"use strict";

const { classifyEntry, accumulate, EMPTY_TOTALS } = require("./koinos-events");
const { addBlockToDaily, pruneDaily, computeWindows, DAY_MS } = require("./profit-metrics");

const RECENT_WINDOW_MS = 2 * DAY_MS; // recent blocks kept for the rolling 24h window

const PAGE = 100;              // entries per history page
const MAX_PAGES_PER_REFRESH = 25; // cap backfill work per refresh (2500 entries)
const FEED_FETCH = 60;         // latest entries scanned to build the feed
const FEED_KEEP = 40;          // feed rows retained

// Builds the dashboard's producer statistics from on-chain account history:
// cumulative totals (rewards, VHP consumed, profit, deposits, burns) plus a
// recent activity feed. Totals are backfilled incrementally and cached per
// network+address so repeated refreshes stay cheap.
class ProducerStats {
  constructor({ chain, state }) {
    this.chain = chain;
    this.state = state;
    this._busy = false;
  }

  _key(networkId, address) {
    return `stats.${networkId}.${address}`;
  }

  _load(key) {
    const s = this.state.get(key, null) ?? {
      cursorNext: 0, // next seq_num to backfill from
      maxSeq: -1,
      totals: { ...EMPTY_TOTALS },
      feed: [],
      daily: {}, // { [dayKey]: profitSats } — backfilled profit per day
      recent: [], // [{ time, profit }] — recent blocks for the rolling 24h window
      updatedAt: 0,
    };
    s.daily ??= {}; // backfill fields onto older cached state
    s.recent ??= [];
    return s;
  }

  get(networkId, address) {
    if (!address) return null;
    const s = this._load(this._key(networkId, address));
    return {
      totals: s.totals,
      feed: s.feed,
      windows: computeWindows(s.daily, s.recent, Date.now()),
      syncing: s.cursorNext <= s.maxSeq,
      updatedAt: s.updatedAt,
    };
  }

  async refresh(address) {
    if (!address || this._busy) return this.getCurrent(address);
    this._busy = true;
    try {
      return await this._refresh(address);
    } finally {
      this._busy = false;
    }
  }

  getCurrent(address) {
    const net = this.chain.network().id;
    return { network: net, available: true, ...this.get(net, address) };
  }

  async _refresh(address) {
    const networkId = this.chain.network().id;
    const key = this._key(networkId, address);
    const contracts = await this.chain.resolveContracts().catch(() => this.chain.network().contracts);
    const ctx = { address, contracts };

    // 1. Latest page (descending) → current feed + newest seq number.
    let latest;
    try {
      latest = await this.chain.getAccountHistory(address, { limit: FEED_FETCH, ascending: false });
    } catch (e) {
      return { network: networkId, available: false, error: String(e.message) };
    }
    const s = this._load(key);
    if (latest.length > 0) {
      const seqs = latest.map((e) => Number(e.seq_num)).filter((n) => !Number.isNaN(n));
      s.maxSeq = Math.max(s.maxSeq, ...seqs);
      const feed = [];
      const recentCut = Date.now() - RECENT_WINDOW_MS;
      const recent = [];
      for (const entry of latest) {
        const rec = classifyEntry(entry, ctx);
        if (!rec) continue;
        feed.push(rec);
        // Recent block profits power the true rolling-24h window immediately,
        // even before the (oldest-first) cumulative backfill reaches today.
        if (rec.type === "block" && rec.time >= recentCut) recent.push({ time: rec.time, profit: rec.profit });
      }
      s.feed = feed.slice(0, FEED_KEEP);
      s.recent = recent;
    }

    // 2. Backfill cumulative totals from the cursor forward, capped per refresh.
    let pages = 0;
    while (pages < MAX_PAGES_PER_REFRESH && s.cursorNext <= s.maxSeq) {
      let batch;
      try {
        batch = await this.chain.getAccountHistory(address, {
          limit: PAGE,
          seqNum: s.cursorNext,
          ascending: true,
        });
      } catch {
        break;
      }
      if (!batch.length) break;
      for (const entry of batch) {
        const rec = classifyEntry(entry, ctx);
        if (rec) {
          s.totals = accumulate(s.totals, rec);
          addBlockToDaily(s.daily, rec); // fold block profit into its day bucket
        }
        const seq = Number(entry.seq_num);
        if (!Number.isNaN(seq)) s.cursorNext = Math.max(s.cursorNext, seq + 1);
      }
      pages += 1;
      if (batch.length < PAGE) break; // caught up
    }

    pruneDaily(s.daily, Date.now());
    s.updatedAt = Date.now();
    this.state.set(key, s);
    return {
      network: networkId,
      available: true,
      totals: s.totals,
      feed: s.feed,
      windows: computeWindows(s.daily, s.recent, Date.now()),
      syncing: s.cursorNext <= s.maxSeq,
    };
  }
}

module.exports = { ProducerStats };
