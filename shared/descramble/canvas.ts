/* SPDX-License-Identifier: GPL-3.0-or-later */

// Canvas backend abstraction for tile-descramble reassembly.
//
// The tile-permutation math is platform-agnostic, but moving pixels is not:
// Paperback 0.8 exposes `App.createPBImage` / `App.createPBCanvas`, while 0.9
// exposes a DOM-ish `Image` / `HTMLCanvasElement` polyfill. Each platform
// implements this interface with its own class and injects it into the shared
// `descrambleImage` orchestrator (see ./descramble.ts).

// The re-encoded image plus the MIME type it was actually encoded as (a backend
// may fall back to a different format than requested, e.g. WebP -> PNG). `TOut`
// is the platform's encoded-bytes container: `ArrayBuffer` on 0.9, the host
// `RawData` on 0.8.
export interface EncodedImage<TOut> {
  data: TOut;
  mime: string;
}

// A canvas seeded with the scrambled source image, onto which the orchestrator
// blits tiles from the (immutable) source into their clean positions. Backends
// must read every tile from the original source pixels, never from already-
// written destination pixels, so overlapping tile moves cannot corrupt output.
export interface DescrambleCanvas<TOut> {
  readonly width: number;
  readonly height: number;

  // Copy the `sw x sh` region at (sx, sy) in the source image to (dx, dy) in the
  // destination. No scaling — destination tile size equals source tile size.
  drawTile(
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
  ): void;

  // Encode the destination to image bytes, preferring `preferredMime` but free to
  // fall back to another format; the returned `mime` reflects what was produced.
  encode(
    preferredMime: string,
  ): EncodedImage<TOut> | Promise<EncodedImage<TOut>>;
}

// Constructs a `DescrambleCanvas` from raw scrambled image bytes. `TRaw` is the
// platform's native image container: `ArrayBuffer` on 0.9, the host `RawData` on
// 0.8. The orchestrator is generic over both so neither side needs a cast.
export interface CanvasBackend<TRaw, TOut> {
  fromImage(
    data: TRaw,
    mime: string,
  ): DescrambleCanvas<TOut> | Promise<DescrambleCanvas<TOut>>;
}
