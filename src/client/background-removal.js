// MODNet portrait matting via onnxruntime-web. Model streamed from Hugging Face,
// WebGPU with WASM fallback. No local ONNX file is bundled.
const MODEL_URL = "https://huggingface.co/Xenova/modnet/resolve/main/onnx/model_fp16.onnx";
const REF = 512;
const STRIDE = 32;

let modelPromise = null;
let cachedBytes = null;

// IndexedDB cache — persist model bytes so the AI loads instantly after the first visit.
const IDB_NAME = "makepics-models";
const IDB_STORE = "onnx";
const IDB_KEY = "modnet-fp16-v1";

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

async function downloadModel(onProgress) {
  if (cachedBytes) return cachedBytes;
  const cached = await idbGet();
  if (cached && cached.byteLength) {
    cachedBytes = cached instanceof Uint8Array ? cached : new Uint8Array(cached);
    onProgress &&
      onProgress({ stage: "download", loaded: cachedBytes.length, total: cachedBytes.length });
    return cachedBytes;
  }
  const res = await fetch(MODEL_URL);
  if (!res.ok || !res.body) throw new Error(`Model download failed (${res.status})`);
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress && onProgress({ stage: "download", loaded, total });
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

export function loadModel(onProgress) {
  if (modelPromise) return modelPromise;
  modelPromise = (async () => {
    const ort = await import("onnxruntime-web/webgpu");
    ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/";
    const hc = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 1;
    ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.min(4, hc) : 1;

    const bytes = await downloadModel(onProgress);
    onProgress && onProgress({ stage: "compile" });

    let session,
      backend = "wasm";
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
    onProgress && onProgress({ stage: "ready" });
    return { ort, session, backend };
  })();
  return modelPromise;
}

function sourceSize(source) {
  const w = source.naturalWidth || source.width || 0;
  const h = source.naturalHeight || source.height || 0;
  return { w, h };
}

function inferSize(w, h) {
  let rw = w,
    rh = h;
  if (Math.max(w, h) > REF || Math.min(w, h) < REF) {
    if (w >= h) {
      rw = REF;
      rh = Math.round((h / w) * REF);
    } else {
      rh = REF;
      rw = Math.round((w / h) * REF);
    }
  }
  rw = Math.max(STRIDE, rw - (rw % STRIDE));
  rh = Math.max(STRIDE, rh - (rh % STRIDE));
  return { rw, rh };
}

export async function computeMask(source, onProgress) {
  const { ort, session, backend } = await loadModel(onProgress);
  const { w: natW, h: natH } = sourceSize(source);
  const { rw, rh } = inferSize(natW, natH);

  const input = document.createElement("canvas");
  input.width = rw;
  input.height = rh;
  const ictx = input.getContext("2d", { willReadFrequently: true });
  ictx.imageSmoothingEnabled = true;
  ictx.imageSmoothingQuality = "high";
  ictx.drawImage(source, 0, 0, rw, rh);
  const { data } = ictx.getImageData(0, 0, rw, rh);

  const area = rw * rh;
  const f = new Float32Array(3 * area);
  for (let i = 0; i < area; i++) {
    f[i] = data[i * 4] / 127.5 - 1;
    f[area + i] = data[i * 4 + 1] / 127.5 - 1;
    f[2 * area + i] = data[i * 4 + 2] / 127.5 - 1;
  }
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const tensor = new ort.Tensor("float32", f, [1, 3, rh, rw]);
  const t0 = performance.now();
  const out = await session.run({ [inputName]: tensor });
  const inferenceMs = performance.now() - t0;
  const pred = out[outputName].data;

  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = rw;
  maskCanvas.height = rh;
  const mctx = maskCanvas.getContext("2d");
  const id = mctx.createImageData(rw, rh);
  for (let i = 0; i < area; i++) {
    let a = pred[i];
    a = a < 0 ? 0 : a > 1 ? 1 : a;
    id.data[i * 4] = 255;
    id.data[i * 4 + 1] = 255;
    id.data[i * 4 + 2] = 255;
    id.data[i * 4 + 3] = a * 255;
  }
  mctx.putImageData(id, 0, 0);
  return { maskCanvas, backend, inferenceMs };
}
