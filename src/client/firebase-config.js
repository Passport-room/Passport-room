// Firebase Realtime Database connection (REST, no SDK needed).
//
// These values are the public web config from the Firebase console — they are
// meant to ship in the page. Who may read or write what is decided by the
// database rules (see firebase-rules.json in the project root).
//
// Nothing here depends on the hosting provider, so the same files work on
// GitHub + Vercel, Netlify or any static host with no environment variables.

export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBwTzFmMTHEfdX0ZqqXNP29EcQoLud1hrM",
  authDomain: "passport-48389.firebaseapp.com",
  projectId: "passport-48389",
  storageBucket: "passport-48389.firebasestorage.app",
  messagingSenderId: "222961536167",
  appId: "1:222961536167:web:618360108d616b8f129f82",
  databaseURL: "https://passport-48389-default-rtdb.firebaseio.com",
};

export const DB_URL = FIREBASE_CONFIG.databaseURL;

function url(path, auth) {
  return `${DB_URL}/${path}.json${auth ? `?auth=${encodeURIComponent(auth)}` : ""}`;
}

/** Reads a value from the database. Returns null when the path is empty. */
export async function dbGet(path, { auth, etag = false } = {}) {
  const res = await fetch(url(path, auth), {
    headers: etag ? { "X-Firebase-ETag": "true" } : undefined,
  });
  if (!res.ok) throw new Error(`firebase read ${path} failed (${res.status})`);
  const value = await res.json();
  return etag ? { value, etag: res.headers.get("ETag") } : value;
}

/** Replaces a value. Pass `ifMatch` for a safe "only if unchanged" write. */
export async function dbPut(path, value, { auth, ifMatch, keepalive = false } = {}) {
  const headers = { "content-type": "application/json" };
  if (ifMatch) headers["if-match"] = ifMatch;
  const res = await fetch(url(path, auth), {
    method: "PUT",
    headers,
    body: JSON.stringify(value),
    keepalive,
  });
  if (res.status === 412) return { ok: false, conflict: true };
  if (!res.ok) throw new Error(`firebase write ${path} failed (${res.status})`);
  return { ok: true };
}

/** Updates only the given fields of an object. */
export async function dbPatch(path, fields, { auth, keepalive = false } = {}) {
  const res = await fetch(url(path, auth), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(fields),
    keepalive,
  });
  if (!res.ok) throw new Error(`firebase update ${path} failed (${res.status})`);
  return true;
}
