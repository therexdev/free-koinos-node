"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ChainService } = require("../electron/lib/chain");

const LOCAL = "http://127.0.0.1:8080";
const PUBLIC = "https://api.koinos.io";

function svc(overrides = {}, { localUp = false } = {}) {
  const data = { network: "mainnet", useLocalNodeRpc: true, customRpc: {}, ...overrides };
  const settings = {
    get: (k, d) => {
      const v = k.split(".").reduce((o, part) => (o == null ? o : o[part]), data);
      return v === undefined ? d : v;
    },
  };
  const c = new ChainService(settings);
  // Pin the health probe instead of touching the network.
  c._localNodeUsable = () => localUp;
  return c;
}

test("our own node leads once it is up and caught up", () => {
  const c = svc({}, { localUp: true });
  assert.deepEqual(c.rpcUrls(), [LOCAL, PUBLIC]);
  const st = c.rpcStatus();
  assert.equal(st.usingLocal, true);
  assert.equal(st.active, LOCAL);
  assert.deepEqual(st.fallbacks, [PUBLIC]); // public stays as the backstop
});

test("a node that is down or still syncing is not used", () => {
  const c = svc({}, { localUp: false });
  assert.deepEqual(c.rpcUrls(), [PUBLIC]);
  assert.equal(c.rpcStatus().usingLocal, false);
});

test("the preference can be switched off", () => {
  const c = svc({ useLocalNodeRpc: false }, { localUp: true });
  assert.deepEqual(c.rpcUrls(), [PUBLIC]);
  assert.equal(c.rpcStatus().preferLocal, false);
});

test("a custom RPC overrides everything, local included", () => {
  const c = svc({ customRpc: { mainnet: "https://rpc.example/x" } }, { localUp: true });
  assert.deepEqual(c.rpcUrls(), ["https://rpc.example/x"]);
  const st = c.rpcStatus();
  assert.equal(st.custom, "https://rpc.example/x");
  assert.equal(st.usingLocal, false);
});

test("harbinger, which has no public endpoint, still resolves to the local node", () => {
  const c = svc({ network: "harbinger" }, { localUp: false });
  assert.deepEqual(c.rpcUrls(), ["http://127.0.0.1:8081"]);
});

// ---------- failover ----------

test("a multi-endpoint provider rotates instead of aborting on the first error", () => {
  const c = svc({}, { localUp: true });
  const p = c.provider();
  assert.equal(p.rpcNodes.length, 2);
  // koilib's default onError aborts immediately; ours must survive one failure
  // (so a request in flight when our node dies lands on the public endpoint)
  // and then stop rather than loop forever.
  assert.equal(p.onError(new Error("ECONNREFUSED")), false); // try the next one
  assert.equal(p.onError(new Error("also down")), true);     // both gone -> give up
});

test("a single-endpoint provider keeps koilib's abort-on-error default", () => {
  const c = svc({}, { localUp: false });
  const p = c.provider();
  assert.equal(p.rpcNodes.length, 1);
  assert.equal(p.onError(new Error("boom")), true);
});
