/* SPDX-License-Identifier: GPL-3.0-or-later */
/// <reference lib="deno.ns" />

import { assertEquals } from "@std/assert";
import { solveAdaptiveLookup } from "./adaptive.ts";

// A coherent, globally-continuous test image: true tile seams line up exactly
// (continuous function) while non-adjacent tiles generally don't. Multiple
// incommensurate frequencies keep every tile's edges textured so the solve is
// fully determined.
function makeImage(width: number, height: number): Uint8Array {
  const px = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const r = 128 + 100 * Math.sin(x * 0.11 + y * 0.017);
      const g = 128 + 100 * Math.sin(x * 0.037 - y * 0.091 + 1.7);
      const b = 128 + 100 * Math.sin(x * 0.005 + y * 0.13 + 3.1) +
        30 * Math.sin(x * 0.31);
      px[o] = Math.max(0, Math.min(255, r)) | 0;
      px[o + 1] = Math.max(0, Math.min(255, g)) | 0;
      px[o + 2] = Math.max(0, Math.min(255, b)) | 0;
      px[o + 3] = 255;
    }
  }
  return px;
}

// Scramble the tile grid by a permutation and return the scrambled pixels.
// `perm[s]` = the clean tile index whose content lands in scrambled slot `s`.
function scramble(
  clean: Uint8Array,
  width: number,
  height: number,
  cols: number,
  rows: number,
  perm: number[],
): Uint8Array {
  const tw = (width / cols) | 0;
  const th = (height / rows) | 0;
  const out = new Uint8Array(clean.length);
  out.set(clean);
  for (let s = 0; s < cols * rows; s++) {
    const cleanIdx = perm[s]!;
    const sr = (s / cols) | 0, sc = s % cols;
    const cr = (cleanIdx / cols) | 0, cc = cleanIdx % cols;
    for (let y = 0; y < th; y++) {
      const src = ((cr * th + y) * width + cc * tw) * 4;
      const dst = ((sr * th + y) * width + sc * tw) * 4;
      out.set(clean.subarray(src, src + tw * 4), dst);
    }
  }
  return out;
}

// Reassemble scrambled pixels using the solver's lookup and compare to clean.
function reconstructEquals(
  clean: Uint8Array,
  scrambled: Uint8Array,
  width: number,
  height: number,
  cols: number,
  rows: number,
  lookup: number[],
): boolean {
  const tw = (width / cols) | 0;
  const th = (height / rows) | 0;
  const out = new Uint8Array(scrambled.length);
  out.set(scrambled);
  for (let i = 0; i < cols * rows; i++) {
    const cr = (i / cols) | 0, cc = i % cols;
    const s = lookup[i]!;
    const sr = (s / cols) | 0, sc = s % cols;
    for (let y = 0; y < th; y++) {
      const src = ((sr * th + y) * width + sc * tw) * 4;
      const dst = ((cr * th + y) * width + cc * tw) * 4;
      out.set(scrambled.subarray(src, src + tw * 4), dst);
    }
  }
  for (let i = 0; i < out.length; i++) if (out[i] !== clean[i]) return false;
  return true;
}

const PERM = [
  7,
  2,
  19,
  0,
  11,
  24,
  5,
  16,
  9,
  1,
  22,
  14,
  3,
  18,
  8,
  13,
  21,
  6,
  23,
  4,
  10,
  15,
  20,
  12,
  17,
];

Deno.test("adaptive solver exactly reconstructs a textured page", () => {
  const width = 200, height = 280, cols = 5, rows = 5;
  const clean = makeImage(width, height);
  const scrambled = scramble(clean, width, height, cols, rows, PERM);
  const lookup = solveAdaptiveLookup(scrambled, width, height, cols, rows);
  assertEquals(
    reconstructEquals(clean, scrambled, width, height, cols, rows, lookup),
    true,
  );
});

Deno.test("adaptive solver doesn't wrap flat white bands into a torus", () => {
  // Top and bottom tile rows are solid white (zero-variance edges). A plain
  // seam-min solver would happily glue white-to-white and roll the page; the
  // variance weighting must leave those edges on the outside so the textured
  // interior stays put. The two white rows are identical, so any swap of them
  // is pixel-identical — the assertion catches interior roll, not band order.
  const width = 200, height = 280, cols = 5, rows = 5;
  const th = (height / rows) | 0;
  const clean = makeImage(width, height);
  for (let y = 0; y < height; y++) {
    if (y < th || y >= height - th) {
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        clean[o] = clean[o + 1] = clean[o + 2] = 255;
      }
    }
  }
  const scrambled = scramble(clean, width, height, cols, rows, PERM);
  const lookup = solveAdaptiveLookup(scrambled, width, height, cols, rows);
  assertEquals(
    reconstructEquals(clean, scrambled, width, height, cols, rows, lookup),
    true,
  );
});

Deno.test("adaptive solver tolerates a fully flat page", () => {
  const width = 100, height = 100, cols = 5, rows = 5;
  const clean = new Uint8Array(width * height * 4).fill(255);
  const lookup = solveAdaptiveLookup(clean, width, height, cols, rows);
  assertEquals(lookup.length, cols * rows);
  // Every tile index appears exactly once (a valid permutation).
  const seen = new Set(lookup);
  assertEquals(seen.size, cols * rows);
});

Deno.test("adaptive solver handles a 1x1 grid", () => {
  const lookup = solveAdaptiveLookup(new Uint8Array(4 * 4 * 4), 4, 4, 1, 1);
  assertEquals(lookup, [0]);
});
