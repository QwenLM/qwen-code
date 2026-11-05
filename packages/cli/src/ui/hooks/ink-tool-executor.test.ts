/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { ToolCallRequestInfo } from '@qwen-code/qwen-code-core/core/turn.js';
import type { InteractiveToolCall } from '../../services/interactive-mod-tool-scheduler.js';
import { createInkToolExecutor } from './ink-tool-executor.js';
import type { ScheduleFn } from './useReactToolScheduler.js';

const request = (callId: string): ToolCallRequestInfo =>
  ({
    callId,
    name: 'read_file',
    args: {},
    isClientInitiated: false,
    prompt_id: 'prompt-1',
  }) as ToolCallRequestInfo;

const completed = (
  call: ToolCallRequestInfo,
  status: 'success' | 'error' | 'cancelled',
  nativeAttemptsObserved?: boolean,
) =>
  ({
    status,
    request: call,
    response: {
      callId: call.callId,
      responseParts: [],
      resultDisplay: undefined,
      error: undefined,
      errorType: undefined,
    },
    nativeAttemptsObserved,
  }) as unknown as InteractiveToolCall;

const hooks = (refuse: string[] = []) => ({
  beforeLaunch: vi.fn(
    (call: ToolCallRequestInfo) => !refuse.includes(call.callId),
  ),
  output: vi.fn(),
});

describe('createInkToolExecutor', () => {
  it('schedules the launched calls as one batch and returns them settled', async () => {
    const onSettled = vi.fn();
    const schedule = vi.fn<ScheduleFn>(
      (requests, _signal, _modelOverride, onBatchComplete) => {
        const calls = requests as ToolCallRequestInfo[];
        void onBatchComplete?.([
          completed(calls[0], 'success', true),
          completed(calls[1], 'cancelled'),
          completed(calls[2], 'error'),
        ]);
      },
    );
    const signal = new AbortController().signal;
    const executor = createInkToolExecutor(schedule, 'model\0', onSettled);

    const settled = await executor.run(
      [request('a'), request('b'), request('c'), request('refused')],
      signal,
      hooks(['refused']),
    );

    expect(schedule).toHaveBeenCalledOnce();
    expect(schedule.mock.calls[0][0]).toEqual([
      request('a'),
      request('b'),
      request('c'),
    ]);
    expect(schedule.mock.calls[0][1]).toBe(signal);
    expect(schedule.mock.calls[0][2]).toBe('model\0');
    expect(onSettled).toHaveBeenCalledOnce();
    expect(
      settled.map(({ request, status, recorded }) => [
        request.callId,
        status,
        recorded,
      ]),
    ).toEqual([
      // The middleware counted a; the TUI counts the cancelled b itself.
      ['a', 'success', true],
      ['b', 'cancelled', true],
      ['c', 'error', false],
    ]);
  });

  it('settles the batch when onSettled throws', async () => {
    let callbackResult: Promise<void> | undefined;
    const schedule = vi.fn<ScheduleFn>(
      (requests, _signal, _modelOverride, onBatchComplete) => {
        const calls = requests as ToolCallRequestInfo[];
        callbackResult = onBatchComplete?.([completed(calls[0], 'success')]);
      },
    );
    const executor = createInkToolExecutor(schedule, undefined, () => {
      throw new Error('Chat not initialized');
    });

    const settled = await executor.run(
      [request('a')],
      new AbortController().signal,
      hooks(),
    );

    expect(settled.map(({ request }) => request.callId)).toEqual(['a']);
    await expect(callbackResult).rejects.toThrow('Chat not initialized');
  });

  it("settles the batch once onSettled's promise does, without holding the scheduler's callback", async () => {
    let callbackResult: Promise<void> | undefined;
    const schedule = vi.fn<ScheduleFn>(
      (requests, _signal, _modelOverride, onBatchComplete) => {
        const calls = requests as ToolCallRequestInfo[];
        callbackResult = onBatchComplete?.([completed(calls[0], 'success')]);
      },
    );
    let release!: () => void;
    const executor = createInkToolExecutor(
      schedule,
      undefined,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    let settled = false;
    const run = executor
      .run([request('a')], new AbortController().signal, hooks())
      .then((calls) => {
        settled = true;
        return calls;
      });

    await callbackResult;
    await Promise.resolve();
    expect(settled).toBe(false);

    release();
    expect((await run).map(({ request }) => request.callId)).toEqual(['a']);
  });

  it('settles the batch when the promise onSettled returns rejects', async () => {
    const schedule = vi.fn<ScheduleFn>(
      (requests, _signal, _modelOverride, onBatchComplete) => {
        const calls = requests as ToolCallRequestInfo[];
        void onBatchComplete?.([completed(calls[0], 'success')]);
      },
    );
    const executor = createInkToolExecutor(schedule, undefined, () =>
      Promise.reject(new Error('lost')),
    );

    const settled = await executor.run(
      [request('a')],
      new AbortController().signal,
      hooks(),
    );

    expect(settled.map(({ request }) => request.callId)).toEqual(['a']);
  });

  it('schedules nothing when every launch is refused', async () => {
    const schedule = vi.fn<ScheduleFn>();
    const executor = createInkToolExecutor(schedule, undefined, vi.fn());

    const settled = await executor.run(
      [request('a')],
      new AbortController().signal,
      hooks(['a']),
    );

    expect(settled).toEqual([]);
    expect(schedule).not.toHaveBeenCalled();
  });
});
