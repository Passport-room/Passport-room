// Admin-panel access to the Firebase Realtime Database.
//
// Visitor records cannot be read by the public web key (see firebase-rules.json).
// The admin panel unlocks them with the database secret typed into the form,
// which is sent as `?auth=...` — nothing is stored in the code or on the host.
export const DB_URL = "https://passport-48389-default-rtdb.firebaseio.com";

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

/** Loads the visitor list. Rejects when the secret is wrong. */
export async function loadVisitors(secret: string): Promise<VisitorRow[]> {
  const res = await fetch(
    `${DB_URL}/customers.json?auth=${encodeURIComponent(secret)}&orderBy=%22lastVisit%22`,
  );
  if (!res.ok) throw new Error("unauthorized");
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
