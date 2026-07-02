/* SPDX-License-Identifier: GPL-3.0-or-later */
/// <reference lib="deno.ns" />

import { assertEquals } from "@std/assert";
import { decodePng } from "./png.ts";

// Build a minimal valid PNG (color type 6, RGBA, 8-bit, no interlace) from raw
// RGBA using the platform DEFLATE (CompressionStream) so the decoder's inflater
// is exercised on real Huffman-coded output. Chunk CRCs are left zero — the
// decoder ignores them.
async function encodePng(
  data: Uint8Array,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  writer.write(raw);
  writer.close();
  const zlib = new Uint8Array(
    await new Response(cs.readable).arrayBuffer(),
  );

  const be32 = (n: number) =>
    Uint8Array.from([
      (n >>> 24) & 255,
      (n >>> 16) & 255,
      (n >>> 8) & 255,
      n & 255,
    ]);
  const chunk = (type: string, body: Uint8Array) => {
    const t = Uint8Array.from([...type].map((c) => c.charCodeAt(0)));
    return [be32(body.length), t, body, be32(0)];
  };
  const ihdr = new Uint8Array(13);
  ihdr.set(be32(width), 0);
  ihdr.set(be32(height), 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const parts: Uint8Array[] = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ...chunk("IHDR", ihdr),
    ...chunk("IDAT", zlib),
    ...chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

Deno.test("decodePng round-trips RGBA through real DEFLATE", async () => {
  const width = 37, height = 23; // non-multiples to catch stride bugs
  const src = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    src[i * 4] = (i * 7) & 0xff;
    src[i * 4 + 1] = (i * 13 + 5) & 0xff;
    src[i * 4 + 2] = (i * 29 + 100) & 0xff;
    src[i * 4 + 3] = 255;
  }
  const png = await encodePng(src, width, height);
  const decoded = decodePng(png);
  assertEquals(decoded.width, width);
  assertEquals(decoded.height, height);
  assertEquals(decoded.data, src);
});

Deno.test("decodePng handles a large noisy image (Paeth/back-refs)", async () => {
  const width = 128, height = 96;
  const src = new Uint8Array(width * height * 4);
  let s = 12345;
  for (let i = 0; i < src.length; i += 4) {
    // xorshift noise stresses back-references and filtering.
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    src[i] = s & 0xff;
    src[i + 1] = (s >>> 8) & 0xff;
    src[i + 2] = (s >>> 16) & 0xff;
    src[i + 3] = 255;
  }
  const png = await encodePng(src, width, height);
  assertEquals(decodePng(png).data, src);
});
