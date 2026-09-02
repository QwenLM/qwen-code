/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Config,
  GoalRuntime,
  GoalSnapshotV2,
  GoalStateResponse,
} from '@qwen-code/qwen-code-core';
import {
  emptyGoalSnapshot,
  GOAL_PAUSE_REASON_COMMAND,
  GoalPersistenceUnavailableError,
} from '@qwen-code/qwen-code-core';
import { goalCommand, parseGoalCommand } from './goalCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

const mockRegisterGoalHook = vi.hoisted(() => vi.fn());
const mockGetActiveGoal = vi.hoisted(() => vi.fn());
const mockGetLastGoalTerminal = vi.hoisted(() => vi.fn());
const mockUnregisterGoalHook = vi.hoisted(() => vi.fn());

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    registerGoalHook: mockRegisterGoalHook,
    getActiveGoal: mockGetActiveGoal,
    getLastGoalTerminal: mockGetLastGoalTerminal,
    unregisterGoalHook: mockUnregisterGoalHook,
  };
});

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
      tokensUsed: 0,
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

function makeContext(
  runtime: GoalRuntime,
  {
    trusted = true,
    executionMode = 'interactive',
  }: {
    trusted?: boolean;
    executionMode?: 'interactive' | 'non_interactive' | 'acp';
  } = {},
) {
  const getGoalRuntimeReady = vi.fn().mockResolvedValue(runtime);
  const isTrustedFolder = vi.fn(() => trusted);
  const config = { getGoalRuntimeReady, isTrustedFolder } as unknown as Config;
  const context = createMockCommandContext({
    executionMode,
    services: { config },
  });
  return { context, getGoalRuntimeReady, isTrustedFolder };
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
    ['stop', { kind: 'clear' }],
    ['off', { kind: 'clear' }],
    ['reset', { kind: 'clear' }],
    ['none', { kind: 'clear' }],
    ['cancel', { kind: 'clear' }],
    ['cancel after tests', { kind: 'set', objective: 'cancel after tests' }],
    ['pause after tests', { kind: 'set', objective: 'pause after tests' }],
    ['/goal', { kind: 'status' }],
    ['/goal ship it', { kind: 'set', objective: 'ship it' }],
    ['/goal set ship it', { kind: 'set', objective: 'ship it' }],
    ['/goal set pause', { kind: 'set', objective: 'pause' }],
    ['/goal edit revised', { kind: 'edit', objective: 'revised' }],
    ['/goal pause', { kind: 'pause' }],
    ['/goal resume', { kind: 'resume' }],
    ['/goal clear', { kind: 'clear' }],
    ['/goal stop', { kind: 'clear' }],
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
  beforeEach(() => {
    mockRegisterGoalHook.mockReset();
    mockGetActiveGoal.mockReset();
    mockGetLastGoalTerminal.mockReset();
    mockUnregisterGoalHook.mockReset();
  });

  it('is available in interactive, non-interactive, and ACP modes', () => {
    expect(goalCommand.supportedModes).toEqual([
      'interactive',
      'non_interactive',
      'acp',
    ]);
  });

  it.each([
    [
      'edit revised',
      {
        action: 'edit',
        objective: 'revised',
        expectedGoalId: 'goal-1',
        expectedRevision: 4,
      },
    ],
    [
      'pause',
      {
        action: 'pause',
        expectedGoalId: 'goal-1',
        expectedRevision: 4,
        reason: GOAL_PAUSE_REASON_COMMAND,
      },
    ],
    [
      'resume',
      {
        action: 'resume',
        expectedGoalId: 'goal-1',
        expectedRevision: 4,
      },
    ],
  ] as const)(
    'uses the canonical runtime for non-interactive /goal %s',
    async (args, expectedRequest) => {
      const { dispatch, runtime } = makeRuntime(goalSnapshot());
      const { context } = makeContext(runtime, {
        executionMode: 'non_interactive',
      });

      const result = await goalCommand.action!(context, args);

      expect(dispatch).toHaveBeenCalledWith(expectedRequest);
      expect(result).toMatchObject({ type: 'goal_control' });
      expect(mockRegisterGoalHook).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      'set Ship it',
      { action: 'replace', objective: 'Ship it' },
      { kind: 'set', objective: 'Ship it' },
    ],
    [
      'edit revised',
      { action: 'edit', objective: 'revised' },
      { kind: 'edit', objective: 'revised' },
    ],
    [
      'pause',
      { action: 'pause', reason: GOAL_PAUSE_REASON_COMMAND },
      { kind: 'pause' },
    ],
    ['resume', { action: 'resume' }, { kind: 'resume' }],
    ['clear', { action: 'clear' }, { kind: 'clear' }],
  ] as const)(
    'uses the canonical runtime for ACP /goal %s',
    async (args, request, operation) => {
      const snapshot = goalSnapshot();
      const { dispatch, runtime } = makeRuntime(snapshot);
      const { context, getGoalRuntimeReady } = makeContext(runtime, {
        executionMode: 'acp',
      });

      const result = await goalCommand.action!(context, args);

      expect(dispatch).toHaveBeenCalledWith({
        ...request,
        expectedGoalId: 'goal-1',
        expectedRevision: 4,
      });
      expect(result).toEqual({
        type: 'goal_control',
        operation,
        response: { snapshot },
        cause: request.action,
      });
      expect(getGoalRuntimeReady).toHaveBeenCalledTimes(1);
      expect(mockRegisterGoalHook).not.toHaveBeenCalled();
      expect(mockUnregisterGoalHook).not.toHaveBeenCalled();
    },
  );

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
      cause: 'create',
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
      cause: 'replace',
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
          reason: GOAL_PAUSE_REASON_COMMAND,
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
        cause: request.action,
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

  it('creates a Goal without requiring hook services', async () => {
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

  it.each(['set Ship it', 'edit Better', 'resume'])(
    'rejects %j in an untrusted workspace before runtime admission',
    async (args) => {
      const { dispatch, runtime } = makeRuntime(goalSnapshot());
      const { context, getGoalRuntimeReady } = makeContext(runtime, {
        trusted: false,
      });

      const result = await goalCommand.action!(context, args);

      expect(result).toMatchObject({
        type: 'message',
        messageType: 'error',
        content: expect.stringMatching(/trusted workspaces/i),
      });
      expect(getGoalRuntimeReady).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it.each(['', 'clear', 'pause'])(
    'still allows %j in an untrusted workspace',
    async (args) => {
      const { runtime } = makeRuntime(goalSnapshot());
      const { context } = makeContext(runtime, { trusted: false });

      const result = await goalCommand.action!(context, args);

      expect(result).toMatchObject({ type: 'goal_control' });
    },
  );

  it('maps runtime errors to the existing error action without state', async () => {
    const failure = new Error('Goal persistence is unavailable');
    const getGoalRuntimeReady = vi.fn().mockRejectedValue(failure);
    const config = {
      getGoalRuntimeReady,
      isTrustedFolder: () => true,
    } as unknown as Config;
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

  describe('goal persistence unavailable', () => {
    // In ACP an error return throws out of `#processSlashCommandResult`, so
    // failing here fails the user's whole prompt request — and a sticky
    // `recoveryError` keeps failing it for the rest of the session, while
    // `GET /goals` answers the same question fine. The sibling
    // `sessionGoalGet`/`sessionGoalClear` ext methods already degrade.
    function unavailableContext() {
      const getGoalRuntimeReady = vi
        .fn()
        .mockRejectedValue(
          new GoalPersistenceUnavailableError('no transcript'),
        );
      const config = {
        getGoalRuntimeReady,
        getChatRecordingService: () => undefined,
        isTrustedFolder: () => true,
      } as unknown as Config;
      return createMockCommandContext({
        executionMode: 'acp',
        services: { config },
      });
    }

    it.each(['', 'clear'])(
      'answers %j with an empty snapshot instead of failing',
      async (args) => {
        const result = await goalCommand.action!(unavailableContext(), args);

        expect(result).toEqual({
          type: 'goal_control',
          operation: parseGoalCommand(args),
          response: { snapshot: emptyGoalSnapshot() },
        });
      },
    );

    it.each(['', 'clear'])(
      'fails %j when recovery fails while persisted Goal state may remain',
      async (args) => {
        const getGoalRuntimeReady = vi
          .fn()
          .mockRejectedValue(
            new GoalPersistenceUnavailableError('migration write failed'),
          );
        const config = {
          getGoalRuntimeReady,
          getChatRecordingService: () => ({}),
          isTrustedFolder: () => true,
        } as unknown as Config;
        const context = createMockCommandContext({ services: { config } });

        const result = await goalCommand.action!(context, args);

        expect(result).toEqual({
          type: 'message',
          messageType: 'error',
          content: 'migration write failed',
        });
        expect(result).not.toHaveProperty('response');
      },
    );

    it.each(['Ship it', 'edit revised', 'resume'])(
      'still fails %j, which genuinely needs persistence',
      async (args) => {
        const result = await goalCommand.action!(unavailableContext(), args);

        expect(result).toMatchObject({
          type: 'message',
          messageType: 'error',
        });
      },
    );

    it('does not report a failed clear dispatch as successful', async () => {
      const snapshot = goalSnapshot();
      const { dispatch, runtime } = makeRuntime(snapshot);
      dispatch.mockRejectedValue(
        new GoalPersistenceUnavailableError('journal write failed'),
      );
      const { context } = makeContext(runtime);

      const result = await goalCommand.action!(context, 'clear');

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: 'journal write failed',
      });
      expect(result).not.toHaveProperty('response');
      expect(runtime.getSnapshot()).toEqual(snapshot);
    });
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
