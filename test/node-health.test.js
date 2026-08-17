"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  assessHealth,
  serviceTrouble,
  describeRecovery,
  recommendWslMemory,
  parseSizeGB,
  mergeWslConfig,
  classifyCrash,
  crashRemedy,
  isCrashLooping,
} = require("../electron/lib/node-health");

// A real block_store crash tail (segfault in GetBlocksByHeight, seen looping).
const PANIC_LOG = `
block_store-1 | [koinos-mq-golang] Request handler connected
block_store-1 | panic: runtime error: invalid memory address or nil pointer dereference
block_store-1 | [signal SIGSEGV: segmentation violation code=0x1 addr=0x40 pc=0x91eae0]
block_store-1 | github.com/koinos/koinos-block-store/internal/bstore.(*RequestHandler).GetBlocksByHeight(...)
block_store-1 | Koinos Block Store v1.1.0
block_store-1 | panic: runtime error: invalid memory address or nil pointer dereference
`;

const upRow = (service) => ({ service, state: "running", status: "Up 2 hours" });
const healthySet = (producing = false) =>
  ["chain", "block_store", "mempool", "p2p", ...(producing ? ["block_producer"] : []), "jsonrpc"].map(upRow);

// ---------- serviceTrouble ----------

test("serviceTrouble flags a crash-looping / OOM-killed container", () => {
  assert.deepEqual(serviceTrouble({ state: "restarting", status: "Restarting (137) 3 seconds ago" }), {
    down: true,
    oom: true,
  });
  assert.deepEqual(serviceTrouble({ state: "exited", status: "Exited (1) 5 seconds ago" }), {
    down: true,
    oom: false,
  });
  assert.deepEqual(serviceTrouble(upRow("chain")), { down: false, oom: false });
});

// ---------- assessHealth ----------

test("assessHealth: a fully-up stack that is advancing is healthy", () => {
  const h = assessHealth({
    services: healthySet(true),
    producing: true,
    headHeight: 1010,
    lastHeight: 1000,
    lastHeightAt: 1_000_000,
    now: 1_000_000 + 30_000,
  });
  assert.deepEqual(h, { ok: true, reason: null, oom: false });
});

test("assessHealth: block_store crash-loop is caught as OOM", () => {
  const services = healthySet(true).map((r) =>
    r.service === "block_store" ? { service: "block_store", state: "restarting", status: "Restarting (137) 2 seconds ago" } : r
  );
  const h = assessHealth({ services, producing: true, headHeight: 1000, lastHeight: 1000, lastHeightAt: 0, now: 1000 });
  assert.equal(h.ok, false);
  assert.equal(h.reason, "oom");
  assert.equal(h.oom, true);
  assert.equal(h.service, "block_store");
});

test("assessHealth: a missing core container is service-down", () => {
  const services = healthySet(false).filter((r) => r.service !== "p2p");
  const h = assessHealth({ services, producing: false, now: 1000 });
  assert.equal(h.ok, false);
  assert.equal(h.reason, "service-down");
  assert.equal(h.service, "p2p");
});

test("assessHealth: the API tier is not required (memory-saver drops jsonrpc)", () => {
  const services = ["chain", "block_store", "mempool", "p2p", "block_producer"].map(upRow); // no jsonrpc
  const h = assessHealth({ services, producing: true, headHeight: 5, lastHeight: 4, lastHeightAt: 0, now: 1000 });
  assert.equal(h.ok, true);
});

test("assessHealth: head flat past the stall window is 'stalled'", () => {
  const base = { services: healthySet(false), producing: false, headHeight: 1000, lastHeight: 1000, lastHeightAt: 0 };
  // Within the window: still considered ok.
  assert.equal(assessHealth({ ...base, now: 5 * 60 * 1000 }).ok, true);
  // Past the window: wedged.
  const stalled = assessHealth({ ...base, now: 9 * 60 * 1000 });
  assert.equal(stalled.ok, false);
  assert.equal(stalled.reason, "stalled");
});

test("assessHealth: advancing head is never stalled even after a long time", () => {
  const h = assessHealth({
    services: healthySet(false),
    headHeight: 2000,
    lastHeight: 1000,
    lastHeightAt: 0,
    now: 60 * 60 * 1000,
  });
  assert.equal(h.ok, true);
});

test("assessHealth: no service data is a no-op, not a false alarm", () => {
  const h = assessHealth({ services: [], producing: true, now: 1000 });
  assert.deepEqual(h, { ok: true, reason: "no-data", oom: false });
});

// ---------- describeRecovery ----------

test("describeRecovery is plain-English and never mentions Docker/OOM/RocksDB", () => {
  for (const [reason, oom] of [["oom", true], ["stalled", false], ["service-down", false], [null, false]]) {
    const s = describeRecovery(reason, oom);
    assert.match(s, /your node/i);
    assert.doesNotMatch(s, /docker|oom|rocksdb|wsl|137|container/i);
  }
});

// ---------- recommendWslMemory ----------

test("recommendWslMemory leaves host headroom and caps the top end", () => {
  const gib = 1024 * 1024 * 1024;
  const r8 = recommendWslMemory(8 * gib);
  assert.equal(r8.hostGB, 8);
  assert.ok(r8.memoryGB >= 4 && r8.memoryGB <= 6, `8GB host -> ${r8.memoryGB}`);
  assert.ok(r8.memoryGB <= 8 - 2);

  const r16 = recommendWslMemory(16 * gib);
  assert.ok(r16.memoryGB >= 8 && r16.memoryGB <= 12, `16GB host -> ${r16.memoryGB}`);

  const r64 = recommendWslMemory(64 * gib);
  assert.ok(r64.memoryGB <= 24, "caps at 24GB");
  assert.equal(r64.swapGB, 8);
});

// ---------- parseSizeGB ----------

test("parseSizeGB understands GB/MB/bare units", () => {
  assert.equal(parseSizeGB("8GB"), 8);
  assert.equal(parseSizeGB("8"), 8);
  assert.equal(parseSizeGB("4096MB"), 4);
  assert.equal(parseSizeGB("nonsense"), null);
});

// ---------- mergeWslConfig ----------

test("mergeWslConfig creates a [wsl2] section when the file is empty", () => {
  const { text, changed } = mergeWslConfig("", { memoryGB: 8, swapGB: 8 });
  assert.equal(changed, true);
  assert.match(text, /\[wsl2\]/);
  assert.match(text, /memory=8GB/);
  assert.match(text, /swap=8GB/);
});

test("mergeWslConfig raises a too-low memory value but preserves other keys", () => {
  const existing = ["[wsl2]", "memory=2GB", "processors=4", "swap=8GB"].join("\n");
  const { text, changed } = mergeWslConfig(existing, { memoryGB: 8, swapGB: 8 });
  assert.equal(changed, true);
  assert.match(text, /memory=8GB/);
  assert.match(text, /processors=4/); // untouched
  assert.doesNotMatch(text, /memory=2GB/);
});

test("mergeWslConfig never lowers a value the user set higher", () => {
  const existing = ["[wsl2]", "memory=16GB", "swap=16GB"].join("\n");
  const { text, changed } = mergeWslConfig(existing, { memoryGB: 8, swapGB: 8 });
  assert.equal(changed, false);
  assert.match(text, /memory=16GB/);
  assert.match(text, /swap=16GB/);
});

test("mergeWslConfig appends [wsl2] without clobbering an unrelated section", () => {
  const existing = ["[experimental]", "sparseVhd=true"].join("\n");
  const { text, changed } = mergeWslConfig(existing, { memoryGB: 8, swapGB: 8 });
  assert.equal(changed, true);
  assert.match(text, /\[experimental\]/);
  assert.match(text, /sparseVhd=true/);
  assert.match(text, /\[wsl2\]/);
  assert.match(text, /memory=8GB/);
});

// ---------- classifyCrash / crashRemedy / isCrashLooping ----------

test("classifyCrash reads a segfault/nil-pointer panic as a panic (not OOM)", () => {
  assert.equal(classifyCrash(PANIC_LOG), "panic");
  assert.equal(crashRemedy(classifyCrash(PANIC_LOG)), "repair"); // rebuild data, don't just restart
});

test("classifyCrash distinguishes OOM, corruption, and benign logs", () => {
  assert.equal(classifyCrash("container exited (137)"), "oom");
  assert.equal(crashRemedy("oom"), "memory");
  assert.equal(classifyCrash("badger: Corruption: checksum mismatch"), "corruption");
  assert.equal(crashRemedy("corruption"), "repair");
  assert.equal(classifyCrash("All 2084 tables opened in 7.3s\nRequest handler connected"), null);
  assert.equal(crashRemedy(null), null);
});

test("isCrashLooping needs repeated panics, not a single one", () => {
  assert.equal(isCrashLooping(PANIC_LOG), true); // two panics in the tail
  assert.equal(isCrashLooping("panic: runtime error: nil pointer"), false); // one-off
  assert.equal(isCrashLooping("All tables opened; connected"), false);
});
