"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { validateSponsoredTx, ALLOWED_OPS } = require("../onramp-endpoint/lib/validate-sponsored-tx.cjs");

const SPONSOR = "14CEp9sYsExa3TVkdwgShPDJzfZFXZVsKj";
const USER = "1CZ4AV3jbGB7fi9bqarouyquFQ94DpLsqi";
const BRIDGE = "1aqHtNRDkiAZeFtuM8fRFuurcje6eHqF8";
const allowed = ALLOWED_OPS.mainnet;
const rcMax = "500000000";

function tx({ header, operations } = {}) {
  return {
    header: { payer: SPONSOR, payee: USER, rc_limit: "300000000", ...(header || {}) },
    operations: operations || [{ call_contract: { contract_id: BRIDGE, entry_point: 1296908025 } }],
  };
}
const check = (t) => validateSponsoredTx({ transaction: t, sponsorAddress: SPONSOR, allowed, rcMax });

test("accepts a valid sponsored redeem transaction", () => {
  assert.deepEqual(check(tx()), { ok: true });
});

test("rejects a payer that isn't the sponsor", () => {
  assert.match(check(tx({ header: { payer: "1SomeoneElse999999999999999999999" } })).error, /payer must be the sponsor/);
});

test("rejects a missing or self payee", () => {
  assert.match(check(tx({ header: { payee: "" } })).error, /payee must be/);
  assert.match(check(tx({ header: { payee: SPONSOR } })).error, /payee must be/);
});

test("rejects rc_limit above the ceiling", () => {
  assert.match(check(tx({ header: { rc_limit: "999999999999" } })).error, /ceiling/);
  assert.match(check(tx({ header: { rc_limit: "0" } })).error, /ceiling/);
});

test("rejects a disallowed contract", () => {
  assert.match(
    check(tx({ operations: [{ call_contract: { contract_id: "1EvilContract9999999999999999999", entry_point: 1296908025 } }] })).error,
    /not something this wallet pays for/
  );
});

test("rejects the bridge with the wrong entry_point", () => {
  assert.match(
    check(tx({ operations: [{ call_contract: { contract_id: BRIDGE, entry_point: 999 } }] })).error,
    /not something this wallet pays for/
  );
});

test("rejects non-contract-call and empty operations", () => {
  assert.match(check(tx({ operations: [{ upload_contract: {} }] })).error, /only contract-call/);
  assert.match(check(tx({ operations: [] })).error, /operations is required/);
});

test("accepts entry_point as a numeric string too", () => {
  assert.deepEqual(check(tx({ operations: [{ call_contract: { contract_id: BRIDGE, entry_point: "1296908025" } }] })), { ok: true });
});

test("accepts a two-op swap (vETH approve + KoinDX swap_tokens_in)", () => {
  const VETH = "1Tf1QKv3gVYLjq34yURSHw5ErTYbFjqTG";
  const ROUTER = "17e1q6Fh5RgnuA8K7v4KvXXH4k9qHgsT5s";
  const swapTx = tx({
    operations: [
      { call_contract: { contract_id: VETH, entry_point: 1960973952 } }, // approve
      { call_contract: { contract_id: ROUTER, entry_point: 2335548678 } }, // swap_tokens_in
    ],
  });
  assert.deepEqual(check(swapTx), { ok: true });
});

test("still rejects a swap on the wrong router entry_point", () => {
  const ROUTER = "17e1q6Fh5RgnuA8K7v4KvXXH4k9qHgsT5s";
  assert.match(
    check(tx({ operations: [{ call_contract: { contract_id: ROUTER, entry_point: 678105445 } }] })).error, // create_pair
    /not something this wallet pays for/
  );
});
