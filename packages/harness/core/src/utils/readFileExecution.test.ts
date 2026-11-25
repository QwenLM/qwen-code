/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emitReadFileDiagnostic } from './diagnosticInterceptors.js';
import { runWithToolCallContext } from './toolCallContext.js';
import { runWithAgentContext } from './agentContext.js';
import { sessionIdContext } from './sessionIdContext.js';
import { promptIdContext } from './promptIdContext.js';
import {
  READ_FILE_TIMEOUT_MS,
  ReadFileTimeoutError,
  readFileStage,
  runReadFileExecution,
} from './readFileExecution.js';

vi.mock('./diagnosticInterceptors.js', () => ({
  emitReadFileDiagnostic: vi.fn(),
}));
const result = { llmContent: 'ok', returnDisplay: 'ok' };

// 保护单次总预算、取消语义和单终态；阶段日志不得泄露文件内容或路径。
describe('Read execution deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['stat', 'read_file', 'context_discovery'] as const)(
    'bounds a stalled %s and discards late settlement',
    async (phase) => {
      let resolve!: () => void;
      const stalled = new Promise<void>((done) => {
        resolve = done;
      });
      const parent = new AbortController();
      const execution = runReadFileExecution(parent.signal, async () => {
        await readFileStage(phase, () => stalled);
        return result;
      });
      const outcome = execution.then(
        () => undefined,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(READ_FILE_TIMEOUT_MS);
      expect(await outcome).toBeInstanceOf(ReadFileTimeoutError);
      expect(parent.signal.aborted).toBe(false);
      expect(emitReadFileDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            event: 'finished',
            status: 'timeout',
            phases: [phase],
            operation_pending: true,
          }),
        }),
      );
      resolve();
      await vi.advanceTimersByTimeAsync(0);
      const terminal = vi
        .mocked(emitReadFileDiagnostic)
        .mock.calls.filter(([event]) => event.data.event === 'finished');
      expect(terminal).toHaveLength(1);
      expect(emitReadFileDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { event: 'late_settlement', status: 'discarded' },
        }),
      );
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('does not reset the budget between phases', async () => {
    const execution = runReadFileExecution(
      new AbortController().signal,
      async () => {
        await readFileStage(
          'stat',
          () =>
            new Promise<void>((resolve) =>
              setTimeout(resolve, READ_FILE_TIMEOUT_MS / 2),
            ),
        );
        await readFileStage('read_file', () => new Promise<never>(() => {}));
        return result;
      },
    );
    const outcome = execution.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(READ_FILE_TIMEOUT_MS);
    expect(await outcome).toBeInstanceOf(ReadFileTimeoutError);
  });

  it('preserves parent cancellation and observes a late I/O rejection', async () => {
    const parent = new AbortController();
    const reason = new Error('cancelled by user');
    let reject!: (error: Error) => void;
    const execution = runReadFileExecution(
      parent.signal,
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const outcome = execution.then(
      () => undefined,
      (error: unknown) => error,
    );
    parent.abort(reason);
    expect(await outcome).toBe(reason);
    reject(new Error('late I/O failure'));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(emitReadFileDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          event: 'finished',
          status: 'cancelled',
        }),
      }),
    );
  });

  it('correlates diagnostics without recording raw errors or file data', async () => {
    const execution = sessionIdContext.run('session', () =>
      promptIdContext.run('turn', () =>
        runWithAgentContext(
          { agentId: 'agent-id', agentType: 'explorer' },
          () =>
            runWithToolCallContext(
              { callId: 'call', toolCallScopeId: 'scheduler' },
              () =>
                runReadFileExecution(new AbortController().signal, async () => {
                  await readFileStage('stat', async () => {
                    throw Object.assign(
                      new Error('/private/secret-file.txt: secret content'),
                      { code: 'EIO' },
                    );
                  });
                  return result;
                }),
            ),
        ),
      ),
    );
    await expect(execution).rejects.toThrow('secret');
    expect(emitReadFileDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session',
        turnId: 'turn',
        toolCallId: 'call',
        agentId: 'agent-id',
        data: expect.objectContaining({
          phase: 'stat',
          error_code: 'EIO',
          status: 'failed',
        }),
      }),
    );
    expect(
      JSON.stringify(vi.mocked(emitReadFileDiagnostic).mock.calls),
    ).not.toContain('secret');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns normal results even when diagnostic logging fails', async () => {
    vi.mocked(emitReadFileDiagnostic).mockImplementationOnce(() => {
      throw new Error('logger unavailable');
    });
    await expect(
      runReadFileExecution(new AbortController().signal, async () => result),
    ).resolves.toBe(result);
    expect(vi.getTimerCount()).toBe(0);
  });
});
