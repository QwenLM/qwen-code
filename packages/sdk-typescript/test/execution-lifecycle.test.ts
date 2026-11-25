/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import {
  createExecutionLifecycleState,
  extractExecutionLifecycle,
  reduceExecutionLifecycle,
} from '../src/daemon/ui/execution-lifecycle.js';
import { normalizeDaemonEvent } from '../src/daemon/ui/normalizer.js';

const started = {
  v: 1,
  kind: 'request',
  executionId: 'exec',
  sessionId: 'session',
  promptId: 'prompt',
  model: 'model',
  startedAt: 100,
  phase: 'started',
};
const ended = {
  ...started,
  phase: 'ended',
  endedAt: 150,
  durationMs: 50,
  outcome: 'success',
};
const frame = (event: unknown) => ({
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text: '' },
  _meta: { executionLifecycle: event },
});

describe('execution lifecycle wire and reducer', () => {
  it('validates discriminants and measurements and drops unrelated payload', () => {
    expect(
      extractExecutionLifecycle(frame({ ...ended, secret: 'discard' })),
    ).toEqual(ended);
    for (const bad of [
      null,
      { ...started, v: 2 },
      { ...started, executionId: ' ' },
      { ...started, startedAt: NaN },
      { ...ended, endedAt: 99 },
      { ...ended, durationMs: -1 },
      { ...ended, outcome: 'timeout' },
      { ...ended, reason: 'consumer_closed' },
      { ...started, subagentId: 1 },
    ]) {
      expect(extractExecutionLifecycle(frame(bad))).toBeUndefined();
    }
    expect(extractExecutionLifecycle({})).toBeUndefined();
  });

  it('keeps metadata-only frames out of chat', () => {
    expect(
      normalizeDaemonEvent({
        type: 'session_update',
        data: { update: frame(started) },
      }),
    ).toEqual([]);
  });

  it('distinguishes replay unknown from live running and never regresses terminal state', () => {
    const replay = reduceExecutionLifecycle(
      createExecutionLifecycleState(),
      frame(started),
      { source: 'replay' },
    );
    expect([...replay.entries.values()][0]?.status).toBe('unknown');
    const live = reduceExecutionLifecycle(replay, frame(started), {
      source: 'live',
    });
    expect([...live.entries.values()][0]?.status).toBe('running');
    const done = reduceExecutionLifecycle(live, frame(ended), {
      source: 'replay',
    });
    expect([...done.entries.values()][0]?.status).toBe('success');
    expect(
      reduceExecutionLifecycle(done, frame(started), { source: 'live' }),
    ).toBe(done);
    expect(
      reduceExecutionLifecycle(done, frame(ended), { source: 'live' }),
    ).toBe(done);
  });

  it('accepts end-before-start and ignores malformed updates', () => {
    const state = reduceExecutionLifecycle(
      createExecutionLifecycleState(),
      frame(ended),
      { source: 'replay' },
    );
    expect(
      reduceExecutionLifecycle(state, frame(started), { source: 'live' }),
    ).toBe(state);
    expect(
      reduceExecutionLifecycle(state, frame({ ...ended, endedAt: Infinity }), {
        source: 'live',
      }),
    ).toBe(state);
  });

  it('marks conflicting terminal facts without replacing the first terminal', () => {
    const done = reduceExecutionLifecycle(
      createExecutionLifecycleState(),
      frame(ended),
      { source: 'live' },
    );
    const conflict = reduceExecutionLifecycle(
      done,
      frame({ ...ended, outcome: 'error' }),
      { source: 'live' },
    );
    expect([...conflict.entries.values()][0]).toMatchObject({
      status: 'success',
      conflicted: true,
      event: ended,
    });
  });

  it('isolates session and agent identity and evicts bounded oldest entries', () => {
    let state = createExecutionLifecycleState();
    for (const event of [
      started,
      { ...started, sessionId: 'other' },
      { ...started, subagentId: 'agent' },
    ]) {
      state = reduceExecutionLifecycle(state, frame(event), { source: 'live' });
    }
    expect(state.entries.size).toBe(3);
    const smaller = reduceExecutionLifecycle(state, frame(started), {
      source: 'live',
      maxEntries: 2,
    });
    expect(smaller.entries.size).toBe(2);
    for (let i = 0; i < 300; i++)
      state = reduceExecutionLifecycle(
        state,
        frame({ ...started, executionId: String(i) }),
        { source: 'live' },
      );
    expect(state.entries.size).toBe(256);
    expect([...state.entries.values()][0]?.event.executionId).toBe('44');
  });
});
