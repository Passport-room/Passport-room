// Image enhance proxy — one model per request. The client rotates models
// and shows a countdown when a model is busy. Returns upstream bytes
// unchanged so resolution is preserved. Face-safe defaults (high fidelity,
// low denoise) so passport photos stay recognizable.

import { createFileRoute } from "@tanstack/react-router";
import { Client, handle_file } from "@gradio/client";

const MAX_BYTES = 12 * 1024 * 1024;
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);
const PER_ATTEMPT_TIMEOUT_MS = 140_000;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

const MODELS = ["finegrain", "codeformer", "realesrgan", "gfpgan"] as const;
type ModelId = (typeof MODELS)[number];
const MODEL_LABELS: Record<ModelId, string> = {
  finegrain: "Finegrain Enhancer",
  codeformer: "CodeFormer",
  realesrgan: "Real-ESRGAN",
  gfpgan: "GFPGAN",
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

function isBusyError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)) || "";
  return /429|503|504|queue|busy|loading|gpu|quota|timed out|timeout|unavailable|overloaded|rate.?limit|sleep|starting/i.test(
    msg,
  );
}

function extractUrl(data: unknown, rootHint?: string): string | undefined {
  const visit = (v: unknown): string | undefined => {
    if (!v) return undefined;
    if (typeof v === "string") return /^https?:\/\//.test(v) ? v : undefined;
    if (Array.isArray(v)) {
      for (const item of v) {
        const f = visit(item);
        if (f) return f;
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

async function toFile(b: Blob, name: string): Promise<File> {
  return new File([await b.arrayBuffer()], name, { type: b.type || "image/png" });
}

async function callFinegrain(image: Blob, upscale: number, hf?: string) {
  const client = await Client.connect(
    "finegrain/finegrain-image-enhancer",
    hf ? ({ hf_token: hf } as unknown as Record<string, never>) : undefined,
  );
  const file = handle_file(await toFile(image, "image.png"));
  // Face-safe: low denoise (0.35), moderate steps (30), keep prompt neutral.
  const result = await client.predict("/process", [
    file,
    "", // prompt
    "worst quality, low quality, normal quality, blurry", // negative prompt
    Math.floor(Math.random() * 1_000_000), // seed
    upscale,
    0.6,
    1,
    1,
    "Karras",
    0.35,
    30,
    112,
    144,
  ]);
  const url = extractUrl((result as { data?: unknown }).data, client.config?.root);
  if (!url) throw new Error("Finegrain returned no image URL");
  return fetchImageBuffer(url);
}

async function callCodeFormer(image: Blob, upscale: number, hf?: string) {
  const client = await Client.connect(
    "sczhou/CodeFormer",
    hf ? ({ hf_token: hf } as unknown as Record<string, never>) : undefined,
  );
  const file = handle_file(await toFile(image, "image.png"));
  // fidelity 0.9 = preserve original identity (best for passport photos).
  const result = await client.predict("/inference", [file, true, true, true, upscale, 0.9]);
  const url = extractUrl((result as { data?: unknown }).data, client.config?.root);
  if (!url) throw new Error("CodeFormer returned no image URL");
  return fetchImageBuffer(url);
}

async function callRealEsrgan(image: Blob, upscale: number, hf?: string) {
  const client = await Client.connect(
    "doevent/Face-Real-ESRGAN",
    hf ? ({ hf_token: hf } as unknown as Record<string, never>) : undefined,
  );
  const file = handle_file(await toFile(image, "image.png"));
  // Signature: (image, size) where size ∈ {2, 4}
  const size = upscale >= 4 ? 4 : 2;
  const result = await client.predict("/predict", [file, size]);
  const url = extractUrl((result as { data?: unknown }).data, client.config?.root);
  if (!url) throw new Error("Real-ESRGAN returned no image URL");
  return fetchImageBuffer(url);
}

async function callGfpgan(image: Blob, upscale: number, hf?: string) {
  const client = await Client.connect(
    "Xintao/GFPGAN",
    hf ? ({ hf_token: hf } as unknown as Record<string, never>) : undefined,
  );
  const file = handle_file(await toFile(image, "image.png"));
  const version = "v1.4";
  const scale = Math.max(1, Math.min(4, upscale));
  const result = await client.predict("/predict", [file, version, scale]);
  const url = extractUrl((result as { data?: unknown }).data, client.config?.root);
  if (!url) throw new Error("GFPGAN returned no image URL");
  return fetchImageBuffer(url);
}

function nextModel(current: ModelId): ModelId | null {
  const i = MODELS.indexOf(current);
  return i >= 0 && i < MODELS.length - 1 ? MODELS[i + 1] : null;
}

async function runModel(model: ModelId, image: Blob, upscale: number, hf?: string) {
  switch (model) {
    case "finegrain":
      return callFinegrain(image, upscale, hf);
    case "codeformer":
      return callCodeFormer(image, upscale, hf);
    case "realesrgan":
      return callRealEsrgan(image, upscale, hf);
    case "gfpgan":
      return callGfpgan(image, upscale, hf);
  }
}

export const Route = createFileRoute("/api/public/enhance")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      POST: async ({ request }) => {
        const url = new URL(request.url);
        const requested = (url.searchParams.get("model") || "finegrain").toLowerCase();
        const model = (MODELS as readonly string[]).includes(requested)
          ? (requested as ModelId)
          : "finegrain";

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

        try {
          const raw = await withTimeout(
            runModel(model, image, upscale, hfToken),
            PER_ATTEMPT_TIMEOUT_MS,
            MODEL_LABELS[model],
          );
          return new Response(raw, {
            status: 200,
            headers: {
              "Content-Type": "image/png",
              "Cache-Control": "no-store",
              "X-Model-Used": MODEL_LABELS[model],
              ...CORS,
            },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[enhance:${model}] failed:`, msg);
          const nxt = nextModel(model);
          if (isBusyError(err) && nxt) {
            return json(
              {
                busy: true,
                model,
                modelLabel: MODEL_LABELS[model],
                nextModel: nxt,
                nextModelLabel: MODEL_LABELS[nxt],
                waitMs: 5000,
                detail: msg,
              },
              202,
            );
          }
          return json(
            {
              error: nxt
                ? `AI enhancer model ${MODEL_LABELS[model]} failed.`
                : "All AI enhancer models are currently unavailable. Please try again shortly.",
              model,
              modelLabel: MODEL_LABELS[model],
              nextModel: nxt,
              nextModelLabel: nxt ? MODEL_LABELS[nxt] : null,
              detail: msg,
            },
            nxt ? 502 : 503,
          );
        }
      },
    },
  },
});
