/* Starts a provider wall for the signed-in visitor.
 *
 *   POST /api/rewards/session   { provider: "<id>" }
 *   Authorization: Bearer <Firebase ID token>
 *
 * The visitor is identified by their existing Firebase anonymous UID (never a
 * client-supplied id), and the provider URL is assembled here so that a
 * provider secret used for user hashing never reaches the browser.
 */
import { loadConfig, pointsPerUnit, providerSecret, requireConfigured } from "./_lib/config.js";
import { readUser } from "./_lib/ledger.js";
import { buildLaunchUrl, missingLaunchFields, requiresHash } from "./_lib/session.js";
import { verifyIdToken } from "./_lib/google.js";
import { applyCors, bearerToken, logEvent, readBody, sendJson } from "./_lib/http.js";

export default async function handler(req, res) {
  if (!applyCors(req, res)) return sendJson(res, 403, { error: "origin not allowed" });
  if (req.method === "OPTIONS") return sendJson(res, 204, {});
  if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });

  try {
    const token = bearerToken(req);
    if (!token) return sendJson(res, 401, { error: "sign in required" });

    await requireConfigured();
    const { uid } = await verifyIdToken(token);

    const body = await readBody(req);
    const providerId = String(body.provider || "").trim();
    if (!providerId) return sendJson(res, 400, { error: "provider is required" });

    const config = await loadConfig();
    if (!config.settings.enabled) {
      return sendJson(res, 403, {
        error: "Rewards are not open yet.",
        detail: config.settings.maintenanceMessage || "",
      });
    }
    const provider = config.providersById[providerId];
    if (!provider || !provider.enabled) {
      return sendJson(res, 404, { error: "This provider is not available." });
    }

    const missing = missingLaunchFields(provider);
    if (missing.length) {
      logEvent("error", "provider launch is incomplete", { providerId, missing });
      return sendJson(res, 503, {
        error: "This provider is not fully configured yet.",
        missing,
      });
    }

    const { secret, source } = await providerSecret(provider);
    if (requiresHash(provider) && !secret) {
      return sendJson(res, 503, { error: "This provider's server secret is not configured yet." });
    }

    const user = await readUser(uid);
    const cap = Number(config.settings.dailyEarnCapPoints) || 0;
    const earnedToday = Math.max(0, Math.round(Number(user.today.earned) || 0));
    if (cap > 0 && earnedToday >= cap) {
      return sendJson(res, 429, {
        error: "You have reached today's reward limit. Come back tomorrow.",
        dailyEarnCapPoints: cap,
        earnedToday,
      });
    }

    const url = buildLaunchUrl(provider, secret, uid);
    logEvent("log", "provider session started", {
      providerId,
      uid,
      secretSource: source || "none",
    });

    return sendJson(res, 200, {
      url,
      mode: provider.mode,
      height: provider.height,
      provider: {
        id: provider.id,
        name: provider.name,
        category: provider.category,
      },
      balance: user.balance,
      pointsPerUnit: pointsPerUnit(provider, config.settings),
      unit: config.settings.unit,
      earnedToday,
      dailyEarnCapPoints: cap,
      minPayoutPoints: Number(config.settings.minPayoutPoints) || 0,
    });
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    const unauthorized = /token|signature|issuer|audience|expired/i.test(message);
    logEvent("error", "reward session failed", { error: message.slice(0, 300) });
    return sendJson(res, unauthorized ? 401 : 500, {
      error: unauthorized ? "Your session has expired. Reload the page." : "Could not start this offer wall.",
      detail: process.env.REWARDS_DEBUG === "true" ? message.slice(0, 300) : undefined,
    });
  }
}
