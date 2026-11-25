/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import * as queue from '../services/messageQueueManager.js';
import { runWithAgentContext } from '../utils/agentContext.js';
import { SleepTool } from './sleep.js';
import { RepeatedToolCallController } from '../tool-executor/streaming/repeated-tool-call.js';

const config = { getSessionId: () => 'main' } as Config;
const command = (overrides: Partial<queue.QueuedCommand> = {}): queue.QueuedCommand => ({
  prompt: 'reply', commandMode: 'prompt', priority: 'next', sessionId: 'main', ...overrides,
});

describe('Sleep', () => {
  let unsubscribe: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    queue._resetQueueForTest();
    const subscribe = queue.subscribeToCommandQueue;
    unsubscribe = vi.fn();
    vi.spyOn(queue, 'subscribeToCommandQueue').mockImplementation((listener) => {
      const stop = subscribe(listener);
      return () => { unsubscribe(); stop(); };
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    queue._resetQueueForTest();
    vi.useRealTimers();
  });

  it('times out with actual duration and repeatNeutral, removing timer and subscription', async () => {
    const promise = new SleepTool(config).build({ duration_ms: 1000 }).execute(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;
    expect(result.data).toEqual({ reason: 'timeout', elapsedMs: 1000 });
    expect(result.toolUseResult).toEqual(result.data);
    expect(result.repeatNeutral).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it.each(['now', 'next'] as const)('wakes on %s input without consuming it', async (priority) => {
    const promise = new SleepTool(config).build({ duration_ms: 1000 }).execute(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(120);
    queue.enqueue(command({ priority }));
    const result = await promise;
    expect(result.data).toEqual({ reason: 'input', elapsedMs: 120 });
    expect(result.repeatNeutral).toBeUndefined();
    expect(queue.getCommandQueue()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('wakes immediately for already queued task notifications', async () => {
    queue.enqueue(command({ commandMode: 'task-notification' }));
    const result = await new SleepTool(config).build({ duration_ms: 1000 }).execute(new AbortController().signal);
    expect(result.data).toEqual({ reason: 'input', elapsedMs: 0 });
    expect(queue.getCommandQueue()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('wakes on legacy input without a session id', async () => {
    queue.enqueue(command({ sessionId: undefined }));
    const result = await new SleepTool(config)
      .build({ duration_ms: 1000 })
      .execute(new AbortController().signal);
    expect(result.data).toEqual({ reason: 'input', elapsedMs: 0 });
    expect(queue.getCommandQueue()).toHaveLength(1);
  });

  it('does not neutralize repeated immediate wakeups', async () => {
    queue.enqueue(command());
    const tool = new SleepTool(config);
    for (let index = 0; index < 3; index++) {
      const result = await tool.build({ duration_ms: 1000 }).execute(new AbortController().signal);
      expect(result.data).toEqual({ reason: 'input', elapsedMs: 0 });
      expect(result.repeatNeutral).toBeUndefined();
    }
    expect(queue.getCommandQueue()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(unsubscribe).toHaveBeenCalledTimes(3);
  });

  it.each([
    { sessionId: 'other' }, { targetAgentId: 'child' }, { priority: 'later' as const },
    { prompt: '/help' }, { commandMode: 'bash' as const }, { commandMode: 'orphaned-permission' as const },
  ])('ignores ineligible input %j', async (overrides) => {
    const promise = new SleepTool(config).build({ duration_ms: 1000 }).execute(new AbortController().signal);
    queue.enqueue(command(overrides));
    await vi.advanceTimersByTimeAsync(1000);
    expect((await promise).data?.['reason']).toBe('timeout');
    expect(queue.getCommandQueue()).toHaveLength(1);
  });

  it('honors skipSlashCommands like request preparation', async () => {
    queue.enqueue(command({ prompt: '/not-a-command', skipSlashCommands: true }));
    expect((await new SleepTool(config).build({ duration_ms: 1000 }).execute(new AbortController().signal)).data?.['reason']).toBe('input');
  });

  it.each([true, false])('cleans up on abort (already aborted: %s)', async (alreadyAborted) => {
    const abort = new AbortController();
    if (alreadyAborted) abort.abort();
    const promise = new SleepTool(config).build({ duration_ms: 1000 }).execute(abort.signal);
    if (!alreadyAborted) abort.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(vi.getTimerCount()).toBe(0);
    expect(unsubscribe).toHaveBeenCalledTimes(alreadyAborted ? 0 : 1);
  });

  it('rejects execution in fork contexts', async () => {
    const result = await runWithAgentContext({ agentId: 'fork', agentType: 'fork' }, () =>
      new SleepTool(config).build({ duration_ms: 1000 }).execute(new AbortController().signal));
    expect(result.error?.message).toContain('only available in the main session');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -1, 1.5, 43_200_001])('rejects invalid duration %s', (duration_ms) => {
    expect(() => new SleepTool(config).build({ duration_ms })).toThrow();
  });

  it('accepts both duration bounds', () => {
    expect(() => new SleepTool(config).build({ duration_ms: 1 })).not.toThrow();
    expect(() => new SleepTool(config).build({ duration_ms: 43_200_000 })).not.toThrow();
  });

  it('rejects a missing duration', () => {
    expect(() => new SleepTool(config).build({} as never)).toThrow();
  });

  it.each(['timeout', 'input'] as const)('integrates %s results with the real repeated-call controller', async (mode) => {
    const controller = new RepeatedToolCallController({ config: {
      ...config, getPermissionMode: () => 'default', getModel: () => 'test-model',
    } as Config });
    const tool = new SleepTool(config);
    const signal = new AbortController().signal;
    if (mode === 'input') queue.enqueue(command());
    let completed = 0;
    for (let i = 0; i < 7; i++) {
      const block = { type: 'tool_use' as const, id: `sleep_${i}`, name: 'Sleep', input: { duration_ms: 1000 } };
      const check = await controller.check(block, { signal });
      if (!check.allowed) {
        expect(mode).toBe('input');
        expect(check.terminalReason).toBe('repeated_tool_call_denied');
        break;
      }
      const waiting = tool.build(block.input).execute(signal);
      if (mode === 'timeout') await vi.advanceTimersByTimeAsync(1000);
      const result = await waiting;
      if (result.repeatNeutral) controller.neutralize(block);
      completed++;
    }
    expect(completed).toBe(mode === 'timeout' ? 7 : 4);
  });
});
