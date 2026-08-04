import { createFileRoute } from "@tanstack/react-router";

const CANDIDATE_URLS = [
  "https://huggingface.co/netrunner-exe/Face-Upscalers-onnx/resolve/main/codeformer.fp16.onnx",
  "https://huggingface.co/OwlMaster/AllFilesRope/resolve/main/codeformer_fp16.onnx",
  "https://huggingface.co/Chroma111/general-models/resolve/main/models/codeformer_fp16.onnx",
  "https://huggingface.co/facefusion/models-3.0.0/resolve/main/codeformer.onnx",
];

export const Route = createFileRoute("/api/public/codeformer-model")({
  server: {
    handlers: {
      GET: async () => {
        for (const url of CANDIDATE_URLS) {
          try {
            const res = await fetch(url, { method: "HEAD" });
            if (res.ok) {
              return Response.redirect(url, 302);
            }
          } catch {
            // Try next candidate
          }
        }
        return Response.redirect(CANDIDATE_URLS[0], 302);
      },
    },
  },
});
