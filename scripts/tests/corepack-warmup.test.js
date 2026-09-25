/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensurePinnedPnpm } from './corepack-warmup.js';

const pinnedVersion = JSON.parse(
  readFileSync('package.json', 'utf8'),
).packageManager.match(/^pnpm@([^+]+)/)[1];

describe('corepack warmup', () => {
  let corepackHome;
  let installDir;

  beforeEach(() => {
    corepackHome = mkdtempSync(join(tmpdir(), 'corepack-warmup-'));
    installDir = join(corepackHome, 'v1', 'pnpm', pinnedVersion);
  });

  afterEach(() => {
    rmSync(corepackHome, { recursive: true, force: true });
  });

  it('does nothing when the pinned pnpm already runs', () => {
    const spawn = vi.fn(() => ({ status: 0, stdout: pinnedVersion }));

    ensurePinnedPnpm(spawn, { COREPACK_HOME: corepackHome });

    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('purges a broken cached install before retrying', () => {
    mkdirSync(installDir, { recursive: true });
    let installDirSeenOnRetry;
    const spawn = vi
      .fn()
      .mockImplementationOnce(() => ({ status: 1, stderr: 'broken' }))
      .mockImplementationOnce(() => {
        installDirSeenOnRetry = existsSync(installDir);
        return { status: 0, stdout: pinnedVersion };
      });

    ensurePinnedPnpm(spawn, { COREPACK_HOME: corepackHome });

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(installDirSeenOnRetry).toBe(false);
  });

  it('throws the corepack output when the retry still fails', () => {
    mkdirSync(installDir, { recursive: true });
    const spawn = vi.fn(() => ({ status: 1, stderr: 'still broken' }));

    expect(() =>
      ensurePinnedPnpm(spawn, { COREPACK_HOME: corepackHome }),
    ).toThrow('still broken');
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(existsSync(installDir)).toBe(false);
  });

  it('does not retry when there is no cached install to purge', () => {
    const spawn = vi.fn(() => ({ status: 1, stderr: 'offline' }));

    expect(() =>
      ensurePinnedPnpm(spawn, { COREPACK_HOME: corepackHome }),
    ).toThrow('offline');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('resolves the pinned pnpm through the real corepack', () => {
    expect(() => ensurePinnedPnpm()).not.toThrow();
  });

  it('warms the pinned pnpm before vitest forks any worker', () => {
    const config = readFileSync(
      join('scripts', 'tests', 'vitest.config.ts'),
      'utf8',
    );

    expect(config).toContain(
      `globalSetup: ['scripts/tests/corepack-warmup.js']`,
    );
  });
});
