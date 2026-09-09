// Visitor tracking (Firebase Anonymous Auth + Realtime Database).
//
// Identity: on first open the studio signs in anonymously. Firebase issues a
// UID that survives reloads, browser restarts and a cleared site storage, and
// every write is signed with that visitor's own token.
//
// Visible number: a short code (e.g. PR-8F3K2A) derived from the UID and
// claimed once in the database, so two visitors can never share one code.
// There is no shared counter, so nothing can race or skip a number.
//
// Totals (visits, photos, time) are raised with database transactions, so they
// can only go up and are never overwritten by a number kept on the device.
//
// Stored per visitor: code, device type, browser, system, screen, language,
// time zone, country, visits, photos per tool and total time.
// Never stored: name, email, phone, exact address or photos.

import { getFirebase, ensureAnonymousUser } from "./firebase-config.js";
import {
  ref,
  get,
  update,
  runTransaction,
  serverTimestamp,
} from "firebase/database";

const OLD_ID_KEY = "pr_device_id";
const OLD_CODE_KEY = "pr_customer_code";
const CODE_KEY = "pr_visitor_code";
const GEO_KEY = "pr_geo";

const PHOTO_KINDS = ["single", "sheet", "dress", "enhance", "bgremove"];

function safe(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ */
/* Device fingerprint (non-identifying)                                */
/* ------------------------------------------------------------------ */

export function getDeviceId() {
  let id = safe(() => localStorage.getItem(OLD_ID_KEY));
  if (!id) {
    id =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : "dev_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
    safe(() => localStorage.setItem(OLD_ID_KEY, id));
  }
  return id;
}

function detect() {
  const ua = navigator.userAgent || "";
  const isTablet = /iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua));
  const isMobile = /Android|iPhone|iPod|Mobile|Opera Mini|IEMobile/i.test(ua);

  let browser = "Other";
  if (/Edg\//i.test(ua)) browser = "Edge";
  else if (/OPR\/|Opera/i.test(ua)) browser = "Opera";
  else if (/SamsungBrowser/i.test(ua)) browser = "Samsung Internet";
  else if (/Firefox\//i.test(ua)) browser = "Firefox";
  else if (/Chrome\//i.test(ua)) browser = "Chrome";
  else if (/Safari\//i.test(ua)) browser = "Safari";

  let os = "Other";
  if (/Windows/i.test(ua)) os = "Windows";
  else if (/Android/i.test(ua)) os = "Android";
  else if (/iPhone|iPad|iPod/i.test(ua)) os = "iOS";
  else if (/Mac OS X/i.test(ua)) os = "macOS";
  else if (/Linux/i.test(ua)) os = "Linux";

  return {
    deviceType: isTablet ? "tablet" : isMobile ? "mobile" : "desktop",
    browser,
    os,
    screen: `${window.screen?.width || 0}x${window.screen?.height || 0}`,
    language: (navigator.language || "").slice(0, 20),
    timeZone: safe(() => Intl.DateTimeFormat().resolvedOptions().timeZone, "") || "",
    userAgent: ua.slice(0, 300),
  };
}

/** Country of the visitor, looked up once and remembered on the device. */
async function getCountry() {
  const cached = safe(() => JSON.parse(localStorage.getItem(GEO_KEY) || "null"));
  if (cached?.country) return cached;
  try {
    const res = await fetch("https://ipwho.is/?fields=success,country,country_code");
    const data = await res.json();
    if (data?.success && data.country) {
      const geo = { country: data.country, countryCode: data.country_code || "" };
      safe(() => localStorage.setItem(GEO_KEY, JSON.stringify(geo)));
      return geo;
    }
  } catch {
    /* country is optional — never block tracking */
  }
  return { country: "Unknown", countryCode: "" };
}

/* ------------------------------------------------------------------ */
/* The visible code                                                     */
/* ------------------------------------------------------------------ */

// No 0/O/1/I so a code can be read out loud without confusion.
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function codeCandidate(uid, salt) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const input = `${uid}#${salt}`;
  for (let i = 0; i < input.length; i++) {
    h1 = Math.imul(h1 ^ input.charCodeAt(i), 16777619) >>> 0;
    h2 = Math.imul(h2 + input.charCodeAt(i) + i, 2246822519) >>> 0;
  }
  let out = "";
  let a = h1;
  let b = h2;
  for (let i = 0; i < 6; i++) {
    out += ALPHABET[(i < 3 ? a : b) & 31];
    if (i < 3) a >>>= 5;
    else b >>>= 5;
  }
  return "PR-" + out;
}

/** The permanent code, once it has been assigned. */
export function getVisitorCode() {
  return safe(() => localStorage.getItem(CODE_KEY)) || safe(() => localStorage.getItem(OLD_CODE_KEY));
}

/** Kept for older imports. */
export const getCustomerCode = getVisitorCode;

const listeners = new Set();

/** Called whenever the code becomes known or changes. */
export function onVisitorCode(fn) {
  listeners.add(fn);
  const code = getVisitorCode();
  if (code) safe(() => fn(code));
  return () => listeners.delete(fn);
}

function paintCode(code) {
  if (!code) return;
  safe(() => localStorage.setItem(CODE_KEY, code));
  safe(() =>
    document.querySelectorAll("[data-customer-code]").forEach((el) => {
      el.textContent = code;
    }),
  );
  listeners.forEach((fn) => safe(() => fn(code)));
}

/** Claims a code for this uid, trying the next candidate when one is taken. */
async function claimCode(db, uid, preferred) {
  const tryClaim = async (code) => {
    const res = await runTransaction(ref(db, `codes/${code}`), (current) =>
      current === null || current === uid ? uid : undefined,
    );
    return res.committed && res.snapshot.val() === uid;
  };

  if (preferred && (await tryClaim(preferred))) return preferred;

  for (let salt = 0; salt < 25; salt++) {
    const code = codeCandidate(uid, salt);
    if (await tryClaim(code)) return code;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Visitor record                                                       */
/* ------------------------------------------------------------------ */

let ready = null; // resolves to { db, uid } or null when tracking is off

async function bump(db, uid, field, amount) {
  if (!amount) return;
  await runTransaction(ref(db, `users/${uid}/${field}`), (v) => (Number(v) || 0) + amount);
}

/** Moves an old device-based record onto the new Firebase identity, once. */
async function carryOver(db, uid, deviceId) {
  const legacyCode =
    (await get(ref(db, `devices/${deviceId}`)).then((s) => s.val())) ||
    safe(() => localStorage.getItem(OLD_CODE_KEY));
  if (!legacyCode || typeof legacyCode !== "string" || !legacyCode.startsWith("CUS-")) return null;

  const old = await get(ref(db, `customers/${legacyCode}`))
    .then((s) => s.val())
    .catch(() => null);

  return {
    code: legacyCode,
    migratedFrom: legacyCode,
    visits: Number(old?.visitCount) || 0,
    totalMs: Number(old?.totalMs) || 0,
    photosTotal: Number(old?.photoCount) || 0,
  };
}

async function startTracking() {
  const user = await ensureAnonymousUser();
  if (!user) return null; // anonymous sign-in off or offline — stay silent

  const { db } = getFirebase();
  const uid = user.uid;
  const deviceId = getDeviceId();
  const info = detect();

  const existing = await get(ref(db, `users/${uid}`))
    .then((s) => s.val())
    .catch(() => null);

  let code = existing?.code || null;
  let seed = null;

  if (!code) {
    seed = await carryOver(db, uid, deviceId).catch(() => null);
    code = await claimCode(db, uid, seed?.code || codeCandidate(uid, 0));
    if (!code) return null;
  }

  const base = {
    code,
    ...info,
    lastSeenAt: serverTimestamp(),
    [`deviceIds/${deviceId}`]: true,
  };
  if (!existing) {
    base.createdAt = serverTimestamp();
    base.visits = seed?.visits || 0;
    base.totalMs = seed?.totalMs || 0;
    base["photos/total"] = seed?.photosTotal || 0;
    for (const kind of PHOTO_KINDS) base[`photos/${kind}`] = 0;
    if (seed?.migratedFrom) base.migratedFrom = seed.migratedFrom;
  }

  const geo = await getCountry();
  Object.assign(base, geo);

  await update(ref(db, `users/${uid}`), base);
  await runTransaction(ref(db, `devices/${deviceId}`), () => uid).catch(() => {});

  paintCode(code);
  await bump(db, uid, "visits", 1);

  return { db, uid };
}

/* ------------------------------------------------------------------ */
/* Time spent — per-session heartbeat while the page is visible         */
/* ------------------------------------------------------------------ */

const HEARTBEAT_MS = 15000;
let activeSince = null;
let heartbeat = null;

async function flushTime() {
  if (activeSince === null) return;
  const spent = Date.now() - activeSince;
  activeSince = Date.now();
  if (spent < 1000) return;
  const ctx = await ready;
  if (!ctx) return;
  await bump(ctx.db, ctx.uid, "totalMs", Math.min(spent, 10 * 60 * 1000)).catch(() => {});
  await update(ref(ctx.db, `users/${ctx.uid}`), { lastSeenAt: serverTimestamp() }).catch(() => {});
}

function startClock() {
  if (heartbeat) return;
  activeSince = Date.now();
  heartbeat = setInterval(() => {
    flushTime().catch(() => {});
  }, HEARTBEAT_MS);
}

function stopClock() {
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
  flushTime().catch(() => {});
  activeSince = null;
}

/* ------------------------------------------------------------------ */
/* Photo counting                                                       */
/* ------------------------------------------------------------------ */

/**
 * Called once per completed export or tool run.
 * kind: "single" | "sheet" | "dress" | "enhance" | "bgremove"
 */
export function trackPhotoCreated(kind = "single") {
  const type = PHOTO_KINDS.includes(kind) ? kind : "single";
  (async () => {
    const ctx = await ready;
    if (!ctx) return;
    await bump(ctx.db, ctx.uid, `photos/${type}`, 1);
    await bump(ctx.db, ctx.uid, "photos/total", 1);
    await update(ref(ctx.db, `users/${ctx.uid}`), { lastSeenAt: serverTimestamp() });
  })().catch(() => {
    /* tracking must never surface an error to the visitor */
  });
}

/* ------------------------------------------------------------------ */
/* Boot                                                                 */
/* ------------------------------------------------------------------ */

if (typeof window !== "undefined") {
  paintCode(getVisitorCode());

  ready = startTracking().catch(() => null);
  ready.then((ctx) => {
    if (ctx && document.visibilityState !== "hidden") startClock();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") stopClock();
    else startClock();
  });
  window.addEventListener("pagehide", stopClock);

  window.__prTracking = { getVisitorCode, getDeviceId, onVisitorCode, trackPhotoCreated };
}
