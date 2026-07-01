/* SPDX-License-Identifier: GPL-3.0-or-later */
/// <reference lib="deno.ns" />
// Deno-native replacement for `paperback-cli bundle`.
//
// Produces, for every extension folder under `src/` that contains both
// `pbconfig.ts` and `main.ts`:
//   bundles/<Ext>/index.js     IIFE bundle exposing a global `source`
//   bundles/<Ext>/info.json    SourceInfo (pbconfig with enums resolved + id)
//   bundles/<Ext>/static/*     copied static assets (icon, etc.)
// plus repository-level artifacts:
//   bundles/versioning.json    registry manifest aggregating all sources
//   bundles/index.html         installation homepage
//
// The output format mirrors @paperback/toolchain so the bundles remain
// installable by Paperback and consumable by a Paperback extension registry.

import * as esbuild from "esbuild";
import { copy, ensureDir, exists } from "@std/fs";
import { dirname, fromFileUrl, join, toFileUrl } from "@std/path";
import { tsJsResolvePlugin } from "./plugins.ts";

const CWD = Deno.cwd();
const SRC = join(CWD, "src");
const BUNDLES = join(CWD, "bundles");
const TOOLS = dirname(fromFileUrl(import.meta.url));
const TYPES_PKG = join(CWD, "node_modules/@paperback/types/package.json");

async function discoverSources(): Promise<string[]> {
  const sources: string[] = [];
  for await (const entry of Deno.readDir(SRC)) {
    if (
      !entry.isDirectory || entry.name.startsWith(".") || entry.name === "tests"
    ) continue;
    const hasConfig = await exists(join(SRC, entry.name, "pbconfig.ts"));
    const hasMain = await exists(join(SRC, entry.name, "main.ts"));
    if (hasConfig && hasMain) sources.push(entry.name);
  }
  return sources.sort();
}

async function buildExtension(name: string): Promise<void> {
  const outDir = join(BUNDLES, name);
  await ensureDir(outDir);

  // Transpile + bundle main.ts into an IIFE that assigns a `source` global.
  // `@paperback/types` runtime values are bundled; the ambient `Application`
  // global stays a free variable, provided by the Paperback host at runtime.
  await esbuild.build({
    entryPoints: [join(SRC, name, "main.ts")],
    outfile: join(outDir, "index.js"),
    bundle: true,
    format: "iife",
    globalName: "source",
    platform: "browser",
    target: "es2020",
    minify: true,
    charset: "utf8",
    legalComments: "none",
    resolveExtensions: [".ts", ".tsx", ".js", ".jsx", ".json"],
    plugins: [tsJsResolvePlugin],
  });

  // Copy static assets (icon.png, etc.).
  const staticDir = join(SRC, name, "static");
  if (await exists(staticDir)) {
    await copy(staticDir, join(outDir, "static"), { overwrite: true });
  }

  // Evaluate pbconfig natively: Deno runs the TS module directly, so enum
  // members resolve to their runtime values (ContentRating.EVERYONE -> "SAFE",
  // SourceIntents.* -> numeric bit flags). `id` is appended last, matching the
  // toolchain, and the file is written as compact JSON.
  const configModule = await import(
    toFileUrl(join(SRC, name, "pbconfig.ts")).href
  );
  const info = { ...configModule.default, id: name };
  await Deno.writeTextFile(join(outDir, "info.json"), JSON.stringify(info));
}

async function writeVersioning(sources: string[]): Promise<void> {
  const typesVersion = JSON.parse(await Deno.readTextFile(TYPES_PKG))
    .version as string;

  let projectInfo: { name?: string; description?: string } = {};
  const denoJsonPath = join(CWD, "deno.json");
  if (await exists(denoJsonPath)) {
    projectInfo = JSON.parse(await Deno.readTextFile(denoJsonPath));
  }

  const collected: unknown[] = [];
  for (const name of sources) {
    const infoPath = join(BUNDLES, name, "info.json");
    if (await exists(infoPath)) {
      collected.push(JSON.parse(await Deno.readTextFile(infoPath)));
    }
  }

  const versioning = {
    buildTime: new Date(),
    builtWith: {
      // We no longer depend on @paperback/toolchain; report the types version
      // the sources were built against for both fields (kept semver-valid for
      // registry compatibility).
      toolchain: typesVersion,
      types: typesVersion,
    },
    repository: {
      name: projectInfo.name ?? "Paperback Extension Repository",
      description: projectInfo.description ??
        "An extension repository for Paperback",
    },
    sources: collected,
  };

  await Deno.writeTextFile(
    join(BUNDLES, "versioning.json"),
    JSON.stringify(versioning, null, 2),
  );
}

async function main(): Promise<void> {
  await Deno.remove(BUNDLES, { recursive: true }).catch(() => {});
  await ensureDir(BUNDLES);

  const sources = await discoverSources();
  if (sources.length === 0) {
    throw new Error(
      "No extensions found under src/ (need pbconfig.ts + main.ts).",
    );
  }

  for (const name of sources) {
    console.log(`Bundling ${name}...`);
    await buildExtension(name);
  }

  await writeVersioning(sources);
  await Deno.copyFile(
    join(TOOLS, "homepage.template.html"),
    join(BUNDLES, "index.html"),
  );

  console.log(`Done. Bundled ${sources.length} extension(s) into bundles/.`);
}

try {
  await main();
} finally {
  await esbuild.stop();
}
