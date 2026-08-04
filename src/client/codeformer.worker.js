// CodeFormer inference worker.
//
// Everything expensive lives here: the model download, the ONNX session, the
// per-pixel tensor conversion and the inference itself. The page only ships
// 512x512 RGBA pixels in and gets 512x512 RGBA pixels back, so the UI thread
// never blocks and the app stays smooth on phones.
//
// Model signature:
//   input  x : float32 [1, 3, 512, 512]  (RGB normalised to [-1, 1])
//   input  w : float32 scalar            (fidelity weight)
//   output y : float32 [1, 3, 512, 512]  (RGB in [-1, 1])

import * as ort from "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/ort.webgpu.bundle.min.mjs";

const FACE_SIZE = 512;
const ORT_DIST = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/";

const IDB_NAME = "makepics-models";
const IDB_STORE = "onnx";
const IDB_KEY = "codeformer-fp16-v1";

let sessionPromise = null;
let session = null;

/* ------------------------------ model cache ------------------------------ */

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
  } catch {
    /* cache is best-effort */
  }
}

function progress(payload) {
  self.postMessage({ type: "progress", payload });
}

async function getModelBytes(modelUrl) {
  const cached = await idbGet();
  if (cached && cached.byteLength) {
    return cached instanceof Uint8Array ? cached : new Uint8Array(cached);
  }

  progress({ stage: "download", loaded: 0, total: 0 });

  const res = await fetch(modelUrl);
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
    progress({ stage: "download", loaded, total });
  }

  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  idbPut(bytes);
  return bytes;
}

/* -------------------------------- session -------------------------------- */

async function hasWebGPU() {
  try {
    if (!navigator.gpu) return false;
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}

function load(modelUrl) {
  if (sessionPromise) return sessionPromise;

  sessionPromise = (async () => {
    ort.env.wasm.wasmPaths = ORT_DIST;
    const hc = navigator.hardwareConcurrency || 1;
    // Threads need SharedArrayBuffer (cross-origin isolation). Without it a
    // single thread is the only valid option.
    const threaded = typeof SharedArrayBuffer !== "undefined" && globalThis.crossOriginIsolated;
    ort.env.wasm.numThreads = threaded ? Math.max(1, Math.min(4, hc - 1)) : 1;
    // We are already off the UI thread, so no extra proxy worker.
    ort.env.wasm.proxy = false;

    const bytes = await getModelBytes(modelUrl);
    progress({ stage: "compile" });

    // WebGPU first (fast, GPU-bound), then WASM. Some graph fusions break on
    // this fp16 export, so step down the optimisation level before giving up.
    const providers = (await hasWebGPU()) ? ["webgpu", "wasm"] : ["wasm"];
    let created = null;
    let lastError = null;
    for (const ep of providers) {
      for (const graphOptimizationLevel of ["extended", "basic", "disabled"]) {
        try {
          created = await ort.InferenceSession.create(bytes, {
            executionProviders: [ep],
            graphOptimizationLevel,
          });
          break;
        } catch (err) {
          lastError = err;
        }
      }
      if (created) break;
    }
    if (!created) throw lastError || new Error("Could not start the AI enhancer.");

    session = created;
    progress({ stage: "ready" });
    return created;
  })().catch((err) => {
    sessionPromise = null;
    throw err;
  });

  return sessionPromise;
}

/* ----------------------------- pre/post pixels ---------------------------- */

function rgbaToTensorData(rgba) {
  const plane = FACE_SIZE * FACE_SIZE;
  const out = new Float32Array(plane * 3);
  for (let p = 0, i = 0; p < plane; p++, i += 4) {
    out[p] = rgba[i] / 127.5 - 1;
    out[plane + p] = rgba[i + 1] / 127.5 - 1;
    out[plane * 2 + p] = rgba[i + 2] / 127.5 - 1;
  }
  return out;
}

function tensorDataToRgba(values) {
  const plane = FACE_SIZE * FACE_SIZE;
  const rgba = new Uint8ClampedArray(plane * 4);
  for (let p = 0, i = 0; p < plane; p++, i += 4) {
    rgba[i] = (values[p] + 1) * 127.5;
    rgba[i + 1] = (values[plane + p] + 1) * 127.5;
    rgba[i + 2] = (values[plane * 2 + p] + 1) * 127.5;
    rgba[i + 3] = 255;
  }
  return rgba;
}

async function run(rgba, fidelityWeight) {
  const active = session || (await sessionPromise);
  if (!active) throw new Error("The AI enhancer is not ready yet.");
  const x = new ort.Tensor("float32", rgbaToTensorData(rgba), [1, 3, FACE_SIZE, FACE_SIZE]);
  const w = new ort.Tensor("float32", new Float32Array([fidelityWeight]), []);
  const out = await active.run({ x, w });
  const y = out.y ?? out[active.outputNames[0]];
  return tensorDataToRgba(y.data);
}

/* -------------------------------- messages ------------------------------- */

self.onmessage = async (event) => {
  const { id, type, modelUrl, rgba, fidelityWeight } = event.data || {};
  try {
    if (type === "load") {
      await load(modelUrl);
      self.postMessage({ type: "loaded", id });
    } else if (type === "run") {
      const result = await run(rgba, fidelityWeight);
      self.postMessage({ type: "result", id, rgba: result }, [result.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: "error", id, message: err?.message || String(err) });
  }
};
