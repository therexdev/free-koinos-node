// Coinbase Onramp session-token endpoint for KoinosKit's "Fund node" button.
//
// Since mid-2025 Coinbase requires Onramp URLs to be initialized with a session
// token minted server-side with your CDP *secret* key — so it can't live in the
// desktop app. This ~single-file function does exactly that and nothing else:
// it takes an ETH address, asks Coinbase for a session token, and returns it.
// You (an individual) can get a free CDP key; you earn nothing and pay nothing.
//
// Deploy on Vercel (Node runtime). Environment variables:
//   CDP_API_KEY_ID      — your CDP API key id / name            (required)
//   CDP_API_KEY_SECRET  — your CDP API key secret               (required)
//   ONRAMP_SHARED_SECRET— app key callers must send in the x-koinoskit-app
//                         header. Required: without it the endpoint refuses to
//                         mint tokens (Coinbase's security requirements mandate
//                         authenticating callers before requesting a session
//                         token).
//   ALLOW_ORIGIN        — explicit CORS origin for web callers (optional; the
//                         desktop app needs none, and "*" is never emitted)
//
// Reference: Coinbase's official demo — https://github.com/coinbase/onramp-demo-application
//            Create session token — https://docs.cdp.coinbase.com/api-reference/rest-api/onramp-offramp/create-session-token
//            Security requirements — https://docs.cdp.coinbase.com/onramp/security-requirements

import { generateJwt } from "@coinbase/cdp-sdk/auth";
import { applyCors, checkAuth } from "../lib/guard.cjs";

const HOST = "api.developer.coinbase.com";
const PATH = "/onramp/v1/token";

// Best-effort in-memory rate limit (per warm serverless instance). Not a hard
// guarantee across instances, but it blunts abuse loops cheaply.
const HITS = new Map();
function rateLimited(ip, limit = 20, windowMs = 60000) {
  const now = Date.now();
  const recent = (HITS.get(ip) || []).filter((t) => now - t < windowMs);
  recent.push(now);
  HITS.set(ip, recent);
  return recent.length > limit;
}

export default async function handler(req, res) {
  applyCors(res, process.env.ALLOW_ORIGIN);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  // Verify the caller is our app before anything touches Coinbase.
  const auth = checkAuth(req, process.env.ONRAMP_SHARED_SECRET);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) return res.status(429).json({ error: "Too many requests, try again shortly" });

  const keyId = process.env.CDP_API_KEY_ID;
  const keySecret = process.env.CDP_API_KEY_SECRET;
  if (!keyId || !keySecret) {
    return res.status(500).json({ error: "Server is missing CDP_API_KEY_ID / CDP_API_KEY_SECRET" });
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const address = String(body.address || "");
  const asset = String(body.asset || "ETH");
  const network = String(body.network || "ethereum");
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return res.status(400).json({ error: "A valid 'address' (0x...) is required" });
  }

  try {
    const jwt = await generateJwt({
      apiKeyId: keyId,
      apiKeySecret: keySecret,
      requestMethod: "POST",
      requestHost: HOST,
      requestPath: PATH,
      expiresIn: 120,
    });

    const r = await fetch(`https://${HOST}${PATH}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        addresses: [{ address, blockchains: [network] }],
        assets: [asset],
      }),
    });

    const text = await r.text();
    if (!r.ok) {
      return res.status(502).json({ error: `Coinbase ${r.status}: ${text.slice(0, 300)}` });
    }
    const data = JSON.parse(text);
    const token = data.token || (data.data && data.data.token);
    if (!token) return res.status(502).json({ error: "No session token in Coinbase response" });
    return res.status(200).json({ token });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
