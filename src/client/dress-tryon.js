// Manual Dress Editor. "Change Dress" opens a full-screen editor showing the
// exact preview image (cut-out subject, selected ratio and background) where
// the user picks (or uploads) a garment and places it with drag / resize /
// rotate. "Apply" composites it and hands the result to the existing preview
// pipeline via window.__tryOn.applyResult().

import { openModal, closeActiveModal, showToast } from "./modals-manager.js";

const GARMENTS = [
  { id: "g1", label: "Formal", img: "/garments/1.png" },
  { id: "g2", label: "White Tee", img: "/garments/2.png" },
  { id: "g3", label: "Shirt", img: "/garments/3.png" },
  { id: "g4", label: "T-Shirt", img: "/garments/4.png" },
  { id: "g5", label: "Traditional", img: "/garments/5.png" },
];

const $ = (id) => document.getElementById(id);

let preTryOnSnapshot = null;
let preTryOnDims = null;
let baseDims = null;
let lastResultDataUrl = null;
let busy = false;

// Editor state
let baseImg = null; // HTMLImageElement of the person photo
let garmentImg = null; // HTMLImageElement of the chosen garment
// The garment currently chosen in the editor (may not be applied yet).
let selectedGarment = null; // { id: string|null, src: string }
// The garment baked into the working photo. Drives the highlight + the panel
// preview so re-opening the editor never loses (or invents) a selection.
let appliedGarment = null; // { id, src, frac: {x,y,w,h,rot} }
let layer = { x: 0, y: 0, w: 0, h: 0, rot: 0 }; // in stage (display) pixels
let builtUI = false;

/** Revert stays available only while this outfit is still the newest edit. */
function setRevertState() {
  window.__editHistory?.setRevertEnabled?.($("tryOnRevert"), !!preTryOnSnapshot);
}

/** A newer image was produced by another tool — drop this outfit's undo point. */
function invalidateRevert() {
  preTryOnSnapshot = null;
  preTryOnDims = null;
  setRevertState();
}

function setStatus(msg, kind = "") {
  const el = $("tryOnStatus");
  if (!el) return;
  el.textContent = msg || "";
  el.className = "tryOnStatus " + kind;
}

function setEditorStatus(msg) {
  const el = $("dressEditorStatus");
  if (el) el.textContent = msg || "";
}

function updateGenerateBtn() {
  const btn = $("tryOnGenerate");
  if (!btn) return;
  btn.disabled = busy || !window.__tryOn?.getPersonDataUrl?.();
  btn.textContent = "Change Dress";
}

/* ---------------------------------------------------------------- UI build */

function buildEditorUI() {
  if (builtUI) return;
  builtUI = true;

  const overlay = document.createElement("div");
  overlay.id = "dressEditorModal";
  overlay.className = "appModalOverlay dressEditorOverlay hidden";
  overlay.innerHTML = `
    <div class="appModalBox dressEditorBox">
      <div class="appModalHeader">
        <span class="appModalTitle">Dress Editor</span>
        <button type="button" id="dressEditorClose" class="appModalCloseBtn" aria-label="Close">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      <div class="dressEditorBody">
        <div class="dressEditorStageWrap">
          <div id="dressEditorStage" class="dressEditorStage">
            <canvas id="dressEditorBase" class="dressEditorBase"></canvas>
            <div id="dressEditorLayer" class="dressEditorLayer hidden">
              <img id="dressEditorGarment" alt="Garment overlay" draggable="false" />
              <span class="dressHandle dressHandleScale" data-handle="scale"></span>
              <span class="dressHandle dressHandleRotate" data-handle="rotate"></span>
            </div>
          </div>
          <div id="dressEditorStatus" class="dressEditorStatus"></div>
        </div>
        <div class="dressEditorSide">
          <div class="dressEditorSideTitle">Choose a garment</div>
          <div id="dressEditorGrid" class="dressEditorGrid"></div>
          <label id="dressEditorDrop" class="dressEditorDrop">
            <input id="dressEditorFile" type="file" accept="image/*" hidden />
            <span>Drag &amp; drop your own garment image, or click to upload</span>
          </label>
          <div class="dressEditorHint">
            Drag the garment to move it. Use the bottom-right handle to resize and
            the top-right handle to rotate.
          </div>
          <div class="dressEditorActions">
            <button type="button" id="dressEditorApply" class="tryOnBtn primary" disabled>Apply</button>
            <button type="button" id="dressEditorCancel" class="tryOnBtn ghost">Cancel</button>
          </div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  renderGarmentGrid();
  bindEditorEvents();
}

function renderGarmentGrid() {
  const wrap = $("dressEditorGrid");
  if (!wrap) return;
  wrap.innerHTML = "";
  GARMENTS.forEach((g) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "dressEditorThumb";
    el.dataset.id = g.id;
    el.innerHTML = `<span class="dressEditorThumbImg"><img src="${g.img}" alt="${g.label}" loading="lazy" onerror="this.closest('.dressEditorThumb').classList.add('missing')" /></span><span class="dressEditorThumbLabel">${g.label}</span>`;
    el.onclick = async () => {
      try {
        await setGarment(g.img, g.id);
      } catch {
        setEditorStatus("That garment image is not available yet — upload your own.");
      }
    };
    wrap.appendChild(el);
  });
}

/** Highlights exactly one garment thumb — or none when id is null. */
function highlightGarment(id) {
  document
    .querySelectorAll("#dressEditorGrid .dressEditorThumb")
    .forEach((n) => n.classList.toggle("active", !!id && n.dataset.id === id));
}

/** Keeps the "current outfit" preview in the Dress Editor panel in sync. */
function renderAppliedPreview() {
  const wrap = $("tryOnDresses");
  if (!wrap) return;
  if (!appliedGarment) {
    wrap.innerHTML = "";
    wrap.classList.add("hidden");
    return;
  }
  const label = GARMENTS.find((g) => g.id === appliedGarment.id)?.label || "Your garment";
  wrap.classList.remove("hidden");
  wrap.innerHTML = `
    <div class="tryOnCurrent">
      <span class="tryOnCurrentThumb"><img alt="${label}" /></span>
      <span class="tryOnCurrentText">
        <strong>Current outfit</strong>
        <span class="muted small">${label}</span>
      </span>
    </div>`;
  const img = wrap.querySelector("img");
  if (img) img.src = appliedGarment.src;
}

/* ------------------------------------------------------------ editor logic */

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load image"));
    img.src = src;
  });
}

async function openEditor() {
  if (!window.__tryOn) {
    setStatus("Editor not ready yet — upload a photo first.", "err");
    return;
  }
  const personDataUrl = window.__tryOn.getPersonDataUrl();
  if (!personDataUrl) {
    setStatus("Upload a person photo first.", "err");
    return;
  }
  buildEditorUI();
  if (!preTryOnSnapshot) {
    preTryOnSnapshot = personDataUrl;
    const snap = await loadImage(personDataUrl);
    preTryOnDims = { w: snap.naturalWidth, h: snap.naturalHeight };
  }

  // Base layer = the FULL photo with the background removed, not the passport
  // crop. Compositing on the cropped preview made the crop run a second time
  // when the result was applied, which zoomed the photo in and clipped it.
  const baseUrl = window.__tryOn.getPersonCutoutDataUrl?.() || personDataUrl;
  baseImg = await loadImage(baseUrl);
  baseDims = { w: baseImg.naturalWidth, h: baseImg.naturalHeight };
  clearGarment();
  // Restore the outfit that is actually applied — and nothing else. When no
  // outfit is applied, no thumb is highlighted and no garment is placed.
  highlightGarment(appliedGarment?.id || null);
  setEditorStatus(
    appliedGarment
      ? "Your current outfit is loaded — adjust it or pick another."
      : "Pick a garment to start placing it.",
  );
  // The modal must be visible BEFORE any measurement: while it is hidden
  // getBoundingClientRect() returns 0 and the garment would be sized against a
  // zero-width stage (the old clipping / tiny-box bug).
  openModal("dressEditorModal");
  await nextLayoutFrame();
  drawBase();
  if (appliedGarment) {
    try {
      await setGarment(appliedGarment.src, appliedGarment.id, appliedGarment.frac);
    } catch {
      setEditorStatus("Could not reload your current garment — pick one again.");
    }
  }
}

/** Resolves after the browser has laid the (now visible) modal out. */
function nextLayoutFrame() {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

function drawBase() {
  const canvas = $("dressEditorBase");
  const stage = $("dressEditorStage");
  if (!canvas || !baseImg || !stage) return;
  canvas.width = baseImg.naturalWidth;
  canvas.height = baseImg.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(baseImg, 0, 0);
  // Stage matches the rendered canvas box so overlay coords stay in sync.
  const rect = canvas.getBoundingClientRect();
  stage.style.width = rect.width ? `${rect.width}px` : "auto";
  stage.style.height = rect.height ? `${rect.height}px` : "auto";
}

function clearGarment() {
  garmentImg = null;
  selectedGarment = null;
  const l = $("dressEditorLayer");
  if (l) l.classList.add("hidden");
  const apply = $("dressEditorApply");
  if (apply) apply.disabled = true;
}

async function setGarment(src, id = null, frac = null) {
  garmentImg = await loadImage(src);
  selectedGarment = { id, src };
  highlightGarment(id);
  // Re-measure the stage right now — the modal is visible and laid out, so
  // these are the real dimensions the garment can be dragged across.
  drawBase();
  const canvas = $("dressEditorBase");
  let rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    await nextLayoutFrame();
    drawBase();
    rect = canvas.getBoundingClientRect();
  }
  const stageW = rect.width || canvas.width;
  const stageH = rect.height || canvas.height;
  if (frac) {
    // Re-created from the stored placement so the outfit comes back exactly
    // where the user left it, whatever the stage size is this time.
    layer = {
      x: frac.x * stageW,
      y: frac.y * stageH,
      w: frac.w * stageW,
      h: frac.h * stageH,
      rot: frac.rot || 0,
    };
  } else {
    const targetW = stageW * 0.6;
    const ratio = garmentImg.naturalHeight / garmentImg.naturalWidth;
    layer = {
      x: (stageW - targetW) / 2,
      y: stageH * 0.32,
      w: targetW,
      h: targetW * ratio,
      rot: 0,
    };
  }
  const imgEl = $("dressEditorGarment");
  imgEl.src = garmentImg.src;
  $("dressEditorLayer").classList.remove("hidden");
  $("dressEditorApply").disabled = false;
  syncLayer();
  setEditorStatus("Drag to move • corner handle to resize • top handle to rotate");
}

function syncLayer() {
  const l = $("dressEditorLayer");
  if (!l) return;
  l.style.left = `${layer.x}px`;
  l.style.top = `${layer.y}px`;
  l.style.width = `${layer.w}px`;
  l.style.height = `${layer.h}px`;
  l.style.transform = `rotate(${layer.rot}rad)`;
}

/* ------------------------------------------------- drag / resize / rotate */

function bindPointerControls() {
  const stage = $("dressEditorStage");
  const l = $("dressEditorLayer");
  if (!stage || !l) return;

  let mode = null;
  let start = null;

  const stagePoint = (e) => {
    const r = stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onDown = (e) => {
    if (!garmentImg) return;
    const handle = e.target.dataset?.handle;
    mode = handle || "move";
    const p = stagePoint(e);
    start = {
      p,
      layer: { ...layer },
      cx: layer.x + layer.w / 2,
      cy: layer.y + layer.h / 2,
    };
    start.dist = Math.hypot(p.x - start.cx, p.y - start.cy) || 1;
    start.angle = Math.atan2(p.y - start.cy, p.x - start.cx);
    l.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };

  const onMove = (e) => {
    if (!mode || !start) return;
    const p = stagePoint(e);
    if (mode === "move") {
      layer.x = start.layer.x + (p.x - start.p.x);
      layer.y = start.layer.y + (p.y - start.p.y);
    } else if (mode === "scale") {
      const dist = Math.hypot(p.x - start.cx, p.y - start.cy);
      const k = Math.max(0.1, dist / start.dist);
      const w = Math.max(24, start.layer.w * k);
      const h = Math.max(24, start.layer.h * k);
      layer.x = start.cx - w / 2;
      layer.y = start.cy - h / 2;
      layer.w = w;
      layer.h = h;
    } else if (mode === "rotate") {
      const angle = Math.atan2(p.y - start.cy, p.x - start.cx);
      layer.rot = start.layer.rot + (angle - start.angle);
    }
    syncLayer();
    e.preventDefault();
  };

  const onUp = () => {
    mode = null;
    start = null;
  };

  l.addEventListener("pointerdown", onDown);
  window.addEventListener("pointermove", onMove, { passive: false });
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}

/* ------------------------------------------------------- apply / composite */

function compositeToDataUrl() {
  const canvas = document.createElement("canvas");
  canvas.width = baseImg.naturalWidth;
  canvas.height = baseImg.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(baseImg, 0, 0);

  const stageRect = $("dressEditorBase").getBoundingClientRect();
  const k = canvas.width / (stageRect.width || canvas.width);
  const cx = (layer.x + layer.w / 2) * k;
  const cy = (layer.y + layer.h / 2) * k;
  const w = layer.w * k;
  const h = layer.h * k;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(layer.rot);
  ctx.drawImage(garmentImg, -w / 2, -h / 2, w, h);
  ctx.restore();

  return canvas.toDataURL("image/png");
}

/** Stores the applied garment + its placement as stage-relative fractions. */
function rememberAppliedGarment() {
  const rect = $("dressEditorBase")?.getBoundingClientRect();
  const stageW = rect?.width || 1;
  const stageH = rect?.height || 1;
  appliedGarment = {
    id: selectedGarment?.id || null,
    src: selectedGarment?.src || garmentImg?.src,
    frac: {
      x: layer.x / stageW,
      y: layer.y / stageH,
      w: layer.w / stageW,
      h: layer.h / stageH,
      rot: layer.rot,
    },
  };
  renderAppliedPreview();
}

async function applyEdit() {
  if (!garmentImg || !baseImg || busy) return;
  busy = true;
  const applyBtn = $("dressEditorApply");
  if (applyBtn) {
    applyBtn.disabled = true;
    applyBtn.textContent = "Applying…";
  }
  try {
    const dataUrl = compositeToDataUrl();
    lastResultDataUrl = dataUrl;
    rememberAppliedGarment();
    closeActiveModal();
    setStatus("Applying your new look…");
    // New working image — any other feature's revert point is now stale.
    window.__editHistory?.claim?.("tryOn");
    await window.__tryOn.applyResult(dataUrl, (m) => setStatus(m), baseDims);
    setRevertState();
    setStatus("Outfit applied. Open the editor again to adjust it.", "ok");
    showToast("Outfit applied", "success");
  } catch (e) {
    setStatus(e?.message || "Could not apply the garment.", "err");
  } finally {
    busy = false;
    if (applyBtn) applyBtn.textContent = "Apply";
    updateGenerateBtn();
  }
}

async function revert() {
  if (!preTryOnSnapshot || busy) return;
  busy = true;
  updateGenerateBtn();
  setStatus("Restoring original…");
  try {
    await window.__tryOn.applyResult(preTryOnSnapshot, (m) => setStatus(m), preTryOnDims);
    preTryOnSnapshot = null;
    lastResultDataUrl = null;
    // No outfit is applied any more: clear the highlight and the preview.
    appliedGarment = null;
    highlightGarment(null);
    renderAppliedPreview();
    setRevertState();
    setStatus("Reverted to original.", "ok");
  } catch (e) {
    setStatus(e?.message || "Could not revert.", "err");
  } finally {
    busy = false;
    updateGenerateBtn();
  }
}

/* --------------------------------------------------------------- bindings */

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error("Could not read image"));
    r.readAsDataURL(file);
  });
}

async function useCustomFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    setEditorStatus("Please choose an image file.");
    return;
  }
  const dataUrl = await readFileAsDataUrl(file);
  await setGarment(dataUrl, null);
}

function bindEditorEvents() {
  bindPointerControls();

  $("dressEditorClose").onclick = () => closeActiveModal();
  $("dressEditorCancel").onclick = () => closeActiveModal();
  $("dressEditorApply").onclick = applyEdit;

  const input = $("dressEditorFile");
  input.addEventListener("change", (e) => useCustomFile(e.target.files?.[0]));

  const drop = $("dressEditorDrop");
  ["dragenter", "dragover"].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add("over");
    }),
  );
  ["dragleave", "drop"].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.remove("over");
    }),
  );
  drop.addEventListener("drop", (e) => useCustomFile(e.dataTransfer?.files?.[0]));

  window.addEventListener("resize", () => {
    if (!$("dressEditorModal")?.classList.contains("hidden")) drawBase();
  });
}

/** Called when a brand-new photo is loaded: drop every try-on result so the
 *  previous outfit can never reappear on the new image. */
function resetSession() {
  preTryOnSnapshot = null;
  preTryOnDims = null;
  baseDims = null;
  lastResultDataUrl = null;
  baseImg = null;
  garmentImg = null;
  selectedGarment = null;
  appliedGarment = null;
  busy = false;
  layer = { x: 0, y: 0, w: 0, h: 0, rot: 0 };
  const l = $("dressEditorLayer");
  if (l) l.classList.add("hidden");
  const apply = $("dressEditorApply");
  if (apply) apply.disabled = true;
  const base = $("dressEditorBase");
  if (base) {
    const ctx = base.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, base.width, base.height);
  }
  highlightGarment(null);
  renderAppliedPreview();
  setStatus("");
  setEditorStatus("");
  setRevertState();
  updateGenerateBtn();
}

function bind() {
  const gen = $("tryOnGenerate");
  if (gen) gen.onclick = () => openEditor();
  const rev = $("tryOnRevert");
  if (rev) rev.onclick = revert;
  renderAppliedPreview();
  const custom = $("tryOnCustom");
  if (custom) custom.classList.add("hidden");

  const obs = new MutationObserver(updateGenerateBtn);
  const resultView = document.getElementById("resultView");
  if (resultView) obs.observe(resultView, { attributes: true, attributeFilter: ["class"] });
  updateGenerateBtn();

  setRevertState();
  window.__editHistory?.register?.("tryOn", { invalidate: invalidateRevert });
  (window.__aiSessionResets ||= []).push(resetSession);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
else bind();

export { lastResultDataUrl };
