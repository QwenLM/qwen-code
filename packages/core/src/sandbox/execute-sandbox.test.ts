/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeBwrap = vi.hoisted(() => vi.fn());
const executeLandlock = vi.hoisted(() => vi.fn());
vi.mock('./bwrap-execution.js', () => ({ executeBwrap }));
vi.mock('./landlock-execution.js', () => ({ executeLandlock }));

import { executeSandbox } from './execute-sandbox.js';

const policy = {
  workspace: '/workspace',
  installation: '/installation',
  state: '/state',
  filesystem: 'workspace-write' as const,
  network: 'open' as const,
};
const payload = {
  executable: '/bin/true',
  args: [],
  cwd: '/workspace',
  env: {},
};

describe('sandbox backend dispatch', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['bwrap', executeBwrap],
    ['landlock', executeLandlock],
  ] as const)(
    'dispatches only to the resolved %s backend',
    async (backend, run) => {
      run.mockResolvedValue({ pid: 1, result: Promise.resolve({}) });
      await executeSandbox(
        { ...policy, effectiveBackend: backend, enforcement: 'partial' },
        payload,
        () => {},
        new AbortController().signal,
      );
      expect(run).toHaveBeenCalledOnce();
      expect(
        backend === 'bwrap' ? executeLandlock : executeBwrap,
      ).not.toHaveBeenCalled();
    },
  );

  it('rejects an unresolved policy without launching or falling back', async () => {
    await expect(
      executeSandbox(policy, payload, () => {}, new AbortController().signal),
    ).rejects.toThrow('backend was not resolved');
    expect(executeBwrap).not.toHaveBeenCalled();
    expect(executeLandlock).not.toHaveBeenCalled();
  });
});
