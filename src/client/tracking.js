// Anonymous, no-login device tracking.
//
// Identity is tied to the BROWSER, not the person: a random id is stored in
// localStorage. Clearing storage / another browser / another device = new id.
// That is an accepted limitation — no fingerprinting is used on purpose.
//
// Only device id, device type, browser name and timestamps are collected.
// No name, phone, email or location. Reads are blocked by RLS; the public key
// can only INSERT and update last_seen.
//
// Debugging: every failure is now reported. Open the browser console and run
//   await window.__prTracking.test()
// to see exactly what the database answers.
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://ejyazkthqukoubfwindh.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_6cWoIFzU0-GHABApKgAw4Q_BUpJmPd2";

const ID_KEY = "pr_device_id";
const LAST_VISIT_KEY = "pr_last_visit_at";
const VISIT_WINDOW_MS = 30 * 60 * 1000;

let client = null;
function db() {
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  return client;
}

function safeStorage(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// Supabase never throws on a rejected row — it returns { error }. The old code
// only had a try/catch, so RLS rejections were completely invisible.
function report(step, error) {
  if (!error) return null;
  const detail = error.message || error.hint || JSON.stringify(error);
  console.warn(`[tracking] ${step} failed: ${detail}`);
  if (typeof window !== "undefined") {
    window.__prTrackingLastError = { step, error };
  }
  return error;
}

export function getDeviceId() {
  let id = safeStorage(() => localStorage.getItem(ID_KEY));
  if (!id) {
    id =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : "dev_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    safeStorage(() => localStorage.setItem(ID_KEY, id));
  }
  return id;
}

function detect() {
  const ua = navigator.userAgent || "";
  const isTablet = /iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua));
  const isMobile = /Android|iPhone|iPod|Mobile|Opera Mini|IEMobile/i.test(ua);
  const deviceType = isTablet ? "tablet" : isMobile ? "mobile" : "desktop";

  let browser = "Other";
  if (/Edg\//i.test(ua)) browser = "Edge";
  else if (/OPR\/|Opera/i.test(ua)) browser = "Opera";
  else if (/SamsungBrowser/i.test(ua)) browser = "Samsung Internet";
  else if (/Firefox\//i.test(ua)) browser = "Firefox";
  else if (/Chrome\//i.test(ua)) browser = "Chrome";
  else if (/Safari\//i.test(ua)) browser = "Safari";

  return { deviceType, browser };
}

async function ensureVisitorRow() {
  const deviceId = getDeviceId();
  const { deviceType, browser } = detect();

  // INSERT ... ON CONFLICT DO NOTHING — needs only the insert policy.
  const { error } = await db()
    .from("visitors")
    .upsert(
      { device_id: deviceId, device_type: deviceType, browser },
      { onConflict: "device_id", ignoreDuplicates: true },
    );
  return report("visitor upsert", error);
}

async function logEvent(eventType) {
  // The event row has a foreign key to visitors, so the visitor row must exist
  // first. On a fresh browser the two calls used to race, which silently threw
  // away the very first "visit" event.
  const { error } = await db()
    .from("visitor_events")
    .insert({ device_id: getDeviceId(), event_type: eventType });
  return report(`event ${eventType}`, error);
}

/** Logged once per page load, throttled to one visit per 30 minutes. */
export async function trackVisit() {
  const deviceId = getDeviceId();

  const upsertError = await ensureVisitorRow();
  if (!upsertError) {
    // Allowed by the narrow update policy (last_seen_at only).
    const { error } = await db()
      .from("visitors")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("device_id", deviceId);
    report("last_seen update", error);
  }

  const last = Number(safeStorage(() => localStorage.getItem(LAST_VISIT_KEY)) || 0);
  if (Date.now() - last < VISIT_WINDOW_MS) return;
  safeStorage(() => localStorage.setItem(LAST_VISIT_KEY, String(Date.now())));
  await logEvent("visit");
}

/** Called from the single shared download helper. */
export function trackPhotoCreated() {
  // Make sure the visitor row exists before writing the event, otherwise the
  // foreign key rejects it for a brand-new browser.
  void ensureVisitorRow().then(() => logEvent("photo_created"));
}

if (typeof window !== "undefined") {
  window.__prTracking = {
    getDeviceId,
    trackVisit,
    trackPhotoCreated,
    /** Console helper: reports exactly what the database answered. */
    async test() {
      const visitor = await ensureVisitorRow();
      const event = await logEvent("visit");
      const ok = !visitor && !event;
      console.log(
        ok
          ? "[tracking] OK — rows written for device " + getDeviceId()
          : "[tracking] BLOCKED — run supabase-tracking.sql in the Supabase SQL editor",
        { visitor, event },
      );
      return { ok, deviceId: getDeviceId(), visitor, event };
    },
  };
  void trackVisit();
}
