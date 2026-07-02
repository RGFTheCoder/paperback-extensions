/* SPDX-License-Identifier: GPL-3.0-or-later */

// Shared tile-descramble orchestrator.
//
// Reads the Comix `X-Scramble-*` headers, resolves the permutation scheme, and
// reassembles the clean image by blitting each scrambled tile to its clean
// position through an injected, platform-specific canvas backend (see
// ./canvas.ts). The pixel-moving code lives in the backend; the permutation math
// lives in ./permutation.ts; this module is the glue both platforms share.

import {
  computeDescrambleLookup,
  decodeScrambleHash,
  parseScrambleGrid,
  type ScrambleScheme,
} from "./permutation.ts";
import type { CanvasBackend, EncodedImage } from "./canvas.ts";

export type { ScrambleScheme } from "./permutation.ts";
export type {
  CanvasBackend,
  DescrambleCanvas,
  EncodedImage,
} from "./canvas.ts";
export interface ScrambleParams {
  seed: number;
  cols: number;
  rows: number;
  // X-Scramble-Algo: 3 = the 0.8 GF(2)-affine (current 5x5) scheme; 2/absent =
  // the legacy xorshift32. Used only by `autoSchemeFromAlgo`; the 0.9 host omits
  // this header (it always uses the LCG scheme).
  algo: number;
  // XOR applied to `seed` before the Fisher-Yates: effective seed is
  // `seed ^ seedHashXor`. Decoded from the X-Scramble-Hash header.
  seedHashXor: number;
}

// Pull scramble params from a response's headers (case-insensitive). Returns null
// when absent/malformed — the image is then byte-encrypted or clean, and the
// caller should pass it through untouched.
export function readScrambleHeaders(
  headers: Record<string, string | undefined> | undefined,
): ScrambleParams | null {
  if (!headers) return null;
  let seedStr: string | undefined;
  let gridStr: string | undefined;
  let algoStr: string | undefined;
  let hashStr: string | undefined;
  for (const key of Object.keys(headers)) {
    const v = headers[key];
    if (typeof v !== "string") continue;
    const lk = key.toLowerCase();
    if (lk === "x-scramble-seed") seedStr = v;
    else if (lk === "x-scramble-grid") gridStr = v;
    else if (lk === "x-scramble-algo") algoStr = v;
    else if (lk === "x-scramble-hash") hashStr = v;
  }
  if (!seedStr || !gridStr) return null;
  const seed = parseInt(seedStr, 10);
  if (!Number.isFinite(seed) || seed < 0) return null;
  const grid = parseScrambleGrid(gridStr);
  if (!grid) return null;
  const algo = algoStr ? parseInt(algoStr, 10) : 2; // absent = legacy xorshift
  return {
    seed: seed >>> 0,
    cols: grid.cols,
    rows: grid.rows,
    algo: Number.isFinite(algo) ? algo : 2,
    seedHashXor: decodeScrambleHash(hashStr),
  };
}

// The 0.8 header-driven scheme dispatch (its current default behavior): algo 3 on
// a 5x5 grid is the GF(2)-affine scheme; everything else is the legacy xorshift.
export function autoSchemeFromAlgo(
  algo: number,
  cols: number,
  rows: number,
): ScrambleScheme {
  return algo === 3 && cols === 5 && rows === 5 ? "gf2affine" : "xorshift";
}

// Reassemble the clean image. `scheme` is resolved by the caller (from the
// platform default and/or a user "descramble scheme" setting), so this stays
// backend- and platform-agnostic.
export async function descrambleImage<TRaw, TOut>(
  data: TRaw,
  params: ScrambleParams,
  preferredMime: string,
  backend: CanvasBackend<TRaw, TOut>,
  scheme: ScrambleScheme,
): Promise<EncodedImage<TOut>> {
  const canvas = await backend.fromImage(data, preferredMime);
  const { width, height } = canvas;
  const { cols, rows, seed, seedHashXor } = params;

  const tw = (width / cols) | 0;
  const th = (height / rows) | 0;
  if (tw === 0 || th === 0) {
    throw new Error(
      `image ${width}x${height} too small for grid ${cols}x${rows}`,
    );
  }

  // The effective Fisher-Yates seed is the X-Scramble-Seed XORed with the
  // X-Scramble-Hash constant (0 when the header is absent/unknown).
  const effSeed = (seed ^ seedHashXor) >>> 0;
  const lookup = computeDescrambleLookup(scheme, effSeed, cols * rows);

  for (let i = 0; i < lookup.length; i++) {
    const cleanRow = (i / cols) | 0;
    const cleanCol = i % cols;
    const srcIdx = lookup[i]!;
    const srcRow = (srcIdx / cols) | 0;
    const srcCol = srcIdx % cols;
    canvas.drawTile(
      srcCol * tw,
      srcRow * th,
      tw,
      th,
      cleanCol * tw,
      cleanRow * th,
    );
  }

  return await canvas.encode(preferredMime);
}
