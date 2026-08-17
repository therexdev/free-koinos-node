"use strict";

// Core-agent (Phase 3.1) — runs on a shared-core host and provisions/deprovisions
// per-user block producers on that core, on demand, via the Docker CLI.
//
// Each producer is its own koinos-block-producer container with its OWN
// self-generated signing key and its OWN --producer (reward) address, attached to
// the shared core's AMQP. The agent only ever reads a producer's PUBLIC key; the
// private key stays in the producer's basedir on the host. No user main key is
// ever involved.
//
// Free tier: there is no payment gate here. A thin control plane (accounts +
// PayPal billing, later) will sit in front and call this same API. For now the
// shared token is the only gate.
//
// Dependencies: none (Node 18+ built-ins + the `docker` CLI on PATH).

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");

// ---------- config (env) ----------
const TOKEN = process.env.AGENT_TOKEN || "";
const PORT = Number(process.env.AGENT_PORT || 3738);
const CORE_NETWORK = process.env.CORE_NETWORK || "koinos-core_default"; // docker network of the shared core
const CORE_AMQP = process.env.CORE_AMQP || "amqp://guest:guest@amqp:5672/";
const PRODUCER_IMAGE = process.env.PRODUCER_IMAGE || "koinos/koinos-block-producer:v1.3.1";
const PRODUCERS_DIR = process.env.PRODUCERS_DIR || "/opt/koinos-core/producers";
const PRODUCER_ALGO = process.env.PRODUCER_ALGO || "pob";
// On a real core the p2p service supplies gossip, so leave production gated on sync
// (true). For a local core with no p2p, set GOSSIP_PRODUCTION=false.
const GOSSIP_PRODUCTION = String(process.env.GOSSIP_PRODUCTION ?? "true") === "true";
const LOCAL_RPC = process.env.LOCAL_RPC || "http://127.0.0.1:8080/";
const NETWORK_RPC = process.env.NETWORK_RPC || "https://api.koinos.io/";

const NAME_PREFIX = "koinos-producer-";
const PUBKEY_TIMEOUT_MS = 45000;

// ---------- small helpers ----------
function sh(bin, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: opts.timeout ?? 30000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) =>
      resolve({
        ok: !error,
        stdout: String(stdout || "").trim(),
        stderr: String(stderr || "").trim(),
        error: error ? String(error.message).split("\n")[0] : null,
      })
    );
  });
}
const docker = (args, opts) => sh("docker", args, opts);

// Koinos base58 addresses start with 1; keep it strict to avoid junk (no shell is
// ever used, so this is validation, not injection defense).
function validAddress(a) {
  return typeof a === "string" && /^1[1-9A-HJ-NP-Za-km-z]{25,49}$/.test(a);
}
const containerName = (id) => NAME_PREFIX + id;
const basedirFor = (id) => path.join(PRODUCERS_DIR, id);

function readPubkey(id) {
  try {
    return fs.readFileSync(path.join(basedirFor(id), "block_producer", "public.key"), "utf8").trim() || null;
  } catch {
    return null;
  }
}
function readMeta(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(basedirFor(id), "meta.json"), "utf8"));
  } catch {
    return null;
  }
}
function writeMeta(id, meta) {
  fs.writeFileSync(path.join(basedirFor(id), "meta.json"), JSON.stringify(meta, null, 2));
}

async function containerState(id) {
  const r = await docker(["inspect", "-f", "{{.State.Status}}", containerName(id)], { timeout: 10000 });
  return r.ok ? r.stdout : null; // running | exited | null(=absent)
}

async function rpcHead(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "chain.get_head_info", params: {} }),
      signal: controller.signal,
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    return Number(d.result?.head_topology?.height ?? 0) || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- lifecycle ----------
async function provision({ producerAddress, id }) {
  if (!validAddress(producerAddress)) {
    const e = new Error("producerAddress must be a valid Koinos address (starts with 1)");
    e.status = 400;
    throw e;
  }
  id = id || crypto.randomUUID().slice(0, 8);
  const base = basedirFor(id);
  if (fs.existsSync(base)) {
    const e = new Error(`producer ${id} already exists`);
    e.status = 409;
    throw e;
  }
  fs.mkdirSync(path.join(base, "block_producer"), { recursive: true });
  writeMeta(id, { id, producerAddress, algorithm: PRODUCER_ALGO, createdAt: new Date().toISOString() });

  const args = [
    "run", "-d",
    "--name", containerName(id),
    "--restart", "always",
    "--network", CORE_NETWORK,
    "-v", `${base}:/koinos`,
    PRODUCER_IMAGE,
    "--basedir=/koinos",
    "-a", CORE_AMQP,
    "--algorithm", PRODUCER_ALGO,
    "--producer", producerAddress,
  ];
  if (!GOSSIP_PRODUCTION) args.push("--gossip-production", "false");

  const run = await docker(args, { timeout: 60000 });
  if (!run.ok) {
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
    const e = new Error(`docker run failed: ${run.stderr || run.error}`);
    e.status = 500;
    throw e;
  }

  // The container self-generates its signing key on first start and writes
  // public.key — wait for it so we can hand it back for registration.
  const deadline = Date.now() + PUBKEY_TIMEOUT_MS;
  let publicKey = null;
  while (Date.now() < deadline) {
    publicKey = readPubkey(id);
    if (publicKey) break;
    await new Promise((r) => setTimeout(r, 750));
  }
  return { id, producerAddress, publicKey, status: publicKey ? "running" : "starting", containerId: run.stdout.slice(0, 12) };
}

// Pause without losing the key: the container stops but its basedir (signing key)
// stays, so start() resumes the SAME registered key. This is the billing "grace"
// state (subscription lapsed → stop producing, keep the node reclaimable).
async function stopProducer(id) {
  if (!readMeta(id)) {
    const e = new Error(`producer ${id} not found`);
    e.status = 404;
    throw e;
  }
  const r = await docker(["stop", containerName(id)], { timeout: 30000 });
  if (!r.ok) {
    const e = new Error(`docker stop failed: ${r.stderr || r.error}`);
    e.status = 500;
    throw e;
  }
  return { id, stopped: true };
}

async function startProducer(id) {
  if (!readMeta(id)) {
    const e = new Error(`producer ${id} not found`);
    e.status = 404;
    throw e;
  }
  const r = await docker(["start", containerName(id)], { timeout: 30000 });
  if (!r.ok) {
    const e = new Error(`docker start failed: ${r.stderr || r.error}`);
    e.status = 500;
    throw e;
  }
  return { id, started: true, publicKey: readPubkey(id) };
}

// Full delete: remove the container AND wipe the basedir (and thus the signing
// key). After this the user must register a fresh key to run again.
async function deprovision(id) {
  if (!readMeta(id) && !fs.existsSync(basedirFor(id))) {
    const e = new Error(`producer ${id} not found`);
    e.status = 404;
    throw e;
  }
  await docker(["rm", "-f", containerName(id)], { timeout: 30000 });
  try { fs.rmSync(basedirFor(id), { recursive: true, force: true }); } catch {}
  return { id, removed: true };
}

function listIds() {
  try {
    return fs.readdirSync(PRODUCERS_DIR).filter((d) => fs.existsSync(path.join(PRODUCERS_DIR, d, "meta.json")));
  } catch {
    return [];
  }
}

async function producerStatus(id) {
  const meta = readMeta(id);
  if (!meta) {
    const e = new Error(`producer ${id} not found`);
    e.status = 404;
    throw e;
  }
  const state = await containerState(id);
  const publicKey = readPubkey(id);
  return {
    id,
    producerAddress: meta.producerAddress,
    algorithm: meta.algorithm,
    createdAt: meta.createdAt,
    containerState: state, // running | exited | null
    running: state === "running",
    publicKey,
    // "producing" means the container is up and has a key registered-able; whether
    // it wins slots also needs the user's VHP + registration (done from their phone).
    ready: state === "running" && !!publicKey,
  };
}

async function listProducers() {
  return Promise.all(listIds().map((id) => producerStatus(id)));
}

async function coreStatus() {
  const local = await rpcHead(LOCAL_RPC);
  const network = await rpcHead(NETWORK_RPC);
  const blocksBehind = local != null && network != null ? Math.max(0, network - local) : null;
  return {
    localHeight: local,
    networkHeight: network,
    blocksBehind,
    synced: blocksBehind != null ? blocksBehind <= 5 : null,
    producers: listIds().length,
  };
}

// ---------- HTTP ----------
function send(res, code, body) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}
function readJson(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve(null); }
    });
    req.on("error", () => resolve(null));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);

  // CORS so the browser front-end (served from another origin) can call the API.
  // The x-agent-token header is still required — the wildcard origin only allows
  // the request to be made, not to succeed without the token.
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Headers", "x-agent-token, content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });

  if (TOKEN && req.headers["x-agent-token"] !== TOKEN) return send(res, 401, { error: "unauthorized" });

  try {
    if (url.pathname === "/core" && req.method === "GET") {
      return send(res, 200, await coreStatus());
    }
    if (parts[0] === "producers") {
      if (parts.length === 1) {
        if (req.method === "GET") return send(res, 200, { producers: await listProducers() });
        if (req.method === "POST") {
          const body = await readJson(req);
          if (!body) return send(res, 400, { error: "invalid JSON body" });
          return send(res, 201, await provision(body));
        }
      }
      if (parts.length === 2) {
        const id = parts[1];
        if (req.method === "GET") return send(res, 200, await producerStatus(id));
        if (req.method === "DELETE") return send(res, 200, await deprovision(id));
      }
      if (parts.length === 3 && req.method === "POST") {
        const id = parts[1];
        if (parts[2] === "stop") return send(res, 200, await stopProducer(id));
        if (parts[2] === "start") return send(res, 200, await startProducer(id));
      }
    }
    return send(res, 404, { error: "not found" });
  } catch (e) {
    return send(res, e.status || 500, { error: String((e && e.message) || e) });
  }
});

if (require.main === module) {
  fs.mkdirSync(PRODUCERS_DIR, { recursive: true });
  server.listen(PORT, () =>
    console.log(`koinos core-agent on :${PORT} (network=${CORE_NETWORK}, image=${PRODUCER_IMAGE}, dir=${PRODUCERS_DIR})`)
  );
}

module.exports = { provision, stopProducer, startProducer, deprovision, listProducers, producerStatus, coreStatus, validAddress };
