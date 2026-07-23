// Enhance client — model rotation with countdown, mirroring dress-tryon.js.

const ENDPOINT = "/api/public/enhance";
const REQUEST_TIMEOUT_MS = 230_000;

let scale = 2;
let busy = false;
let preSnapshot = null;
let countdownTimer = null;

const $ = (id) => document.getElementById(id);

function statusEl() {
  return $("enhanceStatus");
}

function setStatus(msg, kind = "") {
  const el = statusEl();
  if (!el) return;
  el.innerHTML = "";
  el.textContent = msg || "";
  el.className = "tryOnStatus " + kind;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderBusyCard({ modelLabel, nextModelLabel, seconds, onSkip }) {
  const el = statusEl();
  if (!el) return;
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
}

function updateCountdown(seconds) {
  const el = statusEl();
  if (!el) return;
  const span = el.querySelector(".aiCountdown");
  if (span) span.textContent = String(seconds);
}

function busyCountdown({ modelLabel, nextModelLabel, waitMs }) {
  return new Promise((resolve) => {
    let remaining = Math.ceil(waitMs / 1000);
    renderBusyCard({
      modelLabel,
      nextModelLabel,
      seconds: remaining,
      onSkip: () => {
        clearInterval(countdownTimer);
        countdownTimer = null;
        resolve();
      },
    });
    countdownTimer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(countdownTimer);
        countdownTimer = null;
        resolve();
      } else {
        updateCountdown(remaining);
      }
    }, 1000);
  });
}

function updateBtn() {
  const btn = $("enhanceGenerate");
  if (!btn) return;
  const ready = !busy && !!window.__tryOn?.getPersonDataUrl?.();
  btn.disabled = !ready;
  btn.textContent = busy ? "Enhancing…" : "Enhance photo";
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

async function callEnhanceModel(personBlob, upscale, model) {
  const form = new FormData();
  form.append("image", personBlob, "image.png");
  form.append("upscale", String(upscale));

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
      throw new Error("Request timed out — the cloud AI enhancer is warming up. Please try again.");
    throw new Error("Network error contacting the enhancer.");
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
    let msg = `Enhance failed (${res.status})`;
    let nextModel = null;
    if (ct.includes("json")) {
      try {
        const j = await res.json();
        if (j?.error) msg = typeof j.error === "string" ? j.error : (j.error.message || JSON.stringify(j.error));
        if (j?.nextModel) nextModel = j.nextModel;
      } catch {}
    }
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
    console.error("Enhance unexpected non-image response:", ct, text);
    throw new Error("Enhancer service did not return an image. Please try again.");
  }
  return { kind: "image", blob: await res.blob() };
}

async function runModelLoop(personBlob, upscale) {
  let model = "finegrain";
  let guard = 8;
  while (guard-- > 0) {
    const result = await callEnhanceModel(personBlob, upscale, model);
    if (result.kind === "image") return result.blob;
    await busyCountdown({
      modelLabel: result.modelLabel,
      nextModelLabel: result.nextModelLabel,
      waitMs: result.waitMs,
    });
    model = result.nextModel;
    if (!model) throw new Error("All AI enhancers are currently busy. Please try again shortly.");
  }
  throw new Error("Could not enhance after multiple attempts.");
}

async function enhance() {
  if (busy) return;
  if (!window.__tryOn) return setStatus("Editor not ready — upload a photo first.", "err");
  const personDataUrl = window.__tryOn.getPersonDataUrl();
  if (!personDataUrl) return setStatus("Upload a photo first.", "err");

  busy = true;
  updateBtn();

  const progressMsgs = [
    `Sending photo to cloud AI studio (${scale}x)…`,
    "Enhancing facial features & detail…",
    "Restoring clarity & resolution…",
    "Giving final touches…",
    "Polishing enhanced portrait…",
  ];
  let msgIdx = 0;
  let progressInterval = null;
  function startProgress() {
    stopProgress();
    setStatus(progressMsgs[0]);
    msgIdx = 0;
    progressInterval = setInterval(() => {
      msgIdx = (msgIdx + 1) % progressMsgs.length;
      const el = statusEl();
      if (el && !el.querySelector(".aiBusyCard")) setStatus(progressMsgs[msgIdx]);
    }, 3500);
  }
  function stopProgress() {
    if (progressInterval) clearInterval(progressInterval);
    progressInterval = null;
  }

  try {
    preSnapshot = personDataUrl;
    const personBlob = await dataUrlToBlob(personDataUrl);
    startProgress();
    const resultBlob = await runModelLoop(personBlob, scale);
    stopProgress();
    setStatus("Preparing enhanced photo…");
    const dataUrl = await blobToDataUrl(resultBlob);
    await window.__tryOn.applyResult(dataUrl, (m) => setStatus(m));
    $("enhanceRevert").classList.remove("hidden");
    const rt = $("enhanceRetry");
    if (rt) rt.classList.remove("hidden");
    setStatus("Enhanced. Tap Retry to run again, or continue editing.", "ok");
  } catch (e) {
    stopProgress();
    console.error(e);
    setStatus(e?.message || "Enhance failed. Please try again.", "err");
  } finally {
    stopProgress();
    busy = false;
    updateBtn();
  }
}

async function revert() {
  if (!preSnapshot || busy) return;
  busy = true;
  updateBtn();
  setStatus("Restoring original…");
  try {
    await window.__tryOn.applyResult(preSnapshot, (m) => setStatus(m));
    $("enhanceRevert").classList.add("hidden");
    const rt = $("enhanceRetry");
    if (rt) rt.classList.add("hidden");
    preSnapshot = null;
    setStatus("Reverted to original.", "ok");
  } catch (e) {
    setStatus(e.message || "Could not revert.", "err");
  } finally {
    busy = false;
    updateBtn();
  }
}

function bind() {
  document.querySelectorAll(".enhanceScaleBtn").forEach((b) => {
    b.addEventListener("click", () => {
      const raw = String(b.dataset.scale || "2x").replace("x", "");
      scale = Math.min(4, Math.max(1, parseInt(raw, 10) || 2));
      document.querySelectorAll(".enhanceScaleBtn").forEach((x) => x.classList.toggle("active", x === b));
    });
  });
  const gen = $("enhanceGenerate");
  const rev = $("enhanceRevert");
  if (gen) gen.onclick = enhance;
  if (rev) rev.onclick = revert;
  const rt = $("enhanceRetry");
  if (rt) rt.onclick = () => enhance();
  const obs = new MutationObserver(updateBtn);
  const resultView = document.getElementById("resultView");
  if (resultView) obs.observe(resultView, { attributes: true, attributeFilter: ["class"] });
  updateBtn();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
else bind();
