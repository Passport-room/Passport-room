// AI Enhance — UI controller for the GPEN-BFR-256 face restoration pipeline.
//
// All image work lives in face-restore.js. This file only drives the panel:
// model download progress, the strength control, running the restore and
// applying / reverting the result.

import { restoreFace, loadFaceModel, isFaceModelSaved } from "./face-restore.js";
import { loadFaceDetector } from "./face-detector.js";

const MODEL_MB = 75.8;

// Two identity-safe levels — both restore, neither beautifies.
const PRESETS = { natural: 0.78, strong: 1.0 };

let level = "natural";
let strengthOverride = null;
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

function showSetup(title, sub, pct) {
  const box = $("enhanceSetup");
  if (!box) return;
  box.classList.remove("hidden");
  box.classList.add("active");
  const t = $("enhanceSetupTitle");
  const s = $("enhanceSetupSub");
  const bar = $("enhanceSetupBar");
  const pctEl = $("enhanceSetupPct");
  if (t) t.textContent = title;
  if (s) s.textContent = sub;
  const known = typeof pct === "number" && isFinite(pct);
  if (bar) {
    bar.classList.toggle("indeterminate", !known);
    bar.style.width = known ? `${Math.max(2, Math.min(100, pct))}%` : "100%";
  }
  if (pctEl) pctEl.textContent = known ? `${Math.round(pct)}%` : "";
}

function hideSetup(delay = 700) {
  const box = $("enhanceSetup");
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
    showSetup(
      "Setting up the AI enhancer",
      `Downloading the face model — ${(p.loaded / 1048576).toFixed(1)} MB of ${MODEL_MB} MB. This happens only once.`,
      (p.loaded / total) * 100,
    );
  } else if (p.stage === "compile") {
    showSetup("Preparing the AI model", "Warming up the restoration engine…", null);
  } else if (p.stage === "ready") {
    showSetup("AI enhancer ready", "Ready to enhance — instant from now on.", 100);
  } else if (p.stage === "detect") {
    showSetup("Finding the face", "Locating eyes, nose and mouth…", null);
  } else if (p.stage === "run") {
    showSetup("Restoring the face", "Recovering real detail in eyes, skin and features…", null);
  } else if (p.stage === "composite") {
    showSetup("Blending", "Merging the restored face into your photo…", null);
  }
}

/* ---------------- controls ---------------- */

function currentStrength() {
  return strengthOverride !== null ? strengthOverride : PRESETS[level];
}

function syncStrengthUI() {
  const slider = $("enhanceStrength");
  const label = $("enhanceStrengthValue");
  const v = currentStrength();
  if (slider) slider.value = String(Math.round(v * 100));
  if (label) label.textContent = `${Math.round(v * 100)}%`;
}

function updateBtn() {
  const btn = $("enhanceGenerate");
  if (!btn) return;
  btn.disabled = busy || !window.__tryOn?.getPersonDataUrl?.();
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

function setRevertState() {
  window.__editHistory?.setRevertEnabled?.($("enhanceRevert"), !!preSnapshot);
}

function invalidateRevert() {
  preSnapshot = null;
  setRevertState();
}

/* ---------------- run ---------------- */

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
    if (!baseDataUrl) preSnapshot = personDataUrl;
    const source = await loadImage(personDataUrl);

    const saved = await isFaceModelSaved();
    showSetup(
      saved ? "Loading the AI model" : "Setting up the AI enhancer",
      saved ? "Already prepared — no download needed." : `First run only — fetching ${MODEL_MB} MB.`,
      saved ? 100 : 0,
    );
    await loadFaceModel(onModelProgress);

    // Landmark detector (small, cached on-device like the restorer).
    try {
      await loadFaceDetector(onModelProgress);
    } catch (err) {
      console.warn("Face detector unavailable, using estimated landmarks", err);
    }

    setStatus("Restoring the face…");
    const result = await restoreFace(
      source,
      { strength: currentStrength() },
      onModelProgress,
    );
    hideSetup();

    if (!result.restored) {
      setStatus(
        result.reason === "model-failed"
          ? "The AI couldn't restore this face — try a photo where the face is clearer."
          : "No usable face found in this photo.",
        "err",
      );
      preSnapshot = baseDataUrl ? preSnapshot : null;
      setRevertState();
      return;
    }

    setStatus("Applying the enhanced photo…");
    window.__editHistory?.claim?.("enhance");
    await window.__tryOn.applyResult(result.canvas.toDataURL("image/png"), (m) => setStatus(m));

    setRevertState();
    setStatus(
      [
        `Face restored (${result.backend === "webgpu" ? "WebGPU" : "CPU"})`,
        result.landmarksExact ? " — aligned on detected landmarks" : " — approximate face area",
        `. ${level === "strong" ? "Strong" : "Natural"} level, blend ${Math.round(result.blend * 100)}%.`,
      ].join(""),
      "ok",
    );
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

function resetSession() {
  preSnapshot = null;
  busy = false;
  strengthOverride = null;
  level = "natural";
  document
    .querySelectorAll(".enhanceScaleBtn")
    .forEach((b) => b.classList.toggle("active", b.dataset.level !== "strong"));
  syncStrengthUI();
  hideSetup(0);
  setStatus("");
  setRevertState();
  updateBtn();
}

function bind() {
  document.querySelectorAll(".enhanceScaleBtn").forEach((b) => {
    b.addEventListener("click", () => {
      level = b.dataset.level === "strong" ? "strong" : "natural";
      strengthOverride = null;
      document
        .querySelectorAll(".enhanceScaleBtn")
        .forEach((x) => x.classList.toggle("active", x === b));
      syncStrengthUI();
    });
  });

  const slider = $("enhanceStrength");
  if (slider) {
    slider.addEventListener("input", () => {
      strengthOverride = Math.max(0.25, Math.min(1, Number(slider.value) / 100));
      const label = $("enhanceStrengthValue");
      if (label) label.textContent = `${Math.round(strengthOverride * 100)}%`;
    });
  }
  syncStrengthUI();

  const gen = $("enhanceGenerate");
  const rev = $("enhanceRevert");
  if (gen) gen.onclick = () => enhance();
  if (rev) rev.onclick = revert;

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
