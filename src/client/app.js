import { initCrystal } from "./crystal.js";
import { PASSPORT_SPECS, BACKGROUND_OPTIONS, specPixels } from "./passport-specs.js";
import { computeMask } from "./background-removal.js";
import { composeCutout, renderPassport, buildPrintSheet, canvasToBlob, downloadBlob, DEFAULT_ADJUST } from "./passport-render.js";
import { EDIT_KEYS, DEFAULT_EDITS, applyEdits, loadEdits, saveEdits } from "./photo-editor.js";

const $ = id => document.getElementById(id);

function paintRangeFill(input){
  const min = parseFloat(input.min), max = parseFloat(input.max), val = parseFloat(input.value);
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
let bgColor = BACKGROUND_OPTIONS[0].color;
let adjust = { ...DEFAULT_ADJUST };
let edits = loadEdits(); // persisted from previous session
let showGuides = true;
let format = "jpeg";
let backend = null;
let timings = null;
let busy = false;

// Views
const views = { upload:$("uploadView"), processing:$("processingView"), result:$("resultView") };
function setPhase(p){
  phase = p;
  for (const [k,el] of Object.entries(views)) el.classList.toggle("hidden", k !== p);
  // Home-only sections (About + Articles) show only on the upload/home view
  document.querySelectorAll("[data-home-only]").forEach(el => el.classList.toggle("hidden", p !== "upload"));
  if (p === "upload" && !crystalTeardown) startCrystal();
  if (p !== "upload" && crystalTeardown){ crystalTeardown(); crystalTeardown = null; }
}

// Crystal (only on landing)
let crystalTeardown = null;
function startCrystal(){
  crystalTeardown = initCrystal($("crystalCanvas"), $("crystalBox"));
}
startCrystal();

// Header dropdowns
const profileBtn = $("profileBtn"), menuBtn = $("menuBtn");
const profileMenu = $("profileMenu"), menuMenu = $("menuMenu");
function closeMenus(){ profileMenu.classList.add("hidden"); menuMenu.classList.add("hidden"); profileBtn.setAttribute("aria-expanded","false"); menuBtn.setAttribute("aria-expanded","false"); }
profileBtn.addEventListener("click", e => { e.stopPropagation(); const open = profileMenu.classList.toggle("hidden"); menuMenu.classList.add("hidden"); profileBtn.setAttribute("aria-expanded", String(!open)); menuBtn.setAttribute("aria-expanded","false"); });
menuBtn.addEventListener("click", e => { e.stopPropagation(); const open = menuMenu.classList.toggle("hidden"); profileMenu.classList.add("hidden"); menuBtn.setAttribute("aria-expanded", String(!open)); profileBtn.setAttribute("aria-expanded","false"); });
document.addEventListener("click", e => { if (!e.target.closest(".btnGroup")) closeMenus(); });
menuMenu.addEventListener("click", e => {
  const btn = e.target.closest(".ddItem"); if (!btn) return;
  if (btn.dataset.action === "new") reset();
  closeMenus();
});
profileMenu.addEventListener("click", e => { if (e.target.closest(".ddItem")) closeMenus(); });

// Upload
const drop = $("drop"), fileInput = $("fileInput"), pickBtn = $("pickBtn"), uploadError = $("uploadError");
pickBtn.addEventListener("click", e => { e.stopPropagation(); fileInput.click(); });
drop.addEventListener("click", () => fileInput.click());
drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("drag"); });
drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
drop.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("drag"); const f = e.dataTransfer.files?.[0]; if (f) handleFile(f); });
fileInput.addEventListener("change", e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; });

async function fileToSourceCanvas(file){
  const bitmap = await createImageBitmap(file, { imageOrientation:"from-image" });
  const MAX = 2000;
  const scale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width*scale));
  const h = Math.max(1, Math.round(bitmap.height*scale));
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return canvas;
}

function showError(el, msg){ if (!msg){ el.classList.add("hidden"); return; } el.textContent = msg; el.classList.remove("hidden"); }

async function handleFile(file){
  if (!file.type.startsWith("image/")){ showError(uploadError, "Please choose an image file (JPG or PNG)."); return; }
  showError(uploadError, null);
  backend = null; timings = null;
  adjust = { ...DEFAULT_ADJUST };
  setPhase("processing");
  updateProc("download", null);

  try {
    const t0 = performance.now();
    const source = await fileToSourceCanvas(file);
    lastSourceCanvas = source;
    const mask = await computeMask(source, p => updateProc(p.stage, p.total ? Math.round((p.loaded/p.total)*100) : null));
    cutout = composeCutout(source, mask.maskCanvas, source.width, source.height);
    originalCutoutCanvas = cutout.canvas;
    backend = mask.backend;
    timings = { inference: mask.inferenceMs, total: performance.now() - t0 };
    renderBackendBadge();
    setPhase("result");
    syncEditorUI();
    applyEditsToCutout(); // may be no-op if edits are default
    renderResult();
  } catch (err){
    console.error(err);
    showError(uploadError, err instanceof Error ? err.message : "Something went wrong while processing.");
    setPhase("upload");
  }
}

function updateProc(stage, pct){
  const t = $("procTitle"), sub = $("procSub");
  if (stage === "download"){ t.textContent = "Warming up the AI…"; sub.textContent = "Preparing your photo studio."; }
  else if (stage === "compile"){ t.textContent = "Tuning the studio lights…"; sub.textContent = "Getting everything ready for you."; }
  else if (stage === "ready"){ t.textContent = "Polishing your portrait…"; sub.textContent = "Almost there."; }
  else if (stage === "done"){ t.textContent = "Finishing up…"; sub.textContent = "Almost there."; }
}

function renderBackendBadge(){
  const el = $("backendBadge");
  if (!el) return;
  if (backend === "webgpu"){ el.textContent = "⚡ WebGPU"; el.classList.remove("hidden"); }
  else { el.textContent = ""; el.classList.add("hidden"); }
}

// Result view
const specSelect = $("specSelect"), specMeta = $("specMeta");
PASSPORT_SPECS.forEach(s => {
  const o = document.createElement("option"); o.value = s.id; o.textContent = s.label; specSelect.appendChild(o);
});
specSelect.addEventListener("change", () => { specId = specSelect.value; renderResult(); });

const bgSwatches = $("bgSwatches");
BACKGROUND_OPTIONS.forEach(b => {
  const btn = document.createElement("button");
  btn.className = "sw"; btn.style.backgroundColor = b.color; btn.title = b.label;
  btn.addEventListener("click", () => { bgColor = b.color; renderResult(); });
  bgSwatches.appendChild(btn);
});
const colorLabel = document.createElement("label");
colorLabel.className = "swColor"; colorLabel.title = "Custom color"; colorLabel.textContent = "+";
const colorInput = document.createElement("input");
colorInput.type = "color"; colorInput.value = bgColor;
colorInput.addEventListener("input", e => { bgColor = e.target.value; renderResult(); });
colorLabel.appendChild(colorInput);
bgSwatches.appendChild(colorLabel);

document.querySelectorAll(".fmtBtn").forEach(b => {
  b.addEventListener("click", () => {
    format = b.dataset.fmt;
    document.querySelectorAll(".fmtBtn").forEach(x => x.classList.toggle("active", x === b));
  });
});

const zoomInput = $("zoom"), offYInput = $("offY"), offXInput = $("offX");
const zoomVal = $("zoomVal"), offYVal = $("offYVal"), offXVal = $("offXVal");
function syncCropUI(){
  zoomVal.textContent = (+zoomInput.value).toFixed(2) + "×";
  offYVal.textContent = Math.round(+offYInput.value * 100);
  offXVal.textContent = Math.round(+offXInput.value * 100);
  [zoomInput, offYInput, offXInput].forEach(paintRangeFill);
}
zoomInput.addEventListener("input", e => { adjust.zoom = +e.target.value; syncCropUI(); renderPreview(); });
offYInput.addEventListener("input", e => { adjust.offsetY = +e.target.value; syncCropUI(); renderPreview(); });
offXInput.addEventListener("input", e => { adjust.offsetX = +e.target.value; syncCropUI(); renderPreview(); });
$("guidesChk").addEventListener("change", e => { showGuides = e.target.checked; renderPreview(); });
$("resetFrame").addEventListener("click", () => {
  adjust = { ...DEFAULT_ADJUST };
  zoomInput.value = 1; offYInput.value = 0; offXInput.value = 0;
  syncCropUI();
  renderPreview();
});
syncCropUI();
$("newBtn").addEventListener("click", reset);
$("dlSingle").addEventListener("click", () => download("single"));
$("dlSheet").addEventListener("click", () => download("sheet"));
$("dlPrint").addEventListener("click", () => download("print"));

// Post-download popup
const downloadModal = $("downloadModal");
function showDownloadModal(){ downloadModal.classList.remove("hidden"); }
function hideDownloadModal(){ downloadModal.classList.add("hidden"); }
downloadModal.addEventListener("click", e => { if (e.target === downloadModal) hideDownloadModal(); });
$("modalNewImage").addEventListener("click", () => { hideDownloadModal(); reset(); });
$("modalHome").addEventListener("click", () => { hideDownloadModal(); reset(); });

// ------- Studio editor sliders -------
const EDIT_LABELS = {
  brightness:"Brightness", contrast:"Contrast",
  exposure:"Exposure", highlights:"Highlights",
  shadows:"Shadows", clarity:"Clarity",
  sharpness:"Sharpness", noise:"Denoise",
};
const editorSliders = $("editorSliders");
const editInputs = {};
const editValueEls = {};
EDIT_KEYS.forEach(key => {
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
  input.addEventListener("input", e => {
    edits[key] = +e.target.value;
    editValueEls[key].textContent = edits[key];
    paintRangeFill(input);
    scheduleEditApply();
  });
  input.addEventListener("dblclick", () => {
    edits[key] = 0; input.value = 0; editValueEls[key].textContent = 0;
    paintRangeFill(input);
    scheduleEditApply();
  });
});
$("resetEdits").addEventListener("click", () => {
  edits = { ...DEFAULT_EDITS };
  syncEditorUI();
  saveEdits(edits);
  scheduleEditApply();
});

function syncEditorUI(){
  EDIT_KEYS.forEach(k => {
    const v = edits[k] || 0;
    if (editInputs[k]){ editInputs[k].value = v; editValueEls[k].textContent = v; paintRangeFill(editInputs[k]); }
  });
}

let editApplyTimer = null;
function scheduleEditApply(){
  saveEdits(edits);
  if (editApplyTimer) clearTimeout(editApplyTimer);
  editApplyTimer = setTimeout(() => {
    editApplyTimer = null;
    applyEditsToCutout();
    renderPreview();
  }, 90);
}

function applyEditsToCutout(){
  if (!originalCutoutCanvas || !cutout) return;
  editedCutoutCanvas = applyEdits(originalCutoutCanvas, edits);
  cutout.canvas = editedCutoutCanvas;
}

function reset(){
  cutout = null;
  originalCutoutCanvas = null;
  editedCutoutCanvas = null;
  showError(uploadError, null);
  setPhase("upload");
}

function renderResult(){
  const spec = PASSPORT_SPECS.find(s => s.id === specId) || PASSPORT_SPECS[0];
  const px = specPixels(spec);
  specMeta.textContent = `${spec.widthMM}×${spec.heightMM} mm · ${px.width}×${px.height}px · ${spec.dpi} DPI`;
  Array.from(bgSwatches.querySelectorAll(".sw")).forEach((btn, i) => btn.classList.toggle("active", BACKGROUND_OPTIONS[i].color === bgColor));
  if (timings){
    $("timings").textContent = `Processed in ${(timings.total/1000).toFixed(2)}s · AI inference ${Math.round(timings.inference)}ms`;
  }
  renderPreview();
}

function renderPreview(){
  if (phase !== "result" || !cutout) return;
  const spec = PASSPORT_SPECS.find(s => s.id === specId) || PASSPORT_SPECS[0];
  const rendered = renderPassport(cutout, spec, bgColor, adjust);
  const display = $("previewCanvas");
  const maxSide = 380;
  const scale = Math.min(maxSide / rendered.width, maxSide / rendered.height, 1.4);
  display.width = Math.round(rendered.width * scale);
  display.height = Math.round(rendered.height * scale);
  const ctx = display.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.clearRect(0, 0, display.width, display.height);
  ctx.drawImage(rendered, 0, 0, display.width, display.height);
  if (showGuides){
    const W = display.width, H = display.height;
    ctx.save();
    ctx.strokeStyle = "rgba(192, 100, 250, 0.6)";
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 1;
    [0.1, 0.86].forEach(f => { ctx.beginPath(); ctx.moveTo(0, H*f); ctx.lineTo(W, H*f); ctx.stroke(); });
    ctx.beginPath(); ctx.moveTo(W/2, 0); ctx.lineTo(W/2, H); ctx.stroke();
    ctx.restore();
  }
}

async function download(kind){
  if (!cutout || busy) return;
  busy = true;
  $("dlSingle").disabled = true; $("dlSheet").disabled = true; $("dlPrint").disabled = true;
  showError($("resultError"), null);
  try {
    const spec = PASSPORT_SPECS.find(s => s.id === specId) || PASSPORT_SPECS[0];
    const photo = renderPassport(cutout, spec, bgColor, adjust);
    const target = kind === "sheet" ? buildPrintSheet(photo, spec) : photo;
    if (kind === "print"){
      const dataUrl = target.toDataURL("image/png");
      const w = window.open("", "_blank");
      if (!w) throw new Error("Popup blocked — allow popups to print.");
      w.document.write(`<!doctype html><title>Print photo</title><style>@page{margin:10mm}body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh}img{max-width:100%;max-height:100vh}</style><img src="${dataUrl}" onload="setTimeout(()=>{window.print();},200)"/>`);
      w.document.close();
    } else {
      const type = format === "png" ? "image/png" : "image/jpeg";
      const ext = format === "png" ? "png" : "jpg";
      const blob = await canvasToBlob(target, type, format === "jpeg" ? 0.95 : undefined);
      const name = kind === "sheet" ? `passport-a4-sheet.${ext}` : `passport-${spec.id}.${ext}`;
      downloadBlob(blob, name);
      showDownloadModal();
    }
  } catch (err){
    console.error(err);
    showError($("resultError"), err instanceof Error ? err.message : "Could not export the image.");
  } finally {
    busy = false;
    $("dlSingle").disabled = false; $("dlSheet").disabled = false; $("dlPrint").disabled = false;
  }
}

// ---------- AI Dress Try-On integration ----------
// Exposes hooks the dress-tryon.js module uses to feed a swapped-outfit image
// back into the pipeline (background removal → editor → passport → download).

function canvasFromImage(img){
  const MAX = 2000;
  const scale = Math.min(1, MAX / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width*scale));
  const h = Math.max(1, Math.round(img.height*scale));
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, w, h);
  return c;
}

window.__tryOn = {
  getPersonDataUrl(){
    if (lastSourceCanvas){
      try { return lastSourceCanvas.toDataURL("image/png"); } catch {}
    }
    const pc = $("previewCanvas");
    if (pc){ try { return pc.toDataURL("image/png"); } catch {} }
    return null;
  },
  async applyResult(dataUrl, onStage){
    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error("Failed to load result image")); img.src = dataUrl; });
    const source = canvasFromImage(img);
    lastSourceCanvas = source;
    onStage && onStage("Removing background…");
    const mask = await computeMask(source, () => {});
    cutout = composeCutout(source, mask.maskCanvas, source.width, source.height);
    originalCutoutCanvas = cutout.canvas;
    backend = mask.backend;
    timings = { inference: mask.inferenceMs, total: 0 };
    renderBackendBadge();
    adjust = { ...DEFAULT_ADJUST };
    if (zoomInput){ zoomInput.value = 1; offYInput.value = 0; offXInput.value = 0; syncCropUI(); }
    setPhase("result");
    syncEditorUI();
    applyEditsToCutout();
    renderResult();
  },
};
