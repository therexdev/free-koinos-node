"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { getAmountOut, applySlippage, swapPath } = require("../electron/lib/koindx");

test("getAmountOut uses the 0.25% constant-product formula", () => {
  // (100 * 9975 * 1000) / (1000 * 10000 + 100 * 9975) = 997500000 / 10997500 = 90
  assert.equal(getAmountOut(100n, 1000n, 1000n), 90n);
  // Bigger input => more out, but sublinear (slippage).
  assert.ok(getAmountOut(200n, 1000n, 1000n) < 2n * getAmountOut(100n, 1000n, 1000n));
  // Accepts strings.
  assert.equal(getAmountOut("100", "1000", "1000"), 90n);
});

test("getAmountOut ballpark against the live vETH/KOIN reserves", () => {
  // reserves observed on-chain: vETH ~0.366 (36636279), KOIN ~24628.7 (2462871870076)
  const out = getAmountOut("1000000", "36636279", "2462871870076"); // 0.01 vETH in
  // ~652.8 KOIN out (65,280,000,000 sats); assert within a tight band.
  assert.ok(out > 64_000_000_000n && out < 66_000_000_000n, `got ${out}`);
});

test("getAmountOut rejects bad inputs / empty pools", () => {
  assert.throws(() => getAmountOut(0n, 1000n, 1000n), /greater than 0/);
  assert.throws(() => getAmountOut(100n, 0n, 1000n), /no liquidity/);
  assert.throws(() => getAmountOut(100n, 1000n, 0n), /no liquidity/);
});

test("applySlippage reduces to a floor by basis points", () => {
  assert.equal(applySlippage(1000n, 100), 990n); // 1%
  assert.equal(applySlippage(1000n, 500), 950n); // 5%
  assert.equal(applySlippage(1000n, 0), 1000n);
  assert.throws(() => applySlippage(1000n, 10000), /out of range/);
  assert.throws(() => applySlippage(1000n, -1), /out of range/);
});

test("swapPath routes vETH -> KOIN with the 'koin' string key", () => {
  assert.deepEqual(swapPath("mainnet"), ["1Tf1QKv3gVYLjq34yURSHw5ErTYbFjqTG", "koin"]);
});
