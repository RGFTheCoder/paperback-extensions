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
