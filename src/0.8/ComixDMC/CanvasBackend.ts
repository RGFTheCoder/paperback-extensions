/* SPDX-License-Identifier: GPL-3.0-or-later */

// Paperback 0.8 canvas backend for tile descramble.
//
// Implements the shared `CanvasBackend` using the host's `App.createPBImage` /
// `App.createPBCanvas`. Tiles are blitted straight from the immutable source
// `PBImage` (never from the destination canvas), so overlapping tile moves can't
// corrupt output. The destination is pre-seeded with the full source image so the
// untiled right/bottom margin (when width/height isn't divisible by the grid)
// survives unchanged.

import type { PBCanvas, PBImage, RawData } from "@paperback/types-0.8";
import type {
  CanvasBackend,
  DescrambleCanvas,
  EncodedImage,
} from "../../../shared/descramble/descramble.ts";
import { decodePng } from "../../../shared/descramble/png.ts";

class PBDescrambleCanvas implements DescrambleCanvas<RawData> {
  readonly width: number;
  readonly height: number;

  constructor(
    private readonly src: PBImage,
    private readonly canvas: PBCanvas,
  ) {
    this.width = canvas.width;
    this.height = canvas.height;
  }

  drawTile(
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
  ): void {
    this.canvas.drawImage(this.src, sx, sy, sw, sh, dx, dy);
  }

  // Decode the *source* to RGBA for the adaptive solver. 0.8 exposes no pixel
  // readback, so we re-encode the untouched source to PNG (lossless) on a scratch
  // canvas and inflate it in pure JS. Called once per page only when adaptive is
  // selected, before any drawTile mutates the destination.
  getSourcePixels(): Uint8Array {
    const scratch = App.createPBCanvas();
    scratch.setSize(this.width, this.height);
    scratch.drawImage(this.src, 0, 0, this.width, this.height, 0, 0);
    const png = scratch.encode("image/png");
    if (!png) throw new Error("PBCanvas.encode(png) returned no data");
    const { data } = decodePng(App.createByteArray(png));
    return data;
  }

  encode(_preferredMime: string): EncodedImage<RawData> {
    // Prefer WebP so Kingfisher's WebPProcessor (keyed on the .webp URL) can
    // still decode the result; fall back to PNG if WebP isn't supported. The
    // caller's requested MIME is ignored here — 0.8 always re-encodes to one of
    // these two and rewrites the response's content-type to match.
    let out = this.canvas.encode("image/webp");
    let mime = "image/webp";
    if (!out) {
      out = this.canvas.encode("image/png");
      mime = "image/png";
    }
    if (!out) throw new Error("PBCanvas.encode returned no data");
    return { data: out, mime };
  }
}

export const pbCanvasBackend: CanvasBackend<RawData, RawData> = {
  fromImage(data: RawData): DescrambleCanvas<RawData> {
    const src = App.createPBImage({ data });
    const { width, height } = src;
    const canvas = App.createPBCanvas();
    canvas.setSize(width, height);
    // Seed the destination with the full source image so the untiled margin
    // survives; the tile blits then overwrite the scrambled tile grid.
    canvas.drawImage(src, 0, 0, width, height, 0, 0);
    return new PBDescrambleCanvas(src, canvas);
  },
};
