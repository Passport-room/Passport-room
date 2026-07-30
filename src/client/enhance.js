// Local High-Definition AI Face & Image Enhancer for Passport Photos.
// Enhances, upscales, smooths skin, and removes dark spots — all on-device.
// No paid APIs.
//
// Performance: all heavy pixel processing runs on a capped working canvas
// (max ~1200px) so the browser never freezes or crashes. The final 4x
// upscale is applied afterwards via the GPU-accelerated canvas drawImage.

import { detectFaceInCanvas } from "./face-detector.js";

const UPSCALE_FACTOR = 4;
const MAX_WORKING_DIM = 1200;

let busy = false;
let preSnapshot = null;

const $ = (id) => document.getElementById(id);

function setStatus(msg, kind = "") {
  const el = $("enhanceStatus");
  if (!el) return;
  el.className = "tryOnStatus " + kind;
  el.innerHTML = "";
  if (msg) {
    const dot = document.createElement("span");
    dot.className = "tryOnStatusDot";
    const span = document.createElement("span");
    span.className = "tryOnStatusMsg";
    span.textContent = msg;
    el.appendChild(dot);
    el.appendChild(span);
  }
  const prog = $("enhanceProgress");
  if (prog) prog.classList.toggle("hidden", kind !== "info");
}
window.__updateEnhanceBtn = updateBtn;

function updateBtn() {
  const btn = $("enhanceGenerate");
  if (!btn) return;
  const isTryOn = !!window.__isTryOnRunning;
  const hasPhoto = !!window.__tryOn?.getPersonDataUrl?.();
  const ready = !busy && !isTryOn && hasPhoto;
  btn.disabled = !ready;
  btn.textContent = isTryOn ? "Try-On in progress..." : busy ? "Enhancing…" : "Enhance photo";
}

const yieldToUI = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// Skin detection — works across all skin tones (light to deep)
// ---------------------------------------------------------------------------

function isSkinPixel(r, g, b) {
  const sum = r + g + b;
  if (sum < 30 || sum > 750) return false;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;
  const isRedDominant = r >= g - 10 && r >= b - 10;
  const isNotGrey = chroma >= 4;
  const isNotWhite = !(r > 240 && g > 240 && b > 240);
  return isRedDominant && isNotGrey && isNotWhite;
}

function isLipPixel(r, g, b) {
  return r > 50 && r > g * 1.25 && r > b * 1.25 && Math.abs(g - b) < 55;
}

function isEyeOrBrow(r, g, b) {
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  return luma < 70 && Math.abs(r - g) < 30 && Math.abs(g - b) < 30;
}

// ---------------------------------------------------------------------------
// Bilateral filter — edge-preserving smoothing (chunked to stay responsive)
// ---------------------------------------------------------------------------

async function bilateralFilter(data, w, h, radius, sigmaSpatial, sigmaColor, onProgress) {
  const result = new Uint8ClampedArray(data);
  const sigmaS2 = 2 * sigmaSpatial * sigmaSpatial;
  const sigmaC2 = 2 * sigmaColor * sigmaColor;
  const CHUNK = 64;

  for (let yStart = 0; yStart < h; yStart += CHUNK) {
    const yEnd = Math.min(h, yStart + CHUNK);
    for (let y = yStart; y < yEnd; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4;
        const cr = data[idx], cg = data[idx + 1], cb = data[idx + 2];
        if (!isSkinPixel(cr, cg, cb) || isLipPixel(cr, cg, cb) || isEyeOrBrow(cr, cg, cb)) continue;

        let wSum = 0, rSum = 0, gSum = 0, bSum = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -radius; dx <= radius; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= w) continue;
            const nidx = (ny * w + nx) * 4;
            const nr = data[nidx], ng = data[nidx + 1], nb = data[nidx + 2];
            if (!isSkinPixel(nr, ng, nb) || isLipPixel(nr, ng, nb) || isEyeOrBrow(nr, ng, nb)) continue;
            const spatialDist = dx * dx + dy * dy;
            const colorDist = (cr - nr) * (cr - nr) + (cg - ng) * (cg - ng) + (cb - nb) * (cb - nb);
            const weight = Math.exp(-(spatialDist / sigmaS2) - (colorDist / sigmaC2));
            wSum += weight; rSum += nr * weight; gSum += ng * weight; bSum += nb * weight;
          }
        }
        if (wSum > 0) {
          result[idx] = Math.round(rSum / wSum);
          result[idx + 1] = Math.round(gSum / wSum);
          result[idx + 2] = Math.round(bSum / wSum);
        }
      }
    }
    onProgress?.(yEnd / h);
    await yieldToUI();
  }
  return result;
}

// ---------------------------------------------------------------------------
// Dark spot / blemish / dark circle removal (single neighborhood pass)
// ---------------------------------------------------------------------------

async function removeDarkSpots(data, w, h, faceInfo, origW, origH, onProgress) {
  const result = new Uint8ClampedArray(data);
  let fcx = w / 2, fcy = h * 0.4, fradX = w * 0.45, fradY = h * 0.45;
  if (faceInfo) {
    const sx = w / origW, sy = h / origH;
    fcx = faceInfo.faceCenterX * sx;
    fcy = ((faceInfo.headTopY + faceInfo.chinY) / 2) * sy;
    fradX = Math.max(w * 0.35, faceInfo.faceHeight * 1.3 * sx);
    fradY = Math.max(h * 0.45, faceInfo.faceHeight * 1.5 * sy);
  }
  const radius = Math.max(4, Math.round(w * 0.02));
  const step = Math.max(1, Math.round(radius / 3));
  const CHUNK = 64;

  for (let yStart = 0; yStart < h; yStart += CHUNK) {
    const yEnd = Math.min(h, yStart + CHUNK);
    for (let y = yStart; y < yEnd; y++) {
      const dyNorm = (y - fcy) / fradY;
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4;
        const r = data[idx], g = data[idx + 1], b = data[idx + 2];
        if (!isSkinPixel(r, g, b) || isLipPixel(r, g, b) || isEyeOrBrow(r, g, b)) continue;
        const dxNorm = (x - fcx) / fradX;
        const distSq = dxNorm * dxNorm + dyNorm * dyNorm;
        const faceWeight = Math.max(0, Math.min(1, 1 - distSq * 0.4));
        if (faceWeight < 0.05) continue;

        const currentLuma = 0.299 * r + 0.587 * g + 0.114 * b;
        let lumaSum = 0, avgR = 0, avgG = 0, avgB = 0, count = 0;
        for (let dy = -radius; dy <= radius; dy += step) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -radius; dx <= radius; dx += step) {
            const nx = x + dx;
            if (nx < 0 || nx >= w) continue;
            const nidx = (ny * w + nx) * 4;
            const nr = data[nidx], ng = data[nidx + 1], nb = data[nidx + 2];
            if (isSkinPixel(nr, ng, nb) && !isLipPixel(nr, ng, nb) && !isEyeOrBrow(nr, ng, nb)) {
              lumaSum += 0.299 * nr + 0.587 * ng + 0.114 * nb;
              avgR += nr; avgG += ng; avgB += nb; count++;
            }
          }
        }
        if (count >= 5) {
          const avgLuma = lumaSum / count;
          if (currentLuma < avgLuma * 0.85) {
            const lumaDiff = (avgLuma - currentLuma) / Math.max(avgLuma, 1);
            const eraseBlend = Math.min(0.85, lumaDiff * 2.5) * faceWeight;
            avgR /= count; avgG /= count; avgB /= count;
            result[idx] = Math.round(r * (1 - eraseBlend) + avgR * eraseBlend);
            result[idx + 1] = Math.round(g * (1 - eraseBlend) + avgG * eraseBlend);
            result[idx + 2] = Math.round(b * (1 - eraseBlend) + avgB * eraseBlend);
          }
        }
      }
    }
    onProgress?.(yEnd / h);
    await yieldToUI();
  }
  return result;
}

// ---------------------------------------------------------------------------
// Separable Gaussian blur + unsharp masking
// ---------------------------------------------------------------------------

function gaussianBlur(data, w, h, radius) {
  const sigma = Math.max(0.5, radius / 2);
  const kSize = Math.max(3, Math.ceil(radius * 2) | 1);
  const kHalf = Math.floor(kSize / 2);
  const kernel = [];
  let kSum = 0;
  for (let i = 0; i < kSize; i++) {
    const xv = i - kHalf;
    const val = Math.exp(-(xv * xv) / (2 * sigma * sigma));
    kernel.push(val); kSum += val;
  }
  for (let i = 0; i < kSize; i++) kernel[i] /= kSum;

  const temp = new Uint8ClampedArray(data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let k = 0; k < kSize; k++) {
        const nx = Math.min(w - 1, Math.max(0, x + k - kHalf));
        const idx = (y * w + nx) * 4;
        r += data[idx] * kernel[k]; g += data[idx + 1] * kernel[k]; b += data[idx + 2] * kernel[k];
      }
      const idx = (y * w + x) * 4;
      temp[idx] = r; temp[idx + 1] = g; temp[idx + 2] = b; temp[idx + 3] = data[idx + 3];
    }
  }
  const result = new Uint8ClampedArray(data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let k = 0; k < kSize; k++) {
        const ny = Math.min(h - 1, Math.max(0, y + k - kHalf));
        const idx = (ny * w + x) * 4;
        r += temp[idx] * kernel[k]; g += temp[idx + 1] * kernel[k]; b += temp[idx + 2] * kernel[k];
      }
      const idx = (y * w + x) * 4;
      result[idx] = r; result[idx + 1] = g; result[idx + 2] = b; result[idx + 3] = data[idx + 3];
    }
  }
  return result;
}

function unsharpMask(data, w, h, amount, radius) {
  const blurred = gaussianBlur(data, w, h, radius);
  const result = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const original = data[i + c];
      const highFreq = original - blurred[i + c];
      result[i + c] = Math.min(255, Math.max(0, Math.round(original + highFreq * amount)));
    }
    result[i + 3] = data[i + 3];
  }
  return result;
}

// ---------------------------------------------------------------------------
// Lighting equalization — evens out shadows for passport compliance
// ---------------------------------------------------------------------------

function equalizeLighting(data, w, h, faceInfo, origW, origH) {
  const result = new Uint8ClampedArray(data);
  let fcx = w / 2, fcy = h * 0.4, fradX = w * 0.45, fradY = h * 0.45;
  if (faceInfo) {
    const sx = w / origW, sy = h / origH;
    fcx = faceInfo.faceCenterX * sx;
    fcy = ((faceInfo.headTopY + faceInfo.chinY) / 2) * sy;
    fradX = Math.max(w * 0.35, faceInfo.faceHeight * 1.3 * sx);
    fradY = Math.max(h * 0.45, faceInfo.faceHeight * 1.5 * sy);
  }
  for (let y = 0; y < h; y++) {
    const dyNorm = (y - fcy) / fradY;
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const dxNorm = (x - fcx) / fradX;
      const distSq = dxNorm * dxNorm + dyNorm * dyNorm;
      const faceWeight = Math.max(0, Math.min(1, 1 - distSq * 0.5));
      if (faceWeight > 0.1) {
        const lumaBoost = faceWeight * 6;
        const contrastFactor = 1.04 + faceWeight * 0.02;
        for (let c = 0; c < 3; c++) {
          let val = data[idx + c];
          val = (val - 128) * contrastFactor + 128 + lumaBoost;
          result[idx + c] = Math.min(255, Math.max(0, Math.round(val)));
        }
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Multi-step high-quality upscaling (GPU-accelerated drawImage)
// ---------------------------------------------------------------------------

function upscaleCanvas(srcCanvas, targetW, targetH) {
  const origW = srcCanvas.width;
  const origH = srcCanvas.height;
  const steps = [];
  let curW = origW, curH = origH;
  while (curW * 2 <= targetW || curH * 2 <= targetH) {
    curW = Math.min(targetW, curW * 2);
    curH = Math.min(targetH, curH * 2);
    steps.push({ w: curW, h: curH });
  }
  if (curW !== targetW || curH !== targetH) steps.push({ w: targetW, h: targetH });

  let current = srcCanvas;
  for (const step of steps) {
    const canvas = document.createElement("canvas");
    canvas.width = step.w; canvas.height = step.h;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(current, 0, 0, step.w, step.h);
    current = canvas;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Main enhancement pipeline — pixel work on capped working canvas, then upscale
// ---------------------------------------------------------------------------

async function processFaceEnhancement(srcCanvas, setStatusMsg) {
  const origW = srcCanvas.width;
  const origH = srcCanvas.height;

  // Cap working resolution for heavy pixel processing
  const workScale = Math.min(1, MAX_WORKING_DIM / Math.max(origW, origH));
  const workW = Math.max(1, Math.round(origW * workScale));
  const workH = Math.max(1, Math.round(origH * workScale));

  const workCanvas = document.createElement("canvas");
  workCanvas.width = workW; workCanvas.height = workH;
  const wctx = workCanvas.getContext("2d", { willReadFrequently: true });
  wctx.imageSmoothingEnabled = true; wctx.imageSmoothingQuality = "high";
  wctx.drawImage(srcCanvas, 0, 0, workW, workH);

  const faceInfo = detectFaceInCanvas(workCanvas, null);
  let imgData = wctx.getImageData(0, 0, workW, workH);
  let data = imgData.data;

  // Pass 1: Dark spot / blemish / dark circle removal
  setStatusMsg("Removing dark spots & blemishes…");
  await yieldToUI();
  data = await removeDarkSpots(data, workW, workH, faceInfo, workW, workH);
  wctx.putImageData(new ImageData(data, workW, workH), 0, 0);

  // Pass 2: Bilateral skin smoothing (edge-preserving)
  setStatusMsg("Smoothing skin texture…");
  await yieldToUI();
  const radius = Math.max(2, Math.round(workW * 0.012));
  data = await bilateralFilter(data, workW, workH, radius, radius * 1.5, 30);
  wctx.putImageData(new ImageData(data, workW, workH), 0, 0);

  // Pass 3: Unsharp masking for detail clarity
  setStatusMsg("Sharpening facial features…");
  await yieldToUI();
  data = unsharpMask(data, workW, workH, 0.6, Math.max(2, Math.round(workW * 0.004)));
  wctx.putImageData(new ImageData(data, workW, workH), 0, 0);

  // Pass 4: Lighting equalization for passport compliance
  setStatusMsg("Equalising lighting for passport standard…");
  await yieldToUI();
  data = equalizeLighting(data, workW, workH, faceInfo, workW, workH);
  wctx.putImageData(new ImageData(data, workW, workH), 0, 0);

  // Final upscale to 4x from the enhanced working canvas
  setStatusMsg("Upscaling to high definition…");
  await yieldToUI();
  const targetW = Math.round(origW * UPSCALE_FACTOR);
  const targetH = Math.round(origH * UPSCALE_FACTOR);
  const finalCanvas = upscaleCanvas(workCanvas, targetW, targetH);

  setStatusMsg("Finalizing high definition passport photo…");
  await yieldToUI();

  return { dataUrl: finalCanvas.toDataURL("image/png"), width: targetW, height: targetH };
}

async function enhance() {
  if (busy) return;
  if (window.__isTryOnRunning) {
    setStatus("AI Dress Try-On is currently running. Please wait for it to complete.", "warn");
    return;
  }
  if (!window.__tryOn) { setStatus("Editor not ready — upload a photo first.", "err"); return; }
  const personDataUrl = window.__tryOn.getPersonDataUrl();
  if (!personDataUrl) { setStatus("Upload a photo first.", "err"); return; }

  busy = true;
  window.__isEnhanceRunning = true;
  window.__updateToolButtons?.();
  updateBtn();

  try {
    preSnapshot = personDataUrl;
    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Could not load photo for enhancement"));
      img.src = personDataUrl;
    });

    const srcCanvas = document.createElement("canvas");
    srcCanvas.width = img.naturalWidth || img.width;
    srcCanvas.height = img.naturalHeight || img.height;
    const sctx = srcCanvas.getContext("2d");
    sctx.drawImage(img, 0, 0);

    const res = await processFaceEnhancement(srcCanvas, (m) => setStatus(m, "info"));

    await window.__tryOn.applyResult(res.dataUrl, (m) => setStatus(m, "info"));
    $("enhanceRevert").classList.remove("hidden");
    setStatus(`Enhanced & upscaled to ${UPSCALE_FACTOR}\u00d7 Studio HD. Dark spots reduced, skin smoothed. You can now also change clothes!`, "ok");
  } catch (e) {
    console.error(e);
    setStatus(e.message || "Enhance failed. Please try again.", "err");
  } finally {
    busy = false;
    window.__isEnhanceRunning = false;
    window.__updateToolButtons?.();
    updateBtn();
  }
}

async function revert() {
  if (!preSnapshot || busy) return;
  busy = true;
  window.__isEnhanceRunning = true;
  window.__updateToolButtons?.();
  updateBtn();
  setStatus("Restoring original…", "info");
  try {
    await window.__tryOn.applyResult(preSnapshot, (m) => setStatus(m, "info"));
    $("enhanceRevert").classList.add("hidden");
    preSnapshot = null;
    setStatus("Reverted to original.", "ok");
  } catch (e) {
    setStatus(e.message || "Could not revert.", "err");
  } finally {
    busy = false;
    window.__isEnhanceRunning = false;
    window.__updateToolButtons?.();
    updateBtn();
  }
}

function bind() {
  const gen = $("enhanceGenerate");
  const rev = $("enhanceRevert");
  if (gen) gen.onclick = enhance;
  if (rev) rev.onclick = revert;
  const obs = new MutationObserver(updateBtn);
  const resultView = document.getElementById("resultView");
  if (resultView) obs.observe(resultView, { attributes: true, attributeFilter: ["class"] });
  updateBtn();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
else bind();
