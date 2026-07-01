/* SPDX-License-Identifier: GPL-3.0-or-later */
/// <reference lib="deno.ns" />
// Deno-native bundler for Paperback 0.8 extensions.
//
// Uses the built-in `deno bundle` command (no third-party bundler dependency).
// Produces, for every extension folder under `src/` that contains a matching
// `<Folder>/<Folder>.ts` entry (exporting the source class `<Folder>` and its
// `<Folder>Info: SourceInfo`):
//   bundles/<Folder>/source.js           script exposing a global `Sources`
//   bundles/<Folder>/includes/icon.png   copied static assets
// plus repository-level artifacts:
//   bundles/versioning.json              registry manifest aggregating sources
//   bundles/index.html                   installation homepage
//
// The output format mirrors the Paperback 0.8 toolchain so the bundles remain
// installable by Paperback 0.8 and consumable by a Paperback extension registry.

import { copy, ensureDir, exists } from "@std/fs";
import { join, toFileUrl } from "@std/path";

// Repository metadata for the generated homepage. Edit `baseURL` to match where
// this branch's bundles are published (GitHub Pages destination = branch name).
const REPO = {
  name: "ComixTo (DMC)",
  description: "Comix.to extension for Paperback 0.8 (DMC fork).",
  baseURL: "https://rgfthecoder.github.io/paperback-extensions/0.8/stable",
};

const CWD = Deno.cwd();
const SRC = join(CWD, "src");
const BUNDLES = join(CWD, "bundles");
const TYPES_PKG = join(CWD, "node_modules/@paperback/types/package.json");

// Paperback 0.8 reads a global `Sources` object from the bundle. The synthetic
// entry sets `globalThis.Sources`; this footer mirrors it onto the top-level
// script `this` (parity with the legacy bundle, for classic-script eval) and
// onto CommonJS `module.exports`, so the object is discoverable regardless of
// how the host evaluates the file.
const SOURCE_FOOTER =
  "\ntry { this.Sources = globalThis.Sources; } catch (e) {}\n" +
  'if (typeof module === "object" && module && module.exports) { module.exports.Sources = globalThis.Sources; }\n';

interface SourceInfoLike {
  version: string;
  name: string;
  icon: string;
  author?: string;
  authorWebsite?: string;
  description?: string;
  contentRating: string;
  websiteBaseURL: string;
  sourceTags?: Array<{ text: string; type: string }>;
  intents: number;
}

async function discoverSources(): Promise<string[]> {
  const sources: string[] = [];
  for await (const entry of Deno.readDir(SRC)) {
    if (!entry.isDirectory || entry.name.startsWith(".")) continue;
    // Entry convention: src/<Folder>/<Folder>.ts.
    if (await exists(join(SRC, entry.name, `${entry.name}.ts`))) {
      sources.push(entry.name);
    }
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

async function buildExtension(name: string): Promise<SourceInfoLike> {
  const outDir = join(BUNDLES, name);
  await ensureDir(outDir);

  // Write a synthetic entry beside the source so its relative import resolves,
  // then bundle it. The entry pins the exports onto `globalThis.Sources` so the
  // tree-shaker keeps them and the Paperback host can find them. The ambient
  // `App` global is left as a free variable, provided by the host at runtime.
  const entryPath = join(SRC, name, "__bundle_entry__.ts");
  const entrySource = `import { ${name}, ${name}Info } from "./${name}.ts";\n` +
    `// deno-lint-ignore no-explicit-any\n` +
    `(globalThis as any).Sources = { ${name}: ${name}, ${name}Info: ${name}Info };\n`;
  await Deno.writeTextFile(entryPath, entrySource);
  try {
    const bundled = await denoBundle(entryPath);
    const source = `"use strict";\n${bundled}${SOURCE_FOOTER}`;
    await Deno.writeTextFile(join(outDir, "source.js"), source);
  } finally {
    await Deno.remove(entryPath).catch(() => {});
  }

  // Copy static assets. Paperback 0.8 expects them under `includes/`.
  const includesDir = join(SRC, name, "includes");
  if (await exists(includesDir)) {
    await copy(includesDir, join(outDir, "includes"), { overwrite: true });
  }

  // Read the source's declared SourceInfo by importing the entry natively
  // (sloppy-imports resolves the extensionless relative imports); enum members
  // resolve to their runtime values (ContentRating.EVERYONE -> "EVERYONE",
  // BadgeColor.GREY -> "info", SourceIntents.* OR-ed into a number).
  const mod = await import(toFileUrl(join(SRC, name, `${name}.ts`)).href);
  const info = mod[`${name}Info`] as SourceInfoLike | undefined;
  if (!info) {
    throw new Error(`src/${name}/${name}.ts does not export ${name}Info`);
  }
  return info;
}

function toManifestSource(id: string, info: SourceInfoLike) {
  return {
    id,
    name: info.name,
    author: info.author ?? "",
    desc: info.description ?? "",
    website: info.authorWebsite ?? "",
    contentRating: info.contentRating,
    version: info.version,
    icon: info.icon,
    tags: (info.sourceTags ?? []).map((t) => ({ text: t.text, type: t.type })),
    websiteBaseURL: info.websiteBaseURL,
    intents: info.intents,
  };
}

async function writeVersioning(
  sources: Array<{ id: string; info: SourceInfoLike }>,
): Promise<void> {
  const typesVersion = JSON.parse(await Deno.readTextFile(TYPES_PKG))
    .version as string;
  const manifest = {
    buildTime: new Date(),
    sources: sources.map(({ id, info }) => toManifestSource(id, info)),
    // We build with `deno bundle` rather than @paperback/toolchain; report the
    // types version the sources were built against for both fields (kept in the
    // 0.8 schema for registry compatibility).
    builtWith: { toolchain: typesVersion, types: typesVersion },
  };
  await Deno.writeTextFile(
    join(BUNDLES, "versioning.json"),
    JSON.stringify(manifest),
  );
}

function renderHomepage(
  sources: Array<{ id: string; info: SourceInfoLike }>,
): string {
  const addRepoUrl = `paperback://addRepo?displayName=${
    encodeURIComponent(REPO.name)
  }&url=${encodeURIComponent(REPO.baseURL)}`;
  const list = sources
    .map(({ id, info }) => {
      const tag = info.sourceTags?.[0]?.text ?? "";
      return `<li>${id}${tag ? ` <span class="tag">${tag}</span>` : ""}</li>`;
    })
    .join("");
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta name="robots" content="noindex" />
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${REPO.name}</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #2c3e50; padding: 3.6rem 2rem 1.5rem; text-align: center; }
      .title { font-weight: 700; margin-bottom: 8px; }
      .addToPaperbackButton { display: inline-block; margin: 1rem 0; padding: 0.6rem 1.2rem; background: #367cf4; color: #fff; border-radius: 8px; text-decoration: none; }
      .baseUrl { margin-top: 2rem; }
      .tag { font-size: 0.75rem; padding: 0 6px; border-radius: 6px; background: #e6effd; color: #367cf4; }
      ul { list-style: none; padding: 0; }
    </style>
  </head>
  <body>
    <header>
      <h1>${REPO.name}</h1>
      <p>${REPO.description}</p>
      <a class="addToPaperbackButton" href="${addRepoUrl}">Add to Paperback</a>
    </header>
    <div class="content">
      <div class="baseUrl">
        <p class="title">Base URL:</p>
        <p>${REPO.baseURL}</p>
      </div>
      <div class="availableSources">
        <p class="title">Available Sources:</p>
        <ul>${list}</ul>
      </div>
    </div>
  </body>
</html>
`;
}

async function main(): Promise<void> {
  await Deno.remove(BUNDLES, { recursive: true }).catch(() => {});
  await ensureDir(BUNDLES);

  const names = await discoverSources();
  if (names.length === 0) {
    throw new Error(
      "No extensions found under src/ (need src/<Folder>/<Folder>.ts).",
    );
  }

  const built: Array<{ id: string; info: SourceInfoLike }> = [];
  for (const name of names) {
    console.log(`Bundling ${name}...`);
    const info = await buildExtension(name);
    built.push({ id: name, info });
  }

  await writeVersioning(built);
  await Deno.writeTextFile(join(BUNDLES, "index.html"), renderHomepage(built));

  console.log(`Done. Bundled ${built.length} extension(s) into bundles/.`);
}

await main();
