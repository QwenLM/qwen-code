/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Computer Use is backed by `cua-driver` (the Rust implementation,
 * `cua-driver-rs`) from trycua/cua — a background, no-focus-stealing
 * native automation driver that speaks MCP over stdio (`cua-driver mcp`).
 *
 * Unlike the previous open-computer-use backend, cua-driver is NOT on npm.
 * It ships as per-platform, Developer-ID-signed + Apple-notarized binaries
 * attached to GitHub releases (tag `cua-driver-rs-v<version>`). We download
 * the pinned asset once into `~/.qwen/computer-use/`, preferring a
 * qwen-code-owned OSS mirror (reliable in CN where GitHub release downloads
 * are slow/blocked) and falling back to GitHub.
 *
 * Source: https://github.com/trycua/cua/tree/main/libs/cua-driver
 * License: MIT (the driver pulls no AGPL deps — AGPL only affects the
 * separate `cua-agent[omni]` layer, which we do not consume).
 */

import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * The exact `cua-driver-rs` release this build of qwen-code is pinned to.
 * Hardcoded `schemas.ts` is generated against this version.
 *
 * Exact pin (NOT a range) is deliberate: cua-driver is pre-1.0 and ships
 * multiple releases per day, some schema-affecting. Locking the version
 * means users get the exact surface we tested; a new upstream release
 * can't silently drift our hardcoded schemas or break the download.
 *
 * To bump: update this, re-run `scripts/sync-computer-use-schemas.ts`
 * against the new binary, sync the new assets to OSS via
 * `scripts/sync-cua-driver-to-oss.ts`, then smoke-test on macOS.
 */
export const CUA_DRIVER_VERSION = '0.5.2';

/**
 * qwen-code-owned OSS mirror base (primary download source — reliable in CN
 * where GitHub release downloads are slow/blocked). Assets live under
 * `<base>/cua-driver-rs/v<version>/<asset>`, mirrored from the upstream
 * trycua/cua release by the "Sync cua-driver to Aliyun OSS" workflow
 * (.github/workflows/sync-cua-driver-to-oss.yml), which auto-triggers on pushes
 * to main that touch this file — a CUA_DRIVER_VERSION bump auto-mirrors the new
 * release (a checksums.txt guard no-ops when already mirrored); manual
 * workflow_dispatch covers first-time / forced re-mirror. Until a version is
 * mirrored there, the GitHub fallback (GITHUB_RELEASE_BASE) serves it
 * transparently.
 *
 * Hosted on the shared `qwen-code-assets` bucket (same one the CLI's own
 * release/installation assets use), under a `computer-use` namespace.
 */
export const OSS_MIRROR_BASE =
  'https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/computer-use';

/** GitHub release download base for the pinned tag (fallback source). */
export const GITHUB_RELEASE_BASE =
  'https://github.com/trycua/cua/releases/download';

export interface AssetTarget {
  /** Release asset filename. */
  asset: string;
  /** Directory the tarball/zip extracts into. */
  extractDir: string;
  /** Path to the spawnable driver binary, relative to the extract dir. */
  binaryRelPath: string;
  /** Whether this asset bundles `CuaDriver.app` (macOS TCC onboarding). */
  hasApp: boolean;
}

/**
 * Map a Node platform/arch to the cua-driver release asset.
 * Throws for unsupported targets so callers fail loudly rather than
 * spawning a missing binary.
 */
export function resolveAssetTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  version: string = CUA_DRIVER_VERSION,
): AssetTarget {
  const v = version;
  if (platform === 'darwin') {
    const slug = arch === 'arm64' ? 'darwin-arm64' : 'darwin-x86_64';
    const extractDir = `cua-driver-rs-${v}-${slug}`;
    return {
      asset: `${extractDir}.tar.gz`,
      extractDir,
      // Spawn the binary INSIDE CuaDriver.app, not the bare one beside it.
      // cua-driver only triggers its TCC auto-relaunch (`open -a CuaDriver
      // serve`, which attributes Accessibility/Screen-Recording grants to
      // com.trycua.driver rather than the launching terminal) when its
      // running image resolves into `/CuaDriver.app/Contents/MacOS/`
      // (see bundle.rs `is_executable_inside_cuadriver_app`). Pointing at
      // the bare `cua-driver` made TCC attribute to the parent terminal
      // (e.g. iTerm) — wrong identity, per-terminal, oversized privacy.
      binaryRelPath: 'CuaDriver.app/Contents/MacOS/cua-driver',
      hasApp: true,
    };
  }
  if (platform === 'linux') {
    if (arch !== 'x64') {
      throw new Error(
        `Computer Use: unsupported Linux arch '${arch}' (only x64).`,
      );
    }
    // Linux ships a BARE-BINARY tarball whose single `cua-driver` file sits at
    // the archive ROOT — no bundle, no wrapper dir. Upstream _install-rust.sh
    // picks `darwin-universal.tar.gz` (a dir tarball carrying CuaDriver.app)
    // for macOS but `${label}-binary.tar.gz` for every other target, which
    // expands to a lone `cua-driver`. So there is NO extractDir layer here:
    // extractDir '.' keeps binaryPath at <versionDir>/cua-driver.
    return {
      asset: `cua-driver-rs-${v}-linux-x86_64-binary.tar.gz`,
      extractDir: '.',
      binaryRelPath: 'cua-driver',
      hasApp: false,
    };
  }
  if (platform === 'win32') {
    // Windows uses the NON-binary `.zip` (verified against upstream
    // install.ps1: `$zipName = "cua-driver-rs-$version-$archLabel.zip"`), which
    // expands to `cua-driver-rs-<v>-<slug>/cua-driver.exe (+ LICENSE)` — a
    // wrapper dir, UNLIKE Linux. This asset mapping is correct; the only gap is
    // zip extraction in downloader.ts (node `tar` reads .tar.gz only).
    const slug = arch === 'arm64' ? 'windows-arm64' : 'windows-x86_64';
    const extractDir = `cua-driver-rs-${v}-${slug}`;
    return {
      asset: `${extractDir}.zip`,
      extractDir,
      binaryRelPath: 'cua-driver.exe',
      hasApp: false,
    };
  }
  throw new Error(`Computer Use: unsupported platform '${platform}'.`);
}

/**
 * Ordered list of full download URLs for an asset: env override (if set),
 * then OSS mirror, then GitHub. The downloader tries each in order until
 * one succeeds.
 *
 * `QWEN_COMPUTER_USE_DOWNLOAD_HOST` lets enterprises / power users point at
 * an internal mirror laid out like OSS (`<host>/cua-driver-rs/v<ver>/<asset>`).
 */
export function resolveAssetUrls(
  asset: string,
  env: NodeJS.ProcessEnv = process.env,
  version: string = CUA_DRIVER_VERSION,
): string[] {
  const urls: string[] = [];
  const override = env['QWEN_COMPUTER_USE_DOWNLOAD_HOST'];
  if (override) {
    urls.push(`${trimSlash(override)}/cua-driver-rs/v${version}/${asset}`);
  }
  urls.push(`${OSS_MIRROR_BASE}/cua-driver-rs/v${version}/${asset}`);
  urls.push(`${GITHUB_RELEASE_BASE}/cua-driver-rs-v${version}/${asset}`);
  return urls;
}

/** URL for the release `checksums.txt` (same source order as assets). */
export function resolveChecksumUrls(
  env: NodeJS.ProcessEnv = process.env,
  version: string = CUA_DRIVER_VERSION,
): string[] {
  return resolveAssetUrls('checksums.txt', env, version);
}

/** Install root for all Computer Use artifacts. Footprint stays here. */
export function computerUseRoot(home: string = homedir()): string {
  return join(home, '.qwen', 'computer-use');
}

/** Directory a given version's assets extract into. */
export function versionDir(
  home: string = homedir(),
  version: string = CUA_DRIVER_VERSION,
): string {
  return join(computerUseRoot(home), `cua-driver-rs-${version}`);
}

/**
 * Absolute path to the spawnable `cua-driver` binary for this host.
 * `bootstrap` ensures it has been downloaded before `client` spawns it.
 */
export function binaryPath(
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  version: string = CUA_DRIVER_VERSION,
): string {
  const target = resolveAssetTarget(platform, arch, version);
  return join(
    versionDir(home, version),
    target.extractDir,
    target.binaryRelPath,
  );
}

/**
 * Stable identity recorded in install-state for first-use approval.
 * Bumping the pinned version produces a new key, forcing re-approval +
 * re-download of the new binary.
 */
export function approvalKey(version: string = CUA_DRIVER_VERSION): string {
  return `cua-driver-rs@${version}`;
}

function trimSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}
