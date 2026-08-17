"use strict";

// Pure validation for the mana relayer — the rules that keep the sponsor wallet
// safe while it pays mana for strangers (mirrors therexdev/marketplace server.js):
//   1. payer must be the sponsor — we never co-sign someone else's bill;
//   2. payee must be set and not the sponsor (the user whose nonce is spent);
//   3. rc_limit must be within the sponsorship ceiling;
//   4. every operation must call an allowlisted contract+entry_point — the
//      sponsor does not fund arbitrary computation.
// (Signature recovery, co-signing and broadcast happen in the handler.)

// Vortex Koinos bridge + KoinDX addresses/entry-points that may be sponsored,
// all verified on-chain:
//   bridge.complete_transfer   1296908025
//   vETH token approve         1960973952 (to let the KoinDX router pull vETH)
//   KoinDX router swap_tokens_in 2335548678
const ALLOWED_OPS = {
  mainnet: {
    "1aqHtNRDkiAZeFtuM8fRFuurcje6eHqF8": [1296908025], // Vortex bridge: complete_transfer
    "1Tf1QKv3gVYLjq34yURSHw5ErTYbFjqTG": [1960973952], // vETH token: approve
    "17e1q6Fh5RgnuA8K7v4KvXXH4k9qHgsT5s": [2335548678], // KoinDX router: swap_tokens_in
  },
};

function validateSponsoredTx({ transaction, sponsorAddress, allowed, rcMax }) {
  const tx = transaction;
  const h = tx && tx.header;
  if (!h || !Array.isArray(tx.operations) || tx.operations.length === 0) {
    return { ok: false, error: "A prepared transaction with operations is required" };
  }
  if (!sponsorAddress) return { ok: false, error: "Sponsor address unavailable" };
  if (h.payer !== sponsorAddress) return { ok: false, error: "payer must be the sponsor wallet" };
  if (!h.payee || h.payee === sponsorAddress) return { ok: false, error: "payee must be the acting user" };

  let rc;
  try {
    rc = BigInt(h.rc_limit);
  } catch (_) {
    return { ok: false, error: "bad rc_limit" };
  }
  if (rc <= 0n || rc > BigInt(rcMax)) return { ok: false, error: "rc_limit above the sponsorship ceiling" };

  for (const op of tx.operations) {
    const cc = op && op.call_contract;
    if (!cc || !cc.contract_id) return { ok: false, error: "only contract-call operations are sponsored" };
    const entries = allowed[cc.contract_id];
    // entry_point may arrive as number or numeric string; compare loosely.
    const ep = Number(cc.entry_point);
    if (!entries || !entries.map(Number).includes(ep)) {
      return { ok: false, error: "that operation is not something this wallet pays for" };
    }
  }
  return { ok: true };
}

module.exports = { validateSponsoredTx, ALLOWED_OPS };
