/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  Config,
  GoalRuntime,
  GoalSnapshotV2,
  GoalStateResponse,
} from '@qwen-code/qwen-code-core';
import { goalCommand, parseGoalCommand } from './goalCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

function goalSnapshot(
  overrides: Partial<NonNullable<GoalSnapshotV2['goal']>> = {},
): GoalSnapshotV2 {
  return {
    v: 2,
    activity: 'idle',
    goal: {
      goalId: 'goal-1',
      revision: 4,
      objective: 'Ship Goal v3',
      status: 'active',
      evidenceCursor: { recordId: 'cursor-1' },
      turnCount: 3,
      activeTimeMs: 1_000,
      createdAt: 10,
      updatedAt: 20,
      ...overrides,
    },
  };
}

function noGoalSnapshot(): GoalSnapshotV2 {
  return { v: 2, goal: null, activity: 'idle' };
}

function makeRuntime(
  snapshot: GoalSnapshotV2,
  response: GoalStateResponse = { snapshot },
) {
  const getSnapshot = vi.fn(() => structuredClone(snapshot));
  const dispatch = vi.fn().mockResolvedValue(structuredClone(response));
  const runtime = { getSnapshot, dispatch } as unknown as GoalRuntime;
  return { dispatch, getSnapshot, runtime };
}

function makeContext(runtime: GoalRuntime) {
  const getGoalRuntimeReady = vi.fn().mockResolvedValue(runtime);
  const config = { getGoalRuntimeReady } as unknown as Config;
  const context = createMockCommandContext({ services: { config } });
  return { context, getGoalRuntimeReady };
}

describe('parseGoalCommand', () => {
  it.each([
    ['', { kind: 'status' }],
    ['   ', { kind: 'status' }],
    ['ship Goal v3', { kind: 'set', objective: 'ship Goal v3' }],
    ['set ship Goal v3', { kind: 'set', objective: 'ship Goal v3' }],
    ['set pause', { kind: 'set', objective: 'pause' }],
    ['edit ship it better', { kind: 'edit', objective: 'ship it better' }],
    ['pause', { kind: 'pause' }],
    ['resume', { kind: 'resume' }],
    ['clear', { kind: 'clear' }],
    ['pause after tests', { kind: 'set', objective: 'pause after tests' }],
    ['/goal', { kind: 'status' }],
    ['/goal ship it', { kind: 'set', objective: 'ship it' }],
    ['/goal set ship it', { kind: 'set', objective: 'ship it' }],
    ['/goal set pause', { kind: 'set', objective: 'pause' }],
    ['/goal edit revised', { kind: 'edit', objective: 'revised' }],
    ['/goal pause', { kind: 'pause' }],
    ['/goal resume', { kind: 'resume' }],
    ['/goal clear', { kind: 'clear' }],
  ] as const)('parses %j', (args, expected) => {
    expect(parseGoalCommand(args)).toEqual(expected);
  });

  it.each(['set', 'set   ', 'edit', ' edit\n\t'])(
    'rejects an empty objective for %j',
    (args) => {
      expect(parseGoalCommand(args)).toMatchObject({
        kind: 'error',
        message: expect.stringMatching(/requires an objective/i),
      });
    },
  );

  it('does not impose an objective length cap', () => {
    const objective = `${'x'.repeat(4_001)}-end`;
    expect(parseGoalCommand(`set ${objective}`)).toEqual({
      kind: 'set',
      objective,
    });
  });
});

describe('goalCommand', () => {
  it('is available in interactive, non-interactive, and ACP modes', () => {
    expect(goalCommand.supportedModes).toEqual([
      'interactive',
      'non_interactive',
      'acp',
    ]);
  });

  it('rejects invalid set and edit commands before runtime admission', async () => {
    const { runtime } = makeRuntime(noGoalSnapshot());
    const { context, getGoalRuntimeReady } = makeContext(runtime);

    for (const args of ['set', 'edit   ']) {
      const result = await goalCommand.action!(context, args);
      expect(result).toMatchObject({
        type: 'message',
        messageType: 'error',
        content: expect.stringMatching(/requires an objective/i),
      });
    }
    expect(getGoalRuntimeReady).not.toHaveBeenCalled();
  });

  it('awaits runtime readiness and reads authoritative status without dispatch', async () => {
    const snapshot = goalSnapshot({ status: 'paused' });
    const { dispatch, getSnapshot, runtime } = makeRuntime(snapshot);
    const { context, getGoalRuntimeReady } = makeContext(runtime);

    const result = await goalCommand.action!(context, '');

    expect(result).toEqual({
      type: 'goal_control',
      operation: { kind: 'status' },
      response: { snapshot },
    });
    expect(getGoalRuntimeReady).toHaveBeenCalledTimes(1);
    expect(getSnapshot).toHaveBeenCalledTimes(1);
    expect(getGoalRuntimeReady.mock.invocationCallOrder[0]).toBeLessThan(
      getSnapshot.mock.invocationCallOrder[0]!,
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('maps a set operation to create when no Goal exists', async () => {
    const before = noGoalSnapshot();
    const after = goalSnapshot({ objective: 'Ship it', revision: 1 });
    const { dispatch, runtime } = makeRuntime(before, { snapshot: after });
    const { context } = makeContext(runtime);

    const result = await goalCommand.action!(context, 'Ship it');

    expect(dispatch).toHaveBeenCalledWith({
      action: 'create',
      objective: 'Ship it',
    });
    expect(result).toEqual({
      type: 'goal_control',
      operation: { kind: 'set', objective: 'Ship it' },
      response: { snapshot: after },
    });
    expect(result).not.toHaveProperty('content');
    expect(context.ui.addItem).not.toHaveBeenCalled();
  });

  it('maps set to a versioned replace when a Goal exists', async () => {
    const before = goalSnapshot();
    const after = goalSnapshot({
      goalId: 'goal-2',
      revision: 1,
      objective: 'Replace it',
    });
    const { dispatch, runtime } = makeRuntime(before, { snapshot: after });
    const { context } = makeContext(runtime);

    const result = await goalCommand.action!(context, 'set Replace it');

    expect(dispatch).toHaveBeenCalledWith({
      action: 'replace',
      objective: 'Replace it',
      expectedGoalId: 'goal-1',
      expectedRevision: 4,
    });
    expect(result).toEqual({
      type: 'goal_control',
      operation: { kind: 'set', objective: 'Replace it' },
      response: { snapshot: after },
    });
  });

  it('dispatches versioned edit, pause, resume, and clear requests', async () => {
    const cases = [
      [
        'edit Better objective',
        { kind: 'edit', objective: 'Better objective' },
        {
          action: 'edit',
          objective: 'Better objective',
          expectedGoalId: 'goal-1',
          expectedRevision: 4,
        },
      ],
      [
        'pause',
        { kind: 'pause' },
        {
          action: 'pause',
          expectedGoalId: 'goal-1',
          expectedRevision: 4,
        },
      ],
      [
        'resume',
        { kind: 'resume' },
        {
          action: 'resume',
          expectedGoalId: 'goal-1',
          expectedRevision: 4,
        },
      ],
      [
        'clear',
        { kind: 'clear' },
        {
          action: 'clear',
          expectedGoalId: 'goal-1',
          expectedRevision: 4,
        },
      ],
    ] as const;

    for (const [args, operation, request] of cases) {
      const snapshot = goalSnapshot();
      const { dispatch, runtime } = makeRuntime(snapshot);
      const { context } = makeContext(runtime);

      const result = await goalCommand.action!(context, args);

      expect(dispatch).toHaveBeenCalledWith(request);
      expect(result).toEqual({
        type: 'goal_control',
        operation,
        response: { snapshot },
      });
      expect(result).not.toHaveProperty('content');
    }
  });

  it.each(['edit new objective', 'pause', 'resume'])(
    'rejects %j when no Goal exists',
    async (args) => {
      const { dispatch, runtime } = makeRuntime(noGoalSnapshot());
      const { context } = makeContext(runtime);

      const result = await goalCommand.action!(context, args);

      expect(result).toMatchObject({
        type: 'message',
        messageType: 'error',
        content: expect.stringMatching(/no goal/i),
      });
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it('treats clear with no Goal as an authoritative no-op status response', async () => {
    const snapshot = noGoalSnapshot();
    const { dispatch, runtime } = makeRuntime(snapshot);
    const { context } = makeContext(runtime);

    const result = await goalCommand.action!(context, 'clear');

    expect(result).toEqual({
      type: 'goal_control',
      operation: { kind: 'clear' },
      response: { snapshot },
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('works with a bare config that exposes no trust or hook services', async () => {
    const before = noGoalSnapshot();
    const after = goalSnapshot({ objective: 'Bare Goal', revision: 1 });
    const { dispatch, runtime } = makeRuntime(before, { snapshot: after });
    const { context } = makeContext(runtime);

    const result = await goalCommand.action!(context, 'set Bare Goal');

    expect(dispatch).toHaveBeenCalledWith({
      action: 'create',
      objective: 'Bare Goal',
    });
    expect(result).toMatchObject({ type: 'goal_control' });
  });

  it('maps runtime errors to the existing error action without state', async () => {
    const failure = new Error('Goal persistence is unavailable');
    const getGoalRuntimeReady = vi.fn().mockRejectedValue(failure);
    const config = { getGoalRuntimeReady } as unknown as Config;
    const context = createMockCommandContext({ services: { config } });

    const result = await goalCommand.action!(context, 'status objective');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Goal persistence is unavailable',
    });
    expect(result).not.toHaveProperty('response');
    expect(context.ui.addItem).not.toHaveBeenCalled();
  });

  it('rejects when config is missing', async () => {
    const context = createMockCommandContext();
    const result = await goalCommand.action!(context, 'Ship it');
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Configuration is not available.',
    });
  });
});
