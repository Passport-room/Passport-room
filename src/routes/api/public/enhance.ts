// Image enhance proxy — authenticated Hugging Face Space calls with a
// second free Space as a fallback. Returns the upstream image bytes as-is
// (no local pixel sharpen) so quality is preserved. On real failure returns
// a JSON 502 the UI can surface.

import { createFileRoute } from "@tanstack/react-router";
import { Client, handle_file } from "@gradio/client";

const MAX_BYTES = 12 * 1024 * 1024;
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);
const PER_ATTEMPT_TIMEOUT_MS = 120_000;

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

async function callFinegrain(
  image: Blob,
  upscale: number,
  hfToken: string | undefined,
): Promise<ArrayBuffer> {
  const client = await Client.connect(
    "finegrain/finegrain-image-enhancer",
    hfToken ? ({ hf_token: hfToken } as unknown as Record<string, never>) : undefined,
  );
  const file = new File([await image.arrayBuffer()], "image.png", {
    type: image.type || "image/png",
  });
  const result = await client.predict("/process", [
    handle_file(file),
    "", // prompt
    "worst quality, low quality, normal quality", // negative prompt
    42, // seed
    upscale, // upscale factor 1..4
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
  if (!url) throw new Error("Finegrain enhancer returned no image URL");
  return fetchImageBuffer(url);
}

async function callCodeFormer(
  image: Blob,
  upscale: number,
  hfToken: string | undefined,
): Promise<ArrayBuffer> {
  const client = await Client.connect(
    "sczhou/CodeFormer",
    hfToken ? ({ hf_token: hfToken } as unknown as Record<string, never>) : undefined,
  );
  const file = new File([await image.arrayBuffer()], "image.png", {
    type: image.type || "image/png",
  });
  const result = await client.predict("/inference", [
    handle_file(file),
    true,
    true,
    true,
    upscale,
    0.7,
  ]);
  const rootHint = client.config?.root;
  const url = extractUrl((result as { data?: unknown }).data, rootHint);
  if (!url) throw new Error("CodeFormer returned no image URL");
  return fetchImageBuffer(url);
}

export const Route = (createFileRoute("/api/public/enhance") as any)({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      POST: async ({ request }: { request: Request }) => {
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

        const hfToken = process.env.HF_TOKEN;
        const errors: string[] = [];

        const attempts: Array<{ name: string; run: () => Promise<ArrayBuffer> }> = [
          { name: "Finegrain enhancer", run: () => callFinegrain(image, upscale, hfToken) },
          {
            name: "Finegrain enhancer retry",
            run: () => callFinegrain(image, upscale, hfToken),
          },
          { name: "CodeFormer", run: () => callCodeFormer(image, upscale, hfToken) },
        ];

        for (const attempt of attempts) {
          try {
            const raw = await withTimeout(attempt.run(), PER_ATTEMPT_TIMEOUT_MS, attempt.name);
            return new Response(raw, {
              status: 200,
              headers: {
                "Content-Type": "image/png",
                "Cache-Control": "no-store",
                ...CORS,
              },
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[enhance] ${attempt.name} failed:`, msg);
            errors.push(`${attempt.name}: ${msg}`);
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

