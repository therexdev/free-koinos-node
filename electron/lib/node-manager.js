"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");
const { NETWORKS } = require("./constants");
const { parseSha256File, analyzeMembers, requiredSpace, fmtBytes } = require("./quicksync-utils");
const { httpHead, httpGetText, httpDownload } = require("./download");
const { assessHealth, describeRecovery, classifyCrash, isCrashLooping } = require("./node-health");

const OP_LOG_LIMIT = 400;
const ARCHIVE_NAME = "koinos-backup.tar.gz";

// ----- self-healing watchdog tuning -----
const WATCH_INTERVAL_MS = 45 * 1000; // how often we check the node's pulse
const WATCH_GRACE_MS = 2 * 60 * 1000; // ignore the first 2 min after start / a recovery (startup + resync)
const STALL_MS = 8 * 60 * 1000; // head height flat this long => chain wedged
const RECOVERY_WINDOW_MS = 30 * 60 * 1000; // window for counting recent auto-recoveries
const SAVER_AFTER_OOM = 2; // OOM-driven recoveries before switching to memory-saver
const CHRONIC_AFTER = 5; // low-memory recoveries in the window before we suggest the cloud
const REPAIR_AFTER = 3; // restarts that didn't stick before we call for a data repair
const MAX_BACKOFF_MS = 15 * 60 * 1000;

// Manages a per-network Koinos node directory containing the official
// docker-compose.yml plus generated .env and config files, and drives it
// through `docker compose`.
class NodeManager {
  constructor({ templateRoot, dataRoot, onEvent, autoRecover = true, probeHead = null }) {
    this.templateRoot = templateRoot;
    this.dataRoot = dataRoot;
    this.onEvent = onEvent || (() => {});
    this._composeCmd = null;
    this._op = null; // { name, network, running, startedAt, lines, code, error }
    // Self-healing: keep the node alive without the user ever touching Docker.
    this.autoRecover = autoRecover !== false;
    this.probeHead = probeHead; // async () => number|null  (local chain head height)
    this._desiredRunning = false; // is the node meant to be up right now?
    this._watch = null; // live watchdog state while the node runs
  }

  dirs(networkId) {
    const root = path.join(this.dataRoot, networkId);
    return {
      root,
      config: path.join(root, "config"),
      basedir: path.join(root, "basedir"),
      producerKeyDir: path.join(root, "basedir", "block_producer"),
    };
  }

  // ---------- file generation ----------

  ensureFiles(networkId, producerAddress, opts = {}) {
    const net = NETWORKS[networkId];
    if (!net) throw new Error(`Unknown network: ${networkId}`);
    const d = this.dirs(networkId);
    fs.mkdirSync(d.config, { recursive: true });
    fs.mkdirSync(d.basedir, { recursive: true });

    const tpl = (...p) => path.join(this.templateRoot, ...p);
    fs.copyFileSync(tpl("docker-compose.yml"), path.join(d.root, "docker-compose.yml"));
    fs.copyFileSync(tpl("common", "koinos_descriptors.pb"), path.join(d.config, "koinos_descriptors.pb"));
    fs.copyFileSync(tpl("common", "rabbitmq.conf"), path.join(d.config, "rabbitmq.conf"));
    fs.copyFileSync(tpl(net.templateDir, "genesis_data.json"), path.join(d.config, "genesis_data.json"));

    fs.writeFileSync(path.join(d.config, "config.yml"), buildConfigYml(net, producerAddress));
    fs.writeFileSync(path.join(d.root, ".env"), buildEnv(net, d.basedir, !!producerAddress, opts.memorySaver));
    return d;
  }

  filesReady(networkId) {
    const d = this.dirs(networkId);
    return (
      fs.existsSync(path.join(d.root, "docker-compose.yml")) &&
      fs.existsSync(path.join(d.config, "config.yml"))
    );
  }

  readProducerPublicKey(networkId) {
    try {
      const p = path.join(this.dirs(networkId).producerKeyDir, "public.key");
      const v = fs.readFileSync(p, "utf8").trim();
      return v || null;
    } catch {
      return null;
    }
  }

  // ---------- docker plumbing ----------

  _exec(bin, args, opts = {}) {
    return new Promise((resolve) => {
      execFile(
        bin,
        args,
        {
          timeout: opts.timeout ?? 30000,
          cwd: opts.cwd,
          maxBuffer: 8 * 1024 * 1024,
          env: process.env,
          windowsHide: true,
        },
        (error, stdout, stderr) =>
          resolve({
            ok: !error,
            stdout: String(stdout || ""),
            stderr: String(stderr || ""),
            error: error ? String(error.message).split("\n")[0] : null,
          })
      );
    });
  }

  async composeCmd() {
    if (this._composeCmd) return this._composeCmd;
    if ((await this._exec("docker", ["compose", "version"], { timeout: 15000 })).ok) {
      this._composeCmd = { bin: "docker", pre: ["compose"] };
    } else if ((await this._exec("docker-compose", ["version"], { timeout: 15000 })).ok) {
      this._composeCmd = { bin: "docker-compose", pre: [] };
    }
    return this._composeCmd;
  }

  async dockerInfo() {
    const info = await this._exec("docker", ["info", "--format", "{{.ServerVersion}}"], {
      timeout: 15000,
    });
    if (!info.ok) {
      const raw = `${info.stderr} ${info.error ?? ""}`.toLowerCase();
      const daemonDown = /connect|daemon|sock|pipe|permission|refused/.test(raw);
      const error = daemonDown
        ? "Docker is installed but the Docker engine isn't running (or isn't accessible). Start Docker and try again."
        : "Docker was not found. Install Docker Desktop (or Docker Engine + Compose).";
      return { ok: false, error };
    }
    if (!(await this.composeCmd())) {
      return { ok: false, error: "Docker Compose was not found (need `docker compose` v2 or `docker-compose`)." };
    }
    return { ok: true, serverVersion: info.stdout.trim() };
  }

  async _compose(networkId, args, opts = {}) {
    const cmd = await this.composeCmd();
    if (!cmd) throw new Error("Docker Compose not available");
    const net = NETWORKS[networkId];
    const d = this.dirs(networkId);
    return this._exec(cmd.bin, [...cmd.pre, "-p", net.composeProject, ...args], {
      cwd: d.root,
      ...opts,
    });
  }

  // Long-running compose command (up/down) with live output capture.
  async _composeOp(networkId, opName, args) {
    if (this._op?.running) {
      throw new Error(`Another node operation ("${this._op.name}") is still running`);
    }
    const cmd = await this.composeCmd();
    if (!cmd) throw new Error("Docker Compose not available");
    const net = NETWORKS[networkId];
    const d = this.dirs(networkId);
    const op = {
      name: opName,
      network: networkId,
      running: true,
      startedAt: Date.now(),
      finishedAt: null,
      lines: [],
      code: null,
      error: null,
    };
    this._op = op;
    const push = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        op.lines.push(t);
        if (op.lines.length > OP_LOG_LIMIT) op.lines.splice(0, op.lines.length - OP_LOG_LIMIT);
      }
    };
    this.onEvent({ type: "node", message: `${opName} started (${net.label})` });
    return new Promise((resolve) => {
      const child = spawn(cmd.bin, [...cmd.pre, "-p", net.composeProject, ...args], {
        cwd: d.root,
        env: process.env,
        windowsHide: true,
      });
      child.stdout.on("data", push);
      child.stderr.on("data", push);
      child.on("error", (e) => {
        op.running = false;
        op.finishedAt = Date.now();
        op.error = String(e.message);
        this.onEvent({ type: "node", level: "error", message: `${opName} failed: ${op.error}` });
        resolve(op);
      });
      child.on("close", (code) => {
        op.running = false;
        op.finishedAt = Date.now();
        op.code = code;
        if (code !== 0 && !op.error) {
          op.error = op.lines.slice(-3).join(" | ") || `exit code ${code}`;
        }
        this.onEvent({
          type: "node",
          level: code === 0 ? "info" : "error",
          message: code === 0 ? `${opName} finished` : `${opName} failed: ${op.error}`,
        });
        resolve(op);
      });
    });
  }

  // ---------- lifecycle ----------

  // producerAddress null -> sync-only node (no block_producer service).
  async start(networkId, producerAddress) {
    const memorySaver = this._watch?.memorySaver || false;
    this.ensureFiles(networkId, producerAddress, { memorySaver });
    this._desiredRunning = true;
    // Fire and forget; callers poll status() / currentOp().
    this._composeOp(networkId, "start", ["up", "-d", "--remove-orphans"]);
    this._startWatchdog(networkId, !!producerAddress, producerAddress || null, memorySaver);
    return { started: true };
  }

  async stop(networkId) {
    this._desiredRunning = false;
    this._stopWatchdog();
    if (!this.filesReady(networkId)) return { stopped: true, note: "Node was never started" };
    this._composeOp(networkId, "stop", ["down"]);
    return { stopping: true };
  }

  // ---------- self-healing watchdog ----------
  //
  // While the node is meant to be up, poll its pulse every WATCH_INTERVAL_MS. If
  // a core service is crash-looping (e.g. block_store OOM-killed) or the chain
  // wedges, restart the whole stack automatically and tell the user in one plain
  // sentence. Repeated low-memory crashes flip on memory-saver mode (a lighter
  // footprint) so it stops happening. The user never runs a command.

  setAutoRecover(on) {
    this.autoRecover = !!on;
    return this.autoRecover;
  }

  _startWatchdog(networkId, producing, producerAddress, memorySaver) {
    this._stopWatchdog();
    const now = Date.now();
    const w = {
      networkId,
      producing: !!producing,
      producerAddress: producerAddress || null,
      memorySaver: !!memorySaver,
      lastHeight: null,
      lastHeightAt: now,
      graceUntil: now + WATCH_GRACE_MS,
      recoveries: [], // timestamps of recent auto-recoveries
      oomHits: 0,
      recovering: false,
      warnedChronic: false,
      needsRepair: false, // corrupted block data — a restart can't fix it
      repairReason: null,
      health: { ok: true, reason: "starting" },
      timer: null,
    };
    w.timer = setInterval(() => this._watchTick().catch(() => {}), WATCH_INTERVAL_MS);
    if (w.timer.unref) w.timer.unref();
    this._watch = w;
  }

  _stopWatchdog() {
    if (this._watch?.timer) clearInterval(this._watch.timer);
    this._watch = null;
  }

  async _watchTick() {
    const w = this._watch;
    if (!w || w.recovering || !this._desiredRunning) return;
    if (this._op?.running) return; // a start/stop/quick-sync is already driving the stack

    const services = await this.services(w.networkId).catch(() => []);
    let headHeight = null;
    if (this.probeHead) headHeight = await this.probeHead().catch(() => null);

    const now = Date.now();
    if (headHeight != null && (w.lastHeight == null || Number(headHeight) > Number(w.lastHeight))) {
      w.lastHeight = headHeight;
      w.lastHeightAt = now;
    }
    // Grace window: don't judge a node that's still starting up or resyncing.
    if (now < w.graceUntil) {
      w.health = { ok: true, reason: "starting" };
      return;
    }

    const health = assessHealth({
      services,
      producing: w.producing,
      headHeight,
      lastHeight: w.lastHeight,
      lastHeightAt: w.lastHeightAt,
      now,
      stallMs: STALL_MS,
    });
    w.health = health;
    // Once we've concluded the block data is corrupted, stop restarting into the
    // same wall — wait for the user to repair (Quick Sync).
    if (!health.ok && health.reason !== "no-data" && this.autoRecover && !w.needsRepair) {
      await this._recover(w, health);
    }
  }

  async _recover(w, health) {
    if (!this._desiredRunning || this._watch !== w) return;
    w.recovering = true;

    // Diagnose the crashing service before blindly restarting. A restart fixes
    // transient failures and (with memory-saver) low-memory kills — but NOT a
    // code panic (segfault/nil-pointer) or corrupted on-disk data, which just
    // reproduce the crash. Those need the block data rebuilt (Quick Sync).
    let crash = null;
    let logText = "";
    try {
      logText = await this.logs(w.networkId, health.service || "block_store", 80).catch(() => "");
      crash = classifyCrash(logText);
    } catch {
      /* diagnosis is best-effort */
    }

    const now = Date.now();
    w.recoveries = w.recoveries.filter((t) => now - t < RECOVERY_WINDOW_MS);
    const recent = w.recoveries.length;

    const memoryTrouble = crash === "oom" || health.oom || health.reason === "oom";
    const dataCrash = crash === "panic" || crash === "corruption";
    const looping = isCrashLooping(logText);

    // Corrupted/panicking block data, or restarts that plainly aren't sticking:
    // stop the futile loop and call for a one-click repair instead.
    if ((dataCrash && (looping || recent >= 1)) || (recent >= REPAIR_AFTER && !memoryTrouble)) {
      w.needsRepair = true;
      w.repairReason = dataCrash ? crash : "restart-loop";
      w.recovering = false;
      this.onEvent({
        type: "node",
        level: "warn",
        message:
          "Your node's block data looks corrupted — restarting can't fix it. Open the Node tab and click “Repair node data” to rebuild it from a verified snapshot (a few minutes; your wallet and keys are untouched).",
      });
      return;
    }

    // Repeated low-memory crashes -> switch to a lighter footprint for good.
    let switchedSaver = false;
    if (memoryTrouble && !w.memorySaver) {
      w.oomHits += 1;
      if (w.oomHits >= SAVER_AFTER_OOM) {
        w.memorySaver = true;
        switchedSaver = true;
      }
    }

    this.onEvent({
      type: "node",
      message: switchedSaver
        ? "Your PC was running low on memory, so the app switched your node to a lighter mode and is restarting it. It'll keep running on its own."
        : `${describeRecovery(health.reason, health.oom)} Restarting it for you — you don't need to do anything.`,
    });

    try {
      const ok = await this._restartStack(w);
      if (ok) {
        w.recoveries.push(Date.now());
        this.onEvent({ type: "node", message: "Your node is back up and running." });
      }
    } catch (e) {
      this.onEvent({
        type: "node",
        level: "error",
        message: "The app couldn't restart your node just now — it will try again in a minute.",
      });
    }

    // Chronic low-memory trouble even after memory-saver: point at the cloud, once.
    w.recoveries = w.recoveries.filter((t) => Date.now() - t < RECOVERY_WINDOW_MS);
    if (memoryTrouble && w.recoveries.length >= CHRONIC_AFTER && !w.warnedChronic) {
      w.warnedChronic = true;
      this.onEvent({
        type: "node",
        level: "warn",
        message:
          "Your node keeps running low on memory on this PC. The app will keep restarting it for you, but for reliable 24/7 uptime you may want to run it in the cloud.",
      });
    }

    // Back off (grows with how often we've had to step in) so we never thrash,
    // and give the fresh stack time to resync before judging it again.
    const backoff = Math.min(MAX_BACKOFF_MS, WATCH_GRACE_MS * 2 ** Math.min(recent, 3));
    w.lastHeight = null;
    w.lastHeightAt = Date.now();
    w.graceUntil = Date.now() + backoff;
    w.recovering = false;
  }

  // Full-stack restart used by the watchdog. Regenerates .env (so memory-saver
  // profiles take effect) and cycles compose down/up. Guards against a user Stop
  // landing mid-recovery.
  async _restartStack(w) {
    this.ensureFiles(w.networkId, w.producerAddress, { memorySaver: w.memorySaver });
    await this._compose(w.networkId, ["down", "--remove-orphans"], { timeout: 180000 });
    if (this._watch !== w || !this._desiredRunning) return false;
    const up = await this._compose(w.networkId, ["up", "-d", "--remove-orphans"], { timeout: 300000 });
    if (!up.ok) throw new Error(up.error || up.stderr?.slice(-200) || "compose up failed");
    return true;
  }

  currentOp() {
    if (!this._op) return null;
    const { lines, ...rest } = this._op;
    return { ...rest, tail: lines.slice(-15) };
  }

  // ---------- quick sync (restore from the official chain backup) ----------

  restoreDir(networkId) {
    return path.join(this.dirs(networkId).root, "restore");
  }

  async quickSyncInfo(networkId) {
    const net = NETWORKS[networkId];
    if (!net?.backup) throw new Error("Quick sync is only available on mainnet");
    const head = await httpHead(net.backup.url);
    let freeBytes = null;
    try {
      fs.mkdirSync(this.dataRoot, { recursive: true });
      const s = fs.statfsSync(this.dataRoot);
      freeBytes = Number(s.bavail) * Number(s.bsize);
    } catch {
      /* stat not available on this platform */
    }
    let metadata = null;
    try {
      metadata = (await httpGetText(net.backup.metadataUrl)).slice(0, 1500);
    } catch {
      /* metadata is informative only */
    }
    let resumeFrom = 0;
    try {
      resumeFrom = fs.statSync(path.join(this.restoreDir(networkId), ARCHIVE_NAME)).size;
    } catch {
      /* no partial download */
    }
    const services = await this.services(networkId).catch(() => []);
    return {
      archiveBytes: head.size,
      lastModified: head.lastModified,
      resumeFrom,
      freeBytes,
      requiredBytes: requiredSpace(head.size),
      metadata,
      nodeRunning: services.some((s) => /running|up/i.test(s.state)),
    };
  }

  // Fire-and-forget; progress is exposed through currentOp() like start/stop.
  async quickSync(networkId) {
    const net = NETWORKS[networkId];
    if (!net?.backup) throw new Error("Quick sync is only available on mainnet");
    if (this._op?.running) {
      throw new Error(`Another node operation ("${this._op.name}") is still running`);
    }
    // Quick sync stops the node and leaves it stopped; stand the watchdog down so
    // it doesn't fight the restore.
    this._desiredRunning = false;
    this._stopWatchdog();
    const op = {
      name: "quick-sync",
      network: networkId,
      running: true,
      startedAt: Date.now(),
      finishedAt: null,
      lines: [],
      code: null,
      error: null,
      progress: { stage: "starting", pct: null },
    };
    this._op = op;
    this._qsAbort = new AbortController();
    this._runQuickSync(networkId, net, op)
      .then(() => {
        op.running = false;
        op.finishedAt = Date.now();
        op.code = 0;
        this.onEvent({
          type: "node",
          message: "Quick sync complete — chain data restored from backup. Start the node to catch up to head.",
        });
      })
      .catch((e) => {
        op.running = false;
        op.finishedAt = Date.now();
        op.code = 1;
        op.error = String(e?.message ?? e);
        this.onEvent({ type: "node", level: "error", message: `Quick sync failed: ${op.error}` });
      });
    return { started: true };
  }

  cancelQuickSync() {
    if (this._op?.name === "quick-sync" && this._op.running) {
      this._qsAbort?.abort();
      return { cancelling: true };
    }
    return { cancelling: false };
  }

  async _runQuickSync(networkId, net, op) {
    const signal = this._qsAbort.signal;
    const say = (stage, line, pct = null, extra = {}) => {
      op.progress = { stage, pct, ...extra };
      if (line) {
        op.lines.push(line);
        if (op.lines.length > OP_LOG_LIMIT) op.lines.splice(0, op.lines.length - OP_LOG_LIMIT);
      }
      if (signal.aborted) throw new Error("Cancelled");
    };
    const d = this.dirs(networkId);
    const restoreDir = this.restoreDir(networkId);
    const archivePath = path.join(restoreDir, ARCHIVE_NAME);
    const stagingDir = path.join(restoreDir, "extracted");
    fs.mkdirSync(restoreDir, { recursive: true });
    fs.mkdirSync(d.basedir, { recursive: true }); // never touches config/.env — a producer setup stays intact

    // 1. Stop the node if it's running.
    say("stopping", "Stopping the node (if running)…");
    const running = (await this.services(networkId).catch(() => [])).some((s) =>
      /running|up/i.test(s.state)
    );
    if (running) {
      const r = await this._compose(networkId, ["stop"], { timeout: 180000 });
      if (!r.ok) throw new Error(`Could not stop the node: ${r.error}`);
      say("stopping", "Node stopped.");
    }

    // 2. Download checksum + archive (with resume).
    say("download", "Fetching published checksum…");
    const publishedSha = parseSha256File(await httpGetText(net.backup.sha256Url));
    const head = await httpHead(net.backup.url);
    let from = 0;
    try {
      const st = fs.statSync(archivePath);
      // Resume only when the remote file is unchanged and we have less than all of it.
      const marker = readJson(path.join(restoreDir, "download.json"));
      if (marker?.etag === head.etag && st.size <= head.size) {
        from = st.size;
      } else {
        fs.rmSync(archivePath, { force: true });
      }
    } catch {
      /* no partial file */
    }
    writeJson(path.join(restoreDir, "download.json"), { etag: head.etag, size: head.size });
    if (from < head.size) {
      say("download", from > 0
        ? `Resuming download at ${fmtBytes(from)} of ${fmtBytes(head.size)}…`
        : `Downloading chain backup (${fmtBytes(head.size)}) — this is a large file…`);
      await httpDownload(net.backup.url, archivePath, {
        resumeFrom: from,
        signal,
        onProgress: (done, total) => {
          op.progress = {
            stage: "download",
            pct: (done / total) * 100,
            doneBytes: done,
            totalBytes: total,
          };
        },
      });
    }
    say("download", "Download complete.");

    // 3. Verify the checksum.
    say("verify", "Verifying SHA-256 checksum (reads the whole archive)…");
    const actualSha = await sha256File(archivePath, (done, total) => {
      op.progress = { stage: "verify", pct: (done / total) * 100 };
      if (signal.aborted) throw new Error("Cancelled");
    });
    if (actualSha !== publishedSha) {
      fs.rmSync(archivePath, { force: true });
      throw new Error("Checksum mismatch — the downloaded backup was corrupt and has been deleted. Run quick sync again.");
    }
    say("verify", "Checksum OK.");

    // 4. List members and validate the layout (never extract blindly).
    say("inspect", "Inspecting archive contents (decompresses once, takes a while)…");
    const list = await this._exec("tar", ["-tzf", archivePath], {
      timeout: 3 * 3600 * 1000,
      maxBuffer: 128 * 1024 * 1024,
    });
    if (!list.ok) throw new Error(`Could not list the archive: ${list.error}`);
    const layout = analyzeMembers(list.stdout);
    if (!layout.ok) {
      throw new Error(`${layout.error}. The published backup layout changed — restore manually per docs.koinos.io.`);
    }
    say("inspect", `Archive layout OK (prefix "${layout.prefix || "(none)"}").`);

    // 5. Extract only chain/ and block_store/ into staging.
    say("extract", "Extracting chain and block_store (can take a long time)…");
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.mkdirSync(stagingDir, { recursive: true });
    const ex = await this._exec(
      "tar",
      ["-xzf", archivePath, "-C", stagingDir, `${layout.prefix}chain`, `${layout.prefix}block_store`],
      { timeout: 6 * 3600 * 1000, maxBuffer: 16 * 1024 * 1024 }
    );
    if (!ex.ok) throw new Error(`Extraction failed: ${ex.error} ${ex.stderr.slice(-300)}`);
    const stagedChain = path.join(stagingDir, ...`${layout.prefix}chain`.split("/").filter(Boolean));
    const stagedBlockStore = path.join(stagingDir, ...`${layout.prefix}block_store`.split("/").filter(Boolean));
    if (!fs.existsSync(stagedChain) || !fs.existsSync(stagedBlockStore)) {
      throw new Error("Extraction finished but chain/ or block_store/ is missing from staging");
    }

    // 6. Move current state aside (rollback dir), then install the staged data.
    // p2p identity, config, .env and wallets are never touched.
    say("install", "Installing restored chain data…");
    const rollback = path.join(restoreDir, `previous-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    fs.mkdirSync(rollback, { recursive: true });
    for (const dir of ["chain", "block_store", "mempool", "transaction_store", "account_history", "contract_meta_store"]) {
      const src = path.join(d.basedir, dir);
      if (fs.existsSync(src)) fs.renameSync(src, path.join(rollback, dir));
    }
    fs.renameSync(stagedChain, path.join(d.basedir, "chain"));
    fs.renameSync(stagedBlockStore, path.join(d.basedir, "block_store"));

    // 7. Clean up what's no longer needed (keep the rollback copy).
    say("cleanup", "Cleaning up download and staging files…");
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.rmSync(archivePath, { force: true });
    fs.rmSync(path.join(restoreDir, "download.json"), { force: true });
    say("done", `Done. Previous state kept in ${rollback} — delete it once the node runs fine.`, 100);
  }

  async services(networkId) {
    if (!this.filesReady(networkId)) return [];
    const r = await this._compose(networkId, ["ps", "--format", "json"], { timeout: 20000 });
    if (!r.ok) return [];
    return parseComposePs(r.stdout);
  }

  async logs(networkId, service, tail = 120) {
    const args = ["logs", "--no-color", "--tail", String(Math.min(Number(tail) || 120, 1000))];
    if (service) args.push(String(service));
    const r = await this._compose(networkId, args, { timeout: 25000 });
    if (!r.ok) throw new Error(r.error || "Failed to read logs");
    return (r.stdout + (r.stderr ? `\n${r.stderr}` : "")).trim();
  }

  async status(networkId) {
    const docker = await this.dockerInfo();
    const services = docker.ok ? await this.services(networkId) : [];
    const running = services.filter((s) => /running|up/i.test(s.state)).length;
    const w = this._watch;
    return {
      docker,
      filesReady: this.filesReady(networkId),
      services,
      runningCount: running,
      isRunning: running > 0,
      producerPublicKey: this.readProducerPublicKey(networkId),
      op: this.currentOp(),
      dataDir: this.dirs(networkId).root,
      autoRecover: this.autoRecover,
      memorySaver: w?.memorySaver || false,
      health: w
        ? {
            ok: w.health?.ok !== false && !w.needsRepair,
            reason: w.needsRepair ? "needs-repair" : w.health?.reason || null,
            recovering: !!w.recovering,
            memorySaver: !!w.memorySaver,
            needsRepair: !!w.needsRepair,
            repairReason: w.repairReason || null,
            recoveries: w.recoveries?.length || 0,
            lastRecoveryAt: w.recoveries?.length ? w.recoveries[w.recoveries.length - 1] : null,
          }
        : null,
    };
  }
}

// ---------- local helpers ----------

function sha256File(filePath, onProgress) {
  return new Promise((resolve, reject) => {
    const total = fs.statSync(filePath).size;
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    let done = 0;
    let lastTick = 0;
    stream.on("data", (chunk) => {
      hash.update(chunk);
      done += chunk.length;
      const now = Date.now();
      if (onProgress && now - lastTick > 500) {
        lastTick = now;
        try {
          onProgress(done, total);
        } catch (e) {
          stream.destroy(e);
        }
      }
    });
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(p, v) {
  fs.writeFileSync(p, JSON.stringify(v));
}

function parseComposePs(stdout) {
  const rows = [];
  const text = stdout.trim();
  if (!text) return rows;
  // docker compose v2 emits one JSON object per line; older versions emit an array.
  let objects = [];
  try {
    const parsed = JSON.parse(text);
    objects = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    for (const line of text.split("\n")) {
      try {
        objects.push(JSON.parse(line));
      } catch {
        /* skip non-JSON lines */
      }
    }
  }
  for (const o of objects) {
    rows.push({
      name: o.Name ?? o.name ?? "",
      service: o.Service ?? o.service ?? "",
      state: o.State ?? o.state ?? "",
      status: o.Status ?? o.status ?? "",
      health: o.Health ?? o.health ?? "",
    });
  }
  return rows;
}

function buildEnv(net, basedirAbs, producing, memorySaver) {
  // Memory-saver drops the optional API tier (jsonrpc/grpc/rest/…) so a
  // low-memory PC only runs the core services (+ the block producer if minting),
  // which is what keeps a small machine from running out of memory.
  //
  // account_history rides with jsonrpc in normal mode: it is what serves block
  // reward/burn history, so running it makes this node self-sufficient — the
  // dashboard, reward returns and community distribution all work off our own
  // chain data instead of depending on a public endpoint being up. It indexes
  // forward from when it first runs, so it is NOT a backfill of old history.
  const profiles = memorySaver
    ? producing
      ? "block_producer"
      : ""
    : producing
    ? "jsonrpc,account_history,block_producer"
    : "jsonrpc,account_history";
  const lines = [
    "# Generated by Free Koinos Node — regenerated on every node start.",
    `BASEDIR=${basedirAbs}`,
    "",
    `AMQP_PORT=${net.ports.amqp}`,
    `AMQP_ADMIN_PORT=${net.ports.amqpAdmin}`,
    `P2P_PORT=${net.ports.p2p}`,
    `JSONRPC_PORT=${net.ports.jsonrpc}`,
    `GRPC_PORT=${net.ports.grpc}`,
    `REST_PORT=${net.ports.rest}`,
    "",
    `COMPOSE_PROFILES=${profiles}`,
    "",
    ...Object.entries(net.imageTags).map(([k, v]) => `${k}=${v}`),
    "",
  ];
  return lines.join("\n");
}

function buildConfigYml(net, producerAddress) {
  const producerLines = producerAddress
    ? `  producer: ${producerAddress}                # Address that receives block rewards (this app's wallet)`
    : `  # producer:                                 # Set automatically when block production is enabled`;
  const seeds = net.p2pSeeds.map((s) => `    - ${s}`).join("\n");
  return `# Generated by Free Koinos Node — based on koinos/koinos config-example.
# Regenerated on every node start; manual edits will be overwritten.

global:
  amqp: amqp://guest:guest@amqp:5672/
  log-level: info
  log-color: false
  log-datetime: true
  log-dir: logs
  instance-id: KoinosDesktop
  fork-algorithm: pob
  blacklist:
    - block_store.add_block
    - chain.propose_block

block_producer:
  algorithm: pob
${producerLines}

grpc:
  endpoint: 0.0.0.0:50051

jsonrpc:
  listen: /tcp/8080

p2p:
  listen: /ip4/0.0.0.0/tcp/8888
  peer:
${seeds}
`;
}

module.exports = { NodeManager, buildEnv, buildConfigYml, parseComposePs };
