"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseVkoin, formatVkoin, sendVkoin, DEFAULT_MAX_VKOIN } = require("../electron/lib/vkoin-send");

const DUMMY_KEY = "0x" + "11".repeat(32);
const GOOD_ADDR = "0x1111111111111111111111111111111111111111";

test("parseVkoin / formatVkoin use 8 decimals", () => {
  assert.equal(parseVkoin("1"), 100000000n);
  assert.equal(parseVkoin("0.5"), 50000000n);
  assert.equal(formatVkoin(100000000n), "1.0");
});

test("sendVkoin validates recipient, amount and cap before any network use", async () => {
  await assert.rejects(() => sendVkoin({ ethPrivHex: DUMMY_KEY, amountVkoin: "1", toAddress: "0xnope" }), /Invalid Ethereum recipient/);
  await assert.rejects(() => sendVkoin({ ethPrivHex: DUMMY_KEY, amountVkoin: "0", toAddress: GOOD_ADDR }), /greater than 0/);
  const overCap = String(Number(DEFAULT_MAX_VKOIN) + 1);
  await assert.rejects(() => sendVkoin({ ethPrivHex: DUMMY_KEY, amountVkoin: overCap, toAddress: GOOD_ADDR, maxVkoin: DEFAULT_MAX_VKOIN }), /exceeds the safety cap/);
});
