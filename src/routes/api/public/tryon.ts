// Virtual try-on proxy — sends the person image to yisol/IDM-VTON.
// To avoid the "shrink from width" distortion (IDM-VTON forces a portrait
// 768x1024 working canvas), we letterbox the person image to 3:4 on white
// before sending, remember the inset rect, then crop the model output back
// to the original aspect. Also adds retry/backoff for cold-Space errors.

import { createFileRoute } from "@tanstack/react-router";
import { Client } from "@gradio/client";
import { Image, decode, encode } from "image-js";

const SPACE_ID = "yisol/IDM-VTON";
const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const TIMEOUT_MS = 170_000;

const MODEL_W = 768;
const MODEL_H = 1024;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function letterboxTo3x4(src: Blob): Promise<{
  blob: Blob;
  inset: { x: number; y: number; w: number; h: number };
  origW: number;
  origH: number;
}> {
  const buf = new Uint8Array(await src.arrayBuffer());
  const img = decode(buf);
  const origW = img.width;
  const origH = img.height;

  const scale = Math.min(MODEL_W / origW, MODEL_H / origH);
  const w = Math.max(1, Math.round(origW * scale));
  const h = Math.max(1, Math.round(origH * scale));
  const x = Math.floor((MODEL_W - w) / 2);
  const y = Math.floor((MODEL_H - h) / 2);

  // Normalize to RGBA so source and target share the same color model for copyTo.
  const rgbaSrc = img.colorModel === "RGBA" ? img : img.convertColor("RGBA");
  const resized = rgbaSrc.resize({ width: w, height: h });
  let canvas = new Image(MODEL_W, MODEL_H, { colorModel: "RGBA" });
  canvas.fill([255, 255, 255, 255]);
  canvas = resized.copyTo(canvas, { origin: { row: y, column: x } });

  const out = encode(canvas, { format: "png" });
  const outCopy = new Uint8Array(out);
  return {
    blob: new Blob([outCopy.buffer], { type: "image/png" }),
    inset: { x, y, w, h },
    origW,
    origH,
  };
}

async function cropBackToOriginal(
  modelOut: ArrayBuffer,
  inset: { x: number; y: number; w: number; h: number },
  origW: number,
  origH: number,
): Promise<{ buf: ArrayBuffer; type: string }> {
  const img = decode(new Uint8Array(modelOut));

  // If the space returned a different resolution, scale the inset.
  const sx = img.width / MODEL_W;
  const sy = img.height / MODEL_H;
  const cx = Math.max(0, Math.round(inset.x * sx));
  const cy = Math.max(0, Math.round(inset.y * sy));
  const cw = Math.min(img.width - cx, Math.max(1, Math.round(inset.w * sx)));
  const ch = Math.min(img.height - cy, Math.max(1, Math.round(inset.h * sy)));

  const cropped = img.crop({ origin: { row: cy, column: cx }, width: cw, height: ch });

  const MAX = 2000;
  const restoreScale = Math.min(1, MAX / Math.max(origW, origH));
  const outW = Math.max(1, Math.round(origW * restoreScale));
  const outH = Math.max(1, Math.round(origH * restoreScale));
  const restored = cropped.resize({ width: outW, height: outH });

  const encoded = encode(restored, { format: "png" });
  const ab = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(ab).set(encoded);
  return { buf: ab, type: "image/png" };
}

async function callSpaceOnce(
  personPadded: Blob,
  garment: Blob,
  description: string,
): Promise<ArrayBuffer> {
  const client = await Client.connect(SPACE_ID);
  const result = await client.predict("/tryon", {
    dict: { background: personPadded, layers: [], composite: null },
    garm_img: garment,
    garment_des: description || "a garment",
    is_checked: true,
    is_checked_crop: false,
    denoise_steps: 30,
    seed: 42,
  });

  const data = (result as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("Unexpected response from the Space");
  }
  const first = data[0] as { url?: string; path?: string } | string | null;
  const url =
    typeof first === "string"
      ? first
      : first && typeof first === "object"
        ? first.url ??
          (first.path
            ? `https://${SPACE_ID.replace("/", "-").toLowerCase()}.hf.space/file=${first.path}`
            : undefined)
        : undefined;
  if (!url) throw new Error("Space did not return an image URL");

  const imgRes = await fetch(url);
  if (!imgRes.ok) throw new Error(`Failed to fetch generated image (${imgRes.status})`);
  return await imgRes.arrayBuffer();
}

const isTransient = (msg: string) =>
  /429|rate|queue|loading|starting|busy|502|503|504/i.test(msg);

async function callSpaceWithRetry(
  personPadded: Blob,
  garment: Blob,
  description: string,
): Promise<ArrayBuffer> {
  const delays = [0, 3000, 8000];
  let lastErr: unknown = null;
  for (const d of delays) {
    if (d) await sleep(d);
    try {
      return await callSpaceOnce(personPadded, garment, description);
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!isTransient(msg)) throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export const Route = createFileRoute("/api/public/tryon")({
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

        const person = form.get("person");
        const garment = form.get("garment");
        const description = String(form.get("description") ?? "");

        if (!(person instanceof File) || !(garment instanceof File)) {
          return json({ error: "Both 'person' and 'garment' image files are required" }, 400);
        }
        for (const [name, f] of [
          ["person", person],
          ["garment", garment],
        ] as const) {
          if (f.size === 0) return json({ error: `${name} image is empty` }, 400);
          if (f.size > MAX_BYTES)
            return json({ error: `${name} image exceeds 8 MB limit` }, 413);
          if (f.type && !ALLOWED_MIME.has(f.type))
            return json({ error: `${name} must be JPEG, PNG, or WebP (got ${f.type})` }, 415);
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

        try {
          const { blob: personPadded, inset, origW, origH } = await letterboxTo3x4(person);

          const work = callSpaceWithRetry(personPadded, garment, description);
          const raw = await Promise.race([
            work,
            new Promise<never>((_, reject) =>
              controller.signal.addEventListener("abort", () =>
                reject(new Error("timeout")),
              ),
            ),
          ]);

          const { buf, type } = await cropBackToOriginal(raw, inset, origW, origH);

          return new Response(buf, {
            status: 200,
            headers: {
              "Content-Type": type,
              "Cache-Control": "no-store",
              ...CORS,
            },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error("[tryon] upstream failure:", msg);
          if (msg === "timeout") {
            return json(
              { error: "The AI Space took too long to respond. Please try again." },
              504,
            );
          }
          if (/rate|429|too many/i.test(msg)) {
            return json({ error: "The Hugging Face Space is busy. Please retry shortly." }, 429);
          }
          return json({ error: `Hugging Face Space error: ${msg}` }, 502);
        } finally {
          clearTimeout(timer);
        }
      },
    },
  },
});
