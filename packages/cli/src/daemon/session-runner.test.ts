/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runDaemonSession } from './session-runner.js';

vi.mock('../config/settings.js', () => ({
  loadSettings: vi.fn(() => ({ merged: {} })),
}));

vi.mock('../config/config.js', () => ({
  loadCliConfig: vi.fn(() =>
    Promise.resolve({
      getOutputFormat: () => 'text',
      getSessionId: () => 'test-session',
      getApprovalMode: () => 'auto',
      getGeminiClient: () => ({}),
      getIncludePartialMessages: () => false,
    }),
  ),
}));

vi.mock('../nonInteractiveCli.js', () => ({
  runNonInteractive: vi.fn(() => Promise.resolve()),
}));

describe('runDaemonSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should call onOutput when runNonInteractive writes to stdout', async () => {
    const { runNonInteractive } = await import('../nonInteractiveCli.js');
    vi.mocked(runNonInteractive).mockImplementation(async () => {
      process.stdout.write('Hello from session');
    });

    const onOutput = vi.fn();
    const onError = vi.fn();
    const onToolCall = vi.fn();

    await runDaemonSession({
      cwd: '/test',
      prompt: 'test prompt',
      sessionId: 'session-1',
      abortSignal: new AbortController().signal,
      onOutput,
      onToolCall,
      onError,
    });

    expect(onOutput).toHaveBeenCalledWith('Hello from session');
  });

  it('should call onError when runNonInteractive writes to stderr', async () => {
    const { runNonInteractive } = await import('../nonInteractiveCli.js');
    vi.mocked(runNonInteractive).mockImplementation(async () => {
      process.stderr.write('Error from session');
    });

    const onOutput = vi.fn();
    const onError = vi.fn();
    const onToolCall = vi.fn();

    await runDaemonSession({
      cwd: '/test',
      prompt: 'test prompt',
      sessionId: 'session-1',
      abortSignal: new AbortController().signal,
      onOutput,
      onToolCall,
      onError,
    });

    expect(onError).toHaveBeenCalledWith('Error from session');
  });

  it('should restore stdout/stderr after execution even on error', async () => {
    const { runNonInteractive } = await import('../nonInteractiveCli.js');
    vi.mocked(runNonInteractive).mockRejectedValueOnce(new Error('fail'));

    const onOutput = vi.fn();
    const onError = vi.fn();

    await runDaemonSession({
      cwd: '/test',
      prompt: 'test',
      sessionId: 'session-1',
      abortSignal: new AbortController().signal,
      onOutput,
      onToolCall: vi.fn(),
      onError,
    });

    expect(onError).toHaveBeenCalledWith('fail');

    // After session, writing to stdout should NOT trigger onOutput anymore
    const callCountBefore = onOutput.mock.calls.length;
    const spy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    process.stdout.write('post-session');
    expect(onOutput.mock.calls.length).toBe(callCountBefore);
    spy.mockRestore();
  });

  it('should call onError when config loading fails', async () => {
    const { loadCliConfig } = await import('../config/config.js');
    vi.mocked(loadCliConfig).mockRejectedValueOnce(new Error('Config error'));

    const onError = vi.fn();

    await runDaemonSession({
      cwd: '/test',
      prompt: 'test',
      sessionId: 'session-1',
      abortSignal: new AbortController().signal,
      onOutput: vi.fn(),
      onToolCall: vi.fn(),
      onError,
    });

    expect(onError).toHaveBeenCalledWith(
      'Failed to initialize config: Config error',
    );
  });

  it('should serialize concurrent sessions via mutex', async () => {
    const executionOrder: string[] = [];

    const { runNonInteractive } = await import('../nonInteractiveCli.js');
    vi.mocked(runNonInteractive).mockImplementation(
      async (_c, _s, _p, sessionId) => {
        executionOrder.push(`start-${sessionId}`);
        await new Promise((r) => setTimeout(r, 50));
        executionOrder.push(`end-${sessionId}`);
      },
    );

    const makeOptions = (id: string) => ({
      cwd: '/test',
      prompt: `prompt ${id}`,
      sessionId: id,
      abortSignal: new AbortController().signal,
      onOutput: vi.fn(),
      onToolCall: vi.fn(),
      onError: vi.fn(),
    });

    // Launch two sessions concurrently
    const p1 = runDaemonSession(makeOptions('s1'));
    const p2 = runDaemonSession(makeOptions('s2'));

    await Promise.all([p1, p2]);

    // Sessions should NOT overlap: start-s1, end-s1, start-s2, end-s2
    expect(executionOrder).toEqual([
      'start-s1',
      'end-s1',
      'start-s2',
      'end-s2',
    ]);
  });

  it('should handle abort signal', async () => {
    const { runNonInteractive } = await import('../nonInteractiveCli.js');
    vi.mocked(runNonInteractive).mockImplementation(
      async (_c, _s, _p, _id, opts) => {
        opts?.abortController?.abort();
        throw new Error('Aborted');
      },
    );

    const onError = vi.fn();

    await runDaemonSession({
      cwd: '/test',
      prompt: 'test',
      sessionId: 'session-1',
      abortSignal: new AbortController().signal,
      onOutput: vi.fn(),
      onToolCall: vi.fn(),
      onError,
    });

    // Should not call onError when aborted
    expect(onError).not.toHaveBeenCalled();
  });
});
