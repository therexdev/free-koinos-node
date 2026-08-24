"use strict";

const HOLD_MS = 10 * 60 * 1000; // how long a held value is still worth showing

// Keeps the last successful result of a flaky read and serves it while the
// source is failing. The dashboard polls the chain every few seconds; without
// this, one timed-out RPC call blanks every tile to "—" and the next poll pops
// them back, which reads as flickering rather than as a hiccup.
//
// A held value is marked `stale` (with the error that caused the hold) so the
// UI can say the figures may be out of date, and it is only held for a bounded
// time — an endpoint that has been down for ten minutes should stop pretending.
class LastGood {
  constructor({ holdMs = HOLD_MS } = {}) {
    this.holdMs = holdMs;
    this._held = new Map(); // key -> { value, at }
  }

  // Runs fn(); on success caches and returns its value, on failure returns the
  // held value flagged stale, or { error } when there is nothing worth holding.
  async run(key, fn, now = Date.now()) {
    try {
      const value = await fn();
      this._held.set(key, { value, at: now });
      return value;
    } catch (e) {
      const message = String(e && e.message ? e.message : e);
      const held = this._held.get(key);
      if (!held || now - held.at > this.holdMs) return { error: message };
      return { ...held.value, stale: true, staleAt: held.at, staleError: message };
    }
  }

  get(key) {
    return this._held.get(key)?.value ?? null;
  }

  clear() {
    this._held.clear();
  }
}

module.exports = { LastGood, HOLD_MS };
