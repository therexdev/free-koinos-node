"use strict";

// Vortex bridge client helpers — the SAFE, read-only + pure parts of Phase 2.
// Transaction signing/broadcasting (the Ethereum deposit and the Koinos redeem)
// lives in later modules so the money-moving code stays small and reviewable.

const { BRIDGE, ETH_DECIMALS, VETH_DECIMALS } = require("./bridge-constants");

// Vortex computes its guardian quorum as floor((n*5 + 10) / 9): 2-of-3 with the
// 3 validators live today, 5-of-7 at the originally-announced set. Read the live
// validator count on-chain and derive this rather than hard-coding a threshold.
function computeQuorum(nValidators) {
  const n = Number(nValidators);
  if (!Number.isInteger(n) || n <= 0) throw new Error("Invalid validator count");
  return Math.floor((n * 5 + 10) / 9);
}

// The bridge normalizes ETH (18 decimals) to vETH (8 decimals) by dividing by
// 10^10; anything below 10^10 wei is dust and is refunded, so the smallest
// bridgeable amount is 10^10 wei. Returns the vETH amount in 8-dec satoshis plus
// the refunded dust, as strings (BigInt-safe).
const WEI_PER_VSAT = 10n ** BigInt(ETH_DECIMALS - VETH_DECIMALS); // 10^10

function weiToVethSats(wei) {
  const v = typeof wei === "bigint" ? wei : BigInt(String(wei == null ? 0 : wei).trim() || "0");
  if (v < 0n) throw new Error("wei cannot be negative");
  const sats = v / WEI_PER_VSAT;
  const dust = v % WEI_PER_VSAT;
  return { sats: sats.toString(), dust: dust.toString(), bridgeable: sats > 0n };
}

// A proxy record is ready to redeem when it carries at least `quorum` guardian
// signatures and hasn't passed its 60-minute expiration.
function isRedeemable(record, nValidators, nowMs = Date.now()) {
  if (!record || !Array.isArray(record.signatures)) return false;
  const enough = record.signatures.length >= computeQuorum(nValidators);
  const exp = record.expiration != null ? Number(record.expiration) : 0;
  const notExpired = !exp || exp > nowMs;
  return enough && notExpired;
}

// Poll the Vortex aggregator for an ETH→Koinos deposit's guardian signatures.
// Read-only. Returns the proxy record (fields incl. signatures[], expiration,
// koinosToken, recipient, amount…) or null while the deposit isn't indexed yet
// (HTTP 404, up to ~3 min after the deposit). Throws on other network errors.
async function fetchEthDepositRecord(ethTxHash, { network = "mainnet", fetchImpl, timeoutMs = 12000 } = {}) {
  const cfg = BRIDGE[network];
  if (!cfg) throw new Error(`Unknown network: ${network}`);
  const doFetch = fetchImpl || fetch;
  const url = `${cfg.proxyUrl}/GetEthereumTransaction?TransactionId=${encodeURIComponent(ethTxHash)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp;
  try {
    resp = await doFetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (resp.status === 404) return null; // not indexed yet
  if (!resp.ok) throw new Error(`Vortex proxy HTTP ${resp.status}`);
  return resp.json();
}

module.exports = {
  computeQuorum,
  weiToVethSats,
  isRedeemable,
  fetchEthDepositRecord,
  WEI_PER_VSAT,
};
