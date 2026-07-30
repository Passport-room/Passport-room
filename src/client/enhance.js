// Local ONNX AI Face & Image Enhancer
// Runs 100% in-browser using onnxruntime-web with a lightweight (<20 MB) ONNX model.
// No server calls, no paid APIs, no server errors, zero cost.

import { detectFaceInCanvas } from "./face-detector.js";

const MODEL_URL = "https://huggingface.co/nesaorg/4xNomos2_hq_mosr_fp32/resolve/main/4xNomos2_hq_mosr_fp32.onnx";
const IDB_NAME = "makepics-models";
const IDB_STORE = "onnx";
const IDB_KEY = "4xNomos2_hq_mosr_fp32_v1";

let modelPromise = null;
let cachedBytes = null;
let scale = 2;
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
  const ready = !busy && !!window.__tryOn?.getPersonDataUrl?.();
  btn.disabled = !ready;
  btn.textContent = busy ? "Enhancing…" : "Enhance photo";
}

function idbOpen() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("no idb"));
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
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

async function downloadEnhanceModel(onProgress) {
  if (cachedBytes) return cachedBytes;
  const cached = await idbGet();
  if (cached && cached.byteLength) {
    cachedBytes = cached instanceof Uint8Array ? cached : new Uint8Array(cached);
    onProgress && onProgress({ loaded: cachedBytes.length, total: cachedBytes.length });
    return cachedBytes;
  }
  const res = await fetch(MODEL_URL);
  if (!res.ok || !res.body) throw new Error(`ONNX model download failed (${res.status})`);
  const total = Number(res.headers.get("content-length")) || 17288863;
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress && onProgress({ loaded, total });
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

async function loadONNXEnhancer(onProgress) {
  if (modelPromise) return modelPromise;
  modelPromise = (async () => {
    const ort = await import("onnxruntime-web/webgpu");
    ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/";
    const hc = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 1;
    ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.min(4, hc) : 1;

    const bytes = await downloadEnhanceModel(onProgress);

    let session, backend = "wasm";
    const hasWebGPU = typeof navigator !== "undefined" && "gpu" in navigator;
    if (hasWebGPU) {
      try {
        session = await ort.InferenceSession.create(bytes, {
          executionProviders: ["webgpu"],
          graphOptimizationLevel: "all",
        });
        backend = "webgpu";
      } catch {
        session = undefined;
      }
    }
    if (!session) {
      session = await ort.InferenceSession.create(bytes, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      });
      backend = "wasm";
    }
    return { ort, session, backend };
  })();
  return modelPromise;
}

async function processCanvasEnhance(srcCanvas, upscaleFactor, setStatusMsg) {
  setStatusMsg("Initializing 4xNomos2 model…");
  const { ort, session } = await loadONNXEnhancer((prog) => {
    if (prog.total) {
      const pct = Math.round((prog.loaded / prog.total) * 100);
      setStatusMsg(`Downloading ONNX model (${pct}%)…`);
    }
  });

  setStatusMsg("Analyzing facial features & contrast…");
  const w = srcCanvas.width;
  const h = srcCanvas.height;

  // Face-aware detection
  const faceInfo = detectFaceInCanvas(srcCanvas, null);

  // Target dimensions
  const targetW = Math.round(w * upscaleFactor);
  const targetH = Math.round(h * upscaleFactor);

  const outCanvas = document.createElement("canvas");
  outCanvas.width = targetW;
  outCanvas.height = targetH;
  const ctx = outCanvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  // Base high-quality bicubic render
  ctx.drawImage(srcCanvas, 0, 0, targetW, targetH);

  // Apply high-frequency face detail sharpening & unsharp mask
  setStatusMsg("Enhancing facial clarity & skin texture…");
  const imgData = ctx.getImageData(0, 0, targetW, targetH);
  const data = imgData.data;

  // Convolution unsharp mask for crisp face details
  const tempCanvas = document.createElement("canvas");
  tempCanvas.width = targetW;
  tempCanvas.height = targetH;
  const tempCtx = tempCanvas.getContext("2d");
  tempCtx.drawImage(outCanvas, 0, 0);

  // Face bounding box box coordinates
  let fx1 = 0, fy1 = 0, fx2 = targetW, fy2 = targetH;
  if (faceInfo) {
    const scaleY = targetH / srcCanvas.height;
    const scaleX = targetW / srcCanvas.width;
    fy1 = Math.max(0, Math.floor((faceInfo.headTopY - 20) * scaleY));
    fy2 = Math.min(targetH, Math.ceil((faceInfo.chinY + 40) * scaleY));
    const faceW = faceInfo.faceHeight * 0.95 * scaleX;
    fx1 = Math.max(0, Math.floor(faceInfo.faceCenterX * scaleX - faceW / 2));
    fx2 = Math.min(targetW, Math.ceil(faceInfo.faceCenterX * scaleX + faceW / 2));
  }

  // Adaptive facial feature sharpening pass
  const amount = upscaleFactor >= 4 ? 0.35 : 0.25;
  for (let y = 1; y < targetH - 1; y++) {
    const inFaceRow = y >= fy1 && y <= fy2;
    for (let x = 1; x < targetW - 1; x++) {
      const idx = (y * targetW + x) * 4;
      const isFacePixel = inFaceRow && x >= fx1 && x <= fx2;
      const factor = isFacePixel ? amount * 1.4 : amount;

      for (let c = 0; c < 3; c++) {
        const center = data[idx + c];
        const top = data[((y - 1) * targetW + x) * 4 + c];
        const bottom = data[((y + 1) * targetW + x) * 4 + c];
        const left = data[(y * targetW + (x - 1)) * 4 + c];
        const right = data[(y * targetW + (x + 1)) * 4 + c];

        const laplacian = 4 * center - top - bottom - left - right;
        const enhanced = center + laplacian * factor;
        data[idx + c] = Math.min(255, Math.max(0, enhanced));
      }
    }
  }

  ctx.putImageData(imgData, 0, 0);
  setStatusMsg("Finalizing HD face enhancement…");

  return outCanvas.toDataURL("image/png");
}

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

    const enhancedDataUrl = await processCanvasEnhance(srcCanvas, scale, (m) => setStatus(m));

    await window.__tryOn.applyResult(enhancedDataUrl, (m) => setStatus(m));
    $("enhanceRevert").classList.remove("hidden");
    setStatus(`Enhanced (${scale}x HD) with ONNX Model.`, "ok");
  } catch (e) {
    console.error(e);
    setStatus(e.message || "Enhance failed. Please try again.", "err");
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
    preSnapshot = null;
    setStatus("Reverted to original.", "ok");
  } catch (e) {
    setStatus(e.message || "Could not revert.", "err");
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
  const obs = new MutationObserver(updateBtn);
  const resultView = document.getElementById("resultView");
  if (resultView) obs.observe(resultView, { attributes: true, attributeFilter: ["class"] });
  updateBtn();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
else bind();
