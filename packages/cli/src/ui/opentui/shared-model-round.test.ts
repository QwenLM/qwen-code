/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  SendMessageType,
  type Config,
  type LlmClient,
  type ServerLlmStreamEvent,
  type ToolCallRequestInfo,
} from '@qwen-code/qwen-code-core';
import {
  runAgentLoop,
  type AgentLoopToolExecutor,
} from '@qwen-code/qwen-code-core/core/agent-loop.js';
import { getToolCallFingerprint } from '@qwen-code/qwen-code-core/core/toolCallIdUtils.js';
import {
  sharedModelRound,
  type SharedRoundOptions,
} from './shared-model-round.js';

vi.mock(
  '@qwen-code/qwen-code-core/core/agent-loop.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@qwen-code/qwen-code-core/core/agent-loop.js')
      >();
    return { ...actual, runAgentLoop: vi.fn(actual.runAgentLoop) };
  },
);

const call = (callId: string) => ({
  type: 'tool_call_request',
  value: { callId, name: 'read_file', args: {} },
});

it('bounds early consumer close while the provider is still cleaning up', async () => {
  vi.useFakeTimers();
  try {
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => (finishCleanup = resolve));
    const parent = new AbortController();
    let providerSignal: AbortSignal | undefined;
    const client = {
      async *sendMessageStream(_parts: unknown, signal: AbortSignal) {
        providerSignal = signal;
        try {
          yield { type: 'content', value: 'a' };
        } finally {
          await cleanup;
        }
      },
    } as unknown as LlmClient;
    const shared = sharedModelRound(client, round, parent.signal, {
      config,
      duplicates: { handled: new Map(), responded: new Set() },
      useEventBus: true,
      beforeBatch: () => {},
    });
    const events = shared.events[Symbol.asyncIterator]();
    await events.next();
    const closed = vi.fn();
    void events.return?.().then(closed);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(closed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(closed).toHaveBeenCalledWith({ done: true, value: undefined });
    expect(providerSignal?.aborted).toBe(true);
    expect(parent.signal.aborted).toBe(false);
    expect(shared.result()).toBeUndefined();
    finishCleanup();
    await vi.advanceTimersByTimeAsync(0);
  } finally {
    vi.useRealTimers();
  }
});

it('arms cancellation even when iterator return is queued behind next', async () => {
  vi.useFakeTimers();
  try {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => (release = resolve));
    const client = {
      async *sendMessageStream() {
        await waiting;
        yield { type: 'content', value: 'late' };
      },
    } as unknown as LlmClient;
    const shared = sharedModelRound(
      client,
      round,
      new AbortController().signal,
      {
        config,
        duplicates: { handled: new Map(), responded: new Set() },
        useEventBus: true,
        beforeBatch: () => {},
      },
    );
    const events = shared.events[Symbol.asyncIterator]();
    const next = events.next();
    await vi.advanceTimersByTimeAsync(0);
    const closed = vi.fn();
    void events.return?.().then(closed);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(closed).toHaveBeenCalledWith({ done: true, value: undefined });
    await expect(next).resolves.toEqual({ done: true, value: undefined });
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(shared.result()).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

it('releases an offered event when close follows the parent abort deadline', async () => {
  vi.useFakeTimers();
  try {
    const parent = new AbortController();
    const { client, progress } = fakeClient([{ type: 'content', value: 'a' }]);
    const shared = sharedModelRound(client, round, parent.signal, {
      config,
      duplicates: { handled: new Map(), responded: new Set() },
      useEventBus: true,
      beforeBatch: () => {},
    });
    await shared.events[Symbol.asyncIterator]().next();
    parent.abort();
    await vi.advanceTimersByTimeAsync(10_000);
    await shared.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(progress).toEqual({ pulled: 1, closed: true });
  } finally {
    vi.useRealTimers();
  }
});

/** A client whose one stream yields `events`, noting how far it got. */
function fakeClient(events: Array<Record<string, unknown> | Error>) {
  const progress = { pulled: 0, closed: false };
  const sendMessageStream = vi.fn(async function* (
    _parts: unknown,
    _signal: AbortSignal,
    _promptId: string,
    _options: unknown,
  ) {
    try {
      for (const event of events) {
        progress.pulled++;
        if (event instanceof Error) throw event;
        yield event;
      }
    } finally {
      progress.closed = true;
    }
  });
  return {
    client: {
      sendMessageStream,
      recordCompletedToolCall: vi.fn(),
    } as unknown as LlmClient,
    sendMessageStream,
    progress,
  };
}

const round = {
  parts: [{ text: 'hi' }],
  promptId: 'p1',
  options: { type: SendMessageType.UserQuery },
};

const config = {
  getSessionId: () => 'session',
  getToolOutputBatchBudget: () => Number.POSITIVE_INFINITY,
  getChatRecordingService: () => undefined,
} as unknown as Config;

/** An executor that runs each call to an `ok` result. */
const okExecutor = (): AgentLoopToolExecutor & {
  run: ReturnType<typeof vi.fn>;
} => ({
  run: vi.fn(async (requests, _signal, hooks) =>
    requests.flatMap((request: ToolCallRequestInfo) =>
      hooks.beforeLaunch(request, [])
        ? [
            {
              status: 'success' as const,
              request,
              response: {
                callId: request.callId,
                responseParts: [
                  {
                    functionResponse: {
                      id: request.callId,
                      name: request.name,
                      response: { output: 'ok' },
                    },
                  },
                ],
                resultDisplay: 'ok',
                error: undefined,
                errorType: undefined,
              },
            },
          ]
        : [],
    ),
  ),
});

describe.each([false, true])('sharedModelRound (kernel=%s)', (kernel) => {
  const open = (
    client: LlmClient,
    signal = new AbortController().signal,
    extra: Partial<SharedRoundOptions> = {},
  ) =>
    sharedModelRound(client, round, signal, {
      config,
      duplicates: { handled: new Map(), responded: new Set() },
      useEventBus: kernel,
      beforeBatch: () => {},
      ...extra,
    });

  it('sends the round as given and hands over its events in order', async () => {
    const { client, sendMessageStream } = fakeClient([
      { type: 'content', value: 'a' },
      call('c1'),
      { type: 'finished', value: {} },
    ]);
    const signal = new AbortController().signal;
    const shared = open(client, signal);
    const seen: ServerLlmStreamEvent[] = [];
    for await (const event of shared.events) seen.push(event);
    expect(sendMessageStream).toHaveBeenCalledExactlyOnceWith(
      round.parts,
      kernel ? expect.any(AbortSignal) : signal,
      'p1',
      round.options,
    );
    expect(seen.map((event) => event.type)).toEqual([
      'content',
      'tool_call_request',
      'finished',
    ]);
    expect(shared.result()).toEqual({ calls: [call('c1').value] });
    await shared.close();
  });

  it('reads the next event only once the turn took the one before', async () => {
    const { client, progress } = fakeClient([
      { type: 'content', value: 'a' },
      { type: 'content', value: 'b' },
    ]);
    const shared = open(client);
    const events = shared.events[Symbol.asyncIterator]();
    await events.next();
    // Give the round every chance to read ahead.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(progress.pulled).toBe(1);
    await events.next();
    expect(progress.pulled).toBe(2);
    await events.return?.();
  });

  it('keeps only the calls of the attempt a retry replaced them with', async () => {
    const { client } = fakeClient([
      call('stale'),
      { type: 'retry' },
      call('fresh'),
    ]);
    const shared = open(client);
    for await (const _ of shared.events) {
      // drain
    }
    expect(shared.result()?.calls.map((c) => c.callId)).toEqual(['fresh']);
    await shared.close();
  });

  it('reports the stop reason of a round that detected a loop', async () => {
    const { client } = fakeClient([call('c1'), { type: 'loop_detected' }]);
    const shared = open(client);
    for await (const _ of shared.events) {
      // drain
    }
    expect(shared.result()).toEqual({
      calls: [call('c1').value],
      stop: 'loop_detected',
    });
  });

  it("closes the client's stream when the turn stops reading", async () => {
    const { client, progress } = fakeClient([
      { type: 'content', value: 'a' },
      { type: 'content', value: 'b' },
    ]);
    const shared = open(client);
    for await (const _ of shared.events) break;
    expect(progress.closed).toBe(true);
    expect(progress.pulled).toBe(1);
    expect(shared.result()).toBeUndefined();
  });

  it("rethrows the client's error", async () => {
    const { client, sendMessageStream } = fakeClient([
      { type: 'content', value: 'a' },
      new Error('provider failed'),
    ]);
    const shared = open(client);
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const event of shared.events) seen.push(event.type);
      })(),
    ).rejects.toThrow('provider failed');
    expect(seen).toEqual(['content']);
    expect(shared.result()).toBeUndefined();
    expect(sendMessageStream.mock.calls[0][1].aborted).toBe(false);
  });

  it("runs the round's batch on the executor the turn hands it, in one loop call", async () => {
    const loop = vi.mocked(runAgentLoop);
    loop.mockClear();
    const { client } = fakeClient([call('c1')]);
    const signal = new AbortController().signal;
    const shared = open(client, signal);
    for await (const _ of shared.events) {
      // drain
    }
    const executor = okExecutor();
    const batch = await shared.runBatch(executor);
    expect(executor.run).toHaveBeenCalledOnce();
    expect(executor.run.mock.calls[0][1]).toBe(signal);
    expect(batch.stop).toBeUndefined();
    expect(batch.responses?.map(({ callId }) => callId)).toEqual(['c1']);
    expect(loop).toHaveBeenCalledOnce();
    expect(loop.mock.calls[0][0]).toMatchObject({
      maxRounds: 1,
      useEventBus: kernel,
      keepCancelledResults: true,
      deferRecording: true,
    });
  });

  it('answers a replay in place without running the executor', async () => {
    const { client } = fakeClient([call('c1')]);
    const shared = sharedModelRound(
      client,
      round,
      new AbortController().signal,
      {
        config,
        duplicates: {
          handled: new Map([['c1', getToolCallFingerprint('read_file', {})]]),
          responded: new Set(),
        },
        useEventBus: kernel,
        beforeBatch: () => {},
      },
    );
    for await (const _ of shared.events) {
      // drain
    }
    const executor = okExecutor();
    const batch = await shared.runBatch(executor);
    expect(executor.run).not.toHaveBeenCalled();
    expect(shared.answered.map(({ request }) => request.callId)).toEqual([
      'c1',
    ]);
    expect(batch.responses?.map(({ callId }) => callId)).toEqual(['c1']);
  });

  it('calls beforeBatch only when the turn hands off a batch to run', async () => {
    for (const [events, expected] of [
      [[call('c1')], 1],
      [[{ type: 'content', value: 'a' }], 0],
      [[call('c1'), { type: 'loop_detected' }], 0],
    ] as const) {
      const { client } = fakeClient([...events]);
      const beforeBatch = vi.fn();
      const shared = open(client, undefined, { beforeBatch });
      for await (const _ of shared.events) {
        // drain
      }
      expect(beforeBatch).not.toHaveBeenCalled();
      await shared.runBatch(okExecutor());
      expect(beforeBatch).toHaveBeenCalledTimes(expected);
    }
  });

  it('settles the run, running nothing, when the turn closes the round', async () => {
    const { client } = fakeClient([call('c1')]);
    const beforeBatch = vi.fn();
    const shared = open(client, undefined, { beforeBatch });
    for await (const _ of shared.events) {
      // drain
    }
    // The batch waits for an executor the turn never hands it.
    await shared.close();
    const executor = okExecutor();
    await expect(shared.runBatch(executor)).resolves.toEqual({
      parts: [],
      stop: 'surface_ended',
    });
    expect(beforeBatch).not.toHaveBeenCalled();
    expect(executor.run).not.toHaveBeenCalled();
    expect(shared.answered).toEqual([]);
  });

  it('settles the run when the turn closes the round mid-stream', async () => {
    const { client, progress } = fakeClient([
      { type: 'content', value: 'a' },
      call('c1'),
    ]);
    const shared = open(client);
    for await (const _ of shared.events) break;
    await expect(shared.close()).resolves.toBeUndefined();
    expect(progress.closed).toBe(true);
  });
});
