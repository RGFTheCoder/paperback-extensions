/* SPDX-License-Identifier: GPL-3.0-or-later */
// Shared, source-agnostic date helpers.

// Parse a compact relative-time string (e.g. "3h", "2d", "5mo", "1y") into an
// absolute Date, measured back from now. Returns the current time when the
// input is missing or unrecognized.
export function parseRelativeTime(s?: string): Date {
  if (!s) return new Date();
  const m = s.match(/^(\d+)\s*(s|m|h|d|w|mos|mo|y)\b/i);
  if (!m) return new Date();
  const n = parseInt(m[1]!, 10);
  const unit = m[2]!.toLowerCase();
  const ms: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 60 * 60_000,
    d: 24 * 60 * 60_000,
    w: 7 * 24 * 60 * 60_000,
    mo: 30 * 24 * 60 * 60_000,
    mos: 30 * 24 * 60 * 60_000,
    y: 365 * 24 * 60 * 60_000,
  };
  return new Date(Date.now() - n * (ms[unit] ?? 0));
}
