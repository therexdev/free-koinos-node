"use strict";

// Pure profit/return math for the dashboard: daily profit buckets, rolling
// realized windows (24h / 7d / 30d), and yearly projections (simple, and
// compounded at the user's reburn rate). Amounts are integer satoshi strings;
// the yearly projection uses Number since it's an estimate, not accounting.

const DAY_MS = 86400000;

const dayKey = (timeMs) => Math.floor(Number(timeMs) / DAY_MS);

// Fold a classified block record into daily profit buckets (mutates + returns).
function addBlockToDaily(daily, rec) {
  if (!rec || rec.type !== "block" || !rec.time) return daily;
  const k = dayKey(rec.time);
  daily[k] = (BigInt(daily[k] ?? "0") + BigInt(rec.profit ?? "0")).toString();
  return daily;
}

function sumFromDay(daily, fromDay) {
  let sum = 0n;
  for (const k of Object.keys(daily)) if (Number(k) >= fromDay) sum += BigInt(daily[k]);
  return sum;
}

// Drop buckets older than `keepDays` (keeps the map bounded). Mutates.
function pruneDaily(daily, nowMs, keepDays = 400) {
  const cutoff = dayKey(nowMs) - keepDays;
  for (const k of Object.keys(daily)) if (Number(k) < cutoff) delete daily[k];
  return daily;
}

// Rolling realized profit windows + the average daily rate used for projections.
//   daily:  { [dayKey]: profitSats }        (backfilled from block history)
//   recent: [{ time, profit }]              (recent blocks, for the true 24h window)
function computeWindows(daily, recent, nowMs) {
  const today = dayKey(nowMs);
  const last7d = sumFromDay(daily, today - 6).toString();
  const last30d = sumFromDay(daily, today - 29).toString();

  let last24h = 0n;
  const cut = Number(nowMs) - DAY_MS;
  for (const r of recent || []) if (Number(r.time) >= cut) last24h += BigInt(r.profit ?? "0");

  // Average daily profit over the tracked span (capped at 30 days), so the rate
  // is stable for lumpy producers and honest for young nodes.
  const days = Object.keys(daily).map(Number);
  const spanDays = days.length ? Math.min(30, today - Math.min(...days) + 1) : 0;
  const avgDailyProfit = spanDays > 0 ? (sumFromDay(daily, today - 29) / BigInt(spanDays)).toString() : "0";

  return { last24h: last24h.toString(), last7d, last30d, avgDailyProfit, daysTracked: spanDays };
}

// Yearly projections from the current rate.
//   avgDailyProfitSats: net KOIN/day (sats)
//   stakeSats:          producing stake = VHP balance (sats), the return basis
//   reburnFraction:     0..1 share of rewards reburned to VHP (compounding)
// Returns KOIN amounts (sats strings) and percentages (numbers), or nulls when
// the stake is unknown (can't express a %).
function projectReturns({ avgDailyProfitSats, stakeSats, reburnFraction } = {}) {
  const avgDaily = Number(avgDailyProfitSats || 0);
  const stake = Number(stakeSats || 0);
  const r = Math.max(0, Math.min(1, Number(reburnFraction) || 0));
  const yearlyProfit = avgDaily * 365;

  const out = {
    reburnFraction: r,
    yearlyProfitSats: String(Math.round(yearlyProfit)),
    yearlyReturnPct: stake > 0 ? (yearlyProfit / stake) * 100 : null,
    yearlyProfitReburnSats: null,
    yearlyReturnReburnPct: null,
  };

  if (stake > 0) {
    const i = avgDaily / stake; // daily yield on stake
    // Compounded yearly-profit-to-stake factor when a fraction r of profit is
    // reinvested daily. r→0 reduces to the simple APR (i*365); r=1 is full
    // compounding (1+i)^365 − 1. Assumes constant network conditions.
    const factor = r <= 0 ? i * 365 : (Math.pow(1 + i * r, 365) - 1) / r;
    out.yearlyReturnReburnPct = factor * 100;
    out.yearlyProfitReburnSats = String(Math.round(stake * factor));
  }
  return out;
}

module.exports = { DAY_MS, dayKey, addBlockToDaily, pruneDaily, computeWindows, projectReturns };
