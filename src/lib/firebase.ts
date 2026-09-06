// Admin-panel access to the Firebase Realtime Database.
//
// Visitor records cannot be read anonymously (see firebase-rules.json): only the
// admin account's email may read them. The panel signs in with Firebase
// Email/Password (Identity Toolkit REST API) and sends the resulting ID token as
// `?auth=...` — no database secret exists in the code or on the host.
export const DB_URL = "https://passport-48389-default-rtdb.firebaseio.com";

const API_KEY = "AIzaSyBwTzFmMTHEfdX0ZqqXNP29EcQoLud1hrM";
const IDENTITY = "https://identitytoolkit.googleapis.com/v1";

export type VisitorRow = {
  id: string;
  deviceType: string | null;
  browser: string | null;
  os: string | null;
  screen: string | null;
  country: string | null;
  countryCode: string | null;
  visitCount: number;
  photoCount: number;
  totalMs: number;
  firstVisit: number;
  lastVisit: number;
};

type RawVisitor = Partial<VisitorRow> & { id?: string };

/** Signs the admin in with email + password and returns a Firebase ID token. */
export async function signInAdmin(email: string, password: string): Promise<string> {
  const res = await fetch(`${IDENTITY}/accounts:signInWithPassword?key=${API_KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message || `sign-in failed (${res.status})`);
  }
  const data = (await res.json()) as { idToken?: string };
  if (!data.idToken) throw new Error("sign-in failed (no token returned)");
  return data.idToken;
}

/** Loads the visitor list. Rejects when the sign-in details are wrong. */
export async function loadVisitors(email: string, password: string): Promise<VisitorRow[]> {
  const idToken = await signInAdmin(email, password);
  const res = await fetch(
    `${DB_URL}/customers.json?auth=${encodeURIComponent(idToken)}&orderBy=%22lastVisit%22`,
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(
      body?.error ||
        `Signed in, but the database rejected the read (${res.status}). Check that the database rules were published and that the admin email in the rules matches exactly.`,
    );
  }
  const data = (await res.json()) as Record<string, RawVisitor> | null;
  if (!data) return [];
  return Object.entries(data)
    .map(([key, v]) => ({
      id: v.id || key,
      deviceType: v.deviceType ?? null,
      browser: v.browser ?? null,
      os: v.os ?? null,
      screen: v.screen ?? null,
      country: v.country ?? null,
      countryCode: v.countryCode ?? null,
      visitCount: Number(v.visitCount) || 0,
      photoCount: Number(v.photoCount) || 0,
      totalMs: Number(v.totalMs) || 0,
      firstVisit: Number(v.firstVisit) || 0,
      lastVisit: Number(v.lastVisit) || 0,
    }))
    .sort((a, b) => b.lastVisit - a.lastVisit);
}
