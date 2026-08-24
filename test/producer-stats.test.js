"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ProducerStats } = require("../electron/lib/producer-stats");

const ADDR = "1ProducerAddress";
const KEY = `stats.mainnet.${ADDR}`;

function store(seed = {}) {
  const data = { ...seed };
  return {
    data,
    get: (k, d) => (k in data ? data[k] : d),
    set: (k, v) => { data[k] = v; },
  };
}

function chainThat(getAccountHistory) {
  return {
    network: () => ({ id: "mainnet", contracts: {} }),
    resolveContracts: async () => ({}),
    getAccountHistory,
  };
}

const CACHED = {
  cursorNext: 12,
  maxSeq: 11,
  totals: { blocks: 4, rewards: "400000000", vhpConsumed: "380000000", profit: "20000000", depositsIn: "0", burned: "0", sentOut: "0" },
  feed: [{ type: "block", height: 9, reward: "100000000", vhpBurned: "95000000", profit: "5000000", time: 1000 }],
  daily: {},
  recent: [],
  updatedAt: 1700000000000,
};

test("a history hiccup serves the cached snapshot instead of blanking it", async () => {
  const state = store({ [KEY]: { ...CACHED } });
  const stats = new ProducerStats({
    chain: chainThat(async () => { throw new Error("request timeout"); }),
    state,
  });
  const res = await stats.refresh(ADDR);
  // Available, so the dashboard keeps drawing numbers rather than falling back
  // to "—" for a tick and popping straight back.
  assert.equal(res.available, true);
  assert.equal(res.stale, true);
  assert.equal(res.error, "request timeout");
  assert.equal(res.totals.blocks, 4);
  assert.equal(res.totals.rewards, "400000000");
  assert.equal(res.feed.length, 1);
});

test("a cold failure is still reported as unavailable", async () => {
  const stats = new ProducerStats({
    chain: chainThat(async () => { throw new Error("no history rpc"); }),
    state: store(),
  });
  const res = await stats.refresh(ADDR);
  assert.equal(res.available, false);
  assert.equal(res.error, "no history rpc");
  assert.equal(res.totals, undefined);
});

test("a good refresh is not marked stale", async () => {
  const state = store({ [KEY]: { ...CACHED } });
  const stats = new ProducerStats({ chain: chainThat(async () => []), state });
  const res = await stats.refresh(ADDR);
  assert.equal(res.available, true);
  assert.equal(res.stale, undefined);
  assert.equal(res.totals.blocks, 4);
});
