"use strict";
/* Koinos Cloud Node — testing front-end (PWA seed).
 * Talks to a core-agent (provision/stop/start/delete) and to a Koinos RPC
 * (register_public_key, burn KOIN->VHP, balances) using vendored koilib. The
 * user's main key stays in this browser; only the node's PUBLIC key is sent to
 * the agent. Mirrors electron/lib/chain.js so on-chain behavior matches the app. */

const { Signer, Provider, Contract, Transaction, utils } = window;

// Fallback mainnet addresses (resolved live via get_contract_address when possible).
const FALLBACK = {
  koin: "19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK",
  vhp: "12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq",
  pob: "159myq5YUhhoVWu3wsHKHiJYKPKGUrGiyv",
};
const SATS = 100000000n;
let POB_ABI = null, TOKEN_ABI = null, ADDRS = { ...FALLBACK };

const $ = (id) => document.getElementById(id);
const store = {
  get: (k, d = "") => localStorage.getItem("kcn." + k) ?? d,
  set: (k, v) => localStorage.setItem("kcn." + k, v),
  del: (k) => localStorage.removeItem("kcn." + k),
};
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $("toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}

// ---------- formatting ----------
function satsToStr(sats) {
  const n = BigInt(sats || 0); const whole = n / SATS; let frac = (n % SATS).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
function koinToSats(str) {
  const s = String(str).trim(); if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") throw new Error("Invalid amount");
  const [w, f = ""] = s.split("."); return (BigInt(w || "0") * SATS + BigInt((f + "00000000").slice(0, 8))).toString();
}

// ---------- config / koilib ----------
const cfg = () => ({ agentUrl: store.get("agentUrl").replace(/\/+$/, ""), token: store.get("agentToken"), rpc: store.get("rpcUrl", "https://api.koinos.io") });
const provider = () => new Provider([cfg().rpc || "https://api.koinos.io"]);
function signer() {
  const wif = store.get("wif"); if (!wif) return null;
  const s = Signer.fromWif(wif); s.provider = provider(); return s;
}
async function resolveAddrs() {
  const p = provider(); const out = { ...FALLBACK };
  await Promise.all(["koin", "vhp", "pob"].map(async (n) => {
    try { const r = await p.invokeGetContractAddress(n); const a = r?.value?.address; if (a) out[n] = a; } catch {}
  }));
  ADDRS = out; return out;
}
function contract(kind, s) {
  return new Contract({ id: ADDRS[kind], abi: kind === "pob" ? POB_ABI : TOKEN_ABI, provider: provider(), signer: s });
}

// ---------- core-agent ----------
async function agent(path, { method = "GET", body } = {}) {
  const { agentUrl, token } = cfg();
  if (!agentUrl) throw new Error("Set the core-agent URL in Connection settings");
  const res = await fetch(agentUrl + path, {
    method,
    headers: { "x-agent-token": token, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Agent error ${res.status}`);
  return data;
}

// ---------- chain ops (mirror electron/lib/chain.js) ----------
async function getBalances(address) {
  const p = provider();
  const [k, v, rc] = await Promise.all([
    contract("koin").functions.balance_of({ owner: address }),
    contract("vhp").functions.balance_of({ owner: address }),
    p.getAccountRc(address).catch(() => "0"),
  ]);
  return { koin: k?.result?.value ?? "0", vhp: v?.result?.value ?? "0", mana: rc ?? "0" };
}
async function registeredKey(producer) {
  try { const r = await contract("pob").functions.get_public_key({ producer }); return r?.result?.value ?? null; } catch { return null; }
}
async function registerKey(s, publicKey) {
  const producer = s.getAddress();
  const rcLimit = await provider().getAccountRc(producer).catch(() => undefined);
  const pob = contract("pob", s);
  await pob.functions.register_public_key({ producer, public_key: String(publicKey).trim() }, rcLimit ? { rcLimit } : {});
}
async function burnKoin(s, amountSat) {
  const address = s.getAddress();
  const rcLimit = await provider().getAccountRc(address).catch(() => undefined);
  const koin = contract("koin", s), pob = contract("pob", s);
  const tx = new Transaction({ signer: s, provider: provider(), options: rcLimit ? { rcLimit } : {} });
  await tx.pushOperation(koin.functions.approve, { owner: address, spender: ADDRS.pob, value: String(amountSat) });
  await tx.pushOperation(pob.functions.burn, { token_amount: String(amountSat), burn_address: address, vhp_address: address });
  await tx.send();
  if (tx.wait) { try { await tx.wait("byBlock", 30000); } catch {} }
}

// ---------- rendering ----------
function renderConn() {
  $("agentUrl").value = store.get("agentUrl"); $("agentToken").value = store.get("agentToken");
  $("rpcUrl").value = store.get("rpcUrl", "https://api.koinos.io");
  const ok = !!cfg().agentUrl; $("connState").textContent = ok ? "  ✓ configured" : "  — not set";
  if (!ok) $("connDetails").open = true;
}
let curAddress = null;
function renderWallet() {
  const s = signer();
  if (!s) { $("walletNone").classList.remove("hide"); $("walletInfo").classList.add("hide"); $("walletDot").className = "dot bad"; $("startNode").disabled = true; return; }
  curAddress = s.getAddress();
  $("walletNone").classList.add("hide"); $("walletInfo").classList.remove("hide"); $("walletDot").className = "dot ok";
  $("wAddr").textContent = curAddress; $("startNode").disabled = false;
  refreshBalances();
}
async function refreshBalances() {
  if (!curAddress) return;
  try { await resolveAddrs(); const b = await getBalances(curAddress);
    $("wKoin").textContent = satsToStr(b.koin); $("wVhp").textContent = satsToStr(b.vhp); $("wMana").textContent = satsToStr(b.mana);
  } catch (e) { toast("Balance error: " + e.message); }
}
function getNode() { try { return JSON.parse(store.get("node", "null")); } catch { return null; } }
function setNode(n) { n ? store.set("node", JSON.stringify(n)) : store.del("node"); }
function renderNode() {
  const n = getNode();
  if (!n) { $("nodeNone").classList.remove("hide"); $("nodeInfo").classList.add("hide"); $("nodeDot").className = "dot"; return; }
  $("nodeNone").classList.add("hide"); $("nodeInfo").classList.remove("hide");
  $("pubkey").value = n.publicKey || "";
  refreshNodeStatus();
}
async function refreshNodeStatus() {
  const n = getNode(); if (!n) return;
  // agent status
  try {
    const [st, core] = await Promise.all([agent("/producers/" + n.id), agent("/core").catch(() => null)]);
    const pill = $("nodeStatePill");
    pill.textContent = st.running ? "running" : (st.containerState || "stopped");
    pill.className = "pill " + (st.running ? "on" : "off");
    $("nodeDot").className = "dot " + (st.running ? "ok" : "bad");
    $("stopNode").classList.toggle("hide", !st.running); $("startAgain").classList.toggle("hide", st.running);
    if (core) $("coreSync").textContent = core.synced === true ? "synced" : (core.blocksBehind != null ? core.blocksBehind + " behind" : "—");
  } catch (e) { $("nodeStatePill").textContent = "agent?"; $("nodeStatePill").className = "pill off"; }
  // on-chain registration
  try {
    const reg = await registeredKey(n.producerAddress || curAddress);
    const ok = reg && reg === n.publicKey;
    const p = $("regPill"); p.textContent = ok ? "yes" : (reg ? "other key" : "no"); p.className = "pill " + (ok ? "on" : "off");
    $("registerKey").classList.toggle("hide", !!ok);
  } catch {}
}

// ---------- actions ----------
function busy(btn, fn) {
  return async () => { const t = btn.textContent; btn.disabled = true; btn.textContent = "…";
    try { await fn(); } catch (e) { toast(e.message || String(e)); } finally { btn.disabled = false; btn.textContent = t; } };
}

$("saveConn").onclick = () => {
  store.set("agentUrl", $("agentUrl").value.trim()); store.set("agentToken", $("agentToken").value.trim());
  store.set("rpcUrl", $("rpcUrl").value.trim() || "https://api.koinos.io");
  renderConn(); toast("Saved"); renderWallet(); renderNode();
};
$("genWallet").onclick = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const s = new Signer({ privateKey: hex }); store.set("wif", s.getPrivateKey("wif"));
  toast("Wallet created — export & back up the WIF"); renderWallet();
};
$("showImport").onclick = () => $("importBox").classList.toggle("hide");
$("importWallet").onclick = () => {
  try { const wif = $("wifIn").value.trim(); Signer.fromWif(wif); store.set("wif", wif); $("wifIn").value = ""; renderWallet(); toast("Imported"); }
  catch { toast("Invalid WIF"); }
};
$("exportWif").onclick = () => { const w = store.get("wif"); navigator.clipboard?.writeText(w); toast("WIF copied to clipboard"); };
$("forgetWallet").onclick = () => { if (confirm("Forget this wallet from the browser? Make sure you exported the WIF.")) { store.del("wif"); curAddress = null; renderWallet(); } };
$("refreshBal").onclick = refreshBalances;

$("startNode").onclick = busy($("startNode"), async () => {
  const r = await agent("/producers", { method: "POST", body: { producerAddress: curAddress } });
  setNode({ id: r.id, publicKey: r.publicKey, producerAddress: curAddress });
  toast("Node provisioned"); renderNode();
});
$("copyPub").onclick = () => { navigator.clipboard?.writeText($("pubkey").value); toast("Public key copied"); };
$("registerKey").onclick = busy($("registerKey"), async () => {
  const s = signer(); const n = getNode(); if (!s || !n) throw new Error("No wallet/node");
  await resolveAddrs(); await registerKey(s, n.publicKey);
  toast("Registered — the node can now produce for you"); setTimeout(refreshNodeStatus, 3000);
});
$("burnBtn").onclick = busy($("burnBtn"), async () => {
  const s = signer(); if (!s) throw new Error("No wallet");
  const sat = koinToSats($("burnAmt").value); if (BigInt(sat) <= 0n) throw new Error("Enter an amount");
  await resolveAddrs(); await burnKoin(s, sat);
  toast("Burned KOIN → VHP"); $("burnAmt").value = ""; setTimeout(refreshBalances, 3000);
});
$("stopNode").onclick = busy($("stopNode"), async () => { const n = getNode(); await agent("/producers/" + n.id + "/stop", { method: "POST" }); toast("Paused"); refreshNodeStatus(); });
$("startAgain").onclick = busy($("startAgain"), async () => { const n = getNode(); await agent("/producers/" + n.id + "/start", { method: "POST" }); toast("Resumed"); refreshNodeStatus(); });
$("deleteNode").onclick = busy($("deleteNode"), async () => {
  const n = getNode(); if (!confirm("Delete the node and wipe its signing key?")) return;
  await agent("/producers/" + n.id, { method: "DELETE" }); setNode(null); toast("Deleted"); renderNode();
});

// ---------- init ----------
(async function init() {
  [POB_ABI, TOKEN_ABI] = await Promise.all([
    fetch("vendor/pob-abi.json").then((r) => r.json()),
    fetch("vendor/token-abi.json").then((r) => r.json()),
  ]);
  renderConn(); renderWallet(); renderNode();
  setInterval(() => { if (getNode()) refreshNodeStatus(); }, 15000);
})();
