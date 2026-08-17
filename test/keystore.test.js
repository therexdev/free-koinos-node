"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { encryptKeystore, decryptKeystore } = require("../electron/lib/keystore");

const KEY = "a".repeat(63) + "b";
const ADDR = "1L62VUwpA28dkaZ5mHKGdLmrxeYduBFBBu";

test("keystore roundtrip", () => {
  const ks = encryptKeystore({ privateKeyHex: KEY, address: ADDR, password: "correct horse" });
  assert.equal(ks.address, ADDR);
  assert.equal(ks.crypto.cipher, "aes-256-gcm");
  assert.equal(decryptKeystore(ks, "correct horse"), KEY);
});

test("wrong password fails", () => {
  const ks = encryptKeystore({ privateKeyHex: KEY, address: ADDR, password: "correct horse" });
  assert.throws(() => decryptKeystore(ks, "wrong horse"), /Incorrect password/);
});

test("tampered ciphertext fails", () => {
  const ks = encryptKeystore({ privateKeyHex: KEY, address: ADDR, password: "pw12345678" });
  const flipped = (parseInt(ks.crypto.ciphertext.slice(0, 2), 16) ^ 0xff)
    .toString(16)
    .padStart(2, "0");
  ks.crypto.ciphertext = flipped + ks.crypto.ciphertext.slice(2);
  assert.throws(() => decryptKeystore(ks, "pw12345678"), /Incorrect password/);
});

test("rejects invalid private key hex", () => {
  assert.throws(
    () => encryptKeystore({ privateKeyHex: "nothex", address: ADDR, password: "pw12345678" }),
    /32 bytes of hex/
  );
});

test("rejects foreign keystore files", () => {
  assert.throws(() => decryptKeystore({ type: "other" }, "pw"), /Not a valid keystore/);
});
