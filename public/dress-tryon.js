// Virtual Try-On — posts to the server-side proxy at /api/public/tryon,
// which forwards to the yisol/IDM-VTON Hugging Face Space via @gradio/client.
// Keeps the window.__tryOn contract, all DOM ids, and UX identical.

const ENDPOINT = "/api/public/tryon";
const TIMEOUT_MS = 160_000;

const GARMENTS = [
  { id: "formal",       label: "Formal",         img: "assets/formal.png",       description: "a formal shirt" },
  { id: "whitetshirt",  label: "White T-Shirt",  img: "assets/whitetshirt.png",  description: "a white t-shirt" },
  { id: "shirt",        label: "Shirt",          img: "assets/shirt.png",        description: "a shirt" },
  { id: "tshirt",       label: "T-Shirt",        img: "assets/tshirt.png",       description: "a t-shirt" },
  { id: "traditional",  label: "Traditional",    img: "assets/traditional.png",  description: "a traditional outfit" },
];

let selected = null;
let generating = false;
let customBlob = null;
let customDataUrl = null;
let customPrompt = "";
let preTryOnSnapshot = null;

const $ = (id) => document.getElementById(id);

const PLUS_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;

function setStatus(msg, kind = "") {
  const el = $("tryOnStatus");
  if (!el) return;
  el.textContent = msg || "";
  el.className = "tryOnStatus " + kind;
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
    const iconInner = g.img
      ? `<img src="${g.img}" alt="${g.label}" loading="lazy" />`
      : PLUS_SVG;
    el.innerHTML = `<span class="tryOnDressIcon">${iconInner}</span><span class="tryOnDressLabel">${g.label}</span>`;
    el.onclick = () => {
      selected = g;
      wrap.querySelectorAll(".tryOnDress").forEach((n) =>
        n.classList.toggle("active", n.dataset.id === g.id),
      );
      $("tryOnCustom").classList.toggle("hidden", g.id !== "custom");
      updateGenerateBtn();
    };
    wrap.appendChild(el);
  });
}

async function urlToBlob(url) {
  const res = await fetch(url);
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

async function callTryOn(personBlob, garmentBlob, description) {
  const form = new FormData();
  form.append("person", personBlob, "person.png");
  form.append("garment", garmentBlob, "garment.png");
  form.append("description", description || "a garment");

  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort("timeout"), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(ENDPOINT, { method: "POST", body: form, signal: ctl.signal });
  } catch (err) {
    clearTimeout(t);
    if (err?.name === "AbortError") throw new Error("Request timed out — the AI Space may be waking up.");
    throw new Error("Network error contacting the AI service.");
  }
  clearTimeout(t);

  const ct = res.headers.get("content-type") || "";
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    if (ct.includes("application/json")) {
      try { const j = await res.json(); if (j?.error) msg = j.error; } catch {}
    }
    throw new Error(msg);
  }
  if (!ct.startsWith("image/")) throw new Error("Unexpected response from AI service.");
  return await res.blob();
}

async function generate() {
  if (generating || !selected) return;
  if (!window.__tryOn) { setStatus("Editor not ready yet — upload a photo first.", "err"); return; }
  const personDataUrl = window.__tryOn.getPersonDataUrl();
  if (!personDataUrl) { setStatus("Upload a person photo first.", "err"); return; }

  let garmentBlob;
  let description = "a garment";
  try {
    if (selected.id === "custom") {
      const prompt = customPrompt.trim();
      if (!customBlob && !prompt) {
        setStatus("Upload a garment image or enter a prompt.", "err");
        return;
      }
      if (customBlob) {
        garmentBlob = customBlob;
      } else {
        // Prompt-only: send a neutral white placeholder; IDM-VTON uses `garment_des` as guidance.
        garmentBlob = await makePlaceholderGarmentBlob();
      }
      if (prompt) description = prompt;
    } else {
      garmentBlob = await urlToBlob(selected.img);
      description = selected.description;
    }
  } catch (e) {
    setStatus(e.message || "Could not load garment.", "err");
    return;
  }

  generating = true;
  updateGenerateBtn();
  setStatus("Sending photo & garment to AI…");

  try {
    preTryOnSnapshot = personDataUrl;
    const personBlob = await dataUrlToBlob(personDataUrl);
    const resultBlob = await callTryOn(personBlob, garmentBlob, description);
    setStatus("Preparing your new photo…");
    const dataUrl = await blobToDataUrl(resultBlob);
    await window.__tryOn.applyResult(dataUrl, (m) => setStatus(m));
    $("tryOnRevert").classList.remove("hidden");
    setStatus("Done ✓ Continue editing, cropping or downloading.", "ok");
  } catch (e) {
    console.error(e);
    setStatus(e.message || "Generation failed. Please try again.", "err");
  } finally {
    generating = false;
    updateGenerateBtn();
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
    preTryOnSnapshot = null;
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
  c.width = 512; c.height = 512;
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
  const obs = new MutationObserver(updateGenerateBtn);
  const resultView = document.getElementById("resultView");
  if (resultView) obs.observe(resultView, { attributes: true, attributeFilter: ["class"] });
  updateGenerateBtn();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
else bind();
