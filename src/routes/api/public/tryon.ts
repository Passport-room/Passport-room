// Virtual try-on proxy — authenticated Hugging Face Space calls with an
// automatic multi-worker failover chain that LOOPS continuously. If a worker
// is busy or times out, it instantly transfers to the next free space in the
// chain (up to MAX_ROUNDS passes) until the image is generated.
//
// High quality, low-traffic Hugging Face spaces:
//   1. yisol/IDM-VTON                     (primary — high quality reference)
//   2. Kwai-Kolors/Kolors-Virtual-Try-On  (ZeroGPU, very reliable)
//   3. Nymbo/IDM-VTON                     (low traffic IDM-VTON mirror)
//   4. franciszzj/Leffa                   (Leffa VTON, efficient)
//   5. zhengchong/CatVTON                 (CatVTON, fast)
//   6. wild-minds/IDM-VTON                (low traffic IDM-VTON clone)
//   7. zero-gpu-explorers/IDM-VTON        (ZeroGPU IDM-VTON mirror)
//   8. levihsu/OOTDiffusion               (OOTDiffusion VTON backup)

import { createFileRoute } from "@tanstack/react-router";
import { Client, handle_file } from "@gradio/client";

const MAX_BYTES = 12 * 1024 * 1024;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const PER_ATTEMPT_TIMEOUT_MS = 30_000; // 30s quick timeout so busy queues skip fast
const MAX_ROUNDS = 10; // loop through the entire chain 10 times until success

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
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

function isRetryable(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes("invalid input") || msg.includes("unsupported file")) return false;
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
const hfOpts = (t: string | undefined): HfAuth =>
  t ? ({ hf_token: t } as unknown as Record<string, never>) : undefined;

async function toFile(blob: Blob, name: string): Promise<File> {
  return new File([await blob.arrayBuffer()], name, {
    type: blob.type || "image/png",
  });
}

// --- Worker Adapters ---

async function callIdmVtonSpace(
  spaceName: string,
  personBlob: Blob,
  garmentBlob: Blob,
  description: string,
  hfToken: string | undefined,
): Promise<ArrayBuffer> {
  const client = await Client.connect(spaceName, hfOpts(hfToken));
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
  if (!url) throw new Error(`${spaceName} returned no image URL`);
  return fetchImageBuffer(url);
}

async function callKolorsVton(
  personBlob: Blob,
  garmentBlob: Blob,
  hfToken: string | undefined,
): Promise<ArrayBuffer> {
  const client = await Client.connect("Kwai-Kolors/Kolors-Virtual-Try-On", hfOpts(hfToken));
  const personFile = await toFile(personBlob, "person.png");
  const garmentFile = await toFile(garmentBlob, "garment.png");
  const result = await client.predict("/tryon", [
    handle_file(personFile),
    handle_file(garmentFile),
    0,
    true,
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
  const result = await client.predict("/process_hd", [
    handle_file(personFile),
    handle_file(garmentFile),
    1,
    20,
    2,
    -1,
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

async function callCatVton(
  personBlob: Blob,
  garmentBlob: Blob,
  hfToken: string | undefined,
): Promise<ArrayBuffer> {
  const client = await Client.connect("zhengchong/CatVTON", hfOpts(hfToken));
  const personFile = await toFile(personBlob, "person.png");
  const garmentFile = await toFile(garmentBlob, "garment.png");
  const result = await client.predict("/submit_function", [
    handle_file(personFile),
    handle_file(garmentFile),
    "upper",
    50,
    2.5,
    42,
    true,
  ]);
  const rootHint = client.config?.root;
  const url = extractUrl((result as { data?: unknown }).data, rootHint);
  if (!url) throw new Error("CatVTON returned no image URL");
  return fetchImageBuffer(url);
}

// --- Route ---------------------------------------------------------------

const tryonUsageMap = new Map<string, number[]>();

export const Route = createFileRoute("/api/public/tryon")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      POST: async ({ request }) => {
        const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "user";
        const now = Date.now();
        const ONE_HOUR = 60 * 60 * 1000;
        const ONE_DAY = 24 * 60 * 60 * 1000;

        let history = (tryonUsageMap.get(clientIp) || []).filter((ts) => now - ts < ONE_DAY);
        const recentHour = history.filter((ts) => now - ts < ONE_HOUR);

        if (recentHour.length >= 1) {
          const oldest = recentHour[0];
          const waitMins = Math.ceil((ONE_HOUR - (now - oldest)) / 60000);
          return json({ error: `Limit reached: Maximum 1 image per hour. Try again in ${waitMins}m.` }, 429);
        }
        if (history.length >= 5) {
          return json({ error: "Limit reached: Maximum 5 images per day." }, 429);
        }

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
        for (const [name, f] of [["person", person], ["garment", garment]] as const) {
          if (f.size === 0) return json({ error: `${name} image is empty` }, 400);
          if (f.size > MAX_BYTES) return json({ error: `${name} image exceeds 12 MB limit` }, 413);
          if (f.type && !ALLOWED_MIME.has(f.type))
            return json({ error: `${name} must be JPEG, PNG, or WebP` }, 415);
        }

        const hfToken = process.env.HF_TOKEN;
        const customPrimary = (process.env.TRYON_PRIMARY_SPACE || "").trim();
        const errors: string[] = [];

        const chain: Array<{ name: string; run: () => Promise<ArrayBuffer> }> = [];

        if (customPrimary) {
          chain.push({
            name: `custom:${customPrimary}`,
            run: () => callIdmVtonSpace(customPrimary, person, garment, description, hfToken),
          });
        }

        // Low-traffic & reliable Hugging Face Spaces failover chain
        chain.push(
          { name: "IDM-VTON",          run: () => callIdmVtonSpace("yisol/IDM-VTON", person, garment, description, hfToken) },
          { name: "Kolors-VTON",       run: () => callKolorsVton(person, garment, hfToken) },
          { name: "Nymbo-IDM-VTON",    run: () => callIdmVtonSpace("Nymbo/IDM-VTON", person, garment, description, hfToken) },
          { name: "Leffa",             run: () => callLeffa(person, garment, hfToken) },
          { name: "CatVTON",           run: () => callCatVton(person, garment, hfToken) },
          { name: "WildMinds-VTON",    run: () => callIdmVtonSpace("wild-minds/IDM-VTON", person, garment, description, hfToken) },
          { name: "ZeroGPU-IDM-VTON", run: () => callIdmVtonSpace("zero-gpu-explorers/IDM-VTON", person, garment, description, hfToken) },
          { name: "OOTDiffusion",      run: () => callOotdiffusion(person, garment, hfToken) },
        );

        for (let round = 1; round <= MAX_ROUNDS; round++) {
          for (const attempt of chain) {
            const label = round === 1 ? attempt.name : `${attempt.name} (retry ${round})`;
            try {
              const raw = await withTimeout(attempt.run(), PER_ATTEMPT_TIMEOUT_MS, label);
              history.push(now);
              tryonUsageMap.set(clientIp, history);
              return new Response(raw, {
                status: 200,
                headers: {
                  "Content-Type": "image/png",
                  "Cache-Control": "no-store",
                  "X-Worker": label,
                  ...CORS,
                },
              });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.warn(`[tryon] ${label} busy/failed:`, msg);
              errors.push(`${label}: ${msg}`);
              if (!isRetryable(err)) {
                return json(
                  { error: "The uploaded image was rejected by the AI service.", details: errors },
                  400,
                );
              }
            }
          }
        }

        return json(
          {
            error:
              "The AI try-on servers are currently busy. Retrying automatically...",
            details: errors,
          },
          502,
        );
      },
    },
  },
});
