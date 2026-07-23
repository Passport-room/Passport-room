import { PASSPORT_SPECS } from "./passport-specs.js";
import { renderPassport, canvasToBlob, downloadBlob } from "./passport-render.js";

const $ = (id) => document.getElementById(id);

let state = {
  isOpen: false,
  cutout: null,
  spec: null,
  bgColor: "#2563eb",
  baseAdjust: { zoom: 1, offsetX: 0, offsetY: 0 },
  count: 4,
  selectedSlotIdx: null,

  grid: {
    sheetMM: { width: 210, height: 297 },
    marginMM: 2,
    gapMM: 2,
    cols: 5,
    rows: 6,
    totalSlots: 30,
    photoW: 35,
    photoH: 45,
  },

  // slots array of length grid.totalSlots.
  // Each element is null OR { id, zoom, offsetX, offsetY }
  slots: [],
};

function calculateGrid(spec) {
  const sheetMM = { width: 210, height: 297 }; // A4
  const photoW = spec.widthMM || 35;
  const photoH = spec.heightMM || 45;

  const marginMM = 2; // 2mm outer margin
  const gapMM = 2; // 2mm gap between slots

  const availW = sheetMM.width - 2 * marginMM;
  const availH = sheetMM.height - 2 * marginMM;

  const cols = Math.max(1, Math.floor((availW + gapMM) / (photoW + gapMM)));
  const rows = Math.max(1, Math.floor((availH + gapMM) / (photoH + gapMM)));
  const totalSlots = cols * rows;

  return { sheetMM, marginMM, gapMM, photoW, photoH, cols, rows, totalSlots };
}

export function openPrintEditor(params) {
  state.cutout = params.cutout;
  state.spec = params.spec || PASSPORT_SPECS[0];
  state.bgColor = params.bgColor || "#2563eb";
  state.baseAdjust = params.adjust || { zoom: 1, offsetX: 0, offsetY: 0 };
  state.count = Math.max(1, Math.min(60, params.count || 4));

  state.grid = calculateGrid(state.spec);
  initSlots(state.count);

  const modal = $("printEditorModal");
  if (modal) modal.classList.remove("hidden");
  state.isOpen = true;

  bindEventsOnce();
  syncBgUI();
  renderAll();
}

function syncBgUI() {
  const bgContainer = $("printBgSwatches");
  if (bgContainer) {
    bgContainer.querySelectorAll(".swMini").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.color === state.bgColor);
    });
  }
  const picker = $("printBgPicker");
  if (picker) {
    picker.value = state.bgColor;
  }
}

export function closePrintEditor() {
  const modal = $("printEditorModal");
  if (modal) modal.classList.add("hidden");
  state.isOpen = false;
}

function createPhotoObject() {
  return {
    id: "p_" + Date.now() + "_" + Math.random().toString(36).substr(2, 4),
    zoom: state.baseAdjust.zoom || 1,
    offsetX: state.baseAdjust.offsetX || 0,
    offsetY: state.baseAdjust.offsetY || 0,
  };
}

function initSlots(count) {
  const total = state.grid.totalSlots;
  state.slots = new Array(total).fill(null);

  const fillCount = Math.min(count, total);
  for (let i = 0; i < fillCount; i++) {
    state.slots[i] = createPhotoObject();
  }
  state.selectedSlotIdx = fillCount > 0 ? 0 : null;
}

function autoArrange() {
  const existing = state.slots.filter((p) => p !== null);
  const total = state.grid.totalSlots;
  state.slots = new Array(total).fill(null);

  for (let i = 0; i < Math.min(existing.length, total); i++) {
    state.slots[i] = existing[i];
  }

  if (state.selectedSlotIdx !== null && state.selectedSlotIdx >= total) {
    state.selectedSlotIdx = null;
  }
}

function setPhotoCount(targetCount) {
  const total = state.grid.totalSlots;
  targetCount = Math.max(1, Math.min(total, targetCount));
  state.count = targetCount;

  const currentFilled = state.slots.filter((s) => s !== null).length;

  if (targetCount > currentFilled) {
    let toAdd = targetCount - currentFilled;
    for (let i = 0; i < total && toAdd > 0; i++) {
      if (state.slots[i] === null) {
        state.slots[i] = createPhotoObject();
        toAdd--;
      }
    }
  } else if (targetCount < currentFilled) {
    let toRemove = currentFilled - targetCount;
    for (let i = total - 1; i >= 0 && toRemove > 0; i--) {
      if (state.slots[i] !== null) {
        state.slots[i] = null;
        if (state.selectedSlotIdx === i) state.selectedSlotIdx = null;
        toRemove--;
      }
    }
  }
}

function swapOrMoveSlots(fromIdx, toIdx) {
  if (fromIdx < 0 || fromIdx >= state.slots.length || toIdx < 0 || toIdx >= state.slots.length)
    return;
  const temp = state.slots[fromIdx];
  state.slots[fromIdx] = state.slots[toIdx];
  state.slots[toIdx] = temp;
  state.selectedSlotIdx = toIdx;
}

function renderAll() {
  if (!state.isOpen) return;

  const placedCount = state.slots.filter((s) => s !== null).length;
  if ($("printQtyInput")) $("printQtyInput").value = placedCount;
  if ($("statCopies")) $("statCopies").textContent = `${placedCount} / ${state.grid.totalSlots}`;
  if ($("statSpec")) $("statSpec").textContent = `${state.spec.widthMM}×${state.spec.heightMM} mm`;
  if ($("statGrid"))
    $("statGrid").textContent =
      `${state.grid.totalSlots} slots (${state.grid.cols}×${state.grid.rows})`;

  // Render Page Grid
  const gridEl = $("a4SlotsGrid");
  if (!gridEl) return;

  const pageEl = $("printSheetPage");
  if (pageEl) {
    pageEl.style.aspectRatio = "210 / 297";
  }

  gridEl.style.gridTemplateColumns = `repeat(${state.grid.cols}, 1fr)`;
  gridEl.style.gridTemplateRows = `repeat(${state.grid.rows}, 1fr)`;
  gridEl.innerHTML = "";

  for (let i = 0; i < state.grid.totalSlots; i++) {
    const photo = state.slots[i];
    const slotEl = document.createElement("div");
    slotEl.className = "gridSlot " + (photo ? "occupied" : "empty");
    if (i === state.selectedSlotIdx) slotEl.classList.add("selected");
    slotEl.dataset.slotIdx = i;

    slotEl.style.aspectRatio = `${state.grid.photoW} / ${state.grid.photoH}`;

    if (photo) {
      // Occupied slot
      slotEl.draggable = true;

      const canvas = renderPassport(state.cutout, state.spec, state.bgColor, {
        zoom: photo.zoom,
        offsetX: photo.offsetX,
        offsetY: photo.offsetY,
      });
      canvas.className = "printPhotoCanvas";

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

      // Drag Start
      slotEl.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", i.toString());
        slotEl.classList.add("dragging");
      });
      slotEl.addEventListener("dragend", () => slotEl.classList.remove("dragging"));
    } else {
      // Empty slot
      const emptyLabel = document.createElement("span");
      emptyLabel.className = "slotEmptyLabel";
      emptyLabel.textContent = `${i + 1}`;
      slotEl.appendChild(emptyLabel);
    }

    // Drag & Drop handlers
    slotEl.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    });

    slotEl.addEventListener("dragenter", (e) => {
      e.preventDefault();
      slotEl.classList.add("drop-target");
    });

    slotEl.addEventListener("dragleave", () => {
      slotEl.classList.remove("drop-target");
    });

    slotEl.addEventListener("drop", (e) => {
      e.preventDefault();
      slotEl.classList.remove("drop-target");
      const fromStr = e.dataTransfer.getData("text/plain");
      if (fromStr !== "") {
        const fromIdx = parseInt(fromStr, 10);
        if (!isNaN(fromIdx) && fromIdx !== i) {
          swapOrMoveSlots(fromIdx, i);
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
  }

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
    state.selectedSlotIdx = 0;
  }

  const photo = state.slots[state.selectedSlotIdx];
  inspBox.classList.remove("hidden");
  if ($("inspPhotoNum")) $("inspPhotoNum").textContent = state.selectedSlotIdx + 1;

  const hasPhoto = !!photo;
  if ($("inspDupBtn")) $("inspDupBtn").disabled = !hasPhoto;
  if ($("inspDelBtn")) $("inspDelBtn").disabled = !hasPhoto;
  if ($("topDupBtn")) $("topDupBtn").disabled = !hasPhoto;
  if ($("topDelBtn")) $("topDelBtn").disabled = !hasPhoto;
}

function duplicateSlotPhoto(idx) {
  if (idx === null || idx < 0 || idx >= state.slots.length) idx = 0;
  if (state.slots[idx] === null) return;
  const src = state.slots[idx];
  const emptyIdx = state.slots.findIndex((s) => s === null);
  if (emptyIdx !== -1) {
    state.slots[emptyIdx] = {
      id: "p_" + Date.now() + "_" + Math.random().toString(36).substr(2, 4),
      zoom: src.zoom,
      offsetX: src.offsetX,
      offsetY: src.offsetY,
    };
    state.selectedSlotIdx = emptyIdx;
  }
  renderAll();
}

function deleteSlotPhoto(idx) {
  if (idx === null || idx < 0 || idx >= state.slots.length) idx = 0;
  state.slots[idx] = null;
  renderAll();
}

let isBound = false;
function bindEventsOnce() {
  if (isBound) return;
  isBound = true;

  if ($("closePrintEditor")) $("closePrintEditor").addEventListener("click", closePrintEditor);
  if ($("cancelPrintEditor")) $("cancelPrintEditor").addEventListener("click", closePrintEditor);

  if ($("printQtyDec"))
    $("printQtyDec").addEventListener("click", () => {
      const currentCount = state.slots.filter((s) => s !== null).length;
      if (currentCount > 1) {
        setPhotoCount(currentCount - 1);
        renderAll();
      }
    });

  if ($("printQtyInc"))
    $("printQtyInc").addEventListener("click", () => {
      const currentCount = state.slots.filter((s) => s !== null).length;
      if (currentCount < state.grid.totalSlots) {
        setPhotoCount(currentCount + 1);
        renderAll();
      }
    });

  if ($("printQtyInput"))
    $("printQtyInput").addEventListener("change", (e) => {
      let targetVal = parseInt(e.target.value, 10) || 1;
      setPhotoCount(targetVal);
      renderAll();
    });

  if ($("printAutoArrange"))
    $("printAutoArrange").addEventListener("click", () => {
      autoArrange();
      renderAll();
    });

  if ($("printResetLayout"))
    $("printResetLayout").addEventListener("click", () => {
      initSlots(4);
      renderAll();
    });

  if ($("inspDupBtn"))
    $("inspDupBtn").addEventListener("click", () => {
      duplicateSlotPhoto(state.selectedSlotIdx);
    });

  if ($("inspDelBtn"))
    $("inspDelBtn").addEventListener("click", () => {
      deleteSlotPhoto(state.selectedSlotIdx);
    });

  if ($("topDupBtn"))
    $("topDupBtn").addEventListener("click", () => {
      duplicateSlotPhoto(state.selectedSlotIdx);
    });

  if ($("topDelBtn"))
    $("topDelBtn").addEventListener("click", () => {
      deleteSlotPhoto(state.selectedSlotIdx);
    });

  if ($("printBgSwatches")) {
    $("printBgSwatches").addEventListener("click", (e) => {
      const btn = e.target.closest(".swMini");
      if (btn && btn.dataset.color) {
        state.bgColor = btn.dataset.color;
        syncBgUI();
        renderAll();
      }
    });
  }

  if ($("printBgPicker")) {
    $("printBgPicker").addEventListener("input", (e) => {
      state.bgColor = e.target.value;
      syncBgUI();
      renderAll();
    });
  }

  if ($("confirmDownloadSheet"))
    $("confirmDownloadSheet").addEventListener("click", () => exportFullSheet("image"));
  if ($("confirmPrintPdf"))
    $("confirmPrintPdf").addEventListener("click", () => exportFullSheet("pdf"));
}

function printCanvasViaIframe(canvas) {
  const dataUrl = canvas.toDataURL("image/png");
  let iframe = document.getElementById("a4HiddenPrintIframe");
  if (iframe) {
    iframe.remove();
  }
  iframe = document.createElement("iframe");
  iframe.id = "a4HiddenPrintIframe";
  iframe.style.position = "fixed";
  iframe.style.right = "-9999px";
  iframe.style.bottom = "-9999px";
  iframe.style.width = "1px";
  iframe.style.height = "1px";
  iframe.style.border = "0";
  iframe.style.opacity = "0";
  iframe.style.pointerEvents = "none";
  document.body.appendChild(iframe);

  const doc = iframe.contentWindow.document;
  doc.open();
  doc.write(`<!DOCTYPE html>
<html>
<head>
  <title>Print A4 Passport Sheet</title>
  <style>
    @page { size: A4 portrait; margin: 0; }
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; background: #fff; }
    img { max-width: 100%; max-height: 100%; object-fit: contain; }
  </style>
</head>
<body>
  <img src="${dataUrl}" onload="setTimeout(function(){ try { window.focus(); window.print(); } catch(e){} }, 250);" />
</body>
</html>`);
  doc.close();
}

function printDirectly(canvas) {
  try {
    const dataUrl = canvas.toDataURL("image/png");
    const htmlContent = `<!DOCTYPE html>
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
  <img src="${dataUrl}" id="sheetImg" alt="A4 Print Sheet" />
  <script>
    window.onload = function() {
      setTimeout(function() {
        try {
          window.focus();
          window.print();
        } catch(e) {}
      }, 300);
    };
  </script>
</body>
</html>`;

    const blob = new Blob([htmlContent], { type: "text/html;charset=utf-8" });
    const blobUrl = URL.createObjectURL(blob);
    const win = window.open(blobUrl, "_blank");

    if (!win) {
      printCanvasViaIframe(canvas);
    }
  } catch (err) {
    console.error("Direct print error:", err);
    printCanvasViaIframe(canvas);
  }
}

export function renderFullSheetCanvas() {
  const g = state.grid;
  const dpi = 300;
  const sheetW = Math.round((g.sheetMM.width / 25.4) * dpi);
  const sheetH = Math.round((g.sheetMM.height / 25.4) * dpi);

  const canvas = document.createElement("canvas");
  canvas.width = sheetW;
  canvas.height = sheetH;
  const ctx = canvas.getContext("2d");

  // Pure White Paper Background
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, sheetW, sheetH);

  const marginPxX = Math.round((g.marginMM / 25.4) * dpi);
  const marginPxY = Math.round((g.marginMM / 25.4) * dpi);
  const gapPxX = Math.round((g.gapMM / 25.4) * dpi);
  const gapPxY = Math.round((g.gapMM / 25.4) * dpi);

  const photoPxW = Math.round((g.photoW / 25.4) * dpi);
  const photoPxH = Math.round((g.photoH / 25.4) * dpi);

  for (let i = 0; i < g.totalSlots; i++) {
    const col = i % g.cols;
    const row = Math.floor(i / g.cols);

    const x = marginPxX + col * (photoPxW + gapPxX);
    const y = marginPxY + row * (photoPxH + gapPxY);

    const photo = state.slots[i];
    if (photo) {
      const photoCanvas = renderPassport(state.cutout, state.spec, state.bgColor, {
        zoom: photo.zoom,
        offsetX: photo.offsetX,
        offsetY: photo.offsetY,
      });

      ctx.drawImage(photoCanvas, x, y, photoPxW, photoPxH);

      // Precise 1px grey cut line around each photo
      ctx.strokeStyle = "#cccccc";
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, photoPxW, photoPxH);
    } else {
      // Light dashed border for empty slot
      ctx.save();
      ctx.strokeStyle = "#e2e8f0";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(x + 0.5, y + 0.5, photoPxW, photoPxH);
      ctx.restore();
    }
  }

  return canvas;
}

async function exportFullSheet(mode) {
  const fullCanvas = renderFullSheetCanvas();

  if (mode === "pdf") {
    printDirectly(fullCanvas);
  } else {
    const blob = await canvasToBlob(fullCanvas, "image/png");
    downloadBlob(blob, "passport-A4-sheet.png");
    closePrintEditor();
    const downloadModal = $("downloadModal");
    if (downloadModal) {
      downloadModal.classList.remove("hidden");
    }
  }
}
