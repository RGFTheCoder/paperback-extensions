/* SPDX-License-Identifier: GPL-3.0-or-later */
/// <reference lib="deno.ns" />
// Deno-native bundler for Paperback 0.9 extensions.
//
// Uses the built-in `deno bundle` command (no third-party bundler dependency),
// mirroring the 0.8 bundler. Produces, for every extension folder under
// `src/0.9/` that contains both `pbconfig.ts` and `main.ts`:
//   bundles/0.9/<Ext>/index.js     IIFE bundle exposing a global `source`
//   bundles/0.9/<Ext>/info.json    SourceInfo (pbconfig with enums resolved + id)
//   bundles/0.9/<Ext>/static/*     copied static assets (icon, etc.)
// plus repository-level artifacts:
//   bundles/0.9/versioning.json    registry manifest aggregating all sources
//   bundles/0.9/index.html         installation homepage
//
// The output format mirrors @paperback/toolchain so the bundles remain
// installable by Paperback 0.9 and consumable by a Paperback extension registry.

import { copy, ensureDir, exists } from "@std/fs";
import { dirname, fromFileUrl, join, toFileUrl } from "@std/path";
import { typesVersionFor } from "../version.ts";

const CWD = Deno.cwd();
const SRC = join(CWD, "src", "0.9");
const BUNDLES = join(CWD, "bundles", "0.9");
const TOOLS = dirname(fromFileUrl(import.meta.url));

// Paperback 0.9 reads a global `source` (the main.ts module namespace). The
// synthetic entry pins it onto `globalThis.source` so the tree-shaker keeps the
// exports; this footer mirrors it onto the top-level script `this` and CommonJS
// `module.exports`, so the object is discoverable however the host evaluates it.
const SOURCE_FOOTER =
  "\ntry { this.source = globalThis.source; } catch (e) {}\n" +
  'if (typeof module === "object" && module && module.exports) { module.exports.source = globalThis.source; }\n';

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

// Run `deno bundle` on a single entry file and return the produced JS. Bundling
// is done in a child process so we depend only on Deno's own toolchain.
async function denoBundle(entryPath: string): Promise<string> {
  const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args: [
      "bundle",
      "--format",
      "iife",
      "--platform",
      "browser",
      "--minify",
      entryPath,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (code !== 0) {
    throw new Error(
      `deno bundle failed for ${entryPath}:\n${
        new TextDecoder().decode(stderr)
      }`,
    );
  }
  return new TextDecoder().decode(stdout);
}

async function buildExtension(name: string): Promise<void> {
  const outDir = join(BUNDLES, name);
  await ensureDir(outDir);

  // Write a synthetic entry beside main.ts so its relative imports resolve, then
  // bundle it. The entry pins the module namespace onto `globalThis.source`. The
  // ambient `Application` global is left free, provided by the host at runtime.
  const entryPath = join(SRC, name, "__bundle_entry__.ts");
  const entrySource = `import * as __src__ from "./main.ts";\n` +
    `// deno-lint-ignore no-explicit-any\n` +
    `(globalThis as any).source = __src__;\n`;
  await Deno.writeTextFile(entryPath, entrySource);
  try {
    const bundled = await denoBundle(entryPath);
    const source = `"use strict";\n${bundled}${SOURCE_FOOTER}`;
    await Deno.writeTextFile(join(outDir, "index.js"), source);
  } finally {
    await Deno.remove(entryPath).catch(() => {});
  }

  // Copy static assets (icon.png, etc.). Paperback 0.9 expects them under static/.
  const staticDir = join(SRC, name, "static");
  if (await exists(staticDir)) {
    await copy(staticDir, join(outDir, "static"), { overwrite: true });
  }

  // Evaluate pbconfig natively: Deno runs the TS module directly, so enum members
  // resolve to their runtime values. `id` is appended last, matching the
  // toolchain, and the file is written as compact JSON.
  const configModule = await import(
    toFileUrl(join(SRC, name, "pbconfig.ts")).href
  );
  const info = { ...configModule.default, id: name };
  await Deno.writeTextFile(join(outDir, "info.json"), JSON.stringify(info));
}

async function writeVersioning(sources: string[]): Promise<void> {
  const typesVersion = await typesVersionFor("@paperback/types-0.9");

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
      // the sources were built against for both fields (semver-valid for
      // registry compatibility).
      toolchain: typesVersion,
      types: typesVersion,
    },
    repository: {
      // Version-qualify the monorepo name (deno.json) for this repo page.
      name: `${projectInfo.name ?? "DMC's Extensions"} (0.9)`,
      description: projectInfo.description ??
        "DMC's extensions for Paperback 0.9",
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
      "No extensions found under src/0.9/ (need pbconfig.ts + main.ts).",
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

  console.log(
    `Done. Bundled ${sources.length} extension(s) into bundles/0.9/.`,
  );
}

await main();
