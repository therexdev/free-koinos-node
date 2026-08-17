// Mana relayer for KoinosKit's "Fund node" flow. A zero-KOIN user can't pay the
// mana to redeem bridged vETH or swap it to KOIN, so this endpoint co-signs their
// transaction as the PAYER using a sponsor wallet, after validating that it only
// does the operations we're willing to pay for. Mirrors the sponsorship safety
// model in therexdev/marketplace (server.js).
//
// Environment variables (set in the same Vercel project as api/session.js):
//   KOINOS_SPONSOR_WIF   the sponsor wallet's WIF (pays mana)          (required)
//   ONRAMP_SHARED_SECRET app key checked in the x-koinoskit-app header (required,
//                        shared with api/session.js)
//   SPONSOR_RC_MAX       per-tx mana ceiling in satoshis (default 5 KOIN)
//   KOINOS_NETWORK       mainnet (default)
//   KOINOS_RPC           comma-separated RPC override (default api.koinos.io)

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { Signer, Provider } = require("koilib");
const { validateSponsoredTx, ALLOWED_OPS } = require("../lib/validate-sponsored-tx.cjs");
const { applyCors, checkAuth } = require("../lib/guard.cjs");

const RPCS = (process.env.KOINOS_RPC || "https://api.koinos.io")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const NETWORK = process.env.KOINOS_NETWORK || "mainnet";
const SPONSOR_RC_MAX = process.env.SPONSOR_RC_MAX || "500000000"; // 5 KOIN

// Best-effort in-memory rate limit (per warm serverless instance).
const HITS = new Map();
function rateLimited(key, limit, windowMs) {
  const now = Date.now();
  const arr = (HITS.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  HITS.set(key, arr);
  return arr.length > limit;
}

let _sponsor = null;
function sponsorSigner() {
  if (_sponsor) return _sponsor;
  const wif = (process.env.KOINOS_SPONSOR_WIF || "").trim();
  if (!wif) return null;
  const s = Signer.fromWif(wif);
  s.provider = new Provider(RPCS);
  _sponsor = s;
  return s;
}

export default async function handler(req, res) {
  applyCors(res, process.env.ALLOW_ORIGIN, { methods: "GET, POST, OPTIONS" });
  if (req.method === "OPTIONS") return res.status(204).end();

  const sponsor = sponsorSigner();
  if (!sponsor) return res.status(500).json({ error: "Server is missing KOINOS_SPONSOR_WIF" });
  const sponsorAddress = sponsor.getAddress();

  // The app fetches the sponsor address to set as the transaction payer.
  if (req.method === "GET") {
    return res.status(200).json({ address: sponsorAddress, network: NETWORK });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  // App-identity check (same shared secret as the Coinbase endpoint). Required:
  // a deployment without the secret fails closed rather than co-signing for all.
  const auth = checkAuth(req, process.env.ONRAMP_SHARED_SECRET);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const tx = body.transaction;
  if (!tx || !tx.header) return res.status(400).json({ error: "A prepared transaction is required" });

  // Only sponsor allowlisted operations, with a capped rc_limit, paid by us.
  const allowed = ALLOWED_OPS[NETWORK] || {};
  const v = validateSponsoredTx({ transaction: tx, sponsorAddress, allowed, rcMax: SPONSOR_RC_MAX });
  if (!v.ok) return res.status(400).json({ error: v.error });

  const payee = tx.header.payee;
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  // A full onboard is redeem + swap (2 txs); allow a few retries, then throttle.
  if (rateLimited("payee:" + payee, 6, 3600000) || rateLimited("ip:" + ip, 30, 3600000)) {
    return res.status(429).json({ error: "Too many sponsored transactions — slow down" });
  }

  // The user (payee) must already have signed what we are about to pay for; the
  // chain enforces this too, but failing fast keeps garbage off-chain.
  let signers = [];
  try {
    signers = await Signer.recoverAddresses(tx);
  } catch (_) {
    /* fall through to the check below */
  }
  if (!signers.includes(payee)) {
    return res.status(400).json({ error: "the payee has not signed this transaction" });
  }

  try {
    await sponsor.signTransaction(tx); // payer signature — authorizes the mana spend
    const receipt = await sponsor.provider.sendTransaction(tx);
    return res.status(200).json({ ok: true, id: tx.id, receipt: receipt && receipt.receipt });
  } catch (e) {
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
}
