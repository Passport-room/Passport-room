// Image enhance proxy — sczhou/CodeFormer face-restoration Space.
// Same request contract as before (FormData: image + upscale) so the
// existing public/enhance.js client needs no changes.

import { Client } from "@gradio/client";

const SPACE_ID = "sczhou/CodeFormer";
const MAX_BYTES = 12 * 1024 * 1024;
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);
const TIMEOUT_MS = 90_000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

const json = (b, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { "Content-Type": "application/json", ...CORS },
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractUrl(data) {
  if (!Array.isArray(data)) return undefined;
  for (const item of data) {
    if (!item) continue;
    if (typeof item === "string" && /^https?:\/\//.test(item)) return item;
    if (typeof item === "object") {
      const rec = item;
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

async function callSpaceOnce(image, upscale) {
  const client = await Client.connect(SPACE_ID);
  // sczhou/CodeFormer /inference — positional:
  // [image, pre_face_align, background_enhance, face_upsample, rescaling_factor, codeformer_fidelity]
  const result = await client.predict("/inference", [
    image,
    true,
    true,
    true,
    upscale,
    0.7,
  ]);
  const url = extractUrl(result?.data);
  if (!url) throw new Error("Space did not return an image URL");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch generated image ${res.status}`);
  return {
    buf: await res.arrayBuffer(),
    type: res.headers.get("content-type") || "image/png",
  };
}

const isTransient = (msg) =>
  /429|rate|queue|loading|starting|busy|502|503|504/i.test(msg);

async function callSpaceWithRetry(image, upscale) {
  const delays = [0, 5000];
  let lastErr = null;
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

export default async function handler(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "Expected multipart/form-data" }, 400);
  }
  const image = form.get("image");
  const upscale = Math.min(2, Math.max(1, Number(form.get("upscale") ?? 2) || 2));
  if (!(image instanceof File)) return json({ error: "image file required" }, 400);
  if (image.size === 0) return json({ error: "image is empty" }, 400);
  if (image.size > MAX_BYTES) return json({ error: "image exceeds 12 MB" }, 413);
  if (image.type && !ALLOWED.has(image.type))
    return json({ error: `unsupported type ${image.type}` }, 415);

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const raced = await Promise.race([
      callSpaceWithRetry(image, upscale),
      new Promise((_, rej) =>
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
    if (msg === "timeout") return json({ error: "AI took too long. Try again." }, 504);
    if (/429|rate|too many/i.test(msg))
      return json({ error: "Space is busy. Retry shortly." }, 429);
    if (/connect|loading|starting/i.test(msg))
      return json({ error: "The enhancer Space is starting up. Please retry in ~30 seconds." }, 503);
    return json({ error: `Space error: ${msg}` }, 502);
  } finally {
    clearTimeout(timer);
  }
}
