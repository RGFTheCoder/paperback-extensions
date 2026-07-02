# Comix Extensions (Unified — Paperback 0.8 & 0.9)

A single Deno monorepo hosting the Comix.to source for **both** Paperback 0.8
(`ComixTo`) and Paperback 0.9 (`ComixDMC`), sharing as much code as possible.

## Layout

```
shared/                     API-agnostic code shared by both versions
  descramble/               tile-descramble core (permutation math + canvas interface)
  strings.ts, time.ts
src/
  0.8/ComixTo/              Paperback 0.8 extension (+ 0.8 canvas backend)
  0.9/ComixDMC/             Paperback 0.9 extension (+ 0.9 canvas backend)
tools/
  version.ts               shared import-map version resolver
  0.8/bundle.ts            0.8 bundler  -> bundles/0.8/
  0.9/bundle.ts, test.ts   0.9 bundler + test harness -> bundles/0.9/
```

The two versions pin different `@paperback/types` releases via **import
aliases** (`@paperback/types-0.8`, `@paperback/types-0.9`) rather than Deno
workspaces, so both coexist in one project. No `node_modules` directory is used
(`nodeModulesDir: "none"`) — npm deps resolve from Deno's global cache.

## Shared descramble

Tiled/scrambled page images are unscrambled by shared code in
`shared/descramble/`:

- `permutation.ts` — the pure permutation math for all three schemes: `lcg`
  (Numerical Recipes ranqd1, the 0.9 scheme), `xorshift` (0.8 legacy algo 2) and
  `gf2affine` (0.8 algo 3).
- `canvas.ts` — a `CanvasBackend` interface; each platform injects its own class
  (`src/0.8/.../CanvasBackend.ts` uses `App.createPBCanvas`;
  `src/0.9/.../
  canvasBackend.ts` uses the DOM polyfill).
- `descramble.ts` — the header parsing + reassembly orchestrator both share.

Each extension exposes a **Descramble Scheme** setting (Auto / LCG / xorshift /
GF(2)-affine) so a mis-scrambled page can be tested against each scheme on
device.

## Installation

Bundles are published to GitHub Pages under the branch's path. For this unified
branch the two versions land at:

```
https://paperback.damastacoda.dev/unified/stable/0.8/
https://paperback.damastacoda.dev/unified/stable/0.9/
```

Add the URL matching your Paperback version in **Settings → Extensions → Add
Repository**.

## Development

Deno-based; no Node.js or npm required.

| Task                   | Command                               |
| ---------------------- | ------------------------------------- |
| Format                 | `deno task fmt`                       |
| Type-check everything  | `deno task check`                     |
| Type-check one version | `deno task check:0.8` / `check:0.9`   |
| Format + type-check    | `deno task conformance`               |
| Bundle both versions   | `deno task bundle`                    |
| Bundle one version     | `deno task bundle:0.8` / `bundle:0.9` |
| Run 0.9 tests          | `deno task test`                      |

Bundled output is written to `bundles/0.8/` and `bundles/0.9/`. Both bundlers
use the built-in `deno bundle` (no esbuild/third-party bundler).

## Support

Found a bug or need help? Open an issue on the
[issue tracker](https://github.com/RGFTheCoder/paperback-extensions/issues).
