/* SPDX-License-Identifier: GPL-3.0-or-later */

// Minimal, dependency-free baseline JPEG decoder producing tightly-packed RGBA.
//
// Companion to `png.ts`. Paperback 0.8's `PBCanvas.encode("image/png")` ignores
// the requested MIME on some hosts and hands back a baseline JFIF/JPEG instead
// (observed header `FF D8 FF E0 … JFIF`). The "adaptive" descrambler needs raw
// source pixels, so the 0.8 canvas backend decodes that JPEG here — a
// self-contained baseline decoder that runs on JavaScriptCore (no Buffer / no
// browser image APIs). Scope: baseline sequential DCT (SOF0/SOF1), 8-bit,
// Huffman entropy coding, 1 (grayscale) or 3 (YCbCr) components — the shapes a
// canvas JPEG encoder emits. Progressive / arithmetic / 12-bit / CMYK throw (the
// caller then skips adaptive for that page). Output is always top-down RGBA.
//
// The marker parsing, entropy decode, dequantize and integer IDCT below are a
// TypeScript port of jpeg-js (https://github.com/jpeg-js/jpeg-js) /
// notmasteryet's decoder, Apache-2.0 licensed. See THIRD_PARTY_NOTICES.md.

import type { DecodedImage } from "./png.ts";

const dctZigZag = new Int32Array([
  0,
  1,
  8,
  16,
  9,
  2,
  3,
  10,
  17,
  24,
  32,
  25,
  18,
  11,
  4,
  5,
  12,
  19,
  26,
  33,
  40,
  48,
  41,
  34,
  27,
  20,
  13,
  6,
  7,
  14,
  21,
  28,
  35,
  42,
  49,
  56,
  57,
  50,
  43,
  36,
  29,
  22,
  15,
  23,
  30,
  37,
  44,
  51,
  58,
  59,
  52,
  45,
  38,
  31,
  39,
  46,
  53,
  60,
  61,
  54,
  47,
  55,
  62,
  63,
]);

const dctCos1 = 4017; // cos(pi/16)
const dctSin1 = 799; // sin(pi/16)
const dctCos3 = 3406; // cos(3*pi/16)
const dctSin3 = 2276; // sin(3*pi/16)
const dctCos6 = 1567; // cos(6*pi/16)
const dctSin6 = 3784; // sin(6*pi/16)
const dctSqrt2 = 5793; // sqrt(2)
const dctSqrt1d2 = 2896; // sqrt(2) / 2

// A canonical-Huffman decode tree. Interior nodes are arrays of length 2
// (indexed by the next bit); leaves are the decoded symbol numbers.
type HuffTree = Array<HuffTree | number>;

interface HuffBuildNode {
  children: HuffTree;
  index: number;
}

function buildHuffmanTable(
  codeLengths: Uint8Array,
  values: Uint8Array,
): HuffTree {
  let k = 0;
  let length = 16;
  while (length > 0 && !codeLengths[length - 1]) length--;
  const code: HuffBuildNode[] = [{ children: [], index: 0 }];
  let p = code[0]!;
  let q: HuffBuildNode;
  for (let i = 0; i < length; i++) {
    for (let j = 0; j < codeLengths[i]!; j++) {
      p = code.pop()!;
      p.children[p.index] = values[k]!;
      while (p.index > 0) {
        if (code.length === 0) {
          throw new Error("jpeg: could not recreate Huffman table");
        }
        p = code.pop()!;
      }
      p.index++;
      code.push(p);
      while (code.length <= i) {
        q = { children: [], index: 0 };
        code.push(q);
        p.children[p.index] = q.children;
        p = q;
      }
      k++;
    }
    if (i + 1 < length) {
      q = { children: [], index: 0 };
      code.push(q);
      p.children[p.index] = q.children;
      p = q;
    }
  }
  return code[0]!.children;
}

interface Component {
  h: number;
  v: number;
  quantizationIdx?: number;
  quantizationTable?: Int32Array;
  huffmanTableDC?: HuffTree;
  huffmanTableAC?: HuffTree;
  pred: number;
  blocksPerLine: number;
  blocksPerColumn: number;
  blocks: Int32Array[][];
}

interface Frame {
  precision: number;
  scanLines: number;
  samplesPerLine: number;
  maxH: number;
  maxV: number;
  mcusPerLine: number;
  mcusPerColumn: number;
  components: Record<number, Component>;
  componentsOrder: number[];
}

function decodeScan(
  data: Uint8Array,
  offsetIn: number,
  frame: Frame,
  components: Component[],
  resetInterval: number,
): number {
  const mcusPerLine = frame.mcusPerLine;
  const startOffset = offsetIn;
  let offset = offsetIn;
  let bitsData = 0;
  let bitsCount = 0;

  function readBit(): number | null {
    if (bitsCount > 0) {
      bitsCount--;
      return (bitsData >> bitsCount) & 1;
    }
    bitsData = data[offset++]!;
    if (bitsData === 0xff) {
      const nextByte = data[offset++]!;
      if (nextByte) {
        throw new Error(
          "jpeg: unexpected marker " +
            ((bitsData << 8) | nextByte).toString(16),
        );
      }
      // byte-stuffed 0x00, drop it
    }
    bitsCount = 7;
    return bitsData >>> 7;
  }

  function decodeHuffman(tree: HuffTree): number {
    let node: HuffTree | number = tree;
    let bit: number | null;
    while ((bit = readBit()) !== null) {
      node = (node as HuffTree)[bit]!;
      if (typeof node === "number") return node;
      if (typeof node !== "object") {
        throw new Error("jpeg: invalid huffman sequence");
      }
    }
    throw new Error("jpeg: unexpected end of huffman stream");
  }

  function receive(len: number): number {
    let n = 0;
    while (len > 0) {
      const bit = readBit();
      if (bit === null) return n;
      n = (n << 1) | bit;
      len--;
    }
    return n;
  }

  function receiveAndExtend(len: number): number {
    const n = receive(len);
    if (n >= 1 << (len - 1)) return n;
    return n + (-1 << len) + 1;
  }

  function decodeBaseline(component: Component, zz: Int32Array): void {
    const t = decodeHuffman(component.huffmanTableDC!);
    const diff = t === 0 ? 0 : receiveAndExtend(t);
    zz[0] = component.pred += diff;
    let k = 1;
    while (k < 64) {
      const rs = decodeHuffman(component.huffmanTableAC!);
      const s = rs & 15;
      const r = rs >> 4;
      if (s === 0) {
        if (r < 15) break;
        k += 16;
        continue;
      }
      k += r;
      const z = dctZigZag[k]!;
      zz[z] = receiveAndExtend(s);
      k++;
    }
  }

  function decodeMcu(
    component: Component,
    mcu: number,
    row: number,
    col: number,
  ): void {
    const mcuRow = (mcu / mcusPerLine) | 0;
    const mcuCol = mcu % mcusPerLine;
    const blockRow = mcuRow * component.v + row;
    const blockCol = mcuCol * component.h + col;
    decodeBaseline(component, component.blocks[blockRow]![blockCol]!);
  }

  function decodeBlock(component: Component, mcu: number): void {
    const blockRow = (mcu / component.blocksPerLine) | 0;
    const blockCol = mcu % component.blocksPerLine;
    decodeBaseline(component, component.blocks[blockRow]![blockCol]!);
  }

  const componentsLength = components.length;
  let mcu = 0;
  let mcuExpected: number;
  if (componentsLength === 1) {
    mcuExpected = components[0]!.blocksPerLine * components[0]!.blocksPerColumn;
  } else {
    mcuExpected = mcusPerLine * frame.mcusPerColumn;
  }
  if (!resetInterval) resetInterval = mcuExpected;

  while (mcu < mcuExpected) {
    for (let i = 0; i < componentsLength; i++) components[i]!.pred = 0;

    if (componentsLength === 1) {
      const component = components[0]!;
      for (let n = 0; n < resetInterval; n++) {
        decodeBlock(component, mcu);
        mcu++;
      }
    } else {
      for (let n = 0; n < resetInterval; n++) {
        for (let i = 0; i < componentsLength; i++) {
          const component = components[i]!;
          const h = component.h;
          const v = component.v;
          for (let j = 0; j < v; j++) {
            for (let c = 0; c < h; c++) {
              decodeMcu(component, mcu, j, c);
            }
          }
        }
        mcu++;
        if (mcu === mcuExpected) break;
      }
    }

    if (mcu === mcuExpected) {
      // Skip trailing bytes until the next marker.
      do {
        if (data[offset] === 0xff) {
          if (data[offset + 1] !== 0x00) break;
        }
        offset += 1;
      } while (offset < data.length - 2);
    }

    bitsCount = 0;
    const marker = (data[offset]! << 8) | data[offset + 1]!;
    if (marker < 0xff00) throw new Error("jpeg: marker not found");
    if (marker >= 0xffd0 && marker <= 0xffd7) {
      offset += 2; // RSTx
    } else {
      break;
    }
  }

  return offset - startOffset;
}

function quantizeAndInverse(
  component: Component,
  zz: Int32Array,
  dataOut: Uint8Array,
  p: Int32Array,
): void {
  const qt = component.quantizationTable!;
  let v0, v1, v2, v3, v4, v5, v6, v7, t;

  for (let i = 0; i < 64; i++) p[i] = zz[i]! * qt[i]!;

  // inverse DCT on rows
  for (let i = 0; i < 8; ++i) {
    const row = 8 * i;
    if (
      p[1 + row] === 0 && p[2 + row] === 0 && p[3 + row] === 0 &&
      p[4 + row] === 0 && p[5 + row] === 0 && p[6 + row] === 0 &&
      p[7 + row] === 0
    ) {
      t = (dctSqrt2 * p[0 + row]! + 512) >> 10;
      p[0 + row] = t;
      p[1 + row] = t;
      p[2 + row] = t;
      p[3 + row] = t;
      p[4 + row] = t;
      p[5 + row] = t;
      p[6 + row] = t;
      p[7 + row] = t;
      continue;
    }
    v0 = (dctSqrt2 * p[0 + row]! + 128) >> 8;
    v1 = (dctSqrt2 * p[4 + row]! + 128) >> 8;
    v2 = p[2 + row]!;
    v3 = p[6 + row]!;
    v4 = (dctSqrt1d2 * (p[1 + row]! - p[7 + row]!) + 128) >> 8;
    v7 = (dctSqrt1d2 * (p[1 + row]! + p[7 + row]!) + 128) >> 8;
    v5 = p[3 + row]! << 4;
    v6 = p[5 + row]! << 4;

    t = (v0 - v1 + 1) >> 1;
    v0 = (v0 + v1 + 1) >> 1;
    v1 = t;
    t = (v2 * dctSin6 + v3 * dctCos6 + 128) >> 8;
    v2 = (v2 * dctCos6 - v3 * dctSin6 + 128) >> 8;
    v3 = t;
    t = (v4 - v6 + 1) >> 1;
    v4 = (v4 + v6 + 1) >> 1;
    v6 = t;
    t = (v7 + v5 + 1) >> 1;
    v5 = (v7 - v5 + 1) >> 1;
    v7 = t;

    t = (v0 - v3 + 1) >> 1;
    v0 = (v0 + v3 + 1) >> 1;
    v3 = t;
    t = (v1 - v2 + 1) >> 1;
    v1 = (v1 + v2 + 1) >> 1;
    v2 = t;
    t = (v4 * dctSin3 + v7 * dctCos3 + 2048) >> 12;
    v4 = (v4 * dctCos3 - v7 * dctSin3 + 2048) >> 12;
    v7 = t;
    t = (v5 * dctSin1 + v6 * dctCos1 + 2048) >> 12;
    v5 = (v5 * dctCos1 - v6 * dctSin1 + 2048) >> 12;
    v6 = t;

    p[0 + row] = v0 + v7;
    p[7 + row] = v0 - v7;
    p[1 + row] = v1 + v6;
    p[6 + row] = v1 - v6;
    p[2 + row] = v2 + v5;
    p[5 + row] = v2 - v5;
    p[3 + row] = v3 + v4;
    p[4 + row] = v3 - v4;
  }

  // inverse DCT on columns
  for (let i = 0; i < 8; ++i) {
    const col = i;
    if (
      p[1 * 8 + col] === 0 && p[2 * 8 + col] === 0 && p[3 * 8 + col] === 0 &&
      p[4 * 8 + col] === 0 && p[5 * 8 + col] === 0 && p[6 * 8 + col] === 0 &&
      p[7 * 8 + col] === 0
    ) {
      t = (dctSqrt2 * p[0 * 8 + col]! + 8192) >> 14;
      p[0 * 8 + col] = t;
      p[1 * 8 + col] = t;
      p[2 * 8 + col] = t;
      p[3 * 8 + col] = t;
      p[4 * 8 + col] = t;
      p[5 * 8 + col] = t;
      p[6 * 8 + col] = t;
      p[7 * 8 + col] = t;
      continue;
    }
    v0 = (dctSqrt2 * p[0 * 8 + col]! + 2048) >> 12;
    v1 = (dctSqrt2 * p[4 * 8 + col]! + 2048) >> 12;
    v2 = p[2 * 8 + col]!;
    v3 = p[6 * 8 + col]!;
    v4 = (dctSqrt1d2 * (p[1 * 8 + col]! - p[7 * 8 + col]!) + 2048) >> 12;
    v7 = (dctSqrt1d2 * (p[1 * 8 + col]! + p[7 * 8 + col]!) + 2048) >> 12;
    v5 = p[3 * 8 + col]!;
    v6 = p[5 * 8 + col]!;

    t = (v0 - v1 + 1) >> 1;
    v0 = (v0 + v1 + 1) >> 1;
    v1 = t;
    t = (v2 * dctSin6 + v3 * dctCos6 + 2048) >> 12;
    v2 = (v2 * dctCos6 - v3 * dctSin6 + 2048) >> 12;
    v3 = t;
    t = (v4 - v6 + 1) >> 1;
    v4 = (v4 + v6 + 1) >> 1;
    v6 = t;
    t = (v7 + v5 + 1) >> 1;
    v5 = (v7 - v5 + 1) >> 1;
    v7 = t;

    t = (v0 - v3 + 1) >> 1;
    v0 = (v0 + v3 + 1) >> 1;
    v3 = t;
    t = (v1 - v2 + 1) >> 1;
    v1 = (v1 + v2 + 1) >> 1;
    v2 = t;
    t = (v4 * dctSin3 + v7 * dctCos3 + 2048) >> 12;
    v4 = (v4 * dctCos3 - v7 * dctSin3 + 2048) >> 12;
    v7 = t;
    t = (v5 * dctSin1 + v6 * dctCos1 + 2048) >> 12;
    v5 = (v5 * dctCos1 - v6 * dctSin1 + 2048) >> 12;
    v6 = t;

    p[0 * 8 + col] = v0 + v7;
    p[7 * 8 + col] = v0 - v7;
    p[1 * 8 + col] = v1 + v6;
    p[6 * 8 + col] = v1 - v6;
    p[2 * 8 + col] = v2 + v5;
    p[5 * 8 + col] = v2 - v5;
    p[3 * 8 + col] = v3 + v4;
    p[4 * 8 + col] = v3 - v4;
  }

  for (let i = 0; i < 64; ++i) {
    const sample = 128 + ((p[i]! + 8) >> 4);
    dataOut[i] = sample < 0 ? 0 : sample > 0xff ? 0xff : sample;
  }
}

function buildComponentData(component: Component): Uint8Array[] {
  const lines: Uint8Array[] = [];
  const blocksPerLine = component.blocksPerLine;
  const blocksPerColumn = component.blocksPerColumn;
  const samplesPerLine = blocksPerLine << 3;
  const R = new Int32Array(64);
  const r = new Uint8Array(64);

  for (let blockRow = 0; blockRow < blocksPerColumn; blockRow++) {
    const scanLine = blockRow << 3;
    for (let i = 0; i < 8; i++) lines.push(new Uint8Array(samplesPerLine));
    for (let blockCol = 0; blockCol < blocksPerLine; blockCol++) {
      quantizeAndInverse(
        component,
        component.blocks[blockRow]![blockCol]!,
        r,
        R,
      );
      let offset = 0;
      const sample = blockCol << 3;
      for (let j = 0; j < 8; j++) {
        const line = lines[scanLine + j]!;
        for (let i = 0; i < 8; i++) line[sample + i] = r[offset++]!;
      }
    }
  }
  return lines;
}

function clampTo8bit(a: number): number {
  return a < 0 ? 0 : a > 255 ? 255 : a;
}

// Decode a baseline JPEG into top-down RGBA. Throws on unsupported variants.
export function decodeJpeg(data: Uint8Array): DecodedImage {
  let offset = 0;
  const length = data.length;

  function readUint16(): number {
    const value = (data[offset]! << 8) | data[offset + 1]!;
    offset += 2;
    return value;
  }
  function readDataBlock(): Uint8Array {
    const len = readUint16();
    const array = data.subarray(offset, offset + len - 2);
    offset += array.length;
    return array;
  }
  function prepareComponents(frame: Frame): void {
    let maxH = 1, maxV = 1;
    for (const id of frame.componentsOrder) {
      const c = frame.components[id]!;
      if (maxH < c.h) maxH = c.h;
      if (maxV < c.v) maxV = c.v;
    }
    const mcusPerLine = Math.ceil(frame.samplesPerLine / 8 / maxH);
    const mcusPerColumn = Math.ceil(frame.scanLines / 8 / maxV);
    for (const id of frame.componentsOrder) {
      const c = frame.components[id]!;
      const blocksPerLine = Math.ceil(
        Math.ceil(frame.samplesPerLine / 8) * c.h / maxH,
      );
      const blocksPerColumn = Math.ceil(
        Math.ceil(frame.scanLines / 8) * c.v / maxV,
      );
      const blocksPerLineForMcu = mcusPerLine * c.h;
      const blocksPerColumnForMcu = mcusPerColumn * c.v;
      const blocks: Int32Array[][] = [];
      for (let i = 0; i < blocksPerColumnForMcu; i++) {
        const row: Int32Array[] = [];
        for (let j = 0; j < blocksPerLineForMcu; j++) {
          row.push(new Int32Array(64));
        }
        blocks.push(row);
      }
      c.blocksPerLine = blocksPerLine;
      c.blocksPerColumn = blocksPerColumn;
      c.blocks = blocks;
    }
    frame.maxH = maxH;
    frame.maxV = maxV;
    frame.mcusPerLine = mcusPerLine;
    frame.mcusPerColumn = mcusPerColumn;
  }

  let adobeTransform: number | null = null;
  let frame: Frame | null = null;
  let resetInterval = 0;
  const quantizationTables: Int32Array[] = [];
  const huffmanTablesAC: HuffTree[] = [];
  const huffmanTablesDC: HuffTree[] = [];

  let fileMarker = readUint16();
  if (fileMarker !== 0xffd8) throw new Error("jpeg: SOI not found");

  fileMarker = readUint16();
  while (fileMarker !== 0xffd9) {
    if (offset >= length) break;
    switch (fileMarker) {
      case 0xff00:
        break;
      case 0xffe0:
      case 0xffe1:
      case 0xffe2:
      case 0xffe3:
      case 0xffe4:
      case 0xffe5:
      case 0xffe6:
      case 0xffe7:
      case 0xffe8:
      case 0xffe9:
      case 0xffea:
      case 0xffeb:
      case 0xffec:
      case 0xffed:
      case 0xffee:
      case 0xffef:
      case 0xfffe: {
        const appData = readDataBlock();
        if (fileMarker === 0xffee) {
          if (
            appData[0] === 0x41 && appData[1] === 0x64 && appData[2] === 0x6f &&
            appData[3] === 0x62 && appData[4] === 0x65 && appData[5] === 0
          ) {
            adobeTransform = appData[11]!;
          }
        }
        break;
      }

      case 0xffdb: {
        const quantizationTablesLength = readUint16();
        const quantizationTablesEnd = quantizationTablesLength + offset - 2;
        while (offset < quantizationTablesEnd) {
          const quantizationTableSpec = data[offset++]!;
          const tableData = new Int32Array(64);
          if (quantizationTableSpec >> 4 === 0) {
            for (let j = 0; j < 64; j++) {
              tableData[dctZigZag[j]!] = data[offset++]!;
            }
          } else if (quantizationTableSpec >> 4 === 1) {
            for (let j = 0; j < 64; j++) {
              tableData[dctZigZag[j]!] = readUint16();
            }
          } else {
            throw new Error("jpeg: DQT invalid table spec");
          }
          quantizationTables[quantizationTableSpec & 15] = tableData;
        }
        break;
      }

      case 0xffc0:
      case 0xffc1: {
        readUint16(); // skip length
        const f: Frame = {
          precision: data[offset++]!,
          scanLines: readUint16(),
          samplesPerLine: readUint16(),
          maxH: 1,
          maxV: 1,
          mcusPerLine: 0,
          mcusPerColumn: 0,
          components: {},
          componentsOrder: [],
        };
        const componentsCount = data[offset++]!;
        for (let i = 0; i < componentsCount; i++) {
          const componentId = data[offset]!;
          const h = data[offset + 1]! >> 4;
          const v = data[offset + 1]! & 15;
          const qId = data[offset + 2]!;
          if (h <= 0 || v <= 0) {
            throw new Error("jpeg: invalid sampling factor");
          }
          f.componentsOrder.push(componentId);
          f.components[componentId] = {
            h,
            v,
            quantizationIdx: qId,
            pred: 0,
            blocksPerLine: 0,
            blocksPerColumn: 0,
            blocks: [],
          };
          offset += 3;
        }
        prepareComponents(f);
        frame = f;
        break;
      }

      case 0xffc2:
        throw new Error("jpeg: progressive JPEG not supported");
      case 0xffc3:
      case 0xffc5:
      case 0xffc6:
      case 0xffc7:
      case 0xffc9:
      case 0xffca:
      case 0xffcb:
        throw new Error(
          "jpeg: unsupported SOF marker " + fileMarker.toString(16),
        );

      case 0xffc4: {
        const huffmanLength = readUint16();
        for (let i = 2; i < huffmanLength;) {
          const huffmanTableSpec = data[offset++]!;
          const codeLengths = new Uint8Array(16);
          let codeLengthSum = 0;
          for (let j = 0; j < 16; j++, offset++) {
            codeLengthSum += codeLengths[j] = data[offset]!;
          }
          const huffmanValues = new Uint8Array(codeLengthSum);
          for (let j = 0; j < codeLengthSum; j++, offset++) {
            huffmanValues[j] = data[offset]!;
          }
          i += 17 + codeLengthSum;
          (huffmanTableSpec >> 4 === 0 ? huffmanTablesDC : huffmanTablesAC)[
            huffmanTableSpec & 15
          ] = buildHuffmanTable(codeLengths, huffmanValues);
        }
        break;
      }

      case 0xffdd:
        readUint16();
        resetInterval = readUint16();
        break;

      case 0xffdc:
        readUint16();
        readUint16();
        break;

      case 0xffda: {
        readUint16(); // scan length
        const selectorsCount = data[offset++]!;
        const scanComponents: Component[] = [];
        if (!frame) throw new Error("jpeg: SOS before SOF");
        for (let i = 0; i < selectorsCount; i++) {
          const component = frame.components[data[offset++]!]!;
          const tableSpec = data[offset++]!;
          component.huffmanTableDC = huffmanTablesDC[tableSpec >> 4];
          component.huffmanTableAC = huffmanTablesAC[tableSpec & 15];
          scanComponents.push(component);
        }
        const spectralStart = data[offset++]!;
        const spectralEnd = data[offset++]!;
        data[offset++]; // successive approximation
        if (spectralStart !== 0 || spectralEnd !== 63) {
          throw new Error("jpeg: non-baseline scan");
        }
        const processed = decodeScan(
          data,
          offset,
          frame,
          scanComponents,
          resetInterval,
        );
        offset += processed;
        break;
      }

      case 0xffff:
        if (data[offset] !== 0xff) offset--;
        break;

      default:
        if (
          data[offset - 3] === 0xff &&
          data[offset - 2]! >= 0xc0 && data[offset - 2]! <= 0xfe
        ) {
          // last 0xFF of the previous block was eaten by the encoder
          offset -= 3;
          break;
        }
        throw new Error("jpeg: unknown marker " + fileMarker.toString(16));
    }
    fileMarker = readUint16();
  }

  if (!frame) throw new Error("jpeg: no frame");
  const frm = frame;

  for (const id of frm.componentsOrder) {
    const c = frm.components[id]!;
    c.quantizationTable = quantizationTables[c.quantizationIdx!];
  }

  const width = frm.samplesPerLine;
  const height = frm.scanLines;
  const outComponents = frm.componentsOrder.map((id) => {
    const c = frm.components[id]!;
    return {
      lines: buildComponentData(c),
      scaleX: c.h / frm.maxH,
      scaleY: c.v / frm.maxV,
    };
  });

  const out = new Uint8Array(width * height * 4);
  let o = 0;

  if (outComponents.length === 1) {
    const c1 = outComponents[0]!;
    for (let y = 0; y < height; y++) {
      const line = c1.lines[(y * c1.scaleY) | 0]!;
      for (let x = 0; x < width; x++) {
        const Y = line[(x * c1.scaleX) | 0]!;
        out[o++] = Y;
        out[o++] = Y;
        out[o++] = Y;
        out[o++] = 255;
      }
    }
  } else if (outComponents.length === 3) {
    const colorTransform = adobeTransform ? adobeTransform !== 0 : true;
    const c1 = outComponents[0]!;
    const c2 = outComponents[1]!;
    const c3 = outComponents[2]!;
    for (let y = 0; y < height; y++) {
      const l1 = c1.lines[(y * c1.scaleY) | 0]!;
      const l2 = c2.lines[(y * c2.scaleY) | 0]!;
      const l3 = c3.lines[(y * c3.scaleY) | 0]!;
      for (let x = 0; x < width; x++) {
        let R: number, G: number, B: number;
        if (!colorTransform) {
          R = l1[(x * c1.scaleX) | 0]!;
          G = l2[(x * c2.scaleX) | 0]!;
          B = l3[(x * c3.scaleX) | 0]!;
        } else {
          const Y = l1[(x * c1.scaleX) | 0]!;
          const Cb = l2[(x * c2.scaleX) | 0]!;
          const Cr = l3[(x * c3.scaleX) | 0]!;
          R = clampTo8bit(Y + 1.402 * (Cr - 128));
          G = clampTo8bit(
            Y - 0.3441363 * (Cb - 128) - 0.71413636 * (Cr - 128),
          );
          B = clampTo8bit(Y + 1.772 * (Cb - 128));
        }
        out[o++] = R;
        out[o++] = G;
        out[o++] = B;
        out[o++] = 255;
      }
    }
  } else {
    throw new Error(
      "jpeg: unsupported component count " + outComponents.length,
    );
  }

  return { width, height, data: out };
}
