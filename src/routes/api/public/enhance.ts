// Image enhance proxy — authenticated Hugging Face Space calls with an
// automatic multi-worker failover chain. If a Space is busy, sleeping,
// rate-limited, or errors, the same image request is transparently retried
// against the next compatible Space until one succeeds or all fail.
//
// Primary + backups (all public, free-tier, gradio predict API):
//   1. finegrain/finegrain-image-enhancer  (primary — highest-fidelity upscale)
//   2. finegrain/finegrain-image-enhancer  (single quick retry)
//   3. sczhou/CodeFormer                   (quality match, face restoration)
//   4. Xintao/GFPGAN                       (face restoration, low traffic)
//   5. doevent/Face-Real-ESRGAN            (general upscale + face)
//
// Optional env var ENHANCE_PRIMARY_SPACE lets the user prepend their own
// duplicated Finegrain / CodeFormer Space without a code change.

import { createFileRoute } from "@tanstack/react-router";
import { Client, handle_file } from "@gradio/client";

const MAX_BYTES = 12 * 1024 * 1024;
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);
const PER_ATTEMPT_TIMEOUT_MS = 120_000;
const BACKOFF_MS = 1_500;

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

function isRetryable(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes("invalid input") || msg.includes("unsupported file"))
    return false;
  return true;
}

function extractUrl(data: unknown, rootHint?: string): string | undefined {
  const visit = (v: unknown): string | undefined => {
    if (!v) return undefined;
    if (typeof v === "string") return /^https?:\/\//.test(v) ? v : undefined;
    if (Array.isArray(v)) {
      for (const item of v) {
        const found = visit(item);
        if (found) return found;
      }
      return undefined;
    }
    if (typeof v === "object") {
      const rec = v as { url?: string; path?: string; name?: string };
      if (rec.url && /^https?:\/\//.test(rec.url)) return rec.url;
      if (rec.path && rootHint) return `${rootHint}/file=${rec.path}`;
      if (rec.name && rootHint) return `${rootHint}/file=${rec.name}`;
    }
    return undefined;
  };
  return visit(data);
}

async function fetchImageBuffer(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch enhanced image failed (${res.status})`);
  const buf = await res.arrayBuffer();
  const out = new ArrayBuffer(buf.byteLength);
  new Uint8Array(out).set(new Uint8Array(buf));
  return out;
}

type HfAuth = Record<string, never> | undefined;
const hfOpts = (t: string | undefined): HfAuth =>
  t ? ({ hf_token: t } as unknown as Record<string, never>) : undefined;

async function toFile(blob: Blob, name: string): Promise<File> {
  return new File([await blob.arrayBuffer()], name, {
    type: blob.type || "image/png",
  });
}

// --- Worker adapters ------------------------------------------------------

async function callFinegrain(
  space: string,
  image: Blob,
  upscale: number,
  hfToken: string | undefined,
): Promise<ArrayBuffer> {
  const client = await Client.connect(space, hfOpts(hfToken));
  const file = await toFile(image, "image.png");
  const result = await client.predict("/process", [
    handle_file(file),
    "", // prompt
    "worst quality, low quality, normal quality", // negative prompt
    42, // seed
    upscale, // upscale 1..4
    0.6, // controlnet scale
    1, // controlnet decay
    1, // condition scale
    "Karras", // solver
    0.8, // denoise strength
    18, // num inference steps
    112, // tile width
    144, // tile height
  ]);
  const rootHint = client.config?.root;
  const url = extractUrl((result as { data?: unknown }).data, rootHint);
  if (!url) throw new Error(`${space} returned no image URL`);
  return fetchImageBuffer(url);
}

async function callCodeFormer(
  image: Blob,
  upscale: number,
  hfToken: string | undefined,
): Promise<ArrayBuffer> {
  const client = await Client.connect("sczhou/CodeFormer", hfOpts(hfToken));
  const file = await toFile(image, "image.png");
  const result = await client.predict("/inference", [
    handle_file(file),
    true, // background enhance
    true, // face upsample
    true, // has aligned
    upscale,
    0.7, // fidelity weight
  ]);
  const rootHint = client.config?.root;
  const url = extractUrl((result as { data?: unknown }).data, rootHint);
  if (!url) throw new Error("CodeFormer returned no image URL");
  return fetchImageBuffer(url);
}

async function callGfpgan(
  image: Blob,
  upscale: number,
  hfToken: string | undefined,
): Promise<ArrayBuffer> {
  const client = await Client.connect("Xintao/GFPGAN", hfOpts(hfToken));
  const file = await toFile(image, "image.png");
  // GFPGAN Space: /predict (img, version, scale)
  const result = await client.predict("/predict", [
    handle_file(file),
    "v1.4",
    upscale,
  ]);
  const rootHint = client.config?.root;
  const url = extractUrl((result as { data?: unknown }).data, rootHint);
  if (!url) throw new Error("GFPGAN returned no image URL");
  return fetchImageBuffer(url);
}

async function callFaceRealEsrgan(
  image: Blob,
  upscale: number,
  hfToken: string | undefined,
): Promise<ArrayBuffer> {
  const client = await Client.connect(
    "doevent/Face-Real-ESRGAN",
    hfOpts(hfToken),
  );
  const file = await toFile(image, "image.png");
  // Face-Real-ESRGAN: /predict (img, size)  — size is a "2x" | "3x" | "4x" enum.
  const sizeArg = `${Math.min(4, Math.max(2, upscale))}x`;
  const result = await client.predict("/predict", [handle_file(file), sizeArg]);
  const rootHint = client.config?.root;
  const url = extractUrl((result as { data?: unknown }).data, rootHint);
  if (!url) throw new Error("Face-Real-ESRGAN returned no image URL");
  return fetchImageBuffer(url);
}

// --- Route ---------------------------------------------------------------

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
        const upscale = Math.min(
          4,
          Math.max(1, Number(form.get("upscale") ?? 2) || 2),
        );
        if (!(image instanceof File))
          return json({ error: "image file required" }, 400);
        if (image.size === 0) return json({ error: "image is empty" }, 400);
        if (image.size > MAX_BYTES)
          return json({ error: "image exceeds 12 MB" }, 413);
        if (image.type && !ALLOWED.has(image.type))
          return json({ error: `unsupported type ${image.type}` }, 415);

        const hfToken = process.env.HF_TOKEN;
        const customPrimary = (process.env.ENHANCE_PRIMARY_SPACE || "").trim();
        const errors: string[] = [];

        const attempts: Array<{
          name: string;
          run: () => Promise<ArrayBuffer>;
        }> = [];

        if (customPrimary) {
          attempts.push({
            name: `custom:${customPrimary}`,
            run: () => callFinegrain(customPrimary, image, upscale, hfToken),
          });
        }

        attempts.push(
          {
            name: "Finegrain enhancer",
            run: () =>
              callFinegrain(
                "finegrain/finegrain-image-enhancer",
                image,
                upscale,
                hfToken,
              ),
          },
          {
            name: "Finegrain enhancer retry",
            run: () =>
              callFinegrain(
                "finegrain/finegrain-image-enhancer",
                image,
                upscale,
                hfToken,
              ),
          },
          {
            name: "CodeFormer",
            run: () => callCodeFormer(image, upscale, hfToken),
          },
          { name: "GFPGAN", run: () => callGfpgan(image, upscale, hfToken) },
          {
            name: "Face-Real-ESRGAN",
            run: () => callFaceRealEsrgan(image, upscale, hfToken),
          },
        );

        for (const attempt of attempts) {
          try {
            const raw = await withTimeout(
              attempt.run(),
              PER_ATTEMPT_TIMEOUT_MS,
              attempt.name,
            );
            return new Response(raw, {
              status: 200,
              headers: {
                "Content-Type": "image/png",
                "Cache-Control": "no-store",
                "X-Worker": attempt.name,
                ...CORS,
              },
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[enhance] ${attempt.name} failed:`, msg);
            errors.push(`${attempt.name}: ${msg}`);
            if (!isRetryable(err)) break;
            if (attempt.name.endsWith("retry")) {
              await new Promise((r) => setTimeout(r, BACKOFF_MS));
            }
          }
        }

        return json(
          {
            error:
              "The AI enhancer service is busy or unavailable right now. Please try again in a minute.",
            details: errors,
          },
          502,
        );
      },
    },
  },
});
