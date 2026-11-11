/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ExecutionLifecycleService,
  type ExecutionHandle,
  type ExecutionResult,
} from './executionLifecycleService.js';
import {
  getCommandQueueSnapshot,
  getCommandQueueLength,
  _resetQueueForTest,
} from './messageQueueManager.js';

function createResult(
  overrides: Partial<ExecutionResult> = {},
): ExecutionResult {
  return {
    rawOutput: Buffer.from(''),
    output: '',
    exitCode: 0,
    signal: null,
    error: null,
    aborted: false,
    pid: 123,
    executionMethod: 'child_process',
    ...overrides,
  };
}

describe('ExecutionLifecycleService', () => {
  beforeEach(() => {
    ExecutionLifecycleService.resetForTest();
    _resetQueueForTest();
  });

  it('completes managed executions in the foreground and notifies exit subscribers', async () => {
    const handle = ExecutionLifecycleService.createExecution();
    if (handle.pid === undefined) {
      throw new Error('Expected execution ID.');
    }

    const onExit = vi.fn();
    const unsubscribe = ExecutionLifecycleService.onExit(handle.pid, onExit);

    ExecutionLifecycleService.appendOutput(handle.pid, 'Hello');
    ExecutionLifecycleService.appendOutput(handle.pid, ' World');
    ExecutionLifecycleService.completeExecution(handle.pid, {
      exitCode: 0,
    });

    const result = await handle.result;
    expect(result.output).toBe('Hello World');
    expect(result.executionMethod).toBe('none');
    expect(result.backgrounded).toBeUndefined();

    await vi.waitFor(() => {
      expect(onExit).toHaveBeenCalledWith(0, undefined);
    });

    unsubscribe();
  });

  it('supports explicit execution methods for managed executions', async () => {
    const handle = ExecutionLifecycleService.createExecution(
      '',
      undefined,
      'none',
    );
    if (handle.pid === undefined) {
      throw new Error('Expected execution ID.');
    }

    ExecutionLifecycleService.completeExecution(handle.pid, {
      exitCode: 0,
    });
    const result = await handle.result;
    expect(result.executionMethod).toBe('none');
  });

  it('reports active notifiable executions until they complete', async () => {
    expect(ExecutionLifecycleService.hasActiveNotifiableExecutions()).toBe(
      false,
    );

    const handle = ExecutionLifecycleService.createExecution(
      '',
      undefined,
      'none',
      undefined,
      'background workflow',
      'notify',
    );
    if (handle.pid === undefined) {
      throw new Error('Expected execution ID.');
    }

    expect(ExecutionLifecycleService.hasActiveNotifiableExecutions()).toBe(
      true,
    );

    ExecutionLifecycleService.completeExecution(handle.pid, { exitCode: 0 });
    await handle.result;

    expect(ExecutionLifecycleService.hasActiveNotifiableExecutions()).toBe(
      false,
    );
  });

  it('treats inject executions as notifiable and silent executions as non-blocking', async () => {
    const injectHandle = ExecutionLifecycleService.createExecution(
      '',
      undefined,
      'none',
      () => 'done',
      'inject task',
      'inject',
    );
    const silentHandle = ExecutionLifecycleService.createExecution(
      '',
      undefined,
      'none',
      undefined,
      'silent task',
      'silent',
    );
    if (injectHandle.pid === undefined || silentHandle.pid === undefined) {
      throw new Error('Expected execution IDs.');
    }

    expect(ExecutionLifecycleService.hasActiveNotifiableExecutions()).toBe(
      true,
    );

    ExecutionLifecycleService.completeExecution(injectHandle.pid, {
      exitCode: 0,
    });
    await injectHandle.result;

    expect(ExecutionLifecycleService.hasActiveNotifiableExecutions()).toBe(
      false,
    );

    ExecutionLifecycleService.completeExecution(silentHandle.pid, {
      exitCode: 0,
    });
    await silentHandle.result;
  });

  it('supports backgrounding managed executions and continues streaming updates', async () => {
    const handle = ExecutionLifecycleService.createExecution();
    if (handle.pid === undefined) {
      throw new Error('Expected execution ID.');
    }

    const chunks: string[] = [];
    const onExit = vi.fn();

    const unsubscribeStream = ExecutionLifecycleService.subscribe(
      handle.pid,
      (event) => {
        if (event.type === 'data' && typeof event.chunk === 'string') {
          chunks.push(event.chunk);
        }
      },
    );
    const unsubscribeExit = ExecutionLifecycleService.onExit(
      handle.pid,
      onExit,
    );

    ExecutionLifecycleService.appendOutput(handle.pid, 'Chunk 1');
    ExecutionLifecycleService.background(handle.pid, 'user');

    const backgroundResult = await handle.result;
    expect(backgroundResult.backgrounded).toBe(true);
    expect(backgroundResult.backgroundReason).toBe('user');
    expect(backgroundResult.output).toBe('Chunk 1');

    ExecutionLifecycleService.appendOutput(handle.pid, '\nChunk 2');
    ExecutionLifecycleService.completeExecution(handle.pid, {
      exitCode: 0,
    });

    await vi.waitFor(() => {
      expect(chunks.join('')).toContain('Chunk 2');
      expect(onExit).toHaveBeenCalledWith(0, undefined);
    });

    unsubscribeStream();
    unsubscribeExit();
  });

  it('kills managed executions and resolves with aborted result', async () => {
    const onKill = vi.fn();
    const handle = ExecutionLifecycleService.createExecution('', onKill);
    if (handle.pid === undefined) {
      throw new Error('Expected execution ID.');
    }

    ExecutionLifecycleService.appendOutput(handle.pid, 'work');
    await ExecutionLifecycleService.kill(handle.pid);

    const result = await handle.result;
    expect(onKill).toHaveBeenCalledTimes(1);
    expect(result.aborted).toBe(true);
    expect(result.exitCode).toBe(130);
    expect(result.error?.message).toContain('Operation cancelled by user');
  });

  it('does not probe OS process state for completed non-process execution IDs', async () => {
    const handle = ExecutionLifecycleService.createExecution();
    if (handle.pid === undefined) {
      throw new Error('Expected execution ID.');
    }

    ExecutionLifecycleService.completeExecution(handle.pid, { exitCode: 0 });
    await handle.result;

    const processKillSpy = vi.spyOn(process, 'kill');
    expect(ExecutionLifecycleService.isActive(handle.pid)).toBe(false);
    expect(processKillSpy).not.toHaveBeenCalled();
    processKillSpy.mockRestore();
  });

  it('manages external executions through registration hooks', async () => {
    const writeInput = vi.fn();
    const isActive = vi.fn().mockReturnValue(true);
    const exitListener = vi.fn();
    const chunks: string[] = [];

    let output = 'seed';
    const handle: ExecutionHandle = ExecutionLifecycleService.attachExecution(
      4321,
      {
        executionMethod: 'child_process',
        getBackgroundOutput: () => output,
        getSubscriptionSnapshot: () => output,
        writeInput,
        isActive,
      },
    );

    const unsubscribe = ExecutionLifecycleService.subscribe(4321, (event) => {
      if (event.type === 'data' && typeof event.chunk === 'string') {
        chunks.push(event.chunk);
      }
    });
    ExecutionLifecycleService.onExit(4321, exitListener);

    ExecutionLifecycleService.writeInput(4321, 'stdin');
    expect(writeInput).toHaveBeenCalledWith('stdin');
    expect(ExecutionLifecycleService.isActive(4321)).toBe(true);

    const firstChunk = { type: 'data', chunk: ' +delta' } as const;
    ExecutionLifecycleService.emitEvent(4321, firstChunk);
    output += firstChunk.chunk;

    ExecutionLifecycleService.background(4321);
    const backgroundResult = await handle.result;
    expect(backgroundResult.backgrounded).toBe(true);
    expect(backgroundResult.output).toBe('seed +delta');
    expect(backgroundResult.executionMethod).toBe('child_process');

    ExecutionLifecycleService.completeWithResult(
      4321,
      createResult({
        pid: 4321,
        output: 'seed +delta done',
        rawOutput: Buffer.from('seed +delta done'),
        executionMethod: 'child_process',
      }),
    );

    await vi.waitFor(() => {
      expect(exitListener).toHaveBeenCalledWith(0, undefined);
    });

    const lateExit = vi.fn();
    ExecutionLifecycleService.onExit(4321, lateExit);
    expect(lateExit).toHaveBeenCalledWith(0, undefined);

    unsubscribe();
  });

  it('supports late subscription catch-up after backgrounding an external execution', async () => {
    let output = 'seed';
    const onExit = vi.fn();
    const handle = ExecutionLifecycleService.attachExecution(4322, {
      executionMethod: 'child_process',
      getBackgroundOutput: () => output,
      getSubscriptionSnapshot: () => output,
    });

    ExecutionLifecycleService.onExit(4322, onExit);
    ExecutionLifecycleService.background(4322);

    const backgroundResult = await handle.result;
    expect(backgroundResult.backgrounded).toBe(true);
    expect(backgroundResult.output).toBe('seed');

    output += ' +late';
    ExecutionLifecycleService.emitEvent(4322, {
      type: 'data',
      chunk: ' +late',
    });

    const chunks: string[] = [];
    const unsubscribe = ExecutionLifecycleService.subscribe(4322, (event) => {
      if (event.type === 'data' && typeof event.chunk === 'string') {
        chunks.push(event.chunk);
      }
    });
    expect(chunks[0]).toBe('seed +late');

    output += ' +live';
    ExecutionLifecycleService.emitEvent(4322, {
      type: 'data',
      chunk: ' +live',
    });
    expect(chunks[chunks.length - 1]).toBe(' +live');

    ExecutionLifecycleService.completeWithResult(
      4322,
      createResult({
        pid: 4322,
        output,
        rawOutput: Buffer.from(output),
        executionMethod: 'child_process',
      }),
    );

    await vi.waitFor(() => {
      expect(onExit).toHaveBeenCalledWith(0, undefined);
    });
    unsubscribe();
  });

  it('kills external executions and settles pending promises', async () => {
    const terminate = vi.fn();
    const onExit = vi.fn();
    const handle = ExecutionLifecycleService.attachExecution(4323, {
      executionMethod: 'child_process',
      initialOutput: 'running',
      kill: terminate,
    });
    ExecutionLifecycleService.onExit(4323, onExit);
    await ExecutionLifecycleService.kill(4323);

    const result = await handle.result;
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(result.aborted).toBe(true);
    expect(result.exitCode).toBe(130);
    expect(result.output).toBe('running');
    expect(result.error?.message).toContain('Operation cancelled by user');
    expect(onExit).toHaveBeenCalledWith(130, undefined);
  });

  it('waits for an asynchronous kill callback before settling', async () => {
    let finishKill!: () => void;
    const onKill = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishKill = resolve;
        }),
    );
    const handle = ExecutionLifecycleService.createExecution('', onKill);
    const executionId = handle.pid!;

    const killPromise = ExecutionLifecycleService.kill(executionId);
    await Promise.resolve();

    expect(onKill).toHaveBeenCalledTimes(1);
    expect(ExecutionLifecycleService.isActive(executionId)).toBe(true);

    finishKill();
    await killPromise;
    const result = await handle.result;

    expect(result.aborted).toBe(true);
    expect(ExecutionLifecycleService.isActive(executionId)).toBe(false);
  });

  it('retains external executions after a failed stop and retries at shutdown', async () => {
    const terminate = vi
      .fn()
      .mockRejectedValueOnce(new Error('Access is denied'))
      .mockResolvedValueOnce(undefined);
    const onExit = vi.fn();
    const handle = ExecutionLifecycleService.attachExecution(4323, {
      executionMethod: 'child_process',
      kill: terminate,
      isActive: () => true,
    });
    ExecutionLifecycleService.onExit(4323, onExit);
    await expect(ExecutionLifecycleService.kill(4323)).rejects.toThrow(
      'Access is denied',
    );
    expect(ExecutionLifecycleService.isActive(4323)).toBe(true);
    expect(onExit).not.toHaveBeenCalled();
    await ExecutionLifecycleService.terminateAll();
    expect(terminate).toHaveBeenCalledTimes(2);
    expect((await handle.result).aborted).toBe(true);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent kill requests', async () => {
    let finishKill!: () => void;
    const onKill = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishKill = resolve;
        }),
    );
    const handle = ExecutionLifecycleService.createExecution('', onKill);
    const executionId = handle.pid!;

    const firstKill = ExecutionLifecycleService.kill(executionId, 'user_stop');
    const secondKill = ExecutionLifecycleService.kill(
      executionId,
      'session_shutdown',
    );

    expect(secondKill).toBe(firstKill);
    expect(onKill).toHaveBeenCalledTimes(1);
    expect(onKill).toHaveBeenCalledWith('user_stop');

    finishKill();
    await Promise.all([firstKill, secondKill, handle.result]);
  });

  it('terminates both foreground and background executions', async () => {
    const foregroundKill = vi.fn();
    const backgroundKill = vi.fn();
    const foreground = ExecutionLifecycleService.createExecution(
      '',
      foregroundKill,
    );
    const background = ExecutionLifecycleService.createExecution(
      '',
      backgroundKill,
    );
    const foregroundId = foreground.pid!;
    const backgroundId = background.pid!;

    ExecutionLifecycleService.background(backgroundId, 'user');
    await background.result;

    await ExecutionLifecycleService.terminateAll();

    expect(foregroundKill).toHaveBeenCalledTimes(1);
    expect(backgroundKill).toHaveBeenCalledTimes(1);
    expect(foregroundKill).toHaveBeenCalledWith('session_shutdown');
    expect(backgroundKill).toHaveBeenCalledWith('session_shutdown');
    expect((await foreground.result).aborted).toBe(true);
    expect(ExecutionLifecycleService.isActive(foregroundId)).toBe(false);
    expect(ExecutionLifecycleService.isActive(backgroundId)).toBe(false);
  });

  it('rejects duplicate execution registration for active execution IDs', () => {
    ExecutionLifecycleService.attachExecution(4324, {
      executionMethod: 'child_process',
    });

    expect(() => {
      ExecutionLifecycleService.attachExecution(4324, {
        executionMethod: 'child_process',
      });
    }).toThrow('Execution 4324 is already attached.');
  });

  describe('Background Start Listeners', () => {
    it('fires onBackground when an execution is backgrounded', async () => {
      const listener = vi.fn();
      ExecutionLifecycleService.onBackground(listener);

      const handle = ExecutionLifecycleService.createExecution(
        '',
        undefined,
        'none',
        undefined,
        'My Managed Task',
      );
      const executionId = handle.pid!;

      ExecutionLifecycleService.appendOutput(executionId, 'some output');
      ExecutionLifecycleService.background(executionId, 'user');
      await handle.result;

      expect(listener).toHaveBeenCalledTimes(1);
      const info = listener.mock.calls[0][0];
      expect(info.executionId).toBe(executionId);
      expect(info.executionMethod).toBe('none');
      expect(info.label).toBe('My Managed Task');
      expect(info.output).toBe('some output');
      expect(info.reason).toBe('user');

      ExecutionLifecycleService.offBackground(listener);
    });

    it('uses fallback label when none is provided', async () => {
      const listener = vi.fn();
      ExecutionLifecycleService.onBackground(listener);

      const handle = ExecutionLifecycleService.createExecution(
        '',
        undefined,
        'none',
      );
      const executionId = handle.pid!;

      ExecutionLifecycleService.background(executionId);
      await handle.result;

      const info = listener.mock.calls[0][0];
      expect(info.label).toContain('none');
      expect(info.label).toContain(String(executionId));

      ExecutionLifecycleService.offBackground(listener);
    });

    it('does not fire onBackground for non-backgrounded completions', async () => {
      const listener = vi.fn();
      ExecutionLifecycleService.onBackground(listener);

      const handle = ExecutionLifecycleService.createExecution();
      ExecutionLifecycleService.completeExecution(handle.pid!);
      await handle.result;

      expect(listener).not.toHaveBeenCalled();

      ExecutionLifecycleService.offBackground(listener);
    });

    it('offBackground removes the listener', async () => {
      const listener = vi.fn();
      ExecutionLifecycleService.onBackground(listener);
      ExecutionLifecycleService.offBackground(listener);

      const handle = ExecutionLifecycleService.createExecution();
      ExecutionLifecycleService.background(handle.pid!);
      await handle.result;

      expect(listener).not.toHaveBeenCalled();
    });

    it('backgrounds one tool use or all foreground executions in a session', async () => {
      const first = ExecutionLifecycleService.createExecution(
        '',
        undefined,
        'none',
        undefined,
        'first',
        'silent',
        {
          sessionId: 'session-1',
          toolUseId: 'tool-1',
          backgroundControlType: 'local_agent',
        },
      );
      const second = ExecutionLifecycleService.createExecution(
        '',
        undefined,
        'none',
        undefined,
        'second',
        'silent',
        {
          sessionId: 'session-1',
          toolUseId: 'tool-2',
          backgroundControlType: 'local_agent',
        },
      );
      const otherSession = ExecutionLifecycleService.createExecution(
        '',
        undefined,
        'none',
        undefined,
        'other',
        'silent',
        {
          sessionId: 'session-2',
          toolUseId: 'tool-1',
          backgroundControlType: 'local_agent',
        },
      );
      const unrelated = ExecutionLifecycleService.createExecution(
        '',
        undefined,
        'none',
        undefined,
        'unrelated',
        'silent',
        { sessionId: 'session-1', toolUseId: 'tool-1' },
      );
      const monitor = ExecutionLifecycleService.createExecution(
        '',
        undefined,
        'none',
        undefined,
        'monitor',
        'silent',
        { sessionId: 'session-1', toolUseId: 'tool-monitor' },
      );

      expect(
        ExecutionLifecycleService.backgroundTasks({
          sessionId: 'session-1',
          toolUseId: 'tool-1',
        }),
      ).toBe(true);
      expect((await first.result).backgrounded).toBe(true);
      expect(
        ExecutionLifecycleService.backgroundTasks({
          sessionId: 'session-1',
          toolUseId: 'missing',
        }),
      ).toBe(false);

      expect(
        ExecutionLifecycleService.backgroundTasks({ sessionId: 'session-1' }),
      ).toBe(true);
      expect((await second.result).backgrounded).toBe(true);

      ExecutionLifecycleService.completeExecution(first.pid!);
      ExecutionLifecycleService.completeExecution(second.pid!);
      ExecutionLifecycleService.completeExecution(otherSession.pid!);
      ExecutionLifecycleService.completeExecution(unrelated.pid!);
      ExecutionLifecycleService.completeExecution(monitor.pid!);
      expect((await otherSession.result).backgrounded).toBeUndefined();
      expect((await unrelated.result).backgrounded).toBeUndefined();
      expect((await monitor.result).backgrounded).toBeUndefined();
    });
  });

  describe('Background Completion Listeners', () => {
    it('fires onBackgroundComplete with formatInjection text when backgrounded execution settles', async () => {
      const listener = vi.fn();
      ExecutionLifecycleService.onBackgroundComplete(listener);

      const handle = ExecutionLifecycleService.createExecution(
        '',
        undefined,
        'none',
        (output, error) => {
          const header = error
            ? `[Agent error: ${error.message}]`
            : '[Agent completed]';
          return output ? `${header}\n${output}` : header;
        },
      );
      const executionId = handle.pid!;

      ExecutionLifecycleService.appendOutput(executionId, 'agent output');
      ExecutionLifecycleService.background(executionId);
      await handle.result;

      ExecutionLifecycleService.completeExecution(executionId);

      expect(listener).toHaveBeenCalledTimes(1);
      const info = listener.mock.calls[0][0];
      expect(info.executionId).toBe(executionId);
      expect(info.executionMethod).toBe('none');
      expect(info.output).toBe('agent output');
      expect(info.error).toBeNull();
      expect(info.injectionText).toBe(
        '<output>\n[Agent completed]\nagent output\n</output>',
      );
      expect(info.completionBehavior).toBe('inject');

      ExecutionLifecycleService.offBackgroundComplete(listener);
    });

    it('passes error to formatInjection when backgrounded execution fails', async () => {
      const listener = vi.fn();
      ExecutionLifecycleService.onBackgroundComplete(listener);

      const handle = ExecutionLifecycleService.createExecution(
        '',
        undefined,
        'none',
        (output, error) => (error ? `Error: ${error.message}` : output),
      );
      const executionId = handle.pid!;

      ExecutionLifecycleService.background(executionId);
      await handle.result;

      ExecutionLifecycleService.completeExecution(executionId, {
        error: new Error('something broke'),
      });

      expect(listener).toHaveBeenCalledTimes(1);
      const info = listener.mock.calls[0][0];
      expect(info.error?.message).toBe('something broke');
      expect(info.injectionText).toBe(
        '<output>\nError: something broke\n</output>',
      );

      ExecutionLifecycleService.offBackgroundComplete(listener);
    });

    it('sets injectionText to null and completionBehavior to notify when no formatInjection is provided', async () => {
      const listener = vi.fn();
      ExecutionLifecycleService.onBackgroundComplete(listener);

      const handle = ExecutionLifecycleService.createExecution(
        '',
        undefined,
        'none',
      );
      const executionId = handle.pid!;

      ExecutionLifecycleService.appendOutput(executionId, 'output');
      ExecutionLifecycleService.background(executionId);
      await handle.result;

      ExecutionLifecycleService.completeExecution(executionId);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].injectionText).toBeNull();
      expect(listener.mock.calls[0][0].completionBehavior).toBe('notify');

      ExecutionLifecycleService.offBackgroundComplete(listener);
    });

    it('does not fire onBackgroundComplete for non-backgrounded executions', async () => {
      const listener = vi.fn();
      ExecutionLifecycleService.onBackgroundComplete(listener);

      const handle = ExecutionLifecycleService.createExecution(
        '',
        undefined,
        'none',
        () => 'text',
      );
      const executionId = handle.pid!;

      ExecutionLifecycleService.completeExecution(executionId);
      await handle.result;

      expect(listener).not.toHaveBeenCalled();

      ExecutionLifecycleService.offBackgroundComplete(listener);
    });

    it('does not fire onBackgroundComplete when execution is killed (aborted)', async () => {
      const listener = vi.fn();
      ExecutionLifecycleService.onBackgroundComplete(listener);

      const handle = ExecutionLifecycleService.createExecution(
        '',
        undefined,
        'none',
        () => 'text',
      );
      const executionId = handle.pid!;

      ExecutionLifecycleService.background(executionId);
      await handle.result;

      await ExecutionLifecycleService.kill(executionId);

      expect(listener).not.toHaveBeenCalled();

      ExecutionLifecycleService.offBackgroundComplete(listener);
    });

    it('offBackgroundComplete removes the listener', async () => {
      const listener = vi.fn();
      ExecutionLifecycleService.onBackgroundComplete(listener);
      ExecutionLifecycleService.offBackgroundComplete(listener);

      const handle = ExecutionLifecycleService.createExecution(
        '',
        undefined,
        'none',
        () => 'text',
      );
      const executionId = handle.pid!;

      ExecutionLifecycleService.background(executionId);
      await handle.result;

      ExecutionLifecycleService.completeExecution(executionId);

      expect(listener).not.toHaveBeenCalled();
    });

    it('explicit notify behavior includes injectionText and auto-dismiss signal', async () => {
      const listener = vi.fn();
      ExecutionLifecycleService.onBackgroundComplete(listener);

      const handle = ExecutionLifecycleService.createExecution(
        '',
        undefined,
        'child_process',
        () => '[Command completed. Output saved to /tmp/bg.log]',
        undefined,
        'notify',
      );
      const executionId = handle.pid!;

      ExecutionLifecycleService.background(executionId);
      await handle.result;

      ExecutionLifecycleService.completeExecution(executionId);

      expect(listener).toHaveBeenCalledTimes(1);
      const info = listener.mock.calls[0][0];
      expect(info.completionBehavior).toBe('notify');
      expect(info.injectionText).toBe(
        '<output>\n[Command completed. Output saved to /tmp/bg.log]\n</output>',
      );

      ExecutionLifecycleService.offBackgroundComplete(listener);
    });

    it('explicit silent behavior skips injection even when formatInjection is provided', async () => {
      const formatFn = vi.fn().mockReturnValue('should not appear');
      const listener = vi.fn();
      ExecutionLifecycleService.onBackgroundComplete(listener);

      const handle = ExecutionLifecycleService.createExecution(
        '',
        undefined,
        'none',
        formatFn,
        undefined,
        'silent',
      );
      const executionId = handle.pid!;

      ExecutionLifecycleService.background(executionId);
      await handle.result;

      ExecutionLifecycleService.completeExecution(executionId);

      expect(listener).toHaveBeenCalledTimes(1);
      const info = listener.mock.calls[0][0];
      expect(info.completionBehavior).toBe('silent');
      expect(info.injectionText).toBeNull();
      expect(formatFn).not.toHaveBeenCalled();

      ExecutionLifecycleService.offBackgroundComplete(listener);
    });

    it('includes completionBehavior in BackgroundStartInfo', async () => {
      const bgStartListener = vi.fn();
      ExecutionLifecycleService.onBackground(bgStartListener);

      const handle = ExecutionLifecycleService.createExecution(
        '',
        undefined,
        'none',
        () => 'text',
        'test-label',
        'inject',
      );

      ExecutionLifecycleService.background(handle.pid!);
      await handle.result;

      expect(bgStartListener).toHaveBeenCalledTimes(1);
      expect(bgStartListener.mock.calls[0][0].completionBehavior).toBe(
        'inject',
      );

      ExecutionLifecycleService.offBackground(bgStartListener);
    });

    it('completionBehavior flows through attachExecution', async () => {
      const listener = vi.fn();
      ExecutionLifecycleService.onBackgroundComplete(listener);

      const handle = ExecutionLifecycleService.attachExecution(9999, {
        executionMethod: 'child_process',
        formatInjection: () => '[notify message]',
        completionBehavior: 'notify',
      });

      ExecutionLifecycleService.background(9999);
      await handle.result;

      ExecutionLifecycleService.completeWithResult(
        9999,
        createResult({ pid: 9999, executionMethod: 'child_process' }),
      );

      expect(listener).toHaveBeenCalledTimes(1);
      const info = listener.mock.calls[0][0];
      expect(info.completionBehavior).toBe('notify');
      expect(info.injectionText).toBe('<output>\n[notify message]\n</output>');

      ExecutionLifecycleService.offBackgroundComplete(listener);
    });

    it('does not inject into InjectionService (background_completion removed)', async () => {
      // Notifications now go through messageQueueManager, not InjectionService.
      // Verify that a backgrounded execution with inject behavior enqueues to the
      // message queue instead.
      const handle = ExecutionLifecycleService.createExecution(
        '',
        undefined,
        'none',
        (output) => `[Completed] ${output}`,
        'test cmd',
        'inject',
      );
      const executionId = handle.pid!;

      ExecutionLifecycleService.appendOutput(executionId, 'agent output');
      ExecutionLifecycleService.background(executionId);
      await handle.result;

      ExecutionLifecycleService.completeExecution(executionId);

      // Notification should be in messageQueueManager instead
      expect(getCommandQueueLength()).toBe(1);
      expect(getCommandQueueSnapshot()[0]?.commandMode).toBe(
        'task-notification',
      );
    });
  });

  describe('Queue-based task notifications', () => {
    it('enqueues XML task-notification when backgrounded execution completes', async () => {
      const handle = ExecutionLifecycleService.createExecution(
        'test output',
        undefined,
        'child_process',
        () => 'injection text',
        'npm test',
        'inject',
      );
      const executionId = handle.pid!;

      ExecutionLifecycleService.background(executionId);
      await handle.result;

      ExecutionLifecycleService.completeExecution(executionId);

      // Queue should have one notification
      expect(getCommandQueueLength()).toBe(1);
      const snapshot = getCommandQueueSnapshot();
      expect(snapshot[0]?.commandMode).toBe('task-notification');
      expect(snapshot[0]?.priority).toBe('later');
      expect(snapshot[0]?.prompt).toContain('<task-notification>');
      expect(snapshot[0]?.prompt).toContain(
        `<task-id>${executionId}</task-id>`,
      );
      expect(snapshot[0]?.prompt).toContain('<status>completed</status>');
      expect(snapshot[0]?.prompt).toContain(
        'Background command "npm test" completed (exit code 0)',
      );
    });

    it('carries the originating customContext on the completion notification', async () => {
      const customContext = Object.freeze({ tenant: 'alpha' });
      const handle = ExecutionLifecycleService.attachExecution(9998, {
        executionMethod: 'child_process',
        taskId: 'task-1',
        sessionId: 'session-1',
        taskKind: 'bash',
        label: 'context test',
        outputPath: '/tmp/out.txt',
        completionBehavior: 'notify',
        customContext,
      });

      ExecutionLifecycleService.background(9998);
      await handle.result;
      ExecutionLifecycleService.completeWithResult(
        9998,
        createResult({ pid: 9998 }),
      );

      const notification = getCommandQueueSnapshot().find(
        (command) => command.commandMode === 'task-notification',
      );
      expect(notification?.customContext).toEqual(customContext);
    });

    it('enqueues failed status when execution has error', async () => {
      const handle = ExecutionLifecycleService.createExecution(
        '',
        undefined,
        'child_process',
        () => 'error text',
        'bad cmd',
        'inject',
      );
      const executionId = handle.pid!;

      ExecutionLifecycleService.background(executionId);
      await handle.result;

      ExecutionLifecycleService.completeExecution(executionId, {
        error: new Error('boom'),
        exitCode: 1,
      });

      const snapshot = getCommandQueueSnapshot();
      expect(snapshot[0]?.prompt).toContain('<status>failed</status>');
      expect(snapshot[0]?.prompt).toContain(
        'Background command "bad cmd" failed with exit code 1',
      );
    });

    it('reports the output cap when a background command is killed', async () => {
      const handle = ExecutionLifecycleService.createExecution(
        '',
        undefined,
        'child_process',
        () => 'output cap text',
        'verbose cmd',
        'notify',
        { taskId: 'b12345678', taskKind: 'bash' },
      );
      const executionId = handle.pid!;

      ExecutionLifecycleService.background(executionId);
      await handle.result;

      ExecutionLifecycleService.completeWithResult(
        executionId,
        createResult({
          pid: executionId,
          signal: 15,
          outputLimitExceeded: true,
        }),
      );

      expect(getCommandQueueSnapshot()[0]).toMatchObject({
        priority: 'next',
        prompt: expect.stringContaining(
          'Background command "verbose cmd" was stopped: output file exceeded 5GB',
        ),
      });
    });

    it('classifies a non-zero shell exit as failed without requiring an Error', async () => {
      const handle = ExecutionLifecycleService.createExecution(
        '',
        undefined,
        'child_process',
        () => 'error text',
        'false',
        'notify',
        { taskId: 'b12345678', taskKind: 'bash' },
      );
      const executionId = handle.pid!;
      ExecutionLifecycleService.background(executionId);
      await handle.result;

      ExecutionLifecycleService.completeWithResult(
        executionId,
        createResult({
          pid: executionId,
          exitCode: 1,
          error: null,
        }),
      );

      expect(getCommandQueueSnapshot()[0]).toMatchObject({
        priority: 'next',
        prompt: expect.stringContaining(
          'Background command "false" failed with exit code 1',
        ),
      });
    });

    it('uses Monitor terminal summaries and next priority', async () => {
      const handle = ExecutionLifecycleService.createExecution(
        '',
        undefined,
        'child_process',
        () => 'monitor ended',
        'service readiness',
        'notify',
        { taskId: 'b87654321', taskKind: 'monitor' },
      );
      const executionId = handle.pid!;
      ExecutionLifecycleService.background(executionId);
      await handle.result;

      ExecutionLifecycleService.completeWithResult(
        executionId,
        createResult({ pid: executionId, exitCode: 0 }),
      );

      expect(getCommandQueueSnapshot()[0]).toMatchObject({
        priority: 'next',
        prompt: expect.stringContaining(
          'Monitor "service readiness" stream ended',
        ),
      });
    });

    it('deduplicates: only enqueues one notification per execution', async () => {
      const handle = ExecutionLifecycleService.attachExecution(9999, {
        executionMethod: 'child_process',
        label: 'dup test',
        outputPath: '/tmp/out.txt',
        formatInjection: () => 'text',
        completionBehavior: 'inject',
      });

      ExecutionLifecycleService.background(9999);
      await handle.result;

      // Complete twice (shouldn't happen in practice, but tests dedup)
      ExecutionLifecycleService.completeWithResult(
        9999,
        createResult({ pid: 9999 }),
      );

      // Only 1 notification should be in the queue
      expect(getCommandQueueLength()).toBe(1);
    });

    it('markNotified suppresses future notification', async () => {
      const handle = ExecutionLifecycleService.attachExecution(8888, {
        executionMethod: 'child_process',
        label: 'mark test',
        outputPath: '/tmp/out.txt',
        formatInjection: () => 'text',
        completionBehavior: 'inject',
      });

      ExecutionLifecycleService.background(8888);
      await handle.result;

      // Mark as notified before completion
      ExecutionLifecycleService.markNotified(8888);

      ExecutionLifecycleService.completeWithResult(
        8888,
        createResult({ pid: 8888 }),
      );

      // Queue should be empty — notification was suppressed
      expect(getCommandQueueLength()).toBe(0);
    });

    it('does not enqueue notification for silent behavior', async () => {
      const handle = ExecutionLifecycleService.createExecution(
        '',
        undefined,
        'child_process',
        () => 'text',
        'silent cmd',
        'silent',
      );
      const executionId = handle.pid!;

      ExecutionLifecycleService.background(executionId);
      await handle.result;

      ExecutionLifecycleService.completeExecution(executionId);

      expect(getCommandQueueLength()).toBe(0);
    });

    it('does not enqueue notification for non-backgrounded execution', async () => {
      const handle = ExecutionLifecycleService.createExecution(
        '',
        undefined,
        'child_process',
        () => 'text',
        'fg cmd',
        'inject',
      );
      const executionId = handle.pid!;

      // Complete without backgrounding
      ExecutionLifecycleService.completeExecution(executionId);
      await handle.result;

      expect(getCommandQueueLength()).toBe(0);
    });

    it('includes outputPath in XML when provided via attachExecution', async () => {
      const handle = ExecutionLifecycleService.attachExecution(7777, {
        executionMethod: 'child_process',
        label: 'with path',
        outputPath: '/tmp/tasks/task-7777.output',
        formatInjection: () => 'text',
        completionBehavior: 'inject',
      });

      ExecutionLifecycleService.background(7777);
      await handle.result;

      ExecutionLifecycleService.completeWithResult(
        7777,
        createResult({ pid: 7777 }),
      );

      const snapshot = getCommandQueueSnapshot();
      expect(snapshot[0]?.prompt).toContain(
        '<output-file>/tmp/tasks/task-7777.output</output-file>',
      );
    });
  });
});
