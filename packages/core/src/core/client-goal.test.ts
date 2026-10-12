/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Part } from '@google/genai';
import type { Config } from '../config/config.js';
import type { LlmChat } from './llm-chat.js';
import {
  createGoalRuntime,
  GoalPersistenceUnavailableError,
  type GoalJournal,
  type GoalRuntime,
} from '../goals/goal-runtime.js';
import {
  GOAL_PAUSE_REASON_HEADLESS_RUN_ENDED,
  GOAL_PAUSE_REASON_SESSION_TOKEN_LIMIT,
  GOAL_PAUSE_REASON_STOP_HOOK_CAP,
  GOAL_PAUSE_REASON_USER_INTERRUPT,
  goalPauseReasonForFailure,
  goalPauseReasonForHeadlessFailure,
  type GoalRecord,
  type GoalSnapshotV2,
  type GoalStateCause,
  type GoalStateRecordPayloadV2,
  type GoalTurnPermit,
} from '../goals/goal-protocol.js';
import type { ChatRecord } from '../services/chatRecordingService.js';
import { ApprovalMode } from '../config/config.js';
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

import {
  LlmClient,
  SendMessageType,
  type SendMessageOptions,
} from './client.js';
import { LlmEventType, type ServerLlmStreamEvent } from './turn.js';
import {
  collect,
  drain,
  fnResponse,
  streamOf,
} from '../test-utils/model-fixtures.js';

const FORMER_GOAL_CONTINUATION_LIMIT = 50;

const permit: GoalTurnPermit = {
  goalId: 'goal-1',
  revision: 1,
  turnId: 'turn-1',
};
// Send options carrying `permit` as the turn's exact Goal permit.
const exactPermit = {
  goalPermit: permit,
  goalTurnKey: `goal-runtime:${permit.turnId}`,
};
const SETTLEMENT_FAILED =
  'The approved Goal could not be started. Check the Goal status before trying again, or run:\n/goal set ship it';

function emptyStream() {
  return (async function* () {})();
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

// A Goal record; the defaults describe the Goal `permit` was issued for.
const goalRecord = (overrides: Partial<GoalRecord> = {}): GoalRecord => ({
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
  ...overrides,
});

const proposal = (objective: string, turnKey: string): PendingGoalProposal => ({
  objective,
  turnKey,
  reviewedGoal: null,
});

// take(expectedTurnKey) only hands over a proposal parked for that turn,
// unless `matchTurnKey` is off.
function pendingGoalProposalStore(
  initial?: PendingGoalProposal,
  matchTurnKey = true,
) {
  let pending = initial;
  return {
    get: () => pending,
    set: (proposal: PendingGoalProposal) => {
      pending = proposal;
    },
    take: vi.fn((expectedTurnKey?: string) => {
      const proposal = pending;
      if (
        matchTurnKey &&
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
const keylessSlot = (initial?: PendingGoalProposal) =>
  pendingGoalProposalStore(initial, false);

type GoalStateEvent = Extract<
  ServerLlmStreamEvent,
  { type: LlmEventType.GoalState }
>;

const goalStateCauses = (events: unknown[]) =>
  events
    .filter(
      (event): event is GoalStateEvent =>
        (event as { type?: LlmEventType }).type === LlmEventType.GoalState,
    )
    .map((event) => event.cause);

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

const goalStateIndex = (events: unknown[], cause: GoalStateCause | undefined) =>
  eventIndex(
    events,
    LlmEventType.GoalState,
    (event) => event.type === LlmEventType.GoalState && event.cause === cause,
  );

function setupGoalClient() {
  const order: string[] = [];
  let snapshot: GoalSnapshotV2 = {
    v: 2,
    activity: 'running',
    goal: goalRecord(),
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
    getActiveTodoReminder: vi.fn(() => undefined),
    getContentGeneratorConfig: vi.fn(() => undefined),
    hasHooksForEvent: vi.fn(() => false),
    getStopHookBlockingCap: vi.fn(() => 8),
    isManagedMemoryAvailable: vi.fn(() => false),
    getManagedAutoMemoryEnabled: vi.fn(() => false),
    getMemoryManager: vi.fn(() => ({
      resetExhaustedBodyRefsForCurrentTurn: vi.fn(),
      reconcileMemoryBodiesPresentInHistory: vi.fn(),
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
    getGoalProposalHostSupported: vi.fn(() => false),
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

// Sends `request` on a fresh caller signal unless one is given. Tests drain
// or collect the stream: consuming it runs the client's true-Stop path.
function send(
  client: LlmClient,
  request: string | Part[],
  promptId: string,
  options: SendMessageOptions,
  {
    signal = new AbortController().signal,
    turns,
  }: { signal?: AbortSignal; turns?: number } = {},
) {
  return client.sendMessageStream(
    typeof request === 'string' ? [{ text: request }] : request,
    signal,
    promptId,
    options,
    turns,
  );
}
const userQuery = (
  client: LlmClient,
  text: string,
  promptId: string,
  extra: Partial<SendMessageOptions> = {},
) =>
  send(client, text, promptId, { type: SendMessageType.UserQuery, ...extra });
// A Goal turn under the exact `permit`.
const goalTurn = (
  client: LlmClient,
  text: string,
  extra: Partial<SendMessageOptions> = {},
  {
    promptId = 'goal-prompt',
    ...sendOptions
  }: { promptId?: string; signal?: AbortSignal; turns?: number } = {},
) =>
  send(
    client,
    text,
    promptId,
    { type: SendMessageType.Goal, ...exactPermit, ...extra },
    sendOptions,
  );
const toolResult = (
  client: LlmClient,
  promptId: string,
  name = 'read_file',
  output = 'ok',
) =>
  send(client, [fnResponse(name, { output })], promptId, {
    type: SendMessageType.ToolResult,
  });
const backgroundNotification = (client: LlmClient, promptId = 'notification') =>
  send(client, 'background notification', promptId, {
    type: SendMessageType.Notification,
  });

// Hands the client `take` as its proposal slot, with usage statistics off.
const useProposals = (
  config: Config,
  take: unknown,
  extra: Record<string, unknown> = {},
) =>
  Object.assign(config, {
    takePendingGoalProposal: take,
    getUsageStatisticsEnabled: vi.fn(() => false),
    ...extra,
  });
const withoutGoal = (runtime: GoalRuntime) =>
  vi
    .mocked(runtime.getSnapshot)
    .mockReturnValue({ v: 2, activity: 'idle', goal: null });
// `create` answers with a snapshot that still has no Goal: settlement fails.
const createLeavesNoGoal = (runtime: GoalRuntime) =>
  vi.mocked(runtime.dispatch).mockResolvedValueOnce({
    snapshot: { v: 2, activity: 'idle', goal: null },
  });
// A user query whose model turn parks a proposal for its own turn key.
function proposingQuery(
  client: LlmClient,
  slot: { set: (proposal: PendingGoalProposal) => void },
  turnKey: string,
  objective = 'ship it',
) {
  turnMocks.run.mockImplementationOnce(() => {
    slot.set(proposal(objective, turnKey));
    return emptyStream();
  });
  return userQuery(client, 'set a goal for this', turnKey);
}
// Settles the parked proposal at the end of `turnKey`'s turn.
const settle = (
  client: LlmClient,
  turnKey: string,
  loadGoalRuntime: () => Promise<GoalRuntime | undefined>,
  {
    signal = new AbortController().signal,
    reportFailure = vi.fn(),
  }: { signal?: AbortSignal; reportFailure?: (message: string) => void } = {},
) =>
  client['settlePendingGoalProposal'](
    true,
    signal,
    loadGoalRuntime,
    turnKey,
    reportFailure,
  );
const expectCreated = (runtime: GoalRuntime, objective = 'ship it') =>
  expect(runtime.dispatch).toHaveBeenCalledWith({
    action: 'create',
    objective,
  });
const expectPaused = (runtime: GoalRuntime, reason: string) =>
  expect(runtime.dispatch).toHaveBeenCalledWith({
    action: 'pause',
    expectedGoalId: permit.goalId,
    expectedRevision: permit.revision,
    reason,
  });
// A concurrent, reasonless pause of the Goal `permit` belongs to.
const pauseGoal = (runtime: GoalRuntime) =>
  runtime.dispatch({
    action: 'pause',
    expectedGoalId: permit.goalId,
    expectedRevision: permit.revision,
  });

// Enables hooks for `events` only, answered by `messageBus`.
function enableHooks(config: Config, messageBus: unknown, ...events: string[]) {
  vi.mocked(config.getDisableAllHooks).mockReturnValue(false);
  vi.mocked(config.getMessageBus).mockReturnValue(
    messageBus as ReturnType<Config['getMessageBus']>,
  );
  vi.mocked(config.hasHooksForEvent).mockImplementation((event) =>
    events.includes(event),
  );
}
// A message bus on which every hook blocks with `reason`.
const blockingBus = (reason: string, stopHookCount?: number) => ({
  request: vi.fn(async () => ({
    output: { decision: 'block', reason },
    ...(stopHookCount === undefined ? {} : { stopHookCount }),
  })),
});
const throwingBus = (message: string) => ({
  request: vi.fn(async () => {
    throw new Error(message);
  }),
});
// Every Stop hook blocks with `reason` (stopHookCount 1), capped at `cap`.
function blockStopHook(config: Config, reason: string, cap?: number) {
  const messageBus = blockingBus(reason, 1);
  enableHooks(config, messageBus, 'Stop');
  if (cap !== undefined) {
    vi.mocked(config.getStopHookBlockingCap).mockReturnValue(cap);
  }
  return messageBus;
}
const stopHookActiveFlags = (request: ReturnType<typeof vi.fn>) =>
  request.mock.calls
    .filter(([hookRequest]) => hookRequest.eventName === 'Stop')
    .map(([hookRequest]) => hookRequest.input.stop_hook_active);

describe('LlmClient Goal admission', () => {
  beforeEach(() => {
    turnMocks.constructors.length = 0;
    turnMocks.pendingToolCalls.length = 0;
    turnMocks.run.mockReset().mockImplementation(emptyStream);
    nextSpeakerMocks.check.mockReset().mockResolvedValue({
      next_speaker: 'model',
    });
  });

  it('sets an approved propose_goal proposal once the turn ends without tool calls', async () => {
    const { client, config, runtime } = setupGoalClient();
    nextSpeakerMocks.check.mockResolvedValue({ next_speaker: 'user' });
    withoutGoal(runtime);
    const takePendingGoalProposal = vi
      .fn()
      .mockReturnValueOnce(undefined) // the new-query discard
      .mockReturnValueOnce(proposal('ship it', 'real-user-key'));
    useProposals(config, takePendingGoalProposal);

    await drain(userQuery(client, 'set a goal for this', 'real-user-key'));

    expect(takePendingGoalProposal).toHaveBeenCalledTimes(2);
    expectCreated(runtime);
  });

  it('leaves a host-owned approved proposal for Session settlement', async () => {
    const { client, config, runtime } = setupGoalClient();
    vi.mocked(config.getGoalProposalHostSupported).mockReturnValue(true);
    const store = pendingGoalProposalStore(
      proposal('ship it', 'host-owned-key'),
    );
    const loadGoalRuntime = vi.fn(async () => runtime);
    Object.assign(config, { takePendingGoalProposal: store.take });

    await settle(client, 'host-owned-key', loadGoalRuntime);

    expect(store.get()).toEqual(proposal('ship it', 'host-owned-key'));
    expect(store.take).not.toHaveBeenCalled();
    expect(loadGoalRuntime).not.toHaveBeenCalled();
    expect(runtime.dispatch).not.toHaveBeenCalled();
    expect(store.take('host-owned-key')).toEqual(
      proposal('ship it', 'host-owned-key'),
    );
  });

  it('reports recovery when the core-owned proposal runtime is unavailable', async () => {
    const { client, config } = setupGoalClient();
    const store = pendingGoalProposalStore(
      proposal('ship it', 'runtime-unavailable-key'),
    );
    const reportFailure = vi.fn();
    Object.assign(config, { takePendingGoalProposal: store.take });

    await settle(client, 'runtime-unavailable-key', async () => undefined, {
      reportFailure,
    });

    expect(store.get()).toBeUndefined();
    expect(reportFailure).toHaveBeenCalledWith(SETTLEMENT_FAILED);
  });

  it('reports a proposal that could not be applied to the terminal user', async () => {
    const { client, config, runtime } = setupGoalClient();
    vi.mocked(config.getSkipNextSpeakerCheck).mockReturnValue(true);
    withoutGoal(runtime);
    createLeavesNoGoal(runtime);
    const store = pendingGoalProposalStore();
    useProposals(config, store.take);

    const events = await collect(
      proposingQuery(client, store, 'failed-settlement-key'),
    );

    expect(events).toContainEqual({
      type: LlmEventType.GoalSettlementFailed,
      value: SETTLEMENT_FAILED,
    });
  });

  it('does not suggest replacing a Goal that changed after approval', async () => {
    const { client, config, runtime } = setupGoalClient();
    vi.mocked(config.getSkipNextSpeakerCheck).mockReturnValue(true);
    vi.mocked(runtime.getSnapshot).mockReturnValue({
      v: 2,
      activity: 'idle',
      goal: goalRecord({
        goalId: 'newer-goal',
        revision: 2,
        objective: 'newer objective',
        status: 'paused',
        evidenceCursor: { recordId: 'newer-record' },
        updatedAt: 2,
      }),
    });
    const store = pendingGoalProposalStore();
    useProposals(config, store.take);

    const events = await collect(
      proposingQuery(client, store, 'changed-goal-key', 'stale objective'),
    );
    const failure = events.find(
      (event) => event.type === LlmEventType.GoalSettlementFailed,
    ) as Extract<
      ServerLlmStreamEvent,
      { type: LlmEventType.GoalSettlementFailed }
    >;

    expect(failure.value).toContain('Goal changed after the proposal');
    expect(failure.value).not.toContain('/goal set');
    expect(runtime.dispatch).not.toHaveBeenCalled();
  });

  it('settles an approved proposal on the default skip-next-speaker exit', async () => {
    const { client, config, runtime } = setupGoalClient();
    withoutGoal(runtime);
    const slot = keylessSlot();
    useProposals(config, slot.take, {
      getSkipNextSpeakerCheck: vi.fn(() => true),
    });

    await drain(proposingQuery(client, slot, 'default-exit-key'));

    expect(nextSpeakerMocks.check).not.toHaveBeenCalled();
    expectCreated(runtime);
  });

  it('settles an approved proposal when a blocking Stop hook hits its cap', async () => {
    const { client, config, runtime } = setupGoalClient();
    withoutGoal(runtime);
    const slot = keylessSlot();
    useProposals(config, slot.take);
    blockStopHook(config, 'Keep working', 1);

    await drain(proposingQuery(client, slot, 'stop-cap-key'));

    expectCreated(runtime);
  });

  it('reports a failed proposal settlement from the Stop-hook-cap exit', async () => {
    const { client, config, runtime } = setupGoalClient();
    withoutGoal(runtime);
    createLeavesNoGoal(runtime);
    const store = pendingGoalProposalStore();
    useProposals(config, store.take);
    blockStopHook(config, 'Keep working', 1);

    const events = await collect(
      proposingQuery(client, store, 'stop-cap-failure-key'),
    );

    expect(events).toContainEqual({
      type: LlmEventType.GoalSettlementFailed,
      value: SETTLEMENT_FAILED,
    });
  });

  it('discards an approved proposal when settlement starts already aborted', async () => {
    const { client, config, runtime } = setupGoalClient();
    const controller = new AbortController();
    controller.abort();
    const slot = keylessSlot(proposal('ship it', 'settle-key'));
    const loadGoalRuntime = vi.fn(async () => runtime);
    Object.assign(config, { takePendingGoalProposal: slot.take });

    await settle(client, 'settle-key', loadGoalRuntime, {
      signal: controller.signal,
    });

    expect(slot.get()).toBeUndefined();
    expect(loadGoalRuntime).not.toHaveBeenCalled();
    expect(runtime.dispatch).not.toHaveBeenCalled();
  });

  it('keeps an approved proposal parked until its ToolResult turn ends', async () => {
    const { client, config, runtime } = setupGoalClient();
    nextSpeakerMocks.check.mockResolvedValue({ next_speaker: 'user' });
    withoutGoal(runtime);
    const slot = keylessSlot();
    useProposals(config, slot.take, { getMaxSessionTurns: vi.fn(() => 0) });
    turnMocks.pendingToolCalls.push([{ name: 'read_file' }], []);

    await drain(proposingQuery(client, slot, 'pending-tool-key'));

    expect(slot.take).toHaveBeenCalledOnce();
    expect(runtime.dispatch).not.toHaveBeenCalled();
    expect(slot.get()).toEqual(proposal('ship it', 'pending-tool-key'));

    await drain(toolResult(client, 'pending-tool-key'));

    expect(slot.take).toHaveBeenCalledTimes(2);
    expectCreated(runtime);
  });

  it('reports a failed proposal settlement from the ToolResult exit', async () => {
    const { client, config, runtime } = setupGoalClient();
    nextSpeakerMocks.check.mockResolvedValue({ next_speaker: 'user' });
    withoutGoal(runtime);
    createLeavesNoGoal(runtime);
    const store = pendingGoalProposalStore(
      proposal('ship it', 'tool-result-failure-key'),
    );
    useProposals(config, store.take);

    const events = await collect(toolResult(client, 'tool-result-failure-key'));

    expect(events).toContainEqual({
      type: LlmEventType.GoalSettlementFailed,
      value: SETTLEMENT_FAILED,
    });
  });

  it('keeps an approved proposal parked through a queued steer continuation', async () => {
    const { client, config, runtime } = setupGoalClient();
    vi.mocked(config.getMaxSessionTurns).mockReturnValue(0);
    nextSpeakerMocks.check.mockResolvedValue({ next_speaker: 'user' });
    const slot = keylessSlot();
    useProposals(config, slot.take);
    let snapshot: GoalSnapshotV2 = { v: 2, activity: 'idle', goal: null };
    vi.mocked(runtime.getSnapshot).mockImplementation(() =>
      structuredClone(snapshot),
    );
    vi.mocked(runtime.dispatch).mockImplementation(async (request) => {
      if (request.action === 'create') {
        snapshot = {
          v: 2,
          activity: 'idle',
          goal: goalRecord({
            goalId: 'proposal-goal',
            objective: request.objective,
            evidenceCursor: { recordId: 'proposal-create' },
          }),
        };
      }
      return { snapshot: structuredClone(snapshot) };
    });
    turnMocks.run
      .mockImplementationOnce(() => {
        slot.set(proposal('ship it', 'real-user-key'));
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
      userQuery(client, 'set a goal for this', 'real-user-key', {
        getSteerInput,
      }),
    );

    expect(turnMocks.run).toHaveBeenCalledTimes(2);
    expect(runtime.dispatch).toHaveBeenCalledTimes(1);
    expectCreated(runtime);
  });

  it('drops a proposal when its turn exits with a provider error', async () => {
    const { client, config, runtime } = setupGoalClient();
    vi.mocked(config.getMaxSessionTurns).mockReturnValue(0);
    withoutGoal(runtime);
    const store = pendingGoalProposalStore();
    useProposals(config, store.take, {
      getSkipNextSpeakerCheck: vi.fn(() => true),
    });
    turnMocks.run.mockImplementationOnce(async function* () {
      store.set(proposal('stale proposal', 'failed-user-key'));
      yield { type: LlmEventType.Error, value: { error: { status: 500 } } };
    });

    await drain(userQuery(client, 'set a goal for this', 'failed-user-key'));
    expect(store.get()).toBeUndefined();
    await drain(backgroundNotification(client, 'notification-key'));

    expect(runtime.dispatch).not.toHaveBeenCalled();
  });

  it('drops a proposal when cancellation lands during runtime readiness', async () => {
    const { client, config, runtime } = setupGoalClient();
    // No Goal at the boundary, as in production: the only thing standing
    // between the approval and `create` is the post-loader abort guard.
    withoutGoal(runtime);
    const controller = new AbortController();
    const slot = keylessSlot(proposal('ship it', 'settle-key'));
    Object.assign(config, { takePendingGoalProposal: slot.take });

    await settle(
      client,
      'settle-key',
      async () => {
        controller.abort();
        return runtime;
      },
      { signal: controller.signal },
    );

    // Dropped means taken and not applied: the slot is empty afterwards, so
    // a later boundary cannot revive the cancelled approval.
    expect(slot.take).toHaveBeenCalledTimes(1);
    expect(slot.get()).toBeUndefined();
    expect(runtime.dispatch).not.toHaveBeenCalled();
  });

  it('pauses a proposal applied while cancellation is landing', async () => {
    const { client, config, runtime } = setupGoalClient();
    const controller = new AbortController();
    Object.assign(config, {
      takePendingGoalProposal: vi.fn(() => proposal('ship it', 'settle-key')),
    });
    const appliedGoal = goalRecord({
      goalId: 'proposal-goal',
      objective: 'ship it',
      evidenceCursor: { recordId: 'proposal-create' },
    });
    withoutGoal(runtime);
    vi.mocked(runtime.dispatch)
      .mockImplementationOnce(async () => {
        controller.abort();
        return { snapshot: { v: 2, activity: 'idle', goal: appliedGoal } };
      })
      .mockResolvedValueOnce({
        snapshot: {
          v: 2,
          activity: 'idle',
          goal: { ...appliedGoal, status: 'paused' },
        },
      });

    await settle(client, 'settle-key', async () => runtime, {
      signal: controller.signal,
    });

    expect(runtime.dispatch).toHaveBeenNthCalledWith(1, {
      action: 'create',
      objective: 'ship it',
    });
    expect(runtime.dispatch).toHaveBeenNthCalledWith(2, {
      action: 'pause',
      expectedGoalId: appliedGoal.goalId,
      expectedRevision: appliedGoal.revision,
      reason: GOAL_PAUSE_REASON_USER_INTERRUPT,
    });
  });

  it.each(['terminal', 'aborted', 'throwing', 'side-query'] as const)(
    'leaves the owner approval parked through a foreign %s turn',
    async (exit) => {
      const { client, config, runtime } = setupGoalClient();
      nextSpeakerMocks.check.mockResolvedValue({ next_speaker: 'user' });
      withoutGoal(runtime);
      const store = pendingGoalProposalStore(
        proposal('approved earlier', 'owner-key'),
      );
      useProposals(config, store.take, { getMaxSessionTurns: vi.fn(() => 0) });

      if (exit === 'aborted') {
        const controller = new AbortController();
        controller.abort();
        await settle(client, 'foreign-key', async () => runtime, {
          signal: controller.signal,
        });
      } else {
        if (exit === 'throwing') {
          turnMocks.run.mockImplementationOnce(() => {
            throw new Error('provider exploded');
          });
        }
        const foreignTurn = drain(
          send(
            client,
            'background task finished',
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
      expect(store.get()).toEqual(proposal('approved earlier', 'owner-key'));
      expect(runtime.dispatch).not.toHaveBeenCalled();

      await settle(client, 'owner-key', async () => runtime);

      expect(store.get()).toBeUndefined();
      expectCreated(runtime, 'approved earlier');
    },
  );

  it('clears a stale approval before a blocked user query', async () => {
    const { client, config, runtime } = setupGoalClient();
    const store = pendingGoalProposalStore(
      proposal('stale approval', 'cancelled-key'),
    );
    Object.assign(config, { takePendingGoalProposal: store.take });
    enableHooks(config, blockingBus('policy denied'), 'UserPromptSubmit');

    const events = await collect(
      userQuery(client, 'replacement query', 'replacement-key'),
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
    withoutGoal(runtime);
    const store = pendingGoalProposalStore(
      proposal('stale approval', 'cancelled-key'),
    );
    useProposals(config, store.take, {
      getSkipNextSpeakerCheck: vi.fn(() => true),
    });

    await drain(
      send(client, 'retry the interrupted request', 'retry-key', {
        type: SendMessageType.Retry,
      }),
    );

    expect(store.take).toHaveBeenNthCalledWith(1);
    expect(store.get()).toBeUndefined();
    expect(runtime.dispatch).not.toHaveBeenCalled();
  });

  it.each(['blocked', 'throwing'] as const)(
    '%s owner ToolResult hook closes its parked approval',
    async (hookExit) => {
      const { client, config, runtime } = setupGoalClient();
      withoutGoal(runtime);
      const store = pendingGoalProposalStore(proposal('ship it', 'owner-key'));
      Object.assign(config, { takePendingGoalProposal: store.take });
      enableHooks(
        config,
        hookExit === 'throwing'
          ? throwingBus('hook exploded')
          : blockingBus('policy denied'),
        'UserPromptSubmit',
      );

      const ownerStream = toolResult(
        client,
        'owner-key',
        'propose_goal',
        'approved',
      );
      let events: unknown[] = [];
      if (hookExit === 'throwing') {
        await expect(drain(ownerStream)).rejects.toThrow('hook exploded');
      } else {
        events = await collect(ownerStream);
      }

      expect(store.get()).toBeUndefined();
      if (hookExit === 'blocked') {
        expectCreated(runtime);
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
      withoutGoal(runtime);
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
      useProposals(config, store.take);
      enableHooks(
        config,
        messageBus,
        'UserPromptSubmit',
        ...(continuation === 'Stop-hook' ? ['Stop'] : []),
      );
      if (continuation === 'next-speaker') {
        nextSpeakerMocks.check.mockResolvedValue({ next_speaker: 'model' });
      }

      await drain(proposingQuery(client, store, 'owner-key'));

      expect(turnMocks.run).toHaveBeenCalledOnce();
      expect(store.get()).toBeUndefined();
      expect(runtime.dispatch).toHaveBeenCalledTimes(1);
      expectCreated(runtime);
    },
  );

  it('discards a proposal still parked when the next user query starts', async () => {
    // The proposing turn was cancelled before its boundary; the approval must
    // not start a loop from under the user's next message.
    const { client, config, runtime } = setupGoalClient();
    withoutGoal(runtime);
    const takePendingGoalProposal = vi
      .fn()
      .mockReturnValueOnce(proposal('stale', 'cancelled-turn-key'))
      .mockReturnValue(undefined);
    useProposals(config, takePendingGoalProposal);

    await drain(userQuery(client, 'something else', 'real-user-key'));

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
      goalTurn(client, 'Continue the Goal.', { getQueuedGoalTurnKey }),
    );

    expect(runtime.permitForTurn).toHaveBeenCalledWith(exactPermit.goalTurnKey);
    expect(recorder.recordGoalRuntimeMessage).toHaveBeenCalledWith(
      [{ text: 'Continue the Goal.' }],
      permit,
    );
    expect(turnMocks.constructors[0]?.[2]).toEqual(permit);
    expect(order).toEqual(['flush', 'peek', 'begin:queued-user', 'finish']);
    expect(nextSpeakerMocks.check).not.toHaveBeenCalled();
    expect(unsubscribeGoalState).toHaveBeenCalledOnce();
    expect(goalStateCauses(events)).toEqual([undefined, 'turn_finished']);
    const initialGoalStateIndex = goalStateIndex(events, undefined);
    expect(initialGoalStateIndex).toBeGreaterThanOrEqual(0);
    expect(events[initialGoalStateIndex]).toMatchObject({
      type: LlmEventType.GoalState,
      value: { goal: { objective: 'ship', goalId: 'goal-1', revision: 1 } },
    });
  });

  it('fails closed before recording or sampling when an automatic permit is stale', async () => {
    const { client, runtime, recorder } = setupGoalClient();
    vi.mocked(runtime.permitForTurn).mockReturnValue(undefined);

    await expect(drain(goalTurn(client, 'stale continuation'))).rejects.toThrow(
      'Goal turn permit is no longer valid',
    );

    expect(recorder.recordGoalRuntimeMessage).not.toHaveBeenCalled();
    expect(turnMocks.run).not.toHaveBeenCalled();
  });

  it('requires an explicit permit for automatic Goal text', async () => {
    const { client, recorder } = setupGoalClient();

    await expect(
      drain(
        send(client, 'looks like a Goal but is not admitted', 'goal-prompt', {
          type: SendMessageType.Goal,
        }),
      ),
    ).rejects.toThrow('requires an exact permit');

    expect(recorder.recordGoalRuntimeMessage).not.toHaveBeenCalled();
  });

  it('claims an active Goal for a real user and records real-user provenance', async () => {
    const { client, runtime, recorder } = setupGoalClient();
    vi.mocked(runtime.permitForTurn).mockReturnValueOnce(undefined);
    vi.mocked(runtime.beginTurn).mockReturnValueOnce({ ...permit });

    await drain(userQuery(client, 'user correction', 'real-user-key'));

    expect(runtime.beginTurn).toHaveBeenCalledWith('real-user-key');
    expect(recorder.recordUserMessage).toHaveBeenCalledWith(
      [{ text: 'user correction' }],
      permit,
      undefined,
      'real-user-key',
    );
    expect(recorder.recordGoalRuntimeMessage).not.toHaveBeenCalled();
    expect(turnMocks.constructors[0]?.[2]).toEqual(permit);
  });

  it('keeps real-user accounting when UserQuery receives a hidden automatic permit', async () => {
    const { client, runtime, recorder } = setupGoalClient();

    await drain(
      userQuery(
        client,
        'interrupt hidden continuation',
        'real-user-key',
        exactPermit,
      ),
    );

    expect(runtime.permitForTurn).toHaveBeenCalledWith(exactPermit.goalTurnKey);
    expect(recorder.recordAttributionSnapshot).toHaveBeenCalledOnce();
    expect(client['sessionTurnCount']).toBe(1);
  });

  it('releases a hidden exact permit when UserPromptSubmit blocks before sampling', async () => {
    const { client, config, runtime, recorder, order, unsubscribeGoalState } =
      setupGoalClient();
    enableHooks(config, blockingBus('policy denied'), 'UserPromptSubmit');

    const events = await collect(
      userQuery(client, 'blocked real user', 'real-user-key', exactPermit),
    );

    expect(runtime.finishTurn).toHaveBeenCalledWith(permit);
    expect(order).toEqual(['flush', 'finish']);
    expect(recorder.recordUserMessage).not.toHaveBeenCalled();
    expect(turnMocks.run).not.toHaveBeenCalled();
    expect(unsubscribeGoalState).toHaveBeenCalledOnce();
    expect(goalStateCauses(events)).toEqual([undefined, 'turn_finished']);
    expect(goalStateIndex(events, 'turn_finished')).toBeLessThan(
      eventIndex(events, LlmEventType.UserPromptSubmitBlocked),
    );
  });

  it('pauses and releases a hidden exact permit when UserPromptSubmit throws', async () => {
    const { client, config, runtime, order } = setupGoalClient();
    enableHooks(config, throwingBus('hook exploded'), 'UserPromptSubmit');

    await expect(
      drain(
        userQuery(client, 'throwing real user', 'real-user-key', exactPermit),
      ),
    ).rejects.toThrow('hook exploded');

    // The hook threw; the caller never aborted.
    expectPaused(
      runtime,
      goalPauseReasonForFailure('the turn was interrupted'),
    );
    expect(order).toEqual(['pause', 'flush', 'finish']);
    expect(turnMocks.run).not.toHaveBeenCalled();
  });

  it('explicitly rejects unrelated background sends while Goal owns the model', async () => {
    const { client, recorder } = setupGoalClient();

    await expect(drain(backgroundNotification(client))).rejects.toThrow(
      'active Goal requires an exact turn permit',
    );

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
      drain(userQuery(client, 'hello', 'plain-user-turn')),
    ).resolves.toBeUndefined();

    expect(turnMocks.run).toHaveBeenCalledOnce();
  });

  it('keeps unexpected Goal initialization failures fail-closed', async () => {
    const { client, config } = setupGoalClient();
    vi.mocked(config.getGoalRuntimeReady).mockRejectedValue(
      new TypeError('unexpected Goal initialization failure'),
    );

    await expect(
      drain(userQuery(client, 'hello', 'plain-user-turn')),
    ).rejects.toThrow('unexpected Goal initialization failure');

    expect(turnMocks.run).not.toHaveBeenCalled();
  });

  it('requires the exact permit while a paused Goal turn is still running', async () => {
    const { client, runtime, recorder } = setupGoalClient();
    await pauseGoal(runtime);
    expect(runtime.getSnapshot()).toMatchObject({
      activity: 'running',
      goal: { status: 'paused' },
    });

    await expect(drain(backgroundNotification(client))).rejects.toThrow(
      'active Goal requires an exact turn permit',
    );

    expect(recorder.recordNotification).not.toHaveBeenCalled();
    expect(turnMocks.run).not.toHaveBeenCalled();
  });

  it('accepts and true-stops a supplied Notification permit as runtime work', async () => {
    const { client, runtime, recorder, order } = setupGoalClient();

    await drain(
      send(client, 'dependency completed', 'notification', {
        type: SendMessageType.Notification,
        notificationDisplayText: 'Dependency completed',
        ...exactPermit,
        goalOrigin: 'runtime',
      }),
    );

    expect(runtime.permitForTurn).toHaveBeenCalledWith(exactPermit.goalTurnKey);
    expect(recorder.recordNotification).toHaveBeenCalledWith(
      [{ text: 'dependency completed' }],
      'Dependency completed',
      undefined,
      permit,
      // The send path stamps every delivered notification turn entry, which
      // is what lets recovery tell it apart from a cold pre-send record.
      true,
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
      goalTurn(client, 'work until cancelled', {}, { signal: caller.signal }),
    );

    expectPaused(runtime, GOAL_PAUSE_REASON_USER_INTERRUPT);
    expect(order).toEqual(['pause', 'flush', 'finish']);
    expect(goalStateCauses(events)).toEqual([
      undefined,
      'pause',
      'turn_finished',
    ]);
    expect(goalStateIndex(events, 'turn_finished')).toBeLessThan(
      eventIndex(events, LlmEventType.UserCancelled),
    );
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
      goalTurn(client, 'start work'),
    );

    expect(error).toBe(setupError);
    // Model setup threw; the caller never aborted, so this is a failure
    // rather than a user interrupt.
    expectPaused(
      runtime,
      goalPauseReasonForFailure('the turn was interrupted'),
    );
    expect(order).toEqual(['pause', 'flush', 'finish']);
    expect(goalStateCauses(events)).toEqual([
      undefined,
      'pause',
      'turn_finished',
    ]);
  });

  it('uses the host reason when an interrupted Goal send releases its permit', async () => {
    const { client, runtime } = setupGoalClient();
    const setupError = new Error('model setup exploded');
    const getInterruptedGoalPauseReason = vi.fn(
      () => GOAL_PAUSE_REASON_HEADLESS_RUN_ENDED,
    );
    turnMocks.run.mockImplementationOnce(() => {
      throw setupError;
    });

    const { error } = await collectOutcome(
      goalTurn(client, 'start work', { getInterruptedGoalPauseReason }),
    );

    expect(error).toBe(setupError);
    expect(getInterruptedGoalPauseReason).toHaveBeenCalledOnce();
    // The host needs the error to tell a turn that died from one that merely
    // stopped; without it every failure reads as a clean stop.
    expect(getInterruptedGoalPauseReason).toHaveBeenCalledWith({
      failure: 'model setup exploded',
    });
    expectPaused(runtime, GOAL_PAUSE_REASON_HEADLESS_RUN_ENDED);
  });

  it('passes loop detection failures to the host pause-reason resolver', async () => {
    const { client, runtime } = setupGoalClient();
    vi.spyOn(
      client['loopDetector'],
      'checkAlwaysOnSafeties',
    ).mockReturnValueOnce(true);
    turnMocks.run.mockReturnValueOnce(
      streamOf({
        type: LlmEventType.ToolCallRequest,
        value: {
          callId: 'loop-tool',
          name: 'read_file',
          args: {},
          isClientInitiated: false,
          prompt_id: 'goal-prompt',
        },
      }),
    );
    const getInterruptedGoalPauseReason = vi.fn(
      (interruption?: { failure?: string }) =>
        goalPauseReasonForHeadlessFailure(interruption?.failure ?? ''),
    );

    await drain(
      goalTurn(client, 'start work', { getInterruptedGoalPauseReason }),
    );

    expect(getInterruptedGoalPauseReason).toHaveBeenCalledWith({
      failure: 'loop detected',
    });
    expectPaused(runtime, goalPauseReasonForHeadlessFailure('loop detected'));
  });

  it('drains a concurrent pause before a blocking Stop hook recurses', async () => {
    const { client, config, runtime } = setupGoalClient();
    let stopRequestCount = 0;
    const messageBus = {
      request: vi.fn(async () => {
        stopRequestCount += 1;
        if (stopRequestCount === 1) {
          await pauseGoal(runtime);
          return {
            output: { decision: 'block', reason: 'Run the policy check' },
            stopHookCount: 1,
          };
        }
        return { output: undefined, stopHookCount: 1 };
      }),
    };
    enableHooks(config, messageBus, 'Stop');
    const events = await collect(goalTurn(client, 'continue'));

    expect(turnMocks.constructors.map((args) => args[2])).toEqual([
      permit,
      permit,
    ]);
    expect(runtime.finishTurn).toHaveBeenCalledOnce();
    expect(messageBus.request).toHaveBeenCalledTimes(2);
    const pauseStateIndex = goalStateIndex(events, 'pause');
    const loopIndex = eventIndex(events, LlmEventType.StopHookLoop);
    expect(pauseStateIndex).toBeGreaterThanOrEqual(0);
    expect(loopIndex).toBeGreaterThan(pauseStateIndex);
  });

  it('reports stop_hook_active on a goal-bound Stop hook continuation', async () => {
    const { client, config } = setupGoalClient();
    const messageBus = {
      request: vi
        .fn()
        .mockResolvedValueOnce({
          output: { decision: 'block', reason: 'Run the policy check' },
          stopHookCount: 1,
        })
        .mockResolvedValue({ output: undefined, stopHookCount: 1 }),
    };
    enableHooks(config, messageBus, 'Stop');

    await collect(goalTurn(client, 'continue'));

    expect(stopHookActiveFlags(messageBus.request)).toEqual([false, true]);
  });

  it('reports stop_hook_active false when a goal turn reuses a hook-forced prompt id', async () => {
    const { client, config } = setupGoalClient();
    const messageBus = blockStopHook(config, 'Run the policy check', 2);
    // Goal turn 1: the hook-forced continuation ends with a tool call that is
    // never returned. Goal turn 2 then runs under the same prompt id, which
    // is how consecutive goal continuations are submitted.
    turnMocks.pendingToolCalls.push(
      [],
      [{ name: 'read_file' }],
      [],
      [{ name: 'read_file' }],
    );
    const goalSend = () =>
      collect(
        goalTurn(client, 'continue', {}, { promptId: 'goal-prompt-shared' }),
      );

    await goalSend();
    const secondTurnEvents = await goalSend();

    expect(stopHookActiveFlags(messageBus.request)).toEqual([false, false]);
    expect(client['stopHookChains'].get('goal-prompt-shared')?.count).toBe(1);
    expect(secondTurnEvents).not.toContainEqual(
      expect.objectContaining({ type: LlmEventType.HookSystemMessage }),
    );
  });

  it('drains a concurrent pause before a non-blocking Stop true-stops', async () => {
    const { client, config, runtime } = setupGoalClient();
    const messageBus = {
      request: vi.fn(async () => {
        await pauseGoal(runtime);
        return { output: undefined, stopHookCount: 1 };
      }),
    };
    enableHooks(config, messageBus, 'Stop');

    const events = await collect(goalTurn(client, 'continue'));

    const pauseStateIndex = goalStateIndex(events, 'pause');
    const finishStateIndex = goalStateIndex(events, 'turn_finished');
    expect(pauseStateIndex).toBeGreaterThanOrEqual(0);
    expect(finishStateIndex).toBeGreaterThan(pauseStateIndex);
    expect(eventIndex(events, LlmEventType.StopHookLoop)).toBe(-1);
    expect(runtime.finishTurn).toHaveBeenCalledOnce();
  });

  it('resets the loop detector before each Goal-owned Hook continuation', async () => {
    const { client, config } = setupGoalClient();
    const reset = vi.spyOn(client['loopDetector'], 'reset');
    const messageBus = blockStopHook(config, 'continue checking', 5);

    await drain(
      send(
        client,
        'continue',
        'goal-prompt',
        { type: SendMessageType.Hook, ...exactPermit, goalOrigin: 'runtime' },
        { turns: 2 },
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
    blockStopHook(config, 'Run the policy check');
    const getSteerInput = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
        permitIsCurrent = false;
        permitController.abort();
        return undefined;
      });

    await drain(
      goalTurn(client, 'continue', {
        goalSignal: permitController.signal,
        getSteerInput,
      }),
    );

    expect(getSteerInput).toHaveBeenCalledTimes(2);
    expect(turnMocks.constructors).toHaveLength(1);
    expect(runtime.dispatch).not.toHaveBeenCalled();
    expect(runtime.finishTurn).not.toHaveBeenCalled();
  });

  it('pauses Goal when a generic Stop-hook cap prevents further progress', async () => {
    const { client, config, runtime, order } = setupGoalClient();
    blockStopHook(config, 'still blocked', 1);

    const events = await collect(goalTurn(client, 'continue'));

    // The cap is the reason the Goal stopped, and this dispatch is the one
    // that reaches the record -- a later reasoned pause on a paused Goal
    // throws.
    expectPaused(runtime, GOAL_PAUSE_REASON_STOP_HOOK_CAP);
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

  it('records the session token limit when it stops a Goal before sampling', async () => {
    const { client, config, runtime } = setupGoalClient();
    vi.mocked(config.getSessionTokenLimit).mockReturnValue(100);
    Object.assign(config, {
      getModelRouteIdentity: vi.fn(() => 'test-route'),
    });
    Object.assign(client.getChat(), {
      getLastPromptTokenCount: vi.fn(() => 101),
    });

    await drain(goalTurn(client, 'continue'));

    expectPaused(runtime, GOAL_PAUSE_REASON_SESSION_TOKEN_LIMIT);
    expect(turnMocks.run).not.toHaveBeenCalled();
  });

  it('lets the host name a Stop-hook cap pause in its own register', async () => {
    const { client, config, runtime } = setupGoalClient();
    blockStopHook(config, 'still blocked', 1);
    const hostReason =
      'The headless run stopped after the Stop hook cap. Resume the Goal in a later run.';
    const getInterruptedGoalPauseReason = vi.fn(() => hostReason);

    await drain(
      goalTurn(client, 'continue', { getInterruptedGoalPauseReason }),
    );

    expect(getInterruptedGoalPauseReason).toHaveBeenCalledWith({
      failure: undefined,
      cause: 'stop-hook-cap',
    });
    expectPaused(runtime, hostReason);
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
      goalTurn(client, 'preempt me', { goalSignal: permitController.signal }),
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
        send(client, 'continue', `goal-${turn}`, {
          type: SendMessageType.Goal,
          goalPermit: current,
          goalTurnKey: `goal-runtime:${current.turnId}`,
        }),
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
      goalTurn(
        client,
        'continue',
        {},
        { promptId: 'goal-exhausted', turns: 0 },
      ),
    );

    expect(turnMocks.run).not.toHaveBeenCalled();
    // A spent recursion budget is not a user interrupt: the caller signal is
    // never aborted here, so this pause has to read as a turn that could not
    // finish.
    expect(runtime.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'pause',
        reason: goalPauseReasonForFailure('the turn was interrupted'),
      }),
    );
    expect(runtime.finishTurn).toHaveBeenCalledOnce();
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: LlmEventType.MaxSessionTurns }),
    );
  });

  it('admits a runtime Goal turn to steer input at a hit session cap', async () => {
    // Second half of the session-cap exclusion: runtime Goal turns skip the
    // count increment (pinned by the 75-turn test above) and must also be
    // admitted to steer input once the user's own turns hit the cap.
    const { client } = setupGoalClient();
    client['sessionTurnCount'] = 1;
    const getSteerInput = vi.fn().mockResolvedValue(undefined);

    await drain(
      goalTurn(
        client,
        'continue',
        { getSteerInput },
        { promptId: 'goal-steer-cap' },
      ),
    );

    expect(getSteerInput).toHaveBeenCalled();
  });
});
