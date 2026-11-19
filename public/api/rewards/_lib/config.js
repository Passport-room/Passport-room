/* Reward configuration.
 *
 * Public settings and provider definitions live in /rewards/config and are
 * readable by the site so it can render the page. Provider secrets never live
 * there: they are read from an environment variable first, then from
 * /rewardsSecrets (a node no client can read, enforced by database rules).
 */
import { dbGet, ConfigError } from "./google.js";

export const DEFAULT_SETTINGS = {
  enabled: false,
  pointsPerUnit: 1000,
  unit: "USD",
  dailyEarnCapPoints: 5000,
  minPayoutPoints: 1000,
  maintenanceMessage: "",
  termsUrl: "/terms-of-service",
};

export const DEFAULT_PROVIDER = {
  id: "",
  name: "",
  category: "survey",
  enabled: false,
  mode: "iframe",
  launchUrl: "",
  appId: "",
  height: 720,
  pointsPerUnit: 0, // 0 = inherit settings.pointsPerUnit
  rewardMode: "payout", // "payout" (provider sends money) or "points"
  maxPerEventPoints: 5000,
  minPayoutForCredit: 0,
  description: "",
  notes: "",
  postback: {
    uidParam: "user_id",
    amountParam: "amount",
    txnParam: "trans_id",
    statusParam: "status",
    reversalValues: "reversed,chargeback,reversal,declined,refund",
  },
  signature: {
    scheme: "shared-secret", // hmac-sha256 | md5-uid | shared-secret | none
    param: "token",
    secretEnv: "",
    params: [],
    encoding: "hex",
  },
};

export const CATEGORIES = ["survey", "offer", "video"];

function merge(base, override) {
  if (!override || typeof override !== "object") return { ...base };
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = merge(base[key] && typeof base[key] === "object" ? base[key] : {}, value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

export function normalizeProvider(raw) {
  const provider = merge(DEFAULT_PROVIDER, raw);
  provider.id = String(provider.id || "").trim();
  provider.name = String(provider.name || provider.id).trim();
  provider.enabled = provider.enabled === true;
  provider.category = CATEGORIES.includes(provider.category) ? provider.category : "survey";
  provider.mode = provider.mode === "link" ? "link" : "iframe";
  provider.height = Math.min(Math.max(Number(provider.height) || 720, 320), 4000);
  provider.pointsPerUnit = Number(provider.pointsPerUnit) || 0;
  provider.maxPerEventPoints = Math.min(
    Math.max(Number(provider.maxPerEventPoints) || DEFAULT_PROVIDER.maxPerEventPoints, 1),
    1_000_000,
  );
  provider.signature.scheme = ["hmac-sha256", "md5-uid", "shared-secret", "none"].includes(
    provider.signature.scheme,
  )
    ? provider.signature.scheme
    : "shared-secret";
  provider.signature.params = Array.isArray(provider.signature.params)
    ? provider.signature.params.map(String)
    : String(provider.signature.params || "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
  return provider;
}

export async function loadConfig() {
  let data = null;
  try {
    ({ data } = await dbGet("rewards/config"));
  } catch (error) {
    // A missing node is fine (nothing configured yet); a rules/credential
    // problem is not — surface it as a server error.
    if (!String(error.message).includes("denied")) throw error;
  }
  const config = data && typeof data === "object" ? data : {};
  const settings = merge(DEFAULT_SETTINGS, config.settings || {});
  const providers = Object.entries(config.providers || {})
    .map(([id, provider]) => normalizeProvider({ ...(provider || {}), id }))
    .filter((provider) => provider.id)
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  return {
    settings,
    providers,
    providersById: Object.fromEntries(providers.map((provider) => [provider.id, provider])),
    raw: config,
  };
}

export function pointsPerUnit(provider, settings) {
  return Number(provider.pointsPerUnit) || Number(settings.pointsPerUnit) || 0;
}

/**
 * Points for a provider payout. `rawAmount` is what the provider says it paid,
 * in its own unit (normally USD). Never a client-supplied point total.
 */
export function pointsForPayout(provider, settings, rawAmount, rawPoints) {
  if (provider.rewardMode === "points") {
    const points = Math.round(Number(rawPoints ?? rawAmount) || 0);
    return clampEvent(points, provider);
  }
  const rate = pointsPerUnit(provider, settings);
  const points = Math.round((Number(rawAmount) || 0) * rate);
  return clampEvent(points, provider);
}

function clampEvent(points, provider) {
  if (!Number.isFinite(points) || points <= 0) return 0;
  return Math.min(points, provider.maxPerEventPoints);
}

function envNameFor(provider) {
  if (provider.signature.secretEnv) return String(provider.signature.secretEnv).trim();
  const slug = provider.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return `REWARDS_SECRET_${slug}`;
}

/** Provider secret: environment variable wins, then the private DB node. */
export async function providerSecret(provider) {
  const envName = envNameFor(provider);
  const fromEnv = process.env[envName];
  if (fromEnv && fromEnv.trim()) return { secret: fromEnv.trim(), source: `env:${envName}` };

  const { data } = await dbGet(`rewardsSecrets/providers/${provider.id}/secret`);
  if (typeof data === "string" && data.trim()) {
    return { secret: data.trim(), source: "database" };
  }
  return { secret: "", source: "" };
}

export function secretEnvName(provider) {
  return envNameFor(provider);
}

export async function requireConfigured() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON && !process.env.FIREBASE_CLIENT_EMAIL) {
    throw new ConfigError(
      "Firebase Admin credentials are not set. Add FIREBASE_SERVICE_ACCOUNT_JSON to the " +
        "Vercel environment variables and redeploy. See REWARDS-SETUP.md.",
    );
  }
}
