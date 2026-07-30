// Local High-Definition AI Face & Image Enhancer
// Performs face detection, dark spot clearing, skin smoothing, feature sharpening, and HD upscaling.

import { detectFaceInCanvas } from "./face-detector.js";

let scale = 5;
let busy = false;
let preSnapshot = null;

const $ = (id) => document.getElementById(id);

function setStatus(msg, kind = "") {
  const el = $("enhanceStatus");
  if (!el) return;
  el.textContent = msg || "";
  el.className = "tryOnStatus " + kind;
}

function updateBtn() {
  const btn = $("enhanceGenerate");
  if (!btn) return;
  const isTryOn = !!window.__isTryOnRunning;
  const hasPhoto = !!window.__tryOn?.getPersonDataUrl?.();
  const ready = !busy && !isTryOn && hasPhoto;
  btn.disabled = !ready;
  if (isTryOn) {
    btn.textContent = "Try-On in progress...";
  } else if (busy) {
    btn.textContent = "Enhancing…";
  } else {
    btn.textContent = "Enhance photo";
  }
}
window.__updateEnhanceBtn = updateBtn;

/**
 * High quality face dark spot reduction, skin smoothing, feature clarity, and HD upscaling engine.
 * Tailored for studio & passport photo perfection across all skin tones with zero hard boundaries.
 */
async function processFaceEnhancement(srcCanvas, upscaleFactor, setStatusMsg) {
  setStatusMsg("Analyzing facial features & skin tones…");
  await new Promise((r) => setTimeout(r, 60));

  const origW = srcCanvas.width;
  const origH = srcCanvas.height;

  // Detect face location if possible
  const faceInfo = detectFaceInCanvas(srcCanvas, null);

  const targetW = Math.round(origW * upscaleFactor);
  const targetH = Math.round(origH * upscaleFactor);

  // High quality multi-pass canvas upscaling
  const outCanvas = document.createElement("canvas");
  outCanvas.width = targetW;
  outCanvas.height = targetH;
  const ctx = outCanvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  if (upscaleFactor > 2) {
    const midW = Math.round(origW * 2);
    const midH = Math.round(origH * 2);
    const midCanvas = document.createElement("canvas");
    midCanvas.width = midW;
    midCanvas.height = midH;
    const mctx = midCanvas.getContext("2d");
    mctx.imageSmoothingEnabled = true;
    mctx.imageSmoothingQuality = "high";
    mctx.drawImage(srcCanvas, 0, 0, midW, midH);
    ctx.drawImage(midCanvas, 0, 0, targetW, targetH);
  } else {
    ctx.drawImage(srcCanvas, 0, 0, targetW, targetH);
  }

  setStatusMsg("Clearing dark spots & smoothing skin…");
  await new Promise((r) => setTimeout(r, 60));

  const imgData = ctx.getImageData(0, 0, targetW, targetH);
  const data = imgData.data;

  // Compute face center and influence radius for smooth continuous falloff
  let fcx = targetW / 2;
  let fcy = targetH * 0.4;
  let fradX = targetW * 0.45;
  let fradY = targetH * 0.45;

  if (faceInfo) {
    const scaleX = targetW / origW;
    const scaleY = targetH / origH;
    fcx = faceInfo.faceCenterX * scaleX;
    fcy = ((faceInfo.headTopY + faceInfo.chinY) / 2) * scaleY;
    fradX = Math.max(targetW * 0.35, faceInfo.faceHeight * 1.3 * scaleX);
    fradY = Math.max(targetH * 0.45, faceInfo.faceHeight * 1.5 * scaleY);
  }

  const srcData = new Uint8ClampedArray(data);

  // Universal skin detection algorithm for light, medium, and deep skin tones
  function isSkinPixel(r, g, b) {
    const sum = r + g + b;
    if (sum < 35 || sum > 740) return false;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const chroma = max - min;

    // Skin color characteristics across all lighting
    const isRedDominant = r >= g - 8 && r >= b - 8;
    const isNotGrey = chroma >= 5;

    return isRedDominant && isNotGrey;
  }

  // Lip / mouth protection to prevent mouth blurring or distortion
  function isLipPixel(r, g, b) {
    return r > 50 && r > g * 1.25 && r > b * 1.25 && Math.abs(g - b) < 50;
  }

  // Pass 1: Dark Spot Blemish Eraser & Smooth Porcelain Skin Filter
  const radius = Math.max(3, Math.round(4 * upscaleFactor));
  const step = Math.max(1, Math.round(upscaleFactor));

  for (let y = 0; y < targetH; y++) {
    // Face weighting factor based on ellipse distance from face center
    const dyNorm = (y - fcy) / fradY;

    for (let x = 0; x < targetW; x++) {
      const idx = (y * targetW + x) * 4;
      const r = srcData[idx];
      const g = srcData[idx + 1];
      const b = srcData[idx + 2];

      const dxNorm = (x - fcx) / fradX;
      const distSq = dxNorm * dxNorm + dyNorm * dyNorm;

      // Smooth continuous weight between 0 and 1 with zero hard cutoffs
      const faceWeight = Math.max(0, Math.min(1, 1 - distSq * 0.45));

      // Skip lip pixels to keep mouth details perfectly intact
      if (isLipPixel(r, g, b) || !isSkinPixel(r, g, b) || faceWeight <= 0.05)
        continue;

      let skinRSum = 0,
        skinGSum = 0,
        skinBSum = 0,
        skinCount = 0;
      let skinLumaSum = 0;

      for (let dy = -radius; dy <= radius; dy += step) {
        const ny = y + dy;
        if (ny < 0 || ny >= targetH) continue;
        for (let dx = -radius; dx <= radius; dx += step) {
          const nx = x + dx;
          if (nx < 0 || nx >= targetW) continue;
          const nidx = (ny * targetW + nx) * 4;
          const nr = srcData[nidx];
          const ng = srcData[nidx + 1];
          const nb = srcData[nidx + 2];

          if (isSkinPixel(nr, ng, nb) && !isLipPixel(nr, ng, nb)) {
            skinRSum += nr;
            skinGSum += ng;
            skinBSum += nb;
            skinCount++;
            skinLumaSum += 0.299 * nr + 0.587 * ng + 0.114 * nb;
          }
        }
      }

      if (skinCount >= 3) {
        const avgR = skinRSum / skinCount;
        const avgG = skinGSum / skinCount;
        const avgB = skinBSum / skinCount;
        const avgLuma = skinLumaSum / skinCount;
        const currentLuma = 0.299 * r + 0.587 * g + 0.114 * b;

        let targetR = r;
        let targetG = g;
        let targetB = b;

        // Dark spot / blemish / dark circle under eyes correction
        if (currentLuma < avgLuma * 0.92) {
          const lumaDiff = (avgLuma - currentLuma) / avgLuma;
          const eraseBlend = Math.min(0.9, lumaDiff * 2.2);
          targetR = r * (1 - eraseBlend) + avgR * eraseBlend;
          targetG = g * (1 - eraseBlend) + avgG * eraseBlend;
          targetB = b * (1 - eraseBlend) + avgB * eraseBlend;
        } else {
          // Soft skin porcelain smoothing
          const smoothBlend = 0.4;
          targetR = r * (1 - smoothBlend) + avgR * smoothBlend;
          targetG = g * (1 - smoothBlend) + avgG * smoothBlend;
          targetB = b * (1 - smoothBlend) + avgB * smoothBlend;
        }

        // Apply with smooth face weight blend to avoid any boundary lines
        const finalBlend = faceWeight * 0.85;
        data[idx] = Math.round(r * (1 - finalBlend) + targetR * finalBlend);
        data[idx + 1] = Math.round(g * (1 - finalBlend) + targetG * finalBlend);
        data[idx + 2] = Math.round(b * (1 - finalBlend) + targetB * finalBlend);
      }
    }
  }

  setStatusMsg("Sharpening facial features & HD passport clarity…");
  await new Promise((r) => setTimeout(r, 60));

  // Pass 2: Feature Sharpening & Passport Lighting Equalization
  const smoothedData = new Uint8ClampedArray(data);
  const sharpFactor = 0.35;

  for (let y = 1; y < targetH - 1; y++) {
    const dyNorm = (y - fcy) / fradY;
    for (let x = 1; x < targetW - 1; x++) {
      const idx = (y * targetW + x) * 4;
      const dxNorm = (x - fcx) / fradX;
      const distSq = dxNorm * dxNorm + dyNorm * dyNorm;
      const faceWeight = Math.max(0, Math.min(1, 1 - distSq * 0.5));

      for (let c = 0; c < 3; c++) {
        const center = smoothedData[idx + c];
        const top = smoothedData[((y - 1) * targetW + x) * 4 + c];
        const bottom = smoothedData[((y + 1) * targetW + x) * 4 + c];
        const left = smoothedData[(y * targetW + (x - 1)) * 4 + c];
        const right = smoothedData[(y * targetW + (x + 1)) * 4 + c];

        const laplacian = 4 * center - top - bottom - left - right;
        const currentSharp = sharpFactor * (1 + faceWeight * 0.3);
        let val = center + laplacian * currentSharp;

        // Subtle studio passport lighting boost (+4% brightness & contrast calibration)
        if (faceWeight > 0.1) {
          const lumaBoost = faceWeight * 5;
          val = (val - 128) * (1.02 + faceWeight * 0.03) + 128 + lumaBoost;
        }

        data[idx + c] = Math.min(255, Math.max(0, Math.round(val)));
      }
    }
  }

  ctx.putImageData(imgData, 0, 0);

  setStatusMsg("Finalizing high definition passport photo…");
  await new Promise((r) => setTimeout(r, 60));

  return {
    dataUrl: outCanvas.toDataURL("image/png"),
    width: targetW,
    height: targetH,
  };
}

async function enhance() {
  if (busy) return;
  if (window.__isTryOnRunning) {
    setStatus(
      "AI Dress Try-On is currently running. Please wait for it to complete.",
      "warn",
    );
    return;
  }
  if (!window.__tryOn) {
    setStatus("Editor not ready — upload a photo first.", "err");
    return;
  }
  const personDataUrl = window.__tryOn.getPersonDataUrl();
  if (!personDataUrl) {
    setStatus("Upload a photo first.", "err");
    return;
  }

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
      img.onerror = () =>
        reject(new Error("Could not load photo for enhancement"));
      img.src = personDataUrl;
    });

    const srcCanvas = document.createElement("canvas");
    srcCanvas.width = img.naturalWidth || img.width;
    srcCanvas.height = img.naturalHeight || img.height;
    const sctx = srcCanvas.getContext("2d");
    sctx.drawImage(img, 0, 0);

    const res = await processFaceEnhancement(srcCanvas, 5, (m) => setStatus(m));

    await window.__tryOn.applyResult(res.dataUrl, (m) => setStatus(m));
    $("enhanceRevert").classList.remove("hidden");
    setStatus(
      `Enhanced & upscaled to 5× Studio HD with dark spot reduction. You can now also change clothes!`,
      "ok",
    );
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
  setStatus("Restoring original…");
  try {
    await window.__tryOn.applyResult(preSnapshot, (m) => setStatus(m));
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
  if (resultView)
    obs.observe(resultView, { attributes: true, attributeFilter: ["class"] });
  updateBtn();
}

if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", bind);
else bind();
