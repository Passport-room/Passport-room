// Review chat box (WhatsApp-style list + 5-star rating), stored in Firebase.
//
// Reads/writes the public "reviews" list in the Realtime Database through the
// small REST helpers in firebase-config.js. Every visitor gets a stable local
// user id from the account manager, so their own messages are highlighted.

import { dbPush, dbRecent } from "./firebase-config.js";
import { loadAccount } from "./account-manager.js";

const PATH = "reviews";
const MAX_LEN = 300;
const REFRESH_MS = 20000;

let els = null;
let me = null;
let rating = 0;
let sending = false;
let timer = null;
let lastSignature = "";

function esc(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function timeLabel(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const now = Date.now();
  const sameDay = new Date(now).toDateString() === d.toDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay ? time : `${d.toLocaleDateString([], { day: "numeric", month: "short" })} · ${time}`;
}

function initials(name) {
  const parts = String(name || "User").trim().split(/\s+/);
  const first = parts[0] || "U";
  const digits = first.match(/\d+/);
  if (digits) return digits[0].slice(-2);
  return first.slice(0, 2).toUpperCase();
}

function stars(n) {
  let out = "";
  for (let i = 1; i <= 5; i++) {
    out += `<span class="rvStar${i <= n ? " on" : ""}">★</span>`;
  }
  return `<span class="rvStars" aria-label="${n} out of 5 stars">${out}</span>`;
}

function renderList(items) {
  if (!items.length) {
    els.list.innerHTML = `<div class="rvEmpty">No reviews yet — be the first to share how Passport Room worked for you.</div>`;
    return;
  }
  els.list.innerHTML = items
    .map((r) => {
      const mine = me && r.uid === me.id;
      return `<div class="rvMsg${mine ? " mine" : ""}">
        <div class="rvAvatar" style="--rvA:${esc(r.color || "#7c3aed")}">${esc(initials(r.name))}</div>
        <div class="rvBubble">
          <div class="rvHead">
            <span class="rvName">${esc(r.name || "Guest")}${mine ? " (you)" : ""}</span>
            ${stars(Number(r.rating) || 0)}
          </div>
          <div class="rvText">${esc(r.text || "")}</div>
          <div class="rvMeta"><span class="rvId">${esc(r.uid || "")}</span><span>${esc(timeLabel(r.ts))}</span></div>
        </div>
      </div>`;
    })
    .join("");
}

function renderSummary(items) {
  if (!els.summary) return;
  if (!items.length) {
    els.summary.innerHTML = `<span class="muted small">Ratings appear here</span>`;
    return;
  }
  const rated = items.filter((r) => Number(r.rating) > 0);
  const avg = rated.length
    ? rated.reduce((s, r) => s + Number(r.rating), 0) / rated.length
    : 0;
  els.summary.innerHTML = `${stars(Math.round(avg))}<strong>${avg ? avg.toFixed(1) : "–"}</strong><span class="muted small">${items.length} review${items.length === 1 ? "" : "s"}</span>`;
}

function scrollToEnd() {
  els.list.scrollTop = els.list.scrollHeight;
}

async function load({ keepScroll = false } = {}) {
  try {
    const data = await dbRecent(PATH, 60);
    const items = Object.entries(data || {})
      .map(([id, v]) => ({ id, ...(v || {}) }))
      .filter((r) => r && r.text)
      .sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const signature = items.map((r) => r.id).join("|");
    if (signature === lastSignature && keepScroll) return;
    lastSignature = signature;
    const atEnd =
      els.list.scrollHeight - els.list.scrollTop - els.list.clientHeight < 60;
    renderList(items);
    renderSummary(items);
    if (!keepScroll || atEnd) scrollToEnd();
    els.error.classList.add("hidden");
  } catch (err) {
    console.warn("[reviews] load failed", err);
    if (!els.list.children.length) {
      els.list.innerHTML = `<div class="rvEmpty">Reviews can't be loaded right now. Please try again later.</div>`;
    }
  }
}

function setRating(n) {
  rating = n;
  [...els.rate.querySelectorAll("button")].forEach((b, i) => {
    b.classList.toggle("on", i < n);
    b.setAttribute("aria-checked", String(i + 1 === n));
  });
}

function showError(msg) {
  els.error.textContent = msg;
  els.error.classList.remove("hidden");
}

async function send() {
  if (sending) return;
  const text = els.input.value.trim().slice(0, MAX_LEN);
  if (!text) {
    showError("Please write a short review first.");
    els.input.focus();
    return;
  }
  if (!rating) {
    showError("Please tap a star rating (1–5).");
    return;
  }
  sending = true;
  els.send.disabled = true;
  els.error.classList.add("hidden");
  try {
    await dbPush(PATH, {
      uid: me.id,
      name: me.displayName,
      color: me.avatarColor || "#7c3aed",
      rating,
      text,
      ts: Date.now(),
    });
    els.input.value = "";
    setRating(0);
    els.count.textContent = `0/${MAX_LEN}`;
    await load();
    scrollToEnd();
  } catch (err) {
    console.warn("[reviews] send failed", err);
    showError("Your review couldn't be posted. Please check your connection and try again.");
  } finally {
    sending = false;
    els.send.disabled = false;
  }
}

function init() {
  const root = document.getElementById("reviewBox");
  if (!root) return;
  els = {
    root,
    list: root.querySelector("#rvList"),
    input: root.querySelector("#rvInput"),
    send: root.querySelector("#rvSend"),
    rate: root.querySelector("#rvRate"),
    error: root.querySelector("#rvError"),
    count: root.querySelector("#rvCount"),
    summary: root.querySelector("#rvSummary"),
    who: root.querySelector("#rvWho"),
  };
  if (!els.list || !els.input || !els.send || !els.rate) return;

  try {
    me = loadAccount();
  } catch {
    me = { id: "usr_guest", displayName: "Guest", avatarColor: "#7c3aed" };
  }
  if (els.who) els.who.textContent = `${me.displayName} · ${me.id}`;

  els.rate.innerHTML = [1, 2, 3, 4, 5]
    .map(
      (n) =>
        `<button type="button" role="radio" aria-checked="false" aria-label="${n} star${n > 1 ? "s" : ""}">★</button>`,
    )
    .join("");
  [...els.rate.querySelectorAll("button")].forEach((b, i) =>
    b.addEventListener("click", () => setRating(i + 1)),
  );

  els.input.setAttribute("maxlength", String(MAX_LEN));
  els.input.addEventListener("input", () => {
    els.count.textContent = `${els.input.value.length}/${MAX_LEN}`;
  });
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  els.send.addEventListener("click", send);

  load();
  timer = setInterval(() => {
    if (!document.hidden) load({ keepScroll: true });
  }, REFRESH_MS);
  window.addEventListener("pagehide", () => clearInterval(timer));
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
