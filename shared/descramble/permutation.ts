/* SPDX-License-Identifier: GPL-3.0-or-later */

// Comix tile-scramble permutation math (platform-agnostic, no canvas/host deps).
//
// Every known Comix tile shuffle is a backward Fisher-Yates over a `cols * rows`
// tile grid, differing only in the PRNG that drives the swaps. `arr` starts as
// [0..N-1] and ends as the forward scramble permutation P, where
// `scrambled_tile[i] = clean_tile[P[i]]`. To descramble we place each scrambled
// tile at the clean position given by the inverse: `clean[i] = scrambled[invP[i]]`.
//
// Three schemes are known:
//   - "lcg"       Numerical Recipes "ranqd1" LCG (state*1664525 + 1013904223).
//                 This is the Paperback 0.9 scheme; also the variant the 0.8
//                 reader historically could not descramble.
//   - "xorshift"  xorshift32 (13/17/5) seeded with `state = seed`. Legacy 0.8
//                 algo-2 tile shuffle.
//   - "gf2affine" xorshift32 (13/17/5) seeded with `state = seed | 1`. 0.8 algo-3
//                 (current 5x5 scheme); structurally algo-2 with an odd-forced seed.

export type ScrambleScheme = "lcg" | "xorshift" | "gf2affine";

// Advance a scheme's PRNG one step and return the next 32-bit state.
function step(scheme: ScrambleScheme, state: number): number {
  if (scheme === "lcg") {
    return (Math.imul(state, 1664525) + 1013904223) >>> 0;
  }
  // xorshift32 (13/17/5) — shared by "xorshift" and "gf2affine".
  let s = state;
  s ^= s << 13;
  s >>>= 0;
  s ^= s >>> 17;
  s ^= s << 5;
  return s >>> 0;
}

// Initial PRNG state for a scheme, given the (effective) seed.
function seedState(scheme: ScrambleScheme, seed: number): number {
  // "gf2affine" forces bit 0 set; the others use the seed verbatim.
  return scheme === "gf2affine" ? (seed | 1) >>> 0 : seed >>> 0;
}

// Forward scramble permutation: scrambled[i] = clean[P[i]].
export function computeScramblePerm(
  scheme: ScrambleScheme,
  seed: number,
  tileCount: number,
): number[] {
  const arr = new Array<number>(tileCount);
  for (let i = 0; i < tileCount; i++) arr[i] = i;
  let state = seedState(scheme, seed);
  for (let i = tileCount - 1; i > 0; i--) {
    state = step(scheme, state);
    const j = state % (i + 1);
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}

// For each clean tile position, the scrambled tile index to copy from:
// clean[i] = scrambled[descrambleLookup[i]].
export function computeDescrambleLookup(
  scheme: ScrambleScheme,
  seed: number,
  tileCount: number,
): number[] {
  const P = computeScramblePerm(scheme, seed, tileCount);
  const inv = new Array<number>(tileCount);
  for (let i = 0; i < tileCount; i++) inv[P[i]!] = i;
  return inv;
}

// Comix keys the tile-scramble seed with an X-Scramble-Hash header: the effective
// Fisher-Yates seed is `X-Scramble-Seed XOR decodeScrambleHash(X-Scramble-Hash)`.
// The short hash token maps to a per-bundle XOR constant and comix can rotate or
// extend this table. Known live tokens:
//   "03632" -> 58414  (bundle 58c4b11b0f71, 2026-06)
//   "02900" -> 117532 (added later — comix extended the table)
// Unknown/absent tokens fall back to 0 (raw seed) — the pre-hash behavior.
export function decodeScrambleHash(hash: string | undefined): number {
  switch (hash?.trim()) {
    case "03632":
      return 58414;
    case "02900":
      return 117532;
    default:
      return 0;
  }
}

// Parse "5x5" -> { cols: 5, rows: 5 }. Returns null if malformed.
export function parseScrambleGrid(
  grid: string,
): { cols: number; rows: number } | null {
  const m = /^\s*(\d+)\s*x\s*(\d+)\s*$/i.exec(grid);
  if (!m) return null;
  const cols = parseInt(m[1]!, 10);
  const rows = parseInt(m[2]!, 10);
  if (
    !Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0
  ) return null;
  return { cols, rows };
}
