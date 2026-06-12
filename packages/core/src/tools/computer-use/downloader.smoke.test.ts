/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureInstalled } from './downloader.js';
import { binaryPath } from './constants.js';

/**
 * REAL network + REAL OS extraction smoke. Off by default — only the CI
 * "Computer Use download smoke" job sets CUA_DOWNLOAD_SMOKE=1, on each of
 * windows-latest / ubuntu-latest / macos-latest. It exercises the actual
 * pipeline the unit tests stub out:
 *
 *   fetch checksums.txt + asset (OSS mirror → GitHub fallback)
 *     → sha256 verify
 *     → extract (.tar.gz via `tar`; .zip via bsdtar/PowerShell on Windows)
 *     → resolve the per-OS binary path
 *
 * This is what actually verifies the Linux (bare-binary tarball, root binary)
 * and Windows (.zip, wrapper dir, cua-driver.exe) paths that cannot be run on
 * the macOS dev box. Downloads ~20MB, so the timeout is generous.
 *
 * Because the file matches `*.test.ts`, the normal `test:ci` run collects it
 * too — but `describe.runIf` skips the whole block unless the env flag is set,
 * so the unit run never hits the network.
 */
const enabled = process.env['CUA_DOWNLOAD_SMOKE'] === '1';

describe.runIf(enabled)(
  'cua-driver download smoke (real network + OS extraction)',
  () => {
    it('downloads, verifies, and extracts the pinned binary for this OS', async () => {
      const home = mkdtempSync(join(tmpdir(), 'qwen-cu-smoke-'));
      try {
        const bin = await ensureInstalled({ home });
        expect(bin).toBe(binaryPath(home));
        expect(existsSync(bin)).toBe(true);
        expect(statSync(bin).size).toBeGreaterThan(0);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }, 180_000);
  },
);
