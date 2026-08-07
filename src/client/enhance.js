// AI Enhance — GPEN face restoration, no cloud queue, no "busy" errors.
//
// Uses GPEN-BFR-256 through onnxruntime-web (WebGPU with WASM fallback), the
// same on-device strategy as background removal. The model downloads once,
// is saved on the device under "makepics-gpen-bfr-256-v1" and is found there
// automatically on every later visit.

import { enhanceFace, loadFaceModel, isFaceModelSaved } from "./face-enhance.js";
import { loadFaceDetector } from "./face-detector.js";
import { computeMask } from "./background-removal.js";

const MODEL_MB = 75.8;

// Natural keeps the face almost exactly as shot; Strong genuinely does more
// work — more unsharp detail recovery and more skin smoothing — instead of
// just blending the same restoration at a higher opacity.
const PRESETS = {
  // underEye is deliberately gentle: a strong lift reads as two bright dots
  // beside the eyes. It is a subtle shadow lift, never a patch.
  natural: { strength: 0.72, sharpen: 0.35, softSkin: 0.25, underEye: 0.3 },
  strong: { strength: 0.95, sharpen: 0.85, softSkin: 0.6, underEye: 0.45 },
};

// Kept for backward compatibility with anything reading the old shape.
export const STRENGTH = { natural: PRESETS.natural.strength, strong: PRESETS.strong.strength };

let level = "natural";
let softSkinOverride = null; // set once the user touches the slider
let busy = false;
let preSnapshot = null;

const $ = (id) => document.getElementById(id);

function setStatus(msg, kind = "") {
  const el = $("enhanceStatus");
  if (!el) return;
  el.textContent = msg || "";
  el.className = "tryOnStatus " + kind;
}

/* ---------------- model setup animation ---------------- */

function setupBox() {
  return $("enhanceSetup");
}

function showSetup(title, sub, pct) {
  const box = setupBox();
  if (!box) return;
  box.classList.remove("hidden");
  box.classList.add("active");
  const t = $("enhanceSetupTitle");
  const s = $("enhanceSetupSub");
  const bar = $("enhanceSetupBar");
  const pctEl = $("enhanceSetupPct");
  if (t) t.textContent = title;
  if (s) s.textContent = sub;
  if (bar) {
    const known = typeof pct === "number" && isFinite(pct);
    bar.classList.toggle("indeterminate", !known);
    bar.style.width = known ? `${Math.max(2, Math.min(100, pct))}%` : "100%";
  }
  if (pctEl)
    pctEl.textContent = typeof pct === "number" && isFinite(pct) ? `${Math.round(pct)}%` : "";
}

function hideSetup(delay = 700) {
  const box = setupBox();
  if (!box) return;
  setTimeout(() => {
    box.classList.remove("active");
    box.classList.add("hidden");
  }, delay);
}

function onModelProgress(p) {
  if (p.stage === "download") {
    if (p.cached) {
      showSetup("Loading the AI model", "Already prepared — no download needed.", 100);
      return;
    }
    const total = p.total || MODEL_MB * 1024 * 1024;
    const pct = (p.loaded / total) * 100;
    const mb = (p.loaded / 1048576).toFixed(1);
    showSetup(
      "Setting up the AI enhancer",
      `Downloading the face model — ${mb} MB of ${MODEL_MB} MB. This happens only once.`,
      pct,
    );
  } else if (p.stage === "compile") {
    showSetup("Preparing the AI model", "Warming up the enhancement engine…", null);
  } else if (p.stage === "ready") {
    showSetup("AI enhancer ready", "Ready to enhance — instant from now on.", 100);
  } else if (p.stage === "detect") {
    showSetup("Finding the face", "Locating eyes, nose and mouth…", null);
  } else if (p.stage === "run") {
    showSetup("Enhancing the face", "Restoring detail, clearing spots and blur…", null);
  } else if (p.stage === "soften") {
    showSetup("Softening skin", "Edge-preserving smoothing — features stay sharp…", null);
  } else if (p.stage === "sharpen") {
    showSetup("Adding clarity", "Sharpening the upscaled face to match your photo size…", null);
  }
}

/* ---------------- buttons ---------------- */

function currentSoftSkin() {
  if (softSkinOverride !== null) return softSkinOverride;
  return PRESETS[level].softSkin;
}

function syncSoftSkinUI() {
  const slider = $("enhanceSoftSkin");
  const label = $("enhanceSoftSkinValue");
  const v = currentSoftSkin();
  if (slider) slider.value = String(Math.round(v * 100));
  if (label) label.textContent = `${Math.round(v * 100)}%`;
}

function updateBtn() {
  const btn = $("enhanceGenerate");
  if (!btn) return;
  const ready = !busy && !!window.__tryOn?.getPersonDataUrl?.();
  btn.disabled = !ready;
  btn.textContent = busy ? "Enhancing…" : "Enhance face";
}

async function loadImage(dataUrl) {
  const img = new Image();
  img.crossOrigin = "anonymous";
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = () => rej(new Error("Could not read the photo"));
    img.src = dataUrl;
  });
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext("2d").drawImage(img, 0, 0);
  return c;
}

/** Revert is only offered while the pre-enhance snapshot is still the photo
 *  that this enhance produced. Once another tool creates a newer image the
 *  snapshot is dropped and the button greys out. */
function setRevertState() {
  window.__editHistory?.setRevertEnabled?.($("enhanceRevert"), !!preSnapshot);
}

/** Another feature produced a newer image — this enhance is no longer undoable. */
function invalidateRevert() {
  preSnapshot = null;
  setRevertState();
}

/**
 * @param {string|null} baseDataUrl  When given, enhancement runs from this
 *   exact photo instead of the current (possibly already enhanced) one.
 */
async function enhance(baseDataUrl = null) {
  if (busy) return;
  if (!window.__tryOn) {
    setStatus("Editor not ready — upload a photo first.", "err");
    return;
  }
  const personDataUrl = baseDataUrl || window.__tryOn.getPersonDataUrl();
  if (!personDataUrl) {
    setStatus("Upload a photo first.", "err");
    return;
  }

  busy = true;
  updateBtn();
  setStatus("Setting up the AI…");

  try {
    // Keep the FIRST pre-enhance photo as the one true original, so Revert
    // always goes back to it rather than to a previous enhanced result.
    if (!baseDataUrl) preSnapshot = personDataUrl;
    const source = await loadImage(personDataUrl);

    const saved = await isFaceModelSaved();
    showSetup(
      saved ? "Loading the AI model" : "Setting up the AI enhancer",
      saved
        ? "Already prepared — no download needed."
        : `First run only — fetching ${MODEL_MB} MB.`,
      saved ? 100 : 0,
    );
    await loadFaceModel(onModelProgress);

    // Person mask (MODNet, already on-device) pinpoints the head so the
    // enhancer touches the face and nothing else.
    let maskCanvas = null;
    try {
      setStatus("Locating the face…");
      maskCanvas = (await computeMask(source, () => {})).maskCanvas;
    } catch {
      maskCanvas = null;
    }

    // Small face detector (real landmarks) — also cached on this device.
    try {
      await loadFaceDetector(onModelProgress);
    } catch (err) {
      console.warn("Face detector unavailable, using fallback detection", err);
    }

    setStatus("Enhancing the face…");
    const preset = PRESETS[level];
    const { canvas, backend, faceFound, faceSource, upscaleRatio } = await enhanceFace(
      source,
      {
        strength: preset.strength,
        sharpen: preset.sharpen,
        underEye: preset.underEye,
        softSkin: currentSoftSkin(),
        maskCanvas,
      },
      onModelProgress,
    );
    hideSetup();

    setStatus("Applying the enhanced photo…");
    // A new image is about to become the working photo: every other feature's
    // revert snapshot is now stale and must be dropped.
    window.__editHistory?.claim?.("enhance");
    await window.__tryOn.applyResult(canvas.toDataURL("image/png"), (m) => setStatus(m));

    setRevertState();
    const detail = [
      `Face enhanced (${backend === "webgpu" ? "WebGPU" : "CPU"})`,
      faceFound
        ? faceSource === "onnx"
          ? " — landmarks detected"
          : " — approximate face area"
        : " — no face detected, enhanced the centre area",
      upscaleRatio > 1.05 ? `, sharpened for ${upscaleRatio.toFixed(1)}x upscale` : "",
      `. ${level === "strong" ? "Strong" : "Natural"} level, soft skin ${Math.round(currentSoftSkin() * 100)}%.`,
    ].join("");
    setStatus(detail, "ok");
  } catch (e) {
    hideSetup(0);
    console.error(e);
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
    await window.__tryOn.applyResult(preSnapshot, (m) => setStatus(m));
    preSnapshot = null;
    setRevertState();
    setStatus("Reverted to original.", "ok");
  } catch (e) {
    setStatus(e?.message || "Could not revert.", "err");
  } finally {
    busy = false;
    updateBtn();
  }
}

/** Called when a brand-new photo is loaded: drop every enhance result so the
 *  previous face-enhancement can never reappear on the new image. The
 *  downloaded model stays cached on the device. */
function resetSession() {
  preSnapshot = null;
  busy = false;
  softSkinOverride = null;
  level = "natural";
  document
    .querySelectorAll(".enhanceScaleBtn")
    .forEach((b) => b.classList.toggle("active", b.dataset.level !== "strong"));
  syncSoftSkinUI();
  hideSetup(0);
  setStatus("");
  setRevertState();
  updateBtn();
}

function bind() {
  document.querySelectorAll(".enhanceScaleBtn").forEach((b) => {
    b.addEventListener("click", () => {
      level = b.dataset.level === "strong" ? "strong" : "natural";
      softSkinOverride = null; // each level has its own default amount
      document
        .querySelectorAll(".enhanceScaleBtn")
        .forEach((x) => x.classList.toggle("active", x === b));
      syncSoftSkinUI();
    });
  });

  const soft = $("enhanceSoftSkin");
  if (soft) {
    soft.addEventListener("input", () => {
      softSkinOverride = Math.max(0, Math.min(1, Number(soft.value) / 100));
      const label = $("enhanceSoftSkinValue");
      if (label) label.textContent = `${Math.round(softSkinOverride * 100)}%`;
    });
  }
  syncSoftSkinUI();
  const gen = $("enhanceGenerate");
  const rev = $("enhanceRevert");
  if (gen) gen.onclick = () => enhance();
  if (rev) rev.onclick = revert;

  // Tell returning visitors the model is already on their device.
  isFaceModelSaved()
    .then((saved) => {
      if (saved) setStatus("AI model ready — enhancing is instant.", "ok");
    })
    .catch(() => {});

  const obs = new MutationObserver(updateBtn);
  const resultView = document.getElementById("resultView");
  if (resultView) obs.observe(resultView, { attributes: true, attributeFilter: ["class"] });
  updateBtn();

  setRevertState();
  window.__editHistory?.register?.("enhance", { invalidate: invalidateRevert });
  (window.__aiSessionResets ||= []).push(resetSession);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
else bind();
