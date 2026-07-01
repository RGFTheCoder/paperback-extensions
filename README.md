# General Extensions (Paperback 0.8)

Paperback 0.8 extensions. This branch hosts the `ComixTo` extension (a native,
self-contained Comix.to source), built with Deno tooling.

## Available Extensions

- [ComixTo](https://comix.to)

## Installation

These extensions are bundled and published to GitHub Pages by the
[Bundle and Deploy](.github/workflows/bundle-deploy.yaml) workflow. To add them
to Paperback, open the app and go to **Settings → Extensions → Add Repository**,
then enter the GitHub Pages URL for a published version branch:

```
https://rgfthecoder.github.io/paperback-extensions/0.8/stable
```

(The path segment after the repository name matches the version branch that was
built, e.g. `0.8/stable`.)

## Support

Found a bug or need help? Open an issue on this repository's
[issue tracker](https://github.com/RGFTheCoder/paperback-extensions/issues).

## Development

This repository is Deno-based; no Node.js or npm is required.

| Task                 | Command                 |
| -------------------- | ----------------------- |
| Install deps         | `deno install`          |
| Format               | `deno task fmt`         |
| Format + tools check | `deno task conformance` |
| Bundle extensions    | `deno task bundle`      |

Bundled output is written to `bundles/`. The extension itself is transpiled by
esbuild (no type-check gate), matching how the upstream Paperback 0.8 toolchain
builds sources.
