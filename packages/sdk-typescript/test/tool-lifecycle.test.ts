/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { normalizeDaemonEvent } from '../src/daemon/ui/normalizer.js';
import { describe, expect, it } from 'vitest';
import {
  createToolLifecycleState,
  extractToolLifecycle,
  reduceToolLifecycle,
} from '../src/daemon/ui/tool-lifecycle.js';
const started = {
  v: 1,
  kind: 'tool',
  sessionId: 's',
  executionId: 'e',
  callId: 'c',
  toolName: 'shell',
  phase: 'started',
  executionStatus: 'running',
  startedAt: 100,
};
const ended = {
  ...started,
  phase: 'ended',
  executionStatus: 'success',
  endedAt: 120,
  executionDurationMs: 20,
  outcome: 'error',
};
const frame = (event: unknown) => ({
  sessionUpdate: 'tool_call_update',
  toolCallId: 'c',
  _meta: { toolLifecycle: event },
});
describe('tool lifecycle', () => {
  it('does not create or overwrite Chat cards for metadata-only updates, including unknown versions', () => {
    for (const payload of [started, { ...started, v: 2 }]) {
      expect(
        normalizeDaemonEvent({
          id: 1,
          v: 1,
          type: 'session_update',
          data: { update: frame(payload) },
        }),
      ).toEqual([]);
    }
    expect(
      normalizeDaemonEvent({
        id: 1,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            ...frame(started),
            status: 'completed',
            title: 'Output retained',
          },
        },
      }),
    ).toHaveLength(1);
  });
  it('validates execution boundaries and preserves independent call outcome', () => {
    expect(extractToolLifecycle(frame(ended))).toMatchObject({
      executionStatus: 'success',
      outcome: 'error',
    });
    for (const event of [
      { ...started, v: 2 },
      { ...started, startedAt: Infinity },
      { ...started, endedAt: 120 },
      { ...ended, endedAt: 99 },
      { ...ended, executionDurationMs: -1 },
      { ...ended, executionStatus: 'not_started' },
    ])
      expect(extractToolLifecycle(frame(event))).toBeUndefined();
    const noExecution = {
      v: 1,
      kind: 'tool',
      sessionId: 's',
      executionId: 'n',
      callId: 'c',
      toolName: 'shell',
      phase: 'ended',
      executionStatus: 'not_started',
      endedAt: 120,
      outcome: 'cancelled',
    };
    expect(extractToolLifecycle(frame(noExecution))).toEqual(noExecution);
  });
  it('keeps replay unknown, terminals sticky, duplicates inert and conflicts explicit', () => {
    let state = reduceToolLifecycle(
      createToolLifecycleState(),
      frame(started),
      { source: 'replay' },
    );
    expect([...state.entries.values()][0]?.status).toBe('unknown');
    state = reduceToolLifecycle(state, frame(ended), { source: 'live' });
    expect(reduceToolLifecycle(state, frame(started), { source: 'live' })).toBe(
      state,
    );
    expect(reduceToolLifecycle(state, frame(ended), { source: 'replay' })).toBe(
      state,
    );
    const conflict = reduceToolLifecycle(
      state,
      frame({ ...ended, outcome: 'success' }),
      { source: 'live' },
    );
    expect([...conflict.entries.values()][0]).toMatchObject({
      event: ended,
      conflicted: true,
    });
    const terminalFirst = reduceToolLifecycle(
      createToolLifecycleState(),
      frame(ended),
      { source: 'replay' },
    );
    expect(
      reduceToolLifecycle(terminalFirst, frame(started), { source: 'live' }),
    ).toBe(terminalFirst);
  });
  it('marks not-started versus observed execution as conflicting in either arrival order', () => {
    const { startedAt: _start, ...base } = started;
    const notStarted = {
      ...base,
      phase: 'ended',
      executionStatus: 'not_started',
      endedAt: 120,
      outcome: 'cancelled',
    };
    for (const pair of [
      [started, notStarted],
      [notStarted, started],
    ]) {
      let state = createToolLifecycleState();
      for (const event of pair)
        state = reduceToolLifecycle(state, frame(event), { source: 'replay' });
      expect([...state.entries.values()][0]?.conflicted).toBe(true);
    }
  });
  it('isolates owner, subagent and occurrences with reused call IDs and bounds memory', () => {
    let state = createToolLifecycleState();
    for (const event of [
      started,
      { ...started, subagentId: 'child' },
      { ...started, sessionId: 'other' },
      { ...started, executionId: 'next-round' },
    ])
      state = reduceToolLifecycle(state, frame(event), { source: 'live' });
    expect(state.entries.size).toBe(4);
    for (let i = 0; i < 300; i++)
      state = reduceToolLifecycle(
        state,
        frame({ ...started, executionId: `${i}` }),
        { source: 'replay' },
      );
    expect(state.entries.size).toBe(256);
  });
});
