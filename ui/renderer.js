"use strict";

/* global window, document */

// ---------- IPC + state ----------

async function call(channel, payload) {
  const res = await window.koinos.invoke(channel, payload);
  if (!res.ok) throw new Error(res.error || "Unknown error");
  return res.data;
}

const S = {
  appInfo: null,
  wallet: null,       // wallet:status
  balances: null,     // chain:balances
  balancesAt: 0,
  node: null,         // node:status
  producer: null,     // producer:status
  rewards: null,      // rewards:status
  distribution: null, // distribution:status
  dashboard: null,    // dashboard:summary
  dashboardRendered: false,
  view: "dashboard",
  walletStage: null,  // "none" | "locked" | "unlocked"
  pendingWif: null,   // shown once after create
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------- formatting ----------

const ONE = 100000000n;

function fmtSat(sats, maxDecimals = 8) {
  let v;
  try { v = BigInt(String(sats ?? "0")); } catch { return "0"; }
  const neg = v < 0n;
  if (neg) v = -v;
  const whole = (v / ONE).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  let frac = (v % ONE).toString().padStart(8, "0").slice(0, maxDecimals).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

function fmtTime(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString();
}

// Format a percentage (number) for a metric tile: more precision when small,
// commas when huge.
function fmtPct(v) {
  if (v == null || !isFinite(v)) return "—";
  const abs = Math.abs(v);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits }) + "%";
}

function shortTx(txId) {
  const s = String(txId ?? "");
  return s.length > 18 ? `${s.slice(0, 10)}…${s.slice(-6)}` : s;
}

function net() {
  return S.appInfo.networks[S.appInfo.settings.network];
}

function sym() {
  return net().tokenSymbol;
}

// ---------- toasts / modals ----------

function toast(message, kind = "info", ms = 5000) {
  const div = document.createElement("div");
  div.className = `toast ${kind}`;
  div.textContent = message;
  $("#toasts").appendChild(div);
  setTimeout(() => div.remove(), ms);
}

function showModal({ title, body, actions = [], onMount }) {
  const root = $("#modal-root");
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `<div class="modal"><h2>${esc(title)}</h2><div class="modal-body">${body}</div><div class="actions"></div></div>`;
  const close = () => backdrop.remove();
  const actionsEl = $(".actions", backdrop);
  for (const a of actions) {
    const b = document.createElement("button");
    b.className = `btn ${a.class || ""}`;
    b.textContent = a.label;
    b.addEventListener("click", () => a.onClick?.(close, backdrop));
    actionsEl.appendChild(b);
  }
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop && !actions.some((a) => a.required)) close();
  });
  root.appendChild(backdrop);
  onMount?.(backdrop, close);
  return close;
}

function busyButton(btn, busy, labelBusy = "Working…") {
  if (!btn) return;
  if (busy) {
    btn.dataset.label = btn.textContent;
    btn.innerHTML = `<span class="spin"></span> ${esc(labelBusy)}`;
    btn.disabled = true;
  } else {
    btn.textContent = btn.dataset.label || btn.textContent;
    btn.disabled = false;
  }
}

async function openTx(txId) {
  const ex = net().explorer;
  if (!ex) {
    await call("util:copy", { text: txId });
    toast("Transaction ID copied (no explorer for this network)");
    return;
  }
  call("util:openExternal", { url: ex.tx + txId }).catch(() => {});
}

// ---------- data refreshers ----------

async function refreshWallet() {
  S.wallet = await call("wallet:status");
  const stage = !S.wallet.exists ? "none" : S.wallet.unlocked ? "unlocked" : "locked";
  if (stage !== S.walletStage) {
    S.walletStage = stage;
    renderWalletView();
    renderBurnView();
  }
}

async function refreshBalances(force = false) {
  if (!S.wallet?.exists) { S.balances = null; return; }
  if (!force && Date.now() - S.balancesAt < 25000) return;
  try {
    S.balances = await call("chain:balances");
    S.balancesAt = Date.now();
    patchBalances();
  } catch (e) {
    S.balances = { error: e.message };
    patchBalances();
  }
}

async function refreshNode() {
  try {
    S.node = await call("node:status");
  } catch (e) {
    S.node = { error: e.message };
  }
  try {
    S.producer = await call("producer:status");
  } catch {
    S.producer = null;
  }
  // VHP/KOIN balances are public on-chain data read from your address, so they
  // load while the wallet is LOCKED. Refresh them here (25s-cached, so it's
  // cheap) so the block-production checklist shows your real VHP without needing
  // an unlock — the node produces blocks whether or not the app is unlocked.
  await refreshBalances().catch(() => {});
  patchNodeView();
  patchRpcSource();
}

async function refreshRewards() {
  try {
    S.rewards = await call("rewards:status");
    patchReturnsView();
  } catch { /* ignore */ }
}

async function refreshDistribution() {
  try {
    S.distribution = await call("distribution:status");
    patchDistributionView();
  } catch { /* ignore */ }
}

// ---------- dashboard ----------

async function refreshDashboard() {
  try {
    S.dashboard = await call("dashboard:summary");
  } catch (e) {
    S.dashboard = { error: e.message };
  }
  if (!S.dashboardRendered) renderDashboardView();
  patchDashboardView();
}

function renderDashboardView() {
  const root = $("#view-dashboard");
  root.innerHTML = `
    <div class="row spread">
      <h1>Dashboard</h1>
      <span class="muted small" id="d-updated"></span>
    </div>
    <div class="card status-card">
      <div class="row spread">
        <div>
          <div class="status-line"><span class="dot" id="d-dot"></span><span id="d-status-text">Loading…</span></div>
          <div class="muted small" id="d-status-sub"></div>
        </div>
        <button id="d-toggle" class="btn primary" data-action="">…</button>
      </div>
      <div id="d-sync"></div>
    </div>
    <div class="widget-grid" id="d-tiles"></div>
    <div class="card">
      <div class="row spread"><h2>💵 Profit &amp; projected return</h2><span class="muted small" id="d-returns-note"></span></div>
      <div class="widget-grid" id="d-returns"></div>
    </div>
    <div class="card">
      <div class="row spread"><h2>📡 Activity feed</h2><span class="muted small" id="d-feed-note"></span></div>
      <div class="feed" id="d-feed"><span class="muted small">Loading…</span></div>
    </div>`;
  $("#d-toggle").addEventListener("click", onDashToggle);
  $("#d-feed").addEventListener("click", (e) => {
    const el = e.target.closest("[data-tx]");
    if (el) openTx(el.dataset.tx);
  });
  S.dashboardRendered = true;
}

function tile(label, value, sub, cls) {
  return `<div class="tile ${cls || ""}"><div class="t-label">${esc(label)}</div>
    <div class="t-value">${value}</div><div class="t-sub">${esc(sub || "")}</div></div>`;
}

function patchDashboardView() {
  if (!S.dashboardRendered) return;
  const d = S.dashboard;
  if (!d || d.error) {
    if ($("#d-status-text")) $("#d-status-text").textContent = "Can't reach the app";
    return;
  }
  const symbol = d.network.tokenSymbol;
  const running = !!(d.node && d.node.isRunning);
  const dockerOk = d.node && d.node.docker && d.node.docker.ok;

  const dot = $("#d-dot");
  const text = $("#d-status-text");
  const sub = $("#d-status-sub");
  const toggle = $("#d-toggle");
  dot.className = "dot " + (running ? "green" : "red");
  if (running) {
    text.textContent = "● Running";
    text.className = "status-text good-text";
    const op = d.node.op;
    sub.textContent = op && op.running ? `${op.name} in progress…` : `${d.node.runningCount} services · ${d.network.label}`;
    toggle.textContent = "Stop node";
    toggle.className = "btn danger";
    toggle.dataset.action = "stop";
  } else if (!dockerOk) {
    text.textContent = "● Offline";
    text.className = "status-text bad-text";
    sub.textContent = "Docker not ready — finish setup on the Node tab";
    toggle.textContent = "Set up node";
    toggle.className = "btn";
    toggle.dataset.action = "setup";
  } else {
    text.textContent = "● Offline";
    text.className = "status-text bad-text";
    sub.textContent = `Node stopped · ${d.network.label}`;
    toggle.textContent = "Start node";
    toggle.className = "btn primary";
    toggle.dataset.action = "start";
  }
  toggle.disabled = false;

  const syncEl = $("#d-sync");
  const sync = d.sync;
  if (running && sync && !sync.local?.error) {
    const pct = sync.progressPct != null ? sync.progressPct : sync.inSync ? 100 : 0;
    syncEl.innerHTML = `<div class="row spread" style="margin-top:12px">
      <span>${sync.inSync ? '<span class="pill good">in sync</span>' : '<span class="pill warn">syncing</span>'}</span>
      <span class="mono small">${sync.local.height.toLocaleString()}${sync.remote ? " / " + sync.remote.height.toLocaleString() : ""} blocks</span></div>
      <div class="progress" style="margin-top:6px"><div style="width:${Math.min(100, pct).toFixed(1)}%"></div></div>`;
  } else {
    syncEl.innerHTML = "";
  }

  // stat tiles
  const b = d.balances && !d.balances.error ? d.balances : null;
  const st = d.stats && d.stats.available ? d.stats : null;
  const totals = st && st.totals ? st.totals : null;
  const netWorth = b ? (BigInt(b.koin) + BigInt(b.vhp)).toString() : null;
  const tiles = [
    tile(symbol + " liquid", b ? fmtSat(b.koin, 4) : "—", "spendable + mana"),
    tile("VHP", b ? fmtSat(b.vhp, 4) : "—", "producing stake", "accent"),
    tile("Mana", b ? fmtSat(b.mana, 4) : "—", "recharges over time"),
    tile("Net worth", netWorth ? fmtSat(netWorth, 2) : "—", symbol + " + VHP", "accent"),
    tile("Blocks produced", totals ? totals.blocks.toLocaleString() : "—", st && st.syncing ? "counting…" : "lifetime"),
    tile("Total rewards", totals ? fmtSat(totals.rewards, 4) : "—", symbol + " minted", "good"),
    tile("VHP consumed", totals ? fmtSat(totals.vhpConsumed, 4) : "—", "spent producing"),
    tile("Profit", totals ? fmtSat(totals.profit, 4) : "—", "rewards − VHP spent", "good"),
    tile("Total burned", totals ? fmtSat(totals.burned, 4) : "—", symbol + " → VHP"),
    tile("Deposits in", totals ? fmtSat(totals.depositsIn, 4) : "—", symbol + " received"),
  ];
  $("#d-tiles").innerHTML = tiles.join("");

  // profit windows + projected return
  const w = st && st.windows ? st.windows : null;
  const ret = d.returns || null;
  const yearlyCurrent = ret
    ? ret.yearlyReturnPct != null
      ? fmtPct(ret.yearlyReturnPct)
      : fmtSat(ret.yearlyProfitSats, 2) + " " + symbol
    : "—";
  const yearlyCurrentSub =
    ret && ret.yearlyReturnPct != null ? `≈ ${fmtSat(ret.yearlyProfitSats, 0)} ${symbol}/yr` : "at current rate";
  let yearlyReburn = "—";
  let yearlyReburnSub = "enable reburn to compound";
  if (ret && ret.yearlyReturnReburnPct != null) {
    yearlyReburn = fmtPct(ret.yearlyReturnReburnPct);
    yearlyReburnSub = ret.reburnFraction > 0 ? `reburning ${Math.round(ret.reburnFraction * 100)}% of rewards` : "no reburn set";
  } else if (ret && ret.yearlyProfitReburnSats) {
    yearlyReburn = fmtSat(ret.yearlyProfitReburnSats, 2) + " " + symbol;
  }
  const returnTiles = [
    tile("Daily profit", w ? fmtSat(w.last24h, 4) : "—", "last 24h", "good"),
    tile("Weekly profit", w ? fmtSat(w.last7d, 4) : "—", "last 7 days", "good"),
    tile("Monthly profit", w ? fmtSat(w.last30d, 4) : "—", "last 30 days", "good"),
    tile("Yearly return", yearlyCurrent, yearlyCurrentSub, "accent"),
    tile("Yearly + reburn", yearlyReburn, yearlyReburnSub, "accent"),
  ];
  $("#d-returns").innerHTML = returnTiles.join("");
  $("#d-returns-note").textContent = !w
    ? ""
    : st.syncing
      ? "history syncing — longer windows still catching up"
      : w.daysTracked > 0 && w.daysTracked < 30
        ? `based on ${w.daysTracked} day${w.daysTracked === 1 ? "" : "s"} of history`
        : "";

  // feed
  const feedEl = $("#d-feed");
  const note = $("#d-feed-note");
  if (!d.wallet.exists) {
    feedEl.innerHTML = `<span class="muted small">Create a wallet (Wallet tab) to see activity.</span>`;
    note.textContent = "";
  } else if (!st) {
    feedEl.innerHTML = `<span class="muted small">Activity history isn't available on ${esc(d.network.label)} — it needs a history RPC (works on mainnet).</span>`;
    note.textContent = "";
  } else if (!st.feed.length) {
    feedEl.innerHTML = `<span class="muted small">No activity yet. When your node produces a block, it appears here.</span>`;
    note.textContent = st.syncing ? "syncing…" : "";
  } else {
    note.textContent = st.syncing ? "totals still syncing…" : "";
    feedEl.innerHTML = st.feed.map((f) => feedRow(symbol, f)).join("");
  }
  $("#d-updated").textContent = st && st.updatedAt ? "updated " + new Date(st.updatedAt).toLocaleTimeString() : "";
}

function feedRow(symbol, f) {
  if (f.type === "block") {
    return `<div class="feed-row">
      <span class="fr-ico">🧊</span>
      <span class="fr-main">Block <span class="mono">#${f.height.toLocaleString()}</span></span>
      <span class="fr-metric burn">🔥 ${fmtSat(f.vhpBurned, 4)}</span>
      <span class="fr-metric reward">🪙 ${fmtSat(f.reward, 4)}</span>
      <span class="fr-metric profit">💰 ${fmtSat(f.profit, 4)}</span>
      <span class="fr-time">${new Date(f.time).toLocaleTimeString()}</span>
    </div>`;
  }
  const map = {
    deposit: ["📥", "Deposit"],
    burn: ["🔥", "Burned → VHP"],
    sent: ["📤", "Sent out"],
  };
  const [ico, label] = map[f.type] || ["•", f.type];
  return `<div class="feed-row ${f.id ? "link" : ""}" ${f.id ? `data-tx="${esc(f.id)}"` : ""}>
    <span class="fr-ico">${ico}</span>
    <span class="fr-main">${esc(label)}</span>
    <span class="fr-metric">${fmtSat(f.amount, 4)} ${esc(symbol)}</span>
    <span class="fr-time">${f.id ? esc(shortTx(f.id)) : ""}</span>
  </div>`;
}

async function onDashToggle(e) {
  const btn = e.currentTarget;
  const action = btn.dataset.action;
  if (action === "setup") return switchView("node");
  if (action === "start") {
    busyButton(btn, true, "Starting…");
    try {
      await call("node:start", { produce: !!(S.dashboard && S.dashboard.wallet.exists) });
      toast("Node starting…", "good");
    } catch (err) {
      toast(err.message, "bad");
    }
    refreshDashboard();
  } else if (action === "stop") {
    busyButton(btn, true, "Stopping…");
    try {
      await call("node:stop");
      toast("Stopping node…");
    } catch (err) {
      toast(err.message, "bad");
    }
    refreshDashboard();
  }
}

// ---------- wallet view ----------

function renderWalletView() {
  const root = $("#view-wallet");
  const stage = S.walletStage;

  if (stage === "none") {
    root.innerHTML = `
      <h1>Welcome 👋</h1>
      <p class="lead">Set up a Koinos wallet to get started. It takes a few seconds — your key is generated locally and encrypted with a password on this computer.</p>
      <div class="grid-2">
        <div class="card">
          <h2>🆕 Create a new wallet</h2>
          <label class="field"><span>Password (min ${S.appInfo.minPasswordLength} characters)</span>
            <input id="cw-pass" type="password" autocomplete="new-password"></label>
          <label class="field"><span>Confirm password</span>
            <input id="cw-pass2" type="password" autocomplete="new-password"></label>
          <button id="cw-go" class="btn primary">Create wallet</button>
          <p class="hint">You'll be shown a private key backup right after — write it down and keep it safe.</p>
        </div>
        <div class="card">
          <h2>📥 Import an existing wallet</h2>
          <label class="field"><span>Private key (WIF)</span>
            <input id="iw-wif" type="password" class="mono" autocomplete="off"></label>
          <label class="field"><span>New password for this device</span>
            <input id="iw-pass" type="password" autocomplete="new-password"></label>
          <button id="iw-go" class="btn">Import wallet</button>
          <p class="hint">The key is encrypted with your password and stored only on this machine.</p>
        </div>
      </div>`;
    $("#cw-go").addEventListener("click", onCreateWallet);
    $("#iw-go").addEventListener("click", onImportWallet);
    return;
  }

  if (stage === "locked") {
    root.innerHTML = `
      <h1>Unlock your wallet</h1>
      <p class="lead">Wallet <span class="mono">${esc(S.wallet.address ?? "")}</span></p>
      <div class="card" style="max-width:420px">
        <label class="field"><span>Password</span>
          <input id="uw-pass" type="password" autocomplete="current-password"></label>
        <button id="uw-go" class="btn primary">Unlock</button>
        <p class="hint">Unlocking is required to burn, send, register the producer key, and for automatic reward returns.</p>
      </div>`;
    const go = () => onUnlock();
    $("#uw-go").addEventListener("click", go);
    $("#uw-pass").addEventListener("keydown", (e) => e.key === "Enter" && go());
    $("#uw-pass").focus();
    return;
  }

  // unlocked
  root.innerHTML = `
    <div class="row spread">
      <h1>Wallet</h1>
      <div class="row">
        <button id="w-send" class="btn">Send</button>
        <button id="w-lock" class="btn ghost">🔒 Lock</button>
      </div>
    </div>
    <p class="lead">Your address — share it to receive ${esc(sym())} or VHP.</p>
    <div class="card">
      <div class="row">
        <div class="addr" style="flex:1">${esc(S.wallet.address)}</div>
        <button id="w-copy" class="btn">Copy</button>
        ${net().explorer ? '<button id="w-explore" class="btn ghost">Explorer ↗</button>' : ""}
      </div>
    </div>
    <div class="grid-3">
      <div class="stat"><div class="label">${esc(sym())} (liquid)</div><div class="value" id="bal-koin">…</div><div class="sub">spendable + fuels mana</div></div>
      <div class="stat"><div class="label">VHP</div><div class="value" id="bal-vhp">…</div><div class="sub">virtual hash power for block production</div></div>
      <div class="stat"><div class="label">Mana</div><div class="value" id="bal-mana">…</div><div class="sub">recharges over time, spent by transactions</div></div>
    </div>
    <p class="muted" id="bal-note" style="margin-top:8px"></p>
    <div class="card">
      <div class="row spread"><h2 style="margin:0">⟠ Ethereum &amp; USDT</h2><span class="pill">funding wallet</span></div>
      <p class="hint">Your Ethereum funding address, derived from this same wallet key. Receive ETH or USDT here to fund the node, or send them back out.</p>
      <div class="row" style="gap:8px;align-items:center">
        <div class="addr" id="w-eth-addr" style="flex:1">…</div>
        <button id="w-eth-copy" class="btn">Copy</button>
      </div>
      <div class="banner warn" style="margin-top:10px">Send only <b>ETH or USDT on Ethereum Mainnet</b> to this address. Other networks/tokens may be lost.</div>
      <div class="grid-3" style="margin-top:12px">
        <div class="stat"><div class="label">ETH</div><div class="value" id="w-eth-bal">…</div><div class="sub"><button id="w-eth-send" class="btn ghost" style="padding:4px 12px">Send ETH</button></div></div>
        <div class="stat"><div class="label">USDT</div><div class="value" id="w-usdt-bal">…</div><div class="sub"><button id="w-usdt-send" class="btn ghost" style="padding:4px 12px">Send USDT</button></div></div>
        <div class="stat"><div class="label">vKOIN</div><div class="value" id="w-vkoin-bal">…</div><div class="sub row" style="gap:6px;justify-content:center"><button id="w-vkoin-send" class="btn ghost" style="padding:4px 10px">Send</button><button id="w-vkoin-bridge" class="btn" style="padding:4px 10px">Bridge→KOIN</button></div></div>
      </div>
      <p class="hint" style="margin-top:8px">vKOIN bridges 1:1 to native KOIN. Use <b>Bridge→KOIN</b> to rescue vKOIN that a funding run left in this address.</p>
    </div>`;
  $("#w-lock").addEventListener("click", async () => {
    await call("wallet:lock");
    toast("Wallet locked");
    refreshWallet();
  });
  $("#w-copy").addEventListener("click", async () => {
    await call("util:copy", { text: S.wallet.address });
    toast("Address copied");
  });
  $("#w-explore")?.addEventListener("click", () =>
    call("util:openExternal", { url: net().explorer.address + S.wallet.address }).catch(() => {})
  );
  $("#w-send").addEventListener("click", openSendModal);
  const ea = S.wallet.ethAddress || "";
  $("#w-eth-addr").textContent = ea || "(unavailable)";
  $("#w-eth-copy").addEventListener("click", async () => { await call("util:copy", { text: ea }); toast("ETH address copied"); });
  $("#w-eth-send").addEventListener("click", openEthSendModal);
  $("#w-usdt-send").addEventListener("click", openUsdtSendModal);
  $("#w-vkoin-send").addEventListener("click", openVkoinSendModal);
  $("#w-vkoin-bridge").addEventListener("click", onBridgeVkoin);
  patchBalances();
  refreshBalances(true);
  refreshCryptoBalances();
}

async function refreshCryptoBalances() {
  const setb = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  try {
    const r = await call("fund:cryptoBalances");
    const addrEl = document.getElementById("w-eth-addr");
    if (addrEl && r.address) addrEl.textContent = r.address;
    setb("w-eth-bal", Number(r.eth).toLocaleString(undefined, { maximumFractionDigits: 6 }));
    setb("w-usdt-bal", Number(r.usdt).toLocaleString(undefined, { maximumFractionDigits: 2 }));
    setb("w-vkoin-bal", Number(r.vkoin).toLocaleString(undefined, { maximumFractionDigits: 4 }));
  } catch {
    setb("w-eth-bal", "—");
    setb("w-usdt-bal", "—");
    setb("w-vkoin-bal", "—");
  }
}

// Send-ETH / Send-USDT modals (funding wallet withdrawals).
function openEthSendModal() {
  showModal({
    title: "Send ETH",
    body: `
      <label class="field"><span>Recipient Ethereum address</span>
        <input id="es-to" type="text" class="mono" placeholder="0x…" autocomplete="off" spellcheck="false"></label>
      <label class="field"><span>Amount (ETH)</span>
        <div class="row" style="gap:8px">
          <input id="es-amt" type="number" min="0" step="0.001" class="mono" placeholder="0.01" style="max-width:200px">
          <button id="es-max" class="btn ghost" style="padding:6px 12px">Max</button>
        </div></label>
      <div id="es-quote" class="hint" style="min-height:18px"></div>`,
    actions: [
      { label: "Cancel", onClick: (close) => close() },
      {
        label: "Send ETH", class: "primary",
        onClick: async (close, modal) => {
          const to = $("#es-to", modal).value.trim();
          const amt = $("#es-amt", modal).value.trim();
          if (!to || !Number(amt)) return toast("Enter a recipient and amount", "bad");
          const btn = $$(".btn.primary", modal).pop();
          busyButton(btn, true, "Sending…");
          try {
            const res = await call("fund:ethSend", { toAddress: to, amountEth: amt });
            close();
            toast(`Sent — tx ${res.hash.slice(0, 12)}…`, "good", 8000);
            refreshCryptoBalances();
          } catch (e) { toast(e.message, "bad", 9000); busyButton(btn, false); }
        },
      },
    ],
    onMount: (modal) => {
      const to = $("#es-to", modal), amt = $("#es-amt", modal), q = $("#es-quote", modal);
      let t = null;
      const quote = async () => {
        if (!Number(amt.value) || !to.value.trim()) { q.textContent = ""; return; }
        q.textContent = "Getting quote…";
        try {
          const r = await call("fund:ethSendQuote", { toAddress: to.value.trim(), amountEth: amt.value });
          q.innerHTML = r.sufficient
            ? `Gas ~${esc(Number(r.gasCostEth).toFixed(5))} ETH · balance ${esc(Number(r.balanceEth).toFixed(5))} ETH`
            : `<span style="color:var(--bad)">Not enough ETH for amount + gas (balance ${esc(Number(r.balanceEth).toFixed(5))})</span>`;
        } catch (e) { q.innerHTML = `<span style="color:var(--bad)">${esc(e.message)}</span>`; }
      };
      const deb = () => { clearTimeout(t); t = setTimeout(quote, 500); };
      to.addEventListener("input", deb); amt.addEventListener("input", deb);
      $("#es-max", modal).addEventListener("click", async () => {
        try {
          const r = await call("fund:ethSendMax", { toAddress: to.value.trim() });
          const m = Math.floor(Number(r.maxEth) * 1e6) / 1e6;
          if (!(m > 0)) return toast("Not enough ETH (after gas)", "bad");
          amt.value = String(m); quote();
        } catch (e) { toast(e.message, "bad"); }
      });
    },
  });
}

function openUsdtSendModal() {
  showModal({
    title: "Send USDT",
    body: `
      <label class="field"><span>Recipient Ethereum address</span>
        <input id="us-to" type="text" class="mono" placeholder="0x…" autocomplete="off" spellcheck="false"></label>
      <label class="field"><span>Amount (USDT)</span>
        <div class="row" style="gap:8px">
          <input id="us-amt" type="number" min="0" step="1" class="mono" placeholder="10" style="max-width:200px">
          <button id="us-max" class="btn ghost" style="padding:6px 12px">Max</button>
        </div></label>
      <div id="us-quote" class="hint" style="min-height:18px"></div>
      <p class="small muted">Gas is paid in ETH — keep a little ETH in this address.</p>`,
    actions: [
      { label: "Cancel", onClick: (close) => close() },
      {
        label: "Send USDT", class: "primary",
        onClick: async (close, modal) => {
          const to = $("#us-to", modal).value.trim();
          const amt = $("#us-amt", modal).value.trim();
          if (!to || !Number(amt)) return toast("Enter a recipient and amount", "bad");
          const btn = $$(".btn.primary", modal).pop();
          busyButton(btn, true, "Sending…");
          try {
            const res = await call("fund:usdtSend", { toAddress: to, amountUsdt: amt });
            close();
            toast(`Sent — tx ${res.hash.slice(0, 12)}…`, "good", 8000);
            refreshCryptoBalances();
          } catch (e) { toast(e.message, "bad", 9000); busyButton(btn, false); }
        },
      },
    ],
    onMount: (modal) => {
      const to = $("#us-to", modal), amt = $("#us-amt", modal), q = $("#us-quote", modal);
      let t = null;
      const quote = async () => {
        if (!Number(amt.value) || !to.value.trim()) { q.textContent = ""; return; }
        q.textContent = "Getting quote…";
        try {
          const r = await call("fund:usdtSendQuote", { toAddress: to.value.trim(), amountUsdt: amt.value });
          if (r.sufficientUsdt && r.sufficientGas) {
            q.innerHTML = `Gas ~${esc(Number(r.gasCostEth).toFixed(5))} ETH · USDT balance ${esc(Number(r.usdtBalance).toFixed(2))}`;
          } else {
            q.innerHTML = `<span style="color:var(--bad)">${r.sufficientUsdt ? "" : "Not enough USDT. "}${r.sufficientGas ? "" : "Not enough ETH for gas."}</span>`;
          }
        } catch (e) { q.innerHTML = `<span style="color:var(--bad)">${esc(e.message)}</span>`; }
      };
      const deb = () => { clearTimeout(t); t = setTimeout(quote, 500); };
      to.addEventListener("input", deb); amt.addEventListener("input", deb);
      $("#us-max", modal).addEventListener("click", async () => {
        try {
          const r = await call("fund:usdtSendMax");
          const m = Math.floor(Number(r.maxUsdt) * 100) / 100;
          if (!(m > 0)) return toast("No USDT balance", "bad");
          amt.value = String(m); quote();
        } catch (e) { toast(e.message, "bad"); }
      });
    },
  });
}

function openVkoinSendModal() {
  showModal({
    title: "Send vKOIN",
    body: `
      <label class="field"><span>Recipient Ethereum address</span>
        <input id="vs-to" type="text" class="mono" placeholder="0x…" autocomplete="off" spellcheck="false"></label>
      <label class="field"><span>Amount (vKOIN)</span>
        <div class="row" style="gap:8px">
          <input id="vs-amt" type="number" min="0" step="0.0001" class="mono" placeholder="100" style="max-width:200px">
          <button id="vs-max" class="btn ghost" style="padding:6px 12px">Max</button>
        </div></label>
      <div id="vs-quote" class="hint" style="min-height:18px"></div>
      <p class="small muted">Gas is paid in ETH — keep a little ETH in this address.</p>`,
    actions: [
      { label: "Cancel", onClick: (close) => close() },
      {
        label: "Send vKOIN", class: "primary",
        onClick: async (close, modal) => {
          const to = $("#vs-to", modal).value.trim();
          const amt = $("#vs-amt", modal).value.trim();
          if (!to || !Number(amt)) return toast("Enter a recipient and amount", "bad");
          const btn = $$(".btn.primary", modal).pop();
          busyButton(btn, true, "Sending…");
          try {
            const res = await call("fund:vkoinSend", { toAddress: to, amountVkoin: amt });
            close();
            toast(`Sent — tx ${res.hash.slice(0, 12)}…`, "good", 8000);
            refreshCryptoBalances();
          } catch (e) { toast(e.message, "bad", 9000); busyButton(btn, false); }
        },
      },
    ],
    onMount: (modal) => {
      const to = $("#vs-to", modal), amt = $("#vs-amt", modal), q = $("#vs-quote", modal);
      let t = null;
      const quote = async () => {
        if (!Number(amt.value) || !to.value.trim()) { q.textContent = ""; return; }
        q.textContent = "Getting quote…";
        try {
          const r = await call("fund:vkoinSendQuote", { toAddress: to.value.trim(), amountVkoin: amt.value });
          if (r.sufficientVkoin && r.sufficientGas) {
            q.innerHTML = `Gas ~${esc(Number(r.gasCostEth).toFixed(5))} ETH · vKOIN balance ${esc(Number(r.vkoinBalance).toFixed(4))}`;
          } else {
            q.innerHTML = `<span style="color:var(--bad)">${r.sufficientVkoin ? "" : "Not enough vKOIN. "}${r.sufficientGas ? "" : "Not enough ETH for gas."}</span>`;
          }
        } catch (e) { q.innerHTML = `<span style="color:var(--bad)">${esc(e.message)}</span>`; }
      };
      const deb = () => { clearTimeout(t); t = setTimeout(quote, 500); };
      to.addEventListener("input", deb); amt.addEventListener("input", deb);
      $("#vs-max", modal).addEventListener("click", async () => {
        try {
          const r = await call("fund:vkoinSendMax");
          const m = Math.floor(Number(r.maxVkoin) * 10000) / 10000;
          if (!(m > 0)) return toast("No vKOIN balance", "bad");
          amt.value = String(m); quote();
        } catch (e) { toast(e.message, "bad"); }
      });
    },
  });
}

// Rescue vKOIN sitting in the funding address by bridging it to native KOIN.
function onBridgeVkoin() {
  const cur = document.getElementById("w-vkoin-bal");
  const prefill = cur && /^[\d.,]+$/.test(cur.textContent) ? cur.textContent.replace(/,/g, "") : "";
  showModal({
    title: "Bridge vKOIN → KOIN",
    body: `
      <p class="small">Bridges vKOIN from your funding address to <b>native KOIN</b> (1:1) via Vortex. Needs a little ETH for gas. Runs a couple of transactions and auto-advances.</p>
      <label class="field"><span>Amount (vKOIN)</span>
        <div class="row" style="gap:8px">
          <input id="bv-amt" type="number" min="0" step="0.0001" class="mono" value="${esc(prefill)}" placeholder="0" style="max-width:200px">
          <button id="bv-max" class="btn ghost" style="padding:6px 12px">Max</button>
        </div></label>`,
    actions: [
      { label: "Cancel", onClick: (close) => close() },
      {
        label: "Bridge to KOIN", class: "primary",
        onClick: async (close, modal) => {
          const amt = $("#bv-amt", modal).value.trim();
          if (!Number(amt)) return toast("Enter a vKOIN amount", "bad");
          const btn = $$(".btn.primary", modal).pop();
          busyButton(btn, true, "Starting…");
          try {
            await call("fund:routeCStart", { source: "vkoin", amountVkoin: amt });
            close();
            toast("Bridging vKOIN → KOIN — see progress in the Fund tab", "good", 8000);
            switchView("fund");
            refreshFundJobs();
          } catch (e) { toast(e.message, "bad", 9000); busyButton(btn, false); }
        },
      },
    ],
    onMount: (modal) => {
      $("#bv-max", modal).addEventListener("click", async () => {
        try {
          const r = await call("fund:vkoinSendMax");
          const m = Math.floor(Number(r.maxVkoin) * 10000) / 10000;
          if (!(m > 0)) return toast("No vKOIN balance", "bad");
          $("#bv-amt", modal).value = String(m);
        } catch (e) { toast(e.message, "bad"); }
      });
    },
  });
}

function patchBalances() {
  const b = S.balances;
  const setText = (id, v) => { const e = $(id); if (e) e.textContent = v; };
  if (!b || b.error) {
    setText("#bal-koin", "—"); setText("#bal-vhp", "—"); setText("#bal-mana", "—");
    const note = $("#bal-note");
    if (note) note.textContent = b?.error ? `RPC error: ${b.error}` : "";
  } else {
    setText("#bal-koin", fmtSat(b.koin, 4));
    setText("#bal-vhp", fmtSat(b.vhp, 4));
    setText("#bal-mana", fmtSat(b.mana, 4));
    const note = $("#bal-note");
    if (note) note.textContent = `Updated ${new Date(S.balancesAt).toLocaleTimeString()}`;
  }
  patchBurnBalances();
}

async function onCreateWallet() {
  const pass = $("#cw-pass").value;
  const pass2 = $("#cw-pass2").value;
  if (pass !== pass2) return toast("Passwords don't match", "bad");
  const btn = $("#cw-go");
  busyButton(btn, true, "Creating…");
  try {
    const { address, wif } = await call("wallet:create", { password: pass });
    showBackupModal(address, wif);
    await refreshWallet();
  } catch (e) {
    toast(e.message, "bad");
  } finally {
    busyButton(btn, false);
  }
}

function showBackupModal(address, wif) {
  showModal({
    title: "🔑 Back up your private key now",
    body: `
      <p class="small">This is the only time it will be shown automatically. Anyone with this key controls the wallet — write it down and store it offline.</p>
      <div class="wif-box">${esc(wif)}</div>
      <p class="small muted">Address: <span class="mono">${esc(address)}</span></p>`,
    actions: [
      { label: "Copy key", onClick: async () => { await call("util:copy", { text: wif }); toast("Private key copied — clear your clipboard after saving it", "warn"); } },
      { label: "I saved my key", class: "primary", required: true, onClick: (close) => close() },
    ],
  });
}

async function onImportWallet() {
  const wif = $("#iw-wif").value.trim();
  const pass = $("#iw-pass").value;
  const btn = $("#iw-go");
  busyButton(btn, true, "Importing…");
  try {
    const { address } = await call("wallet:import", { wif, password: pass });
    toast(`Wallet imported: ${address}`, "good");
    await refreshWallet();
  } catch (e) {
    toast(e.message, "bad");
  } finally {
    busyButton(btn, false);
  }
}

async function onUnlock() {
  const btn = $("#uw-go");
  busyButton(btn, true, "Unlocking…");
  try {
    await call("wallet:unlock", { password: $("#uw-pass").value });
    toast("Wallet unlocked", "good");
    await refreshWallet();
  } catch (e) {
    toast(e.message, "bad");
    busyButton(btn, false);
  }
}

function openSendModal() {
  showModal({
    title: "Send tokens",
    body: `
      <label class="field"><span>Token</span>
        <select id="s-token"><option value="koin">${esc(sym())}</option><option value="vhp">VHP</option></select></label>
      <label class="field"><span>Recipient address</span>
        <input id="s-to" type="text" class="mono" placeholder="1…"></label>
      <label class="field"><span>Amount</span>
        <input id="s-amount" type="text" class="mono" placeholder="0.0"></label>
      <p class="small muted">Transactions consume mana (not a fee — it recharges).</p>`,
    actions: [
      { label: "Cancel", onClick: (close) => close() },
      {
        label: "Send", class: "primary",
        onClick: async (close, modal) => {
          const btn = $$(".btn.primary", modal).pop();
          busyButton(btn, true, "Sending…");
          try {
            const res = await call("chain:send", {
              to: $("#s-to", modal).value.trim(),
              amount: $("#s-amount", modal).value.trim(),
              token: $("#s-token", modal).value,
            });
            close();
            txToast(res, "Transfer");
            refreshBalances(true);
          } catch (e) {
            toast(e.message, "bad");
            busyButton(btn, false);
          }
        },
      },
    ],
  });
}

function txToast(res, label) {
  const div = document.createElement("div");
  div.className = "toast good";
  div.innerHTML = `${esc(label)} ${res.confirmed ? "confirmed" : "submitted"} · <button class="link">${esc(shortTx(res.txId))} ↗</button>`;
  $("button", div).addEventListener("click", () => openTx(res.txId));
  $("#toasts").appendChild(div);
  setTimeout(() => div.remove(), 9000);
}

// ---------- burn view ----------

function renderBurnView() {
  const root = $("#view-burn");
  if (S.walletStage !== "unlocked") {
    root.innerHTML = `
      <h1>Burn ${esc(sym())} → VHP</h1>
      <p class="lead">Burning converts liquid ${esc(sym())} into Virtual Hash Power (VHP) — the stake that lets your node produce blocks and earn rewards.</p>
      <div class="banner info">${S.walletStage === "none" ? "Create a wallet first (Wallet tab)." : "Unlock your wallet to burn (Wallet tab)."}</div>`;
    return;
  }
  root.innerHTML = `
    <h1>Burn ${esc(sym())} → VHP</h1>
    <p class="lead">Burning converts liquid ${esc(sym())} into VHP 1:1. VHP is consumed slowly while producing blocks, and you earn ${esc(sym())} rewards in return.</p>
    <div class="grid-2">
      <div class="card">
        <h2>🔥 Burn</h2>
        <div class="row" style="margin-bottom:8px">
          <span class="muted">Balance:</span> <span class="mono" id="burn-koin">…</span>
          <span class="muted" style="margin-left:12px">VHP:</span> <span class="mono" id="burn-vhp">…</span>
        </div>
        <label class="field"><span>Amount to burn (${esc(sym())})</span>
          <div class="row">
            <input id="burn-amount" type="text" class="mono" placeholder="0.0" style="flex:1">
            <button id="burn-max" class="btn ghost">Max</button>
          </div>
        </label>
        <div class="muted" id="burn-est" style="margin-bottom:12px">You will receive: —</div>
        <div id="burn-warn"></div>
        <button id="burn-go" class="btn primary">Burn ${esc(sym())}</button>
      </div>
      <div class="card">
        <h2>ℹ️ How it works</h2>
        <p class="hint">
          • Proof-of-Burn is Koinos consensus: VHP acts like mining hardware that slowly "depreciates".<br><br>
          • Producing blocks consumes VHP and mints ${esc(sym())} rewards to your wallet — roughly 2% APY network-wide, more per participant when fewer VHP are competing.<br><br>
          • Keep some liquid ${esc(sym())} — mana from liquid balance pays for your transactions (Max leaves ${esc(S.appInfo.settings.keepLiquidKoin)} ${esc(sym())} by default, adjustable in Settings).<br><br>
          • Use the <b>Reward returns</b> tab to automatically re-burn a percentage of rewards and keep your VHP topped up.
        </p>
      </div>
    </div>`;
  patchBurnBalances();
  $("#burn-max").addEventListener("click", async () => {
    try {
      const { maxFormatted, manaLimited } = await call("chain:maxBurn");
      $("#burn-amount").value = maxFormatted;
      updateBurnEstimate();
      if (manaLimited) {
        toast(`Capped to available mana (${maxFormatted} ${sym()}). Mana recharges over ~5 days.`, "info", 6000);
      }
    } catch (e) {
      toast(e.message, "bad");
    }
  });
  $("#burn-amount").addEventListener("input", updateBurnEstimate);
  $("#burn-go").addEventListener("click", onBurn);
}

function patchBurnBalances() {
  const b = S.balances;
  if ($("#burn-koin") && b && !b.error) {
    $("#burn-koin").textContent = `${fmtSat(b.koin, 4)} ${sym()}`;
    $("#burn-vhp").textContent = fmtSat(b.vhp, 4);
  }
}

function updateBurnEstimate() {
  const v = $("#burn-amount").value.trim();
  const est = $("#burn-est");
  const warn = $("#burn-warn");
  warn.innerHTML = "";
  if (!v || !/^\d+(\.\d{1,8})?$/.test(v.replace(/,/g, ""))) {
    est.textContent = "You will receive: —";
    return;
  }
  est.textContent = `You will receive: ${v} VHP`;
  try {
    const sats = toSat(v);
    const bal = BigInt(S.balances?.koin ?? "0");
    const mana = BigInt(S.balances?.mana ?? "0");
    const burnableMana = mana > ONE ? mana - ONE : 0n; // 1 KOIN cushion for tx rc
    const keep = toSatBig(S.appInfo.settings.keepLiquidKoin);
    if (sats > bal) {
      warn.innerHTML = `<div class="banner bad">Amount exceeds your balance.</div>`;
    } else if (sats > burnableMana) {
      // Burning requires mana >= amount on-chain; catch it before the revert.
      warn.innerHTML = `<div class="banner warn">Not enough mana to burn this much right now (about ${fmtSat(burnableMana.toString(), 4)} ${esc(sym())} available). Burning spends mana, which recharges over ~5 days — burn less or wait.</div>`;
    } else if (bal - sats < keep) {
      warn.innerHTML = `<div class="banner warn">This leaves less than ${esc(S.appInfo.settings.keepLiquidKoin)} ${esc(sym())} liquid. You need liquid ${esc(sym())} for mana to keep transacting.</div>`;
    }
  } catch { /* ignore */ }
}

function toSat(v) {
  const [w, f = ""] = String(v).replace(/,/g, "").split(".");
  return BigInt(w || "0") * ONE + BigInt((f.padEnd(8, "0") || "0").slice(0, 8));
}
function toSatBig(v) { try { return toSat(v); } catch { return 0n; } }

function onBurn() {
  const amount = $("#burn-amount").value.trim();
  if (!amount) return toast("Enter an amount to burn", "warn");
  showModal({
    title: "Confirm burn",
    body: `
      <p>You are about to <b>permanently burn</b> <span class="mono">${esc(amount)} ${esc(sym())}</span> and receive <span class="mono">${esc(amount)} VHP</span>.</p>
      <p class="small muted" style="margin-top:8px">VHP is only useful for producing blocks with a node. It converts back to ${esc(sym())} gradually through block rewards.</p>`,
    actions: [
      { label: "Cancel", onClick: (close) => close() },
      {
        label: "Burn", class: "danger",
        onClick: async (close, modal) => {
          const btn = $$(".btn.danger", modal).pop();
          busyButton(btn, true, "Burning…");
          try {
            const res = await call("chain:burn", { amount });
            close();
            txToast(res, `Burned ${amount} ${sym()} → VHP.`);
            refreshBalances(true);
          } catch (e) {
            toast(e.message, "bad");
            busyButton(btn, false);
          }
        },
      },
    ],
  });
}

// ---------- node view ----------

function renderNodeView() {
  const root = $("#view-node");
  root.innerHTML = `
    <div class="row spread">
      <h1>Koinos node</h1>
      <div class="row">
        <button id="n-open" class="btn ghost">📁 Data folder</button>
        <button id="n-quicksync" class="btn" style="display:none">⚡ Quick sync</button>
        <button id="n-stop" class="btn">Stop</button>
        <button id="n-start" class="btn primary">Start node</button>
      </div>
    </div>
    <p class="lead">Runs the official Koinos microservices with Docker. First start downloads images and syncs the chain — this can take a while.</p>
    <div id="n-docker"></div>
    <div id="n-op"></div>
    <div class="grid-2">
      <div class="card">
        <h2>📡 Status <span id="n-run-pill"></span></h2>
        <div id="n-health" class="stack"></div>
        <div id="n-sync" class="stack"></div>
        <label class="row small" style="gap:8px;margin-top:10px;cursor:pointer">
          <input type="checkbox" id="n-autorecover" checked>
          <span>Keep my node running automatically <span class="muted">— the app restarts it for you if it ever stops.</span></span>
        </label>
        <div style="margin-top:10px"><table id="n-services"><tbody></tbody></table></div>
      </div>
      <div class="card">
        <h2>⛏️ Block production setup</h2>
        <ul class="checklist" id="n-checklist"></ul>
        <div class="row" style="margin-top:6px">
          <button id="n-register" class="btn">Register signing key</button>
        </div>
        <p class="hint" id="n-reg-hint"></p>
      </div>
    </div>
    <div class="card">
      <div class="row spread">
        <h2>📜 Logs</h2>
        <div class="row">
          <select id="n-log-svc" style="width:auto">
            <option value="">all services</option>
            ${["chain", "p2p", "block_producer", "mempool", "block_store", "jsonrpc", "amqp"]
              .map((s) => `<option value="${s}">${s}</option>`).join("")}
          </select>
          <button id="n-log-refresh" class="btn">Refresh</button>
        </div>
      </div>
      <pre class="logs" id="n-log-out">Press Refresh to load logs.</pre>
    </div>`;

  $("#n-open").addEventListener("click", () => call("util:openPath", { which: "nodeData" }).catch(() => {}));
  $("#n-docker").addEventListener("click", onSetupClick);
  $("#n-start").addEventListener("click", onStartNode);
  $("#n-stop").addEventListener("click", onStopNode);
  $("#n-register").addEventListener("click", onRegisterKey);
  $("#n-autorecover").addEventListener("change", async (e) => {
    const on = e.target.checked;
    await call("node:setAutoRecover", { on }).catch(() => {});
    toast(
      on ? "The app will keep your node running automatically." : "Automatic restart is off — you'll restart the node yourself.",
      on ? "good" : "warn"
    );
  });
  $("#n-log-refresh").addEventListener("click", loadLogs);
  const qsBtn = $("#n-quicksync");
  if (S.appInfo.settings.network === "mainnet") {
    qsBtn.style.display = "";
    qsBtn.addEventListener("click", onQuickSync);
  }
  patchNodeView();
}

function fmtBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return "?";
  if (v >= 1e12) return `${(v / 1e12).toFixed(2)} TB`;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)} GB`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)} MB`;
  return `${Math.round(v / 1e3)} kB`;
}

async function onQuickSync() {
  const btn = $("#n-quicksync");
  busyButton(btn, true, "Checking…");
  let info;
  try {
    info = await call("node:quickSyncInfo");
  } catch (e) {
    busyButton(btn, false);
    return toast(`Quick sync unavailable: ${e.message}`, "bad");
  }
  busyButton(btn, false);
  const lowSpace = info.freeBytes != null && info.freeBytes < info.requiredBytes;
  showModal({
    title: "⚡ Quick sync from official backup",
    body: `
      <p class="small">Downloads the Koinos Foundation chain snapshot and installs it, so the node
      catches up in hours instead of syncing for days. Your wallet, node config, and peer identity are not touched;
      current chain data is set aside for rollback.</p>
      <table style="margin:12px 0">
        <tr><td class="muted small">Snapshot size</td><td class="mono small">${fmtBytes(info.archiveBytes)} (compressed)</td></tr>
        <tr><td class="muted small">Snapshot date</td><td class="mono small">${esc(info.lastModified ?? "unknown")}</td></tr>
        <tr><td class="muted small">Free disk space</td><td class="mono small">${info.freeBytes != null ? fmtBytes(info.freeBytes) : "unknown"} (needs ~${fmtBytes(info.requiredBytes)} during restore)</td></tr>
        ${info.resumeFrom > 0 ? `<tr><td class="muted small">Resumable</td><td class="mono small">${fmtBytes(info.resumeFrom)} already downloaded</td></tr>` : ""}
      </table>
      ${lowSpace ? `<div class="banner warn">Free space looks below the recommended headroom — the restore may fail mid-way. Free up disk first if possible.</div>` : ""}
      ${info.nodeRunning ? `<div class="banner info">The node is running — it will be stopped before the restore and can be started again right after.</div>` : ""}
      <p class="small muted">The download is verified against the published SHA-256 and the archive layout is checked before anything is installed. You can cancel at any time and resume later.</p>`,
    actions: [
      { label: "Cancel", onClick: (close) => close() },
      {
        label: "Start quick sync", class: "primary",
        onClick: async (close) => {
          try {
            await call("node:quickSync");
            close();
            toast("Quick sync started — progress shows on this page", "good");
            refreshNode();
          } catch (e) {
            toast(e.message, "bad");
          }
        },
      },
    ],
  });
}

function onStartNode() {
  const canProduce = S.wallet?.exists;
  showModal({
    title: "Start Koinos node",
    body: `
      <label class="field"><span class="row" style="gap:8px">
        <input type="checkbox" id="ns-produce" ${canProduce ? "checked" : "disabled"} style="width:auto">
        <span>Enable block production (uses your wallet address <span class="mono">${esc(S.wallet?.address ?? "no wallet yet")}</span> as producer)</span>
      </span></label>
      <p class="small muted">The node runs in Docker in the background and keeps running even if you close this app. First sync downloads the whole chain.</p>`,
    actions: [
      { label: "Cancel", onClick: (close) => close() },
      {
        label: "Start", class: "primary",
        onClick: async (close, modal) => {
          const produce = $("#ns-produce", modal)?.checked ?? false;
          try {
            await call("node:start", { produce });
            close();
            toast("Node starting — pulling images and launching services…", "good");
            refreshNode();
          } catch (e) {
            toast(e.message, "bad");
          }
        },
      },
    ],
  });
}

async function onStopNode() {
  try {
    await call("node:stop");
    toast("Stopping node…");
    refreshNode();
  } catch (e) {
    toast(e.message, "bad");
  }
}

async function onRegisterKey() {
  const btn = $("#n-register");
  busyButton(btn, true, "Registering…");
  try {
    const res = await call("producer:register");
    txToast(res, "Producer key registration");
    refreshNode();
  } catch (e) {
    toast(e.message, "bad");
  } finally {
    busyButton(btn, false);
  }
}

async function loadLogs() {
  const out = $("#n-log-out");
  out.textContent = "Loading…";
  try {
    const text = await call("node:logs", { service: $("#n-log-svc").value || undefined, tail: 200 });
    out.textContent = text || "(no output)";
    out.scrollTop = out.scrollHeight;
  } catch (e) {
    out.textContent = `Failed to load logs: ${e.message}`;
  }
}

const SETUP_ICONS = { done: "✅", active: "🔵", pending: "⬜", reboot: "🔁", manual: "🔗" };

function renderSetupCard(n) {
  const setup = n.setup;
  if (!setup) {
    // Detection unavailable — fall back to a simple prompt with a docs link.
    return `<div class="banner bad"><b>Docker isn't available.</b> ${esc(n.docker?.error ?? "")}<br>
      <div class="row" style="margin-top:10px">
        <button class="btn" data-setup-action="openDockerDocs">Docker install guide ↗</button>
      </div></div>`;
  }

  const platLabel = { win32: "Windows", darwin: "macOS", linux: "Linux" }[setup.platform] ?? setup.platform;
  const stepsHtml = setup.steps
    .map((s) => {
      const icon = s.status === "active" ? '<span class="spin"></span>' : SETUP_ICONS[s.status] ?? "•";
      const btn = s.action
        ? `<button class="btn ${s.status === "reboot" ? "danger" : "primary"}" data-setup-action="${esc(s.action.channel.split(":")[1])}">${esc(s.action.label)}</button>`
        : "";
      const altBtn = s.altAction
        ? `<button class="btn ghost" data-setup-action="${esc(s.altAction.channel.split(":")[1])}">${esc(s.altAction.label)}</button>`
        : "";
      const cls = s.status === "done" ? "muted" : "";
      return `<div class="setup-step ${s.status}">
        <div class="setup-ico">${icon}</div>
        <div class="setup-body"><div class="setup-title ${cls}">${esc(s.title)}</div>
          <div class="setup-detail">${esc(s.detail)}</div></div>
        <div class="setup-act">${btn}${altBtn}</div>
      </div>`;
    })
    .join("");

  // Docker download progress (if running).
  const op = setup.op;
  let progressHtml = "";
  if (op?.running && op.name === "docker-download") {
    const p = op.progress ?? {};
    const bytes = p.doneBytes != null ? ` — ${fmtBytes(p.doneBytes)} / ${fmtBytes(p.totalBytes)}` : "";
    progressHtml = `<div class="banner info" style="margin-top:12px">
      <div class="row spread"><span><span class="spin"></span> Downloading Docker Desktop${bytes}</span>
        <button class="btn ghost" style="padding:4px 10px" data-setup-action="cancelInstallDocker">Cancel</button></div>
      <div class="progress" style="margin-top:8px"><div style="width:${p.pct != null ? Math.min(100, p.pct).toFixed(1) : 0}%"></div></div>
    </div>`;
  }

  return `<div class="card setup-card">
    <div class="row spread"><h2>🧰 Set up requirements <span class="muted small">one time · ${esc(platLabel)}</span></h2>
      <button class="btn ghost" data-setup-action="recheck">Re-check</button></div>
    <p class="hint" style="margin-top:0">The Koinos node runs inside Docker. KoinosKit can set everything up for you — just click through the steps. It's all free.</p>
    <div class="setup-steps">${stepsHtml}</div>
    ${progressHtml}
  </div>`;
}

async function onSetupClick(e) {
  const el = e.target.closest("[data-setup-action]");
  if (!el) return;
  const action = el.dataset.setupAction;

  if (action === "recheck") { refreshNode(); return; }
  if (action === "openDockerDocs") { call("setup:openDockerDocs").catch(() => {}); return; }
  if (action === "cancelInstallDocker") {
    await call("setup:cancelInstallDocker").catch(() => {});
    toast("Download cancelled"); refreshNode(); return;
  }

  if (action === "installWsl") {
    busyDelegate(el, "Starting…");
    try {
      await call("setup:installWsl");
      toast("Follow the Windows window to install WSL, then restart when it finishes", "good", 8000);
    } catch (err) { toast(err.message, "bad", 8000); }
    refreshNode();
    return;
  }

  if (action === "markWslReady") {
    busyDelegate(el, "Checking…");
    try {
      const r = await call("setup:markWslReady");
      toast(
        r?.overridden
          ? "Couldn't auto-detect WSL, but continuing as requested. If Docker install fails, restart Windows and try again."
          : "WSL detected — continuing to Docker.",
        r?.overridden ? "warn" : "good",
        7000
      );
    } catch (err) { toast(err.message, "bad"); }
    refreshNode();
    return;
  }

  if (action === "restart") {
    showModal({
      title: "Restart Windows?",
      body: `<p class="small">Windows needs to restart to finish enabling WSL 2. This will restart your computer in 60 seconds — save any open work first. You can cancel during the countdown.</p>`,
      actions: [
        { label: "Not now", onClick: (close) => close() },
        {
          label: "Restart in 60s", class: "danger",
          onClick: async (close) => {
            try {
              await call("setup:restart");
              close();
              const div = document.createElement("div");
              div.className = "toast warn";
              div.innerHTML = `Windows will restart in 60 seconds. <button class="link">Cancel</button>`;
              $("button", div).addEventListener("click", async () => {
                await call("setup:cancelRestart").catch(() => {});
                toast("Restart cancelled", "good");
                div.remove();
              });
              $("#toasts").appendChild(div);
              setTimeout(() => div.remove(), 60000);
            } catch (err) { toast(err.message, "bad"); }
          },
        },
      ],
    });
    return;
  }

  if (action === "installDocker") {
    busyDelegate(el, "Starting…");
    try {
      await call("setup:installDocker");
      toast("Downloading Docker Desktop — progress shows below", "good");
    } catch (err) { toast(err.message, "bad"); }
    refreshNode();
    return;
  }

  if (action === "startDocker") {
    busyDelegate(el, "Starting…");
    try {
      await call("setup:startDocker");
      toast("Starting Docker — this can take a minute on first launch", "good", 7000);
    } catch (err) { toast(err.message, "bad"); }
    refreshNode();
    return;
  }
}

function busyDelegate(el, label) {
  el.disabled = true;
  el.innerHTML = `<span class="spin"></span> ${esc(label)}`;
}

function patchNodeView() {
  if (!$("#n-docker")) return;
  const n = S.node;

  // guided setup card (shown until Docker is usable)
  const dockerEl = $("#n-docker");
  if (n?.docker && !n.docker.ok) {
    dockerEl.innerHTML = renderSetupCard(n);
  } else {
    dockerEl.innerHTML = "";
  }

  // operation progress
  const opEl = $("#n-op");
  const op = n?.op;
  if (op?.running && op.name === "quick-sync") {
    const p = op.progress ?? {};
    const stageLabels = {
      starting: "Starting…", stopping: "Stopping node", download: "Downloading snapshot",
      verify: "Verifying checksum", inspect: "Inspecting archive", extract: "Extracting chain data",
      install: "Installing", cleanup: "Cleaning up", done: "Done",
    };
    const pctText = p.pct != null ? ` — ${p.pct.toFixed(1)}%` : "";
    const bytesText = p.doneBytes != null ? ` (${fmtBytes(p.doneBytes)} / ${fmtBytes(p.totalBytes)})` : "";
    opEl.innerHTML = `<div class="banner info">
      <div class="row spread"><span><span class="spin"></span> <b>Quick sync:</b> ${esc(stageLabels[p.stage] ?? p.stage ?? "working")}${pctText}${bytesText}</span>
      <button id="n-qs-cancel" class="btn ghost" style="padding:4px 10px">Cancel</button></div>
      ${p.pct != null ? `<div class="progress" style="margin-top:8px"><div style="width:${Math.min(100, p.pct).toFixed(1)}%"></div></div>` : ""}
      <span class="mono small">${op.tail.slice(-2).map(esc).join("<br>")}</span></div>`;
    $("#n-qs-cancel")?.addEventListener("click", async () => {
      await call("node:quickSyncCancel").catch(() => {});
      toast("Cancelling quick sync — the download can be resumed later", "warn");
    });
  } else if (op?.running) {
    opEl.innerHTML = `<div class="banner info"><span class="spin"></span> <b>${esc(op.name)}</b> in progress…<br>
      <span class="mono small">${op.tail.slice(-4).map(esc).join("<br>")}</span></div>`;
  } else if (op && op.code !== 0 && op.error) {
    opEl.innerHTML = `<div class="banner bad"><b>${esc(op.name)} failed:</b> ${esc(op.error)}</div>`;
  } else {
    opEl.innerHTML = "";
  }

  // run pill + services
  const pill = $("#n-run-pill");
  if (pill) {
    pill.className = "pill " + (n?.isRunning ? "good" : "warn");
    pill.textContent = n?.isRunning ? `running (${n.runningCount} services)` : "stopped";
  }

  // friendly, jargon-free health line + auto-recover toggle state
  const autoBox = $("#n-autorecover");
  if (autoBox && n?.autoRecover != null) autoBox.checked = n.autoRecover !== false;
  const healthEl = $("#n-health");
  if (healthEl) {
    const h = n?.health;
    const recovered = h?.recoveries ? ` <span class="muted small">(recovered ${h.recoveries}× recently)</span>` : "";
    if (h?.needsRepair) {
      // Corrupted block data — a restart can't fix it. Offer the one-click rebuild.
      healthEl.innerHTML = `<div class="banner bad">
        <b>Your node's block data got corrupted.</b> Restarting won't fix it — it needs to be rebuilt from a verified snapshot. Your wallet, keys and settings are safe, and it takes a few minutes.
        <div style="margin-top:8px"><button id="n-repair" class="btn primary" style="padding:6px 12px">🔧 Repair node data</button></div>
      </div>`;
      $("#n-repair")?.addEventListener("click", onQuickSync);
    } else if (!n?.isRunning) {
      healthEl.innerHTML = "";
    } else if (h?.recovering) {
      healthEl.innerHTML = `<div class="banner info"><span class="spin"></span> Getting your node back up — this takes a minute. You don't need to do anything.</div>`;
    } else if (h?.memorySaver) {
      healthEl.innerHTML = `<div class="banner warn">Running in memory-saver mode to stay stable on this PC — your node is up and earning.${recovered}</div>`;
    } else if (h && h.ok === false) {
      healthEl.innerHTML = `<div class="banner warn">Your node needs attention — the app is taking care of it.</div>`;
    } else if (h) {
      healthEl.innerHTML = `<div class="banner good">✓ Your node is running and healthy.${recovered}</div>`;
    } else {
      healthEl.innerHTML = "";
    }
  }
  const tbody = $("#n-services tbody");
  if (tbody) {
    tbody.innerHTML = (n?.services ?? [])
      .map(
        (s) => `<tr><td class="mono">${esc(s.service)}</td>
          <td><span class="pill ${/running|up/i.test(s.state) ? "good" : "warn"}">${esc(s.state)}</span></td>
          <td class="muted">${esc(s.status)}</td></tr>`
      )
      .join("") || `<tr><td class="muted">No services running.</td></tr>`;
  }

  // sync
  const syncEl = $("#n-sync");
  if (syncEl) {
    const sync = n?.sync;
    if (!n?.isRunning) {
      syncEl.innerHTML = `<span class="muted">Start the node to sync the chain.</span>`;
    } else if (!sync || sync.local?.error) {
      syncEl.innerHTML = `<span class="muted">Waiting for local RPC… (services may still be starting)</span>`;
    } else {
      const pct = sync.progressPct != null ? sync.progressPct : sync.inSync ? 100 : 0;
      syncEl.innerHTML = `
        <div class="row spread">
          <span>${sync.inSync ? '<span class="pill good">in sync</span>' : '<span class="pill warn">syncing</span>'}</span>
          <span class="mono small">${sync.local.height.toLocaleString()}${sync.remote ? " / " + sync.remote.height.toLocaleString() : ""} blocks</span>
        </div>
        <div class="progress"><div style="width:${pct.toFixed(1)}%"></div></div>
        <span class="muted small">Head block time: ${fmtTime(sync.local.headBlockTimeMs)}</span>`;
    }
  }

  // checklist
  const p = S.producer;
  const checklist = $("#n-checklist");
  if (checklist) {
    // VHP is public on-chain stake read from your address — it loads while the
    // wallet is LOCKED. Distinguish "still checking" from a real zero so the list
    // never claims you have no VHP when it simply hasn't looked yet (the node
    // produces blocks whether or not the app wallet is unlocked).
    const balLoaded = S.balances && !S.balances.error;
    const hasVhp = balLoaded && BigInt(S.balances.vhp ?? "0") > 0n;
    const vhpState = hasVhp ? "ok" : balLoaded ? "empty" : "pending";
    const st = (ok) => (ok ? "ok" : "empty");
    const items = [
      [st(S.wallet?.exists), "Wallet created", "Create one in the Wallet tab."],
      [
        vhpState,
        "VHP staked at your address",
        vhpState === "pending"
          ? "Checking your VHP… no need to unlock — it's read from your public address."
          : `Burn some ${sym()} in the Burn tab — VHP is your block-producing stake.`,
      ],
      [st(n?.isRunning), "Node running", "Start the node above."],
      [st(!!p?.filePublicKey), "Signing key generated", "Generated automatically by the node on first start."],
      [st(!!p?.matches), "Signing key registered on chain", "Register it with the button below (needs unlocked wallet + mana)."],
    ];
    const tickFor = (s) => (s === "ok" ? "✅" : s === "pending" ? "⏳" : "⬜");
    checklist.innerHTML = items
      .map(
        ([state, label, hint]) => `<li><span class="tick">${tickFor(state)}</span>
          <span>${esc(label)}${state === "ok" ? "" : `<br><span class="muted small">${esc(hint)}</span>`}</span></li>`
      )
      .join("");
    const reg = $("#n-register");
    const regHint = $("#n-reg-hint");
    const canRegister = !!p?.filePublicKey && S.walletStage === "unlocked" && !p?.matches;
    reg.disabled = !canRegister;
    if (p?.matches) {
      regHint.textContent = "✅ Registered — your node signs blocks with this key. Rewards arrive at your wallet address.";
    } else if (p?.registeredPublicKey && p?.filePublicKey && !p.matches) {
      regHint.textContent = "⚠️ A different key is registered on chain for this address. Register the current node key to replace it.";
    } else if (!p?.filePublicKey) {
      regHint.textContent = "The signing key appears after the node's first start.";
    } else if (S.walletStage !== "unlocked") {
      regHint.textContent = "Unlock your wallet to register.";
    } else {
      regHint.textContent = "";
    }
  }
}

// ---------- fund view ----------

let FUND = { ethAddress: null, onrampEndpoint: "", onrampConfigured: false };

function renderFundView() {
  const root = $("#view-fund");
  root.innerHTML = `
    <h1>Fund node</h1>
    <p class="lead">Buy ETH into an address the app generates for you, then bridge it to Koinos and swap to KOIN — all in-app. Mana for the Koinos steps is sponsored, so you don't need any KOIN to start.</p>
    <div class="grid-2">
      <div class="card">
        <h2>① Your Ethereum funding address</h2>
        <div id="fund-addr-wrap"><p class="muted">Loading…</p></div>
        <div class="banner warn" style="margin-top:12px">Send only <b>ETH on Ethereum Mainnet</b> here. Funds on other networks or other tokens may be lost.</div>
        <p class="hint">Derived from your Koinos wallet key — your existing private-key backup recovers this ETH address too, so there's no second thing to back up.</p>
      </div>
      <div class="card">
        <h2>② Buy ETH with Coinbase</h2>
        <div id="fund-buy-wrap"><p class="muted">Loading…</p></div>
      </div>
    </div>
    <div class="card">
      <h2>⚙️ Coinbase Onramp endpoint <span class="muted small">advanced · optional</span></h2>
      <p class="hint">Buying ETH with Coinbase works out of the box — nothing to set up. This only lets advanced users route purchases through their own Coinbase (CDP) endpoint instead of the built-in one. Leave blank to use the default.</p>
      <label class="field"><span>Custom endpoint URL (https)</span>
        <input id="fund-endpoint" type="text" class="mono" placeholder="Default: ${esc(FUND.onrampDefault || "built-in")}" value="${esc(FUND.onrampEndpoint || "")}"></label>
      <div class="row">
        <button id="fund-endpoint-save" class="btn primary">Save</button>
        <button class="btn ghost" data-ext="https://github.com/therexdev/free-koinos-node/blob/HEAD/docs/coinbase-onramp.md">Self-host guide ↗</button>
      </div>
    </div>
    <div class="card">
      <div class="row spread"><h2 style="margin:0">🚀 Fund your node</h2><span class="pill warn">beta</span></div>
      <p class="hint">Enter an amount of ETH — we price <b>both</b> routes and put the best on top, each with its own button. <b>Route&nbsp;C</b> swaps to vKOIN on Uniswap and bridges it 1:1 to native KOIN (usually far more KOIN); <b>Route&nbsp;B</b> is the classic Vortex + KoinDX path. Mana for the Koinos steps is sponsored. Real funds through an unaudited bridge — <b>start small</b> (max 0.05 ETH).</p>
      <div id="fund-unified-body"><p class="muted">Loading…</p></div>
    </div>
    <div class="card">
      <div class="row spread"><h2 style="margin:0">💵 Fund with USDT</h2><span class="pill warn">beta</span></div>
      <p class="hint">Already hold USDT at your funding address? Skip the ETH swap — this goes USDT → vKOIN → native KOIN directly (you still need a little ETH for gas). Max $150 worth.</p>
      <div id="fund-usdt-body"><p class="muted">Loading…</p></div>
    </div>`;

  $("#fund-endpoint-save").addEventListener("click", onSaveOnrampEndpoint);
  $$("[data-ext]", root).forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      call("util:openExternal", { url: a.dataset.ext }).catch(() => {});
    })
  );
  refreshFund();
}

async function refreshFund() {
  try {
    FUND = await call("fund:status");
  } catch {
    /* keep last */
  }
  patchFundView();
  refreshFundJobs();
}

// ---- unified funding: price both routes, pick one; plus USDT funding ----
async function refreshFundJobs() {
  try { BRIDGEJOB = await call("fund:bridgeStatus"); } catch { /* keep last */ }
  try { ROUTECJOB = await call("fund:routeCStatus"); } catch { /* keep last */ }
  patchFundUnified();
  patchUsdtFund();
}

function isTerminal(j) { return !j || ["done", "error"].includes(j.status); }
function anyFundingActive() {
  return !!((BRIDGEJOB && !isTerminal(BRIDGEJOB)) || (ROUTECJOB && !isTerminal(ROUTECJOB)));
}

const BRIDGE_PHASES = ["Deposit ETH into the bridge", "Wait for guardians", "Redeem to vETH", "Swap vETH → KOIN"];
function bridgePhaseIdx(status) { return BRIDGE_ORDER.indexOf(status); }

function fundDoneBanner(route, koin) {
  return `<div class="banner good">✅ ${esc(route)} complete — received ~<b>${esc(fmtKoin(koin))} KOIN</b>. Check the Wallet tab.</div>`;
}
function fundErrorBanner(route, job, safeNote) {
  const where = job.failedAt ? ` (at ${esc(job.failedAt)})` : "";
  return `<div class="banner bad">${esc(route)} stopped${where}: ${esc(job.error || "unknown error")}${safeNote ? `<br><span class="small">${esc(safeNote)}</span>` : ""}</div>`;
}

// Route C shows only the phases its source actually runs (vKOIN skips both swaps,
// USDT skips the ETH swap).
function routeCView(job) {
  const src = job.source || "eth";
  const ALL = [
    { label: "Swap ETH → USDT", states: ["swap_eth_usdt"] },
    { label: "Swap USDT → vKOIN", states: ["approve_permit2", "approve_ur", "swap_usdt_vkoin"] },
    { label: "Bridge vKOIN → Koinos", states: ["approve_bridge", "bridge_token", "awaiting_signatures"] },
    { label: "Redeem to native KOIN", states: ["redeeming"] },
  ];
  const phases = src === "vkoin" ? ALL.slice(2) : src === "usdt" ? ALL.slice(1) : ALL;
  let idx = phases.findIndex((p) => p.states.includes(job.status));
  if (job.status === "done") idx = phases.length;
  if (idx < 0) idx = 0;
  return { labels: phases.map((p) => p.label), idx };
}

function fundProgress(kind, job) {
  let labels, idx, title;
  if (kind === "bridge") {
    labels = BRIDGE_PHASES; idx = bridgePhaseIdx(job.status); title = "Route B";
  } else {
    const v = routeCView(job); labels = v.labels; idx = v.idx;
    title = job.source === "vkoin" ? "vKOIN → KOIN" : job.source === "usdt" ? "USDT funding" : "Route C";
  }
  const steps = labels.map((label, i) => {
    const ico = i < idx ? "✅" : i === idx ? '<span class="spin"></span>' : "⬜";
    return `<div class="row" style="gap:8px;align-items:center"><span>${ico}</span><span class="${i === idx ? "" : "muted"}">${esc(label)}</span></div>`;
  }).join("");
  const tx = job.pendingTx ? `<div class="small muted" style="margin-top:6px">Waiting on tx ${esc(String(job.pendingTx).slice(0, 12))}…</div>` : "";
  const attempts = job.redeemAttempts ? `<div class="small muted" style="margin-top:6px">Retrying redeem (nonce) — attempt ${esc(String(job.redeemAttempts))}…</div>` : "";
  return `<div style="margin-top:4px"><b>${esc(title)}</b> running…</div>
    <div style="display:flex;flex-direction:column;gap:6px;margin-top:6px">${steps}</div>${tx}${attempts}
    <p class="hint" style="margin-top:10px">Keep the app open and unlocked. Auto-advances; resumes if interrupted.</p>`;
}

function patchFundUnified() {
  const el = document.getElementById("fund-unified-body");
  if (!el) return;
  const b = BRIDGEJOB, c = ROUTECJOB;
  const active = (b && !isTerminal(b)) ? { kind: "bridge", job: b }
    : (c && !isTerminal(c) && c.source !== "usdt") ? { kind: "routeC", job: c } : null;
  const sig = `${b?.status || "-"}|${b?.pendingTx || ""}|${c?.status || "-"}|${c?.source || ""}|${c?.pendingTx || ""}`;
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;

  if (active) {
    el.innerHTML = fundProgress(active.kind, active.job);
    return;
  }

  let banner = "";
  if (b && b.status === "done") banner += fundDoneBanner("Route B", b.koinReceived);
  else if (b && b.status === "error") banner += fundErrorBanner("Route B", b, b.ethTxHash ? "Your ETH deposit is safe — retry to resume." : "");
  if (c && c.source !== "usdt" && c.status === "done") banner += fundDoneBanner("Route C", c.koinReceived);
  else if (c && c.source !== "usdt" && c.status === "error") banner += fundErrorBanner("Route C", c, "Funds are safe as ETH / USDT / vKOIN.");
  const usdtBusy = c && !isTerminal(c) && c.source === "usdt";

  const ctl = [];
  if (b && b.status === "error") ctl.push('<button class="btn" data-act="b-retry">Retry Route B</button>', '<button class="btn ghost" data-act="b-clear">Clear</button>');
  else if (b && b.status === "done") ctl.push('<button class="btn ghost" data-act="b-clear">Clear</button>');
  if (c && c.source !== "usdt" && c.status === "error") ctl.push('<button class="btn" data-act="c-resume">Resume Route C</button>', '<button class="btn ghost" data-act="c-clear">Clear</button>');
  else if (c && c.source !== "usdt" && c.status === "done") ctl.push('<button class="btn ghost" data-act="c-clear">Clear</button>');
  const controls = ctl.length ? `<div class="row" style="gap:8px;margin-bottom:8px">${ctl.join("")}</div>` : "";

  el.innerHTML = `${banner}${controls}
    <label class="field"><span>Amount (ETH · max 0.05)</span>
      <div class="row" style="gap:8px">
        <input id="fund-u-amt" type="number" min="0" max="0.05" step="0.001" class="mono" placeholder="0.02" style="max-width:180px" ${usdtBusy ? "disabled" : ""}>
        <button id="fund-u-max" class="btn ghost" style="padding:6px 12px" title="Your ETH balance minus a gas reserve for the funding steps" ${usdtBusy ? "disabled" : ""}>Max</button>
      </div></label>
    <div id="fund-u-routes" class="hint" style="margin-top:8px">${usdtBusy ? '<span class="muted">A USDT funding is in progress below…</span>' : "Enter an amount to see both routes."}</div>`;
  el.querySelectorAll("[data-act]").forEach((btn) => btn.addEventListener("click", () => onFundControl(btn.dataset.act)));
  const amt = document.getElementById("fund-u-amt");
  const maxBtn = document.getElementById("fund-u-max");
  if (amt && !usdtBusy) amt.addEventListener("input", debounceUnifiedQuote);
  if (maxBtn && !usdtBusy) maxBtn.addEventListener("click", onRouteMaxEth);
}

async function onRouteMaxEth() {
  const amt = document.getElementById("fund-u-amt");
  if (!amt) return;
  try {
    const r = await call("fund:routeMaxEth");
    const m = Math.floor(Number(r.maxEth) * 1e6) / 1e6;
    if (!r.enoughForGas || !(m > 0)) {
      return toast(`Not enough ETH — a funding run needs ~${Number(r.gasReserveEth).toFixed(4)} ETH of gas on top`, "bad", 9000);
    }
    amt.value = String(m);
    doUnifiedQuote();
  } catch (e) { toast(e.message, "bad"); }
}

async function onFundControl(act) {
  try {
    if (act === "b-retry") await call("fund:bridgeAdvance");
    else if (act === "b-clear") { await call("fund:bridgeReset"); BRIDGEJOB = null; }
    else if (act === "c-resume") await call("fund:routeCResume");
    else if (act === "c-clear" || act === "u-clear") { await call("fund:routeCReset"); ROUTECJOB = null; }
  } catch (e) { toast(e.message, "bad"); }
  refreshFundJobs();
}

let _uQuoteTimer = null;
function debounceUnifiedQuote() { clearTimeout(_uQuoteTimer); _uQuoteTimer = setTimeout(doUnifiedQuote, 600); }
async function doUnifiedQuote() {
  const amt = document.getElementById("fund-u-amt");
  const box = document.getElementById("fund-u-routes");
  if (!amt || !box) return;
  if (!Number(amt.value)) { box.textContent = "Enter an amount to see both routes."; return; }
  box.innerHTML = '<span class="muted">Pricing both routes…</span>';
  try {
    const r = await call("fund:routeCompare", { amountEth: amt.value });
    box.innerHTML = renderRouteChoices(r);
    box.querySelectorAll("[data-route]").forEach((btn) => btn.addEventListener("click", () => onPickRoute(btn.dataset.route, amt.value)));
    // Gas sufficiency: the run sends several txs on top of the ETH you're bridging.
    try {
      const g = await call("fund:routeMaxEth");
      if (Number(amt.value) + Number(g.gasReserveEth) > Number(g.balanceEth)) {
        box.insertAdjacentHTML("beforeend", `<div class="banner warn" style="margin-top:8px">⚠ Low on gas: a run needs ~${esc(Number(g.gasReserveEth).toFixed(4))} ETH of gas on top of the amount, but your balance is ${esc(Number(g.balanceEth).toFixed(4))} ETH. It could stall mid-way — use <b>Max</b> or add ETH.</div>`);
      }
    } catch { /* non-blocking */ }
  } catch (e) {
    box.innerHTML = `<span style="color:var(--bad)">${esc(e.message)}</span>`;
  }
}

function renderRouteChoices(r) {
  const routes = [...(r.routes || [])].sort((a, b) => {
    const av = a.koinOut ? BigInt(a.koinOut) : -1n, bv = b.koinOut ? BigInt(b.koinOut) : -1n;
    return bv > av ? 1 : bv < av ? -1 : 0;
  });
  return routes.map((rt) => {
    const koin = rt.koinOut ? fmtKoin(rt.koinOut) : null;
    const best = rt.isBest ? ' <span class="good">★ best</span>' : "";
    const mult = rt.bestMultiple && !rt.isBest ? ` <span class="muted small">— best returns ${esc(String(rt.bestMultiple))}× more</span>` : "";
    const val = koin ? `<b>${esc(koin)} KOIN</b>${best}${mult}` : `<span style="color:var(--bad)">unavailable${rt.error ? ": " + esc(rt.error) : ""}</span>`;
    const btn = koin ? `<button class="btn ${rt.isBest ? "primary" : ""}" data-route="${esc(rt.id)}">Use Route ${esc(rt.id)}</button>` : "";
    return `<div style="padding:10px 0;border-top:1px solid var(--border)">
      <div class="row spread" style="gap:8px"><div><b>Route ${esc(rt.id)}</b> — ${esc(rt.label)}</div>${btn}</div>
      <div class="muted small" style="margin-top:2px">${esc((rt.steps || []).join(" → "))}</div>
      <div style="margin-top:3px">${val}</div>
    </div>`;
  }).join("");
}

function onPickRoute(routeId, amountEth) {
  const v = Number(amountEth);
  if (!v || v <= 0) return toast("Enter an amount", "bad");
  if (v > 0.05) return toast("Max 0.05 ETH while this is in beta", "bad");
  if (anyFundingActive()) return toast("A funding is already in progress", "bad");
  const isC = routeId === "C";
  showModal({
    title: `Fund via Route ${routeId}?`,
    body: `<p class="small">This runs <b>${esc(String(v))} ETH</b> through <b>Route ${esc(routeId)}</b> — ${isC ? "swap ETH→USDT→vKOIN on Uniswap, then bridge vKOIN to native KOIN" : "deposit to the Vortex bridge, then swap vETH→KOIN on KoinDX"}. Real funds, several on-chain steps, auto-advances. Keep the app open and unlocked. Continue?</p>`,
    actions: [
      { label: "Cancel", onClick: (c) => c() },
      {
        label: `Run Route ${routeId}`,
        class: "primary",
        onClick: async (c) => {
          c();
          try {
            if (isC) await call("fund:routeCStart", { amountEth: String(v), source: "eth" });
            else await call("fund:bridgeStart", { amountEth: String(v) });
            toast(`Route ${routeId} started — follow the progress here`, "good");
          } catch (e) { toast(e.message, "bad", 9000); }
          refreshFundJobs();
        },
      },
    ],
  });
}

function patchUsdtFund() {
  const el = document.getElementById("fund-usdt-body");
  if (!el) return;
  const c = ROUTECJOB;
  const owns = c && !isTerminal(c) && c.source === "usdt";
  const sig = `${c?.status || "-"}|${c?.source || ""}|${c?.pendingTx || ""}|${anyFundingActive()}`;
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;

  if (owns) { el.innerHTML = fundProgress("routeC", c); return; }

  let banner = "";
  if (c && c.source === "usdt" && c.status === "done") banner = fundDoneBanner("USDT funding", c.koinReceived);
  else if (c && c.source === "usdt" && c.status === "error") banner = fundErrorBanner("USDT funding", c, "Funds are safe as USDT / vKOIN.");
  const busyElsewhere = anyFundingActive();

  el.innerHTML = `${banner}
    <label class="field"><span>Amount (USDT · max 150)</span>
      <div class="row" style="gap:8px">
        <input id="fund-usdt-amt" type="number" min="0" step="1" class="mono" placeholder="20" style="max-width:180px" ${busyElsewhere ? "disabled" : ""}>
        <button id="fund-usdt-max" class="btn ghost" style="padding:6px 12px" ${busyElsewhere ? "disabled" : ""}>Max</button>
      </div></label>
    <div id="fund-usdt-quote" class="hint" style="min-height:18px;margin-top:6px"></div>
    <div class="row" style="margin-top:8px;gap:8px">
      <button id="fund-usdt-go" class="btn primary" ${busyElsewhere ? "disabled" : ""}>Swap &amp; bridge to KOIN</button>
      ${c && c.source === "usdt" && c.status === "error" ? '<button id="fund-usdt-resume" class="btn">Resume</button>' : ""}
      ${c && c.source === "usdt" && (c.status === "error" || c.status === "done") ? '<button class="btn ghost" data-act="u-clear">Clear</button>' : ""}
    </div>
    ${busyElsewhere ? '<p class="hint">Finish the funding above first.</p>' : ""}`;
  if (!busyElsewhere) {
    $("#fund-usdt-amt").addEventListener("input", debounceUsdtFundQuote);
    $("#fund-usdt-max").addEventListener("click", onUsdtFundMax);
    $("#fund-usdt-go").addEventListener("click", onUsdtFundStart);
  }
  const resume = document.getElementById("fund-usdt-resume");
  if (resume) resume.addEventListener("click", async () => { await call("fund:routeCResume").catch((e) => toast(e.message, "bad")); refreshFundJobs(); });
  el.querySelectorAll("[data-act]").forEach((btn) => btn.addEventListener("click", () => onFundControl(btn.dataset.act)));
}

let _usdtFundQuoteTimer = null;
function debounceUsdtFundQuote() { clearTimeout(_usdtFundQuoteTimer); _usdtFundQuoteTimer = setTimeout(doUsdtFundQuote, 600); }
async function doUsdtFundQuote() {
  const amt = document.getElementById("fund-usdt-amt");
  const q = document.getElementById("fund-usdt-quote");
  if (!amt || !q || !Number(amt.value)) { if (q) q.textContent = ""; return; }
  q.textContent = "Getting quote…";
  try {
    const r = await call("fund:usdtFundQuote", { amountUsdt: amt.value });
    q.innerHTML = `~<b>${esc(fmtKoin(r.koinOut))} KOIN</b> (min ${esc(fmtKoin(r.koinOutMin))} after slippage).`;
    try {
      const g = await call("fund:routeMaxEth");
      if (!g.enoughForGas) q.insertAdjacentHTML("beforeend", `<br><span style="color:var(--warn)">⚠ Low ETH for gas — needs ~${esc(Number(g.gasReserveEth).toFixed(4))} ETH in this address.</span>`);
    } catch { /* non-blocking */ }
  } catch (e) { q.innerHTML = `<span style="color:var(--bad)">${esc(e.message)}</span>`; }
}
async function onUsdtFundMax() {
  const amt = document.getElementById("fund-usdt-amt");
  if (!amt) return;
  try {
    const r = await call("fund:usdtSendMax");
    let max = Math.floor(Number(r.maxUsdt) * 100) / 100;
    if (max > 150) max = 150;
    if (!(max > 0)) return toast("No USDT balance in your funding address", "bad");
    amt.value = String(max);
    doUsdtFundQuote();
  } catch (e) { toast(e.message, "bad"); }
}
function onUsdtFundStart() {
  const amt = document.getElementById("fund-usdt-amt");
  const v = Number(amt && amt.value);
  if (!v || v <= 0) return toast("Enter a USDT amount", "bad");
  if (v > 150) return toast("Max $150 while this is in beta", "bad");
  if (anyFundingActive()) return toast("A funding is already in progress", "bad");
  showModal({
    title: "Fund with USDT?",
    body: `<p class="small">This swaps <b>${esc(String(v))} USDT</b> → vKOIN on Uniswap and bridges it to native KOIN. Needs a little ETH in your funding address for gas. Real funds, auto-advances. Continue?</p>`,
    actions: [
      { label: "Cancel", onClick: (c) => c() },
      {
        label: "Swap & bridge",
        class: "primary",
        onClick: async (c) => {
          c();
          try { await call("fund:routeCStart", { source: "usdt", amountUsdt: String(v) }); toast("USDT funding started", "good"); }
          catch (e) { toast(e.message, "bad", 9000); }
          refreshFundJobs();
        },
      },
    ],
  });
}

function patchFundView() {
  const addrWrap = $("#fund-addr-wrap");
  if (addrWrap) {
    const key = FUND.ethAddress || "";
    if (addrWrap.dataset.addr !== key) {
      addrWrap.dataset.addr = key;
      if (FUND.ethAddress) {
        addrWrap.innerHTML = `
          <div class="mono" style="word-break:break-all;font-size:15px;padding:10px;background:var(--card-2);border:1px solid var(--border);border-radius:8px">${esc(FUND.ethAddress)}</div>
          <div class="row" style="margin-top:8px;align-items:center;gap:10px">
            <button id="fund-copy" class="btn">Copy address</button>
            <span id="fund-bal" class="muted">Balance: checking…</span>
            <button id="fund-bal-refresh" class="btn ghost" title="Refresh balance" style="padding:4px 10px">↻</button>
          </div>`;
        $("#fund-copy").addEventListener("click", async () => {
          await call("util:copy", { text: FUND.ethAddress });
          toast("Address copied", "good");
        });
        $("#fund-bal-refresh").addEventListener("click", loadEthBalance);
      } else {
        addrWrap.innerHTML = `<div class="banner warn">Create or unlock your wallet first — your ETH address is derived from it.</div>`;
      }
    }
    if (FUND.ethAddress) loadEthBalance();
  }
  const buyWrap = $("#fund-buy-wrap");
  if (buyWrap) {
    // A blank onrampEndpoint means the built-in (default) Coinbase endpoint,
    // which is pending Coinbase approval — so the in-app Coinbase button only
    // shows when the user has set their own (approved) endpoint. Everyone gets
    // the keyless buy links + the receive address.
    const state = !FUND.ethAddress ? "locked" : FUND.onrampEndpoint ? "buy-custom" : "buy-default";
    const keylessLinks = `
      <div style="margin-top:14px;border-top:1px solid var(--border);padding-top:12px">
        <div class="muted small" style="margin-bottom:6px">Buy ETH anywhere — no account with us, no setup — and send it to your address above:</div>
        <div class="row" style="gap:8px;flex-wrap:wrap">
          <button class="btn ghost" data-buy="https://www.moonpay.com/buy/eth">MoonPay ↗</button>
          <button class="btn ghost" data-buy="https://ramp.network/buy?swapAsset=ETH">Ramp ↗</button>
          <button class="btn ghost" data-buy="https://www.coinbase.com/how-to-buy/ethereum">Coinbase ↗</button>
          <button class="btn ghost" data-buy="https://www.kraken.com/learn/buy-ethereum-eth">Kraken ↗</button>
        </div>
      </div>`;
    if (buyWrap.dataset.state !== state) {
      buyWrap.dataset.state = state;
      if (state === "locked") {
        buyWrap.innerHTML = `<p class="muted">Unlock your wallet to enable buying.</p>`;
      } else if (state === "buy-custom") {
        buyWrap.innerHTML = `
          <label class="field"><span>Amount (USD, optional)</span>
            <input id="fund-usd" type="number" min="0" step="1" class="mono" placeholder="e.g. 50" style="max-width:160px"></label>
          <button id="fund-buy" class="btn primary big">Buy ETH with Coinbase ↗</button>
          <p class="hint">Opens Coinbase Pay with this address pre-filled (your custom endpoint).</p>
          ${keylessLinks}`;
        $("#fund-buy").addEventListener("click", onBuyEth);
      } else {
        buyWrap.innerHTML = `
          <div class="banner info">Coinbase in-app purchase is <b>currently unavailable</b> (pending Coinbase approval). Use a Buy link below, or add your own approved Coinbase endpoint in the settings above.</div>
          ${keylessLinks}`;
      }
      $$("[data-buy]", buyWrap).forEach((b) =>
        b.addEventListener("click", () => call("util:openExternal", { url: b.dataset.buy }).catch(() => {}))
      );
    }
  }
}

let _balBusy = false;
async function loadEthBalance() {
  const el = document.getElementById("fund-bal");
  if (!el || _balBusy) return;
  _balBusy = true;
  try {
    const b = await call("fund:ethBalance");
    const positive = Number(b.eth) > 0;
    el.textContent = `Balance: ${b.eth} ETH`;
    el.classList.toggle("good", positive);
    el.classList.toggle("muted", !positive);
  } catch {
    el.textContent = "Balance: unavailable";
  } finally {
    _balBusy = false;
  }
}

// ---- bridge & swap (Phase 2) ----
let BRIDGEJOB = null;
const BRIDGE_ORDER = ["depositing", "awaiting_signatures", "redeeming", "swapping", "done"];
const BRIDGE_LABELS = {
  depositing: "Depositing ETH into the bridge",
  awaiting_signatures: "Waiting for bridge guardians (~a few min)",
  redeeming: "Minting vETH on Koinos",
  swapping: "Swapping vETH → KOIN",
};
const fmtKoin = (sats) => (Number(BigInt(sats || "0")) / 1e8).toLocaleString(undefined, { maximumFractionDigits: 4 });

async function refreshBridge() {
  try {
    BRIDGEJOB = await call("fund:bridgeStatus");
  } catch {
    /* keep last */
  }
  patchBridge();
}

function patchBridge() {
  const el = document.getElementById("fund-bridge-body");
  if (!el) return;
  const job = BRIDGEJOB;
  // Only re-render when the bridge state actually changes — otherwise the 5s
  // status refresh rebuilds the card and clobbers the amount the user is typing.
  const sig = `${job?.status || "none"}|${job?.error || ""}|${job?.koinReceived || ""}|${job?.ethTxHash || ""}`;
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  const active = job && !["done", "error"].includes(job.status);

  if (active) {
    const idx = BRIDGE_ORDER.indexOf(job.status);
    const steps = BRIDGE_ORDER.slice(0, 4)
      .map((s, i) => {
        const ico = i < idx ? "✅" : i === idx ? '<span class="spin"></span>' : "⬜";
        return `<div class="row" style="gap:8px;align-items:center"><span>${ico}</span><span class="${i === idx ? "" : "muted"}">${esc(BRIDGE_LABELS[s])}</span></div>`;
      })
      .join("");
    el.innerHTML = `<div style="display:flex;flex-direction:column;gap:6px;margin-top:6px">${steps}</div>
      <p class="hint" style="margin-top:10px">Keep the app open and unlocked. This can take several minutes and resumes automatically if interrupted.</p>`;
    return;
  }

  let banner = "";
  if (job && job.status === "done") {
    banner = `<div class="banner good">✅ Bridged! Received ~<b>${esc(fmtKoin(job.koinReceived))} KOIN</b> — check the Wallet tab.</div>`;
  } else if (job && job.status === "error") {
    banner = `<div class="banner bad">Bridge stopped: ${esc(job.error || "unknown error")}${job.ethTxHash ? `<br><span class="small">Your ETH deposit (${esc(job.ethTxHash.slice(0, 12))}…) is safe — Retry resumes from where it left off.</span>` : ""}</div>`;
  }
  el.innerHTML = `${banner}
    <div class="field" style="margin-top:10px"><span>Amount to bridge (ETH · max 0.05)</span>
      <div class="row" style="gap:8px;align-items:center">
        <input id="fund-bridge-amt" type="number" min="0" max="0.05" step="0.001" class="mono" placeholder="0.01" style="max-width:180px">
        <button id="fund-bridge-max" class="btn ghost" style="padding:6px 12px" title="Bridge your whole ETH balance minus gas">Max</button>
      </div>
    </div>
    <div id="fund-bridge-quote" class="hint" style="min-height:18px;margin-top:6px"></div>
    <div class="row" style="margin-top:8px">
      <button id="fund-bridge-start" class="btn primary">Bridge &amp; swap to KOIN</button>
      ${job && job.status === "error" ? '<button id="fund-bridge-retry" class="btn">Retry</button>' : ""}
      ${job ? '<button id="fund-bridge-reset" class="btn ghost">Reset</button>' : ""}
    </div>`;
  $("#fund-bridge-amt").addEventListener("input", debounceBridgeQuote);
  $("#fund-bridge-max").addEventListener("click", onBridgeMax);
  $("#fund-bridge-start").addEventListener("click", onBridgeStart);
  const retry = document.getElementById("fund-bridge-retry");
  if (retry) retry.addEventListener("click", async () => { await call("fund:bridgeAdvance").catch(() => {}); refreshBridge(); });
  const reset = document.getElementById("fund-bridge-reset");
  if (reset) reset.addEventListener("click", async () => { await call("fund:bridgeReset").catch(() => {}); BRIDGEJOB = null; refreshBridge(); });
}

// ---- Route C execution (ETH → USDT → vKOIN → native KOIN) ----
let ROUTECJOB = null;
const ROUTEC_PHASES = ["Swap ETH → USDT", "Swap USDT → vKOIN", "Bridge vKOIN → Koinos", "Redeem to native KOIN"];
function routeCPhase(status) {
  if (status === "swap_eth_usdt") return 0;
  if (["approve_permit2", "approve_ur", "swap_usdt_vkoin"].includes(status)) return 1;
  if (["approve_bridge", "bridge_token", "awaiting_signatures"].includes(status)) return 2;
  if (status === "redeeming") return 3;
  if (status === "done") return 4;
  return 0;
}

async function refreshRouteC() {
  try {
    ROUTECJOB = await call("fund:routeCStatus");
  } catch {
    /* keep last */
  }
  patchRouteC();
}

function patchRouteC() {
  const el = document.getElementById("fund-routec-body");
  if (!el) return;
  const job = ROUTECJOB;
  const sig = `${job?.status || "none"}|${job?.error || ""}|${job?.koinReceived || ""}|${job?.pendingTx || ""}`;
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  const active = job && !["done", "error"].includes(job.status);

  if (active) {
    const idx = routeCPhase(job.status);
    const steps = ROUTEC_PHASES.map((label, i) => {
      const ico = i < idx ? "✅" : i === idx ? '<span class="spin"></span>' : "⬜";
      return `<div class="row" style="gap:8px;align-items:center"><span>${ico}</span><span class="${i === idx ? "" : "muted"}">${esc(label)}</span></div>`;
    }).join("");
    const tx = job.pendingTx ? `<div class="small muted" style="margin-top:6px">Waiting on tx ${esc(String(job.pendingTx).slice(0, 12))}…</div>` : "";
    el.innerHTML = `<div style="display:flex;flex-direction:column;gap:6px;margin-top:6px">${steps}</div>${tx}
      <p class="hint" style="margin-top:10px">Keep the app open and unlocked. Auto-advances; resumes if interrupted.</p>`;
    return;
  }

  let banner = "";
  if (job && job.status === "done") {
    banner = `<div class="banner good">✅ Funded via Route C! Received ~<b>${esc(fmtKoin(job.koinReceived))} KOIN</b> — check the Wallet tab.</div>`;
  } else if (job && job.status === "error") {
    const where = job.failedAt ? ` (at ${esc(job.failedAt)})` : "";
    banner = `<div class="banner bad">Route C stopped${where}: ${esc(job.error || "unknown error")}<br><span class="small">Your funds are safe as ETH / USDT / vKOIN — Resume continues from the last step.</span></div>`;
  }
  el.innerHTML = `${banner}
    <div class="field" style="margin-top:10px"><span>Amount (ETH · max 0.05)</span>
      <div class="row" style="gap:8px;align-items:center">
        <input id="fund-routec-amt" type="number" min="0" max="0.05" step="0.001" class="mono" placeholder="0.01" style="max-width:180px">
      </div>
    </div>
    <div id="fund-routec-quote" class="hint" style="min-height:18px;margin-top:6px"></div>
    <div class="row" style="margin-top:8px">
      <button id="fund-routec-start" class="btn primary">Swap &amp; bridge to KOIN</button>
      ${job && job.status === "error" ? '<button id="fund-routec-resume" class="btn">Resume</button>' : ""}
      ${job ? '<button id="fund-routec-reset" class="btn ghost">Reset</button>' : ""}
    </div>`;
  $("#fund-routec-amt").addEventListener("input", debounceRouteCQuote);
  $("#fund-routec-start").addEventListener("click", onRouteCStart);
  const resume = document.getElementById("fund-routec-resume");
  if (resume) resume.addEventListener("click", async () => { await call("fund:routeCResume").catch((e) => toast(e.message, "bad")); refreshRouteC(); });
  const reset = document.getElementById("fund-routec-reset");
  if (reset) reset.addEventListener("click", async () => { await call("fund:routeCReset").catch(() => {}); ROUTECJOB = null; refreshRouteC(); });
}

let _routeCQuoteTimer = null;
function debounceRouteCQuote() {
  clearTimeout(_routeCQuoteTimer);
  _routeCQuoteTimer = setTimeout(doRouteCQuote, 600);
}
async function doRouteCQuote() {
  const q = document.getElementById("fund-routec-quote");
  const amt = document.getElementById("fund-routec-amt");
  if (!q || !amt || !Number(amt.value)) { if (q) q.textContent = ""; return; }
  q.textContent = "Getting quote…";
  try {
    const r = await call("fund:routeCompare", { amountEth: amt.value });
    const c = (r.routes || []).find((x) => x.id === "C");
    if (c && c.koinOut) {
      q.innerHTML = `~<b>${esc(fmtKoin(c.koinOut))} KOIN</b> (min ${esc(fmtKoin(c.koinOutMin))} after slippage).`;
    } else {
      q.innerHTML = `<span style="color:var(--bad)">Quote unavailable${c && c.error ? ": " + esc(c.error) : ""}</span>`;
    }
  } catch (e) {
    q.innerHTML = `<span style="color:var(--bad)">${esc(e.message)}</span>`;
  }
}

async function onRouteCStart() {
  const amt = document.getElementById("fund-routec-amt");
  const v = Number(amt && amt.value);
  if (!v || v <= 0) return toast("Enter an ETH amount", "bad");
  if (v > 0.05) return toast("Max 0.05 ETH while Route C is experimental", "bad");
  showModal({
    title: "Fund via Route C?",
    body: `<p class="small">This swaps <b>${esc(String(v))} ETH</b> → USDT → vKOIN on Uniswap and bridges it to <b>native KOIN</b> across several real Ethereum transactions (unaudited bridge). It auto-advances and can take a few minutes — keep the app open and unlocked. <b>New path — test small first.</b> Continue?</p>`,
    actions: [
      { label: "Cancel", onClick: (c) => c() },
      {
        label: "Swap & bridge",
        class: "primary",
        onClick: async (c) => {
          c();
          try {
            await call("fund:routeCStart", { amountEth: String(v) });
            toast("Route C started — follow the progress below", "good");
          } catch (e) {
            toast(e.message, "bad", 9000);
          }
          refreshRouteC();
        },
      },
    ],
  });
}

let _bridgeQuoteTimer = null;
function debounceBridgeQuote() {
  clearTimeout(_bridgeQuoteTimer);
  _bridgeQuoteTimer = setTimeout(doBridgeQuote, 600);
}
async function doBridgeQuote() {
  const q = document.getElementById("fund-bridge-quote");
  const amt = document.getElementById("fund-bridge-amt");
  if (!q || !amt || !Number(amt.value)) { if (q) q.textContent = ""; return; }
  q.textContent = "Getting quote…";
  try {
    const r = await call("fund:bridgeQuote", { amountEth: amt.value });
    const gas = Number(r.deposit.gasCostEth || 0).toFixed(5);
    const short = r.deposit.sufficient ? "" : ' <span style="color:var(--bad)">Not enough ETH for amount + gas.</span>';
    if (r.swap && r.swap.amountOut) {
      const koin = fmtKoin(r.swap.amountOut);
      const min = fmtKoin(r.swap.amountOutMin);
      q.innerHTML = `Deposit ${esc(r.deposit.amountEth)} ETH (gas ~${esc(gas)} ETH) → ~<b>${esc(koin)} KOIN</b> (min ${esc(min)} after slippage).${short}`;
    } else {
      const why = r.swap && r.swap.error ? `: ${esc(r.swap.error)}` : "";
      const veth = r.deposit.vethSats ? fmtKoin(r.deposit.vethSats) : "?";
      q.innerHTML = `Deposit ${esc(r.deposit.amountEth)} ETH (gas ~${esc(gas)} ETH) → ${esc(veth)} vETH. <span style="color:var(--bad)">KOIN quote unavailable${why}</span>.${short}`;
    }
  } catch (e) {
    q.innerHTML = `<span style="color:var(--bad)">${esc(e.message)}</span>`;
  }
}

async function onBridgeMax() {
  const btn = document.getElementById("fund-bridge-max");
  const amt = document.getElementById("fund-bridge-amt");
  if (!btn || !amt) return;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "…";
  try {
    const r = await call("fund:bridgeMax");
    const max = Math.floor(Number(r.maxEth) * 1e6) / 1e6; // floor to 6 dp so it never exceeds balance − gas
    if (!(max > 0)) {
      toast("Not enough ETH (after gas) to bridge", "bad", 7000);
      return;
    }
    amt.value = String(max);
    doBridgeQuote();
  } catch (e) {
    toast(e.message, "bad", 8000);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function onBridgeStart() {
  const amt = document.getElementById("fund-bridge-amt");
  const v = Number(amt && amt.value);
  if (!v || v <= 0) return toast("Enter an amount to bridge", "bad");
  if (v > 0.05) return toast("Max 0.05 ETH per bridge", "bad");
  showModal({
    title: "Bridge real ETH?",
    body: `<p class="small">This sends <b>${esc(String(v))} ETH</b> to the Vortex bridge (unaudited), then mints vETH and swaps it to KOIN. It moves real funds and can take several minutes. Keep the app open and unlocked. Continue?</p>`,
    actions: [
      { label: "Cancel", onClick: (c) => c() },
      {
        label: "Bridge it",
        class: "primary",
        onClick: async (c) => {
          c();
          try {
            await call("fund:bridgeStart", { amountEth: String(v) });
            toast("Bridge started — follow the progress below", "good");
          } catch (e) {
            toast(e.message, "bad", 9000);
          }
          refreshBridge();
        },
      },
    ],
  });
}

// ---- compare funding routes ----
async function onCompareRoutes() {
  const amt = document.getElementById("fund-cmp-amt");
  const body = document.getElementById("fund-cmp-body");
  const btn = document.getElementById("fund-cmp-go");
  const v = Number(amt && amt.value);
  if (!v || v <= 0) return toast("Enter an ETH amount to compare", "bad");
  if (!body) return;
  busyButton(btn, true, "Quoting…");
  body.innerHTML = '<span class="muted">Quoting both routes…</span>';
  try {
    const r = await call("fund:routeCompare", { amountEth: String(v) });
    body.innerHTML = renderRouteCompare(r);
  } catch (e) {
    body.innerHTML = `<span style="color:var(--bad)">${esc(e.message)}</span>`;
  } finally {
    busyButton(btn, false);
  }
}

function renderRouteCompare(r) {
  const rows = (r.routes || []).map((rt) => {
    const steps = (rt.steps || []).join(" → ");
    const preview = rt.executable ? "" : ' <span class="muted small">(preview)</span>';
    let val;
    if (rt.koinOut) {
      const koin = fmtKoin(rt.koinOut);
      const best = rt.isBest ? ' <span class="good">★ best</span>' : "";
      const mult = rt.bestMultiple && !rt.isBest ? ` <span class="muted">— best returns ${esc(String(rt.bestMultiple))}× more</span>` : "";
      val = `<b>${esc(koin)} KOIN</b>${best}${mult}`;
    } else {
      val = `<span style="color:var(--bad)">unavailable${rt.error ? ": " + esc(rt.error) : ""}</span>`;
    }
    return `<div style="padding:8px 0;border-top:1px solid var(--border)">
      <div><b>Route ${esc(rt.id)}</b> — ${esc(rt.label)}${preview}</div>
      <div class="muted small">${esc(steps)}</div>
      <div style="margin-top:3px">${val}</div>
    </div>`;
  }).join("");
  const hdr = r.best
    ? `Best for <b>${esc(r.amountEth)} ETH</b>: <b>Route ${esc(r.best.id)}</b> (${esc(fmtKoin(r.best.koinOut))} KOIN)`
    : '<span style="color:var(--bad)">No route could be quoted right now.</span>';
  return `<div style="margin-bottom:4px">${hdr}</div>${rows}`;
}

// ---- withdraw ETH out ----
let _sendQuoteTimer = null;
function debounceSendQuote() {
  clearTimeout(_sendQuoteTimer);
  _sendQuoteTimer = setTimeout(doSendQuote, 600);
}
async function doSendQuote() {
  const q = document.getElementById("fund-send-quote");
  const to = document.getElementById("fund-send-to");
  const amt = document.getElementById("fund-send-amt");
  if (!q || !to || !amt) return;
  const v = Number(amt.value);
  if (!to.value.trim() || !v || v <= 0) { q.textContent = ""; return; }
  q.textContent = "Estimating…";
  try {
    const r = await call("fund:ethSendQuote", { toAddress: to.value.trim(), amountEth: String(v) });
    const gas = Number(r.gasCostEth || 0).toFixed(5);
    const total = Number(r.totalEth || 0).toFixed(6);
    const bal = Number(r.balanceEth || 0).toFixed(6);
    q.innerHTML = r.sufficient
      ? `Gas ~${esc(gas)} ETH · total ~${esc(total)} ETH · balance ${esc(bal)} ETH`
      : `<span style="color:var(--bad)">Not enough ETH: need ~${esc(total)} incl. gas, have ${esc(bal)}.</span>`;
  } catch (e) {
    q.innerHTML = `<span style="color:var(--bad)">${esc(e.message)}</span>`;
  }
}

async function onSendMax() {
  const btn = document.getElementById("fund-send-max");
  const amt = document.getElementById("fund-send-amt");
  const to = document.getElementById("fund-send-to");
  if (!btn || !amt) return;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "…";
  try {
    const r = await call("fund:ethSendMax", { toAddress: to && to.value.trim() });
    const max = Math.floor(Number(r.maxEth) * 1e6) / 1e6; // floor to 6 dp so it never exceeds balance − gas
    if (!(max > 0)) {
      toast("Not enough ETH (after gas) to send", "bad", 7000);
      return;
    }
    amt.value = String(max);
    doSendQuote();
  } catch (e) {
    toast(e.message, "bad", 8000);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function onSendEth() {
  const to = document.getElementById("fund-send-to");
  const amt = document.getElementById("fund-send-amt");
  const dest = to && to.value.trim();
  const v = Number(amt && amt.value);
  if (!dest) return toast("Enter a recipient address", "bad");
  if (!v || v <= 0) return toast("Enter an amount to send", "bad");
  showModal({
    title: "Send real ETH?",
    body: `<p class="small">This sends <b>${esc(String(v))} ETH</b> to<br><span class="mono" style="word-break:break-all">${esc(dest)}</span><br>on Ethereum Mainnet. This is irreversible. Continue?</p>`,
    actions: [
      { label: "Cancel", onClick: (c) => c() },
      {
        label: "Send it",
        class: "primary",
        onClick: async (c) => {
          c();
          const btn = document.getElementById("fund-send-go");
          busyButton(btn, true, "Sending…");
          try {
            const r = await call("fund:ethSend", { toAddress: dest, amountEth: String(v) });
            toast(`Sent — tx ${r.hash.slice(0, 10)}…`, "good", 9000);
            if (amt) amt.value = "";
            const q = document.getElementById("fund-send-quote");
            if (q) {
              q.innerHTML = `<span class="good">Sent ✓</span> <a href="#" id="fund-send-tx">view on Etherscan ↗</a>`;
              const link = document.getElementById("fund-send-tx");
              if (link) link.addEventListener("click", (e) => {
                e.preventDefault();
                call("util:openExternal", { url: `https://etherscan.io/tx/${r.hash}` }).catch(() => {});
              });
            }
            loadEthBalance();
          } catch (e) {
            toast(e.message, "bad", 9000);
          } finally {
            busyButton(btn, false);
          }
        },
      },
    ],
  });
}

async function onBuyEth() {
  const btn = $("#fund-buy");
  busyButton(btn, true, "Preparing…");
  try {
    const usd = Number($("#fund-usd")?.value) || undefined;
    const { url } = await call("fund:buyUrl", { amountUsd: usd });
    await call("util:openExternal", { url });
    toast("Opened Coinbase Pay in your browser", "good");
  } catch (e) {
    toast(e.message, "bad", 8000);
  } finally {
    busyButton(btn, false);
  }
}

async function onSaveOnrampEndpoint() {
  const btn = $("#fund-endpoint-save");
  busyButton(btn, true, "Saving…");
  try {
    await call("settings:update", { onrampEndpoint: $("#fund-endpoint").value.trim() });
    toast("Endpoint saved", "good");
    await refreshFund();
  } catch (e) {
    toast(e.message, "bad");
  } finally {
    busyButton(btn, false);
  }
}

// ---------- distribution view ----------

function renderDistributionView() {
  const root = $("#view-distribution");
  const cfg = S.distribution?.config ?? S.appInfo.settings.distribution;
  root.innerHTML = `
    <h1>Community distribution</h1>
    <p class="lead">Run your node for the network, not just yourself: the VHP each block consumes is automatically re-burned so your node keeps producing at the same level, and the <b>profit</b> is split evenly — once a day — between every node seen producing with enough VHP. Turn it off and the app behaves exactly like a normal node.</p>
    <div class="grid-2">
      <div class="card">
        <h2>⚙️ Configuration</h2>
        <label class="field"><span class="row" style="gap:8px">
          <input type="checkbox" id="di-enabled" ${cfg.enabled ? "checked" : ""} style="width:auto">
          <b>Enable community distribution</b></span></label>
        <div class="field">
          <span>Who earns a share</span>
          <label class="row" style="gap:8px;margin-top:6px">
            <input type="checkbox" id="di-req-vhp" ${cfg.requireVhpMinimum ? "checked" : ""} style="width:auto">
            <span><b>Require VHP minimum</b> <span class="muted small">— must be producing blocks with enough VHP</span></span></label>
          <label class="row" style="gap:8px;margin-top:6px">
            <input type="checkbox" id="di-req-ai" ${cfg.requireAiNode ? "checked" : ""} style="width:auto">
            <span><b>Running Koinos AI Node</b> <span class="muted small">— must be seen on the Koinos AI network</span></span></label>
          <p class="hint" id="di-rule" style="margin-top:8px"></p>
        </div>
        <label class="field"><span>How the pool is split</span>
          <select id="di-weighting">
            <option value="participation" ${cfg.weighting !== "even" ? "selected" : ""}>\u23f1\ufe0f By rewards earned — share \u221d the rewards a node was qualifying for</option>
            <option value="even" ${cfg.weighting === "even" ? "selected" : ""}>\u2696\ufe0f Evenly — a flat split among everyone who qualified</option>
          </select></label>
        <label class="field" id="di-minvhp-wrap" style="display:${cfg.requireVhpMinimum ? "block" : "none"}"><span>Minimum VHP a node needs to qualify</span>
          <input id="di-minvhp" type="text" class="mono" value="${esc(cfg.minVhpKoin)}"></label>
        <label class="field" id="di-roster-wrap" style="display:${cfg.requireAiNode ? "block" : "none"}"><span>Koinos AI Node roster URL</span>
          <input id="di-roster" type="text" class="mono" placeholder="https://…/workers/active" value="${esc(cfg.aiRosterUrl ?? "")}"></label>
        <label class="field"><span>Distribute daily at (UTC hour, 0–23)</span>
          <input id="di-hour" type="number" min="0" max="23" value="${cfg.payoutHourUtc}"></label>
        <div class="grid-2">
          <label class="field"><span>Minimum share to pay out (${esc(sym())})</span>
            <input id="di-minpay" type="text" class="mono" value="${esc(cfg.minPayoutKoin)}"></label>
          <label class="field"><span>Check every (minutes)</span>
            <input id="di-poll" type="number" min="1" value="${cfg.pollMinutes}"></label>
        </div>
        <div class="row">
          <button id="di-save" class="btn primary">Save</button>
          <button id="di-now" class="btn">Check now</button>
          <button id="di-close" class="btn">Distribute now</button>
        </div>
        <p class="hint">Every time this node collects a block reward, each address qualifying <b>at that moment</b> is credited with it, and the pool is paid out in proportion to those credits. Be qualified for two of three rewards while someone else catches one, and you are paid exactly 2:1. Turn up in the last ten minutes and you earn the last ten minutes. Stake never buys a bigger share — a node with ten times the minimum VHP earns the same as one right at it.</p>
        <p class="hint">Credits are only cleared when a pool is actually paid out, so rewards that roll over still belong to whoever was around when they were earned. Any share below the minimum is skipped and carried rather than sent, because each payout spends mana.</p>
        <p class="hint">With <b>Running Koinos AI Node</b> on, the roster URL decides who is credited — point it only at a roster you trust. If the roster can't be read at any point during a day, that day pays nobody and carries the whole pool over (the VHP reburn still happens).</p>
        <p class="hint">Payouts are signed locally, so the app must be open with the wallet unlocked. Sending and reburning KOIN spend <b>mana</b> — big distributions drain out in chunks as mana recharges. Enabling this turns off the Reward-returns tab (they'd both spend the same rewards).</p>
      </div>
      <div class="card">
        <h2>📊 Status</h2>
        <div id="di-status" class="stack"></div>
      </div>
    </div>
    <div class="card">
      <h2>🧾 Distribution cycles</h2>
      <table><thead><tr><th>Closed</th><th>Profit</th><th>Reburned</th><th>Nodes</th><th>Top share</th><th>Carried</th></tr></thead>
      <tbody id="di-history"></tbody></table>
    </div>
    <div class="card">
      <h2>📤 Recent transactions</h2>
      <table><thead><tr><th>When</th><th>What</th><th>Amount</th><th>Tx</th></tr></thead>
      <tbody id="di-actions"></tbody></table>
    </div>`;

  const syncGates = () => {
    const vhp = $("#di-req-vhp").checked;
    const ai = $("#di-req-ai").checked;
    $("#di-minvhp-wrap").style.display = vhp ? "block" : "none";
    $("#di-roster-wrap").style.display = ai ? "block" : "none";
    $("#di-rule").innerHTML =
      vhp && ai
        ? "Both required: a node must be on a Koinos AI Node <b>and</b> producing blocks with the minimum VHP."
        : vhp
          ? "Nodes producing blocks that hold at least the minimum VHP earn a share."
          : ai
            ? "Every address seen running a Koinos AI Node earns a share, whether or not it produces blocks."
            : "No requirements — every node seen producing a block earns a share.";
  };
  $("#di-req-vhp").addEventListener("change", syncGates);
  $("#di-req-ai").addEventListener("change", syncGates);
  syncGates();

  $("#di-save").addEventListener("click", onSaveDistribution);
  $("#di-now").addEventListener("click", () => onDistributionTick("distribution:runNow", $("#di-now"), "Checking…"));
  $("#di-close").addEventListener("click", onDistributeNow);
  patchDistributionView();
}

async function onSaveDistribution() {
  const btn = $("#di-save");
  busyButton(btn, true, "Saving…");
  try {
    await call("distribution:configure", {
      enabled: $("#di-enabled").checked,
      weighting: $("#di-weighting").value,
      requireVhpMinimum: $("#di-req-vhp").checked,
      requireAiNode: $("#di-req-ai").checked,
      aiRosterUrl: $("#di-roster").value.trim(),
      minVhpKoin: $("#di-minvhp").value.trim(),
      payoutHourUtc: Number($("#di-hour").value),
      minPayoutKoin: $("#di-minpay").value.trim(),
      pollMinutes: Number($("#di-poll").value),
    });
    toast("Distribution settings saved", "good");
    await Promise.all([refreshDistribution(), refreshRewards()]);
  } catch (e) {
    toast(e.message, "bad");
  } finally {
    busyButton(btn, false);
  }
}

async function onDistributionTick(channel, btn, busyLabel) {
  busyButton(btn, true, busyLabel);
  try {
    S.distribution = await call(channel);
    patchDistributionView();
    const last = S.distribution.last;
    toast(last?.message || `Check complete: ${last?.outcome ?? "done"}`,
      ["cycle-closed", "distributed"].includes(last?.outcome) ? "good"
        : last?.outcome === "cycle-held" ? "warn" : "info", 8000);
  } catch (e) {
    toast(e.message, "bad");
  } finally {
    busyButton(btn, false);
  }
}

function onDistributeNow() {
  showModal({
    title: "Close the cycle now?",
    body: `<p class="small">This closes the current cycle immediately instead of waiting for the daily time:
      the VHP consumed so far is queued for reburn and the profit is split between the nodes seen producing
      <b>up to now</b>. The next cycle starts fresh right after.</p>`,
    actions: [
      { label: "Cancel", onClick: (close) => close() },
      {
        label: "Distribute now", class: "primary",
        onClick: async (close) => {
          close();
          await onDistributionTick("distribution:distributeNow", $("#di-close"), "Distributing…");
        },
      },
    ],
  });
}

const DISTRIBUTION_OUTCOME_LABELS = {
  disabled: ["pill", "disabled"],
  "no-wallet": ["pill warn", "no wallet"],
  locked: ["pill warn", "wallet locked"],
  "rpc-error": ["pill bad", "RPC error"],
  "history-unavailable": ["pill bad", "no history RPC"],
  syncing: ["pill accent", "reading history…"],
  anchored: ["pill accent", "tracking started"],
  "re-anchored": ["pill warn", "re-anchored"],
  watching: ["pill accent", "watching network"],
  "cycle-closed": ["pill good", "cycle closed"],
  "cycle-held": ["pill warn", "held — roster unavailable"],
  distributing: ["pill accent", "paying out…"],
  distributed: ["pill good", "all paid out"],
  "tx-error": ["pill bad", "tx failed"],
};

function patchDistributionView() {
  const statusEl = $("#di-status");
  if (!statusEl) return;
  const r = S.distribution;
  if (!r) { statusEl.innerHTML = `<span class="muted">Loading…</span>`; return; }
  const d = r.derived;
  const c = d?.cycle;
  const q = d?.queue;
  const last = r.last;
  const [pillClass, pillLabel] = last ? DISTRIBUTION_OUTCOME_LABELS[last.outcome] ?? ["pill", last.outcome] : ["pill", "no checks yet"];
  statusEl.innerHTML = `
    <div class="row spread"><span class="muted">Engine</span>
      <span class="pill ${r.config.enabled ? "good" : "warn"}">${r.config.enabled ? "enabled" : "disabled"}</span></div>
    <div class="row spread"><span class="muted">Last check</span>
      <span class="small">${last ? `${fmtTime(last.time)} · ` : ""}<span class="${pillClass}">${esc(pillLabel)}</span></span></div>
    ${last?.message ? `<div class="muted small">${esc(last.message)}</div>` : ""}
    <div class="row spread"><span class="muted">Next distribution</span>
      <span class="small mono">${c?.dueAt ? fmtTime(c.dueAt) : "—"}</span></div>
    <hr style="border-color:var(--border);border-style:solid;opacity:.4">
    <div class="row spread"><span class="muted">Requirements</span>
      <span class="small">${
        r.config.requireVhpMinimum && r.config.requireAiNode
          ? `<span class="pill accent">VHP ≥ ${esc(r.config.minVhpKoin)}</span> <span class="pill accent">AI node</span>`
          : r.config.requireVhpMinimum
            ? `<span class="pill accent">VHP ≥ ${esc(r.config.minVhpKoin)}</span>`
            : r.config.requireAiNode
              ? `<span class="pill accent">AI node</span>`
              : `<span class="pill">any producer</span>`
      }</span></div>
    <div class="row spread"><span class="muted">Split</span>
      <span class="small">${r.config.weighting === "even"
        ? `<span class="pill">evenly</span>`
        : `<span class="pill accent">by rewards earned</span>`}</span></div>
    <div class="row spread"><span class="muted">Producers seen this cycle</span>
      <span class="mono">${c ? c.seenCount : "—"}</span></div>
    <div class="row spread"><span class="muted">Reward checks this cycle</span>
      <span class="mono">${c ? c.ticks ?? 0 : "—"}</span></div>
    ${r.config.requireAiNode
      ? `<div class="row spread"><span class="muted">AI nodes seen this cycle</span>
      <span class="mono">${c ? c.aiSeenCount : "—"}${c?.aiReads ? ` <span class="muted small">(${c.aiReads.ok} ok / ${c.aiReads.failed} failed)</span>` : ""}</span></div>
    ${!r.config.aiRosterUrl
        ? `<div class="muted small">⚠️ No roster URL set — no one can be verified as running a Koinos AI Node, so cycles will pay nobody and carry over.</div>`
        : c?.aiReads?.accepted === 0 && c?.aiReads?.rejected > 0
          ? `<div class="muted small">⚠️ The roster answered, but none of the ${c.aiReads.rejected} addresses it returned were valid Koinos addresses. A status/display page that shortens addresses (<span class="mono">1AbCdE…wXyZ</span>) can't be paid to — point this at an endpoint that returns full addresses.</div>`
          : c?.aiReads?.lastError
            ? `<div class="muted small">⚠️ Last roster read failed: ${esc(c.aiReads.lastError)}</div>`
            : c?.aiReads?.rejected > 0
              ? `<div class="muted small">⚠️ ${c.aiReads.rejected} roster ${c.aiReads.rejected === 1 ? "entry was" : "entries were"} not a valid Koinos address and ${c.aiReads.rejected === 1 ? "was" : "were"} ignored.</div>`
              : ""}`
      : ""}
    <div class="row spread"><span class="muted">Rewards this cycle</span>
      <span class="mono">${c ? fmtSat(c.rewards, 4) : "—"} ${sym()}</span></div>
    <div class="row spread"><span class="muted">VHP consumed (to reburn)</span>
      <span class="mono">${c ? fmtSat(c.vhpConsumed, 4) : "—"} ${sym()}</span></div>
    <div class="row spread"><span class="muted">Profit to distribute</span>
      <span class="mono">${c ? fmtSat(c.profit, 4) : "—"} ${sym()}</span></div>
    <div class="row spread"><span class="muted">Carried from earlier cycles</span>
      <span class="mono">${d ? fmtSat(d.carry, 4) : "0"} ${sym()}</span></div>
    <hr style="border-color:var(--border);border-style:solid;opacity:.4">
    <div class="row spread"><span class="muted">Reburn queued</span>
      <span class="mono">${q ? fmtSat(q.reburnOwed, 4) : "0"} ${sym()}</span></div>
    <div class="row spread"><span class="muted">Payouts queued</span>
      <span class="mono">${q ? `${q.payouts.length} · ${fmtSat(q.payoutTotal, 4)} ${sym()}` : "0"}</span></div>`;

  const hist = $("#di-history");
  if (hist) {
    const rows = (d?.history ?? []).map((h) => `<tr>
        <td class="small">${fmtTime(h.time)}${h.holdReason ? ` <span class="pill warn">held</span>` : ""}</td>
        <td class="mono">${fmtSat(h.pool, 4)}</td>
        <td class="mono">${fmtSat(h.reburn, 4)}</td>
        <td class="mono">${h.eligibleCount}<span class="muted small"> of ${h.poolCount ?? h.seenCount} seen</span></td>
        <td class="mono">${fmtSat(h.share, 4)}</td>
        <td class="mono">${fmtSat(h.carryOut, 4)}</td>
      </tr>${h.holdReason ? `<tr><td colspan="6" class="muted small">${esc(h.holdReason)}</td></tr>` : ""}`);
    hist.innerHTML = rows.join("") || `<tr><td colspan="6" class="muted">No distributions yet.</td></tr>`;
  }

  const acts = $("#di-actions");
  if (acts) {
    const rows = (d?.actions ?? []).slice(0, 25).map((a) => `<tr>
        <td class="small">${fmtTime(a.time)}</td>
        <td>${a.kind === "reburn" ? "♻️ Reburn → VHP" : `📤 ${esc(shortTx(a.to))}`}</td>
        <td class="mono">${fmtSat(a.amount, 4)}</td>
        <td><button class="link" data-tx="${esc(a.txId)}">${esc(shortTx(a.txId))}</button></td>
      </tr>`);
    acts.innerHTML = rows.join("") || `<tr><td colspan="4" class="muted">No transactions yet.</td></tr>`;
    $$("button[data-tx]", acts).forEach((b) =>
      b.addEventListener("click", () => openTx(b.dataset.tx))
    );
  }
}

// ---------- returns view ----------

function renderReturnsView() {
  const root = $("#view-returns");
  const cfg = S.rewards?.config ?? S.appInfo.settings.rewards;
  root.innerHTML = `
    <h1>Reward returns</h1>
    <p class="lead">Automatically return a percentage of the block rewards your node earns — compound them back into VHP to keep producing, or send them to any address.</p>
    <div class="grid-2">
      <div class="card">
        <h2>⚙️ Configuration</h2>
        <label class="field"><span class="row" style="gap:8px">
          <input type="checkbox" id="r-enabled" ${cfg.enabled ? "checked" : ""} style="width:auto">
          <b>Enable automatic returns</b></span></label>
        <label class="field"><span>Return percentage: <b id="r-pct-label">${cfg.pct}%</b> of new rewards</span>
          <input type="range" id="r-pct" min="0" max="100" step="1" value="${cfg.pct}"></label>
        <label class="field"><span>What to do with returned ${esc(sym())}</span>
          <select id="r-mode">
            <option value="burn" ${cfg.mode === "burn" ? "selected" : ""}>♻️ Compound — burn back into VHP (keeps node producing)</option>
            <option value="send" ${cfg.mode === "send" ? "selected" : ""}>📤 Send to another address</option>
          </select></label>
        <label class="field" id="r-to-wrap" style="display:${cfg.mode === "send" ? "block" : "none"}"><span>Send returns to</span>
          <input id="r-to" type="text" class="mono" placeholder="1…" value="${esc(cfg.toAddress)}"></label>
        <div class="grid-2">
          <label class="field"><span>Minimum return (${esc(sym())})</span>
            <input id="r-min" type="text" class="mono" value="${esc(cfg.minReturnKoin)}"></label>
          <label class="field"><span>Max per return (${esc(sym())})</span>
            <input id="r-max" type="text" class="mono" placeholder="0 = no limit" value="${esc(cfg.maxReturnKoin === "0" ? "" : cfg.maxReturnKoin ?? "")}"></label>
        </div>
        <label class="field"><span>Check every (minutes)</span>
          <input id="r-poll" type="number" min="1" value="${cfg.pollMinutes}"></label>
        <div class="row">
          <button id="r-save" class="btn primary">Save</button>
          <button id="r-now" class="btn">Check now</button>
        </div>
        <p class="hint">Returns are signed locally, so the app must be open with the wallet unlocked. Rewards are read from your node's on-chain block-reward events (the same figure shown on the Dashboard), so deposits and manual burns are never counted.</p>
        <p class="hint">Compounding or sending KOIN spends <b>mana</b>, which recharges over ~5 days — returns are automatically capped to the mana available now and the rest carries over, so a large pending balance is paid down in chunks. Set a <b>Max per return</b> to cap each run yourself.</p>
        <p class="hint">Enabling returns turns off <b>Community distribution</b> — both would spend the same reward KOIN.</p>
      </div>
      <div class="card">
        <h2>📊 Status</h2>
        <div id="r-status" class="stack"></div>
      </div>
    </div>
    <div class="card">
      <h2>🧾 Return history</h2>
      <table><thead><tr><th>When</th><th>Returned</th><th>Mode</th><th>Tx</th></tr></thead>
      <tbody id="r-history"></tbody></table>
    </div>`;

  $("#r-pct").addEventListener("input", () => {
    $("#r-pct-label").textContent = `${$("#r-pct").value}%`;
  });
  $("#r-mode").addEventListener("change", () => {
    $("#r-to-wrap").style.display = $("#r-mode").value === "send" ? "block" : "none";
  });
  $("#r-save").addEventListener("click", onSaveRewards);
  $("#r-now").addEventListener("click", onRunRewardsNow);
  patchReturnsView();
}

async function onSaveRewards() {
  const btn = $("#r-save");
  busyButton(btn, true, "Saving…");
  try {
    await call("rewards:configure", {
      enabled: $("#r-enabled").checked,
      pct: Number($("#r-pct").value),
      mode: $("#r-mode").value,
      toAddress: $("#r-to").value.trim(),
      minReturnKoin: $("#r-min").value.trim(),
      maxReturnKoin: $("#r-max").value.trim() || "0",
      pollMinutes: Number($("#r-poll").value),
    });
    toast("Return settings saved", "good");
    refreshRewards();
  } catch (e) {
    toast(e.message, "bad");
  } finally {
    busyButton(btn, false);
  }
}

async function onRunRewardsNow() {
  const btn = $("#r-now");
  busyButton(btn, true, "Checking…");
  try {
    S.rewards = await call("rewards:runNow");
    patchReturnsView();
    const last = S.rewards.last;
    toast(last?.message || `Check complete: ${last?.outcome ?? "done"}`, last?.outcome === "returned" ? "good" : "info", 7000);
  } catch (e) {
    toast(e.message, "bad");
  } finally {
    busyButton(btn, false);
  }
}

const OUTCOME_LABELS = {
  disabled: ["pill", "disabled"],
  "no-wallet": ["pill warn", "no wallet"],
  locked: ["pill warn", "wallet locked"],
  "rpc-error": ["pill bad", "RPC error"],
  "history-unavailable": ["pill bad", "no history RPC"],
  syncing: ["pill accent", "reading history…"],
  anchored: ["pill accent", "tracking started"],
  accumulating: ["pill accent", "accumulating"],
  "insufficient-liquid": ["pill warn", "low liquid KOIN"],
  "insufficient-mana": ["pill warn", "waiting for mana"],
  returned: ["pill good", "returned"],
  "tx-error": ["pill bad", "tx failed"],
  "config-error": ["pill bad", "config error"],
};

function patchReturnsView() {
  const statusEl = $("#r-status");
  if (!statusEl) return;
  const r = S.rewards;
  if (!r) { statusEl.innerHTML = `<span class="muted">Loading…</span>`; return; }
  const d = r.derived;
  const last = r.last;
  const [pillClass, pillLabel] = last ? OUTCOME_LABELS[last.outcome] ?? ["pill", last.outcome] : ["pill", "no checks yet"];
  statusEl.innerHTML = `
    <div class="row spread"><span class="muted">Engine</span>
      <span class="pill ${r.config.enabled ? "good" : "warn"}">${r.config.enabled ? "enabled" : "disabled"}</span></div>
    <div class="row spread"><span class="muted">Last check</span>
      <span class="small">${last ? `${fmtTime(last.time)} · ` : ""}<span class="${pillClass}">${esc(pillLabel)}</span></span></div>
    ${last?.message ? `<div class="muted small">${esc(last.message)}</div>` : ""}
    <div class="row spread"><span class="muted">Next automatic check</span>
      <span class="small mono">${r.nextRunAt ? fmtTime(r.nextRunAt) : "—"}</span></div>
    <hr style="border-color:var(--border);border-style:solid;opacity:.4">
    <div class="row spread"><span class="muted">Lifetime rewards <span class="small">(Dashboard)</span></span>
      <span class="mono">${d ? fmtSat(d.lifetimeRewards, 4) : "0"} ${sym()}</span></div>
    <div class="row spread"><span class="muted">Rewards since enabled</span>
      <span class="mono">${d && d.anchored ? fmtSat(d.rewardsSinceEnable, 4) : "—"} ${sym()}</span></div>
    <div class="row spread"><span class="muted">Returned</span>
      <span class="mono">${d ? fmtSat(d.returned, 4) : "0"} ${sym()}</span></div>
    <div class="row spread"><span class="muted">Pending return</span>
      <span class="mono">${d ? fmtSat(d.pending, 4) : "0"} ${sym()}</span></div>
    ${r.config.maxReturnKoin && r.config.maxReturnKoin !== "0"
      ? `<div class="row spread"><span class="muted">Max per return</span>
      <span class="mono">${esc(r.config.maxReturnKoin)} ${sym()}</span></div>`
      : ""}`;

  const hist = $("#r-history");
  if (hist) {
    const rows = (d?.actions ?? []).map((a) => {
      return `<tr>
        <td class="small">${fmtTime(a.time)}</td>
        <td class="mono">${fmtSat(a.amount, 4)}</td>
        <td>${a.mode === "burn" ? "♻️ VHP" : "📤 send"}</td>
        <td><button class="link" data-tx="${esc(a.txId)}">${esc(shortTx(a.txId))}</button></td>
      </tr>`;
    });
    hist.innerHTML = rows.join("") || `<tr><td colspan="4" class="muted">No returns yet.</td></tr>`;
    $$("button[data-tx]", hist).forEach((b) =>
      b.addEventListener("click", () => openTx(b.dataset.tx))
    );
  }
}

// ---------- settings view ----------

function renderSettingsView() {
  const root = $("#view-settings");
  const s = S.appInfo.settings;
  const networks = Object.values(S.appInfo.networks);
  root.innerHTML = `
    <h1>Settings</h1>
    <p class="lead">Network, RPC and wallet management.</p>
    <div class="card">
      <h2>🌐 Network</h2>
      <div class="stack">
        ${networks
          .map(
            (n) => `<label class="row" style="gap:8px">
          <input type="radio" name="set-net" value="${n.id}" ${s.network === n.id ? "checked" : ""} style="width:auto">
          <b>${esc(n.label)}</b>
          <span class="muted small">${n.rpcUrls[0] ?? "local node RPC"} · token ${esc(n.tokenSymbol)}</span></label>`
          )
          .join("")}
      </div>
      <p class="hint">Harbinger is the Koinos testnet (worthless tKOIN from the faucet in the Koinos Discord). It has no public RPC — the app talks to your local node once it's running, or set a custom RPC below.</p>
    </div>
    <div class="card">
      <h2>🔌 Custom RPC (optional)</h2>
      ${networks
        .map(
          (n) => `<label class="field"><span>${esc(n.label)} RPC URL</span>
        <input type="text" class="mono set-rpc" data-net="${n.id}" placeholder="${n.rpcUrls[0] ?? n.localRpcUrl}" value="${esc(s.customRpc?.[n.id] ?? "")}"></label>`
        )
        .join("")}
      <label class="field"><span>Liquid ${esc(sym())} to keep when using Max burn</span>
        <input id="set-keep" type="text" class="mono" value="${esc(s.keepLiquidKoin)}" style="max-width:160px"></label>
      <button id="set-save" class="btn primary">Save settings</button>
    </div>
    <div class="card">
      <h2>\u26d3\ufe0f Chain data source</h2>
      <label class="field"><span class="row" style="gap:8px">
        <input type="checkbox" id="set-localrpc" ${s.useLocalNodeRpc !== false ? "checked" : ""} style="width:auto">
        <b>Use my own node for chain data when it's running</b></span></label>
      <div id="set-rpc-now" class="stack"></div>
      <p class="hint">Your node holds the same chain — reading from it keeps the app working when a public endpoint is down or rate-limited, and no query leaves this machine. The public endpoint stays as an automatic fallback. A node that is still syncing is skipped, since it would report stale balances.</p>
      <p class="hint">Block-reward history comes from the node's <span class="mono">account_history</span> service, which this app now runs for you. It indexes from when it was first enabled, so its lifetime totals can start lower than a public endpoint's — the distribution engine re-anchors itself when that happens rather than stalling.</p>
    </div>
    <div class="card">
      <h2>🔐 Wallet security</h2>
      <div class="row">
        <button id="set-reveal" class="btn">Reveal private key</button>
        <button id="set-remove" class="btn danger">Remove wallet from this device</button>
      </div>
      <p class="hint">Files live in <span class="mono">${esc(S.appInfo.userData)}</span> <button class="link" id="set-open">open ↗</button></p>
    </div>`;

  patchRpcSource();
  $("#set-save").addEventListener("click", onSaveSettings);
  $("#set-open").addEventListener("click", () => call("util:openPath", { which: "userData" }).catch(() => {}));
  $("#set-reveal").addEventListener("click", onRevealWif);
  $("#set-remove").addEventListener("click", onRemoveWallet);
}

async function onSaveSettings() {
  const btn = $("#set-save");
  busyButton(btn, true, "Saving…");
  try {
    const network = $$('input[name="set-net"]').find((r) => r.checked)?.value;
    const customRpc = {};
    $$(".set-rpc").forEach((i) => { customRpc[i.dataset.net] = i.value.trim(); });
    const settings = await call("settings:update", {
      network,
      customRpc,
      useLocalNodeRpc: $("#set-localrpc").checked,
      keepLiquidKoin: $("#set-keep").value.trim(),
    });
    S.appInfo.settings = settings;
    $("#network-pill").textContent = net().label;
    toast("Settings saved", "good");
    S.balancesAt = 0;
    await Promise.all([refreshBalances(true), refreshNode(), refreshRewards()]);
    renderBurnView();
  } catch (e) {
    toast(e.message, "bad");
  } finally {
    busyButton(btn, false);
  }
}

function onRevealWif() {
  if (!S.wallet?.exists) return toast("No wallet on this device", "warn");
  showModal({
    title: "Reveal private key",
    body: `
      <p class="small">Enter your password. Never share this key or enter it on websites.</p>
      <label class="field"><span>Password</span><input id="rv-pass" type="password"></label>
      <div id="rv-out"></div>`,
    actions: [
      { label: "Close", onClick: (close) => close() },
      {
        label: "Reveal", class: "primary",
        onClick: async (_close, modal) => {
          try {
            const { wif } = await call("wallet:revealWif", { password: $("#rv-pass", modal).value });
            $("#rv-out", modal).innerHTML = `<div class="wif-box">${esc(wif)}</div>`;
          } catch (e) {
            toast(e.message, "bad");
          }
        },
      },
    ],
  });
}

function onRemoveWallet() {
  if (!S.wallet?.exists) return toast("No wallet on this device", "warn");
  showModal({
    title: "⚠️ Remove wallet",
    body: `
      <p class="small">This deletes the encrypted key file from this device. <b>Without a backup of the private key, the funds are lost forever.</b></p>
      <label class="field"><span>Password</span><input id="rm-pass" type="password"></label>
      <label class="field"><span>Type <b>REMOVE</b> to confirm</span><input id="rm-confirm" type="text" class="mono"></label>`,
    actions: [
      { label: "Cancel", onClick: (close) => close() },
      {
        label: "Remove wallet", class: "danger",
        onClick: async (close, modal) => {
          try {
            await call("wallet:remove", {
              password: $("#rm-pass", modal).value,
              confirm: $("#rm-confirm", modal).value.trim(),
            });
            close();
            toast("Wallet removed from this device", "warn");
            await refreshWallet();
          } catch (e) {
            toast(e.message, "bad");
          }
        },
      },
    ],
  });
}

// Which endpoint chain reads are actually going to right now. Sourced from
// node:status (refreshed on the Node tab) or app:info at startup.
function patchRpcSource() {
  const el = $("#set-rpc-now");
  if (!el) return;
  const r = S.node?.rpc ?? S.appInfo?.rpc ?? null;
  if (!r) { el.innerHTML = `<span class="muted small">Checking…</span>`; return; }
  const label = r.custom
    ? `<span class="pill">custom RPC</span> <span class="mono small">${esc(r.custom)}</span>`
    : r.usingLocal
      ? `<span class="pill good">your node</span> <span class="mono small">${esc(r.active ?? "")}</span>`
      : `<span class="pill warn">public endpoint</span> <span class="mono small">${esc(r.active ?? "")}</span>`;
  const why = r.custom
    ? "A custom RPC overrides everything else."
    : r.usingLocal
      ? "Reading from the node on this machine."
      : r.preferLocal
        ? "Your node isn't answering yet (or is still syncing) — using the public endpoint until it catches up."
        : "Preferring your own node is switched off.";
  el.innerHTML = `
    <div class="row spread"><span class="muted">Serving chain reads</span><span>${label}</span></div>
    <div class="muted small">${esc(why)}</div>
    ${r.fallbacks?.length ? `<div class="row spread"><span class="muted">Fallback</span><span class="mono small">${esc(r.fallbacks.join(", "))}</span></div>` : ""}`;
}

// ---------- navigation + heartbeat ----------

function switchView(view) {
  S.view = view;
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
  if (view === "dashboard") refreshDashboard();
  if (view === "node") refreshNode();
  if (view === "returns") refreshRewards();
  if (view === "distribution") refreshDistribution();
  if (view === "fund") refreshFund();
  if (view === "wallet" || view === "burn") refreshBalances();
}

async function heartbeat() {
  try {
    await refreshWallet();
    if (S.view === "dashboard") await refreshDashboard();
    if (S.view === "wallet" || S.view === "burn") await refreshBalances();
    if (S.view === "node") await refreshNode();
    if (S.view === "returns") await refreshRewards();
    if (S.view === "distribution") await refreshDistribution();
    if (S.view === "fund") await refreshFund();
  } catch { /* keep ticking */ }
}

async function init() {
  S.appInfo = await call("app:info");
  $("#network-pill").textContent = net().label;
  $("#version-tag").textContent = `v${S.appInfo.version}`;

  $$(".nav-item").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.view)));

  window.koinos.onEvent((evt) => {
    if (evt.message) {
      toast(evt.message, evt.level === "error" ? "bad" : evt.type === "rewards" ? "good" : "info", 7000);
    }
    if (evt.type === "node" && S.view === "node") refreshNode();
    if (evt.type === "rewards") { refreshRewards(); S.balancesAt = 0; }
    if (evt.type === "distribution") { refreshDistribution(); S.balancesAt = 0; }
    if ((evt.type === "bridge" || evt.type === "routeC") && S.view === "fund") refreshFundJobs();
    if (S.view === "dashboard") refreshDashboard();
  });

  await refreshWallet();
  renderDashboardView();
  renderNodeView();
  renderDistributionView();
  renderReturnsView();
  renderFundView();
  renderSettingsView();
  refreshDashboard();
  refreshRewards();
  refreshDistribution();

  setInterval(heartbeat, 5000);
}

init().catch((e) => {
  document.body.innerHTML = `<div style="padding:40px;font-family:monospace">Failed to start UI: ${esc(e.message)}</div>`;
});
