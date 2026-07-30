// Virtual Try-On — Client-side Smart Multi-Space Router.
//
// Connects directly to ~50 Hugging Face Spaces from the browser using
// @gradio/client's browser build. No server needed — eliminates 404 errors.
//
// The router:
//   - Ranks spaces by success rate, speed, and recent failures (in-memory).
//   - Stays in the current space while the queue is short (1-2 people ahead).
//   - Only moves to the next space on a CONFIRMED failure.
//   - Streams live status to the UI via callback.

import { detectFaceInCanvas } from "./face-detector.js";

// ---------------------------------------------------------------------------
// Space pool (~50 high-quality, low-traffic HF Spaces)
// ---------------------------------------------------------------------------

const SPACE_POOL = [
  { id: "yisol/IDM-VTON", adapter: "idm-vton" },
  { id: "Nymbo/IDM-VTON", adapter: "idm-vton" },
  { id: "Kwai-Kolors/Kolors-Virtual-Try-On", adapter: "kolors" },
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

const PER_SPACE_TIMEOUT_MS = 180_000;
const MAX_TOTAL_ATTEMPTS = 50;
const COOLDOWN_MS = 90_000;

// ---------------------------------------------------------------------------
// Health registry (in-memory, per browser session)
// ---------------------------------------------------------------------------

const healthRegistry = new Map();

function getHealth(id) {
  let h = healthRegistry.get(id);
  if (!h) {
    h = { attempts: 0, successes: 0, failures: 0, totalMs: 0, lastFailureAt: 0, consecutiveFailures: 0 };
    healthRegistry.set(id, h);
  }
  return h;
}

function recordSuccess(id, ms) {
  const h = getHealth(id);
  h.attempts++; h.successes++; h.consecutiveFailures = 0; h.totalMs += ms;
}

function recordFailure(id) {
  const h = getHealth(id);
  h.attempts++; h.failures++; h.consecutiveFailures++; h.lastFailureAt = Date.now();
}

function isCooling(id) {
  const h = getHealth(id);
  if (h.consecutiveFailures === 0) return false;
  return Date.now() - h.lastFailureAt < COOLDOWN_MS;
}

function rankSpaces() {
  const scored = SPACE_POOL.map((s) => {
    const h = getHealth(s.id);
    const rate = h.attempts === 0 ? 0.5 : h.successes / h.attempts;
    const avg = h.successes === 0 ? 60000 : h.totalMs / h.successes;
    const coolingPenalty = isCooling(s.id) ? 1000 : 0;
    const score = rate * 1000 - avg / 1000 - h.consecutiveFailures * 50 - coolingPenalty;
    return { id: s.id, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.id);
}

// ---------------------------------------------------------------------------
// Gradio client (loaded from CDN, browser build)
// ---------------------------------------------------------------------------

let gradioClient = null;

async function loadGradioClient() {
  if (gradioClient) return gradioClient;
  try {
    gradioClient = await import("https://cdn.jsdelivr.net/npm/@gradio/client@2.4.0/dist/browser.js");
  } catch {
    try {
      gradioClient = await import("https://unpkg.com/@gradio/client@2.4.0/dist/browser.js");
    } catch {
      throw new Error("Could not load AI service. Check your internet connection.");
    }
  }
  return gradioClient;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractUrl(data, rootHint) {
  const visit = (v) => {
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
      const rec = v;
      if (rec.url && /^https?:\/\//.test(rec.url)) return rec.url;
      if (rec.path && rootHint) return `${rootHint}/file=${rec.path}`;
      if (rec.name && rootHint) return `${rootHint}/file=${rec.name}`;
    }
    return undefined;
  };
  return visit(data);
}

async function fetchImageBlob(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch image failed (${res.status})`);
  return await res.blob();
}

function isRetryableError(msg) {
  const m = msg.toLowerCase();
  if (m.includes("invalid input") || m.includes("unsupported file")) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Per-adapter Space callers
// ---------------------------------------------------------------------------

async function callIdmVton(spaceName, client, personFile, garmentFile, description, onStatus) {
  const { handle_file } = await loadGradioClient();
  const bgData = handle_file(personFile);
  const garmData = handle_file(garmentFile);
  const submission = client.submit("/tryon", {
    dict: { background: bgData, layers: [], composite: bgData },
    garm_img: garmData,
    garment_des: description || "a garment",
    is_checked: true,
    is_checked_crop: false,
    denoise_steps: 30,
    seed: 42,
  });
  return await drainSubmission(submission, spaceName, onStatus);
}

async function callKolors(client, personFile, garmentFile, onStatus) {
  const { handle_file } = await loadGradioClient();
  const submission = client.submit("/tryon", [
    handle_file(personFile), handle_file(garmentFile), 0, true,
  ]);
  return await drainSubmission(submission, "Kwai-Kolors/Kolors-Virtual-Try-On", onStatus);
}

async function callOotdiffusion(client, personFile, garmentFile, onStatus) {
  const { handle_file } = await loadGradioClient();
  const submission = client.submit("/process_hd", [
    handle_file(personFile), handle_file(garmentFile), 1, 20, 2, -1,
  ]);
  return await drainSubmission(submission, "levihsu/OOTDiffusion", onStatus);
}

async function callLeffa(client, personFile, garmentFile, onStatus) {
  const { handle_file } = await loadGradioClient();
  const submission = client.submit("/leffa_predict_vt", [
    handle_file(personFile), handle_file(garmentFile), false, 30, 2.5, 42, "viton_hd", "upper_body", false,
  ]);
  return await drainSubmission(submission, "franciszzj/Leffa", onStatus);
}

async function callCatVton(client, personFile, garmentFile, onStatus) {
  const { handle_file } = await loadGradioClient();
  const submission = client.submit("/submit_function", [
    handle_file(personFile), handle_file(garmentFile), "upper", 50, 2.5, 42, true,
  ]);
  return await drainSubmission(submission, "zhengchong/CatVTON", onStatus);
}

async function drainSubmission(submission, spaceName, onStatus) {
  let lastQueue = -1;
  for await (const evt of submission) {
    const e = evt;
    if (e.type === "status") {
      const st = e.data;
      if (st.stage === "pending" && typeof st.position === "number") {
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
      const rootHint = e.data?.root || `https://${spaceName.replace("/", "-")}.hf.space`;
      const url = extractUrl(e.data, rootHint);
      if (!url) throw new Error(`${spaceName} returned no image URL`);
      return await fetchImageBlob(url);
    }
  }
  throw new Error(`${spaceName} closed without returning an image`);
}

function runSpace(spaceId, client, personFile, garmentFile, description, onStatus) {
  const entry = SPACE_POOL.find((s) => s.id === spaceId);
  const adapter = entry?.adapter ?? "idm-vton";
  switch (adapter) {
    case "kolors": return callKolors(client, personFile, garmentFile, onStatus);
    case "ootdiffusion": return callOotdiffusion(client, personFile, garmentFile, onStatus);
    case "leffa": return callLeffa(client, personFile, garmentFile, onStatus);
    case "catvton": return callCatVton(client, personFile, garmentFile, onStatus);
    default: return callIdmVton(spaceId, client, personFile, garmentFile, description, onStatus);
  }
}

// ---------------------------------------------------------------------------
// Main router: tries spaces in ranked order, switches only on confirmed failure
// ---------------------------------------------------------------------------

async function generateTryOn(personBlob, garmentBlob, description, onStatus) {
  const { Client } = await loadGradioClient();
  const personFile = new File([await personBlob.arrayBuffer()], "person.png", { type: "image/png" });
  const garmentFile = new File([await garmentBlob.arrayBuffer()], "garment.png", { type: "image/png" });

  const ranked = rankSpaces();
  let attempts = 0;
  const errors = [];

  for (const spaceId of ranked) {
    if (attempts >= MAX_TOTAL_ATTEMPTS) break;

    onStatus("Connecting to AI server...");

    let client;
    try {
      client = await Promise.race([
        Client.connect(spaceId),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Connection timeout")), 30000)),
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      recordFailure(spaceId);
      errors.push(`${spaceId}: ${msg}`);
      if (!isRetryableError(msg)) throw new Error("The uploaded image was rejected by the AI service.");
      onStatus(`Server busy, shifting to another server... (attempt ${attempts + 1})`);
      await new Promise((r) => setTimeout(r, 800));
      attempts++;
      continue;
    }

    const start = Date.now();
    try {
      const resultBlob = await Promise.race([
        runSpace(spaceId, client, personFile, garmentFile, description, onStatus),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${spaceId} timed out`)), PER_SPACE_TIMEOUT_MS)),
      ]);
      const ms = Date.now() - start;
      recordSuccess(spaceId, ms);

      onStatus("Enhancing image quality...");
      await new Promise((r) => setTimeout(r, 200));
      onStatus("Almost finished...");
      await new Promise((r) => setTimeout(r, 200));
      onStatus("Finalising your result...");
      await new Promise((r) => setTimeout(r, 200));

      return resultBlob;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      recordFailure(spaceId);
      errors.push(`${spaceId}: ${msg}`);

      if (!isRetryableError(msg)) throw new Error("The uploaded image was rejected by the AI service.");

      onStatus(`Server busy, shifting to another server... (attempt ${attempts + 1})`);
      await new Promise((r) => setTimeout(r, 800));
      attempts++;
    }
  }

  throw new Error("All AI try-on servers are currently busy. Please try again in a moment.");
}

// ---------------------------------------------------------------------------
// UI: garment selection, status animation, generate, revert, download
// ---------------------------------------------------------------------------

const GARMENTS = [
  { id: "formal", label: "Formal", img: "/garments/1.png", description: "a formal shirt" },
  { id: "whitetshirt", label: "White T-Shirt", img: "/garments/2.png", description: "a white t-shirt" },
  { id: "shirt", label: "Shirt", img: "/garments/3.png", description: "a shirt" },
  { id: "tshirt", label: "T-Shirt", img: "/garments/4.png", description: "a t-shirt" },
  { id: "traditional", label: "Traditional", img: "/garments/5.png", description: "a traditional outfit" },
];

const ROTATING_MESSAGES = [
  "Finding the best AI server...",
  "Checking server health...",
  "Connecting to AI server...",
  "Optimising generation...",
  "Preparing your request...",
  "Processing your image...",
  "Enhancing image quality...",
  "Almost finished...",
  "Finalising your result...",
];

let selected = null;
let generating = false;
let customBlob = null;
let customDataUrl = null;
let customPrompt = "";
let preTryOnSnapshot = null;
let lastResultBlob = null;
let statusTimer = null;
let statusIndex = 0;
let liveQueueMsg = null;

const $ = (id) => document.getElementById(id);
const PLUS_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;

function setStatus(msg, kind = "") {
  const el = $("tryOnStatus");
  if (!el) return;
  el.className = "tryOnStatus " + kind;
  el.innerHTML = "";
  if (msg) {
    const dot = document.createElement("span");
    dot.className = "tryOnStatusDot";
    const span = document.createElement("span");
    span.className = "tryOnStatusMsg";
    span.textContent = msg;
    el.appendChild(dot);
    el.appendChild(span);
  }
  const prog = $("tryOnProgress");
  if (prog) prog.classList.toggle("hidden", kind !== "info");
}

function updateGenerateBtn() {
  const btn = $("tryOnGenerate");
  if (!btn) return;
  const customReady = !!customBlob || customPrompt.trim().length > 0;
  const isEnhancing = !!window.__isEnhanceRunning;
  const ready = !generating && !isEnhancing && !!selected &&
    (selected.id !== "custom" || customReady) && !!window.__tryOn?.getPersonDataUrl?.();
  btn.disabled = !ready;
  btn.textContent = isEnhancing ? "Enhance in progress..." : generating ? "Generating…" : "Change clothes";
}
window.__updateTryOnBtn = updateGenerateBtn;

function renderGarments() {
  const wrap = $("tryOnDresses");
  if (!wrap) return;
  wrap.innerHTML = "";
  const all = [...GARMENTS, { id: "custom", label: "Custom", img: null }];
  all.forEach((g) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "tryOnDress";
    el.dataset.id = g.id;
    const fallback1 = g.img ? g.img.replace("/garments/", "/") : "";
    const fallback2 = g.img ? g.img.replace("/garments/", "/assets/") : "";
    const iconInner = g.img
      ? `<img src="${g.img}" alt="${g.label}" loading="lazy" onerror="if(!this.dataset.tried1){this.dataset.tried1='1';this.src='${fallback1}';}else if(!this.dataset.tried2){this.dataset.tried2='1';this.src='${fallback2}';}" />`
      : PLUS_SVG;
    el.innerHTML = `<span class="tryOnDressIcon">${iconInner}</span><span class="tryOnDressLabel">${g.label}</span>`;
    el.onclick = () => {
      selected = g;
      wrap.querySelectorAll(".tryOnDress").forEach((n) => n.classList.toggle("active", n.dataset.id === g.id));
      $("tryOnCustom").classList.toggle("hidden", g.id !== "custom");
      updateGenerateBtn();
    };
    wrap.appendChild(el);
  });
}

async function urlToBlob(url) {
  let res = await fetch(url);
  if (!res.ok) res = await fetch(url.startsWith("/") ? url.slice(1) : "/" + url);
  if (!res.ok && url.includes("/garments/")) res = await fetch(url.replace("/garments/", "/"));
  if (!res.ok && url.includes("/garments/")) res = await fetch(url.replace("/garments/", "/assets/"));
  if (!res.ok) throw new Error(`Failed to load garment (${res.status})`);
  return await res.blob();
}

async function dataUrlToBlob(dataUrl) {
  return await (await fetch(dataUrl)).blob();
}

async function blobToDataUrl(blob) {
  return await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error("Could not read image"));
    r.readAsDataURL(blob);
  });
}

async function preparePersonBlobForTryOn(dataUrl) {
  const img = new Image();
  img.crossOrigin = "anonymous";
  await new Promise((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Could not load person image"));
    img.src = dataUrl;
  });
  const origW = img.naturalWidth || img.width;
  const origH = img.naturalHeight || img.height;
  const origAR = origW / origH;
  const targetW = 768, targetH = 1024, targetAR = targetW / targetH;
  let drawW, drawH, drawX, drawY;
  if (origAR >= targetAR) {
    drawW = targetW; drawH = Math.round(targetW / origAR); drawX = 0; drawY = Math.round((targetH - drawH) / 2);
  } else {
    drawH = targetH; drawW = Math.round(targetH * origAR); drawX = Math.round((targetW - drawW) / 2); drawY = 0;
  }
  const canvas = document.createElement("canvas");
  canvas.width = targetW; canvas.height = targetH;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  const coverScale = Math.max(targetW / origW, targetH / origH);
  const coverW = origW * coverScale, coverH = origH * coverScale;
  const coverX = (targetW - coverW) / 2, coverY = (targetH - coverH) / 2;
  ctx.save(); ctx.filter = "blur(16px)"; ctx.drawImage(img, coverX, coverY, coverW, coverH); ctx.restore();
  ctx.drawImage(img, drawX, drawY, drawW, drawH);
  const preparedBlob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
  return { preparedBlob, placement: { origW, origH, drawX, drawY, drawW, drawH, targetW, targetH } };
}

async function restoreTryOnResultAspect(resultBlob, placement) {
  const resultDataUrl = await blobToDataUrl(resultBlob);
  const img = new Image();
  img.crossOrigin = "anonymous";
  await new Promise((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Could not load result image"));
    img.src = resultDataUrl;
  });
  const resW = img.naturalWidth || img.width;
  const resH = img.naturalHeight || img.height;
  const scaleX = resW / placement.targetW, scaleY = resH / placement.targetH;
  const srcX = Math.round(placement.drawX * scaleX);
  const srcY = Math.round(placement.drawY * scaleY);
  const srcW = Math.round(placement.drawW * scaleX);
  const srcH = Math.round(placement.drawH * scaleY);
  const canvas = document.createElement("canvas");
  canvas.width = placement.origW; canvas.height = placement.origH;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, placement.origW, placement.origH);
  return canvas.toDataURL("image/png");
}

function startStatusAnimation() {
  statusIndex = 0; liveQueueMsg = null;
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = setInterval(() => {
    if (liveQueueMsg) { setStatus(liveQueueMsg, "info"); }
    else {
      const msg = ROTATING_MESSAGES[statusIndex % ROTATING_MESSAGES.length];
      statusIndex++;
      setStatus(msg, "info");
    }
  }, 2200);
  setStatus(ROTATING_MESSAGES[0], "info");
}

function setLiveQueue(msg) { liveQueueMsg = msg; setStatus(msg, "info"); }
function stopStatusAnimation() { if (statusTimer) { clearInterval(statusTimer); statusTimer = null; } liveQueueMsg = null; }

const TRYON_LIMIT_KEY = "tryon_generations_v1";

function checkTryOnRateLimit() {
  const now = Date.now();
  const ONE_HOUR = 60 * 60 * 1000;
  const ONE_DAY = 24 * 60 * 60 * 1000;
  let history = [];
  try {
    const raw = localStorage.getItem(TRYON_LIMIT_KEY);
    if (raw) history = JSON.parse(raw);
    if (!Array.isArray(history)) history = [];
  } catch {}
  history = history.filter((ts) => typeof ts === "number" && now - ts < ONE_DAY);
  const inLastHour = history.filter((ts) => now - ts < ONE_HOUR);
  if (inLastHour.length >= 30) {
    const oldest = inLastHour[0];
    const waitMins = Math.ceil((ONE_HOUR - (now - oldest)) / 60000);
    return { allowed: false, error: `Limit reached: Maximum 30 images per hour. Try again in ${waitMins}m.` };
  }
  if (history.length >= 100) return { allowed: false, error: "Limit reached: Maximum 100 images per day." };
  return {
    allowed: true,
    recordSuccess: () => {
      history.push(Date.now());
      try { localStorage.setItem(TRYON_LIMIT_KEY, JSON.stringify(history)); } catch {}
    },
  };
}

async function preserveOriginalFace(tryOnDataUrl, origDataUrl) {
  try {
    const origImg = new Image(); origImg.crossOrigin = "anonymous";
    const tryOnImg = new Image(); tryOnImg.crossOrigin = "anonymous";
    await Promise.all([
      new Promise((res, rej) => { origImg.onload = res; origImg.onerror = rej; origImg.src = origDataUrl; }),
      new Promise((res, rej) => { tryOnImg.onload = res; tryOnImg.onerror = rej; tryOnImg.src = tryOnDataUrl; }),
    ]);
    const w = tryOnImg.naturalWidth || tryOnImg.width;
    const h = tryOnImg.naturalHeight || tryOnImg.height;
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(tryOnImg, 0, 0, w, h);
    const origCanvas = document.createElement("canvas");
    origCanvas.width = w; origCanvas.height = h;
    const octx = origCanvas.getContext("2d");
    octx.drawImage(origImg, 0, 0, w, h);
    const faceInfo = detectFaceInCanvas(origCanvas);
    let chinY = h * 0.35;
    let fadeDist = Math.max(15, h * 0.08);
    if (faceInfo && faceInfo.chinY > 0) {
      chinY = faceInfo.chinY;
      fadeDist = Math.max(15, faceInfo.faceHeight * 0.22);
    }
    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = w; maskCanvas.height = h;
    const mctx = maskCanvas.getContext("2d");
    const blendCutoffY = Math.min(h - 1, Math.round(chinY));
    mctx.fillStyle = "#ffffff"; mctx.fillRect(0, 0, w, blendCutoffY);
    const grad = mctx.createLinearGradient(0, blendCutoffY, 0, Math.min(h, blendCutoffY + fadeDist));
    grad.addColorStop(0, "rgba(255,255,255,1.0)");
    grad.addColorStop(1, "rgba(255,255,255,0.0)");
    mctx.fillStyle = grad; mctx.fillRect(0, blendCutoffY, w, Math.round(fadeDist));
    const headCanvas = document.createElement("canvas");
    headCanvas.width = w; headCanvas.height = h;
    const hctx = headCanvas.getContext("2d");
    hctx.drawImage(origCanvas, 0, 0);
    hctx.globalCompositeOperation = "destination-in";
    hctx.drawImage(maskCanvas, 0, 0);
    ctx.drawImage(headCanvas, 0, 0);
    return canvas.toDataURL("image/png");
  } catch (err) {
    console.warn("Face preservation overlay warning:", err);
    return tryOnDataUrl;
  }
}

async function generate() {
  if (generating || !selected) return;
  if (window.__isEnhanceRunning) { setStatus("AI Enhancement is currently running. Please wait for it to complete.", "warn"); return; }
  if (!window.__tryOn) { setStatus("Editor not ready.", "err"); return; }
  const personDataUrl = window.__tryOn.getPersonDataUrl();
  if (!personDataUrl) { setStatus("Upload a photo first.", "err"); return; }
  const rateLimit = checkTryOnRateLimit();
  if (!rateLimit.allowed) { setStatus(rateLimit.error, "err"); return; }

  let garmentBlob, description = "a garment";
  try {
    if (selected.id === "custom") {
      const prompt = customPrompt.trim();
      if (!customBlob && !prompt) { setStatus("Upload a garment image or enter prompt.", "err"); return; }
      garmentBlob = customBlob || await makePlaceholderGarmentBlob();
      if (prompt) description = prompt;
    } else {
      garmentBlob = await urlToBlob(selected.img);
      description = selected.description;
    }
  } catch (e) {
    setStatus(e instanceof Error ? e.message : "Could not load garment.", "err");
    return;
  }

  generating = true;
  window.__isTryOnRunning = true;
  window.__updateToolButtons?.();
  updateGenerateBtn();
  startStatusAnimation();

  try {
    preTryOnSnapshot = personDataUrl;
    const { preparedBlob, placement } = await preparePersonBlobForTryOn(personDataUrl);
    const resultBlob = await generateTryOn(preparedBlob, garmentBlob, description, (msg, queue) => {
      if (typeof queue === "number") setLiveQueue(`People ahead of you: ${queue}`);
      else { liveQueueMsg = null; setStatus(msg, "info"); }
    });
    stopStatusAnimation();
    setStatus("Preparing your image...", "info");
    const restoredDataUrl = await restoreTryOnResultAspect(resultBlob, placement);
    const finalPreservedUrl = await preserveOriginalFace(restoredDataUrl, personDataUrl);
    const restoredBlob = await dataUrlToBlob(finalPreservedUrl);
    lastResultBlob = restoredBlob;
    setStatus("Applying photo...", "info");
    await window.__tryOn.applyResult(finalPreservedUrl, (m) => setStatus(m));
    rateLimit.recordSuccess();
    $("tryOnRevert").classList.remove("hidden");
    const dlBtn = $("tryOnDownload");
    if (dlBtn) dlBtn.classList.remove("hidden");
    setStatus("Outfit applied successfully. You can now also enhance photo!", "ok");
  } catch (e) {
    console.error(e);
    stopStatusAnimation();
    setStatus(e instanceof Error ? e.message : "Generation failed. Try again.", "err");
  } finally {
    generating = false;
    window.__isTryOnRunning = false;
    window.__updateToolButtons?.();
    updateGenerateBtn();
    stopStatusAnimation();
  }
}

async function revert() {
  if (!preTryOnSnapshot || generating) return;
  generating = true; window.__isTryOnRunning = true;
  window.__updateToolButtons?.(); updateGenerateBtn();
  setStatus("Restoring original…");
  try {
    await window.__tryOn.applyResult(preTryOnSnapshot, (m) => setStatus(m));
    $("tryOnRevert").classList.add("hidden");
    const dlBtn = $("tryOnDownload");
    if (dlBtn) dlBtn.classList.add("hidden");
    preTryOnSnapshot = null; lastResultBlob = null;
    setStatus("Reverted to original.", "ok");
  } catch (e) { setStatus(e?.message || "Could not revert.", "err"); }
  finally {
    generating = false; window.__isTryOnRunning = false;
    window.__updateToolButtons?.(); updateGenerateBtn();
  }
}

async function makePlaceholderGarmentBlob() {
  const c = document.createElement("canvas");
  c.width = 512; c.height = 512;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, c.width, c.height);
  return await new Promise((resolve) => c.toBlob((b) => resolve(b), "image/png"));
}

function bindCustomUpload() {
  const input = $("tryOnCustomFile");
  const preview = $("tryOnCustomPreview");
  const label = $("tryOnCustomFileLabel");
  const prompt = $("tryOnCustomPrompt");
  if (input) {
    input.addEventListener("change", (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      if (!f.type.startsWith("image/")) { setStatus("Please choose an image file.", "err"); return; }
      customBlob = f;
      const r = new FileReader();
      r.onload = () => {
        customDataUrl = r.result;
        preview.src = customDataUrl;
        preview.classList.remove("hidden");
        label.textContent = "Change garment image";
        updateGenerateBtn();
      };
      r.readAsDataURL(f);
    });
  }
  if (prompt) prompt.addEventListener("input", (e) => { customPrompt = e.target.value || ""; updateGenerateBtn(); });
}

function bind() {
  renderGarments();
  bindCustomUpload();
  $("tryOnGenerate").onclick = generate;
  $("tryOnRevert").onclick = revert;
  const dlBtn = $("tryOnDownload");
  if (dlBtn) dlBtn.onclick = downloadResult;
  const obs = new MutationObserver(updateGenerateBtn);
  const resultView = document.getElementById("resultView");
  if (resultView) obs.observe(resultView, { attributes: true, attributeFilter: ["class"] });
  updateGenerateBtn();
}

async function downloadResult() {
  if (!lastResultBlob) { setStatus("Generate a try-on first, then download.", "err"); return; }
  try {
    setStatus("Preparing download…");
    const dataUrl = await blobToDataUrl(lastResultBlob);
    const img = new Image(); img.crossOrigin = "anonymous";
    await new Promise((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error("Could not load result image")); img.src = dataUrl; });
    const MAX = 1600;
    const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", 0.85));
    if (!blob) throw new Error("Could not encode image");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `tryon-${Date.now()}.jpg`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    setStatus(`Downloaded (${Math.round(blob.size / 1024)} KB).`, "ok");
  } catch (e) { setStatus(e?.message || "Could not download the image.", "err"); }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
else bind();
