"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { fetchAiRoster, validateRosterUrl, extractAddresses } = require("../electron/lib/ai-roster");

// Stand-in for koilib's checksum check: our fixtures use "1<name>" addresses.
const isValidAddress = (a) => typeof a === "string" && /^1[A-Za-z0-9]{3,}$/.test(a);
const ok = (payload) => async () => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(payload),
});

// ---------- URL policy ----------

test("roster URL must be https, or http on loopback", () => {
  assert.equal(validateRosterUrl("https://kai.example/workers"), "https://kai.example/workers");
  assert.ok(validateRosterUrl("http://127.0.0.1:41100/workers").startsWith("http://127.0.0.1"));
  assert.ok(validateRosterUrl("http://localhost:41100/workers").startsWith("http://localhost"));
  // Plaintext to a remote host would be trivially spoofable — and this list
  // decides who gets paid.
  assert.throws(() => validateRosterUrl("http://kai.example/workers"), /https/);
  assert.throws(() => validateRosterUrl("ftp://kai.example/workers"), /https/);
  assert.throws(() => validateRosterUrl("nonsense"), /valid URL/);
  assert.throws(() => validateRosterUrl(""), /No Koinos AI Node roster URL/);
});

// ---------- payload shapes ----------

test("addresses are extracted from every plausible roster shape", () => {
  assert.deepEqual(extractAddresses(["1a", "1b"]), ["1a", "1b"]);
  assert.deepEqual(extractAddresses({ workers: [{ address: "1a" }, { address: "1b" }] }), ["1a", "1b"]);
  assert.deepEqual(extractAddresses({ addresses: ["1a"] }), ["1a"]);
  assert.deepEqual(extractAddresses({ nodes: [{ worker: "1a" }] }), ["1a"]);
  assert.deepEqual(extractAddresses({ values: ["1a"] }), ["1a"]);
  // An unrecognized shape yields nothing rather than throwing — upstream then
  // treats the cycle as unverified and fails closed.
  assert.deepEqual(extractAddresses({ something: "else" }), []);
  assert.deepEqual(extractAddresses(null), []);
});

// ---------- fetching ----------

test("fetch returns validated, de-duplicated addresses", async () => {
  const res = await fetchAiRoster("https://kai.example/workers", {
    isValidAddress,
    fetchImpl: ok({ workers: [{ address: "1aaa" }, { address: "1bbb" }, { address: "1aaa" }] }),
  });
  assert.deepEqual(res.addresses, ["1aaa", "1bbb"]);
  assert.ok(res.fetchedAt > 0);
});

test("entries that aren't valid Koinos addresses are dropped, not paid", async () => {
  const res = await fetchAiRoster("https://kai.example/workers", {
    isValidAddress,
    fetchImpl: ok(["1aaa", "0xdeadbeef", "", "not-an-address", { nope: 1 }]),
  });
  assert.deepEqual(res.addresses, ["1aaa"]);
  assert.equal(res.rejected, 2); // 0xdeadbeef + not-an-address
});

test("HTTP and JSON failures raise, so the cycle can fail closed", async () => {
  await assert.rejects(
    () => fetchAiRoster("https://kai.example/workers", {
      isValidAddress,
      fetchImpl: async () => ({ ok: false, status: 503, text: async () => "" }),
    }),
    /HTTP 503/
  );
  await assert.rejects(
    () => fetchAiRoster("https://kai.example/workers", {
      isValidAddress,
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => "<html>nope</html>" }),
    }),
    /did not return JSON/
  );
  await assert.rejects(
    () => fetchAiRoster("https://kai.example/workers", {
      isValidAddress,
      fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
    }),
    /Couldn't reach the AI node roster/
  );
});

test("a validator that throws is treated as a rejection, not a dead roster", async () => {
  // koilib's isChecksumAddress THROWS on a truncated address rather than
  // returning false. If that escaped, an all-truncated roster would look like
  // an unreachable endpoint instead of one returning unusable addresses — and
  // one junk entry would cost us the whole roster.
  const throwing = (a) => {
    if (a.includes("\u2026")) throw new Error("invalid character '\u2026'");
    return /^1[A-Za-z0-9]{3,}$/.test(a);
  };
  const res = await fetchAiRoster("https://kai.example/roster", {
    isValidAddress: throwing,
    fetchImpl: ok(["1good", "1HU2QZ\u2026zY2x", "1alsogood"]),
  });
  assert.deepEqual(res.addresses, ["1good", "1alsogood"]);
  assert.equal(res.rejected, 1);

  // The all-truncated case reports zero accepted with a rejection count, which
  // is exactly what the engine keys its "unusable addresses" hold on.
  const allBad = await fetchAiRoster("https://kai.example/roster", {
    isValidAddress: throwing,
    fetchImpl: ok(["1aaaaa\u2026wxyz", "1bbbbb\u2026wxyz"]),
  });
  assert.deepEqual(allBad.addresses, []);
  assert.equal(allBad.rejected, 2);
});

test("an oversized roster body is refused", async () => {
  const huge = JSON.stringify(Array.from({ length: 200000 }, (_, i) => `1addr${i}`));
  await assert.rejects(
    () => fetchAiRoster("https://kai.example/workers", {
      isValidAddress,
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => huge }),
    }),
    /too large/
  );
});
