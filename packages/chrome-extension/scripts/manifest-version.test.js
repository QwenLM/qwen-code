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
const repoRoot = path.resolve(packageRoot, '../..');

function resolveNightlyBuildNumber(packageVersion) {
  if (!packageVersion.includes('-nightly.')) return undefined;
  const configured = process.env.QWEN_CHROME_EXTENSION_BUILD_NUMBER?.trim();
  if (configured) return Number(configured);
  return Number(
    execFileSync('git', ['rev-list', '--count', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim(),
  );
}

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

  it('uses an explicit monotonic build number for nightly releases', () => {
    const nightly1 = toChromeManifestVersion(
      '0.20.0-nightly.20260712.abc',
      1234,
    );
    const nightly2 = toChromeManifestVersion(
      '0.20.0-nightly.20260712.def',
      1235,
    );
    const preview = toChromeManifestVersion('0.20.0-preview.0');
    expect(nightly1).toBe('0.20.0.1234');
    expect(nightly2).toBe('0.20.0.1235');
    expect(nightly1.localeCompare(nightly2, undefined, { numeric: true })).toBe(
      -1,
    );
    expect(nightly2.localeCompare(preview, undefined, { numeric: true })).toBe(
      -1,
    );
  });

  it('rejects nightly releases without a valid monotonic build number', () => {
    expect(() =>
      toChromeManifestVersion('0.20.0-nightly.20260712.abc'),
    ).toThrow('Nightly extension build number is required');
    expect(() =>
      toChromeManifestVersion('0.20.0-nightly.20260712.abc', 60000),
    ).toThrow('Invalid nightly extension build number');
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
        toChromeManifestVersion(
          packageJson.version,
          resolveNightlyBuildNumber(packageJson.version),
        ),
      );
      expect(manifest.version_name).toBe(packageJson.version);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  }, 15_000);
});
