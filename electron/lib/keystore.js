"use strict";

const crypto = require("crypto");

// Encrypted wallet file: scrypt key derivation + AES-256-GCM. The GCM auth
// tag doubles as an integrity check, so a wrong password or a tampered file
// both fail decryption.

// Kept identical to Koinos Node Desktop so an existing wallet.json can be
// copied straight into this app (same encryption, same type tag).
const KEYSTORE_TYPE = "koinos-node-desktop-keystore";
const VERSION = 1;
const SCRYPT = { n: 16384, r: 8, p: 1, dklen: 32 };

function deriveKey(password, salt, params) {
  const { n, r, p, dklen } = params;
  return crypto.scryptSync(Buffer.from(String(password), "utf8"), salt, dklen, {
    N: n,
    r,
    p,
    maxmem: 256 * n * r,
  });
}

function encryptKeystore({ privateKeyHex, address, password }) {
  if (!/^[0-9a-fA-F]{64}$/.test(privateKeyHex)) {
    throw new Error("privateKeyHex must be 32 bytes of hex");
  }
  const salt = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(password, salt, SCRYPT);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(privateKeyHex, "hex")),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    type: KEYSTORE_TYPE,
    version: VERSION,
    address,
    createdAt: new Date().toISOString(),
    crypto: {
      kdf: "scrypt",
      kdfparams: { ...SCRYPT, salt: salt.toString("hex") },
      cipher: "aes-256-gcm",
      cipherparams: { iv: iv.toString("hex") },
      ciphertext: ciphertext.toString("hex"),
      mac: tag.toString("hex"),
    },
  };
}

function decryptKeystore(keystore, password) {
  if (!keystore || keystore.type !== KEYSTORE_TYPE) {
    throw new Error("Not a valid keystore file");
  }
  const c = keystore.crypto;
  if (c.kdf !== "scrypt" || c.cipher !== "aes-256-gcm") {
    throw new Error(`Unsupported keystore format (${c.kdf}/${c.cipher})`);
  }
  const key = deriveKey(password, Buffer.from(c.kdfparams.salt, "hex"), c.kdfparams);
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(c.cipherparams.iv, "hex")
  );
  decipher.setAuthTag(Buffer.from(c.mac, "hex"));
  try {
    const plain = Buffer.concat([
      decipher.update(Buffer.from(c.ciphertext, "hex")),
      decipher.final(),
    ]);
    return plain.toString("hex");
  } catch {
    throw new Error("Incorrect password");
  }
}

module.exports = { encryptKeystore, decryptKeystore, KEYSTORE_TYPE };
