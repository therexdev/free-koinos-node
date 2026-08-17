"use strict";

// Status agent for a cloud-hosted Koinos node (Phase 1 of the cloud-node service).
// Runs alongside the node on the VM and exposes a small, token-protected HTTP API
// so the control plane (and the phone app) can read the node's block-signing
// PUBLIC key (to register it) and monitor sync/production — without ever holding
// the user's main key. No dependencies; Node 18+ (built-in fetch).

const http = require("http");
const fs = require("fs");
const path = require("path");

const KOINOS_DIR = process.env.KOINOS_DIR || "/opt/koinos-node";
const TOKEN = process.env.AGENT_TOKEN || "";
const PORT = Number(process.env.AGENT_PORT || 3737);
const LOCAL_RPC = process.env.LOCAL_RPC || "http://127.0.0.1:8080/";
const NETWORK_RPC = process.env.NETWORK_RPC || "https://api.koinos.io/";
const PUBKEY_FILE = path.join(KOINOS_DIR, "basedir", "block_producer", "public.key");

async function rpcHead(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "chain.get_head_info", params: {} }),
      signal: controller.signal,
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message || "rpc error");
    return d.result; // { head_topology: { height, id }, head_block_time, last_irreversible_block }
  } finally {
    clearTimeout(timer);
  }
}

function readPublicKey() {
  try {
    return fs.readFileSync(PUBKEY_FILE, "utf8").trim() || null;
  } catch {
    return null; // not generated yet (node still starting)
  }
}

async function buildStatus() {
  const producerPublicKey = readPublicKey();
  let local = null;
  let running = false;
  try {
    const h = await rpcHead(LOCAL_RPC);
    local = { height: String(h.head_topology?.height ?? ""), headBlockTime: String(h.head_block_time ?? "") };
    running = true;
  } catch {
    running = false;
  }
  let network = null;
  try {
    const h = await rpcHead(NETWORK_RPC);
    network = { height: String(h.head_topology?.height ?? "") };
  } catch {
    /* network head unavailable — leave null */
  }
  let blocksBehind = null;
  let synced = null;
  if (local?.height && network?.height) {
    blocksBehind = Math.max(0, Number(network.height) - Number(local.height));
    synced = blocksBehind <= 5;
  }
  return {
    running,
    producing: !!producerPublicKey && running,
    producerPublicKey,
    local,
    network,
    blocksBehind,
    synced,
    ts: Date.now(),
  };
}

const server = http.createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  const url = new URL(req.url, "http://localhost");

  // Unauthenticated liveness probe.
  if (url.pathname === "/health") {
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  // Everything else requires the shared token.
  if (TOKEN && req.headers["x-agent-token"] !== TOKEN) {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  try {
    if (url.pathname === "/status") {
      res.end(JSON.stringify(await buildStatus()));
    } else if (url.pathname === "/pubkey") {
      res.end(JSON.stringify({ publicKey: readPublicKey() }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    }
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String((e && e.message) || e) }));
  }
});

server.listen(PORT, () => console.log(`koinos-agent listening on :${PORT} (node dir ${KOINOS_DIR})`));
