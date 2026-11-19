/* Provider postback endpoint.
 *
 *   GET/POST /api/rewards/postback?provider=<id>&...
 *
 * The provider's dashboard points at this URL. Every request is verified with
 * the provider's configured signature before anything is written. Successful
 * credits are idempotent: the same provider transaction id can never pay a
 * balance twice.
 */
import { loadConfig, providerSecret, requireConfigured } from "./_lib/config.js";
import { applyEvent } from "./_lib/ledger.js";
import { isFirebaseUid, isReversal, normalizeParams, verifySignature } from "./_lib/verify.js";
import { logEvent, readBody, requestUrl, sendText } from "./_lib/http.js";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return sendText(res, 204, "");

  let providerId = "";
  let uid = "";
  let providerTxnId = "";
  try {
    const url = requestUrl(req);
    const body = req.method === "POST" ? await readBody(req) : {};
    const params = normalizeParams({
      ...Object.fromEntries(url.searchParams.entries()),
      ...(body && typeof body === "object" ? body : {}),
    });
    providerId = String(params.provider || url.searchParams.get("provider") || "").trim();

    if (!providerId) return sendText(res, 400, "missing provider");
    await requireConfigured();

    const config = await loadConfig();
    const provider = config.providersById[providerId];
    if (!provider) {
      logEvent("error", "postback for unknown provider", { providerId });
      return sendText(res, 404, "unknown provider");
    }
    if (!config.settings.enabled) return sendText(res, 403, "rewards are disabled");
    if (!provider.enabled) return sendText(res, 403, "provider is disabled");

    const { secret } = await providerSecret(provider);
    const verdict = verifySignature(provider, params, secret);
    if (!verdict.ok) {
      logEvent("error", "postback signature rejected", {
        providerId,
        reason: verdict.reason,
      });
      return sendText(res, 401, "signature rejected");
    }

    uid = String(params[provider.postback.uidParam] ?? "").trim();
    providerTxnId = String(params[provider.postback.txnParam] ?? "").trim();
    if (!uid) uid = String(params.user_id || params.subid || params.subid1 || "").trim();
    if (!isFirebaseUid(uid)) {
      logEvent("error", "postback with invalid user id", { providerId, reason: "bad uid" });
      return sendText(res, 400, "invalid user");
    }
    if (!providerTxnId) {
      logEvent("error", "postback without transaction id", { providerId, uid });
      return sendText(res, 400, "missing transaction id");
    }

    const rawAmount = Number(params[provider.postback.amountParam]);
    const rawPoints = Number(params.points ?? params.reward ?? params.amount_points);
    const reversal = isReversal(provider, params) || (Number.isFinite(rawAmount) && rawAmount < 0);
    if (!Number.isFinite(rawAmount) && !Number.isFinite(rawPoints)) {
      logEvent("error", "postback without an amount", { providerId, uid });
      return sendText(res, 400, "missing amount");
    }

    const result = await applyEvent({
      uid,
      provider,
      settings: config.settings,
      providerTxnId,
      kind: reversal ? "reversal" : "credit",
      rawAmount: Number.isFinite(rawAmount) ? Math.abs(rawAmount) : 0,
      rawPoints: Number.isFinite(rawPoints) ? Math.abs(rawPoints) : undefined,
      raw: params,
      reason: String(params.reason || params.status || ""),
    });

    logEvent("log", "postback applied", {
      providerId,
      uid,
      txn: providerTxnId,
      kind: reversal ? "reversal" : "credit",
      status: result.status,
      points: result.points,
    });

    if (result.status === "conflict") return sendText(res, 409, "conflict");
    if (result.status === "processing") return sendText(res, 409, "processing, retry later");
    if (result.status === "invalid-amount") return sendText(res, 400, "invalid amount");

    // 200 for credited, capped, reversed and duplicate: the provider should
    // stop retrying in all of those cases. A duplicate is a success, not an
    // error, so a retry after a network blip does not look like a failure.
    return sendText(res, 200, "OK");
  } catch (error) {
    logEvent("error", "postback failed", {
      providerId,
      uid,
      txn: providerTxnId,
      error: String(error && error.message ? error.message : error).slice(0, 300),
    });
    return sendText(res, 500, "server error");
  }
}
