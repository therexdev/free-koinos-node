"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { LastGood } = require("../electron/lib/last-good");

const KEY = "balances.mainnet.1Abc";

test("a good read is passed straight through and cached", async () => {
  const hold = new LastGood();
  const v = await hold.run(KEY, async () => ({ koin: "100", vhp: "200" }));
  assert.deepEqual(v, { koin: "100", vhp: "200" });
  assert.deepEqual(hold.get(KEY), { koin: "100", vhp: "200" });
});

test("a failed read serves the last good value, flagged stale", async () => {
  const hold = new LastGood();
  await hold.run(KEY, async () => ({ koin: "100", vhp: "200", mana: "50" }), 1000);
  const v = await hold.run(KEY, async () => { throw new Error("request timeout"); }, 2000);
  // The numbers survive — this is the whole point: a tile must not blank and
  // refill on the next poll.
  assert.equal(v.koin, "100");
  assert.equal(v.vhp, "200");
  assert.equal(v.mana, "50");
  assert.equal(v.stale, true);
  assert.equal(v.staleAt, 1000);
  assert.equal(v.staleError, "request timeout");
  assert.equal(v.error, undefined); // callers keying off `error` still see usable data
});

test("a cold failure reports the error — there is nothing to hold", async () => {
  const hold = new LastGood();
  const v = await hold.run(KEY, async () => { throw new Error("no endpoint"); });
  assert.deepEqual(v, { error: "no endpoint" });
});

test("a held value expires rather than being shown forever", async () => {
  const hold = new LastGood({ holdMs: 60_000 });
  await hold.run(KEY, async () => ({ koin: "100" }), 0);
  const inside = await hold.run(KEY, async () => { throw new Error("down"); }, 59_000);
  assert.equal(inside.koin, "100");
  const outside = await hold.run(KEY, async () => { throw new Error("down"); }, 61_000);
  assert.deepEqual(outside, { error: "down" });
});

test("recovery clears the stale flag", async () => {
  const hold = new LastGood();
  await hold.run(KEY, async () => ({ koin: "100" }), 0);
  await hold.run(KEY, async () => { throw new Error("down"); }, 10);
  const back = await hold.run(KEY, async () => ({ koin: "140" }), 20);
  assert.deepEqual(back, { koin: "140" });
});

test("each key is held independently", async () => {
  const hold = new LastGood();
  await hold.run("a", async () => ({ n: 1 }), 0);
  await hold.run("b", async () => ({ n: 2 }), 0);
  const a = await hold.run("a", async () => { throw new Error("x"); }, 1);
  assert.equal(a.n, 1);
  assert.equal(hold.get("b").n, 2);
});
