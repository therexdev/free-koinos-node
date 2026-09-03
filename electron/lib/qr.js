"use strict";

// A minimal QR Code encoder — byte mode, error-correction level M, versions
// 1–10 (up to 213 bytes). That is far more than the wallet needs: a Koinos
// address is 34 characters and an Ethereum address 42, both of which fit in a
// version 3 symbol.
//
// It lives here rather than in the renderer so it can be unit-tested with the
// rest of the suite, and so the renderer keeps needing no third-party script
// (the window's CSP allows no external code at all). The caller gets a plain
// matrix of booleans and draws it however it likes.
//
// The encoding follows ISO/IEC 18004. Every symbol this produces is checked
// module-for-module against an independent implementation in the test suite.

const ECC_PER_BLOCK_M = [null, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS_M = [null, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const MIN_VERSION = 1;
const MAX_VERSION = 10;
const PAD_BYTES = [0xec, 0x11]; // the spec's alternating filler

// Modules available for data + ECC, before the format/version information.
function rawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function rawCodewords(version) {
  return Math.floor(rawDataModules(version) / 8);
}

function dataCodewords(version) {
  return rawCodewords(version) - ECC_PER_BLOCK_M[version] * BLOCKS_M[version];
}

// How many bytes of payload a version holds: the data capacity less the mode
// indicator (4 bits) and the character count (8 bits below version 10, 16 at
// and above it).
function byteCapacity(version) {
  const countBits = version < 10 ? 8 : 16;
  return Math.floor((dataCodewords(version) * 8 - 4 - countBits) / 8);
}

function alignmentPositions(version) {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const step = Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

// ---- GF(256) arithmetic for Reed–Solomon (primitive polynomial 0x11D) ----

function gfMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

// Coefficients of the generator polynomial of the given degree.
function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] ^= gfMultiply(coef, factor);
    });
  }
  return result;
}

// ---- payload → interleaved codewords ----

function utf8Bytes(text) {
  return Array.from(Buffer.from(String(text), "utf8"));
}

function pickVersion(byteLen) {
  for (let v = MIN_VERSION; v <= MAX_VERSION; v++) {
    if (byteLen <= byteCapacity(v)) return v;
  }
  throw new Error(
    `Too much data for a QR code: ${byteLen} bytes, limit ${byteCapacity(MAX_VERSION)}`
  );
}

function bitStream(bytes, version) {
  const bits = [];
  const push = (value, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);

  const capacityBits = dataCodewords(version) * 8;
  push(0, Math.min(4, capacityBits - bits.length)); // terminator
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  for (let i = 0; codewords.length < dataCodewords(version); i++) {
    codewords.push(PAD_BYTES[i % PAD_BYTES.length]);
  }
  return codewords;
}

// Split into blocks, append each block's ECC, and interleave — the shuffle that
// lets a burst of damage hit every block a little instead of one block fatally.
function addEccAndInterleave(data, version) {
  const numBlocks = BLOCKS_M[version];
  const blockEccLen = ECC_PER_BLOCK_M[version];
  const raw = rawCodewords(version);
  const numShortBlocks = numBlocks - (raw % numBlocks);
  const shortBlockLen = Math.floor(raw / numBlocks);

  const divisor = rsDivisor(blockEccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const len = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
    const dat = data.slice(k, k + len);
    k += len;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShortBlocks) dat.push(0); // pad short blocks so the walk is square
    blocks.push(dat.concat(ecc));
  }

  const result = [];
  for (let i = 0; i < blocks[0].length; i++) {
    for (let j = 0; j < blocks.length; j++) {
      // Skip the padding slot added to the short blocks above.
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(blocks[j][i]);
    }
  }
  return result;
}

// ---- symbol construction ----

class Symbol_ {
  constructor(version) {
    this.version = version;
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    // Function modules (finders, timing, alignment, format) are never masked
    // and never carry data.
    this.isFunction = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
  }

  set(x, y, dark) {
    this.modules[y][x] = dark;
    this.isFunction[y][x] = true;
  }

  drawFunctionPatterns() {
    for (let i = 0; i < this.size; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    this.finder(3, 3);
    this.finder(this.size - 4, 3);
    this.finder(3, this.size - 4);

    const pos = alignmentPositions(this.version);
    for (let i = 0; i < pos.length; i++) {
      for (let j = 0; j < pos.length; j++) {
        // The three corners are already occupied by finder patterns.
        const corner =
          (i === 0 && j === 0) ||
          (i === 0 && j === pos.length - 1) ||
          (i === pos.length - 1 && j === 0);
        if (!corner) this.alignment(pos[i], pos[j]);
      }
    }
    this.drawFormatBits(0); // placeholder; rewritten once the mask is chosen
    this.drawVersion();
  }

  finder(x, y) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) {
          this.set(xx, yy, dist !== 2 && dist !== 4);
        }
      }
    }
  }

  alignment(x, y) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  // 15 bits of BCH-protected format information, written twice.
  drawFormatBits(mask) {
    const data = (0b00 << 3) | mask; // level M is 0b00
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i) => ((bits >>> i) & 1) !== 0;

    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
    this.set(8, 7, bit(6));
    this.set(8, 8, bit(7));
    this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));

    for (let i = 0; i < 8; i++) this.set(this.size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.set(8, this.size - 15 + i, bit(i));
    this.set(8, this.size - 8, true); // the module that is always dark
  }

  drawVersion() {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.set(a, b, dark);
      this.set(b, a, dark);
    }
  }

  // Walk the symbol in two-module columns, bottom-right to top-left, snaking
  // up and down and stepping over the vertical timing pattern.
  drawCodewords(data) {
    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
          // Any leftover modules stay light, and are masked like data.
        }
      }
    }
  }

  applyMask(mask) {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (this.isFunction[y][x]) continue;
        let invert;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        }
        if (invert) this.modules[y][x] = !this.modules[y][x];
      }
    }
  }

  // The spec's four penalty rules, in the ISO/IEC 18004:2015 formulation.
  // Lower is better; the mask that scores lowest is the one that ships.
  //
  // Rule 3 — the finder pattern's own 1:1:3:1:1 signature turning up in the
  // data, where it would give a scanner a false landmark — is the rule the
  // standard words loosely, and encoders read it differently. A symbol from
  // here can therefore carry a different mask from one produced elsewhere for
  // the same text. That is cosmetic: the eight masks all encode the same data
  // and all decode to the same string; the score only picks the one least
  // likely to trouble a scanner.
  penalty() {
    const N1 = 3, N2 = 3, N3 = 40, N4 = 10;
    let result = 0;

    const addHistory = (run, history) => {
      if (history[0] === 0) run += this.size; // light border before the first run
      history.pop();
      history.unshift(run);
    };
    const countPatterns = (h) => {
      const n = h[1];
      const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
      return (
        (core && h[0] >= n * 4 && h[6] >= n ? 1 : 0) + (core && h[6] >= n * 4 && h[0] >= n ? 1 : 0)
      );
    };
    const terminate = (color, run, history) => {
      if (color) {
        addHistory(run, history);
        run = 0;
      }
      run += this.size; // light border after the last run
      addHistory(run, history);
      return countPatterns(history);
    };

    for (let y = 0; y < this.size; y++) {
      let color = false;
      let run = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      for (let x = 0; x < this.size; x++) {
        if (this.modules[y][x] === color) {
          run++;
          if (run === 5) result += N1;
          else if (run > 5) result++;
        } else {
          addHistory(run, history);
          if (!color) result += countPatterns(history) * N3;
          color = this.modules[y][x];
          run = 1;
        }
      }
      result += terminate(color, run, history) * N3;
    }
    for (let x = 0; x < this.size; x++) {
      let color = false;
      let run = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      for (let y = 0; y < this.size; y++) {
        if (this.modules[y][x] === color) {
          run++;
          if (run === 5) result += N1;
          else if (run > 5) result++;
        } else {
          addHistory(run, history);
          if (!color) result += countPatterns(history) * N3;
          color = this.modules[y][x];
          run = 1;
        }
      }
      result += terminate(color, run, history) * N3;
    }

    for (let y = 0; y < this.size - 1; y++) {
      for (let x = 0; x < this.size - 1; x++) {
        const c = this.modules[y][x];
        if (c === this.modules[y][x + 1] && c === this.modules[y + 1][x] && c === this.modules[y + 1][x + 1]) {
          result += N2;
        }
      }
    }

    let dark = 0;
    for (const row of this.modules) for (const cell of row) if (cell) dark++;
    const total = this.size * this.size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    return result + k * N4;
  }
}

// Encode `text` and return the finished symbol as a matrix of booleans
// (true = dark), row-major, with no quiet zone.
function encodeQr(text, { mask: forcedMask = null } = {}) {
  const bytes = utf8Bytes(text);
  if (bytes.length === 0) throw new Error("Nothing to encode");
  const version = pickVersion(bytes.length);
  const codewords = addEccAndInterleave(bitStream(bytes, version), version);

  const sym = new Symbol_(version);
  sym.drawFunctionPatterns();
  sym.drawCodewords(codewords);

  // Try all eight masks and keep the least ugly one, as the spec requires.
  // (A mask can be forced, which the tests use to isolate mask selection from
  // everything that happens before it.)
  let bestMask = forcedMask ?? 0;
  let bestPenalty = Infinity;
  for (let mask = 0; forcedMask === null && mask < 8; mask++) {
    sym.applyMask(mask);
    sym.drawFormatBits(mask);
    const p = sym.penalty();
    if (p < bestPenalty) {
      bestPenalty = p;
      bestMask = mask;
    }
    sym.applyMask(mask); // masking is its own inverse
  }
  sym.applyMask(bestMask);
  sym.drawFormatBits(bestMask);

  return {
    version,
    size: sym.size,
    mask: bestMask,
    modules: sym.modules.map((row) => row.slice()),
  };
}

module.exports = { encodeQr, byteCapacity, MAX_VERSION };
