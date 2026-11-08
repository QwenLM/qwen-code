/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveNightlyBuildNumber,
  toChromeManifestVersion,
} from './manifest-version.js';

const { mockExecFileSync, originalExecFileSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  originalExecFileSync: { current: null },
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  originalExecFileSync.current = actual.execFileSync;
  mockExecFileSync.mockImplementation((...args) =>
    actual.execFileSync(...args),
  );
  return { ...actual, execFileSync: mockExecFileSync };
});

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const dateDerivedBuildNumber = (digits) => {
  const year = Math.floor(digits / 10000);
  const month = Math.floor((digits % 10000) / 100);
  const day = digits % 100;
  return (
    Math.floor(Date.UTC(year, month - 1, day) / 86_400_000) -
    Math.floor(Date.UTC(2000, 0, 1) / 86_400_000)
  );
};

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

  it('rejects nightly releases with an impossible date', () => {
    expect(() =>
      toChromeManifestVersion('0.20.0-nightly.20261332.abc', 100),
    ).toThrow('Invalid extension package version');
    expect(() =>
      toChromeManifestVersion('0.20.0-nightly.20260230.abc', 100),
    ).toThrow('Invalid extension package version');
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
        env: {
          ...process.env,
          EXTENSION_OUT_DIR: outputDir,
          // Pin the build number so the assertion is deterministic and does not
          // depend on git history (a shallow clone has no rev-list count).
          QWEN_CHROME_EXTENSION_BUILD_NUMBER: '1',
        },
      });
      const packageJson = JSON.parse(
        readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
      );
      const manifest = JSON.parse(
        readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'),
      );

      expect(manifest.version).toBe(
        toChromeManifestVersion(packageJson.version, 1),
      );
      expect(manifest.version_name).toBe(packageJson.version);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  }, 15_000);

  it('writes a nightly version through syncManifestVersion', async () => {
    const sourceDir = mkdtempSync(path.join(os.tmpdir(), 'qwen-ext-src-'));
    const outputDir = mkdtempSync(path.join(os.tmpdir(), 'qwen-ext-out-'));
    const savedOutDir = process.env.EXTENSION_OUT_DIR;
    const savedBuild = process.env.QWEN_CHROME_EXTENSION_BUILD_NUMBER;
    try {
      writeFileSync(
        path.join(sourceDir, 'package.json'),
        JSON.stringify({ version: '0.21.2-nightly.20260712.abc' }),
      );
      writeFileSync(
        path.join(outputDir, 'manifest.json'),
        JSON.stringify({ manifest_version: 3, name: 'test', version: '0.0.0' }),
      );
      process.env.EXTENSION_OUT_DIR = outputDir;
      process.env.QWEN_CHROME_EXTENSION_BUILD_NUMBER = '42';
      const { syncManifestVersion } = await import('./sync-extension.js');
      await syncManifestVersion(sourceDir);
      const manifest = JSON.parse(
        readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'),
      );
      expect(manifest.version).toBe('0.21.2.42');
      expect(manifest.version_name).toBe('0.21.2-nightly.20260712.abc');
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
      rmSync(outputDir, { recursive: true, force: true });
      if (savedOutDir === undefined) delete process.env.EXTENSION_OUT_DIR;
      else process.env.EXTENSION_OUT_DIR = savedOutDir;
      if (savedBuild === undefined)
        delete process.env.QWEN_CHROME_EXTENSION_BUILD_NUMBER;
      else process.env.QWEN_CHROME_EXTENSION_BUILD_NUMBER = savedBuild;
    }
  }, 15_000);
});

describe('resolveNightlyBuildNumber', () => {
  const ENV_KEY = 'QWEN_CHROME_EXTENSION_BUILD_NUMBER';
  let savedEnv;
  let warnSpy;

  beforeEach(() => {
    savedEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockExecFileSync.mockClear();
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
    warnSpy.mockRestore();
    mockExecFileSync.mockImplementation((...args) =>
      originalExecFileSync.current(...args),
    );
  });

  it('returns undefined for non-nightly versions', () => {
    expect(resolveNightlyBuildNumber('0.21.2')).toBeUndefined();
    expect(resolveNightlyBuildNumber('1.0.0-preview.1')).toBeUndefined();
  });

  it('uses the environment variable override', () => {
    process.env[ENV_KEY] = '42';
    expect(resolveNightlyBuildNumber('0.21.2-nightly.20260712.abc')).toBe(42);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('rejects a malformed environment variable override by name', () => {
    process.env[ENV_KEY] = 'abc';
    expect(() =>
      resolveNightlyBuildNumber('0.21.2-nightly.20260712.abc'),
    ).toThrow(`Invalid ${ENV_KEY} "abc"`);
  });

  it('rejects an environment variable override in the preview range', () => {
    process.env[ENV_KEY] = '60000';
    expect(() =>
      resolveNightlyBuildNumber('0.21.2-nightly.20260712.abc'),
    ).toThrow(
      `Invalid ${ENV_KEY} "60000": expected a positive integer less than 60000.`,
    );
  });

  it('falls back to the nightly date on a shallow clone', () => {
    mockExecFileSync.mockReturnValue('true\n');
    expect(resolveNightlyBuildNumber('0.21.2-nightly.20260712.abc')).toBe(
      dateDerivedBuildNumber(20260712),
    );
    expect(warnSpy).toHaveBeenCalled();
  });

  it('derives the build number from git history', () => {
    mockExecFileSync.mockImplementation((_cmd, args) => {
      if (args.includes('--is-shallow-repository')) return 'false\n';
      if (args.includes('--count')) return '1234\n';
      throw new Error(`unexpected: ${args}`);
    });
    expect(resolveNightlyBuildNumber('0.21.2-nightly.20260712.abc')).toBe(1234);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('falls back to the nightly date when git rev-list fails', () => {
    mockExecFileSync.mockImplementation((_cmd, args) => {
      if (args.includes('--is-shallow-repository')) return 'false\n';
      throw new Error('git failed');
    });
    expect(resolveNightlyBuildNumber('0.21.2-nightly.20260712.abc')).toBe(
      dateDerivedBuildNumber(20260712),
    );
    expect(warnSpy).toHaveBeenCalled();
  });

  it('falls back to the nightly date when git is unavailable', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('spawn git ENOENT');
    });
    expect(resolveNightlyBuildNumber('0.21.2-nightly.20260712.abc')).toBe(
      dateDerivedBuildNumber(20260712),
    );
    expect(warnSpy).toHaveBeenCalled();
  });

  it('throws an actionable error without git history or a nightly date', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('spawn git ENOENT');
    });
    expect(() =>
      resolveNightlyBuildNumber('0.21.2-nightly.notadate.abc'),
    ).toThrow(`Set ${ENV_KEY}`);
  });
});
