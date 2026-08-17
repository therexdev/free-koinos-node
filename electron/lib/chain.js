"use strict";

const { Provider, Contract, Transaction, utils } = require("koilib");
const { NETWORKS, POB_ABI, TOKEN_ABI, BURN_MANA_CUSHION } = require("./constants");
const { cmpSats, subSats, formatAmount } = require("./format");

const RC_LIMIT_CAP = 1000000000n; // never ask for more than 10 KOIN of mana
const MIN_MANA = 5000000n;        // refuse to send with < 0.05 KOIN of mana
const WAIT_TIMEOUT_MS = 60000;

function rpcError(e) {
  let msg = String(e?.message ?? e ?? "RPC error");
  // koilib sometimes surfaces raw JSON errors; extract the useful part.
  try {
    const parsed = JSON.parse(msg);
    if (typeof parsed?.error === "string") {
      msg = parsed.error;
      if (Array.isArray(parsed.logs) && parsed.logs.length > 0) {
        msg += ` — ${parsed.logs[0]}`;
      }
    } else {
      msg = parsed?.error?.message ?? parsed?.message ?? msg;
    }
  } catch {
    /* not JSON */
  }
  return new Error(msg);
}

const CONTRACT_NAMES = ["koin", "vhp", "pob"];
const RESOLVE_TTL_MS = 60 * 60 * 1000;
const LOCAL_PROBE_TTL_MS = 30 * 1000;      // how often to re-check our own node
const LOCAL_SYNC_TOLERANCE_MS = 2 * 60 * 1000; // head this fresh counts as caught up
const FAILOVER_WINDOW_MS = 15 * 1000;      // window for one rotation through the endpoints

class ChainService {
  constructor(settings) {
    this.settings = settings;
    this._resolved = {}; // { [networkId]: { addrs, at } }
  }

  clearCache() {
    this._resolved = {};
    this._localHealth = {}; // re-probe our node on the next call
  }

  // The canonical KOIN/VHP/PoB addresses can change (the token contracts have
  // migrated on mainnet before), so ask the chain via the
  // get_contract_address system call and fall back to the vendored addresses.
  async resolveContracts() {
    const net = this.network();
    const cached = this._resolved[net.id];
    if (cached && Date.now() - cached.at < RESOLVE_TTL_MS) return cached.addrs;
    const provider = this.provider();
    const addrs = { ...net.contracts };
    await Promise.all(
      CONTRACT_NAMES.map(async (name) => {
        try {
          const r = await provider.invokeGetContractAddress(name);
          const a = r?.value?.address;
          if (a && this.isValidAddress(a)) addrs[name] = a;
        } catch {
          /* keep fallback address */
        }
      })
    );
    this._resolved[net.id] = { addrs, at: Date.now() };
    return addrs;
  }

  // KCS-4 tokens (the current mainnet KOIN) only let another contract pull
  // funds through an allowance, so burning via PoB needs an approve operation
  // in the same transaction. Legacy tokens (older deployments, testnets) have
  // no allowance method at all — probe once per network and cache.
  async _isAllowanceToken(provider) {
    const net = this.network();
    const cached = this._allowanceStyle?.[net.id];
    if (cached && Date.now() - cached.at < RESOLVE_TTL_MS) return cached.val;
    let val;
    try {
      const koin = await this._contract("koin", { provider });
      const probe = net.contracts.pob;
      await koin.functions.allowance({ owner: probe, spender: probe });
      val = true;
    } catch {
      val = false;
    }
    (this._allowanceStyle ??= {})[net.id] = { val, at: Date.now() };
    return val;
  }

  network() {
    return NETWORKS[this.settings.get("network", "mainnet")] ?? NETWORKS.mainnet;
  }

  // Is the node we manage answering AND caught up? Probed in the background and
  // cached, because rpcUrls() is synchronous and sits on every call path. A
  // node that is still syncing is deliberately NOT used: it would answer with
  // stale balances and a short block history, which is worse than a public
  // endpoint. Unknown counts as down, so the first call after launch uses the
  // public endpoint and later ones switch over once the probe lands.
  _localNodeUsable() {
    const net = this.network();
    const st = ((this._localHealth ??= {})[net.id] ??= { up: false, at: 0, checking: false });
    if (!st.checking && Date.now() - st.at > LOCAL_PROBE_TTL_MS) {
      st.checking = true;
      (async () => {
        let up = false;
        try {
          const head = await new Provider([net.localRpcUrl]).getHeadInfo();
          const headMs = Number(head?.head_block_time ?? 0);
          up = Date.now() - headMs < LOCAL_SYNC_TOLERANCE_MS;
        } catch {
          up = false;
        }
        st.up = up;
        st.at = Date.now();
        st.checking = false;
      })();
    }
    return st.up;
  }

  // Which endpoints to use, best first. An explicit custom RPC always wins;
  // otherwise our own synced node leads and the public endpoint backs it up.
  rpcUrls() {
    const net = this.network();
    const custom = this.settings.get(`customRpc.${net.id}`, "");
    if (custom && /^https?:\/\//.test(custom)) return [custom];
    const pub = net.rpcUrls;
    if (this.settings.get("useLocalNodeRpc", true) && this._localNodeUsable()) {
      return [net.localRpcUrl, ...pub];
    }
    return pub.length > 0 ? pub : [net.localRpcUrl];
  }

  // What the UI reports about where chain data is coming from.
  rpcStatus() {
    const net = this.network();
    const custom = this.settings.get(`customRpc.${net.id}`, "");
    const urls = this.rpcUrls();
    return {
      urls,
      active: urls[0] ?? null,
      usingLocal: urls[0] === net.localRpcUrl,
      localUrl: net.localRpcUrl,
      localUsable: this._localNodeUsable(),
      preferLocal: !!this.settings.get("useLocalNodeRpc", true),
      custom: custom || null,
      fallbacks: urls.slice(1),
    };
  }

  provider(urls) {
    const list = urls ?? this.rpcUrls();
    const p = new Provider(list);
    // koilib's default onError returns true, which ABORTS on the first failure
    // — so a list of endpoints is not a fallback chain unless we make it one.
    // Allow one full rotation within a short window (so a request survives our
    // node going down mid-flight), then give up rather than spin forever.
    if (list.length > 1) {
      let fails = 0;
      let windowAt = 0;
      p.onError = () => {
        const now = Date.now();
        if (now - windowAt > FAILOVER_WINDOW_MS) {
          fails = 0;
          windowAt = now;
        }
        return ++fails >= list.length;
      };
    }
    return p;
  }

  isValidAddress(address) {
    try {
      return utils.isChecksumAddress(String(address).trim());
    } catch {
      return false;
    }
  }

  async _contract(kind, { signer, provider } = {}) {
    const p = provider ?? this.provider();
    const addrs = await this.resolveContracts();
    if (signer) signer.provider = p;
    // TOKEN_ABI/POB_ABI are vendored from the chain's contract meta store —
    // koilib's bundled tokenAbi trips protobufjs 7.x extension resolution.
    return new Contract({
      id: addrs[kind],
      abi: kind === "pob" ? POB_ABI : TOKEN_ABI,
      provider: p,
      signer,
    });
  }

  async balances(address) {
    const provider = this.provider();
    try {
      const [koin, vhp] = await Promise.all([
        this._contract("koin", { provider }),
        this._contract("vhp", { provider }),
      ]);
      const [k, v, rc] = await Promise.all([
        koin.functions.balance_of({ owner: address }),
        vhp.functions.balance_of({ owner: address }),
        provider.getAccountRc(address).catch(() => "0"),
      ]);
      return {
        koin: k?.result?.value ?? "0",
        vhp: v?.result?.value ?? "0",
        mana: rc ?? "0",
      };
    } catch (e) {
      throw rpcError(e);
    }
  }

  async headInfo(urls) {
    try {
      const head = await this.provider(urls).getHeadInfo();
      return {
        height: Number(head.head_topology?.height ?? 0),
        lastIrreversible: Number(head.last_irreversible_block ?? 0),
        headBlockTimeMs: Number(head.head_block_time ?? 0),
      };
    } catch (e) {
      throw rpcError(e);
    }
  }

  // Compares the local node's head with public RPC (when available) and with
  // wall-clock time to report sync progress.
  async syncStatus() {
    const net = this.network();
    const [local, remote] = await Promise.all([
      this.headInfo([net.localRpcUrl]).catch((e) => ({ error: String(e.message) })),
      net.rpcUrls.length > 0
        ? this.headInfo(net.rpcUrls).catch(() => null)
        : Promise.resolve(null),
    ]);
    const out = { local, remote, inSync: false, progressPct: null };
    if (!local.error) {
      out.inSync = Date.now() - local.headBlockTimeMs < 60000;
      if (remote && remote.height > 0) {
        out.progressPct = Math.min(100, (local.height / remote.height) * 100);
      } else if (out.inSync) {
        out.progressPct = 100;
      }
    }
    return out;
  }

  async _rcLimit(provider, address) {
    let rc = 0n;
    try {
      rc = BigInt((await provider.getAccountRc(address)) || "0");
    } catch {
      /* treated as zero */
    }
    if (rc < MIN_MANA) {
      throw new Error(
        "Not enough mana to send a transaction. Keep some liquid KOIN in the wallet and let mana recharge."
      );
    }
    return (rc < RC_LIMIT_CAP ? rc : RC_LIMIT_CAP).toString();
  }

  async _finalize(transaction) {
    const out = { txId: transaction.id, confirmed: false, blockNumber: null };
    try {
      const { blockNumber } = await transaction.wait("by_block", WAIT_TIMEOUT_MS);
      out.confirmed = true;
      out.blockNumber = blockNumber ?? null;
    } catch {
      out.note = "Transaction submitted; confirmation timed out. Check the explorer.";
    }
    return out;
  }

  async _finalizeTx(tx) {
    const out = { txId: tx.transaction?.id ?? null, confirmed: false, blockNumber: null };
    try {
      const { blockNumber } = await tx.wait("by_block", WAIT_TIMEOUT_MS);
      out.confirmed = true;
      out.blockNumber = blockNumber ?? null;
    } catch {
      out.note = "Transaction submitted; confirmation timed out. Check the explorer.";
    }
    return out;
  }

  // How much KOIN can actually be burned/sent right now given current mana.
  // On-chain, both operations require mana >= amount (mana recharges over
  // ~5 days); we keep a small cushion for the transaction's own resource cost.
  burnableFromMana(manaSat) {
    return cmpSats(manaSat, BURN_MANA_CUSHION) > 0 ? subSats(manaSat, BURN_MANA_CUSHION) : "0";
  }

  // Fail early with a clear, actionable message instead of letting the token /
  // PoB contract revert with the opaque "could not burn KOIN".
  _assertMana(amountSat, manaSat, verb) {
    const burnable = this.burnableFromMana(manaSat);
    if (cmpSats(amountSat, burnable) > 0) {
      const doing = verb === "burn" ? "Burning" : "Sending";
      throw new Error(
        `Not enough mana to ${verb} ${formatAmount(amountSat)} KOIN — about ${formatAmount(burnable)} KOIN ` +
          `is available now. ${doing} KOIN spends mana, which recharges over ~5 days; ` +
          `${verb} a smaller amount or wait for mana to refill.`
      );
    }
  }

  // Burn KOIN belonging to `signer` and credit VHP to the same address
  // (or `vhpAddress` when given) via the PoB contract. On KCS-4 KOIN the
  // PoB contract pulls the tokens, so the same transaction first approves
  // exactly the burn amount (the pull consumes the allowance).
  async burn(signer, amountSat, { vhpAddress } = {}) {
    const address = signer.getAddress();
    if (cmpSats(amountSat, "0") <= 0) throw new Error("Burn amount must be positive");
    const { koin, mana } = await this.balances(address);
    if (cmpSats(amountSat, koin) > 0) throw new Error("Insufficient KOIN balance");
    this._assertMana(amountSat, mana, "burn");
    const provider = this.provider();
    const rcLimit = await this._rcLimit(provider, address);
    const addrs = await this.resolveContracts();
    const needsApprove = await this._isAllowanceToken(provider);
    try {
      const koinContract = await this._contract("koin", { signer, provider });
      const pob = await this._contract("pob", { signer, provider });
      const tx = new Transaction({ signer, provider, options: { rcLimit } });
      if (needsApprove) {
        await tx.pushOperation(koinContract.functions.approve, {
          owner: address,
          spender: addrs.pob,
          value: String(amountSat),
        });
      }
      await tx.pushOperation(pob.functions.burn, {
        token_amount: String(amountSat),
        burn_address: address,
        vhp_address: vhpAddress || address,
      });
      await tx.send();
      return await this._finalizeTx(tx);
    } catch (e) {
      throw rpcError(e);
    }
  }

  async transfer(signer, { to, amountSat, token = "koin" }) {
    const address = signer.getAddress();
    if (!["koin", "vhp"].includes(token)) throw new Error(`Unknown token: ${token}`);
    if (!this.isValidAddress(to)) throw new Error("Invalid recipient address");
    if (cmpSats(amountSat, "0") <= 0) throw new Error("Amount must be positive");
    const balances = await this.balances(address);
    if (cmpSats(amountSat, balances[token]) > 0) {
      throw new Error(`Insufficient ${token.toUpperCase()} balance`);
    }
    // KOIN transfers also require mana >= amount on-chain (VHP does not).
    if (token === "koin") this._assertMana(amountSat, balances.mana, "send");
    const provider = this.provider();
    const rcLimit = await this._rcLimit(provider, address);
    const contract = await this._contract(token, { signer, provider });
    try {
      const { transaction } = await contract.functions.transfer(
        { from: address, to: String(to).trim(), value: String(amountSat) },
        { rcLimit }
      );
      return await this._finalize(transaction);
    } catch (e) {
      throw rpcError(e);
    }
  }

  // Registers the node's block-signing public key (base64url, as written by
  // the block producer to public.key) to the producer address.
  async registerProducerKey(signer, publicKeyB64url) {
    const producer = signer.getAddress();
    if (!publicKeyB64url) throw new Error("Missing block producer public key");
    const provider = this.provider();
    const rcLimit = await this._rcLimit(provider, producer);
    const pob = await this._contract("pob", { signer, provider });
    try {
      const { transaction } = await pob.functions.register_public_key(
        { producer, public_key: String(publicKeyB64url).trim() },
        { rcLimit }
      );
      return await this._finalize(transaction);
    } catch (e) {
      throw rpcError(e);
    }
  }

  // Account history (block-production records, transfers) from the configured
  // RPC. Requires the RPC to run the account_history microservice — the public
  // mainnet endpoint does; a bare local node does not.
  async getAccountHistory(address, { limit = 100, seqNum, ascending = true } = {}) {
    const provider = this.provider();
    const params = { address, limit, ascending, irreversible: false };
    if (seqNum !== undefined && seqNum !== null) params.seq_num = String(seqNum);
    try {
      const res = await provider.call("account_history.get_account_history", params);
      return res?.values ?? [];
    } catch (e) {
      throw rpcError(e);
    }
  }

  // Block headers over [fromHeight, toHeight] straight from the block store
  // (headers only — no receipts). Used to see who is producing on the network.
  async blockHeaders(fromHeight, toHeight) {
    const provider = this.provider();
    const CHUNK = 100;
    try {
      const head = await provider.getHeadInfo();
      const headId = head.head_topology?.id;
      const headHeight = Number(head.head_topology?.height ?? 0);
      const from = Math.max(1, Number(fromHeight));
      const to = Math.min(Number(toHeight), headHeight);
      const headers = [];
      for (let start = from; start <= to; start += CHUNK) {
        const num = Math.min(CHUNK, to - start + 1);
        const res = await provider.call("block_store.get_blocks_by_height", {
          head_block_id: headId,
          ancestor_start_height: String(start),
          num_blocks: num,
          return_block: true,
          return_receipt: false,
        });
        for (const item of res?.block_items ?? []) {
          const h = item.block?.header;
          if (!h) continue;
          headers.push({
            height: Number(item.block_height ?? h.height ?? 0),
            timestamp: Number(h.timestamp ?? 0),
            signer: h.signer ?? null,
          });
        }
      }
      return { headHeight, headers };
    } catch (e) {
      throw rpcError(e);
    }
  }

  // VHP balances for many addresses, fetched with bounded concurrency.
  // Returns { [address]: vhpSat }; individual failures resolve to null so one
  // bad address doesn't sink the whole eligibility check.
  async vhpBalances(addresses, { concurrency = 8 } = {}) {
    const provider = this.provider();
    const vhp = await this._contract("vhp", { provider });
    const out = {};
    const queue = [...new Set(addresses)];
    const worker = async () => {
      while (queue.length > 0) {
        const address = queue.shift();
        try {
          const r = await vhp.functions.balance_of({ owner: address });
          out[address] = r?.result?.value ?? "0";
        } catch {
          out[address] = null;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
    return out;
  }

  async registeredPublicKey(producer) {
    try {
      const pob = await this._contract("pob");
      // Reverts with "given address has no public key record" when unset.
      const res = await pob.functions.get_public_key({ producer });
      return res?.result?.value ?? null;
    } catch {
      return null;
    }
  }
}

module.exports = { ChainService };
