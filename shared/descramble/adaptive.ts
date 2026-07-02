/* SPDX-License-Identifier: GPL-3.0-or-later */

// Content-based ("adaptive") tile-descramble solver.
//
// The seed-driven schemes (lcg/xorshift/gf2affine) invert the exact Fisher-Yates
// permutation Comix used. This solver instead ignores the seed and reconstructs
// the page purely from pixel content, treating the cols×rows tile grid as a
// jigsaw with fixed orientation: find the arrangement whose interior seams line
// up best. Useful when Comix rotates to a scheme we don't yet model.
//
// Edge scoring (the crux). For each candidate adjacency we combine two factors:
//   similarity  — how well the two touching pixel edges match (exp(-meanΔ)).
//   confidence  — how textured those edges are (variance → 0 for a flat/solid
//                 edge, → 1 for a busy one).
// benefit = similarity · confidence. A busy edge that matches scores high; a
// flat white/black edge that "matches" any other flat edge scores ~0, and a
// mismatch scores ~0 regardless. This is deliberate: manga pages are full of
// solid black/white bands, and a plain seam-difference solver will happily wrap
// the page into a torus (gluing a white top edge to a white bottom edge). By
// making flat matches worthless, those edges fall to the outside border instead
// of being trusted as interior seams.
//
// The arrangement is grown greedily on an open lattice (never a torus), capped
// to the cols×rows bounding box, so no wrap-around is representable at all.

const SIM_SCALE = 12; // mean per-channel Δ (0..255) that halves similarity ≈ 8·ln2
const CONF_K = 8; // edge stdev at which confidence reaches 0.5

interface TileEdges {
  // Each strip is RGB triplets along the edge, length = (tw or th)*3.
  left: Float64Array;
  right: Float64Array;
  top: Float64Array;
  bottom: Float64Array;
  // Per-edge texture (stdev of the strip), used for confidence.
  vLeft: number;
  vRight: number;
  vTop: number;
  vBottom: number;
}

function stripStdev(strip: Float64Array): number {
  const n = strip.length;
  if (n === 0) return 0;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += strip[i]!;
  mean /= n;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const d = strip[i]! - mean;
    acc += d * d;
  }
  return Math.sqrt(acc / n);
}

function meanAbsDiff(a: Float64Array, b: Float64Array): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 255;
  let acc = 0;
  for (let i = 0; i < n; i++) acc += Math.abs(a[i]! - b[i]!);
  return acc / n;
}

// benefit = similarity(edge match) · confidence(edges are textured).
function benefit(
  a: Float64Array,
  aVar: number,
  b: Float64Array,
  bVar: number,
): number {
  const similarity = Math.exp(-meanAbsDiff(a, b) / SIM_SCALE);
  const v = (aVar + bVar) / 2;
  const confidence = v / (v + CONF_K);
  return similarity * confidence;
}

function extractEdges(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  tw: number,
  th: number,
  cols: number,
  rows: number,
): TileEdges[] {
  const tiles: TileEdges[] = [];
  for (let sr = 0; sr < rows; sr++) {
    for (let sc = 0; sc < cols; sc++) {
      const x0 = sc * tw;
      const y0 = sr * th;
      const left = new Float64Array(th * 3);
      const right = new Float64Array(th * 3);
      const top = new Float64Array(tw * 3);
      const bottom = new Float64Array(tw * 3);
      for (let y = 0; y < th; y++) {
        const rowBase = ((y0 + y) * width) * 4;
        const lo = rowBase + x0 * 4;
        const ro = rowBase + (x0 + tw - 1) * 4;
        left[y * 3] = pixels[lo]!;
        left[y * 3 + 1] = pixels[lo + 1]!;
        left[y * 3 + 2] = pixels[lo + 2]!;
        right[y * 3] = pixels[ro]!;
        right[y * 3 + 1] = pixels[ro + 1]!;
        right[y * 3 + 2] = pixels[ro + 2]!;
      }
      for (let x = 0; x < tw; x++) {
        const to = (y0 * width + (x0 + x)) * 4;
        const bo = ((y0 + th - 1) * width + (x0 + x)) * 4;
        top[x * 3] = pixels[to]!;
        top[x * 3 + 1] = pixels[to + 1]!;
        top[x * 3 + 2] = pixels[to + 2]!;
        bottom[x * 3] = pixels[bo]!;
        bottom[x * 3 + 1] = pixels[bo + 1]!;
        bottom[x * 3 + 2] = pixels[bo + 2]!;
      }
      tiles.push({
        left,
        right,
        top,
        bottom,
        vLeft: stripStdev(left),
        vRight: stripStdev(right),
        vTop: stripStdev(top),
        vBottom: stripStdev(bottom),
      });
    }
  }
  return tiles;
}

// Solve the tile arrangement from pixel content. Returns a `lookup` of length
// cols*rows where lookup[cleanRow*cols + cleanCol] = the scrambled tile index to
// place there — the same shape `descrambleImage` consumes.
export function solveAdaptiveLookup(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  cols: number,
  rows: number,
): number[] {
  const n = cols * rows;
  if (n <= 1) return [0];
  const tw = (width / cols) | 0;
  const th = (height / rows) | 0;
  if (tw === 0 || th === 0) {
    throw new Error(`image ${width}x${height} too small for ${cols}x${rows}`);
  }
  const tiles = extractEdges(pixels, width, tw, th, cols, rows);

  // Pairwise benefit of putting b to the right of a (LR) / below a (UD).
  const lr = new Float64Array(n * n);
  const ud = new Float64Array(n * n);
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      if (a === b) continue;
      lr[a * n + b] = benefit(
        tiles[a]!.right,
        tiles[a]!.vRight,
        tiles[b]!.left,
        tiles[b]!.vLeft,
      );
      ud[a * n + b] = benefit(
        tiles[a]!.bottom,
        tiles[a]!.vBottom,
        tiles[b]!.top,
        tiles[b]!.vTop,
      );
    }
  }

  // Greedy open-lattice growth. Positions live on a virtual integer grid; the
  // bounding box is capped to rows×cols so no cell can wrap.
  const posR = new Int32Array(n).fill(-1);
  const posC = new Int32Array(n).fill(-1);
  const placed = new Uint8Array(n);
  const cellOf = new Map<number, number>(); // r*BIG+c -> tile
  const BIG = 1 << 15;
  const key = (r: number, c: number) => (r + BIG) * (BIG * 2) + (c + BIG);

  let minR = 0, maxR = 0, minC = 0, maxC = 0;

  const place = (t: number, r: number, c: number) => {
    posR[t] = r;
    posC[t] = c;
    placed[t] = 1;
    cellOf.set(key(r, c), t);
    if (cellOf.size === 1) {
      minR = maxR = r;
      minC = maxC = c;
    } else {
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
    }
  };

  // Seed with the single best adjacency anywhere.
  let bestVal = -1, bestA = 0, bestB = 1, bestDir = 0; // dir 0=LR,1=UD
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      if (a === b) continue;
      if (lr[a * n + b]! > bestVal) {
        bestVal = lr[a * n + b]!;
        bestA = a;
        bestB = b;
        bestDir = 0;
      }
      if (ud[a * n + b]! > bestVal) {
        bestVal = ud[a * n + b]!;
        bestA = a;
        bestB = b;
        bestDir = 1;
      }
    }
  }
  place(bestA, 0, 0);
  if (bestDir === 0) place(bestB, 0, 1);
  else place(bestB, 1, 0);

  const wouldFit = (r: number, c: number): boolean => {
    const nMinR = Math.min(minR, r), nMaxR = Math.max(maxR, r);
    const nMinC = Math.min(minC, c), nMaxC = Math.max(maxC, c);
    return (nMaxR - nMinR + 1) <= rows && (nMaxC - nMinC + 1) <= cols;
  };

  // Benefit of dropping tile u into empty cell (r,c) given its placed neighbors.
  const cellScore = (u: number, r: number, c: number): number => {
    let s = 0;
    const lft = cellOf.get(key(r, c - 1));
    if (lft !== undefined) s += lr[lft * n + u]!; // u right-of left neighbor
    const rgt = cellOf.get(key(r, c + 1));
    if (rgt !== undefined) s += lr[u * n + rgt]!; // right neighbor right-of u
    const up = cellOf.get(key(r - 1, c));
    if (up !== undefined) s += ud[up * n + u]!; // u below upper neighbor
    const dn = cellOf.get(key(r + 1, c));
    if (dn !== undefined) s += ud[u * n + dn]!; // lower neighbor below u
    return s;
  };

  while (cellOf.size < n) {
    // Collect empty cells adjacent to any placed tile that keep us in-bounds.
    const frontier = new Set<number>();
    for (const [k, _t] of cellOf) {
      const c = (k % (BIG * 2)) - BIG;
      const r = ((k - (c + BIG)) / (BIG * 2)) - BIG;
      const neigh: [number, number][] = [
        [r, c - 1],
        [r, c + 1],
        [r - 1, c],
        [r + 1, c],
      ];
      for (const [nr, nc] of neigh) {
        if (cellOf.has(key(nr, nc))) continue;
        if (!wouldFit(nr, nc)) continue;
        frontier.add(key(nr, nc));
      }
    }

    let bR = 0, bC = 0, bU = -1, bScore = -1;
    for (const fk of frontier) {
      const c = (fk % (BIG * 2)) - BIG;
      const r = ((fk - (c + BIG)) / (BIG * 2)) - BIG;
      for (let u = 0; u < n; u++) {
        if (placed[u]) continue;
        const sc = cellScore(u, r, c);
        if (sc > bScore) {
          bScore = sc;
          bR = r;
          bC = c;
          bU = u;
        }
      }
    }
    if (bU < 0) throw new Error("adaptive solve: no frontier (grid mismatch)");
    place(bU, bR, bC);
  }

  // Normalize to (0,0) and emit the lookup.
  const lookup = new Array<number>(n);
  for (let t = 0; t < n; t++) {
    const cleanRow = posR[t]! - minR;
    const cleanCol = posC[t]! - minC;
    lookup[cleanRow * cols + cleanCol] = t;
  }
  return lookup;
}
