/* Postback signature verification.
 *
 * A provider postback is an unauthenticated HTTP request, so the only thing
 * that proves it came from the provider is the signature/secret the provider
 * and this server share. Schemes are configured per provider in the admin
 * panel. `none` exists only for providers that call back from a fixed IP and
 * is refused unless the operator explicitly opts in.
 */
import crypto from "node:crypto";

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function canonical(provider, params, secret) {
  const fields = provider.signature.params.length
    ? provider.signature.params
    : [provider.postback.uidParam, provider.postback.txnParam, provider.postback.amountParam];
  const joined = fields.map((field) => String(params[field] ?? "")).join(":");
  // Secret goes last so an empty trailing field cannot be confused with it.
  return `${joined}:${secret}`;
}

/**
 * @returns {{ok: boolean, reason: string}}
 */
export function verifySignature(provider, params, secret) {
  const signature = provider.signature;
  switch (signature.scheme) {
    case "none":
      return provider.allowUnsigned === true
        ? { ok: true, reason: "unsigned-allowed" }
        : { ok: false, reason: "provider signature scheme is 'none' but allowUnsigned is off" };

    case "shared-secret": {
      if (!secret) return { ok: false, reason: "provider secret is not configured" };
      const supplied = params[signature.param] ?? params.secret ?? params.token ?? "";
      if (!supplied) return { ok: false, reason: `missing ${signature.param}` };
      return timingSafeEqual(supplied, secret)
        ? { ok: true, reason: "shared-secret" }
        : { ok: false, reason: "secret mismatch" };
    }

    case "md5-uid": {
      if (!secret) return { ok: false, reason: "provider secret is not configured" };
      const uid = params[provider.postback.uidParam] ?? "";
      const supplied = params[signature.param] ?? "";
      if (!uid || !supplied) return { ok: false, reason: `missing ${signature.param}` };
      const expected = crypto.createHash("md5").update(`${uid}${secret}`).digest("hex");
      return timingSafeEqual(String(supplied).toLowerCase(), expected)
        ? { ok: true, reason: "md5-uid" }
        : { ok: false, reason: "hash mismatch" };
    }

    case "hmac-sha256": {
      if (!secret) return { ok: false, reason: "provider secret is not configured" };
      const supplied = params[signature.param] ?? params.signature ?? "";
      if (!supplied) return { ok: false, reason: `missing ${signature.param}` };
      const digest = crypto
        .createHmac("sha256", secret)
        .update(canonical(provider, params, secret))
        .digest(signature.encoding === "base64" ? "base64" : "hex");
      return timingSafeEqual(String(supplied), digest)
        ? { ok: true, reason: "hmac-sha256" }
        : { ok: false, reason: "signature mismatch" };
    }

    default:
      return { ok: false, reason: "unknown signature scheme" };
  }
}

/** Parameters that change how a reward is applied, not who is asking. */
export function normalizeParams(source) {
  const out = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (Array.isArray(value)) out[key] = value[0];
    else if (value === undefined || value === null) out[key] = "";
    else out[key] = typeof value === "object" ? value : String(value).slice(0, 500);
  }
  return out;
}

export function isReversal(provider, params) {
  const statusValue = String(params[provider.postback.statusParam] ?? "").toLowerCase();
  const list = String(provider.postback.reversalValues || "")
    .toLowerCase()
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return list.includes(statusValue);
}

export function isFirebaseUid(uid) {
  return typeof uid === "string" && uid.length >= 6 && uid.length <= 128 && /^[A-Za-z0-9_-]+$/.test(uid);
}
