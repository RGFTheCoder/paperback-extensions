/* SPDX-License-Identifier: GPL-3.0-or-later */

// Content-based ("adaptive") tile-descramble solver.
//
// The seed-driven schemes (lcg/xorshift/gf2affine) invert the exact Fisher-Yates
// permutation Comix used. This solver instead ignores the seed and reconstructs
// the page purely from pixel content, treating the cols×rows tile grid as a
// jigsaw with fixed orientation: find the arrangement whose interior seams line
// up best. Useful when Comix rotates to a scheme we don't yet model.
//
// Seam scoring (the crux). For every candidate adjacency we combine:
//   similarity  — how well the two touching pixel edges match, exp(-meanΔ),
//                 in (0,1]; 1 = identical.
//   confidence  — how textured those edges are (stdev → 0 for a flat/solid edge,
//                 → 1 for a busy one).
// and score a seam by a CENTRED reward:
//   score = confidence · (2·similarity − 1)
//   → strongly POSITIVE for a confident (textured) match,
//   → strongly NEGATIVE for a confident (textured) mismatch,
//   → ≈ 0 for any flat/low-texture seam (match or not).
// We MAXIMISE the total score over interior seams (border seams excluded).
//
// Why centred, and why maximise. Two failure modes have to die at once:
//   * Toroidal roll on flat bands. A page with solid black/white margins can be
//     cyclically shifted so the flat left margin glues to the flat right margin.
//     Because flat seams score ≈0, that wrapped seam is worthless — but the shift
//     also BREAKS a true textured seam (large positive), so the roll strictly
//     lowers the total. The true frame wins.
//   * Textured edges on the real border. A high-variance edge can legitimately
//     sit on the outer image border. A pure "penalise mismatch" objective would
//     exile costly-but-true seams to the (unpenalised) border to cheat; rewarding
//     matches removes that incentive — the true arrangement already has every
//     real match on the inside, and no rearrangement can out-score all-true.
// A confident MISMATCH scores negative (not merely zero), so a wrong swap of two
// textured tiles is actively rejected by the local search.
//
// Solve: greedy growth → local search from many starts (all frame shifts + random
// restarts), keeping the highest-scoring arrangement. n = cols·rows is tiny (25
// for a 5×5 page) so this is well under ~30 ms.

const SIM_SCALE = 40; // similarity pivot (sim=0.5) at meanΔ ≈ 40·ln2 ≈ 27.7,
// placed between real true-seam meanΔ (measured ≤ ~24) and mismatch meanΔ (≥ ~30)
const CONF_K = 8; // edge stdev at which confidence reaches 0.5
const EPS = 1e-9;

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

// Centred seam reward: confidence · (2·similarity − 1).
function seamScore(
  a: Float64Array,
  aVar: number,
  b: Float64Array,
  bVar: number,
): number {
  const similarity = Math.exp(-meanAbsDiff(a, b) / SIM_SCALE);
  const v = (aVar + bVar) / 2;
  const confidence = v / (v + CONF_K);
  return confidence * (2 * similarity - 1);
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
        const rowBase = (y0 + y) * width * 4;
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

export interface SeamScores {
  n: number;
  // lr[a*n+b] = score of placing tile b immediately right of tile a.
  lr: Float64Array;
  // ud[a*n+b] = score of placing tile b immediately below tile a.
  ud: Float64Array;
}

// Pairwise centred seam scores for every ordered tile pair (exposed for
// tests/debug). Self-pairs are left at 0 and never referenced.
export function computeSeamScores(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  tw: number,
  th: number,
  cols: number,
  rows: number,
): SeamScores {
  const tiles = extractEdges(pixels, width, tw, th, cols, rows);
  const n = cols * rows;
  const lr = new Float64Array(n * n);
  const ud = new Float64Array(n * n);
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      if (a === b) continue;
      lr[a * n + b] = seamScore(
        tiles[a]!.right,
        tiles[a]!.vRight,
        tiles[b]!.left,
        tiles[b]!.vLeft,
      );
      ud[a * n + b] = seamScore(
        tiles[a]!.bottom,
        tiles[a]!.vBottom,
        tiles[b]!.top,
        tiles[b]!.vTop,
      );
    }
  }
  return { n, lr, ud };
}

// Total centred score of the interior seams of an arrangement. `arr[r*cols+c]`
// is the tile placed at clean position (r,c). Border seams are excluded.
export function arrangementScore(
  arr: number[],
  lr: Float64Array,
  ud: Float64Array,
  n: number,
  cols: number,
  rows: number,
): number {
  let s = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const t = arr[r * cols + c]!;
      if (c + 1 < cols) s += lr[t * n + arr[r * cols + c + 1]!]!;
      if (r + 1 < rows) s += ud[t * n + arr[(r + 1) * cols + c]!]!;
    }
  }
  return s;
}

// Greedy open-lattice growth → an initial arrangement (arr[pos] = tile). Grows on
// a virtual integer grid capped to rows×cols so no cell can wrap, always adding
// the placement with the highest incremental seam score.
function greedyArrangement(
  lr: Float64Array,
  ud: Float64Array,
  n: number,
  cols: number,
  rows: number,
): number[] {
  const posR = new Int32Array(n).fill(-1);
  const posC = new Int32Array(n).fill(-1);
  const placed = new Uint8Array(n);
  const cellOf = new Map<number, number>();
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

  // Seed with the single highest-scoring adjacency anywhere.
  let bestVal = -Infinity, bestA = 0, bestB = 1, bestDir = 0; // dir 0=LR,1=UD
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
  // Incremental score of dropping tile u into empty cell (r,c).
  const cellScore = (u: number, r: number, c: number): number => {
    let s = 0;
    const lft = cellOf.get(key(r, c - 1));
    if (lft !== undefined) s += lr[lft * n + u]!;
    const rgt = cellOf.get(key(r, c + 1));
    if (rgt !== undefined) s += lr[u * n + rgt]!;
    const up = cellOf.get(key(r - 1, c));
    if (up !== undefined) s += ud[up * n + u]!;
    const dn = cellOf.get(key(r + 1, c));
    if (dn !== undefined) s += ud[u * n + dn]!;
    return s;
  };

  while (cellOf.size < n) {
    const frontier = new Set<number>();
    for (const [k] of cellOf) {
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
    let bR = 0, bC = 0, bU = -1, bScore = -Infinity;
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

  const arr = new Array<number>(n);
  for (let t = 0; t < n; t++) {
    arr[(posR[t]! - minR) * cols + (posC[t]! - minC)] = t;
  }
  return arr;
}

// Sum of the interior-seam scores touching position `p` in `arr`.
function incident(
  arr: number[],
  p: number,
  lr: Float64Array,
  ud: Float64Array,
  n: number,
  cols: number,
  rows: number,
): number {
  const r = (p / cols) | 0, c = p % cols;
  const t = arr[p]!;
  let s = 0;
  if (c > 0) s += lr[arr[p - 1]! * n + t]!;
  if (c + 1 < cols) s += lr[t * n + arr[p + 1]!]!;
  if (r > 0) s += ud[arr[p - cols]! * n + t]!;
  if (r + 1 < rows) s += ud[t * n + arr[p + cols]!]!;
  return s;
}

// Score of the direct seam between positions p and q if they are grid neighbours
// (else 0) — subtracted once so it isn't double-counted in a swap delta.
function sharedEdge(
  arr: number[],
  p: number,
  q: number,
  lr: Float64Array,
  ud: Float64Array,
  n: number,
  cols: number,
): number {
  const pr = (p / cols) | 0, pc = p % cols;
  const qr = (q / cols) | 0, qc = q % cols;
  if (pr === qr && Math.abs(pc - qc) === 1) {
    const [l, rr] = pc < qc ? [arr[p]!, arr[q]!] : [arr[q]!, arr[p]!];
    return lr[l * n + rr]!;
  }
  if (pc === qc && Math.abs(pr - qr) === 1) {
    const [u, d] = pr < qr ? [arr[p]!, arr[q]!] : [arr[q]!, arr[p]!];
    return ud[u * n + d]!;
  }
  return 0;
}

// Roll rows [i0..i1] (inclusive) horizontally by k columns, in place.
function rollRowBlock(
  arr: number[],
  i0: number,
  i1: number,
  k: number,
  cols: number,
): void {
  const tmp = new Array<number>(cols);
  for (let r = i0; r <= i1; r++) {
    for (let c = 0; c < cols; c++) tmp[c] = arr[r * cols + ((c + k) % cols)]!;
    for (let c = 0; c < cols; c++) arr[r * cols + c] = tmp[c]!;
  }
}

// Roll columns [j0..j1] (inclusive) vertically by k rows, in place.
function rollColBlock(
  arr: number[],
  j0: number,
  j1: number,
  k: number,
  cols: number,
  rows: number,
): void {
  const tmp = new Array<number>(rows);
  for (let c = j0; c <= j1; c++) {
    for (let r = 0; r < rows; r++) tmp[r] = arr[((r + k) % rows) * cols + c]!;
    for (let r = 0; r < rows; r++) arr[r * cols + c] = tmp[r]!;
  }
}

// Hill-climb by best-improving moves until none raises the interior score. The
// neighbourhood is position swaps PLUS block rolls — rolling a contiguous band of
// rows horizontally, or of columns vertically, by any offset. Block rolls are
// essential: a page can settle into a "sub-block roll" (e.g. the bottom three
// rows cyclically shifted across a flat internal band, where the broken seams
// cost ≈0), which no sequence of individually-improving swaps can undo. A block
// roll un-rolls the whole band in a single improving move. Mutates and returns
// `arr`.
function localSearch(
  arr: number[],
  lr: Float64Array,
  ud: Float64Array,
  n: number,
  cols: number,
  rows: number,
): number[] {
  let cur = arrangementScore(arr, lr, ud, n, cols, rows);
  for (;;) {
    let bestDelta = EPS;
    let apply: (() => void) | null = null;

    // Position swaps (fast incremental delta).
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const before = incident(arr, p, lr, ud, n, cols, rows) +
          incident(arr, q, lr, ud, n, cols, rows) -
          sharedEdge(arr, p, q, lr, ud, n, cols);
        const tmp = arr[p]!;
        arr[p] = arr[q]!;
        arr[q] = tmp;
        const after = incident(arr, p, lr, ud, n, cols, rows) +
          incident(arr, q, lr, ud, n, cols, rows) -
          sharedEdge(arr, p, q, lr, ud, n, cols);
        arr[q] = arr[p]!;
        arr[p] = tmp; // undo
        const delta = after - before;
        if (delta > bestDelta) {
          bestDelta = delta;
          const pp = p, qq = q;
          apply = () => {
            const t = arr[pp]!;
            arr[pp] = arr[qq]!;
            arr[qq] = t;
          };
        }
      }
    }

    // Row-band horizontal rolls.
    for (let i0 = 0; i0 < rows; i0++) {
      for (let i1 = i0; i1 < rows; i1++) {
        for (let k = 1; k < cols; k++) {
          rollRowBlock(arr, i0, i1, k, cols);
          const delta = arrangementScore(arr, lr, ud, n, cols, rows) - cur;
          rollRowBlock(arr, i0, i1, cols - k, cols); // undo
          if (delta > bestDelta) {
            bestDelta = delta;
            const a = i0, b = i1, kk = k;
            apply = () => rollRowBlock(arr, a, b, kk, cols);
          }
        }
      }
    }

    // Column-band vertical rolls.
    for (let j0 = 0; j0 < cols; j0++) {
      for (let j1 = j0; j1 < cols; j1++) {
        for (let k = 1; k < rows; k++) {
          rollColBlock(arr, j0, j1, k, cols, rows);
          const delta = arrangementScore(arr, lr, ud, n, cols, rows) - cur;
          rollColBlock(arr, j0, j1, rows - k, cols, rows); // undo
          if (delta > bestDelta) {
            bestDelta = delta;
            const a = j0, b = j1, kk = k;
            apply = () => rollColBlock(arr, a, b, kk, cols, rows);
          }
        }
      }
    }

    if (!apply) break;
    apply();
    cur += bestDelta;
  }
  return arr;
}

// Small deterministic PRNG so restarts (and tests) are reproducible.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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
  const { lr, ud } = computeSeamScores(pixels, width, tw, th, cols, rows);

  const greedy = greedyArrangement(lr, ud, n, cols, rows);

  // Frame-shift helper: every cyclic (dv,dh) shift of a base arrangement.
  const shiftOf = (base: number[], dv: number, dh: number): number[] => {
    const out = new Array<number>(n);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        out[r * cols + c] = base[((r + dv) % rows) * cols + ((c + dh) % cols)]!;
      }
    }
    return out;
  };

  // Polish the greedy arrangement with the block-roll local search (which already
  // escapes toroidal/sub-block rolls in single moves), then try more starts to
  // guard against swap-only local optima: every whole-frame shift of the greedy
  // seed, plus a handful of deterministic random restarts. Keep the best.
  let best = localSearch(greedy.slice(), lr, ud, n, cols, rows);
  let bestScore = arrangementScore(best, lr, ud, n, cols, rows);
  const consider = (start: number[]): void => {
    const arr = localSearch(start.slice(), lr, ud, n, cols, rows);
    const sc = arrangementScore(arr, lr, ud, n, cols, rows);
    if (sc > bestScore) {
      bestScore = sc;
      best = arr;
    }
  };

  for (let dv = 0; dv < rows; dv++) {
    for (let dh = 0; dh < cols; dh++) {
      if (dv === 0 && dh === 0) continue;
      consider(shiftOf(greedy, dv, dh));
    }
  }

  const rand = mulberry32((0x9e3779b9 ^ (n * 2654435761)) >>> 0);
  const restarts = Math.min(16, 6 + n);
  for (let it = 0; it < restarts; it++) {
    const perm = best.slice();
    for (let i = n - 1; i > 0; i--) {
      const j = (rand() * (i + 1)) | 0;
      const t = perm[i]!;
      perm[i] = perm[j]!;
      perm[j] = t;
    }
    consider(perm);
  }

  return best;
}
