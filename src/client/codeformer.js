// Professional AI Face Photo Restoration & Enhancement Engine
// Powered by CodeFormer ONNX neural model + face-detector + studio finishing pipeline.
// Downloads model once with streaming progress UI, caches in IndexedDB,
// crops & restores face at 512x512 with 0.75-0.8 fidelity weight (preserving exact identity/eyebrow shape),
// feather-blends back into 4x upscaled photo, removes dark spots & blur spots, and sharpens detail.

import { detectFaceInCanvas } from "./face-detector.js";

export const DEFAULT_FIDELITY_WEIGHT = 0.75;

const MODEL_URLS = [
  "/api/public/codeformer-model?variant=fp16",
  "https://huggingface.co/netrunner-exe/Face-Upscalers-onnx/resolve/main/codeformer.fp16.onnx",
  "https://huggingface.co/OwlMaster/AllFilesRope/resolve/main/codeformer_fp16.onnx",
  "https://huggingface.co/Chroma111/general-models/resolve/main/models/codeformer_fp16.onnx",
  "https://huggingface.co/facefusion/models-3.0.0/resolve/main/codeformer.onnx",
];

const IDB_NAME = "makepics-models";
const IDB_STORE = "onnx";
const IDB_KEY = "codeformer-fp16-v2";

let modelPromise = null;
let cachedBytes = null;
let mainSession = null;
let mainOrt = null;
let workerInstance = null;
let workerReady = false;
let msgIdCounter = 0;

function idbOpen() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("no idb"));
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key = IDB_KEY) {
  try {
    const db = await idbOpen();
    return await new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function idbPut(bytes, key = IDB_KEY) {
  try {
    const db = await idbOpen();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(bytes, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {}
}

export async function isModelCached() {
  if (cachedBytes && cachedBytes.byteLength > 0) return true;
  const c = await idbGet(IDB_KEY);
  if (c && c.byteLength > 0) return true;
  for (const k of [
    "codeformer-onnx-v3",
    "codeformer-onnx-v2",
    "codeformer-fp16-v1",
    "codeformer-fp32-v1",
  ]) {
    const prev = await idbGet(k);
    if (prev && prev.byteLength > 0) return true;
  }
  return false;
}

async function downloadModel(onProgress) {
  if (cachedBytes && cachedBytes.byteLength > 0) {
    if (onProgress)
      onProgress({ stage: "download", loaded: cachedBytes.length, total: cachedBytes.length });
    return cachedBytes;
  }

  for (const k of [
    IDB_KEY,
    "codeformer-onnx-v3",
    "codeformer-onnx-v2",
    "codeformer-fp16-v1",
    "codeformer-fp32-v1",
  ]) {
    const cached = await idbGet(k);
    if (cached && cached.byteLength > 0) {
      cachedBytes = cached instanceof Uint8Array ? cached : new Uint8Array(cached);
      if (onProgress)
        onProgress({ stage: "download", loaded: cachedBytes.length, total: cachedBytes.length });
      return cachedBytes;
    }
  }

  let lastErr = null;
  for (const url of MODEL_URLS) {
    try {
      if (onProgress) onProgress({ stage: "download", loaded: 0, total: 100 });
      const res = await fetch(url);
      if (!res.ok || !res.body) continue;

      const total = Number(res.headers.get("content-length")) || 188576500;
      const reader = res.body.getReader();
      const chunks = [];
      let loaded = 0;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        if (onProgress) onProgress({ stage: "download", loaded, total: Math.max(total, loaded) });
      }

      const bytes = new Uint8Array(loaded);
      let offset = 0;
      for (const c of chunks) {
        bytes.set(c, offset);
        offset += c.length;
      }

      cachedBytes = bytes;
      await idbPut(bytes, IDB_KEY);
      return bytes;
    } catch (err) {
      console.warn(`[codeformer] Download failed from ${url}:`, err);
      lastErr = err;
    }
  }

  return new Uint8Array(0);
}

export async function loadCodeFormer(onProgress) {
  if (modelPromise) return modelPromise;

  modelPromise = (async () => {
    try {
      const bytes = await downloadModel(onProgress);
      if (!bytes || bytes.byteLength === 0) {
        console.warn("[codeformer] Model download unavailable, falling back to canvas pipeline");
        if (onProgress) onProgress({ stage: "ready" });
        return { session: null, worker: null };
      }

      if (onProgress) onProgress({ stage: "compile" });

      // Try initializing Web Worker first
      try {
        if (typeof Worker !== "undefined") {
          workerInstance = new Worker("/assets/codeformer.worker.js", { type: "module" });
          const initId = ++msgIdCounter;
          const workerSuccess = await new Promise((resolve) => {
            const timeout = setTimeout(() => resolve(false), 8000);
            const handler = (e) => {
              if (e.data?.type === "loaded" && e.data.id === initId) {
                clearTimeout(timeout);
                workerInstance.removeEventListener("message", handler);
                resolve(!!e.data.success);
              } else if (e.data?.type === "progress" && e.data.payload) {
                if (onProgress) onProgress(e.data.payload);
              }
            };
            workerInstance.addEventListener("message", handler);
            workerInstance.postMessage({ type: "load", id: initId, bytes }, [bytes.buffer]);
          });

          if (workerSuccess) {
            workerReady = true;
            if (onProgress) onProgress({ stage: "ready" });
            return { session: null, worker: workerInstance };
          }
        }
      } catch (wErr) {
        console.warn("[codeformer] Worker init failed, using main thread fallback:", wErr);
      }

      // Main thread ONNX session fallback
      try {
        let ort;
        try {
          ort = await import("onnxruntime-web/webgpu");
        } catch {
          ort =
            await import("https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/ort.webgpu.bundle.min.mjs");
        }
        mainOrt = ort;
        ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/";
        const hc = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 1;
        ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.min(4, hc) : 1;

        const hasWebGPU = typeof navigator !== "undefined" && "gpu" in navigator;
        if (hasWebGPU) {
          try {
            mainSession = await ort.InferenceSession.create(bytes, {
              executionProviders: ["webgpu"],
              graphOptimizationLevel: "all",
            });
          } catch (e) {
            console.warn("[codeformer] WebGPU main session failed, trying WASM:", e?.message);
          }
        }
        if (!mainSession) {
          mainSession = await ort.InferenceSession.create(bytes, {
            executionProviders: ["wasm"],
            graphOptimizationLevel: "all",
          });
        }
      } catch (mErr) {
        console.warn("[codeformer] Main thread session create failed:", mErr);
      }

      if (onProgress) onProgress({ stage: "ready" });
      return { session: mainSession, worker: null };
    } catch (err) {
      console.warn("[codeformer] Model initialization warning:", err);
      if (onProgress) onProgress({ stage: "ready" });
      return { session: null, worker: null };
    }
  })();

  return modelPromise;
}

// Run AI model on 512x512 face crop canvas
async function runFaceModelInference(cropCanvas, fidelityWeight = DEFAULT_FIDELITY_WEIGHT) {
  const ctx = cropCanvas.getContext("2d", { willReadFrequently: true });
  const imgData = ctx.getImageData(0, 0, 512, 512);
  const pixels = imgData.data;

  // Prepare float32 NCHW tensor data [1, 3, 512, 512]
  const area = 512 * 512;
  const float32Input = new Float32Array(3 * area);
  for (let i = 0; i < area; i++) {
    float32Input[i] = pixels[i * 4] / 127.5 - 1.0;
    float32Input[area + i] = pixels[i * 4 + 1] / 127.5 - 1.0;
    float32Input[2 * area + i] = pixels[i * 4 + 2] / 127.5 - 1.0;
  }

  let outFloat32 = null;

  // 1. Try worker if ready
  if (workerReady && workerInstance) {
    try {
      const runId = ++msgIdCounter;
      outFloat32 = await new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(null), 15000);
        const handler = (e) => {
          if (e.data?.type === "result" && e.data.id === runId) {
            clearTimeout(timeout);
            workerInstance.removeEventListener("message", handler);
            resolve(e.data.success ? e.data.float32Output : null);
          }
        };
        workerInstance.addEventListener("message", handler);
        workerInstance.postMessage({ type: "run", id: runId, float32Input, fidelityWeight }, [
          float32Input.buffer,
        ]);
      });
    } catch (wErr) {
      console.warn("[codeformer] Worker run error, falling back to main session:", wErr);
    }
  }

  // 2. Main thread session fallback
  if (!outFloat32 && mainSession && mainOrt) {
    try {
      const xTensor = new mainOrt.Tensor("float32", float32Input, [1, 3, 512, 512]);
      const inputNames = mainSession.inputNames || ["x"];
      const outputNames = mainSession.outputNames || ["y"];

      const feeds = { [inputNames[0]]: xTensor };
      if (inputNames.length > 1) {
        feeds[inputNames[1]] = new mainOrt.Tensor(
          "float32",
          new Float32Array([fidelityWeight]),
          [1],
        );
      }

      let results;
      try {
        results = await mainSession.run(feeds);
      } catch {
        results = await mainSession.run({ [inputNames[0]]: xTensor });
      }

      const outTensor = results[outputNames[0]];
      outFloat32 = outTensor ? outTensor.data : null;
    } catch (mErr) {
      console.warn("[codeformer] Main session inference error:", mErr);
    }
  }

  if (!outFloat32) {
    return null;
  }

  // Determine output normalization range
  let isNegRange = false;
  let isOneRange = false;
  for (let k = 0; k < Math.min(200, outFloat32.length); k++) {
    if (outFloat32[k] < -0.05) {
      isNegRange = true;
      break;
    }
    if (outFloat32[k] > 1.2) {
      isOneRange = false;
    } else if (outFloat32[k] <= 1.2 && outFloat32[k] >= 0) {
      isOneRange = true;
    }
  }

  const restoredCanvas = document.createElement("canvas");
  restoredCanvas.width = 512;
  restoredCanvas.height = 512;
  const rctx = restoredCanvas.getContext("2d");
  const outImgData = rctx.createImageData(512, 512);
  const outPx = outImgData.data;

  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

  for (let i = 0; i < area; i++) {
    let r = outFloat32[i];
    let g = outFloat32[area + i];
    let b = outFloat32[2 * area + i];

    if (isNegRange) {
      r = (r + 1.0) * 127.5;
      g = (g + 1.0) * 127.5;
      b = (b + 1.0) * 127.5;
    } else if (isOneRange) {
      r = r * 255.0;
      g = g * 255.0;
      b = b * 255.0;
    }

    const idx = i * 4;
    outPx[idx] = clamp(r);
    outPx[idx + 1] = clamp(g);
    outPx[idx + 2] = clamp(b);
    outPx[idx + 3] = 255;
  }

  rctx.putImageData(outImgData, 0, 0);
  return restoredCanvas;
}

/**
 * Professional AI Face Photo Restoration & Enhancement Engine
 * Always upscales in 4x HD, runs CodeFormer ONNX neural face restoration on cropped face box,
 * feather-blends restored face back into full photo, removes blemishes/dark spots, and sharpens detail.
 */
export async function restorePhoto(sourceCanvas, options = {}) {
  const scale = 4; // Always 4x
  const fidelityWeight = options.fidelityWeight || DEFAULT_FIDELITY_WEIGHT;
  const onStage = options.onStage;

  if (onStage) onStage("Analyzing facial features…");
  await new Promise((r) => setTimeout(r, 30));

  await loadCodeFormer();

  const srcW = sourceCanvas.width;
  const srcH = sourceCanvas.height;
  const outW = Math.round(srcW * scale);
  const outH = Math.round(srcH * scale);

  // 1. Detect facial structure for targeted ONNX neural crop
  const faceInfo = detectFaceInCanvas(sourceCanvas);

  let restoredFaceCanvas = null;
  let cropX = 0;
  let cropY = 0;
  let actualW = srcW;
  let actualH = srcH;

  if (faceInfo && faceInfo.faceHeight > 0) {
    if (onStage) onStage("Running AI face restoration model…");

    const cx = faceInfo.faceCenterX;
    const cy = faceInfo.headTopY + faceInfo.faceHeight * 0.52;
    const size = Math.max(faceInfo.faceWidth || faceInfo.faceHeight, faceInfo.faceHeight);
    const cropSize = Math.max(64, Math.round(size * 1.8)); // 40% padding around face

    cropX = Math.max(0, Math.round(cx - cropSize / 2));
    cropY = Math.max(0, Math.round(cy - cropSize / 2));
    if (cropX + cropSize > srcW) cropX = Math.max(0, srcW - cropSize);
    if (cropY + cropSize > srcH) cropY = Math.max(0, srcH - cropSize);

    actualW = Math.min(cropSize, srcW - cropX);
    actualH = Math.min(cropSize, srcH - cropY);

    // Create 512x512 face crop canvas
    const cropCanvas = document.createElement("canvas");
    cropCanvas.width = 512;
    cropCanvas.height = 512;
    const cctx = cropCanvas.getContext("2d", { willReadFrequently: true });
    cctx.imageSmoothingEnabled = true;
    cctx.imageSmoothingQuality = "high";
    cctx.drawImage(sourceCanvas, cropX, cropY, actualW, actualH, 0, 0, 512, 512);

    // Run CodeFormer AI neural inference on face crop
    restoredFaceCanvas = await runFaceModelInference(cropCanvas, fidelityWeight);
  }

  if (onStage) onStage("Upscaling photo to 4x HD…");

  // Create high-resolution output canvas
  const outCanvas = document.createElement("canvas");
  outCanvas.width = outW;
  outCanvas.height = outH;
  const ctx = outCanvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(sourceCanvas, 0, 0, outW, outH);

  // 2. Feather-blend restored 512x512 face back into 4x upscaled photo
  if (restoredFaceCanvas) {
    if (onStage) onStage("Blending AI restored face into photo…");

    const dstX = cropX * scale;
    const dstY = cropY * scale;
    const dstW = actualW * scale;
    const dstH = actualH * scale;

    const blendCanvas = document.createElement("canvas");
    blendCanvas.width = dstW;
    blendCanvas.height = dstH;
    const bctx = blendCanvas.getContext("2d", { willReadFrequently: true });
    bctx.imageSmoothingEnabled = true;
    bctx.imageSmoothingQuality = "high";
    bctx.drawImage(restoredFaceCanvas, 0, 0, 512, 512, 0, 0, dstW, dstH);

    // Apply radial feather mask to alpha channel
    const blendImgData = bctx.getImageData(0, 0, dstW, dstH);
    const blendPx = blendImgData.data;

    for (let r = 0; r < dstH; r++) {
      const ny = (r - dstH / 2) / (dstH / 2);
      for (let c = 0; c < dstW; c++) {
        const nx = (c - dstW / 2) / (dstW / 2);
        const dist = Math.sqrt(nx * nx + ny * ny);

        let alphaFactor = 1.0;
        if (dist > 0.68) {
          alphaFactor = dist >= 0.98 ? 0.0 : 1.0 - (dist - 0.68) / 0.3;
        }

        const idx = (r * dstW + c) * 4 + 3;
        blendPx[idx] = Math.round(blendPx[idx] * alphaFactor);
      }
    }

    bctx.putImageData(blendImgData, 0, 0);
    ctx.drawImage(blendCanvas, dstX, dstY);
  }

  if (onStage) onStage("Removing dark spots & skin blemishes…");

  const imgData = ctx.getImageData(0, 0, outW, outH);
  const pixels = imgData.data;

  // Create smooth guide layer for skin blemish/dark spot removal
  const skinBlurCanvas = document.createElement("canvas");
  skinBlurCanvas.width = outW;
  skinBlurCanvas.height = outH;
  const sbctx = skinBlurCanvas.getContext("2d", { willReadFrequently: true });
  sbctx.imageSmoothingEnabled = true;
  sbctx.imageSmoothingQuality = "high";
  sbctx.drawImage(outCanvas, 0, 0);
  sbctx.filter = "blur(2.2px)";
  sbctx.drawImage(skinBlurCanvas, 0, 0);
  sbctx.filter = "none";
  const skinBlurPixels = sbctx.getImageData(0, 0, outW, outH).data;

  // Create fine guide layer for micro de-blurring & sharpening
  const fineBlurCanvas = document.createElement("canvas");
  fineBlurCanvas.width = outW;
  fineBlurCanvas.height = outH;
  const fbctx = fineBlurCanvas.getContext("2d", { willReadFrequently: true });
  fbctx.imageSmoothingEnabled = true;
  fbctx.imageSmoothingQuality = "high";
  fbctx.drawImage(outCanvas, 0, 0);
  fbctx.filter = "blur(1.0px)";
  fbctx.drawImage(fineBlurCanvas, 0, 0);
  fbctx.filter = "none";
  const fineBlurPixels = fbctx.getImageData(0, 0, outW, outH).data;

  // Map face coordinates
  let isFacePresent = false;
  let faceCenterX = outW / 2;
  let faceCenterY = outH / 2;
  let faceRadX = outW / 2;
  let faceRadY = outH / 2;

  if (faceInfo && faceInfo.faceHeight > 0) {
    isFacePresent = true;
    const sy = outH / faceInfo.fullH;
    const sx = outW / faceInfo.fullW;
    faceCenterX = faceInfo.faceCenterX * sx;
    faceCenterY = (faceInfo.headTopY + faceInfo.faceHeight * 0.52) * sy;
    faceRadX = Math.max(20, faceInfo.faceHeight * 0.72 * sx);
    faceRadY = Math.max(20, faceInfo.faceHeight * 0.78 * sy);
  }

  if (onStage) onStage("Removing blur & sharpening photo details…");

  const clampVal = (val) => (val < 0 ? 0 : val > 255 ? 255 : val);
  const clampDiff = (diff, maxShift) => Math.max(-maxShift, Math.min(maxShift, diff));

  // Process in async row-chunks so UI never freezes and Chrome never crashes
  const CHUNK_ROWS = 56;
  for (let y = 0; y < outH; y += CHUNK_ROWS) {
    const yEnd = Math.min(outH, y + CHUNK_ROWS);

    for (let r = y; r < yEnd; r++) {
      const rowOffset = r * outW * 4;

      for (let c = 0; c < outW; c++) {
        const i = rowOffset + c * 4;

        let red = pixels[i];
        let green = pixels[i + 1];
        let blue = pixels[i + 2];

        const sbRed = skinBlurPixels[i];
        const sbGreen = skinBlurPixels[i + 1];
        const sbBlue = skinBlurPixels[i + 2];

        const fbRed = fineBlurPixels[i];
        const fbGreen = fineBlurPixels[i + 1];
        const fbBlue = fineBlurPixels[i + 2];

        const lum = 0.299 * red + 0.587 * green + 0.114 * blue;

        const isSkin =
          red > 45 &&
          green > 28 &&
          blue > 18 &&
          Math.max(red, green, blue) - Math.min(red, green, blue) > 10 &&
          Math.abs(red - green) > 5 &&
          red > green &&
          red > blue;

        const isHairOrEyebrow = lum < 60 || (!isSkin && lum < 85);

        let faceWeight = 0;
        if (isFacePresent) {
          const dx = (c - faceCenterX) / faceRadX;
          const dy = (r - faceCenterY) / faceRadY;
          const dist2 = dx * dx + dy * dy;
          if (dist2 <= 1.0) {
            faceWeight = 1.0 - Math.sqrt(dist2);
          }
        } else {
          faceWeight = 0.5;
        }

        // --- 1. Skin Blemish & Dark Spot Removal ---
        if (isSkin && !isHairOrEyebrow && faceWeight > 0.05) {
          const colorDiff =
            Math.abs(red - sbRed) + Math.abs(green - sbGreen) + Math.abs(blue - sbBlue);

          if (colorDiff < 55) {
            const smoothAmount = 0.48 * faceWeight;
            red = red * (1 - smoothAmount) + sbRed * smoothAmount;
            green = green * (1 - smoothAmount) + sbGreen * smoothAmount;
            blue = blue * (1 - smoothAmount) + sbBlue * smoothAmount;
          }

          if (lum > 65 && lum < 125) {
            const shadowLift = (125 - lum) * 0.22 * faceWeight;
            red += shadowLift;
            green += shadowLift * 0.95;
            blue += shadowLift * 0.9;
          }
        }

        // --- 2. Micro De-Blurring & Feature Sharpening ---
        const hpR = clampDiff(red - fbRed, 18);
        const hpG = clampDiff(green - fbGreen, 18);
        const hpB = clampDiff(blue - fbBlue, 18);

        const sharpStrength = isHairOrEyebrow ? 0.42 : isSkin ? 0.32 : 0.6;
        red += hpR * sharpStrength;
        green += hpG * sharpStrength;
        blue += hpB * sharpStrength;

        // --- 3. Subtle HD Contrast Finish ---
        red = (red - 128) * 1.03 + 128;
        green = (green - 128) * 1.03 + 128;
        blue = (blue - 128) * 1.03 + 128;

        pixels[i] = clampVal(red);
        pixels[i + 1] = clampVal(green);
        pixels[i + 2] = clampVal(blue);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  ctx.putImageData(imgData, 0, 0);

  if (onStage) onStage("Finalizing 4x photo enhancement…");
  await new Promise((r) => setTimeout(r, 20));

  return outCanvas;
}
