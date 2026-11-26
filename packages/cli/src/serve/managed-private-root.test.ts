/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executePrivateRootBwrap } from '@qwen-code/qwen-code-core/sandbox/private-root-bwrap.js';
import type { SandboxStatus } from '@qwen-code/qwen-code-core/sandbox/sandbox-status.js';
import { runPrivateRootShell } from './managed-private-root.js';

vi.mock('node:fs/promises', () => ({
  realpath: async (file: string) => file,
  stat: async () => ({ dev: 1n, ino: 2n }),
}));
vi.mock('@qwen-code/qwen-code-core/sandbox/private-root-bwrap.js', () => ({
  executePrivateRootBwrap: vi.fn(),
}));

const launch = vi.mocked(executePrivateRootBwrap);
const recipe = {
  version: 1,
  rootfs: '/image',
  rootfsIdentity: '1:2',
  bwrapIdentity: '1:2',
} as const;

describe('runPrivateRootShell', () => {
  beforeEach(() => {
    launch.mockReset();
  });

  it('settles an attested failure before execution', async () => {
    mockLaunch({ state: 'unconfirmed', payloadExitObserved: false });
    await expect(run()).resolves.toMatchObject({
      executionStatus: 'not_started',
      responseParts: [],
    });
  });

  it('settles an abort when the Shell service did not spawn a process', async () => {
    mockLaunch({ state: 'interrupted' }, true);
    await expect(run()).resolves.toMatchObject({
      executionStatus: 'not_started',
      responseParts: [],
    });
  });

  it.each([
    { state: 'unconfirmed' },
    { state: 'unconfirmed', payloadExitObserved: true },
    { state: 'interrupted' },
  ] as const)('keeps a possible execution unknown for %j', async (status) => {
    mockLaunch(status);
    await expect(run()).resolves.toBeUndefined();
  });
});

function run() {
  return runPrivateRootShell(
    recipe,
    '/workspace',
    'pwd',
    new AbortController().signal,
  );
}

function mockLaunch(
  sandboxStatus: SandboxStatus,
  cancelledBeforeSpawn = false,
) {
  const pid = cancelledBeforeSpawn ? undefined : 123;
  launch.mockResolvedValue({
    pid,
    settled: Promise.resolve(sandboxStatus),
    result: Promise.resolve({
      rawOutput: Buffer.alloc(0),
      output: '',
      exitCode: null,
      signal: null,
      error: null,
      aborted: sandboxStatus.state === 'interrupted',
      pid,
      executionMethod: cancelledBeforeSpawn ? 'none' : 'child_process',
      sandboxStatus,
    }),
  });
}
