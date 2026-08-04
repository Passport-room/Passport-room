// CodeFormer FP16 face restoration — runs fully on-device.
//
// This module is the *main-thread* side: it locates the face, prepares the
// 512x512 crop, hands the pixels to codeformer.worker.js for inference, and
// blends the restored face back into the photo. All heavy work (download,
// session compile, inference, pixel maths) happens in the worker, so the page
// stays responsive on mobile and desktop.

import codeformerModel from "../assets/codeformer_fp16.onnx.asset.json";

const MODEL_URL = codeformerModel.url;
const FACE_SIZE = 512;
const WORKER_URL = "/assets/codeformer.worker.js";

/** Default fidelity weight — 0.5–0.6 gives natural, non-plastic results. */
export const DEFAULT_FIDELITY_WEIGHT = 0.55;

const IDB_NAME = "makepics-models";
const IDB_STORE = "onnx";
const IDB_KEY = "codeformer-fp16-v1";

let worker = null;
let readyPromise = null;
let msgId = 0;
const pending = new Map();
let progressHandler = null;

/* ------------------------------------------------------------------ *
 * Worker plumbing
 * ------------------------------------------------------------------ */

function getWorker() {
  if (worker) return worker;
  worker = new Worker(WORKER_URL, { type: "module" });
  worker.onmessage = ({ data }) => {
    if (data.type === "progress") {
      progressHandler?.(data.payload);
      return;
    }
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.type === "error") entry.reject(new Error(data.message));
    else entry.resolve(data);
  };
  worker.onerror = (e) => {
    const err = new Error(e.message || "The AI enhancer could not start.");
    for (const [, entry] of pending) entry.reject(err);
    pending.clear();
    readyPromise = null;
    worker?.terminate();
    worker = null;
  };
  return worker;
}

function post(message, transfer) {
  const id = ++msgId;
  const w = getWorker();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ ...message, id }, transfer || []);
  });
}

/* ------------------------------------------------------------------ *
 * Model cache check (read-only; the worker owns writes)
 * ------------------------------------------------------------------ */

function idbOpen() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("no idb"));
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** True when the model bytes are already on this device (no download needed). */
export async function isModelCached() {
  if (readyPromise) return true;
  try {
    const db = await idbOpen();
    const value = await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    return !!(value && value.byteLength);
  } catch {
    return false;
  }
}

/** Downloads (once) and compiles the CodeFormer session inside the worker. */
export function loadCodeFormer(onProgress) {
  progressHandler = onProgress || null;
  if (readyPromise) return readyPromise;
  readyPromise = post({ type: "load", modelUrl: MODEL_URL }).catch((err) => {
    readyPromise = null;
    throw err;
  });
  return readyPromise;
}

/* ------------------------------------------------------------------ *
 * Canvas helpers
 * ------------------------------------------------------------------ */

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function drawSmooth(ctx, src, sx, sy, sw, sh, dx, dy, dw, dh) {
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh);
}

function rgbaToCanvas(rgba) {
  const canvas = makeCanvas(FACE_SIZE, FACE_SIZE);
  const ctx = canvas.getContext("2d");
  ctx.putImageData(new ImageData(rgba, FACE_SIZE, FACE_SIZE), 0, 0);
  return canvas;
}

/**
 * Lightweight skin-tone face locator. Returns a square crop box (source pixels)
 * around the face, or null when no confident face region is found.
 */
export function findFaceBox(source) {
  const w = source.width;
  const h = source.height;
  if (!w || !h) return null;

  const sw = 160;
  const sh = Math.max(1, Math.round((h / w) * sw));
  const tmp = makeCanvas(sw, sh);
  const ctx = tmp.getContext("2d", { willReadFrequently: true });
  drawSmooth(ctx, source, 0, 0, w, h, 0, 0, sw, sh);
  const { data } = ctx.getImageData(0, 0, sw, sh);

  let minX = sw,
    maxX = 0,
    minY = sh,
    maxY = 0,
    count = 0;

  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const i = (y * sw + x) * 4;
      if (data[i + 3] < 80) continue;
      const r = data[i],
        g = data[i + 1],
        b = data[i + 2];
      const isSkin =
        r > 60 &&
        g > 40 &&
        b > 20 &&
        r > g &&
        r > b &&
        r - g > 10 &&
        Math.max(r, g, b) - Math.min(r, g, b) > 12;
      if (!isSkin) continue;
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (count < sw * sh * 0.01) return null;

  const scaleX = w / sw;
  const scaleY = h / sh;
  const faceW = (maxX - minX + 1) * scaleX;
  const faceH = (maxY - minY + 1) * scaleY;
  if (faceW < 24 || faceH < 24) return null;

  const cx = ((minX + maxX) / 2) * scaleX;
  // Skin pixels skew towards the lower face (neck/chest), so lift the centre.
  const cy = ((minY + maxY) / 2) * scaleY - faceH * 0.08;
  const size = Math.min(Math.max(faceW, faceH) * 1.9, Math.max(w, h));

  return { cx, cy, size };
}

/**
 * Fallback box used when the locator finds nothing: a portrait-style region in
 * the upper-middle of the frame. The restored patch is always blended into a
 * region — the full photo is never replaced by the 512px model output.
 */
function fallbackFaceBox(source) {
  const size = Math.min(source.width, source.height) * 0.8;
  return { cx: source.width / 2, cy: Math.min(source.height / 2, size * 0.62), size };
}

/** Radial feather mask used to blend the restored face back into the photo. */
function makeFeatherMask(size) {
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext("2d");
  const r = size / 2;
  const grad = ctx.createRadialGradient(r, r, r * 0.62, r, r, r * 0.98);
  grad.addColorStop(0, "rgba(0,0,0,1)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

/** High-quality stepwise upscale of the base photo. */
function upscaleCanvas(source, factor) {
  let current = source;
  let curW = source.width;
  let curH = source.height;
  const targetW = Math.round(source.width * factor);
  const targetH = Math.round(source.height * factor);

  while (curW < targetW) {
    const nextW = Math.min(targetW, curW * 2);
    const nextH = Math.round((nextW / curW) * curH);
    const step = makeCanvas(nextW, nextH);
    drawSmooth(step.getContext("2d"), current, 0, 0, curW, curH, 0, 0, nextW, nextH);
    current = step;
    curW = nextW;
    curH = nextH;
  }

  if (curW !== targetW || curH !== targetH) {
    const final = makeCanvas(targetW, targetH);
    drawSmooth(final.getContext("2d"), current, 0, 0, curW, curH, 0, 0, targetW, targetH);
    return final;
  }
  return current;
}

/** Keeps output size sane on phones: caps total pixels of the final image. */
export function safeScale(source, requested) {
  const isMobile =
    typeof navigator !== "undefined" &&
    (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
      (navigator.deviceMemory && navigator.deviceMemory <= 4));
  const budget = isMobile ? 6e6 : 24e6; // ~6MP on mobile, ~24MP on desktop
  const base = source.width * source.height;
  let scale = Math.max(1, Math.min(4, requested || 1));
  while (scale > 1 && base * scale * scale > budget) scale -= 0.5;
  return Math.max(1, scale);
}

/**
 * Restores the face in `source` with CodeFormer and returns a new canvas,
 * optionally upscaled by `scale`. The photo itself is always preserved: only
 * the face region is replaced, feathered into the original pixels.
 */
export async function restorePhoto(source, { scale = 1, fidelityWeight = DEFAULT_FIDELITY_WEIGHT, onStage } = {}) {
  await loadCodeFormer(progressHandler);

  onStage?.("Locating face…");
  const detected = findFaceBox(source);
  const box = detected || fallbackFaceBox(source);

  // Never let the crop cover (almost) the whole frame — that is what caused the
  // photo to be replaced by a soft 512px render.
  const maxSize = Math.min(source.width, source.height) * 0.95;
  box.size = Math.min(box.size, maxSize);

  const faceInput = makeCanvas(FACE_SIZE, FACE_SIZE);
  const faceCtx = faceInput.getContext("2d", { willReadFrequently: true });
  // Keep the crop fully inside the photo so the model never sees empty pixels.
  const half = box.size / 2;
  const cx = Math.min(Math.max(box.cx, half), source.width - half);
  const cy = Math.min(Math.max(box.cy, half), source.height - half);
  box.cx = cx;
  box.cy = cy;
  drawSmooth(faceCtx, source, cx - half, cy - half, box.size, box.size, 0, 0, FACE_SIZE, FACE_SIZE);

  onStage?.("Restoring facial detail…");
  const rgba = faceCtx.getImageData(0, 0, FACE_SIZE, FACE_SIZE).data;
  const { rgba: restoredRgba } = await post(
    { type: "run", rgba, fidelityWeight },
    [rgba.buffer],
  );
  const restored = rgbaToCanvas(restoredRgba);

  onStage?.("Composing final photo…");
  const factorScale = safeScale(source, scale);
  const output =
    factorScale > 1
      ? upscaleCanvas(source, factorScale)
      : (() => {
          const c = makeCanvas(source.width, source.height);
          c.getContext("2d").drawImage(source, 0, 0);
          return c;
        })();

  const ctx = output.getContext("2d");
  const factor = output.width / source.width;

  const destSize = Math.round(box.size * factor);
  const destX = Math.round((box.cx - half) * factor);
  const destY = Math.round((box.cy - half) * factor);

  // Feather the restored face into the photo so there is no visible seam.
  const patch = makeCanvas(destSize, destSize);
  const pctx = patch.getContext("2d");
  drawSmooth(pctx, restored, 0, 0, FACE_SIZE, FACE_SIZE, 0, 0, destSize, destSize);
  pctx.globalCompositeOperation = "destination-in";
  pctx.drawImage(makeFeatherMask(destSize), 0, 0);
  pctx.globalCompositeOperation = "source-over";

  ctx.drawImage(patch, destX, destY);

  return output;
}
