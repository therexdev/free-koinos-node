"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Signer, utils } = require("koilib");
const { encryptKeystore, decryptKeystore } = require("./keystore");
const { deriveEthAddress, deriveEthPrivateKey } = require("./eth");

const MIN_PASSWORD_LENGTH = 8;

// Holds the encrypted keystore on disk and, after unlock, a koilib Signer in
// memory. Private keys never leave the Electron main process.
class WalletService {
  constructor(walletDir) {
    this.walletDir = walletDir;
    this.keystorePath = path.join(walletDir, "wallet.json");
    this._signer = null;
    this._ethAddress = null;
  }

  // The Ethereum address (for the Fund Node flow) is derived from the Koinos
  // key, so it's cached publicly in the keystore for display while locked and
  // recomputed on unlock. The ETH private key itself is only derived on demand.
  _koinosPrivHex(signer) {
    return String(signer.getPrivateKey("hex")).replace(/^0x/i, "").padStart(64, "0");
  }

  readKeystore() {
    try {
      return JSON.parse(fs.readFileSync(this.keystorePath, "utf8"));
    } catch {
      return null;
    }
  }

  exists() {
    return fs.existsSync(this.keystorePath);
  }

  status() {
    const ks = this.readKeystore();
    return {
      exists: !!ks,
      unlocked: !!this._signer,
      address: this._signer ? this._signer.getAddress() : ks?.address ?? null,
      ethAddress: this._ethAddress ?? ks?.ethAddress ?? null,
      createdAt: ks?.createdAt ?? null,
    };
  }

  get ethAddress() {
    return this._ethAddress ?? this.readKeystore()?.ethAddress ?? null;
  }

  // Derives the Ethereum private key on demand (Phase 2: Vortex bridge signing).
  ethPrivateKey() {
    if (!this._signer) throw new Error("Wallet is locked");
    return deriveEthPrivateKey(this._koinosPrivHex(this._signer));
  }

  get signer() {
    if (!this._signer) throw new Error("Wallet is locked");
    return this._signer;
  }

  get address() {
    return this._signer ? this._signer.getAddress() : this.readKeystore()?.address ?? null;
  }

  _checkPassword(password) {
    if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
  }

  _persist(signer, password) {
    const ethAddress = deriveEthAddress(this._koinosPrivHex(signer));
    const keystore = encryptKeystore({
      privateKeyHex: signer.getPrivateKey("hex"),
      address: signer.getAddress(),
      password,
    });
    keystore.compressed = signer.compressed !== false;
    keystore.ethAddress = ethAddress; // public; for display while locked
    fs.mkdirSync(this.walletDir, { recursive: true });
    const tmp = `${this.keystorePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(keystore, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.keystorePath);
    this._ethAddress = ethAddress;
  }

  _writeKeystore(ks) {
    const tmp = `${this.keystorePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(ks, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.keystorePath);
  }

  create({ password }) {
    this._checkPassword(password);
    if (this.exists()) {
      throw new Error("A wallet already exists. Back it up and remove it before creating a new one.");
    }
    let signer = null;
    while (!signer) {
      try {
        signer = new Signer({ privateKey: crypto.randomBytes(32).toString("hex") });
      } catch {
        // Astronomically rare: key outside curve order. Try again.
      }
    }
    this._persist(signer, password);
    this._signer = signer;
    // WIF is returned once so the user can write down a backup.
    return { address: signer.getAddress(), ethAddress: this._ethAddress, wif: signer.getPrivateKey("wif") };
  }

  importWif({ wif, password }) {
    this._checkPassword(password);
    if (this.exists()) {
      throw new Error("A wallet already exists. Back it up and remove it before importing another one.");
    }
    const cleanWif = String(wif).trim();
    let signer;
    try {
      // fromWif alone doesn't verify the checksum, so validate explicitly.
      if (!utils.isChecksumWif(cleanWif)) throw new Error("bad checksum");
      signer = Signer.fromWif(cleanWif);
    } catch {
      throw new Error("Invalid private key (WIF)");
    }
    this._persist(signer, password);
    this._signer = signer;
    return { address: signer.getAddress(), ethAddress: this._ethAddress };
  }

  _signerFromKeystore(password) {
    const ks = this.readKeystore();
    if (!ks) throw new Error("No wallet found");
    const privateKeyHex = decryptKeystore(ks, password);
    const signer = new Signer({ privateKey: privateKeyHex, compressed: ks.compressed !== false });
    if (ks.address && signer.getAddress() !== ks.address) {
      throw new Error("Keystore address mismatch — file may be corrupted");
    }
    return signer;
  }

  unlock(password) {
    this._signer = this._signerFromKeystore(password);
    this._ethAddress = deriveEthAddress(this._koinosPrivHex(this._signer));
    // Backfill ethAddress into keystores created before the Fund feature so the
    // address also shows while locked.
    const ks = this.readKeystore();
    if (ks && ks.ethAddress !== this._ethAddress) {
      ks.ethAddress = this._ethAddress;
      try {
        this._writeKeystore(ks);
      } catch {
        /* non-fatal: it will be recomputed on next unlock */
      }
    }
    return { address: this._signer.getAddress(), ethAddress: this._ethAddress };
  }

  lock() {
    this._signer = null;
    return { locked: true };
  }

  revealWif(password) {
    // Requires the password again even when unlocked.
    const signer = this._signerFromKeystore(password);
    return { wif: signer.getPrivateKey("wif"), address: signer.getAddress() };
  }

  remove({ password, confirm }) {
    if (confirm !== "REMOVE") {
      throw new Error('Type "REMOVE" to confirm deleting the wallet file');
    }
    // Proves the caller knows the password (and therefore could have backed up).
    this._signerFromKeystore(password);
    fs.rmSync(this.keystorePath, { force: true });
    this._signer = null;
    this._ethAddress = null;
    return { removed: true };
  }
}

module.exports = { WalletService, MIN_PASSWORD_LENGTH };
