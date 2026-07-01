/* SPDX-License-Identifier: GPL-3.0-or-later */
import type { Plugin } from "esbuild";
import { exists } from "@std/fs";
import { join } from "@std/path";

// Resolve TypeScript "bundler" style specifiers: source files import sibling
// modules using a `.js` extension (e.g. `../ComixDMC/main.js`) that actually
// resolve to a `.ts` file on disk. esbuild does not rewrite `.js` -> `.ts` by
// default, so this plugin maps relative `.js` imports onto their `.ts` source.
export const tsJsResolvePlugin: Plugin = {
  name: "ts-js-resolve",
  setup(build) {
    build.onResolve({ filter: /\.js$/ }, async (args) => {
      if (args.kind === "entry-point" || !args.path.startsWith(".")) return;
      const tsPath = join(args.resolveDir, args.path).replace(/\.js$/, ".ts");
      if (await exists(tsPath)) return { path: tsPath };
      return;
    });
  },
};
