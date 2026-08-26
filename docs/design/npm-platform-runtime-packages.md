# Design: npm distribution with per-platform runtime packages

## Problem

`npm install -g @qwen-code/qwen-code` runs the CLI under Node, where the
OpenTUI renderer silently falls back to ink (the locked `@opentui/core` loads
its native renderer through FFI, which Node builds without `node:ffi` cannot
provide). Only the standalone archives — which bundle a pinned Bun runtime —
run OpenTUI. npm users therefore never see the new renderer, and the two
distribution channels diverge.

## Goals

- `npm install -g @qwen-code/qwen-code` yields a working OpenTUI CLI.
- No network access at install time beyond the npm registry itself (no
  postinstall downloads from GitHub Releases) so mirrors and offline
  registries keep working.
- The JS-only main package stays small; the heavy runtime stays optional so
  `--omit=optional` installs and CI installs of the JS package still succeed.

## Approach: optionalDependencies + launcher (the opencode/esbuild pattern)

The main package declares five per-platform runtime packages as
`optionalDependencies`:

```
@qwen-code/qwen-code-{darwin-arm64, darwin-x64, linux-arm64, linux-x64, win-x64}
```

Each platform package is the standalone archive payload (pinned Bun build,
native renderer libraries, bundled CLI, `lib/cli-entry.js`) with an npm
manifest whose `os`/`cpu` fields make npm install exactly one of them per
host — the same mechanism already used in this repo by `@lydell/node-pty` and
`@teddyzhu/clipboard`.

The main package's `bin` becomes `npm-bin.js`, a Node launcher that resolves
the platform package for the current OS/arch and spawns its bundled Bun on
its `lib/cli-entry.js`, setting `QWEN_CODE_LAUNCHER_PATH` exactly like the
standalone `bin/qwen` wrapper so the in-CLI updater can relaunch correctly.

### Why a launcher instead of postinstall copying

opencode's npm package copies the platform binary into the main package via
`postinstall`. We deliberately do not:

- **No postinstall** means no surprise execution during install, no
  `--ignore-scripts` breakage, and no partial state when the copy is
  interrupted — the launcher resolves whatever is on disk at run time.
- The launcher is a plain Node script, so npm's cross-platform bin shims work
  unmodified (no `.cmd` quoting games).
- The cost is one extra Node process start (~50ms) plus a lightweight waiter
  resident for the whole session (~65 MB RSS on Node 22) to mirror exit status
  and forward signals — inherent to the spawn-and-wait design (Node cannot
  execve-replace itself), accepted in preference to postinstall.

### Fallbacks

Whenever the platform package is unavailable, the launcher prints a one-line
notice and runs `cli-entry.js` under node (the legacy node/ink path, which
still ships in the tarball) instead of failing — so `qwen` keeps working on
the node path exactly as before the platform packages existed:

- **Unsupported platform** (e.g. linux-x64 musl variants, win-arm64): no
  prebuilt runtime exists; the launcher falls back to node.
- **Platform package missing** (`--omit=optional`, mirror gaps) or **damaged**
  (partial extraction): the launcher falls back to node.
- **Main package without any platform package** (e.g. CI installing the JS
  bundle for `qwen -p` usage): install succeeds because the dependency is
  optional; the bin transparently runs the node path.

## Release flow

`release.yml` gains two steps between "Build Standalone Archives" and the
main package publish:

1. `npm run package:npm-platform -- --version "$RELEASE_VERSION"` —
   repackages the five standalone archives into
   `dist/npm-platform/<platform>/` npm package directories.
2. `Publish platform runtime packages` — publishes all five with the same
   dry-run / already-published / `--tag=$NPM_TAG` guards as the existing
   `@qwen-code/audio-capture` publish step.

Platform packages publish before the main package because the main package's
`optionalDependencies` entries (stamped by `prepare:package` from the root
`package.json` version, which `release:version` has already set to the
release version) point at them.

Version alignment is automatic: `scripts/package-npm-platform-packages.js`
must run with the same `--version` as the release, and `prepare-package.js`
derives the `optionalDependencies` versions from the same root
`package.json` the release flow stamps.

## Validation performed

- `npm pack` of both packages, local install via tarballs.
- `qwen --version` through the launcher (Bun path).
- PTY smoke: mouse tracking (`CSI ?1000h/?1006h`), composer, DEC 2026 sync —
  all present (OpenTUI active) through the npm-installed bin.
- Platform package removed: launcher exits 1 with the node fallback command,
  which was itself verified to run.
- yamllint clean on `release.yml`; eslint clean on the touched scripts.

## Alternatives considered

- **postinstall downloading the standalone tarball from GitHub Releases**:
  adds a non-registry network dependency at install time (breaks offline
  mirrors), and the downloaded payload is outside npm's integrity model.
- **Shipping opentui-assets in the JS tarball so node users get them**: dead
  weight (~22MB) for a renderer node cannot load in the first place; the
  platform packages carry them instead.
- **Requiring Bun as a peerDependency**: pushes runtime setup onto users and
  CI; the platform-package approach is what users of esbuild/swc/opencode
  already expect from npm-native tooling.
