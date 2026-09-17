// Pro membership & free daily limit (browser side).
//
// Free visitors: 3 photos per day (counted on this device, reset at midnight).
// Pro members: unlimited photos for 30 days, no ads, nothing deducted per photo.
//
// Pro can only ever be switched on by the server, after Paddle confirms a real
// payment. This file just asks the server "is this device Pro?" and paints the
// answer into the page.

import { getDeviceId } from "./tracking.js";

const STATE_KEY = "pr_pro_state_v1";
const USAGE_KEY = "pr_free_usage_v1";
const EMAIL_KEY = "pr_pro_email";

export const FREE_DAILY_LIMIT = 3;
export const PLAN_DAYS = 30;
export const PRICE_LABEL = "$0.99";

const $ = (id) => document.getElementById(id);

function safe(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

const EMPTY = {
  pro: false,
  status: "none",
  startedAt: null,
  expiresAt: null,
  daysLeft: 0,
  email: null,
};

/* ------------------------------ stored state ------------------------------ */

let state = readState();
const listeners = new Set();

function readState() {
  const raw = safe(() => JSON.parse(localStorage.getItem(STATE_KEY) || "null"));
  if (!raw || typeof raw !== "object") return { ...EMPTY };
  const merged = { ...EMPTY, ...raw };
  // A cached "pro" never outlives its own expiry date.
  if (merged.expiresAt && merged.expiresAt <= Date.now()) {
    merged.pro = false;
    merged.status = "expired";
    merged.daysLeft = 0;
  }
  return merged;
}

function writeState(next) {
  state = { ...EMPTY, ...next };
  safe(() => localStorage.setItem(STATE_KEY, JSON.stringify(state)));
  listeners.forEach((fn) => safe(() => fn(state)));
  paint();
}

export function getMembership() {
  return { ...state };
}

export function isPro() {
  return Boolean(state.pro && state.expiresAt && state.expiresAt > Date.now());
}

/** True when a membership existed but its 30 days have run out. */
export function isExpired() {
  return !isPro() && state.status === "expired" && Boolean(state.expiresAt);
}

export function onMembershipChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getSavedEmail() {
  return safe(() => localStorage.getItem(EMAIL_KEY));
}

export function saveEmail(email) {
  safe(() => localStorage.setItem(EMAIL_KEY, String(email || "").trim().toLowerCase()));
}

/* --------------------------- free daily counter --------------------------- */

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

function readUsage() {
  const raw = safe(() => JSON.parse(localStorage.getItem(USAGE_KEY) || "null"));
  if (!raw || raw.date !== today()) return { date: today(), count: 0 };
  return { date: raw.date, count: Number(raw.count) || 0 };
}

export function freeUsedToday() {
  return readUsage().count;
}

export function freeRemaining() {
  return Math.max(0, FREE_DAILY_LIMIT - freeUsedToday());
}

/** Pro members are never limited; free visitors get 3 per day. */
export function canGenerate() {
  return isPro() || freeRemaining() > 0;
}

/** Called once a photo has actually been created. Pro members lose nothing. */
export function consumeGeneration() {
  if (isPro()) return;
  const usage = readUsage();
  usage.count += 1;
  safe(() => localStorage.setItem(USAGE_KEY, JSON.stringify(usage)));
  paint();
}

/* ------------------------------ server check ------------------------------ */

/** Asks the server for the real access status and caches it. */
export async function refreshMembership() {
  try {
    const params = new URLSearchParams({ deviceId: getDeviceId() });
    const email = getSavedEmail();
    if (email) params.set("email", email);
    const res = await fetch(`/api/public/membership?${params.toString()}`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return getMembership();
    const data = await res.json();
    if (data && data.unavailable) return getMembership();
    writeState({
      pro: Boolean(data.pro),
      status: data.status || "none",
      startedAt: data.startedAt ?? null,
      expiresAt: data.expiresAt ?? null,
      daysLeft: Number(data.daysLeft) || 0,
      email: data.email ?? email ?? null,
    });
    if (data.email) saveEmail(data.email);
  } catch (err) {
    console.warn("[membership] status check failed", err);
  }
  return getMembership();
}

/** Restores an active membership on this device from the payment email. */
export async function restoreWithEmail(email) {
  const res = await fetch("/api/public/membership/restore", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, deviceId: getDeviceId() }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) throw new Error((data && data.error) || "Could not restore membership.");
  saveEmail(email);
  writeState({
    pro: Boolean(data.pro),
    status: data.status || "none",
    startedAt: data.startedAt ?? null,
    expiresAt: data.expiresAt ?? null,
    daysLeft: Number(data.daysLeft) || 0,
    email: data.email ?? email,
  });
  return getMembership();
}

export function formatDate(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/* -------------------------------- painting -------------------------------- */

function removeAds() {
  document.querySelectorAll(".pr-ad").forEach((el) => el.remove());
}

function paint() {
  const pro = isPro();
  const body = document.body;
  if (!body) return;

  body.classList.toggle("is-pro", pro);
  if (pro) removeAds();

  // Status and upgrade action below the upload box. The action stays outside
  // #drop so clicking it can never trigger the image picker.
  const line = $("planLine");
  const upgradeLink = $("upgradeLink");
  if (line) {
    if (pro) {
      line.innerHTML = `<span class="planLinePro">Pro active · unlimited photos · ${state.daysLeft} day${
        state.daysLeft === 1 ? "" : "s"
      } left</span>`;
      if (upgradeLink) upgradeLink.classList.add("hidden");
    } else {
      const left = freeRemaining();
      line.innerHTML = `<span>${left} of ${FREE_DAILY_LIMIT} free photo${
        FREE_DAILY_LIMIT === 1 ? "" : "s"
      } left today</span>`;
      if (upgradeLink) {
        upgradeLink.textContent = `Buy Pro for ${PRICE_LABEL} for unlimited photos →`;
        upgradeLink.classList.remove("hidden");
      }
    }
  }

  // Expiry notice (studio + download popup).
  document.querySelectorAll("[data-pro-expired]").forEach((el) => {
    el.classList.toggle("hidden", !isExpired());
  });
  document.querySelectorAll("[data-pro-expired-date]").forEach((el) => {
    el.textContent = formatDate(state.expiresAt);
  });

  // "Renew soon" notice: shown in the last 5 days of a membership.
  const renewSoon = pro && state.daysLeft > 0 && state.daysLeft <= 5;
  document.querySelectorAll("[data-pro-renew-soon]").forEach((el) => {
    el.classList.toggle("hidden", !renewSoon);
  });
  document.querySelectorAll("[data-pro-days-left]").forEach((el) => {
    el.textContent = String(state.daysLeft);
  });

  // Upgrade boxes are for free visitors only — Pro never sees an offer or an ad.
  document.querySelectorAll("[data-pro-offer]").forEach((el) => {
    el.classList.toggle("hidden", pro);
  });
  document.querySelectorAll("[data-pro-only]").forEach((el) => {
    el.classList.toggle("hidden", !pro);
  });
  document.querySelectorAll("[data-free-left]").forEach((el) => {
    el.textContent = String(freeRemaining());
  });
}

/** Shows the "daily free limit reached" popup. */
export function showLimitReached() {
  const modal = $("proLimitModal");
  if (modal) modal.classList.remove("hidden");
}

export function initMembership() {
  paint();

  const limitModal = $("proLimitModal");
  if (limitModal) {
    limitModal.addEventListener("click", (e) => {
      if (e.target === limitModal || e.target.closest("[data-close-pro-modal]")) {
        limitModal.classList.add("hidden");
      }
    });
  }

  refreshMembership();

  // Coming back from checkout (or from the payment page) re-checks access.
  window.addEventListener("focus", () => refreshMembership());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshMembership();
  });

  // A payment can land a moment after checkout closes — retry for a short while.
  if (/[?&](paid|checkout)=1/.test(window.location.search)) {
    let tries = 0;
    const timer = setInterval(async () => {
      tries += 1;
      const s = await refreshMembership();
      if (s.pro || tries >= 10) clearInterval(timer);
    }, 3000);
  }

  window.__prMembership = {
    isPro,
    getMembership,
    freeRemaining,
    refreshMembership,
    restoreWithEmail,
  };
}
