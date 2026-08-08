// MODNet portrait matting via onnxruntime-web. Model streamed from Hugging Face
// once, then saved on-device under "makepics-modnet-portrait-v1".
// WebGPU with WASM fallback. No local ONNX file is bundled.
import { MODEL_KEYS, getModelBytes, createSession } from "./model-cache.js";

const MODEL_URL = "https://huggingface.co/Xenova/modnet/resolve/main/onnx/model_fp16.onnx";
const REF = 512;
const STRIDE = 32;

let modelPromise = null;

export function loadModel(onProgress) {
  if (modelPromise) return modelPromise;
  modelPromise = (async () => {
    const bytes = await getModelBytes(MODEL_KEYS.MODNET, MODEL_URL, onProgress);
    onProgress && onProgress({ stage: "compile" });
    const { ort, session, backend } = await createSession(bytes);
    onProgress && onProgress({ stage: "ready" });
    return { ort, session, backend };
  })().catch((err) => {
    modelPromise = null;
    throw err;
  });
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
