// Anonymous, no-login device tracking.
//
// Identity is tied to the BROWSER, not the person: a random id is stored in
// localStorage. Clearing storage / another browser / another device = new id.
// That is an accepted limitation — no fingerprinting is used on purpose.
//
// Only device id, device type, browser name and timestamps are collected.
// No name, phone, email or location. Reads are blocked by RLS; the anon key
// can only INSERT and update last_seen.
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

async function logEvent(eventType) {
  try {
    await db()
      .from("visitor_events")
      .insert({ device_id: getDeviceId(), event_type: eventType }, { returning: "minimal" });
  } catch (err) {
    console.debug("[tracking] event failed", err);
  }
}

/** Logged once per page load, throttled to one visit per 30 minutes. */
export async function trackVisit() {
  const deviceId = getDeviceId();
  const { deviceType, browser } = detect();

  try {
    // INSERT ... ON CONFLICT DO NOTHING — needs only the insert policy.
    await db()
      .from("visitors")
      .upsert(
        { device_id: deviceId, device_type: deviceType, browser },
        { onConflict: "device_id", ignoreDuplicates: true, returning: "minimal" },
      );
    // Allowed by the narrow update policy (last_seen_at only).
    await db()
      .from("visitors")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("device_id", deviceId);
  } catch (err) {
    console.debug("[tracking] visitor upsert failed", err);
  }

  const last = Number(safeStorage(() => localStorage.getItem(LAST_VISIT_KEY)) || 0);
  if (Date.now() - last < VISIT_WINDOW_MS) return;
  safeStorage(() => localStorage.setItem(LAST_VISIT_KEY, String(Date.now())));
  await logEvent("visit");
}

/** Called from the single shared download helper. */
export function trackPhotoCreated() {
  void logEvent("photo_created");
}

if (typeof window !== "undefined") {
  void trackVisit();
}
