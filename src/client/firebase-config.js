// Firebase Realtime Database connection (REST, no SDK needed) + Firebase
// Authentication via the Identity Toolkit REST API.
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

/* ------------------------------------------------------------------ *
 * Firebase Authentication (anonymous sign-in, REST)                   *
 * ------------------------------------------------------------------ */

const SESSION_KEY = "pr_fb_auth";
const IDENTITY = "https://identitytoolkit.googleapis.com/v1";
const SECURE_TOKEN = "https://securetoken.googleapis.com/v1";

function safe(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function loadSession() {
  const raw = safe(() => localStorage.getItem(SESSION_KEY));
  const parsed = raw ? safe(() => JSON.parse(raw)) : null;
  if (parsed?.idToken && parsed?.refreshToken && parsed?.localId) return parsed;
  return null;
}

function saveSession(session) {
  safe(() => localStorage.setItem(SESSION_KEY, JSON.stringify(session)));
  return session;
}

function shape(data) {
  return {
    idToken: data.idToken || data.id_token,
    refreshToken: data.refreshToken || data.refresh_token,
    localId: data.localId || data.user_id,
    // renew a minute early so a request never travels with a dead token
    expiresAt: Date.now() + (Number(data.expiresIn || data.expires_in) || 3600) * 1000 - 60_000,
  };
}

let session = typeof window !== "undefined" ? loadSession() : null;
let pending = null;

async function firebaseErrorMessage(res, fallback) {
  const body = await res.json().catch(() => null);
  return body?.error?.message || fallback;
}

async function signInAnonymously() {
  const res = await fetch(`${IDENTITY}/accounts:signUp?key=${FIREBASE_CONFIG.apiKey}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ returnSecureToken: true }),
  });
  if (!res.ok) {
    throw new Error(await firebaseErrorMessage(res, `anonymous sign-in failed (${res.status})`));
  }
  return saveSession(shape(await res.json()));
}

async function refreshSession(refreshToken) {
  const res = await fetch(`${SECURE_TOKEN}/token?key=${FIREBASE_CONFIG.apiKey}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  if (!res.ok) {
    throw new Error(await firebaseErrorMessage(res, `token refresh failed (${res.status})`));
  }
  return saveSession(shape(await res.json()));
}

/** Signs in (anonymously, once) and keeps the ID token fresh. */
export function ensureAuth() {
  if (session && session.expiresAt > Date.now()) return Promise.resolve(session);
  if (pending) return pending;
  const previous = session;
  pending = (previous?.refreshToken
    ? refreshSession(previous.refreshToken).catch(() => signInAnonymously())
    : signInAnonymously()
  )
    .then((next) => {
      session = next;
      return next;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

/** Current Firebase ID token, refreshed silently when it has expired. */
export async function getIdToken() {
  return (await ensureAuth()).idToken;
}

/** The Firebase Auth uid — this is the customer's database key. */
export async function getUid() {
  return (await ensureAuth()).localId;
}

/** The uid already known on this device, without waiting for the network. */
export function getCachedUid() {
  return session?.localId || null;
}

/* ------------------------------------------------------------------ *
 * Database helpers — every request carries the current ID token       *
 * ------------------------------------------------------------------ */

function url(path, auth) {
  return `${DB_URL}/${path}.json${auth ? `?auth=${encodeURIComponent(auth)}` : ""}`;
}

async function tokenFor(auth) {
  return auth === undefined ? await getIdToken() : auth;
}

/** Reads a value from the database. Returns null when the path is empty. */
export async function dbGet(path, { auth, etag = false } = {}) {
  const res = await fetch(url(path, await tokenFor(auth)), {
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
  const res = await fetch(url(path, await tokenFor(auth)), {
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
  const res = await fetch(url(path, await tokenFor(auth)), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(fields),
    keepalive,
  });
  if (!res.ok) throw new Error(`firebase update ${path} failed (${res.status})`);
  return true;
}
