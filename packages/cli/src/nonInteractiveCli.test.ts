/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ChatRecord,
  Config,
  CronJob,
  ToolCallRequestInfo,
  ToolCallResponseInfo,
  GoalJournal,
  GoalRuntime,
  GoalStateRecordPayloadV2,
  GoalTurnPermit,
  ToolRegistry,
  ServerGeminiStreamEvent,
  SessionMetrics,
} from '@qwen-code/qwen-code-core';
import type { CLIUserMessage } from './nonInteractive/types.js';
import {
  executeToolCall,
  ToolErrorType,
  shutdownTelemetry,
  isTelemetrySdkInitialized,
  GeminiEventType,
  Kind,
  OutputFormat,
  uiTelemetryService,
  FatalInputError,
  ApprovalMode,
  SendMessageType,
  SYSTEM_REMINDER_OPEN,
  LoopType,
  CronScheduler,
  AUTONOMOUS_SENTINEL_CRON,
  AUTONOMOUS_SENTINEL_DYNAMIC,
  LOOP_SENTINEL_CRON,
  LOOP_SENTINEL_DYNAMIC,
  TeamEventType,
  ToolConfirmationOutcome,
  ToolNames,
  PLAN_MODE_ENTRY_SIBLING_SKIP_MESSAGE,
  createGoalRuntime,
} from '@qwen-code/qwen-code-core';
import type { Part } from '@google/genai';
import { EventEmitter } from 'node:events';
import {
  runNonInteractive,
  skipHeadlessLoopSentinel,
} from './nonInteractiveCli.js';
import { vi, type Mock, type MockInstance } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LoadedSettings } from './config/settings.js';
import { StreamJsonOutputAdapter } from './nonInteractive/io/StreamJsonOutputAdapter.js';
import { CommandKind, type ExecutionMode } from './ui/commands/types.js';
import { goalCommand } from './ui/commands/goalCommand.js';
import { filterCommandsForMode } from './services/commandUtils.js';
import { _resetCleanupFunctionsForTest } from './utils/cleanup.js';
import {
  AlreadyReportedError,
  _resetExitLatchForTest,
} from './utils/errors.js';

// Mock core modules
vi.mock('./ui/hooks/atCommandProcessor.js');
vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();

  class MockChatRecordingService {
    initialize = vi.fn();
    recordMessage = vi.fn();
    recordMessageTokens = vi.fn();
    recordToolCalls = vi.fn();
  }

  return {
    ...original,
    executeToolCall: vi.fn(),
    shutdownTelemetry: vi.fn(),
    isTelemetrySdkInitialized: vi.fn().mockReturnValue(true),
    ChatRecordingService: MockChatRecordingService,
    uiTelemetryService: {
      getMetrics: vi.fn(),
      getMetricsForSession: vi.fn(),
    },
  };
});

const mockGetCommands = vi.hoisted(() => vi.fn());
const mockGetCommandsForMode = vi.hoisted(() => vi.fn());
const mockCommandServiceCreate = vi.hoisted(() => vi.fn());
vi.mock('./services/CommandService.js', () => ({
  CommandService: {
    create: mockCommandServiceCreate,
  },
}));

function createGoalJournal(): GoalJournal {
  return {
    getTranscriptCursor: () => ({ recordId: null }),
    async recordGoalState(
      recordUuid: string,
      payload: GoalStateRecordPayloadV2,
    ): Promise<ChatRecord> {
      return {
        uuid: recordUuid,
        parentUuid: null,
        sessionId: 'test-session-id',
        timestamp: new Date(0).toISOString(),
        type: 'system',
        subtype: 'goal_state',
        provenance: 'goal_control',
        cwd: '/test/project',
        version: 'test',
        systemPayload: structuredClone(payload),
      };
    },
  };
}

describe('skipHeadlessLoopSentinel', () => {
  it('deletes a recurring session loop.md sentinel job so sessionSize reaches 0', () => {
    // A recurring SESSION (non-durable) loop.md job left in the scheduler keeps
    // sessionSize > 0, so the headless hold-open never resolves and the run
    // hangs. Skipping the sentinel must delete the job, not just no-op the tick.
    const scheduler = new CronScheduler();
    const job = scheduler.create('*/5 * * * *', LOOP_SENTINEL_CRON, true);
    expect(scheduler.sessionSize).toBe(1);

    expect(skipHeadlessLoopSentinel(scheduler, job)).toBe(true);

    expect(scheduler.sessionSize).toBe(0);
    expect(scheduler.list()).toHaveLength(0);
  });

  it('also cleans up a recurring session job for the dynamic sentinel', () => {
    // Mirror of the cron case for `<<loop.md-dynamic>>`. skipHeadlessLoopSentinel
    // must route through detectLoopSentinel (which matches BOTH sentinels), not a
    // `=== LOOP_SENTINEL_CRON` comparison — otherwise a dynamic loop.md job would
    // pin sessionSize > 0 and hang the headless run.
    const scheduler = new CronScheduler();
    const job = scheduler.create('*/5 * * * *', LOOP_SENTINEL_DYNAMIC, true);
    expect(scheduler.sessionSize).toBe(1);

    expect(skipHeadlessLoopSentinel(scheduler, job)).toBe(true);

    expect(scheduler.sessionSize).toBe(0);
    expect(scheduler.list()).toHaveLength(0);
  });

  it('also cleans up recurring autonomous sentinel jobs', () => {
    const scheduler = new CronScheduler();
    const cron = scheduler.create(
      '*/5 * * * *',
      AUTONOMOUS_SENTINEL_CRON,
      true,
    );
    const dynamic = scheduler.create(
      '*/5 * * * *',
      AUTONOMOUS_SENTINEL_DYNAMIC,
      true,
    );
    expect(scheduler.sessionSize).toBe(2);

    expect(skipHeadlessLoopSentinel(scheduler, cron)).toBe(true);
    expect(skipHeadlessLoopSentinel(scheduler, dynamic)).toBe(true);

    expect(scheduler.sessionSize).toBe(0);
    expect(scheduler.list()).toHaveLength(0);
  });

  it('returns false and keeps a non-sentinel job', () => {
    const scheduler = new CronScheduler();
    scheduler.create('*/5 * * * *', 'do real work', true);
    const job = scheduler.list()[0] as CronJob;

    expect(skipHeadlessLoopSentinel(scheduler, job)).toBe(false);

    expect(scheduler.sessionSize).toBe(1);
  });

  it('does not delete a durable sentinel job (it persists for a future session)', () => {
    // Durable jobs live under ~/.qwen and never count toward sessionSize, so
    // they don't pin the run; deleting one would wrongly remove it from disk.
    const scheduler = new CronScheduler();
    const job = scheduler.create('*/5 * * * *', LOOP_SENTINEL_CRON, true);
    job.durable = true;
    const deleteSpy = vi.spyOn(scheduler, 'delete');

    expect(skipHeadlessLoopSentinel(scheduler, job)).toBe(true);

    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('does not delete a non-recurring sentinel job (one-shot stays in the scheduler)', () => {
    // The deletion branch requires BOTH `recurring && !durable`. A one-shot
    // sentinel job is already removed by the scheduler before it fires, so this
    // guard must NOT delete it — a `!durable`-only guard would wrongly evict it.
    const scheduler = new CronScheduler();
    const job = scheduler.create('*/5 * * * *', LOOP_SENTINEL_CRON, false);
    const deleteSpy = vi.spyOn(scheduler, 'delete');

    expect(skipHeadlessLoopSentinel(scheduler, job)).toBe(true);

    expect(deleteSpy).not.toHaveBeenCalled();
  });
});

describe('runNonInteractive', () => {
  let mockConfig: Config;
  let mockSettings: LoadedSettings;
  let mockToolRegistry: ToolRegistry;
  let mockBackgroundTaskRegistry: {
    setNotificationCallback: ReturnType<typeof vi.fn>;
    setRegisterCallback: ReturnType<typeof vi.fn>;
    getAll: ReturnType<typeof vi.fn>;
    hasUnfinalizedTasks: ReturnType<typeof vi.fn>;
    abortAll: ReturnType<typeof vi.fn>;
  };
  let mockMonitorRegistry: {
    setNotificationCallback: ReturnType<typeof vi.fn>;
    setRegisterCallback: ReturnType<typeof vi.fn>;
    getRunning: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    abortAll: ReturnType<typeof vi.fn>;
  };
  let mockCoreExecuteToolCall: Mock;
  let mockShutdownTelemetry: Mock;
  let processStdoutSpy: MockInstance;
  let processStderrSpy: MockInstance;
  let mockGeminiClient: {
    sendMessageStream: Mock;
    getChatRecordingService: Mock;
    getChat: Mock;
    stripOrphanedUserEntriesFromHistory: Mock;
    getHistoryFunctionResponseIds: Mock;
    consumePendingMemoryTaskPromises: Mock;
    recordCompletedToolCall: Mock;
    addHistory: Mock;
  };
  let mockGetDebugResponses: Mock;
  let goalRuntime: GoalRuntime;

  beforeEach(async () => {
    // Reset module-level state from any prior test in this file. Without
    // these resets the once-set exit latch parks subsequent JSON-mode
    // handleError tests in the never-resolving promise (5s vitest timeout).
    _resetCleanupFunctionsForTest();
    _resetExitLatchForTest();

    mockCoreExecuteToolCall = vi.mocked(executeToolCall);
    mockShutdownTelemetry = vi.mocked(shutdownTelemetry);
    vi.mocked(isTelemetrySdkInitialized).mockReturnValue(true);
    mockGetDebugResponses = vi.fn().mockReturnValue([]);
    goalRuntime = createGoalRuntime({ journal: createGoalJournal() });
    mockGetCommandsForMode.mockImplementation((mode: ExecutionMode) =>
      filterCommandsForMode(mockGetCommands(), mode),
    );
    mockCommandServiceCreate.mockResolvedValue({
      getCommands: mockGetCommands,
      getCommandsForMode: mockGetCommandsForMode,
      getModelInvocableCommands: vi.fn(() => []),
    });

    processStdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    processStderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code}) called`);
    });

    mockToolRegistry = {
      getTool: vi.fn(),
      getFunctionDeclarations: vi.fn().mockReturnValue([]),
      getAllToolNames: vi.fn().mockReturnValue([]),
    } as unknown as ToolRegistry;

    mockBackgroundTaskRegistry = {
      setNotificationCallback: vi.fn(),
      setRegisterCallback: vi.fn(),
      getAll: vi.fn().mockReturnValue([]),
      hasUnfinalizedTasks: vi.fn().mockReturnValue(false),
      abortAll: vi.fn(),
    };

    mockMonitorRegistry = {
      setNotificationCallback: vi.fn(),
      setRegisterCallback: vi.fn(),
      getRunning: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue({ status: 'running' }),
      abortAll: vi.fn(),
    };

    mockGeminiClient = {
      sendMessageStream: vi.fn(),
      consumePendingMemoryTaskPromises: vi.fn().mockReturnValue([]),
      recordCompletedToolCall: vi.fn(),
      addHistory: vi.fn(),
      stripOrphanedUserEntriesFromHistory: vi.fn(),
      getChatRecordingService: vi.fn(() => ({
        initialize: vi.fn(),
        recordMessage: vi.fn(),
        recordMessageTokens: vi.fn(),
        recordToolCalls: vi.fn(),
      })),
      getChat: vi.fn(() => ({})),
      getHistoryFunctionResponseIds: vi.fn(() => new Set<string>()),
    };

    let currentModel = 'test-model';

    mockConfig = {
      initialize: vi.fn().mockResolvedValue(undefined),
      getApprovalMode: vi.fn().mockReturnValue(ApprovalMode.DEFAULT),
      getGeminiClient: vi.fn().mockReturnValue(mockGeminiClient),
      getChatRecordingService: vi.fn().mockReturnValue({
        flush: vi.fn().mockResolvedValue(undefined),
        finalize: vi.fn(),
      }),
      getToolRegistry: vi.fn().mockReturnValue(mockToolRegistry),
      getMaxSessionTurns: vi.fn().mockReturnValue(10),
      getMaxWallTimeSeconds: vi.fn().mockReturnValue(-1),
      getMaxToolCalls: vi.fn().mockReturnValue(-1),
      getProjectRoot: vi.fn().mockReturnValue('/test/project'),
      getTargetDir: vi.fn().mockReturnValue('/test/project'),
      getMcpServers: vi.fn().mockReturnValue(undefined),
      getCliVersion: vi.fn().mockReturnValue('test-version'),
      storage: {
        getProjectTempDir: vi.fn().mockReturnValue('/test/project/.gemini/tmp'),
      },
      getIdeMode: vi.fn().mockReturnValue(false),
      getFullContext: vi.fn().mockReturnValue(false),
      getContentGeneratorConfig: vi.fn().mockReturnValue({}),
      getDebugMode: vi.fn().mockReturnValue(false),
      getOutputFormat: vi.fn().mockReturnValue('text'),
      getJsonSchema: vi.fn().mockReturnValue(undefined),
      getFolderTrustFeature: vi.fn().mockReturnValue(false),
      getFolderTrust: vi.fn().mockReturnValue(false),
      getIncludePartialMessages: vi.fn().mockReturnValue(false),
      getSessionId: vi.fn().mockReturnValue('test-session-id'),
      getModel: vi.fn(() => currentModel),
      setModel: vi.fn(async (model: string) => {
        currentModel = model;
      }),
      getExperimentalZedIntegration: vi.fn().mockReturnValue(false),
      isInteractive: vi.fn().mockReturnValue(false),
      getHookSystem: vi.fn().mockReturnValue(undefined),
      isCronEnabled: vi.fn().mockReturnValue(false),
      getCronScheduler: vi.fn().mockReturnValue(null),
      getTeamManager: vi.fn().mockReturnValue(null),
      onTeamManagerChange: vi.fn(),
      setModelInvocableCommandsProvider: vi.fn(),
      setModelInvocableCommandsExecutor: vi.fn(),
      getAutoSkillEnabled: vi.fn().mockReturnValue(false),
      getDisabledSlashCommands: vi.fn().mockReturnValue([]),
      getGoalRuntime: vi.fn(() => goalRuntime),
      getGoalRuntimeReady: vi.fn(async () => goalRuntime),
      bindGoalTurnHost: vi.fn((host) => goalRuntime.bindHost(host)),
      getBackgroundTaskRegistry: vi
        .fn()
        .mockReturnValue(mockBackgroundTaskRegistry),
      getMonitorRegistry: vi.fn().mockReturnValue(mockMonitorRegistry),
      // Phase C: headless --resume reads the resumed session + sidecar to
      // restore worktree context. These tests don't exercise resume, so
      // return undefined to short-circuit the helper.
      getResumedSessionData: vi.fn().mockReturnValue(undefined),
      // Phase D-1: nonInteractiveCli calls this on every prompt to pick
      // up the one-shot startup-worktree notice (set by gemini.tsx
      // when --worktree was passed). These tests don't exercise the
      // --worktree flag, so return null to short-circuit injection
      // and let the resume-restore branch run.
      consumePendingStartupWorktreeNotice: vi.fn().mockReturnValue(null),
    } as unknown as Config;

    mockSettings = {
      system: { path: '', settings: {} },
      systemDefaults: { path: '', settings: {} },
      user: { path: '', settings: {} },
      workspace: { path: '', settings: {} },
      errors: [],
      setValue: vi.fn(),
      merged: {
        security: {
          auth: {
            enforcedType: undefined,
          },
        },
      },
      isTrusted: true,
      migratedInMemoryScopes: new Set(),
      forScope: vi.fn(),
      computeMergedSettings: vi.fn(),
    } as unknown as LoadedSettings;

    const { handleAtCommand } = await import(
      './ui/hooks/atCommandProcessor.js'
    );
    vi.mocked(handleAtCommand).mockImplementation(async ({ query }) => ({
      processedQuery: [{ text: query }],
      shouldProceed: true,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Creates a default mock SessionMetrics object.
   * Can be overridden in individual tests if needed.
   */
  function createMockMetrics(
    overrides?: Partial<SessionMetrics>,
  ): SessionMetrics {
    return {
      models: {},
      tools: {
        totalCalls: 0,
        totalSuccess: 0,
        totalFail: 0,
        totalDurationMs: 0,
        totalDecisions: {
          accept: 0,
          reject: 0,
          modify: 0,
          auto_accept: 0,
        },
        byName: {},
      },
      files: {
        totalLinesAdded: 0,
        totalLinesRemoved: 0,
      },
      skills: {
        totalCalls: 0,
        totalSuccess: 0,
        totalFail: 0,
        byName: {},
      },
      ...overrides,
    };
  }

  /**
   * Sets up the default mock for uiTelemetryService.getMetrics().
   * Should be called in beforeEach or at the start of tests that need metrics.
   */
  function setupMetricsMock(overrides?: Partial<SessionMetrics>): void {
    const mockMetrics = createMockMetrics(overrides);
    vi.mocked(uiTelemetryService.getMetrics).mockReturnValue(mockMetrics);
    vi.mocked(uiTelemetryService.getMetricsForSession).mockReturnValue(
      mockMetrics,
    );
  }

  async function* createStreamFromEvents(
    events: ServerGeminiStreamEvent[],
  ): AsyncGenerator<ServerGeminiStreamEvent> {
    for (const event of events) {
      yield event;
    }
  }

  type GoalControlCase = {
    name: string;
    input: string;
    prepare: 'none' | 'active' | 'paused';
    expectedStatus: 'active' | 'paused' | null;
    expectedObjective?: string;
    expectedWorkers: number;
    expectedText: string;
  };

  const goalControlCases: GoalControlCase[] = [
    {
      name: 'status',
      input: '/goal',
      prepare: 'active',
      expectedStatus: 'active',
      expectedObjective: 'existing goal',
      expectedWorkers: 0,
      expectedText: 'Goal active: existing goal',
    },
    {
      name: 'create',
      input: '/goal ship it',
      prepare: 'none',
      expectedStatus: 'active',
      expectedObjective: 'ship it',
      expectedWorkers: 1,
      expectedText: 'Goal active: ship it',
    },
    {
      name: 'replace',
      input: '/goal set replacement',
      prepare: 'active',
      expectedStatus: 'active',
      expectedObjective: 'replacement',
      expectedWorkers: 1,
      expectedText: 'Goal active: replacement',
    },
    {
      name: 'edit',
      input: '/goal edit revised goal',
      prepare: 'active',
      expectedStatus: 'active',
      expectedObjective: 'revised goal',
      expectedWorkers: 1,
      expectedText: 'Goal active: revised goal',
    },
    {
      name: 'pause',
      input: '/goal pause',
      prepare: 'active',
      expectedStatus: 'paused',
      expectedObjective: 'existing goal',
      expectedWorkers: 0,
      expectedText: 'Goal paused: existing goal',
    },
    {
      name: 'resume',
      input: '/goal resume',
      prepare: 'paused',
      expectedStatus: 'active',
      expectedObjective: 'existing goal',
      expectedWorkers: 1,
      expectedText: 'Goal active: existing goal',
    },
    {
      name: 'clear',
      input: '/goal clear',
      prepare: 'active',
      expectedStatus: null,
      expectedWorkers: 0,
      expectedText: 'Goal cleared.',
    },
  ];

  async function prepareGoalState(
    preparation: GoalControlCase['prepare'],
  ): Promise<void> {
    if (preparation === 'none') return;
    const created = await goalRuntime.dispatch({
      action: 'create',
      objective: 'existing goal',
    });
    if (preparation === 'paused') {
      await goalRuntime.dispatch({
        action: 'pause',
        expectedGoalId: created.snapshot.goal!.goalId,
        expectedRevision: created.snapshot.goal!.revision,
      });
    }
  }

  function mockFinishedGoalWorker(): void {
    mockGeminiClient.sendMessageStream.mockImplementation(() =>
      createStreamFromEvents([
        {
          type: GeminiEventType.Finished,
          value: {
            reason: undefined,
            usageMetadata: { totalTokenCount: 0 },
          },
        },
      ]),
    );
  }

  it.each(goalControlCases)(
    'handles plain Goal $name before ordinary model input',
    async (testCase) => {
      setupMetricsMock();
      mockGetCommands.mockReturnValue([goalCommand]);
      await prepareGoalState(testCase.prepare);
      mockFinishedGoalWorker();
      const dispatch = vi.spyOn(goalRuntime, 'dispatch');

      const exitCode = await runNonInteractive(
        mockConfig,
        mockSettings,
        testCase.input,
        `goal-plain-${testCase.name}`,
      );

      expect(exitCode).toBe(0);
      expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledTimes(
        testCase.expectedWorkers,
      );
      if (testCase.expectedWorkers === 0) {
        expect(mockConfig.bindGoalTurnHost).not.toHaveBeenCalled();
      } else {
        const lastDispatchOrder = dispatch.mock.invocationCallOrder.at(-1);
        expect(lastDispatchOrder).toBeDefined();
        expect(lastDispatchOrder!).toBeLessThan(
          vi.mocked(mockConfig.bindGoalTurnHost).mock.invocationCallOrder[0]!,
        );
      }
      expect(processStdoutSpy).toHaveBeenCalledWith(
        `${testCase.expectedText}\n`,
      );
      expect(goalRuntime.getSnapshot()).toMatchObject({
        goal:
          testCase.expectedStatus === null
            ? null
            : {
                status: testCase.expectedStatus,
                objective: testCase.expectedObjective,
              },
      });
    },
  );

  it.each(goalControlCases)(
    'emits stream-json Goal $name state without legacy partial events',
    async (testCase) => {
      setupMetricsMock();
      mockGetCommands.mockReturnValue([goalCommand]);
      await prepareGoalState(testCase.prepare);
      mockFinishedGoalWorker();
      vi.mocked(mockConfig.getOutputFormat).mockReturnValue(
        OutputFormat.STREAM_JSON,
      );
      vi.mocked(mockConfig.getIncludePartialMessages).mockReturnValue(false);

      const exitCode = await runNonInteractive(
        mockConfig,
        mockSettings,
        testCase.input,
        `goal-stream-${testCase.name}`,
      );

      expect(exitCode).toBe(0);
      expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledTimes(
        testCase.expectedWorkers,
      );
      const messages = processStdoutSpy.mock.calls
        .map(([chunk]) => String(chunk).trim())
        .filter(Boolean)
        .map((chunk) => JSON.parse(chunk));
      const goalStateEvents = messages.filter(
        (message) =>
          message.type === 'stream_event' &&
          message.event?.type === 'goal_state',
      );
      expect(goalStateEvents.length).toBeGreaterThanOrEqual(1);
      expect(goalStateEvents[0].event.goal_state).toMatchObject({
        v: 2,
        goal:
          testCase.expectedStatus === null
            ? null
            : {
                status: testCase.expectedStatus,
                objective: testCase.expectedObjective,
              },
      });
      expect(
        messages.some(
          (message) =>
            message.type === 'stream_event' &&
            message.event?.type === 'active_goal',
        ),
      ).toBe(false);
    },
  );

  it('runs idle resume with the one exact permit scheduled by Core', async () => {
    setupMetricsMock();
    mockGetCommands.mockReturnValue([goalCommand]);
    await prepareGoalState('paused');
    mockFinishedGoalWorker();

    await runNonInteractive(
      mockConfig,
      mockSettings,
      '/goal resume',
      'goal-resume-exact',
    );

    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledOnce();
    const [parts, , , options] =
      mockGeminiClient.sendMessageStream.mock.calls[0]!;
    expect(parts).toEqual([
      {
        text: expect.stringContaining('Continue working on the active Goal.'),
      },
    ]);
    expect(parts[0]?.text).toContain(
      "Follow the objective's requested output format exactly.",
    );
    expect(parts[0]?.text).toContain(
      'call get_goal in the same response before update_goal.',
    );
    expect(options).toMatchObject({
      type: SendMessageType.Goal,
      goalOrigin: 'runtime',
      goalTurnKey: expect.stringMatching(/^goal-runtime:/),
      goalPermit: {
        goalId: expect.any(String),
        revision: expect.any(Number),
        turnId: expect.any(String),
      },
    });
    expect(options.goalTurnKey).toBe(
      `goal-runtime:${options.goalPermit.turnId}`,
    );
    expect(options.goalSignal).toBeInstanceOf(AbortSignal);
  });

  it('keeps the exact Goal permit through a ToolResult continuation', async () => {
    setupMetricsMock();
    mockGetCommands.mockReturnValue([goalCommand]);
    await prepareGoalState('paused');
    mockCoreExecuteToolCall.mockResolvedValue({
      responseParts: [{ text: 'tool response' }],
    });
    let requestCount = 0;
    mockGeminiClient.sendMessageStream.mockImplementation(
      (
        _parts: Part[],
        _signal: AbortSignal,
        _promptId: string,
        sendOptions: {
          goalPermit?: {
            goalId: string;
            revision: number;
            turnId: string;
          };
        },
      ) => {
        requestCount += 1;
        if (requestCount === 1) {
          return createStreamFromEvents([
            {
              type: GeminiEventType.ToolCallRequest,
              value: {
                callId: 'goal-tool-1',
                name: 'testTool',
                args: {},
                isClientInitiated: false,
                prompt_id: 'goal-resume-tool-result',
                goalContext: sendOptions.goalPermit,
              },
            },
          ]);
        }
        return createStreamFromEvents([
          {
            type: GeminiEventType.Finished,
            value: {
              reason: undefined,
              usageMetadata: { totalTokenCount: 0 },
            },
          },
        ]);
      },
    );

    await runNonInteractive(
      mockConfig,
      mockSettings,
      '/goal resume',
      'goal-resume-tool-result',
    );

    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledTimes(2);
    const firstOptions = mockGeminiClient.sendMessageStream.mock.calls[0]![3];
    const secondOptions = mockGeminiClient.sendMessageStream.mock.calls[1]![3];
    expect(secondOptions).toMatchObject({
      type: SendMessageType.ToolResult,
      goalPermit: firstOptions.goalPermit,
      goalTurnKey: firstOptions.goalTurnKey,
      goalOrigin: 'runtime',
    });
    expect(secondOptions.goalSignal).toBe(firstOptions.goalSignal);
  });

  it('ends a Goal turn without another model call after update_goal', async () => {
    setupMetricsMock();
    mockGetCommands.mockReturnValue([goalCommand]);
    await prepareGoalState('paused');
    const finishTurn = vi
      .spyOn(goalRuntime, 'finishTurn')
      .mockResolvedValue(undefined);
    mockCoreExecuteToolCall.mockResolvedValue({
      callId: 'update-goal-terminal',
      responseParts: [{ text: 'proposal recorded' }],
      resultDisplay: 'proposal recorded',
      error: undefined,
      errorType: undefined,
      terminateTurn: true,
    });
    mockGeminiClient.sendMessageStream.mockImplementation(
      (
        _parts: Part[],
        _signal: AbortSignal,
        _promptId: string,
        sendOptions: { goalPermit?: GoalTurnPermit },
      ) =>
        createStreamFromEvents([
          {
            type: GeminiEventType.ToolCallRequest,
            value: {
              callId: 'update-goal-terminal',
              name: 'update_goal',
              args: {},
              isClientInitiated: false,
              prompt_id: 'goal-terminal-tool-result',
              goalContext: sendOptions.goalPermit,
            },
          },
        ]),
    );

    await runNonInteractive(
      mockConfig,
      mockSettings,
      '/goal resume',
      'goal-terminal-tool-result',
    );

    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledOnce();
    expect(mockGeminiClient.addHistory).toHaveBeenCalledWith({
      role: 'user',
      parts: [{ text: 'proposal recorded' }],
    });
    expect(finishTurn).toHaveBeenCalledOnce();
  });

  it('settles a plain-text Goal turn before leaving the headless run', async () => {
    setupMetricsMock();
    mockGetCommands.mockReturnValue([goalCommand]);
    await prepareGoalState('paused');
    const finishTurn = vi
      .spyOn(goalRuntime, 'finishTurn')
      .mockResolvedValue(undefined);
    const flush = vi.fn().mockResolvedValue(undefined);
    Object.assign(mockConfig, {
      getChatRecordingService: vi.fn(() => ({
        flush,
        finalize: vi.fn().mockResolvedValue(undefined),
      })),
    });
    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents([
        { type: GeminiEventType.Content, value: 'still working' },
        {
          type: GeminiEventType.Finished,
          value: {
            reason: undefined,
            usageMetadata: { totalTokenCount: 0 },
          },
        },
      ]),
    );
    await runNonInteractive(
      mockConfig,
      mockSettings,
      '/goal resume',
      'goal-plain-text',
    );
    expect(flush).toHaveBeenCalled();
    expect(finishTurn).toHaveBeenCalledOnce();
    expect(flush.mock.invocationCallOrder[0]).toBeLessThan(
      finishTurn.mock.invocationCallOrder[0]!,
    );
  });

  it('does not charge runtime Goal continuations to the generic session turn cap', async () => {
    setupMetricsMock();
    mockGetCommands.mockReturnValue([goalCommand]);
    await prepareGoalState('paused');
    vi.mocked(mockConfig.getMaxSessionTurns).mockReturnValue(0);
    mockCoreExecuteToolCall.mockResolvedValue({
      responseParts: [{ text: 'tool response' }],
    });
    mockGeminiClient.sendMessageStream
      .mockReturnValueOnce(
        createStreamFromEvents([
          {
            type: GeminiEventType.ToolCallRequest,
            value: {
              callId: 'goal-unlimited-turns-tool',
              name: 'testTool',
              args: {},
              isClientInitiated: false,
              prompt_id: 'goal-unlimited-turns',
            },
          },
        ]),
      )
      .mockReturnValueOnce(
        createStreamFromEvents([
          {
            type: GeminiEventType.Finished,
            value: {
              reason: undefined,
              usageMetadata: { totalTokenCount: 0 },
            },
          },
        ]),
      );

    const exitCode = await runNonInteractive(
      mockConfig,
      mockSettings,
      '/goal resume',
      'goal-unlimited-turns',
    );

    expect(exitCode).toBe(0);
    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledTimes(2);
    expect(mockCoreExecuteToolCall).toHaveBeenCalledOnce();
    expect(processStderrSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('Reached max session turns'),
    );
  });

  it('still applies the generic turn cap to real user input during an active Goal', async () => {
    setupMetricsMock();
    await prepareGoalState('active');
    vi.mocked(mockConfig.getMaxSessionTurns).mockReturnValue(0);
    mockFinishedGoalWorker();

    await expect(
      runNonInteractive(
        mockConfig,
        mockSettings,
        'A real user update',
        'goal-user-turn-cap',
      ),
    ).rejects.toThrow('process.exit(53) called');

    expect(mockGeminiClient.sendMessageStream).not.toHaveBeenCalled();
  });

  it('keeps explicit per-request tool-call budgets on runtime Goal work', async () => {
    setupMetricsMock();
    mockGetCommands.mockReturnValue([goalCommand]);
    await prepareGoalState('paused');
    vi.mocked(mockConfig.getMaxSessionTurns).mockReturnValue(0);
    vi.mocked(mockConfig.getMaxToolCalls).mockReturnValue(0);
    mockGeminiClient.sendMessageStream.mockReturnValueOnce(
      createStreamFromEvents([
        {
          type: GeminiEventType.ToolCallRequest,
          value: {
            callId: 'goal-explicit-budget-tool',
            name: 'testTool',
            args: {},
            isClientInitiated: false,
            prompt_id: 'goal-explicit-budget',
          },
        },
      ]),
    );

    const run = runNonInteractive(
      mockConfig,
      mockSettings,
      '/goal resume',
      'goal-explicit-budget',
    ).catch(() => undefined);

    await vi.waitFor(() =>
      expect(processStderrSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'Run aborted: tool-call budget of 0 exceeded (--max-tool-calls)',
        ),
      ),
    );
    expect(mockCoreExecuteToolCall).not.toHaveBeenCalled();
    expect(goalRuntime.getSnapshot()).toMatchObject({
      activity: 'idle',
      goal: { status: 'paused' },
    });

    void run;
  });

  it('fails closed when a Goal hits the local repeated-provider guard after a tool gap', async () => {
    setupMetricsMock();
    mockGetCommands.mockReturnValue([goalCommand]);
    await prepareGoalState('paused');
    mockCoreExecuteToolCall.mockResolvedValue({
      responseParts: [{ text: 'tool response' }],
    });
    const flush = vi.fn().mockResolvedValue(undefined);
    Object.assign(mockConfig, {
      getChatRecordingService: vi.fn(() => ({
        flush,
        finalize: vi.fn().mockResolvedValue(undefined),
      })),
    });
    const dispatch = vi.spyOn(goalRuntime, 'dispatch');
    const finishTurn = vi.spyOn(goalRuntime, 'finishTurn');
    let requestCount = 0;
    mockGeminiClient.sendMessageStream.mockImplementation(
      (
        _parts: Part[],
        _signal: AbortSignal,
        _promptId: string,
        sendOptions: { goalPermit?: GoalTurnPermit },
      ) => {
        requestCount += 1;
        const duplicate = {
          type: GeminiEventType.ToolCallRequest as const,
          value: {
            callId: 'goal-duplicate-tool',
            providerCallId: 'goal-duplicate-tool',
            name: 'testTool',
            args: {},
            isClientInitiated: false,
            prompt_id: 'goal-duplicate-loop',
            goalContext: sendOptions.goalPermit,
          },
        };
        if (requestCount < 3) {
          return createStreamFromEvents([duplicate]);
        }
        return createStreamFromEvents([
          duplicate,
          {
            type: GeminiEventType.ToolCallRequest,
            value: {
              callId: 'goal-fresh-tool',
              providerCallId: 'goal-fresh-tool',
              name: 'testTool',
              args: {},
              isClientInitiated: false,
              prompt_id: 'goal-duplicate-loop',
              goalContext: sendOptions.goalPermit,
            },
          },
        ]);
      },
    );

    const exitCode = await runNonInteractive(
      mockConfig,
      mockSettings,
      '/goal resume',
      'goal-duplicate-loop',
    );

    expect(exitCode).toBe(1);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'pause' }),
    );
    expect(flush).toHaveBeenCalled();
    expect(finishTurn).not.toHaveBeenCalled();
    const pauseOrder = dispatch.mock.invocationCallOrder.find(
      (_, index) => dispatch.mock.calls[index]?.[0].action === 'pause',
    );
    expect(pauseOrder).toBeDefined();
    expect(pauseOrder!).toBeLessThan(flush.mock.invocationCallOrder[0]!);
    expect(goalRuntime.getSnapshot()).toMatchObject({
      goal: { status: 'paused' },
      activity: 'idle',
    });
  });

  it('claims an active Goal for a real user before binding the headless host', async () => {
    setupMetricsMock();
    await prepareGoalState('active');
    mockFinishedGoalWorker();
    const beginTurn = vi.spyOn(goalRuntime, 'beginTurn');

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'A real user update',
      'goal-real-user',
    );

    expect(beginTurn).toHaveBeenCalledWith('goal-real-user');
    expect(beginTurn.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(mockConfig.bindGoalTurnHost).mock.invocationCallOrder[0]!,
    );
    const sendOptions = mockGeminiClient.sendMessageStream.mock.calls[0]![3];
    expect(sendOptions).toMatchObject({
      type: SendMessageType.UserQuery,
      goalOrigin: 'user',
      goalTurnKey: 'goal-real-user',
      goalPermit: {
        goalId: expect.any(String),
        revision: expect.any(Number),
        turnId: expect.any(String),
      },
    });
    expect(sendOptions.goalSignal).toBeInstanceOf(AbortSignal);
  });

  it('emits direct slash Goal v2 state before the legacy partial projection', async () => {
    setupMetricsMock();
    mockGetCommands.mockReturnValue([goalCommand]);
    await prepareGoalState('active');
    vi.mocked(mockConfig.getOutputFormat).mockReturnValue(
      OutputFormat.STREAM_JSON,
    );
    vi.mocked(mockConfig.getIncludePartialMessages).mockReturnValue(true);

    await runNonInteractive(
      mockConfig,
      mockSettings,
      '/goal',
      'goal-direct-order',
    );

    const goalEventTypes = processStdoutSpy.mock.calls
      .map(
        ([chunk]) => JSON.parse(String(chunk)) as { event?: { type?: string } },
      )
      .map(({ event }) => event?.type)
      .filter((type) => type === 'goal_state' || type === 'active_goal');
    expect(goalEventTypes).toEqual(['goal_state', 'active_goal']);
    expect(mockGeminiClient.sendMessageStream).not.toHaveBeenCalled();
  });

  it('should process input and write text output', async () => {
    setupMetricsMock();
    const events: ServerGeminiStreamEvent[] = [
      { type: GeminiEventType.Content, value: 'Hello' },
      { type: GeminiEventType.Content, value: ' World' },
      {
        type: GeminiEventType.Finished,
        value: { reason: undefined, usageMetadata: { totalTokenCount: 10 } },
      },
    ];
    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents(events),
    );

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'Test input',
      'prompt-id-1',
    );

    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledWith(
      [{ text: 'Test input' }],
      expect.any(AbortSignal),
      'prompt-id-1',
      { type: SendMessageType.UserQuery },
    );
    expect(processStdoutSpy).toHaveBeenCalledWith('Hello World\n');
    expect(mockShutdownTelemetry).toHaveBeenCalled();
  });

  it('does not let headless YOLO bypass explicit teammate approval', async () => {
    setupMetricsMock();
    const teamEvents = new EventEmitter();
    const respond = vi.fn().mockResolvedValue(undefined);
    const teamManager = {
      setLeaderMessageCallback: vi.fn(),
      getEventEmitter: () => teamEvents,
      hasActiveTeammates: () => false,
      drainLeaderInbox: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(mockConfig.getApprovalMode).mockReturnValue(ApprovalMode.YOLO);
    vi.mocked(mockConfig.getTeamManager).mockReturnValue(teamManager as never);
    let emittedApproval = false;
    mockGeminiClient.sendMessageStream.mockImplementation(
      async function* (): AsyncGenerator<ServerGeminiStreamEvent> {
        if (!emittedApproval) {
          emittedApproval = true;
          teamEvents.emit(TeamEventType.TEAMMATE_APPROVAL_REQUEST, {
            teammateName: 'worker',
            toolName: 'run_shell_command',
            toolInput: { command: "python -c 'print(1)'" },
            confirmationDetails: {
              type: 'info',
              title: 'Permission rule requires confirmation',
              prompt: 'Allow this operation?',
              hideAlwaysAllow: true,
            },
            respond,
            timestamp: Date.now(),
          });
        }
        yield {
          type: GeminiEventType.Finished,
          value: {
            reason: undefined,
            usageMetadata: { totalTokenCount: 0 },
          },
        };
      },
    );

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'Test input',
      'prompt-exact-teammate',
    );

    await vi.waitFor(() =>
      expect(respond).toHaveBeenCalledWith(ToolConfirmationOutcome.Cancel),
    );
    expect(processStderrSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'requires an explicit interactive approval surface',
      ),
    );
    expect(processStderrSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('exact-invocation'),
    );
  });

  it('describes the active mode when explicit teammate approval cannot be shown', async () => {
    setupMetricsMock();
    const teamEvents = new EventEmitter();
    const respond = vi.fn().mockResolvedValue(undefined);
    const teamManager = {
      setLeaderMessageCallback: vi.fn(),
      getEventEmitter: () => teamEvents,
      hasActiveTeammates: () => false,
      drainLeaderInbox: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(mockConfig.getApprovalMode).mockReturnValue(ApprovalMode.DEFAULT);
    vi.mocked(mockConfig.getTeamManager).mockReturnValue(teamManager as never);
    let emittedApproval = false;
    mockGeminiClient.sendMessageStream.mockImplementation(
      async function* (): AsyncGenerator<ServerGeminiStreamEvent> {
        if (!emittedApproval) {
          emittedApproval = true;
          teamEvents.emit(TeamEventType.TEAMMATE_APPROVAL_REQUEST, {
            teammateName: 'worker',
            toolName: 'run_shell_command',
            toolInput: { command: "python -c 'print(1)'" },
            confirmationDetails: {
              type: 'info',
              title: 'Permission rule requires confirmation',
              prompt: 'Allow this operation?',
              hideAlwaysAllow: true,
            },
            respond,
            timestamp: Date.now(),
          });
        }
        yield {
          type: GeminiEventType.Finished,
          value: {
            reason: undefined,
            usageMetadata: { totalTokenCount: 0 },
          },
        };
      },
    );

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'Test input',
      'prompt-exact-teammate-default',
    );

    await vi.waitFor(() =>
      expect(respond).toHaveBeenCalledWith(ToolConfirmationOutcome.Cancel),
    );
    expect(processStderrSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        `current approval mode (${ApprovalMode.DEFAULT})`,
      ),
    );
    expect(processStderrSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Use --input-format stream-json --output-format stream-json',
      ),
    );
    expect(processStderrSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('cannot be bypassed by YOLO mode'),
    );
  });

  describe('continueInterrupted', () => {
    it('re-submits an orphaned trailing user prompt with Retry semantics', async () => {
      setupMetricsMock();
      // The orphan strip + restore is owned by the Retry send path in
      // client.ts (covered by client.test.ts); here we only assert the
      // continuation hands off to that path with Retry semantics.
      mockGeminiClient.getChat = vi.fn(() => ({
        getDebugResponses: mockGetDebugResponses,
        getHistory: vi
          .fn()
          .mockReturnValue([
            { role: 'user', parts: [{ text: 'do the thing' }] },
          ]),
      }));
      mockGeminiClient.sendMessageStream.mockReturnValue(
        createStreamFromEvents([
          {
            type: GeminiEventType.Finished,
            value: { reason: undefined, usageMetadata: { totalTokenCount: 5 } },
          },
        ]),
      );

      await runNonInteractive(mockConfig, mockSettings, '', 'prompt-c1', {
        continueInterrupted: true,
      });

      expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledWith(
        [{ text: 'do the thing' }],
        expect.any(AbortSignal),
        'prompt-c1',
        expect.objectContaining({ type: SendMessageType.Retry }),
      );
    });

    it('adds plan mode reminders to an interrupted prompt replay', async () => {
      setupMetricsMock();
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.PLAN);
      mockGeminiClient.stripOrphanedUserEntriesFromHistory = vi.fn();
      mockGeminiClient.getChat = vi.fn(() => ({
        getDebugResponses: mockGetDebugResponses,
        getHistory: vi
          .fn()
          .mockReturnValue([
            { role: 'user', parts: [{ text: 'do the thing' }] },
          ]),
      }));
      mockGeminiClient.sendMessageStream.mockReturnValue(
        createStreamFromEvents([
          {
            type: GeminiEventType.Finished,
            value: { reason: undefined, usageMetadata: { totalTokenCount: 5 } },
          },
        ]),
      );

      await runNonInteractive(mockConfig, mockSettings, '', 'prompt-c-plan', {
        continueInterrupted: true,
      });

      const [request, , , options] =
        mockGeminiClient.sendMessageStream.mock.calls[0]!;
      expect(options).toEqual(
        expect.objectContaining({ type: SendMessageType.Retry }),
      );
      expect(request).toEqual([
        { text: expect.stringContaining(SYSTEM_REMINDER_OPEN) },
        { text: 'do the thing' },
      ]);
    });

    it('closes dangling tool calls with synthesized ToolResult parts', async () => {
      setupMetricsMock();
      mockGeminiClient.getChat = vi.fn(() => ({
        getDebugResponses: mockGetDebugResponses,
        getHistory: vi.fn().mockReturnValue([
          {
            role: 'model',
            parts: [{ functionCall: { id: 'call-1', name: 'shell' } }],
          },
        ]),
      }));
      mockGeminiClient.sendMessageStream.mockReturnValue(
        createStreamFromEvents([
          {
            type: GeminiEventType.Finished,
            value: { reason: undefined, usageMetadata: { totalTokenCount: 5 } },
          },
        ]),
      );

      await runNonInteractive(mockConfig, mockSettings, '', 'prompt-c2', {
        continueInterrupted: true,
      });

      const [request, , , options] =
        mockGeminiClient.sendMessageStream.mock.calls[0]!;
      expect(options).toEqual(
        expect.objectContaining({ type: SendMessageType.ToolResult }),
      );
      expect(request).toEqual([
        {
          functionResponse: {
            id: 'call-1',
            name: 'shell',
            response: { error: expect.stringContaining('not recorded') },
          },
        },
      ]);
    });

    it('adds plan mode reminders to a continued tool result without moving function responses', async () => {
      setupMetricsMock();
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.PLAN);
      mockGeminiClient.getChat = vi.fn(() => ({
        getDebugResponses: mockGetDebugResponses,
        getHistory: vi.fn().mockReturnValue([
          {
            role: 'model',
            parts: [{ functionCall: { id: 'call-1', name: 'shell' } }],
          },
        ]),
      }));
      mockGeminiClient.sendMessageStream.mockReturnValue(
        createStreamFromEvents([
          {
            type: GeminiEventType.Finished,
            value: { reason: undefined, usageMetadata: { totalTokenCount: 5 } },
          },
        ]),
      );

      await runNonInteractive(
        mockConfig,
        mockSettings,
        '',
        'prompt-c-tool-plan',
        {
          continueInterrupted: true,
        },
      );

      const [request, , , options] =
        mockGeminiClient.sendMessageStream.mock.calls[0]!;
      expect(options).toEqual(
        expect.objectContaining({ type: SendMessageType.ToolResult }),
      );
      expect(request).toEqual([
        {
          functionResponse: {
            id: 'call-1',
            name: 'shell',
            response: { error: expect.stringContaining('not recorded') },
          },
        },
        { text: expect.stringContaining(SYSTEM_REMINDER_OPEN) },
      ]);
    });

    it('is a no-op when the last turn ended cleanly', async () => {
      setupMetricsMock();
      mockGeminiClient.getChat = vi.fn(() => ({
        getDebugResponses: mockGetDebugResponses,
        getHistory: vi
          .fn()
          .mockReturnValue([{ role: 'model', parts: [{ text: 'all done' }] }]),
      }));

      await runNonInteractive(mockConfig, mockSettings, '', 'prompt-c3', {
        continueInterrupted: true,
      });

      expect(mockGeminiClient.sendMessageStream).not.toHaveBeenCalled();
    });
  });

  it('on EPIPE, destroys stdout and returns normally instead of process.exit', async () => {
    // Regression: process.exit(0) on EPIPE bypassed runExitCleanup → flush()
    // and dropped queued JSONL writes for `qwen -p ... | head -1` patterns.
    // process.exit is mocked to throw in beforeEach, so reaching the
    // assertion also proves the bypass route is gone.
    setupMetricsMock();
    const stdoutDestroySpy = vi
      .spyOn(process.stdout, 'destroy')
      .mockReturnValue(process.stdout);

    mockGeminiClient.sendMessageStream.mockImplementation(
      async function* mockStream(): AsyncGenerator<ServerGeminiStreamEvent> {
        process.stdout.emit(
          'error',
          Object.assign(new Error('EPIPE'), { code: 'EPIPE' }),
        );
        yield { type: GeminiEventType.Content, value: 'Hello' };
        yield {
          type: GeminiEventType.Finished,
          value: {
            reason: undefined,
            usageMetadata: { totalTokenCount: 0 },
          },
        };
      },
    );

    await runNonInteractive(mockConfig, mockSettings, 'test', 'p1');

    expect(stdoutDestroySpy).toHaveBeenCalled();
  });

  it('returns non-zero and skips pending tool calls after loop detection', async () => {
    setupMetricsMock();
    const toolCallEvent: ServerGeminiStreamEvent = {
      type: GeminiEventType.ToolCallRequest,
      value: {
        callId: 'tool-1',
        name: 'testTool',
        args: { arg1: 'value1' },
        isClientInitiated: false,
        prompt_id: 'prompt-id-loop-detected',
      },
    };
    const events: ServerGeminiStreamEvent[] = [
      toolCallEvent,
      {
        type: GeminiEventType.LoopDetected,
        value: { loopType: LoopType.TURN_TOOL_CALL_CAP },
      },
    ];
    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents(events),
    );

    const exitCode = await runNonInteractive(
      mockConfig,
      mockSettings,
      'Use a tool',
      'prompt-id-loop-detected',
    );

    expect(exitCode).toBe(1);
    expect(mockCoreExecuteToolCall).not.toHaveBeenCalled();
    expect(processStdoutSpy).not.toHaveBeenCalled();
    expect(processStderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('Loop detection halted the run'),
    );
  });

  it('shows the always-on hint (not the skipLoopDetection escape) for a consecutive-identical halt', async () => {
    setupMetricsMock();
    const toolCallEvent: ServerGeminiStreamEvent = {
      type: GeminiEventType.ToolCallRequest,
      value: {
        callId: 'tool-1',
        name: 'run_shell_command',
        args: { command: 'echo loop' },
        isClientInitiated: false,
        prompt_id: 'prompt-id-consecutive-loop',
      },
    };
    const events: ServerGeminiStreamEvent[] = [
      toolCallEvent,
      {
        type: GeminiEventType.LoopDetected,
        value: { loopType: LoopType.CONSECUTIVE_IDENTICAL_TOOL_CALLS },
      },
    ];
    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents(events),
    );

    const exitCode = await runNonInteractive(
      mockConfig,
      mockSettings,
      'Repeat a tool',
      'prompt-id-consecutive-loop',
    );

    expect(exitCode).toBe(1);
    // The consecutive guard is always-on, so the headless message must flag it
    // as always-on and must NOT suggest the skipLoopDetection escape hatch,
    // which cannot disable it.
    expect(processStderrSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'always-on guard and cannot be disabled via `model.skipLoopDetection`',
      ),
    );
    expect(processStderrSpy).not.toHaveBeenCalledWith(
      expect.stringContaining(
        'Set the `model.skipLoopDetection` setting to true',
      ),
    );
  });

  it('shows the skipLoopDetection escape hint for a heuristic loop type', async () => {
    setupMetricsMock();
    const toolCallEvent: ServerGeminiStreamEvent = {
      type: GeminiEventType.ToolCallRequest,
      value: {
        callId: 'tool-1',
        name: 'run_shell_command',
        args: { command: 'echo loop' },
        isClientInitiated: false,
        prompt_id: 'prompt-id-heuristic-loop',
      },
    };
    const events: ServerGeminiStreamEvent[] = [
      toolCallEvent,
      {
        type: GeminiEventType.LoopDetected,
        value: { loopType: LoopType.REPETITIVE_THOUGHTS },
      },
    ];
    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents(events),
    );

    const exitCode = await runNonInteractive(
      mockConfig,
      mockSettings,
      'Repeat a tool',
      'prompt-id-heuristic-loop',
    );

    expect(exitCode).toBe(1);
    // A heuristic loop IS gated by skipLoopDetection, so the message must offer
    // that escape hatch and must NOT claim it is an always-on guard. (Mutation
    // guard: routing all types into the always-on hint would fail here.)
    expect(processStderrSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Set the `model.skipLoopDetection` setting to true',
      ),
    );
    expect(processStderrSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('always-on guard'),
    );
  });

  it('shows the maxToolCallsPerTurn hint when the per-turn cap halts the run', async () => {
    setupMetricsMock();
    const events: ServerGeminiStreamEvent[] = [
      { type: GeminiEventType.Content, value: 'Partial work' },
      {
        type: GeminiEventType.LoopDetected,
        value: { loopType: LoopType.TURN_TOOL_CALL_CAP },
      },
    ];
    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents(events),
    );

    const exitCode = await runNonInteractive(
      mockConfig,
      mockSettings,
      'Long turn',
      'prompt-id-turn-cap',
    );

    expect(exitCode).toBe(1);
    // The cap has its own knob, so the message must point at it rather than
    // claiming the halt cannot be configured away.
    expect(processStderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('`model.maxToolCallsPerTurn`'),
    );
    expect(processStderrSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('cannot be disabled'),
    );
    expect(processStderrSpy).not.toHaveBeenCalledWith(
      expect.stringContaining(
        'Set the `model.skipLoopDetection` setting to true',
      ),
    );
  });

  it('marks JSON output as an error when loop detection halts the run', async () => {
    (mockConfig.getOutputFormat as Mock).mockReturnValue(OutputFormat.JSON);
    setupMetricsMock();
    const events: ServerGeminiStreamEvent[] = [
      { type: GeminiEventType.Content, value: 'Partial work' },
      {
        type: GeminiEventType.LoopDetected,
        value: { loopType: LoopType.TURN_TOOL_CALL_CAP },
      },
    ];
    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents(events),
    );

    const exitCode = await runNonInteractive(
      mockConfig,
      mockSettings,
      'Test input',
      'prompt-id-loop-json',
    );

    expect(exitCode).toBe(1);
    const outputCalls = processStdoutSpy.mock.calls.filter(
      (call) => typeof call[0] === 'string',
    );
    const lastOutput = outputCalls.at(-1)?.[0];
    expect(typeof lastOutput).toBe('string');
    const parsed = JSON.parse(lastOutput as string) as Array<{
      type?: string;
      is_error?: boolean;
      error?: { message?: string };
    }>;
    const resultMessage = parsed.find((msg) => msg.type === 'result');
    expect(resultMessage?.is_error).toBe(true);
    expect(resultMessage?.error?.message).toContain(
      'Loop detection halted the run',
    );
  });

  it('finalizes and reports recording failure before the JSON terminal result', async () => {
    (mockConfig.getOutputFormat as Mock).mockReturnValue(OutputFormat.JSON);
    setupMetricsMock();
    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents([
        { type: GeminiEventType.Content, value: 'Answer' },
        {
          type: GeminiEventType.Finished,
          value: { reason: undefined, usageMetadata: { totalTokenCount: 1 } },
        },
      ]),
    );
    const order: string[] = [];
    let recordingFailureListener:
      | ((event: { sessionId: string; error: Error }) => void)
      | undefined;
    (
      mockConfig as unknown as {
        onChatRecordingFailure: (
          listener: (event: { sessionId: string; error: Error }) => void,
        ) => () => void;
        getChatRecordingService: () => {
          finalize: () => void;
          flush: () => Promise<void>;
        };
      }
    ).onChatRecordingFailure = (listener) => {
      recordingFailureListener = listener;
      return vi.fn();
    };
    (
      mockConfig as unknown as {
        getChatRecordingService: () => {
          finalize: () => void;
          flush: () => Promise<void>;
        };
      }
    ).getChatRecordingService = () => ({
      finalize: () => order.push('finalize'),
      flush: async () => {
        order.push('flush');
        recordingFailureListener?.({
          sessionId: 'affected-session',
          error: new Error('/private/transcript.jsonl: ENOSPC'),
        });
        throw new Error('write failed');
      },
    });

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'Test input',
      'prompt-recording-failure',
    );

    const output = processStdoutSpy.mock.calls.at(-1)?.[0] as string;
    const messages = JSON.parse(output) as Array<{
      type: string;
      subtype?: string;
      session_id?: string;
      data?: { session_id?: string };
    }>;
    const warningIndex = messages.findIndex(
      (message) => message.subtype === 'session_recording_degraded',
    );
    const resultIndex = messages.findIndex(
      (message) => message.type === 'result',
    );
    expect(order).toEqual(['finalize', 'flush']);
    expect(warningIndex).toBeGreaterThanOrEqual(0);
    expect(warningIndex).toBeLessThan(resultIndex);
    expect(messages[warningIndex]).toMatchObject({
      session_id: 'affected-session',
      data: { session_id: 'affected-session' },
    });
    expect(output).not.toContain('/private/transcript.jsonl');
  });

  it('flushes but does not finalize when the caller owns the stream adapter', async () => {
    (mockConfig.getOutputFormat as Mock).mockReturnValue(
      OutputFormat.STREAM_JSON,
    );
    setupMetricsMock();
    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents([
        { type: GeminiEventType.Content, value: 'Answer' },
        {
          type: GeminiEventType.Finished,
          value: { reason: undefined, usageMetadata: { totalTokenCount: 1 } },
        },
      ]),
    );
    const finalize = vi.fn();
    const flush = vi.fn().mockResolvedValue(undefined);
    (
      mockConfig as unknown as {
        getChatRecordingService: () => {
          finalize: () => void;
          flush: () => Promise<void>;
        };
      }
    ).getChatRecordingService = () => ({ finalize, flush });
    const adapter = new StreamJsonOutputAdapter(mockConfig, false);

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'Test input',
      'prompt-caller-owned-adapter',
      { adapter },
    );

    expect(flush).toHaveBeenCalledOnce();
    expect(finalize).not.toHaveBeenCalled();
  });

  it('should handle a single tool call and respond', async () => {
    setupMetricsMock();
    const toolCallEvent: ServerGeminiStreamEvent = {
      type: GeminiEventType.ToolCallRequest,
      value: {
        callId: 'tool-1',
        name: 'testTool',
        args: { arg1: 'value1' },
        isClientInitiated: false,
        prompt_id: 'prompt-id-2',
      },
    };
    const toolResponse: Part[] = [{ text: 'Tool response' }];
    mockCoreExecuteToolCall.mockResolvedValue({ responseParts: toolResponse });

    const firstCallEvents: ServerGeminiStreamEvent[] = [toolCallEvent];
    const secondCallEvents: ServerGeminiStreamEvent[] = [
      { type: GeminiEventType.Content, value: 'Final answer' },
      {
        type: GeminiEventType.Finished,
        value: { reason: undefined, usageMetadata: { totalTokenCount: 10 } },
      },
    ];

    mockGeminiClient.sendMessageStream
      .mockReturnValueOnce(createStreamFromEvents(firstCallEvents))
      .mockReturnValueOnce(createStreamFromEvents(secondCallEvents));

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'Use a tool',
      'prompt-id-2',
    );

    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledTimes(2);
    expect(mockCoreExecuteToolCall).toHaveBeenCalledWith(
      mockConfig,
      expect.objectContaining({ name: 'testTool' }),
      expect.any(AbortSignal),
      expect.objectContaining({
        outputUpdateHandler: expect.any(Function),
      }),
    );
    // Verify first call has type: UserQuery
    expect(mockGeminiClient.sendMessageStream).toHaveBeenNthCalledWith(
      1,
      [{ text: 'Use a tool' }],
      expect.any(AbortSignal),
      'prompt-id-2',
      { type: SendMessageType.UserQuery },
    );
    // Verify second call (after tool execution) has type: ToolResult
    expect(mockGeminiClient.sendMessageStream).toHaveBeenNthCalledWith(
      2,
      [{ text: 'Tool response' }],
      expect.any(AbortSignal),
      'prompt-id-2',
      { type: SendMessageType.ToolResult },
    );
    expect(processStdoutSpy).toHaveBeenCalledWith('Final answer\n');
    // Verify recordCompletedToolCall is called with the tool name and args.
    expect(mockGeminiClient.recordCompletedToolCall).toHaveBeenCalledWith(
      'testTool',
      { arg1: 'value1' },
    );
    // Verify consumePendingMemoryTaskPromises is called at the end of the session.
    expect(
      mockGeminiClient.consumePendingMemoryTaskPromises,
    ).toHaveBeenCalled();
  });

  describe('parallel tool execution', () => {
    const finishTurn: ServerGeminiStreamEvent[] = [
      { type: GeminiEventType.Content, value: 'done' },
      {
        type: GeminiEventType.Finished,
        value: { reason: undefined, usageMetadata: { totalTokenCount: 1 } },
      },
    ];

    function toolCallEvents(
      ids: string[],
      name: string,
      promptId: string,
    ): ServerGeminiStreamEvent[] {
      return ids.map((callId) => ({
        type: GeminiEventType.ToolCallRequest,
        value: {
          callId,
          name,
          args: {},
          isClientInitiated: false,
          prompt_id: promptId,
        },
      }));
    }

    it('isolates enter_plan_mode from headless siblings without charging skipped calls to the budget', async () => {
      setupMetricsMock();
      vi.mocked(mockConfig.getMaxToolCalls).mockReturnValue(1);
      vi.mocked(mockToolRegistry.getTool).mockImplementation(
        (name: string) =>
          ({
            kind:
              name === ToolNames.READ_FILE
                ? Kind.Read
                : name === ToolNames.WRITE_FILE
                  ? Kind.Edit
                  : Kind.Other,
          }) as unknown as ReturnType<typeof mockToolRegistry.getTool>,
      );
      mockCoreExecuteToolCall.mockImplementation(
        async (
          _config: unknown,
          request: { callId: string; name: string },
        ) => ({
          responseParts: [
            {
              functionResponse: {
                id: request.callId,
                name: request.name,
                response: { output: 'entered plan mode' },
              },
            },
          ],
          resultDisplay: 'entered plan mode',
        }),
      );

      mockGeminiClient.sendMessageStream
        .mockReturnValueOnce(
          createStreamFromEvents([
            ...toolCallEvents(
              ['write-before-entry'],
              ToolNames.WRITE_FILE,
              'p-plan-boundary',
            ),
            ...toolCallEvents(
              ['enter-plan'],
              ToolNames.ENTER_PLAN_MODE,
              'p-plan-boundary',
            ),
            ...toolCallEvents(
              ['read-after-entry-1', 'read-after-entry-2'],
              ToolNames.READ_FILE,
              'p-plan-boundary',
            ),
          ]),
        )
        .mockReturnValueOnce(createStreamFromEvents(finishTurn));

      await runNonInteractive(
        mockConfig,
        mockSettings,
        'enter plan mode',
        'p-plan-boundary',
      );

      expect(mockCoreExecuteToolCall).toHaveBeenCalledOnce();
      expect(mockCoreExecuteToolCall.mock.calls[0][1]).toMatchObject({
        callId: 'enter-plan',
        name: ToolNames.ENTER_PLAN_MODE,
      });
      const nextTurnParts = mockGeminiClient.sendMessageStream.mock
        .calls[1][0] as Part[];
      expect(nextTurnParts.map((part) => part.functionResponse?.id)).toEqual([
        'write-before-entry',
        'enter-plan',
        'read-after-entry-1',
        'read-after-entry-2',
      ]);
      expect(nextTurnParts[0].functionResponse?.response).toEqual({
        error: PLAN_MODE_ENTRY_SIBLING_SKIP_MESSAGE,
      });
      expect(nextTurnParts[1].functionResponse?.response).toEqual({
        output: 'entered plan mode',
      });
      expect(nextTurnParts[2].functionResponse?.response).toEqual({
        error: PLAN_MODE_ENTRY_SIBLING_SKIP_MESSAGE,
      });
      expect(nextTurnParts[3].functionResponse?.response).toEqual({
        error: PLAN_MODE_ENTRY_SIBLING_SKIP_MESSAGE,
      });
    });

    it('runs a batch of concurrency-safe tool calls concurrently', async () => {
      setupMetricsMock();
      // Kind.Read is concurrency-safe, so the whole batch is one parallel
      // partition (mirrors the interactive scheduler).
      vi.mocked(mockToolRegistry.getTool).mockReturnValue({
        kind: Kind.Read,
      } as unknown as ReturnType<typeof mockToolRegistry.getTool>);

      const total = 3;
      const startOrder: string[] = [];
      let started = 0;
      let openGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      // Each call blocks on `gate`, which only opens once EVERY call in the
      // batch has started. Under the old one-at-a-time loop, call #2 never
      // starts until call #1 resolves — but call #1 is parked on the gate, so
      // the gate never opens and the run deadlocks (the test then times out).
      // Reaching `started === total` therefore proves the batch ran in
      // parallel.
      mockCoreExecuteToolCall.mockImplementation(
        async (_config: unknown, req: { callId: string }) => {
          startOrder.push(req.callId);
          started += 1;
          if (started === total) openGate();
          await gate;
          return { responseParts: [{ text: `resp-${req.callId}` }] };
        },
      );

      mockGeminiClient.sendMessageStream
        .mockReturnValueOnce(
          createStreamFromEvents(
            toolCallEvents(
              ['tool-1', 'tool-2', 'tool-3'],
              'read',
              'p-parallel',
            ),
          ),
        )
        .mockReturnValueOnce(createStreamFromEvents(finishTurn));

      await runNonInteractive(mockConfig, mockSettings, 'go', 'p-parallel');

      expect(started).toBe(total);
      expect(startOrder).toEqual(['tool-1', 'tool-2', 'tool-3']);
      expect(mockCoreExecuteToolCall).toHaveBeenCalledTimes(total);
    });

    it('finalizes concurrent results in request order despite out-of-order completion', async () => {
      setupMetricsMock();
      vi.mocked(mockToolRegistry.getTool).mockReturnValue({
        kind: Kind.Read,
      } as unknown as ReturnType<typeof mockToolRegistry.getTool>);

      const resolvers: Record<string, () => void> = {};
      mockCoreExecuteToolCall.mockImplementation(
        (_config: unknown, req: { callId: string }) =>
          new Promise((resolve) => {
            resolvers[req.callId] = () =>
              resolve({
                responseParts: [
                  {
                    functionResponse: {
                      id: req.callId,
                      name: req.callId,
                      response: { output: `r-${req.callId}` },
                    },
                  },
                ],
              });
          }),
      );

      mockGeminiClient.sendMessageStream
        .mockReturnValueOnce(
          createStreamFromEvents(
            toolCallEvents(['a', 'b', 'c'], 'read', 'p-order'),
          ),
        )
        .mockReturnValueOnce(createStreamFromEvents(finishTurn));

      const run = runNonInteractive(mockConfig, mockSettings, 'go', 'p-order');
      // Wait for all three to launch, then resolve them out of order.
      await vi.waitFor(() =>
        expect(Object.keys(resolvers).sort()).toEqual(['a', 'b', 'c']),
      );
      resolvers['c']();
      resolvers['a']();
      resolvers['b']();
      await run;

      // The next model turn must receive the tool responses in the original
      // request order a, b, c — not the completion order c, a, b.
      const nextTurnParts = mockGeminiClient.sendMessageStream.mock
        .calls[1][0] as Part[];
      const ids = nextTurnParts
        .map((part) => part.functionResponse?.id)
        .filter((id): id is string => id === 'a' || id === 'b' || id === 'c');
      expect(ids).toEqual(['a', 'b', 'c']);
    });

    it('hard-caps the aggregate headless tool response before the next model turn', async () => {
      setupMetricsMock();
      const recordToolResult = vi.fn();
      (
        mockConfig as Config & {
          getChatRecordingService: () => {
            recordToolResult: typeof recordToolResult;
            finalize: ReturnType<typeof vi.fn>;
            flush: ReturnType<typeof vi.fn>;
          };
        }
      ).getChatRecordingService = () => ({
        recordToolResult,
        finalize: vi.fn(),
        flush: vi.fn().mockResolvedValue(undefined),
      });
      vi.mocked(mockToolRegistry.getTool).mockReturnValue({
        kind: Kind.Read,
      } as unknown as ReturnType<typeof mockToolRegistry.getTool>);
      (
        mockConfig as Config & {
          getToolOutputBatchBudget: ReturnType<typeof vi.fn>;
        }
      ).getToolOutputBatchBudget = vi.fn().mockReturnValue(10_000);
      const prefix = 'Tool output was too large and has been truncated';
      mockCoreExecuteToolCall.mockImplementation(
        async (_config: unknown, req: { callId: string }) => ({
          responseParts: [
            {
              functionResponse: {
                id: req.callId,
                name: 'read',
                response: { output: `${prefix}${req.callId.repeat(7000)}` },
              },
            },
          ],
          persistedOutputFiles: [],
        }),
      );
      mockGeminiClient.sendMessageStream
        .mockReturnValueOnce(
          createStreamFromEvents(toolCallEvents(['a', 'b'], 'read', 'p-cap')),
        )
        .mockReturnValueOnce(createStreamFromEvents(finishTurn));

      await runNonInteractive(mockConfig, mockSettings, 'go', 'p-cap');

      const nextTurnParts = mockGeminiClient.sendMessageStream.mock
        .calls[1][0] as Part[];
      const total = nextTurnParts.reduce((sum, part) => {
        const output = part.functionResponse?.response?.['output'];
        return sum + (typeof output === 'string' ? output.length : 0);
      }, 0);
      expect(total).toBeLessThanOrEqual(10_000);
      expect(recordToolResult).toHaveBeenCalledTimes(2);
      expect(recordToolResult.mock.calls.flatMap((call) => call[0])).toEqual(
        nextTurnParts,
      );
    });

    it('runs side-effecting (unsafe) tool calls sequentially', async () => {
      setupMetricsMock();
      // Kind.Edit is a mutator: each unsafe call forms its own sequential
      // batch, so call #2 must not start until call #1 has settled.
      vi.mocked(mockToolRegistry.getTool).mockReturnValue({
        kind: Kind.Edit,
      } as unknown as ReturnType<typeof mockToolRegistry.getTool>);

      const startOrder: string[] = [];
      const resolvers: Array<() => void> = [];
      mockCoreExecuteToolCall.mockImplementation(
        (_config: unknown, req: { callId: string }) =>
          new Promise((resolve) => {
            startOrder.push(req.callId);
            resolvers.push(() =>
              resolve({ responseParts: [{ text: `resp-${req.callId}` }] }),
            );
          }),
      );

      mockGeminiClient.sendMessageStream
        .mockReturnValueOnce(
          createStreamFromEvents(toolCallEvents(['e1', 'e2'], 'edit', 'p-seq')),
        )
        .mockReturnValueOnce(createStreamFromEvents(finishTurn));

      const run = runNonInteractive(mockConfig, mockSettings, 'go', 'p-seq');
      await vi.waitFor(() => expect(startOrder).toEqual(['e1']));
      // Flush pending microtasks; the second call must still not have started
      // while the first is unresolved.
      await new Promise((resolve) => setImmediate(resolve));
      expect(startOrder).toEqual(['e1']);
      resolvers[0]();
      await vi.waitFor(() => expect(startOrder).toEqual(['e1', 'e2']));
      resolvers[1]();
      await run;

      expect(mockCoreExecuteToolCall).toHaveBeenCalledTimes(2);
    });

    it('caps a parallel batch at exactly --max-tool-calls', async () => {
      setupMetricsMock();
      vi.mocked(mockConfig.getMaxToolCalls).mockReturnValue(2);
      vi.mocked(mockToolRegistry.getTool).mockReturnValue({
        kind: Kind.Read,
      } as unknown as ReturnType<typeof mockToolRegistry.getTool>);
      mockCoreExecuteToolCall.mockResolvedValue({
        responseParts: [{ text: 'r' }],
      });

      mockGeminiClient.sendMessageStream.mockReturnValueOnce(
        createStreamFromEvents(
          toolCallEvents(['t1', 't2', 't3'], 'read', 'p-budget'),
        ),
      );

      // Budget = 2, so the 3rd tick trips the budget and stops the launch
      // loop before the 3rd call runs. The run then unwinds through the
      // budget-abort path; assert on the cap rather than the terminal exit
      // (which routes through the mocked process.exit / cleanup machinery and
      // never settles under these mocks — the same routeAbort the serial path
      // takes).
      const run = runNonInteractive(
        mockConfig,
        mockSettings,
        'go',
        'p-budget',
      ).catch(() => undefined);

      await vi.waitFor(() =>
        expect(mockCoreExecuteToolCall).toHaveBeenCalledTimes(2),
      );
      // A would-be 3rd launch happens synchronously with the first two, so a
      // couple of extra event-loop turns confirm it never fires.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(mockCoreExecuteToolCall).toHaveBeenCalledTimes(2);

      void run;
    });

    it('partitions a mixed batch: parallel reads, sequential edit, parallel reads', async () => {
      setupMetricsMock();
      // read → Kind.Read (safe), edit → Kind.Edit (unsafe). The batch
      // [r1,r2,e1,r3,r4] partitions to [r1,r2](parallel), [e1](sequential),
      // [r3,r4](parallel).
      vi.mocked(mockToolRegistry.getTool).mockImplementation(
        (name: string) =>
          ({
            kind: name.startsWith('read') ? Kind.Read : Kind.Edit,
          }) as unknown as ReturnType<typeof mockToolRegistry.getTool>,
      );

      const startOrder: string[] = [];
      const resolvers: Record<string, () => void> = {};
      mockCoreExecuteToolCall.mockImplementation(
        (_config: unknown, req: { callId: string }) =>
          new Promise((resolve) => {
            startOrder.push(req.callId);
            resolvers[req.callId] = () =>
              resolve({ responseParts: [{ text: `resp-${req.callId}` }] });
          }),
      );

      mockGeminiClient.sendMessageStream
        .mockReturnValueOnce(
          createStreamFromEvents([
            ...toolCallEvents(['r1', 'r2'], 'read', 'p-mixed'),
            ...toolCallEvents(['e1'], 'edit', 'p-mixed'),
            ...toolCallEvents(['r3', 'r4'], 'read', 'p-mixed'),
          ]),
        )
        .mockReturnValueOnce(createStreamFromEvents(finishTurn));

      const run = runNonInteractive(mockConfig, mockSettings, 'go', 'p-mixed');

      // Batch 1: r1 and r2 launch together; the edit and later reads wait.
      await vi.waitFor(() => expect(startOrder).toEqual(['r1', 'r2']));
      await new Promise((resolve) => setImmediate(resolve));
      expect(startOrder).toEqual(['r1', 'r2']);
      resolvers['r1']();
      resolvers['r2']();

      // Batch 2: the edit runs alone; r3/r4 must not start until it settles.
      await vi.waitFor(() => expect(startOrder).toEqual(['r1', 'r2', 'e1']));
      await new Promise((resolve) => setImmediate(resolve));
      expect(startOrder).toEqual(['r1', 'r2', 'e1']);
      resolvers['e1']();

      // Batch 3: r3 and r4 launch together.
      await vi.waitFor(() =>
        expect(startOrder).toEqual(['r1', 'r2', 'e1', 'r3', 'r4']),
      );
      resolvers['r3']();
      resolvers['r4']();
      await run;

      expect(mockCoreExecuteToolCall).toHaveBeenCalledTimes(5);
    });

    it('throttles a parallel batch to QWEN_CODE_MAX_TOOL_CONCURRENCY in flight', async () => {
      setupMetricsMock();
      const prev = process.env['QWEN_CODE_MAX_TOOL_CONCURRENCY'];
      process.env['QWEN_CODE_MAX_TOOL_CONCURRENCY'] = '2';
      try {
        vi.mocked(mockToolRegistry.getTool).mockReturnValue({
          kind: Kind.Read,
        } as unknown as ReturnType<typeof mockToolRegistry.getTool>);

        let active = 0;
        let maxActive = 0;
        const startOrder: string[] = [];
        const resolvers: Record<string, () => void> = {};
        mockCoreExecuteToolCall.mockImplementation(
          (_config: unknown, req: { callId: string }) =>
            new Promise((resolve) => {
              startOrder.push(req.callId);
              active += 1;
              maxActive = Math.max(maxActive, active);
              resolvers[req.callId] = () => {
                active -= 1;
                resolve({ responseParts: [{ text: `resp-${req.callId}` }] });
              };
            }),
        );

        mockGeminiClient.sendMessageStream
          .mockReturnValueOnce(
            createStreamFromEvents(
              toolCallEvents(['c1', 'c2', 'c3', 'c4'], 'read', 'p-cap'),
            ),
          )
          .mockReturnValueOnce(createStreamFromEvents(finishTurn));

        const run = runNonInteractive(mockConfig, mockSettings, 'go', 'p-cap');

        // Cap = 2: only c1 and c2 start; c3 waits on Promise.race(inFlight).
        await vi.waitFor(() => expect(startOrder).toEqual(['c1', 'c2']));
        await new Promise((resolve) => setImmediate(resolve));
        expect(startOrder).toEqual(['c1', 'c2']);
        // Freeing one slot admits the next call, one at a time.
        resolvers['c1']();
        await vi.waitFor(() => expect(startOrder).toEqual(['c1', 'c2', 'c3']));
        resolvers['c2']();
        await vi.waitFor(() =>
          expect(startOrder).toEqual(['c1', 'c2', 'c3', 'c4']),
        );
        resolvers['c3']();
        resolvers['c4']();
        await run;

        expect(maxActive).toBe(2);
        expect(mockCoreExecuteToolCall).toHaveBeenCalledTimes(4);
      } finally {
        if (prev === undefined) {
          delete process.env['QWEN_CODE_MAX_TOOL_CONCURRENCY'];
        } else {
          process.env['QWEN_CODE_MAX_TOOL_CONCURRENCY'] = prev;
        }
      }
    });

    it('canonicalizes legacy tool aliases so they partition like the interactive path', async () => {
      setupMetricsMock();
      // `search_file_content` is a legacy alias for `grep_search`
      // (Kind.Search, concurrency-safe). The registry only knows the canonical
      // name, so the partitioner must canonicalize before the kind lookup —
      // otherwise these classify unsafe → sequential here while the TUI runs
      // them in parallel.
      vi.mocked(mockToolRegistry.getTool).mockImplementation(
        (name: string) =>
          (name === 'grep_search'
            ? { kind: Kind.Search }
            : undefined) as unknown as ReturnType<
            typeof mockToolRegistry.getTool
          >,
      );

      const total = 2;
      const startOrder: string[] = [];
      let started = 0;
      let openGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      mockCoreExecuteToolCall.mockImplementation(
        async (_config: unknown, req: { callId: string }) => {
          startOrder.push(req.callId);
          started += 1;
          if (started === total) openGate();
          await gate;
          return { responseParts: [{ text: `resp-${req.callId}` }] };
        },
      );

      mockGeminiClient.sendMessageStream
        .mockReturnValueOnce(
          createStreamFromEvents(
            toolCallEvents(['s1', 's2'], 'search_file_content', 'p-alias'),
          ),
        )
        .mockReturnValueOnce(createStreamFromEvents(finishTurn));

      await runNonInteractive(mockConfig, mockSettings, 'go', 'p-alias');

      // Both alias calls run in parallel (the gate opens only once both have
      // started); a raw-name lookup would classify them sequential and this
      // would deadlock.
      expect(started).toBe(total);
      expect(startOrder).toEqual(['s1', 's2']);
    });
  });

  it('should ignore duplicate provider tool-call ids across rounds', async () => {
    setupMetricsMock();
    vi.mocked(mockConfig.getMaxToolCalls).mockReturnValue(1);
    const toolCallEvent: ServerGeminiStreamEvent = {
      type: GeminiEventType.ToolCallRequest,
      value: {
        callId: 'tool-1',
        providerCallId: 'tool-1',
        name: 'testTool',
        args: { arg1: 'value1' },
        isClientInitiated: false,
        prompt_id: 'prompt-id-dup',
      },
    };
    const toolResponse: Part[] = [{ text: 'Tool response' }];
    mockCoreExecuteToolCall.mockResolvedValue({ responseParts: toolResponse });

    mockGeminiClient.sendMessageStream
      .mockReturnValueOnce(createStreamFromEvents([toolCallEvent]))
      .mockReturnValueOnce(createStreamFromEvents([toolCallEvent]))
      .mockReturnValueOnce(
        createStreamFromEvents([
          { type: GeminiEventType.Content, value: 'Final answer' },
          {
            type: GeminiEventType.Finished,
            value: {
              reason: undefined,
              usageMetadata: { totalTokenCount: 10 },
            },
          },
        ]),
      );

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'Use a tool',
      'prompt-id-dup',
    );

    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledTimes(3);
    expect(mockCoreExecuteToolCall).toHaveBeenCalledTimes(1);
    expect(mockGeminiClient.recordCompletedToolCall).toHaveBeenCalledTimes(1);

    const duplicateParts = mockGeminiClient.sendMessageStream.mock.calls[2][0];
    expect(duplicateParts[0].functionResponse?.response?.['error']).toContain(
      'Duplicate provider tool call id "tool-1"',
    );
    expect(processStdoutSpy).toHaveBeenCalledWith('Final answer\n');
  });

  it('should stop repeated duplicate provider tool-call responses', async () => {
    setupMetricsMock();
    vi.mocked(mockConfig.getMaxToolCalls).mockReturnValue(1);
    const toolCallEvent: ServerGeminiStreamEvent = {
      type: GeminiEventType.ToolCallRequest,
      value: {
        callId: 'tool-1',
        providerCallId: 'tool-1',
        name: 'testTool',
        args: { arg1: 'value1' },
        isClientInitiated: false,
        prompt_id: 'prompt-id-dup-loop',
      },
    };
    const freshToolCallEvent: ServerGeminiStreamEvent = {
      type: GeminiEventType.ToolCallRequest,
      value: {
        callId: 'tool-2',
        providerCallId: 'tool-2',
        name: 'testTool',
        args: { arg1: 'value2' },
        isClientInitiated: false,
        prompt_id: 'prompt-id-dup-loop',
      },
    };
    mockCoreExecuteToolCall.mockResolvedValue({
      responseParts: [{ text: 'Tool response' }],
    });

    mockGeminiClient.sendMessageStream
      .mockReturnValueOnce(createStreamFromEvents([toolCallEvent]))
      .mockReturnValueOnce(createStreamFromEvents([toolCallEvent]))
      .mockReturnValueOnce(
        createStreamFromEvents([toolCallEvent, freshToolCallEvent]),
      );

    const exitCode = await runNonInteractive(
      mockConfig,
      mockSettings,
      'Use a tool',
      'prompt-id-dup-loop',
    );

    expect(exitCode).toBe(1);
    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledTimes(3);
    expect(mockCoreExecuteToolCall).toHaveBeenCalledTimes(1);
    expect(mockGeminiClient.recordCompletedToolCall).toHaveBeenCalledTimes(1);

    const duplicateParts = mockGeminiClient.sendMessageStream.mock.calls[2][0];
    expect(duplicateParts[0].functionResponse?.response?.['error']).toContain(
      'Duplicate provider tool call id "tool-1"',
    );
    expect(processStderrSpy).toHaveBeenCalledWith(
      expect.stringContaining(LoopType.GLOBAL_TOOL_CALL_DUPLICATE),
    );
    expect(processStderrSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'always-on guard and cannot be disabled via `model.skipLoopDetection`',
      ),
    );
    expect(processStderrSpy).not.toHaveBeenCalledWith(
      expect.stringContaining(
        'Set the `model.skipLoopDetection` setting to true',
      ),
    );
  });

  it('should stop repeated duplicate provider tool-call responses from drain items', async () => {
    setupMetricsMock();
    mockGeminiClient.getHistoryFunctionResponseIds.mockReturnValue(
      new Set(['tool-drain']),
    );

    const notificationXml =
      '<task-notification>\n' +
      '<task-id>mon_1</task-id>\n' +
      '<kind>monitor</kind>\n' +
      '<status>running</status>\n' +
      '<summary>Monitor emitted event #1.</summary>\n' +
      '<result>ready</result>\n' +
      '</task-notification>';
    mockMonitorRegistry.setNotificationCallback.mockImplementation((cb) => {
      if (!cb) return;
      cb('Monitor "logs" event #1: ready', notificationXml, {
        monitorId: 'mon_1',
        toolUseId: 'tool_mon_1',
        status: 'running',
        eventCount: 1,
      });
    });

    const duplicateToolCallEvent: ServerGeminiStreamEvent = {
      type: GeminiEventType.ToolCallRequest,
      value: {
        callId: 'tool-drain__qwen_dup_2',
        providerCallId: 'tool-drain',
        name: 'testTool',
        args: { arg1: 'value1' },
        isClientInitiated: false,
        prompt_id: 'prompt-id-drain-dup-loop',
      },
    };
    const freshToolCallEvent: ServerGeminiStreamEvent = {
      type: GeminiEventType.ToolCallRequest,
      value: {
        callId: 'tool-fresh',
        providerCallId: 'tool-fresh',
        name: 'testTool',
        args: { arg1: 'value2' },
        isClientInitiated: false,
        prompt_id: 'prompt-id-drain-dup-loop',
      },
    };

    mockGeminiClient.sendMessageStream
      .mockReturnValueOnce(
        createStreamFromEvents([
          { type: GeminiEventType.Content, value: 'Monitor launched.' },
          {
            type: GeminiEventType.Finished,
            value: {
              reason: undefined,
              usageMetadata: { totalTokenCount: 2 },
            },
          },
        ]),
      )
      .mockReturnValueOnce(createStreamFromEvents([duplicateToolCallEvent]))
      .mockReturnValueOnce(
        createStreamFromEvents([duplicateToolCallEvent, freshToolCallEvent]),
      );

    const exitCode = await runNonInteractive(
      mockConfig,
      mockSettings,
      'Watch the logs',
      'prompt-id-drain-dup-loop',
    );

    expect(exitCode).toBe(1);
    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledTimes(3);
    expect(mockCoreExecuteToolCall).not.toHaveBeenCalled();

    const duplicateParts = mockGeminiClient.sendMessageStream.mock
      .calls[2][0] as Part[];
    expect(duplicateParts[0].functionResponse?.response?.['error']).toContain(
      'Duplicate provider tool call id "tool-drain"',
    );
    expect(processStderrSpy).toHaveBeenCalledWith(
      expect.stringContaining(LoopType.GLOBAL_TOOL_CALL_DUPLICATE),
    );
  });

  it('should ignore duplicate provider tool-call ids already present in chat history', async () => {
    setupMetricsMock();
    mockGeminiClient.getHistoryFunctionResponseIds.mockReturnValue(
      new Set(['tool-history']),
    );
    const toolCallEvent: ServerGeminiStreamEvent = {
      type: GeminiEventType.ToolCallRequest,
      value: {
        callId: 'tool-history__qwen_dup_2',
        providerCallId: 'tool-history',
        name: 'testTool',
        args: { arg1: 'value1' },
        isClientInitiated: false,
        prompt_id: 'prompt-id-history-dup',
      },
    };

    mockGeminiClient.sendMessageStream
      .mockReturnValueOnce(createStreamFromEvents([toolCallEvent]))
      .mockReturnValueOnce(
        createStreamFromEvents([
          { type: GeminiEventType.Content, value: 'Final answer' },
          {
            type: GeminiEventType.Finished,
            value: {
              reason: undefined,
              usageMetadata: { totalTokenCount: 10 },
            },
          },
        ]),
      );

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'Use a tool',
      'prompt-id-history-dup',
    );

    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledTimes(2);
    expect(mockCoreExecuteToolCall).not.toHaveBeenCalled();
    expect(mockGeminiClient.recordCompletedToolCall).not.toHaveBeenCalled();

    const duplicateParts = mockGeminiClient.sendMessageStream.mock.calls[1][0];
    expect(duplicateParts[0].functionResponse?.id).toBe(
      'tool-history__qwen_dup_2',
    );
    expect(duplicateParts[0].functionResponse?.response?.['error']).toContain(
      'Duplicate provider tool call id "tool-history"',
    );
    expect(processStdoutSpy).toHaveBeenCalledWith('Final answer\n');
  });

  it('should execute only the first duplicate provider tool-call id in the same batch', async () => {
    setupMetricsMock();
    const recordToolResult = vi.fn();
    (
      mockConfig as Config & {
        getChatRecordingService: () => {
          recordToolResult: typeof recordToolResult;
          finalize: ReturnType<typeof vi.fn>;
          flush: ReturnType<typeof vi.fn>;
        };
      }
    ).getChatRecordingService = () => ({
      recordToolResult,
      finalize: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(mockConfig.getMaxToolCalls).mockReturnValue(1);
    const firstToolCall: ServerGeminiStreamEvent = {
      type: GeminiEventType.ToolCallRequest,
      value: {
        callId: 'tool-1',
        providerCallId: 'tool-1',
        name: 'testTool',
        args: { arg1: 'value1' },
        isClientInitiated: false,
        prompt_id: 'prompt-id-same-batch-dup',
      },
    };
    const duplicateToolCall: ServerGeminiStreamEvent = {
      type: GeminiEventType.ToolCallRequest,
      value: {
        callId: 'tool-1',
        providerCallId: 'tool-1',
        name: 'testTool',
        args: { arg1: 'value1' },
        isClientInitiated: false,
        prompt_id: 'prompt-id-same-batch-dup',
      },
    };
    mockCoreExecuteToolCall.mockImplementation(
      async (
        _config: unknown,
        request: ToolCallRequestInfo,
        _signal: AbortSignal,
        options: {
          onAllToolCallsComplete?: (
            calls: Array<{
              request: ToolCallRequestInfo;
              response: ToolCallResponseInfo;
              status: 'success';
            }>,
          ) => Promise<void>;
        },
      ) => {
        const response: ToolCallResponseInfo = {
          callId: request.callId,
          responseParts: [{ text: 'Tool response' }],
          resultDisplay: 'Tool response',
          error: undefined,
          errorType: undefined,
        };
        await options.onAllToolCallsComplete?.([
          { request, response, status: 'success' },
        ]);
        return response;
      },
    );

    mockGeminiClient.sendMessageStream
      .mockReturnValueOnce(
        createStreamFromEvents([firstToolCall, duplicateToolCall]),
      )
      .mockReturnValueOnce(
        createStreamFromEvents([
          { type: GeminiEventType.Content, value: 'Final answer' },
          {
            type: GeminiEventType.Finished,
            value: {
              reason: undefined,
              usageMetadata: { totalTokenCount: 10 },
            },
          },
        ]),
      );

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'Use a tool',
      'prompt-id-same-batch-dup',
    );

    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledTimes(2);
    expect(mockCoreExecuteToolCall).toHaveBeenCalledTimes(1);
    expect(mockGeminiClient.recordCompletedToolCall).toHaveBeenCalledTimes(1);

    const toolResultParts = mockGeminiClient.sendMessageStream.mock.calls[1][0];
    expect(toolResultParts).toHaveLength(2);
    expect(toolResultParts[0]).toEqual({ text: 'Tool response' });
    expect(toolResultParts[1].functionResponse?.response?.['error']).toContain(
      'Duplicate provider tool call id "tool-1"',
    );
    expect(recordToolResult).toHaveBeenCalledTimes(2);
    expect(recordToolResult.mock.calls.map((call) => call[1].status)).toEqual([
      'success',
      'error',
    ]);
    expect(processStdoutSpy).toHaveBeenCalledWith('Final answer\n');
  });

  it('should handle error during tool execution and should send error back to the model', async () => {
    setupMetricsMock();
    const toolCallEvent: ServerGeminiStreamEvent = {
      type: GeminiEventType.ToolCallRequest,
      value: {
        callId: 'tool-1',
        name: 'errorTool',
        args: {},
        isClientInitiated: false,
        prompt_id: 'prompt-id-3',
      },
    };
    mockCoreExecuteToolCall.mockResolvedValue({
      error: new Error('Execution failed'),
      errorType: ToolErrorType.EXECUTION_FAILED,
      responseParts: [
        {
          functionResponse: {
            name: 'errorTool',
            response: {
              output: 'Error: Execution failed',
            },
          },
        },
      ],
      resultDisplay: 'Execution failed',
    });
    const finalResponse: ServerGeminiStreamEvent[] = [
      {
        type: GeminiEventType.Content,
        value: 'Sorry, let me try again.',
      },
      {
        type: GeminiEventType.Finished,
        value: { reason: undefined, usageMetadata: { totalTokenCount: 10 } },
      },
    ];
    mockGeminiClient.sendMessageStream
      .mockReturnValueOnce(createStreamFromEvents([toolCallEvent]))
      .mockReturnValueOnce(createStreamFromEvents(finalResponse));

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'Trigger tool error',
      'prompt-id-3',
    );

    expect(mockCoreExecuteToolCall).toHaveBeenCalled();
    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledTimes(2);
    expect(mockGeminiClient.sendMessageStream).toHaveBeenNthCalledWith(
      2,
      [
        {
          functionResponse: {
            name: 'errorTool',
            response: {
              output: 'Error: Execution failed',
            },
          },
        },
      ],
      expect.any(AbortSignal),
      'prompt-id-3',
      { type: SendMessageType.ToolResult },
    );
    expect(processStdoutSpy).toHaveBeenCalledWith('Sorry, let me try again.\n');
  });

  it('should exit with error if sendMessageStream throws initially', async () => {
    setupMetricsMock();
    const apiError = new Error('API connection failed');
    mockGeminiClient.sendMessageStream.mockImplementation(() => {
      throw apiError;
    });

    await expect(
      runNonInteractive(
        mockConfig,
        mockSettings,
        'Initial fail',
        'prompt-id-4',
      ),
    ).rejects.toThrow(apiError);
  });

  it('should not exit if a tool is not found, and should send error back to model', async () => {
    setupMetricsMock();
    const toolCallEvent: ServerGeminiStreamEvent = {
      type: GeminiEventType.ToolCallRequest,
      value: {
        callId: 'tool-1',
        name: 'nonexistentTool',
        args: {},
        isClientInitiated: false,
        prompt_id: 'prompt-id-5',
      },
    };
    mockCoreExecuteToolCall.mockResolvedValue({
      error: new Error('Tool "nonexistentTool" not found in registry.'),
      resultDisplay: 'Tool "nonexistentTool" not found in registry.',
      responseParts: [],
    });
    const finalResponse: ServerGeminiStreamEvent[] = [
      {
        type: GeminiEventType.Content,
        value: "Sorry, I can't find that tool.",
      },
      {
        type: GeminiEventType.Finished,
        value: { reason: undefined, usageMetadata: { totalTokenCount: 10 } },
      },
    ];

    mockGeminiClient.sendMessageStream
      .mockReturnValueOnce(createStreamFromEvents([toolCallEvent]))
      .mockReturnValueOnce(createStreamFromEvents(finalResponse));

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'Trigger tool not found',
      'prompt-id-5',
    );

    expect(mockCoreExecuteToolCall).toHaveBeenCalled();
    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledTimes(2);
    expect(processStdoutSpy).toHaveBeenCalledWith(
      "Sorry, I can't find that tool.\n",
    );
  });

  it('should exit when max session turns are exceeded', async () => {
    setupMetricsMock();
    vi.mocked(mockConfig.getMaxSessionTurns).mockReturnValue(0);
    await expect(
      runNonInteractive(
        mockConfig,
        mockSettings,
        'Trigger loop',
        'prompt-id-6',
      ),
    ).rejects.toThrow('process.exit(53) called');
  });

  it('should preprocess @include commands before sending to the model', async () => {
    setupMetricsMock();
    // 1. Mock the imported atCommandProcessor
    const { handleAtCommand } = await import(
      './ui/hooks/atCommandProcessor.js'
    );
    const mockHandleAtCommand = vi.mocked(handleAtCommand);

    // 2. Define the raw input and the expected processed output
    const rawInput = 'Summarize @file.txt';
    const processedParts: Part[] = [
      { text: 'Summarize @file.txt' },
      { text: '\n--- Content from referenced files ---\n' },
      { text: 'This is the content of the file.' },
      { text: '\n--- End of content ---' },
    ];

    // 3. Setup the mock to return the processed parts
    mockHandleAtCommand.mockResolvedValue({
      processedQuery: processedParts,
      shouldProceed: true,
    });

    // Mock a simple stream response from the Gemini client
    const events: ServerGeminiStreamEvent[] = [
      { type: GeminiEventType.Content, value: 'Summary complete.' },
      {
        type: GeminiEventType.Finished,
        value: { reason: undefined, usageMetadata: { totalTokenCount: 10 } },
      },
    ];
    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents(events),
    );

    // 4. Run the non-interactive mode with the raw input
    await runNonInteractive(mockConfig, mockSettings, rawInput, 'prompt-id-7');

    // 5. Assert that sendMessageStream was called with the PROCESSED parts, not the raw input
    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledWith(
      processedParts,
      expect.any(AbortSignal),
      'prompt-id-7',
      { type: SendMessageType.UserQuery },
    );

    // 6. Assert the final output is correct
    expect(processStdoutSpy).toHaveBeenCalledWith('Summary complete.\n');
  });

  it('should process input and write JSON output with stats', async () => {
    const events: ServerGeminiStreamEvent[] = [
      { type: GeminiEventType.Content, value: 'Hello World' },
      {
        type: GeminiEventType.Finished,
        value: { reason: undefined, usageMetadata: { totalTokenCount: 10 } },
      },
    ];
    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents(events),
    );
    (mockConfig.getOutputFormat as Mock).mockReturnValue(OutputFormat.JSON);
    setupMetricsMock();

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'Test input',
      'prompt-id-1',
    );

    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledWith(
      [{ text: 'Test input' }],
      expect.any(AbortSignal),
      'prompt-id-1',
      { type: SendMessageType.UserQuery },
    );

    // JSON adapter emits array of messages, last one is result with stats
    const outputCalls = processStdoutSpy.mock.calls.filter(
      (call) => typeof call[0] === 'string',
    );
    expect(outputCalls.length).toBeGreaterThan(0);
    const lastOutput = outputCalls[outputCalls.length - 1][0];
    const parsed = JSON.parse(lastOutput);
    expect(Array.isArray(parsed)).toBe(true);
    const resultMessage = parsed.find(
      (msg: unknown) =>
        typeof msg === 'object' &&
        msg !== null &&
        'type' in msg &&
        msg.type === 'result',
    );
    expect(resultMessage).toBeTruthy();
    expect(resultMessage?.result).toBe('Hello World');
    // Get the actual metrics that were used
    const actualMetrics = vi.mocked(uiTelemetryService.getMetrics)();
    expect(resultMessage?.stats).toEqual(actualMetrics);
  });

  it('should write JSON output with stats for tool-only commands (no text response)', async () => {
    // Test the scenario where a command completes successfully with only tool calls
    // but no text response - this would have caught the original bug
    const toolCallEvent: ServerGeminiStreamEvent = {
      type: GeminiEventType.ToolCallRequest,
      value: {
        callId: 'tool-1',
        name: 'testTool',
        args: { arg1: 'value1' },
        isClientInitiated: false,
        prompt_id: 'prompt-id-tool-only',
      },
    };
    const toolResponse: Part[] = [{ text: 'Tool executed successfully' }];
    mockCoreExecuteToolCall.mockResolvedValue({ responseParts: toolResponse });

    // First call returns only tool call, no content
    const firstCallEvents: ServerGeminiStreamEvent[] = [
      toolCallEvent,
      {
        type: GeminiEventType.Finished,
        value: { reason: undefined, usageMetadata: { totalTokenCount: 5 } },
      },
    ];

    // Second call returns no content (tool-only completion)
    const secondCallEvents: ServerGeminiStreamEvent[] = [
      {
        type: GeminiEventType.Finished,
        value: { reason: undefined, usageMetadata: { totalTokenCount: 3 } },
      },
    ];

    mockGeminiClient.sendMessageStream
      .mockReturnValueOnce(createStreamFromEvents(firstCallEvents))
      .mockReturnValueOnce(createStreamFromEvents(secondCallEvents));

    (mockConfig.getOutputFormat as Mock).mockReturnValue(OutputFormat.JSON);
    setupMetricsMock({
      tools: {
        totalCalls: 1,
        totalSuccess: 1,
        totalFail: 0,
        totalDurationMs: 100,
        totalDecisions: {
          accept: 1,
          reject: 0,
          modify: 0,
          auto_accept: 0,
        },
        byName: {
          testTool: {
            count: 1,
            success: 1,
            fail: 0,
            durationMs: 100,
            decisions: {
              accept: 1,
              reject: 0,
              modify: 0,
              auto_accept: 0,
            },
          },
        },
      },
    });

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'Execute tool only',
      'prompt-id-tool-only',
    );

    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledTimes(2);
    expect(mockCoreExecuteToolCall).toHaveBeenCalledWith(
      mockConfig,
      expect.objectContaining({ name: 'testTool' }),
      expect.any(AbortSignal),
      expect.objectContaining({
        outputUpdateHandler: expect.any(Function),
      }),
    );

    // JSON adapter emits array of messages, last one is result with stats
    const outputCalls = processStdoutSpy.mock.calls.filter(
      (call) => typeof call[0] === 'string',
    );
    expect(outputCalls.length).toBeGreaterThan(0);
    const lastOutput = outputCalls[outputCalls.length - 1][0];
    const parsed = JSON.parse(lastOutput);
    expect(Array.isArray(parsed)).toBe(true);
    const resultMessage = parsed.find(
      (msg: unknown) =>
        typeof msg === 'object' &&
        msg !== null &&
        'type' in msg &&
        msg.type === 'result',
    );
    expect(resultMessage).toBeTruthy();
    expect(resultMessage?.result).toBe('');
    // Note: stats would only be included if passed to emitResult, which current implementation doesn't do
    // This test verifies the structure, but stats inclusion depends on implementation
  });

  it('should write JSON output with stats for empty response commands', async () => {
    // Test the scenario where a command completes but produces no content at all
    const events: ServerGeminiStreamEvent[] = [
      {
        type: GeminiEventType.Finished,
        value: { reason: undefined, usageMetadata: { totalTokenCount: 1 } },
      },
    ];
    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents(events),
    );
    (mockConfig.getOutputFormat as Mock).mockReturnValue(OutputFormat.JSON);
    setupMetricsMock();

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'Empty response test',
      'prompt-id-empty',
    );

    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledWith(
      [{ text: 'Empty response test' }],
      expect.any(AbortSignal),
      'prompt-id-empty',
      { type: SendMessageType.UserQuery },
    );

    // JSON adapter emits array of messages, last one is result with stats
    const outputCalls = processStdoutSpy.mock.calls.filter(
      (call) => typeof call[0] === 'string',
    );
    expect(outputCalls.length).toBeGreaterThan(0);
    const lastOutput = outputCalls[outputCalls.length - 1][0];
    const parsed = JSON.parse(lastOutput);
    expect(Array.isArray(parsed)).toBe(true);
    const resultMessage = parsed.find(
      (msg: unknown) =>
        typeof msg === 'object' &&
        msg !== null &&
        'type' in msg &&
        msg.type === 'result',
    );
    expect(resultMessage).toBeTruthy();
    expect(resultMessage?.result).toBe('');
    // Get the actual metrics that were used
    const actualMetrics = vi.mocked(uiTelemetryService.getMetrics)();
    expect(resultMessage?.stats).toEqual(actualMetrics);
  });

  it('should handle errors in JSON format', async () => {
    (mockConfig.getOutputFormat as Mock).mockReturnValue(OutputFormat.JSON);
    setupMetricsMock();
    const testError = new Error('Invalid input provided');

    mockGeminiClient.sendMessageStream.mockImplementation(() => {
      throw testError;
    });

    let thrownError: Error | null = null;
    try {
      await runNonInteractive(
        mockConfig,
        mockSettings,
        'Test input',
        'prompt-id-error',
      );
      // Should not reach here
      expect.fail('Expected process.exit to be called');
    } catch (error) {
      thrownError = error as Error;
    }

    // Should throw because of mocked process.exit
    expect(thrownError?.message).toBe('process.exit(1) called');

    const jsonError = JSON.stringify(
      {
        error: {
          type: 'Error',
          message: 'Invalid input provided',
          code: 1,
        },
      },
      null,
      2,
    );
    expect(processStderrSpy).toHaveBeenCalledWith(`${jsonError}\n`);
  });

  it('should handle API errors in text mode and exit with error code', async () => {
    (mockConfig.getOutputFormat as Mock).mockReturnValue(OutputFormat.TEXT);
    setupMetricsMock();

    // Simulate an API error event (like 401 unauthorized)
    const apiErrorEvent: ServerGeminiStreamEvent = {
      type: GeminiEventType.Error,
      value: {
        error: {
          message: '401 Incorrect API key provided',
          status: 401,
        },
      },
    };

    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents([apiErrorEvent]),
    );

    let thrownError: Error | null = null;
    try {
      await runNonInteractive(
        mockConfig,
        mockSettings,
        'Test input',
        'prompt-id-api-error',
      );
      // Should not reach here
      expect.fail('Expected error to be thrown');
    } catch (error) {
      thrownError = error as Error;
    }

    // Should throw with the API error message
    expect(thrownError).toBeTruthy();
    expect(thrownError?.message).toContain('401');
    expect(thrownError?.message).toContain('Incorrect API key provided');

    // Verify error was written to stderr
    expect(processStderrSpy).toHaveBeenCalled();
    const stderrCalls = processStderrSpy.mock.calls;
    const errorOutput = stderrCalls.map((call) => call[0]).join('');
    expect(errorOutput).toContain('401');
    expect(errorOutput).toContain('Incorrect API key provided');
  });

  it('does not double-wrap or double-format an API error in non-interactive mode', async () => {
    // Regression test for the bug where a 4xx error event flowed through
    // both the stream handler and handleError, each calling
    // parseAndFormatApiError once. The second pass would wrap the
    // already-formatted Error.message a second time, producing
    // "[API Error: [API Error: 402 ...]]" on stderr.
    //
    // We don't assert on the *number* of stderr writes here — JsonOutputAdapter
    // also emits the result message on the error path, which legitimately hits
    // stderr in TEXT mode (separate concern, separate channel). What we
    // strictly forbid is the double-wrap and any handleError-path duplicate.
    (mockConfig.getOutputFormat as Mock).mockReturnValue(OutputFormat.TEXT);
    setupMetricsMock();
    const finalize = vi.fn();
    const flush = vi.fn().mockResolvedValue(undefined);
    (
      mockConfig as unknown as {
        getChatRecordingService: () => {
          finalize: () => void;
          flush: () => Promise<void>;
        };
      }
    ).getChatRecordingService = () => ({ finalize, flush });

    const apiErrorEvent: ServerGeminiStreamEvent = {
      type: GeminiEventType.Error,
      value: {
        error: {
          message: '402 Model gpt-oss-120b is not available for billing.',
          status: 402,
        },
      },
    };

    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents([apiErrorEvent]),
    );

    await expect(
      runNonInteractive(
        mockConfig,
        mockSettings,
        'Test input',
        'prompt-id-double-wrap',
      ),
    ).rejects.toBeInstanceOf(AlreadyReportedError);

    expect(finalize).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledOnce();

    const stderrOutput = processStderrSpy.mock.calls
      .map((call) => String(call[0]))
      .join('');

    // The "[API Error: [API Error:" double-wrap must never appear.
    if (stderrOutput.includes('[API Error: [API Error:')) {
      // Surface the raw bytes so a regression points at the actual offending
      // line instead of needing a debugger.
      const dump = processStderrSpy.mock.calls
        .map((call, i) => `  [${i}] ${JSON.stringify(call[0])}`)
        .join('\n');
      throw new Error(`unexpected double-wrap on stderr:\n${dump}`);
    }

    // Each formatted line ("[API Error: ...]") must contain the upstream
    // message verbatim — i.e. wrapping happens exactly once per emission.
    for (const call of processStderrSpy.mock.calls) {
      const line = String(call[0]);
      if (line.startsWith('[API Error: ')) {
        // The opening "[API Error: " should appear once; if it appears twice,
        // we have a "[API Error: [API Error: ..." line.
        expect(line.match(/\[API Error: /g)?.length ?? 0).toBe(1);
      }
    }
  });

  it('should handle FatalInputError with custom exit code in JSON format', async () => {
    (mockConfig.getOutputFormat as Mock).mockReturnValue(OutputFormat.JSON);
    setupMetricsMock();
    const fatalError = new FatalInputError('Invalid command syntax provided');

    mockGeminiClient.sendMessageStream.mockImplementation(() => {
      throw fatalError;
    });

    let thrownError: Error | null = null;
    try {
      await runNonInteractive(
        mockConfig,
        mockSettings,
        'Invalid syntax',
        'prompt-id-fatal',
      );
      // Should not reach here
      expect.fail('Expected process.exit to be called');
    } catch (error) {
      thrownError = error as Error;
    }

    // Should throw because of mocked process.exit with custom exit code
    expect(thrownError?.message).toBe('process.exit(42) called');

    const jsonError = JSON.stringify(
      {
        error: {
          type: 'FatalInputError',
          message: 'Invalid command syntax provided',
          code: 42,
        },
      },
      null,
      2,
    );
    expect(processStderrSpy).toHaveBeenCalledWith(`${jsonError}\n`);
  });

  it('should execute a slash command that returns a prompt', async () => {
    setupMetricsMock();
    const mockCommand = {
      name: 'testcommand',
      description: 'a test command',
      kind: CommandKind.FILE,
      action: vi.fn().mockResolvedValue({
        type: 'submit_prompt',
        content: [{ text: 'Prompt from command' }],
      }),
    };
    mockGetCommands.mockReturnValue([mockCommand]);

    const events: ServerGeminiStreamEvent[] = [
      { type: GeminiEventType.Content, value: 'Response from command' },
      {
        type: GeminiEventType.Finished,
        value: { reason: undefined, usageMetadata: { totalTokenCount: 5 } },
      },
    ];
    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents(events),
    );

    await runNonInteractive(
      mockConfig,
      mockSettings,
      '/testcommand',
      'prompt-id-slash',
    );

    // Ensure the prompt sent to the model is from the command, not the raw input
    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledWith(
      [{ text: 'Prompt from command' }],
      expect.any(AbortSignal),
      'prompt-id-slash',
      { type: SendMessageType.UserQuery },
    );

    expect(processStdoutSpy).toHaveBeenCalledWith('Response from command\n');
  });

  it('should handle command that requires confirmation by returning early', async () => {
    setupMetricsMock();
    const mockCommand = {
      name: 'confirm',
      description: 'a command that needs confirmation',
      kind: CommandKind.FILE,
      action: vi.fn().mockResolvedValue({
        type: 'confirm_shell_commands',
        commands: ['rm -rf /'],
      }),
    };
    mockGetCommands.mockReturnValue([mockCommand]);

    await runNonInteractive(
      mockConfig,
      mockSettings,
      '/confirm',
      'prompt-id-confirm',
    );

    // Should write error message through adapter to stdout (TEXT mode goes through JsonOutputAdapter)
    expect(processStderrSpy).toHaveBeenCalledWith(
      'Shell command confirmation is not supported in non-interactive mode. Use YOLO mode or pre-approve commands.\n',
    );
  });

  it('should treat an unknown slash command as a regular prompt', async () => {
    setupMetricsMock();
    // No commands are mocked, so any slash command is "unknown"
    mockGetCommands.mockReturnValue([]);

    const events: ServerGeminiStreamEvent[] = [
      { type: GeminiEventType.Content, value: 'Response to unknown' },
      {
        type: GeminiEventType.Finished,
        value: { reason: undefined, usageMetadata: { totalTokenCount: 5 } },
      },
    ];
    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents(events),
    );

    await runNonInteractive(
      mockConfig,
      mockSettings,
      '/unknowncommand',
      'prompt-id-unknown',
    );

    // Ensure the raw input is sent to the model
    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledWith(
      [{ text: '/unknowncommand' }],
      expect.any(AbortSignal),
      'prompt-id-unknown',
      { type: SendMessageType.UserQuery },
    );

    expect(processStdoutSpy).toHaveBeenCalledWith('Response to unknown\n');
  });

  it('should handle known but unsupported slash commands like /help by returning early', async () => {
    setupMetricsMock();
    // Mock a built-in command that exists but is not in the allowed list
    const mockHelpCommand = {
      name: 'help',
      description: 'Show help',
      kind: CommandKind.BUILT_IN,
      action: vi.fn(),
    };
    mockGetCommands.mockReturnValue([mockHelpCommand]);

    await runNonInteractive(
      mockConfig,
      mockSettings,
      '/help',
      'prompt-id-help',
    );

    // Should write error message through adapter to stdout (TEXT mode goes through JsonOutputAdapter)
    expect(processStderrSpy).toHaveBeenCalledWith(
      'The command "/help" is not supported in this mode.\n',
    );
  });

  it('should handle unhandled command result types by returning early with error', async () => {
    setupMetricsMock();
    const mockCommand = {
      name: 'noaction',
      description: 'unhandled type',
      kind: CommandKind.FILE,
      action: vi.fn().mockResolvedValue({
        type: 'unhandled',
      }),
    };
    mockGetCommands.mockReturnValue([mockCommand]);

    await runNonInteractive(
      mockConfig,
      mockSettings,
      '/noaction',
      'prompt-id-unhandled',
    );

    // Should write error message to stderr
    expect(processStderrSpy).toHaveBeenCalledWith(
      'Unknown command result type: unhandled\n',
    );
  });

  it('should pass arguments to the slash command action', async () => {
    setupMetricsMock();
    const mockAction = vi.fn().mockResolvedValue({
      type: 'submit_prompt',
      content: [{ text: 'Prompt from command' }],
    });
    const mockCommand = {
      name: 'testargs',
      description: 'a test command',
      kind: CommandKind.FILE,
      action: mockAction,
    };
    mockGetCommands.mockReturnValue([mockCommand]);

    const events: ServerGeminiStreamEvent[] = [
      { type: GeminiEventType.Content, value: 'Acknowledged' },
      {
        type: GeminiEventType.Finished,
        value: { reason: undefined, usageMetadata: { totalTokenCount: 1 } },
      },
    ];
    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents(events),
    );

    await runNonInteractive(
      mockConfig,
      mockSettings,
      '/testargs arg1 arg2',
      'prompt-id-args',
    );

    expect(mockAction).toHaveBeenCalledWith(expect.any(Object), 'arg1 arg2');

    expect(processStdoutSpy).toHaveBeenCalledWith('Acknowledged\n');
  });

  it('should emit stream-json envelopes when output format is stream-json', async () => {
    (mockConfig.getOutputFormat as Mock).mockReturnValue('stream-json');
    (mockConfig.getIncludePartialMessages as Mock).mockReturnValue(false);
    setupMetricsMock();

    const writes: string[] = [];
    processStdoutSpy.mockImplementation((chunk: string | Uint8Array) => {
      if (typeof chunk === 'string') {
        writes.push(chunk);
      } else {
        writes.push(Buffer.from(chunk).toString('utf8'));
      }
      return true;
    });

    const events: ServerGeminiStreamEvent[] = [
      { type: GeminiEventType.Content, value: 'Hello stream' },
      {
        type: GeminiEventType.Finished,
        value: { reason: undefined, usageMetadata: { totalTokenCount: 4 } },
      },
    ];
    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents(events),
    );

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'Stream input',
      'prompt-stream',
    );

    const envelopes = writes
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));

    // First envelope should be system message (emitted at session start)
    expect(envelopes[0]).toMatchObject({
      type: 'system',
      subtype: 'init',
    });

    const assistantEnvelope = envelopes.find((env) => env.type === 'assistant');
    expect(assistantEnvelope).toBeTruthy();
    expect(assistantEnvelope?.message?.content?.[0]).toMatchObject({
      type: 'text',
      text: 'Hello stream',
    });
    const resultEnvelope = envelopes.at(-1);
    expect(resultEnvelope).toMatchObject({
      type: 'result',
      is_error: false,
      num_turns: 1,
    });
  });

  it('emits the effective fork context mode in headless task events', async () => {
    (mockConfig.getOutputFormat as Mock).mockReturnValue(
      OutputFormat.STREAM_JSON,
    );
    (mockConfig.getIncludePartialMessages as Mock).mockReturnValue(false);
    setupMetricsMock();

    const writes: string[] = [];
    processStdoutSpy.mockImplementation((chunk: string | Uint8Array) => {
      writes.push(
        typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'),
      );
      return true;
    });
    mockBackgroundTaskRegistry.setRegisterCallback.mockImplementation(
      (callback) => {
        callback?.({
          agentId: 'fork-tool-fork-1',
          toolUseId: 'tool-fork-1',
          description: 'Inherit parent context',
          subagentType: 'fork',
        });
      },
    );
    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents([
        { type: GeminiEventType.Content, value: 'Fork launched.' },
        {
          type: GeminiEventType.Finished,
          value: {
            reason: undefined,
            usageMetadata: { totalTokenCount: 2 },
          },
        },
      ]),
    );

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'Launch a context-inheriting fork',
      'prompt-headless-fork',
    );

    const envelopes = writes
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
    expect(envelopes).toContainEqual(
      expect.objectContaining({
        type: 'system',
        subtype: 'task_started',
        data: expect.objectContaining({
          task_id: 'fork-tool-fork-1',
          tool_use_id: 'tool-fork-1',
          subagent_type: 'fork',
        }),
      }),
    );
  });

  it('flushes terminal monitor notifications before the final headless result', async () => {
    (mockConfig.getOutputFormat as Mock).mockReturnValue(
      OutputFormat.STREAM_JSON,
    );
    (mockConfig.getIncludePartialMessages as Mock).mockReturnValue(false);
    setupMetricsMock();

    const writes: string[] = [];
    processStdoutSpy.mockImplementation((chunk: string | Uint8Array) => {
      if (typeof chunk === 'string') {
        writes.push(chunk);
      } else {
        writes.push(Buffer.from(chunk).toString('utf8'));
      }
      return true;
    });

    const notificationXml =
      '<task-notification>\n' +
      '<task-id>mon_1</task-id>\n' +
      '<kind>monitor</kind>\n' +
      '<status>running</status>\n' +
      '<summary>Monitor emitted event #1.</summary>\n' +
      '<result>ready</result>\n' +
      '</task-notification>';
    const cancelledXml =
      '<task-notification>\n' +
      '<task-id>mon_1</task-id>\n' +
      '<kind>monitor</kind>\n' +
      '<status>cancelled</status>\n' +
      '<summary>Monitor was cancelled.</summary>\n' +
      '</task-notification>';
    let monitorNotificationCallback:
      | ((
          displayText: string,
          modelText: string,
          meta: {
            monitorId: string;
            toolUseId?: string;
            status: 'running' | 'completed' | 'failed' | 'cancelled';
            eventCount: number;
          },
        ) => void)
      | undefined;

    mockMonitorRegistry.setNotificationCallback.mockImplementation((cb) => {
      monitorNotificationCallback = cb ?? undefined;
      if (!cb) {
        return;
      }
      cb('Monitor "logs" event #1: ready', notificationXml, {
        monitorId: 'mon_1',
        toolUseId: 'tool_mon_1',
        status: 'running',
        eventCount: 1,
      });
    });
    mockMonitorRegistry.abortAll.mockImplementation(() => {
      monitorNotificationCallback?.(
        'Monitor "logs" was cancelled.',
        cancelledXml,
        {
          monitorId: 'mon_1',
          toolUseId: 'tool_mon_1',
          status: 'cancelled',
          eventCount: 1,
        },
      );
    });

    mockGeminiClient.sendMessageStream
      .mockReturnValueOnce(
        createStreamFromEvents([
          { type: GeminiEventType.Content, value: 'Monitor launched.' },
          {
            type: GeminiEventType.Finished,
            value: {
              reason: undefined,
              usageMetadata: { totalTokenCount: 2 },
            },
          },
        ]),
      )
      .mockReturnValueOnce(
        createStreamFromEvents([
          { type: GeminiEventType.Content, value: 'Observed.' },
          {
            type: GeminiEventType.Finished,
            value: {
              reason: undefined,
              usageMetadata: { totalTokenCount: 1 },
            },
          },
        ]),
      );

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'Watch the logs',
      'prompt-monitor',
    );

    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledTimes(2);
    expect(mockGeminiClient.sendMessageStream).toHaveBeenNthCalledWith(
      2,
      [{ text: notificationXml }],
      expect.any(AbortSignal),
      'prompt-monitor',
      {
        type: SendMessageType.Notification,
        modelOverride: undefined,
        notificationDisplayText: 'Monitor "logs" event #1: ready',
      },
    );

    const envelopes = writes
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
    expect(
      envelopes.some(
        (env) =>
          env.type === 'system' &&
          env.subtype === 'task_notification' &&
          env.data?.task_id === 'mon_1',
      ),
    ).toBe(true);
    const cancelledNotificationIndex = envelopes.findIndex(
      (env) =>
        env.type === 'system' &&
        env.subtype === 'task_notification' &&
        env.data?.task_id === 'mon_1' &&
        env.data?.status === 'cancelled',
    );
    const resultIndex = envelopes.findIndex((env) => env.type === 'result');
    expect(cancelledNotificationIndex).toBeGreaterThanOrEqual(0);
    expect(resultIndex).toBeGreaterThan(cancelledNotificationIndex);
    expect(mockMonitorRegistry.abortAll).toHaveBeenCalledTimes(1);
    expect(envelopes.at(-1)).toMatchObject({
      type: 'result',
      is_error: false,
    });
  });

  it.skip('should emit a single user envelope when userEnvelope is provided', async () => {
    (mockConfig.getOutputFormat as Mock).mockReturnValue('stream-json');
    (mockConfig.getIncludePartialMessages as Mock).mockReturnValue(false);

    const writes: string[] = [];
    processStdoutSpy.mockImplementation((chunk: string | Uint8Array) => {
      if (typeof chunk === 'string') {
        writes.push(chunk);
      } else {
        writes.push(Buffer.from(chunk).toString('utf8'));
      }
      return true;
    });

    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents([
        { type: GeminiEventType.Content, value: 'Handled once' },
        {
          type: GeminiEventType.Finished,
          value: { reason: undefined, usageMetadata: { totalTokenCount: 2 } },
        },
      ]),
    );

    const userEnvelope = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '来自 envelope 的消息',
          },
        ],
      },
    } as unknown as CLIUserMessage;

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'ignored input',
      'prompt-envelope',
      {
        userMessage: userEnvelope,
      },
    );

    const envelopes = writes
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));

    const userEnvelopes = envelopes.filter((env) => env.type === 'user');
    expect(userEnvelopes).toHaveLength(0);
  });

  it('does not let late monitor output keep one-shot runs alive', async () => {
    (mockConfig.getOutputFormat as Mock).mockReturnValue(
      OutputFormat.STREAM_JSON,
    );
    (mockConfig.getIncludePartialMessages as Mock).mockReturnValue(false);
    setupMetricsMock();

    const writes: string[] = [];
    processStdoutSpy.mockImplementation((chunk: string | Uint8Array) => {
      if (typeof chunk === 'string') {
        writes.push(chunk);
      } else {
        writes.push(Buffer.from(chunk).toString('utf8'));
      }
      return true;
    });

    const firstNotificationXml =
      '<task-notification>\n' +
      '<task-id>mon_1</task-id>\n' +
      '<kind>monitor</kind>\n' +
      '<status>running</status>\n' +
      '<summary>Monitor emitted event #1.</summary>\n' +
      '<result>ready</result>\n' +
      '</task-notification>';
    const secondNotificationXml =
      '<task-notification>\n' +
      '<task-id>mon_1</task-id>\n' +
      '<kind>monitor</kind>\n' +
      '<status>running</status>\n' +
      '<summary>Monitor emitted event #2.</summary>\n' +
      '<result>still running</result>\n' +
      '</task-notification>';
    const cancelledXml =
      '<task-notification>\n' +
      '<task-id>mon_1</task-id>\n' +
      '<kind>monitor</kind>\n' +
      '<status>cancelled</status>\n' +
      '<summary>Monitor was cancelled.</summary>\n' +
      '</task-notification>';

    let monitorNotificationCallback:
      | ((
          displayText: string,
          modelText: string,
          meta: {
            monitorId: string;
            toolUseId?: string;
            status: 'running' | 'completed' | 'failed' | 'cancelled';
            eventCount: number;
          },
        ) => void)
      | undefined;

    mockMonitorRegistry.setNotificationCallback.mockImplementation((cb) => {
      monitorNotificationCallback = cb ?? undefined;
      if (!cb) {
        return;
      }
      cb('Monitor "logs" event #1: ready', firstNotificationXml, {
        monitorId: 'mon_1',
        toolUseId: 'tool_mon_1',
        status: 'running',
        eventCount: 1,
      });
    });
    mockMonitorRegistry.abortAll.mockImplementation(() => {
      monitorNotificationCallback?.(
        'Monitor "logs" was cancelled.',
        cancelledXml,
        {
          monitorId: 'mon_1',
          toolUseId: 'tool_mon_1',
          status: 'cancelled',
          eventCount: 2,
        },
      );
    });

    async function* secondTurnStream(): AsyncGenerator<ServerGeminiStreamEvent> {
      yield { type: GeminiEventType.Content, value: 'Observed.' };
      monitorNotificationCallback?.(
        'Monitor "logs" event #2: still running',
        secondNotificationXml,
        {
          monitorId: 'mon_1',
          toolUseId: 'tool_mon_1',
          status: 'running',
          eventCount: 2,
        },
      );
      yield {
        type: GeminiEventType.Finished,
        value: {
          reason: undefined,
          usageMetadata: { totalTokenCount: 1 },
        },
      };
    }

    mockGeminiClient.sendMessageStream
      .mockReturnValueOnce(
        createStreamFromEvents([
          { type: GeminiEventType.Content, value: 'Monitor launched.' },
          {
            type: GeminiEventType.Finished,
            value: {
              reason: undefined,
              usageMetadata: { totalTokenCount: 2 },
            },
          },
        ]),
      )
      .mockReturnValueOnce(secondTurnStream());

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'Watch the logs',
      'prompt-monitor-cutover',
    );

    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledTimes(2);

    const envelopes = writes
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
    const monitorNotifications = envelopes.filter(
      (env) =>
        env.type === 'system' &&
        env.subtype === 'task_notification' &&
        env.data?.task_id === 'mon_1',
    );
    expect(
      monitorNotifications.filter((env) => env.data?.status === 'running'),
    ).toHaveLength(2);
    expect(
      monitorNotifications.some((env) => env.data?.status === 'cancelled'),
    ).toBe(true);
    expect(envelopes.at(-1)).toMatchObject({
      type: 'result',
      is_error: false,
    });
  });

  it('streams late monitor output to the SDK before one-shot completion', async () => {
    (mockConfig.getOutputFormat as Mock).mockReturnValue(
      OutputFormat.STREAM_JSON,
    );
    (mockConfig.getIncludePartialMessages as Mock).mockReturnValue(false);
    setupMetricsMock();

    const writes: string[] = [];
    processStdoutSpy.mockImplementation((chunk: string | Uint8Array) => {
      if (typeof chunk === 'string') {
        writes.push(chunk);
      } else {
        writes.push(Buffer.from(chunk).toString('utf8'));
      }
      return true;
    });

    let keepBackgroundTaskOpen = true;
    let lateMonitorEventEmitted = false;
    mockBackgroundTaskRegistry.hasUnfinalizedTasks.mockImplementation(() => {
      if (keepBackgroundTaskOpen && !lateMonitorEventEmitted) {
        lateMonitorEventEmitted = true;
        monitorNotificationCallback?.(
          'Monitor "logs" event #2: still running',
          secondNotificationXml,
          {
            monitorId: 'mon_1',
            toolUseId: 'tool_mon_1',
            status: 'running',
            eventCount: 2,
          },
        );
      }
      return keepBackgroundTaskOpen;
    });

    const firstNotificationXml =
      '<task-notification>\n' +
      '<task-id>mon_1</task-id>\n' +
      '<kind>monitor</kind>\n' +
      '<status>running</status>\n' +
      '<summary>Monitor emitted event #1.</summary>\n' +
      '<result>ready</result>\n' +
      '</task-notification>';
    const secondNotificationXml =
      '<task-notification>\n' +
      '<task-id>mon_1</task-id>\n' +
      '<kind>monitor</kind>\n' +
      '<status>running</status>\n' +
      '<summary>Monitor emitted event #2.</summary>\n' +
      '<result>still running</result>\n' +
      '</task-notification>';
    const cancelledXml =
      '<task-notification>\n' +
      '<task-id>mon_1</task-id>\n' +
      '<kind>monitor</kind>\n' +
      '<status>cancelled</status>\n' +
      '<summary>Monitor was cancelled.</summary>\n' +
      '</task-notification>';

    let monitorNotificationCallback:
      | ((
          displayText: string,
          modelText: string,
          meta: {
            monitorId: string;
            toolUseId?: string;
            status: 'running' | 'completed' | 'failed' | 'cancelled';
            eventCount: number;
          },
        ) => void)
      | undefined;

    mockMonitorRegistry.setNotificationCallback.mockImplementation((cb) => {
      monitorNotificationCallback = cb ?? undefined;
      if (!cb) {
        return;
      }
      cb('Monitor "logs" event #1: ready', firstNotificationXml, {
        monitorId: 'mon_1',
        toolUseId: 'tool_mon_1',
        status: 'running',
        eventCount: 1,
      });
    });
    mockMonitorRegistry.abortAll.mockImplementation(() => {
      monitorNotificationCallback?.(
        'Monitor "logs" was cancelled.',
        cancelledXml,
        {
          monitorId: 'mon_1',
          toolUseId: 'tool_mon_1',
          status: 'cancelled',
          eventCount: 2,
        },
      );
    });

    mockGeminiClient.sendMessageStream
      .mockReturnValueOnce(
        createStreamFromEvents([
          { type: GeminiEventType.Content, value: 'Monitor launched.' },
          {
            type: GeminiEventType.Finished,
            value: {
              reason: undefined,
              usageMetadata: { totalTokenCount: 2 },
            },
          },
        ]),
      )
      .mockReturnValueOnce(
        createStreamFromEvents([
          { type: GeminiEventType.Content, value: 'Observed.' },
          {
            type: GeminiEventType.Finished,
            value: {
              reason: undefined,
              usageMetadata: { totalTokenCount: 1 },
            },
          },
        ]),
      );

    const runPromise = runNonInteractive(
      mockConfig,
      mockSettings,
      'Watch the logs',
      'prompt-monitor-late-sdk',
    );

    await vi.waitFor(() => {
      const envelopes = writes
        .join('')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line));
      const monitorNotifications = envelopes.filter(
        (env) =>
          env.type === 'system' &&
          env.subtype === 'task_notification' &&
          env.data?.task_id === 'mon_1',
      );

      expect(
        monitorNotifications.filter((env) => env.data?.status === 'running'),
      ).toHaveLength(2);
      expect(envelopes.some((env) => env.type === 'result')).toBe(false);
    });

    keepBackgroundTaskOpen = false;
    await runPromise;

    const envelopes = writes
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
    expect(envelopes.at(-1)).toMatchObject({
      type: 'result',
      is_error: false,
    });
  });

  it('should include usage metadata and API duration in stream-json result', async () => {
    (mockConfig.getOutputFormat as Mock).mockReturnValue('stream-json');
    (mockConfig.getIncludePartialMessages as Mock).mockReturnValue(false);
    setupMetricsMock({
      models: {
        'test-model': {
          api: {
            totalRequests: 1,
            totalErrors: 0,
            totalLatencyMs: 500,
          },
          tokens: {
            prompt: 11,
            candidates: 5,
            total: 16,
            cached: 3,
            thoughts: 0,
          },
          bySource: {},
        },
      },
    });

    const writes: string[] = [];
    processStdoutSpy.mockImplementation((chunk: string | Uint8Array) => {
      if (typeof chunk === 'string') {
        writes.push(chunk);
      } else {
        writes.push(Buffer.from(chunk).toString('utf8'));
      }
      return true;
    });

    const nowSpy = vi.spyOn(Date, 'now');
    let current = 0;
    nowSpy.mockImplementation(() => {
      current += 500;
      return current;
    });

    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents([
        { type: GeminiEventType.Content, value: 'All done' },
      ]),
    );

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'usage test',
      'prompt-usage',
    );

    const envelopes = writes
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
    const resultEnvelope = envelopes.at(-1);
    expect(resultEnvelope?.type).toBe('result');
    expect(resultEnvelope?.duration_api_ms).toBeGreaterThan(0);
    expect(resultEnvelope?.usage).toEqual({
      input_tokens: 11,
      output_tokens: 5,
      total_tokens: 16,
      cache_read_input_tokens: 3,
    });

    nowSpy.mockRestore();
  });

  it('should not emit user message when userMessage option is provided (stream-json input binding)', async () => {
    (mockConfig.getOutputFormat as Mock).mockReturnValue('stream-json');
    (mockConfig.getIncludePartialMessages as Mock).mockReturnValue(false);
    setupMetricsMock();

    const writes: string[] = [];
    processStdoutSpy.mockImplementation((chunk: string | Uint8Array) => {
      if (typeof chunk === 'string') {
        writes.push(chunk);
      } else {
        writes.push(Buffer.from(chunk).toString('utf8'));
      }
      return true;
    });

    const events: ServerGeminiStreamEvent[] = [
      { type: GeminiEventType.Content, value: 'Response from envelope' },
      {
        type: GeminiEventType.Finished,
        value: { reason: undefined, usageMetadata: { totalTokenCount: 5 } },
      },
    ];
    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents(events),
    );

    const userMessage: CLIUserMessage = {
      type: 'user',
      uuid: 'test-uuid',
      session_id: 'test-session',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Message from stream-json input',
          },
        ],
      },
    };

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'ignored input',
      'prompt-envelope',
      {
        userMessage,
      },
    );

    const envelopes = writes
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));

    // Should NOT emit user message since it came from userMessage option
    const userEnvelopes = envelopes.filter((env) => env.type === 'user');
    expect(userEnvelopes).toHaveLength(0);

    // Should emit assistant message
    const assistantEnvelope = envelopes.find((env) => env.type === 'assistant');
    expect(assistantEnvelope).toBeTruthy();

    // Verify the model received the correct parts from userMessage
    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledWith(
      [{ text: 'Message from stream-json input' }],
      expect.any(AbortSignal),
      'prompt-envelope',
      { type: SendMessageType.UserQuery },
    );
  });

  it('should emit tool results as user messages in stream-json format', async () => {
    (mockConfig.getOutputFormat as Mock).mockReturnValue('stream-json');
    (mockConfig.getIncludePartialMessages as Mock).mockReturnValue(false);
    setupMetricsMock();

    const writes: string[] = [];
    processStdoutSpy.mockImplementation((chunk: string | Uint8Array) => {
      if (typeof chunk === 'string') {
        writes.push(chunk);
      } else {
        writes.push(Buffer.from(chunk).toString('utf8'));
      }
      return true;
    });

    const toolCallEvent: ServerGeminiStreamEvent = {
      type: GeminiEventType.ToolCallRequest,
      value: {
        callId: 'tool-1',
        name: 'testTool',
        args: { arg1: 'value1' },
        isClientInitiated: false,
        prompt_id: 'prompt-id-tool',
      },
    };
    const toolResponse: Part[] = [
      {
        functionResponse: {
          name: 'testTool',
          response: { output: 'Tool executed successfully' },
        },
      },
    ];
    mockCoreExecuteToolCall.mockResolvedValue({ responseParts: toolResponse });

    const firstCallEvents: ServerGeminiStreamEvent[] = [toolCallEvent];
    const secondCallEvents: ServerGeminiStreamEvent[] = [
      { type: GeminiEventType.Content, value: 'Final response' },
      {
        type: GeminiEventType.Finished,
        value: { reason: undefined, usageMetadata: { totalTokenCount: 10 } },
      },
    ];

    mockGeminiClient.sendMessageStream
      .mockReturnValueOnce(createStreamFromEvents(firstCallEvents))
      .mockReturnValueOnce(createStreamFromEvents(secondCallEvents));

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'Use tool',
      'prompt-id-tool',
    );

    const envelopes = writes
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));

    // Should have tool use in assistant message
    const assistantEnvelope = envelopes.find((env) => env.type === 'assistant');
    expect(assistantEnvelope).toBeTruthy();
    const toolUseBlock = assistantEnvelope?.message?.content?.find(
      (block: unknown) =>
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        block.type === 'tool_use',
    );
    expect(toolUseBlock).toBeTruthy();
    expect(toolUseBlock?.name).toBe('testTool');

    // Should have tool result as user message
    const toolResultUserMessages = envelopes.filter(
      (env) =>
        env.type === 'user' &&
        Array.isArray(env.message?.content) &&
        env.message.content.some(
          (block: unknown) =>
            typeof block === 'object' &&
            block !== null &&
            'type' in block &&
            block.type === 'tool_result',
        ),
    );
    expect(toolResultUserMessages).toHaveLength(1);
    const toolResultBlock = toolResultUserMessages[0]?.message?.content?.find(
      (block: unknown) =>
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        block.type === 'tool_result',
    );
    expect(toolResultBlock?.tool_use_id).toBe('tool-1');
    expect(toolResultBlock?.is_error).toBe(false);
    expect(toolResultBlock?.content).toBe('Tool executed successfully');
  });

  it('should emit tool errors in tool_result blocks in stream-json format', async () => {
    (mockConfig.getOutputFormat as Mock).mockReturnValue('stream-json');
    (mockConfig.getIncludePartialMessages as Mock).mockReturnValue(false);
    setupMetricsMock();

    const writes: string[] = [];
    processStdoutSpy.mockImplementation((chunk: string | Uint8Array) => {
      if (typeof chunk === 'string') {
        writes.push(chunk);
      } else {
        writes.push(Buffer.from(chunk).toString('utf8'));
      }
      return true;
    });

    const toolCallEvent: ServerGeminiStreamEvent = {
      type: GeminiEventType.ToolCallRequest,
      value: {
        callId: 'tool-error',
        name: 'errorTool',
        args: {},
        isClientInitiated: false,
        prompt_id: 'prompt-id-error',
      },
    };
    mockCoreExecuteToolCall.mockResolvedValue({
      error: new Error('Tool execution failed'),
      errorType: ToolErrorType.EXECUTION_FAILED,
      responseParts: [
        {
          functionResponse: {
            name: 'errorTool',
            response: {
              output: 'Error: Tool execution failed',
            },
          },
        },
      ],
      resultDisplay: 'Tool execution failed',
    });

    const finalResponse: ServerGeminiStreamEvent[] = [
      {
        type: GeminiEventType.Content,
        value: 'I encountered an error',
      },
      {
        type: GeminiEventType.Finished,
        value: { reason: undefined, usageMetadata: { totalTokenCount: 10 } },
      },
    ];
    mockGeminiClient.sendMessageStream
      .mockReturnValueOnce(createStreamFromEvents([toolCallEvent]))
      .mockReturnValueOnce(createStreamFromEvents(finalResponse));

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'Trigger error',
      'prompt-id-error',
    );

    const envelopes = writes
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));

    // Tool errors are now captured in tool_result blocks with is_error=true,
    // not as separate system messages (see comment in nonInteractiveCli.ts line 307-309)
    const toolResultMessages = envelopes.filter(
      (env) =>
        env.type === 'user' &&
        Array.isArray(env.message?.content) &&
        env.message.content.some(
          (block: unknown) =>
            typeof block === 'object' &&
            block !== null &&
            'type' in block &&
            block.type === 'tool_result',
        ),
    );
    expect(toolResultMessages.length).toBeGreaterThan(0);
    const toolResultBlock = toolResultMessages[0]?.message?.content?.find(
      (block: unknown) =>
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        block.type === 'tool_result',
    );
    expect(toolResultBlock?.tool_use_id).toBe('tool-error');
    expect(toolResultBlock?.is_error).toBe(true);
  });

  it('should emit partial messages when includePartialMessages is true', async () => {
    (mockConfig.getOutputFormat as Mock).mockReturnValue('stream-json');
    (mockConfig.getIncludePartialMessages as Mock).mockReturnValue(true);
    setupMetricsMock();

    const writes: string[] = [];
    processStdoutSpy.mockImplementation((chunk: string | Uint8Array) => {
      if (typeof chunk === 'string') {
        writes.push(chunk);
      } else {
        writes.push(Buffer.from(chunk).toString('utf8'));
      }
      return true;
    });

    const events: ServerGeminiStreamEvent[] = [
      { type: GeminiEventType.Content, value: 'Hello' },
      { type: GeminiEventType.Content, value: ' World' },
      {
        type: GeminiEventType.Finished,
        value: { reason: undefined, usageMetadata: { totalTokenCount: 5 } },
      },
    ];
    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents(events),
    );

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'Stream test',
      'prompt-partial',
    );

    const envelopes = writes
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));

    // Should have stream events for partial messages
    const streamEvents = envelopes.filter((env) => env.type === 'stream_event');
    expect(streamEvents.length).toBeGreaterThan(0);

    // Should have message_start event
    const messageStart = streamEvents.find(
      (ev) => ev.event?.type === 'message_start',
    );
    expect(messageStart).toBeTruthy();

    // Should have content_block_delta events for incremental text
    const textDeltas = streamEvents.filter(
      (ev) => ev.event?.type === 'content_block_delta',
    );
    expect(textDeltas.length).toBeGreaterThan(0);
  });

  it('should handle thinking blocks in stream-json format', async () => {
    (mockConfig.getOutputFormat as Mock).mockReturnValue('stream-json');
    (mockConfig.getIncludePartialMessages as Mock).mockReturnValue(false);
    setupMetricsMock();

    const writes: string[] = [];
    processStdoutSpy.mockImplementation((chunk: string | Uint8Array) => {
      if (typeof chunk === 'string') {
        writes.push(chunk);
      } else {
        writes.push(Buffer.from(chunk).toString('utf8'));
      }
      return true;
    });

    const events: ServerGeminiStreamEvent[] = [
      {
        type: GeminiEventType.Thought,
        value: { subject: 'Analysis', description: 'Processing request' },
      },
      { type: GeminiEventType.Content, value: 'Response text' },
      {
        type: GeminiEventType.Finished,
        value: { reason: undefined, usageMetadata: { totalTokenCount: 8 } },
      },
    ];
    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents(events),
    );

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'Thinking test',
      'prompt-thinking',
    );

    const envelopes = writes
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));

    const assistantEnvelope = envelopes.find((env) => env.type === 'assistant');
    expect(assistantEnvelope).toBeTruthy();

    const thinkingBlock = assistantEnvelope?.message?.content?.find(
      (block: unknown) =>
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        block.type === 'thinking',
    );
    expect(thinkingBlock).toBeTruthy();
    expect(thinkingBlock?.signature).toBe('Analysis');
    expect(thinkingBlock?.thinking).toContain('Processing request');
  });

  it('should handle multiple tool calls in stream-json format', async () => {
    (mockConfig.getOutputFormat as Mock).mockReturnValue('stream-json');
    (mockConfig.getIncludePartialMessages as Mock).mockReturnValue(false);
    setupMetricsMock();

    const writes: string[] = [];
    processStdoutSpy.mockImplementation((chunk: string | Uint8Array) => {
      if (typeof chunk === 'string') {
        writes.push(chunk);
      } else {
        writes.push(Buffer.from(chunk).toString('utf8'));
      }
      return true;
    });

    const toolCall1: ServerGeminiStreamEvent = {
      type: GeminiEventType.ToolCallRequest,
      value: {
        callId: 'tool-1',
        name: 'firstTool',
        args: { param: 'value1' },
        isClientInitiated: false,
        prompt_id: 'prompt-id-multi',
      },
    };
    const toolCall2: ServerGeminiStreamEvent = {
      type: GeminiEventType.ToolCallRequest,
      value: {
        callId: 'tool-2',
        name: 'secondTool',
        args: { param: 'value2' },
        isClientInitiated: false,
        prompt_id: 'prompt-id-multi',
      },
    };

    mockCoreExecuteToolCall
      .mockResolvedValueOnce({
        responseParts: [{ text: 'First tool result' }],
      })
      .mockResolvedValueOnce({
        responseParts: [{ text: 'Second tool result' }],
      });

    const firstCallEvents: ServerGeminiStreamEvent[] = [toolCall1, toolCall2];
    const secondCallEvents: ServerGeminiStreamEvent[] = [
      { type: GeminiEventType.Content, value: 'Combined response' },
      {
        type: GeminiEventType.Finished,
        value: { reason: undefined, usageMetadata: { totalTokenCount: 15 } },
      },
    ];

    mockGeminiClient.sendMessageStream
      .mockReturnValueOnce(createStreamFromEvents(firstCallEvents))
      .mockReturnValueOnce(createStreamFromEvents(secondCallEvents));

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'Multiple tools',
      'prompt-id-multi',
    );

    const envelopes = writes
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));

    // Should have assistant message with both tool uses
    const assistantEnvelope = envelopes.find((env) => env.type === 'assistant');
    expect(assistantEnvelope).toBeTruthy();
    const toolUseBlocks = assistantEnvelope?.message?.content?.filter(
      (block: unknown) =>
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        block.type === 'tool_use',
    );
    expect(toolUseBlocks?.length).toBe(2);
    const toolNames = (toolUseBlocks ?? []).map((b: unknown) => {
      if (
        typeof b === 'object' &&
        b !== null &&
        'name' in b &&
        typeof (b as { name: unknown }).name === 'string'
      ) {
        return (b as { name: string }).name;
      }
      return '';
    });
    expect(toolNames).toContain('firstTool');
    expect(toolNames).toContain('secondTool');

    // Should have two tool result user messages
    const toolResultMessages = envelopes.filter(
      (env) =>
        env.type === 'user' &&
        Array.isArray(env.message?.content) &&
        env.message.content.some(
          (block: unknown) =>
            typeof block === 'object' &&
            block !== null &&
            'type' in block &&
            block.type === 'tool_result',
        ),
    );
    expect(toolResultMessages.length).toBe(2);
  });

  it('should execute only the first duplicate tool call id in stream-json format', async () => {
    (mockConfig.getOutputFormat as Mock).mockReturnValue('stream-json');
    (mockConfig.getIncludePartialMessages as Mock).mockReturnValue(false);
    setupMetricsMock();
    const writes: string[] = [];
    processStdoutSpy.mockImplementation((chunk: string | Uint8Array) => {
      writes.push(
        typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'),
      );
      return true;
    });

    const duplicateToolCall: ServerGeminiStreamEvent = {
      type: GeminiEventType.ToolCallRequest,
      value: {
        callId: 'dup_id_0001',
        name: 'read_file',
        args: { file_path: 'a.ts' },
        isClientInitiated: false,
        prompt_id: 'prompt-id-dup',
      },
    };
    const replayedToolCall: ServerGeminiStreamEvent = {
      type: GeminiEventType.ToolCallRequest,
      value: {
        callId: 'dup_id_0001',
        name: 'read_file',
        args: { file_path: 'b.ts' },
        isClientInitiated: false,
        prompt_id: 'prompt-id-dup',
      },
    };

    mockCoreExecuteToolCall.mockResolvedValue({
      responseParts: [
        {
          functionResponse: {
            id: 'dup_id_0001',
            name: 'read_file',
            response: { output: 'first' },
          },
        },
      ],
    });
    mockGeminiClient.sendMessageStream
      .mockReturnValueOnce(
        createStreamFromEvents([duplicateToolCall, replayedToolCall]),
      )
      .mockReturnValueOnce(
        createStreamFromEvents([
          { type: GeminiEventType.Content, value: 'done' },
          {
            type: GeminiEventType.Finished,
            value: {
              reason: undefined,
              usageMetadata: { totalTokenCount: 1 },
            },
          },
        ]),
      );

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'Duplicate tool',
      'prompt-id-dup',
    );

    expect(mockCoreExecuteToolCall).toHaveBeenCalledOnce();
    expect(mockCoreExecuteToolCall).toHaveBeenCalledWith(
      mockConfig,
      expect.objectContaining({
        callId: 'dup_id_0001',
        args: { file_path: 'a.ts' },
      }),
      expect.any(AbortSignal),
      expect.any(Object),
    );

    const toolResultParts = mockGeminiClient.sendMessageStream.mock.calls[1][0];
    expect(toolResultParts).toHaveLength(2);
    expect(toolResultParts[0].functionResponse?.response?.['output']).toBe(
      'first',
    );
    expect(toolResultParts[1].functionResponse?.id).toBe('dup_id_0001');
    expect(toolResultParts[1].functionResponse?.response?.['error']).toContain(
      'Duplicate provider tool call id "dup_id_0001"',
    );

    const envelopes = writes
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
    const toolResultMessages = envelopes.filter(
      (env) =>
        env.type === 'user' &&
        Array.isArray(env.message?.content) &&
        env.message.content.some(
          (block: unknown) =>
            typeof block === 'object' &&
            block !== null &&
            'type' in block &&
            block.type === 'tool_result',
        ),
    );
    expect(toolResultMessages).toHaveLength(2);
  });

  it('should execute every tool call with an empty call id in stream-json format', async () => {
    (mockConfig.getOutputFormat as Mock).mockReturnValue('stream-json');
    (mockConfig.getIncludePartialMessages as Mock).mockReturnValue(false);
    setupMetricsMock();

    const firstToolCall: ServerGeminiStreamEvent = {
      type: GeminiEventType.ToolCallRequest,
      value: {
        callId: '',
        name: 'read_file',
        args: { file_path: 'a.ts' },
        isClientInitiated: false,
        prompt_id: 'prompt-id-empty',
      },
    };
    const secondToolCall: ServerGeminiStreamEvent = {
      type: GeminiEventType.ToolCallRequest,
      value: {
        callId: '',
        name: 'read_file',
        args: { file_path: 'b.ts' },
        isClientInitiated: false,
        prompt_id: 'prompt-id-empty',
      },
    };

    mockCoreExecuteToolCall.mockResolvedValue({
      responseParts: [
        {
          functionResponse: {
            id: '',
            name: 'read_file',
            response: { output: 'ok' },
          },
        },
      ],
    });
    mockGeminiClient.sendMessageStream
      .mockReturnValueOnce(
        createStreamFromEvents([firstToolCall, secondToolCall]),
      )
      .mockReturnValueOnce(
        createStreamFromEvents([
          { type: GeminiEventType.Content, value: 'done' },
          {
            type: GeminiEventType.Finished,
            value: {
              reason: undefined,
              usageMetadata: { totalTokenCount: 1 },
            },
          },
        ]),
      );

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'Empty id tools',
      'prompt-id-empty',
    );

    expect(mockCoreExecuteToolCall).toHaveBeenCalledTimes(2);
    expect(mockCoreExecuteToolCall).toHaveBeenNthCalledWith(
      1,
      mockConfig,
      expect.objectContaining({
        callId: '',
        args: { file_path: 'a.ts' },
      }),
      expect.any(AbortSignal),
      expect.any(Object),
    );
    expect(mockCoreExecuteToolCall).toHaveBeenNthCalledWith(
      2,
      mockConfig,
      expect.objectContaining({
        callId: '',
        args: { file_path: 'b.ts' },
      }),
      expect.any(AbortSignal),
      expect.any(Object),
    );
  });

  it('should handle userMessage with text content blocks in stream-json input mode', async () => {
    (mockConfig.getOutputFormat as Mock).mockReturnValue('stream-json');
    (mockConfig.getIncludePartialMessages as Mock).mockReturnValue(false);
    setupMetricsMock();

    const writes: string[] = [];
    processStdoutSpy.mockImplementation((chunk: string | Uint8Array) => {
      if (typeof chunk === 'string') {
        writes.push(chunk);
      } else {
        writes.push(Buffer.from(chunk).toString('utf8'));
      }
      return true;
    });

    const events: ServerGeminiStreamEvent[] = [
      { type: GeminiEventType.Content, value: 'Response' },
      {
        type: GeminiEventType.Finished,
        value: { reason: undefined, usageMetadata: { totalTokenCount: 3 } },
      },
    ];
    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents(events),
    );

    // UserMessage with string content
    const userMessageString: CLIUserMessage = {
      type: 'user',
      uuid: 'test-uuid-1',
      session_id: 'test-session',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: 'Simple string content',
      },
    };

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'ignored',
      'prompt-string-content',
      {
        userMessage: userMessageString,
      },
    );

    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledWith(
      [{ text: 'Simple string content' }],
      expect.any(AbortSignal),
      'prompt-string-content',
      { type: SendMessageType.UserQuery },
    );

    // UserMessage with array of text blocks
    mockGeminiClient.sendMessageStream.mockClear();
    const userMessageBlocks: CLIUserMessage = {
      type: 'user',
      uuid: 'test-uuid-2',
      session_id: 'test-session',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'First part' },
          { type: 'text', text: 'Second part' },
        ],
      },
    };

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'ignored',
      'prompt-blocks-content',
      {
        userMessage: userMessageBlocks,
      },
    );

    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledWith(
      [{ text: 'First part' }, { text: 'Second part' }],
      expect.any(AbortSignal),
      'prompt-blocks-content',
      { type: SendMessageType.UserQuery },
    );
  });

  it('installs a skipDurableFire predicate that classifies loop.md sentinels in headless mode', async () => {
    // Locks the wiring at the scheduler-enable site: runNonInteractive must
    // hand the scheduler a predicate that skips durable loop.md sentinels
    // (which a headless run can't expand), while still letting non-sentinel
    // durable jobs fire. Both halves are covered alone — detectLoopSentinel via
    // skipHeadlessLoopSentinel above, the filter via cronScheduler tests — but
    // nothing pins that runNonInteractive actually connects them. A refactor
    // dropping or rewriting this call would otherwise silently fire raw
    // `<<loop.md>>` sentinels at the model (or skip real durable jobs), uncaught.
    setupMetricsMock();
    // Real scheduler with no projectRoot: enableDurable() short-circuits (no
    // filesystem/lock work) and, with no jobs, the headless cron hold-open
    // resolves immediately, so runNonInteractive returns without hanging.
    const scheduler = new CronScheduler();
    const skipSpy = vi.spyOn(scheduler, 'setSkipDurableFire');
    mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
    mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents([
        { type: GeminiEventType.Content, value: 'ok' },
        {
          type: GeminiEventType.Finished,
          value: { reason: undefined, usageMetadata: { totalTokenCount: 1 } },
        },
      ]),
    );

    await runNonInteractive(mockConfig, mockSettings, 'test', 'p-cron-wiring');

    expect(skipSpy).toHaveBeenCalledOnce();
    const predicate = skipSpy.mock.calls[0][0];
    expect(predicate({ prompt: LOOP_SENTINEL_CRON } as CronJob)).toBe(true);
    expect(predicate({ prompt: LOOP_SENTINEL_DYNAMIC } as CronJob)).toBe(true);
    expect(predicate({ prompt: AUTONOMOUS_SENTINEL_CRON } as CronJob)).toBe(
      true,
    );
    expect(predicate({ prompt: AUTONOMOUS_SENTINEL_DYNAMIC } as CronJob)).toBe(
      true,
    );
    expect(predicate({ prompt: 'regular cron job' } as CronJob)).toBe(false);
  });

  describe('--json-schema structured output', () => {
    // Helper: walk an emitted event and extract the first tool_use_id when
    // it represents a tool_result block. Returns undefined for any other
    // event shape.
    const extractToolResultId = (event: unknown): string | undefined => {
      if (typeof event !== 'object' || event === null) return undefined;
      const e = event as {
        type?: unknown;
        message?: { content?: unknown };
      };
      if (e.type !== 'user') return undefined;
      const content = e.message?.content;
      if (!Array.isArray(content) || content.length === 0) return undefined;
      const block = content[0] as { type?: unknown; tool_use_id?: unknown };
      if (block?.type !== 'tool_result') return undefined;
      return typeof block.tool_use_id === 'string'
        ? block.tool_use_id
        : undefined;
    };

    it('stops executing remaining tool calls from the same turn once structured_output succeeds', async () => {
      (mockConfig.getJsonSchema as Mock).mockReturnValue({
        type: 'object',
        properties: { summary: { type: 'string' } },
      });
      (mockConfig.getOutputFormat as Mock).mockReturnValue(OutputFormat.JSON);
      setupMetricsMock();

      // Spy on the registry returned by getBackgroundTaskRegistry so we can
      // assert abortAll() is called as part of the deterministic shutdown
      // contract for structured-output mode.
      const abortAllSpy = vi.fn();
      (mockConfig.getBackgroundTaskRegistry as Mock).mockReturnValue({
        setNotificationCallback: vi.fn(),
        setRegisterCallback: vi.fn(),
        getAll: vi.fn().mockReturnValue([]),
        hasUnfinalizedTasks: vi.fn().mockReturnValue(false),
        abortAll: abortAllSpy,
      });

      const writes: string[] = [];
      processStdoutSpy.mockImplementation((chunk: string | Uint8Array) => {
        writes.push(
          typeof chunk === 'string'
            ? chunk
            : Buffer.from(chunk).toString('utf8'),
        );
        return true;
      });

      // Same turn: the model emits structured_output FIRST, then a second
      // (hypothetical side-effecting) tool. The break must prevent the
      // second tool from running.
      const structuredArgs = { summary: 'done' };
      const structuredCall: ServerGeminiStreamEvent = {
        type: GeminiEventType.ToolCallRequest,
        value: {
          callId: 'tool-structured',
          name: 'structured_output',
          args: structuredArgs,
          isClientInitiated: false,
          prompt_id: 'prompt-id-structured',
        },
      };
      const trailingCall: ServerGeminiStreamEvent = {
        type: GeminiEventType.ToolCallRequest,
        value: {
          callId: 'tool-trailing',
          name: 'side_effect_tool',
          args: {},
          isClientInitiated: false,
          prompt_id: 'prompt-id-structured',
        },
      };

      mockCoreExecuteToolCall.mockResolvedValue({
        responseParts: [{ text: 'ok' }],
      });

      mockGeminiClient.sendMessageStream.mockReturnValueOnce(
        createStreamFromEvents([structuredCall, trailingCall]),
      );

      await runNonInteractive(
        mockConfig,
        mockSettings,
        'Emit structured output',
        'prompt-id-structured',
      );

      // Only structured_output should have been executed. The trailing tool
      // should have been skipped because structured output ended the session.
      expect(mockCoreExecuteToolCall).toHaveBeenCalledTimes(1);
      const firstCallArg = mockCoreExecuteToolCall.mock.calls[0][1] as {
        name: string;
      };
      expect(firstCallArg.name).toBe('structured_output');

      // And we should not have sent a second follow-up turn.
      expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledTimes(1);

      // abortAll() must be called so any in-flight background agents are
      // torn down before we emit the terminal result.
      expect(abortAllSpy).toHaveBeenCalledTimes(1);

      const events = writes
        .join('')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line))
        .flat();

      // The emitted result must carry the submitted args under `result` as
      // the JSON-stringified payload (the headless JSON formatter encodes
      // the structured submission so SDK consumers always see a string here,
      // matching how text-mode `result` is also a string).
      const result = events.find(
        (m: unknown) =>
          typeof m === 'object' &&
          m !== null &&
          (m as { type?: string }).type === 'result',
      );
      expect(result).toBeDefined();
      expect(result.is_error).toBe(false);
      expect(typeof result.result).toBe('string');
      expect(JSON.parse(result.result)).toEqual(structuredArgs);
      // The raw object is also exposed under `structured_result` for SDK
      // consumers that don't want to re-parse the stringified payload.
      expect(result.structured_result).toEqual(structuredArgs);

      // The suppressed trailing tool_use must have a synthesised
      // tool_result so the event log pairs every tool_use with a
      // tool_result, even on the success path.
      const trailingToolResult = events.find(
        (m: unknown) => extractToolResultId(m) === 'tool-trailing',
      );
      expect(trailingToolResult).toBeDefined();
    });

    it('skips side-effecting tool calls that precede structured_output in the same turn', async () => {
      (mockConfig.getJsonSchema as Mock).mockReturnValue({
        type: 'object',
        properties: { summary: { type: 'string' } },
      });
      (mockConfig.getOutputFormat as Mock).mockReturnValue(OutputFormat.JSON);
      setupMetricsMock();

      const abortAllSpy = vi.fn();
      (mockConfig.getBackgroundTaskRegistry as Mock).mockReturnValue({
        setNotificationCallback: vi.fn(),
        setRegisterCallback: vi.fn(),
        getAll: vi.fn().mockReturnValue([]),
        hasUnfinalizedTasks: vi.fn().mockReturnValue(false),
        abortAll: abortAllSpy,
      });

      const writes: string[] = [];
      processStdoutSpy.mockImplementation((chunk: string | Uint8Array) => {
        writes.push(
          typeof chunk === 'string'
            ? chunk
            : Buffer.from(chunk).toString('utf8'),
        );
        return true;
      });

      // Same turn, reverse order: a side-effecting tool comes BEFORE
      // structured_output. The pre-scan must drop the leading call so the
      // side effect never runs — accepting the structured result while
      // having already executed write_file would violate the "structured
      // output is the terminal contract" guarantee.
      const structuredArgs = { summary: 'done' };
      const leadingCall: ServerGeminiStreamEvent = {
        type: GeminiEventType.ToolCallRequest,
        value: {
          callId: 'tool-structured',
          name: 'side_effect_tool',
          args: { path: '/tmp/should-not-write' },
          isClientInitiated: false,
          prompt_id: 'prompt-id-leading',
        },
      };
      const structuredCall: ServerGeminiStreamEvent = {
        type: GeminiEventType.ToolCallRequest,
        value: {
          callId: 'tool-structured',
          name: 'structured_output',
          args: structuredArgs,
          isClientInitiated: false,
          prompt_id: 'prompt-id-leading',
        },
      };

      mockCoreExecuteToolCall.mockResolvedValue({
        responseParts: [{ text: 'ok' }],
      });

      mockGeminiClient.sendMessageStream.mockReturnValueOnce(
        createStreamFromEvents([leadingCall, structuredCall]),
      );

      await runNonInteractive(
        mockConfig,
        mockSettings,
        'Emit structured output',
        'prompt-id-leading',
      );

      // Only the structured_output call should have been executed; the
      // leading side-effect tool must have been suppressed by the pre-scan.
      expect(mockCoreExecuteToolCall).toHaveBeenCalledTimes(1);
      const onlyCallArg = mockCoreExecuteToolCall.mock.calls[0][1] as {
        name: string;
      };
      expect(onlyCallArg.name).toBe('structured_output');
      // No follow-up turn should have been issued.
      expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledTimes(1);
      expect(abortAllSpy).toHaveBeenCalledTimes(1);

      const events = writes
        .join('')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line))
        .flat();
      const result = events.find(
        (m: unknown) =>
          typeof m === 'object' &&
          m !== null &&
          (m as { type?: string }).type === 'result',
      );
      expect(result).toBeDefined();
      expect(result.is_error).toBe(false);
      expect(result.structured_result).toEqual(structuredArgs);

      // The suppressed leading tool_use must have a synthesised
      // tool_result event so the event log pairs every tool_use with a
      // tool_result on the success path.
      const leadingToolResult = events.find((m: unknown) => {
        if (extractToolResultId(m) !== 'tool-structured') {
          return false;
        }
        const content = (
          m as {
            message?: { content?: Array<{ content?: string }> };
          }
        )?.message?.content?.[0]?.content;
        return typeof content === 'string' && content.includes('Skipped:');
      });
      expect(leadingToolResult).toBeDefined();
      // On the success path, the synthesised "Skipped" message must NOT
      // include the trailing "Re-issue this call in a separate turn"
      // advice — the session terminates immediately so neither the model
      // nor any SDK consumer can act on it. Keeps the success-path event
      // stream clean and avoids contradictory guidance ("re-issue" + the
      // run already exited).
      const leadingContent = (
        leadingToolResult as {
          message?: { content?: Array<{ content?: string }> };
        }
      )?.message?.content?.[0]?.content;
      expect(leadingContent).toMatch(/Skipped:/);
      expect(leadingContent).not.toMatch(/Re-issue this call/);
    });

    it('tries multiple structured_output calls in the same turn until one succeeds', async () => {
      // Same-turn batch: [structured_output(bad), structured_output(good)].
      // The first fails validation; the second has valid args and should
      // be tried in-order, ending the session without an extra turn —
      // rather than the older behaviour of only attempting the first
      // structured_output and forcing a retry.
      (mockConfig.getJsonSchema as Mock).mockReturnValue({
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
      });
      (mockConfig.getOutputFormat as Mock).mockReturnValue(OutputFormat.JSON);
      setupMetricsMock();

      const abortAllSpy = vi.fn();
      (mockConfig.getBackgroundTaskRegistry as Mock).mockReturnValue({
        setNotificationCallback: vi.fn(),
        setRegisterCallback: vi.fn(),
        getAll: vi.fn().mockReturnValue([]),
        hasUnfinalizedTasks: vi.fn().mockReturnValue(false),
        abortAll: abortAllSpy,
      });

      const writes: string[] = [];
      processStdoutSpy.mockImplementation((chunk: string | Uint8Array) => {
        writes.push(
          typeof chunk === 'string'
            ? chunk
            : Buffer.from(chunk).toString('utf8'),
        );
        return true;
      });

      const goodArgs = { summary: 'ok' };
      const badStructured: ServerGeminiStreamEvent = {
        type: GeminiEventType.ToolCallRequest,
        value: {
          callId: 'tool-structured-bad',
          name: 'structured_output',
          args: { wrong: 'shape' },
          isClientInitiated: false,
          prompt_id: 'prompt-id-multi-struct',
        },
      };
      const goodStructured: ServerGeminiStreamEvent = {
        type: GeminiEventType.ToolCallRequest,
        value: {
          callId: 'tool-structured-good',
          name: 'structured_output',
          args: goodArgs,
          isClientInitiated: false,
          prompt_id: 'prompt-id-multi-struct',
        },
      };

      mockGeminiClient.sendMessageStream.mockReturnValueOnce(
        createStreamFromEvents([badStructured, goodStructured]),
      );

      // First structured_output returns a tool-execution error (bad args);
      // second one returns clean responseParts so the session can capture.
      mockCoreExecuteToolCall
        .mockResolvedValueOnce({
          error: new Error('args invalid'),
          errorType: 'TOOL_INVALID_ARGUMENTS',
          responseParts: [
            {
              functionResponse: {
                id: 'tool-structured-bad',
                name: 'structured_output',
                response: { error: 'args invalid' },
              },
            },
          ],
        })
        .mockResolvedValueOnce({
          responseParts: [{ text: 'ok' }],
        });

      await runNonInteractive(
        mockConfig,
        mockSettings,
        'Emit structured output',
        'prompt-id-multi-struct',
      );

      // Both structured_output calls must have been attempted in original
      // order; the loop stops at the first success so no third execution.
      const executedNames = mockCoreExecuteToolCall.mock.calls.map(
        (call) => (call[1] as { name: string; callId: string }).name,
      );
      const executedIds = mockCoreExecuteToolCall.mock.calls.map(
        (call) => (call[1] as { name: string; callId: string }).callId,
      );
      expect(executedNames).toEqual(['structured_output', 'structured_output']);
      expect(executedIds).toEqual([
        'tool-structured-bad',
        'tool-structured-good',
      ]);

      // No retry turn was needed.
      expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledTimes(1);
      expect(abortAllSpy).toHaveBeenCalledTimes(1);

      // Result must reflect the second (successful) structured_output's
      // submitted args, not a retry payload.
      const events = writes
        .join('')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line))
        .flat();
      const result = events.find(
        (m: unknown) =>
          typeof m === 'object' &&
          m !== null &&
          (m as { type?: string }).type === 'result',
      );
      expect(result).toBeDefined();
      expect(result.is_error).toBe(false);
      expect(result.structured_result).toEqual(goodArgs);
    });

    it('keeps the session running when structured_output args fail validation so the model can retry', async () => {
      (mockConfig.getJsonSchema as Mock).mockReturnValue({
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
      });
      (mockConfig.getOutputFormat as Mock).mockReturnValue(OutputFormat.JSON);
      setupMetricsMock();

      // First turn: model calls structured_output with invalid args (the
      // tool returns a tool-execution error). The session must NOT terminate
      // — `!toolResponse.error` keeps `structuredSubmission` undefined and
      // we feed the validation failure back so the model can retry.
      const invalidStructured: ServerGeminiStreamEvent = {
        type: GeminiEventType.ToolCallRequest,
        value: {
          callId: 'tool-structured-invalid',
          name: 'structured_output',
          args: {},
          isClientInitiated: false,
          prompt_id: 'prompt-id-retry',
        },
      };
      // Second turn: model retries with valid args.
      const validStructured: ServerGeminiStreamEvent = {
        type: GeminiEventType.ToolCallRequest,
        value: {
          callId: 'tool-structured-valid',
          name: 'structured_output',
          args: { summary: 'second try' },
          isClientInitiated: false,
          prompt_id: 'prompt-id-retry',
        },
      };

      mockGeminiClient.sendMessageStream
        .mockReturnValueOnce(createStreamFromEvents([invalidStructured]))
        .mockReturnValueOnce(createStreamFromEvents([validStructured]));

      mockCoreExecuteToolCall
        .mockResolvedValueOnce({
          error: new Error('args failed schema validation'),
          errorType: 'TOOL_INVALID_ARGUMENTS',
          resultDisplay: 'missing required field: summary',
          responseParts: [
            { text: 'Tool error: args failed schema validation' },
          ],
        })
        .mockResolvedValueOnce({
          responseParts: [{ text: 'ok' }],
        });

      await runNonInteractive(
        mockConfig,
        mockSettings,
        'Emit structured output',
        'prompt-id-retry',
      );

      // Both attempts must have been executed (no early termination on the
      // first call's error).
      expect(mockCoreExecuteToolCall).toHaveBeenCalledTimes(2);
      const firstName = (
        mockCoreExecuteToolCall.mock.calls[0][1] as { name: string }
      ).name;
      const secondName = (
        mockCoreExecuteToolCall.mock.calls[1][1] as { name: string }
      ).name;
      expect(firstName).toBe('structured_output');
      expect(secondName).toBe('structured_output');

      // A second sendMessageStream call confirms the retry turn was issued
      // — the failed first attempt did not short-circuit the run.
      expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledTimes(2);
    });

    it('errors with non-zero exit when model emits plain text instead of structured_output', async () => {
      (mockConfig.getJsonSchema as Mock).mockReturnValue({
        type: 'object',
        properties: { summary: { type: 'string' } },
      });
      (mockConfig.getOutputFormat as Mock).mockReturnValue(OutputFormat.JSON);
      setupMetricsMock();

      const writes: string[] = [];
      processStdoutSpy.mockImplementation((chunk: string | Uint8Array) => {
        writes.push(
          typeof chunk === 'string'
            ? chunk
            : Buffer.from(chunk).toString('utf8'),
        );
        return true;
      });

      const plainTextTurn: ServerGeminiStreamEvent[] = [
        { type: GeminiEventType.Content, value: 'Here is my answer as text.' },
        {
          type: GeminiEventType.Finished,
          value: { reason: undefined, usageMetadata: { totalTokenCount: 5 } },
        },
      ];
      mockGeminiClient.sendMessageStream.mockReturnValueOnce(
        createStreamFromEvents(plainTextTurn),
      );

      const exitCode = await runNonInteractive(
        mockConfig,
        mockSettings,
        'Should call structured_output',
        'prompt-id-plaintext',
      );
      expect(exitCode).toBe(1);

      const result = writes
        .join('')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line))
        .flat()
        .find(
          (m: unknown) =>
            typeof m === 'object' &&
            m !== null &&
            (m as { type?: string }).type === 'result',
        );
      expect(result?.is_error).toBe(true);
      expect(result?.error?.message).toMatch(/structured_output/);
    });

    it('synthesises tool_result for suppressed sibling calls when structured_output fails validation', async () => {
      // Same-turn batch: [side_effect_tool, structured_output(bad)]. The
      // pre-scan suppresses the side_effect_tool; structured_output then
      // fails validation. The retry turn must still pair both tool_use
      // blocks from the prior assistant message with tool_result blocks,
      // or providers like Anthropic reject the request. We synthesise a
      // "skipped" functionResponse for every suppressed call.
      (mockConfig.getJsonSchema as Mock).mockReturnValue({
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
      });
      (mockConfig.getOutputFormat as Mock).mockReturnValue(OutputFormat.JSON);
      setupMetricsMock();

      const leadingCall: ServerGeminiStreamEvent = {
        type: GeminiEventType.ToolCallRequest,
        value: {
          callId: 'tool-leading',
          name: 'side_effect_tool',
          args: { path: '/tmp/should-not-write' },
          isClientInitiated: false,
          prompt_id: 'prompt-id-suppress-pair',
        },
      };
      const badStructuredCall: ServerGeminiStreamEvent = {
        type: GeminiEventType.ToolCallRequest,
        value: {
          callId: 'tool-structured-bad',
          name: 'structured_output',
          args: { wrong: 'shape' },
          isClientInitiated: false,
          prompt_id: 'prompt-id-suppress-pair',
        },
      };
      const goodStructuredCall: ServerGeminiStreamEvent = {
        type: GeminiEventType.ToolCallRequest,
        value: {
          callId: 'tool-structured-good',
          name: 'structured_output',
          args: { summary: 'retry ok' },
          isClientInitiated: false,
          prompt_id: 'prompt-id-suppress-pair',
        },
      };

      mockGeminiClient.sendMessageStream
        .mockReturnValueOnce(
          createStreamFromEvents([leadingCall, badStructuredCall]),
        )
        .mockReturnValueOnce(createStreamFromEvents([goodStructuredCall]));

      // First call (the bad structured_output) returns an error response;
      // second call (the retry's good structured_output) succeeds.
      mockCoreExecuteToolCall
        .mockResolvedValueOnce({
          error: new Error('args invalid'),
          errorType: 'TOOL_INVALID_ARGUMENTS',
          responseParts: [
            {
              functionResponse: {
                id: 'tool-structured-bad',
                name: 'structured_output',
                response: { error: 'args invalid' },
              },
            },
          ],
        })
        .mockResolvedValueOnce({
          responseParts: [{ text: 'ok' }],
        });

      await runNonInteractive(
        mockConfig,
        mockSettings,
        'Emit structured output',
        'prompt-id-suppress-pair',
      );

      // The side-effect tool must NEVER have been executed.
      const executedNames = mockCoreExecuteToolCall.mock.calls.map(
        (call) => (call[1] as { name: string }).name,
      );
      expect(executedNames).toEqual(['structured_output', 'structured_output']);

      // The retry message sent to the model must contain BOTH a tool_result
      // for the suppressed side_effect_tool and one for the failed
      // structured_output, so every prior tool_use is paired.
      expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledTimes(2);
      const retryParts = mockGeminiClient.sendMessageStream.mock.calls[1][0] as
        | Array<{
            functionResponse?: { id?: string; name?: string };
          }>
        | undefined;
      const retryPartsTyped = (retryParts || []) as Array<{
        functionResponse?: {
          id?: string;
          name?: string;
          response?: unknown;
        };
      }>;
      const responseIds = retryPartsTyped
        .map((p) => p.functionResponse?.id)
        .filter(Boolean);
      expect(responseIds).toContain('tool-leading');
      expect(responseIds).toContain('tool-structured-bad');
      const suppressed = retryPartsTyped.find(
        (p) => p.functionResponse?.id === 'tool-leading',
      );
      expect(suppressed?.functionResponse?.name).toBe('side_effect_tool');
      // On the retry path the suppressed call's synthesised body must keep
      // the "Re-issue this call" guidance: the model is about to receive
      // these parts and may legitimately want to retry the suppressed call
      // in the next turn (the structured contract didn't terminate yet).
      const suppressedOutput = JSON.stringify(
        suppressed?.functionResponse?.response,
      );
      expect(suppressedOutput).toMatch(/Skipped:/);
      expect(suppressedOutput).toMatch(/Re-issue this call/);

      // The failed structured_output's tool_result must carry the actual
      // validation error from `executeToolCall` so the model has signal
      // to correct itself on the retry — a regression that overwrote it
      // with the synthesised "Skipped" message would leave the model
      // blind. Assert the shape: the bad call's response carries the
      // validation error string, not the suppressed-output prose.
      const failedStructured = retryPartsTyped.find(
        (p) => p.functionResponse?.id === 'tool-structured-bad',
      );
      expect(failedStructured?.functionResponse?.name).toBe(
        'structured_output',
      );
      expect(
        JSON.stringify(failedStructured?.functionResponse?.response),
      ).toContain('args invalid');
      expect(
        JSON.stringify(failedStructured?.functionResponse?.response),
      ).not.toMatch(/Skipped:/);
    });

    it('keeps duplicate provider responses when structured_output fails validation', async () => {
      (mockConfig.getJsonSchema as Mock).mockReturnValue({
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
      });
      (mockConfig.getOutputFormat as Mock).mockReturnValue(OutputFormat.JSON);
      setupMetricsMock();

      const firstSideEffectCall: ServerGeminiStreamEvent = {
        type: GeminiEventType.ToolCallRequest,
        value: {
          callId: 'tool-side',
          providerCallId: 'tool-side',
          name: 'side_effect_tool',
          args: { path: '/tmp/first' },
          isClientInitiated: false,
          prompt_id: 'prompt-id-dup-structured',
        },
      };
      const duplicateSideEffectCall: ServerGeminiStreamEvent = {
        type: GeminiEventType.ToolCallRequest,
        value: {
          callId: 'tool-side',
          providerCallId: 'tool-side',
          name: 'side_effect_tool',
          args: { path: '/tmp/second' },
          isClientInitiated: false,
          prompt_id: 'prompt-id-dup-structured',
        },
      };
      const badStructuredCall: ServerGeminiStreamEvent = {
        type: GeminiEventType.ToolCallRequest,
        value: {
          callId: 'tool-structured-bad',
          name: 'structured_output',
          args: { wrong: 'shape' },
          isClientInitiated: false,
          prompt_id: 'prompt-id-dup-structured',
        },
      };
      const goodStructuredCall: ServerGeminiStreamEvent = {
        type: GeminiEventType.ToolCallRequest,
        value: {
          callId: 'tool-structured-good',
          name: 'structured_output',
          args: { summary: 'retry ok' },
          isClientInitiated: false,
          prompt_id: 'prompt-id-dup-structured',
        },
      };

      mockGeminiClient.sendMessageStream
        .mockReturnValueOnce(createStreamFromEvents([firstSideEffectCall]))
        .mockReturnValueOnce(
          createStreamFromEvents([duplicateSideEffectCall, badStructuredCall]),
        )
        .mockReturnValueOnce(createStreamFromEvents([goodStructuredCall]));

      mockCoreExecuteToolCall
        .mockResolvedValueOnce({
          responseParts: [
            {
              functionResponse: {
                id: 'tool-side',
                name: 'side_effect_tool',
                response: { output: 'first side effect' },
              },
            },
          ],
        })
        .mockResolvedValueOnce({
          error: new Error('args invalid'),
          errorType: 'TOOL_INVALID_ARGUMENTS',
          responseParts: [
            {
              functionResponse: {
                id: 'tool-structured-bad',
                name: 'structured_output',
                response: { error: 'args invalid' },
              },
            },
          ],
        })
        .mockResolvedValueOnce({
          responseParts: [{ text: 'ok' }],
        });

      await runNonInteractive(
        mockConfig,
        mockSettings,
        'Emit structured output',
        'prompt-id-dup-structured',
      );

      const executedNames = mockCoreExecuteToolCall.mock.calls.map(
        (call) => (call[1] as { name: string }).name,
      );
      expect(executedNames).toEqual([
        'side_effect_tool',
        'structured_output',
        'structured_output',
      ]);

      expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledTimes(3);
      const retryParts = mockGeminiClient.sendMessageStream.mock.calls[2][0] as
        | Array<{
            functionResponse?: {
              id?: string;
              name?: string;
              response?: unknown;
            };
          }>
        | undefined;
      const retryPartsTyped = retryParts || [];
      const duplicateResponse = retryPartsTyped.find((part) =>
        String(
          (part.functionResponse?.response as { error?: unknown } | undefined)
            ?.error,
        ).includes('Duplicate provider tool call id "tool-side"'),
      );
      const failedStructured = retryPartsTyped.find(
        (part) => part.functionResponse?.id === 'tool-structured-bad',
      );
      expect(duplicateResponse?.functionResponse?.id).toBe('tool-side');
      expect(duplicateResponse?.functionResponse?.name).toBe(
        'side_effect_tool',
      );
      expect(failedStructured?.functionResponse?.name).toBe(
        'structured_output',
      );
      expect(
        JSON.stringify(failedStructured?.functionResponse?.response),
      ).toContain('args invalid');
    });

    it('captures structured_output emitted from a drain-turn (queued notification)', async () => {
      // Main turn ends with plain text → control falls into the drain
      // block. A monitor notification then arrives and the model's reply
      // to it calls structured_output. The synthetic tool is registered
      // for the whole session, so the drain turn must apply the same
      // terminal handling as the main loop — capture the args, abort
      // background work, and emit the structured success envelope.
      // Without this fix the drain treated structured_output as a regular
      // tool, sent its response back to the model, and the run exited
      // with the "Model produced plain text..." failure even though a
      // valid structured payload had already been accepted.
      (mockConfig.getJsonSchema as Mock).mockReturnValue({
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
      });
      (mockConfig.getOutputFormat as Mock).mockReturnValue(
        OutputFormat.STREAM_JSON,
      );
      (mockConfig.getIncludePartialMessages as Mock).mockReturnValue(false);
      setupMetricsMock();

      const writes: string[] = [];
      processStdoutSpy.mockImplementation((chunk: string | Uint8Array) => {
        writes.push(
          typeof chunk === 'string'
            ? chunk
            : Buffer.from(chunk).toString('utf8'),
        );
        return true;
      });

      // Inject a monitor notification synchronously when the registry
      // wires up — same trick the existing notification tests use to
      // enqueue a drain item before the first turn runs.
      const notificationXml =
        '<task-notification>\n' +
        '<task-id>mon_1</task-id>\n' +
        '<kind>monitor</kind>\n' +
        '<status>running</status>\n' +
        '<summary>Monitor emitted event #1.</summary>\n' +
        '<result>ready</result>\n' +
        '</task-notification>';
      mockMonitorRegistry.setNotificationCallback.mockImplementation((cb) => {
        if (!cb) return;
        cb('Monitor "logs" event #1: ready', notificationXml, {
          monitorId: 'mon_1',
          toolUseId: 'tool_mon_1',
          status: 'running',
          eventCount: 1,
        });
      });

      const drainStructuredArgs = { summary: 'drain-captured' };
      const drainStructuredCall: ServerGeminiStreamEvent = {
        type: GeminiEventType.ToolCallRequest,
        value: {
          callId: 'tool-drain-structured',
          name: 'structured_output',
          args: drainStructuredArgs,
          isClientInitiated: false,
          prompt_id: 'prompt-drain-struct',
        },
      };

      // First turn: plain text, no tool calls — drains into the queue.
      // Drain turn: model invokes structured_output as the reply to the
      // notification.
      mockGeminiClient.sendMessageStream
        .mockReturnValueOnce(
          createStreamFromEvents([
            { type: GeminiEventType.Content, value: 'Monitor launched.' },
            {
              type: GeminiEventType.Finished,
              value: {
                reason: undefined,
                usageMetadata: { totalTokenCount: 2 },
              },
            },
          ]),
        )
        .mockReturnValueOnce(createStreamFromEvents([drainStructuredCall]));

      mockCoreExecuteToolCall.mockResolvedValue({
        responseParts: [{ text: 'ok' }],
      });

      const exitCode = await runNonInteractive(
        mockConfig,
        mockSettings,
        'Watch the logs',
        'prompt-drain-struct',
      );

      // The drain turn captured structured_output → success exit, not the
      // "Model produced plain text..." failure path.
      expect(exitCode).toBe(0);

      // Two stream calls: main + drain reply. structured_output executed
      // exactly once (during drain).
      expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledTimes(2);
      expect(mockCoreExecuteToolCall).toHaveBeenCalledTimes(1);
      const drainCallArg = mockCoreExecuteToolCall.mock.calls[0][1] as {
        name: string;
      };
      expect(drainCallArg.name).toBe('structured_output');

      // The terminating result event must carry the drain-captured args
      // under structured_result, not be flagged as an error.
      const events = writes
        .join('')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line));
      const result = events.find(
        (m: unknown) =>
          typeof m === 'object' &&
          m !== null &&
          (m as { type?: string }).type === 'result',
      );
      expect(result).toBeDefined();
      expect(result.is_error).toBe(false);
      expect(result.structured_result).toEqual(drainStructuredArgs);
    });

    it('holds back for in-flight background tasks before emitting structured success', async () => {
      // The structured-success terminal block has a bounded holdback:
      // `while (Date.now() < holdbackDeadline && registry.hasUnfinalizedTasks())`
      // sleeping 50 ms between polls. All other success-path tests pin
      // `hasUnfinalizedTasks: () => false`, so the loop body never
      // enters and the cap, polling, and ordering of flush + finalize
      // are unverified. This test flips `hasUnfinalizedTasks` true →
      // false mid-run so the body executes at least once, and asserts
      // (a) the structured success result still emits, (b) the
      // suppressed in-flight task's `task_notification` is flushed
      // BEFORE the result event in the SDK output stream.
      (mockConfig.getJsonSchema as Mock).mockReturnValue({
        type: 'object',
        properties: { summary: { type: 'string' } },
      });
      (mockConfig.getOutputFormat as Mock).mockReturnValue(
        OutputFormat.STREAM_JSON,
      );
      setupMetricsMock();

      const abortAllSpy = vi.fn();
      // Returns true once, then false. After abortAll() is called the
      // holdback's `while` body executes one iteration of `setTimeout(50)`
      // and re-checks; on the second call we report tasks finalized.
      let unfinalizedCalls = 0;
      const hasUnfinalizedTasksSpy = vi.fn(() => {
        unfinalizedCalls++;
        return unfinalizedCalls === 1;
      });
      // Capture the notification callback so we can fire a
      // `task_notification` from "the agent's natural handler" during
      // the holdback. Without flushing localQueue before emitResult,
      // this notification would be silently dropped.
      let notificationCallback:
        | ((
            displayText: string,
            modelText: string,
            meta: {
              agentId: string;
              toolUseId?: string;
              status: string;
              stats?: unknown;
            },
          ) => void)
        | null = null;
      (mockConfig.getBackgroundTaskRegistry as Mock).mockReturnValue({
        setNotificationCallback: vi.fn((cb) => {
          notificationCallback = cb;
        }),
        setRegisterCallback: vi.fn(),
        getAll: vi.fn().mockReturnValue([]),
        hasUnfinalizedTasks: hasUnfinalizedTasksSpy,
        abortAll: vi.fn(() => {
          abortAllSpy();
          // The natural cancel-handler enqueues the terminal
          // task_notification synchronously when abortAll is invoked.
          // Fire the captured callback immediately so it lands in
          // localQueue before the holdback flush runs.
          notificationCallback?.(
            'Agent cancelled: bg-task-1',
            'Agent bg-task-1 was cancelled',
            {
              agentId: 'bg-task-1',
              toolUseId: 'tool-bg-1',
              status: 'cancelled' as never,
            },
          );
        }),
      });

      const writes: string[] = [];
      processStdoutSpy.mockImplementation((chunk: string | Uint8Array) => {
        writes.push(
          typeof chunk === 'string'
            ? chunk
            : Buffer.from(chunk).toString('utf8'),
        );
        return true;
      });

      const structuredArgs = { summary: 'done' };
      const structuredCall: ServerGeminiStreamEvent = {
        type: GeminiEventType.ToolCallRequest,
        value: {
          callId: 'tool-structured',
          name: 'structured_output',
          args: structuredArgs,
          isClientInitiated: false,
          prompt_id: 'prompt-id-holdback',
        },
      };
      mockCoreExecuteToolCall.mockResolvedValue({
        responseParts: [{ text: 'ok' }],
      });
      mockGeminiClient.sendMessageStream.mockReturnValueOnce(
        createStreamFromEvents([structuredCall]),
      );

      const startedAt = Date.now();
      const exitCode = await runNonInteractive(
        mockConfig,
        mockSettings,
        'Emit structured output',
        'prompt-id-holdback',
      );
      const elapsed = Date.now() - startedAt;

      expect(exitCode).toBe(0);
      expect(abortAllSpy).toHaveBeenCalledTimes(1);
      // The holdback while-body must have executed at least one poll.
      expect(unfinalizedCalls).toBeGreaterThanOrEqual(2);
      // …but it must NOT exceed the 500 ms cap by a meaningful margin.
      // 1000 ms is generous (test env CI noise) while still proving the
      // cap exists; without the cap, an infinitely-true
      // hasUnfinalizedTasks would never return.
      expect(elapsed).toBeLessThan(1000);

      // Find the result event and the simulated cancellation
      // task_notification. The notification must appear BEFORE the
      // result event in the JSONL output, proving
      // flushQueuedNotificationsToSdk(localQueue) ran before emitResult.
      const lines = writes
        .join('')
        .split('\n')
        .filter((line) => line.trim().length > 0);
      const events = lines.map((line) => JSON.parse(line));
      const resultIdx = events.findIndex(
        (m: unknown) =>
          typeof m === 'object' &&
          m !== null &&
          (m as { type?: string }).type === 'result',
      );
      const taskNotificationIdx = events.findIndex(
        (m: unknown) =>
          typeof m === 'object' &&
          m !== null &&
          (m as { type?: string; subtype?: string }).type === 'system' &&
          (m as { subtype?: string }).subtype === 'task_notification',
      );
      expect(resultIdx).toBeGreaterThan(-1);
      expect(taskNotificationIdx).toBeGreaterThan(-1);
      expect(taskNotificationIdx).toBeLessThan(resultIdx);
    });

    it('emits structuredResult to stdout in OutputFormat.TEXT mode', async () => {
      // The other --json-schema tests pin OutputFormat.JSON /
      // OutputFormat.STREAM_JSON. TEXT is the default for headless runs
      // (`qwen -p "..."` without --output-format), so it needs its own
      // pin: a regression that diverged the TEXT adapter's
      // structuredResult handling from the JSON / stream-json paths
      // would only surface to users running plain `qwen -p`.
      (mockConfig.getJsonSchema as Mock).mockReturnValue({
        type: 'object',
        properties: { summary: { type: 'string' } },
      });
      (mockConfig.getOutputFormat as Mock).mockReturnValue(OutputFormat.TEXT);
      setupMetricsMock();

      (mockConfig.getBackgroundTaskRegistry as Mock).mockReturnValue({
        setNotificationCallback: vi.fn(),
        setRegisterCallback: vi.fn(),
        getAll: vi.fn().mockReturnValue([]),
        hasUnfinalizedTasks: vi.fn().mockReturnValue(false),
        abortAll: vi.fn(),
      });

      const writes: string[] = [];
      processStdoutSpy.mockImplementation((chunk: string | Uint8Array) => {
        writes.push(
          typeof chunk === 'string'
            ? chunk
            : Buffer.from(chunk).toString('utf8'),
        );
        return true;
      });

      const structuredArgs = { summary: 'text-mode-ok' };
      const structuredCall: ServerGeminiStreamEvent = {
        type: GeminiEventType.ToolCallRequest,
        value: {
          callId: 'tool-structured-text',
          name: 'structured_output',
          args: structuredArgs,
          isClientInitiated: false,
          prompt_id: 'prompt-id-text',
        },
      };
      mockCoreExecuteToolCall.mockResolvedValue({
        responseParts: [{ text: 'ok' }],
      });
      mockGeminiClient.sendMessageStream.mockReturnValueOnce(
        createStreamFromEvents([structuredCall]),
      );

      const exitCode = await runNonInteractive(
        mockConfig,
        mockSettings,
        'Emit structured output (text mode)',
        'prompt-id-text',
      );

      expect(exitCode).toBe(0);
      // TEXT mode writes the JSON-stringified structured payload as the
      // result on stdout (BaseJsonOutputAdapter.buildResultMessage forces
      // `result = JSON.stringify(structuredResult)` when the field is
      // set; JsonOutputAdapter writes `result` directly to stdout in
      // TEXT mode). The line should be exactly the stringified args plus
      // a trailing newline — no JSON envelope, no extra event log.
      const stdout = writes.join('');
      expect(stdout).toBe(`${JSON.stringify(structuredArgs)}\n`);
    });
  });

  // PR #4174 Phase C: `--resume` headless restore.
  // Covers reviewer #4174 follow-up — "nonInteractiveCli.ts:375-408
  // headless --resume worktree restore is stubbed out". Verifies the
  // <system-reminder> injection + worktree_restored adapter event.
  describe('--resume with active worktree (Phase C)', () => {
    it('injects a <system-reminder> block into the user prompt when sidecar names a live worktree', async () => {
      // Write a real sidecar pointing at a real directory so the
      // restoreWorktreeContext helper (which fs.stat's the worktree
      // path) reports it as alive.
      const tmpDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'wt-headless-resume-'),
      );
      const realTmpDir = await fs.realpath(tmpDir);
      // restoreWorktreeContext enforces a structural invariant:
      // worktreePath MUST live under `<originalCwd>/.qwen/worktrees/`
      // (PR #4174 review #3256839787). The test fixture mirrors that
      // shape so the restore path isn't rejected as tampered.
      const worktreeDir = path.join(
        realTmpDir,
        '.qwen',
        'worktrees',
        'worktree-real',
      );
      await fs.mkdir(worktreeDir, { recursive: true });
      const sidecarPath = path.join(realTmpDir, 'sidecar.worktree.json');
      const sidecar = {
        slug: 'resume-test',
        worktreePath: worktreeDir,
        worktreeBranch: 'worktree-resume-test',
        originalCwd: realTmpDir,
        originalBranch: 'main',
        originalHeadCommit: 'a'.repeat(40),
      };
      await fs.writeFile(sidecarPath, JSON.stringify(sidecar), 'utf-8');

      // Wire mockConfig to indicate a resumed session + return a service
      // whose getWorktreeSessionPath points at our real sidecar.
      (mockConfig.getResumedSessionData as Mock).mockReturnValue({
        sessionId: 'resume-session',
        conversation: { messages: [] },
      });
      const sessionService = {
        getWorktreeSessionPath: vi.fn().mockReturnValue(sidecarPath),
      };
      (mockConfig as { getSessionService?: () => unknown }).getSessionService =
        vi.fn().mockReturnValue(sessionService);

      setupMetricsMock();
      const events: ServerGeminiStreamEvent[] = [
        { type: GeminiEventType.Content, value: 'ok' },
        {
          type: GeminiEventType.Finished,
          value: { reason: undefined, usageMetadata: { totalTokenCount: 1 } },
        },
      ];
      mockGeminiClient.sendMessageStream.mockReturnValue(
        createStreamFromEvents(events),
      );

      try {
        await runNonInteractive(
          mockConfig,
          mockSettings,
          'continue work',
          'prompt-id-resume',
        );

        // The user message sent to the model should now begin with a
        // <system-reminder> block carrying the restore notice.
        const [parts] = mockGeminiClient.sendMessageStream.mock.calls[0] as [
          Array<{ text?: string }>,
        ];
        expect(parts.length).toBeGreaterThanOrEqual(2);
        expect(parts[0].text).toContain('<system-reminder>');
        expect(parts[0].text).toContain('Active worktree: "resume-test"');
        expect(parts[0].text).toContain(worktreeDir);
        // User's actual prompt is preserved as the next part.
        expect(parts[parts.length - 1].text).toBe('continue work');
      } finally {
        await fs.rm(realTmpDir, { recursive: true, force: true });
      }
    });

    it('does not inject anything when sidecar is absent', async () => {
      // No sidecar set up — getResumedSessionData also returns undefined
      // by default, so the entire restore block is short-circuited.
      (mockConfig.getResumedSessionData as Mock).mockReturnValue(undefined);

      setupMetricsMock();
      const events: ServerGeminiStreamEvent[] = [
        { type: GeminiEventType.Content, value: 'ok' },
        {
          type: GeminiEventType.Finished,
          value: { reason: undefined, usageMetadata: { totalTokenCount: 1 } },
        },
      ];
      mockGeminiClient.sendMessageStream.mockReturnValue(
        createStreamFromEvents(events),
      );

      await runNonInteractive(
        mockConfig,
        mockSettings,
        'plain prompt',
        'prompt-id-no-resume',
      );

      const [parts] = mockGeminiClient.sendMessageStream.mock.calls[0] as [
        Array<{ text?: string }>,
      ];
      // Exactly one part — the user prompt, no reminder prefix.
      expect(parts.length).toBe(1);
      expect(parts[0].text).toBe('plain prompt');
    });

    it('cleans up the sidecar when the worktree dir is gone (stale --resume)', async () => {
      const tmpDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'wt-headless-stale-'),
      );
      const realTmpDir = await fs.realpath(tmpDir);
      const sidecarPath = path.join(realTmpDir, 'stale.worktree.json');
      const sidecar = {
        slug: 'stale-test',
        // Points at a dir that does NOT exist on disk → restoreWorktreeContext
        // treats it as stale and clears the sidecar.
        worktreePath: path.join(realTmpDir, 'never-created'),
        worktreeBranch: 'worktree-stale-test',
        originalCwd: realTmpDir,
        originalBranch: 'main',
        originalHeadCommit: 'b'.repeat(40),
      };
      await fs.writeFile(sidecarPath, JSON.stringify(sidecar), 'utf-8');

      (mockConfig.getResumedSessionData as Mock).mockReturnValue({
        sessionId: 'resume-session',
        conversation: { messages: [] },
      });
      const sessionService = {
        getWorktreeSessionPath: vi.fn().mockReturnValue(sidecarPath),
      };
      (mockConfig as { getSessionService?: () => unknown }).getSessionService =
        vi.fn().mockReturnValue(sessionService);

      setupMetricsMock();
      const events: ServerGeminiStreamEvent[] = [
        { type: GeminiEventType.Content, value: 'ok' },
        {
          type: GeminiEventType.Finished,
          value: { reason: undefined, usageMetadata: { totalTokenCount: 1 } },
        },
      ];
      mockGeminiClient.sendMessageStream.mockReturnValue(
        createStreamFromEvents(events),
      );

      try {
        await runNonInteractive(
          mockConfig,
          mockSettings,
          'hello',
          'prompt-id-stale',
        );

        // Sidecar should be cleared.
        await expect(fs.stat(sidecarPath)).rejects.toMatchObject({
          code: 'ENOENT',
        });
        // No <system-reminder> injected — the user prompt is the only part.
        const [parts] = mockGeminiClient.sendMessageStream.mock.calls[0] as [
          Array<{ text?: string }>,
        ];
        expect(parts.length).toBe(1);
        expect(parts[0].text).toBe('hello');
      } finally {
        await fs.rm(realTmpDir, { recursive: true, force: true });
      }
    });
  });
});
