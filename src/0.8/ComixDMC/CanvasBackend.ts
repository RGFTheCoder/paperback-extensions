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
import type { DecodedImage } from "../../../shared/descramble/png.ts";
import { decodeJpeg } from "../../../shared/descramble/jpeg.ts";

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

// If a host `_data` RawData looks like a raw pixel buffer for a `px`-pixel image
// (RGBA = px·4, or RGB = px·3), materialize it as RGBA. Returns null otherwise
// (e.g. it's actually encoded bytes, or absent).
function rawRgbaFrom(
  data: RawData | undefined,
  px: number,
): Uint8Array | null {
  if (!data) return null;
  const len = data.length;
  if (len === px * 4) return App.createByteArray(data);
  if (len === px * 3) {
    const rgb = App.createByteArray(data);
    const out = new Uint8Array(px * 4);
    for (let i = 0, o = 0; i < rgb.length; i += 3) {
      out[o++] = rgb[i]!;
      out[o++] = rgb[i + 1]!;
      out[o++] = rgb[i + 2]!;
      out[o++] = 255;
    }
    return out;
  }
  return null;
}

function isJpegSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 &&
    bytes[2] === 0xff;
}

// Decode whatever `PBCanvas.encode(...)` hands back into raw RGBA. On-device the
// bytes may arrive as binary PNG, binary JPEG, base64 text, or a
// `data:…;base64,…` data URI (the host serializes differently across versions,
// and 0.8 ignores the requested PNG MIME — it re-encodes to JPEG). We normalize
// any base64/data-URI wrapper, then dispatch on the file signature. Unknown
// formats throw a diagnostic (header hex + candidate raw-buffer sizes) that the
// caller logs via `appLog("descramble-error", …)`.
function decodeEncodedImage(
  bytes: Uint8Array,
  diag: { px: number; scratchLen: number; srcLen: number },
): DecodedImage {
  let raw = bytes;
  if (!isPngSignature(raw) && !isJpegSignature(raw)) {
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
    if (looksBase64) raw = decodeBase64Ascii(bytes, start);
  }
  if (isPngSignature(raw)) return decodePng(raw);
  if (isJpegSignature(raw)) return decodeJpeg(raw);
  const hex = Array.from(raw.slice(0, 12))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  throw new Error(
    `adaptive: unknown encode header=${hex} len=${raw.length} ` +
      `px4=${diag.px * 4} scratchLen=${diag.scratchLen} srcLen=${diag.srcLen}`,
  );
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

  // Decode the *source* to RGBA for the adaptive solver. Prefer a raw pixel
  // buffer if the host exposes one (lossless, no decode). Otherwise fall back to
  // re-encoding the untouched source on a scratch canvas and decoding it in pure
  // JS. Called once per page only when adaptive is selected, before any drawTile
  // mutates the destination.
  getSourcePixels(): Uint8Array {
    const scratch = App.createPBCanvas();
    scratch.setSize(this.width, this.height);
    scratch.drawImage(this.src, 0, 0, this.width, this.height, 0, 0);

    // 1. Raw pixel readback, if available (PBCanvas/PBImage `_data`).
    const px = this.width * this.height;
    const rawScratch = rawRgbaFrom(scratch.data, px);
    if (rawScratch) return rawScratch;
    const rawSrc = rawRgbaFrom(this.src.data, px);
    if (rawSrc) return rawSrc;

    // 2. Re-encode + decode. The host ignores the requested MIME on some
    //    versions (returns JPEG), so `decodeEncodedImage` sniffs the actual
    //    format (PNG or JPEG, base64-wrapped or not) and records sizes if it
    //    can't identify it.
    const raw = scratch.encode("image/png");
    if (!raw) throw new Error("PBCanvas.encode(png) returned no data");
    const encoded = App.createByteArray(raw);
    const scratchLen = scratch.data ? scratch.data.length : -1;
    const srcLen = this.src.data ? this.src.data.length : -1;
    const { data } = decodeEncodedImage(encoded, { px, scratchLen, srcLen });
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
