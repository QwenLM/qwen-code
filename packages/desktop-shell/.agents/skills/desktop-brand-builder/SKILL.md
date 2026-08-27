---
name: desktop-brand-builder
description: Generate a branded Qwen Code desktop package from the Tauri desktop shell using a minimal brandId and logo. Use when the user wants a custom, white-label, or rebranded desktop client, installer, DMG/EXE/AppImage/deb, or one-click brand build on top of packages/desktop-shell.
---

# Desktop Brand Builder (Tauri shell)

## Goal

Create a branded desktop package from `packages/desktop-shell` with the least
user input possible. The user should usually provide only:

```text
brandId: acme-ai
logo: /absolute/path/to/logo.png
website: https://acme.ai
```

`website` is optional. Do not ask for app name, app id, artifact name,
copyright, or updater endpoints unless the user explicitly asks to override
them.

This skill replaces the Electron-era brand builder that lived in the removed
`packages/desktop`. The Tauri shell is the only desktop implementation now;
branding hooks are `src-tauri/tauri.conf.json`, `src-tauri/icons/`, and the
`bootstrap/` startup UI.

## Input Rules

Required fields:

- `brandId`: must match `^[a-z][a-z0-9-]*$`
- `logo`: local file path; must exist; `.png` recommended (square, >= 1024px)

Optional overrides:

- `website`
- `appName`
- `appId` (Tauri bundle identifier)
- `artifactPrefix`
- `updaterEndpoints` (JSON array; empty array disables in-app updates)
- `target`: `mac`, `win`, `linux`, or `all`

If required input is missing, ask once:

```text
请提供：
brandId: 例如 acme-ai，只能小写字母、数字、短横线
logo: 本地 logo 文件路径（建议 1024x1024 PNG）
website: 可选
```

Once the required fields are present, proceed without a confirmation step.

## Derived Defaults

Infer missing values deterministically:

- `appName`: title-case the hyphen-separated `brandId`; `acme-ai` becomes
  `Acme AI`
- `artifactPrefix`: title-case the hyphen-separated `brandId` and join with
  hyphens; `acme-ai` becomes `Acme-AI`
- `appId`: if `website` has a valid host, reverse the host labels and append
  `.desktop`; `https://acme.ai` becomes `ai.acme.desktop`
- fallback `appId`: `app.<brandId>.desktop`
- `updaterEndpoints`: empty by default. A branded build must never poll the
  official Qwen Code updater feed, and the official feed must never update a
  branded build. Only set endpoints when the user supplies their own feed.

## Workflow

Work in an isolated build clone so the working repository stays clean:

```bash
BUILD_ROOT="$PWD/brand-builds/<brandId>-<timestamp>"
mkdir -p "$BUILD_ROOT"
git clone --branch main --single-branch \
  https://github.com/QwenLM/qwen-code.git \
  "$BUILD_ROOT/qwen-code"
cd "$BUILD_ROOT/qwen-code"
git checkout -B brand-<brandId> origin/main
```

If the clone or checkout fails, stop and report the failure. Do not continue
as if `brand-<brandId>` was created.

Create a temporary `brand.json` in the build directory:

```json
{
  "brandId": "acme-ai",
  "logo": "/absolute/path/to/logo.png",
  "website": "https://acme.ai",
  "appName": "Acme AI",
  "appId": "ai.acme.desktop",
  "artifactPrefix": "Acme-AI",
  "updaterEndpoints": []
}
```

Install dependencies. The brand script itself only needs desktop-shell's
own `node_modules`, but `npm run build:runtime` shells out to the repo
root (which uses `cross-env` and other root devDependencies), so the
root install is also required before packaging:

```bash
# Root dependencies (needed by build:runtime → cross-env, esbuild, etc.)
npm install

# Desktop-shell dependencies
cd packages/desktop-shell
npm install --workspaces=false
cd ../..
```

Then run this skill's bundled brand creation script with plain Node (the
script has no dependencies beyond Node >= 18):

```bash
node packages/desktop-shell/.agents/skills/desktop-brand-builder/scripts/brand-create.mjs \
  --shell-root /absolute/path/to/qwen-code/packages/desktop-shell \
  --config /absolute/path/to/brand.json
```

The agent should not hand-edit `tauri.conf.json`, icon files, or bootstrap
brand strings when this bundled script is available. The bundled script is the
source of truth for patching config and generating resources.

What the script does:

1. Patches `src-tauri/tauri.conf.json`: `productName`, `identifier`,
   `bundle.shortDescription`, and `plugins.updater.endpoints`. When
   `updaterEndpoints` is empty it also clears `bundle.createUpdaterArtifacts`
   and blanks the official `plugins.updater.pubkey` (set to empty string
   rather than deleted, because the updater plugin requires the field);
   a brand supplying its own feed must supply its own pubkey.
2. Regenerates the full icon set from the logo via
   `npx --yes @tauri-apps/cli icon <logo>` (falls back to a warning if the
   CLI cannot run; in that case copy the logo over `src-tauri/icons/icon.png`
   manually and tell the user the remaining sizes are stale).
3. Patches the bootstrap UI: page title, brand heading, startup strings in
   `bootstrap/index.html` and `bootstrap/bootstrap.js`, and replaces
   `bootstrap/qwen-code-logo.svg` usage with the brand logo.

Package with the current host target unless the user requested a target:

```bash
cd packages/desktop-shell
npm run build:runtime --workspaces=false
npx tauri build            # current platform
```

**Cross-compile:** `build:runtime` bundles the Node runtime for the platform
indicated by `QWEN_DESKTOP_TARGET` (defaults to the host). When targeting a
different platform you **must** re-run `build:runtime` with the env var set
before each `tauri build --target`, otherwise the packaged artifact contains
a wrong-arch Node binary and fails at launch with an exec format error:

```bash
# Cross-compile: set QWEN_DESKTOP_TARGET and re-run build:runtime per target
QWEN_DESKTOP_TARGET=aarch64-apple-darwin npm run build:runtime --workspaces=false
npx tauri build --target aarch64-apple-darwin   # explicit macOS arm64
```

For `target: all`, iterate `build:runtime` → `tauri build` per target; run
only targets supported by the current machine or CI environment. Do not
claim cross-platform artifacts were produced unless the files exist.
Artifacts land under `packages/desktop-shell/src-tauri/target/release/bundle/`
for the host target, or `src-tauri/target/<triple>/release/bundle/` when
`--target <triple>` is used.

## Signing and Updates

Branded builds are unsigned by default. The upstream release pipeline's
signing secrets (Apple, Windows) and updater private key belong to the
official Qwen Code releases only. For a brand that needs signed releases or
in-app updates, set up separate credentials and a separate updater feed; do
not reuse the upstream ones.

## Validation

After packaging:

1. Confirm the expected artifact exists under
   `packages/desktop-shell/src-tauri/target/release/bundle/`
   (or `src-tauri/target/<triple>/release/bundle/` for cross-compile targets)
   (`dmg/`, `nsis/`, `appimage/`, or `deb/`).
2. Compute `sha256sum` or `shasum -a 256` for each artifact.
3. On macOS, run `hdiutil verify` for generated DMG files.
4. Report the artifact path, SHA-256, app name, app id, and build directory.

## Failure Handling

- Invalid `brandId`: show the regex and ask for a corrected value.
- Missing `logo`: ask for a valid local path.
- Missing bundled script: report that
  `packages/desktop-shell/.agents/skills/desktop-brand-builder/scripts/brand-create.mjs`
  is missing, and include the expected command.
- Already-branded shell-root: the script refuses to run when
  `productName` is no longer the default (`Qwen Code Desktop`). Start from
  a fresh clone — do not re-run the script in an already-patched tree.
- Build failure: preserve the build directory, return the last useful error
  lines, and include the full log path or command that produced the failure.

Do not delete the build directory on failure. **Never re-run `brand-create`
in the same clone** — the script is single-use. The "preserve the build
directory" guidance is for post-mortem debugging, not for retrying the
brand step. If the brand config was wrong, discard the clone and start
fresh.
