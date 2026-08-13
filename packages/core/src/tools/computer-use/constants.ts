/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Computer Use is backed by Qwen CUA Driver (the vendored Rust implementation
 * under `packages/cua-driver`) — a background, no-focus-stealing native
 * automation driver that speaks MCP over stdio (`qwen-cua-driver mcp`).
 *
 * Unlike the previous open-computer-use backend, cua-driver is NOT on npm.
 * It ships as per-platform release bundles (the macOS app is Developer-ID
 * signed + Apple-notarized) under tag `cua-driver-rs-v<version>`. We download
 * the pinned asset once into `~/.qwen/computer-use/`, preferring a
 * qwen-code-owned OSS mirror (reliable in CN where GitHub release downloads
 * are slow/blocked) and falling back to GitHub.
 *
 * Source: https://github.com/QwenLM/qwen-code/tree/main/packages/cua-driver
 * License: MIT
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
 * against the new binary, publish through `cd-cua-driver.yml` (which mirrors
 * the consumer assets to OSS), then smoke-test the published asset on macOS.
 */
export const CUA_DRIVER_VERSION = '0.17.0';

/**
 * qwen-code-owned OSS mirror base (primary download source — reliable in CN
 * where GitHub release downloads are slow/blocked). Assets live under
 * `<base>/cua-driver-rs/v<version>/<asset>`. The Qwen CUA release workflow
 * mirrors the consumer assets after publishing the matching GitHub Release.
 * Until a version is mirrored there, the Qwen GitHub fallback serves it
 * transparently.
 *
 * Hosted on the shared `qwen-code-assets` bucket (same one the CLI's own
 * release/installation assets use), under a `computer-use` namespace.
 */
export const OSS_MIRROR_BASE =
  'https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/computer-use';

/** GitHub release download base for the pinned tag (fallback source). */
export const GITHUB_RELEASE_BASE =
  'https://github.com/QwenLM/qwen-code/releases/download';

export interface AssetTarget {
  /** Release asset filename. */
  asset: string;
  /** Directory the tarball/zip extracts into. */
  extractDir: string;
  /** Path to the spawnable driver binary, relative to the extract dir. */
  binaryRelPath: string;
  /** Whether this asset bundles `QwenCuaDriver.app` (macOS TCC onboarding). */
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
      // Spawn the binary INSIDE QwenCuaDriver.app, not the bare one beside it.
      // qwen-cua-driver only triggers its TCC auto-relaunch (`open -a QwenCuaDriver
      // serve`, which attributes Accessibility/Screen-Recording grants to
      // com.qwencode.cua-driver rather than the launching terminal) when its
      // running image resolves into `/QwenCuaDriver.app/Contents/MacOS/`.
      // Pointing at the bare binary makes TCC attribute to the parent terminal
      // (e.g. iTerm) — wrong identity, per-terminal, oversized privacy.
      binaryRelPath: 'QwenCuaDriver.app/Contents/MacOS/qwen-cua-driver',
      hasApp: true,
    };
  }
  if (platform === 'linux') {
    if (arch !== 'x64' && arch !== 'arm64') {
      throw new Error(
        `Computer Use: unsupported Linux arch '${arch}' (x64 and arm64 only).`,
      );
    }
    const slug = arch === 'arm64' ? 'linux-arm64' : 'linux-x86_64';
    // Linux's binary tarball expands its runtime payload at the archive root.
    return {
      asset: `cua-driver-rs-${v}-${slug}-binary.tar.gz`,
      extractDir: '.',
      binaryRelPath: 'qwen-cua-driver',
      hasApp: false,
    };
  }
  if (platform === 'win32') {
    if (arch !== 'x64' && arch !== 'arm64') {
      throw new Error(
        `Computer Use: unsupported Windows arch '${arch}' (x64 and arm64 only).`,
      );
    }
    // Windows uses the full wrapper zip because qwen-cua-driver requires its
    // UIA helper and native runtime sidecars beside the main executable.
    const slug = arch === 'arm64' ? 'windows-arm64' : 'windows-x86_64';
    const extractDir = `cua-driver-rs-${v}-${slug}`;
    return {
      asset: `${extractDir}.zip`,
      extractDir,
      binaryRelPath: 'qwen-cua-driver.exe',
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

/** Env var name for overriding the screenshot longest-edge cap. */
export const MAX_IMAGE_DIMENSION_ENV = 'QWEN_COMPUTER_USE_MAX_IMAGE_DIMENSION';

/**
 * Coerce a raw value into a valid `max_image_dimension` override, or
 * `undefined` if it isn't one. A valid override is a non-negative integer
 * (`0` = no resizing / full resolution). Anything else — negative (incl. the
 * `-1` "use default" sentinel), fractional, NaN/Infinity, or empty — yields
 * `undefined`, meaning "use cua-driver's built-in default (1568)".
 */
function coerceImageDimension(
  value: string | number | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n < 0) return undefined;
  return n;
}

/**
 * Resolve the screenshot longest-edge cap (px) to apply to cua-driver via the
 * `set_config` `max_image_dimension` knob. Precedence:
 *
 *   1. `QWEN_COMPUTER_USE_MAX_IMAGE_DIMENSION` env var (if a valid override)
 *   2. the `tools.computerUse.maxImageDimension` setting
 *   3. `undefined` → reset cua-driver to its built-in default (1568)
 *
 * A valid override is a non-negative integer (`0` disables resizing). Negative
 * values (incl. the `-1` setting default), non-integers, and blanks mean "no
 * override at this layer" — an invalid env value falls through to the setting
 * rather than forcing a default.
 */
export function resolveMaxImageDimension(
  settingValue?: number,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const fromEnv = coerceImageDimension(env[MAX_IMAGE_DIMENSION_ENV]);
  if (fromEnv !== undefined) return fromEnv;
  return coerceImageDimension(settingValue);
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
