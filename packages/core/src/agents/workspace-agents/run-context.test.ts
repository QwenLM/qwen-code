/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  getAgentRunContext,
  isAgentRun,
  requireAgentRunContext,
  runWithAgentRunContext,
  type AgentRunContext,
} from './run-context.js';

function context(overrides: Partial<AgentRunContext> = {}): AgentRunContext {
  return {
    workspaceId: 'ws_1',
    agentId: 'ag_alice',
    runId: 'rn_1',
    threadId: 'th_1',
    rootThreadId: 'th_1',
    attempt: 1,
    ...overrides,
  };
}

describe('agent run context', () => {
  it('is absent outside a agent turn', () => {
    expect(getAgentRunContext()).toBeUndefined();
    expect(isAgentRun()).toBe(false);
    expect(() => requireAgentRunContext('thread_post')).toThrow(
      /thread_post requires an active agent run context/,
    );
  });

  it('binds the triple for the duration of the turn', () => {
    const bound = runWithAgentRunContext(context(), () =>
      requireAgentRunContext('thread_post'),
    );
    expect(bound.threadId).toBe('th_1');
    expect(getAgentRunContext()).toBeUndefined();
  });

  // The reason this is AsyncLocalStorage and not a mutable "current run"
  // register: a second turn starting while the first awaits must not be able
  // to retarget the first turn's tool calls.
  it('keeps each turn on its own thread across interleaved async work', async () => {
    const observed: string[] = [];
    const turn = (threadId: string, runId: string, delayMs: number) =>
      runWithAgentRunContext(context({ threadId, runId }), async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        observed.push(requireAgentRunContext('thread_post').threadId);
      });

    await Promise.all([turn('th_a', 'rn_a', 5), turn('th_b', 'rn_b', 0)]);

    expect(observed).toEqual(['th_b', 'th_a']);
  });

  it('allows re-entering the identical run', () => {
    const outer = context();
    const threadId = runWithAgentRunContext(outer, () =>
      runWithAgentRunContext({ ...outer }, () =>
        requireAgentRunContext('thread_post'),
      ),
    ).threadId;
    expect(threadId).toBe('th_1');
  });

  it('refuses to nest a different run inside a live one', () => {
    expect(() =>
      runWithAgentRunContext(context(), () =>
        runWithAgentRunContext(
          context({ runId: 'rn_2', threadId: 'th_2', rootThreadId: 'th_2' }),
          () => undefined,
        ),
      ),
    ).toThrow(/Refusing to nest agent run rn_2 \(thread th_2\)/);
  });
});
