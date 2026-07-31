/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('getLinterTempDir', () => {
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

    expect(first).toBe(
      '/runner/_work/_temp/qwen-code-linters/28501834362-1-test',
    );
    expect(second).toBe(
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

    expect(first).toMatch(/\/qwen-code-linters\/local-[a-f0-9]{16}$/);
    expect(second).toMatch(/\/qwen-code-linters\/local-[a-f0-9]{16}$/);
    expect(first).not.toBe(second);
  });
});
