// Compositing pipeline: source + soft mask -> framed passport photo + print sheet.
import { specPixels } from "./passport-specs.js";

export const DEFAULT_ADJUST = { zoom:1, offsetX:0, offsetY:0 };

export function composeCutout(source, maskCanvas, natWidth, natHeight){
  const canvas = document.createElement("canvas");
  canvas.width = natWidth; canvas.height = natHeight;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, natWidth, natHeight);
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(maskCanvas, 0, 0, natWidth, natHeight);
  ctx.globalCompositeOperation = "source-over";

  const sw = 160;
  const sh = Math.max(1, Math.round((natHeight/natWidth)*sw));
  const small = document.createElement("canvas");
  small.width = sw; small.height = sh;
  const sctx = small.getContext("2d", { willReadFrequently:true });
  sctx.drawImage(maskCanvas, 0, 0, sw, sh);
  const alpha = sctx.getImageData(0, 0, sw, sh).data;
  let minX=sw,minY=sh,maxX=0,maxY=0,found=false;
  const threshold = 96;
  for (let y=0; y<sh; y++){
    for (let x=0; x<sw; x++){
      if (alpha[(y*sw+x)*4+3] > threshold){
        found=true;
        if (x<minX) minX=x; if (x>maxX) maxX=x;
        if (y<minY) minY=y; if (y>maxY) maxY=y;
      }
    }
  }
  let bbox;
  if (found){
    const scaleX = natWidth/sw, scaleY = natHeight/sh;
    const x = minX*scaleX, y = minY*scaleY;
    const w = (maxX-minX+1)*scaleX, h = (maxY-minY+1)*scaleY;
    bbox = { x, y, w, h, cx: x + w/2 };
  } else {
    bbox = { x:0, y:0, w:natWidth, h:natHeight, cx:natWidth/2 };
  }
  return { canvas, width:natWidth, height:natHeight, bbox };
}

export function renderPassport(cutout, spec, bgColor, adjust){
  const { width:outW, height:outH } = specPixels(spec);
  const aspect = outW/outH;
  const { bbox } = cutout;
  const baseCropH = bbox.h / spec.subjectFill;
  const cropH = baseCropH / adjust.zoom;
  const cropW = cropH * aspect;
  const topMargin = 0.1;
  const cropX = bbox.cx - cropW/2 + adjust.offsetX * cropW;
  const cropY = bbox.y - topMargin * cropH + adjust.offsetY * cropH;

  const canvas = document.createElement("canvas");
  canvas.width = outW; canvas.height = outH;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, outW, outH);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  ctx.drawImage(cutout.canvas, cropX, cropY, cropW, cropH, 0, 0, outW, outH);
  return canvas;
}

export function buildPrintSheet(photo, spec){
  const dpi = spec.dpi;
  const { width:pW, height:pH } = specPixels(spec);
  const gap = Math.round(0.04*dpi);
  const margin = Math.round(0.15*dpi);
  const sheetLong = 6*dpi, sheetShort = 4*dpi;
  const tryLayout = (sheetW, sheetH) => {
    const cols = Math.max(1, Math.floor((sheetW - 2*margin + gap) / (pW + gap)));
    const rows = Math.max(1, Math.floor((sheetH - 2*margin + gap) / (pH + gap)));
    return { sheetW, sheetH, cols, rows, count: cols*rows };
  };
  const portrait = tryLayout(sheetShort, sheetLong);
  const landscape = tryLayout(sheetLong, sheetShort);
  const layout = landscape.count > portrait.count ? landscape : portrait;

  const canvas = document.createElement("canvas");
  canvas.width = layout.sheetW; canvas.height = layout.sheetH;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, layout.sheetW, layout.sheetH);
  const gridW = layout.cols*pW + (layout.cols-1)*gap;
  const gridH = layout.rows*pH + (layout.rows-1)*gap;
  const startX = Math.round((layout.sheetW - gridW)/2);
  const startY = Math.round((layout.sheetH - gridH)/2);
  ctx.strokeStyle = "#c8c8c8"; ctx.lineWidth = 1;
  for (let r=0; r<layout.rows; r++){
    for (let c=0; c<layout.cols; c++){
      const x = startX + c*(pW+gap);
      const y = startY + r*(pH+gap);
      ctx.drawImage(photo, x, y, pW, pH);
      ctx.strokeRect(x+0.5, y+0.5, pW, pH);
    }
  }
  return canvas;
}

export function canvasToBlob(canvas, type, quality){
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => b ? resolve(b) : reject(new Error("Export failed")), type, quality);
  });
}

export function downloadBlob(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
