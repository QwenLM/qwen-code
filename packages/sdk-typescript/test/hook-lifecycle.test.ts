/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import {
  createHookLifecycleState,
  extractHookLifecycle,
  reduceHookLifecycle,
  summarizeHookExecutions,
} from '../src/daemon/ui/hook-lifecycle.js';
import { normalizeDaemonEvent } from '../src/daemon/ui/normalizer.js';

const start = {
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
const frame = (event: unknown) => ({
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text: '' },
  _meta: { hookLifecycle: event },
});
describe('SDK hook lifecycle', () => {
  it('parses allowlisted fields without generating chat rows', () => {
    expect(
      extractHookLifecycle(frame({ ...start, secret: 'discard' })),
    ).toEqual(start);
    expect(
      normalizeDaemonEvent({
        type: 'session_update',
        data: { update: frame(start) },
      }),
    ).toEqual([]);
  });
  it('uses the same reducer for live and restored events', () => {
    let state = reduceHookLifecycle(createHookLifecycleState(), frame(start), {
      source: 'live',
    });
    state = reduceHookLifecycle(
      state,
      frame({
        ...start,
        phase: 'ended',
        endedAt: 120,
        durationMs: 20,
        outcome: 'error',
      }),
      { source: 'replay' },
    );
    state = reduceHookLifecycle(state, frame(start), { source: 'replay' });
    expect(summarizeHookExecutions(state.entries.values())).toMatchObject({
      totalExecutions: 1,
      counts: { error: 1 },
      durationMs: 20,
    });
  });
});
