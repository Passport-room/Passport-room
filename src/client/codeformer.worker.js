// CodeFormer ONNX inference Web Worker.
// Runs AI face restoration off the main thread using onnxruntime-web.

import ort from "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/ort.min.js";

ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/";
const hc = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 1;
ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.min(4, hc) : 1;

let session = null;

self.onmessage = async (e) => {
  const { id, type } = e.data || {};

  if (type === "load") {
    try {
      const bytes = e.data.bytes;
      if (bytes && bytes.byteLength > 0) {
        // Try WebGPU first, then WASM
        try {
          session = await ort.InferenceSession.create(bytes, {
            executionProviders: ["webgpu"],
            graphOptimizationLevel: "all",
          });
        } catch (gpuErr) {
          console.warn("[codeformer.worker] WebGPU failed, using WASM fallback:", gpuErr?.message);
          session = await ort.InferenceSession.create(bytes, {
            executionProviders: ["wasm"],
            graphOptimizationLevel: "all",
          });
        }
      }
      self.postMessage({ type: "progress", payload: { stage: "ready" } });
      self.postMessage({ type: "loaded", id, success: !!session });
    } catch (err) {
      console.warn("[codeformer.worker] Worker session creation error:", err);
      self.postMessage({ type: "loaded", id, success: false, error: err?.message });
    }
  } else if (type === "run") {
    try {
      if (!session) {
        throw new Error("Worker session not initialized");
      }
      const { float32Input, fidelityWeight = 0.75 } = e.data;
      const xTensor = new ort.Tensor("float32", float32Input, [1, 3, 512, 512]);

      const inputNames = session.inputNames || ["x"];
      const outputNames = session.outputNames || ["y"];

      const feeds = { [inputNames[0]]: xTensor };
      if (inputNames.length > 1) {
        feeds[inputNames[1]] = new ort.Tensor("float32", new Float32Array([fidelityWeight]), [1]);
      }

      let results;
      try {
        results = await session.run(feeds);
      } catch {
        // Retry with single input feed if multi-input rejected
        results = await session.run({ [inputNames[0]]: xTensor });
      }

      const outTensor = results[outputNames[0]];
      const outFloat32 = outTensor.data;

      self.postMessage({ type: "result", id, success: true, float32Output: outFloat32 }, [
        outFloat32.buffer,
      ]);
    } catch (err) {
      console.warn("[codeformer.worker] Worker inference error:", err);
      self.postMessage({ type: "result", id, success: false, error: err?.message });
    }
  }
};
