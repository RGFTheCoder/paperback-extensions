/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 Inkdex */

// Paperback 0.9 canvas backend for tile descramble.
//
// Implements the shared `CanvasBackend` using the Paperback runtime polyfill's
// DOM-ish `Image` / `HTMLCanvasElement`. Two quirks are handled here:
//   1. The polyfill omits Blob / URL / OffscreenCanvas, so image bytes cross the
//      boundary via `data:` URLs (base64 in, toDataURL out).
//   2. getImageData/putImageData are Y-up (origin bottom-left), so the pixel
//      buffer is row-reversed vs. the image; we flip to standard Y-down for the
//      tile blits and flip back before putImageData.
//
// Tiles are copied from an immutable pre-captured source buffer into a separate
// destination buffer (seeded from the source so the untiled right/bottom margin
// survives), so overlapping tile moves cannot corrupt output.

import type {
  CanvasBackend,
  DescrambleCanvas,
  EncodedImage,
} from "../../../../shared/descramble/descramble.ts";

async function loadImageFromBuffer(
  data: ArrayBuffer,
  mimeType: string,
): Promise<HTMLImageElement> {
  const b64 = Application.base64Encode(data);
  const b64Str = typeof b64 === "string"
    ? b64
    : Application.arrayBufferToASCIIString(b64);
  const dataUrl = `data:${mimeType};base64,${b64Str}`;

  const img = new Image();
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    if (img.complete && img.naturalWidth > 0) {
      resolve(img);
      return;
    }
    img.onload = () => resolve(img);
    img.onerror = (event) => {
      const msg = typeof event === "string" ? event : "image load failed";
      reject(new Error(msg));
    };
    img.src = dataUrl;
    if (img.complete && img.naturalWidth > 0) resolve(img);
  });
}

function decodeDataUrlToArrayBuffer(dataUrl: string): ArrayBuffer {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("toDataURL returned malformed data URL");
  const payload = dataUrl.slice(comma + 1);
  const decoded = Application.base64Decode(payload);
  if (typeof decoded === "string") {
    const buf = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) buf[i] = decoded.charCodeAt(i);
    return buf.buffer;
  }
  return decoded;
}

class DomDescrambleCanvas implements DescrambleCanvas<ArrayBuffer> {
  readonly #stride: number;

  constructor(
    readonly width: number,
    readonly height: number,
    private readonly srcStd: Uint8ClampedArray,
    private readonly dstStd: Uint8ClampedArray,
    private readonly canvas: HTMLCanvasElement,
    private readonly ctx: CanvasRenderingContext2D,
  ) {
    this.#stride = width * 4;
  }

  drawTile(
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
  ): void {
    const rowBytes = sw * 4;
    for (let y = 0; y < sh; y++) {
      const srcOff = ((sy + y) * this.width + sx) * 4;
      const dstOff = ((dy + y) * this.width + dx) * 4;
      this.dstStd.set(this.srcStd.subarray(srcOff, srcOff + rowBytes), dstOff);
    }
  }

  // Standard Y-down RGBA of the source; the adaptive solver reads tile edges.
  getSourcePixels(): Uint8ClampedArray {
    return this.srcStd;
  }

  encode(preferredMime: string): EncodedImage<ArrayBuffer> {
    // Flip the standard Y-down destination back to the polyfill's Y-up layout,
    // then write it and re-encode to the requested MIME (same as the input).
    const stride = this.#stride;
    const dstYup = new Uint8ClampedArray(this.dstStd.length);
    for (let y = 0; y < this.height; y++) {
      dstYup.set(
        this.dstStd.subarray(y * stride, (y + 1) * stride),
        (this.height - 1 - y) * stride,
      );
    }
    this.ctx.putImageData(new ImageData(dstYup, this.width, this.height), 0, 0);
    const data = decodeDataUrlToArrayBuffer(
      this.canvas.toDataURL(preferredMime),
    );
    return { data, mime: preferredMime };
  }
}

export const domCanvasBackend: CanvasBackend<ArrayBuffer, ArrayBuffer> = {
  async fromImage(
    data: ArrayBuffer,
    mime: string,
  ): Promise<DescrambleCanvas<ArrayBuffer>> {
    const src = await loadImageFromBuffer(data, mime);
    const width = src.naturalWidth || src.width;
    const height = src.naturalHeight || src.height;

    const canvas = new HTMLCanvasElement();
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("failed to acquire 2d context");
    ctx.drawImage(src, 0, 0, width, height);

    // Capture source pixels once, un-flipped to standard Y-down. Pre-copy into
    // the destination so the untiled margin survives the tile blits.
    const stride = width * 4;
    const srcYup = ctx.getImageData(0, 0, width, height).data;
    const srcStd = new Uint8ClampedArray(srcYup.length);
    for (let y = 0; y < height; y++) {
      srcStd.set(
        srcYup.subarray(y * stride, (y + 1) * stride),
        (height - 1 - y) * stride,
      );
    }
    const dstStd = new Uint8ClampedArray(srcStd);

    return new DomDescrambleCanvas(
      width,
      height,
      srcStd,
      dstStd,
      canvas,
      ctx,
    );
  },
};
