/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { executeRuntimeShell } from './runtime-shell.js';
import { executeBwrap } from './bwrap-execution.js';
import { ShellExecutionService } from '../services/shellExecutionService.js';
import { assertShellSandboxCwd } from './runtime-shell-policy.js';
import { sessionIdContext } from '../utils/sessionIdContext.js';

vi.mock('./bwrap-execution.js', () => ({ executeBwrap: vi.fn() }));
vi.mock('./runtime-shell-policy.js', () => ({
  assertShellSandboxCwd: vi.fn(),
}));
vi.mock('../services/shellExecutionService.js', () => ({
  ShellExecutionService: { execute: vi.fn() },
}));

describe('runtime shell dispatch', () => {
  const policy = {
    workspace: '/workspace',
    installation: '/installation',
    state: '/state',
    filesystem: 'workspace-write' as const,
    network: 'closed' as const,
  };
  const runtime = (enabled = true, sessionId = 'runtime-session') =>
    ({
      getShellExecutionSandbox: () => (enabled ? policy : undefined),
      getTargetDir: () => '/workspace',
      getSessionId: () => sessionId,
      storage: { getProjectDir: () => `/state/${sessionId}` },
    }) as unknown as Config;
  const callback = vi.fn();
  const signal = new AbortController().signal;
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllEnvs());

  it('preserves the legacy service and all options without policy', async () => {
    const options = { streamStdout: true };
    const handle = { pid: 7, result: Promise.resolve({ output: 'legacy' }) };
    vi.mocked(ShellExecutionService.execute).mockResolvedValue(
      handle as Awaited<ReturnType<typeof ShellExecutionService.execute>>,
    );
    expect(
      await executeRuntimeShell(
        runtime(false),
        'echo ok',
        '/workspace',
        callback,
        signal,
        false,
        {},
        options,
      ),
    ).toBe(handle);
    expect(ShellExecutionService.execute).toHaveBeenCalledWith(
      'echo ok',
      '/workspace',
      callback,
      signal,
      false,
      {},
      options,
    );
    expect(executeBwrap).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'uses a literal command and owning session environment (pty=%s)',
    async (pty) => {
      vi.stubEnv('GH_TOKEN', 'expected-user-value');
      const command = 'printf "%s" "$HOME"; echo literal';
      await sessionIdContext.run('different-session', () =>
        executeRuntimeShell(
          runtime(),
          command,
          '/workspace/sub',
          callback,
          signal,
          pty,
          { pager: 'less' },
          { streamStdout: true },
        ),
      );
      expect(assertShellSandboxCwd).toHaveBeenCalledWith(policy, '/workspace');
      expect(assertShellSandboxCwd).toHaveBeenCalledWith(
        policy,
        '/workspace/sub',
      );
      const args = vi.mocked(executeBwrap).mock.calls[0];
      expect(args[0]).toBe(policy);
      expect(args[1]).toMatchObject({
        executable: '/bin/bash',
        args: ['-c', command],
        cwd: '/workspace/sub',
        env: {
          QWEN_CODE: '1',
          QWEN_CODE_SESSION_ID: 'runtime-session',
          QWEN_CODE_PROJECT_DIR: '/state/runtime-session',
          GH_TOKEN: 'expected-user-value',
          TERM: 'xterm-256color',
          PAGER: 'less',
        },
      });
      if (pty) expect(args[1].env['GIT_PAGER']).toBe('less');
      expect(args.slice(2)).toEqual([
        callback,
        signal,
        pty,
        { pager: 'less' },
        { streamStdout: true },
      ]);
      expect(ShellExecutionService.execute).not.toHaveBeenCalled();
    },
  );

  it('does not fall back after admission or backend failure', async () => {
    vi.mocked(assertShellSandboxCwd).mockImplementationOnce(() => {
      throw new Error('outside');
    });
    await expect(
      executeRuntimeShell(
        runtime(),
        'touch marker',
        '/other',
        callback,
        signal,
        false,
      ),
    ).rejects.toThrow('outside');
    expect(executeBwrap).not.toHaveBeenCalled();
    vi.mocked(executeBwrap).mockRejectedValueOnce(new Error('setup failed'));
    await expect(
      executeRuntimeShell(
        runtime(),
        'touch marker',
        '/workspace',
        callback,
        signal,
        false,
      ),
    ).rejects.toThrow('setup failed');
    expect(ShellExecutionService.execute).not.toHaveBeenCalled();
  });
});
