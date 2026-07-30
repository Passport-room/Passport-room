// Local ONNX Face Enhancement status endpoint

import { createFileRoute } from "@tanstack/react-router";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export const Route = createFileRoute("/api/public/enhance")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      GET: async () =>
        new Response(
          JSON.stringify({
            status: "active",
            engine: "ONNX Local Browser Inference",
            model: "4xNomos2_hq_mosr_fp32 (17.28 MB)",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json", ...CORS },
          },
        ),
      POST: async () =>
        new Response(
          JSON.stringify({
            message:
              "AI Face Enhancement runs 100% locally in browser using ONNX Runtime.",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json", ...CORS },
          },
        ),
    },
  },
});
