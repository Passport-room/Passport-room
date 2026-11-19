/* Builds a provider launch URL for a signed-in anonymous visitor.
 *
 * The URL is built on the server because providers that bind the visitor id to
 * a hash need the shared secret to compute it. Returning the finished URL keeps
 * the secret out of the browser.
 */
import crypto from "node:crypto";

export function userHash(provider, secret, uid) {
  switch (provider.signature.scheme) {
    case "md5-uid":
      return secret ? crypto.createHash("md5").update(`${uid}${secret}`).digest("hex") : "";
    case "hmac-sha256":
      return secret
        ? crypto.createHmac("sha256", secret).update(uid).digest("hex")
        : "";
    default:
      return "";
  }
}

export function requiresHash(provider) {
  return provider.signature.scheme === "md5-uid" || provider.signature.scheme === "hmac-sha256";
}

/**
 * Replace {placeholders} in the admin-configured launch URL. Unknown
 * placeholders are left alone so a misconfiguration is visible instead of
 * silently sending an empty value to the provider.
 */
export function buildLaunchUrl(provider, secret, uid) {
  const hash = userHash(provider, secret, uid);
  const values = {
    uid,
    user_id: uid,
    subid: uid,
    subid1: uid,
    hash,
    secure_hash: hash,
    app_id: provider.appId,
    appId: provider.appId,
  };
  return String(provider.launchUrl || "").replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(values, name) ? encodeURIComponent(values[name] ?? "") : match,
  );
}

export function missingLaunchFields(provider) {
  const missing = [];
  if (!String(provider.launchUrl || "").trim()) missing.push("launch url");
  if (/\{appId\}|\{app_id\}/.test(provider.launchUrl) && !String(provider.appId || "").trim()) {
    missing.push("app id");
  }
  if (!/\{uid\}|\{user_id\}|\{subid\}|\{subid1\}/.test(provider.launchUrl)) {
    missing.push("a {uid} placeholder so the reward is tied to the visitor");
  }
  return missing;
}
