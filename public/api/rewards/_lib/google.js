/* Server-side access to the project's existing Firebase Realtime Database.
 *
 * Nothing here ever reaches the browser. Credentials come from Vercel
 * environment variables (a Firebase service account), never from a file in the
 * repository and never from a client request.
 *
 * Writes that change a balance use the Realtime Database conditional-request
 * API (ETag + `if-match`), which is the REST equivalent of a transaction. That
 * is what makes a credit/reversal atomic and safe against two postbacks
 * arriving at the same moment.
 */
import crypto from "node:crypto";

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = [
  "https://www.googleapis.com/auth/firebase.database",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

let tokenCache = null;

function projectId() {
  return process.env.FIREBASE_PROJECT_ID || "passport-48389";
}

function serviceAccount() {
  const raw =
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT || "";
  if (raw.trim().startsWith("{")) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ConfigError("FIREBASE_SERVICE_ACCOUNT_JSON is set but is not valid JSON.");
    }
    const clientEmail = parsed.client_email;
    const privateKey = String(parsed.private_key || "").replace(/\\n/g, "\n");
    if (!clientEmail || !privateKey) {
      throw new ConfigError(
        "FIREBASE_SERVICE_ACCOUNT_JSON is missing client_email or private_key.",
      );
    }
    return { clientEmail, privateKey, projectId: parsed.project_id || projectId() };
  }

  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL || "";
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if (!clientEmail || !privateKey) {
    throw new ConfigError(
      "Firebase service credentials are not configured. Set FIREBASE_SERVICE_ACCOUNT_JSON " +
        "(the whole service-account JSON) or FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY " +
        "in the Vercel project's Environment Variables, then redeploy.",
    );
  }
  return { clientEmail, privateKey, projectId: projectId() };
}

/** OAuth2 access token for the Realtime Database REST API, cached until expiry. */
export async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.expiresAt - 60 > now) return tokenCache.token;

  const account = serviceAccount();
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: account.clientEmail,
    scope: SCOPES,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  const encode = (part) => Buffer.from(JSON.stringify(part)).toString("base64url");
  const unsigned = `${encode(header)}.${encode(claims)}`;
  let signature;
  try {
    signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(account.privateKey);
  } catch {
    throw new ConfigError(
      "The Firebase private key could not be read. Paste the service-account JSON exactly, " +
        "including the header and footer lines of private_key.",
    );
  }
  const assertion = `${unsigned}.${signature.toString("base64url")}`;

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new ConfigError(`Google rejected the service-account sign-in (${response.status}): ${detail}`);
  }
  const json = await response.json();
  tokenCache = {
    token: json.access_token,
    expiresAt: now + (Number(json.expires_in) || 3600),
  };
  return tokenCache.token;
}

export function databaseUrl() {
  const explicit = process.env.FIREBASE_DATABASE_URL;
  const url = explicit || `https://${projectId()}-default-rtdb.firebaseio.com`;
  return url.replace(/\/+$/, "");
}

function encodePath(path) {
  return String(path)
    .split("/")
    .filter((part) => part.length > 0)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

async function databaseRequest(path, options = {}) {
  const { method = "GET", body, ifMatch, wantEtag = true, extraQuery = "" } = options;
  const token = await accessToken();
  const url =
    `${databaseUrl()}/${encodePath(path)}.json` +
    `?access_token=${encodeURIComponent(token)}${extraQuery}`;
  const headers = {};
  if (wantEtag) headers["X-Firebase-ETag"] = "true";
  if (ifMatch !== undefined && ifMatch !== null) headers["if-match"] = String(ifMatch);
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return {
    ok: response.ok,
    status: response.status,
    data,
    etag: response.headers.get("etag") || null,
    text,
  };
}

/** Read a node. `data` is null when the node does not exist. */
export async function dbGet(path) {
  const result = await databaseRequest(path);
  if (result.status === 401 || result.status === 403) {
    throw new Error(`Firebase rules denied the server read of /${path}.`);
  }
  if (!result.ok) throw new Error(`Firebase read of /${path} failed (${result.status}).`);
  return { data: result.data, etag: result.etag };
}

/**
 * Write a node. Pass `ifMatch: "null_etag"` to create only when the node is
 * empty, or an ETag from dbGet to write only when the data is unchanged.
 * A 412 response is not an error: it carries the current value and ETag.
 */
export async function dbPut(path, value, options = {}) {
  const result = await databaseRequest(path, {
    method: "PUT",
    body: value === undefined ? null : value,
    ifMatch: options.ifMatch,
  });
  return result;
}

export async function dbPatch(path, value) {
  return databaseRequest(path, { method: "PATCH", body: value, wantEtag: false });
}

export async function dbDelete(path, options = {}) {
  return databaseRequest(path, { method: "DELETE", ifMatch: options.ifMatch });
}

/* ---------------------------------------------------------------------------
 * Firebase ID token verification (used by the admin rewards endpoint).
 * Anonymous visitors have ID tokens too, but only UIDs listed under
 * /admins/{uid} === true may call the admin endpoint.
 * ------------------------------------------------------------------------- */

const CERT_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
let certCache = { at: 0, certs: null };

async function certs() {
  if (certCache.certs && Date.now() - certCache.at < 30 * 60 * 1000) return certCache.certs;
  const response = await fetch(CERT_URL);
  if (!response.ok) throw new Error("Could not load Google's token-signing certificates.");
  const certsJson = await response.json();
  certCache = { at: Date.now(), certs: certsJson };
  return certsJson;
}

export async function verifyIdToken(idToken) {
  if (typeof idToken !== "string" || idToken.split(".").length !== 3) {
    throw new Error("A Firebase ID token is required.");
  }
  const [encodedHeader, encodedPayload, encodedSignature] = idToken.split(".");
  const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
  const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  if (header.alg !== "RS256" || !header.kid) throw new Error("Unsupported token algorithm.");

  const keys = await certs();
  const cert = keys[header.kid];
  if (!cert) throw new Error("Unknown token-signing key.");

  const valid = crypto.verify(
    "RSA-SHA256",
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    cert,
    Buffer.from(encodedSignature, "base64url"),
  );
  if (!valid) throw new Error("Token signature is invalid.");

  const now = Math.floor(Date.now() / 1000);
  const expectedIssuer = `https://securetoken.google.com/${projectId()}`;
  if (payload.iss !== expectedIssuer) throw new Error("Token issuer mismatch.");
  if (payload.aud !== projectId()) throw new Error("Token audience mismatch.");
  if (!payload.sub || typeof payload.sub !== "string") throw new Error("Token has no subject.");
  if (!payload.exp || payload.exp <= now) throw new Error("Token has expired.");
  if (payload.iat && payload.iat > now + 300) throw new Error("Token was issued in the future.");
  return { uid: payload.sub, anonymous: Boolean(payload.firebase?.sign_in_provider === "anonymous") };
}

/** True when the UID is listed under /admins in the Realtime Database. */
export async function isAdminUid(uid) {
  const { data } = await dbGet(`admins/${uid}`);
  return data === true;
}
