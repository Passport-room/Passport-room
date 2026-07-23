// Image enhance — posts to the server-side proxy at /api/public/enhance,
// which calls the finegrain-image-enhancer Space via @gradio/client.

const ENDPOINT = "/api/public/enhance";
const TIMEOUT_MS = 230_000;

let scale = 2;
let busy = false;
let preSnapshot = null;

const $ = (id) => document.getElementById(id);

function setStatus(msg, kind = "") {
  const el = $("enhanceStatus");
  if (!el) return;
  el.textContent = msg || "";
  el.className = "tryOnStatus " + kind;
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

async function callEnhance(personBlob, upscale) {
  const form = new FormData();
  form.append("image", personBlob, "image.png");
  form.append("upscale", String(upscale));

  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort("timeout"), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(ENDPOINT, { method: "POST", body: form, signal: ctl.signal });
  } catch (err) {
    clearTimeout(t);
    if (err?.name === "AbortError")
      throw new Error("Request timed out — the cloud AI enhancer is warming up. Please try again.");
    throw new Error("Network error contacting the enhancer.");
  }
  clearTimeout(t);

  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (!res.ok) {
    let msg = `Enhance failed (${res.status})`;
    if (ct.includes("json")) {
      try {
        const j = await res.json();
        if (j?.error) msg = typeof j.error === "string" ? j.error : (j.error.message || JSON.stringify(j.error));
      } catch {}
    }
    throw new Error(msg);
  }
  if (!ct.includes("image/")) {
    let text = "";
    try { text = await res.text(); } catch {}
    console.error("Enhance unexpected non-image response:", ct, text);
    throw new Error("Enhancer service did not return an image. Please try again.");
  }
  return await res.blob();
}

async function enhance() {
  if (busy) return;
  if (!window.__tryOn) {
    setStatus("Editor not ready — upload a photo first.", "err");
    return;
  }
  const personDataUrl = window.__tryOn.getPersonDataUrl();
  if (!personDataUrl) {
    setStatus("Upload a photo first.", "err");
    return;
  }

  busy = true;
  updateBtn();

  const progressMsgs = [
    `Sending photo to cloud AI studio (${scale}x)…`,
    "Enhancing facial features & detail…",
    "Restoring photo clarity & resolution…",
    "Giving final touches…",
    "Polishing enhanced portrait…"
  ];
  let msgIdx = 0;
  setStatus(progressMsgs[0]);
  const progressInterval = setInterval(() => {
    msgIdx = (msgIdx + 1) % progressMsgs.length;
    setStatus(progressMsgs[msgIdx]);
  }, 3500);

  try {
    preSnapshot = personDataUrl;
    const personBlob = await dataUrlToBlob(personDataUrl);
    const resultBlob = await callEnhance(personBlob, scale);
    clearInterval(progressInterval);
    setStatus("Preparing enhanced photo…");
    const dataUrl = await blobToDataUrl(resultBlob);
    await window.__tryOn.applyResult(dataUrl, (m) => setStatus(m));
    $("enhanceRevert").classList.remove("hidden");
    setStatus("Enhanced. Keep editing, cropping or downloading.", "ok");
  } catch (e) {
    clearInterval(progressInterval);
    console.error(e);
    setStatus(e.message || "Enhance failed. Please try again.", "err");
  } finally {
    clearInterval(progressInterval);
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
      document
        .querySelectorAll(".enhanceScaleBtn")
        .forEach((x) => x.classList.toggle("active", x === b));
    });
  });
  const gen = $("enhanceGenerate");
  const rev = $("enhanceRevert");
  if (gen) gen.onclick = enhance;
  if (rev) rev.onclick = revert;
  const obs = new MutationObserver(updateBtn);
  const resultView = document.getElementById("resultView");
  if (resultView) obs.observe(resultView, { attributes: true, attributeFilter: ["class"] });
  updateBtn();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
else bind();
