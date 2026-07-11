/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toChromeManifestVersion } from './manifest-version.js';

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

describe('toChromeManifestVersion', () => {
  it('preserves a stable semantic version', () => {
    expect(toChromeManifestVersion('0.19.9')).toBe('0.19.9');
  });

  it('removes prerelease metadata that Chrome does not accept', () => {
    expect(toChromeManifestVersion('0.20.0-alpha.3')).toBe('0.20.0');
  });

  it('rejects non-numeric version components', () => {
    expect(() => toChromeManifestVersion('next')).toThrow(
      'Invalid extension package version',
    );
  });

  it('writes the package version into the generated manifest', () => {
    const outputDir = mkdtempSync(path.join(os.tmpdir(), 'qwen-chrome-ext-'));
    try {
      execFileSync(process.execPath, ['scripts/sync-extension.js'], {
        cwd: packageRoot,
        env: { ...process.env, EXTENSION_OUT_DIR: outputDir },
      });
      const packageJson = JSON.parse(
        readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
      );
      const manifest = JSON.parse(
        readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'),
      );

      expect(manifest.version).toBe(
        toChromeManifestVersion(packageJson.version),
      );
      expect(manifest.version_name).toBe(packageJson.version);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
