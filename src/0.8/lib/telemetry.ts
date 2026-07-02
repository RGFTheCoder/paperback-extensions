/* SPDX-License-Identifier: GPL-3.0-or-later */
// Shared, source-agnostic telemetry emitter.
//
// Sends a compact per-request breakdown to an optional collector URL. Request
// paths are one-way hashed so no manga/chapter IDs leave the device in
// plaintext. Set TELEMETRY_URL to "" (the default) to disable entirely — the
// bundler then dead-code-eliminates the network path.

import { RequestManager } from "@paperback/types-0.8";
import { DEBUG, debugLog } from "./debug-log.ts";

// Set to your telemetry collector URL. Empty string disables telemetry.
export const TELEMETRY_URL = "";
// Must match the SECRET environment variable set in the collector.
const TELEMETRY_KEY = "";

export interface TelemetryEvent {
  seq: number;
  ts: number;
  label: string;
  path: string;
  status: number;
  bytes: number;
  signMs: number;
  fetchMs: number;
  parseMs: number;
  decryptMs: number;
  totalMs: number;
}

let _rm: RequestManager | null = null;
let _seq = 0;

function getRM(): RequestManager {
  if (!_rm) {
    _rm = App.createRequestManager({
      requestsPerSecond: 20,
      requestTimeout: 3000,
    });
  }
  return _rm;
}

// FNV-1a 32-bit — one-way hash so no manga/chapter IDs leave the device in plaintext
function hashPath(path: string): string {
  let h = 2166136261;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function emit(event: Omit<TelemetryEvent, "seq" | "ts">): void {
  // Local dev mirror — full readable per-request breakdown (label, real path,
  // signMs/fetchMs/parseMs/decryptMs/totalMs). No-op in released builds
  // (LOCAL_LOG_URL is empty). This isolates bundle CPU cost (signMs/decryptMs)
  // from network wait (fetchMs).
  if (DEBUG) debugLog("req", event as unknown as Record<string, unknown>);
  if (!TELEMETRY_URL) return;
  try {
    const full: TelemetryEvent = {
      seq: ++_seq,
      ts: Date.now(),
      ...event,
      path: hashPath(event.path),
    };
    const req = App.createRequest({
      url: TELEMETRY_URL,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Tel-Key": TELEMETRY_KEY,
      },
      data: JSON.stringify(full),
    });
    void getRM().schedule(req, 1).catch(() => {});
  } catch {}
}
