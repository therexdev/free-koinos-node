"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { corsOrigin, applyCors, checkAuth } = require("../onramp-endpoint/lib/guard.cjs");

function fakeRes() {
  const headers = {};
  return { headers, setHeader: (k, v) => (headers[k] = v) };
}

test("never emits a wildcard Access-Control-Allow-Origin", () => {
  assert.equal(corsOrigin("*"), null);
  assert.equal(corsOrigin(""), null);
  assert.equal(corsOrigin(undefined), null);
  assert.equal(corsOrigin("  *  "), null);

  for (const allow of [undefined, "", "*"]) {
    const res = fakeRes();
    applyCors(res, allow);
    assert.deepEqual(res.headers, {}, `ALLOW_ORIGIN=${JSON.stringify(allow)} must emit no CORS headers`);
  }
});

test("emits an explicitly configured origin, with Vary", () => {
  const res = fakeRes();
  applyCors(res, "https://example.com", { methods: "GET, POST, OPTIONS" });
  assert.equal(res.headers["Access-Control-Allow-Origin"], "https://example.com");
  assert.equal(res.headers["Vary"], "Origin");
  assert.equal(res.headers["Access-Control-Allow-Methods"], "GET, POST, OPTIONS");
});

test("auth fails closed when no shared secret is configured", () => {
  const v = checkAuth({ headers: { "x-koinoskit-app": "anything" } }, "");
  assert.equal(v.ok, false);
  assert.equal(v.status, 500);
  assert.match(v.error, /ONRAMP_SHARED_SECRET/);
});

test("rejects a missing or wrong app key", () => {
  assert.equal(checkAuth({ headers: {} }, "s3cret").status, 401);
  assert.equal(checkAuth({ headers: { "x-koinoskit-app": "wrong" } }, "s3cret").status, 401);
  assert.equal(checkAuth({ headers: { "x-koinoskit-app": "" } }, "s3cret").status, 401);
});

test("accepts the correct app key", () => {
  assert.deepEqual(checkAuth({ headers: { "x-koinoskit-app": "s3cret" } }, "s3cret"), { ok: true });
});
