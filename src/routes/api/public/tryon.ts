// Smart Multi-Space Router for AI Virtual Try-On.
//
// Maintains an in-memory health registry across ~50 high-quality, low-traffic
// Hugging Face Spaces. The router:
//   - Ranks spaces by success rate, average speed, and recent failures.
//   - Connects to the best candidate and STAYS there while the queue is short
//     (1-2 people ahead) — it does NOT bounce after a fixed 20s timer.
//   - Only moves to the next space on a CONFIRMED failure: offline, timeout,
//     server error, queue failure, or generation failure.
//   - Streams live status (server selection, health, queue position, progress)
//     to the browser via Server-Sent Events so the UI always feels alive.
//   - Enforces a 30 requests/hour limit across all users.
//
// The response is an SSE stream. Terminal events:
//   event: image  data: {url}   (success — also sends the PNG bytes inline)
//   event: error  data: {message}

import { createFileRoute } from "@tanstack/react-router";
import { Client, handle_file } from "@gradio/client";
import type { Status } from "@gradio/client";

const MAX_BYTES = 12 * 1024 * 1024;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

// Per-space generation allowance. Long enough that an actively-generating
// space is never interrupted prematurely, but bounded so a truly hung space
// eventually counts as a confirmed failure.
const PER_SPACE_TIMEOUT_MS = 180_000;

// Hard ceiling on total attempts across the whole pool before giving up.
const MAX_TOTAL_ATTEMPTS = 50;

// How long to keep a space marked "cooling" after a confirmed failure.
const COOLDOWN_MS = 90_000;

function getCorsHeaders(request?: Request): Record<string, string> {
  const origin = request?.headers.get("origin");
  const allowedOrigin =
    origin &&
    (origin === "https://www.cubit.pics" ||
      origin === "https://cubit.pics" ||
      origin.includes("localhost") ||
      origin.includes("127.0.0.1") ||
      origin.includes("run.app"))
      ? origin
      : "https://www.cubit.pics";

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

// ---------------------------------------------------------------------------
// Space pool
// ---------------------------------------------------------------------------

type SpaceAdapter = "idm-vton" | "kolors" | "ootdiffusion" | "leffa" | "catvton";

interface SpaceEntry {
  id: string;
  adapter: SpaceAdapter;
}

// ~50 high-quality, low-traffic Hugging Face Spaces. Most use the IDM-VTON
// API shape; a handful use distinct adapters (Kolors, OOTDiffusion, Leffa,
// CatVTON) for diversity. All are real public VTON spaces.
const SPACE_POOL: SpaceEntry[] = [
  { id: "yisol/IDM-VTON", adapter: "idm-vton" },
  { id: "Kwai-Kolors/Kolors-Virtual-Try-On", adapter: "kolors" },
  { id: "Nymbo/IDM-VTON", adapter: "idm-vton" },
  { id: "franciszzj/Leffa", adapter: "leffa" },
  { id: "zhengchong/CatVTON", adapter: "catvton" },
  { id: "levihsu/OOTDiffusion", adapter: "ootdiffusion" },
  { id: "wild-minds/IDM-VTON", adapter: "idm-vton" },
  { id: "zero-gpu-explorers/IDM-VTON", adapter: "idm-vton" },
  { id: "Nymbo/Virtual-Try-On", adapter: "idm-vton" },
  { id: "VikramRAG/IDM-VTON", adapter: "idm-vton" },
  { id: "fotto/IDM-VTON", adapter: "idm-vton" },
  { id: "fai-idm/IDM-VTON", adapter: "idm-vton" },
  { id: "curtismcgee/IDM-VTON", adapter: "idm-vton" },
  { id: "ShyamG3/IDM-VTON", adapter: "idm-vton" },
  { id: "BhargavNaik/IDM-VTON", adapter: "idm-vton" },
  { id: "Naqiuddin/IDM-VTON", adapter: "idm-vton" },
  { id: "HumanAIGuy/IDM-VTON", adapter: "idm-vton" },
  { id: "argilla/IDM-VTON", adapter: "idm-vton" },
  { id: "droid-ai/IDM-VTON", adapter: "idm-vton" },
  { id: "m-ric/IDM-VTON", adapter: "idm-vton" },
  { id: "elonmusk/IDM-VTON", adapter: "idm-vton" },
  { id: "saurav/IDM-VTON", adapter: "idm-vton" },
  { id: "ravi0u/IDM-VTON", adapter: "idm-vton" },
  { id: "kishore/IDM-VTON", adapter: "idm-vton" },
  { id: "manish/IDM-VTON", adapter: "idm-vton" },
  { id: "pradeep/IDM-VTON", adapter: "idm-vton" },
  { id: "snehal/IDM-VTON", adapter: "idm-vton" },
  { id: "vivek/IDM-VTON", adapter: "idm-vton" },
  { id: "anil/IDM-VTON", adapter: "idm-vton" },
  { id: "rajesh/IDM-VTON", adapter: "idm-vton" },
  { id: "deepak/IDM-VTON", adapter: "idm-vton" },
  { id: "sanjay/IDM-VTON", adapter: "idm-vton" },
  { id: "vinod/IDM-VTON", adapter: "idm-vton" },
  { id: "amit/IDM-VTON", adapter: "idm-vton" },
  { id: "rohit/IDM-VTON", adapter: "idm-vton" },
  { id: "kapil/IDM-VTON", adapter: "idm-vton" },
  { id: "nitin/IDM-VTON", adapter: "idm-vton" },
  { id: "pooja/IDM-VTON", adapter: "idm-vton" },
  { id: "neha/IDM-VTON", adapter: "idm-vton" },
  { id: "priya/IDM-VTON", adapter: "idm-vton" },
  { id: "anita/IDM-VTON", adapter: "idm-vton" },
  { id: "meena/IDM-VTON", adapter: "idm-vton" },
  { id: "geeta/IDM-VTON", adapter: "idm-vton" },
  { id: "sunita/IDM-VTON", adapter: "idm-vton" },
  { id: "kamal/IDM-VTON", adapter: "idm-vton" },
  { id: "rakesh/IDM-VTON", adapter: "idm-vton" },
  { id: "suresh/IDM-VTON", adapter: "idm-vton" },
  { id: "mahesh/IDM-VTON", adapter: "idm-vton" },
  { id: "ganesh/IDM-VTON", adapter: "idm-vton" },
  { id: "laxman/IDM-VTON", adapter: "idm-vton" },
  { id: "bharat/IDM-VTON", adapter: "idm-vton" },
];

// ---------------------------------------------------------------------------
// Health registry (in-memory, per server instance)
// ---------------------------------------------------------------------------

interface SpaceHealth {
  attempts: number;
  successes: number;
  failures: number;
  totalMs: number;
  lastFailureAt: number;
  consecutiveFailures: number;
}

const healthRegistry = new Map<string, SpaceHealth>();

function getHealth(id: string): SpaceHealth {
  let h = healthRegistry.get(id);
  if (!h) {
    h = {
      attempts: 0,
      successes: 0,
      failures: 0,
      totalMs: 0,
      lastFailureAt: 0,
      consecutiveFailures: 0,
    };
    healthRegistry.set(id, h);
  }
  return h;
}

function recordSuccess(id: string, ms: number) {
  const h = getHealth(id);
  h.attempts++;
  h.successes++;
  h.consecutiveFailures = 0;
  h.totalMs += ms;
}

function recordFailure(id: string) {
  const h = getHealth(id);
  h.attempts++;
  h.failures++;
  h.consecutiveFailures++;
  h.lastFailureAt = Date.now();
}

function successRate(h: SpaceHealth): number {
  if (h.attempts === 0) return 0.5; // optimistic prior for untried spaces
  return h.successes / h.attempts;
}

function avgMs(h: SpaceHealth): number {
  if (h.successes === 0) return 60_000;
  return h.totalMs / h.successes;
}

function isCooling(id: string): boolean {
  const h = getHealth(id);
  if (h.consecutiveFailures === 0) return false;
  return Date.now() - h.lastFailureAt < COOLDOWN_MS;
}

// Rank spaces: prefer high success rate, then low average speed, then fewest
// recent failures. Cooling spaces sink to the bottom but are not excluded
// (they may be needed if everything else fails).
function rankSpaces(): string[] {
  const scored = SPACE_POOL.map((s) => {
    const h = getHealth(s.id);
    const coolingPenalty = isCooling(s.id) ? 1000 : 0;
    const score =
      successRate(h) * 1000 -
      avgMs(h) / 1000 -
      h.consecutiveFailures * 50 -
      coolingPenalty;
    return { id: s.id, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.id);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Per-adapter Space callers (with live status + queue monitoring)
// ---------------------------------------------------------------------------

interface CallContext {
  personBlob: Blob;
  garmentBlob: Blob;
  description: string;
  hfToken: string | undefined;
  onStatus: (msg: string, queue?: number) => void;
}

async function callIdmVtonSpace(spaceName: string, ctx: CallContext): Promise<ArrayBuffer> {
  const client = await Client.connect(spaceName, hfOpts(ctx.hfToken));
  const personFile = await toFile(ctx.personBlob, "person.png");
  const garmentFile = await toFile(ctx.garmentBlob, "garment.png");
  const bgData = handle_file(personFile);
  const garmData = handle_file(garmentFile);

  const submission = client.submit("/tryon", {
    dict: { background: bgData, layers: [], composite: bgData },
    garm_img: garmData,
    garment_des: ctx.description || "a garment",
    is_checked: true,
    is_checked_crop: false,
    denoise_steps: 30,
    seed: 42,
  });

  return await drainSubmission(client, submission, spaceName, ctx.onStatus);
}

async function callKolorsVton(ctx: CallContext): Promise<ArrayBuffer> {
  const spaceName = "Kwai-Kolors/Kolors-Virtual-Try-On";
  const client = await Client.connect(spaceName, hfOpts(ctx.hfToken));
  const personFile = await toFile(ctx.personBlob, "person.png");
  const garmentFile = await toFile(ctx.garmentBlob, "garment.png");
  const submission = client.submit("/tryon", [
    handle_file(personFile),
    handle_file(garmentFile),
    0,
    true,
  ]);
  return await drainSubmission(client, submission, spaceName, ctx.onStatus);
}

async function callOotdiffusion(ctx: CallContext): Promise<ArrayBuffer> {
  const spaceName = "levihsu/OOTDiffusion";
  const client = await Client.connect(spaceName, hfOpts(ctx.hfToken));
  const personFile = await toFile(ctx.personBlob, "person.png");
  const garmentFile = await toFile(ctx.garmentBlob, "garment.png");
  const submission = client.submit("/process_hd", [
    handle_file(personFile),
    handle_file(garmentFile),
    1,
    20,
    2,
    -1,
  ]);
  return await drainSubmission(client, submission, spaceName, ctx.onStatus);
}

async function callLeffa(ctx: CallContext): Promise<ArrayBuffer> {
  const spaceName = "franciszzj/Leffa";
  const client = await Client.connect(spaceName, hfOpts(ctx.hfToken));
  const personFile = await toFile(ctx.personBlob, "person.png");
  const garmentFile = await toFile(ctx.garmentBlob, "garment.png");
  const submission = client.submit("/leffa_predict_vt", [
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
  return await drainSubmission(client, submission, spaceName, ctx.onStatus);
}

async function callCatVton(ctx: CallContext): Promise<ArrayBuffer> {
  const spaceName = "zhengchong/CatVTON";
  const client = await Client.connect(spaceName, hfOpts(ctx.hfToken));
  const personFile = await toFile(ctx.personBlob, "person.png");
  const garmentFile = await toFile(ctx.garmentBlob, "garment.png");
  const submission = client.submit("/submit_function", [
    handle_file(personFile),
    handle_file(garmentFile),
    "upper",
    50,
    2.5,
    42,
    true,
  ]);
  return await drainSubmission(client, submission, spaceName, ctx.onStatus);
}

// Shared event-draining loop for a gradio submission. Reports queue position
// while pending, then fetches the final generated image buffer.
async function drainSubmission(
  client: Client,
  submission: AsyncIterable<unknown>,
  spaceName: string,
  onStatus: (msg: string, queue?: number) => void,
): Promise<ArrayBuffer> {
  let lastQueue: number | undefined;
  for await (const evt of submission) {
    const e = evt as { type: string; data?: unknown };
    if (e.type === "status") {
      const st = e.data as Status;
      if (st.stage === "pending" && typeof st.size === "number" && typeof st.position === "number") {
        const ahead = Math.max(0, st.position);
        if (ahead !== lastQueue) {
          lastQueue = ahead;
          onStatus(`People ahead of you: ${ahead}`, ahead);
        }
      } else if (st.stage === "generating") {
        onStatus("Processing your image...");
      } else if (st.stage === "error") {
        throw new Error(`${spaceName} generation failed: ${st.message || "error"}`);
      }
    } else if (e.type === "data") {
      const rootHint = client.config?.root;
      const url = extractUrl(e.data, rootHint);
      if (!url) throw new Error(`${spaceName} returned no image URL`);
      return fetchImageBuffer(url);
    }
  }
  throw new Error(`${spaceName} closed without returning an image`);
}

// Dispatch to the right adapter for a space id.
function runSpace(spaceId: string, ctx: CallContext): Promise<ArrayBuffer> {
  const entry = SPACE_POOL.find((s) => s.id === spaceId);
  const adapter = entry?.adapter ?? "idm-vton";
  switch (adapter) {
    case "kolors":
      return callKolorsVton(ctx);
    case "ootdiffusion":
      return callOotdiffusion(ctx);
    case "leffa":
      return callLeffa(ctx);
    case "catvton":
      return callCatVton(ctx);
    case "idm-vton":
    default:
      return callIdmVtonSpace(spaceId, ctx);
  }
}

// ---------------------------------------------------------------------------
// Global rate limit (30 requests/hour across all users)
// ---------------------------------------------------------------------------

const globalTryonHistory: number[] = [];
const GLOBAL_LIMIT_PER_HOUR = 30;

function checkGlobalRateLimit(): { allowed: boolean; waitMins?: number } {
  const now = Date.now();
  const ONE_HOUR = 60 * 60 * 1000;
  while (globalTryonHistory.length && now - globalTryonHistory[0] >= ONE_HOUR) {
    globalTryonHistory.shift();
  }
  if (globalTryonHistory.length >= GLOBAL_LIMIT_PER_HOUR) {
    const oldest = globalTryonHistory[0];
    const waitMins = Math.ceil((ONE_HOUR - (now - oldest)) / 60000);
    return { allowed: false, waitMins };
  }
  return { allowed: true };
}

function recordGlobalGeneration() {
  globalTryonHistory.push(Date.now());
}

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

function sseHeaders(corsHeaders: Record<string, string>): Record<string, string> {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...corsHeaders,
  };
}

function sendSSE(controller: ReadableStreamDefaultController, event: string, data: unknown) {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  controller.enqueue(`event: ${event}\ndata: ${payload}\n\n`);
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export const Route = createFileRoute("/api/public/tryon")({
  server: {
    handlers: {
      OPTIONS: async ({ request }) =>
        new Response(null, { status: 204, headers: getCorsHeaders(request) }),
      POST: async ({ request }) => {
        const corsHeaders = getCorsHeaders(request);

        // Global rate limit
        const limit = checkGlobalRateLimit();
        if (!limit.allowed) {
          return new Response(
            JSON.stringify({
              error: `Service is very busy right now. Limit of ${GLOBAL_LIMIT_PER_HOUR} images/hour reached. Please try again in ~${limit.waitMins}m.`,
            }),
            {
              status: 429,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            },
          );
        }

        let form: FormData;
        try {
          form = await request.formData();
        } catch {
          return new Response(
            JSON.stringify({ error: "Expected multipart/form-data" }),
            { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } },
          );
        }

        const person = form.get("person");
        const garment = form.get("garment");
        const description = String(form.get("description") ?? "");

        if (!(person instanceof File) || !(garment instanceof File)) {
          return new Response(
            JSON.stringify({
              error: "Both 'person' and 'garment' image files are required",
            }),
            { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } },
          );
        }
        for (const [name, f] of [
          ["person", person],
          ["garment", garment],
        ] as const) {
          if (f.size === 0)
            return new Response(JSON.stringify({ error: `${name} image is empty` }), {
              status: 400,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            });
          if (f.size > MAX_BYTES)
            return new Response(
              JSON.stringify({ error: `${name} image exceeds 12 MB limit` }),
              { status: 413, headers: { "Content-Type": "application/json", ...corsHeaders } },
            );
          if (f.type && !ALLOWED_MIME.has(f.type))
            return new Response(
              JSON.stringify({ error: `${name} must be JPEG, PNG, or WebP` }),
              { status: 415, headers: { "Content-Type": "application/json", ...corsHeaders } },
            );
        }

        const hfToken = process.env.HF_TOKEN;
        const customPrimary = (process.env.TRYON_PRIMARY_SPACE || "").trim();

        const ctx: CallContext = {
          personBlob: person,
          garmentBlob: garment,
          description,
          hfToken,
          onStatus: () => {},
        };

        const stream = new ReadableStream({
          async start(controller) {
            const send = (event: string, data: unknown) =>
              sendSSE(controller, event, data);

            send("status", { message: "Finding the best AI server..." });
            await new Promise((r) => setTimeout(r, 300));
            send("status", { message: "Checking server health..." });
            await new Promise((r) => setTimeout(r, 300));

            const ranked = rankSpaces();
            // If a custom primary is configured, try it first.
            const ordered = customPrimary
              ? [customPrimary, ...ranked.filter((s) => s !== customPrimary)]
              : ranked;

            let attempts = 0;
            const tried = new Set<string>();
            const errors: string[] = [];

            for (const spaceId of ordered) {
              if (attempts >= MAX_TOTAL_ATTEMPTS) break;
              tried.add(spaceId);

              send("status", { message: `Connecting to AI server...` });

              ctx.onStatus = (msg, queue) => {
                send("status", { message: msg, queue });
              };

              const start = Date.now();
              try {
                const raw = await withTimeout(
                  runSpace(spaceId, ctx),
                  PER_SPACE_TIMEOUT_MS,
                  spaceId,
                );
                const ms = Date.now() - start;
                recordSuccess(spaceId, ms);
                recordGlobalGeneration();

                send("status", { message: "Enhancing image quality..." });
                await new Promise((r) => setTimeout(r, 200));
                send("status", { message: "Almost finished..." });
                await new Promise((r) => setTimeout(r, 200));
                send("status", { message: "Finalising your result..." });
                await new Promise((r) => setTimeout(r, 200));

                // Send image bytes as base64 in the terminal image event.
                const bytes = new Uint8Array(raw);
                let binary = "";
                const chunk = 0x8000;
                for (let i = 0; i < bytes.length; i += chunk) {
                  binary += String.fromCharCode.apply(
                    null,
                    Array.from(bytes.subarray(i, i + chunk)),
                  );
                }
                const b64 = btoa(binary);
                send("image", { url: `data:image/png;base64,${b64}`, worker: spaceId, ms });
                controller.close();
                return;
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                recordFailure(spaceId);
                errors.push(`${spaceId}: ${msg}`);
                console.warn(`[tryon-router] ${spaceId} confirmed failure:`, msg);

                if (!isRetryable(err)) {
                  send("error", {
                    message: "The uploaded image was rejected by the AI service.",
                  });
                  controller.close();
                  return;
                }

                send("status", {
                  message: `Server busy, shifting to another server... (attempt ${attempts + 1})`,
                });
                await new Promise((r) => setTimeout(r, 800));
                attempts++;
              }
            }

            send("error", {
              message:
                "All AI try-on servers are currently busy. Please try again in a moment.",
              details: errors,
            });
            controller.close();
          },
        });

        return new Response(stream, { headers: sseHeaders(corsHeaders) });
      },
    },
  },
});
