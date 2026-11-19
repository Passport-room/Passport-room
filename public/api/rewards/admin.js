/* Admin-only rewards operations.
 *
 *   POST /api/rewards/admin  { action, ... }
 *   Authorization: Bearer <Firebase ID token of an account listed under /admins>
 *
 * Configuration itself is written by the admin page straight to
 * /rewards/config (database rules allow admins and nobody else). Anything that
 * moves a balance goes through this endpoint so the balance write is atomic,
 * audited and impossible from a browser.
 */
import { loadConfig, normalizeProvider, providerSecret, requireConfigured } from "./_lib/config.js";
import { applyEvent, readUser } from "./_lib/ledger.js";
import { buildLaunchUrl, missingLaunchFields } from "./_lib/session.js";
import { dbGet, isAdminUid, verifyIdToken } from "./_lib/google.js";
import {
  applyCors,
  bearerToken,
  logEvent,
  readBody,
  sendJson,
} from "./_lib/http.js";
import { normalizeParams, verifySignature } from "./_lib/verify.js";

export default async function handler(req, res) {
  if (!applyCors(req, res)) return sendJson(res, 403, { error: "origin not allowed" });
  if (req.method === "OPTIONS") return sendJson(res, 204, {});
  if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });

  try {
    const token = bearerToken(req);
    if (!token) return sendJson(res, 401, { error: "sign in required" });
    await requireConfigured();
    const { uid: adminUid } = await verifyIdToken(token);
    if (!(await isAdminUid(adminUid))) {
      logEvent("error", "non-admin called the rewards admin API", { uid: adminUid });
      return sendJson(res, 403, { error: "This account is not an admin." });
    }

    const body = await readBody(req);
    const action = String(body.action || "").trim();
    const config = await loadConfig();

    if (action === "lookup") {
      const uid = String(body.uid || "").trim();
      if (!uid) return sendJson(res, 400, { error: "uid is required" });
      const user = await readUser(uid);
      return sendJson(res, 200, { user });
    }

    if (action === "reverse") {
      const uid = String(body.uid || "").trim();
      const key = String(body.txnKey || "").trim();
      const reason = String(body.reason || "").slice(0, 300);
      if (!uid || !key) return sendJson(res, 400, { error: "uid and txnKey are required" });

      const { data: original } = await dbGet(`rewards/transactions/${uid}/${key}`);
      if (!original || typeof original !== "object") {
        return sendJson(res, 404, { error: "Transaction not found." });
      }
      if (original.kind === "reversal") {
        return sendJson(res, 400, { error: "A reversal cannot be reversed." });
      }
      if (!(Number(original.points) > 0)) {
        return sendJson(res, 400, { error: "This transaction has no points to take back." });
      }

      const provider =
        config.providersById[original.providerId] ||
        normalizeProvider({ id: String(original.providerId || "manual"), name: String(original.providerId || "manual") });

      const result = await applyEvent({
        uid,
        provider,
        settings: config.settings,
        providerTxnId: `${original.providerTxnId || key}#reversal`,
        kind: "reversal",
        rawAmount: 0,
        rawPoints: Number(original.points) || 0,
        reason: reason || `Reversed by admin ${adminUid}`,
        raw: { source: "admin", adminUid, originalKey: key, reason },
      });

      logEvent("log", "admin reward reversal", {
        adminUid,
        uid,
        txnKey: key,
        status: result.status,
        points: result.points,
      });
      return sendJson(res, 200, { result });
    }

    if (action === "test") {
      const providerId = String(body.provider || "").trim();
      const provider = config.providersById[providerId];
      if (!provider) return sendJson(res, 404, { error: "Unknown provider." });
      const params = normalizeParams(body.params || {});
      const { secret, source } = await providerSecret(provider);
      const verdict = verifySignature(provider, params, secret);
      const previewUid = String(body.uid || "test-visitor-uid").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "test-visitor-uid";
      return sendJson(res, 200, {
        signature: verdict,
        secretConfigured: Boolean(secret),
        secretSource: source || null,
        missingLaunchFields: missingLaunchFields(provider),
        sampleLaunchUrl: provider.launchUrl ? buildLaunchUrl(provider, secret, previewUid) : "",
      });
    }

    if (action === "status") {
      const providers = [];
      for (const provider of config.providers) {
        const { secret, source } = await providerSecret(provider);
        providers.push({
          id: provider.id,
          enabled: provider.enabled,
          secretConfigured: Boolean(secret),
          secretSource: source || null,
          launchConfigured: missingLaunchFields(provider).length === 0,
          missingLaunchFields: missingLaunchFields(provider),
        });
      }
      return sendJson(res, 200, {
        rewardsEnabled: config.settings.enabled === true,
        providerCount: config.providers.length,
        providers,
      });
    }

    return sendJson(res, 400, { error: "Unknown action." });
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    logEvent("error", "rewards admin action failed", { error: message.slice(0, 300) });
    return sendJson(res, 500, {
      error: "The action failed.",
      detail: process.env.REWARDS_DEBUG === "true" ? message.slice(0, 300) : undefined,
    });
  }
}
