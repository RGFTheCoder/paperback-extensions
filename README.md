# General Extensions

Paperback extensions for websites with unique, non-generic themes.

## Available Extensions

- [ComixTo (DMC)](https://comix.to)

## Installation

These extensions are bundled and published to GitHub Pages by the
[Bundle and Deploy](.github/workflows/bundle-deploy.yaml) workflow. To add them
to Paperback, open the app and go to **Settings → Extensions → Add Repository**,
then enter the GitHub Pages URL for a published version branch:

```
https://rgfthecoder.github.io/paperback-extensions/0.9/stable
```

(The path segment after the repository name matches the version branch that was
built, e.g. `0.9/stable`.)

## Support

Found a bug or need help? Open an issue on this repository's
[issue tracker](https://github.com/RGFTheCoder/paperback-extensions/issues).

## Development

This repository is Deno-based; no Node.js or npm is required.

| Task               | Command                 |
| ------------------ | ----------------------- |
| Install deps       | `deno install`          |
| Format             | `deno task fmt`         |
| Format + typecheck | `deno task conformance` |
| Bundle extensions  | `deno task bundle`      |
| Run tests          | `deno task test`        |

Bundled output is written to `bundles/`.
