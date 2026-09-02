// Compositing pipeline: source + soft mask -> framed passport photo + print sheet.
import { specPixels } from "./passport-specs.js";
import { detectFaceInCanvas } from "./face-detector.js";

export const DEFAULT_ADJUST = { zoom: 0.8, offsetX: 0, offsetY: 0 };

export function composeCutout(source, maskCanvas, natWidth, natHeight) {
  const canvas = document.createElement("canvas");
  canvas.width = natWidth;
  canvas.height = natHeight;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, natWidth, natHeight);
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(maskCanvas, 0, 0, natWidth, natHeight);
  ctx.globalCompositeOperation = "source-over";

  const sw = 160;
  const sh = Math.max(1, Math.round((natHeight / natWidth) * sw));
  const small = document.createElement("canvas");
  small.width = sw;
  small.height = sh;
  const sctx = small.getContext("2d", { willReadFrequently: true });
  sctx.drawImage(maskCanvas, 0, 0, sw, sh);
  const alpha = sctx.getImageData(0, 0, sw, sh).data;
  let minX = sw,
    minY = sh,
    maxX = 0,
    maxY = 0,
    found = false;
  const threshold = 96;
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      if (alpha[(y * sw + x) * 4 + 3] > threshold) {
        found = true;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  let bbox;
  if (found) {
    const scaleX = natWidth / sw,
      scaleY = natHeight / sh;
    const x = minX * scaleX,
      y = minY * scaleY;
    const w = (maxX - minX + 1) * scaleX,
      h = (maxY - minY + 1) * scaleY;
    bbox = { x, y, w, h, cx: x + w / 2 };
  } else {
    bbox = { x: 0, y: 0, w: natWidth, h: natHeight, cx: natWidth / 2 };
  }

  // Detect face features (head top, chin, face height, center)
  const face = detectFaceInCanvas(source, maskCanvas);

  return { canvas, width: natWidth, height: natHeight, bbox, face };
}

/**
 * The framing anchors renderPassport() crops around, as fractions of the
 * cutout size. Exposed so a tool (AI Enhance / Try-On) can pin the CURRENT
 * framing and re-apply it to its result: without this, re-running face
 * detection on the new image picks slightly different anchors and the photo
 * visibly jumps / zooms after the AI step.
 */
export function frameGeometry(cutout) {
  let headTopY, faceCenterX, faceHeight;

  if (cutout.face && cutout.face.faceHeight > 15) {
    headTopY = cutout.face.headTopY;
    faceCenterX = cutout.face.faceCenterX;
    faceHeight = cutout.face.faceHeight;
  } else if (cutout.bbox) {
    headTopY = cutout.bbox.y;
    faceCenterX = cutout.bbox.cx;
    // Estimate head/face height (top of hair to chin)
    faceHeight = Math.min(cutout.bbox.h * 0.45, cutout.bbox.w * 0.85);
  } else {
    headTopY = 0;
    faceCenterX = cutout.width / 2;
    faceHeight = cutout.height * 0.4;
  }

  return {
    headTopYRatio: headTopY / (cutout.height || 1),
    faceCenterXRatio: faceCenterX / (cutout.width || 1),
    faceHeightRatio: faceHeight / (cutout.height || 1),
  };
}

export function renderPassport(cutout, spec, bgColor, adjust) {
  const { width: outW, height: outH } = specPixels(spec);
  const aspect = outW / outH;

  // A pinned frame (set by applyResult) wins over freshly detected anchors so
  // an AI result keeps exactly the framing the user was already looking at.
  const g = cutout.pinnedFrame || frameGeometry(cutout);
  const headTopY = g.headTopYRatio * cutout.height;
  const faceCenterX = g.faceCenterXRatio * cutout.width;
  const faceHeight = g.faceHeightRatio * cutout.height;

  // Target face fill: scaled up zoom level by 1.5x for larger, better face frame filling
  const targetFaceFill = spec.subjectFill || (34 / 55) * 1.05;

  // Crop height needed so that faceHeight occupies targetFaceFill of the passport frame
  const baseCropH = faceHeight / targetFaceFill;
  const cropH = baseCropH / (adjust.zoom || 1);
  const cropW = cropH * aspect;

  // Top margin above top of head: ~8% of crop height for nice spacing above hair
  const topMarginRatio = spec.id === "bd-passport" ? 0.08 : 0.08;

  let cropX = faceCenterX - cropW / 2 + (adjust.offsetX || 0) * cropW;
  let cropY = headTopY - topMarginRatio * cropH + (adjust.offsetY || 0) * cropH;

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, outW, outH);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  if (adjust.rotate) {
    ctx.save();
    ctx.translate(outW / 2, outH / 2);
    ctx.rotate((adjust.rotate * Math.PI) / 180);
    ctx.drawImage(cutout.canvas, cropX, cropY, cropW, cropH, -outW / 2, -outH / 2, outW, outH);
    ctx.restore();
  } else {
    ctx.drawImage(cutout.canvas, cropX, cropY, cropW, cropH, 0, 0, outW, outH);
  }
  return canvas;
}

export function buildPrintSheet(photo, spec) {
  const dpi = spec.dpi;
  const { width: pW, height: pH } = specPixels(spec);
  const gap = Math.round(0.04 * dpi);
  const margin = Math.round(0.15 * dpi);
  const sheetLong = 6 * dpi,
    sheetShort = 4 * dpi;
  const tryLayout = (sheetW, sheetH) => {
    const cols = Math.max(1, Math.floor((sheetW - 2 * margin + gap) / (pW + gap)));
    const rows = Math.max(1, Math.floor((sheetH - 2 * margin + gap) / (pH + gap)));
    return { sheetW, sheetH, cols, rows, count: cols * rows };
  };
  const portrait = tryLayout(sheetShort, sheetLong);
  const landscape = tryLayout(sheetLong, sheetShort);
  const layout = landscape.count > portrait.count ? landscape : portrait;

  const canvas = document.createElement("canvas");
  canvas.width = layout.sheetW;
  canvas.height = layout.sheetH;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, layout.sheetW, layout.sheetH);
  const gridW = layout.cols * pW + (layout.cols - 1) * gap;
  const gridH = layout.rows * pH + (layout.rows - 1) * gap;
  const startX = Math.round((layout.sheetW - gridW) / 2);
  const startY = Math.round((layout.sheetH - gridH) / 2);
  ctx.strokeStyle = "#c8c8c8";
  ctx.lineWidth = 1;
  for (let r = 0; r < layout.rows; r++) {
    for (let c = 0; c < layout.cols; c++) {
      const x = startX + c * (pW + gap);
      const y = startY + r * (pH + gap);
      ctx.drawImage(photo, x, y, pW, pH);
      ctx.strokeRect(x + 0.5, y + 0.5, pW, pH);
    }
  }
  return canvas;
}

export function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Export failed"))), type, quality);
  });
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
