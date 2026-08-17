"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseUsdt, formatUsdt, sendUsdt, quoteUsdtSend, DEFAULT_MAX_USDT } = require("../electron/lib/usdt-send");

const DUMMY_KEY = "0x" + "11".repeat(32);
const GOOD_ADDR = "0x1111111111111111111111111111111111111111";

test("parseUsdt / formatUsdt use 6 decimals", () => {
  assert.equal(parseUsdt("1"), 1000000n);
  assert.equal(parseUsdt("0.5"), 500000n);
  assert.equal(parseUsdt("123.456789"), 123456789n);
  assert.equal(formatUsdt(1000000n), "1.0");
  assert.equal(formatUsdt(500000n), "0.5");
});

test("quoteUsdtSend rejects an invalid recipient before any network use", async () => {
  await assert.rejects(() => quoteUsdtSend({ fromAddress: GOOD_ADDR, amountUsdt: "1", toAddress: "not-an-address" }), /Invalid Ethereum recipient/);
});

test("sendUsdt validates recipient, amount, and cap before touching the network", async () => {
  await assert.rejects(() => sendUsdt({ ethPrivHex: DUMMY_KEY, amountUsdt: "1", toAddress: "0xnope" }), /Invalid Ethereum recipient/);
  await assert.rejects(() => sendUsdt({ ethPrivHex: DUMMY_KEY, amountUsdt: "0", toAddress: GOOD_ADDR }), /greater than 0/);
  const overCap = String(Number(DEFAULT_MAX_USDT) + 1);
  await assert.rejects(() => sendUsdt({ ethPrivHex: DUMMY_KEY, amountUsdt: overCap, toAddress: GOOD_ADDR, maxUsdt: DEFAULT_MAX_USDT }), /exceeds the safety cap/);
});

test("sendUsdt rejects a malformed private key", async () => {
  await assert.rejects(() => sendUsdt({ ethPrivHex: "0xdeadbeef", amountUsdt: "1", toAddress: GOOD_ADDR }), /Invalid Ethereum private key/);
});
