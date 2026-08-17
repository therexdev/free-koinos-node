"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { quoteSend, maxSendable, sendEth, requireValidTo, DEFAULT_MAX_ETH } = require("../electron/lib/eth-send");

// A real EIP-55 checksummed address (USDT) and a valid 32-byte private key.
const VALID_TO = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const VALID_PRIV = "1".repeat(64);

// A fake ethers-style provider so the read-only math can be tested without a
// network. 1 gwei = 1e9 wei; ETH = 1e18 wei.
function fakeProvider({ balanceWei, gas = 21000n, perGasWei = 20n * 10n ** 9n } = {}) {
  return {
    getBalance: async () => BigInt(balanceWei),
    estimateGas: async () => gas,
    getFeeData: async () => ({ maxFeePerGas: perGasWei, gasPrice: perGasWei }),
  };
}

test("requireValidTo checksums good addresses and rejects bad ones", () => {
  assert.equal(requireValidTo(VALID_TO), VALID_TO);
  // all-lowercase is accepted and normalized to checksum form
  assert.equal(requireValidTo(VALID_TO.toLowerCase()), VALID_TO);
  assert.throws(() => requireValidTo("nope"), /Invalid Ethereum recipient/);
  assert.throws(() => requireValidTo(""), /Invalid Ethereum recipient/);
  assert.throws(() => requireValidTo("0x1234"), /Invalid Ethereum recipient/);
  // a mixed-case address with a single wrong char fails the checksum
  assert.throws(() => requireValidTo("0xdAC17F958D2ee523a2206206994597C13D831ecA"), /Invalid Ethereum recipient/);
});

test("sendEth validates everything before touching the network", async () => {
  await assert.rejects(
    () => sendEth({ ethPrivHex: VALID_PRIV, amountEth: "0.01", toAddress: "nope" }),
    /Invalid Ethereum recipient/
  );
  await assert.rejects(
    () => sendEth({ ethPrivHex: "xyz", amountEth: "0.01", toAddress: VALID_TO }),
    /Invalid Ethereum private key/
  );
  await assert.rejects(
    () => sendEth({ ethPrivHex: VALID_PRIV, amountEth: "0", toAddress: VALID_TO }),
    /greater than 0/
  );
  await assert.rejects(
    () => sendEth({ ethPrivHex: VALID_PRIV, amountEth: "100", toAddress: VALID_TO, maxEth: DEFAULT_MAX_ETH }),
    /safety cap/
  );
});

test("quoteSend computes gas, total and sufficiency", async () => {
  const provider = fakeProvider({ balanceWei: 10n ** 18n }); // 1 ETH
  const q = await quoteSend({ fromAddress: VALID_TO, amountEth: "0.5", toAddress: VALID_TO, provider });
  assert.equal(q.to, VALID_TO);
  assert.equal(q.amountEth, "0.5");
  // gas = 21000 * 20 gwei = 420000 gwei = 0.00042 ETH
  assert.equal(q.gasCostEth, "0.00042");
  assert.equal(q.totalEth, "0.50042");
  assert.equal(q.sufficient, true);
});

test("quoteSend flags an amount that exceeds balance+gas", async () => {
  const provider = fakeProvider({ balanceWei: 10n ** 17n }); // 0.1 ETH
  const q = await quoteSend({ fromAddress: VALID_TO, amountEth: "0.1", toAddress: VALID_TO, provider });
  // 0.1 ETH + gas > 0.1 ETH balance
  assert.equal(q.sufficient, false);
});

test("quoteSend rejects a non-positive amount before network", async () => {
  await assert.rejects(
    () => quoteSend({ fromAddress: VALID_TO, amountEth: "0", toAddress: VALID_TO }),
    /greater than 0/
  );
});

test("maxSendable subtracts a +30% gas reserve from the balance", async () => {
  const provider = fakeProvider({ balanceWei: 10n ** 18n }); // 1 ETH
  const m = await maxSendable({ fromAddress: VALID_TO, toAddress: VALID_TO, provider });
  // reserve = 21000 * 20 gwei * 1.3 = 546000 gwei = 0.000546 ETH
  assert.equal(m.gasReserveEth, "0.000546");
  assert.equal(m.maxEth, "0.999454");
  assert.equal(m.capped, false);
});

test("maxSendable caps at the safety limit and never goes negative", async () => {
  const capped = await maxSendable({
    fromAddress: VALID_TO, toAddress: VALID_TO, capEth: "0.05",
    provider: fakeProvider({ balanceWei: 10n ** 18n }),
  });
  assert.equal(capped.maxEth, "0.05");
  assert.equal(capped.capped, true);

  const broke = await maxSendable({
    fromAddress: VALID_TO, toAddress: VALID_TO,
    provider: fakeProvider({ balanceWei: 1000n }), // dust, less than the gas reserve
  });
  assert.equal(broke.maxWei, "0");
});
