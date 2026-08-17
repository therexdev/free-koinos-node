"use strict";

// Drives Route C end to end: ETH → USDT → vKOIN on Ethereum, bridge the vKOIN,
// then poll guardians and redeem to native KOIN. Each Ethereum step sends exactly
// one transaction and waits for its receipt before advancing, and the job is
// persisted after every transition — so a crash/restart resumes from on-chain
// reality, and amounts are always read from actual balances (never assumed).
//
// State flow:
//   swap_eth_usdt → approve_permit2 → approve_ur → swap_usdt_vkoin
//     → approve_bridge → bridge_token → awaiting_signatures → redeeming → done
//
// Fail-safe by design: every swap carries an on-chain min-out guard and every
// approval is checked before sending, so a bad step reverts and leaves funds in a
// plain ERC-20 (USDT or vKOIN) the flow can retry from. The redeem is the same
// token-generic path Route B uses; the record's koinosToken is KOIN.

const { ethers } = require("ethers");
const { makeProvider, requestNewSignatures } = require("./eth-bridge");
const { fetchEthDepositRecord, isRedeemable } = require("./bridge");
const { buildRedeemTransaction } = require("./koinos-bridge");
const { fetchSponsorAddress, coSignAndBroadcast } = require("./sponsor-relay");
const { quoteEthToVkoin, quoteUsdtOut, quoteVkoinOut, applySlippage } = require("./eth-swap");
const swap = require("./eth-swap-exec");
const { buildTransferTokensTx, bridgePaused } = require("./eth-bridge-token");
const { parseUsdt, formatUsdt } = require("./usdt-send");
const { parseVkoin, formatVkoin } = require("./vkoin-send");
const { BRIDGE } = require("./bridge-constants");
const RC = require("./route-constants");

// Safety caps — keep Route C amounts small while it's new. Matches Route B.
const MAX_ROUTE_C_ETH = "0.05";
const MAX_ROUTE_C_USDT = "150"; // ~ the USD value of the ETH cap, with headroom
const MAX_ROUTE_C_VKOIN = "50000"; // recovery path; generous but bounded
const DEFAULT_SLIPPAGE_BPS = 150; // 1.5%
const PERMIT2_EXPIRY_SEC = 3600;
const SWAP_DEADLINE_SEC = 1800;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;

const ETH_STATES = ["swap_eth_usdt", "approve_permit2", "approve_ur", "swap_usdt_vkoin", "approve_bridge", "bridge_token"];
const TERMINAL = new Set(["done", "error"]);

// Pure: what should the driver do for a given status?
function nextAction(status) {
  if (ETH_STATES.includes(status)) return "eth";
  if (status === "awaiting_signatures") return "poll";
  if (status === "redeeming") return "redeem";
  return "none"; // idle / done / error
}

class RouteCOrchestrator {
  constructor({ wallet, provider, store, settings, appKey, network, onEvent } = {}) {
    this.wallet = wallet;
    this.provider = provider; // koilib Provider (Koinos)
    this.store = store; // JsonStore (shares the Fund store, distinct key)
    this.settings = settings;
    this.appKey = appKey;
    this.network = network || "mainnet";
    this.onEvent = onEvent || (() => {});
    this._busy = false;
    this._ethProvider = null;
    this._ethWallet = null;
  }

  status() {
    return this.store.get("routeCJob", null);
  }

  _save(job) {
    this.store.set("routeCJob", { ...job, updatedAt: Date.now() });
    this.onEvent({ type: "routeC", job: this.status() });
  }

  reset() {
    this.store.set("routeCJob", null);
    this.onEvent({ type: "routeC", job: null });
    return { ok: true };
  }

  async _eth() {
    if (!this._ethWallet) {
      this._ethProvider = await makeProvider();
      this._ethWallet = new ethers.Wallet(this.wallet.ethPrivateKey(), this._ethProvider);
    }
    return this._ethWallet;
  }

  _koinosSigner() {
    const signer = this.wallet.signer; // throws if locked
    signer.provider = this.provider;
    return signer;
  }

  _bridgeAddr() {
    return BRIDGE[this.network].ethBridge;
  }

  // Begin a new Route C funding. `source` is "eth" (swap ETH→USDT→vKOIN…) or
  // "usdt" (the user already holds USDT — skip the ETH leg and start at the vKOIN
  // swap). Validates + quotes before anything moves, snapshots starting balances
  // (so post-swap deltas are exact), and persists.
  async start({ amountEth, amountUsdt, amountVkoin, source = "eth", slippageBps = DEFAULT_SLIPPAGE_BPS } = {}) {
    const cur = this.status();
    if (cur && !TERMINAL.has(cur.status)) throw new Error("A Route C funding is already in progress");
    if (!this.wallet.ethAddress) throw new Error("Create or unlock your wallet first");
    this._koinosSigner(); // ensure the Koinos key is unlocked before spending funds

    const wallet = await this._eth();
    if (await bridgePaused(this._ethProvider, this.network)) throw new Error("The Vortex bridge is currently paused");
    const common = {
      slippageBps,
      source,
      koinosRecipient: this.wallet.address,
      ethFrom: wallet.address,
      pendingTx: null,
      startedAt: Date.now(),
    };

    if (source === "usdt") {
      const usdtSats = parseUsdt(amountUsdt);
      if (usdtSats <= 0n) throw new Error("Amount must be greater than 0");
      if (usdtSats > parseUsdt(MAX_ROUTE_C_USDT)) {
        throw new Error(`Amount ${formatUsdt(usdtSats)} USDT exceeds the safety cap of ${MAX_ROUTE_C_USDT} USDT`);
      }
      const usdtBal = await swap.balanceOf(this._ethProvider, RC.USDT, wallet.address);
      if (usdtBal < usdtSats) throw new Error("Insufficient USDT balance for that amount");
      const ethBal = await this._ethProvider.getBalance(wallet.address);
      if (ethBal <= 0n) throw new Error("This address needs a little ETH to pay gas for the swaps");
      const vkoinExpected = await quoteVkoinOut({ usdtSats, provider: this._ethProvider });
      const vkoinBefore = (await swap.balanceOf(this._ethProvider, RC.VKOIN, wallet.address)).toString();
      this._save({
        ...common,
        status: "approve_permit2", // skip swap_eth_usdt — USDT is already in hand
        amountUsdt: formatUsdt(usdtSats),
        usdtSats: usdtSats.toString(),
        vkoinBefore,
        estKoinOut: vkoinExpected.toString(),
      });
      return this.status();
    }

    if (source === "vkoin") {
      // Recovery: vKOIN already sits in the wallet — just bridge + redeem it.
      const vkoinSats = parseVkoin(amountVkoin);
      if (vkoinSats <= 0n) throw new Error("Amount must be greater than 0");
      if (vkoinSats > parseVkoin(MAX_ROUTE_C_VKOIN)) {
        throw new Error(`Amount ${formatVkoin(vkoinSats)} vKOIN exceeds the safety cap of ${MAX_ROUTE_C_VKOIN} vKOIN`);
      }
      const vkoinBal = await swap.balanceOf(this._ethProvider, RC.VKOIN, wallet.address);
      if (vkoinBal < vkoinSats) throw new Error("Insufficient vKOIN balance for that amount");
      const ethBal = await this._ethProvider.getBalance(wallet.address);
      if (ethBal <= 0n) throw new Error("This address needs a little ETH to pay gas for the bridge");
      this._save({
        ...common,
        status: "approve_bridge", // skip both swaps — vKOIN is already in hand
        amountVkoin: formatVkoin(vkoinSats),
        vkoinSats: vkoinSats.toString(),
        estKoinOut: vkoinSats.toString(), // 1:1
      });
      return this.status();
    }

    // source === "eth"
    const amt = ethers.parseEther(String(amountEth));
    if (amt <= 0n) throw new Error("Amount must be greater than 0");
    if (amt > ethers.parseEther(MAX_ROUTE_C_ETH)) {
      throw new Error(`Amount ${ethers.formatEther(amt)} ETH exceeds the safety cap of ${MAX_ROUTE_C_ETH} ETH`);
    }
    const quote = await quoteEthToVkoin({ amountEth, slippageBps, provider: this._ethProvider });
    const balance = await this._ethProvider.getBalance(wallet.address);
    if (balance <= amt) throw new Error("Insufficient ETH to cover the swap plus gas");
    const usdtBefore = (await swap.balanceOf(this._ethProvider, RC.USDT, wallet.address)).toString();
    this._save({
      ...common,
      status: "swap_eth_usdt",
      amountEth: String(amountEth),
      amountWei: amt.toString(),
      usdtBefore,
      estKoinOut: quote.koinOut,
    });
    return this.status();
  }

  // Advance one step. Safe to call on a loop; no-ops while a tx is still mining.
  async advance() {
    if (this._busy) return this.status();
    const job = this.status();
    if (!job || nextAction(job.status) === "none") return job;
    this._busy = true;
    try {
      const action = nextAction(job.status);
      if (action === "eth") await this._advanceEth(job);
      else if (action === "poll") await this._poll(job);
      else if (action === "redeem") await this._redeem(job);
    } catch (e) {
      const msg = String(e.message || e);
      // Transient (RPC blip, locked wallet, rate limit) — leave the job as-is and
      // let the driver retry next tick. estimateGas catches would-revert sends
      // before any gas is spent, so those surface as a real (non-transient) error.
      if (!this._isTransient(msg)) {
        this._save({ ...this.status(), status: "error", error: msg, failedAt: job.status });
      } else {
        // Rebuild the Ethereum provider/wallet next tick in case the RPC went down.
        this._ethWallet = null;
        this._ethProvider = null;
      }
    } finally {
      this._busy = false;
    }
    return this.status();
  }

  _isTransient(msg) {
    return /locked|unlock|ECONN|ETIMEDOUT|EAI_AGAIN|timeout|network|missing response|fetch failed|socket|throttl|rate limit|\b(429|502|503|504)\b|SERVER_ERROR|could not detect/i.test(String(msg));
  }

  // Recover a job that hit a non-transient error: return to the step it failed on
  // and clear the pending tx so that step re-sends fresh (a reverted send spent no
  // gas via estimateGas; a reverted mined tx moved no tokens — both safe to redo).
  resume() {
    const job = this.status();
    if (!job || job.status !== "error" || !job.failedAt) throw new Error("Nothing to resume");
    // A redeem failure re-polls for fresh guardian signatures (they may have expired)
    // before retrying — that path also rebuilds the tx with a current nonce.
    const back = job.failedAt === "redeeming" ? "awaiting_signatures" : job.failedAt;
    this._save({ ...job, status: back, error: null, pendingTx: null, redeemAttempts: 0, sigStartedAt: Date.now() });
    return this.status();
  }

  async _receipt(hash) {
    const r = await this._ethProvider.getTransactionReceipt(hash);
    if (!r) return null; // still mining
    if (r.status === 0) throw new Error(`Ethereum tx reverted (${String(hash).slice(0, 10)}…)`);
    return r;
  }

  async _advanceEth(job) {
    const wallet = await this._eth();
    // A tx is in flight for this state — wait for it, then process on confirmation.
    if (job.pendingTx) {
      const r = await this._receipt(job.pendingTx);
      if (!r) return;
      return await this._onEthConfirmed(job);
    }
    const now = Math.floor(Date.now() / 1000);
    switch (job.status) {
      case "swap_eth_usdt": {
        const { usdt, fee } = await quoteUsdtOut({ amountWei: job.amountWei, provider: this._ethProvider });
        const minUsdtOut = applySlippage(usdt, job.slippageBps);
        const tx = swap.buildEthToUsdtTx({ recipient: wallet.address, amountWei: job.amountWei, fee, minUsdtOut });
        const { hash } = await swap.sendTx(wallet, tx);
        this._save({ ...job, pendingTx: hash });
        return;
      }
      case "approve_permit2": {
        const cur = await swap.allowance(this._ethProvider, RC.USDT, wallet.address, RC.PERMIT2);
        if (cur >= BigInt(job.usdtSats)) return this._save({ ...job, status: "approve_ur" });
        const tx = swap.buildApproveTx(RC.USDT, RC.PERMIT2, swap.MAX_UINT256);
        const { hash } = await swap.sendTx(wallet, tx);
        this._save({ ...job, pendingTx: hash });
        return;
      }
      case "approve_ur": {
        const a = await swap.permit2Allowance(this._ethProvider, wallet.address, RC.USDT, RC.UNIVERSAL_ROUTER);
        if (BigInt(a.amount) >= BigInt(job.usdtSats) && Number(a.expiration) > now + 60) {
          return this._save({ ...job, status: "swap_usdt_vkoin" });
        }
        const tx = swap.buildPermit2ApproveTx({ token: RC.USDT, spender: RC.UNIVERSAL_ROUTER, amount: job.usdtSats, expiration: now + PERMIT2_EXPIRY_SEC });
        const { hash } = await swap.sendTx(wallet, tx);
        this._save({ ...job, pendingTx: hash });
        return;
      }
      case "swap_usdt_vkoin": {
        const vkoinExpected = await quoteVkoinOut({ usdtSats: job.usdtSats, provider: this._ethProvider });
        const minVkoinOut = applySlippage(vkoinExpected, job.slippageBps);
        const tx = swap.buildUsdtToVkoinTx({ usdtAmount: job.usdtSats, minVkoinOut, deadline: now + SWAP_DEADLINE_SEC });
        const { hash } = await swap.sendTx(wallet, tx);
        this._save({ ...job, pendingTx: hash, minVkoinOut: minVkoinOut.toString() });
        return;
      }
      case "approve_bridge": {
        const cur = await swap.allowance(this._ethProvider, RC.VKOIN, wallet.address, this._bridgeAddr());
        if (cur >= BigInt(job.vkoinSats)) return this._save({ ...job, status: "bridge_token" });
        const tx = swap.buildApproveTx(RC.VKOIN, this._bridgeAddr(), job.vkoinSats);
        const { hash } = await swap.sendTx(wallet, tx);
        this._save({ ...job, pendingTx: hash });
        return;
      }
      case "bridge_token": {
        const tx = buildTransferTokensTx({ token: RC.VKOIN, amountSats: job.vkoinSats, koinosRecipient: job.koinosRecipient, network: this.network });
        const { hash } = await swap.sendTx(wallet, tx);
        this._save({ ...job, pendingTx: hash });
        return;
      }
    }
  }

  async _onEthConfirmed(job) {
    const wallet = await this._eth();
    const confirmedHash = job.pendingTx;
    const base = { ...job, pendingTx: null };
    switch (job.status) {
      case "swap_eth_usdt": {
        const usdtNow = await swap.balanceOf(this._ethProvider, RC.USDT, wallet.address);
        const usdtSats = (usdtNow - BigInt(job.usdtBefore)).toString();
        if (BigInt(usdtSats) <= 0n) throw new Error("ETH→USDT swap produced no USDT");
        const vkoinBefore = (await swap.balanceOf(this._ethProvider, RC.VKOIN, wallet.address)).toString();
        return this._save({ ...base, status: "approve_permit2", usdtSats, vkoinBefore });
      }
      case "approve_permit2":
        return this._save({ ...base, status: "approve_ur" });
      case "approve_ur":
        return this._save({ ...base, status: "swap_usdt_vkoin" });
      case "swap_usdt_vkoin": {
        const vkoinNow = await swap.balanceOf(this._ethProvider, RC.VKOIN, wallet.address);
        const vkoinSats = (vkoinNow - BigInt(job.vkoinBefore)).toString();
        if (BigInt(vkoinSats) <= 0n) throw new Error("USDT→vKOIN swap produced no vKOIN");
        return this._save({ ...base, status: "approve_bridge", vkoinSats });
      }
      case "approve_bridge":
        return this._save({ ...base, status: "bridge_token" });
      case "bridge_token":
        return this._save({ ...base, status: "awaiting_signatures", ethTxHash: confirmedHash, sigStartedAt: Date.now() });
    }
  }

  // --- Koinos side (mirrors BridgeOrchestrator; redeem delivers native KOIN) ---
  async _poll(job) {
    const record = await fetchEthDepositRecord(job.ethTxHash, { network: this.network });
    if (!record) {
      if (Date.now() - (job.sigStartedAt || job.startedAt || 0) > POLL_TIMEOUT_MS) {
        this._save({ ...job, status: "error", error: "Guardians didn't sign in time. Your vKOIN is bridged — retry to resume.", failedAt: "awaiting_signatures" });
      }
      return; // not indexed yet
    }
    const n = Array.isArray(record.validators) && record.validators.length ? record.validators.length : 3;
    if (isRedeemable(record, n)) {
      this._save({ ...job, status: "redeeming", record });
    } else if (record.expiration && Number(record.expiration) <= Date.now()) {
      await requestNewSignatures({ ethPrivHex: this.wallet.ethPrivateKey(), ethTxHash: job.ethTxHash, network: this.network });
      this._save({ ...job, status: "awaiting_signatures", sigStartedAt: Date.now() });
    }
  }

  async _redeem(job) {
    const attempts = (job.redeemAttempts || 0) + 1;
    const sponsorAddress = await fetchSponsorAddress(this.settings);
    // Build fresh every attempt so koilib re-fetches the account nonce.
    const tx = await buildRedeemTransaction({
      userSigner: this._koinosSigner(),
      record: job.record,
      sponsorAddress,
      network: this.network,
      provider: this.provider,
    });
    try {
      const res = await coSignAndBroadcast(this.settings, this.appKey, tx);
      this._save({ ...job, status: "done", redeemId: res.id, koinReceived: job.record.amount, finishedAt: Date.now() });
    } catch (e) {
      const m = String(e.message || e);
      // The transfer already completed on a prior attempt whose response we lost —
      // the KOIN is delivered, so this is success, not a failure.
      if (/already complet|already redeem|already processed|has been completed|already exists/i.test(m)) {
        this._save({ ...job, status: "done", koinReceived: job.record.amount, finishedAt: Date.now(), redeemNote: "already completed" });
        return;
      }
      // Retryable: a stale nonce (the account was raced by another tx, e.g. a reward
      // return), OR a transient relayer/RPC hiccup (deadline exceeded, internal server
      // error, 5xx, rate limit). Both often mean the tx may not have applied — rebuild
      // with a fresh nonce next tick. Bounded so a persistent problem still surfaces.
      const retryable = /invalid transaction nonce|nonce mismatch|\b-201\b|context deadline|deadline exceeded|internal server error|rpc failed|timeout|timed out|ECONN|connection reset|temporarily unavailable|service unavailable|too many requests|\b(429|500|502|503|504)\b/i;
      if (retryable.test(m) && attempts < 15) {
        this._save({ ...job, redeemAttempts: attempts });
        return; // stay in "redeeming"; the driver retries
      }
      throw e;
    }
  }
}

module.exports = { RouteCOrchestrator, nextAction, MAX_ROUTE_C_ETH, MAX_ROUTE_C_USDT, MAX_ROUTE_C_VKOIN, DEFAULT_SLIPPAGE_BPS };
