// Image enhance — CodeFormer FP16 face restoration running fully on-device.
// Model loading/progress UI lives in ./model-loading-ui.js; this module only
// orchestrates the enhancement itself.

import {
  DEFAULT_FIDELITY_WEIGHT,
  isModelCached,
  loadCodeFormer,
  restorePhoto,
} from "./codeformer.js";
import {
  hideModelLoadingCard,
  showModelLoadingCard,
  updateModelLoadingProgress,
} from "./model-loading-ui.js";

const FIDELITY_WEIGHT = DEFAULT_FIDELITY_WEIGHT; // 0.55 — natural, non-plastic result

// Exposed for diagnostics/testing of the on-device model.
if (typeof window !== "undefined") {
  window.__codeformer = { isModelCached, loadCodeFormer, restorePhoto, FIDELITY_WEIGHT };
}

let scale = 2;
let busy = false;
let preSnapshot = null;

const $ = (id) => document.getElementById(id);

function setStatus(msg, kind = "") {
  const el = $("enhanceStatus");
  if (!el) return;
  el.textContent = msg || "";
  el.className = "tryOnStatus " + kind;
}

function updateBtn() {
  const btn = $("enhanceGenerate");
  if (!btn) return;
  const ready = !busy && !!window.__tryOn?.getPersonDataUrl?.();
  btn.disabled = !ready;
  btn.textContent = busy ? "Enhancing…" : "Enhance photo";
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not read the photo."));
    img.src = dataUrl;
  });
}

function imageToCanvas(img) {
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  canvas.getContext("2d").drawImage(img, 0, 0);
  return canvas;
}

/** Ensures the model is ready, showing the first-run download card if needed. */
async function ensureModelReady() {
  const cached = await isModelCached();
  if (!cached) showModelLoadingCard();
  try {
    await loadCodeFormer((progress) => {
      if (!cached) updateModelLoadingProgress(progress);
    });
  } finally {
    hideModelLoadingCard();
  }
}

/** Encodes the result: JPEG for big images (fast, low memory), PNG otherwise. */
function encode(canvas) {
  const pixels = canvas.width * canvas.height;
  return pixels > 2.2e6 ? canvas.toDataURL("image/jpeg", 0.94) : canvas.toDataURL("image/png");
}

/** Applies the enhanced photo without re-running background removal. */
async function applyEnhanced(dataUrl, onStage) {
  const apply = window.__tryOn.applyEnhancedSource || window.__tryOn.applyResult;
  await apply.call(window.__tryOn, dataUrl, onStage);
}

async function enhance() {
  if (busy) return;
  if (!window.__tryOn) {
    setStatus("Editor not ready — upload a photo first.", "err");
    return;
  }
  const personDataUrl = window.__tryOn.getPersonDataUrl();
  if (!personDataUrl) {
    setStatus("Upload a photo first.", "err");
    return;
  }

  busy = true;
  updateBtn();

  try {
    preSnapshot = personDataUrl;

    setStatus("Preparing the AI enhancer…");
    await ensureModelReady();

    setStatus("Enhancing facial detail on your device…");
    const source = imageToCanvas(await loadImage(personDataUrl));
    const output = await restorePhoto(source, {
      scale,
      fidelityWeight: FIDELITY_WEIGHT,
      onStage: (m) => setStatus(m),
    });

    setStatus("Preparing enhanced photo…");
    await applyEnhanced(encode(output), (m) => setStatus(m));

    $("enhanceRevert").classList.remove("hidden");
    const rt = $("enhanceRetry");
    if (rt) rt.classList.remove("hidden");
    setStatus("Enhanced. Tap Retry to run again, or continue editing.", "ok");
  } catch (e) {
    console.error(e);
    hideModelLoadingCard();
    setStatus(e?.message || "Enhance failed. Please try again.", "err");
  } finally {
    busy = false;
    updateBtn();
  }
}

async function revert() {
  if (!preSnapshot || busy) return;
  busy = true;
  updateBtn();
  setStatus("Restoring original…");
  try {
    await applyEnhanced(preSnapshot, (m) => setStatus(m));
    $("enhanceRevert").classList.add("hidden");
    const rt = $("enhanceRetry");
    if (rt) rt.classList.add("hidden");
    preSnapshot = null;
    setStatus("Reverted to original.", "ok");
  } catch (e) {
    setStatus(e.message || "Could not revert.", "err");
  } finally {
    busy = false;
    updateBtn();
  }
}

function bind() {
  document.querySelectorAll(".enhanceScaleBtn").forEach((b) => {
    b.addEventListener("click", () => {
      const raw = String(b.dataset.scale || "2x").replace("x", "");
      scale = Math.min(4, Math.max(1, parseInt(raw, 10) || 2));
      document
        .querySelectorAll(".enhanceScaleBtn")
        .forEach((x) => x.classList.toggle("active", x === b));
    });
  });
  const gen = $("enhanceGenerate");
  const rev = $("enhanceRevert");
  if (gen) gen.onclick = enhance;
  if (rev) rev.onclick = revert;
  const rt = $("enhanceRetry");
  if (rt) rt.onclick = () => enhance();
  const obs = new MutationObserver(updateBtn);
  const resultView = document.getElementById("resultView");
  if (resultView) obs.observe(resultView, { attributes: true, attributeFilter: ["class"] });
  updateBtn();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
else bind();
