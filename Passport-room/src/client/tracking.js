// Anonymous customer tracking + true real-time presence.
// Single source of truth: Firebase Realtime Database (project passport-48389).
//
// Customers never log in. Each browser gets a persistent sequential id
// (CUS-000001, CUS-000002, ...) allocated with a Realtime Database
// transaction, stored in localStorage. Only device metadata and timestamps
// are collected — no name, phone, email or location.
import { db } from "./firebase.js";
import {
  ref,
  get,
  set,
  update,
  onValue,
  onDisconnect,
  runTransaction,
  serverTimestamp,
} from "firebase/database";

const ID_KEY = "pr_customer_id";
const LEGACY_ID_KEY = "pr_device_id";
const VISIT_KEY = "pr_last_visit_at";
const VISIT_WINDOW_MS = 30 * 60 * 1000;

function safeStorage(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function pad(n) {
  return "CUS-" + String(n).padStart(6, "0");
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

  let os = "Other";
  if (/Windows/i.test(ua)) os = "Windows";
  else if (/Android/i.test(ua)) os = "Android";
  else if (/iPhone|iPad|iPod/i.test(ua)) os = "iOS";
  else if (/Mac OS X/i.test(ua)) os = "macOS";
  else if (/CrOS/i.test(ua)) os = "ChromeOS";
  else if (/Linux/i.test(ua)) os = "Linux";

  return { deviceType, browser, os, userAgent: ua.slice(0, 400) };
}

function warn(step, error) {
  console.warn(`[tracking] ${step} failed:`, error?.message || error);
  if (typeof window !== "undefined") window.__prTrackingLastError = { step, error };
}

/** Allocates the next sequential customer id via an atomic transaction. */
async function allocateCustomerId() {
  const result = await runTransaction(ref(db, "counters/customerSeq"), (current) =>
    (typeof current === "number" ? current : 0) + 1,
  );
  const next = result.snapshot.val();
  return pad(typeof next === "number" && next > 0 ? next : Date.now() % 1000000);
}

async function getOrCreateCustomerId() {
  let id = safeStorage(() => localStorage.getItem(ID_KEY));
  if (id && /^CUS-\d{6}$/.test(id)) return id;
  id = await allocateCustomerId();
  safeStorage(() => localStorage.setItem(ID_KEY, id));
  safeStorage(() => localStorage.removeItem(LEGACY_ID_KEY));
  return id;
}

let currentId = null;

/** Registers the visit and wires real-time presence with onDisconnect(). */
async function start() {
  const customerId = await getOrCreateCustomerId();
  currentId = customerId;
  const info = detect();
  const customerRef = ref(db, `customers/${customerId}`);

  const last = Number(safeStorage(() => localStorage.getItem(VISIT_KEY)) || 0);
  const isNewVisit = Date.now() - last > VISIT_WINDOW_MS;
  if (isNewVisit) safeStorage(() => localStorage.setItem(VISIT_KEY, String(Date.now())));

  const snap = await get(customerRef);
  if (!snap.exists()) {
    await set(customerRef, {
      id: customerId,
      firstVisit: serverTimestamp(),
      lastVisit: serverTimestamp(),
      visitCount: 1,
      deviceType: info.deviceType,
      os: info.os,
      browser: info.browser,
      userAgent: info.userAgent,
    });
  } else {
    const patch = {
      lastVisit: serverTimestamp(),
      deviceType: info.deviceType,
      os: info.os,
      browser: info.browser,
      userAgent: info.userAgent,
    };
    if (isNewVisit) patch.visitCount = (Number(snap.val().visitCount) || 0) + 1;
    await update(customerRef, patch);
  }

  // ---- True real-time presence -------------------------------------------
  const statusRef = ref(db, `status/${customerId}`);
  onValue(ref(db, ".info/connected"), (s) => {
    if (s.val() !== true) return;
    onDisconnect(statusRef)
      .set({ online: false, lastChanged: serverTimestamp(), deviceType: info.deviceType })
      .then(() =>
        set(statusRef, {
          online: true,
          lastChanged: serverTimestamp(),
          deviceType: info.deviceType,
        }),
      )
      .catch((e) => warn("presence", e));
  });

  // Best-effort offline flag for mobile tab switching / page unload.
  const goOffline = () => {
    if (document.visibilityState === "hidden") {
      void set(statusRef, {
        online: false,
        lastChanged: serverTimestamp(),
        deviceType: info.deviceType,
      }).catch(() => {});
    } else {
      void set(statusRef, {
        online: true,
        lastChanged: serverTimestamp(),
        deviceType: info.deviceType,
      }).catch(() => {});
    }
  };
  document.addEventListener("visibilitychange", goOffline);

  return customerId;
}

export function getCustomerId() {
  return currentId || safeStorage(() => localStorage.getItem(ID_KEY));
}

/** Called from the shared download helper. Counts exported photos. */
export function trackPhotoCreated() {
  const id = getCustomerId();
  if (!id) return;
  runTransaction(ref(db, `customers/${id}/photosCreated`), (c) =>
    (typeof c === "number" ? c : 0) + 1,
  ).catch((e) => warn("photo count", e));
}

if (typeof window !== "undefined") {
  window.__prTracking = { getCustomerId, trackPhotoCreated };
  start()
    .then((id) => console.info("[tracking] active as", id))
    .catch((e) => warn("start", e));
}
