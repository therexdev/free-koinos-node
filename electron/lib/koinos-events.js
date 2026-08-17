"use strict";

const { utils } = require("koilib");

// Decoders and classifiers for Koinos token events and account-history
// entries. Pure and offline (koilib utils are pure) so this is unit-tested.

// Minimal protobuf reader: returns a map of fieldNumber -> value.
// Length-delimited fields become Buffers; varints become BigInt.
function readProtoFields(buf) {
  const fields = {};
  let i = 0;
  while (i < buf.length) {
    const tag = readVarint(buf, i);
    i = tag.next;
    const fieldNum = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (wireType === 2) {
      const len = readVarint(buf, i);
      i = len.next;
      const n = Number(len.value);
      fields[fieldNum] = buf.subarray(i, i + n);
      i += n;
    } else if (wireType === 0) {
      const v = readVarint(buf, i);
      fields[fieldNum] = v.value;
      i = v.next;
    } else if (wireType === 5) {
      fields[fieldNum] = BigInt(buf.readUInt32LE(i));
      i += 4;
    } else if (wireType === 1) {
      fields[fieldNum] = buf.readBigUInt64LE(i);
      i += 8;
    } else {
      break; // unsupported wire type
    }
  }
  return fields;
}

function readVarint(buf, start) {
  let value = 0n;
  let shift = 0n;
  let i = start;
  while (i < buf.length) {
    const byte = buf[i++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
  }
  return { value, next: i };
}

function toBuf(data) {
  return Buffer.isBuffer(data) ? data : Buffer.from(utils.decodeBase64url(String(data)));
}

function addr(bytes) {
  return bytes && bytes.length ? utils.encodeBase58(bytes) : null;
}

// token.burn_event { from: bytes(1), value: uint64(2) }
function decodeBurn(data) {
  const f = readProtoFields(toBuf(data));
  return { from: addr(f[1]), value: (f[2] ?? 0n).toString() };
}

// token.mint_event { to: bytes(1), value: uint64(2) }
function decodeMint(data) {
  const f = readProtoFields(toBuf(data));
  return { to: addr(f[1]), value: (f[2] ?? 0n).toString() };
}

// token.transfer_event { from: bytes(1), to: bytes(2), value: uint64(3) }
function decodeTransfer(data) {
  const f = readProtoFields(toBuf(data));
  return { from: addr(f[1]), to: addr(f[2]), value: (f[3] ?? 0n).toString() };
}

const eventShortName = (name) => String(name || "").split(".").pop();

// Classify one account-history entry for `address`. `contracts` supplies the
// koin and vhp contract IDs so we can tell which token an event belongs to.
// Returns a normalized record, or null if nothing relevant.
function classifyEntry(entry, { address, contracts }) {
  const koin = contracts.koin;
  const vhp = contracts.vhp;

  // A block this address produced: reward mint + VHP burn live in the receipt.
  const header = entry.block?.header;
  if (header && header.signer === address) {
    const events = entry.block?.receipt?.events ?? [];
    let vhpBurned = "0";
    let reward = "0";
    for (const e of events) {
      const name = eventShortName(e.name);
      if (name === "burn_event" && e.source === vhp) {
        const d = decodeBurn(e.data);
        if (d.from === address) vhpBurned = d.value;
      } else if (name === "mint_event" && e.source === koin) {
        const d = decodeMint(e.data);
        if (d.to === address) reward = d.value;
      }
    }
    return {
      type: "block",
      seqNum: entry.seq_num,
      height: Number(header.height),
      time: Number(header.timestamp),
      vhpBurned,
      reward,
      profit: (BigInt(reward) - BigInt(vhpBurned)).toString(),
    };
  }

  // A transaction touching this address: look for transfers and manual burns.
  const trx = entry.trx?.transaction ?? entry.trx;
  const events = entry.trx?.receipt?.events ?? entry.receipt?.events ?? [];
  if (!events.length) return null;

  let depositIn = "0";
  let sentOut = "0";
  let koinBurned = "0";
  for (const e of events) {
    const name = eventShortName(e.name);
    if (name === "transfer_event" && e.source === koin) {
      const d = decodeTransfer(e.data);
      if (d.to === address) depositIn = addStr(depositIn, d.value);
      if (d.from === address) sentOut = addStr(sentOut, d.value);
    } else if (name === "burn_event" && e.source === koin) {
      const d = decodeBurn(e.data);
      if (d.from === address) koinBurned = addStr(koinBurned, d.value);
    }
  }
  if (koinBurned !== "0") {
    return { type: "burn", seqNum: entry.seq_num, id: trx?.id ?? null, amount: koinBurned };
  }
  if (depositIn !== "0") {
    return { type: "deposit", seqNum: entry.seq_num, id: trx?.id ?? null, amount: depositIn };
  }
  if (sentOut !== "0") {
    return { type: "sent", seqNum: entry.seq_num, id: trx?.id ?? null, amount: sentOut };
  }
  return null;
}

function addStr(a, b) {
  return (BigInt(a) + BigInt(b)).toString();
}

// Fold classified records into cumulative totals.
function accumulate(totals, rec) {
  const t = { ...totals };
  if (rec.type === "block") {
    t.blocks = (t.blocks ?? 0) + 1;
    t.rewards = addStr(t.rewards ?? "0", rec.reward);
    t.vhpConsumed = addStr(t.vhpConsumed ?? "0", rec.vhpBurned);
    t.profit = (BigInt(t.rewards) - BigInt(t.vhpConsumed)).toString();
  } else if (rec.type === "deposit") {
    t.depositsIn = addStr(t.depositsIn ?? "0", rec.amount);
  } else if (rec.type === "burn") {
    t.burned = addStr(t.burned ?? "0", rec.amount);
  } else if (rec.type === "sent") {
    t.sentOut = addStr(t.sentOut ?? "0", rec.amount);
  }
  return t;
}

const EMPTY_TOTALS = {
  blocks: 0,
  rewards: "0",
  vhpConsumed: "0",
  profit: "0",
  depositsIn: "0",
  burned: "0",
  sentOut: "0",
};

module.exports = {
  readProtoFields,
  decodeBurn,
  decodeMint,
  decodeTransfer,
  classifyEntry,
  accumulate,
  EMPTY_TOTALS,
};
