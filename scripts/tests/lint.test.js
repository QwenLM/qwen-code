/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// getLinterTempDir joins with the platform separator; compare normalized
// paths so the suite also passes on the Windows gate.
const toPosix = (value) => value.replaceAll(path.sep, '/');

describe('linter directories', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    process.argv = ['node', 'scripts/lint.js', '--test-import'];
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  it('isolates GitHub Actions linter installs by run and job', async () => {
    const { getLinterTempDir } = await import('../lint.js');

    const first = getLinterTempDir({
      cwd: '/runner/_work/qwen-code/qwen-code',
      env: {
        RUNNER_TEMP: '/runner/_work/_temp',
        GITHUB_RUN_ID: '28501834362',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_JOB: 'test',
      },
    });
    const second = getLinterTempDir({
      cwd: '/runner/_work/qwen-code/qwen-code',
      env: {
        RUNNER_TEMP: '/runner/_work/_temp',
        GITHUB_RUN_ID: '28501834363',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_JOB: 'integration_cli',
      },
    });

    expect(toPosix(first)).toBe(
      '/runner/_work/_temp/qwen-code-linters/28501834362-1-test',
    );
    expect(toPosix(second)).toBe(
      '/runner/_work/_temp/qwen-code-linters/28501834363-1-integration_cli',
    );
    expect(first).not.toBe(second);
  });

  it('isolates local linter installs by workspace', async () => {
    const { getLinterTempDir } = await import('../lint.js');

    const first = getLinterTempDir({
      cwd: '/tmp/qwen-code-a',
      env: {},
    });
    const second = getLinterTempDir({
      cwd: '/tmp/qwen-code-b',
      env: {},
    });

    expect(toPosix(first)).toMatch(/\/qwen-code-linters\/local-[a-f0-9]{16}$/);
    expect(toPosix(second)).toMatch(/\/qwen-code-linters\/local-[a-f0-9]{16}$/);
    expect(first).not.toBe(second);
  });

  it('shares cached downloads across GitHub Actions runs', async () => {
    const { getLinterCacheDir } = await import('../lint.js');

    const first = getLinterCacheDir({
      env: {
        XDG_CACHE_HOME: '/runner/cache',
        GITHUB_RUN_ID: '31583913822',
      },
    });
    const second = getLinterCacheDir({
      env: {
        XDG_CACHE_HOME: '/runner/cache',
        GITHUB_RUN_ID: '31583913823',
      },
    });

    expect(toPosix(first)).toBe('/runner/cache/qwen-code/linters');
    expect(second).toBe(first);
  });
});
