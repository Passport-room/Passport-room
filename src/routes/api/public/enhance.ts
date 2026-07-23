// Image enhance proxy — sczhou/CodeFormer face-restoration Space & Gemini AI restoration.
// Same request contract as before (FormData: image + upscale) so the
// existing public/enhance.js client needs no changes.

import { createFileRoute } from "@tanstack/react-router";
import { Client } from "@gradio/client";
import { GoogleGenAI } from "@google/genai";

const SPACE_ID = "sczhou/CodeFormer";
const MAX_BYTES = 12 * 1024 * 1024;
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);
const TIMEOUT_MS = 55_000;

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

async function enhanceWithGemini(
  imageBuf: Buffer,
  imageMime: string,
  upscale: number,
): Promise<{ buf: ArrayBuffer; type: string } | null> {
  const ai = getGenAI();
  if (!ai) return null;

  const imageBase64 = imageBuf.toString("base64");

  const prompt = `You are a high-definition professional photo enhancement and restoration system.
Task: Enhance and upscale this photo to HD quality (${upscale}x clarity).
Requirements:
1. Sharpen facial features, remove blur, eliminate noise and compression artifacts, and restore ultra-clear skin texture, eyes, and hair.
2. Preserve the exact facial identity, features, expression, skin tone, lighting, and clothing of the person in the photo.
3. Improve contrast and overall resolution naturally.
4. Output ONLY the resulting enhanced HD image. Do not add any text commentary.`;

  const modelsToTry = ["gemini-3.1-flash-lite-image", "gemini-3.1-flash-image"];

  for (const model of modelsToTry) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: {
          parts: [
            {
              inlineData: {
                data: imageBase64,
                mimeType: imageMime || "image/png",
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
        `[enhance] Gemini model ${model} error:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return null;
}

function extractUrl(data: unknown): string | undefined {
  if (!Array.isArray(data)) return undefined;
  for (const item of data) {
    if (!item) continue;
    if (typeof item === "string" && /^https?:\/\//.test(item)) return item;
    if (typeof item === "object") {
      const rec = item as { url?: string; path?: string; name?: string };
      if (rec.url) return rec.url;
      if (rec.path)
        return `https://${SPACE_ID.replace("/", "-").toLowerCase()}.hf.space/file=${rec.path}`;
      if (rec.name)
        return `https://${SPACE_ID.replace("/", "-").toLowerCase()}.hf.space/file=${rec.name}`;
      if (Array.isArray(item)) {
        const nested = extractUrl(item);
        if (nested) return nested;
      }
    }
  }
  return undefined;
}

async function callSpaceOnce(image: Blob, upscale: number) {
  const client = await Client.connect(SPACE_ID);
  const result = await client.predict("/inference", [image, true, true, true, upscale, 0.7]);
  const url = extractUrl((result as { data?: unknown }).data);
  if (!url) throw new Error("Space did not return an image URL");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch generated image ${res.status}`);
  return {
    buf: await res.arrayBuffer(),
    type: res.headers.get("content-type") || "image/png",
  };
}

const isTransient = (msg: string) => /429|rate|queue|loading|starting|busy|502|503|504/i.test(msg);

async function callSpaceWithRetry(image: Blob, upscale: number) {
  const delays = [0, 2000, 5000];
  let lastErr: unknown = null;
  for (const d of delays) {
    if (d) await sleep(d);
    try {
      return await callSpaceOnce(image, upscale);
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!isTransient(msg)) throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
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

        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
        try {
          const imageBuf = Buffer.from(await image.arrayBuffer());

          // 1. Try Gemini GenAI HD Photo Enhancement
          const geminiResult = await enhanceWithGemini(
            imageBuf,
            image.type || "image/png",
            upscale,
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

          // 2. Fallback to CodeFormer Space
          const raced = await Promise.race([
            callSpaceWithRetry(image, upscale),
            new Promise<never>((_, rej) =>
              ctl.signal.addEventListener("abort", () => rej(new Error("timeout"))),
            ),
          ]);
          return new Response(raced.buf, {
            status: 200,
            headers: {
              "Content-Type": raced.type,
              "Cache-Control": "no-store",
              ...CORS,
            },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error("[enhance]", msg);
          if (msg === "timeout")
            return json({ error: "AI service took too long. Try again." }, 504);
          if (/429|rate|too many/i.test(msg))
            return json({ error: "AI service is busy. Retry shortly." }, 429);
          return json({ error: `AI Photo Enhance error: ${msg}` }, 502);
        } finally {
          clearTimeout(timer);
        }
      },
    },
  },
});
