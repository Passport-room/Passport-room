// Virtual try-on proxy — one model per request. The client drives the
// retry / model-rotation loop and shows a live countdown when a model is
// busy. Never returns a local composite; on busy returns 202 JSON; on
// hard failure returns 502 JSON. On success returns the upstream image
// bytes unchanged so quality/resolution is preserved.

import { createFileRoute } from "@tanstack/react-router";
import { Client, handle_file } from "@gradio/client";

const MAX_BYTES = 12 * 1024 * 1024;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const PER_ATTEMPT_TIMEOUT_MS = 110_000;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

// Ordered model pool. First entry is default. Order matters — highest
// quality first.
const MODELS = ["idm", "catvton", "kolors", "ootd"] as const;
type ModelId = (typeof MODELS)[number];

const MODEL_LABELS: Record<ModelId, string> = {
  idm: "IDM-VTON",
  catvton: "CatVTON",
  kolors: "Kolors-VTON",
  ootd: "OOTDiffusion",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

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

function isBusyError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)) || "";
  return /429|503|504|queue|busy|loading|gpu|quota|timed out|timeout|unavailable|overloaded|rate.?limit|sleep|starting/i.test(
    msg,
  );
}

async function fetchImageBuffer(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch generated image failed (${res.status})`);
  const buf = await res.arrayBuffer();
  const out = new ArrayBuffer(buf.byteLength);
  new Uint8Array(out).set(new Uint8Array(buf));
  return out;
}

async function toFile(b: Blob, name: string): Promise<File> {
  return new File([await b.arrayBuffer()], name, { type: b.type || "image/png" });
}

async function callIdm(person: Blob, garment: Blob, description: string, hf?: string) {
  const client = await Client.connect(
    "yisol/IDM-VTON",
    hf ? ({ hf_token: hf } as unknown as Record<string, never>) : undefined,
  );
  const bg = handle_file(await toFile(person, "person.png"));
  const gm = handle_file(await toFile(garment, "garment.png"));
  const result = await client.predict("/tryon", {
    dict: { background: bg, layers: [], composite: bg },
    garm_img: gm,
    garment_des: description || "a garment",
    is_checked: true,
    is_checked_crop: true,
    denoise_steps: 50,
    seed: Math.floor(Math.random() * 1_000_000),
  });
  const url = extractUrl((result as { data?: unknown }).data, client.config?.root);
  if (!url) throw new Error("IDM-VTON returned no image URL");
  return fetchImageBuffer(url);
}

async function callCatVton(person: Blob, garment: Blob, hf?: string) {
  const client = await Client.connect(
    "zhengchong/CatVTON",
    hf ? ({ hf_token: hf } as unknown as Record<string, never>) : undefined,
  );
  const p = handle_file(await toFile(person, "person.png"));
  const g = handle_file(await toFile(garment, "garment.png"));
  // CatVTON signature: (person, cloth, cloth_type, num_inference_steps, guidance_scale, seed, show_type)
  const result = await client.predict("/submit_function", [
    p,
    g,
    "upper",
    50,
    2.5,
    Math.floor(Math.random() * 1_000_000),
    "result only",
  ]);
  const url = extractUrl((result as { data?: unknown }).data, client.config?.root);
  if (!url) throw new Error("CatVTON returned no image URL");
  return fetchImageBuffer(url);
}

async function callKolors(person: Blob, garment: Blob, hf?: string) {
  const client = await Client.connect(
    "Kwai-Kolors/Kolors-Virtual-Try-On",
    hf ? ({ hf_token: hf } as unknown as Record<string, never>) : undefined,
  );
  const p = handle_file(await toFile(person, "person.png"));
  const g = handle_file(await toFile(garment, "garment.png"));
  const result = await client.predict("/tryon", [p, g, 0, true]);
  const url = extractUrl((result as { data?: unknown }).data, client.config?.root);
  if (!url) throw new Error("Kolors returned no image URL");
  return fetchImageBuffer(url);
}

async function callOotd(person: Blob, garment: Blob, hf?: string) {
  const client = await Client.connect(
    "levihsu/OOTDiffusion",
    hf ? ({ hf_token: hf } as unknown as Record<string, never>) : undefined,
  );
  const p = handle_file(await toFile(person, "person.png"));
  const g = handle_file(await toFile(garment, "garment.png"));
  // Half-body process: (vton_img, garm_img, n_samples, n_steps, image_scale, seed)
  const result = await client.predict("/process_hd", [
    p,
    g,
    1,
    30,
    2.0,
    Math.floor(Math.random() * 1_000_000),
  ]);
  const url = extractUrl((result as { data?: unknown }).data, client.config?.root);
  if (!url) throw new Error("OOTDiffusion returned no image URL");
  return fetchImageBuffer(url);
}

function nextModel(current: ModelId): ModelId | null {
  const i = MODELS.indexOf(current);
  return i >= 0 && i < MODELS.length - 1 ? MODELS[i + 1] : null;
}

async function runModel(
  model: ModelId,
  person: Blob,
  garment: Blob,
  description: string,
  hf?: string,
) {
  switch (model) {
    case "idm":
      return callIdm(person, garment, description, hf);
    case "catvton":
      return callCatVton(person, garment, hf);
    case "kolors":
      return callKolors(person, garment, hf);
    case "ootd":
      return callOotd(person, garment, hf);
  }
}

export const Route = createFileRoute("/api/public/tryon")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      POST: async ({ request }) => {
        const url = new URL(request.url);
        const requested = (url.searchParams.get("model") || "idm").toLowerCase();
        const model = (MODELS as readonly string[]).includes(requested)
          ? (requested as ModelId)
          : "idm";

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
            return json({ error: `${name} must be JPEG, PNG, or WebP` }, 415);
        }

        const hfToken = process.env.HF_TOKEN;

        try {
          const raw = await withTimeout(
            runModel(model, person, garment, description, hfToken),
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
          console.warn(`[tryon:${model}] failed:`, msg);
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
          // No more models — hard failure the UI must surface.
          return json(
            {
              error: nxt
                ? `AI try-on model ${MODEL_LABELS[model]} failed.`
                : "All AI try-on models are currently unavailable. Please try again shortly.",
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
