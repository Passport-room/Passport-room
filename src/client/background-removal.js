// MODNet portrait matting via onnxruntime-web. Model streamed from Hugging Face
// once, then saved on-device under "makepics-modnet-portrait-v1" (fp16, GPU) or
// "makepics-modnet-portrait-fp32-v1" (fp32, CPU). WebGPU with WASM fallback.
// No local ONNX file is bundled.
//
// ============================================================================
//  CRASH-CRITICAL FILE — READ src/client/crash-guard.js FIRST
// ============================================================================
//  This is the step that used to crash the browser tab ("Aw, Snap!") on phones
//  and some PCs. Keep every rule below intact when editing:
//
//   1. Pick the model by backend: fp16 ONLY for WebGPU, fp32 for the CPU/WASM
//      path. Running the fp16 graph on WASM is unstable and can abort the tab.
//   2. Always go through withExclusiveRun() — never let two models run at once.
//   3. Always bracket session.run() with markStart()/markDone() so a tab crash
//      is remembered and the device falls back to the safe path next time.
//   4. Keep the working resolution adaptive (adaptiveWorkSize(), clamped by
//      safeWorkSize() in safe mode); never inference at the full photo size.
//   5. Release temporary canvases and the cached model bytes when done.
//   6. Never delete the WASM fallback or the try/catch that reports a friendly
//      error instead of leaving the UI stuck on the spinner.
//
//  QUALITY PIPELINE (added on top of the rules above, do not remove):
//   - Inference runs at the device tier resolution (600 / 768 / 1024).
//   - The raw mask is cleaned, then upscaled in gentle 2x steps with high
//     quality smoothing and finally edge-refined (unsharp on alpha + a soft
//     S-curve) so hair strands, ears, glasses and clothing edges stay natural.
//   - The final cutout is ALWAYS composed from the original full-resolution
//     photo (see passport-render.js composeCutout) — only the mask is scaled.
// ============================================================================
import { MODEL_KEYS, getModelBytes, createSession, releaseModelBytes } from "./model-cache.js";
import {
  canUseWebGPU,
  markStart,
  markDone,
  safeWorkSize,
  adaptiveWorkSize,
  isMobile,
  withExclusiveRun,
  releaseCanvas,
} from "./crash-guard.js";

// fp16 = small + fast, but GPU only. fp32 = the safe graph for the CPU backend.
const MODEL_URL_FP16 = "https://huggingface.co/Xenova/modnet/resolve/main/onnx/model_fp16.onnx";
const MODEL_URL_FP32 = "https://huggingface.co/Xenova/modnet/resolve/main/onnx/model.onnx";
const STRIDE = 32;

let modelPromise = null;

export function loadModel(onProgress) {
  if (modelPromise) return modelPromise;
  modelPromise = (async () => {
    // Decide the backend BEFORE downloading so we fetch the matching graph.
    const gpu = await canUseWebGPU();
    const key = gpu ? MODEL_KEYS.MODNET : MODEL_KEYS.MODNET_FP32;
    const url = gpu ? MODEL_URL_FP16 : MODEL_URL_FP32;

    const bytes = await getModelBytes(key, url, onProgress);
    onProgress && onProgress({ stage: "compile" });
    const created = await createSession(bytes, { allowWebGPU: gpu });
    // The session owns the weights now; drop our duplicate copy (rule 5).
    releaseModelBytes(key);
    onProgress && onProgress({ stage: "ready" });
    return created;
  })().catch((err) => {
    modelPromise = null;
    throw err;
  });
  return modelPromise;
}

function sourceSize(source) {
  const w = source.naturalWidth || source.width || 0;
  const h = source.naturalHeight || source.height || 0;
  return { w, h };
}

function inferSize(w, h, ref) {
  let rw = w,
    rh = h;
  if (Math.max(w, h) > ref || Math.min(w, h) < ref) {
    if (w >= h) {
      rw = ref;
      rh = Math.round((h / w) * ref);
    } else {
      rh = ref;
      rw = Math.round((w / h) * ref);
    }
  }
  rw = Math.max(STRIDE, rw - (rw % STRIDE));
  rh = Math.max(STRIDE, rh - (rh % STRIDE));
  return { rw, rh };
}

/**
 * Inference edge length for this device (rule 4).
 *   PC/desktop 1024 · high-end phone 1024 · medium phone 768 · low-end 600
 * The CPU/WASM path on a phone is clamped one tier down so the run stays
 * responsive and inside the renderer's memory budget.
 */
function pickWorkSize(backend) {
  let ref = adaptiveWorkSize();
  if (backend !== "webgpu" && isMobile()) ref = Math.min(ref, 768);
  // safeWorkSize() still has the final word on crashed / tiny-RAM devices:
  // when it clamps, this device gets the smallest tier.
  if (safeWorkSize(1024) < 1024) ref = Math.min(ref, 600);
  return Math.max(320, ref);
}

/** How large the refined mask may get before it is handed to the compositor. */
function refineLimit(ref) {
  if (ref >= 1024) return isMobile() ? 1600 : 2048;
  if (ref >= 768) return 1280;
  return 1024;
}

/* -------------------------------------------------------------------------- */
/*  Mask quality helpers — all work on a plain Float32Array of alpha (0..1).   */
/* -------------------------------------------------------------------------- */

/** Separable 3-tap-per-pass box blur; cheap and allocation-free per call. */
function blurAlpha(src, w, h, radius, tmp, out) {
  const r = Math.max(1, Math.round(radius));
  const norm = 1 / (2 * r + 1);
  // horizontal
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum * norm;
      const add = src[row + Math.min(w - 1, x + r + 1)];
      const sub = src[row + Math.max(0, x - r)];
      sum += add - sub;
    }
  }
  // vertical
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum * norm;
      const add = tmp[Math.min(h - 1, y + r + 1) * w + x];
      const sub = tmp[Math.max(0, y - r) * w + x];
      sum += add - sub;
    }
  }
  return out;
}

/**
 * Cleans the raw model output before it is scaled up:
 *  - snaps the solid interior to 1 and clear background to 0 (kills the faint
 *    haze MODNet leaves in flat areas) while leaving the 0.02..0.98 band —
 *    that band IS the hair / glasses / fabric detail, so it must survive.
 */
function cleanRawAlpha(a) {
  for (let i = 0; i < a.length; i++) {
    let v = a[i];
    if (v <= 0.02) v = 0;
    else if (v >= 0.985) v = 1;
    a[i] = v;
  }
  return a;
}

/**
 * Edge refinement after upscaling. An upscaled mask is soft, so:
 *   1. unsharp against a small blur restores the strand/edge definition that
 *      bilinear/bicubic scaling smeared,
 *   2. a soft S-curve tightens the transition band without turning it into a
 *      hard cut-out (hard cut-outs are what look "jagged" and eat hair),
 *   3. the semi-transparent band is preserved so face, neck, shoulders and
 *      clothing edges blend naturally onto the new background.
 */
function refineAlpha(a, w, h, amount, radius) {
  const tmp = new Float32Array(a.length);
  const blur = new Float32Array(a.length);
  blurAlpha(a, w, h, radius, tmp, blur);

  const k = 1.45; // S-curve steepness — gentle on purpose.
  for (let i = 0; i < a.length; i++) {
    let v = a[i] + (a[i] - blur[i]) * amount;
    if (v <= 0) {
      a[i] = 0;
      continue;
    }
    if (v >= 1) {
      a[i] = 1;
      continue;
    }
    // soft S-curve around the 0.5 crossing
    const s = (v - 0.5) * k + 0.5;
    v = v * 0.35 + (s < 0 ? 0 : s > 1 ? 1 : s) * 0.65;
    a[i] = v <= 0.004 ? 0 : v >= 0.996 ? 1 : v;
  }
  return a;
}

function alphaToCanvas(a, w, h) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  const id = ctx.createImageData(w, h);
  const d = id.data;
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    const j = i * 4;
    d[j] = 255;
    d[j + 1] = 255;
    d[j + 2] = 255;
    d[j + 3] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
  }
  ctx.putImageData(id, 0, 0);
  return canvas;
}

/**
 * High-quality mask upscale: repeated <=2x steps with high-quality smoothing
 * (a single huge stretch is what produces blocky, stair-stepped edges).
 */
function upscaleMask(canvas, targetW, targetH) {
  let current = canvas;
  let cw = canvas.width;
  let ch = canvas.height;
  while (cw < targetW) {
    const nw = Math.min(targetW, cw * 2);
    const nh = Math.max(1, Math.round((nw / targetW) * targetH));
    const step = document.createElement("canvas");
    step.width = nw;
    step.height = nh;
    const sctx = step.getContext("2d", { willReadFrequently: true });
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = "high";
    sctx.drawImage(current, 0, 0, nw, nh);
    if (current !== canvas) releaseCanvas(current);
    current = step;
    cw = nw;
    ch = nh;
  }
  if (cw !== targetW || ch !== targetH) {
    const final = document.createElement("canvas");
    final.width = targetW;
    final.height = targetH;
    const fctx = final.getContext("2d", { willReadFrequently: true });
    fctx.imageSmoothingEnabled = true;
    fctx.imageSmoothingQuality = "high";
    fctx.drawImage(current, 0, 0, targetW, targetH);
    if (current !== canvas) releaseCanvas(current);
    current = final;
  }
  if (current !== canvas) releaseCanvas(canvas);
  return current;
}

export function computeMask(source, onProgress) {
  // Rule 2: one model at a time, always.
  return withExclusiveRun(() => computeMaskInner(source, onProgress));
}

async function computeMaskInner(source, onProgress) {
  const { ort, session, backend } = await loadModel(onProgress);
  const { w: natW, h: natH } = sourceSize(source);
  if (!natW || !natH) throw new Error("The photo could not be read. Please try another image.");

  // Rule 4: adaptive, capped working resolution (never the full photo size).
  const ref = pickWorkSize(backend);
  const { rw, rh } = inferSize(natW, natH, ref);

  const input = document.createElement("canvas");
  input.width = rw;
  input.height = rh;
  const ictx = input.getContext("2d", { willReadFrequently: true });
  ictx.imageSmoothingEnabled = true;
  ictx.imageSmoothingQuality = "high";
  ictx.drawImage(source, 0, 0, rw, rh);
  const { data } = ictx.getImageData(0, 0, rw, rh);

  const area = rw * rh;
  const f = new Float32Array(3 * area);
  for (let i = 0; i < area; i++) {
    f[i] = data[i * 4] / 127.5 - 1;
    f[area + i] = data[i * 4 + 1] / 127.5 - 1;
    f[2 * area + i] = data[i * 4 + 2] / 127.5 - 1;
  }
  releaseCanvas(input); // pixels no longer needed (rule 5)

  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const tensor = new ort.Tensor("float32", f, [1, 3, rh, rw]);

  let out = null;
  let inferenceMs = 0;
  // Rule 3: breadcrumbs around the run so a tab crash is never repeated.
  markStart();
  try {
    const t0 = performance.now();
    out = await session.run({ [inputName]: tensor });
    inferenceMs = performance.now() - t0;
  } catch (err) {
    console.error("[background-removal] inference failed:", err);
    throw new Error(
      "Background removal couldn't finish on this device. Please try again with a slightly smaller photo.",
    );
  } finally {
    markDone();
    try {
      tensor.dispose && tensor.dispose();
    } catch {
      /* ignore */
    }
  }

  const predTensor = out[outputName];
  const pred = predTensor.data;

  // Copy the alpha out as floats so the tensor (and any GPU buffer) can go.
  const alpha = new Float32Array(area);
  for (let i = 0; i < area; i++) {
    const v = pred[i];
    alpha[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  try {
    predTensor.dispose && predTensor.dispose();
  } catch {
    /* ignore */
  }

  cleanRawAlpha(alpha);
  // Light pre-sharpen at model resolution keeps thin strands from washing out
  // during the upscale.
  refineAlpha(alpha, rw, rh, 0.35, 1);

  let maskCanvas = alphaToCanvas(alpha, rw, rh);

  // ---- Back to (near) original resolution, with real refinement ----------
  // The compositor always draws the mask over the ORIGINAL photo, so the
  // user's resolution is untouched; we only make the mask faithful to it.
  const limit = refineLimit(ref);
  const longSide = Math.max(natW, natH);
  const targetLong = Math.min(longSide, limit);
  if (targetLong > Math.max(rw, rh) + 8) {
    const scale = targetLong / longSide;
    const tw = Math.max(1, Math.round(natW * scale));
    const th = Math.max(1, Math.round(natH * scale));
    maskCanvas = upscaleMask(maskCanvas, tw, th);

    // Final edge refinement at the high resolution: recovers the crisp strand
    // and clothing edges the smooth upscale softened, without hard clipping.
    try {
      const rctx = maskCanvas.getContext("2d", { willReadFrequently: true });
      const id = rctx.getImageData(0, 0, tw, th);
      const d = id.data;
      const n = tw * th;
      const up = new Float32Array(n);
      for (let i = 0; i < n; i++) up[i] = d[i * 4 + 3] / 255;
      const radius = Math.max(1, Math.round(targetLong / 900));
      refineAlpha(up, tw, th, 0.85, radius);
      for (let i = 0; i < n; i++) {
        const j = i * 4;
        d[j] = 255;
        d[j + 1] = 255;
        d[j + 2] = 255;
        d[j + 3] = Math.round(up[i] * 255);
      }
      rctx.putImageData(id, 0, 0);
    } catch (err) {
      // Refinement is a bonus, never a requirement: a memory hiccup here must
      // not fail the whole background removal.
      console.warn("[background-removal] mask refinement skipped:", err);
    }
  }

  return { maskCanvas, backend, inferenceMs, workSize: ref };
}
