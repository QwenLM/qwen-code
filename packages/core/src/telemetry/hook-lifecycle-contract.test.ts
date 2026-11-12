/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import {
  createHookLifecycleState,
  parseHookLifecycle,
  reduceHookLifecycle,
  summarizeHookExecutions,
  type HookLifecycleEvent,
} from './hook-lifecycle-contract.js';

const start: HookLifecycleEvent = {
  v: 1,
  kind: 'hook',
  executionId: 'exec',
  runtimeId: 'runtime',
  sessionId: 'session',
  promptId: 'turn',
  agentId: null,
  eventName: 'Stop',
  hookType: 'command',
  source: 'project',
  name: 'safe',
  startedAt: 100,
  phase: 'started',
};
const end: HookLifecycleEvent = {
  ...start,
  phase: 'ended',
  endedAt: 120,
  durationMs: 20,
  outcome: 'blocked',
};

describe('hook lifecycle contract', () => {
  it('projects only safe fields and rejects invalid identities and terminal values', () => {
    expect(
      parseHookLifecycle({
        ...end,
        command: 'SECRET',
        error: 'SECRET',
        url: 'SECRET',
        stdout: 'SECRET',
      }),
    ).toEqual(end);
    for (const extra of [
      { agentId: 'child' },
      { promptId: '' },
      { v: 2 },
      { endedAt: 99 },
      { durationMs: -1 },
      { source: 'admin' },
      { outcome: 'invented' },
    ]) {
      expect(parseHookLifecycle({ ...end, ...extra })).toBeUndefined();
    }
  });
  it('reconstructs end-only events and never rolls them back or double counts replay', () => {
    let state = createHookLifecycleState();
    for (const event of [end, start, end, start])
      state = reduceHookLifecycle(state, event, { source: 'replay' });
    expect([...state.entries.values()]).toEqual([
      { event: end, status: 'blocked', conflicted: false },
    ]);
    expect(summarizeHookExecutions(state.entries.values())).toMatchObject({
      totalExecutions: 1,
      durationMs: 20,
      counts: { blocked: 1, success: 0 },
      durationComplete: true,
    });
  });
  it('preserves prior SDK state and returns it unchanged for duplicate events', () => {
    const initial = createHookLifecycleState();
    const running = reduceHookLifecycle(initial, start, { source: 'live' });
    const completed = reduceHookLifecycle(running, end, { source: 'live' });
    expect(initial.entries.size).toBe(0);
    expect([...running.entries.values()]).toEqual([
      { event: start, status: 'running', conflicted: false },
    ]);
    expect([...completed.entries.values()]).toEqual([
      { event: end, status: 'blocked', conflicted: false },
    ]);
    expect(reduceHookLifecycle(completed, end, { source: 'replay' })).toBe(
      completed,
    );
    expect(reduceHookLifecycle(completed, start, { source: 'replay' })).toBe(
      completed,
    );
  });
  it('distinguishes replay-only starts, live starts and dispatch duration', () => {
    let state = reduceHookLifecycle(createHookLifecycleState(), start, {
      source: 'replay',
    });
    expect([...state.entries.values()][0]?.status).toBe('unknown');
    state = reduceHookLifecycle(state, start, { source: 'live' });
    state = reduceHookLifecycle(state, start, { source: 'replay' });
    expect([...state.entries.values()][0]?.status).toBe('running');
    state = reduceHookLifecycle(
      state,
      {
        ...start,
        phase: 'dispatched',
        dispatchedAt: 105,
        dispatchDurationMs: 5,
      },
      { source: 'live' },
    );
    expect(summarizeHookExecutions(state.entries.values())).toMatchObject({
      durationMs: 0,
      durationComplete: false,
      counts: { dispatched: 1, success: 0 },
    });
  });
  it('keeps conflicting owners separate from another session and marks incomplete data', () => {
    let state = reduceHookLifecycle(createHookLifecycleState(), end, {
      source: 'live',
    });
    state = reduceHookLifecycle(
      state,
      { ...end, promptId: 'other' },
      { source: 'replay' },
    );
    state = reduceHookLifecycle(
      state,
      { ...end, sessionId: 'other' },
      { source: 'replay' },
    );
    expect(state.entries.size).toBe(2);
    expect([...state.entries.values()][0]).toMatchObject({
      event: { promptId: 'turn' },
      conflicted: true,
    });
    expect(summarizeHookExecutions(state.entries.values())).toMatchObject({
      totalExecutions: 2,
      durationComplete: false,
      durationMs: 20,
    });
  });
  it('retains more than 1000 executions and sums overlapping durations', () => {
    let state = createHookLifecycleState();
    for (let i = 0; i < 1001; i++)
      state = reduceHookLifecycle(
        state,
        { ...end, executionId: String(i) },
        { source: 'replay' },
      );
    expect(summarizeHookExecutions(state.entries.values())).toMatchObject({
      totalExecutions: 1001,
      durationMs: 20020,
    });
  });
});
