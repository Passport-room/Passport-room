// Crystal (three.js) is dynamically imported on demand to keep mobile lightweight.
import { PASSPORT_SPECS, BACKGROUND_OPTIONS, specPixels } from "./passport-specs.js";
import { computeMask } from "./background-removal.js";
import {
  composeCutout,
  renderPassport,
  frameGeometry,
  buildPrintSheet,
  canvasToBlob,
  downloadBlob,
  DEFAULT_ADJUST,
} from "./passport-render.js";
import { EDIT_KEYS, DEFAULT_EDITS, applyEdits, loadEdits, saveEdits } from "./photo-editor.js";
import { openPrintEditor, resetPrintEditor } from "./print-editor.js";
import { loadCustomSizes, saveCustomSizes, customToSpec } from "./custom-sizes.js";
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

/**
 * Single source of truth for "what can still be reverted".
 *
 * Every feature that produces a NEW working image (AI Enhance, Outfit change,
 * Save crop, …) calls claim("<its id>") first. That invalidates every OTHER
 * feature's revert snapshot, because those snapshots describe an image state
 * that no longer exists — reverting to them would throw away the newer edit.
 * Each feature registers an invalidate() hook that drops its snapshot and
 * disables its Revert button.
 */
const revertOwners = new Map();
window.__editHistory = {
  register(id, hooks) {
    revertOwners.set(id, hooks);
  },
  claim(id) {
    for (const [otherId, hooks] of revertOwners) {
      if (otherId === id) continue;
      try {
        hooks?.invalidate?.();
      } catch (e) {
        console.warn("Revert invalidation hook failed:", e);
      }
    }
  },
  /** Shared helper so every Revert button looks and behaves the same. */
  setRevertEnabled(el, enabled) {
    if (!el) return;
    el.classList.remove("hidden");
    el.disabled = !enabled;
    el.setAttribute("aria-disabled", String(!enabled));
    el.title = enabled ? "Undo this edit" : "Nothing to revert — a newer edit replaced it";
  },
};

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
// The ONE true original: captured once when the user first uploads a file and
// never overwritten by applyResult(): the true original of this session.
let originalUploadCanvas = null;
let specId = PASSPORT_SPECS[0].id;
let customSpec = null; // active temporary/saved custom size (mm), or null
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

/** The spec currently driving every render: a custom mm size when one is
 *  active, otherwise the selected standard preset. */
function getActiveSpec() {
  return customSpec || PASSPORT_SPECS.find((s) => s.id === specId) || PASSPORT_SPECS[0];
}

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
  const lowMem =
    typeof navigator !== "undefined" && navigator.deviceMemory && navigator.deviceMemory < 4;
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
    customSpec = null;
    buildSpecSelect();
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

/**
 * Wipes every artefact of the previous editing session so a freshly loaded
 * photo can never show an earlier outfit, face-enhance result, cached preview
 * or leftover slider adjustment. The downloaded AI models stay on the device —
 * only per-photo results are cleared.
 */
function startFreshSession() {
  cutout = null;
  originalCutoutCanvas = null;
  editedCutoutCanvas = null;
  lastSourceCanvas = null;
  originalUploadCanvas = null;
  lastPersonDims = null;
  backend = null;
  timings = null;
  adjust = { ...DEFAULT_ADJUST };

  // Slider edits are per-photo, never inherited from a previous session.
  edits = { ...DEFAULT_EDITS };
  saveEdits(edits);
  syncEditorUI();

  if (zoomInput && offYInput && offXInput) {
    zoomInput.value = DEFAULT_ADJUST.zoom;
    offYInput.value = 0;
    offXInput.value = 0;
    syncCropUI();
  }

  // Clear the on-screen preview so nothing from the old photo flashes through.
  const pc = $("previewCanvas");
  if (pc) {
    const pctx = pc.getContext("2d");
    if (pctx) pctx.clearRect(0, 0, pc.width, pc.height);
  }

  // Discard the A4 sheet state and any outfit / enhance results.
  resetPrintEditor();
  (window.__aiSessionResets || []).forEach((fn) => {
    try {
      fn();
    } catch (e) {
      console.warn("Session reset hook failed:", e);
    }
  });
}

async function handleFile(file) {
  if (!file.type.startsWith("image/")) {
    showError(uploadError, "Please choose an image file (JPG or PNG).");
    return;
  }
  showError(uploadError, null);
  startFreshSession();
  setPhase("processing");
  updateProc("download", null);

  try {
    const t0 = performance.now();
    const source = await fileToSourceCanvas(file);
    lastSourceCanvas = source;
    originalUploadCanvas = source; // set once, at initial upload only
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
    const currentSpec = getActiveSpec();
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
function buildSpecSelect() {
  if (!specSelect) return;
  const saved = loadCustomSizes();
  specSelect.innerHTML = "";

  const presetGroup = document.createElement("optgroup");
  presetGroup.label = "Standard sizes";
  PASSPORT_SPECS.forEach((s) => {
    const o = document.createElement("option");
    o.value = s.id;
    o.textContent = s.label;
    presetGroup.appendChild(o);
  });
  specSelect.appendChild(presetGroup);

  if (saved.length) {
    const g = document.createElement("optgroup");
    g.label = "Saved custom sizes";
    saved.forEach((e) => {
      const sp = customToSpec(e);
      const o = document.createElement("option");
      o.value = "saved:" + sp.label;
      o.textContent = sp.label;
      g.appendChild(o);
    });
    specSelect.appendChild(g);
  }

  const customOpt = document.createElement("option");
  customOpt.value = "__custom__";
  customOpt.textContent = "Custom size…";
  specSelect.appendChild(customOpt);

  if (customSpec) {
    const savedMatch = saved.some((e) => customToSpec(e).label === customSpec.label);
    specSelect.value = savedMatch ? "saved:" + customSpec.label : "__custom__";
  } else {
    specSelect.value = specId;
  }
  syncCustomSizeBox();
}

function syncCustomSizeBox() {
  const box = $("mainCustomSizeBox");
  if (!box || !specSelect) return;
  const show = specSelect.value === "__custom__" || !!customSpec;
  box.classList.toggle("hidden", !show);
  if (customSpec) {
    if ($("mainCustomW")) $("mainCustomW").value = customSpec.widthMM;
    if ($("mainCustomH")) $("mainCustomH").value = customSpec.heightMM;
  }
  const del = $("mainCustomDelete");
  if (del) del.classList.toggle("hidden", !String(specSelect.value).startsWith("saved:"));
}

function applyCustomSpec(spec) {
  customSpec = spec;
  buildSpecSelect();
  renderResult();
}

if (specSelect) {
  buildSpecSelect();
  specSelect.addEventListener("change", () => {
    const val = specSelect.value;
    if (val === "__custom__") {
      const base = getActiveSpec();
      if ($("mainCustomW") && !$("mainCustomW").value) $("mainCustomW").value = base.widthMM;
      if ($("mainCustomH") && !$("mainCustomH").value) $("mainCustomH").value = base.heightMM;
      syncCustomSizeBox();
      return;
    }
    if (val.startsWith("saved:")) {
      const label = val.slice(6);
      const entry = loadCustomSizes().find((c) => customToSpec(c).label === label);
      if (entry) applyCustomSpec(customToSpec(entry));
      return;
    }
    customSpec = null;
    specId = val;
    syncCustomSizeBox();
    renderResult();
  });

  const readCustomMM = () => {
    const w = Number($("mainCustomW")?.value);
    const h = Number($("mainCustomH")?.value);
    if (!(w > 5 && h > 5 && w <= 210 && h <= 297)) {
      showToast("Enter a width and height between 5 and 210/297 mm.", "error");
      return null;
    }
    return { w, h };
  };

  if ($("mainCustomApply"))
    $("mainCustomApply").addEventListener("click", () => {
      const mm = readCustomMM();
      if (!mm) return;
      applyCustomSpec({
        ...customToSpec({ name: `Custom ${mm.w}×${mm.h}mm`, widthMM: mm.w, heightMM: mm.h }),
        label: `Custom ${mm.w}×${mm.h}mm`,
      });
      showToast(`Using custom size ${mm.w}×${mm.h} mm.`, "success");
    });

  if ($("mainCustomSave"))
    $("mainCustomSave").addEventListener("click", () => {
      const mm = readCustomMM();
      if (!mm) return;
      const nameEl = $("mainCustomName");
      const name = (nameEl?.value || "").trim();
      if (!name) {
        showToast("Give the size a name before saving.", "error");
        return;
      }
      const list = loadCustomSizes().filter((c) => c.name !== name);
      list.push({ name, widthMM: mm.w, heightMM: mm.h });
      saveCustomSizes(list);
      if (nameEl) nameEl.value = "";
      applyCustomSpec(customToSpec({ name, widthMM: mm.w, heightMM: mm.h }));
      showToast(`Saved “${name}” — also available in the print editor.`, "success");
    });

  if ($("mainCustomDelete"))
    $("mainCustomDelete").addEventListener("click", () => {
      if (!specSelect.value.startsWith("saved:")) return;
      const label = specSelect.value.slice(6);
      saveCustomSizes(loadCustomSizes().filter((c) => customToSpec(c).label !== label));
      customSpec = null;
      specId = PASSPORT_SPECS[0].id;
      buildSpecSelect();
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

/** Keeps the Copies control in sync when the A4 sheet editor changes it. */
window.__setPhotoCount = (n) => {
  const val = Math.max(1, Math.min(60, parseInt(n, 10) || 1));
  photoCount = val;
  document
    .querySelectorAll(".qtyBtn")
    .forEach((x) => x.classList.toggle("active", parseInt(x.dataset.count, 10) === photoCount));
  const input = $("qtyCustomInput");
  if (input) input.value = photoCount;
};

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
    zoomInput.value = DEFAULT_ADJUST.zoom;
    offYInput.value = 0;
    offXInput.value = 0;
    syncCropUI();
    renderPreview();
  });

// "Save crop" bakes the current framing into the working image, so every later
// tool (AI Enhance, Outfit, background, print) starts from the cropped photo.
if ($("saveCrop"))
  $("saveCrop").addEventListener("click", async () => {
    if (!cutout || busy) return;
    const btn = $("saveCrop");
    busy = true;
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = "Saving crop…";
    try {
      const spec = getActiveSpec();
      // Flatten at the current background so the baked photo can be re-masked.
      const baked = renderPassport(cutout, spec, bgColor, adjust);
      // A brand-new image: earlier AI results are no longer revertible.
      window.__editHistory.claim("crop");
      // The crop is already baked into these pixels, so this is the one case
      // where the framing must be detected afresh instead of pinned.
      await window.__tryOn.applyResult(
        baked.toDataURL("image/png"),
        null,
        { w: baked.width, h: baked.height },
        { reframe: true },
      );
      // The crop now lives in the pixels, so the framing sliders start from the
      // neutral default again and re-frame the already-cropped photo.
      adjust = { ...DEFAULT_ADJUST };
      zoomInput.value = DEFAULT_ADJUST.zoom;
      offYInput.value = 0;
      offXInput.value = 0;
      syncCropUI();
      renderResult();
      showToast("Crop saved — it's now your working photo.", "success");
    } catch (e) {
      console.error(e);
      showToast(e?.message || "Could not save the crop.", "error");
    } finally {
      busy = false;
      btn.disabled = false;
      btn.textContent = label;
    }
  });
syncCropUI();

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
  startFreshSession();
  showError(uploadError, null);
  setPhase("upload");
  if (hasCreatedImageInSession) {
    hasCreatedImageInSession = false;
    checkAndShowSavePhotosNotice();
  }
}

function renderResult() {
  const spec = getActiveSpec();
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
  const spec = getActiveSpec();
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
  const spec = getActiveSpec();
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
  /** The untouched photo the user uploaded — never an enhanced / try-on result. */
  getOriginalDataUrl() {
    if (originalUploadCanvas) {
      try {
        lastPersonDims = { w: originalUploadCanvas.width, h: originalUploadCanvas.height };
        return originalUploadCanvas.toDataURL("image/png");
      } catch {}
    }
    return this.getPersonDataUrl();
  },
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
  // Full-frame, background-removed subject on the current backdrop — NOT the
  // passport crop. The Dress Editor uses this as its base layer so the garment
  // is composited onto the whole photo; feeding it the cropped preview made the
  // passport crop run twice and the result looked zoomed in / clipped.
  getPersonCutoutDataUrl() {
    try {
      if (!cutout) return null;
      const c = document.createElement("canvas");
      c.width = cutout.width;
      c.height = cutout.height;
      const ctx = c.getContext("2d");
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(cutout.canvas, 0, 0, c.width, c.height);
      lastPersonDims = { w: c.width, h: c.height };
      return c.toDataURL("image/png");
    } catch {
      return null;
    }
  },
  // Exactly what the Preview panel shows: cut-out subject, selected ratio and
  // background.
  getPreviewDataUrl() {
    try {
      if (!cutout) return null;
      const spec = getActiveSpec();
      const rendered = renderPassport(cutout, spec, bgColor, adjust);
      return rendered.toDataURL("image/png");
    } catch {
      return null;
    }
  },

  async applyResult(dataUrl, onStage, dims, opts) {
    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error("Failed to load result image"));
      img.src = dataUrl;
    });
    // Preserve original aspect ratio: no shrinking, no clipped mouth/ear.
    const source = fitResultToPersonAspect(img, dims || lastPersonDims);

    // Pin the framing the user is looking at RIGHT NOW. Re-detecting the face
    // on the AI result picks slightly different anchors, which showed up as an
    // unwanted zoom-in / crop after AI Enhance and AI Try-On.
    const pinnedFrame =
      cutout && !(opts && opts.reframe) ? cutout.pinnedFrame || frameGeometry(cutout) : null;

    // Current working state only — originalUploadCanvas is never reassigned here.
    lastSourceCanvas = source;
    onStage && onStage("Removing background…");
    const mask = await computeMask(source, () => {});
    cutout = composeCutout(source, mask.maskCanvas, source.width, source.height);
    if (pinnedFrame) cutout.pinnedFrame = pinnedFrame;
    originalCutoutCanvas = cutout.canvas;
    backend = mask.backend;
    timings = { inference: mask.inferenceMs, total: 0 };
    renderBackendBadge();
    // Crop framing (zoom / offsets) and the Adjust sliders are USER settings:
    // they survive every tool so the next feature continues from the current
    // look instead of silently snapping back to defaults.
    syncCropUI();

    setPhase("result");
    syncEditorUI();
    applyEditsToCutout();
    renderResult();
  },
};
