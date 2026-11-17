/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import {
  BTW_HISTORY_LIMIT,
  BtwSession,
  getBtwSession,
  runBtwQuery,
  type BtwRunParams,
  type BtwRunResult,
} from './btw-session.js';
import { runForkedAgent, type CachePathParams } from './forkedAgent.js';

vi.mock('./forkedAgent.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./forkedAgent.js')>()),
  runForkedAgent: vi.fn(),
}));

const config = { getSessionId: () => 'session-a' } as unknown as Config;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A runner whose calls stay pending until the test settles them. */
function controlledRunner() {
  const calls: Array<{
    params: BtwRunParams;
    result: ReturnType<typeof deferred<BtwRunResult | null>>;
  }> = [];
  const runner = vi.fn((params: BtwRunParams) => {
    const result = deferred<BtwRunResult | null>();
    calls.push({ params, result });
    params.signal.addEventListener('abort', () =>
      result.reject(new DOMException('aborted', 'AbortError')),
    );
    return result.promise;
  });
  return { runner, calls };
}

const answer = (text: string): BtwRunResult => ({ text });

describe('BtwSession', () => {
  it('threads answered exchanges into later questions', async () => {
    const { runner, calls } = controlledRunner();
    const session = new BtwSession(config, runner);

    const first = session.ask('first?');
    calls[0].result.resolve(answer('one'));
    await first.done;
    const second = session.ask('second?');

    expect(calls[0].params.history).toEqual([]);
    expect(calls[1].params.history).toEqual([
      { question: 'first?', response: 'one' },
    ]);
    calls[1].result.resolve(answer('two'));
    await second.done;
    expect(session.getSnapshot().exchanges.map((e) => e.response)).toEqual([
      'one',
      'two',
    ]);
  });

  it('runs questions concurrently and records them in completion order', async () => {
    const { runner, calls } = controlledRunner();
    const session = new BtwSession(config, runner);

    const slow = session.ask('slow?');
    const fast = session.ask('fast?');
    calls[1].result.resolve(answer('fast answer'));
    await fast.done;
    calls[0].result.resolve(answer('slow answer'));
    await slow.done;

    expect(session.getSnapshot().exchanges.map((e) => e.question)).toEqual([
      'fast?',
      'slow?',
    ]);
  });

  it('keeps only the newest answered exchanges', async () => {
    const runner = vi.fn(async (params: BtwRunParams) =>
      answer(`a:${params.question}`),
    );
    const session = new BtwSession(config, runner);

    for (let index = 0; index < BTW_HISTORY_LIMIT + 2; index += 1) {
      await session.ask(`q${index}`).done;
    }

    const { exchanges } = session.getSnapshot();
    expect(exchanges).toHaveLength(BTW_HISTORY_LIMIT);
    expect(exchanges[0].question).toBe('q2');
  });

  it('does not record tool-call, empty, failed, unavailable or cancelled outcomes', async () => {
    const results: Array<() => Promise<BtwRunResult | null>> = [
      async () => ({ text: null, toolCallName: 'shell' }),
      async () => ({ text: '  ' }),
      async () => {
        throw new Error('boom');
      },
      async () => null,
    ];
    const runner = vi.fn(() => results.shift()!());
    const session = new BtwSession(config, runner);

    expect(await session.ask('tool?').done).toMatchObject({
      kind: 'tool-call',
      toolName: 'shell',
    });
    expect(await session.ask('empty?').done).toEqual({ kind: 'empty' });
    expect(await session.ask('fail?').done).toMatchObject({
      kind: 'failed',
      error: 'boom',
    });
    expect(await session.ask('none?').done).toEqual({ kind: 'unavailable' });

    const { runner: pending } = controlledRunner();
    const cancelling = new BtwSession(config, pending);
    const request = cancelling.ask('cancel?');
    cancelling.abort(request.id);
    expect(await request.done).toEqual({ kind: 'cancelled' });

    expect(session.getSnapshot().exchanges).toEqual([]);
    expect(cancelling.getSnapshot().exchanges).toEqual([]);
  });

  it('accumulates streamed text and rewinds it on a restarting retry', async () => {
    const { runner, calls } = controlledRunner();
    const onReset = vi.fn();
    const onText = vi.fn();
    const session = new BtwSession(config, runner, () => 1_000);
    const { id, done } = session.ask('q?', { onText, onReset });
    const { params } = calls[0];

    await params.onText('hel');
    await params.onText('lo');
    expect(session.getRequest(id)?.streamingText).toBe('hello');

    await params.onRetry({
      restart: true,
      retryInfo: {
        attempt: 1,
        maxRetries: 3,
        delayMs: 2_000,
        message: 'Rate limited',
        skipDelay: () => {},
      },
    });
    expect(session.getRequest(id)).toMatchObject({
      streamingText: '',
      retry: {
        attempt: 1,
        maxRetries: 3,
        message: 'Rate limited',
        retryAt: 3_000,
      },
    });
    expect(onReset).toHaveBeenCalledTimes(1);

    await params.onText('again');
    expect(session.getRequest(id)).toMatchObject({
      streamingText: 'again',
      retry: null,
    });
    expect(onText.mock.calls.map(([text]) => text)).toEqual([
      'hel',
      'lo',
      'again',
    ]);
    calls[0].result.resolve(answer('again'));
    expect(await done).toEqual({ kind: 'answered', response: 'again' });
  });

  it('settles a cancelled request once even if the runner resolves later', async () => {
    const calls: Array<(value: BtwRunResult) => void> = [];
    const runner = vi.fn(
      () =>
        new Promise<BtwRunResult>((resolve) => {
          calls.push(resolve);
        }),
    );
    const session = new BtwSession(config, runner);
    const { id, done } = session.ask('q?');

    session.abort(id);
    calls[0](answer('late'));

    expect(await done).toEqual({ kind: 'cancelled' });
    expect(session.getSnapshot().exchanges).toEqual([]);
  });

  it('honors an external abort signal', async () => {
    const { runner } = controlledRunner();
    const session = new BtwSession(config, runner);
    const controller = new AbortController();
    const { done } = session.ask('q?', { signal: controller.signal });

    controller.abort();

    expect(await done).toEqual({ kind: 'cancelled' });
  });

  it('reopens the newest running request, else the newest answer', async () => {
    const { runner, calls } = controlledRunner();
    const session = new BtwSession(config, runner);
    expect(session.getReopenTargetId()).toBeUndefined();

    const first = session.ask('first?');
    calls[0].result.resolve(answer('one'));
    await first.done;
    expect(session.getReopenTargetId()).toBe(first.id);

    const running = session.ask('second?');
    expect(session.getReopenTargetId()).toBe(running.id);
  });

  it('removes only the given exchanges', async () => {
    const runner = vi.fn(async (params: BtwRunParams) =>
      answer(params.question),
    );
    const session = new BtwSession(config, runner);
    const a = session.ask('a');
    await a.done;
    const b = session.ask('b');
    await b.done;

    session.removeExchanges([a.id]);

    expect(session.getSnapshot().exchanges.map((e) => e.id)).toEqual([b.id]);
  });

  it('reports usage from the run', async () => {
    const usage = { model: 'm', inputTokens: 3, outputTokens: 2 };
    const session = new BtwSession(config, async () => ({
      text: 'ok',
      usage,
    }));

    expect(await session.ask('q?').done).toEqual({
      kind: 'answered',
      response: 'ok',
      usage,
    });
  });
});

describe('getBtwSession', () => {
  it('returns one session per session id and disposes the previous one', () => {
    let sessionId = 'one';
    const owner = { getSessionId: () => sessionId } as unknown as Config;

    const first = getBtwSession(owner);
    expect(getBtwSession(owner)).toBe(first);
    const dispose = vi.spyOn(first, 'dispose');

    sessionId = 'two';
    const second = getBtwSession(owner);

    expect(second).not.toBe(first);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

describe('runBtwQuery', () => {
  it('forks the full history with tools declared but function calls disabled', async () => {
    const getHistory = vi.fn(() => [
      { role: 'user', parts: [{ text: 'main' }] },
    ]);
    const getHistoryTail = vi.fn(() => []);
    const owner = {
      getModel: () => 'qwen',
      getLlmClient: () => ({
        getChat: () => ({
          getGenerationConfig: () => ({}),
          getHistory,
          getHistoryTail,
        }),
      }),
    } as unknown as Config;
    vi.mocked(runForkedAgent).mockResolvedValue({
      text: 'answer',
      model: 'qwen',
      usage: { inputTokens: 1, outputTokens: 2 },
    } as unknown as Awaited<ReturnType<typeof runForkedAgent>>);

    const result = await runBtwQuery({
      config: owner,
      question: 'why?',
      history: [{ question: 'first?', response: 'one' }],
      signal: new AbortController().signal,
      onText: async () => {},
      onRetry: async () => {},
    });

    expect(getHistory).toHaveBeenCalledWith(true);
    expect(getHistoryTail).not.toHaveBeenCalled();
    const params = vi.mocked(runForkedAgent).mock
      .calls[0][0] as unknown as CachePathParams;
    expect(params).toMatchObject({
      fullHistory: true,
      preserveTools: true,
      disableFunctionCalls: true,
    });
    expect(params.cacheSafeParams.history).toEqual([
      { role: 'user', parts: [{ text: 'main' }] },
      { role: 'user', parts: [{ text: 'first?' }] },
      { role: 'model', parts: [{ text: 'one' }] },
    ]);
    expect(result).toEqual({
      text: 'answer',
      toolCallName: undefined,
      usage: { model: 'qwen', inputTokens: 1, outputTokens: 2 },
    });
  });
});
