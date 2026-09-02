// Face detection & landmarks — 100% on-device.
//
// Primary path: a small ONNX face detector (YOLO-Face 8n, ~12 MB) streamed
// once from Hugging Face, saved on the device through model-cache.js exactly
// like MODNet / GPEN, and reused from IndexedDB forever after. It returns a
// real face box plus 5 landmarks (both eyes, nose, both mouth corners), so it
// copes with tilted heads, glasses and off-centre framing.
//
// Fallback path: the original skin-tone + silhouette heuristic, kept intact so
// nothing breaks when the model cannot be downloaded or the device refuses to
// create a session. `detectFaceInCanvas()` stays synchronous and unchanged for
// existing callers (passport-render.js).

import { MODEL_KEYS, getModelBytes, createSession, isModelSaved } from "./model-cache.js";
import { markStart, markDone } from "./crash-guard.js";

const DETECT_MODEL_URL =
  "https://huggingface.co/facefusion/models-3.0.0/resolve/main/yoloface_8n.onnx";
const NET = 640; // model input is 1x3x640x640
const MIN_SCORE = 0.4;

let detectorPromise = null;

/** True when the face detector model is already saved on this device. */
export function isFaceDetectorSaved() {
  return isModelSaved(MODEL_KEYS.FACE_DETECT);
}

/** Loads (and caches) the on-device face detector session. */
export function loadFaceDetector(onProgress) {
  if (detectorPromise) return detectorPromise;
  detectorPromise = (async () => {
    const bytes = await getModelBytes(MODEL_KEYS.FACE_DETECT, DETECT_MODEL_URL, onProgress);
    onProgress && onProgress({ stage: "compile", model: "detector" });
    const { ort, session, backend } = await createSession(bytes);
    onProgress && onProgress({ stage: "ready", model: "detector" });
    return { ort, session, backend };
  })().catch((err) => {
    detectorPromise = null;
    throw err;
  });
  return detectorPromise;
}

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** Letterboxes the photo into NETxNET (top-left aligned, aspect preserved). */
function letterbox(source) {
  const w = source.width || source.naturalWidth;
  const h = source.height || source.naturalHeight;
  const scale = Math.min(NET / w, NET / h);
  const c = makeCanvas(NET, NET);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, NET, NET);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, w, h, 0, 0, Math.round(w * scale), Math.round(h * scale));
  return { canvas: c, scale };
}

/**
 * Runs the ONNX detector and returns the highest-scoring face, or null.
 * Output is [1, 20, 8400]: 4 box (cx,cy,w,h) + 1 score + 5 landmarks (x,y,score).
 */
async function runDetector(source) {
  const { ort, session } = await loadFaceDetector();
  const { canvas, scale } = letterbox(source);
  const { data } = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, NET, NET);
  const area = NET * NET;
  const f = new Float32Array(3 * area);
  for (let i = 0; i < area; i++) {
    f[i] = data[i * 4] / 255;
    f[area + i] = data[i * 4 + 1] / 255;
    f[2 * area + i] = data[i * 4 + 2] / 255;
  }
  const inputName = session.inputNames[0];
  // Rule R1 (crash-guard.js): bracket every GPU/WASM run with breadcrumbs so
  // a tab crash here is remembered instead of repeating silently.
  let out;
  markStart();
  try {
    out = await session.run({
      [inputName]: new ort.Tensor("float32", f, [1, 3, NET, NET]),
    });
  } finally {
    markDone();
  }
  const tensor = out[session.outputNames[0]];
  const [, rows, anchors] = tensor.dims; // rows = 20
  const pred = tensor.data;

  let best = -1;
  let bestScore = 0;
  for (let a = 0; a < anchors; a++) {
    const s = pred[4 * anchors + a];
    if (s > bestScore) {
      bestScore = s;
      best = a;
    }
  }
  if (best < 0 || bestScore < MIN_SCORE) return null;

  const at = (row) => pred[row * anchors + best] / scale;
  const cx = at(0);
  const cy = at(1);
  const bw = at(2);
  const bh = at(3);
  const pts = [];
  for (let k = 0; k < 5 && 5 + k * 3 + 1 < rows; k++) {
    pts.push({ x: at(5 + k * 3), y: at(5 + k * 3 + 1) });
  }
  if (pts.length < 5) return null;

  return {
    score: bestScore,
    box: { x: cx - bw / 2, y: cy - bh / 2, w: bw, h: bh },
    points: pts,
  };
}

/** Turns the raw 5 points into named landmarks (viewer-left / viewer-right). */
function nameLandmarks(points) {
  const eyes = [points[0], points[1]].sort((a, b) => a.x - b.x);
  const mouth = [points[3], points[4]].sort((a, b) => a.x - b.x);
  return {
    leftEye: eyes[0],
    rightEye: eyes[1],
    nose: points[2],
    mouthLeft: mouth[0],
    mouthRight: mouth[1],
  };
}

/**
 * Builds the geometry the enhancer needs from landmarks: crown/chin estimates,
 * roll angle (tilted heads) and a face-shaped ellipse instead of a circle.
 */
function geometryFromLandmarks(det, w, h) {
  const lm = nameLandmarks(det.points);
  const eyeMidX = (lm.leftEye.x + lm.rightEye.x) / 2;
  const eyeMidY = (lm.leftEye.y + lm.rightEye.y) / 2;
  const mouthMidX = (lm.mouthLeft.x + lm.mouthRight.x) / 2;
  const mouthMidY = (lm.mouthLeft.y + lm.mouthRight.y) / 2;

  const roll = Math.atan2(lm.rightEye.y - lm.leftEye.y, lm.rightEye.x - lm.leftEye.x);

  // Anatomical proportions: mouth sits ~0.5 of the eye→chin span above the
  // chin, and the eye line sits ~0.55 of the way down crown→chin.
  const eyeToMouth = Math.max(4, Math.hypot(mouthMidX - eyeMidX, mouthMidY - eyeMidY));
  const eyeToChin = eyeToMouth * 1.95;
  let faceHeight = eyeToChin / 0.55;
  faceHeight = Math.max(faceHeight, det.box.h * 0.95);

  // Walk down the face axis from the eye line to place the chin.
  const axisX = Math.sin(roll) * -1;
  const axisY = Math.cos(roll);
  const chinX = eyeMidX + axisX * eyeToChin;
  const chinY = eyeMidY + axisY * eyeToChin;
  const crownX = chinX - axisX * faceHeight;
  const crownY = chinY - axisY * faceHeight;

  const faceCenterX = eyeMidX * 0.5 + (lm.nose.x + mouthMidX) / 2 * 0.5;

  return {
    headTopY: Math.max(0, crownY),
    chinY: Math.min(h, chinY),
    faceHeight,
    faceCenterX,
    faceCenterY: (crownY + chinY) / 2,
    fullW: w,
    fullH: h,
    source: "onnx",
    score: det.score,
    roll,
    landmarks: lm,
    detectBox: det.box,
    // Face-shaped oval (crown→chin tall, cheek-to-cheek wide), rotated with the head.
    ellipse: {
      cx: (crownX + chinX) / 2,
      cy: (crownY + chinY) / 2,
      rx: faceHeight * 0.37,
      ry: faceHeight * 0.53,
      angle: roll,
    },
  };
}

/**
 * Preferred entry point: real on-device detection with heuristic fallback.
 * Always resolves (never throws) so callers can rely on it.
 * @returns {Promise<null|object>} face geometry incl. `landmarks` when available
 */
export async function detectFace(sourceCanvas, maskCanvas = null, opts = {}) {
  const w = sourceCanvas.width || sourceCanvas.naturalWidth;
  const h = sourceCanvas.height || sourceCanvas.naturalHeight;
  if (!w || !h) return null;

  if (opts.useModel !== false) {
    try {
      const det = await runDetector(sourceCanvas);
      if (det) return geometryFromLandmarks(det, w, h);
    } catch (err) {
      console.warn("[face-detector] model unavailable, using heuristic", err?.message || err);
    }
  }

  try {
    const fallback = detectFaceInCanvas(sourceCanvas, maskCanvas);
    if (fallback) {
      return {
        ...fallback,
        faceCenterY: (fallback.headTopY + fallback.chinY) / 2,
        source: "heuristic",
        roll: 0,
        landmarks: null,
        ellipse: {
          cx: fallback.faceCenterX,
          cy: (fallback.headTopY + fallback.chinY) / 2,
          rx: fallback.faceHeight * 0.37,
          ry: fallback.faceHeight * 0.53,
          angle: 0,
        },
      };
    }
  } catch {
    /* ignore */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Legacy heuristic (skin tone + silhouette). Kept as the offline fallback and
// for the passport cropper, which calls it synchronously.
// ---------------------------------------------------------------------------

export function detectFaceInCanvas(sourceCanvas, maskCanvas) {
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;

  if (!w || !h) {
    return null;
  }

  // Sample image for fast face feature detection
  const sampleW = 200;
  const sampleH = Math.max(1, Math.round((h / w) * sampleW));

  const temp = document.createElement("canvas");
  temp.width = sampleW;
  temp.height = sampleH;
  const ctx = temp.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(sourceCanvas, 0, 0, sampleW, sampleH);
  const imgData = ctx.getImageData(0, 0, sampleW, sampleH);
  const data = imgData.data;

  // Mask alpha data if available
  let maskData = null;
  if (maskCanvas) {
    const mtemp = document.createElement("canvas");
    mtemp.width = sampleW;
    mtemp.height = sampleH;
    const mctx = mtemp.getContext("2d", { willReadFrequently: true });
    mctx.drawImage(maskCanvas, 0, 0, sampleW, sampleH);
    maskData = mctx.getImageData(0, 0, sampleW, sampleH).data;
  }

  // 1. Detect head top from alpha mask or non-transparent silhouette
  let headTopSampleY = -1;
  let headBottomSampleY = -1;
  let minSampleX = sampleW,
    maxSampleX = 0;

  for (let y = 0; y < sampleH; y++) {
    for (let x = 0; x < sampleW; x++) {
      const idx = (y * sampleW + x) * 4;
      const alpha = maskData ? maskData[idx + 3] : data[idx + 3];
      if (alpha > 80) {
        if (headTopSampleY === -1) headTopSampleY = y;
        headBottomSampleY = y;
        if (x < minSampleX) minSampleX = x;
        if (x > maxSampleX) maxSampleX = x;
      }
    }
  }

  if (headTopSampleY === -1) {
    return null;
  }

  const cutoutSampleH = headBottomSampleY - headTopSampleY + 1;

  // 2. Measure head width & center in the upper 30% section of person cutout
  const upperYEnd = Math.min(sampleH - 1, Math.round(headTopSampleY + cutoutSampleH * 0.35));
  let headMinX = sampleW,
    headMaxX = 0;
  let headXSum = 0,
    headXCount = 0;

  for (let y = headTopSampleY; y <= upperYEnd; y++) {
    for (let x = 0; x < sampleW; x++) {
      const idx = (y * sampleW + x) * 4;
      const alpha = maskData ? maskData[idx + 3] : data[idx + 3];
      if (alpha > 80) {
        if (x < headMinX) headMinX = x;
        if (x > headMaxX) headMaxX = x;
        headXSum += x;
        headXCount++;
      }
    }
  }

  const headSampleWidth = Math.max(10, headMaxX - headMinX);
  const headSampleCenterX = headXCount > 0 ? headXSum / headXCount : (minSampleX + maxSampleX) / 2;

  // 3. Scan face skin tone for chin location
  const skinMap = new Uint8Array(sampleW * sampleH);
  let skinCount = 0;
  let sumSkinX = 0;

  for (let y = headTopSampleY; y <= Math.min(sampleH - 1, headBottomSampleY); y++) {
    for (let x = headMinX; x <= headMaxX; x++) {
      const i = (y * sampleW + x) * 4;
      if (maskData && maskData[i + 3] < 80) continue;

      const r = data[i],
        g = data[i + 1],
        b = data[i + 2];
      const isSkin =
        r > 60 &&
        g > 40 &&
        b > 20 &&
        Math.max(r, g, b) - Math.min(r, g, b) > 12 &&
        Math.abs(r - g) > 10 &&
        r > g &&
        r > b;

      if (isSkin) {
        skinMap[y * sampleW + x] = 1;
        skinCount++;
        sumSkinX += x;
      }
    }
  }

  let chinSampleY = -1;
  let faceCenterSampleX = skinCount > 20 ? sumSkinX / skinCount : headSampleCenterX;

  if (skinCount > 20) {
    let lastSkinY = headTopSampleY;
    for (let y = headTopSampleY; y <= headBottomSampleY; y++) {
      let rowSkin = 0;
      for (
        let x = Math.max(0, Math.floor(faceCenterSampleX - 25));
        x <= Math.min(sampleW - 1, Math.ceil(faceCenterSampleX + 25));
        x++
      ) {
        if (skinMap[y * sampleW + x]) rowSkin++;
      }
      if (rowSkin >= 3) {
        lastSkinY = y;
      }
    }
    chinSampleY = Math.min(headBottomSampleY, lastSkinY);
  }

  // Calculate face height (crown of head to chin)
  // Anatomically head height is ~1.28x head width or ~45% of head+torso cutout
  let rawDetectedFaceH =
    chinSampleY > headTopSampleY + 10 ? chinSampleY - headTopSampleY : headSampleWidth * 1.28;

  // Cap face height to avoid counting exposed neck/chest skin as face
  const maxFaceH = Math.min(cutoutSampleH * 0.52, headSampleWidth * 1.35);
  const minFaceH = Math.max(15, headSampleWidth * 1.1);

  const sampleFaceHeight = Math.min(maxFaceH, Math.max(minFaceH, rawDetectedFaceH));

  // Convert to full resolution coordinates
  const scaleX = w / sampleW;
  const scaleY = h / sampleH;

  const headTopY = headTopSampleY * scaleY;
  const faceHeight = sampleFaceHeight * scaleY;
  const chinY = headTopY + faceHeight;
  const faceCenterX = faceCenterSampleX * scaleX;

  return {
    headTopY,
    chinY,
    faceHeight,
    faceCenterX,
    fullW: w,
    fullH: h,
  };
}
