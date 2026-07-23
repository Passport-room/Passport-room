// Virtual try-on proxy — sends the person image to Gemini GenAI or yisol/IDM-VTON.
// To avoid distortion, we letterbox the person image to 3:4 on white before sending,
// then crop back to original aspect. Also includes retry/backoff and Gemini AI fallback.

import { createFileRoute } from "@tanstack/react-router";
import { Client } from "@gradio/client";
import { Image, decode, encode } from "image-js";
import { GoogleGenAI } from "@google/genai";

const SPACE_ID = "yisol/IDM-VTON";
const MAX_BYTES = 12 * 1024 * 1024;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const TIMEOUT_MS = 55_000;

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

function getGenAI() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

async function tryOnWithGemini(
  personBuf: Buffer,
  personMime: string,
  garmentBuf: Buffer,
  garmentMime: string,
  description: string,
): Promise<{ buf: ArrayBuffer; type: string } | null> {
  const ai = getGenAI();
  if (!ai) return null;

  const personBase64 = personBuf.toString("base64");
  const garmentBase64 = garmentBuf.toString("base64");

  const prompt = `You are an expert AI Virtual Try-On tool.
Task: Modify the person in the first photo so they are wearing the clothing shown in the second photo (or described as "${description || "a stylish garment"}").
Requirements:
1. Maintain the person's exact face, facial features, identity, hair, facial expression, skin tone, body pose, and background.
2. Replace only the clothing with the target garment, fitting it naturally onto the body with realistic lighting, fabric texture, and shadows.
3. Output ONLY the resulting edited photo. Do not add any text commentary.`;

  const modelsToTry = ["gemini-3.1-flash-lite-image", "gemini-3.1-flash-image"];

  for (const model of modelsToTry) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: {
          parts: [
            {
              inlineData: {
                data: personBase64,
                mimeType: personMime || "image/png",
              },
            },
            {
              inlineData: {
                data: garmentBase64,
                mimeType: garmentMime || "image/png",
              },
            },
            {
              text: prompt,
            },
          ],
        },
      });

      const candidates = response.candidates;
      if (candidates && candidates[0]?.content?.parts) {
        for (const part of candidates[0].content.parts) {
          if (part.inlineData?.data) {
            const outBase64 = part.inlineData.data;
            const outMime = part.inlineData.mimeType || "image/png";
            const outBuf = Buffer.from(outBase64, "base64");
            const ab = outBuf.buffer.slice(
              outBuf.byteOffset,
              outBuf.byteOffset + outBuf.byteLength,
            );
            return { buf: ab, type: outMime };
          }
        }
      }
    } catch (err) {
      console.warn(
        `[tryon] Gemini model ${model} error:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return null;
}

async function letterboxTo3x4(src: Blob): Promise<{
  blob: Blob;
  inset: { x: number; y: number; w: number; h: number };
  origW: number;
  origH: number;
}> {
  try {
    const buf = new Uint8Array(await src.arrayBuffer());
    const img = decode(buf);
    const origW = img.width || 512;
    const origH = img.height || 512;

    const scale = Math.min(MODEL_W / origW, MODEL_H / origH);
    const w = Math.max(1, Math.round(origW * scale));
    const h = Math.max(1, Math.round(origH * scale));
    const x = Math.floor((MODEL_W - w) / 2);
    const y = Math.floor((MODEL_H - h) / 2);

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
  } catch {
    return {
      blob: src,
      inset: { x: 0, y: 0, w: MODEL_W, h: MODEL_H },
      origW: MODEL_W,
      origH: MODEL_H,
    };
  }
}

async function cropBackToOriginal(
  modelOut: ArrayBuffer,
  inset: { x: number; y: number; w: number; h: number },
  origW: number,
  origH: number,
): Promise<{ buf: ArrayBuffer; type: string }> {
  try {
    const img = decode(new Uint8Array(modelOut));

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
  } catch {
    return { buf: modelOut, type: "image/png" };
  }
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
        ? (first.url ??
          (first.path
            ? `https://${SPACE_ID.replace("/", "-").toLowerCase()}.hf.space/file=${first.path}`
            : undefined))
        : undefined;
  if (!url) throw new Error("Space did not return an image URL");

  const imgRes = await fetch(url);
  if (!imgRes.ok) throw new Error(`Failed to fetch generated image (${imgRes.status})`);
  return await imgRes.arrayBuffer();
}

const isTransient = (msg: string) => /429|rate|queue|loading|starting|busy|502|503|504/i.test(msg);

async function callSpaceWithRetry(
  personPadded: Blob,
  garment: Blob,
  description: string,
): Promise<ArrayBuffer> {
  const delays = [0, 2000, 5000];
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
          if (f.size > MAX_BYTES) return json({ error: `${name} image exceeds 12 MB limit` }, 413);
          if (f.type && !ALLOWED_MIME.has(f.type))
            return json({ error: `${name} must be JPEG, PNG, or WebP (got ${f.type})` }, 415);
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

        try {
          const personBuffer = Buffer.from(await person.arrayBuffer());
          const garmentBuffer = Buffer.from(await garment.arrayBuffer());

          // 1. Try Gemini GenAI Image Editing
          const geminiResult = await tryOnWithGemini(
            personBuffer,
            person.type || "image/png",
            garmentBuffer,
            garment.type || "image/png",
            description,
          );

          if (geminiResult) {
            return new Response(geminiResult.buf, {
              status: 200,
              headers: {
                "Content-Type": geminiResult.type,
                "Cache-Control": "no-store",
                ...CORS,
              },
            });
          }

          // 2. Fallback to Hugging Face Space
          const { blob: personPadded, inset, origW, origH } = await letterboxTo3x4(person);

          const work = callSpaceWithRetry(personPadded, garment, description);
          const raw = await Promise.race([
            work,
            new Promise<never>((_, reject) =>
              controller.signal.addEventListener("abort", () => reject(new Error("timeout"))),
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
          console.error("[tryon] failure:", msg);
          if (msg === "timeout") {
            return json(
              { error: "The AI service took too long to respond. Please try again." },
              504,
            );
          }
          if (/rate|429|too many/i.test(msg)) {
            return json({ error: "The AI service is busy. Please retry shortly." }, 429);
          }
          return json({ error: `AI Virtual Try-On error: ${msg}` }, 502);
        } finally {
          clearTimeout(timer);
        }
      },
    },
  },
});
