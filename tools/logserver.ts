/* SPDX-License-Identifier: GPL-3.0-or-later */
// Tiny LAN log sink for on-device extension debugging.
//
// Paperback has no on-device log console, so the 0.8 extension ships a
// best-effort logger (src/0.8/lib/debug-log.ts) that POSTs each event as JSON
// to a URL you control. Run this server on your PC, copy the printed "LAN URL"
// into `LOCAL_LOG_URL` in src/0.8/lib/debug-log.ts, rebuild + reinstall the
// extension, and every logged event (scheme switch, per-page unscramble, …)
// prints here live as you read on-device.
//
//   deno task logserver            # default port 8787
//   deno task logserver -- 9000    # custom port
//
// Both the PC and the device must be on the same network.

const port = Number(Deno.args[0] ?? "8787") || 8787;

function lanUrls(): string[] {
  const urls: string[] = [];
  try {
    for (const ni of Deno.networkInterfaces()) {
      if (ni.family !== "IPv4") continue;
      if (ni.address === "127.0.0.1") continue;
      urls.push(`http://${ni.address}:${port}`);
    }
  } catch {
    // Deno.networkInterfaces needs --allow-sys; fall back to a hint below.
  }
  return urls;
}

function ts(t?: number): string {
  const d = t ? new Date(t) : new Date();
  return d.toLocaleTimeString(undefined, { hour12: false }) +
    "." + String(d.getMilliseconds()).padStart(3, "0");
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "GET") {
    // `appLog` (on-device) encodes events into the path + query string of a GET.
    const tag = url.pathname.replace(/^\/+/, "") || "log";
    if (tag === "favicon.ico") return new Response("", { status: 204 });
    const fields = [...url.searchParams.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    console.log(`${ts()}  ${tag.padEnd(20)} ${fields}`.trimEnd());
    return new Response("ok");
  }
  if (req.method !== "POST") {
    return new Response("paperback logserver — GET/POST here\n", {
      status: 200,
    });
  }
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    const text = await req.text().catch(() => "");
    console.log(`${ts()}  [raw] ${text}`);
    return new Response("ok");
  }
  const { tag, t, ...rest } = body as {
    tag?: string;
    t?: number;
    [k: string]: unknown;
  };
  const fields = Object.entries(rest)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  console.log(
    `${ts(t)}  ${String(tag ?? "log").padEnd(20)} ${fields}`.trimEnd(),
  );
  return new Response("ok");
}

const urls = lanUrls();
console.log(`paperback logserver listening on port ${port}`);
if (urls.length) {
  console.log("Set LOCAL_LOG_URL in src/0.8/lib/debug-log.ts to one of:");
  for (const u of urls) console.log(`   ${u}`);
} else {
  console.log(
    "Could not read LAN interfaces (run with --allow-sys). Use your PC's" +
      ` LAN IP: http://<your-ip>:${port}`,
  );
}
console.log("Waiting for events…\n");

Deno.serve({ port, hostname: "0.0.0.0" }, handle);
