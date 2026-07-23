// Virtual Try-On client — drives model rotation. When the server reports
// a model is busy (202 JSON { busy, nextModel, waitMs }), we render a
// live countdown inside the status area and either auto-fire the next
// model after 5s or fire it immediately when the user taps
// "Try another model now". Loops until an image is produced or every
// model has failed.

const ENDPOINT = "/api/public/tryon";
const REQUEST_TIMEOUT_MS = 180_000;

const GARMENTS = [
  { id: "formal", label: "Formal", img: "/garments/1.png", description: "a formal shirt" },
  { id: "whitetshirt", label: "White T-Shirt", img: "/garments/2.png", description: "a white t-shirt" },
  { id: "shirt", label: "Shirt", img: "/garments/3.png", description: "a shirt" },
  { id: "tshirt", label: "T-Shirt", img: "/garments/4.png", description: "a t-shirt" },
  { id: "traditional", label: "Traditional", img: "/garments/5.png", description: "a traditional outfit" },
];

let selected = null;
let generating = false;
let customBlob = null;
let customDataUrl = null;
let customPrompt = "";
let preTryOnSnapshot = null;
let lastResultBlob = null;

// Countdown control (so the button can cancel the timer and fire immediately).
let countdownTimer = null;
let countdownResolve = null;

const $ = (id) => document.getElementById(id);

const PLUS_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;

function statusEl() {
  return $("tryOnStatus");
}

function setStatus(msg, kind = "") {
  const el = statusEl();
  if (!el) return;
  el.innerHTML = "";
  el.textContent = msg || "";
  el.className = "tryOnStatus " + kind;
}

function renderBusyCard({ modelLabel, nextModelLabel, seconds, onSkip }) {
  const el = statusEl();
  if (!el) return () => {};
  el.className = "tryOnStatus warn";
  el.innerHTML = `
    <div class="aiBusyCard" style="display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid rgba(230,170,50,.5);background:rgba(255,204,0,.08);border-radius:10px;font-size:13px;line-height:1.4;">
      <div><strong>⚠ ${escapeHtml(modelLabel)}</strong> is busy right now.</div>
      <div>Switching to <strong>${escapeHtml(nextModelLabel)}</strong> in <span class="aiCountdown">${seconds}</span>s…</div>
      <button type="button" class="aiSkipBtn" style="align-self:flex-start;margin-top:4px;padding:6px 12px;border-radius:8px;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer;font-weight:600;">Try another model now</button>
    </div>
  `;
  const btn = el.querySelector(".aiSkipBtn");
  if (btn) btn.onclick = () => onSkip();
  return () => {
    // updater fn — returns nothing
  };
}

function updateCountdown(seconds) {
  const el = statusEl();
  if (!el) return;
  const span = el.querySelector(".aiCountdown");
  if (span) span.textContent = String(seconds);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function busyCountdown({ modelLabel, nextModelLabel, waitMs }) {
  return new Promise((resolve) => {
    let remaining = Math.ceil(waitMs / 1000);
    countdownResolve = resolve;
    renderBusyCard({
      modelLabel,
      nextModelLabel,
      seconds: remaining,
      onSkip: () => {
        clearInterval(countdownTimer);
        countdownTimer = null;
        countdownResolve = null;
        resolve();
      },
    });
    countdownTimer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(countdownTimer);
        countdownTimer = null;
        countdownResolve = null;
        resolve();
      } else {
        updateCountdown(remaining);
      }
    }, 1000);
  });
}

function updateGenerateBtn() {
  const btn = $("tryOnGenerate");
  if (!btn) return;
  const customReady = !!customBlob || customPrompt.trim().length > 0;
  const ready =
    !generating &&
    !!selected &&
    (selected.id !== "custom" || customReady) &&
    !!window.__tryOn?.getPersonDataUrl?.();
  btn.disabled = !ready;
  btn.textContent = generating ? "Generating…" : "Change clothes";
}

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

// One HTTP call to one model. Returns
//   { kind: "image", blob }
//   { kind: "busy", modelLabel, nextModel, nextModelLabel, waitMs }
//   throws Error on fatal.
async function callTryOnModel(personBlob, garmentBlob, description, model) {
  const form = new FormData();
  form.append("person", personBlob, "person.png");
  form.append("garment", garmentBlob, "garment.png");
  form.append("description", description || "a garment");

  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort("timeout"), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${ENDPOINT}?model=${encodeURIComponent(model)}`, {
      method: "POST",
      body: form,
      signal: ctl.signal,
    });
  } catch (err) {
    clearTimeout(t);
    if (err?.name === "AbortError")
      throw new Error("Request timed out — the cloud AI is warming up. Please try again.");
    throw new Error("Network error contacting the AI service.");
  }
  clearTimeout(t);

  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (res.status === 202 && ct.includes("json")) {
    const j = await res.json().catch(() => ({}));
    if (j && j.busy) {
      return {
        kind: "busy",
        modelLabel: j.modelLabel || model,
        nextModel: j.nextModel,
        nextModelLabel: j.nextModelLabel || j.nextModel,
        waitMs: Number(j.waitMs) || 5000,
      };
    }
  }
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    let nextModel = null;
    if (ct.includes("json")) {
      try {
        const j = await res.json();
        if (j?.error) msg = typeof j.error === "string" ? j.error : (j.error.message || JSON.stringify(j.error));
        if (j?.nextModel) nextModel = j.nextModel;
      } catch {}
    }
    // If server offers a next model (502), treat as busy so we roll to next.
    if (nextModel) {
      return {
        kind: "busy",
        modelLabel: model,
        nextModel,
        nextModelLabel: nextModel,
        waitMs: 5000,
      };
    }
    const err = new Error(msg);
    err.fatal = true;
    throw err;
  }
  if (!ct.includes("image/")) {
    let text = "";
    try { text = await res.text(); } catch {}
    console.error("TryOn unexpected non-image response:", ct, text);
    throw new Error("AI service did not return an image. Please try again.");
  }
  return { kind: "image", blob: await res.blob() };
}

async function runModelLoop(personBlob, garmentBlob, description, onProgress) {
  let model = "idm";
  let guard = 8;
  while (guard-- > 0) {
    onProgress(model);
    let result;
    try {
      result = await callTryOnModel(personBlob, garmentBlob, description, model);
    } catch (err) {
      if (err && err.fatal) throw err;
      throw err;
    }
    if (result.kind === "image") return result.blob;
    // busy — countdown then move to next
    await busyCountdown({
      modelLabel: result.modelLabel,
      nextModelLabel: result.nextModelLabel,
      waitMs: result.waitMs,
    });
    model = result.nextModel;
    if (!model) throw new Error("All AI models are currently busy. Please try again shortly.");
  }
  throw new Error("Could not generate an image after multiple attempts.");
}

async function generate() {
  if (generating || !selected) return;
  if (!window.__tryOn) return setStatus("Editor not ready yet — upload a photo first.", "err");
  const personDataUrl = window.__tryOn.getPersonDataUrl();
  if (!personDataUrl) return setStatus("Upload a person photo first.", "err");

  let garmentBlob;
  let description = "a garment";
  try {
    if (selected.id === "custom") {
      const prompt = customPrompt.trim();
      if (!customBlob && !prompt) return setStatus("Upload a garment image or enter a prompt.", "err");
      garmentBlob = customBlob ? customBlob : await makePlaceholderGarmentBlob();
      if (prompt) description = prompt;
    } else {
      garmentBlob = await urlToBlob(selected.img);
      description = selected.description;
    }
  } catch (e) {
    return setStatus(e?.message || "Could not load garment.", "err");
  }

  generating = true;
  updateGenerateBtn();

  const progressMsgs = [
    "Sending photo & garment to cloud AI studio…",
    "Processing clothing fit & posture…",
    "Aligning outfit details…",
    "Giving final touches…",
    "Polishing new look…",
  ];
  let msgIdx = 0;
  let progressInterval = null;
  let usingModel = "idm";

  function startProgress() {
    stopProgress();
    setStatus(progressMsgs[0]);
    msgIdx = 0;
    progressInterval = setInterval(() => {
      msgIdx = (msgIdx + 1) % progressMsgs.length;
      const el = statusEl();
      // Don't overwrite a busy card
      if (el && !el.querySelector(".aiBusyCard")) setStatus(progressMsgs[msgIdx]);
    }, 3500);
  }
  function stopProgress() {
    if (progressInterval) clearInterval(progressInterval);
    progressInterval = null;
  }

  try {
    preTryOnSnapshot = personDataUrl;
    const personBlob = await dataUrlToBlob(personDataUrl);
    startProgress();
    const resultBlob = await runModelLoop(personBlob, garmentBlob, description, (m) => {
      usingModel = m;
      startProgress();
    });
    lastResultBlob = resultBlob;
    stopProgress();
    setStatus("Preparing your new photo…");
    const dataUrl = await blobToDataUrl(resultBlob);
    await window.__tryOn.applyResult(dataUrl, (m) => setStatus(m));
    $("tryOnRevert").classList.remove("hidden");
    const rtBtn = $("tryOnRetry");
    if (rtBtn) rtBtn.classList.remove("hidden");
    setStatus("Outfit applied. Tap Retry to regenerate, or continue editing.", "ok");
  } catch (e) {
    stopProgress();
    console.error(e);
    setStatus(e?.message || "Generation failed. Please try again.", "err");
  } finally {
    stopProgress();
    generating = false;
    updateGenerateBtn();
    void usingModel;
  }
}

async function revert() {
  if (!preTryOnSnapshot || generating) return;
  generating = true;
  updateGenerateBtn();
  setStatus("Restoring original…");
  try {
    await window.__tryOn.applyResult(preTryOnSnapshot, (m) => setStatus(m));
    $("tryOnRevert").classList.add("hidden");
    const rtBtn = $("tryOnRetry");
    if (rtBtn) rtBtn.classList.add("hidden");
    preTryOnSnapshot = null;
    lastResultBlob = null;
    setStatus("Reverted to original.", "ok");
  } catch (e) {
    setStatus(e.message || "Could not revert.", "err");
  } finally {
    generating = false;
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
      if (!f.type.startsWith("image/")) return setStatus("Please choose an image file.", "err");
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
  const rtBtn = $("tryOnRetry");
  if (rtBtn) rtBtn.onclick = () => generate();
  const obs = new MutationObserver(updateGenerateBtn);
  const resultView = document.getElementById("resultView");
  if (resultView) obs.observe(resultView, { attributes: true, attributeFilter: ["class"] });
  updateGenerateBtn();
}

async function downloadResult() {
  if (!lastResultBlob) return setStatus("Generate a try-on first, then download.", "err");
  try {
    setStatus("Preparing download…");
    // Preserve full model resolution — no downscale. Re-encode PNG→JPEG only
    // for smaller download size, at very high quality (0.95).
    const dataUrl = await blobToDataUrl(lastResultBlob);
    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Could not load result image"));
      img.src = dataUrl;
    });
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", 0.95));
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

if (typeof window !== "undefined") window.__tryOnDownload = downloadResult;

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
else bind();
