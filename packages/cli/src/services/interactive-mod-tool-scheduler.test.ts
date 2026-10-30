/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { AsyncResource } from 'node:async_hooks';
import {
  runWithHookExecutionOwner,
  getHookExecutionOwner,
} from '@qwen-code/qwen-code-core/hooks/hook-execution-context.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MockTool } from '@qwen-code/qwen-code-core';
import type {
  Config,
  CompletedToolCall,
  ToolCallRequestInfo,
} from '@qwen-code/qwen-code-core';
import type { ModToolCall } from '@qwen-code/qwen-code-core/mods/tool-events.js';
import {
  InteractiveModToolScheduler,
  type InteractiveCompletedToolCall,
} from './interactive-mod-tool-scheduler.js';

const mocks = vi.hoisted(() => ({ session: vi.fn(), schedule: vi.fn() }));
vi.mock('./interactive-mod-session.js', () => ({
  getInteractiveModSession: mocks.session,
}));
vi.mock(
  '@qwen-code/qwen-code-core/core/coreToolScheduler.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@qwen-code/qwen-code-core/core/coreToolScheduler.js')
      >();
    return {
      ...actual,
      CoreToolScheduler: class {
        constructor(private readonly options: Record<string, unknown>) {}
        schedule(
          request: ToolCallRequestInfo,
          signal: AbortSignal,
          view: unknown,
        ) {
          return mocks.schedule(this.options, request, signal, view);
        }
      },
    };
  },
);

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup(middleware?: ModToolCall, ready = Promise.resolve()) {
  const generation = new AbortController();
  mocks.session.mockReturnValue({
    ready,
    toolCall: () => middleware,
    captureToolSignal: () => generation.signal,
  });
  const config = {
    getHookSystem: () => undefined,
    getSessionId: () => 'session',
    getToolRegistry: () => ({
      getTool: () => ({}),
      getAllToolNames: () => ['read_file'],
    }),
  } as unknown as Config;
  const complete = vi.fn(async (_calls: InteractiveCompletedToolCall[]) => {});
  const update = vi.fn();
  const observe = vi.fn(async (_call: CompletedToolCall) => {});
  const scheduler = new InteractiveModToolScheduler({
    config,
    getPreferredEditor: () => undefined,
    onEditorClose: () => {},
    onAllToolCallsComplete: complete,
    onToolCallsUpdate: update,
    onNativeAttempt: observe,
  });
  const request: ToolCallRequestInfo = {
    callId: 'call',
    name: 'read_file',
    args: { file_path: 'A' },
    isClientInitiated: false,
    prompt_id: 'turn',
  };
  const tool = new MockTool({
    name: 'read_file',
    execute: async () => ({ llmContent: 'native', returnDisplay: 'native' }),
  });
  const finish = (
    options: {
      onAllToolCallsComplete: (calls: CompletedToolCall[]) => Promise<void>;
    },
    native: ToolCallRequestInfo,
  ) =>
    options.onAllToolCallsComplete([
      {
        status: 'success',
        tool,
        invocation: tool.build(native.args),
        request: native,
        response: {
          callId: native.callId,
          responseParts: [
            {
              functionResponse: {
                id: native.callId,
                name: native.name,
                response: { output: native.args['file_path'] },
              },
            },
          ],
          resultDisplay: undefined,
          error: undefined,
          errorType: undefined,
          executionStatus: 'success',
        },
      },
    ]);
  mocks.schedule.mockImplementation(async (options, native) =>
    finish(options, native),
  );
  return {
    config,
    scheduler,
    complete,
    update,
    observe,
    request,
    generation,
    finish,
  };
}
const signal = () => new AbortController().signal;
const check: Parameters<Parameters<ModToolCall>[1]>[2] = async (
  _input,
  verdict,
) => verdict;
beforeEach(() => vi.resetAllMocks());

describe('interactive Mod logical scheduler', () => {
  it.each([false, true])(
    'settles synthetic/deny without inventing invocation (deny=%s)',
    async (deny) => {
      const test = setup(async () =>
        deny ? { deny: 'blocked' } : { result: { output: 'synthetic' } },
      );
      await test.scheduler.schedule(test.request, signal());
      expect(mocks.schedule).not.toHaveBeenCalled();
      expect(test.observe).not.toHaveBeenCalled();
      expect(test.complete).toHaveBeenCalledOnce();
      const [call] = test.complete.mock.calls[0][0];
      expect(call.status).toBe(deny ? 'error' : 'success');
      expect(call.response.executionStatus).toBe('not_started');
      expect(call.tool).toBeUndefined();
      expect(call.invocation).toBeUndefined();
    },
  );
  it('waits for ready, real completion and Mod unwind', async () => {
    const startup = deferred();
    const native = deferred();
    const unwind = deferred();
    const test = setup(async (input, next, active) => {
      const result = await next(input, active, check);
      await unwind.promise;
      return result;
    }, startup.promise);
    mocks.schedule.mockImplementation(async (options, request) => {
      void native.promise.then(() => test.finish(options, request));
    });
    const run = test.scheduler.schedule(test.request, signal());
    await Promise.resolve();
    expect(mocks.schedule).not.toHaveBeenCalled();
    startup.resolve();
    await vi.waitFor(() => expect(mocks.schedule).toHaveBeenCalledOnce());
    expect(test.complete).not.toHaveBeenCalled();
    native.resolve();
    await vi.waitFor(() => expect(test.observe).toHaveBeenCalledOnce());
    expect(test.complete).not.toHaveBeenCalled();
    expect(test.update.mock.lastCall?.[0][0].status).toBe('scheduled');
    unwind.resolve();
    await run;
    expect(test.complete).toHaveBeenCalledOnce();
  });
  it('observes every attempt even when selecting an earlier result', async () => {
    const test = setup(async (input, next, active) => {
      const first = await next(input, active, check);
      await next({ ...input, file_path: 'B' }, active, check);
      return first;
    });
    await test.scheduler.schedule(test.request, signal());
    expect(mocks.schedule).toHaveBeenCalledTimes(2);
    expect(mocks.schedule.mock.calls[0][0]).not.toBe(
      mocks.schedule.mock.calls[1][0],
    );
    expect(
      test.observe.mock.calls.map(([call]) => call.request.args['file_path']),
    ).toEqual(['A', 'B']);
    expect(test.complete).toHaveBeenCalledOnce();
    expect(
      test.complete.mock.calls[0][0][0].response.responseParts[0]
        .functionResponse?.response,
    ).toEqual({ output: 'A' });
  });
  it.each(['abort', 'reject'])(
    'settles pending startup on %s',
    async (kind) => {
      const startup = deferred();
      const test = setup(async () => ({ result: {} }), startup.promise);
      const controller = new AbortController();
      const run = test.scheduler.schedule(test.request, controller.signal);
      await Promise.resolve();
      if (kind === 'abort') controller.abort();
      else startup.reject(new Error('startup failed'));
      await run;
      expect(mocks.schedule).not.toHaveBeenCalled();
      expect(test.complete).toHaveBeenCalledOnce();
      expect(test.complete.mock.calls[0][0][0].status).toBe(
        kind === 'abort' ? 'cancelled' : 'error',
      );
    },
  );
  it('drains a queued cancellation without starting its middleware', async () => {
    const unwind = deferred();
    let count = 0;
    const test = setup(async () => {
      if (++count === 1) await unwind.promise;
      return { result: {} };
    });
    const first = test.scheduler.schedule(test.request, signal());
    await vi.waitFor(() => expect(count).toBe(1));
    const controller = new AbortController();
    const second = test.scheduler.schedule(
      { ...test.request, callId: 'second' },
      controller.signal,
    );
    controller.abort();
    unwind.resolve();
    await Promise.all([first, second]);
    expect(count).toBe(1);
    expect(test.complete).toHaveBeenCalledTimes(2);
    expect(test.complete.mock.calls[1][0][0].status).toBe('cancelled');
  });
  it('waits for old native cleanup but never delivers to a replacement session', async () => {
    const drained = deferred();
    const test = setup(async (input, next, active) =>
      next(input, active, check),
    );
    mocks.schedule.mockImplementation(async (options, request, active) => {
      active.addEventListener(
        'abort',
        () => {
          void drained.promise.then(() => test.finish(options, request));
        },
        { once: true },
      );
    });
    const run = test.scheduler.schedule(test.request, signal());
    await vi.waitFor(() => expect(mocks.schedule).toHaveBeenCalledOnce());
    test.generation.abort();
    expect(test.update.mock.lastCall?.[0]).toEqual([]);
    let finished = false;
    const rejected = run.catch((error: unknown) => {
      finished = true;
      return error;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    drained.resolve();
    expect(await rejected).toBe(test.generation.signal.reason);
    expect(test.complete).not.toHaveBeenCalled();
    expect(test.observe).not.toHaveBeenCalled();
  });
  it('re-enters the captured hook owner at the native boundary after a worker-context hop', async () => {
    const hostOperation = new AsyncResource('Mod worker host operation');
    const owner = Object.freeze({
      runtimeId: 'runtime',
      sessionId: 'session',
      agentId: null,
    });
    const test = setup((input, next, active) =>
      hostOperation.runInAsyncScope(() => next(input, active, check)),
    );
    vi.spyOn(test.config, 'getHookSystem').mockReturnValue({
      runtimeId: 'runtime',
    } as ReturnType<Config['getHookSystem']>);
    const seen: unknown[] = [];
    mocks.schedule.mockImplementation(async (options, request) => {
      seen.push(getHookExecutionOwner());
      await test.finish(options, request);
    });
    try {
      await runWithHookExecutionOwner(owner, () =>
        test.scheduler.schedule(test.request, signal()),
      );
      expect(seen).toHaveLength(1);
      expect(seen[0]).toBe(owner);
    } finally {
      hostOperation.emitDestroy();
    }
  });

  it('retains real execution facts if a physical observer fails', async () => {
    const test = setup(async (input, next, active) =>
      next(input, active, check),
    );
    test.observe.mockRejectedValue(new Error('refresh failed'));
    await test.scheduler.schedule(test.request, signal());
    expect(mocks.schedule).toHaveBeenCalledOnce();
    expect(test.complete.mock.calls[0][0][0].response.executionStatus).toBe(
      'success',
    );
  });

  it('clears the display before awaiting the model continuation callback', async () => {
    const continuation = deferred();
    const test = setup(async () => ({ result: { output: 'synthetic' } }));
    test.complete.mockImplementation(async () => {
      await continuation.promise;
    });
    const run = test.scheduler.schedule(test.request, signal());
    await vi.waitFor(() => expect(test.complete).toHaveBeenCalledOnce());
    expect(test.update.mock.lastCall?.[0]).toEqual([]);
    continuation.resolve();
    await run;
  });

  it('preserves one native scheduler for command-only, client and disabled paths', async () => {
    const test = setup();
    await test.scheduler.schedule(test.request, signal());
    await test.scheduler.schedule(
      { ...test.request, isClientInitiated: true },
      signal(),
    );
    mocks.session.mockReturnValue(undefined);
    await test.scheduler.schedule(test.request, signal());
    expect(mocks.schedule).toHaveBeenCalledTimes(3);
    expect(mocks.schedule.mock.calls[0][0]).toBe(
      mocks.schedule.mock.calls[1][0],
    );
    expect(mocks.schedule.mock.calls[1][0]).toBe(
      mocks.schedule.mock.calls[2][0],
    );
    expect(test.observe).not.toHaveBeenCalled();
  });
});
