"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Signer } = require("koilib");
const { sendDeposit, quoteDeposit, requestNewSignatures, validKoinosAddress } = require("../electron/lib/eth-bridge");

// A real koilib-generated Koinos address (deterministic from a seed).
const VALID_KOINOS = Signer.fromSeed("koinoskit eth-bridge test").getAddress();
const VALID_PRIV = "1".repeat(64);

test("validKoinosAddress accepts real addresses, rejects garbage", () => {
  assert.ok(validKoinosAddress(VALID_KOINOS));
  assert.ok(!validKoinosAddress("garbage"));
  assert.ok(!validKoinosAddress(""));
  assert.ok(!validKoinosAddress("0x1234567890123456789012345678901234567890"));
});

test("sendDeposit validates everything before touching the network", async () => {
  await assert.rejects(
    () => sendDeposit({ ethPrivHex: VALID_PRIV, amountEth: "0.01", koinosRecipient: "nope" }),
    /Invalid Koinos recipient/
  );
  await assert.rejects(
    () => sendDeposit({ ethPrivHex: VALID_PRIV, amountEth: "0", koinosRecipient: VALID_KOINOS }),
    /greater than 0/
  );
  await assert.rejects(
    () => sendDeposit({ ethPrivHex: VALID_PRIV, amountEth: "1", koinosRecipient: VALID_KOINOS, maxEth: "0.25" }),
    /safety cap/
  );
  await assert.rejects(
    () => sendDeposit({ ethPrivHex: "xyz", amountEth: "0.01", koinosRecipient: VALID_KOINOS }),
    /Invalid Ethereum private key/
  );
});

test("quoteDeposit validates recipient/amount/minimum before network", async () => {
  await assert.rejects(
    () => quoteDeposit({ fromAddress: "0x0", amountEth: "0.01", koinosRecipient: "nope" }),
    /Invalid Koinos recipient/
  );
  await assert.rejects(
    () => quoteDeposit({ fromAddress: "0x0", amountEth: "0", koinosRecipient: VALID_KOINOS }),
    /greater than 0/
  );
  await assert.rejects(
    () => quoteDeposit({ fromAddress: "0x0", amountEth: "0.0000000001", koinosRecipient: VALID_KOINOS }),
    /below the bridge minimum/
  );
});

test("requestNewSignatures rejects a malformed tx hash before network", async () => {
  await assert.rejects(
    () => requestNewSignatures({ ethPrivHex: VALID_PRIV, ethTxHash: "0xnope" }),
    /Invalid Ethereum tx hash/
  );
});
