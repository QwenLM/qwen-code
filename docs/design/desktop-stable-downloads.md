# Current Desktop downloads

[中文](./desktop-stable-downloads.zh-CN.md)

## Problem

The README sends new users to `desktop-latest`. That release serves updater manifests and preserves the one-time Electron-to-Tauri bridge installers; its assets are not the current fresh-install selection. The versioned Desktop releases and updater feed are current.

## Decision

Publish a separate `desktop-stable` release containing only the current stable installers for macOS, Windows, and Linux. Both README links point there. Maintain it in the existing Desktop publication job after the stable feed advances, behind the same draft, prerelease, dry-run, and downgrade guards. Leave GitHub's repository-wide Latest selection unchanged.

Copy installers from the already-published versioned release's local build artifacts. Compare their SHA-256 digests and sizes with GitHub's versioned asset metadata before writing; verify uploaded replacements before removing old installer names. Repeated publication repairs an incomplete upload and skips matching files. The first alias is a draft until its installers are verified. GitHub asset replacement is not atomic, so a failed update can temporarily leave a mixture of installer versions until rerun.

Update only the `desktop-latest` body to explain its updater and legacy bridge roles and link to current downloads. Its existing asset publication logic is unchanged. In the existing OSS stable-feed verification, check the advertised alias against the local installers and GitHub digests before promoting the OSS latest manifest. No new workflow or credential is required.

## Rollout

Initialize the alias before making the README links public, using the current stable versioned release. The normal already-published shortcut deliberately skips rebuilding an existing release, so simply dispatching that same version will not bootstrap the alias. A maintainer with release-write access can run the helper from this change:

```sh
version=0.25.0 # Use the version in desktop-latest.json at rollout time.
gh release download "desktop-v$version" --repo QwenLM/qwen-code --dir release-assets
node .github/scripts/update-desktop-downloads.mjs --assets release-assets --version "$version" --repository QwenLM/qwen-code
node .github/scripts/update-desktop-downloads.mjs --assets release-assets --version "$version" --repository QwenLM/qwen-code --verify
```

Run bootstrap without a concurrent Desktop publication. The helper rejects a version that does not match the stable feed. Subsequent stable releases maintain the alias automatically. If a publication fails, rerun it with the existing `clobber` option, or rerun the helper against the published artifacts when only the alias needs repair.

## Acceptance and scope

- Both README download links lead to current installers, including correct bytes for the generic macOS DMG names.
- Draft, prerelease, dry-run, and older-version publication do not replace stable downloads.
- Legacy Electron bridge assets stay intact; only their release description changes.
- Missing, stale, or extra alias assets block OSS latest promotion.
- The `qwen.ai` website is maintained separately and is outside this change.

## Verification status

The existing defect was reproduced through the public GitHub UI and release feed. Local tests exercise publication and verification with GitHub mutations intercepted. Actual post-publication download verification requires a maintainer to initialize the upstream alias; no upstream release is mutated during development.
