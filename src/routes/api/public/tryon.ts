// Virtual try-on proxy — authenticated Hugging Face Space calls with an
// automatic multi-worker failover chain. If the primary Space is busy,
// sleeping, rate-limited, or returns an error, the request is transparently
// retried against compatible backup Spaces until one succeeds or all fail.
//
// Primary + backups (all public, free-tier, gradio predict API):
//   1. yisol/IDM-VTON                          (primary — quality reference)
//   2. yisol/IDM-VTON                          (single quick retry)
//   3. Kwai-Kolors/Kolors-Virtual-Try-On       (ZeroGPU, reliable)
//   4. levihsu/OOTDiffusion                    (high-quality diffusion VTON)
//   5. franciszzj/Leffa                        (newer VTON, low traffic)
//
// Optional env var TRYON_PRIMARY_SPACE lets the user prepend their own
// duplicated Space (e.g. "myuser/IDM-VTON") without a code change.

import { createFileRoute } from "@tanstack/react-router";
import { Client, handle_file } from "@gradio/client";

const MAX_BYTES = 12 * 1024 * 1024;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const PER_ATTEMPT_TIMEOUT_MS = 90_000;
const BACKOFF_MS = 1_500;

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

// A worker failure is "retryable" (try next worker) unless it's clearly our
// own client-side validation error — those we don't have here, since we
// validate before the failover loop begins.
function isRetryable(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  // Explicit non-retryable signals from gradio/HF (rare).
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
  if (!res.ok) throw new Error(`Fetch generated image failed (${res.status})`);
  const buf = await res.arrayBuffer();
  const out = new ArrayBuffer(buf.byteLength);
  new Uint8Array(out).set(new Uint8Array(buf));
  return out;
}

type HfAuth = Record<string, never> | undefined;
function hfOpts(token: string | undefined): HfAuth {
  return token
    ? ({ hf_token: token } as unknown as Record<string, never>)
    : undefined;
}

async function toFile(blob: Blob, name: string): Promise<File> {
  return new File([await blob.arrayBuffer()], name, {
    type: blob.type || "image/png",
  });
}

// --- Worker adapters ------------------------------------------------------

async function callIdmVton(
  space: string,
  personBlob: Blob,
  garmentBlob: Blob,
  description: string,
  hfToken: string | undefined,
): Promise<ArrayBuffer> {
  const client = await Client.connect(space, hfOpts(hfToken));
  const personFile = await toFile(personBlob, "person.png");
  const garmentFile = await toFile(garmentBlob, "garment.png");
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
  if (!url) throw new Error(`${space} returned no image URL`);
  return fetchImageBuffer(url);
}

async function callKolorsVton(
  personBlob: Blob,
  garmentBlob: Blob,
  hfToken: string | undefined,
): Promise<ArrayBuffer> {
  const client = await Client.connect(
    "Kwai-Kolors/Kolors-Virtual-Try-On",
    hfOpts(hfToken),
  );
  const personFile = await toFile(personBlob, "person.png");
  const garmentFile = await toFile(garmentBlob, "garment.png");
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

async function callOotdiffusion(
  personBlob: Blob,
  garmentBlob: Blob,
  hfToken: string | undefined,
): Promise<ArrayBuffer> {
  const client = await Client.connect("levihsu/OOTDiffusion", hfOpts(hfToken));
  const personFile = await toFile(personBlob, "person.png");
  const garmentFile = await toFile(garmentBlob, "garment.png");
  // /process_hd — half-body single-endpoint flow. Args: vton_img, garm_img,
  // n_samples, n_steps, image_scale, seed.
  const result = await client.predict("/process_hd", [
    handle_file(personFile),
    handle_file(garmentFile),
    1, // n_samples
    20, // n_steps
    2, // image_scale
    -1, // seed (random)
  ]);
  const rootHint = client.config?.root;
  const url = extractUrl((result as { data?: unknown }).data, rootHint);
  if (!url) throw new Error("OOTDiffusion returned no image URL");
  return fetchImageBuffer(url);
}

async function callLeffa(
  personBlob: Blob,
  garmentBlob: Blob,
  hfToken: string | undefined,
): Promise<ArrayBuffer> {
  const client = await Client.connect("franciszzj/Leffa", hfOpts(hfToken));
  const personFile = await toFile(personBlob, "person.png");
  const garmentFile = await toFile(garmentBlob, "garment.png");
  // Leffa VTON endpoint accepts src_image, ref_image, ref_acceleration,
  // step, scale, seed, vt_model_type, vt_garment_type, vt_repaint.
  const result = await client.predict("/leffa_predict_vt", [
    handle_file(personFile),
    handle_file(garmentFile),
    false,
    30,
    2.5,
    42,
    "viton_hd",
    "upper_body",
    false,
  ]);
  const rootHint = client.config?.root;
  const url = extractUrl((result as { data?: unknown }).data, rootHint);
  if (!url) throw new Error("Leffa returned no image URL");
  return fetchImageBuffer(url);
}

// --- Route ---------------------------------------------------------------

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
          return json(
            { error: "Both 'person' and 'garment' image files are required" },
            400,
          );
        }
        for (const [name, f] of [
          ["person", person],
          ["garment", garment],
        ] as const) {
          if (f.size === 0)
            return json({ error: `${name} image is empty` }, 400);
          if (f.size > MAX_BYTES)
            return json({ error: `${name} image exceeds 12 MB limit` }, 413);
          if (f.type && !ALLOWED_MIME.has(f.type))
            return json({ error: `${name} must be JPEG, PNG, or WebP` }, 415);
        }

        const hfToken = process.env.HF_TOKEN;
        const customPrimary = (process.env.TRYON_PRIMARY_SPACE || "").trim();
        const errors: string[] = [];

        const attempts: Array<{
          name: string;
          run: () => Promise<ArrayBuffer>;
        }> = [];

        // Optional custom primary (e.g. user's duplicated Space, IDM-VTON API).
        if (customPrimary) {
          attempts.push({
            name: `custom:${customPrimary}`,
            run: () =>
              callIdmVton(customPrimary, person, garment, description, hfToken),
          });
        }

        attempts.push(
          {
            name: "IDM-VTON",
            run: () =>
              callIdmVton(
                "yisol/IDM-VTON",
                person,
                garment,
                description,
                hfToken,
              ),
          },
          {
            name: "IDM-VTON retry",
            run: () =>
              callIdmVton(
                "yisol/IDM-VTON",
                person,
                garment,
                description,
                hfToken,
              ),
          },
          {
            name: "Kolors-VTON",
            run: () => callKolorsVton(person, garment, hfToken),
          },
          {
            name: "OOTDiffusion",
            run: () => callOotdiffusion(person, garment, hfToken),
          },
          { name: "Leffa", run: () => callLeffa(person, garment, hfToken) },
        );

        for (let i = 0; i < attempts.length; i++) {
          const attempt = attempts[i];
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
            console.warn(`[tryon] ${attempt.name} failed:`, msg);
            errors.push(`${attempt.name}: ${msg}`);
            if (!isRetryable(err)) break;
            // Small backoff before same-Space retry only.
            if (attempt.name.endsWith("retry")) {
              await new Promise((r) => setTimeout(r, BACKOFF_MS));
            }
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
