// Virtual try-on proxy — authenticated Hugging Face Space calls with a
// second free Space as a fallback. Never returns a low-quality local
// composite; on real failure returns a JSON 502 the UI can surface.

import { createFileRoute } from "@tanstack/react-router";
import { Client, handle_file } from "@gradio/client";

const MAX_BYTES = 12 * 1024 * 1024;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const PER_ATTEMPT_TIMEOUT_MS = 90_000;

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
  if (!res.ok) throw new Error(`Fetch generated image failed (${res.status})`);
  const buf = await res.arrayBuffer();
  // Ensure ArrayBuffer (not SharedArrayBuffer) — copy is cheap and keeps TS happy.
  const out = new ArrayBuffer(buf.byteLength);
  new Uint8Array(out).set(new Uint8Array(buf));
  return out;
}

async function callIdmVton(
  personBlob: Blob,
  garmentBlob: Blob,
  description: string,
  hfToken: string | undefined,
): Promise<ArrayBuffer> {
  const client = await Client.connect(
    "yisol/IDM-VTON",
    hfToken ? ({ hf_token: hfToken } as unknown as Record<string, never>) : undefined,
  );
  const personFile = new File([await personBlob.arrayBuffer()], "person.png", {
    type: personBlob.type || "image/png",
  });
  const garmentFile = new File([await garmentBlob.arrayBuffer()], "garment.png", {
    type: garmentBlob.type || "image/png",
  });
  const bgData = handle_file(personFile);
  const garmData = handle_file(garmentFile);

  const result = await client.predict("/tryon", {
    dict: { background: bgData, layers: [], composite: bgData },
    garm_img: garmData,
    garment_des: description || "a garment",
    is_checked: true,
    is_checked_crop: false,
    denoise_steps: 30,
    seed: 42,
  });
  const rootHint = client.config?.root;
  const url = extractUrl((result as { data?: unknown }).data, rootHint);
  if (!url) throw new Error("IDM-VTON returned no image URL");
  return fetchImageBuffer(url);
}

async function callKolorsVton(
  personBlob: Blob,
  garmentBlob: Blob,
  hfToken: string | undefined,
): Promise<ArrayBuffer> {
  // Kwai-Kolors/Kolors-Virtual-Try-On — free public Space, simpler API.
  const client = await Client.connect(
    "Kwai-Kolors/Kolors-Virtual-Try-On",
    hfToken ? ({ hf_token: hfToken } as unknown as Record<string, never>) : undefined,
  );
  const personFile = new File([await personBlob.arrayBuffer()], "person.png", {
    type: personBlob.type || "image/png",
  });
  const garmentFile = new File([await garmentBlob.arrayBuffer()], "garment.png", {
    type: garmentBlob.type || "image/png",
  });
  const result = await client.predict("/tryon", [
    handle_file(personFile),
    handle_file(garmentFile),
    0, // seed
    true, // random seed
  ]);
  const rootHint = client.config?.root;
  const url = extractUrl((result as { data?: unknown }).data, rootHint);
  if (!url) throw new Error("Kolors returned no image URL");
  return fetchImageBuffer(url);
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
            return json({ error: `${name} must be JPEG, PNG, or WebP` }, 415);
        }

        const hfToken = process.env.HF_TOKEN;
        const errors: string[] = [];

        const attempts: Array<{ name: string; run: () => Promise<ArrayBuffer> }> = [
          {
            name: "IDM-VTON",
            run: () => callIdmVton(person, garment, description, hfToken),
          },
          {
            name: "IDM-VTON retry",
            run: () => callIdmVton(person, garment, description, hfToken),
          },
          {
            name: "Kolors-VTON",
            run: () => callKolorsVton(person, garment, hfToken),
          },
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
            console.warn(`[tryon] ${attempt.name} failed:`, msg);
            errors.push(`${attempt.name}: ${msg}`);
          }
        }

        return json(
          {
            error:
              "The AI try-on service is busy or unavailable right now. Please try again in a minute.",
            details: errors,
          },
          502,
        );
      },
    },
  },
});

