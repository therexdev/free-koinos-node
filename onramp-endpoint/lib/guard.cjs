"use strict";

// Request guard shared by the onramp endpoints (api/session.js, api/sponsor.js):
// caller authentication and CORS, per Coinbase's Onramp security requirements
// (https://docs.cdp.coinbase.com/onramp/security-requirements):
//   1. the backend must authenticate callers before requesting a session token
//      from Coinbase — so the app key is required, and a deployment without one
//      fails closed instead of serving everyone;
//   2. Access-Control-Allow-Origin must never be the "*" wildcard.

const crypto = require("node:crypto");

// Constant-time string comparison (hash first so unequal lengths are safe).
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// The CORS origin to emit, or null for none. The desktop app calls these
// endpoints from Electron's main process, where CORS does not apply — so by
// default no CORS headers are sent at all and browsers get nothing. ALLOW_ORIGIN
// exists for self-hosters who call from a web page; it must name an explicit
// origin — a wildcard is treated as unset rather than emitted.
function corsOrigin(allowOrigin) {
  const origin = String(allowOrigin || "").trim();
  if (!origin || origin === "*") return null;
  return origin;
}

function applyCors(res, allowOrigin, { methods = "POST, OPTIONS" } = {}) {
  const origin = corsOrigin(allowOrigin);
  if (!origin) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", methods);
  res.setHeader("Access-Control-Allow-Headers", "content-type, x-koinoskit-app");
}

// Authenticate the caller via the x-koinoskit-app header. Returns { ok: true }
// or { ok: false, status, error } for the handler to relay.
function checkAuth(req, sharedSecret) {
  const secret = String(sharedSecret || "").trim();
  if (!secret) {
    return { ok: false, status: 500, error: "Server is missing ONRAMP_SHARED_SECRET" };
  }
  const got = req.headers && req.headers["x-koinoskit-app"];
  if (typeof got !== "string" || !safeEqual(got, secret)) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }
  return { ok: true };
}

module.exports = { corsOrigin, applyCors, checkAuth };
