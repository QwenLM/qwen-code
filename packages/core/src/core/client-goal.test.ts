/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import type { LlmChat } from './llm-chat.js';
import {
  createGoalRuntime,
  GoalPersistenceUnavailableError,
  type GoalJournal,
  type GoalRuntime,
} from '../goals/goal-runtime.js';
import type {
  GoalSnapshotV2,
  GoalStateCause,
  GoalStateRecordPayloadV2,
  GoalTurnPermit,
} from '../goals/goal-protocol.js';
import type { ChatRecord } from '../services/chatRecordingService.js';
import { ApprovalMode } from '../config/config.js';
import {
  __resetActiveGoalStoreForTests,
  clearActiveGoal,
  setActiveGoal,
} from '../goals/activeGoalStore.js';
import { GOAL_HOOK_ID_OUTPUT_KEY } from '../goals/goalHook.js';
import type { PendingGoalProposal } from '../goals/goal-tools.js';

const turnMocks = vi.hoisted(() => ({
  constructors: [] as unknown[][],
  pendingToolCalls: [] as unknown[][],
  run: vi.fn(),
}));

vi.mock('./turn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./turn.js')>();
  class MockTurn {
    pendingToolCalls: unknown[];
    finishReason: undefined;

    constructor(...args: unknown[]) {
      turnMocks.constructors.push(args);
      this.pendingToolCalls = turnMocks.pendingToolCalls.shift() ?? [];
    }

    run(...args: unknown[]) {
      return turnMocks.run(...args);
    }
  }
  return { ...actual, Turn: MockTurn };
});

const nextSpeakerMocks = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock('../utils/nextSpeakerChecker.js', () => ({
  checkNextSpeaker: nextSpeakerMocks.check,
}));

import { LlmClient, SendMessageType } from './client.js';
import { LlmEventType, type ServerLlmStreamEvent } from './turn.js';

const FORMER_GOAL_CONTINUATION_LIMIT = 50;

const permit: GoalTurnPermit = {
  goalId: 'goal-1',
  revision: 1,
  turnId: 'turn-1',
};

function emptyStream() {
  return (async function* () {})();
}

async function drain(stream: AsyncGenerator<unknown>) {
  for await (const _event of stream) {
    // Drain the client stream so its true-Stop path runs.
  }
}

async function collect(stream: AsyncGenerator<unknown>) {
  const events: unknown[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function collectOutcome(stream: AsyncGenerator<unknown>) {
  const events: unknown[] = [];
  try {
    for await (const event of stream) events.push(event);
    return { events, error: undefined };
  } catch (error) {
    return { events, error };
  }
}

function pendingGoalProposalStore(initial?: PendingGoalProposal) {
  let pending = initial;
  return {
    get: () => pending,
    set: (proposal: PendingGoalProposal) => {
      pending = proposal;
    },
    take: vi.fn((expectedTurnKey?: string) => {
      const proposal = pending;
      if (
        expectedTurnKey !== undefined &&
        proposal?.turnKey !== expectedTurnKey
      ) {
        return undefined;
      }
      pending = undefined;
      return proposal;
    }),
  };
}

type GoalStateEvent = Extract<
  ServerLlmStreamEvent,
  { type: LlmEventType.GoalState }
>;

function goalStateEvents(events: unknown[]): GoalStateEvent[] {
  return events.filter(
    (event): event is GoalStateEvent =>
      (event as { type?: LlmEventType }).type === LlmEventType.GoalState,
  );
}

function eventIndex(
  events: unknown[],
  type: LlmEventType,
  predicate: (event: ServerLlmStreamEvent) => boolean = () => true,
) {
  return events.findIndex(
    (event) =>
      (event as { type?: LlmEventType }).type === type &&
      predicate(event as ServerLlmStreamEvent),
  );
}

function setupGoalClient() {
  const order: string[] = [];
  let snapshot: GoalSnapshotV2 = {
    v: 2,
    activity: 'running',
    goal: {
      goalId: permit.goalId,
      revision: permit.revision,
      objective: 'ship',
      status: 'active',
      evidenceCursor: { recordId: 'create-record' },
      turnCount: 0,
      activeTimeMs: 0,
      tokensUsed: 0,
      createdAt: 1,
      updatedAt: 1,
    },
  };
  const listeners = new Set<
    (snapshot: GoalSnapshotV2, cause?: GoalStateCause) => void
  >();
  const unsubscribeGoalState = vi.fn(
    (listener: (snapshot: GoalSnapshotV2, cause?: GoalStateCause) => void) =>
      listeners.delete(listener),
  );
  const publish = (cause?: GoalStateCause) => {
    for (const listener of listeners) {
      listener(structuredClone(snapshot), cause);
    }
  };
  const recorder = {
    recordGoalRuntimeMessage: vi.fn(),
    recordUserMessage: vi.fn(),
    recordNotification: vi.fn(),
    recordAttributionSnapshot: vi.fn(),
    recordFileHistorySnapshot: vi.fn(),
    flush: vi.fn(async () => {
      order.push('flush');
    }),
  };
  const runtime = {
    getSnapshot: vi.fn(() => structuredClone(snapshot)),
    permitForTurn: vi.fn(() => ({ ...permit })),
    beginTurn: vi.fn((key: string) => {
      order.push(`begin:${key}`);
      return undefined;
    }),
    finishTurn: vi.fn(async () => {
      order.push('finish');
      snapshot = {
        ...snapshot,
        activity: 'idle',
        goal: snapshot.goal
          ? {
              ...snapshot.goal,
              turnCount: snapshot.goal.turnCount + 1,
              updatedAt: snapshot.goal.updatedAt + 1,
            }
          : null,
      };
      publish('turn_finished');
    }),
    dispatch: vi.fn(async (request: { action: string }) => {
      order.push('pause');
      if (request.action === 'pause' && snapshot.goal) {
        snapshot = {
          ...snapshot,
          goal: {
            ...snapshot.goal,
            status: 'paused',
            updatedAt: snapshot.goal.updatedAt + 1,
          },
        };
        publish('pause');
      }
      return { snapshot: structuredClone(snapshot) };
    }),
    subscribe: vi.fn(
      (
        listener: (snapshot: GoalSnapshotV2, cause?: GoalStateCause) => void,
      ) => {
        listeners.add(listener);
        return () => unsubscribeGoalState(listener);
      },
    ),
  } as unknown as GoalRuntime;
  const config = {
    assertCanStartTurn: vi.fn(async () => undefined),
    getGoalRuntimeReady: vi.fn(async () => runtime),
    getGoalRuntime: vi.fn(() => runtime),
    getChatRecordingService: vi.fn(() => recorder),
    getDisableAllHooks: vi.fn(() => true),
    getMessageBus: vi.fn(() => undefined),
    getMaxSessionTurns: vi.fn(() => 1),
    getSessionTokenLimit: vi.fn(() => 0),
    getIdeMode: vi.fn(() => false),
    getArenaAgentClient: vi.fn(() => null),
    getModel: vi.fn(() => 'test-model'),
    getSkipNextSpeakerCheck: vi.fn(() => false),
    getSkipLoopDetection: vi.fn(() => false),
    startActiveTodoWorkChain: vi.fn(),
    startAutomaticActiveTodoWorkChain: vi.fn(),
    endAutomaticActiveTodoWorkChain: vi.fn(),
    takeActiveTodoReminder: vi.fn(() => undefined),
    getContentGeneratorConfig: vi.fn(() => undefined),
    hasHooksForEvent: vi.fn(() => false),
    getStopHookBlockingCap: vi.fn(() => 8),
    isManagedMemoryAvailable: vi.fn(() => false),
    getManagedAutoMemoryEnabled: vi.fn(() => false),
    getMemoryManager: vi.fn(() => ({
      resetExhaustedBodyRefsForCurrentTurn: vi.fn(),
      restoreMemoryBodiesPresentInHistory: vi.fn(),
    })),
    getAutoSkillEnabled: vi.fn(() => false),
    getSessionId: vi.fn(() => 'goal-test-session'),
    getProjectRoot: vi.fn(() => '/tmp'),
    getTargetDir: vi.fn(() => '/tmp'),
    getClearContextOnIdle: vi.fn(() => ({
      toolResultsThresholdMinutes: 60,
      toolResultsNumToKeep: 5,
    })),
    getApprovalMode: vi.fn(() => ApprovalMode.DEFAULT),
    getSystemPrompt: vi.fn(() => undefined),
    getOutputStyle: vi.fn(() => undefined),
    getExperimentalZedIntegration: vi.fn(() => false),
    isInteractive: vi.fn(() => true),
    getSdkMode: vi.fn(() => false),
    getArenaManager: vi.fn(() => null),
    getFileHistoryService: vi.fn(() => ({
      makeSnapshot: vi.fn(async () => undefined),
      getSnapshots: vi.fn(() => []),
    })),
  } as unknown as Config;
  const client = new LlmClient(config);
  client['chat'] = {
    getUserContentPushCount: vi.fn(() => 0),
    getHistory: vi.fn(() => []),
    getHistoryLength: vi.fn(() => 0),
    stripOrphanedUserEntriesFromHistory: vi.fn(() => []),
  } as unknown as LlmChat;
  client['drainPendingAddedMcpToolsReminder'] = vi.fn();
  client['drainSkillAndCommandReminders'] = vi.fn(async () => undefined);
  client['drainAgentReminders'] = vi.fn(async () => undefined);
  return { client, config, runtime, recorder, order, unsubscribeGoalState };
}

describe('LlmClient Goal admission', () => {
  beforeEach(() => {
    __resetActiveGoalStoreForTests();
    turnMocks.constructors.length = 0;
    turnMocks.pendingToolCalls.length = 0;
    turnMocks.run.mockReset().mockImplementation(emptyStream);
    nextSpeakerMocks.check.mockReset().mockResolvedValue({
      next_speaker: 'model',
    });
  });

  afterEach(() => {
    __resetActiveGoalStoreForTests();
  });

  it('sets an approved propose_goal proposal once the turn ends without tool calls', async () => {
    const { client, config, runtime } = setupGoalClient();
    nextSpeakerMocks.check.mockResolvedValue({ next_speaker: 'user' });
    vi.mocked(runtime.getSnapshot).mockReturnValue({
      v: 2,
      activity: 'idle',
      goal: null,
    });
    const takePendingGoalProposal = vi
      .fn()
      .mockReturnValueOnce(undefined) // the new-query discard
      .mockReturnValueOnce({ objective: 'ship it', turnKey: 'real-user-key' });
    Object.assign(config, {
      takePendingGoalProposal,
      getUsageStatisticsEnabled: vi.fn(() => false),
    });

    await drain(
      client.sendMessageStream(
        [{ text: 'set a goal for this' }],
        new AbortController().signal,
        'real-user-key',
        { type: SendMessageType.UserQuery },
      ),
    );

    expect(takePendingGoalProposal).toHaveBeenCalledTimes(2);
    expect(runtime.dispatch).toHaveBeenCalledWith({
      action: 'create',
      objective: 'ship it',
    });
  });

  it('settles an approved proposal on the default skip-next-speaker exit', async () => {
    const { client, config, runtime } = setupGoalClient();
    vi.mocked(runtime.getSnapshot).mockReturnValue({
      v: 2,
      activity: 'idle',
      goal: null,
    });
    let pending: { objective: string; turnKey: string } | undefined;
    const takePendingGoalProposal = vi.fn(() => {
      const proposal = pending;
      pending = undefined;
      return proposal;
    });
    Object.assign(config, {
      takePendingGoalProposal,
      getSkipNextSpeakerCheck: vi.fn(() => true),
      getUsageStatisticsEnabled: vi.fn(() => false),
    });
    turnMocks.run.mockImplementationOnce(() => {
      pending = { objective: 'ship it', turnKey: 'default-exit-key' };
      return emptyStream();
    });

    await drain(
      client.sendMessageStream(
        [{ text: 'set a goal for this' }],
        new AbortController().signal,
        'default-exit-key',
        { type: SendMessageType.UserQuery },
      ),
    );

    expect(nextSpeakerMocks.check).not.toHaveBeenCalled();
    expect(runtime.dispatch).toHaveBeenCalledWith({
      action: 'create',
      objective: 'ship it',
    });
  });

  it('settles an approved proposal when a blocking Stop hook hits its cap', async () => {
    const { client, config, runtime } = setupGoalClient();
    vi.mocked(runtime.getSnapshot).mockReturnValue({
      v: 2,
      activity: 'idle',
      goal: null,
    });
    let pending: { objective: string; turnKey: string } | undefined;
    const takePendingGoalProposal = vi.fn(() => {
      const proposal = pending;
      pending = undefined;
      return proposal;
    });
    Object.assign(config, {
      takePendingGoalProposal,
      getDisableAllHooks: vi.fn(() => false),
      hasHooksForEvent: vi.fn((event) => event === 'Stop'),
      getMessageBus: vi.fn(() => ({
        request: vi.fn(async () => ({
          output: { decision: 'block', reason: 'Keep working' },
          stopHookCount: 1,
        })),
      })),
      getStopHookBlockingCap: vi.fn(() => 1),
      getUsageStatisticsEnabled: vi.fn(() => false),
    });
    turnMocks.run.mockImplementationOnce(() => {
      pending = { objective: 'ship it', turnKey: 'stop-cap-key' };
      return emptyStream();
    });

    await drain(
      client.sendMessageStream(
        [{ text: 'set a goal for this' }],
        new AbortController().signal,
        'stop-cap-key',
        { type: SendMessageType.UserQuery },
      ),
    );

    expect(runtime.dispatch).toHaveBeenCalledWith({
      action: 'create',
      objective: 'ship it',
    });
  });

  it('settles an approved proposal when a cleared Goal removes the Stop continuation', async () => {
    const { client, config, runtime } = setupGoalClient();
    vi.mocked(runtime.getSnapshot).mockReturnValue({
      v: 2,
      activity: 'idle',
      goal: null,
    });
    setActiveGoal('goal-test-session', {
      condition: 'finish the old goal',
      iterations: 1,
      setAt: 1,
      tokensAtStart: 1,
      hookId: 'old-goal-hook',
    });
    let pending: { objective: string; turnKey: string } | undefined;
    const takePendingGoalProposal = vi.fn(() => {
      const proposal = pending;
      pending = undefined;
      return proposal;
    });
    Object.assign(config, {
      takePendingGoalProposal,
      getDisableAllHooks: vi.fn(() => false),
      hasHooksForEvent: vi.fn((event) => event === 'Stop'),
      getMessageBus: vi.fn(() => ({
        request: vi.fn(async () => ({
          output: {
            decision: 'block',
            reason: 'Keep working',
            hookSpecificOutput: {
              [GOAL_HOOK_ID_OUTPUT_KEY]: 'old-goal-hook',
            },
          },
          stopHookCount: 1,
          hasNonGoalBlockingStopHook: false,
        })),
      })),
      getMaxSessionTurns: vi.fn(() => 0),
      getUsageStatisticsEnabled: vi.fn(() => false),
    });
    turnMocks.run.mockImplementationOnce(() => {
      pending = { objective: 'ship it', turnKey: 'stop-clear-key' };
      return emptyStream();
    });
    const getSteerInput = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
        clearActiveGoal('goal-test-session');
        return undefined;
      });

    await drain(
      client.sendMessageStream(
        [{ text: 'set a goal for this' }],
        new AbortController().signal,
        'stop-clear-key',
        { type: SendMessageType.UserQuery, getSteerInput },
      ),
    );

    expect(turnMocks.run).toHaveBeenCalledOnce();
    expect(getSteerInput).toHaveBeenCalledTimes(2);
    expect(takePendingGoalProposal).toHaveBeenCalledTimes(2);
    expect(runtime.dispatch).toHaveBeenCalledWith({
      action: 'create',
      objective: 'ship it',
    });
  });

  it('discards an approved proposal when settlement starts already aborted', async () => {
    const { client, config, runtime } = setupGoalClient();
    const controller = new AbortController();
    controller.abort();
    let pending: { objective: string; turnKey: string } | undefined = {
      objective: 'ship it',
      turnKey: 'settle-key',
    };
    const loadGoalRuntime = vi.fn(async () => runtime);
    Object.assign(config, {
      takePendingGoalProposal: vi.fn(() => {
        const proposal = pending;
        pending = undefined;
        return proposal;
      }),
    });

    await client['settlePendingGoalProposal'](
      true,
      controller.signal,
      loadGoalRuntime,
      'settle-key',
    );

    expect(pending).toBeUndefined();
    expect(loadGoalRuntime).not.toHaveBeenCalled();
    expect(runtime.dispatch).not.toHaveBeenCalled();
  });

  it('keeps an approved proposal parked until its ToolResult turn ends', async () => {
    const { client, config, runtime } = setupGoalClient();
    nextSpeakerMocks.check.mockResolvedValue({ next_speaker: 'user' });
    vi.mocked(runtime.getSnapshot).mockReturnValue({
      v: 2,
      activity: 'idle',
      goal: null,
    });
    let pending: { objective: string; turnKey: string } | undefined;
    const takePendingGoalProposal = vi.fn(() => {
      const proposal = pending;
      pending = undefined;
      return proposal;
    });
    Object.assign(config, {
      takePendingGoalProposal,
      getMaxSessionTurns: vi.fn(() => 0),
      getUsageStatisticsEnabled: vi.fn(() => false),
    });
    turnMocks.pendingToolCalls.push([{ name: 'read_file' }], []);
    turnMocks.run
      .mockImplementationOnce(() => {
        pending = { objective: 'ship it', turnKey: 'pending-tool-key' };
        return emptyStream();
      })
      .mockImplementation(emptyStream);

    await drain(
      client.sendMessageStream(
        [{ text: 'set a goal for this' }],
        new AbortController().signal,
        'pending-tool-key',
        { type: SendMessageType.UserQuery },
      ),
    );

    expect(takePendingGoalProposal).toHaveBeenCalledOnce();
    expect(runtime.dispatch).not.toHaveBeenCalled();
    expect(pending).toEqual({
      objective: 'ship it',
      turnKey: 'pending-tool-key',
    });

    await drain(
      client.sendMessageStream(
        [
          {
            functionResponse: {
              name: 'read_file',
              response: { output: 'ok' },
            },
          },
        ],
        new AbortController().signal,
        'pending-tool-key',
        { type: SendMessageType.ToolResult },
      ),
    );

    expect(takePendingGoalProposal).toHaveBeenCalledTimes(2);
    expect(runtime.dispatch).toHaveBeenCalledWith({
      action: 'create',
      objective: 'ship it',
    });
  });

  it('keeps an approved proposal parked through a queued steer continuation', async () => {
    const { client, config, runtime } = setupGoalClient();
    vi.mocked(config.getMaxSessionTurns).mockReturnValue(0);
    nextSpeakerMocks.check.mockResolvedValue({ next_speaker: 'user' });
    let pending: { objective: string; turnKey: string } | undefined;
    const takePendingGoalProposal = vi.fn(() => {
      const proposal = pending;
      pending = undefined;
      return proposal;
    });
    Object.assign(config, {
      takePendingGoalProposal,
      getUsageStatisticsEnabled: vi.fn(() => false),
    });
    let snapshot: GoalSnapshotV2 = { v: 2, activity: 'idle', goal: null };
    vi.mocked(runtime.getSnapshot).mockImplementation(() =>
      structuredClone(snapshot),
    );
    vi.mocked(runtime.dispatch).mockImplementation(async (request) => {
      if (request.action === 'create') {
        snapshot = {
          v: 2,
          activity: 'idle',
          goal: {
            goalId: 'proposal-goal',
            revision: 1,
            objective: request.objective,
            status: 'active',
            evidenceCursor: { recordId: 'proposal-create' },
            turnCount: 0,
            activeTimeMs: 0,
            tokensUsed: 0,
            createdAt: 1,
            updatedAt: 1,
          },
        };
      }
      return { snapshot: structuredClone(snapshot) };
    });
    turnMocks.run
      .mockImplementationOnce(() => {
        pending = { objective: 'ship it', turnKey: 'real-user-key' };
        return emptyStream();
      })
      .mockImplementationOnce(() => {
        expect(runtime.dispatch).not.toHaveBeenCalled();
        return emptyStream();
      });
    const getSteerInput = vi
      .fn()
      .mockResolvedValueOnce({
        parts: [{ text: 'queued user steering' }],
        accept: vi.fn(),
        restore: vi.fn(),
      })
      .mockResolvedValue(undefined);

    await drain(
      client.sendMessageStream(
        [{ text: 'set a goal for this' }],
        new AbortController().signal,
        'real-user-key',
        { type: SendMessageType.UserQuery, getSteerInput },
      ),
    );

    expect(turnMocks.run).toHaveBeenCalledTimes(2);
    expect(runtime.dispatch).toHaveBeenCalledTimes(1);
    expect(runtime.dispatch).toHaveBeenCalledWith({
      action: 'create',
      objective: 'ship it',
    });
  });

  it('drops a proposal when its turn exits with a provider error', async () => {
    const { client, config, runtime } = setupGoalClient();
    vi.mocked(config.getMaxSessionTurns).mockReturnValue(0);
    vi.mocked(runtime.getSnapshot).mockReturnValue({
      v: 2,
      activity: 'idle',
      goal: null,
    });
    const store = pendingGoalProposalStore();
    Object.assign(config, {
      takePendingGoalProposal: store.take,
      getUsageStatisticsEnabled: vi.fn(() => false),
      getSkipNextSpeakerCheck: vi.fn(() => true),
    });
    turnMocks.run
      .mockImplementationOnce(async function* () {
        store.set({
          objective: 'stale proposal',
          turnKey: 'failed-user-key',
        });
        yield {
          type: LlmEventType.Error,
          value: { error: { status: 500 } },
        };
      })
      .mockImplementation(emptyStream);

    await drain(
      client.sendMessageStream(
        [{ text: 'set a goal for this' }],
        new AbortController().signal,
        'failed-user-key',
        { type: SendMessageType.UserQuery },
      ),
    );
    expect(store.get()).toBeUndefined();
    await drain(
      client.sendMessageStream(
        [{ text: 'background notification' }],
        new AbortController().signal,
        'notification-key',
        { type: SendMessageType.Notification },
      ),
    );

    expect(runtime.dispatch).not.toHaveBeenCalled();
  });

  it('drops a proposal when cancellation lands during runtime readiness', async () => {
    const { client, config, runtime } = setupGoalClient();
    // No Goal at the boundary, as in production: the only thing standing
    // between the approval and `create` is the post-loader abort guard.
    vi.mocked(runtime.getSnapshot).mockReturnValue({
      v: 2,
      activity: 'idle',
      goal: null,
    });
    const controller = new AbortController();
    let pending: { objective: string; turnKey: string } | undefined = {
      objective: 'ship it',
      turnKey: 'settle-key',
    };
    const takePendingGoalProposal = vi.fn(() => {
      const proposal = pending;
      pending = undefined;
      return proposal;
    });
    Object.assign(config, { takePendingGoalProposal });

    await client['settlePendingGoalProposal'](
      true,
      controller.signal,
      async () => {
        controller.abort();
        return runtime;
      },
      'settle-key',
    );

    // Dropped means taken and not applied: the slot is empty afterwards, so
    // a later boundary cannot revive the cancelled approval.
    expect(takePendingGoalProposal).toHaveBeenCalledTimes(1);
    expect(pending).toBeUndefined();
    expect(runtime.dispatch).not.toHaveBeenCalled();
  });

  it('pauses a proposal applied while cancellation is landing', async () => {
    const { client, config, runtime } = setupGoalClient();
    const controller = new AbortController();
    Object.assign(config, {
      takePendingGoalProposal: vi.fn(() => ({
        objective: 'ship it',
        turnKey: 'settle-key',
      })),
    });
    const appliedGoal = {
      goalId: 'proposal-goal',
      revision: 1,
      objective: 'ship it',
      status: 'active' as const,
      evidenceCursor: { recordId: 'proposal-create' },
      turnCount: 0,
      activeTimeMs: 0,
      tokensUsed: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    vi.mocked(runtime.getSnapshot).mockReturnValue({
      v: 2,
      activity: 'idle',
      goal: null,
    });
    vi.mocked(runtime.dispatch)
      .mockImplementationOnce(async () => {
        controller.abort();
        return {
          snapshot: { v: 2, activity: 'idle', goal: appliedGoal },
        };
      })
      .mockResolvedValueOnce({
        snapshot: {
          v: 2,
          activity: 'idle',
          goal: { ...appliedGoal, status: 'paused' },
        },
      });

    await client['settlePendingGoalProposal'](
      true,
      controller.signal,
      async () => runtime,
      'settle-key',
    );

    expect(runtime.dispatch).toHaveBeenNthCalledWith(1, {
      action: 'create',
      objective: 'ship it',
    });
    expect(runtime.dispatch).toHaveBeenNthCalledWith(2, {
      action: 'pause',
      expectedGoalId: appliedGoal.goalId,
      expectedRevision: appliedGoal.revision,
    });
  });

  it.each(['terminal', 'aborted', 'throwing', 'side-query'] as const)(
    'leaves the owner approval parked through a foreign %s turn',
    async (exit) => {
      const { client, config, runtime } = setupGoalClient();
      nextSpeakerMocks.check.mockResolvedValue({ next_speaker: 'user' });
      vi.mocked(runtime.getSnapshot).mockReturnValue({
        v: 2,
        activity: 'idle',
        goal: null,
      });
      const store = pendingGoalProposalStore({
        objective: 'approved earlier',
        turnKey: 'owner-key',
      });
      Object.assign(config, {
        takePendingGoalProposal: store.take,
        getMaxSessionTurns: vi.fn(() => 0),
        getUsageStatisticsEnabled: vi.fn(() => false),
      });

      if (exit === 'aborted') {
        const controller = new AbortController();
        controller.abort();
        await client['settlePendingGoalProposal'](
          true,
          controller.signal,
          async () => runtime,
          'foreign-key',
        );
      } else {
        if (exit === 'throwing') {
          turnMocks.run.mockImplementationOnce(() => {
            throw new Error('provider exploded');
          });
        }
        const foreignTurn = drain(
          client.sendMessageStream(
            [{ text: 'background task finished' }],
            new AbortController().signal,
            'foreign-key',
            exit === 'side-query'
              ? {
                  type: SendMessageType.UserQuery,
                  isConcurrentSideQuery: true,
                }
              : { type: SendMessageType.Notification },
          ),
        );
        if (exit === 'throwing') {
          await expect(foreignTurn).rejects.toThrow('provider exploded');
        } else {
          await foreignTurn;
        }
      }

      expect(store.take).toHaveBeenCalledWith('foreign-key');
      expect(store.get()).toEqual({
        objective: 'approved earlier',
        turnKey: 'owner-key',
      });
      expect(runtime.dispatch).not.toHaveBeenCalled();

      await client['settlePendingGoalProposal'](
        true,
        new AbortController().signal,
        async () => runtime,
        'owner-key',
      );

      expect(store.get()).toBeUndefined();
      expect(runtime.dispatch).toHaveBeenCalledWith({
        action: 'create',
        objective: 'approved earlier',
      });
    },
  );

  it('clears a stale approval before a blocked user query', async () => {
    const { client, config, runtime } = setupGoalClient();
    const store = pendingGoalProposalStore({
      objective: 'stale approval',
      turnKey: 'cancelled-key',
    });
    Object.assign(config, { takePendingGoalProposal: store.take });
    vi.mocked(config.getDisableAllHooks).mockReturnValue(false);
    vi.mocked(config.hasHooksForEvent).mockImplementation(
      (event) => event === 'UserPromptSubmit',
    );
    vi.mocked(config.getMessageBus).mockReturnValue({
      request: vi.fn(async () => ({
        output: { decision: 'block', reason: 'policy denied' },
      })),
    } as unknown as ReturnType<Config['getMessageBus']>);

    const events = await collect(
      client.sendMessageStream(
        [{ text: 'replacement query' }],
        new AbortController().signal,
        'replacement-key',
        { type: SendMessageType.UserQuery },
      ),
    );

    expect(store.take).toHaveBeenNthCalledWith(1);
    expect(store.get()).toBeUndefined();
    expect(runtime.dispatch).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      type: LlmEventType.UserPromptSubmitBlocked,
      value: {
        reason: 'policy denied',
        originalPrompt: 'replacement query',
      },
    });
  });

  it('clears a stale approval before a retry chain', async () => {
    const { client, config, runtime } = setupGoalClient();
    vi.mocked(runtime.getSnapshot).mockReturnValue({
      v: 2,
      activity: 'idle',
      goal: null,
    });
    const store = pendingGoalProposalStore({
      objective: 'stale approval',
      turnKey: 'cancelled-key',
    });
    Object.assign(config, {
      takePendingGoalProposal: store.take,
      getSkipNextSpeakerCheck: vi.fn(() => true),
      getUsageStatisticsEnabled: vi.fn(() => false),
    });

    await drain(
      client.sendMessageStream(
        [{ text: 'retry the interrupted request' }],
        new AbortController().signal,
        'retry-key',
        { type: SendMessageType.Retry },
      ),
    );

    expect(store.take).toHaveBeenNthCalledWith(1);
    expect(store.get()).toBeUndefined();
    expect(runtime.dispatch).not.toHaveBeenCalled();
  });

  it.each(['blocked', 'throwing'] as const)(
    '%s owner ToolResult hook closes its parked approval',
    async (hookExit) => {
      const { client, config, runtime } = setupGoalClient();
      vi.mocked(runtime.getSnapshot).mockReturnValue({
        v: 2,
        activity: 'idle',
        goal: null,
      });
      const store = pendingGoalProposalStore({
        objective: 'ship it',
        turnKey: 'owner-key',
      });
      Object.assign(config, {
        takePendingGoalProposal: store.take,
        getDisableAllHooks: vi.fn(() => false),
        hasHooksForEvent: vi.fn((event) => event === 'UserPromptSubmit'),
        getMessageBus: vi.fn(
          () =>
            ({
              request: vi.fn(async () => {
                if (hookExit === 'throwing') {
                  throw new Error('hook exploded');
                }
                return {
                  output: { decision: 'block', reason: 'policy denied' },
                };
              }),
            }) as unknown as ReturnType<Config['getMessageBus']>,
        ),
      });

      const ownerStream = client.sendMessageStream(
        [
          {
            functionResponse: {
              name: 'propose_goal',
              response: { output: 'approved' },
            },
          },
        ],
        new AbortController().signal,
        'owner-key',
        { type: SendMessageType.ToolResult },
      );
      let events: unknown[] = [];
      if (hookExit === 'throwing') {
        await expect(drain(ownerStream)).rejects.toThrow('hook exploded');
      } else {
        events = await collect(ownerStream);
      }

      expect(store.get()).toBeUndefined();
      if (hookExit === 'blocked') {
        expect(runtime.dispatch).toHaveBeenCalledWith({
          action: 'create',
          objective: 'ship it',
        });
        expect(eventIndex(events, LlmEventType.GoalState)).toBeLessThan(
          eventIndex(events, LlmEventType.UserPromptSubmitBlocked),
        );
      } else {
        expect(runtime.dispatch).not.toHaveBeenCalled();
      }
    },
  );

  it.each(['Stop-hook', 'next-speaker'] as const)(
    'settles after a blocked %s continuation ends the owner turn',
    async (continuation) => {
      const { client, config, runtime } = setupGoalClient();
      vi.mocked(runtime.getSnapshot).mockReturnValue({
        v: 2,
        activity: 'idle',
        goal: null,
      });
      const store = pendingGoalProposalStore();
      let userPromptSubmitCount = 0;
      const messageBus = {
        request: vi.fn(async (request: { eventName: string }) => {
          if (request.eventName === 'Stop') {
            return {
              output: { decision: 'block', reason: 'Keep working' },
              stopHookCount: 1,
            };
          }
          userPromptSubmitCount += 1;
          return userPromptSubmitCount === 1
            ? { output: {} }
            : { output: { decision: 'block', reason: 'policy denied' } };
        }),
      };
      Object.assign(config, {
        takePendingGoalProposal: store.take,
        getDisableAllHooks: vi.fn(() => false),
        hasHooksForEvent: vi.fn(
          (event) =>
            event === 'UserPromptSubmit' ||
            (continuation === 'Stop-hook' && event === 'Stop'),
        ),
        getMessageBus: vi.fn(
          () => messageBus as unknown as ReturnType<Config['getMessageBus']>,
        ),
        getUsageStatisticsEnabled: vi.fn(() => false),
      });
      if (continuation === 'next-speaker') {
        nextSpeakerMocks.check.mockResolvedValue({ next_speaker: 'model' });
      }
      turnMocks.run.mockImplementationOnce(() => {
        store.set({ objective: 'ship it', turnKey: 'owner-key' });
        return emptyStream();
      });

      await drain(
        client.sendMessageStream(
          [{ text: 'set a goal for this' }],
          new AbortController().signal,
          'owner-key',
          { type: SendMessageType.UserQuery },
        ),
      );

      expect(turnMocks.run).toHaveBeenCalledOnce();
      expect(store.get()).toBeUndefined();
      expect(runtime.dispatch).toHaveBeenCalledTimes(1);
      expect(runtime.dispatch).toHaveBeenCalledWith({
        action: 'create',
        objective: 'ship it',
      });
    },
  );

  it('discards a proposal still parked when the next user query starts', async () => {
    // The proposing turn was cancelled before its boundary; the approval must
    // not start a loop from under the user's next message.
    const { client, config, runtime } = setupGoalClient();
    vi.mocked(runtime.getSnapshot).mockReturnValue({
      v: 2,
      activity: 'idle',
      goal: null,
    });
    const takePendingGoalProposal = vi
      .fn()
      .mockReturnValueOnce({
        objective: 'stale',
        turnKey: 'cancelled-turn-key',
      })
      .mockReturnValue(undefined);
    Object.assign(config, {
      takePendingGoalProposal,
      getUsageStatisticsEnabled: vi.fn(() => false),
    });

    await drain(
      client.sendMessageStream(
        [{ text: 'something else' }],
        new AbortController().signal,
        'real-user-key',
        { type: SendMessageType.UserQuery },
      ),
    );

    expect(takePendingGoalProposal).toHaveBeenCalled();
    expect(runtime.dispatch).not.toHaveBeenCalled();
  });

  it('exposes Goal as an explicit internal message type', () => {
    expect(SendMessageType.Goal).toBe('goal');
    expect(LlmEventType.GoalState).toBe('goal_state');
  });

  it('flushes and queues real user input before finishing an exact Goal permit', async () => {
    const { client, runtime, recorder, order, unsubscribeGoalState } =
      setupGoalClient();
    const getQueuedGoalTurnKey = vi.fn(() => {
      order.push('peek');
      return 'queued-user';
    });

    const events = await collect(
      client.sendMessageStream(
        [{ text: 'Continue the Goal.' }],
        new AbortController().signal,
        'goal-prompt',
        {
          type: SendMessageType.Goal,
          goalPermit: permit,
          goalTurnKey: `goal-runtime:${permit.turnId}`,
          getQueuedGoalTurnKey,
        },
      ),
    );

    expect(runtime.permitForTurn).toHaveBeenCalledWith(
      `goal-runtime:${permit.turnId}`,
    );
    expect(recorder.recordGoalRuntimeMessage).toHaveBeenCalledWith(
      [{ text: 'Continue the Goal.' }],
      permit,
    );
    expect(turnMocks.constructors[0]?.[2]).toEqual(permit);
    expect(order).toEqual(['flush', 'peek', 'begin:queued-user', 'finish']);
    expect(nextSpeakerMocks.check).not.toHaveBeenCalled();
    expect(unsubscribeGoalState).toHaveBeenCalledOnce();
    expect(goalStateEvents(events).map((event) => event.cause)).toEqual([
      undefined,
      'turn_finished',
    ]);
    const initialGoalStateIndex = eventIndex(
      events,
      LlmEventType.GoalState,
      (event) =>
        event.type === LlmEventType.GoalState && event.cause === undefined,
    );
    const initialActiveGoalIndex = eventIndex(
      events,
      LlmEventType.ActiveGoal,
      (event) => event.type === LlmEventType.ActiveGoal && event.value !== null,
    );
    expect(initialGoalStateIndex).toBeGreaterThanOrEqual(0);
    expect(initialActiveGoalIndex).toBeGreaterThan(initialGoalStateIndex);
    expect(events[initialActiveGoalIndex]).toEqual({
      type: LlmEventType.ActiveGoal,
      value: {
        condition: 'ship',
        iterations: 0,
        setAt: 1,
        tokensAtStart: 0,
        hookId: 'goal-v2:goal-1:1',
      },
    });
  });

  it('fails closed before recording or sampling when an automatic permit is stale', async () => {
    const { client, runtime, recorder } = setupGoalClient();
    vi.mocked(runtime.permitForTurn).mockReturnValue(undefined);

    await expect(
      drain(
        client.sendMessageStream(
          [{ text: 'stale continuation' }],
          new AbortController().signal,
          'goal-prompt',
          {
            type: SendMessageType.Goal,
            goalPermit: permit,
            goalTurnKey: `goal-runtime:${permit.turnId}`,
          },
        ),
      ),
    ).rejects.toThrow('Goal turn permit is no longer valid');

    expect(recorder.recordGoalRuntimeMessage).not.toHaveBeenCalled();
    expect(turnMocks.run).not.toHaveBeenCalled();
  });

  it('requires an explicit permit for automatic Goal text', async () => {
    const { client, recorder } = setupGoalClient();

    await expect(
      drain(
        client.sendMessageStream(
          [{ text: 'looks like a Goal but is not admitted' }],
          new AbortController().signal,
          'goal-prompt',
          { type: SendMessageType.Goal },
        ),
      ),
    ).rejects.toThrow('requires an exact permit');

    expect(recorder.recordGoalRuntimeMessage).not.toHaveBeenCalled();
  });

  it('claims an active Goal for a real user and records real-user provenance', async () => {
    const { client, runtime, recorder } = setupGoalClient();
    vi.mocked(runtime.permitForTurn).mockReturnValueOnce(undefined);
    vi.mocked(runtime.beginTurn).mockReturnValueOnce({ ...permit });

    await drain(
      client.sendMessageStream(
        [{ text: 'user correction' }],
        new AbortController().signal,
        'real-user-key',
        { type: SendMessageType.UserQuery },
      ),
    );

    expect(runtime.beginTurn).toHaveBeenCalledWith('real-user-key');
    expect(recorder.recordUserMessage).toHaveBeenCalledWith(
      [{ text: 'user correction' }],
      permit,
    );
    expect(recorder.recordGoalRuntimeMessage).not.toHaveBeenCalled();
    expect(turnMocks.constructors[0]?.[2]).toEqual(permit);
  });

  it('keeps real-user accounting when UserQuery receives a hidden automatic permit', async () => {
    const { client, runtime, recorder } = setupGoalClient();

    await drain(
      client.sendMessageStream(
        [{ text: 'interrupt hidden continuation' }],
        new AbortController().signal,
        'real-user-key',
        {
          type: SendMessageType.UserQuery,
          goalPermit: permit,
          goalTurnKey: `goal-runtime:${permit.turnId}`,
        },
      ),
    );

    expect(runtime.permitForTurn).toHaveBeenCalledWith(
      `goal-runtime:${permit.turnId}`,
    );
    expect(recorder.recordAttributionSnapshot).toHaveBeenCalledOnce();
    expect(client['sessionTurnCount']).toBe(1);
  });

  it('releases a hidden exact permit when UserPromptSubmit blocks before sampling', async () => {
    const { client, config, runtime, recorder, order, unsubscribeGoalState } =
      setupGoalClient();
    const messageBus = {
      request: vi.fn(async () => ({
        output: { decision: 'block', reason: 'policy denied' },
      })),
    };
    vi.mocked(config.getDisableAllHooks).mockReturnValue(false);
    vi.mocked(config.getMessageBus).mockReturnValue(
      messageBus as unknown as ReturnType<Config['getMessageBus']>,
    );
    vi.mocked(config.hasHooksForEvent).mockImplementation(
      (event) => event === 'UserPromptSubmit',
    );

    const events = await collect(
      client.sendMessageStream(
        [{ text: 'blocked real user' }],
        new AbortController().signal,
        'real-user-key',
        {
          type: SendMessageType.UserQuery,
          goalPermit: permit,
          goalTurnKey: `goal-runtime:${permit.turnId}`,
        },
      ),
    );

    expect(runtime.finishTurn).toHaveBeenCalledWith(permit);
    expect(order).toEqual(['flush', 'finish']);
    expect(recorder.recordUserMessage).not.toHaveBeenCalled();
    expect(turnMocks.run).not.toHaveBeenCalled();
    expect(unsubscribeGoalState).toHaveBeenCalledOnce();
    expect(goalStateEvents(events).map((event) => event.cause)).toEqual([
      undefined,
      'turn_finished',
    ]);
    expect(
      eventIndex(events, LlmEventType.GoalState, (event) =>
        event.type === LlmEventType.GoalState
          ? event.cause === 'turn_finished'
          : false,
      ),
    ).toBeLessThan(eventIndex(events, LlmEventType.UserPromptSubmitBlocked));
  });

  it('pauses and releases a hidden exact permit when UserPromptSubmit throws', async () => {
    const { client, config, runtime, order } = setupGoalClient();
    const messageBus = {
      request: vi.fn(async () => {
        throw new Error('hook exploded');
      }),
    };
    vi.mocked(config.getDisableAllHooks).mockReturnValue(false);
    vi.mocked(config.getMessageBus).mockReturnValue(
      messageBus as unknown as ReturnType<Config['getMessageBus']>,
    );
    vi.mocked(config.hasHooksForEvent).mockImplementation(
      (event) => event === 'UserPromptSubmit',
    );

    await expect(
      drain(
        client.sendMessageStream(
          [{ text: 'throwing real user' }],
          new AbortController().signal,
          'real-user-key',
          {
            type: SendMessageType.UserQuery,
            goalPermit: permit,
            goalTurnKey: `goal-runtime:${permit.turnId}`,
          },
        ),
      ),
    ).rejects.toThrow('hook exploded');

    expect(runtime.dispatch).toHaveBeenCalledWith({
      action: 'pause',
      expectedGoalId: permit.goalId,
      expectedRevision: permit.revision,
    });
    expect(order).toEqual(['pause', 'flush', 'finish']);
    expect(turnMocks.run).not.toHaveBeenCalled();
  });

  it('explicitly rejects unrelated background sends while Goal owns the model', async () => {
    const { client, recorder } = setupGoalClient();

    await expect(
      drain(
        client.sendMessageStream(
          [{ text: 'background notification' }],
          new AbortController().signal,
          'notification',
          { type: SendMessageType.Notification },
        ),
      ),
    ).rejects.toThrow('active Goal requires an exact turn permit');

    expect(recorder.recordGoalRuntimeMessage).not.toHaveBeenCalled();
    expect(turnMocks.run).not.toHaveBeenCalled();
  });

  it('keeps ordinary turns available when Goal recovery is unsupported', async () => {
    const { client, config } = setupGoalClient();
    vi.mocked(config.getGoalRuntimeReady).mockRejectedValue(
      new GoalPersistenceUnavailableError(
        'Goal lifecycle record is malformed or uses an unsupported version',
      ),
    );
    vi.mocked(config.getSkipNextSpeakerCheck).mockReturnValue(true);

    await expect(
      drain(
        client.sendMessageStream(
          [{ text: 'hello' }],
          new AbortController().signal,
          'plain-user-turn',
          { type: SendMessageType.UserQuery },
        ),
      ),
    ).resolves.toBeUndefined();

    expect(turnMocks.run).toHaveBeenCalledOnce();
  });

  it('keeps unexpected Goal initialization failures fail-closed', async () => {
    const { client, config } = setupGoalClient();
    vi.mocked(config.getGoalRuntimeReady).mockRejectedValue(
      new TypeError('unexpected Goal initialization failure'),
    );

    await expect(
      drain(
        client.sendMessageStream(
          [{ text: 'hello' }],
          new AbortController().signal,
          'plain-user-turn',
          { type: SendMessageType.UserQuery },
        ),
      ),
    ).rejects.toThrow('unexpected Goal initialization failure');

    expect(turnMocks.run).not.toHaveBeenCalled();
  });

  it('requires the exact permit while a paused Goal turn is still running', async () => {
    const { client, runtime, recorder } = setupGoalClient();
    await runtime.dispatch({
      action: 'pause',
      expectedGoalId: permit.goalId,
      expectedRevision: permit.revision,
    });
    expect(runtime.getSnapshot()).toMatchObject({
      activity: 'running',
      goal: { status: 'paused' },
    });

    await expect(
      drain(
        client.sendMessageStream(
          [{ text: 'background notification' }],
          new AbortController().signal,
          'notification',
          { type: SendMessageType.Notification },
        ),
      ),
    ).rejects.toThrow('active Goal requires an exact turn permit');

    expect(recorder.recordNotification).not.toHaveBeenCalled();
    expect(turnMocks.run).not.toHaveBeenCalled();
  });

  it('accepts and true-stops a supplied Notification permit as runtime work', async () => {
    const { client, runtime, recorder, order } = setupGoalClient();

    await drain(
      client.sendMessageStream(
        [{ text: 'dependency completed' }],
        new AbortController().signal,
        'notification',
        {
          type: SendMessageType.Notification,
          notificationDisplayText: 'Dependency completed',
          goalPermit: permit,
          goalTurnKey: `goal-runtime:${permit.turnId}`,
          goalOrigin: 'runtime',
        },
      ),
    );

    expect(runtime.permitForTurn).toHaveBeenCalledWith(
      `goal-runtime:${permit.turnId}`,
    );
    expect(recorder.recordNotification).toHaveBeenCalledWith(
      [{ text: 'dependency completed' }],
      'Dependency completed',
      undefined,
      permit,
    );
    expect(recorder.recordGoalRuntimeMessage).not.toHaveBeenCalled();
    expect(order).toEqual(['flush', 'finish']);
  });

  it('pauses and releases the current permit when the caller aborts', async () => {
    const { client, runtime, order } = setupGoalClient();
    const caller = new AbortController();
    turnMocks.run.mockImplementationOnce(() =>
      (async function* () {
        caller.abort();
        yield { type: LlmEventType.UserCancelled };
      })(),
    );

    const events = await collect(
      client.sendMessageStream(
        [{ text: 'work until cancelled' }],
        caller.signal,
        'goal-prompt',
        {
          type: SendMessageType.Goal,
          goalPermit: permit,
          goalTurnKey: `goal-runtime:${permit.turnId}`,
        },
      ),
    );

    expect(runtime.dispatch).toHaveBeenCalledWith({
      action: 'pause',
      expectedGoalId: permit.goalId,
      expectedRevision: permit.revision,
    });
    expect(order).toEqual(['pause', 'flush', 'finish']);
    expect(goalStateEvents(events).map((event) => event.cause)).toEqual([
      undefined,
      'pause',
      'turn_finished',
    ]);
    expect(
      eventIndex(events, LlmEventType.GoalState, (event) =>
        event.type === LlmEventType.GoalState
          ? event.cause === 'turn_finished'
          : false,
      ),
    ).toBeLessThan(eventIndex(events, LlmEventType.UserCancelled));
  });

  it('pauses and releases the current permit when model setup throws', async () => {
    const { client, runtime, recorder, order } = setupGoalClient();
    const setupError = new Error('model setup exploded');
    vi.mocked(recorder.flush).mockImplementationOnce(async () => {
      order.push('flush');
      throw new Error('cleanup flush exploded');
    });
    turnMocks.run.mockImplementationOnce(() => {
      throw setupError;
    });

    const { events, error } = await collectOutcome(
      client.sendMessageStream(
        [{ text: 'start work' }],
        new AbortController().signal,
        'goal-prompt',
        {
          type: SendMessageType.Goal,
          goalPermit: permit,
          goalTurnKey: `goal-runtime:${permit.turnId}`,
        },
      ),
    );

    expect(error).toBe(setupError);
    expect(runtime.dispatch).toHaveBeenCalledWith({
      action: 'pause',
      expectedGoalId: permit.goalId,
      expectedRevision: permit.revision,
    });
    expect(order).toEqual(['pause', 'flush', 'finish']);
    expect(goalStateEvents(events).map((event) => event.cause)).toEqual([
      undefined,
      'pause',
      'turn_finished',
    ]);
  });

  it('drains a concurrent pause before a blocking Stop hook recurses', async () => {
    const { client, config, runtime } = setupGoalClient();
    let stopRequestCount = 0;
    const messageBus = {
      request: vi.fn(async () => {
        stopRequestCount += 1;
        if (stopRequestCount === 1) {
          await runtime.dispatch({
            action: 'pause',
            expectedGoalId: permit.goalId,
            expectedRevision: permit.revision,
          });
          return {
            output: { decision: 'block', reason: 'Run the policy check' },
            stopHookCount: 1,
          };
        }
        return { output: undefined, stopHookCount: 1 };
      }),
    };
    vi.mocked(config.getDisableAllHooks).mockReturnValue(false);
    vi.mocked(config.getMessageBus).mockReturnValue(
      messageBus as unknown as ReturnType<Config['getMessageBus']>,
    );
    vi.mocked(config.hasHooksForEvent).mockImplementation(
      (event) => event === 'Stop',
    );
    const events = await collect(
      client.sendMessageStream(
        [{ text: 'continue' }],
        new AbortController().signal,
        'goal-prompt',
        {
          type: SendMessageType.Goal,
          goalPermit: permit,
          goalTurnKey: `goal-runtime:${permit.turnId}`,
        },
      ),
    );

    expect(turnMocks.constructors.map((args) => args[2])).toEqual([
      permit,
      permit,
    ]);
    expect(runtime.finishTurn).toHaveBeenCalledOnce();
    expect(messageBus.request).toHaveBeenCalledTimes(2);
    const pauseStateIndex = eventIndex(
      events,
      LlmEventType.GoalState,
      (event) =>
        event.type === LlmEventType.GoalState && event.cause === 'pause',
    );
    const inactiveProjectionIndex = eventIndex(
      events,
      LlmEventType.ActiveGoal,
      (event) => event.type === LlmEventType.ActiveGoal && event.value === null,
    );
    const loopIndex = eventIndex(events, LlmEventType.StopHookLoop);
    expect(pauseStateIndex).toBeGreaterThanOrEqual(0);
    expect(inactiveProjectionIndex).toBeGreaterThan(pauseStateIndex);
    expect(loopIndex).toBeGreaterThan(inactiveProjectionIndex);
  });

  it('drains a concurrent pause before a non-blocking Stop true-stops', async () => {
    const { client, config, runtime } = setupGoalClient();
    const messageBus = {
      request: vi.fn(async () => {
        await runtime.dispatch({
          action: 'pause',
          expectedGoalId: permit.goalId,
          expectedRevision: permit.revision,
        });
        return { output: undefined, stopHookCount: 1 };
      }),
    };
    vi.mocked(config.getDisableAllHooks).mockReturnValue(false);
    vi.mocked(config.getMessageBus).mockReturnValue(
      messageBus as unknown as ReturnType<Config['getMessageBus']>,
    );
    vi.mocked(config.hasHooksForEvent).mockImplementation(
      (event) => event === 'Stop',
    );

    const events = await collect(
      client.sendMessageStream(
        [{ text: 'continue' }],
        new AbortController().signal,
        'goal-prompt',
        {
          type: SendMessageType.Goal,
          goalPermit: permit,
          goalTurnKey: `goal-runtime:${permit.turnId}`,
        },
      ),
    );

    const pauseStateIndex = eventIndex(
      events,
      LlmEventType.GoalState,
      (event) =>
        event.type === LlmEventType.GoalState && event.cause === 'pause',
    );
    const inactiveProjectionIndex = eventIndex(
      events,
      LlmEventType.ActiveGoal,
      (event) => event.type === LlmEventType.ActiveGoal && event.value === null,
    );
    const finishStateIndex = eventIndex(
      events,
      LlmEventType.GoalState,
      (event) =>
        event.type === LlmEventType.GoalState &&
        event.cause === 'turn_finished',
    );
    expect(pauseStateIndex).toBeGreaterThanOrEqual(0);
    expect(inactiveProjectionIndex).toBeGreaterThan(pauseStateIndex);
    expect(finishStateIndex).toBeGreaterThan(inactiveProjectionIndex);
    expect(eventIndex(events, LlmEventType.StopHookLoop)).toBe(-1);
    expect(runtime.finishTurn).toHaveBeenCalledOnce();
  });

  it('resets the loop detector before each Goal-owned Hook continuation', async () => {
    const { client, config } = setupGoalClient();
    const reset = vi.spyOn(client['loopDetector'], 'reset');
    const messageBus = {
      request: vi.fn(async () => ({
        output: { decision: 'block', reason: 'continue checking' },
        stopHookCount: 1,
      })),
    };
    vi.mocked(config.getDisableAllHooks).mockReturnValue(false);
    vi.mocked(config.getMessageBus).mockReturnValue(
      messageBus as unknown as ReturnType<Config['getMessageBus']>,
    );
    vi.mocked(config.hasHooksForEvent).mockImplementation(
      (event) => event === 'Stop',
    );
    vi.mocked(config.getStopHookBlockingCap).mockReturnValue(5);

    await drain(
      client.sendMessageStream(
        [{ text: 'continue' }],
        new AbortController().signal,
        'goal-prompt',
        {
          type: SendMessageType.Hook,
          goalPermit: permit,
          goalTurnKey: `goal-runtime:${permit.turnId}`,
          goalOrigin: 'runtime',
        },
        2,
      ),
    );

    expect(turnMocks.run).toHaveBeenCalledTimes(2);
    expect(messageBus.request).toHaveBeenCalledTimes(2);
    expect(reset).toHaveBeenCalledTimes(2);
    expect(reset).toHaveBeenCalledWith('goal-prompt');
  });

  it('does not recurse with a stale permit when Goal preemption lands while draining steer input', async () => {
    const { client, config, runtime } = setupGoalClient();
    const permitController = new AbortController();
    let permitIsCurrent = true;
    vi.mocked(runtime.permitForTurn).mockImplementation(() =>
      permitIsCurrent ? { ...permit } : undefined,
    );
    const messageBus = {
      request: vi.fn(async () => ({
        output: { decision: 'block', reason: 'Run the policy check' },
        stopHookCount: 1,
      })),
    };
    vi.mocked(config.getDisableAllHooks).mockReturnValue(false);
    vi.mocked(config.getMessageBus).mockReturnValue(
      messageBus as unknown as ReturnType<Config['getMessageBus']>,
    );
    vi.mocked(config.hasHooksForEvent).mockImplementation(
      (event) => event === 'Stop',
    );
    const getSteerInput = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
        permitIsCurrent = false;
        permitController.abort();
        return undefined;
      });

    await drain(
      client.sendMessageStream(
        [{ text: 'continue' }],
        new AbortController().signal,
        'goal-prompt',
        {
          type: SendMessageType.Goal,
          goalPermit: permit,
          goalTurnKey: `goal-runtime:${permit.turnId}`,
          goalSignal: permitController.signal,
          getSteerInput,
        },
      ),
    );

    expect(getSteerInput).toHaveBeenCalledTimes(2);
    expect(turnMocks.constructors).toHaveLength(1);
    expect(runtime.dispatch).not.toHaveBeenCalled();
    expect(runtime.finishTurn).not.toHaveBeenCalled();
  });

  it('pauses Goal when a generic Stop-hook cap prevents further progress', async () => {
    const { client, config, runtime, order } = setupGoalClient();
    const messageBus = {
      request: vi.fn(async () => ({
        output: { decision: 'block', reason: 'still blocked' },
        stopHookCount: 1,
      })),
    };
    vi.mocked(config.getDisableAllHooks).mockReturnValue(false);
    vi.mocked(config.getMessageBus).mockReturnValue(
      messageBus as unknown as ReturnType<Config['getMessageBus']>,
    );
    vi.mocked(config.hasHooksForEvent).mockImplementation(
      (event) => event === 'Stop',
    );
    vi.mocked(config.getStopHookBlockingCap).mockReturnValue(1);

    const events = await collect(
      client.sendMessageStream(
        [{ text: 'continue' }],
        new AbortController().signal,
        'goal-prompt',
        {
          type: SendMessageType.Goal,
          goalPermit: permit,
          goalTurnKey: `goal-runtime:${permit.turnId}`,
        },
      ),
    );

    expect(runtime.dispatch).toHaveBeenCalledWith({
      action: 'pause',
      expectedGoalId: permit.goalId,
      expectedRevision: permit.revision,
    });
    expect(runtime.getSnapshot()).toMatchObject({
      goal: { status: 'paused' },
    });
    expect(turnMocks.run).toHaveBeenCalledOnce();
    expect(order).toEqual(['pause', 'flush', 'finish']);
    expect(events).toContainEqual({
      type: LlmEventType.HookSystemMessage,
      value:
        'Stop hook blocked continuation 1 consecutive time; overriding and ending the turn.',
    });
  });

  it('does not treat permit-owned preemption as a caller cancellation', async () => {
    const { client, runtime } = setupGoalClient();
    const permitController = new AbortController();
    turnMocks.run.mockImplementationOnce(
      (_model, _request, signal: AbortSignal) => {
        permitController.abort();
        expect(signal.aborted).toBe(true);
        return emptyStream();
      },
    );

    await drain(
      client.sendMessageStream(
        [{ text: 'preempt me' }],
        new AbortController().signal,
        'goal-prompt',
        {
          type: SendMessageType.Goal,
          goalPermit: permit,
          goalTurnKey: `goal-runtime:${permit.turnId}`,
          goalSignal: permitController.signal,
        },
      ),
    );

    expect(runtime.dispatch).not.toHaveBeenCalled();
    expect(runtime.finishTurn).not.toHaveBeenCalled();
  });

  it('runs runtime-scheduled Goal turns beyond the former fixed limit without session budgets', async () => {
    const { client, config } = setupGoalClient();
    const goalJournal: GoalJournal = {
      getTranscriptCursor: () => ({ recordId: null }),
      async recordGoalState(
        recordUuid: string,
        payload: GoalStateRecordPayloadV2,
      ): Promise<ChatRecord> {
        return {
          uuid: recordUuid,
          parentUuid: null,
          sessionId: 'integration',
          timestamp: new Date(0).toISOString(),
          type: 'system',
          subtype: 'goal_state',
          provenance: 'goal_control',
          cwd: '/tmp',
          version: 'test',
          systemPayload: structuredClone(payload),
        };
      },
    };
    const runtime = createGoalRuntime({ journal: goalJournal });
    const started: GoalTurnPermit[] = [];
    runtime.bindHost({
      async startGoalTurn({ permit: nextPermit }) {
        started.push(structuredClone(nextPermit));
      },
      preemptGoalTurn: vi.fn(),
    });
    vi.mocked(config.getGoalRuntimeReady).mockResolvedValue(runtime);
    vi.mocked(config.getGoalRuntime).mockReturnValue(runtime);
    await runtime.dispatch({ action: 'create', objective: 'ship' });

    const turns = FORMER_GOAL_CONTINUATION_LIMIT + 25;
    for (let turn = 0; turn < turns; turn += 1) {
      const current = started[turn]!;
      await drain(
        client.sendMessageStream(
          [{ text: 'continue' }],
          new AbortController().signal,
          `goal-${turn}`,
          {
            type: SendMessageType.Goal,
            goalPermit: current,
            goalTurnKey: `goal-runtime:${current.turnId}`,
          },
        ),
      );
    }

    expect(started).toHaveLength(turns + 1);
    expect(turnMocks.run).toHaveBeenCalledTimes(turns);
    expect(client['sessionTurnCount']).toBe(0);
  });

  it('holds a runtime Goal turn to the caller recursion budget like any other send', async () => {
    // Each Goal continuation is a fresh top-level send that starts from
    // MAX_TURNS on its own, so a Goal has no reason to outlive one turn's
    // recursion allowance. A caller that hands over an exhausted budget gets
    // the same refusal every other message type gets -- and, because the
    // turn was admitted, the interrupted-exit path pauses the Goal instead
    // of leaving it running with a permit nobody will finish.
    const { client, runtime } = setupGoalClient();
    turnMocks.run.mockImplementation(async function* () {});

    const events = await collect(
      client.sendMessageStream(
        [{ text: 'continue' }],
        new AbortController().signal,
        'goal-exhausted',
        {
          type: SendMessageType.Goal,
          goalPermit: permit,
          goalTurnKey: `goal-runtime:${permit.turnId}`,
        },
        0,
      ),
    );

    expect(turnMocks.run).not.toHaveBeenCalled();
    expect(runtime.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'pause' }),
    );
    expect(runtime.finishTurn).toHaveBeenCalledOnce();
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: LlmEventType.MaxSessionTurns }),
    );
  });

  afterEach(() => __resetActiveGoalStoreForTests());

  it('admits a runtime Goal turn to steer input at a hit session cap', async () => {
    // Second half of the session-cap exclusion: runtime Goal turns skip the
    // count increment (pinned by the 75-turn test above) and must also be
    // admitted to steer input once the user's own turns hit the cap.
    const { client } = setupGoalClient();
    client['sessionTurnCount'] = 1;
    const getSteerInput = vi.fn().mockResolvedValue(undefined);

    await drain(
      client.sendMessageStream(
        [{ text: 'continue' }],
        new AbortController().signal,
        'goal-steer-cap',
        {
          type: SendMessageType.Goal,
          goalPermit: permit,
          goalTurnKey: `goal-runtime:${permit.turnId}`,
          getSteerInput,
        },
      ),
    );

    expect(getSteerInput).toHaveBeenCalled();
  });

  it('does not decrement the caller recursion budget inside a legacy hook Goal chain', async () => {
    // A legacy /goal chain recurses inside one sendMessageStream call. With
    // the caller budget of 2 preserved at every hop, two blocked stops still
    // run three model turns; a decremented budget would refuse the third.
    // Unsupported Goal runtime: the legacy hook chain owns the send, so the
    // branch under test is the one that keys the budget on the active goal.
    const { client, config } = setupGoalClient();
    vi.mocked(config.getGoalRuntimeReady).mockRejectedValue(
      new GoalPersistenceUnavailableError('legacy-only session'),
    );
    vi.mocked(config.getSkipNextSpeakerCheck).mockReturnValue(true);
    vi.mocked(config.getDisableAllHooks).mockReturnValue(false);
    vi.mocked(config.getMaxSessionTurns).mockReturnValue(0);
    vi.mocked(config.hasHooksForEvent).mockImplementation(
      (event) => event === 'Stop',
    );
    let stopRequestCount = 0;
    const messageBus = {
      request: vi.fn(async () => {
        stopRequestCount += 1;
        if (stopRequestCount <= 2) {
          return {
            output: { decision: 'block', reason: 'keep going' },
            stopHookCount: 1,
          };
        }
        return { output: undefined, stopHookCount: 1 };
      }),
    };
    vi.mocked(config.getMessageBus).mockReturnValue(
      messageBus as unknown as ReturnType<Config['getMessageBus']>,
    );
    setActiveGoal('goal-test-session', {
      condition: 'ship',
      iterations: 0,
      setAt: 1,
      tokensAtStart: 0,
      hookId: 'goal-hook:test',
    });

    await drain(
      client.sendMessageStream(
        [{ text: 'start the chain' }],
        new AbortController().signal,
        'legacy-goal-chain',
        undefined,
        2,
      ),
    );

    expect(messageBus.request).toHaveBeenCalledTimes(3);
    expect(turnMocks.run).toHaveBeenCalledTimes(3);
  });
});
