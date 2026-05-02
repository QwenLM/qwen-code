# Standalone Installer Design

## Problem

The current one-line installer installs Qwen Code through npm. That keeps the
script small, but it still requires users to bring a working Node.js and npm
environment. This is fragile for less technical users, and it does not support
offline or controlled enterprise installs well.

Qwen Code already publishes a bundled `dist/cli.js` to GitHub Releases, but the
asset still needs a local Node.js runtime. To remove that dependency, releases
need standalone archives that bundle the Qwen CLI with a private Node.js
runtime and a small launcher.

## Goals

- Prefer standalone release archives when they are available.
- Fall back to npm when no standalone asset exists for the requested platform.
- Keep npm installation available explicitly with `--method npm`.
- Support fully offline installs with `--archive /path/to/archive`.
- Support GitHub Releases and an Aliyun OSS/CDN mirror with the same artifact
  names and checksums.
- Avoid modifying npm config, shell profiles, or user PATH permanently.
- Never start `qwen` automatically from the installer.

## Non-Goals

- Build a single native executable in this change.
- Add geolocation-based mirror selection.
- Install Node.js, NVM, or system packages on behalf of the user.
- Solve code signing or notarization in the first implementation.
- Guarantee parity for optional native modules such as `node-pty` and clipboard
  packages. The CLI already degrades when these optional modules are absent;
  a later release job can add target-specific `node_modules` if that parity is
  required.

## Artifact Format

Each release can publish these assets:

- `qwen-code-darwin-arm64.tar.gz`
- `qwen-code-darwin-x64.tar.gz`
- `qwen-code-linux-arm64.tar.gz`
- `qwen-code-linux-x64.tar.gz`
- `qwen-code-win-x64.zip`
- `SHA256SUMS`

The asset names intentionally do not include the version. This allows the
installer to use GitHub's `releases/latest/download/<asset>` URL without an API
call. Versioned installation is still supported by switching the base URL to
`releases/download/vX.Y.Z`.

Archive layout:

```text
qwen-code/
  bin/qwen
  bin/qwen.cmd
  lib/cli.js
  node/...
  package.json
  README.md
  LICENSE
  manifest.json
```

The Unix launcher executes `node/bin/node ../lib/cli.js`. The Windows launcher
executes `node/node.exe ..\lib\cli.js`. Bundling the full Node distribution is
larger than a single executable, but it is predictable and works with the
existing ESM bundle without requiring a user-managed Node.js installation.

## Installer Behavior

`--method detect` is the default:

1. If `--archive` is provided, install that local archive.
2. Detect OS and architecture.
3. Build an archive URL from the selected mirror/base URL.
4. If the archive exists, download it, verify `SHA256SUMS`, extract it into the
   user install directory, and expose `qwen`.
5. If the archive does not exist, fall back to npm.

Local `--archive` installs also require a `SHA256SUMS` file next to the archive.
This keeps offline installs deterministic without trusting an unchecked tarball.

`--method standalone` follows the same standalone path, but a missing or failed
standalone asset is fatal.

`--method npm` skips standalone logic and runs npm installation after checking
that Node.js 20+ and npm are available.

## Install Locations

Unix:

- Runtime: `$HOME/.local/lib/qwen-code`
- Command shim: `$HOME/.local/bin/qwen`

Windows:

- Runtime: `%LOCALAPPDATA%\qwen-code\qwen-code`
- Command shim: `%LOCALAPPDATA%\qwen-code\bin\qwen.cmd`

The installer may add the command directory to the current process PATH for
verification, but it does not write shell profiles or persistent environment
variables. If the command directory is not on PATH, the installer prints the
exact directory to add.

## Distribution Sources

GitHub is the canonical source:

```text
https://github.com/QwenLM/qwen-code/releases/latest/download
https://github.com/QwenLM/qwen-code/releases/download/vX.Y.Z
```

Aliyun OSS/CDN is a mirror:

```text
https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/releases/qwen-code/latest
https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/releases/qwen-code/vX.Y.Z
```

All mirrors must serve byte-identical artifacts and the same `SHA256SUMS`.
Aliyun OSS/CDN does not have GitHub's `releases/latest/download` redirect, so
release publishing must maintain both `vX.Y.Z/` and `latest/` directories.

## Safety

- Remote standalone installs require checksum verification.
- Local archive installs do not require network access, but they still require
  an adjacent `SHA256SUMS` file.
- The installer only deletes temporary extraction directories and the previous
  managed standalone install directory.
- npm fallback does not change npm prefix, npmrc, or PATH.

## Verification Strategy

- Static tests ensure the installer keeps the expected methods and does not
  reintroduce Node/NVM installation or automatic `qwen` startup.
- Packaging tests can run against a fake target and fake Node distribution.
- Shell smoke tests run installer branches with fake `curl`, `tar`, `npm`,
  `node`, and `qwen`.
- GitHub Actions should later run Linux, macOS, and Windows installer smoke
  tests with locally generated archives before enabling standalone as the
  public default.
