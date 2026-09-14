// Pro membership storage + Paddle helpers (server only).
//
// Membership records live in the same Firebase Realtime Database the studio
// already uses, under two paths that the public database rules deny entirely:
//
//   memberships/<deviceId>        the access record used by the studio
//   membershipEmails/<emailKey>   lookup so a buyer can restore on a new device
//
// Only this server code can read or write them, because it authenticates with
// the database secret (FIREBASE_DB_SECRET) which never reaches the browser.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Days of unlimited access one $0.99 payment grants. */
export const PLAN_DAYS = 30;
/** Photos a free visitor may create per day. */
export const FREE_DAILY_LIMIT = 3;

const DB_URL = "https://passport-48389-default-rtdb.firebaseio.com";
const DAY_MS = 24 * 60 * 60 * 1000;

export type MembershipRecord = {
  deviceId: string;
  email: string | null;
  emailKey: string | null;
  startedAt: number;
  expiresAt: number;
  transactionId: string | null;
  priceId: string | null;
  environment: string;
  updatedAt: number;
};

export type MembershipStatus = {
  pro: boolean;
  status: "active" | "expired" | "none";
  startedAt: number | null;
  expiresAt: number | null;
  daysLeft: number;
  email: string | null;
  planDays: number;
  freeDailyLimit: number;
};

export const NO_MEMBERSHIP: MembershipStatus = {
  pro: false,
  status: "none",
  startedAt: null,
  expiresAt: null,
  daysLeft: 0,
  email: null,
  planDays: PLAN_DAYS,
  freeDailyLimit: FREE_DAILY_LIMIT,
};

function dbSecret(): string {
  // Trim: a stray newline from copy/paste makes Firebase answer 401.
  const secret = (process.env["FIREBASE_DB_SECRET"] ?? "").trim();
  if (!secret) throw new Error("FIREBASE_DB_SECRET is not configured");
  return secret;
}

function path(p: string): string {
  return `${DB_URL}/${p}.json?auth=${encodeURIComponent(dbSecret())}`;
}

async function dbGet<T>(p: string): Promise<T | null> {
  const res = await fetch(path(p));
  if (!res.ok) throw new Error(`database read failed (${res.status})`);
  return (await res.json()) as T | null;
}

async function dbPut(p: string, value: unknown): Promise<void> {
  const res = await fetch(path(p), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
  if (!res.ok) throw new Error(`database write failed (${res.status})`);
}

/**
 * Atomic-ish claim of a Paddle transaction id so a retried (or replayed)
 * webhook delivery can never grant a second 30-day period.
 * Firebase REST supports conditional creation through `PUT` on a child with
 * `?print=silent`, so we read-then-write and treat an existing record as
 * "already processed".
 */
function transactionKey(transactionId: string): string {
  return transactionId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
}

/** Frees a claim when activation failed, so Paddle's retry can succeed. */
export async function releaseTransaction(transactionId: string): Promise<void> {
  const key = transactionKey(transactionId);
  if (!key) return;
  try {
    await fetch(path(`paddleTransactions/${key}`), { method: "DELETE" });
  } catch {
    /* best effort */
  }
}

export async function claimTransaction(transactionId: string): Promise<boolean> {
  const key = transactionKey(transactionId);
  if (!key) return true;
  const existing = await dbGet<{ processedAt?: number }>(`paddleTransactions/${key}`);
  if (existing && existing.processedAt) return false;
  await dbPut(`paddleTransactions/${key}`, { processedAt: Date.now() });
  return true;
}

/** Stable, non-reversible key for an email address. */
export function emailKeyOf(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 40);
}

/** Keeps device ids to the safe shape Firebase paths accept. */
export function safeDeviceId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (!id || id.length > 64 || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
  return id;
}

export function isEmail(value: unknown): value is string {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());
}

export function toStatus(record: MembershipRecord | null): MembershipStatus {
  if (!record) return NO_MEMBERSHIP;
  const now = Date.now();
  const active = record.expiresAt > now;
  return {
    pro: active,
    status: active ? "active" : "expired",
    startedAt: record.startedAt ?? null,
    expiresAt: record.expiresAt ?? null,
    daysLeft: active ? Math.max(1, Math.ceil((record.expiresAt - now) / DAY_MS)) : 0,
    email: record.email ?? null,
    planDays: PLAN_DAYS,
    freeDailyLimit: FREE_DAILY_LIMIT,
  };
}

export async function readMembership(deviceId: string): Promise<MembershipRecord | null> {
  return dbGet<MembershipRecord>(`memberships/${deviceId}`);
}

export async function readMembershipByEmail(email: string): Promise<MembershipRecord | null> {
  const pointer = await dbGet<{ deviceId?: string }>(`membershipEmails/${emailKeyOf(email)}`);
  const deviceId = safeDeviceId(pointer?.deviceId);
  if (!deviceId) return null;
  return readMembership(deviceId);
}

/**
 * Best record for this visitor: the device record, or the one bought with the
 * given email (whichever lasts longer).
 */
export async function resolveMembership(
  deviceId: string | null,
  email: string | null,
): Promise<MembershipRecord | null> {
  const [byDevice, byEmail] = await Promise.all([
    deviceId ? readMembership(deviceId).catch(() => null) : Promise.resolve(null),
    email && isEmail(email) ? readMembershipByEmail(email).catch(() => null) : Promise.resolve(null),
  ]);
  if (byDevice && byEmail) return byEmail.expiresAt > byDevice.expiresAt ? byEmail : byDevice;
  return byDevice ?? byEmail ?? null;
}

/**
 * Grants (or renews) 30 days of unlimited access. Renewing before expiry adds
 * the new days on top of the days still left, so nobody loses paid time.
 * Re-processing the same Paddle transaction is a no-op.
 */
export async function activateMembership(input: {
  deviceId: string;
  email: string | null;
  transactionId: string | null;
  priceId: string | null;
  environment: string;
}): Promise<MembershipRecord> {
  const existing = await readMembership(input.deviceId).catch(() => null);
  if (
    existing &&
    input.transactionId &&
    existing.transactionId === input.transactionId &&
    existing.expiresAt > Date.now()
  ) {
    return existing;
  }

  const now = Date.now();
  const base = existing && existing.expiresAt > now ? existing.expiresAt : now;
  const record: MembershipRecord = {
    deviceId: input.deviceId,
    email: input.email ?? existing?.email ?? null,
    emailKey: input.email ? emailKeyOf(input.email) : (existing?.emailKey ?? null),
    startedAt: now,
    expiresAt: base + PLAN_DAYS * DAY_MS,
    transactionId: input.transactionId,
    priceId: input.priceId,
    environment: input.environment,
    updatedAt: now,
  };

  await dbPut(`memberships/${record.deviceId}`, record);
  if (record.emailKey) {
    await dbPut(`membershipEmails/${record.emailKey}`, {
      deviceId: record.deviceId,
      email: record.email,
      expiresAt: record.expiresAt,
      updatedAt: now,
    });
  }
  return record;
}

/** Copies an active membership onto another device (email restore). */
export async function restoreMembership(
  email: string,
  deviceId: string,
): Promise<MembershipStatus> {
  const source = await readMembershipByEmail(email);
  if (!source || source.expiresAt <= Date.now()) return toStatus(source);
  if (source.deviceId === deviceId) return toStatus(source);

  const now = Date.now();
  const copy: MembershipRecord = { ...source, deviceId, updatedAt: now };
  await dbPut(`memberships/${deviceId}`, copy);
  await dbPut(`membershipEmails/${emailKeyOf(email)}`, {
    deviceId,
    email: source.email,
    expiresAt: source.expiresAt,
    updatedAt: now,
  });
  return toStatus(copy);
}

/* ---------------------------------- Paddle --------------------------------- */

/** The one price the app sells ($0.99 / 30 days). Must be a `pri_...` id. */
export function expectedPriceId(): string | null {
  const id = (process.env["PADDLE_PRICE_ID"] ?? "").trim();
  return id.startsWith("pri_") ? id : null;
}

/**
 * Which payment settings are present. Returns names only — never values — so
 * it is safe to surface in a diagnostic response.
 */
export function paddleReadiness(): { configured: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!(process.env["PADDLE_CLIENT_TOKEN"] ?? "").trim()) missing.push("PADDLE_CLIENT_TOKEN");
  if (!expectedPriceId()) missing.push("PADDLE_PRICE_ID");
  if (!(process.env["PADDLE_API_KEY"] ?? "").trim()) missing.push("PADDLE_API_KEY");
  if (!(process.env["PADDLE_WEBHOOK_SECRET"] ?? "").trim()) missing.push("PADDLE_WEBHOOK_SECRET");
  if (!(process.env["FIREBASE_DB_SECRET"] ?? "").trim()) missing.push("FIREBASE_DB_SECRET");
  // Checkout itself only needs the browser token + price id; the rest are
  // required for the payment to be *honoured*, so they are reported too.
  const checkoutReady =
    !missing.includes("PADDLE_CLIENT_TOKEN") && !missing.includes("PADDLE_PRICE_ID");
  return { configured: checkoutReady, missing };
}

export function paddleEnvironment(): "sandbox" | "production" {
  return process.env["PADDLE_ENVIRONMENT"] === "production" ? "production" : "sandbox";
}

function paddleApiBase(): string {
  return paddleEnvironment() === "production"
    ? "https://api.paddle.com"
    : "https://sandbox-api.paddle.com";
}

/**
 * Verifies the `Paddle-Signature` header against the raw request body.
 * Format: `ts=<unix seconds>;h1=<hex hmac of "<ts>:<body>">`.
 */
export function verifyPaddleSignature(
  header: string | null,
  rawBody: string,
  secret: string,
): boolean {
  if (!header || !secret) return false;
  const parts = new Map<string, string>();
  for (const chunk of header.split(";")) {
    const idx = chunk.indexOf("=");
    if (idx > 0) parts.set(chunk.slice(0, idx).trim(), chunk.slice(idx + 1).trim());
  }
  const ts = parts.get("ts");
  const h1 = parts.get("h1");
  if (!ts || !h1) return false;

  // Reject replays older than 5 minutes.
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(age) || age > 300) return false;

  const expected = createHmac("sha256", secret).update(`${ts}:${rawBody}`).digest("hex");
  const a = Buffer.from(h1, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Looks up the buyer's email so they can restore access on another device. */
export async function fetchPaddleCustomerEmail(customerId: string | null): Promise<string | null> {
  const apiKey = process.env["PADDLE_API_KEY"];
  if (!customerId || !apiKey) return null;
  try {
    const res = await fetch(`${paddleApiBase()}/customers/${encodeURIComponent(customerId)}`, {
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { email?: string } };
    const email = body.data?.email;
    return isEmail(email) ? email.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}
