/* SPDX-License-Identifier: GPL-3.0-or-later */

// Minimal, dependency-free PNG decoder (8-bit, non-interlaced) with an inline
// DEFLATE/zlib inflater.
//
// Paperback 0.8 exposes no way to read decoded pixels from its `PBImage` /
// `PBCanvas` (only encoded WebP/PNG bytes come back out). The "adaptive" content
// descrambler needs raw RGBA, so the 0.8 backend re-encodes the source to PNG via
// `PBCanvas.encode("image/png")` and decodes it here — hence a self-contained PNG
// reader that runs on JavaScriptCore (no Buffer / zlib / DecompressionStream).
//
// Scope: color types 0 (gray), 2 (RGB), 4 (gray+alpha), 6 (RGBA), and 3
// (palette), all at bit depth 8, non-interlaced — the shapes a canvas PNG
// encoder emits. Anything else throws (the caller then skips adaptive for that
// page). Output is always tightly-packed RGBA, top-down.

export interface DecodedImage {
  width: number;
  height: number;
  // RGBA, row-major top-down, length width*height*4.
  data: Uint8Array;
}

// --- DEFLATE (RFC 1951) inflate --------------------------------------------

// Canonical Huffman decoder built from a list of code lengths.
class Huffman {
  // fast[len<=FAST_BITS] direct lookup: index by the next FAST_BITS bits.
  private readonly counts: Int32Array;
  private readonly symbols: Int32Array;
  private readonly maxLen: number;

  constructor(lengths: Uint8Array | number[], n: number) {
    const counts = new Int32Array(16);
    for (let i = 0; i < n; i++) counts[lengths[i]!]++;
    counts[0] = 0;
    let maxLen = 0;
    for (let i = 1; i < 16; i++) if (counts[i]! > 0) maxLen = i;
    // Offsets of the first symbol of each length in the sorted symbol table.
    const offsets = new Int32Array(16);
    for (let i = 1; i < 16; i++) offsets[i] = offsets[i - 1]! + counts[i - 1]!;
    const symbols = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const l = lengths[i]!;
      if (l !== 0) symbols[offsets[l]!++] = i;
    }
    this.counts = counts;
    this.symbols = symbols;
    this.maxLen = maxLen;
  }

  // Decode one symbol from the bit reader (LSB-first, per DEFLATE).
  decode(br: BitReader): number {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= this.maxLen; len++) {
      code |= br.bit();
      const count = this.counts[len]!;
      if (code - first < count) return this.symbols[index + (code - first)]!;
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw new Error("PNG inflate: bad Huffman code");
  }
}

class BitReader {
  private pos: number;
  private bitBuf = 0;
  private bitCnt = 0;
  constructor(private readonly src: Uint8Array, start: number) {
    this.pos = start;
  }
  bit(): number {
    if (this.bitCnt === 0) {
      if (this.pos >= this.src.length) throw new Error("PNG inflate: EOF");
      this.bitBuf = this.src[this.pos++]!;
      this.bitCnt = 8;
    }
    const b = this.bitBuf & 1;
    this.bitBuf >>= 1;
    this.bitCnt--;
    return b;
  }
  bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v |= this.bit() << i;
    return v;
  }
  // Drop to the next byte boundary (for stored blocks).
  align(): void {
    this.bitCnt = 0;
  }
  readByte(): number {
    if (this.pos >= this.src.length) throw new Error("PNG inflate: EOF");
    return this.src[this.pos++]!;
  }
}

const LEN_BASE = [
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  13,
  15,
  17,
  19,
  23,
  27,
  31,
  35,
  43,
  51,
  59,
  67,
  83,
  99,
  115,
  131,
  163,
  195,
  227,
  258,
];
const LEN_EXTRA = [
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  1,
  1,
  1,
  1,
  2,
  2,
  2,
  2,
  3,
  3,
  3,
  3,
  4,
  4,
  4,
  4,
  5,
  5,
  5,
  5,
  0,
];
const DIST_BASE = [
  1,
  2,
  3,
  4,
  5,
  7,
  9,
  13,
  17,
  25,
  33,
  49,
  65,
  97,
  129,
  193,
  257,
  385,
  513,
  769,
  1025,
  1537,
  2049,
  3073,
  4097,
  6145,
  8193,
  12289,
  16385,
  24577,
];
const DIST_EXTRA = [
  0,
  0,
  0,
  0,
  1,
  1,
  2,
  2,
  3,
  3,
  4,
  4,
  5,
  5,
  6,
  6,
  7,
  7,
  8,
  8,
  9,
  9,
  10,
  10,
  11,
  11,
  12,
  12,
  13,
  13,
];
const CODELEN_ORDER = [
  16,
  17,
  18,
  0,
  8,
  7,
  9,
  6,
  10,
  5,
  11,
  4,
  12,
  3,
  13,
  2,
  14,
  1,
  15,
];

let FIXED_LIT: Huffman | null = null;
let FIXED_DIST: Huffman | null = null;
function fixedTrees(): { lit: Huffman; dist: Huffman } {
  if (!FIXED_LIT) {
    const litLen = new Uint8Array(288);
    for (let i = 0; i < 144; i++) litLen[i] = 8;
    for (let i = 144; i < 256; i++) litLen[i] = 9;
    for (let i = 256; i < 280; i++) litLen[i] = 7;
    for (let i = 280; i < 288; i++) litLen[i] = 8;
    FIXED_LIT = new Huffman(litLen, 288);
    const distLen = new Uint8Array(30).fill(5);
    FIXED_DIST = new Huffman(distLen, 30);
  }
  return { lit: FIXED_LIT!, dist: FIXED_DIST! };
}

// Inflate a raw DEFLATE stream into `out` (which must be pre-sized).
function inflateRaw(src: Uint8Array, start: number, out: Uint8Array): number {
  const br = new BitReader(src, start);
  let o = 0;
  for (;;) {
    const last = br.bit();
    const type = br.bits(2);
    if (type === 0) {
      br.align();
      const len = br.readByte() | (br.readByte() << 8);
      br.readByte();
      br.readByte(); // ~len (ignored)
      for (let i = 0; i < len; i++) out[o++] = br.readByte();
    } else {
      let lit: Huffman;
      let dist: Huffman;
      if (type === 1) {
        const t = fixedTrees();
        lit = t.lit;
        dist = t.dist;
      } else if (type === 2) {
        const hlit = br.bits(5) + 257;
        const hdist = br.bits(5) + 1;
        const hclen = br.bits(4) + 4;
        const clLen = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) clLen[CODELEN_ORDER[i]!] = br.bits(3);
        const clTree = new Huffman(clLen, 19);
        const all = new Uint8Array(hlit + hdist);
        let i = 0;
        while (i < hlit + hdist) {
          const sym = clTree.decode(br);
          if (sym < 16) {
            all[i++] = sym;
          } else if (sym === 16) {
            const prev = all[i - 1]!;
            let rep = 3 + br.bits(2);
            while (rep-- > 0) all[i++] = prev;
          } else if (sym === 17) {
            let rep = 3 + br.bits(3);
            while (rep-- > 0) all[i++] = 0;
          } else {
            let rep = 11 + br.bits(7);
            while (rep-- > 0) all[i++] = 0;
          }
        }
        lit = new Huffman(all.subarray(0, hlit), hlit);
        dist = new Huffman(all.subarray(hlit, hlit + hdist), hdist);
      } else {
        throw new Error("PNG inflate: bad block type");
      }
      for (;;) {
        const sym = lit.decode(br);
        if (sym === 256) break;
        if (sym < 256) {
          out[o++] = sym;
        } else {
          const li = sym - 257;
          const length = LEN_BASE[li]! + br.bits(LEN_EXTRA[li]!);
          const ds = dist.decode(br);
          const distance = DIST_BASE[ds]! + br.bits(DIST_EXTRA[ds]!);
          let from = o - distance;
          for (let k = 0; k < length; k++) out[o++] = out[from++]!;
        }
      }
    }
    if (last) break;
  }
  return o;
}

// --- PNG container ----------------------------------------------------------

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function decodePng(bytes: Uint8Array): DecodedImage {
  if (
    bytes.length < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e || bytes[3] !== 0x47
  ) {
    throw new Error("PNG decode: bad signature");
  }
  let p = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  // Gather IDAT chunks; concatenate lazily.
  const idat: Uint8Array[] = [];
  let idatLen = 0;

  const rd32 = (i: number) =>
    ((bytes[i]! << 24) | (bytes[i + 1]! << 16) | (bytes[i + 2]! << 8) |
      bytes[i + 3]!) >>> 0;

  while (p + 8 <= bytes.length) {
    const len = rd32(p);
    const type = String.fromCharCode(
      bytes[p + 4]!,
      bytes[p + 5]!,
      bytes[p + 6]!,
      bytes[p + 7]!,
    );
    const dataStart = p + 8;
    if (type === "IHDR") {
      width = rd32(dataStart);
      height = rd32(dataStart + 4);
      bitDepth = bytes[dataStart + 8]!;
      colorType = bytes[dataStart + 9]!;
      const interlace = bytes[dataStart + 12]!;
      if (bitDepth !== 8) {
        throw new Error(`PNG decode: unsupported bit depth ${bitDepth}`);
      }
      if (interlace !== 0) {
        throw new Error("PNG decode: interlaced unsupported");
      }
      if (CHANNELS[colorType] === undefined) {
        throw new Error(`PNG decode: unsupported color type ${colorType}`);
      }
    } else if (type === "PLTE") {
      palette = bytes.subarray(dataStart, dataStart + len);
    } else if (type === "tRNS") {
      trns = bytes.subarray(dataStart, dataStart + len);
    } else if (type === "IDAT") {
      idat.push(bytes.subarray(dataStart, dataStart + len));
      idatLen += len;
    } else if (type === "IEND") {
      break;
    }
    p = dataStart + len + 4; // skip data + CRC
  }

  if (width === 0 || height === 0) throw new Error("PNG decode: no IHDR");

  // Concatenate IDAT and skip the 2-byte zlib header.
  const z = new Uint8Array(idatLen);
  {
    let off = 0;
    for (const c of idat) {
      z.set(c, off);
      off += c.length;
    }
  }
  const channels = CHANNELS[colorType]!;
  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  inflateRaw(z, 2, raw); // +2: past CMF/FLG; trailing Adler32 ignored

  // Reverse the per-scanline filters into a tight `stride*height` buffer.
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const rowIn = y * (stride + 1) + 1;
    const rowOut = y * stride;
    const prevOut = rowOut - stride;
    for (let x = 0; x < stride; x++) {
      const cur = raw[rowIn + x]!;
      const a = x >= channels ? out[rowOut + x - channels]! : 0;
      const b = y > 0 ? out[prevOut + x]! : 0;
      const c = (y > 0 && x >= channels) ? out[prevOut + x - channels]! : 0;
      let v: number;
      switch (filter) {
        case 0:
          v = cur;
          break;
        case 1:
          v = cur + a;
          break;
        case 2:
          v = cur + b;
          break;
        case 3:
          v = cur + ((a + b) >> 1);
          break;
        case 4:
          v = cur + paeth(a, b, c);
          break;
        default:
          throw new Error(`PNG decode: bad filter ${filter}`);
      }
      out[rowOut + x] = v & 0xff;
    }
  }

  // Expand to RGBA.
  const rgba = new Uint8Array(width * height * 4);
  const n = width * height;
  if (colorType === 6) {
    rgba.set(out);
  } else if (colorType === 2) {
    for (let i = 0; i < n; i++) {
      rgba[i * 4] = out[i * 3]!;
      rgba[i * 4 + 1] = out[i * 3 + 1]!;
      rgba[i * 4 + 2] = out[i * 3 + 2]!;
      rgba[i * 4 + 3] = 255;
    }
  } else if (colorType === 0) {
    for (let i = 0; i < n; i++) {
      const g = out[i]!;
      rgba[i * 4] = g;
      rgba[i * 4 + 1] = g;
      rgba[i * 4 + 2] = g;
      rgba[i * 4 + 3] = 255;
    }
  } else if (colorType === 4) {
    for (let i = 0; i < n; i++) {
      const g = out[i * 2]!;
      rgba[i * 4] = g;
      rgba[i * 4 + 1] = g;
      rgba[i * 4 + 2] = g;
      rgba[i * 4 + 3] = out[i * 2 + 1]!;
    }
  } else if (colorType === 3) {
    if (!palette) throw new Error("PNG decode: palette missing");
    for (let i = 0; i < n; i++) {
      const idx = out[i]!;
      rgba[i * 4] = palette[idx * 3]!;
      rgba[i * 4 + 1] = palette[idx * 3 + 1]!;
      rgba[i * 4 + 2] = palette[idx * 3 + 2]!;
      rgba[i * 4 + 3] = trns && idx < trns.length ? trns[idx]! : 255;
    }
  }
  return { width, height, data: rgba };
}
