/* SPDX-License-Identifier: GPL-3.0-or-later */
/// <reference lib="deno.ns" />

import { assert, assertEquals } from "@std/assert";
import { decodeJpeg } from "./jpeg.ts";

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

// 16×16 solid rgb(200,100,50), baseline JPEG, 4:2:0 chroma subsampling (the
// shape a canvas JPEG encoder emits — exercises 3-component YCbCr→RGB and
// chroma upsampling).
const COLOR_16 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEP" +
  "ERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4e" +
  "Hh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAAQABADASIA" +
  "AhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEB" +
  "AAAAAAAAAAAAAAAAAAAAB//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AIgDwrP/" +
  "2Q==";

// 16×16 solid gray(120), single-component (grayscale) baseline JPEG.
const GRAY_16 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEP" +
  "ERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/wAALCAAQABABAREA/8QAFQABAQAAAAAA" +
  "AAAAAAAAAAAAAAT/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAA/AIgH/9k=";

Deno.test("decodeJpeg: 3-component YCbCr color", () => {
  const { width, height, data } = decodeJpeg(fromBase64(COLOR_16));
  assertEquals(width, 16);
  assertEquals(height, 16);
  assertEquals(data.length, 16 * 16 * 4);
  const i = (8 * 16 + 8) * 4;
  // Solid fill; allow small JPEG quantization error.
  assert(Math.abs(data[i]! - 200) <= 4, `R=${data[i]}`);
  assert(Math.abs(data[i + 1]! - 100) <= 4, `G=${data[i + 1]}`);
  assert(Math.abs(data[i + 2]! - 50) <= 4, `B=${data[i + 2]}`);
  assertEquals(data[i + 3], 255); // opaque alpha
});

Deno.test("decodeJpeg: single-component grayscale", () => {
  const { width, height, data } = decodeJpeg(fromBase64(GRAY_16));
  assertEquals(width, 16);
  assertEquals(height, 16);
  const i = (8 * 16 + 8) * 4;
  assert(Math.abs(data[i]! - 120) <= 4, `Y=${data[i]}`);
  // Grayscale replicated across RGB.
  assertEquals(data[i], data[i + 1]);
  assertEquals(data[i + 1], data[i + 2]);
  assertEquals(data[i + 3], 255);
});

Deno.test("decodeJpeg: rejects non-JPEG", () => {
  let threw = false;
  try {
    decodeJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  } catch {
    threw = true;
  }
  assert(threw, "expected decodeJpeg to reject a PNG signature");
});
