/* SPDX-License-Identifier: GPL-3.0-or-later */
// Shared, source-agnostic string helpers.

// Normalize typographic punctuation to ASCII equivalents so titles/queries
// compare and search consistently across sources.
export function normalizeString(str: string): string {
  return str
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'") // smart single quotes → '
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"'); // smart double quotes → "
}
