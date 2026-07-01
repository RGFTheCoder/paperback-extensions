# Summary

<!-- What changed and why. 1-3 sentences. -->

## Checklist

### Making changes

- [ ] Follows the repository's coding conventions and passes the checks below.

#### For updates to existing extensions

- [ ] Bumped the `version` value in each modified extension's `SourceInfo`.

#### For new extensions

- [ ] The source folder follows the `src/<Name>/<Name>.ts` entry convention.

### Testing changes

- [ ] `deno task conformance` passes.
- [ ] `deno task bundle` succeeds.
- [ ] Bundled the extension and verified it works in the Paperback app.

### Committing changes

- [ ] Commit messages follow the existing convention (`type(Scope): summary`,
      e.g. `fix(EXTENSION_NAME): ...`).

### AI assistance

Pick one:

- [ ] This PR contains no AI-assisted changes.
- [ ] This PR is AI-assisted. I manually reviewed every change and added an
      `Assisted-by: AGENT_NAME:MODEL_VERSION` trailer to each AI-assisted
      commit.
