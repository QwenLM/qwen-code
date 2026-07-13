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
    expect(toChromeManifestVersion('0.19.9')).toBe('0.19.9.65535');
  });

  it('accepts stable build metadata', () => {
    expect(toChromeManifestVersion('0.19.9+build.7')).toBe('0.19.9.65535');
  });

  it('maps consecutive preview releases below the stable release', () => {
    const preview0 = toChromeManifestVersion('0.20.0-preview.0');
    const preview1 = toChromeManifestVersion('0.20.0-preview.1');
    const stable = toChromeManifestVersion('0.20.0');
    expect(preview0).toBe('0.20.0.60000');
    expect(preview1).toBe('0.20.0.60001');
    expect(preview0.localeCompare(preview1, undefined, { numeric: true })).toBe(
      -1,
    );
    expect(preview1.localeCompare(stable, undefined, { numeric: true })).toBe(
      -1,
    );
  });

  it('maps nightly dates monotonically below previews', () => {
    expect(toChromeManifestVersion('0.20.0-nightly.20260712.abc')).toBe(
      '0.20.0.2384',
    );
    expect(toChromeManifestVersion('0.20.0-nightly.20260713.def')).toBe(
      '0.20.0.2385',
    );
  });

  it('rejects non-numeric version components', () => {
    expect(() => toChromeManifestVersion('next')).toThrow(
      'Invalid extension package version',
    );
  });

  it('rejects out-of-range Chrome components and unsupported prereleases', () => {
    expect(() => toChromeManifestVersion('65536.0.0')).toThrow(
      'Invalid extension package version',
    );
    expect(() => toChromeManifestVersion('1.2.3-alpha.1')).toThrow(
      'Unsupported extension prerelease',
    );
    expect(() => toChromeManifestVersion('1.2.3-preview.5536')).toThrow(
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
  }, 15_000);
});
