/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 Inkdex */

// On-device debug logging that surfaces in Paperback's native app log.
//
// The app renders outgoing request URLs (`RequestOperation - https://…`) but
// NOT extension `console.log`. So `appLog` encodes the event into the path +
// query string of a request to a dev log server on the LAN/tailnet (see
// tools/logserver.ts, `deno task logserver`). Even if the server is
// down/unreachable, the attempt still shows up in the app log — grep it for the
// host below. Opt-in: the per-page descramble events are gated behind a
// settings toggle.

const APPLOG_BASE = "http://100.96.0.8:8787";

export function appLog(
  tag: string,
  fields?: Record<string, string | number>,
): void {
  try {
    const qs = Object.entries(fields ?? {})
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join("&");
    const url = `${APPLOG_BASE}/${tag}${qs ? `?${qs}` : ""}`;
    void Application.scheduleRequest({ url, method: "GET" }).catch(() => {});
  } catch { /* best-effort; never throw from logging */ }
}
