/* SPDX-License-Identifier: GPL-3.0-or-later */
/// <reference lib="deno.ns" />

// Resolve the version of an `npm:` import-map alias without a node_modules dir.
// Both bundlers report the `@paperback/types` version the sources were built
// against; with `nodeModulesDir: "none"` there is no package.json on disk, so we
// read the pinned specifier straight from deno.json's import map instead.
//
//   "@paperback/types-0.9": "npm:@paperback/types@^1.0.0-alpha.92"  ->  "1.0.0-alpha.92"

import { join } from "@std/path";

export async function typesVersionFor(
  alias: string,
  cwd: string = Deno.cwd(),
): Promise<string> {
  const deno = JSON.parse(await Deno.readTextFile(join(cwd, "deno.json"))) as {
    imports?: Record<string, string>;
  };
  const spec = deno.imports?.[alias] ?? "";
  // Capture the version range after the final '@' and strip any ^/~ prefix.
  const m = /@([\^~]?\d[^@"]*)$/.exec(spec);
  return (m?.[1] ?? "0.0.0").replace(/^[\^~]/, "");
}
