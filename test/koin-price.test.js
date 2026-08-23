"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { KoinPrice, koinUsdFrom, valueUsd, nodeValueUsd, assertSaneUsd } = require("../electron/lib/koin-price");

const USDT = (n) => BigInt(Math.round(n * 1e6));   // 6 decimals
const KOIN = (n) => String(BigInt(Math.round(n * 1e8))); // 8 decimals
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

// ---------- price from a pool quote ----------

test("price is USDT in over vKOIN out, across the decimal gap", () => {
  // 100 USDT buys 2000 vKOIN -> $0.05 per KOIN. USDT is 6dp, vKOIN 8dp, so
  // getting this wrong by a factor of 100 is the obvious failure mode.
  near(koinUsdFrom({ usdtIn: USDT(100), koinOut: KOIN(2000) }), 0.05);
  near(koinUsdFrom({ usdtIn: USDT(100), koinOut: KOIN(1000) }), 0.1);
  near(koinUsdFrom({ usdtIn: USDT(1), koinOut: KOIN(20) }), 0.05); // probe size is irrelevant
});

test("an empty or illiquid quote is an error, not a price of infinity", () => {
  assert.throws(() => koinUsdFrom({ usdtIn: USDT(100), koinOut: "0" }), /no vKOIN|liquidity/);
  assert.throws(() => koinUsdFrom({ usdtIn: 0, koinOut: KOIN(1) }), /positive/);
});

test("implausible prices are refused rather than displayed", () => {
  // A broken or manipulated read must not tell someone their node is a fortune.
  assert.equal(assertSaneUsd(0.05), 0.05);
  assert.throws(() => assertSaneUsd(50000), /plausible/);
  assert.throws(() => assertSaneUsd(0), /plausible/);
  assert.throws(() => assertSaneUsd(NaN), /plausible/);
  assert.throws(() => assertSaneUsd(Infinity), /plausible/);
});

// ---------- valuing the node ----------

test("valueUsd converts satoshis at the given price", () => {
  near(valueUsd(KOIN(1000), 0.05), 50);
  near(valueUsd("0", 0.05), 0);
  assert.equal(valueUsd("not-a-number", 0.05), null);
  assert.equal(valueUsd(KOIN(1), null), null); // no price -> no answer
});

test("node value is KOIN + VHP, and earnings extend the daily rate", () => {
  const v = nodeValueUsd({
    koinSats: KOIN(500), vhpSats: KOIN(30000),
    avgDailyProfitSats: KOIN(2), usdPerKoin: 0.05,
  });
  near(v.koin, 25);
  near(v.vhp, 1500);
  near(v.total, 1525);
  near(v.daily, 0.1);
  near(v.weekly, 0.7);    // 7 x daily
  near(v.yearly, 36.5);   // 365 x daily
});

test("with no price everything is null, never zero", () => {
  // Zero would read as "this node is worthless" rather than "price unknown".
  const v = nodeValueUsd({ koinSats: KOIN(500), vhpSats: KOIN(30000), avgDailyProfitSats: KOIN(2), usdPerKoin: null });
  assert.deepEqual(v, { usdPerKoin: null, koin: null, vhp: null, total: null, daily: null, weekly: null, yearly: null });
});

// ---------- fetching, caching, failure ----------

function fakePool({ koinOut, fail }) {
  let calls = 0;
  const makeProvider = async () => ({
    // Enough of an ethers provider for the Contract to attach to.
    call: async () => "0x",
    _isProvider: true,
  });
  const p = new KoinPrice({ makeProvider });
  // Replace the one network-touching method; everything else runs for real.
  p._fetch = async () => {
    calls += 1;
    if (fail) throw new Error("RPC down");
    return { usd: koinUsdFrom({ usdtIn: USDT(100), koinOut }), at: Date.now(), source: "test" };
  };
  return { price: p, calls: () => calls };
}

test("the price is cached — the dashboard polls far faster than the pool moves", async () => {
  const { price, calls } = fakePool({ koinOut: KOIN(2000) });
  const a = await price.get();
  const b = await price.get();
  near(a.usd, 0.05);
  near(b.usd, 0.05);
  assert.equal(calls(), 1); // second read served from cache
  await price.get({ force: true });
  assert.equal(calls(), 2);
});

test("concurrent reads share one quote instead of stampeding the RPC", async () => {
  const { price, calls } = fakePool({ koinOut: KOIN(2000) });
  const [a, b, c] = await Promise.all([price.get(), price.get(), price.get()]);
  assert.equal(calls(), 1);
  near(a.usd, 0.05); near(b.usd, 0.05); near(c.usd, 0.05);
});

test("a failed refresh keeps the last good price, flagged stale", async () => {
  const { price } = fakePool({ koinOut: KOIN(2000) });
  await price.get();
  price._fetch = async () => { throw new Error("RPC down"); };
  const r = await price.get({ force: true });
  near(r.usd, 0.05);        // the good price survives
  assert.equal(r.stale, true);
  assert.match(price.lastError, /RPC down/);
});

test("a first-ever failure yields null, not a fabricated price", async () => {
  const { price } = fakePool({ fail: true });
  assert.equal(await price.get(), null);
  assert.equal(price.cached(), null);
  assert.match(price.lastError, /RPC down/);
});
