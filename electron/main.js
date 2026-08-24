"use strict";

const { app, BrowserWindow, ipcMain, shell, clipboard, dialog } = require("electron");
const path = require("path");
const fs = require("fs");

const { JsonStore } = require("./lib/store");
const { NETWORKS, DEFAULT_SETTINGS } = require("./lib/constants");
const { WalletService, MIN_PASSWORD_LENGTH } = require("./lib/wallet");
const { ChainService } = require("./lib/chain");
const { NodeManager } = require("./lib/node-manager");
const { SetupService } = require("./lib/setup");
const { RewardEngine } = require("./lib/rewards");
const { DistributionEngine } = require("./lib/distribution");
const { ProducerStats } = require("./lib/producer-stats");
const { projectReturns } = require("./lib/profit-metrics");

// Optional override so the guided-setup UI can be exercised for other
// platforms during development/screenshots. Never set in production.
const FORCED_PLATFORM = process.env.KND_FORCE_PLATFORM || null;
const { parseAmount, formatAmount, subSats, cmpSats } = require("./lib/format");
const { weiToEth } = require("./lib/eth");
const { BridgeOrchestrator, MAX_BRIDGE_ETH } = require("./lib/bridge-orchestrator");
const { RouteCOrchestrator, MAX_ROUTE_C_ETH } = require("./lib/route-c-orchestrator");
const { quoteDeposit, maxBridgeable, makeProvider } = require("./lib/eth-bridge");
const { quoteSend, maxSendable, sendEth } = require("./lib/eth-send");
const { usdtBalance, quoteUsdtSend, maxUsdtSendable, sendUsdt } = require("./lib/usdt-send");
const { vkoinBalance, quoteVkoinSend, maxVkoinSendable, sendVkoin } = require("./lib/vkoin-send");
const { quoteSwap } = require("./lib/koindx");
const { quoteEthToVkoin, quoteVkoinOut, applySlippage } = require("./lib/eth-swap");
const { compareRoutes, descriptor } = require("./lib/fund-routes");
const { KoinPrice, nodeValueUsd } = require("./lib/koin-price");
const { LastGood } = require("./lib/last-good");

// Shared Coinbase Onramp endpoint + app-identity key (see onramp-endpoint/). At
// module scope so both the IPC handlers and the bridge orchestrator use them.
const DEFAULT_ONRAMP_ENDPOINT = "https://koinos-node.vercel.app/api/session";
const ONRAMP_APP_KEY = "kkapp_71854dc40591df1aeb8811a514e3dbc302bb382f";

let win = null;

function sendEvent(payload) {
  if (win && !win.isDestroyed()) {
    win.webContents.send("app:event", { time: Date.now(), ...payload });
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#0b0f17",
    autoHideMenuBar: true,
    title: "Free Koinos Node",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, "..", "ui", "index.html"));
  win.on("closed", () => {
    win = null;
  });

  // Headless smoke-test hook: when KND_SMOKE_DIR is set, click through every
  // view, capture PNGs, and exit. Used for automated sanity checks.
  const smokeDir = process.env.KND_SMOKE_DIR;
  if (smokeDir) {
    win.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          for (const view of ["dashboard", "wallet", "fund", "burn", "node", "distribution", "returns", "settings"]) {
            await win.webContents.executeJavaScript(
              `document.querySelector('[data-view="${view}"]').click()`
            );
            await new Promise((r) => setTimeout(r, 1500));
            const img = await win.webContents.capturePage();
            fs.writeFileSync(path.join(smokeDir, `screenshot-${view}.png`), img.toPNG());
          }
          console.log("SMOKE_OK");
        } catch (e) {
          console.error("SMOKE_FAIL", e);
          process.exitCode = 1;
        } finally {
          app.quit();
        }
      }, 5000);
    });
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    const userData = app.getPath("userData");
    const settings = new JsonStore(path.join(userData, "settings.json"), DEFAULT_SETTINGS);
    const state = new JsonStore(path.join(userData, "state.json"), {});
    const wallet = new WalletService(path.join(userData, "wallet"));
    const chain = new ChainService(settings);
    const nodeMgr = new NodeManager({
      templateRoot: path.join(__dirname, "..", "node-template"),
      dataRoot: path.join(userData, "node"),
      onEvent: sendEvent,
      autoRecover: settings.get("node.autoRecover", true),
      accountHistory: settings.get("node.accountHistory", false),
      // Lets the watchdog notice a wedged chain: report the local head height.
      probeHead: async () => {
        const s = await chain.syncStatus().catch(() => null);
        const h = s?.local?.height;
        return h != null ? Number(h) : null;
      },
    });
    const setup = new SetupService({
      platform: FORCED_PLATFORM || process.platform,
      arch: process.arch,
      downloadDir: path.join(userData, "downloads"),
      state,
      onEvent: sendEvent,
    });
    const stats = new ProducerStats({ chain, state });
    // KOIN's USD price, quoted from the Uniswap USDT/vKOIN pool (cached).
    const koinPrice = new KoinPrice({ makeProvider });
    const rewards = new RewardEngine({ chain, wallet, settings, state, stats, onEvent: sendEvent });
    rewards.start();
    const distribution = new DistributionEngine({ chain, wallet, settings, state, stats, onEvent: sendEvent });
    distribution.start();

    const bridge = new BridgeOrchestrator({
      wallet,
      provider: chain.provider(),
      store: new JsonStore(path.join(userData, "fund-bridge.json"), { job: null }),
      settings,
      appKey: ONRAMP_APP_KEY,
      network: settings.get("network", "mainnet"),
      onEvent: sendEvent,
    });
    // Driver: advance an active (non-terminal) bridge job every 15s. Deposit is
    // user-initiated; everything after it (poll → redeem → swap) auto-advances.
    setInterval(() => {
      const job = bridge.status();
      if (job && !["done", "error", "depositing"].includes(job.status)) bridge.advance().catch(() => {});
    }, 15000);

    const routeC = new RouteCOrchestrator({
      wallet,
      provider: chain.provider(),
      store: new JsonStore(path.join(userData, "fund-routec.json"), { routeCJob: null }),
      settings,
      appKey: ONRAMP_APP_KEY,
      network: settings.get("network", "mainnet"),
      onEvent: sendEvent,
    });
    // Driver: once started, Route C auto-advances all six Ethereum txs then the
    // Koinos redeem. Ticks every 8s (near block time) and only while the wallet is
    // unlocked, so a locked session pauses the flow instead of failing it.
    setInterval(() => {
      const job = routeC.status();
      if (job && !["done", "error"].includes(job.status) && wallet.status().unlocked) {
        routeC.advance().catch(() => {});
      }
    }, 8000);

    registerIpc({ settings, state, wallet, chain, nodeMgr, setup, rewards, distribution, stats, koinPrice, bridge, routeC, userData });
    createWindow();
    setupAutoUpdates();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
    app.on("before-quit", () => {
      rewards.stop();
      distribution.stop();
    });
  });

  app.on("window-all-closed", () => {
    app.quit();
  });
}

// Checks GitHub Releases for new versions (installed builds only), downloads
// in the background, and offers to restart. "Later" still applies the update
// on quit.
function setupAutoUpdates() {
  if (!app.isPackaged) return;
  let updater;
  try {
    ({ autoUpdater: updater } = require("electron-updater"));
  } catch {
    return;
  }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  // Channel selection by the running build's own version: a prerelease build
  // (e.g. 0.3.0-beta.1 — anything with a "-" per semver) follows the beta line
  // and always takes the highest version (betas now, stable when it's higher);
  // a stable build ignores prereleases entirely. This keeps beta/test builds
  // off your live users' machines with no separate app or feed.
  updater.allowPrerelease = app.getVersion().includes("-");
  updater.on("update-available", (info) => {
    sendEvent({ type: "update", message: `Update v${info.version} found — downloading in the background…` });
  });
  updater.on("update-downloaded", async (info) => {
    sendEvent({ type: "update", message: `Update v${info.version} downloaded — restart to install.` });
    const { response } = await dialog.showMessageBox(win, {
      type: "info",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
      message: `Free Koinos Node v${info.version} is ready to install`,
      detail:
        "Restart the app to apply the update now. If you choose Later, it installs automatically the next time you quit. Your wallet, settings, and the running node are not affected.",
    });
    if (response === 0) updater.quitAndInstall();
  });
  updater.on("error", () => {
    // Update checks are best-effort; never bother the user about them failing.
  });
  const check = () => updater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 4 * 60 * 60 * 1000);
}

function registerIpc({ settings, state, wallet, chain, nodeMgr, setup, rewards, distribution, stats, koinPrice, bridge, routeC, userData }) {
  // Dashboard reads that must not blank on a hiccup (see lib/last-good.js).
  const dashHold = new LastGood();

  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (_evt, payload) => {
      try {
        return { ok: true, data: await fn(payload ?? {}) };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e) };
      }
    });

  const publicNetworks = Object.fromEntries(
    Object.entries(NETWORKS).map(([id, n]) => [
      id,
      {
        id,
        label: n.label,
        tokenSymbol: n.tokenSymbol,
        explorer: n.explorer,
        contracts: n.contracts,
        ports: n.ports,
        rpcUrls: n.rpcUrls,
        localRpcUrl: n.localRpcUrl,
      },
    ])
  );

  // ----- app / settings -----
  handle("app:info", () => ({
    version: require("../package.json").version,
    platform: FORCED_PLATFORM || process.platform,
    userData,
    networks: publicNetworks,
    settings: settings.all(),
    minPasswordLength: MIN_PASSWORD_LENGTH,
    rpc: chain.rpcStatus(),
  }));

  handle("settings:update", ({ network, customRpc, keepLiquidKoin, onrampEndpoint, useLocalNodeRpc }) => {
    if (network !== undefined) {
      if (!NETWORKS[network]) throw new Error(`Unknown network: ${network}`);
      settings.set("network", network);
      chain.clearCache();
      rewards.start(); // re-arm timer; reward baselines are tracked per network
    }
    if (customRpc !== undefined) {
      for (const [netId, url] of Object.entries(customRpc)) {
        if (!NETWORKS[netId]) throw new Error(`Unknown network: ${netId}`);
        if (url && !/^https?:\/\/\S+$/.test(url)) throw new Error("RPC URL must start with http(s)://");
        settings.set(`customRpc.${netId}`, url || "");
      }
      chain.clearCache();
    }
    if (useLocalNodeRpc !== undefined) {
      settings.set("useLocalNodeRpc", !!useLocalNodeRpc);
      chain.clearCache(); // re-probe our node and re-pick the endpoint order
    }
    if (keepLiquidKoin !== undefined) {
      parseAmount(keepLiquidKoin);
      settings.set("keepLiquidKoin", String(keepLiquidKoin));
    }
    if (onrampEndpoint !== undefined) {
      const u = String(onrampEndpoint).trim();
      // Must be https — this endpoint holds the Coinbase secret key.
      if (u && !/^https:\/\/\S+$/.test(u)) throw new Error("Onramp endpoint must be an https:// URL");
      settings.set("onrampEndpoint", u);
    }
    return settings.all();
  });

  // ----- wallet -----
  handle("wallet:status", () => wallet.status());
  handle("wallet:create", ({ password }) => wallet.create({ password }));
  handle("wallet:import", ({ wif, password }) => wallet.importWif({ wif, password }));
  handle("wallet:unlock", ({ password }) => wallet.unlock(password));
  handle("wallet:lock", () => wallet.lock());
  handle("wallet:revealWif", ({ password }) => wallet.revealWif(password));
  handle("wallet:remove", ({ password, confirm }) => wallet.remove({ password, confirm }));

  // ----- chain -----
  handle("chain:balances", async () => {
    const address = wallet.address;
    if (!address) return { address: null };
    // Same hold as the dashboard: the wallet and burn tabs poll this, and a
    // one-off RPC failure should not empty the balances on screen.
    const b = await dashHold.run(`balances.${chain.network().id}.${address}`, () => chain.balances(address));
    if (b.error) throw new Error(b.error);
    return {
      address,
      ...b,
      formatted: {
        koin: formatAmount(b.koin),
        vhp: formatAmount(b.vhp),
        mana: formatAmount(b.mana),
      },
    };
  });

  handle("chain:burn", async ({ amount }) => {
    const amountSat = parseAmount(amount);
    const res = await chain.burn(wallet.signer, amountSat);
    sendEvent({
      type: "burn",
      message: `Burned ${formatAmount(amountSat)} ${chain.network().tokenSymbol} → VHP`,
      txId: res.txId,
    });
    return { ...res, amountSat, amountFormatted: formatAmount(amountSat) };
  });

  handle("chain:send", async ({ to, amount, token }) => {
    const amountSat = parseAmount(amount);
    const res = await chain.transfer(wallet.signer, { to, amountSat, token });
    sendEvent({
      type: "send",
      message: `Sent ${formatAmount(amountSat)} ${String(token).toUpperCase()} to ${to}`,
      txId: res.txId,
    });
    return { ...res, amountSat };
  });

  handle("chain:sync", () => chain.syncStatus());

  handle("chain:maxBurn", async () => {
    const address = wallet.address;
    if (!address) throw new Error("No wallet");
    const { koin, mana } = await chain.balances(address);
    const keep = parseAmount(settings.get("keepLiquidKoin", "10"));
    // Cap by liquid balance above the mana buffer AND by mana actually available
    // now — burning requires mana >= amount, so a balance-only Max can suggest an
    // amount that reverts with "could not burn KOIN".
    const byBalance = cmpSats(koin, keep) > 0 ? subSats(koin, keep) : "0";
    const byMana = chain.burnableFromMana(mana);
    const manaLimited = cmpSats(byMana, byBalance) < 0;
    const max = manaLimited ? byMana : byBalance;
    return {
      maxSat: max,
      maxFormatted: formatAmount(max, { grouping: false }),
      manaLimited,
      manaFormatted: formatAmount(mana),
    };
  });

  // ----- block producer registration -----
  handle("producer:status", async () => {
    const networkId = chain.network().id;
    const address = wallet.address;
    const filePublicKey = nodeMgr.readProducerPublicKey(networkId);
    let registeredPublicKey = null;
    if (address) {
      registeredPublicKey = await chain.registeredPublicKey(address);
    }
    return {
      address,
      filePublicKey,
      registeredPublicKey,
      matches: !!filePublicKey && filePublicKey === registeredPublicKey,
    };
  });

  handle("producer:register", async () => {
    const networkId = chain.network().id;
    const pub = nodeMgr.readProducerPublicKey(networkId);
    if (!pub) {
      throw new Error(
        "No signing key found yet. Start the node once — the block producer generates its key on first run."
      );
    }
    const res = await chain.registerProducerKey(wallet.signer, pub);
    sendEvent({ type: "producer", message: "Block production key registered on chain", txId: res.txId });
    return res;
  });

  // ----- node -----
  handle("node:status", async () => {
    const networkId = chain.network().id;
    const status = await nodeMgr.status(networkId);
    let sync = null;
    if (status.isRunning) {
      sync = await chain.syncStatus().catch(() => null);
    }
    // Only probe prerequisites while Docker isn't usable yet — this is what
    // drives the guided setup card.
    let setupStatus = null;
    if (!status.docker?.ok) {
      setupStatus = await setup.status().catch(() => null);
    }
    return { network: networkId, ...status, sync, setup: setupStatus, rpc: chain.rpcStatus() };
  });

  // ----- guided setup (WSL + Docker) -----
  handle("setup:status", () => setup.status());
  handle("setup:installWsl", () => setup.installWsl());
  handle("setup:restart", () => setup.restart());
  handle("setup:cancelRestart", () => setup.cancelRestart());
  handle("setup:installDocker", () => setup.installDocker());
  handle("setup:cancelInstallDocker", () => setup.cancelInstallDocker());
  handle("setup:startDocker", () => setup.startDocker());
  handle("setup:markWslReady", () => setup.markWslReady());
  handle("setup:openDockerDocs", () => {
    shell.openExternal(setup.dockerDocsUrl());
    return true;
  });

  handle("node:start", async ({ produce }) => {
    const networkId = chain.network().id;
    // One-time, best-effort: right-size the WSL VM so the node has enough memory
    // to begin with. Self-skips off Windows; writes .wslconfig only when it would
    // raise a too-low limit. Fully guarded — tuning must NEVER block starting the
    // node, whatever goes wrong here.
    try {
      if (!state.get("node.memoryTuned", false)) {
        await setup.optimizeWslMemory().catch(() => {});
        state.set("node.memoryTuned", true);
      }
    } catch {
      /* tuning is best-effort; starting the node always wins */
    }
    let producerAddress = null;
    if (produce) {
      producerAddress = wallet.address;
      if (!producerAddress) throw new Error("Create a wallet first to enable block production");
    }
    return nodeMgr.start(networkId, producerAddress);
  });

  handle("node:stop", () => nodeMgr.stop(chain.network().id));
  handle("node:setAutoRecover", ({ on }) => {
    settings.set("node.autoRecover", !!on);
    nodeMgr.setAutoRecover(!!on);
    return { autoRecover: !!on };
  });
  handle("node:logs", ({ service, tail }) => nodeMgr.logs(chain.network().id, service, tail));
  handle("node:quickSyncInfo", () => nodeMgr.quickSyncInfo(chain.network().id));
  handle("node:quickSync", () => nodeMgr.quickSync(chain.network().id));
  handle("node:quickSyncCancel", () => nodeMgr.cancelQuickSync());

  // ----- dashboard -----
  handle("dashboard:summary", async () => {
    const net = chain.network();
    const address = wallet.address;
    const ws = wallet.status();
    const out = {
      network: { id: net.id, label: net.label, tokenSymbol: net.tokenSymbol, explorer: net.explorer },
      wallet: { exists: ws.exists, unlocked: ws.unlocked, address },
      node: null,
      balances: null,
      stats: null,
      rewards: rewards.status().config,
    };
    // Node running state (docker + services).
    try {
      const ns = await nodeMgr.status(net.id);
      out.node = {
        docker: ns.docker,
        isRunning: ns.isRunning,
        runningCount: ns.runningCount,
        op: ns.op,
        producerRegistered: null,
      };
      if (ns.isRunning) {
        out.sync = await chain.syncStatus().catch(() => null);
      }
    } catch (e) {
      out.node = { error: String(e.message) };
    }
    if (!address) return out;
    // Balances + producer stats (both hit the RPC).
    // Both hold their last good answer through a failure rather than reporting
    // nothing: the dashboard polls every few seconds, and a blank tile that
    // refills on the next tick reads as a glitch, not as an outage.
    const [balances, statsRes] = await Promise.all([
      dashHold.run(`balances.${net.id}.${address}`, () => chain.balances(address)),
      stats.refresh(address).catch((e) => ({ available: false, error: String(e.message) })),
    ]);
    out.balances = balances;
    out.stats = statsRes;

    // Projected returns: annualize the recent daily profit rate against the
    // producing stake (VHP), plus a compounded figure at the user's reburn rate.
    const rcfg = out.rewards || {};
    const reburnFraction = rcfg.enabled && rcfg.mode === "burn" ? Number(rcfg.pct || 0) / 100 : 0;
    const windows = statsRes && statsRes.windows ? statsRes.windows : null;
    const stakeSats = balances && !balances.error ? balances.vhp : "0";
    out.returns = windows
      ? projectReturns({ avgDailyProfitSats: windows.avgDailyProfit, stakeSats, reburnFraction })
      : null;

    // What the node is worth, and what it earns, in USD. Priced off the same
    // Uniswap pool the Fund tab swaps through — the rate it could actually be
    // traded at. Never blocks the dashboard: a failed or slow quote leaves the
    // last known price in place (flagged stale) and the tiles simply show "—".
    let price = null;
    try {
      price = await koinPrice.get();
    } catch {
      price = koinPrice.cached();
    }
    out.price = price
      ? { usd: price.usd, at: price.at, stale: !!price.stale, source: price.source, method: price.method }
      : { usd: null, error: koinPrice.lastError };
    out.nodeValue = nodeValueUsd({
      koinSats: balances && !balances.error ? balances.koin : "0",
      vhpSats: stakeSats,
      avgDailyProfitSats: windows ? windows.avgDailyProfit : "0",
      usdPerKoin: price?.usd ?? null,
    });

    // Screenshot/demo-only override (never set in production): present a
    // running, synced node with representative balances so marketing shots
    // show a live dashboard.
    if (process.env.KND_DEMO) {
      out.node = { docker: { ok: true }, isRunning: true, runningCount: 7, op: null };
      out.sync = {
        inSync: true,
        local: { height: 38297044, headBlockTimeMs: Date.now(), error: null },
        remote: { height: 38297044 },
        progressPct: 100,
      };
      out.balances = { koin: "4308560000", vhp: "228813610000", mana: "3822790000" };
      const demoWindows = { last24h: "31200000", last7d: "216500000", last30d: "934800000", avgDailyProfit: "31160000", daysTracked: 30 };
      out.stats = { available: true, network: net.id, totals: out.stats?.totals ?? null, feed: out.stats?.feed ?? [], windows: demoWindows, syncing: false };
      out.returns = projectReturns({ avgDailyProfitSats: demoWindows.avgDailyProfit, stakeSats: out.balances.vhp, reburnFraction: 0.5 });
      out.price = { usd: 0.062, at: Date.now(), stale: false, source: "demo" };
      out.nodeValue = nodeValueUsd({
        koinSats: out.balances.koin, vhpSats: out.balances.vhp,
        avgDailyProfitSats: demoWindows.avgDailyProfit, usdPerKoin: 0.062,
      });
    }
    return out;
  });

  // ----- rewards -----
  // Reward returns and community distribution both spend the same reward KOIN,
  // so enabling one turns the other off — never both at once.
  handle("rewards:status", () => rewards.status());
  handle("rewards:configure", (patch) => {
    const cfg = rewards.configure(patch);
    if (cfg.enabled && distribution.config().enabled) {
      distribution.configure({ enabled: false });
      sendEvent({ type: "distribution", message: "Community distribution turned off — Reward returns now manages rewards." });
    }
    return cfg;
  });
  handle("rewards:runNow", () => rewards.tick("manual"));

  // ----- community profit distribution -----
  handle("distribution:status", () => distribution.status());
  handle("distribution:configure", (patch) => {
    const cfg = distribution.configure(patch);
    if (cfg.enabled && rewards.status().config.enabled) {
      rewards.configure({ enabled: false });
      sendEvent({ type: "rewards", message: "Reward returns turned off — community distribution now manages rewards." });
    }
    return cfg;
  });
  handle("distribution:runNow", () => distribution.tick("manual"));
  handle("distribution:distributeNow", () => distribution.tick("manual", { forceClose: true }));

  // ----- fund node (Ethereum on-ramp — Phase 1) -----
  // Shared, app-hosted Coinbase Onramp endpoint. Every install uses this by
  // default so the Buy button works with zero setup; advanced users can override
  // it with their own endpoint in the Fund tab. (DEFAULT_ONRAMP_ENDPOINT and
  // ONRAMP_APP_KEY are defined at module scope.)
  const effectiveOnrampEndpoint = () => settings.get("onrampEndpoint", "") || DEFAULT_ONRAMP_ENDPOINT;

  handle("fund:status", () => ({
    ethAddress: wallet.ethAddress,
    onrampEndpoint: settings.get("onrampEndpoint", ""), // user override; blank = built-in default
    onrampDefault: DEFAULT_ONRAMP_ENDPOINT,
    onrampConfigured: !!effectiveOnrampEndpoint(),
  }));

  // Asks the user's own Coinbase Onramp endpoint (a small serverless function
  // holding their CDP secret) to mint a session token for the wallet's ETH
  // address, then builds the hosted Coinbase Pay URL. Post-2025 Onramp requires
  // this server-minted session token — the secret never lives in the app.
  handle("fund:buyUrl", async ({ amountUsd } = {}) => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first to get a funding address.");
    const endpoint = effectiveOnrampEndpoint();
    if (!endpoint) throw new Error("No Coinbase Onramp endpoint is configured.");
    let token;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "x-koinoskit-app": ONRAMP_APP_KEY },
        body: JSON.stringify({ address, asset: "ETH", network: "ethereum" }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
      if (!resp.ok) throw new Error(`endpoint returned HTTP ${resp.status}`);
      const data = await resp.json();
      token = data.token || data.sessionToken;
    } catch (e) {
      throw new Error(`Couldn't reach your Onramp endpoint: ${String(e.message || e)}`);
    }
    if (!token) throw new Error("Your Onramp endpoint didn't return a session token.");
    const u = new URL("https://pay.coinbase.com/buy/select-asset");
    u.searchParams.set("sessionToken", token);
    u.searchParams.set("defaultAsset", "ETH");
    u.searchParams.set("defaultNetwork", "ethereum");
    u.searchParams.set("fiatCurrency", "USD");
    if (amountUsd && Number(amountUsd) > 0) u.searchParams.set("presetFiatAmount", String(Number(amountUsd)));
    return { url: u.toString() };
  });

  // Read-only ETH balance of the wallet's funding address, via public RPCs
  // (tried in order). Lets the user confirm funds arrived before bridging.
  const ETH_RPCS = [
    "https://ethereum-rpc.publicnode.com",
    "https://eth.llamarpc.com",
    "https://cloudflare-eth.com",
    "https://rpc.ankr.com/eth",
  ];
  handle("fund:ethBalance", async () => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first.");
    let lastErr;
    for (const rpc of ETH_RPCS) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        const resp = await fetch(rpc, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] }),
          signal: controller.signal,
        }).finally(() => clearTimeout(timer));
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (data.error) throw new Error(data.error.message || "RPC error");
        return { address, wei: data.result, eth: weiToEth(data.result) };
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(`Couldn't fetch ETH balance: ${String(lastErr?.message || lastErr)}`);
  });

  // ----- fund node bridge (Phase 2: ETH -> vETH -> KOIN) -----
  handle("fund:bridgeStatus", () => bridge.status());
  handle("fund:bridgeReset", () => bridge.reset());
  handle("fund:bridgeAdvance", () => bridge.advance());
  handle("fund:bridgeStart", ({ amountEth, slippageBps } = {}) => bridge.start({ amountEth, slippageBps }));

  // Route C (ETH → USDT → vKOIN → bridge → native KOIN). start() sets up + quotes;
  // advance() is called once here to send the first tx, then the 8s driver takes over.
  handle("fund:routeCStatus", () => routeC.status());
  handle("fund:routeCReset", () => routeC.reset());
  handle("fund:routeCAdvance", () => routeC.advance());
  handle("fund:routeCResume", () => routeC.resume());
  handle("fund:routeCStart", async ({ amountEth, amountUsdt, amountVkoin, source, slippageBps } = {}) => {
    const job = await routeC.start({ amountEth, amountUsdt, amountVkoin, source, slippageBps });
    routeC.advance().catch(() => {}); // kick the first Ethereum tx immediately
    return job;
  });
  handle("fund:bridgeMax", async () => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first.");
    return maxBridgeable({
      fromAddress: address,
      koinosRecipient: wallet.address,
      network: settings.get("network", "mainnet"),
      capEth: MAX_BRIDGE_ETH,
    });
  });
  handle("fund:bridgeQuote", async ({ amountEth, slippageBps } = {}) => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first.");
    const network = settings.get("network", "mainnet");
    const deposit = await quoteDeposit({ fromAddress: address, amountEth, koinosRecipient: wallet.address, network });
    let swap = null;
    try {
      swap = await quoteSwap({ amountInSats: deposit.vethSats, slippageBps: slippageBps || 150, network, provider: chain.provider() });
    } catch (e) {
      swap = { error: String(e.message || e) };
    }
    return { deposit, swap, maxEth: MAX_BRIDGE_ETH };
  });

  // Compare both funding routes for a given ETH amount and rank by KOIN out, so
  // the UI can show the best plus the runners-up. Read-only (quotes only).
  //   Route B: ETH → vETH (Vortex) → KOIN (KoinDX)
  //   Route C: ETH → USDT → vKOIN (Uniswap v4) → KOIN (Vortex, 1:1)
  // Route C is quote-only in this build (execution ships next); `executable`
  // tells the UI which route the Bridge button can actually run today.
  handle("fund:routeCompare", async ({ amountEth, slippageBps = 150 } = {}) => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first.");
    const network = settings.get("network", "mainnet");

    let routeB;
    try {
      const deposit = await quoteDeposit({ fromAddress: address, amountEth, koinosRecipient: wallet.address, network });
      const swap = await quoteSwap({ amountInSats: deposit.vethSats, slippageBps, network, provider: chain.provider() });
      routeB = { ...descriptor("B"), executable: true, koinOut: swap.amountOut, koinOutMin: swap.amountOutMin, gasCostEth: deposit.gasCostEth };
    } catch (e) {
      routeB = { ...descriptor("B"), executable: true, koinOut: null, error: String(e.message || e) };
    }

    let routeC;
    try {
      const q = await quoteEthToVkoin({ amountEth, slippageBps });
      routeC = { ...descriptor("C"), executable: true, koinOut: q.koinOut, koinOutMin: q.koinOutMin, usdtOut: q.usdtOut };
    } catch (e) {
      routeC = { ...descriptor("C"), executable: true, koinOut: null, error: String(e.message || e) };
    }

    return { ...compareRoutes([routeB, routeC]), amountEth: String(amountEth), slippageBps };
  });

  // ----- withdraw ETH out (so ETH parked for bridging isn't trapped) -----
  handle("fund:ethSendQuote", async ({ toAddress, amountEth } = {}) => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first.");
    return quoteSend({ fromAddress: address, toAddress, amountEth });
  });
  handle("fund:ethSendMax", async ({ toAddress } = {}) => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first.");
    return maxSendable({ fromAddress: address, toAddress });
  });
  // REAL ETH MOVES HERE. ethPrivateKey() throws if the wallet is locked, so the
  // send is gated on an unlocked wallet.
  handle("fund:ethSend", async ({ toAddress, amountEth } = {}) => {
    if (!wallet.ethAddress) throw new Error("Create or unlock your wallet first.");
    const res = await sendEth({ ethPrivHex: wallet.ethPrivateKey(), toAddress, amountEth });
    return res;
  });

  // ----- ETH + USDT balances (one round-trip) for the Wallet tab -----
  handle("fund:cryptoBalances", async () => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first.");
    const provider = await makeProvider();
    const [ethWei, usdt, vkoin] = await Promise.all([
      provider.getBalance(address),
      usdtBalance({ address, provider }),
      vkoinBalance({ address, provider }),
    ]);
    return {
      address,
      ethWei: ethWei.toString(),
      eth: weiToEth("0x" + ethWei.toString(16)),
      usdtSats: usdt.sats,
      usdt: usdt.usdt,
      vkoinSats: vkoin.sats,
      vkoin: vkoin.vkoin,
    };
  });

  // ----- withdraw / send USDT out -----
  handle("fund:usdtSendQuote", async ({ toAddress, amountUsdt } = {}) => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first.");
    return quoteUsdtSend({ fromAddress: address, toAddress, amountUsdt });
  });
  handle("fund:usdtSendMax", async () => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first.");
    return maxUsdtSendable({ fromAddress: address });
  });
  // REAL USDT MOVES HERE. Gated on an unlocked wallet (ethPrivateKey throws locked).
  handle("fund:usdtSend", async ({ toAddress, amountUsdt } = {}) => {
    if (!wallet.ethAddress) throw new Error("Create or unlock your wallet first.");
    return sendUsdt({ ethPrivHex: wallet.ethPrivateKey(), toAddress, amountUsdt });
  });

  // ----- quote KOIN out for funding the node directly from USDT (Route C) -----
  handle("fund:usdtFundQuote", async ({ amountUsdt, slippageBps = 150 } = {}) => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first.");
    const provider = await makeProvider();
    const usdtSats = require("./lib/usdt-send").parseUsdt(amountUsdt);
    if (usdtSats <= 0n) throw new Error("Amount must be greater than 0");
    const koin = await quoteVkoinOut({ usdtSats, provider });
    return { amountUsdt: String(amountUsdt), koinOut: koin.toString(), koinOutMin: applySlippage(koin, slippageBps).toString(), slippageBps };
  });

  // ----- send vKOIN out / bridge-to-KOIN recovery -----
  handle("fund:vkoinSendQuote", async ({ toAddress, amountVkoin } = {}) => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first.");
    return quoteVkoinSend({ fromAddress: address, toAddress, amountVkoin });
  });
  handle("fund:vkoinSendMax", async () => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first.");
    return maxVkoinSendable({ fromAddress: address });
  });
  handle("fund:vkoinSend", async ({ toAddress, amountVkoin } = {}) => {
    if (!wallet.ethAddress) throw new Error("Create or unlock your wallet first.");
    return sendVkoin({ ethPrivHex: wallet.ethPrivateKey(), toAddress, amountVkoin });
  });

  // ----- gas-aware Max for ETH funding: balance minus a Route-C gas reserve -----
  // Route C sends up to ~6 txs (swaps + approvals + bridge); reserve enough ETH so
  // the run can't stall out of gas mid-flow, and flag if the balance can't cover it.
  handle("fund:routeMaxEth", async () => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first.");
    const provider = await makeProvider();
    const balance = await provider.getBalance(address);
    const fee = await provider.getFeeData();
    const perGas = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
    const ROUTE_C_GAS = 750000n; // ETH→USDT + 2 approvals + USDT→vKOIN + approve + bridge
    const gasReserve = (perGas * ROUTE_C_GAS * 13n) / 10n; // +30% headroom
    let maxWei = balance > gasReserve ? balance - gasReserve : 0n;
    const capWei = 50000000000000000n; // 0.05 ETH
    if (maxWei > capWei) maxWei = capWei;
    return {
      maxWei: maxWei.toString(),
      maxEth: weiToEth("0x" + maxWei.toString(16)),
      gasReserveEth: weiToEth("0x" + gasReserve.toString(16)),
      balanceEth: weiToEth("0x" + balance.toString(16)),
      enoughForGas: balance > gasReserve,
    };
  });

  // ----- utilities -----
  handle("util:copy", ({ text }) => {
    clipboard.writeText(String(text ?? ""));
    return true;
  });

  handle("util:openExternal", ({ url }) => {
    if (!/^https:\/\//.test(String(url))) throw new Error("Only https links can be opened");
    shell.openExternal(url);
    return true;
  });

  handle("util:openPath", ({ which }) => {
    const networkId = chain.network().id;
    const targets = {
      nodeData: nodeMgr.dirs(networkId).root,
      userData,
    };
    const target = targets[which];
    if (!target) throw new Error("Unknown path");
    shell.openPath(target);
    return true;
  });
}
