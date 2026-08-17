"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { computeQuorum, weiToVethSats, isRedeemable, fetchEthDepositRecord } = require("../electron/lib/bridge");
const { BRIDGE, VETH_DECIMALS } = require("../electron/lib/bridge-constants");

test("computeQuorum uses floor((n*5+10)/9)", () => {
  assert.equal(computeQuorum(3), 2); // live mainnet set
  assert.equal(computeQuorum(7), 5); // originally announced
  assert.equal(computeQuorum(1), 1);
  assert.equal(computeQuorum(5), 3);
  assert.throws(() => computeQuorum(0), /Invalid validator count/);
});

test("weiToVethSats normalizes ETH(18) -> vETH(8) and refunds dust", () => {
  // 1 ETH = 1e18 wei -> 1e8 sats = 1.0 vETH (8 decimals)
  assert.deepEqual(weiToVethSats("1000000000000000000"), { sats: "100000000", dust: "0", bridgeable: true });
  // 0.01 ETH
  assert.deepEqual(weiToVethSats("10000000000000000"), { sats: "1000000", dust: "0", bridgeable: true });
  // smallest bridgeable = 1e10 wei -> 1 sat
  assert.deepEqual(weiToVethSats("10000000000"), { sats: "1", dust: "0", bridgeable: true });
  // below the floor: all dust, nothing bridgeable
  assert.deepEqual(weiToVethSats("9999999999"), { sats: "0", dust: "9999999999", bridgeable: false });
  // 1.5e10 wei -> 1 sat + 5e9 dust
  assert.deepEqual(weiToVethSats("15000000000"), { sats: "1", dust: "5000000000", bridgeable: true });
  assert.throws(() => weiToVethSats("-1"), /negative/);
});

test("isRedeemable needs quorum signatures and a live expiration", () => {
  const future = 10_000;
  const rec = (nSigs, exp) => ({ signatures: Array(nSigs).fill("0xsig"), expiration: exp });
  // n=3 -> quorum 2
  assert.equal(isRedeemable(rec(2, future), 3, 0), true);
  assert.equal(isRedeemable(rec(1, future), 3, 0), false); // below quorum
  assert.equal(isRedeemable(rec(3, 5), 3, 10), false); // expired (exp 5 < now 10)
  assert.equal(isRedeemable(null, 3), false);
  assert.equal(isRedeemable({}, 3), false);
});

test("fetchEthDepositRecord returns null on 404, parses JSON on 200", async () => {
  const rec = { id: "0xabc", signatures: ["a", "b"], koinosToken: BRIDGE.mainnet.veth };
  const ok = { status: 200, ok: true, json: async () => rec };
  const notFound = { status: 404, ok: false, json: async () => ({}) };

  assert.equal(await fetchEthDepositRecord("0xdead", { fetchImpl: async () => notFound }), null);
  assert.deepEqual(await fetchEthDepositRecord("0xabc", { fetchImpl: async () => ok }), rec);
  await assert.rejects(
    () => fetchEthDepositRecord("0xabc", { fetchImpl: async () => ({ status: 500, ok: false }) }),
    /HTTP 500/
  );
});

test("mainnet config carries the on-chain-verified addresses", () => {
  const m = BRIDGE.mainnet;
  assert.match(m.ethBridge, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(m.koinosBridge, "1aqHtNRDkiAZeFtuM8fRFuurcje6eHqF8");
  assert.equal(m.veth, "1Tf1QKv3gVYLjq34yURSHw5ErTYbFjqTG");
  assert.equal(m.toChain, 1);
  assert.equal(VETH_DECIMALS, 8);
});
