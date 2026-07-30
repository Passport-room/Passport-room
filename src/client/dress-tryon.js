// Virtual Try-On — posts to the server-side Smart Multi-Space Router at
// /api/public/tryon, which streams live status (server selection, queue
// position, progress) over Server-Sent Events and returns the final image.

import { detectFaceInCanvas } from "./face-detector.js";

const ENDPOINT = "/api/public/tryon";

const GARMENTS = [
  { id: "formal", label: "Formal", img: "/garments/1.png", description: "a formal shirt" },
  { id: "whitetshirt", label: "White T-Shirt", img: "/garments/2.png", description: "a white t-shirt" },
  { id: "shirt", label: "Shirt", img: "/garments/3.png", description: "a shirt" },
  { id: "tshirt", label: "T-Shirt", img: "/garments/4.png", description: "a t-shirt" },
  { id: "traditional", label: "Traditional", img: "/garments/5.png", description: "a traditional outfit" },
];

// Rotating professional status messages shown while the AI server works.
// The router also pushes live messages ("People ahead of you: N") which
// take priority while they are current.
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
  const ready =
    !generating &&
    !isEnhancing &&
    !!selected &&
    (selected.id !== "custom" || customReady) &&
    !!window.__tryOn?.getPersonDataUrl?.();
  btn.disabled = !ready;
  if (isEnhancing) {
    btn.textContent = "Enhance in progress...";
  } else if (generating) {
    btn.textContent = "Generating…";
  } else {
    btn.textContent = "Change clothes";
  }
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
      wrap
        .querySelectorAll(".tryOnDress")
        .forEach((n) => n.classList.toggle("active", n.dataset.id === g.id));
      $("tryOnCustom").classList.toggle("hidden", g.id !== "custom");
      updateGenerateBtn();
    };
    wrap.appendChild(el);
  });
}

async function urlToBlob(url) {
  let res = await fetch(url);
  if (!res.ok) {
    const alt1 = url.startsWith("/") ? url.slice(1) : "/" + url;
    res = await fetch(alt1);
  }
  if (!res.ok && url.includes("/garments/")) {
    const alt2 = url.replace("/garments/", "/");
    res = await fetch(alt2);
  }
  if (!res.ok && url.includes("/garments/")) {
    const alt3 = url.replace("/garments/", "/assets/");
    res = await fetch(alt3);
  }
  if (!res.ok) throw new Error(`Failed to load garment (${res.status})`);
  return await res.blob();
}

async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return await res.blob();
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

  const targetW = 768;
  const targetH = 1024;
  const targetAR = targetW / targetH;

  let drawW, drawH, drawX, drawY;

  if (origAR >= targetAR) {
    drawW = targetW;
    drawH = Math.round(targetW / origAR);
    drawX = 0;
    drawY = Math.round((targetH - drawH) / 2);
  } else {
    drawH = targetH;
    drawW = Math.round(targetH * origAR);
    drawX = Math.round((targetW - drawW) / 2);
    drawY = 0;
  }

  const canvas = document.createElement("canvas");
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  const coverScale = Math.max(targetW / origW, targetH / origH);
  const coverW = origW * coverScale;
  const coverH = origH * coverScale;
  const coverX = (targetW - coverW) / 2;
  const coverY = (targetH - coverH) / 2;

  ctx.save();
  ctx.filter = "blur(16px)";
  ctx.drawImage(img, coverX, coverY, coverW, coverH);
  ctx.restore();

  ctx.drawImage(img, drawX, drawY, drawW, drawH);

  const preparedBlob = await new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/png"),
  );

  return {
    preparedBlob,
    placement: { origW, origH, drawX, drawY, drawW, drawH, targetW, targetH },
  };
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

  const scaleX = resW / placement.targetW;
  const scaleY = resH / placement.targetH;

  const srcX = Math.round(placement.drawX * scaleX);
  const srcY = Math.round(placement.drawY * scaleY);
  const srcW = Math.round(placement.drawW * scaleX);
  const srcH = Math.round(placement.drawH * scaleY);

  const canvas = document.createElement("canvas");
  canvas.width = placement.origW;
  canvas.height = placement.origH;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  ctx.drawImage(
    img,
    srcX, srcY, srcW, srcH,
    0, 0, placement.origW, placement.origH,
  );

  return canvas.toDataURL("image/png");
}

// ---------------------------------------------------------------------------
// Animated status section
// ---------------------------------------------------------------------------

function startStatusAnimation() {
  statusIndex = 0;
  liveQueueMsg = null;
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = setInterval(() => {
    if (liveQueueMsg) {
      setStatus(liveQueueMsg, "info");
    } else {
      const msg = ROTATING_MESSAGES[statusIndex % ROTATING_MESSAGES.length];
      statusIndex++;
      setStatus(msg, "info");
    }
  }, 2200);
  setStatus(ROTATING_MESSAGES[0], "info");
}

function setLiveQueue(msg) {
  liveQueueMsg = msg;
  setStatus(msg, "info");
}

function stopStatusAnimation() {
  if (statusTimer) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
  liveQueueMsg = null;
}

// ---------------------------------------------------------------------------
// SSE-based try-on call
// ---------------------------------------------------------------------------

async function callTryOn(personBlob, garmentBlob, description) {
  const form = new FormData();
  form.append("person", personBlob, "person.png");
  form.append("garment", garmentBlob, "garment.png");
  form.append("description", description || "a garment");

  const res = await fetch(ENDPOINT, { method: "POST", body: form });
  const ct = (res.headers.get("content-type") || "").toLowerCase();

  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    if (ct.includes("json")) {
      try {
        const j = await res.json();
        if (j?.error) msg = typeof j.error === "string" ? j.error : j.error.message || JSON.stringify(j.error);
      } catch {}
    }
    throw new Error(msg);
  }

  if (!ct.includes("text/event-stream")) {
    let text = "";
    try { text = await res.text(); } catch {}
    throw new Error("AI service did not return a stream.");
  }

  return await readSSEStream(res.body);
}

async function readSSEStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let imageUrl = null;
  let errorMsg = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);

      let event = "message";
      let data = "";
      const lines = block.split("\n");
      for (const line of lines) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }

      if (event === "status") {
        try {
          const j = JSON.parse(data);
          if (typeof j.queue === "number") {
            setLiveQueue(`People ahead of you: ${j.queue}`);
          } else if (j.message) {
            liveQueueMsg = null;
            setStatus(j.message, "info");
          }
        } catch {}
      } else if (event === "image") {
        try {
          const j = JSON.parse(data);
          if (j.url) imageUrl = j.url;
        } catch {}
      } else if (event === "error") {
        try {
          const j = JSON.parse(data);
          errorMsg = j.message || "AI generation failed.";
        } catch {
          errorMsg = "AI generation failed.";
        }
      }
    }
  }

  if (imageUrl) {
    const r = await fetch(imageUrl);
    return await r.blob();
  }
  throw new Error(errorMsg || "AI Virtual Try-On is currently busy. Please try again.");
}

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
    return {
      allowed: false,
      error: `Limit reached: Maximum 30 images per hour. Try again in ${waitMins}m.`,
    };
  }

  if (history.length >= 100) {
    return { allowed: false, error: "Limit reached: Maximum 100 images per day." };
  }

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
    const origImg = new Image();
    origImg.crossOrigin = "anonymous";
    const tryOnImg = new Image();
    tryOnImg.crossOrigin = "anonymous";

    await Promise.all([
      new Promise((res, rej) => { origImg.onload = res; origImg.onerror = rej; origImg.src = origDataUrl; }),
      new Promise((res, rej) => { tryOnImg.onload = res; tryOnImg.onerror = rej; tryOnImg.src = tryOnDataUrl; }),
    ]);

    const w = tryOnImg.naturalWidth || tryOnImg.width;
    const h = tryOnImg.naturalHeight || tryOnImg.height;

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");

    ctx.drawImage(tryOnImg, 0, 0, w, h);

    const origCanvas = document.createElement("canvas");
    origCanvas.width = w;
    origCanvas.height = h;
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
    maskCanvas.width = w;
    maskCanvas.height = h;
    const mctx = maskCanvas.getContext("2d");

    const blendCutoffY = Math.min(h - 1, Math.round(chinY));
    mctx.fillStyle = "#ffffff";
    mctx.fillRect(0, 0, w, blendCutoffY);

    const grad = mctx.createLinearGradient(0, blendCutoffY, 0, Math.min(h, blendCutoffY + fadeDist));
    grad.addColorStop(0, "rgba(255,255,255,1.0)");
    grad.addColorStop(1, "rgba(255,255,255,0.0)");
    mctx.fillStyle = grad;
    mctx.fillRect(0, blendCutoffY, w, Math.round(fadeDist));

    const headCanvas = document.createElement("canvas");
    headCanvas.width = w;
    headCanvas.height = h;
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
  if (window.__isEnhanceRunning) {
    setStatus("AI Enhancement is currently running. Please wait for it to complete.", "warn");
    return;
  }
  if (!window.__tryOn) {
    setStatus("Editor not ready.", "err");
    return;
  }
  const personDataUrl = window.__tryOn.getPersonDataUrl();
  if (!personDataUrl) {
    setStatus("Upload a photo first.", "err");
    return;
  }

  const rateLimit = checkTryOnRateLimit();
  if (!rateLimit.allowed) {
    setStatus(rateLimit.error, "err");
    return;
  }

  let garmentBlob;
  let description = "a garment";
  try {
    if (selected.id === "custom") {
      const prompt = customPrompt.trim();
      if (!customBlob && !prompt) {
        setStatus("Upload a garment image or enter prompt.", "err");
        return;
      }
      if (customBlob) {
        garmentBlob = customBlob;
      } else {
        garmentBlob = await makePlaceholderGarmentBlob();
      }
      if (prompt) description = prompt;
    } else {
      garmentBlob = await urlToBlob(selected.img);
      description = selected.description;
    }
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : typeof e === "string" ? e : "Could not load garment.";
    setStatus(errMsg, "err");
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

    const resultBlob = await callTryOn(preparedBlob, garmentBlob, description);

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
    const errMsg = e instanceof Error ? e.message : typeof e === "string" ? e : e?.message || "Generation failed. Try again.";
    setStatus(errMsg, "err");
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
  generating = true;
  window.__isTryOnRunning = true;
  window.__updateToolButtons?.();
  updateGenerateBtn();
  setStatus("Restoring original…");
  try {
    await window.__tryOn.applyResult(preTryOnSnapshot, (m) => setStatus(m));
    $("tryOnRevert").classList.add("hidden");
    const dlBtn = $("tryOnDownload");
    if (dlBtn) dlBtn.classList.add("hidden");
    preTryOnSnapshot = null;
    lastResultBlob = null;
    setStatus("Reverted to original.", "ok");
  } catch (e) {
    setStatus(e.message || "Could not revert.", "err");
  } finally {
    generating = false;
    window.__isTryOnRunning = false;
    window.__updateToolButtons?.();
    updateGenerateBtn();
  }
}

async function makePlaceholderGarmentBlob() {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, c.width, c.height);
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
      if (!f.type.startsWith("image/")) {
        setStatus("Please choose an image file.", "err");
        return;
      }
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
  if (prompt) {
    prompt.addEventListener("input", (e) => {
      customPrompt = e.target.value || "";
      updateGenerateBtn();
    });
  }
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
  if (resultView)
    obs.observe(resultView, { attributes: true, attributeFilter: ["class"] });
  updateGenerateBtn();
}

async function downloadResult() {
  if (!lastResultBlob) {
    setStatus("Generate a try-on first, then download.", "err");
    return;
  }
  try {
    setStatus("Preparing download…");
    const dataUrl = await blobToDataUrl(lastResultBlob);
    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Could not load result image"));
      img.src = dataUrl;
    });
    const MAX = 1600;
    const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", 0.85),
    );
    if (!blob) throw new Error("Could not encode image");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tryon-${Date.now()}.jpg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    const kb = Math.round(blob.size / 1024);
    setStatus(`Downloaded (${kb} KB).`, "ok");
  } catch (e) {
    setStatus(e?.message || "Could not download the image.", "err");
  }
}

if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", bind);
else bind();
