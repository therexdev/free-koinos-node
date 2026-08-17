"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile, spawn } = require("child_process");
const { httpDownload } = require("./download");
const { computeSetupPlan, dockerAsset, DOCKER_DOCS, WSL_INSTALL_ARGS } = require("./setup-plan");
const { recommendWslMemory, mergeWslConfig } = require("./node-health");

// Windows console tools like wsl.exe emit UTF-16LE. Decoding those bytes as
// UTF-8 (Node's default) leaves a NUL between every character — so a naive
// /wsl/.test(stdout) silently fails on "W\0S\0L\0…", which made post-reboot WSL
// detection always fail and the guided setup loop forever on "Restart Windows".
// Detect UTF-16LE by its NUL density, decode accordingly, and drop stray NULs
// and a leading BOM (compared by code point so no control chars live in source).
function decodeWinText(buf) {
  if (!buf || !buf.length) return "";
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf));
  let nul = 0;
  const n = Math.min(b.length, 512);
  for (let i = 0; i < n; i++) if (b[i] === 0) nul++;
  const text = nul > n / 4 ? b.toString("utf16le") : b.toString("utf8");
  let out = "";
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (c === 0 || c === 0xfeff) continue; // NUL or BOM
    out += ch;
  }
  return out;
}

// Automates the Windows/macOS prerequisites (WSL 2 + Docker Desktop) so the
// user never has to open a terminal or hunt for a download. Detection is
// best-effort; every action degrades to a clear message if the platform
// doesn't cooperate.
class SetupService {
  constructor({ platform, arch, downloadDir, state, onEvent }) {
    this.platform = platform || process.platform;
    this.arch = arch || process.arch;
    this.downloadDir = downloadDir;
    this.state = state;
    this.onEvent = onEvent || (() => {});
    this._op = null;
    this._abort = null;
    this._cliPath = null; // memoized docker CLI location
  }

  // Captures stdout/stderr as raw Buffers (so callers can decode UTF-16LE from
  // Windows tools) while still exposing UTF-8 strings for the common case.
  _exec(bin, args, opts = {}) {
    return new Promise((resolve) => {
      execFile(
        bin,
        args,
        {
          timeout: opts.timeout ?? 15000,
          windowsHide: true,
          env: process.env,
          encoding: "buffer",
          maxBuffer: 4 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          const outBuf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || "");
          const errBuf = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr || "");
          resolve({
            ok: !error,
            code: error?.code,
            stdout: outBuf.toString("utf8"),
            stderr: errBuf.toString("utf8"),
            stdoutRaw: outBuf,
            stderrRaw: errBuf,
          });
        }
      );
    });
  }

  // ---------- detection ----------

  async detectWsl() {
    if (this.platform !== "win32") return { installed: true, rebootPending: false };

    // Manual escape hatch: the user asserted WSL is set up. Used when
    // auto-detection can't confirm it on an unusual build.
    if (this.state?.get("setup.wslOverride", false)) {
      if (this.state?.get("setup.wslRebootPending", false)) {
        this.state.set("setup.wslRebootPending", false);
      }
      return { installed: true, rebootPending: false, overridden: true };
    }

    const rebootWasPending = !!this.state?.get("setup.wslRebootPending", false);

    // `wsl --version` succeeds on modern WSL 2; decode UTF-16LE before matching.
    const ver = await this._exec("wsl.exe", ["--version"], { timeout: 12000 });
    let installed = ver.ok && /wsl/i.test(decodeWinText(ver.stdoutRaw));

    // Fallback: `wsl --status` also confirms WSL is present (covers builds where
    // --version output or locale differs). This is the signal that flips the
    // reboot step to done once the machine comes back up.
    if (!installed) {
      const st = await this._exec("wsl.exe", ["--status"], { timeout: 12000 });
      const txt = decodeWinText(st.stdoutRaw);
      if (st.ok && /(default version|wsl|linux kernel|kernel version)/i.test(txt)) {
        installed = true;
      }
    }

    const rebootPending = !installed && rebootWasPending;
    if (installed && rebootWasPending) this.state?.set("setup.wslRebootPending", false);
    return { installed, rebootPending };
  }

  // Full paths to the docker CLI. A freshly installed Docker Desktop is NOT on
  // the running app's PATH (Windows snapshots env at launch), so relying on the
  // bare `docker` command makes detection fail until the app restarts — we probe
  // the known install locations directly instead.
  _dockerCliCandidates() {
    if (this.platform === "win32") {
      const pf = process.env["ProgramFiles"] || "C:\\Program Files";
      const pf64 = process.env["ProgramW6432"] || pf;
      const local = process.env["LOCALAPPDATA"] || "";
      const rel = "Docker\\Docker\\resources\\bin\\docker.exe";
      const list = [path.join(pf, rel), path.join(pf64, rel)];
      if (local) list.push(path.join(local, rel));
      return list;
    }
    if (this.platform === "darwin") {
      return [
        "/usr/local/bin/docker",
        "/opt/homebrew/bin/docker",
        "/Applications/Docker.app/Contents/Resources/bin/docker",
      ];
    }
    return ["/usr/bin/docker", "/usr/local/bin/docker"];
  }

  // Resolve a working docker CLI: PATH first, then known full paths that exist on
  // disk. Memoized, and re-validated each call so an uninstall is noticed.
  async _dockerCli() {
    const works = async (bin) => (await this._exec(bin, ["--version"], { timeout: 12000 })).ok;
    if (this._cliPath && (await works(this._cliPath))) return this._cliPath;
    if (await works("docker")) return (this._cliPath = "docker");
    for (const p of this._dockerCliCandidates()) {
      try {
        if (fs.existsSync(p) && (await works(p))) return (this._cliPath = p);
      } catch {
        /* ignore */
      }
    }
    this._cliPath = null;
    return null;
  }

  _dockerAppInstalled() {
    try {
      if (this.platform === "win32") {
        const pf = process.env["ProgramFiles"] || "C:\\Program Files";
        const pf64 = process.env["ProgramW6432"] || pf;
        const local = process.env["LOCALAPPDATA"] || "";
        const rel = "Docker\\Docker\\Docker Desktop.exe";
        const candidates = [path.join(pf, rel), path.join(pf64, rel)];
        if (local) candidates.push(path.join(local, "Programs", rel)); // per-user install
        return candidates.find((p) => fs.existsSync(p)) || null;
      }
      if (this.platform === "darwin") {
        return fs.existsSync("/Applications/Docker.app") ? "/Applications/Docker.app" : null;
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  async detectDocker() {
    const cli = await this._dockerCli();
    const appPath = this._dockerAppInstalled();
    // "Installed" if we found a working CLI, the Docker Desktop app bundle, or a
    // docker binary on disk (covers the stale-PATH window right after install).
    const cliOnDisk = this._dockerCliCandidates().some((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    });
    const installed = !!cli || !!appPath || cliOnDisk;
    let running = false;
    if (cli) {
      const info = await this._exec(cli, ["info", "--format", "{{.ServerVersion}}"], { timeout: 15000 });
      running = info.ok && info.stdout.trim().length > 0;
    }
    return { installed, running, appPath, cli: cli || null };
  }

  async status() {
    const [wsl, docker] = await Promise.all([this.detectWsl(), this.detectDocker()]);
    const plan = computeSetupPlan({ platform: this.platform, wsl, docker });
    return { platform: this.platform, wsl, docker, ...plan, op: this.currentOp() };
  }

  currentOp() {
    if (!this._op) return null;
    const { lines, ...rest } = this._op;
    return { ...rest, tail: (lines || []).slice(-4) };
  }

  // ---------- actions ----------

  async installWsl() {
    if (this.platform !== "win32") throw new Error("WSL is only needed on Windows");
    // Launch `wsl --install --no-distribution` elevated via a UAC prompt. The
    // elevated install runs in its own window; we detect completion by
    // re-checking `wsl --version`, and flag that a reboot is expected.
    const psCommand =
      `Start-Process -FilePath 'wsl.exe' -ArgumentList ` +
      WSL_INSTALL_ARGS.map((a) => `'${a}'`).join(",") +
      ` -Verb RunAs`;
    const r = await this._exec(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psCommand],
      { timeout: 120000 }
    );
    if (!r.ok) {
      // Non-zero here almost always means the UAC prompt was declined.
      throw new Error("Windows permission was declined, so WSL wasn't installed. Click Enable WSL and choose Yes.");
    }
    // A fresh install supersedes any earlier manual override.
    this.state?.set("setup.wslOverride", false);
    this.state?.set("setup.wslRebootPending", true);
    this.onEvent({
      type: "setup",
      message: "Installing WSL 2 — follow the Windows window, then restart your PC when it finishes.",
    });
    return { started: true, rebootExpected: true };
  }

  // User-driven escape hatch for the reboot step: re-detect first (the normal
  // post-reboot case now that UTF-16LE output is handled), and only fall back to
  // a forced override when detection genuinely can't confirm WSL on this build.
  async markWslReady() {
    if (this.platform !== "win32") return { installed: true, overridden: false };
    this.state?.set("setup.wslRebootPending", false);
    const wsl = await this.detectWsl();
    if (wsl.installed) return { installed: true, overridden: false };
    this.state?.set("setup.wslOverride", true);
    this.onEvent({ type: "setup", message: "Marked WSL as ready — continuing to Docker." });
    return { installed: true, overridden: true };
  }

  async restart() {
    if (this.platform !== "win32") throw new Error("Restart is only offered on Windows");
    // 60-second delay so the user can save work; cancellable with cancelRestart().
    const r = await this._exec(
      "shutdown.exe",
      ["/r", "/t", "60", "/c", "Restarting to finish WSL setup for Free Koinos Node."],
      { timeout: 10000 }
    );
    if (!r.ok) throw new Error("Couldn't schedule the restart. Restart Windows manually to finish WSL setup.");
    this.onEvent({ type: "setup", message: "Windows will restart in 60 seconds. Save your work." });
    return { scheduled: true, seconds: 60 };
  }

  async cancelRestart() {
    if (this.platform !== "win32") return { cancelled: false };
    await this._exec("shutdown.exe", ["/a"], { timeout: 10000 });
    return { cancelled: true };
  }

  async installDocker() {
    const asset = dockerAsset(this.platform, this.arch);
    if (!asset) throw new Error("On Linux, install Docker Engine from the documentation link.");
    if (this._op?.running) throw new Error("A download is already in progress");

    fs.mkdirSync(this.downloadDir, { recursive: true });
    const dest = path.join(this.downloadDir, asset.filename);
    const op = {
      name: "docker-download",
      running: true,
      startedAt: Date.now(),
      progress: { stage: "download", pct: 0 },
      lines: [`Downloading ${asset.filename}…`],
      error: null,
      code: null,
    };
    this._op = op;
    this._abort = new AbortController();

    this.onEvent({ type: "setup", message: "Downloading Docker Desktop…" });
    httpDownload(asset.url, dest, {
      signal: this._abort.signal,
      onProgress: (done, total) => {
        op.progress = { stage: "download", pct: total ? (done / total) * 100 : null, doneBytes: done, totalBytes: total };
      },
    })
      .then(async () => {
        op.progress = { stage: "launch", pct: 100 };
        op.lines.push("Download complete — launching the installer.");
        await this._launchInstaller(asset, dest);
        op.running = false;
        op.code = 0;
        this.onEvent({
          type: "setup",
          message:
            this.platform === "win32"
              ? "Docker Desktop installer launched — follow its prompts, then start Docker."
              : "Docker disk image opened — drag Docker to Applications, then start it.",
        });
      })
      .catch((e) => {
        op.running = false;
        op.code = 1;
        op.error = String(e?.message ?? e);
        if (!/cancel/i.test(op.error)) {
          this.onEvent({ type: "setup", level: "error", message: `Docker download failed: ${op.error}` });
        }
      });
    return { started: true };
  }

  cancelInstallDocker() {
    if (this._op?.name === "docker-download" && this._op.running) {
      this._abort?.abort();
      return { cancelling: true };
    }
    return { cancelling: false };
  }

  async _launchInstaller(asset, dest) {
    if (this.platform === "win32") {
      // The installer self-elevates and shows its own UI.
      spawn(dest, [], { detached: true, stdio: "ignore", windowsHide: false }).unref();
    } else if (this.platform === "darwin") {
      spawn("open", [dest], { detached: true, stdio: "ignore" }).unref();
    }
  }

  async startDocker() {
    if (this.platform === "win32") {
      const exe = this._dockerAppInstalled();
      if (!exe) throw new Error("Docker Desktop isn't installed yet. Install it first.");
      spawn(exe, [], { detached: true, stdio: "ignore" }).unref();
    } else if (this.platform === "darwin") {
      spawn("open", ["-a", "Docker"], { detached: true, stdio: "ignore" }).unref();
    } else {
      throw new Error("Start the Docker service with your init system, e.g. `sudo systemctl start docker`.");
    }
    this.onEvent({ type: "setup", message: "Starting Docker — this can take a minute on first launch." });
    return { started: true };
  }

  dockerDocsUrl() {
    return DOCKER_DOCS[this.platform] || DOCKER_DOCS.linux;
  }

  // Right-size the WSL 2 VM so the Koinos node has enough memory and doesn't get
  // OOM-killed. On Windows, WSL's memory is governed by C:\Users\<you>\.wslconfig
  // (Docker Desktop's WSL backend reads it). We merge sane memory/swap values in —
  // raising only, never lowering a value the user chose — back up any existing
  // file, and let it take effect on the next Docker/WSL restart. No-op elsewhere.
  async optimizeWslMemory({ totalBytes } = {}) {
    if (this.platform !== "win32") return { changed: false, skipped: "not-windows" };
    let cfgPath;
    try {
      const rec = recommendWslMemory(totalBytes ?? os.totalmem());
      cfgPath = path.join(os.homedir(), ".wslconfig");
      let existing = "";
      try {
        existing = fs.readFileSync(cfgPath, "utf8");
      } catch {
        /* no existing config */
      }
      const merged = mergeWslConfig(existing, rec);
      if (!merged.changed) return { changed: false, memoryGB: rec.memoryGB, path: cfgPath };
      if (existing) {
        try {
          fs.writeFileSync(`${cfgPath}.koinos.bak`, existing);
        } catch {
          /* backup is best-effort */
        }
      }
      fs.writeFileSync(cfgPath, merged.text);
      this.onEvent({
        type: "setup",
        message: `Tuned your PC to give the node enough memory (${rec.memoryGB} GB). It takes effect the next time Docker or your PC restarts.`,
      });
      return { changed: true, memoryGB: rec.memoryGB, path: cfgPath };
    } catch (e) {
      return { changed: false, error: String(e?.message ?? e), path: cfgPath };
    }
  }
}

module.exports = { SetupService, decodeWinText };
