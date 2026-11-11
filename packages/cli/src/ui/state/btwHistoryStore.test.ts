/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  QueryEvent,
  SideQuestionParams,
  SideQuestionResult,
} from '@qwen-code/core';
import { BTW_HISTORY_LIMIT, BtwHistoryStore } from './btwHistoryStore.js';

interface PendingCall {
  params: SideQuestionParams;
  resolve: (result: SideQuestionResult) => void;
  reject: (error: unknown) => void;
}

function createStore(now: () => number = () => 1_000) {
  const calls: PendingCall[] = [];
  const runner = vi.fn(
    (params: SideQuestionParams) =>
      new Promise<SideQuestionResult>((resolve, reject) => {
        calls.push({ params, resolve, reject });
      }),
  );
  return { store: new BtwHistoryStore(runner, now), runner, calls };
}

function result(textContent: string, synthetic = false): SideQuestionResult {
  return {
    textContent,
    synthetic,
    totalUsage: {} as SideQuestionResult['totalUsage'],
  };
}

function textDelta(text: string): QueryEvent {
  return {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    },
  };
}

function apiRetry(delayMs: number): QueryEvent {
  return {
    type: 'system',
    subtype: 'api_retry',
    attempt: 2,
    max_retries: 5,
    retry_delay_ms: delayMs,
    error_status: 429,
    uuid: 'retry',
    timestamp: '2026-09-13T00:00:00.000Z',
    content: '',
  } as unknown as QueryEvent;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('BtwHistoryStore', () => {
  it('records an answer once and threads it into the next question', async () => {
    const { store, calls } = createStore();

    const firstId = store.ask('What are we building?', {
      sessionId: 'btw-test-session',
      config: {} as SideQuestionParams['config'],
    });
    calls[0].params.onEvent?.(textDelta('A session'));
    expect(store.getSnapshot().requests[0].streamingText).toBe('A session');
    calls[0].resolve(result('A session cache.'));
    await flush();

    expect(store.getSnapshot().requests[0]).toMatchObject({
      streamingText: '',
      outcome: { kind: 'answered', response: 'A session cache.' },
    });
    expect(store.getSnapshot().exchanges).toEqual([
      {
        id: firstId,
        question: 'What are we building?',
        response: 'A session cache.',
      },
    ]);

    store.ask('Where does it live?', {
      sessionId: 'btw-test-session',
      config: {} as SideQuestionParams['config'],
    });
    expect(calls[1].params.history).toEqual([
      { question: 'What are we building?', response: 'A session cache.' },
    ]);
    expect(calls[1].params).not.toHaveProperty('model');
  });

  it('keeps synthetic, empty and failed outcomes out of history', async () => {
    const { store, calls } = createStore();

    const syntheticId = store.ask('a', {
      sessionId: 'btw-test-session',
      config: {} as SideQuestionParams['config'],
    });
    const emptyId = store.ask('b', {
      sessionId: 'btw-test-session',
      config: {} as SideQuestionParams['config'],
    });
    const failedId = store.ask('c', {
      sessionId: 'btw-test-session',
      config: {} as SideQuestionParams['config'],
    });
    calls[0].resolve(result('(API error: overloaded)', true));
    calls[1].resolve(result('   '));
    calls[2].reject(new Error('boom'));
    await flush();

    const { exchanges, requests } = store.getSnapshot();
    expect(exchanges).toEqual([]);
    const outcomeOf = (id: string) =>
      requests.find((request) => request.id === id)?.outcome;
    expect(outcomeOf(syntheticId)).toEqual({
      kind: 'synthetic',
      response: '(API error: overloaded)',
    });
    expect(outcomeOf(emptyId)).toEqual({ kind: 'empty' });
    expect(outcomeOf(failedId)).toEqual({ kind: 'failed', error: 'boom' });
  });

  it('streams text, rolls back retried calls and clears retry state', () => {
    let now = 1_000;
    const { store, calls } = createStore(() => now);
    const id = store.ask('q', {
      sessionId: 'btw-test-session',
      config: {} as SideQuestionParams['config'],
    });
    const emit = (event: QueryEvent) => calls[0].params.onEvent?.(event);
    const request = () =>
      store.getSnapshot().requests.find((entry) => entry.id === id);

    emit({ type: 'request_start' });
    emit(textDelta('Hello '));
    emit({ type: 'request_start' });
    emit(textDelta('partial'));
    emit({ type: 'result_text_reset', reason: 'malformed_tool_use_retry' });
    expect(request()?.streamingText).toBe('Hello ');

    emit(textDelta('again'));
    now = 2_000;
    emit(apiRetry(750));
    expect(request()?.streamingText).toBe('Hello ');
    expect(request()?.retry).toEqual({
      attempt: 2,
      maxRetries: 5,
      status: 429,
      retryAt: 2_750,
    });

    emit(textDelta('done'));
    expect(request()?.streamingText).toBe('Hello done');
    expect(request()?.retry).toBeNull();
  });

  it('cancels a running request and ignores its late answer', async () => {
    const { store, calls } = createStore();
    const id = store.ask('q', {
      sessionId: 'btw-test-session',
      config: {} as SideQuestionParams['config'],
    });
    calls[0].params.onEvent?.(textDelta('partial answer'));

    store.abort(id);
    expect(store.getSnapshot().requests[0].streamingText).toBe('');
    expect(calls[0].params.signal?.aborted).toBe(true);
    calls[0].resolve(result('too late'));
    await flush();

    const { exchanges, requests } = store.getSnapshot();
    expect(exchanges).toEqual([]);
    expect(requests[0].outcome).toEqual({ kind: 'cancelled' });
  });

  it('drops history and late answers when the session changes', async () => {
    const { store, calls } = createStore();
    store.bindSession('session-a');
    store.ask('kept?', {
      sessionId: 'btw-test-session',
      config: {} as SideQuestionParams['config'],
    });
    calls[0].resolve(result('yes'));
    await flush();
    store.bindSession('session-a');
    expect(store.getSnapshot().exchanges).toHaveLength(1);

    store.ask('running', {
      sessionId: 'btw-test-session',
      config: {} as SideQuestionParams['config'],
    });
    store.bindSession('session-b');
    expect(calls[1].params.signal?.aborted).toBe(true);
    calls[1].resolve(result('from the old session'));
    await flush();

    expect(store.getSnapshot()).toEqual({ exchanges: [], requests: [] });
  });

  it('ignores old events and completions while a new session request runs', async () => {
    const { store, calls } = createStore();
    store.ask('old question', {
      sessionId: 'btw-test-session',
      config: {} as SideQuestionParams['config'],
    });
    store.reset();
    const currentId = store.ask('new question', {
      sessionId: 'btw-test-session',
      config: {} as SideQuestionParams['config'],
    });
    calls[1].params.onEvent?.(textDelta('current text'));
    const snapshot = store.getSnapshot();

    calls[0].params.onEvent?.(textDelta('late text'));
    calls[0].params.onEvent?.(apiRetry(1_000));
    calls[0].resolve(result('late answer'));
    await flush();

    expect(store.getSnapshot()).toBe(snapshot);
    store.abort(currentId);
    expect(calls[1].params.signal?.aborted).toBe(true);
  });

  it('caps history at the most recent exchanges', async () => {
    const { store, calls } = createStore();
    for (let index = 0; index < BTW_HISTORY_LIMIT + 3; index += 1) {
      store.ask(`q${index}`, {
        sessionId: 'btw-test-session',
        config: {} as SideQuestionParams['config'],
      });
      calls[index].resolve(result(`a${index}`));
    }
    await flush();

    const { exchanges, requests } = store.getSnapshot();
    expect(exchanges).toHaveLength(BTW_HISTORY_LIMIT);
    expect(exchanges[0].question).toBe('q3');
    expect(requests).toHaveLength(BTW_HISTORY_LIMIT);
  });

  it('removes only the given exchanges', async () => {
    const { store, calls } = createStore();
    const first = store.ask('first', {
      sessionId: 'btw-test-session',
      config: {} as SideQuestionParams['config'],
    });
    const second = store.ask('second', {
      sessionId: 'btw-test-session',
      config: {} as SideQuestionParams['config'],
    });
    calls[0].resolve(result('1'));
    calls[1].resolve(result('2'));
    await flush();

    store.removeExchanges([first]);

    expect(store.getSnapshot().exchanges.map((entry) => entry.id)).toEqual([
      second,
    ]);
  });

  it('reopens the newest running request before the last answer', async () => {
    const { store, calls } = createStore();
    expect(store.getReopenTargetId()).toBeUndefined();

    const answered = store.ask('answered', {
      sessionId: 'btw-test-session',
      config: {} as SideQuestionParams['config'],
    });
    calls[0].resolve(result('done'));
    await flush();
    expect(store.getReopenTargetId()).toBe(answered);

    const running = store.ask('running', {
      sessionId: 'btw-test-session',
      config: {} as SideQuestionParams['config'],
    });
    expect(store.getReopenTargetId()).toBe(running);
  });
});
