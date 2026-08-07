// Shared on-device ONNX model store.
//
// Every AI model used by the studio (background removal + face enhance) is
// downloaded once, saved into IndexedDB under a stable, specific name, and
// reused from the device on every later visit — no server round-trip.
//
// Saved names (do not rename; they are the on-device lookup keys):
//   makepics-modnet-portrait-v1   -> MODNet portrait matting (background remove)
//   makepics-gpen-bfr-256-v1      -> GPEN-BFR-256 face restoration (AI enhance)
//   makepics-yoloface-8n-v1       -> YOLO-Face 8n detector + 5 landmarks (face find)

const IDB_NAME = "makepics-models";
const IDB_STORE = "onnx";
const IDB_VERSION = 1;

export const MODEL_KEYS = {
  MODNET: "makepics-modnet-portrait-v1",
  GPEN: "makepics-gpen-bfr-256-v1",
  FACE_DETECT: "makepics-yoloface-8n-v1",
};

// Older builds stored MODNet under this key — reuse it instead of re-downloading.
const LEGACY_KEYS = {
  [MODEL_KEYS.MODNET]: ["modnet-fp16-v1"],
};

const ORT_WASM_PATH = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/";

function idbOpen() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("no idb"));
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  try {
    const db = await idbOpen();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function idbPut(key, bytes) {
  try {
    const db = await idbOpen();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(bytes, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* storage unavailable — model just re-downloads next time */
  }
}

/** True when the model is already saved on this device. */
export async function isModelSaved(key) {
  const hit = await idbGet(key);
  if (hit && hit.byteLength) return true;
  for (const legacy of LEGACY_KEYS[key] || []) {
    const old = await idbGet(legacy);
    if (old && old.byteLength) return true;
  }
  return false;
}

const memoryCache = new Map();

/** Loads model bytes from the device, downloading them once if needed. */
export async function getModelBytes(key, url, onProgress) {
  if (memoryCache.has(key)) return memoryCache.get(key);

  let saved = await idbGet(key);
  let fromLegacy = false;
  if (!saved || !saved.byteLength) {
    for (const legacy of LEGACY_KEYS[key] || []) {
      const old = await idbGet(legacy);
      if (old && old.byteLength) {
        saved = old;
        fromLegacy = true;
        break;
      }
    }
  }

  if (saved && saved.byteLength) {
    const bytes = saved instanceof Uint8Array ? saved : new Uint8Array(saved);
    memoryCache.set(key, bytes);
    if (fromLegacy) idbPut(key, bytes);
    onProgress &&
      onProgress({ stage: "download", loaded: bytes.length, total: bytes.length, cached: true });
    return bytes;
  }

  const res = await fetch(url);
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
    onProgress && onProgress({ stage: "download", loaded, total, cached: false });
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  memoryCache.set(key, bytes);
  idbPut(key, bytes);
  return bytes;
}

/** Creates an onnxruntime-web session, preferring WebGPU and falling back to WASM. */
export async function createSession(bytes) {
  const ort = await import("onnxruntime-web/webgpu");
  ort.env.wasm.wasmPaths = ORT_WASM_PATH;
  const hc = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 1;
  ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.min(4, hc) : 1;

  let session = null;
  let backend = "wasm";
  const hasWebGPU = typeof navigator !== "undefined" && "gpu" in navigator;
  if (hasWebGPU) {
    try {
      session = await ort.InferenceSession.create(bytes, {
        executionProviders: ["webgpu"],
        graphOptimizationLevel: "all",
      });
      backend = "webgpu";
    } catch {
      session = null;
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
}
