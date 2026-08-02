// AI Enhance — 100% on-device face restoration + upscale.
// Model: GPEN-BFR-256.onnx (streamed from Hugging Face, never bundled in code),
// executed with onnxruntime-web (WebGPU, WASM fallback) exactly like the
// background remover. No Hugging Face Space / server proxy is used anywhere.

import { detectFaceInCanvas } from "./face-detector.js";

const MODEL_URL =
  "https://huggingface.co/OwlMaster/AllFilesRope/resolve/main/GPEN-BFR-256.onnx";
const MODEL_SIZE = 256;

const IDB_NAME = "makepics-models";
const IDB_STORE = "onnx";
const IDB_KEY = "gpen-bfr-256-v1";

let scale = 2;
let busy = false;
let preSnapshot = null;
let modelPromise = null;
let cachedBytes = null;

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function setStatus(msg, kind = "") {
  const el = $("enhanceStatus");
  if (!el) return;
  el.textContent = msg || "";
  el.className = "tryOnStatus " + kind;
}

function updateBtn() {
  const btn = $("enhanceGenerate");
  if (!btn) return;
  const ready = !busy && !!window.__tryOn?.getPersonDataUrl?.();
  btn.disabled = !ready;
  btn.textContent = busy ? "Enhancing…" : "Enhance photo";
}

/* ---------------- model cache + loading ---------------- */

function idbOpen() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("no idb"));
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE))
        req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet() {
  try {
    const db = await idbOpen();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}
async function idbPut(bytes) {
  try {
    const db = await idbOpen();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(bytes, IDB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {}
}

async function downloadModel(onProgress) {
  if (cachedBytes) return cachedBytes;
  const cached = await idbGet();
  if (cached && cached.byteLength) {
    cachedBytes = cached instanceof Uint8Array ? cached : new Uint8Array(cached);
    return cachedBytes;
  }
  const res = await fetch(MODEL_URL);
  if (!res.ok || !res.body) throw new Error(`Model download failed (${res.status})`);
  const total = Number(res.headers.get("content-length")) || 75_715_262;
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress && onProgress(Math.min(99, Math.round((loaded / total) * 100)));
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  cachedBytes = bytes;
  idbPut(bytes);
  return bytes;
}

function loadModel(onProgress) {
  if (modelPromise) return modelPromise;
  modelPromise = (async () => {
    const ort = await import("onnxruntime-web/webgpu");
    ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/";
    const hc = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 1;
    ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.min(4, hc) : 1;

    const bytes = await downloadModel(onProgress);
    let session;
    if (typeof navigator !== "undefined" && "gpu" in navigator) {
      try {
        session = await ort.InferenceSession.create(bytes, {
          executionProviders: ["webgpu"],
          graphOptimizationLevel: "all",
        });
      } catch {
        session = undefined;
      }
    }
    if (!session) {
      session = await ort.InferenceSession.create(bytes, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      });
    }
    return { ort, session };
  })().catch((err) => {
    modelPromise = null;
    throw err;
  });
  return modelPromise;
}

/* ---------------- image helpers ---------------- */

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not read the photo."));
    img.src = src;
  });
}

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

// Uniform, aspect-ratio-safe upscale in ×2 steps (no stretching, no cropping).
function upscaleCanvas(src, factor) {
  let cur = src;
  let remaining = factor;
  while (remaining > 1.001) {
    const step = remaining >= 2 ? 2 : remaining;
    const next = makeCanvas(cur.width * step, cur.height * step);
    const ctx = next.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(cur, 0, 0, next.width, next.height);
    cur = next;
    remaining /= step;
  }
  return cur;
}

// Gentle unsharp mask — adds crispness without halos or artefacts.
function gentleSharpen(canvas, amount = 0.28) {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, w, h);
  const src = img.data;
  const out = new Uint8ClampedArray(src);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      if (src[i + 3] === 0) continue;
      for (let c = 0; c < 3; c++) {
        const p = i + c;
        const blur =
          (src[p - w * 4] + src[p + w * 4] + src[p - 4] + src[p + 4] + src[p] * 4) / 8;
        out[p] = clamp(src[p] + (src[p] - blur) * amount, 0, 255);
      }
    }
  }
  img.data.set(out);
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// Match the restored crop's tone back to the original so skin colour never shifts.
function matchTone(outData, refData) {
  for (let c = 0; c < 3; c++) {
    let sO = 0,
      sR = 0,
      n = 0;
    for (let i = c; i < outData.length; i += 4) {
      sO += outData[i];
      sR += refData[i];
      n++;
    }
    const delta = clamp(sR / n - sO / n, -18, 18);
    for (let i = c; i < outData.length; i += 4) {
      outData[i] = clamp(outData[i] + delta, 0, 255);
    }
  }
}

/* ---------------- face restoration ---------------- */

function faceBox(canvas) {
  const face = detectFaceInCanvas(canvas, null);
  const w = canvas.width;
  const h = canvas.height;
  let cx, cy, size;
  if (face && face.faceHeight > 8) {
    cx = face.faceCenterX;
    cy = (face.headTopY + face.chinY) / 2;
    size = face.faceHeight * 1.75;
  } else {
    // Fallback: the upper-centre region, where a passport subject's face sits.
    cx = w / 2;
    cy = h * 0.33;
    size = Math.min(w, h) * 0.72;
  }
  size = clamp(size, 32, Math.min(w, h));
  let x = clamp(cx - size / 2, 0, Math.max(0, w - size));
  let y = clamp(cy - size / 2, 0, Math.max(0, h - size));
  return { x, y, size };
}

async function restoreFace(baseCanvas, onStage) {
  const { ort, session } = await loadModel((pct) =>
    onStage(`Loading AI model… ${pct}%`)
  );
  onStage("Restoring facial detail & removing dark spots…");

  const box = faceBox(baseCanvas);
  const crop = makeCanvas(MODEL_SIZE, MODEL_SIZE);
  const cctx = crop.getContext("2d", { willReadFrequently: true });
  cctx.imageSmoothingEnabled = true;
  cctx.imageSmoothingQuality = "high";
  cctx.drawImage(
    baseCanvas,
    box.x,
    box.y,
    box.size,
    box.size,
    0,
    0,
    MODEL_SIZE,
    MODEL_SIZE
  );
  const cropData = cctx.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE);
  const px = cropData.data;

  const area = MODEL_SIZE * MODEL_SIZE;
  const f = new Float32Array(3 * area);
  for (let i = 0; i < area; i++) {
    f[i] = px[i * 4] / 127.5 - 1;
    f[area + i] = px[i * 4 + 1] / 127.5 - 1;
    f[2 * area + i] = px[i * 4 + 2] / 127.5 - 1;
  }

  // GPEN-BFR exposes its weights as graph inputs too, so target "input"/"output"
  // explicitly and fall back to the first entries only if the names change.
  const inputName = session.inputNames.includes("input")
    ? "input"
    : session.inputNames[0];
  const outputName = session.outputNames.includes("output")
    ? "output"
    : session.outputNames[0];
  const feeds = {};
  feeds[inputName] = new ort.Tensor("float32", f, [1, 3, MODEL_SIZE, MODEL_SIZE]);
  const out = await session.run(feeds);
  const pred = out[outputName].data;

  const resCanvas = makeCanvas(MODEL_SIZE, MODEL_SIZE);
  const rctx = resCanvas.getContext("2d");
  const resImg = rctx.createImageData(MODEL_SIZE, MODEL_SIZE);
  for (let i = 0; i < area; i++) {
    resImg.data[i * 4] = clamp((pred[i] + 1) * 127.5, 0, 255);
    resImg.data[i * 4 + 1] = clamp((pred[area + i] + 1) * 127.5, 0, 255);
    resImg.data[i * 4 + 2] = clamp((pred[2 * area + i] + 1) * 127.5, 0, 255);
    resImg.data[i * 4 + 3] = 255;
  }
  matchTone(resImg.data, px);
  rctx.putImageData(resImg, 0, 0);

  // Feathered layer so the restored face blends invisibly into the photo.
  const boxPx = Math.round(box.size);
  const layer = makeCanvas(boxPx, boxPx);
  const lctx = layer.getContext("2d");
  lctx.imageSmoothingEnabled = true;
  lctx.imageSmoothingQuality = "high";
  lctx.drawImage(resCanvas, 0, 0, boxPx, boxPx);

  const grad = lctx.createRadialGradient(
    boxPx / 2,
    boxPx / 2,
    boxPx * 0.24,
    boxPx / 2,
    boxPx / 2,
    boxPx * 0.5
  );
  grad.addColorStop(0, "rgba(0,0,0,1)");
  grad.addColorStop(0.72, "rgba(0,0,0,0.92)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  lctx.globalCompositeOperation = "destination-in";
  lctx.fillStyle = grad;
  lctx.fillRect(0, 0, boxPx, boxPx);

  // Keep the original cut-out silhouette: never paint outside existing pixels.
  lctx.globalCompositeOperation = "destination-in";
  lctx.drawImage(baseCanvas, box.x, box.y, box.size, box.size, 0, 0, boxPx, boxPx);
  lctx.globalCompositeOperation = "source-over";

  const bctx = baseCanvas.getContext("2d");
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = "high";
  bctx.globalAlpha = 0.92;
  bctx.drawImage(layer, box.x, box.y, box.size, box.size);
  bctx.globalAlpha = 1;
  return baseCanvas;
}

/* ---------------- main flow ---------------- */

async function enhance() {
  if (busy) return;
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
  updateBtn();
  setStatus("Preparing your photo…");

  try {
    preSnapshot = personDataUrl;
    const img = await loadImage(personDataUrl);
    const src = makeCanvas(img.naturalWidth || img.width, img.naturalHeight || img.height);
    src.getContext("2d").drawImage(img, 0, 0);

    setStatus(`Upscaling to ${scale}× resolution…`);
    const base = upscaleCanvas(src, scale);

    await restoreFace(base, setStatus);

    setStatus("Sharpening final details…");
    gentleSharpen(base, scale >= 4 ? 0.22 : 0.3);

    const dataUrl = base.toDataURL("image/png");
    await window.__tryOn.applyResult(dataUrl, (m) => setStatus(m));
    $("enhanceRevert").classList.remove("hidden");
    const rt = $("enhanceRetry");
    if (rt) rt.classList.remove("hidden");
    setStatus("Enhanced on your device. Tap Retry to run again, or continue editing.", "ok");
  } catch (e) {
    console.error(e);
    setStatus(e?.message || "Enhance failed. Please try again.", "err");
  } finally {
    busy = false;
    updateBtn();
  }
}

async function revert() {
  if (!preSnapshot || busy) return;
  busy = true;
  updateBtn();
  setStatus("Restoring original…");
  try {
    await window.__tryOn.applyResult(preSnapshot, (m) => setStatus(m));
    $("enhanceRevert").classList.add("hidden");
    const rt = $("enhanceRetry");
    if (rt) rt.classList.add("hidden");
    preSnapshot = null;
    setStatus("Reverted to original.", "ok");
  } catch (e) {
    setStatus(e?.message || "Could not revert.", "err");
  } finally {
    busy = false;
    updateBtn();
  }
}

function bind() {
  document.querySelectorAll(".enhanceScaleBtn").forEach((b) => {
    b.addEventListener("click", () => {
      const raw = String(b.dataset.scale || "2x").replace("x", "");
      scale = Math.min(4, Math.max(1, parseInt(raw, 10) || 2));
      document
        .querySelectorAll(".enhanceScaleBtn")
        .forEach((x) => x.classList.toggle("active", x === b));
    });
  });
  const gen = $("enhanceGenerate");
  const rev = $("enhanceRevert");
  if (gen) gen.onclick = enhance;
  if (rev) rev.onclick = revert;
  const rt = $("enhanceRetry");
  if (rt) rt.onclick = () => enhance();
  const obs = new MutationObserver(updateBtn);
  const resultView = document.getElementById("resultView");
  if (resultView) obs.observe(resultView, { attributes: true, attributeFilter: ["class"] });
  updateBtn();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
else bind();
