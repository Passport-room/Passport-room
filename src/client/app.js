// Crystal (three.js) is dynamically imported on demand to keep mobile lightweight.
import { PASSPORT_SPECS, BACKGROUND_OPTIONS, specPixels } from "./passport-specs.js";
import { computeMask } from "./background-removal.js";
import {
  composeCutout,
  renderPassport,
  buildPrintSheet,
  canvasToBlob,
  downloadBlob,
  DEFAULT_ADJUST,
} from "./passport-render.js";
import { EDIT_KEYS, DEFAULT_EDITS, applyEdits, loadEdits, saveEdits } from "./photo-editor.js";
import { openPrintEditor } from "./print-editor.js";
import {
  openDrawer,
  closeActiveDrawer,
  openModal,
  closeActiveModal,
  initModalsManager,
  showToast,
  updateHeaderProfileWidget,
  checkAndShowSavePhotosNotice,
} from "./modals-manager.js";
import { recordActivity, addHistoryItem, loadAccount } from "./account-manager.js";

const $ = (id) => document.getElementById(id);

function paintRangeFill(input) {
  const min = parseFloat(input.min),
    max = parseFloat(input.max),
    val = parseFloat(input.value);
  const pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
  input.style.background = `linear-gradient(to right, var(--primary) ${pct}%, oklch(0.34 0.05 300 / 0.9) ${pct}%)`;
}

// State
let phase = "upload";
let cutout = null;
let originalCutoutCanvas = null;
let editedCutoutCanvas = null;
let lastSourceCanvas = null;
let specId = PASSPORT_SPECS[0].id;
let bgColor = BACKGROUND_OPTIONS[0].color; // default Passport Blue (#2563eb)
let adjust = { ...DEFAULT_ADJUST };
let edits = loadEdits(); // persisted from previous session
let showGuides = true;
let format = "png"; // default PNG
let photoCount = 4; // default 4 copies
let backend = null;
let timings = null;
let busy = false;

// Load default settings from account
const accountData = loadAccount();
if (accountData?.settings?.defaultSpec) specId = accountData.settings.defaultSpec;
if (accountData?.settings?.defaultFormat) format = accountData.settings.defaultFormat;

let procMessageTimer = null;

function startProcMessageCycle() {
  stopProcMessageCycle();
  const title = $("procTitle");
  const sub = $("procSub");
  if (!title || !sub) return;

  const messages = [
    { title: "Creating your picture…", sub: "Detecting face & studio lighting." },
    { title: "Working on details…", sub: "Applying precise edge isolation." },
    { title: "Polishing your portrait…", sub: "Fitting passport frame specifications." },
    { title: "Giving final touches…", sub: "Optimizing resolution & contrast." },
  ];
  let idx = 0;
  title.textContent = messages[0].title;
  sub.textContent = messages[0].sub;

  procMessageTimer = setInterval(() => {
    idx = (idx + 1) % messages.length;
    title.textContent = messages[idx].title;
    sub.textContent = messages[idx].sub;
  }, 2500);
}

function stopProcMessageCycle() {
  if (procMessageTimer) {
    clearInterval(procMessageTimer);
    procMessageTimer = null;
  }
}

// Views
const views = { upload: $("uploadView"), processing: $("processingView"), result: $("resultView") };
function setPhase(p) {
  phase = p;
  for (const [k, el] of Object.entries(views)) el.classList.toggle("hidden", k !== p);
  // Home-only sections (About + Articles) show only on the upload/home view
  document
    .querySelectorAll("[data-home-only]")
    .forEach((el) => el.classList.toggle("hidden", p !== "upload"));
  if (p === "upload" && !crystalTeardown && !crystalLoading) startCrystal();
  if (p !== "upload" && crystalTeardown) {
    crystalTeardown();
    crystalTeardown = null;
  }
  if (p === "processing") {
    startProcMessageCycle();
  } else {
    stopProcMessageCycle();
  }
}

// Crystal (only on landing, desktop/tablet only — skipped on small screens to
// avoid loading three.js and running WebGL on low-end mobile devices.)
let crystalTeardown = null;
let crystalLoading = false;
const CRYSTAL_MIN_WIDTH = 900;
function crystalAllowed() {
  const narrow = window.matchMedia(`(max-width: ${CRYSTAL_MIN_WIDTH - 1}px)`).matches;
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  const lowMem = typeof navigator !== "undefined" && navigator.deviceMemory && navigator.deviceMemory < 4;
  return !narrow && !coarse && !lowMem;
}
async function startCrystal() {
  if (crystalLoading || crystalTeardown) return;
  if (!crystalAllowed()) return;
  const box = $("crystalBox");
  const canvas = $("crystalCanvas");
  if (!box || !canvas) return;
  crystalLoading = true;
  try {
    const mod = await import("./crystal.js");
    if (phase !== "upload") return; // user navigated away while loading
    crystalTeardown = await mod.initCrystal(canvas, box);
  } catch (e) {
    console.warn("Crystal disabled:", e);
  } finally {
    crystalLoading = false;
  }
}
startCrystal();

// Header Slide-out Drawer Triggers
const profileBtn = $("profileBtn"),
  menuBtn = $("menuBtn");
if (profileBtn) {
  profileBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openDrawer("accountDrawer");
  });
}

if (menuBtn) {
  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openDrawer("menuDrawer");
  });
}

// Slide-out Menu Navigation Actions
document.querySelectorAll("[data-menu-action]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const action = btn.dataset.menuAction;
    closeActiveDrawer();

    if (action === "new") {
      reset();
    } else if (action === "specs") {
      openModal("presetsModal");
    } else if (action === "history") {
      openModal("historyModal");
    } else if (action === "account") {
      openDrawer("accountDrawer");
    } else if (action === "howItWorks") {
      openModal("howItWorksModal");
    } else if (action === "faq") {
      openModal("faqModal");
    } else if (action === "privacy") {
      openModal("privacyModal");
    } else if (action === "tos") {
      openModal("tosModal");
    }
  });
});

// Footer legal links
const footerPrivacyBtn = $("footerPrivacyBtn");
if (footerPrivacyBtn) {
  footerPrivacyBtn.addEventListener("click", () => openModal("privacyModal"));
}

const footerTosBtn = $("footerTosBtn");
if (footerTosBtn) {
  footerTosBtn.addEventListener("click", () => openModal("tosModal"));
}

// Initialize Drawer & Modal Manager
initModalsManager((selectedSpecId) => {
  if (selectedSpecId) {
    specId = selectedSpecId;
    if (specSelect) specSelect.value = specId;
    renderResult();
  }
});

// Upload
const drop = $("drop"),
  fileInput = $("fileInput"),
  pickBtn = $("pickBtn"),
  uploadError = $("uploadError");
if (pickBtn)
  pickBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    fileInput.click();
  });
if (drop) {
  drop.addEventListener("click", () => fileInput.click());
  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("drag");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("drag");
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  });
}
if (fileInput)
  fileInput.addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    if (f) handleFile(f);
    e.target.value = "";
  });

async function fileToSourceCanvas(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const MAX = 2000;
  const scale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return canvas;
}

function showError(el, msg) {
  if (!msg) {
    el.classList.add("hidden");
    return;
  }
  el.textContent = msg;
  el.classList.remove("hidden");
}

async function handleFile(file) {
  if (!file.type.startsWith("image/")) {
    showError(uploadError, "Please choose an image file (JPG or PNG).");
    return;
  }
  showError(uploadError, null);
  backend = null;
  timings = null;
  adjust = { ...DEFAULT_ADJUST };
  setPhase("processing");
  updateProc("download", null);

  try {
    const t0 = performance.now();
    const source = await fileToSourceCanvas(file);
    lastSourceCanvas = source;
    const mask = await computeMask(source, (p) =>
      updateProc(p.stage, p.total ? Math.round((p.loaded / p.total) * 100) : null),
    );
    cutout = composeCutout(source, mask.maskCanvas, source.width, source.height);
    originalCutoutCanvas = cutout.canvas;
    backend = mask.backend;
    timings = { inference: mask.inferenceMs, total: performance.now() - t0 };
    renderBackendBadge();

    // Record activity and save thumbnail to history
    recordActivity("photo_processed");
    hasCreatedImageInSession = true;
    const currentSpec = PASSPORT_SPECS.find((s) => s.id === specId) || PASSPORT_SPECS[0];
    try {
      const thumbDataUrl = cutout.canvas.toDataURL("image/png");
      addHistoryItem({
        specLabel: currentSpec.label,
        specId: currentSpec.id,
        thumbnail: thumbDataUrl,
      });
    } catch (e) {
      console.warn("Could not generate history thumbnail:", e);
    }

    setPhase("result");
    syncEditorUI();
    applyEditsToCutout(); // may be no-op if edits are default
    renderResult();
    updateHeaderProfileWidget();
  } catch (err) {
    console.error(err);
    showError(
      uploadError,
      err instanceof Error ? err.message : "Something went wrong while processing.",
    );
    setPhase("upload");
  }
}

function updateProc(stage, pct) {
  const t = $("procTitle"),
    sub = $("procSub");
  if (!t || !sub) return;
  if (stage === "download") {
    t.textContent = "Warming up the AI…";
    sub.textContent = "Preparing your photo studio.";
  } else if (stage === "compile") {
    t.textContent = "Tuning the studio lights…";
    sub.textContent = "Getting everything ready for you.";
  } else if (stage === "ready") {
    t.textContent = "Polishing your portrait…";
    sub.textContent = "Almost there.";
  } else if (stage === "done") {
    t.textContent = "Finishing up…";
    sub.textContent = "Almost there.";
  }
}

function renderBackendBadge() {
  const el = $("backendBadge");
  if (!el) return;
  if (backend === "webgpu") {
    el.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block; vertical-align:-1px; margin-right:3px;"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> WebGPU`;
    el.classList.remove("hidden");
  } else {
    el.textContent = "";
    el.classList.add("hidden");
  }
}

// Result view
const specSelect = $("specSelect"),
  specMeta = $("specMeta");
if (specSelect) {
  PASSPORT_SPECS.forEach((s) => {
    const o = document.createElement("option");
    o.value = s.id;
    o.textContent = s.label;
    specSelect.appendChild(o);
  });
  specSelect.value = specId;
  specSelect.addEventListener("change", () => {
    specId = specSelect.value;
    renderResult();
  });
}

const bgSwatches = $("bgSwatches");
if (bgSwatches) {
  BACKGROUND_OPTIONS.forEach((b) => {
    const btn = document.createElement("button");
    btn.className = "sw";
    btn.style.backgroundColor = b.color;
    btn.title = b.label;
    btn.addEventListener("click", () => {
      bgColor = b.color;
      renderResult();
    });
    bgSwatches.appendChild(btn);
  });
  const colorLabel = document.createElement("label");
  colorLabel.className = "swColor";
  colorLabel.title = "Custom color";
  colorLabel.textContent = "+";
  const colorInput = document.createElement("input");
  colorInput.type = "color";
  colorInput.value = bgColor;
  colorInput.addEventListener("input", (e) => {
    bgColor = e.target.value;
    renderResult();
  });
  colorLabel.appendChild(colorInput);
  bgSwatches.appendChild(colorLabel);
}

document.querySelectorAll(".fmtBtn").forEach((b) => {
  b.addEventListener("click", () => {
    format = b.dataset.fmt;
    document.querySelectorAll(".fmtBtn").forEach((x) => x.classList.toggle("active", x === b));
  });
});

// Quantity selection
document.querySelectorAll(".qtyBtn").forEach((b) => {
  b.addEventListener("click", () => {
    photoCount = parseInt(b.dataset.count, 10) || 4;
    document.querySelectorAll(".qtyBtn").forEach((x) => x.classList.toggle("active", x === b));
    const input = $("qtyCustomInput");
    if (input) input.value = photoCount;
  });
});
const qtyInput = $("qtyCustomInput");
if (qtyInput) {
  qtyInput.addEventListener("input", (e) => {
    const val = parseInt(e.target.value, 10);
    if (!isNaN(val) && val >= 1) {
      photoCount = Math.min(60, val);
      document
        .querySelectorAll(".qtyBtn")
        .forEach((x) => x.classList.toggle("active", parseInt(x.dataset.count, 10) === photoCount));
    }
  });
}

const zoomInput = $("zoom"),
  offYInput = $("offY"),
  offXInput = $("offX");
const zoomVal = $("zoomVal"),
  offYVal = $("offYVal"),
  offXVal = $("offXVal");
function syncCropUI() {
  if (!zoomInput || !offYInput || !offXInput) return;
  zoomVal.textContent = (+zoomInput.value).toFixed(2) + "×";
  offYVal.textContent = Math.round(+offYInput.value * 100);
  offXVal.textContent = Math.round(+offXInput.value * 100);
  [zoomInput, offYInput, offXInput].forEach(paintRangeFill);
}
if (zoomInput)
  zoomInput.addEventListener("input", (e) => {
    adjust.zoom = +e.target.value;
    syncCropUI();
    renderPreview();
  });
if (offYInput)
  offYInput.addEventListener("input", (e) => {
    adjust.offsetY = +e.target.value;
    syncCropUI();
    renderPreview();
  });
if (offXInput)
  offXInput.addEventListener("input", (e) => {
    adjust.offsetX = +e.target.value;
    syncCropUI();
    renderPreview();
  });
if ($("guidesChk"))
  $("guidesChk").addEventListener("change", (e) => {
    showGuides = e.target.checked;
    renderPreview();
  });
if ($("resetFrame"))
  $("resetFrame").addEventListener("click", () => {
    adjust = { ...DEFAULT_ADJUST };
    zoomInput.value = 0.8;
    offYInput.value = 0;
    offXInput.value = 0;
    syncCropUI();
    renderPreview();
  });
syncCropUI();

if ($("retryBtn"))
  $("retryBtn").addEventListener("click", async () => {
    if (!lastSourceCanvas) {
      showToast("No active photo to retry. Upload a photo first.", "info");
      return;
    }
    showToast("Re-processing photo with AI improvements…", "info");
    setPhase("processing");
    try {
      const t0 = performance.now();
      const mask = await computeMask(lastSourceCanvas, (p) =>
        updateProc(p.stage, p.total ? Math.round((p.loaded / p.total) * 100) : null),
      );
      cutout = composeCutout(lastSourceCanvas, mask.maskCanvas, lastSourceCanvas.width, lastSourceCanvas.height);
      originalCutoutCanvas = cutout.canvas;
      backend = mask.backend;
      timings = { inference: mask.inferenceMs, total: performance.now() - t0 };
      renderBackendBadge();
      setPhase("result");
      syncEditorUI();
      applyEditsToCutout();
      renderResult();
      showToast("Photo re-processed with improved lighting & face alignment!", "success");
    } catch (err) {
      console.error(err);
      showError(
        uploadError,
        err instanceof Error ? err.message : "Something went wrong during retry.",
      );
      setPhase("upload");
    }
  });

if ($("newBtn")) $("newBtn").addEventListener("click", reset);
if ($("dlSingle")) $("dlSingle").addEventListener("click", () => download("single"));
if ($("dlSheet")) $("dlSheet").addEventListener("click", () => download("sheet"));
if ($("dlPrint")) $("dlPrint").addEventListener("click", () => download("print"));

// Post-download popup
const downloadModal = $("downloadModal");
function showDownloadModal() {
  if (downloadModal) downloadModal.classList.remove("hidden");
}
function hideDownloadModal() {
  if (downloadModal) downloadModal.classList.add("hidden");
}
if (downloadModal)
  downloadModal.addEventListener("click", (e) => {
    if (e.target === downloadModal) hideDownloadModal();
  });
if ($("modalNewImage"))
  $("modalNewImage").addEventListener("click", () => {
    hideDownloadModal();
    reset();
  });
if ($("modalHome"))
  $("modalHome").addEventListener("click", () => {
    hideDownloadModal();
    reset();
  });

// ------- Studio editor sliders -------
const EDIT_LABELS = {
  brightness: "Brightness",
  contrast: "Contrast",
  exposure: "Exposure",
  highlights: "Highlights",
  shadows: "Shadows",
  clarity: "Clarity",
  sharpness: "Sharpness",
  noise: "Denoise",
};
const editorSliders = $("editorSliders");
const editInputs = {};
const editValueEls = {};
if (editorSliders) {
  EDIT_KEYS.forEach((key) => {
    const row = document.createElement("div");
    row.className = "editRow";
    row.innerHTML = `
      <span class="editLabel">${EDIT_LABELS[key]}</span>
      <input type="range" min="-100" max="100" step="1" value="0" data-k="${key}" />
      <span class="editValue" data-k="${key}">0</span>
    `;
    editorSliders.appendChild(row);
    const input = row.querySelector("input");
    editInputs[key] = input;
    editValueEls[key] = row.querySelector(".editValue");
    paintRangeFill(input);
    input.addEventListener("input", (e) => {
      edits[key] = +e.target.value;
      editValueEls[key].textContent = edits[key];
      paintRangeFill(input);
      scheduleEditApply();
    });
    input.addEventListener("dblclick", () => {
      edits[key] = 0;
      input.value = 0;
      editValueEls[key].textContent = 0;
      paintRangeFill(input);
      scheduleEditApply();
    });
  });
}

if ($("resetEdits"))
  $("resetEdits").addEventListener("click", () => {
    edits = { ...DEFAULT_EDITS };
    syncEditorUI();
    saveEdits(edits);
    scheduleEditApply();
  });

function syncEditorUI() {
  EDIT_KEYS.forEach((k) => {
    const v = edits[k] || 0;
    if (editInputs[k]) {
      editInputs[k].value = v;
      editValueEls[k].textContent = v;
      paintRangeFill(editInputs[k]);
    }
  });
}

let editApplyTimer = null;
function scheduleEditApply() {
  saveEdits(edits);
  if (editApplyTimer) clearTimeout(editApplyTimer);
  editApplyTimer = setTimeout(() => {
    editApplyTimer = null;
    applyEditsToCutout();
    renderPreview();
  }, 90);
}

function applyEditsToCutout() {
  if (!originalCutoutCanvas || !cutout) return;
  editedCutoutCanvas = applyEdits(originalCutoutCanvas, edits);
  cutout.canvas = editedCutoutCanvas;
}

let hasCreatedImageInSession = false;

function reset() {
  cutout = null;
  originalCutoutCanvas = null;
  editedCutoutCanvas = null;
  showError(uploadError, null);
  setPhase("upload");
  if (hasCreatedImageInSession) {
    hasCreatedImageInSession = false;
    checkAndShowSavePhotosNotice();
  }
}

function renderResult() {
  const spec = PASSPORT_SPECS.find((s) => s.id === specId) || PASSPORT_SPECS[0];
  const px = specPixels(spec);
  if (specMeta)
    specMeta.textContent = `${spec.widthMM}×${spec.heightMM} mm · ${px.width}×${px.height}px · ${spec.dpi} DPI`;
  if (bgSwatches) {
    Array.from(bgSwatches.querySelectorAll(".sw")).forEach((btn, i) =>
      btn.classList.toggle("active", BACKGROUND_OPTIONS[i].color === bgColor),
    );
  }
  if (timings && $("timings")) {
    $("timings").textContent =
      `Processed in ${(timings.total / 1000).toFixed(2)}s · AI inference ${Math.round(timings.inference)}ms`;
  }
  renderPreview();
}

function renderPreview() {
  if (phase !== "result" || !cutout) return;
  const spec = PASSPORT_SPECS.find((s) => s.id === specId) || PASSPORT_SPECS[0];
  const rendered = renderPassport(cutout, spec, bgColor, adjust);
  const display = $("previewCanvas");
  if (!display) return;
  const maxSide = 380;
  const scale = Math.min(maxSide / rendered.width, maxSide / rendered.height, 1.4);
  display.width = Math.round(rendered.width * scale);
  display.height = Math.round(rendered.height * scale);
  const ctx = display.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.clearRect(0, 0, display.width, display.height);
  ctx.drawImage(rendered, 0, 0, display.width, display.height);
  if (showGuides) {
    const W = display.width,
      H = display.height;
    ctx.save();
    ctx.strokeStyle = "rgba(192, 100, 250, 0.6)";
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 1;
    [0.1, 0.86].forEach((f) => {
      ctx.beginPath();
      ctx.moveTo(0, H * f);
      ctx.lineTo(W, H * f);
      ctx.stroke();
    });
    ctx.beginPath();
    ctx.moveTo(W / 2, 0);
    ctx.lineTo(W / 2, H);
    ctx.stroke();
    ctx.restore();
  }
}

async function download(kind) {
  if (!cutout || busy) return;
  const spec = PASSPORT_SPECS.find((s) => s.id === specId) || PASSPORT_SPECS[0];
  if (kind === "sheet" || kind === "print") {
    recordActivity("print_sheet");
    openPrintEditor({
      cutout,
      spec,
      bgColor,
      adjust,
      count: photoCount,
      format,
      pageSize: "4x6",
    });
    updateHeaderProfileWidget();
    return;
  }

  busy = true;
  if ($("dlSingle")) $("dlSingle").disabled = true;
  if ($("dlSheet")) $("dlSheet").disabled = true;
  if ($("dlPrint")) $("dlPrint").disabled = true;
  showError($("resultError"), null);
  try {
    const photo = renderPassport(cutout, spec, bgColor, adjust);
    const type = format === "png" ? "image/png" : "image/jpeg";
    const ext = format === "png" ? "png" : "jpg";
    const blob = await canvasToBlob(photo, type, format === "jpeg" ? 0.95 : undefined);
    const name = `passport-${spec.id}.${ext}`;
    downloadBlob(blob, name);
    recordActivity("single_download");
    updateHeaderProfileWidget();
    showToast("Photo downloaded successfully!", "success");
    showDownloadModal();
  } catch (err) {
    console.error(err);
    showError($("resultError"), err instanceof Error ? err.message : "Could not export the image.");
  } finally {
    busy = false;
    if ($("dlSingle")) $("dlSingle").disabled = false;
    if ($("dlSheet")) $("dlSheet").disabled = false;
    if ($("dlPrint")) $("dlPrint").disabled = false;
  }
}

// ------- AI Dress Try-On integration -------
let lastPersonDims = null; // { w, h } of the person photo sent to the AI

function canvasFromImage(img) {
  const MAX = 2000;
  const scale = Math.min(1, MAX / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, w, h);
  return c;
}

// Fit the try-on result to the original person's aspect ratio so the face
// is never squeezed sideways or clipped when the passport crop is applied.
// VTON models frequently pad or reshape the output (portrait -> 3:4 / 1:1),
// so we letterbox it (paint on a matching-aspect canvas at the same scale
// as the original) instead of stretching or cropping the head.
function fitResultToPersonAspect(img, target) {
  if (!target || !target.w || !target.h) return canvasFromImage(img);
  const targetAR = target.w / target.h;
  const srcAR = img.width / img.height;

  // Base canvas size uses the original person dimensions (capped).
  const MAX = 2000;
  const scale = Math.min(1, MAX / Math.max(target.w, target.h));
  const cw = Math.max(1, Math.round(target.w * scale));
  const ch = Math.max(1, Math.round(target.h * scale));

  const c = document.createElement("canvas");
  c.width = cw;
  c.height = ch;
  const ctx = c.getContext("2d");
  ctx.imageSmoothingQuality = "high";

  // Fill BG so the background remover has a solid edge to grab. Sample the
  // result's top-left pixel — VTON models keep the original studio backdrop
  // there, which matches the subject's surrounding pixels.
  try {
    const probe = document.createElement("canvas");
    probe.width = 1;
    probe.height = 1;
    probe.getContext("2d").drawImage(img, 0, 0, 1, 1, 0, 0, 1, 1);
    const [r, g, b] = probe.getContext("2d").getImageData(0, 0, 1, 1).data;
    ctx.fillStyle = `rgb(${r},${g},${b})`;
  } catch {
    ctx.fillStyle = "#ffffff";
  }
  ctx.fillRect(0, 0, cw, ch);

  // Scale the AI result to "contain" inside the target aspect — the whole
  // subject stays visible, no horizontal squish, no facial features clipped.
  let dw, dh;
  if (srcAR > targetAR) {
    dw = cw;
    dh = Math.round(cw / srcAR);
  } else {
    dh = ch;
    dw = Math.round(ch * srcAR);
  }
  const dx = Math.round((cw - dw) / 2);
  const dy = Math.round((ch - dh) / 2);
  ctx.drawImage(img, 0, 0, img.width, img.height, dx, dy, dw, dh);
  return c;
}

window.__tryOn = {
  getPersonDataUrl() {
    if (lastSourceCanvas) {
      try {
        lastPersonDims = { w: lastSourceCanvas.width, h: lastSourceCanvas.height };
        return lastSourceCanvas.toDataURL("image/png");
      } catch {}
    }
    const pc = $("previewCanvas");
    if (pc) {
      try {
        lastPersonDims = { w: pc.width, h: pc.height };
        return pc.toDataURL("image/png");
      } catch {}
    }
    return null;
  },
  async applyResult(dataUrl, onStage) {
    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error("Failed to load result image"));
      img.src = dataUrl;
    });
    // Preserve original aspect ratio: no shrinking, no clipped mouth/ear.
    const source = fitResultToPersonAspect(img, lastPersonDims);
    lastSourceCanvas = source;
    onStage && onStage("Removing background…");
    const mask = await computeMask(source, () => {});
    cutout = composeCutout(source, mask.maskCanvas, source.width, source.height);
    originalCutoutCanvas = cutout.canvas;
    backend = mask.backend;
    timings = { inference: mask.inferenceMs, total: 0 };
    renderBackendBadge();
    adjust = { ...DEFAULT_ADJUST };
    if (zoomInput) {
      zoomInput.value = 0.8;
      offYInput.value = 0;
      offXInput.value = 0;
      syncCropUI();
    }
    setPhase("result");
    syncEditorUI();
    applyEditsToCutout();
    renderResult();
  },
};
