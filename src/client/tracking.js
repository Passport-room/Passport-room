// Anonymous visitor tracking (Lovable Cloud).
//
// A random id is stored in localStorage the first time the studio is opened and
// never changes. The cloud assigns a permanent customer number for that id and
// always returns the same one, so a returning visitor is never counted as new.
//
// The page talks to the cloud directly through a protected database routine
// (`track_visit`). Nothing here depends on the hosting provider, so the same
// files work on Lovable, GitHub + Vercel, Netlify or any static host.
//
// Collected: device type, browser, OS, screen size, visit count, time on page.
// Never collected: name, email, phone, location or photos.

import { callCloud } from "./cloud-config.js";

const ID_KEY = "pr_device_id";
const CODE_KEY = "pr_customer_code";

function safe(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

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

/** The permanent number, once the cloud has told us what it is. */
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
    device_type: isTablet ? "tablet" : isMobile ? "mobile" : "desktop",
    browser,
    os,
    screen: `${window.screen?.width || 0}x${window.screen?.height || 0}`,
  };
}

function paintCode(code) {
  if (!code) return;
  safe(() => localStorage.setItem(CODE_KEY, code));
  document.querySelectorAll("[data-customer-code]").forEach((el) => {
    el.textContent = code;
  });
}

async function send(event, durationMs = 0, keepalive = false) {
  const info = detect();
  try {
    const rows = await callCloud(
      "track_visit",
      {
        p_device_id: getDeviceId(),
        p_device_type: info.device_type,
        p_browser: info.browser,
        p_os: info.os,
        p_screen: info.screen,
        p_event: event,
        p_duration_ms: Math.round(durationMs),
      },
      { keepalive },
    );
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (row?.customer_code) paintCode(row.customer_code);
    return row ?? null;
  } catch (err) {
    console.warn("[tracking] failed:", err?.message || err);
    return null;
  }
}

let startedAt = Date.now();
let reported = false;

function reportTime() {
  if (reported) return;
  const spent = Date.now() - startedAt;
  if (spent < 2000) return;
  reported = true;
  void send("time", spent, true);
}

if (typeof window !== "undefined") {
  paintCode(getCustomerCode());
  void send("visit");

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") reportTime();
    else if (reported) {
      startedAt = Date.now();
      reported = false;
    }
  });
  window.addEventListener("pagehide", reportTime);

  window.__prTracking = { getDeviceId, getCustomerCode, send };
}

/**
 * Kept for the download helper. Photo creation is a local-only statistic now —
 * the cloud only stores visits, time spent, browser and device.
 */
export function trackPhotoCreated() {}
