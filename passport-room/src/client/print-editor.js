import { PASSPORT_SPECS, BACKGROUND_OPTIONS } from "./passport-specs.js";
import { renderPassport, canvasToBlob, downloadBlob } from "./passport-render.js";
import { openModal, closeActiveModal } from "./modals-manager.js";

const $ = (id) => document.getElementById(id);

/* The A4 preview always opens at this fraction of the "fit to viewport" size. */
const PREVIEW_SCALE = 0.8;

const SHEET_MM = { width: 210, height: 297 };
const MARGIN_MM = 2;
const GAP_MM = 2;

let state = {
  isOpen: false,
  cutout: null,
  spec: null,
  bgColor: "#2563eb",
  baseAdjust: { zoom: 1, offsetX: 0, offsetY: 0 },
  selectedSlotIdx: null,

  // Copies chosen in the main editor. The sheet always places exactly this
  // many photos (capped by how many physically fit on A4).
  desiredCount: 0,

  // Computed by computeBestLayout(): the maximum-density arrangement for the
  // active photo size. Each entry is a mm rectangle on the A4 sheet.
  layout: {
    sheetMM: SHEET_MM,
    marginMM: MARGIN_MM,
    gapMM: GAP_MM,
    rects: [],
    totalSlots: 0,
  },

  // Parallel to layout.rects: null (empty) or { id, zoom, offsetX, offsetY }.
  slots: [],
};

/* ------------------------------------------------------------------ *
 * Maximum-density A4 packing
 *
 * Both photo orientations are tried, and after each full grid block the two
 * leftover strips are packed recursively (a guillotine search). That finds
 * mixed portrait/landscape arrangements — e.g. 25×35 mm fits 50 per sheet
 * rotated instead of 49 upright — and leaves no usable empty space behind.
 * ------------------------------------------------------------------ */

const EPS = 1e-6;

function packBest(W, H, gw, gh, depth, memo) {
  const smallest = Math.min(gw, gh);
  if (W < smallest - EPS || H < smallest - EPS) return [];

  const key = `${W.toFixed(3)}|${H.toFixed(3)}|${depth}`;
  const cached = memo.get(key);
  if (cached) return cached;

  let best = [];

  for (const rot of [false, true]) {
    const a = rot ? gh : gw; // item width in this orientation
    const b = rot ? gw : gh; // item height in this orientation
    const cols = Math.floor((W + EPS) / a);
    const rows = Math.floor((H + EPS) / b);
    if (cols < 1 || rows < 1) continue;

    const block = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) block.push({ x: c * a, y: r * b, rot });
    }

    let candidate = block;
    if (depth > 0) {
      const usedW = cols * a;
      const usedH = rows * b;

      // Split A: full-height strip on the right + strip under the block.
      const rightA = packBest(W - usedW, H, gw, gh, depth - 1, memo).map((p) => ({
        ...p,
        x: p.x + usedW,
      }));
      const bottomA = packBest(usedW, H - usedH, gw, gh, depth - 1, memo).map((p) => ({
        ...p,
        y: p.y + usedH,
      }));
      const splitA = block.concat(rightA, bottomA);

      // Split B: full-width strip underneath + strip beside the block.
      const bottomB = packBest(W, H - usedH, gw, gh, depth - 1, memo).map((p) => ({
        ...p,
        y: p.y + usedH,
      }));
      const rightB = packBest(W - usedW, usedH, gw, gh, depth - 1, memo).map((p) => ({
        ...p,
        x: p.x + usedW,
      }));
      const splitB = block.concat(rightB, bottomB);

      candidate = splitA.length >= splitB.length ? splitA : splitB;
    }

    if (candidate.length > best.length) best = candidate;
  }

  memo.set(key, best);
  return best;
}

function computeBestLayout(spec) {
  const photoW = Number(spec?.widthMM) || 35;
  const photoH = Number(spec?.heightMM) || 45;

  // Gap-inflated coordinate space: each item occupies (size + gap) and the
  // available area gains one gap back, which makes plain grids exact.
  const gw = photoW + GAP_MM;
  const gh = photoH + GAP_MM;
  const availW = SHEET_MM.width - 2 * MARGIN_MM + GAP_MM;
  const availH = SHEET_MM.height - 2 * MARGIN_MM + GAP_MM;

  const placements = packBest(availW, availH, gw, gh, 4, new Map());

  const rects = placements
    .map((p) => ({
      xMM: MARGIN_MM + p.x,
      yMM: MARGIN_MM + p.y,
      wMM: (p.rot ? gh : gw) - GAP_MM,
      hMM: (p.rot ? gw : gh) - GAP_MM,
      rot: !!p.rot,
    }))
    .sort((a, b) => a.yMM - b.yMM || a.xMM - b.xMM);

  return {
    sheetMM: SHEET_MM,
    marginMM: MARGIN_MM,
    gapMM: GAP_MM,
    photoW,
    photoH,
    rects,
    totalSlots: rects.length,
  };
}

/* ------------------------------------------------------------------ */

function gcd(a, b) {
  return b < 0.5 ? a : gcd(b, a % b);
}

function aspectLabel(spec) {
  const w = Math.round((Number(spec?.widthMM) || 0) * 10);
  const h = Math.round((Number(spec?.heightMM) || 0) * 10);
  if (!w || !h) return "—";
  const d = Math.round(gcd(Math.max(w, h), Math.min(w, h))) || 1;
  return `${Math.round(w / d)} : ${Math.round(h / d)}`;
}

function bgLabel(color) {
  const match = BACKGROUND_OPTIONS.find(
    (b) => b.color.toLowerCase() === String(color).toLowerCase(),
  );
  return match ? match.label : String(color).toUpperCase();
}

/** Mirrors the main editor's current selection into the read-only chips. */
function syncInfoUI() {
  const spec = state.spec;
  if ($("printInfoSize")) {
    $("printInfoSize").textContent = spec
      ? `${spec.label ? spec.label + " · " : ""}${spec.widthMM}×${spec.heightMM} mm`
      : "—";
  }
  if ($("printInfoAspect")) $("printInfoAspect").textContent = aspectLabel(spec);
  if ($("printInfoCopies")) {
    const placed = state.slots.filter(Boolean).length;
    $("printInfoCopies").textContent = `${placed} of ${state.desiredCount} selected`;
  }
  const dot = $("printInfoBgDot");
  if (dot) dot.style.backgroundColor = state.bgColor;
  if ($("printInfoBgName")) $("printInfoBgName").textContent = bgLabel(state.bgColor);
}

export function openPrintEditor(params) {
  // Everything comes from the main editor on every open — nothing is restored
  // from a previous session, so a new photo never inherits old settings.
  state.cutout = params.cutout;
  state.spec = params.spec || PASSPORT_SPECS[0];
  state.bgColor = params.bgColor || "#2563eb";
  state.baseAdjust = params.adjust || { zoom: 1, offsetX: 0, offsetY: 0 };
  state.desiredCount = Math.max(1, parseInt(params.count, 10) || 1);

  state.layout = computeBestLayout(state.spec);
  fillAllSlots();

  openModal("printEditorModal");
  state.isOpen = true;

  bindEventsOnce();
  syncInfoUI();
  renderAll();
  // The modal animates in; re-measure once laid out so the mm->px scale is exact.
  requestAnimationFrame(() => requestAnimationFrame(() => renderAll()));
}

export function closePrintEditor() {
  closeActiveModal();
  state.isOpen = false;
}

/** Drops every cached sheet/photo so the next open starts completely fresh. */
export function resetPrintEditor() {
  state.cutout = null;
  state.spec = null;
  state.slots = [];
  state.selectedSlotIdx = null;
  state.layout = { sheetMM: SHEET_MM, marginMM: MARGIN_MM, gapMM: GAP_MM, rects: [], totalSlots: 0 };
  const grid = $("a4SlotsGrid");
  if (grid) grid.innerHTML = "";
  const iframe = document.getElementById("a4HiddenPrintIframe");
  if (iframe) iframe.remove();
}

function createPhotoObject() {
  return {
    id: "p_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
    zoom: state.baseAdjust.zoom || 1,
    offsetX: state.baseAdjust.offsetX || 0,
    offsetY: state.baseAdjust.offsetY || 0,
  };
}

/**
 * Fills exactly the number of copies selected in the main editor. Slots beyond
 * that stay empty, so "8 copies" always means 8 photos on the sheet. If A4
 * cannot hold that many at the chosen size, every available slot is used.
 */
function fillAllSlots() {
  const total = state.layout.totalSlots;
  const wanted = Math.min(total, Math.max(0, state.desiredCount || total));
  state.slots = new Array(total)
    .fill(null)
    .map((_, i) => (i < wanted ? createPhotoObject() : null));
  state.selectedSlotIdx = wanted > 0 ? 0 : null;
  if (state.desiredCount > total && total > 0) {
    setSheetNote(`Only ${total} photos of this size fit on one A4 sheet.`);
  } else {
    setSheetNote("");
  }
}

/** Non-blocking hint shown under the sheet when the copy count cannot fit. */
function setSheetNote(msg) {
  const el = $("printSheetNote");
  if (el) {
    el.textContent = msg || "";
    el.classList.toggle("hidden", !msg);
  }
}

function swapSlots(fromIdx, toIdx) {
  const n = state.slots.length;
  if (fromIdx < 0 || fromIdx >= n || toIdx < 0 || toIdx >= n) return;
  const temp = state.slots[fromIdx];
  state.slots[fromIdx] = state.slots[toIdx];
  state.slots[toIdx] = temp;
  state.selectedSlotIdx = toIdx;
}

/** Sizes the A4 page element at a fixed 80% of the fit-to-viewport size. */
function applyViewportZoom() {
  const vp = $("printSheetScroll") || $("printSheetViewport");
  const page = $("printSheetPage");
  if (!vp || !page) return;

  const rect = vp.getBoundingClientRect();
  const availW = Math.max(120, rect.width - 24);
  const availH = Math.max(160, (rect.height || window.innerHeight * 0.6) - 24);

  const fitW = Math.min(availW, (availH * SHEET_MM.width) / SHEET_MM.height);
  const w = Math.max(120, fitW * PREVIEW_SCALE);

  page.style.maxWidth = "none";
  page.style.maxHeight = "none";
  page.style.width = w + "px";
  page.style.height = (w * SHEET_MM.height) / SHEET_MM.width + "px";
  vp.style.overflow = "hidden";
}

function renderAll() {
  if (!state.isOpen || !state.spec) return;

  applyViewportZoom();
  syncInfoUI();

  const gridEl = $("a4SlotsGrid");
  if (!gridEl) return;

  const pageEl = $("printSheetPage");
  if (pageEl) pageEl.style.aspectRatio = "210 / 297";

  // Pixel-accurate mm -> px scale, measured from the real rendered page box.
  const pageRect = pageEl ? pageEl.getBoundingClientRect() : null;
  const pxPerMM = pageRect && pageRect.width ? pageRect.width / SHEET_MM.width : 0;

  gridEl.style.display = "block";
  gridEl.style.position = "absolute";
  gridEl.style.inset = "0";
  gridEl.innerHTML = "";

  state.layout.rects.forEach((rect, i) => {
    const photo = state.slots[i];
    const slotEl = document.createElement("div");
    slotEl.className = "gridSlot " + (photo ? "occupied" : "empty");
    if (i === state.selectedSlotIdx) slotEl.classList.add("selected");
    slotEl.dataset.slotIdx = String(i);
    slotEl.style.position = "absolute";
    slotEl.style.overflow = "hidden";

    const slotWpx = rect.wMM * pxPerMM;
    const slotHpx = rect.hMM * pxPerMM;

    if (pxPerMM > 0) {
      slotEl.style.left = rect.xMM * pxPerMM + "px";
      slotEl.style.top = rect.yMM * pxPerMM + "px";
      slotEl.style.width = slotWpx + "px";
      slotEl.style.height = slotHpx + "px";
    } else {
      slotEl.style.aspectRatio = `${rect.wMM} / ${rect.hMM}`;
    }

    if (photo) {
      slotEl.draggable = true;

      const canvas = renderPassport(state.cutout, state.spec, state.bgColor, {
        zoom: photo.zoom,
        offsetX: photo.offsetX,
        offsetY: photo.offsetY,
      });
      canvas.className = "printPhotoCanvas";
      canvas.style.position = "absolute";
      canvas.style.left = "50%";
      canvas.style.top = "50%";
      if (rect.rot && pxPerMM > 0) {
        // Rotated slot: the photo keeps its own proportions and is turned 90°.
        canvas.style.width = slotHpx + "px";
        canvas.style.height = slotWpx + "px";
        canvas.style.transform = "translate(-50%, -50%) rotate(90deg)";
      } else {
        canvas.style.width = pxPerMM > 0 ? slotWpx + "px" : "100%";
        canvas.style.height = pxPerMM > 0 ? slotHpx + "px" : "100%";
        canvas.style.transform = "translate(-50%, -50%)";
      }

      const badge = document.createElement("div");
      badge.className = "photoBadge";
      badge.textContent = "#" + (i + 1);

      const overlay = document.createElement("div");
      overlay.className = "photoHoverOverlay";
      overlay.innerHTML = `
        <button class="photoActionBtn dup" title="Duplicate copy" data-action="dup" data-idx="${i}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        <button class="photoActionBtn del" title="Delete copy" data-action="del" data-idx="${i}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      `;

      slotEl.appendChild(canvas);
      slotEl.appendChild(badge);
      slotEl.appendChild(overlay);

      slotEl.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", String(i));
        slotEl.classList.add("dragging");
      });
      slotEl.addEventListener("dragend", () => slotEl.classList.remove("dragging"));
    } else {
      const emptyLabel = document.createElement("span");
      emptyLabel.className = "slotEmptyLabel";
      emptyLabel.textContent = `${i + 1}`;
      slotEl.appendChild(emptyLabel);
    }

    slotEl.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    });
    slotEl.addEventListener("dragenter", (e) => {
      e.preventDefault();
      slotEl.classList.add("drop-target");
    });
    slotEl.addEventListener("dragleave", () => slotEl.classList.remove("drop-target"));
    slotEl.addEventListener("drop", (e) => {
      e.preventDefault();
      slotEl.classList.remove("drop-target");
      const fromStr = e.dataTransfer.getData("text/plain");
      if (fromStr !== "") {
        const fromIdx = parseInt(fromStr, 10);
        if (!isNaN(fromIdx) && fromIdx !== i) {
          swapSlots(fromIdx, i);
          renderAll();
        }
      }
    });

    slotEl.addEventListener("click", (e) => {
      const actionBtn = e.target.closest(".photoActionBtn");
      if (actionBtn) {
        e.stopPropagation();
        const act = actionBtn.dataset.action;
        const targetIdx = parseInt(actionBtn.dataset.idx, 10);
        if (act === "dup") duplicateSlotPhoto(targetIdx);
        else if (act === "del") deleteSlotPhoto(targetIdx);
      } else {
        state.selectedSlotIdx = i;
        renderAll();
      }
    });

    gridEl.appendChild(slotEl);
  });

  renderInspector();
}

function renderInspector() {
  const inspBox = $("itemInspectorBox");
  if (!inspBox) return;

  if (
    state.selectedSlotIdx === null ||
    state.selectedSlotIdx < 0 ||
    state.selectedSlotIdx >= state.slots.length
  ) {
    state.selectedSlotIdx = state.slots.length ? 0 : null;
  }

  const photo = state.selectedSlotIdx === null ? null : state.slots[state.selectedSlotIdx];
  inspBox.classList.remove("hidden");
  if ($("inspPhotoNum"))
    $("inspPhotoNum").textContent = state.selectedSlotIdx === null ? "–" : state.selectedSlotIdx + 1;

  const hasPhoto = !!photo;
  if ($("inspDupBtn")) $("inspDupBtn").disabled = !hasPhoto;
  if ($("inspDelBtn")) $("inspDelBtn").disabled = !hasPhoto;
}

function duplicateSlotPhoto(idx) {
  if (idx === null || idx < 0 || idx >= state.slots.length) idx = 0;
  const src = state.slots[idx];
  if (!src) return;
  const emptyIdx = state.slots.findIndex((s) => s === null);
  if (emptyIdx !== -1) {
    state.slots[emptyIdx] = {
      ...createPhotoObject(),
      zoom: src.zoom,
      offsetX: src.offsetX,
      offsetY: src.offsetY,
    };
    state.selectedSlotIdx = emptyIdx;
  }
  syncCountToMainEditor();
  renderAll();
}

function deleteSlotPhoto(idx) {
  if (idx === null || idx < 0 || idx >= state.slots.length) return;
  state.slots[idx] = null;
  syncCountToMainEditor();
  renderAll();
}

/** Manual add/remove on the sheet updates the main editor's copy count, so the
 *  two editors never disagree about how many photos the user wants. */
function syncCountToMainEditor() {
  state.desiredCount = state.slots.filter(Boolean).length;
  window.__setPhotoCount?.(state.desiredCount);
}

let isBound = false;
function bindEventsOnce() {
  if (isBound) return;
  isBound = true;

  if ($("closePrintEditor")) $("closePrintEditor").addEventListener("click", closePrintEditor);
  if ($("cancelPrintEditor")) $("cancelPrintEditor").addEventListener("click", closePrintEditor);

  if ($("printResetLayout"))
    $("printResetLayout").addEventListener("click", () => {
      state.layout = computeBestLayout(state.spec);
      fillAllSlots();
      renderAll();
    });

  if ($("inspDupBtn"))
    $("inspDupBtn").addEventListener("click", () => duplicateSlotPhoto(state.selectedSlotIdx));
  if ($("inspDelBtn"))
    $("inspDelBtn").addEventListener("click", () => deleteSlotPhoto(state.selectedSlotIdx));

  window.addEventListener("resize", () => {
    if (state.isOpen) renderAll();
  });

  const modalEl = $("printEditorModal");
  if (modalEl) {
    new MutationObserver(() => {
      if (modalEl.classList.contains("hidden")) state.isOpen = false;
    }).observe(modalEl, { attributes: true, attributeFilter: ["class"] });
  }

  if ($("confirmDownloadSheet"))
    $("confirmDownloadSheet").addEventListener("click", () => exportFullSheet("image"));
  if ($("confirmPrintPdf"))
    $("confirmPrintPdf").addEventListener("click", () => exportFullSheet("print"));
}

/* ------------------------------------------------------------------ *
 * Printing
 *
 * The sheet is handed to the print tab as an object URL created from an
 * async canvas.toBlob() — no multi-megabyte data URL is built on the main
 * thread and window.print() is never called from this window, so the editor
 * stays fully interactive while the print tab is open.
 * ------------------------------------------------------------------ */

function printPageHtml(imgUrl) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Print Passport Photo Sheet (A4)</title>
  <style>
    @page { size: A4 portrait; margin: 0; }
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; background: #ffffff; }
    img { max-width: 100%; max-height: 100%; object-fit: contain; }
    @media print {
      html, body { width: 210mm; height: 297mm; margin: 0; padding: 0; }
      img { width: 100%; height: 100%; object-fit: contain; }
    }
  </style>
</head>
<body>
  <img id="sheetImg" src="${imgUrl}" alt="A4 print sheet" />
  <script>
    document.getElementById('sheetImg').addEventListener('load', function () {
      setTimeout(function () { try { window.focus(); window.print(); } catch (e) {} }, 300);
    });
  <\/script>
</body>
</html>`;
}

function printViaHiddenIframe(imgUrl) {
  const old = document.getElementById("a4HiddenPrintIframe");
  if (old) old.remove();

  const iframe = document.createElement("iframe");
  iframe.id = "a4HiddenPrintIframe";
  iframe.setAttribute(
    "style",
    "position:fixed;right:-9999px;bottom:-9999px;width:1px;height:1px;border:0;opacity:0;pointer-events:none",
  );
  document.body.appendChild(iframe);

  const doc = iframe.contentWindow.document;
  doc.open();
  doc.write(printPageHtml(imgUrl));
  doc.close();
}

function openPrintTab(blob) {
  const imgUrl = URL.createObjectURL(blob);
  // Revoke well after the print tab has finished loading the image.
  setTimeout(() => URL.revokeObjectURL(imgUrl), 120000);

  try {
    const win = window.open("", "_blank");
    if (!win || win.closed) {
      printViaHiddenIframe(imgUrl);
      return;
    }
    win.document.open();
    win.document.write(printPageHtml(imgUrl));
    win.document.close();
  } catch (err) {
    console.error("Direct print error:", err);
    printViaHiddenIframe(imgUrl);
  }
}

export function renderFullSheetCanvas() {
  const dpi = 300;
  const mmToPx = (mm) => Math.round((mm / 25.4) * dpi);

  const canvas = document.createElement("canvas");
  canvas.width = mmToPx(SHEET_MM.width);
  canvas.height = mmToPx(SHEET_MM.height);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  state.layout.rects.forEach((rect, i) => {
    const photo = state.slots[i];
    if (!photo) return;

    const photoCanvas = renderPassport(state.cutout, state.spec, state.bgColor, {
      zoom: photo.zoom,
      offsetX: photo.offsetX,
      offsetY: photo.offsetY,
    });

    const x = mmToPx(rect.xMM);
    const y = mmToPx(rect.yMM);
    const w = mmToPx(rect.wMM);
    const h = mmToPx(rect.hMM);

    if (rect.rot) {
      ctx.save();
      ctx.translate(x + w / 2, y + h / 2);
      ctx.rotate(Math.PI / 2);
      // In the rotated frame the photo keeps its upright proportions (h × w).
      ctx.drawImage(photoCanvas, -h / 2, -w / 2, h, w);
      ctx.restore();
    } else {
      ctx.drawImage(photoCanvas, x, y, w, h);
    }
  });

  return canvas;
}

// Post-print popup: the print tab opens immediately, this only confirms.
let printAdModalWired = false;

function hidePrintAdModal() {
  const modal = $("printAdModal");
  if (modal) modal.classList.add("hidden");
}

function showPrintAdModal(blob) {
  // Print right away — no extra tap required.
  openPrintTab(blob);

  const modal = $("printAdModal");
  if (!modal) return;
  modal.classList.remove("hidden");

  if (!printAdModalWired) {
    printAdModalWired = true;
    const homeBtn = $("printAdModalHome");
    if (homeBtn)
      homeBtn.addEventListener("click", () => {
        hidePrintAdModal();
        window.location.href = "/";
      });
    const closeBtn = $("printAdModalClose");
    if (closeBtn) closeBtn.addEventListener("click", hidePrintAdModal);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) hidePrintAdModal();
    });
  }
}


let exporting = false;
async function exportFullSheet(mode) {
  if (exporting || !state.spec || !state.cutout) return;
  exporting = true;
  const btn = mode === "print" ? $("confirmPrintPdf") : $("confirmDownloadSheet");
  if (btn) btn.disabled = true;

  try {
    const fullCanvas = renderFullSheetCanvas();
    // Async encode: keeps the UI responsive on a 2480×3508 sheet.
    const blob = await canvasToBlob(fullCanvas, "image/png");

    if (mode === "print") {
      showPrintAdModal(blob);
    } else {
      downloadBlob(blob, "passport-A4-sheet.png");
      closePrintEditor();
      const downloadModal = $("downloadModal");
      if (downloadModal) downloadModal.classList.remove("hidden");
    }
  } catch (err) {
    console.error("Sheet export failed:", err);
  } finally {
    exporting = false;
    if (btn) btn.disabled = false;
  }
}
