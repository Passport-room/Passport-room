// Image enhance endpoint — runs GFPGAN-class face restoration locally on
// this server using GPEN-BFR-256 (ONNX Runtime, CPU inference). No external
// AI service calls. The model weights are NOT bundled in the repo; they are
// downloaded on demand into a runtime cache directory on first use (see
// src/server/model-cache.ts) and reused afterwards.
//
// Restoration is always run at the model's full generative strength — GPEN
// has no "fidelity" blend knob, so there is no shortcut to opt out of.
//
// Request/response contract is unchanged from the previous implementation:
//   POST multipart/form-data { image: File, upscale?: number(1-4) }
//   -> 200 image/png body, or JSON { error } on failure.

import { createFileRoute } from "@tanstack/react-router";
import { enhanceFaceLocal } from "../../../server/gpen";

const MAX_BYTES = 12 * 1024 * 1024;
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);
const PROCESS_TIMEOUT_MS = 60_000;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { "Content-Type": "application/json", ...CORS },
  });

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export const Route = createFileRoute("/api/public/enhance")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      POST: async ({ request }) => {
        let form: FormData;
        try {
          form = await request.formData();
        } catch {
          return json({ error: "Expected multipart/form-data" }, 400);
        }
        const image = form.get("image");
        const upscale = Math.min(4, Math.max(1, Number(form.get("upscale") ?? 2) || 2));
        if (!(image instanceof File)) return json({ error: "image file required" }, 400);
        if (image.size === 0) return json({ error: "image is empty" }, 400);
        if (image.size > MAX_BYTES) return json({ error: "image exceeds 12 MB" }, 413);
        if (image.type && !ALLOWED.has(image.type))
          return json({ error: `unsupported type ${image.type}` }, 415);

        try {
          const inputBuffer = Buffer.from(await image.arrayBuffer());
          const { buffer, faceFound } = await withTimeout(
            enhanceFaceLocal(inputBuffer, upscale),
            PROCESS_TIMEOUT_MS,
            "Local face enhancer",
          );

          return new Response(buffer, {
            status: 200,
            headers: {
              "Content-Type": "image/png",
              "Cache-Control": "no-store",
              // Debug-only header; harmless if the client ignores it. Lets
              // you confirm from the network tab whether a face was found
              // and actually restored, vs. the original being passed through.
              "X-Enhance-Face-Found": String(faceFound),
              ...CORS,
            },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error("[enhance] local GPEN restoration failed:", msg);
          return json(
            {
              error: "The AI enhancer could not process this photo. Please try again.",
              details: [msg],
            },
            502,
          );
        }
      },
    },
  },
});
