// Admin-panel access to the Firebase Realtime Database.
//
// Visitor records cannot be read by the public web key (see firebase-rules.json).
// The admin panel unlocks them with the database secret typed into the form,
// which is sent as `?auth=...` — nothing is stored in the code or on the host.
export const DB_URL = "https://passport-48389-default-rtdb.firebaseio.com";

export type PhotoSplit = {
  total: number;
  single: number;
  sheet: number;
  dress: number;
  enhance: number;
  bgremove: number;
};

export type VisitorRow = {
  uid: string;
  code: string;
  deviceType: string | null;
  browser: string | null;
  os: string | null;
  screen: string | null;
  language: string | null;
  timeZone: string | null;
  country: string | null;
  countryCode: string | null;
  visits: number;
  photos: PhotoSplit;
  totalMs: number;
  createdAt: number;
  lastSeenAt: number;
  migratedFrom: string | null;
};

type RawVisitor = {
  code?: string;
  deviceType?: string;
  browser?: string;
  os?: string;
  screen?: string;
  language?: string;
  timeZone?: string;
  country?: string;
  countryCode?: string;
  visits?: number;
  totalMs?: number;
  createdAt?: number;
  lastSeenAt?: number;
  migratedFrom?: string;
  photos?: Partial<PhotoSplit>;
};

const num = (v: unknown) => Number(v) || 0;

/** Loads the visitor list. Rejects when the secret is wrong. */
export async function loadVisitors(secret: string): Promise<VisitorRow[]> {
  const res = await fetch(`${DB_URL}/users.json?auth=${encodeURIComponent(secret)}`);
  if (!res.ok) throw new Error("unauthorized");
  const data = (await res.json()) as Record<string, RawVisitor> | null;
  if (!data) return [];

  return Object.entries(data)
    .map(([uid, v]) => {
      const p = v.photos ?? {};
      const split: PhotoSplit = {
        single: num(p.single),
        sheet: num(p.sheet),
        dress: num(p.dress),
        enhance: num(p.enhance),
        bgremove: num(p.bgremove),
        total: num(p.total),
      };
      if (!split.total) {
        split.total = split.single + split.sheet + split.dress + split.enhance + split.bgremove;
      }
      return {
        uid,
        code: v.code || uid.slice(0, 8),
        deviceType: v.deviceType ?? null,
        browser: v.browser ?? null,
        os: v.os ?? null,
        screen: v.screen ?? null,
        language: v.language ?? null,
        timeZone: v.timeZone ?? null,
        country: v.country ?? null,
        countryCode: v.countryCode ?? null,
        visits: num(v.visits),
        photos: split,
        totalMs: num(v.totalMs),
        createdAt: num(v.createdAt),
        lastSeenAt: num(v.lastSeenAt),
        migratedFrom: v.migratedFrom ?? null,
      };
    })
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}
