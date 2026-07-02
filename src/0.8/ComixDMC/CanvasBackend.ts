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

const B64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function isPngSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 &&
    bytes[2] === 0x4e && bytes[3] === 0x47;
}

// Decode base64 directly from an ASCII byte array (JavaScriptCore has no
// guaranteed `atob`). Single pass, no multi-MB intermediate string — skips
// whitespace/newlines and stops at `=` padding.
function decodeBase64Ascii(ascii: Uint8Array, start: number): Uint8Array {
  const lut = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i++) {
    lut[B64_ALPHABET.charCodeAt(i)] = i;
  }
  const out = new Uint8Array(((ascii.length - start) * 3) >> 2);
  let o = 0, acc = 0, bits = 0;
  for (let i = start; i < ascii.length; i++) {
    const v = lut[ascii[i]!];
    if (v === -1) {
      if (ascii[i] === 0x3d) break; // '=' padding → done
      continue; // skip whitespace / stray bytes
    }
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

// Normalize whatever `PBCanvas.encode("image/png")` hands back into raw PNG file
// bytes. On-device this may arrive as binary PNG, as base64 text, or as a
// `data:image/png;base64,…` data URI (the host serializes differently across
// versions). If it's some other image format entirely, throw a header-hex
// diagnostic — the caller logs it via `appLog("descramble-error", …)`.
function toPngBytes(bytes: Uint8Array): Uint8Array {
  if (isPngSignature(bytes)) return bytes;
  let start = 0;
  let head = "";
  const scan = Math.min(bytes.length, 64);
  for (let i = 0; i < scan; i++) head += String.fromCharCode(bytes[i]!);
  if (head.startsWith("data:")) {
    const comma = head.indexOf(",");
    if (comma !== -1) start = comma + 1;
  }
  const first = bytes[start] ?? 0;
  const looksBase64 = (first >= 0x41 && first <= 0x5a) ||
    (first >= 0x61 && first <= 0x7a) || (first >= 0x30 && first <= 0x39) ||
    first === 0x2b || first === 0x2f;
  if (looksBase64) {
    const decoded = decodeBase64Ascii(bytes, start);
    if (isPngSignature(decoded)) return decoded;
  }
  const hex = Array.from(bytes.slice(0, 12))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  throw new Error(`adaptive: non-PNG encode header=${hex} len=${bytes.length}`);
}

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
    const raw = scratch.encode("image/png");
    if (!raw) throw new Error("PBCanvas.encode(png) returned no data");
    const bytes = toPngBytes(App.createByteArray(raw));
    const { data } = decodePng(bytes);
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
