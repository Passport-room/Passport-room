// Anonymous visitor tracking (Firebase Realtime Database).
//
// A random device id is stored in localStorage the first time the studio is
// opened and never changes. The first visit takes the next number from a
// counter in the database, so every visitor keeps one fixed number forever and
// a returning visitor is never counted as new.
//
// Stored per visitor: fixed number, device type, browser, operating system,
// screen size, user agent, country, number of visits, total time spent and how
// many photos they made.
// Never stored: name, email, phone, exact address or photos.

import { dbGet, dbPut, dbPatch } from "./firebase-config.js";

const ID_KEY = "pr_device_id";
const CODE_KEY = "pr_customer_code";
const VISITS_KEY = "pr_visit_count";
const MS_KEY = "pr_total_ms";
const PHOTOS_KEY = "pr_photo_count";
const GEO_KEY = "pr_geo";

function safe(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

const readNum = (k) => Number(safe(() => localStorage.getItem(k)) || 0) || 0;
const writeNum = (k, v) => safe(() => localStorage.setItem(k, String(v)));

export function getDeviceId() {
  let id = safe(() => localStorage.getItem(ID_KEY));
  if (!id) {
    id =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : "dev_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
    safe(() => localStorage.setItem(ID_KEY, id));
  }
  return id;
}

/** The permanent number, once it has been assigned. */
export function getCustomerCode() {
  return safe(() => localStorage.getItem(CODE_KEY));
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

function paintCode(code) {
  if (!code) return;
  safe(() => localStorage.setItem(CODE_KEY, code));
  document.querySelectorAll("[data-customer-code]").forEach((el) => {
    el.textContent = code;
  });
}

const pad = (n) => "CUS-" + String(n).padStart(6, "0");

/** Takes the next free number from the shared counter (safe against races). */
async function allocateCode() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const { value, etag } = await dbGet("counters/customerNumber", { etag: true });
    const next = (Number(value) || 0) + 1;
    const result = await dbPut("counters/customerNumber", next, { ifMatch: etag });
    if (result.ok) return pad(next);
    await new Promise((r) => setTimeout(r, 60 + Math.random() * 200));
  }
  throw new Error("could not assign a customer number");
}

/** Finds this device's existing number, or creates its record once. */
async function ensureCustomer(info, geo) {
  const deviceId = getDeviceId();
  let code = getCustomerCode();

  if (!code) {
    code = await dbGet(`devices/${deviceId}`);
  }

  if (!code) {
    code = await allocateCode();
    const now = Date.now();
    writeNum(VISITS_KEY, 0);
    writeNum(MS_KEY, 0);
    writeNum(PHOTOS_KEY, 0);
    await dbPut(`customers/${code}`, {
      id: code,
      deviceId,
      ...info,
      ...geo,
      visitCount: 0,
      photoCount: 0,
      totalMs: 0,
      firstVisit: now,
      lastVisit: now,
    });
    await dbPut(`devices/${deviceId}`, code);
  }

  paintCode(code);
  return code;
}

let currentCode = null;

async function pushVisit() {
  const info = detect();
  const geo = await getCountry();
  const code = await ensureCustomer(info, geo);
  currentCode = code;

  const visits = readNum(VISITS_KEY) + 1;
  writeNum(VISITS_KEY, visits);

  await dbPatch(`customers/${code}`, {
    ...info,
    ...geo,
    visitCount: visits,
    lastVisit: Date.now(),
  });
  return code;
}

async function pushTime(ms) {
  if (!currentCode) return;
  const total = readNum(MS_KEY) + Math.round(ms);
  writeNum(MS_KEY, total);
  await dbPatch(
    `customers/${currentCode}`,
    { totalMs: total, lastVisit: Date.now() },
    { keepalive: true },
  );
}

let startedAt = Date.now();
let reported = false;

function reportTime() {
  if (reported) return;
  const spent = Date.now() - startedAt;
  if (spent < 2000) return;
  reported = true;
  pushTime(spent).catch(() => {});
}

if (typeof window !== "undefined") {
  paintCode(getCustomerCode());
  pushVisit().catch((err) => console.warn("[tracking] failed:", err?.message || err));

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") reportTime();
    else if (reported) {
      startedAt = Date.now();
      reported = false;
    }
  });
  window.addEventListener("pagehide", reportTime);

  window.__prTracking = { getDeviceId, getCustomerCode, pushVisit };
}

/** Called after every successful photo or print-sheet export. */
export function trackPhotoCreated() {
  const photos = readNum(PHOTOS_KEY) + 1;
  writeNum(PHOTOS_KEY, photos);
  const code = currentCode || getCustomerCode();
  if (!code) return;
  dbPatch(`customers/${code}`, { photoCount: photos, lastVisit: Date.now() }).catch(() => {});
}
