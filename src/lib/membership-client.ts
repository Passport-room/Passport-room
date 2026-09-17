// Browser helpers for the /payment page: access status, Paddle checkout,
// and email restore. Mirrors src/client/membership.js (used by the studio) so
// both pages share the exact same device id and cached state.

export const FREE_DAILY_LIMIT = 3;
export const PLAN_DAYS = 30;

const DEVICE_KEY = "pr_device_id";
const STATE_KEY = "pr_pro_state_v1";
const EMAIL_KEY = "pr_pro_email";
const USAGE_KEY = "pr_free_usage_v1";

export type MembershipState = {
  pro: boolean;
  status: "active" | "expired" | "none";
  startedAt: number | null;
  expiresAt: number | null;
  daysLeft: number;
  email: string | null;
};

export const EMPTY_STATE: MembershipState = {
  pro: false,
  status: "none",
  startedAt: null,
  expiresAt: null,
  daysLeft: 0,
  email: null,
};

export type PaddleConfig = {
  configured: boolean;
  /** Names (never values) of payment settings still missing on the server. */
  missing?: string[];
  environment: "sandbox" | "production";
  clientToken: string | null;
  priceId: string | null;
  priceLabel: string;
  planDays: number;
  freeDailyLimit: number;
};

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function getDeviceId(): string {
  const existing = safe(() => localStorage.getItem(DEVICE_KEY), null);
  if (existing) return existing;
  const id =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `dev_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  safe(() => localStorage.setItem(DEVICE_KEY, id), undefined);
  return id;
}

export function getSavedEmail(): string | null {
  return safe(() => localStorage.getItem(EMAIL_KEY), null);
}

export function saveEmail(email: string): void {
  safe(() => localStorage.setItem(EMAIL_KEY, email.trim().toLowerCase()), undefined);
}

export function cacheState(state: MembershipState): void {
  safe(() => localStorage.setItem(STATE_KEY, JSON.stringify(state)), undefined);
}

export function readCachedState(): MembershipState {
  const raw = safe(
    () => JSON.parse(localStorage.getItem(STATE_KEY) || "null") as MembershipState | null,
    null,
  );
  if (!raw) return EMPTY_STATE;
  const merged = { ...EMPTY_STATE, ...raw };
  if (merged.expiresAt && merged.expiresAt <= Date.now()) {
    return { ...merged, pro: false, status: "expired", daysLeft: 0 };
  }
  return merged;
}

export function freeRemainingToday(): number {
  const d = new Date();
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
  const raw = safe(
    () => JSON.parse(localStorage.getItem(USAGE_KEY) || "null") as { date?: string; count?: number },
    {},
  );
  const used = raw && raw.date === key ? Number(raw.count) || 0 : 0;
  return Math.max(0, FREE_DAILY_LIMIT - used);
}

export async function fetchPaddleConfig(): Promise<PaddleConfig> {
  const res = await fetch("/api/public/paddle/config", { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error("Could not load payment settings.");
  return (await res.json()) as PaddleConfig;
}

export async function fetchMembership(): Promise<MembershipState> {
  const params = new URLSearchParams({ deviceId: getDeviceId() });
  const email = getSavedEmail();
  if (email) params.set("email", email);
  const res = await fetch(`/api/public/membership?${params.toString()}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error("Could not check your membership.");
  const data = (await res.json()) as MembershipState & { unavailable?: boolean };
  if (data.unavailable) return readCachedState();
  const state: MembershipState = {
    pro: Boolean(data.pro),
    status: data.status || "none",
    startedAt: data.startedAt ?? null,
    expiresAt: data.expiresAt ?? null,
    daysLeft: Number(data.daysLeft) || 0,
    email: data.email ?? email ?? null,
  };
  cacheState(state);
  return state;
}

export async function restoreWithEmail(email: string): Promise<MembershipState> {
  const res = await fetch("/api/public/membership/restore", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, deviceId: getDeviceId() }),
  });
  const data = (await res.json().catch(() => null)) as
    | (MembershipState & { error?: string })
    | null;
  if (!res.ok || !data) throw new Error(data?.error || "Could not restore your membership.");
  saveEmail(email);
  const state: MembershipState = {
    pro: Boolean(data.pro),
    status: data.status || "none",
    startedAt: data.startedAt ?? null,
    expiresAt: data.expiresAt ?? null,
    daysLeft: Number(data.daysLeft) || 0,
    email: data.email ?? email,
  };
  cacheState(state);
  return state;
}

/* -------------------------------- Paddle.js -------------------------------- */

type PaddleCheckoutOptions = {
  items: Array<{ priceId: string; quantity: number }>;
  customData?: Record<string, string>;
  customer?: { email: string };
  settings?: Record<string, unknown>;
};

type PaddleGlobal = {
  Environment: { set: (env: string) => void };
  Initialize: (options: { token: string; eventCallback?: (event: unknown) => void }) => void;
  Checkout: { open: (options: PaddleCheckoutOptions) => void };
};

declare global {
  interface Window {
    Paddle?: PaddleGlobal;
  }
}

let paddlePromise: Promise<PaddleGlobal> | null = null;

async function loadPaddle(config: PaddleConfig): Promise<PaddleGlobal> {
  if (!config.clientToken) throw new Error("Payments are not configured yet.");
  if (paddlePromise) return paddlePromise;

  paddlePromise = new Promise<PaddleGlobal>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>("script[data-paddle-js]");
    const ready = () => {
      const paddle = window.Paddle;
      if (!paddle) {
        reject(new Error("Payment window could not start. Please refresh and try again."));
        return;
      }
      try {
        if (config.environment === "sandbox") paddle.Environment.set("sandbox");
        paddle.Initialize({ token: config.clientToken! });
        resolve(paddle);
      } catch (err) {
        reject(err instanceof Error ? err : new Error("Payment window could not start."));
      }
    };

    if (window.Paddle) return ready();
    if (existing) {
      existing.addEventListener("load", ready);
      existing.addEventListener("error", () =>
        reject(new Error("Payment window could not load. Check your connection.")),
      );
      return;
    }

    const script = document.createElement("script");
    script.src = "https://cdn.paddle.com/paddle/v2/paddle.js";
    script.async = true;
    script.dataset["paddleJs"] = "1";
    script.addEventListener("load", ready);
    script.addEventListener("error", () =>
      reject(new Error("Payment window could not load. Check your connection.")),
    );
    document.head.appendChild(script);
  }).catch((err) => {
    paddlePromise = null;
    throw err;
  });

  return paddlePromise;
}

/** Opens the Paddle overlay checkout for the $0.99 / 30 days pass. */
export async function openCheckout(config: PaddleConfig, email?: string | null): Promise<void> {
  if (!config.configured || !config.priceId) {
    throw new Error("Payments are not switched on yet. Please try again later.");
  }
  const paddle = await loadPaddle(config);
  const successUrl = `${window.location.origin}/payment?paid=1`;
  paddle.Checkout.open({
    items: [{ priceId: config.priceId, quantity: 1 }],
    // The webhook reads this to know which device to unlock.
    customData: { device_id: getDeviceId() },
    ...(email ? { customer: { email } } : {}),
    settings: {
      displayMode: "overlay",
      theme: "dark",
      successUrl,
      allowLogout: false,
    },
  });
}
