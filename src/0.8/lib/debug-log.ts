/* SPDX-License-Identifier: GPL-3.0-or-later */
// Shared, source-agnostic debug-log sink.
//
// Posts plain JSON lines to a log server running on your PC so you can watch
// extension behavior in real time while testing on-device. This is a dev aid —
// leave LOCAL_LOG_URL empty (the default for released builds) to disable it.
//
// To use: start a local log server (see the repo's dev tooling), copy the
// "LAN URL" it prints, and paste it below. The device POSTs here over the LAN.

import type { RequestManager } from "@paperback/types-0.8";

export const LOCAL_LOG_URL: string = "";

// Single gate for all debug instrumentation. Set LOCAL_LOG_URL to "" for
// release: DEBUG folds to a constant false and the bundler dead-code-eliminates
// every `if (DEBUG)` block (per-request timing, counters, log POSTs), leaving
// zero overhead for users.
export const DEBUG = LOCAL_LOG_URL !== "";

let _rm: RequestManager | null = null;
function getRM(): RequestManager {
  if (!_rm) {
    _rm = App.createRequestManager({
      requestsPerSecond: 20,
      requestTimeout: 3000,
    });
  }
  return _rm;
}

export function debugLog(tag: string, data?: Record<string, unknown>): void {
  if (!LOCAL_LOG_URL) return;
  try {
    const payload = JSON.stringify({ tag, t: Date.now(), ...(data ?? {}) });
    const req = App.createRequest({
      url: LOCAL_LOG_URL,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      data: payload,
    });
    void getRM().schedule(req, 1).catch(() => {});
  } catch { /* best-effort debug logging; never throw */ }
}

// Base host for `appLog`. Points at a dev log server on the LAN/tailnet (see
// tools/logserver.ts, `deno task logserver`). Requests also surface in
// Paperback's native app log as `RequestOperation - <url>` even if the server
// is down/unreachable, so grepping the app log for this host always works.
const APPLOG_BASE = "http://100.96.0.8:8787";

// Surface a debug event in Paperback's *native* app log with no PC setup.
//
// The app renders outgoing request URLs (e.g. `RequestOperation - https://…`)
// but NOT extension `console.log`. So `appLog` encodes the event into the query
// string of a request to an unresolvable `.invalid` host: DNS fails immediately
// (no real network egress), yet the attempt is logged on-device as
// `RequestOperation - https://comixdmc.debug.invalid/<tag>?<fields>`. Grep the
// app log for `comixdmc.debug.invalid` to see them. Opt-in per call site (the
// per-page descramble events are gated behind a settings toggle).
export function appLog(
  tag: string,
  fields?: Record<string, string | number>,
): void {
  try {
    const qs = Object.entries(fields ?? {})
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join("&");
    const url = `${APPLOG_BASE}/${tag}${qs ? `?${qs}` : ""}`;
    const req = App.createRequest({ url, method: "GET" });
    void getRM().schedule(req, 1).catch(() => {});
  } catch { /* best-effort; never throw from logging */ }
}
