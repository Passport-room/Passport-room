/**
 * ============================================================================
 *  CRASH GUARD — READ THIS BEFORE TOUCHING ANY AI / ONNX / CANVAS CODE
 * ============================================================================
 *
 *  WHY THIS FILE EXISTS
 *  --------------------
 *  Background removal used to crash the whole browser tab ("Aw, Snap!" on
 *  Chrome / "A problem repeatedly occurred" on Safari) on phones and on some
 *  PCs. A tab crash is NOT a JavaScript exception: try/catch can never see it,
 *  so it can only be *prevented* and *remembered*, never "handled".
 *
 *  The two things that crash the renderer:
 *    1. WebGPU. Some Android GPUs / older desktop drivers abort the GPU process
 *       while compiling or running the matting model. The tab dies instantly.
 *    2. Memory. Several big things alive at the same time (model bytes + WASM
 *       heap + full-size canvases + a second model running in parallel) pushes
 *       the renderer over its limit and the OS kills it.
 *
 *  HOW THIS FILE FIXES IT
 *  ----------------------
 *    - markStart()/markDone() write a breadcrumb to localStorage around every
 *      risky GPU/WASM run. If the tab dies mid-run, the breadcrumb survives.
 *      On the next page load the leftover breadcrumb is detected and that
 *      device is permanently switched to the safe path (WASM, smaller work
 *      size). The user simply retries and it works.
 *    - withExclusiveRun() makes sure only ONE model ever runs at a time.
 *
 *  RULES FOR FUTURE AI / DEVELOPERS  (breaking these brings the crash back)
 *  -----------------------------------------------------------------------
 *    R1. Never call ort.InferenceSession.create / session.run without wrapping
 *        it in markStart()/markDone() (createSession + computeMask already do).
 *    R2. Never run two models at once — always go through withExclusiveRun().
 *    R3. Never force executionProviders: ["webgpu"] directly. Ask
 *        canUseWebGPU() first; it respects the crash memory.
 *    R4. Never remove the WASM fallback, and never feed the fp16 model to the
 *        WASM backend (use the fp32 URL there — see background-removal.js).
 *    R5. Keep the working resolution capped (see safeWorkSize()) and always
 *        release canvases with releaseCanvas() when done.
 *    R6. Do not delete or rename the localStorage keys below; they are the
 *        crash memory of already-affected devices.
 * ============================================================================
 */

const FLAG_INFLIGHT = "makepics-gpu-run-inflight";
const FLAG_STRIKES = "makepics-gpu-crash-strikes";
const FLAG_SAFEMODE = "makepics-safe-mode";

// A run older than this was almost certainly a crash, not a page left open.
const INFLIGHT_STALE_MS = 10 * 60 * 1000;

function ls() {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}
function read(key) {
  try {
    return ls()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function write(key, value) {
  try {
    ls()?.setItem(key, value);
  } catch {
    /* private mode — crash memory is best-effort only */
  }
}
function remove(key) {
  try {
    ls()?.removeItem(key);
  } catch {
    /* ignore */
  }
}

let safeMode = false;

// Runs once at import: did the previous run of this page die mid-inference?
(function detectPreviousCrash() {
  if (read(FLAG_SAFEMODE) === "1") safeMode = true;
  const inflight = read(FLAG_INFLIGHT);
  remove(FLAG_INFLIGHT);
  if (!inflight) return;
  const startedAt = Number(inflight) || 0;
  if (startedAt && Date.now() - startedAt > INFLIGHT_STALE_MS) return;
  const strikes = (Number(read(FLAG_STRIKES)) || 0) + 1;
  write(FLAG_STRIKES, String(strikes));
  safeMode = true;
  write(FLAG_SAFEMODE, "1");
  console.warn(
    `[crash-guard] previous AI run ended in a tab crash (strike ${strikes}). ` +
      "Switching this device to the safe CPU path.",
  );
})();

/** True when this device already crashed once — use CPU and smaller sizes. */
export function isSafeMode() {
  return safeMode;
}

/** Call right before a GPU/WASM heavy run. */
export function markStart() {
  write(FLAG_INFLIGHT, String(Date.now()));
}

/** Call in a finally{} right after the run completes or throws. */
export function markDone() {
  remove(FLAG_INFLIGHT);
}

/** Devices that report little RAM get the same treatment as crashed ones. */
function isLowMemoryDevice() {
  if (typeof navigator === "undefined") return false;
  const mem = navigator.deviceMemory;
  if (typeof mem === "number" && mem > 0 && mem <= 4) return true;
  return false;
}

/**
 * WebGPU is used only when the device has it, has never crashed on it, and
 * actually hands us an adapter. Never bypass this (rule R3).
 */
export async function canUseWebGPU() {
  if (safeMode) return false;
  if (typeof navigator === "undefined" || !("gpu" in navigator)) return false;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}

/**
 * Largest inference edge length we allow. Bigger = more memory = crashes on
 * phones. Keep the cap for the *crashed / low-memory* path at 384: those
 * devices already proved they cannot hold more.
 */
export function safeWorkSize(preferred = 512) {
  if (safeMode || isLowMemoryDevice()) return Math.min(preferred, 384);
  return preferred;
}

/** Rough "is this a phone/tablet" check — used only to pick a work size. */
function isMobileDevice() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (/Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(ua)) return true;
  if (navigator.maxTouchPoints > 1 && /Mac/i.test(ua)) return true; // iPadOS
  try {
    if (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches) {
      return !/Windows NT/i.test(ua);
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * ADAPTIVE INFERENCE RESOLUTION (quality-first, memory-safe).
 *
 * Only the mask/inference stage uses this size — the final image is always
 * composed at the photo's own full resolution, so nothing is downscaled for
 * the user. Tiers:
 *
 *   PC / desktop ............................ 1024
 *   High-end mobile (>=6 GB, >=6 cores) ..... 1024
 *   Medium mobile (>=4 GB, >=4 cores) ....... 768
 *   Very low-end mobile ..................... 600
 *   Device that already crashed (safe mode) . 600 (CPU path)
 *
 * A device that survived a crash keeps the smallest tier so it can never die
 * again; the mask refinement in background-removal.js is what keeps edges
 * clean at 600 (rule R5 still applies: release canvases).
 */
export function adaptiveWorkSize() {
  const mem = (typeof navigator !== "undefined" && navigator.deviceMemory) || 0;
  const cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 0;
  const mobile = isMobileDevice();

  if (safeMode) return mobile ? 600 : 768;
  if (!mobile) return 1024; // PC / desktop always gets the model's best size.

  if (mem >= 6 || (mem === 0 && cores >= 8)) return 1024; // high-end phone
  if (mem >= 4 || (mem === 0 && cores >= 6)) return 768; // medium phone
  if (mem > 0 && mem <= 2) return 600; // very low-end phone
  if (cores > 0 && cores <= 4) return 600;
  return 768;
}

/** True when the device looks like a phone/tablet (exported for tuning only). */
export function isMobile() {
  return isMobileDevice();
}


let queue = Promise.resolve();

/** Serialises heavy model work so two models never share memory peaks (R2). */
export function withExclusiveRun(task) {
  const run = queue.then(task, task);
  // Keep the chain alive even when a task rejects.
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Frees a canvas' backing pixel buffer immediately (R5). */
export function releaseCanvas(canvas) {
  if (!canvas) return;
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch {
    /* ignore */
  }
}
