"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { encodeQr, byteCapacity, MAX_VERSION } = require("../electron/lib/qr");

const render = (q) => q.modules.map((row) => row.map((v) => (v ? "#" : ".")).join(""));

// ---------- golden symbols ----------
//
// Captured from this encoder and verified module-for-module against an
// independent implementation (python-qrcode), and by decoding the rendered
// image with OpenCV's detector. They exist so a change here has to be
// deliberate: any edit that moves a single module fails this test.

const KOINOS_ADDRESS = "1AUgCZZiiPkPsdK36uNE4H9ihFS7m6AXHo";
const KOINOS_QR = [
  "#######.###.#..##...#.#######",
  "#.....#....####.#.....#.....#",
  "#.###.#.####..####.##.#.###.#",
  "#.###.#..#.##.#..###..#.###.#",
  "#.###.#..###.###..##..#.###.#",
  "#.....#.#.#....#......#.....#",
  "#######.#.#.#.#.#.#.#.#######",
  ".........#.##.###.#.#........",
  "#.#...##.....##.#..#...#..#.#",
  "#.##.#.########..#.#.###.#..#",
  "#..#.####.##...#.###.####...#",
  "#..#.#.##.#..#.##...###..#.#.",
  "##..###.#.##.#..##.##.#.###.#",
  "#.##.#.##...#..##...#.##...#.",
  "#.#..##..#...####..##.#.....#",
  "#.###.....###.#....##...##.#.",
  "###...#....#.##.##..#.##..###",
  ".#.##..#..##.##.#.#.#..#..#..",
  "####.##...###..##.##.#.###..#",
  "...#.#.#...###....#.###..#.#.",
  "###.#.#####.##....#######.###",
  "........#####...#.###...#.###",
  "#######.#.#.####....#.#.##.##",
  "#.....#...###.#...###...##..#",
  "#.###.#....#.####..#######.##",
  "#.###.#...#..##.##..#..#..#.#",
  "#.###.#.#..#######..#...#.###",
  "#.....#...#....##.###..#.#...",
  "#######.#.#.#..#..###..#.#..#",
];

const ETH_ADDRESS = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
const ETH_QR = [
  "#######....##...#.###.#######",
  "#.....#..#.##.##.#..#.#.....#",
  "#.###.#.#.#.....#.#.#.#.###.#",
  "#.###.#.###.##.##.....#.###.#",
  "#.###.#.####.##...###.#.###.#",
  "#.....#.##.....#.##...#.....#",
  "#######.#.#.#.#.#.#.#.#######",
  "........#.###...#.#.#........",
  "#.#####..#.#.#.#.##...#####..",
  ".#.#.#....#####.#..######...#",
  "...#..#.....#..###...#.#.#.#.",
  "###.#...##.##.###......###..#",
  "#.#.####..####.######..#.....",
  "#.##.#.#.##...#....#.##.#...#",
  "..###.#.#....###....##.#.###.",
  "#.#..#...###..#......##.#..#.",
  "##....##.#####.#.#####..#####",
  "#.#.#..###..#.###..#..####..#",
  "#..#####...######.#..######..",
  "#.#.#....##.#..#.....#.##..#.",
  "#.#.#.#....##.###...########.",
  "........#...#.....###...##..#",
  "#######..#.#.###.####.#.#.##.",
  "#.....#.#.#....#..#.#...#..##",
  "#.###.#.#####..####.#########",
  "#.###.#.##..........##..##.##",
  "#.###.#.#####.##.#....####.#.",
  "#.....#..##.#####...###....#.",
  "#######.###..#.#####.#.####..",
];

test("a Koinos address encodes to the expected symbol", () => {
  const q = encodeQr(KOINOS_ADDRESS);
  assert.equal(q.version, 3);
  assert.equal(q.size, 29);
  assert.deepEqual(render(q), KOINOS_QR);
});

test("an Ethereum address encodes to the expected symbol", () => {
  const q = encodeQr(ETH_ADDRESS);
  assert.equal(q.version, 3); // 42 bytes is exactly a version 3 symbol at level M
  assert.deepEqual(render(q), ETH_QR);
});

// ---------- version selection ----------

test("the smallest version that fits is chosen", () => {
  assert.equal(encodeQr("x".repeat(14)).version, 1);
  assert.equal(encodeQr("x".repeat(15)).version, 2);
  assert.equal(encodeQr("x".repeat(26)).version, 2);
  assert.equal(encodeQr("x".repeat(27)).version, 3);
  assert.equal(encodeQr("x".repeat(42)).version, 3);
  assert.equal(encodeQr("x".repeat(43)).version, 4);
  // The count indicator grows from 8 to 16 bits at version 10, which is why
  // the top capacity is 213 rather than 216.
  assert.equal(byteCapacity(10), 213);
  assert.equal(encodeQr("x".repeat(213)).version, 10);
});

test("more data than the largest supported symbol is refused, not truncated", () => {
  assert.throws(() => encodeQr("x".repeat(byteCapacity(MAX_VERSION) + 1)), /Too much data/);
  assert.throws(() => encodeQr(""), /Nothing to encode/);
});

test("text is measured in UTF-8 bytes, not characters", () => {
  // 10 characters, 20 bytes — too many for version 1 (14 bytes).
  assert.equal(encodeQr("ünïcødé ✓ x").version, 2);
});

// ---------- structure ----------

const finderAt = (rows, x0, y0) => {
  const expect = [
    "#######", "#.....#", "#.###.#", "#.###.#", "#.###.#", "#.....#", "#######",
  ];
  return expect.every((line, dy) => rows[y0 + dy].slice(x0, x0 + 7) === line);
};

test("every symbol carries its three finder patterns and timing lines", () => {
  for (const text of [KOINOS_ADDRESS, ETH_ADDRESS, "x".repeat(180)]) {
    const q = encodeQr(text);
    const rows = render(q);
    const n = q.size;
    assert.ok(finderAt(rows, 0, 0), "top-left finder");
    assert.ok(finderAt(rows, n - 7, 0), "top-right finder");
    assert.ok(finderAt(rows, 0, n - 7), "bottom-left finder");
    for (let i = 8; i < n - 8; i++) {
      assert.equal(q.modules[6][i], i % 2 === 0, `horizontal timing at ${i}`);
      assert.equal(q.modules[i][6], i % 2 === 0, `vertical timing at ${i}`);
    }
    assert.equal(q.modules[n - 8][8], true, "the module that is always dark");
  }
});

// Read the 15 format bits back out and undo the BCH mask, which is how a
// scanner learns the error-correction level and which mask to strip.
function readFormat(q) {
  const bit = (x, y) => (q.modules[y][x] ? 1 : 0);
  let bits = 0;
  for (let i = 0; i <= 5; i++) bits |= bit(8, i) << i;
  bits |= bit(8, 7) << 6;
  bits |= bit(8, 8) << 7;
  bits |= bit(7, 8) << 8;
  for (let i = 9; i < 15; i++) bits |= bit(14 - i, 8) << i;
  const data = (bits ^ 0x5412) >>> 10;
  return { ecLevel: (data >> 3) & 3, mask: data & 7 };
}

test("the format information announces level M and the mask that was applied", () => {
  for (const text of ["A", KOINOS_ADDRESS, ETH_ADDRESS, "x".repeat(100)]) {
    const q = encodeQr(text);
    const fmt = readFormat(q);
    assert.equal(fmt.ecLevel, 0, "0b00 is level M");
    assert.equal(fmt.mask, q.mask, "the announced mask is the one that was applied");
  }
});

test("both copies of the format information agree", () => {
  const q = encodeQr(KOINOS_ADDRESS);
  const n = q.size;
  const bit = (x, y) => (q.modules[y][x] ? 1 : 0);
  const first = [];
  for (let i = 0; i <= 5; i++) first.push(bit(8, i));
  first.push(bit(8, 7), bit(8, 8), bit(7, 8));
  for (let i = 9; i < 15; i++) first.push(bit(14 - i, 8));
  const second = [];
  for (let i = 0; i < 8; i++) second.push(bit(n - 1 - i, 8));
  for (let i = 8; i < 15; i++) second.push(bit(8, n - 15 + i));
  assert.deepEqual(first, second);
});

test("versions 7 and up carry the version information block", () => {
  const q = encodeQr("x".repeat(122)); // version 7
  assert.equal(q.version, 7);
  let bits = 0;
  for (let i = 0; i < 18; i++) {
    const a = q.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    if (q.modules[b][a]) bits |= 1 << i;
    // The block appears twice, transposed.
    assert.equal(q.modules[b][a], q.modules[a][b], `version block symmetry at ${i}`);
  }
  assert.equal(bits >>> 12, 7);
});

// ---------- round trip ----------
//
// Strip the mask, walk the placement in reverse, undo the block interleave and
// read the payload back. Anything wrong with masking, placement, interleaving,
// padding or the length header shows up here as a payload that doesn't match.

const ECC_PER_BLOCK_M = [null, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS_M = [null, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];

function functionMap(version, size) {
  const isF = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (x, y) => {
    if (x >= 0 && x < size && y >= 0 && y < size) isF[y][x] = true;
  };
  for (let i = 0; i < size; i++) {
    mark(6, i);
    mark(i, 6);
  }
  for (const [fx, fy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) mark(fx + dx, fy + dy);
  }
  if (version > 1) {
    const numAlign = Math.floor(version / 7) + 2;
    const step = Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
    const pos = [6];
    for (let p = size - 7; pos.length < numAlign; p -= step) pos.splice(1, 0, p);
    for (let i = 0; i < pos.length; i++) {
      for (let j = 0; j < pos.length; j++) {
        const corner =
          (i === 0 && j === 0) ||
          (i === 0 && j === pos.length - 1) ||
          (i === pos.length - 1 && j === 0);
        if (corner) continue;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) mark(pos[i] + dx, pos[j] + dy);
      }
    }
  }
  for (let i = 0; i <= 5; i++) mark(8, i);
  mark(8, 7); mark(8, 8); mark(7, 8);
  for (let i = 9; i < 15; i++) mark(14 - i, 8);
  for (let i = 0; i < 8; i++) mark(size - 1 - i, 8);
  for (let i = 8; i < 15; i++) mark(8, size - 15 + i);
  mark(8, size - 8);
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      mark(a, b);
      mark(b, a);
    }
  }
  return isF;
}

function unmask(q, isF) {
  const inv = (x, y) => {
    switch (q.mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    }
  };
  return q.modules.map((row, y) => row.map((v, x) => (isF[y][x] ? v : inv(x, y) !== v)));
}

function decodePayload(q) {
  const size = q.size;
  const isF = functionMap(q.version, size);
  const m = unmask(q, isF);

  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isF[y][x]) bits.push(m[y][x] ? 1 : 0);
      }
    }
  }
  const stream = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    stream.push(b);
  }

  // Undo the interleave: deal the codewords back out to their blocks.
  const numBlocks = BLOCKS_M[q.version];
  const eccLen = ECC_PER_BLOCK_M[q.version];
  const totalCodewords = stream.length;
  const shortLen = Math.floor(totalCodewords / numBlocks);
  const numShort = numBlocks - (totalCodewords % numBlocks);
  const blocks = Array.from({ length: numBlocks }, () => []);
  let idx = 0;
  const dataLenOf = (b) => shortLen - eccLen + (b < numShort ? 0 : 1);
  const maxData = Math.max(...blocks.map((_, b) => dataLenOf(b)));
  for (let i = 0; i < maxData; i++) {
    for (let b = 0; b < numBlocks; b++) {
      if (i < dataLenOf(b)) blocks[b].push(stream[idx++]);
    }
  }
  const data = [].concat(...blocks);

  // Read the byte-mode header and payload.
  let p = 0;
  const take = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = data[(p + i) >> 3];
      v = (v << 1) | ((byte >> (7 - ((p + i) & 7))) & 1);
    }
    p += n;
    return v;
  };
  const mode = take(4);
  assert.equal(mode, 0b0100, "byte mode");
  const len = take(q.version < 10 ? 8 : 16);
  const bytes = [];
  for (let i = 0; i < len; i++) bytes.push(take(8));
  return Buffer.from(bytes).toString("utf8");
}

test("every symbol reads back as the text it was made from", () => {
  const samples = [
    "A",
    "hello world",
    KOINOS_ADDRESS,
    ETH_ADDRESS,
    "ünïcødé ✓ test",
    "koinos:1AUgCZZiiPkPsdK36uNE4H9ihFS7m6AXHo?amount=10",
    "x".repeat(14),   // version 1, exactly full
    "y".repeat(15),   // version 2
    "z".repeat(42),   // version 3, exactly full
    "q".repeat(43),   // version 4
    "k".repeat(84),   // version 5
    "m".repeat(106),  // version 6
    "n".repeat(122),  // version 7 — version block appears
    "p".repeat(152),  // version 8
    "r".repeat(180),  // version 9
    "s".repeat(213),  // version 10, the maximum
  ];
  for (const text of samples) {
    assert.equal(decodePayload(encodeQr(text)), text, `round trip: ${text.slice(0, 20)}`);
  }
});

test("all eight masks encode the same payload", () => {
  // The mask is cosmetic — whichever one the penalty score picks, the data
  // underneath has to be identical.
  for (let mask = 0; mask < 8; mask++) {
    const q = encodeQr(KOINOS_ADDRESS, { mask });
    assert.equal(q.mask, mask);
    assert.equal(readFormat(q).mask, mask);
    assert.equal(decodePayload(q), KOINOS_ADDRESS);
  }
});

test("a spread of generated payloads all round trip", () => {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:/?=&.-_ ";
  let seed = 20260903;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 120; i++) {
    const len = 1 + Math.floor(rnd() * 213);
    let text = "";
    for (let j = 0; j < len; j++) text += alphabet[Math.floor(rnd() * alphabet.length)];
    assert.equal(decodePayload(encodeQr(text)), text, `length ${len}`);
  }
});
