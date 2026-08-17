"use strict";

// Drives the full Fund-node pipeline: deposit ETH -> poll guardians -> redeem
// (mints vETH, sponsor pays mana) -> swap vETH->KOIN (sponsor pays mana). The
// job is persisted after every transition so a mid-bridge restart resumes, and
// the ETH tx hash is saved the instant the deposit is sent so funds are never
// "lost" — the flow can always be re-driven from it.

const { sendDeposit, requestNewSignatures } = require("./eth-bridge");
const { fetchEthDepositRecord, isRedeemable } = require("./bridge");
const { buildRedeemTransaction } = require("./koinos-bridge");
const { quoteSwap, buildSwapTransaction } = require("./koindx");

// Hard cap for the in-app bridge — the vETH/KOIN pool is shallow, so keep
// amounts small until liquidity deepens.
const MAX_BRIDGE_ETH = "0.05";
const DEFAULT_SLIPPAGE_BPS = 150; // 1.5%
const DEFAULT_SPONSOR_ENDPOINT = "https://koinos-node.vercel.app/api/sponsor";
// Give up polling after this long (guardians normally index within ~3 min); the
// ethTxHash is kept so the user can still redeem later.
const POLL_TIMEOUT_MS = 30 * 60 * 1000;

// Pure: given a job status, what should the driver do next?
function nextAction(status) {
  switch (status) {
    case "awaiting_signatures":
      return "poll";
    case "redeeming":
      return "redeem";
    case "swapping":
      return "swap";
    default:
      return "none"; // idle / depositing / done / error
  }
}

const TERMINAL = new Set(["done", "error"]);

class BridgeOrchestrator {
  constructor({ wallet, provider, store, settings, appKey, network, onEvent } = {}) {
    this.wallet = wallet;
    this.provider = provider; // koilib Provider (Koinos)
    this.store = store; // JsonStore
    this.settings = settings;
    this.appKey = appKey;
    this.network = network || "mainnet";
    this.onEvent = onEvent || (() => {});
    this._busy = false;
    this._sponsorAddr = null;
  }

  status() {
    return this.store.get("job", null);
  }

  _save(job) {
    this.store.set("job", { ...job, updatedAt: Date.now() });
    this.onEvent({ type: "bridge", job: this.status() });
  }

  reset() {
    this.store.set("job", null);
    this.onEvent({ type: "bridge", job: null });
    return { ok: true };
  }

  sponsorEndpoint() {
    const override = this.settings.get("sponsorEndpoint", "");
    if (override) return override;
    const onramp = this.settings.get("onrampEndpoint", "");
    if (onramp) return onramp.replace(/\/[^/]*$/, "/sponsor");
    return DEFAULT_SPONSOR_ENDPOINT;
  }

  async _sponsorAddress() {
    if (this._sponsorAddr) return this._sponsorAddr;
    const resp = await fetch(this.sponsorEndpoint(), { method: "GET" });
    if (!resp.ok) throw new Error(`Sponsor endpoint HTTP ${resp.status}`);
    const data = await resp.json();
    if (!data.address) throw new Error("Sponsor endpoint returned no address");
    this._sponsorAddr = data.address;
    return data.address;
  }

  async _coSignAndBroadcast(transaction) {
    const resp = await fetch(this.sponsorEndpoint(), {
      method: "POST",
      headers: { "content-type": "application/json", "x-koinoskit-app": this.appKey },
      body: JSON.stringify({ transaction }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.ok) throw new Error(data.error || `Relayer HTTP ${resp.status}`);
    return data;
  }

  _koinosSigner() {
    const signer = this.wallet.signer; // throws if locked
    signer.provider = this.provider;
    return signer;
  }

  // Begin a new bridge: send the ETH deposit, persist the tx hash immediately.
  async start({ amountEth, slippageBps = DEFAULT_SLIPPAGE_BPS } = {}) {
    const cur = this.status();
    if (cur && !TERMINAL.has(cur.status)) throw new Error("A bridge is already in progress");
    if (!this.wallet.ethAddress) throw new Error("Create or unlock your wallet first");
    this._koinosSigner(); // ensure unlocked before spending ETH

    const koinosRecipient = this.wallet.address;
    this._save({ status: "depositing", amountEth: String(amountEth), slippageBps, koinosRecipient, ethTxHash: null, startedAt: Date.now() });
    try {
      const dep = await sendDeposit({
        ethPrivHex: this.wallet.ethPrivateKey(),
        amountEth,
        koinosRecipient,
        network: this.network,
        maxEth: MAX_BRIDGE_ETH,
      });
      this._save({ status: "awaiting_signatures", amountEth: String(amountEth), slippageBps, koinosRecipient, ethTxHash: dep.hash, startedAt: Date.now() });
    } catch (e) {
      this._save({ status: "error", error: String(e.message || e), failedAt: "depositing", amountEth: String(amountEth), koinosRecipient });
      throw e;
    }
    return this.status();
  }

  // Advance the active job one step. Safe to call repeatedly (driver loop).
  async advance() {
    if (this._busy) return this.status();
    const job = this.status();
    if (!job || nextAction(job.status) === "none") return job;
    this._busy = true;
    try {
      const action = nextAction(job.status);
      if (action === "poll") await this._poll(job);
      else if (action === "redeem") await this._redeem(job);
      else if (action === "swap") await this._swap(job);
    } catch (e) {
      this._save({ ...this.status(), status: "error", error: String(e.message || e), failedAt: job.status });
    } finally {
      this._busy = false;
    }
    return this.status();
  }

  async _poll(job) {
    const record = await fetchEthDepositRecord(job.ethTxHash, { network: this.network });
    if (!record) {
      if (Date.now() - (job.startedAt || 0) > POLL_TIMEOUT_MS) {
        this._save({ ...job, status: "error", error: "Guardians didn't sign in time. Your ETH is deposited — retry to resume.", failedAt: "awaiting_signatures" });
      }
      return; // not indexed yet
    }
    const n = Array.isArray(record.validators) && record.validators.length ? record.validators.length : 3;
    if (isRedeemable(record, n)) {
      this._save({ ...job, status: "redeeming", record });
    } else if (record.expiration && Number(record.expiration) <= Date.now()) {
      await requestNewSignatures({ ethPrivHex: this.wallet.ethPrivateKey(), ethTxHash: job.ethTxHash, network: this.network });
      this._save({ ...job, status: "awaiting_signatures", resignRequestedAt: Date.now(), startedAt: Date.now() });
    }
  }

  async _redeem(job) {
    const sponsorAddress = await this._sponsorAddress();
    const tx = await buildRedeemTransaction({
      userSigner: this._koinosSigner(),
      record: job.record,
      sponsorAddress,
      network: this.network,
      provider: this.provider,
    });
    const res = await this._coSignAndBroadcast(tx);
    this._save({ ...job, status: "swapping", redeemId: res.id });
  }

  async _swap(job) {
    const sponsorAddress = await this._sponsorAddress();
    const amountInSats = job.record.amount; // vETH minted by the redeem
    const quote = await quoteSwap({ amountInSats, slippageBps: job.slippageBps, network: this.network, provider: this.provider });
    const tx = await buildSwapTransaction({
      userSigner: this._koinosSigner(),
      amountInSats,
      amountOutMin: quote.amountOutMin,
      sponsorAddress,
      network: this.network,
      provider: this.provider,
    });
    const res = await this._coSignAndBroadcast(tx);
    this._save({ ...job, status: "done", swapId: res.id, koinReceived: quote.amountOut, finishedAt: Date.now() });
  }
}

module.exports = { BridgeOrchestrator, nextAction, MAX_BRIDGE_ETH, DEFAULT_SLIPPAGE_BPS, DEFAULT_SPONSOR_ENDPOINT };
