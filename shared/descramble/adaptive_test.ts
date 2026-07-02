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

// Reassemble scrambled pixels using the solver's lookup into a clean-layout image.
function reconstruct(
  scrambled: Uint8Array,
  width: number,
  height: number,
  cols: number,
  rows: number,
  lookup: number[],
): Uint8Array {
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
  const out = reconstruct(scrambled, width, height, cols, rows, lookup);
  for (let i = 0; i < out.length; i++) if (out[i] !== clean[i]) return false;
  return true;
}

// Like reconstructEquals but tolerant of a whole-image vertical tile-row cyclic
// shift. When the top and bottom tile-rows are featureless (identical), a page's
// absolute vertical registration is genuinely undetermined from content alone —
// the textured block can validly sit one tile-row up or down. This still REJECTS
// a real toroidal wrap (which interleaves a flat row into the textured block or
// reorders it), because that matches no pure vertical shift of the clean page.
function reconstructEqualsUpToVShift(
  clean: Uint8Array,
  scrambled: Uint8Array,
  width: number,
  height: number,
  cols: number,
  rows: number,
  lookup: number[],
): boolean {
  const out = reconstruct(scrambled, width, height, cols, rows, lookup);
  const th = (height / rows) | 0;
  for (let dv = 0; dv < rows; dv++) {
    let match = true;
    for (let y = 0; y < height && match; y++) {
      const tr = (y / th) | 0;
      const oy = y % th;
      const srcY = ((tr + dv) % rows) * th + oy;
      const a = y * width * 4;
      const b = srcY * width * 4;
      for (let x = 0; x < width * 4; x++) {
        if (out[a + x] !== clean[b + x]) {
          match = false;
          break;
        }
      }
    }
    if (match) return true;
  }
  return false;
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
  // seam-min solver would happily glue white-to-white and roll the page. The
  // solver must keep the textured interior block intact and in order; because
  // both white bands are featureless, the block's absolute vertical position is
  // genuinely undetermined (it may sit one tile-row up/down), so we allow a whole
  // vertical shift but still reject any real toroidal wrap / interleave.
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
    reconstructEqualsUpToVShift(
      clean,
      scrambled,
      width,
      height,
      cols,
      rows,
      lookup,
    ),
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

Deno.test("adaptive solver registers the frame with flat margins + noisy seams", () => {
  // Reproduces the real-page failure: solid black left/right margins make a
  // horizontal toroidal roll "free" (flat, low-confidence outer edges), while
  // per-pixel noise makes every TRUE interior seam imperfect (nonzero mismatch).
  // A pure "minimise mismatch" objective exiles a slightly-costly true seam to
  // the unpenalised border and rolls the page; the centred score (which REWARDS
  // confident matches) keeps the true frame because rolling breaks a real match.
  const width = 200, height = 280, cols = 5, rows = 5;
  const clean = makeImage(width, height);

  // Deterministic per-pixel noise so true seams don't line up exactly.
  let s = 123456789 >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < clean.length; i += 4) {
    for (let k = 0; k < 3; k++) {
      clean[i + k] =
        Math.max(0, Math.min(255, clean[i + k]! + (rnd() * 24 - 12))) | 0;
    }
  }

  // Solid black outer left & right margins (flat, uninformative border edges).
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < 8; x++) {
      const o = (y * width + x) * 4;
      clean[o] = clean[o + 1] = clean[o + 2] = 0;
    }
    for (let x = width - 8; x < width; x++) {
      const o = (y * width + x) * 4;
      clean[o] = clean[o + 1] = clean[o + 2] = 0;
    }
  }

  const scrambled = scramble(clean, width, height, cols, rows, PERM);
  const lookup = solveAdaptiveLookup(scrambled, width, height, cols, rows);
  assertEquals(
    reconstructEquals(clean, scrambled, width, height, cols, rows, lookup),
    true,
  );
});
