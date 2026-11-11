#!/usr/bin/env bun
/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Downloads the ripgrep prebuilt binary into
 * `packages/core/dist/vendor/ripgrep/<arch>-<os>/` for a specific build target.
 *
 * Context: scripts/build.js skips this step in CI (to save time on dev-host
 * builds) AND only ever downloads for the host arch. The Bun single-binary
 * compile embeds rg via embedded-natives, so CI cross-compile jobs need a
 * targeted download for the *target* platform, not the runner.
 *
 * Pass the target explicitly to third_party/get-ripgrep. Cache the version
 * and archive name alongside the binary so target mapping changes replace
 * stale binaries (for example, the old glibc-only Linux arm64 build).
 *
 * Usage:
 *   bun run scripts/download_vendor_rg.ts --target bun-linux-x64-musl
 *   bun run scripts/download_vendor_rg.ts --target bun-darwin-arm64
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const tIdx = args.indexOf('--target');
const target = tIdx >= 0 ? args[tIdx + 1] : undefined;

type Triple = { os: 'darwin' | 'linux' | 'win32'; arch: 'x64' | 'arm64' };

function parse(t: string | undefined): Triple {
  if (!t)
    return {
      os: process.platform as Triple['os'],
      arch: process.arch as Triple['arch'],
    };
  const m = t.match(/^bun-(darwin|linux|windows)-(x64|arm64|aarch64)(-musl)?/);
  if (!m) throw new Error(`Unsupported --target: ${t}`);
  const os = m[1] === 'windows' ? 'win32' : (m[1] as 'darwin' | 'linux');
  const arch = m[2] === 'aarch64' ? 'arm64' : (m[2] as 'x64' | 'arm64');
  return { os, arch };
}

const triple = parse(target);
const archOsDir = `${triple.arch}-${triple.os}`;
const rgName = triple.os === 'win32' ? 'rg.exe' : 'rg';
const destDir = path.join(root, 'packages/core/dist/vendor/ripgrep', archOsDir);
const destPath = path.join(destDir, rgName);
const stampPath = `${destPath}.target`;
const { downloadRipGrep, getTarget, RIPGREP_VERSION } = await import(
  '../third_party/get-ripgrep/src/downloadRipGrep.js' as string
);
const options = { platform: triple.os, arch: triple.arch };
const stamp = `${RIPGREP_VERSION}:${getTarget(options)}`;

if (
  existsSync(destPath) &&
  existsSync(stampPath) &&
  readFileSync(stampPath, 'utf8') === stamp
) {
  console.log(`vendor rg for ${archOsDir} already present at ${destPath}.`);
  process.exit(0);
}

console.log(`Downloading ripgrep for ${archOsDir} into ${destDir}...`);
await downloadRipGrep(destDir, options);
if (!existsSync(destPath)) {
  throw new Error(
    `ripgrep download finished but ${destPath} is still missing.`,
  );
}
writeFileSync(stampPath, stamp);
console.log(`vendor rg ready: ${destPath}`);
