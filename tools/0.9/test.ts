/* SPDX-License-Identifier: GPL-3.0-or-later */
/// <reference lib="deno.ns" />
// Deno-native replacement for `paperback-cli test`.
//
// For each extension that has both `src/<Ext>/pbconfig.ts` and a matching
// `src/tests/<Ext>.ts`, this bundles the test entry into an IIFE (exposing a
// `source` global), runs it inside a `node:vm` sandbox seeded with the same
// globals the Paperback toolchain provides — including an `Application`
// implementation from `@paperback/runtime-polyfills` — and then invokes
// `source.runTests(logger)`. Results are aggregated into a JSON tree and
// written to `bundles/tests.json`.

import vm from "node:vm";
import { Buffer } from "node:buffer";
import { ApplicationPolyfill } from "@paperback/runtime-polyfills";
import { ensureDir, exists } from "@std/fs";
import { dirname, join } from "@std/path";
import { Logger } from "./logger.ts";

const CWD = Deno.cwd();
const SRC = join(CWD, "src", "0.9");
const TESTS = join(SRC, "tests");
const OUTPUT = join(CWD, "bundles", "0.9", "tests.json");

// Standard globals to expose inside the sandbox (only those present in Deno are
// forwarded). Mirrors the toolchain's VM context so extension code behaves the
// same as it does inside the Paperback runtime.
const GLOBAL_NAMES = [
  "isNaN",
  "isFinite",
  "escape",
  "unescape",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  "eval",
  "parseInt",
  "parseFloat",
  "ArrayBuffer",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "AggregateError",
  "Proxy",
  "Reflect",
  "JSON",
  "Math",
  "Atomics",
  "Int8Array",
  "Int16Array",
  "Int32Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Uint16Array",
  "Uint32Array",
  "Float16Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "DataView",
  "Date",
  "Error",
  "Boolean",
  "Map",
  "Number",
  "Set",
  "WeakMap",
  "WeakSet",
  "Object",
  "Function",
  "Array",
  "RegExp",
  "Iterator",
  "SharedArrayBuffer",
  "String",
  "Promise",
  "BigInt",
  "Symbol",
  "WeakRef",
  "FinalizationRegistry",
  "Intl",
  "EventTarget",
  "Event",
  "SubtleCrypto",
  "TextEncoder",
  "TextDecoder",
  "URL",
  "URLSearchParams",
  "crypto",
];

function createSandbox(logger: Logger): vm.Context {
  const globals = globalThis as unknown as Record<string, unknown>;
  const sandbox: Record<string, unknown> = {
    NaN,
    Infinity,
    undefined,
    Buffer,
    Application: ApplicationPolyfill(),
    console: logger.console(),
    logger,
  };
  for (const name of GLOBAL_NAMES) {
    const value = globals[name];
    if (value !== undefined) sandbox[name] = value;
  }
  return vm.createContext(sandbox);
}

// Bundle a test entry into an IIFE that pins the test module namespace onto the
// sandbox's `globalThis.source`, using `deno bundle` (no third-party bundler). A
// synthetic entry beside the test file makes its relative imports resolve.
async function bundleTest(name: string): Promise<string> {
  const entryPath = join(TESTS, `__test_entry_${name}__.ts`);
  const entrySource = `import * as __src__ from "./${name}.ts";\n` +
    `// deno-lint-ignore no-explicit-any\n` +
    `(globalThis as any).source = __src__;\n`;
  await Deno.writeTextFile(entryPath, entrySource);
  try {
    const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
      args: [
        "bundle",
        "--format",
        "iife",
        "--platform",
        "browser",
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
  } finally {
    await Deno.remove(entryPath).catch(() => {});
  }
}

async function runSourceTests(name: string, root: Logger): Promise<void> {
  const logger = root.scope(name);
  try {
    const code = await bundleTest(name);
    const context = createSandbox(logger);
    vm.runInContext(code, context);
    await vm.runInContext("source.runTests(logger)", context);
  } catch (error) {
    logger.log("error", String(error));
  }
}

async function discoverTestSources(): Promise<string[]> {
  const sources: string[] = [];
  for await (const entry of Deno.readDir(SRC)) {
    if (
      !entry.isDirectory || entry.name === "tests" || entry.name.startsWith(".")
    ) continue;
    const hasConfig = await exists(join(SRC, entry.name, "pbconfig.ts"));
    const hasTest = await exists(join(TESTS, `${entry.name}.ts`));
    if (hasConfig && hasTest) sources.push(entry.name);
  }
  return sources.sort();
}

function summarize(tree: Record<string, unknown>): void {
  let passed = 0;
  let failed = 0;
  for (const scope of Object.keys(tree)) {
    const data = tree[scope] as Record<string, unknown>;
    if ("error" in data) {
      failed++;
      console.log(`  ${scope}: harness error -> ${data.error}`);
      continue;
    }
    const tests = (data.tests as Array<Record<string, unknown>>) ?? [];
    for (const test of tests) {
      if ("error" in test) {
        failed++;
        console.log(`  ${scope} > ${test.name}: fail`);
      } else {
        passed++;
      }
    }
  }
  console.log(`\nTest Summary — passed: ${passed}, failed: ${failed}`);
}

async function main(): Promise<void> {
  const sources = await discoverTestSources();
  if (sources.length === 0) {
    console.log(
      "No test sources found (need pbconfig.ts + src/tests/<Ext>.ts).",
    );
    return;
  }

  const root = new Logger();
  for (const name of sources) {
    console.log(`Testing ${name}...`);
    await runSourceTests(name, root);
  }

  await ensureDir(dirname(OUTPUT));
  const tree = root.raw() as Record<string, unknown>;
  await Deno.writeTextFile(OUTPUT, JSON.stringify(tree, null, 2));
  summarize(tree);
  console.log(`\nResults written to ${OUTPUT}`);
}

await main();
