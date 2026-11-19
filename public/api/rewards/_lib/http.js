/* Small helpers shared by the rewards API endpoints (no dependencies). */

export function sendText(res, status, body, extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  for (const [key, value] of Object.entries(extraHeaders)) res.setHeader(key, value);
  res.end(body);
}

export function sendJson(res, status, payload, extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  for (const [key, value] of Object.entries(extraHeaders)) res.setHeader(key, value);
  res.end(JSON.stringify(payload));
}

export function allowedOrigins() {
  const configured = process.env.REWARDS_ALLOWED_ORIGINS;
  const list = configured
    ? configured.split(",")
    : ["https://passport-room.com", "https://www.passport-room.com"];
  return list
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean)
    .concat(["http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:8080"]);
}

/** Applies CORS for browser calls. Returns false when the origin is refused. */
export function applyCors(req, res) {
  const origin = String(req.headers.origin || "").replace(/\/+$/, "");
  if (!origin) return true; // server-to-server or same-origin without Origin
  const allowed = allowedOrigins();
  if (!allowed.includes(origin)) return false;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Max-Age", "600");
  return true;
}

export async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body) {
    try {
      return JSON.parse(req.body);
    } catch {
      return Object.fromEntries(new URLSearchParams(req.body));
    }
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  const type = String(req.headers["content-type"] || "");
  if (type.includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

export function bearerToken(req) {
  const header = String(req.headers.authorization || "");
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : "";
}

export function requestUrl(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0];
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "passport-room.com");
  return new URL(req.url || "/", `${proto}://${host}`);
}

export function logEvent(level, message, details) {
  const line = {
    level,
    message,
    at: new Date().toISOString(),
    ...details,
  };
  // Logs must never contain a provider secret or a full ID token.
  console[level === "error" ? "error" : "log"](JSON.stringify(line));
}
