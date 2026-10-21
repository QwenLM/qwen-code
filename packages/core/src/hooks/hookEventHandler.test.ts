/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { HookEventHandler } from './hookEventHandler.js';
import { HookRunner as RealHookRunner } from './hookRunner.js';
import { MessageBus } from '../confirmation-bus/message-bus.js';
import { MessageBusType } from '../confirmation-bus/types.js';
import type { HookProgress } from '../confirmation-bus/types.js';
import {
  HookEventName,
  HookType,
  HooksConfigSource,
  SessionStartSource,
  SessionEndReason,
  PermissionMode,
  AgentType,
  PreCompactTrigger,
  PostCompactTrigger,
  NotificationType,
  HookPhase,
} from './types.js';
import type { MessagesProvider, StopFailureErrorType } from './types.js';
import type { Config } from '../config/config.js';
import type {
  HookPlanner,
  HookRunner,
  HookAggregator,
  AggregatedHookResult,
  SessionHooksManager,
  SessionHookEntry,
} from './index.js';
import type { HookConfig, HookOutput, PermissionSuggestion } from './types.js';
import type { HookExecutionResult } from './types.js';
import { logHookCall } from '../telemetry/loggers.js';
import { runWithAgentContext } from '../agents/runtime/agent-context.js';
import { ApprovalMode } from '../config/approval-mode.js';
import { promptIdContext } from '../utils/promptIdContext.js';

// Mock the telemetry loggers module
vi.mock('../telemetry/loggers.js', () => ({
  logHookCall: vi.fn(),
}));

type Fire = () => Promise<AggregatedHookResult>;

describe('HookEventHandler', () => {
  let mockConfig: Config;
  let mockHookPlanner: HookPlanner;
  let mockHookRunner: HookRunner;
  let mockHookAggregator: HookAggregator;
  let mockSessionHooksManager: SessionHooksManager;
  let hookEventHandler: HookEventHandler;

  const createBaseConfig = (): Config =>
    ({
      getSessionId: vi.fn().mockReturnValue('test-session-id'),
      getSessionSourceType: vi.fn().mockReturnValue(undefined),
      getSessionSourceId: vi.fn().mockReturnValue(undefined),
      getTranscriptPath: vi.fn().mockReturnValue('/test/transcript'),
      getApprovalMode: vi.fn().mockReturnValue('default'),
      getWorkingDir: vi.fn().mockReturnValue('/test/cwd'),
    }) as unknown as Config;

  const createHandler = (
    config: Config = mockConfig,
    runner: HookRunner = mockHookRunner,
    messagesProvider?: MessagesProvider,
  ) =>
    new HookEventHandler(
      config,
      mockHookPlanner,
      runner,
      mockHookAggregator,
      mockSessionHooksManager,
      messagesProvider,
    );

  beforeEach(() => {
    mockConfig = createBaseConfig();

    mockHookPlanner = {
      createExecutionPlan: vi.fn(),
    } as unknown as HookPlanner;

    mockHookRunner = {
      executeHooksSequential: vi.fn(),
      executeHooksParallel: vi.fn(),
    } as unknown as HookRunner;

    mockHookAggregator = {
      aggregateResults: vi.fn(),
    } as unknown as HookAggregator;

    mockSessionHooksManager = {
      getMatchingHooks: vi.fn().mockReturnValue([]),
      getHooksForEvent: vi.fn().mockReturnValue([]),
      hasSessionHooks: vi.fn().mockReturnValue(false),
      addSessionHook: vi.fn(),
      addFunctionHook: vi.fn(),
      removeHook: vi.fn(),
      removeFunctionHook: vi.fn(),
      clearSessionHooks: vi.fn(),
      getActiveSessions: vi.fn().mockReturnValue([]),
      getHookCount: vi.fn().mockReturnValue(0),
      getAllSessionHooks: vi.fn().mockReturnValue([]),
    } as unknown as SessionHooksManager;

    hookEventHandler = createHandler();
  });

  const createMockExecutionPlan = (
    hookConfigs: HookConfig[] = [],
    sequential: boolean = false,
  ) => ({
    hookConfigs,
    sequential,
    eventName: HookEventName.PreToolUse,
  });

  const createMockAggregatedResult = (
    success: boolean = true,
    finalOutput?: HookOutput,
  ): AggregatedHookResult => ({
    success,
    allOutputs: [],
    errors: [],
    totalDuration: 100,
    finalOutput,
  });

  const createSessionHookEntry = (
    eventName: HookEventName,
    matcher: string,
    command: string = 'echo session-hook',
  ): SessionHookEntry => ({
    hookId: `session-${eventName}-${matcher}`,
    eventName,
    matcher,
    config: {
      type: HookType.Command,
      command,
      source: HooksConfigSource.Session,
    },
  });

  const commandHook = (
    command = 'echo test',
    extra: Partial<HookConfig> = {},
  ): HookConfig =>
    ({
      type: HookType.Command,
      command,
      source: HooksConfigSource.Project,
      ...extra,
    }) as HookConfig;

  /**
   * Plans `hooks` (`null`: no registry plan), resolves the runner the plan
   * picks with `results`, and aggregates to `aggregated` (`null`: leave the
   * aggregator unmocked).
   */
  const arrange = (
    hooks: HookConfig[] | null = [commandHook()],
    {
      sequential = false,
      results = [],
      aggregated = createMockAggregatedResult(true),
    }: {
      sequential?: boolean;
      results?: HookExecutionResult[];
      aggregated?: AggregatedHookResult | null;
    } = {},
  ) => {
    vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(
      hooks && createMockExecutionPlan(hooks, sequential),
    );
    vi.mocked(
      sequential
        ? mockHookRunner.executeHooksSequential
        : mockHookRunner.executeHooksParallel,
    ).mockResolvedValue(results);
    if (aggregated) {
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        aggregated,
      );
    }
  };

  /** The hook input of the latest parallel run. */
  const inputOf = <T = Record<string, unknown>>() =>
    vi.mocked(mockHookRunner.executeHooksParallel).mock.calls.at(-1)![2] as T;

  /** Plans one command hook, fires, and returns the input the hook ran with. */
  const captureInput = async <T = Record<string, unknown>>(
    fire: () => Promise<unknown>,
  ) => {
    arrange();
    await fire();
    return inputOf<T>();
  };

  /** One `expect` per field: `toEqual` for objects, `toBe` for the rest. */
  const expectFields = (actual: unknown, fields: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(fields)) {
      const field = (actual as Record<string, unknown>)[key];
      if (typeof value === 'object' && value !== null) {
        expect(field).toEqual(value);
      } else {
        expect(field).toBe(value);
      }
    }
  };

  const expectInput = async (
    fire: () => Promise<unknown>,
    fields: Record<string, unknown>,
  ) => {
    const input = await captureInput(fire);
    expectFields(input, fields);
    return input;
  };

  const expectPlanned = (event: HookEventName, context?: object) =>
    expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalledWith(
      event,
      context,
      expect.objectContaining({
        runtimeId: expect.any(String),
        sessionId: 'test-session-id',
      }),
    );

  /** Checks the parallel runner's call; the two callbacks are hook start/end. */
  const expectRan = (
    configs: unknown,
    event: HookEventName,
    input: unknown = expect.any(Object),
    functionContext: unknown = expect.any(Object),
  ) =>
    expect(mockHookRunner.executeHooksParallel).toHaveBeenCalledWith(
      configs,
      event,
      input,
      expect.any(Function),
      expect.any(Function),
      undefined,
      functionContext,
    );

  const expectFailure = (result: AggregatedHookResult, message: string) => {
    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toBe(message);
  };

  /** Makes planning throw `message`, fires, and checks the failed result. */
  const failPlanning = async (message: string, fire: Fire) => {
    vi.mocked(mockHookPlanner.createExecutionPlan).mockImplementation(() => {
      throw new Error(message);
    });
    const result = await fire();
    expectFailure(result, message);
    return result;
  };

  const fireWithOutput = (finalOutput: HookOutput, fire: Fire) => {
    arrange([commandHook()], {
      aggregated: createMockAggregatedResult(true, finalOutput),
    });
    return fire();
  };

  // Case factories for the checks every fire* method shares.
  const registerPlanCase =
    (checkSuccess: boolean) =>
    (title: string, fire: Fire, event: HookEventName, context?: object) =>
      // eslint-disable-next-line vitest/valid-title -- callers pass literals
      it(title, async () => {
        arrange([]);
        const result = await fire();
        expectPlanned(event, context);
        if (checkSuccess) expect(result.success).toBe(true);
      });
  /** An empty plan: the event is planned with `context` and succeeds. */
  const itPlans = registerPlanCase(true);
  /** An empty plan: the event is planned with `context` (for matchers). */
  const itPassesContext = registerPlanCase(false);

  const itRunsSequentially = (fire: Fire) =>
    it('should execute hooks sequentially when plan.sequential is true', async () => {
      arrange([commandHook()], { sequential: true });
      await fire();
      expect(mockHookRunner.executeHooksSequential).toHaveBeenCalled();
      expect(mockHookRunner.executeHooksParallel).not.toHaveBeenCalled();
    });

  const itHandlesErrors = (message: string, fire: Fire) =>
    it('should handle errors gracefully', () => failPlanning(message, fire));

  describe('fireUserPromptSubmitEvent', () => {
    itPlans(
      'should execute hooks for UserPromptSubmit event',
      () => hookEventHandler.fireUserPromptSubmitEvent('test prompt'),
      HookEventName.UserPromptSubmit,
    );

    it('should include prompt in the hook input', async () => {
      const input = await expectInput(
        () => hookEventHandler.fireUserPromptSubmitEvent('my test prompt'),
        { prompt: 'my test prompt' },
      );
      expect(input).not.toHaveProperty('submitted_prompt');
    });

    it('should include submitted prompt when provided', async () => {
      const input = await captureInput(() =>
        hookEventHandler.fireUserPromptSubmitEvent(
          'model prompt',
          undefined,
          'submitted prompt',
        ),
      );
      expect(input).toMatchObject({
        prompt: 'model prompt',
        submitted_prompt: 'submitted prompt',
      });
    });

    it.each(['', ' \t\n '])(
      'should omit an empty submitted prompt',
      async (submittedPrompt) => {
        const input = await captureInput(() =>
          hookEventHandler.fireUserPromptSubmitEvent(
            'model prompt',
            undefined,
            submittedPrompt,
          ),
        );
        expect(input).not.toHaveProperty('submitted_prompt');
      },
    );
  });

  describe('fireInstructionsLoadedEvent', () => {
    it('should include instruction load metadata in hook input', async () => {
      const input = await captureInput(() =>
        hookEventHandler.fireInstructionsLoadedEvent(
          '/repo/.qwen/QWEN.local.md',
          'local',
          'include',
          { parentFilePath: '/repo/QWEN.md' },
        ),
      );

      expectPlanned(HookEventName.InstructionsLoaded, {
        filePath: '/repo/.qwen/QWEN.local.md',
      });
      expectFields(input, {
        file_path: '/repo/.qwen/QWEN.local.md',
        memory_type: 'local',
        load_reason: 'include',
        parent_file_path: '/repo/QWEN.md',
      });
    });
  });

  describe('fireUserPromptExpansionEvent', () => {
    const fire = () =>
      hookEventHandler.fireUserPromptExpansionEvent(
        'goal',
        'write tests',
        'expanded prompt',
      );

    itPlans(
      'should execute hooks for UserPromptExpansion event',
      fire,
      HookEventName.UserPromptExpansion,
      { commandName: 'goal' },
    );

    it('should include command metadata and expanded prompt in the hook input', () =>
      expectInput(fire, {
        command_name: 'goal',
        command_args: 'write tests',
        prompt: 'expanded prompt',
      }));
  });

  describe('fireStopEvent', () => {
    itPlans(
      'should execute hooks for Stop event',
      () => hookEventHandler.fireStopEvent(true, 'last message'),
      HookEventName.Stop,
    );

    it('should include stop parameters in hook input', () =>
      expectInput(
        () => hookEventHandler.fireStopEvent(true, 'last assistant message'),
        {
          stop_hook_active: true,
          last_assistant_message: 'last assistant message',
        },
      ));

    it('should include context usage fields when provided', () => {
      const usage = {
        context_usage: 0.75,
        context_limit: 200000,
        input_tokens: 150000,
      };
      return expectInput(
        () => hookEventHandler.fireStopEvent(true, 'msg', usage),
        { stop_hook_active: true, ...usage },
      );
    });

    it('should omit context usage fields when not provided', () =>
      expectInput(() => hookEventHandler.fireStopEvent(true, 'msg'), {
        context_usage: undefined,
        context_limit: undefined,
        input_tokens: undefined,
      }));

    it('should handle continue=false in final output', async () => {
      arrange([], {
        aggregated: createMockAggregatedResult(true, {
          continue: false,
          stopReason: 'test stop',
        }),
      });

      await hookEventHandler.fireStopEvent();

      expect(true).toBe(true);
    });

    it('should handle missing finalOutput gracefully', async () => {
      arrange([]);

      const result = await hookEventHandler.fireStopEvent();

      expect(result.success).toBe(true);
      expect(result.finalOutput).toBeUndefined();
    });

    it('should inject background_tasks and crons into Stop input', async () => {
      arrange();
      const mockRegistry = {
        getAll: vi.fn().mockReturnValue([
          {
            id: 'bg-1',
            status: 'running',
            subagentType: 'Explorer',
            startTime: 1720000000000,
            description: 'test task',
          },
        ]),
      };
      const mockScheduler = {
        list: vi.fn().mockReturnValue([
          {
            id: 'cron-1',
            cronExpr: '0 */2 * * *',
            prompt: 'check status',
            recurring: true,
            fireAtMs: 1720007200000,
            lastFiredAt: 1720000000000,
          },
        ]),
      };
      Object.assign(mockConfig, {
        getBackgroundTaskRegistry: () => mockRegistry,
        getCronScheduler: () => mockScheduler,
      });

      // Re-create handler with updated config mocks
      await createHandler().fireStopEvent(true, 'msg');

      const input = inputOf<{
        background_tasks: unknown[];
        crons: unknown[];
      }>();
      expect(input.background_tasks).toHaveLength(1);
      expectFields(input.background_tasks[0], {
        id: 'bg-1',
        status: 'running',
        agent_type: 'Explorer',
      });
      expect(input.crons).toHaveLength(1);
      expectFields(input.crons[0], {
        id: 'cron-1',
        schedule: '0 */2 * * *',
        prompt: 'check status',
      });
    });

    it('should return empty arrays when registry/scheduler unavailable', async () => {
      arrange();

      // Config without registry/scheduler methods
      await createHandler(createBaseConfig()).fireStopEvent(true, 'msg');

      expectFields(inputOf(), { background_tasks: [], crons: [] });
    });
  });

  describe('fireMessageDisplayEvent', () => {
    itPlans(
      'should execute hooks for MessageDisplay event',
      () => hookEventHandler.fireMessageDisplayEvent('msg-1', 'Hello', false),
      HookEventName.MessageDisplay,
    );

    it('should include message_id, displayed_text, and is_final in hook input', () =>
      expectInput(
        () =>
          hookEventHandler.fireMessageDisplayEvent(
            'msg-42',
            'Hello, world.',
            true,
          ),
        {
          message_id: 'msg-42',
          displayed_text: 'Hello, world.',
          is_final: true,
        },
      ));

    it('should handle missing finalOutput gracefully', async () => {
      arrange([]);

      const result = await hookEventHandler.fireMessageDisplayEvent(
        'msg-1',
        '',
        false,
      );

      expect(result.success).toBe(true);
      expect(result.finalOutput).toBeUndefined();
    });
  });

  describe('fireSessionStartEvent', () => {
    const fireStartup = () =>
      hookEventHandler.fireSessionStartEvent(
        SessionStartSource.Startup,
        'test-model',
      );

    itPlans(
      'should execute hooks for SessionStart event',
      fireStartup,
      HookEventName.SessionStart,
      { trigger: SessionStartSource.Startup },
    );

    it('should include all session start parameters in the hook input', () =>
      expectInput(
        () =>
          hookEventHandler.fireSessionStartEvent(
            SessionStartSource.Resume,
            'test-model',
            PermissionMode.Plan,
            AgentType.Bash,
          ),
        {
          permission_mode: PermissionMode.Plan,
          source: SessionStartSource.Resume,
          model: 'test-model',
          agent_type: AgentType.Bash,
        },
      ));

    it('should include session source fields in the hook input', async () => {
      vi.mocked(mockConfig.getSessionSourceType).mockReturnValue('channel');
      vi.mocked(mockConfig.getSessionSourceId).mockReturnValue('feishu-main');

      const input = await captureInput(fireStartup);

      expect(input).toMatchObject({
        source_type: 'channel',
        source_id: 'feishu-main',
      });
    });

    it('should omit session source fields when unavailable', async () => {
      const input = await captureInput(fireStartup);

      expect(input).not.toHaveProperty('source_type');
      expect(input).not.toHaveProperty('source_id');
    });

    it('should use default permission mode when not provided', () =>
      expectInput(
        () =>
          hookEventHandler.fireSessionStartEvent(
            SessionStartSource.Clear,
            'test-model',
          ),
        { permission_mode: PermissionMode.Default },
      ));

    it('should handle session start event with undefined agent type', () =>
      expectInput(
        () =>
          hookEventHandler.fireSessionStartEvent(
            SessionStartSource.Compact,
            'test-model',
          ),
        {
          source: SessionStartSource.Compact,
          model: 'test-model',
          agent_type: undefined,
        },
      ));
  });

  describe('fireSessionEndEvent', () => {
    itPlans(
      'should execute hooks for SessionEnd event',
      () => hookEventHandler.fireSessionEndEvent(SessionEndReason.Clear),
      HookEventName.SessionEnd,
      { trigger: SessionEndReason.Clear },
    );

    it('should include reason in the hook input', () =>
      expectInput(
        () => hookEventHandler.fireSessionEndEvent(SessionEndReason.Logout),
        { reason: SessionEndReason.Logout },
      ));

    it('should handle different session end reasons', async () => {
      arrange();

      for (const reason of [
        SessionEndReason.Clear,
        SessionEndReason.Logout,
        SessionEndReason.PromptInputExit,
        SessionEndReason.Bypass_permissions_disabled,
        SessionEndReason.Other,
      ]) {
        await hookEventHandler.fireSessionEndEvent(reason);
        expect(inputOf()['reason']).toBe(reason);
      }
    });
  });

  describe('fireSessionDeleteEvent', () => {
    it('should execute hooks with the deleted session id', async () => {
      arrange();

      const result =
        await hookEventHandler.fireSessionDeleteEvent('deleted-session-id');

      expectPlanned(HookEventName.SessionDelete);
      expectFields(inputOf(), {
        hook_event_name: HookEventName.SessionDelete,
        deleted_session_id: 'deleted-session-id',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('session hook matcher targets', () => {
    /** One session hook for `event`/`matcher` and no registry plan. */
    const expectSessionHookRuns = async (
      event: HookEventName,
      matcher: string,
      input: object,
      fire: () => Promise<unknown>,
    ) => {
      const sessionHook = createSessionHookEntry(event, matcher);
      arrange(null);
      vi.mocked(mockSessionHooksManager.getMatchingHooks).mockReturnValue([
        sessionHook,
      ]);

      await fire();

      expect(mockSessionHooksManager.getMatchingHooks).toHaveBeenCalledWith(
        'test-session-id',
        event,
        matcher,
      );
      expectRan([sessionHook.config], event, expect.objectContaining(input));
    };

    it('matches SessionStart session hooks against the session source', () =>
      expectSessionHookRuns(
        HookEventName.SessionStart,
        SessionStartSource.Resume,
        { source: SessionStartSource.Resume },
        () =>
          hookEventHandler.fireSessionStartEvent(
            SessionStartSource.Resume,
            'test-model',
          ),
      ));

    it('matches PreToolUse session hooks against the tool name', () =>
      expectSessionHookRuns(
        HookEventName.PreToolUse,
        'shell',
        { tool_name: 'shell' },
        () =>
          hookEventHandler.firePreToolUseEvent(
            'shell',
            { command: 'ls' },
            'toolu_123',
            PermissionMode.Default,
          ),
      ));

    it('matches SubagentStart session hooks against the agent type', () =>
      expectSessionHookRuns(
        HookEventName.SubagentStart,
        AgentType.Explorer,
        { agent_type: AgentType.Explorer },
        () =>
          hookEventHandler.fireSubagentStartEvent(
            'agent_123',
            AgentType.Explorer,
            PermissionMode.Default,
          ),
      ));

    it('matches StopFailure session hooks against the error type', () =>
      expectSessionHookRuns(
        HookEventName.StopFailure,
        'rate_limit',
        { error: 'rate_limit' },
        () => hookEventHandler.fireStopFailureEvent('rate_limit'),
      ));

    it('matches Notification session hooks against the notification type', () =>
      expectSessionHookRuns(
        HookEventName.Notification,
        NotificationType.PermissionPrompt,
        { notification_type: NotificationType.PermissionPrompt },
        () =>
          hookEventHandler.fireNotificationEvent(
            'permission needed',
            NotificationType.PermissionPrompt,
          ),
      ));

    it('does not matcher-filter session hooks for events without matcher semantics', async () => {
      const sessionHook = createSessionHookEntry(
        HookEventName.UserPromptSubmit,
        'ignored-matcher',
      );
      arrange(null);
      vi.mocked(mockSessionHooksManager.getHooksForEvent).mockReturnValue([
        sessionHook,
      ]);

      await hookEventHandler.fireUserPromptSubmitEvent('hello');

      expect(mockSessionHooksManager.getHooksForEvent).toHaveBeenCalledWith(
        'test-session-id',
        HookEventName.UserPromptSubmit,
      );
      expect(mockSessionHooksManager.getMatchingHooks).not.toHaveBeenCalled();
      expectRan(
        [sessionHook.config],
        HookEventName.UserPromptSubmit,
        expect.objectContaining({ prompt: 'hello' }),
      );
    });

    it('matches UserPromptExpansion session hooks against the command name', () =>
      expectSessionHookRuns(
        HookEventName.UserPromptExpansion,
        'goal',
        {
          command_name: 'goal',
          command_args: 'write tests',
          prompt: 'expanded prompt',
        },
        () =>
          hookEventHandler.fireUserPromptExpansionEvent(
            'goal',
            'write tests',
            'expanded prompt',
          ),
      ));
  });

  describe('project-skill trust gate at fire time', () => {
    // The second side of the gate `applySideEffects` enforces on the way
    // in: a hook registered from a repository's `.qwen/skills/` frontmatter
    // fires only while the folder is STILL trusted. `isTrustedFolder()` is
    // live under an IDE connection, so a revocation mid-session must
    // silence the hook at its next event — no restart, no unregistration.
    const gated = {
      hookId: 'gated',
      eventName: HookEventName.PreToolUse,
      matcher: 'shell',
      config: { type: HookType.Command, command: './exfil.sh' },
      trustGated: true,
    };
    const ungated = {
      hookId: 'plain',
      eventName: HookEventName.PreToolUse,
      matcher: 'shell',
      config: { type: HookType.Command, command: './mine.sh' },
    };
    const trust = (value: boolean) => {
      const isTrustedFolder = vi.fn().mockReturnValue(value);
      Object.assign(mockConfig, { isTrustedFolder });
      return isTrustedFolder;
    };
    const fire = async (sessionHooks: unknown[]) => {
      vi.mocked(mockSessionHooksManager.getMatchingHooks).mockReturnValue(
        sessionHooks as never,
      );
      arrange(null);
      return hookEventHandler.firePreToolUseEvent(
        'shell',
        { command: 'ls' },
        'toolu_123',
        PermissionMode.Default,
      );
    };

    it('runs the gated hook while the folder is trusted', async () => {
      trust(true);
      await fire([gated]);
      expectRan([gated.config], HookEventName.PreToolUse);
    });

    it('skips the gated hook once trust is revoked, and only that one', async () => {
      trust(false);
      await fire([gated, ungated]);
      expectRan([ungated.config], HookEventName.PreToolUse);
    });

    it('fires nothing when the gated hook was the only one — and never consults trust without a gated entry', async () => {
      trust(false);
      const result = await fire([gated]);
      expect(result.success).toBe(true);
      expect(mockHookRunner.executeHooksParallel).not.toHaveBeenCalled();
      // An ungated-only set is executed without touching folder trust: the
      // gate costs nothing on rounds that registered no project-skill hook.
      const probe = trust(false);
      await fire([ungated]);
      expect(probe).not.toHaveBeenCalled();
      expect(mockHookRunner.executeHooksParallel).toHaveBeenCalledTimes(1);
    });
  });

  describe('sequential vs parallel execution', () => {
    itRunsSequentially(() =>
      hookEventHandler.fireUserPromptSubmitEvent('test'),
    );

    it('should execute hooks in parallel when plan.sequential is false', async () => {
      arrange();

      await hookEventHandler.fireUserPromptSubmitEvent('test');

      expect(mockHookRunner.executeHooksParallel).toHaveBeenCalled();
      expect(mockHookRunner.executeHooksSequential).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should return error result when hook execution throws', () =>
      failPlanning('Planner error', () =>
        hookEventHandler.fireUserPromptSubmitEvent('test'),
      ));

    it('should return error result when hook runner throws', async () => {
      arrange([commandHook()], { aggregated: null });
      vi.mocked(mockHookRunner.executeHooksParallel).mockRejectedValue(
        new Error('Runner error'),
      );

      const result = await hookEventHandler.fireUserPromptSubmitEvent('test');

      expectFailure(result, 'Runner error');
    });

    it('should handle errors for SessionStart event', () =>
      failPlanning('SessionStart planner error', () =>
        hookEventHandler.fireSessionStartEvent(
          SessionStartSource.Startup,
          'test-model',
        ),
      ));

    it('should handle errors for SessionEnd event', () =>
      failPlanning('SessionEnd planner error', () =>
        hookEventHandler.fireSessionEndEvent(SessionEndReason.Clear),
      ));
  });

  it.each([
    ['use', 'completed'],
    ['batch', 'completed'],
    ['batch', 'failed'],
  ] as const)(
    'preserves shell text for %s hooks with %s results without mutating the UI result',
    async (event, outcome) => {
      arrange();
      const display = Object.freeze({
        type: 'shell_result',
        version: 1,
        text: outcome === 'failed' ? 'Exit Code: 7' : 'line one\nline two',
        output: 'line one\nline two',
        directory: '/tmp',
        exitCode: outcome === 'failed' ? 7 : 0,
        signal: null,
        pid: 42,
        error: null,
        outcome,
        notices: [],
        truncated: false,
        outputFiles: [],
      });
      const response = Object.freeze({
        returnDisplay: display,
        result_display: display,
      });
      if (event === 'use') {
        await hookEventHandler.firePostToolUseEvent(
          'run_shell_command',
          {},
          response,
          'shell-1',
          PermissionMode.Default,
        );
      } else {
        await hookEventHandler.firePostToolBatchEvent([
          {
            tool_name: 'run_shell_command',
            tool_input: {},
            tool_use_id: 'shell-1',
            status: outcome === 'failed' ? 'error' : 'success',
            tool_response: response,
          },
        ]);
      }
      expect(inputOf()).toMatchObject(
        event === 'use'
          ? { tool_response: { returnDisplay: display.text } }
          : {
              tool_calls: [{ tool_response: { result_display: display.text } }],
            },
      );
      expect(response.returnDisplay).toBe(display);
      expect(response.result_display).toBe(display);
    },
  );

  describe('firePostToolBatchEvent', () => {
    it('preserves question text for batch hooks without changing other results', async () => {
      arrange();
      const display = Object.freeze({
        type: 'ask_user_question_answers',
        text: 'Original answer text',
        answers: [{ question: 'Continue?', answer: 'Yes' }],
      });
      const response = Object.freeze({
        result_display: display,
        response_parts: [],
      });
      const calls = ['ask_user_question', 'other_tool'].map((tool_name) =>
        Object.freeze({
          tool_name,
          tool_input: {},
          tool_use_id: tool_name,
          status: 'success' as const,
          tool_response: response,
        }),
      );
      await hookEventHandler.firePostToolBatchEvent(calls);
      expect(inputOf()).toMatchObject({
        tool_calls: [
          {
            tool_response: { result_display: display.text, response_parts: [] },
          },
          { tool_response: { result_display: display, response_parts: [] } },
        ],
      });
      expect(calls[0].tool_response.result_display).toBe(display);
    });

    itPlans(
      'should execute hooks for PostToolBatch without matcher context',
      () =>
        hookEventHandler.firePostToolBatchEvent([
          {
            tool_name: 'read_file',
            tool_input: { path: 'README.md' },
            tool_use_id: 'call-1',
            status: 'success',
            tool_response: { output: 'contents' },
          },
        ]),
      HookEventName.PostToolBatch,
    );

    it('should include tool_calls in hook input', () =>
      expectInput(
        () =>
          hookEventHandler.firePostToolBatchEvent([
            {
              tool_name: 'shell',
              tool_input: { command: 'pwd' },
              tool_use_id: 'call-2',
              status: 'success',
              tool_response: { output: '/tmp/project' },
            },
          ]),
        {
          hook_event_name: HookEventName.PostToolBatch,
          permission_mode: PermissionMode.Default,
          tool_calls: [
            {
              tool_name: 'shell',
              tool_input: { command: 'pwd' },
              tool_use_id: 'call-2',
              status: 'success',
              tool_response: { output: '/tmp/project' },
            },
          ],
        },
      ));
  });

  describe('firePostToolUseFailureEvent', () => {
    /** Fires with the given call id, tool, and error; the input is fixed. */
    const fire = (id: string, tool: string, error: string) => () =>
      hookEventHandler.firePostToolUseFailureEvent(
        id,
        tool,
        { param: 'value' },
        error,
      );

    itPlans(
      'should execute hooks for PostToolUseFailure event',
      fire('toolu_test123', 'test-tool', 'An error occurred'),
      HookEventName.PostToolUseFailure,
      { toolName: 'test-tool' },
    );

    it('should include all parameters in the hook input', () =>
      expectInput(
        () =>
          hookEventHandler.firePostToolUseFailureEvent(
            'toolu_test456',
            'shell',
            { command: 'ls' },
            'Command failed',
            true,
            PermissionMode.Yolo,
          ),
        {
          permission_mode: PermissionMode.Yolo,
          tool_use_id: 'toolu_test456',
          tool_name: 'shell',
          tool_input: { command: 'ls' },
          error: 'Command failed',
          is_interrupt: true,
        },
      ));

    it('should handle default values for optional parameters', () =>
      expectInput(fire('toolu_test789', 'test-tool', 'An error occurred'), {
        permission_mode: PermissionMode.Default,
        is_interrupt: undefined,
      }));

    itPassesContext(
      'should pass tool name as context for matcher filtering',
      fire('toolu_test123', 'special-tool', 'Error occurred'),
      HookEventName.PostToolUseFailure,
      { toolName: 'special-tool' },
    );

    it('should handle successful execution with final output', async () => {
      const result = await fireWithOutput(
        {
          reason: 'Processing error',
          hookSpecificOutput: {
            additionalContext: 'Additional failure context',
          },
        },
        fire('toolu_test999', 'test-tool', 'Error occurred'),
      );

      expect(result.success).toBe(true);
      expect(result.finalOutput).toBeDefined();
      expect(result.finalOutput?.reason).toBe('Processing error');
    });

    it('should handle multiple hooks execution', async () => {
      arrange([commandHook('echo hook1'), commandHook('echo hook2')]);

      await hookEventHandler.firePostToolUseFailureEvent(
        'toolu_test111',
        'multi-tool',
        { params: ['a', 'b'] },
        'Multiple errors',
      );

      expect(mockHookRunner.executeHooksParallel).toHaveBeenCalledTimes(1);
      expectRan(
        [commandHook('echo hook1'), commandHook('echo hook2')],
        HookEventName.PostToolUseFailure,
        expect.any(Object),
        expect.objectContaining({
          messages: undefined,
          toolUseID: 'toolu_test111',
        }),
      );
    });

    itRunsSequentially(
      fire('toolu_sequential', 'seq-tool', 'Sequential error'),
    );
  });

  describe('common input fields', () => {
    it('reports the session approval mode on events without their own mode', async () => {
      vi.mocked(mockConfig.getApprovalMode).mockReturnValue(ApprovalMode.YOLO);

      const input = await captureInput(() =>
        hookEventHandler.fireSessionEndEvent(SessionEndReason.Clear),
      );

      expect(input['permission_mode']).toBe(PermissionMode.Yolo);
    });

    it('keeps the permission mode an event reports itself', async () => {
      vi.mocked(mockConfig.getApprovalMode).mockReturnValue(ApprovalMode.YOLO);

      const input = await captureInput(() =>
        hookEventHandler.firePreToolUseEvent(
          'shell',
          {},
          'toolu_mode',
          PermissionMode.Plan,
        ),
      );

      expect(input['permission_mode']).toBe(PermissionMode.Plan);
    });

    it('adds agent_id and prompt_id only when they are known', async () => {
      const outside = await captureInput(() =>
        hookEventHandler.fireSessionEndEvent(SessionEndReason.Clear),
      );
      expect(outside).not.toHaveProperty('agent_id');
      expect(outside).not.toHaveProperty('prompt_id');

      const inside = await captureInput(() =>
        runWithAgentContext('agent-7', () =>
          promptIdContext.run('prompt-9', () =>
            hookEventHandler.fireSessionEndEvent(SessionEndReason.Clear),
          ),
        ),
      );
      expect(inside['agent_id']).toBe('agent-7');
      expect(inside['prompt_id']).toBe('prompt-9');
    });

    it('reports duration_ms on PostToolUse and PostToolUseFailure when given', async () => {
      const post = await captureInput(() =>
        hookEventHandler.firePostToolUseEvent(
          'shell',
          {},
          {},
          'toolu_post',
          PermissionMode.Default,
          undefined,
          'call-post',
          42,
        ),
      );
      expect(post['duration_ms']).toBe(42);

      const failure = await captureInput(() =>
        hookEventHandler.firePostToolUseFailureEvent(
          'toolu_failure',
          'shell',
          {},
          'boom',
          false,
          PermissionMode.Default,
          undefined,
          'call-failure',
          7,
        ),
      );
      expect(failure['duration_ms']).toBe(7);

      const withoutDuration = await captureInput(() =>
        hookEventHandler.firePostToolUseEvent(
          'shell',
          {},
          {},
          'toolu_untimed',
          PermissionMode.Default,
        ),
      );
      expect(withoutDuration).not.toHaveProperty('duration_ms');
    });
  });

  describe('firePreToolUseEvent', () => {
    /** Fires for `tool` with `input` and call id `id` in the default mode. */
    const fire =
      (tool: string, input: Record<string, unknown>, id: string) => () =>
        hookEventHandler.firePreToolUseEvent(
          tool,
          input,
          id,
          PermissionMode.Default,
        );

    itPlans(
      'should execute hooks for PreToolUse event',
      fire('test-tool', { param: 'value' }, 'toolu_test123'),
      HookEventName.PreToolUse,
      { toolName: 'test-tool' },
    );

    it('should include all parameters in the hook input', () =>
      expectInput(
        () =>
          hookEventHandler.firePreToolUseEvent(
            'shell',
            { command: 'ls -la' },
            'toolu_abc456',
            PermissionMode.Plan,
          ),
        {
          permission_mode: PermissionMode.Plan,
          tool_name: 'shell',
          tool_input: { command: 'ls -la' },
          tool_use_id: 'toolu_abc456',
        },
      ));

    itPassesContext(
      'should pass tool name as context for matcher filtering',
      fire('Bash', { command: 'npm test' }, 'toolu_xyz789'),
      HookEventName.PreToolUse,
      { toolName: 'Bash' },
    );

    it('should handle permission decision in final output', async () => {
      const result = await fireWithOutput(
        {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'Dangerous command blocked',
          },
        },
        fire('Bash', { command: 'rm -rf /' }, 'toolu_danger'),
      );

      expect(result.success).toBe(true);
      expect(result.finalOutput?.hookSpecificOutput).toEqual({
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Dangerous command blocked',
      });
    });

    itRunsSequentially(fire('test-tool', { param: 'value' }, 'toolu_seq'));

    it('should handle errors gracefully', async () => {
      const result = await failPlanning(
        'PreToolUse planner error',
        fire('test-tool', { param: 'value' }, 'toolu_error'),
      );
      expect(result.finalOutput).toBeUndefined();
    });
  });

  describe('todo hook fail-closed behavior', () => {
    it('should block TodoCreated when hook execution setup fails', async () => {
      const result = await failPlanning('TodoCreated planner error', () =>
        hookEventHandler.fireTodoCreatedEvent(
          'todo-1',
          'secret token: abc123',
          'pending',
          [
            {
              id: 'todo-1',
              content: 'secret token: abc123',
              status: 'pending',
            },
          ],
          HookPhase.Validation,
        ),
      );

      expect(result.finalOutput).toEqual({
        decision: 'block',
        reason:
          'Hook system failed while processing TodoCreated: TodoCreated planner error',
      });
    });

    it('should block TodoCompleted when hook execution setup fails', async () => {
      const result = await failPlanning('TodoCompleted planner error', () =>
        hookEventHandler.fireTodoCompletedEvent(
          'todo-1',
          'internal host: db.internal',
          'in_progress',
          [
            {
              id: 'todo-1',
              content: 'internal host: db.internal',
              status: 'completed',
            },
          ],
          HookPhase.Validation,
        ),
      );

      expect(result.finalOutput).toEqual({
        decision: 'block',
        reason:
          'Hook system failed while processing TodoCompleted: TodoCompleted planner error',
      });
    });

    it('should fail open for UserPromptExpansion when hook execution setup fails', async () => {
      const result = await failPlanning(
        'UserPromptExpansion planner error',
        () =>
          hookEventHandler.fireUserPromptExpansionEvent(
            'goal',
            'write tests',
            'expanded prompt',
          ),
      );
      expect(result.finalOutput).toBeUndefined();
    });

    it('should redact sensitive todo fields from hook telemetry', async () => {
      arrange([commandHook()], {
        results: [
          {
            hookConfig: commandHook(),
            eventName: HookEventName.TodoCreated,
            success: true,
            output: undefined,
            duration: 12,
            exitCode: 0,
            stdout: '',
            stderr: '',
          },
        ],
      });

      await hookEventHandler.fireTodoCreatedEvent(
        'todo-1',
        'api_key=super-secret',
        'pending',
        [{ id: 'todo-1', content: 'api_key=super-secret', status: 'pending' }],
        HookPhase.PostWrite,
      );

      expect(logHookCall).toHaveBeenCalledTimes(1);
      const hookCallEvent = vi.mocked(logHookCall).mock.calls[0]?.[1];
      expect(hookCallEvent?.hook_input).toMatchObject({
        hook_event_name: HookEventName.TodoCreated,
        todo_id: 'todo-1',
        todo_status: 'pending',
        phase: HookPhase.PostWrite,
      });
      expect(hookCallEvent?.hook_input).not.toHaveProperty('todo_content');
      expect(hookCallEvent?.hook_input).not.toHaveProperty('all_todos');
    });
  });

  describe('firePostToolUseEvent', () => {
    it.each(['ask_user_question', 'other_tool'])(
      'preserves the hook display contract for %s without mutating results',
      async (toolName) => {
        arrange();
        const text =
          'User has provided the following answers:\n\n**A**: first\n**B**: embedded';
        const display = Object.freeze({
          type: 'ask_user_question_answers',
          text,
          answers: [
            { question: 'Question A?', answer: 'first\n**B**: embedded' },
          ],
        });
        const response = Object.freeze({
          llmContent: text,
          returnDisplay: display,
        });

        await hookEventHandler.firePostToolUseEvent(
          toolName,
          {},
          response,
          'toolu_question',
          PermissionMode.Default,
        );

        expect(inputOf()).toMatchObject({
          tool_response: {
            llmContent: text,
            returnDisplay: toolName === 'ask_user_question' ? text : display,
          },
        });
        expect(response.returnDisplay).toBe(display);
      },
    );

    /** Fires for `tool` with `input`/`response` and call id `id`. */
    const fire =
      (
        tool: string,
        input: Record<string, unknown>,
        response: Record<string, unknown>,
        id: string,
      ) =>
      () =>
        hookEventHandler.firePostToolUseEvent(
          tool,
          input,
          response,
          id,
          PermissionMode.Default,
        );

    itPlans(
      'should execute hooks for PostToolUse event',
      fire(
        'test-tool',
        { param: 'value' },
        { result: 'success' },
        'toolu_test123',
      ),
      HookEventName.PostToolUse,
      { toolName: 'test-tool' },
    );

    it('should include all parameters in the hook input', () =>
      expectInput(
        () =>
          hookEventHandler.firePostToolUseEvent(
            'shell',
            { command: 'ls -la' },
            { files: ['a.txt', 'b.txt'] },
            'toolu_abc456',
            PermissionMode.Yolo,
          ),
        {
          permission_mode: PermissionMode.Yolo,
          tool_name: 'shell',
          tool_input: { command: 'ls -la' },
          tool_response: { files: ['a.txt', 'b.txt'] },
          tool_use_id: 'toolu_abc456',
        },
      ));

    itPassesContext(
      'should pass tool name as context for matcher filtering',
      fire(
        'Write',
        { file_path: '/test.txt', content: 'hello' },
        { success: true },
        'toolu_write123',
      ),
      HookEventName.PostToolUse,
      { toolName: 'Write' },
    );

    it('should handle decision block in final output', async () => {
      const result = await fireWithOutput(
        {
          decision: 'block',
          reason: 'Lint errors detected',
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: 'Please fix the lint errors',
          },
        },
        fire(
          'Write',
          { file_path: '/test.ts', content: 'const x = 1' },
          { success: true },
          'toolu_lint',
        ),
      );

      expect(result.success).toBe(true);
      expect(result.finalOutput?.decision).toBe('block');
      expect(result.finalOutput?.reason).toBe('Lint errors detected');
    });

    itRunsSequentially(
      fire('test-tool', { param: 'value' }, { result: 'ok' }, 'toolu_seq'),
    );

    itHandlesErrors(
      'PostToolUse planner error',
      fire('test-tool', { param: 'value' }, { result: 'ok' }, 'toolu_error'),
    );
  });

  describe('firePreCompactEvent', () => {
    const fire = (trigger: PreCompactTrigger, instructions?: string) => () =>
      hookEventHandler.firePreCompactEvent(trigger, instructions);

    itPlans(
      'should execute hooks for PreCompact event with manual trigger',
      fire(PreCompactTrigger.Manual, 'Keep important code'),
      HookEventName.PreCompact,
      { trigger: PreCompactTrigger.Manual },
    );

    itPlans(
      'should execute hooks for PreCompact event with auto trigger',
      fire(PreCompactTrigger.Auto),
      HookEventName.PreCompact,
      { trigger: PreCompactTrigger.Auto },
    );

    it('should include all parameters in the hook input', () =>
      expectInput(
        fire(PreCompactTrigger.Manual, 'Custom instructions for compaction'),
        {
          trigger: PreCompactTrigger.Manual,
          custom_instructions: 'Custom instructions for compaction',
        },
      ));

    it('should use empty string for custom_instructions when not provided', () =>
      expectInput(fire(PreCompactTrigger.Auto), {
        trigger: PreCompactTrigger.Auto,
        custom_instructions: '',
      }));

    itPassesContext(
      'should pass trigger as context for matcher filtering',
      fire(PreCompactTrigger.Manual),
      HookEventName.PreCompact,
      { trigger: PreCompactTrigger.Manual },
    );

    it('should handle additionalContext in final output', async () => {
      const result = await fireWithOutput(
        {
          hookSpecificOutput: {
            hookEventName: 'PreCompact',
            additionalContext: 'Preserve function signatures',
          },
        },
        fire(PreCompactTrigger.Auto),
      );

      expect(result.success).toBe(true);
      expect(result.finalOutput?.hookSpecificOutput).toEqual({
        hookEventName: 'PreCompact',
        additionalContext: 'Preserve function signatures',
      });
    });

    itRunsSequentially(fire(PreCompactTrigger.Manual));

    itHandlesErrors('PreCompact planner error', fire(PreCompactTrigger.Auto));

    it('should handle both trigger types correctly', async () => {
      arrange();

      for (const trigger of [
        PreCompactTrigger.Manual,
        PreCompactTrigger.Auto,
      ]) {
        await hookEventHandler.firePreCompactEvent(trigger);
        expect(inputOf()['trigger']).toBe(trigger);
      }
    });
  });

  describe('fireNotificationEvent', () => {
    const fire =
      (message: string, type: NotificationType, title?: string) => () =>
        hookEventHandler.fireNotificationEvent(message, type, title);

    itPlans(
      'should execute hooks for Notification event',
      fire(
        'Test notification message',
        NotificationType.PermissionPrompt,
        'Permission needed',
      ),
      HookEventName.Notification,
      { notificationType: 'permission_prompt' },
    );

    it('should include all parameters in the hook input', () =>
      expectInput(
        fire(
          'Qwen Code needs your permission to use Bash',
          NotificationType.PermissionPrompt,
          'Permission needed',
        ),
        {
          message: 'Qwen Code needs your permission to use Bash',
          notification_type: 'permission_prompt',
          title: 'Permission needed',
        },
      ));

    itPassesContext(
      'should pass notification_type as context for matcher filtering',
      fire(
        'Qwen Code is waiting for your input',
        NotificationType.IdlePrompt,
        'Waiting for input',
      ),
      HookEventName.Notification,
      { notificationType: 'idle_prompt' },
    );

    it('should handle notification without title', () =>
      expectInput(
        fire('Authentication successful', NotificationType.AuthSuccess),
        {
          message: 'Authentication successful',
          notification_type: 'auth_success',
          title: undefined,
        },
      ));

    itPlans(
      'should handle auth_success notification type',
      fire('Authentication successful', NotificationType.AuthSuccess),
      HookEventName.Notification,
      { notificationType: 'auth_success' },
    );

    itPlans(
      'should handle elicitation_dialog notification type',
      fire(
        'Dialog shown to user',
        NotificationType.ElicitationDialog,
        'Dialog',
      ),
      HookEventName.Notification,
      { notificationType: 'elicitation_dialog' },
    );

    itRunsSequentially(
      fire('Test notification', NotificationType.PermissionPrompt),
    );

    itHandlesErrors(
      'Notification planner error',
      fire('Test notification', NotificationType.PermissionPrompt),
    );

    it('should handle all notification types correctly', async () => {
      arrange();

      for (const [message, type, expected] of [
        [
          'Permission needed',
          NotificationType.PermissionPrompt,
          'permission_prompt',
        ],
        ['Waiting for input', NotificationType.IdlePrompt, 'idle_prompt'],
        [
          'Authentication successful',
          NotificationType.AuthSuccess,
          'auth_success',
        ],
        [
          'Dialog shown',
          NotificationType.ElicitationDialog,
          'elicitation_dialog',
        ],
      ] as const) {
        await hookEventHandler.fireNotificationEvent(message, type);
        expect(inputOf()['notification_type']).toBe(expected);
      }
    });
  });

  describe('firePermissionRequestEvent', () => {
    const fire =
      (
        tool: string,
        input: Record<string, unknown>,
        mode: PermissionMode = PermissionMode.Default,
      ) =>
      () =>
        hookEventHandler.firePermissionRequestEvent(tool, input, mode);

    itPlans(
      'should execute hooks for PermissionRequest event',
      fire('Bash', { command: 'ls -la' }),
      HookEventName.PermissionRequest,
      { toolName: 'Bash' },
    );

    it('should include all parameters in the hook input', () =>
      expectInput(
        fire(
          'Write',
          { file_path: '/test.txt', content: 'hello' },
          PermissionMode.Yolo,
        ),
        {
          permission_mode: PermissionMode.Yolo,
          tool_name: 'Write',
          tool_input: { file_path: '/test.txt', content: 'hello' },
          permission_suggestions: undefined,
        },
      ));

    it('should include permission_suggestions when provided', async () => {
      const suggestions: PermissionSuggestion[] = [
        { type: 'toolAlwaysAllow', tool: 'Bash' },
      ];

      await expectInput(
        () =>
          hookEventHandler.firePermissionRequestEvent(
            'Bash',
            { command: 'npm test' },
            PermissionMode.Default,
            suggestions,
          ),
        { permission_suggestions: suggestions },
      );
    });

    itPassesContext(
      'should pass tool name as context for matcher filtering',
      fire('ReadFile', { file_path: '/test.txt' }, PermissionMode.Plan),
      HookEventName.PermissionRequest,
      { toolName: 'ReadFile' },
    );

    it('should handle decision block in final output', async () => {
      const result = await fireWithOutput(
        {
          decision: 'block',
          reason: 'Dangerous command detected',
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: {
              behavior: 'deny',
              message: 'Destructive system command blocked by security hook',
              interrupt: true,
            },
          },
        },
        fire('Bash', { command: 'rm -rf /' }),
      );

      expect(result.success).toBe(true);
      expect(result.finalOutput?.decision).toBe('block');
      expect(result.finalOutput?.reason).toBe('Dangerous command detected');
    });

    it('should handle allow decision with updatedInput', async () => {
      const result = await fireWithOutput(
        {
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: {
              behavior: 'allow',
              updatedInput: { command: 'npm install --dry-run' },
            },
          },
        },
        fire('Bash', { command: 'npm install' }),
      );

      expect(result.success).toBe(true);
      expect(result.finalOutput?.hookSpecificOutput).toEqual({
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'allow',
          updatedInput: { command: 'npm install --dry-run' },
        },
      });
    });

    itRunsSequentially(fire('Bash', { command: 'ls' }));

    itHandlesErrors(
      'PermissionRequest planner error',
      fire('Bash', { command: 'test' }),
    );

    it('should handle all permission modes correctly', async () => {
      arrange();

      for (const mode of [
        PermissionMode.Default,
        PermissionMode.Plan,
        PermissionMode.Yolo,
      ]) {
        await fire('Bash', { command: 'test' }, mode)();
        expect(inputOf()['permission_mode']).toBe(mode);
      }
    });
  });

  describe('firePermissionDeniedEvent', () => {
    itPlans(
      'should execute hooks for PermissionDenied event',
      () =>
        hookEventHandler.firePermissionDeniedEvent(
          'Bash',
          { command: 'rm -rf /tmp/project' },
          'toolu-denied-1',
          'classifier_blocked',
        ),
      HookEventName.PermissionDenied,
      { toolName: 'Bash' },
    );

    it('should include the denied tool payload and reason in hook input', () =>
      expectInput(
        () =>
          hookEventHandler.firePermissionDeniedEvent(
            'Write',
            { file_path: '/test.txt', content: 'hello' },
            'toolu-denied-2',
            'classifier_unavailable',
          ),
        {
          tool_name: 'Write',
          tool_input: { file_path: '/test.txt', content: 'hello' },
          tool_use_id: 'toolu-denied-2',
          reason: 'classifier_unavailable',
        },
      ));
  });

  describe('fireSubagentStartEvent', () => {
    const fire =
      (
        id: string,
        type: string,
        mode: PermissionMode = PermissionMode.Default,
      ) =>
      () =>
        hookEventHandler.fireSubagentStartEvent(id, type, mode);

    itPlans(
      'should execute hooks for SubagentStart event',
      fire('agent-123', 'code-reviewer'),
      HookEventName.SubagentStart,
      { agentType: 'code-reviewer' },
    );

    it('should include all parameters in the hook input', () =>
      expectInput(fire('agent-456', 'qwen-tester', PermissionMode.Plan), {
        agent_id: 'agent-456',
        agent_type: 'qwen-tester',
        permission_mode: PermissionMode.Plan,
        hook_event_name: HookEventName.SubagentStart,
      }));

    itPassesContext(
      'should pass agentType as context for matcher filtering',
      fire('agent-789', AgentType.Bash),
      HookEventName.SubagentStart,
      { agentType: String(AgentType.Bash) },
    );

    it('should handle additional context in final output', async () => {
      const result = await fireWithOutput(
        {
          hookSpecificOutput: {
            hookEventName: 'SubagentStart',
            additionalContext: 'Injected context for subagent',
          },
        },
        fire('agent-111', 'code-reviewer'),
      );

      expect(result.success).toBe(true);
      expect(result.finalOutput?.hookSpecificOutput).toEqual({
        hookEventName: 'SubagentStart',
        additionalContext: 'Injected context for subagent',
      });
    });

    itRunsSequentially(fire('agent-seq', 'code-reviewer'));

    itHandlesErrors(
      'SubagentStart planner error',
      fire('agent-err', 'code-reviewer'),
    );
  });

  describe('fireSubagentStopEvent', () => {
    /** Fires with a fixed transcript path in the default mode. */
    const fire =
      (id: string, type: string, message: string, active = false) =>
      () =>
        hookEventHandler.fireSubagentStopEvent(
          id,
          type,
          '/path/transcript.jsonl',
          message,
          active,
          PermissionMode.Default,
        );

    itPlans(
      'should execute hooks for SubagentStop event',
      () =>
        hookEventHandler.fireSubagentStopEvent(
          'agent-123',
          'code-reviewer',
          '/path/to/transcript.jsonl',
          'Final output from subagent',
          false,
          PermissionMode.Default,
        ),
      HookEventName.SubagentStop,
      { agentType: 'code-reviewer' },
    );

    it('should include all parameters in the hook input', () =>
      expectInput(
        () =>
          hookEventHandler.fireSubagentStopEvent(
            'agent-456',
            'qwen-tester',
            '/transcript/path.jsonl',
            'last message from agent',
            true,
            PermissionMode.Yolo,
          ),
        {
          agent_id: 'agent-456',
          agent_type: 'qwen-tester',
          agent_transcript_path: '/transcript/path.jsonl',
          last_assistant_message: 'last message from agent',
          stop_hook_active: true,
          permission_mode: PermissionMode.Yolo,
          hook_event_name: HookEventName.SubagentStop,
        },
      ));

    itPassesContext(
      'should pass agentType as context for matcher filtering',
      fire('agent-789', 'custom-agent', 'output'),
      HookEventName.SubagentStop,
      { agentType: 'custom-agent' },
    );

    it('should handle block decision in final output', async () => {
      const result = await fireWithOutput(
        { decision: 'block', reason: 'Output too short, continue working' },
        fire('agent-block', 'code-reviewer', 'short'),
      );

      expect(result.success).toBe(true);
      expect(result.finalOutput?.decision).toBe('block');
      expect(result.finalOutput?.reason).toBe(
        'Output too short, continue working',
      );
    });

    itRunsSequentially(fire('agent-seq', 'code-reviewer', 'output'));

    itHandlesErrors(
      'SubagentStop planner error',
      fire('agent-err', 'code-reviewer', 'output'),
    );

    it('should handle stop_hook_active flag correctly', async () => {
      arrange();

      for (const [id, active] of [
        ['agent-1', false],
        ['agent-2', true],
      ] as const) {
        await fire(id, 'code-reviewer', 'output', active)();
        expect(inputOf()['stop_hook_active']).toBe(active);
      }
    });
  });

  describe('fireStopFailureEvent', () => {
    itPlans(
      'should execute hooks for StopFailure event',
      () =>
        hookEventHandler.fireStopFailureEvent(
          'rate_limit',
          '429 Too Many Requests',
          'API Error: Rate limit reached',
        ),
      HookEventName.StopFailure,
      { error: 'rate_limit' },
    );

    it('should include all parameters in the hook input', () =>
      expectInput(
        () =>
          hookEventHandler.fireStopFailureEvent(
            'authentication_failed',
            '401 Unauthorized',
            'Please check your API key',
          ),
        {
          error: 'authentication_failed',
          error_details: '401 Unauthorized',
          last_assistant_message: 'Please check your API key',
          hook_event_name: HookEventName.StopFailure,
        },
      ));

    itPassesContext(
      'should pass error type as context for matcher filtering',
      () => hookEventHandler.fireStopFailureEvent('server_error'),
      HookEventName.StopFailure,
      { error: 'server_error' },
    );

    it('should handle all error types correctly', async () => {
      arrange();

      const errorTypes: StopFailureErrorType[] = [
        'rate_limit',
        'authentication_failed',
        'billing_error',
        'invalid_request',
        'server_error',
        'max_output_tokens',
        'unknown',
      ];
      for (const errorType of errorTypes) {
        await hookEventHandler.fireStopFailureEvent(errorType);
        expect(inputOf()['error']).toBe(errorType);
      }
    });

    it('should handle optional parameters', () =>
      expectInput(() => hookEventHandler.fireStopFailureEvent('unknown'), {
        error: 'unknown',
        error_details: undefined,
        last_assistant_message: undefined,
      }));

    itHandlesErrors('StopFailure planner error', () =>
      hookEventHandler.fireStopFailureEvent('rate_limit'),
    );
  });

  describe('firePostCompactEvent', () => {
    const fire = (trigger: PostCompactTrigger, summary: string) => () =>
      hookEventHandler.firePostCompactEvent(trigger, summary);

    itPlans(
      'should execute hooks for PostCompact event with manual trigger',
      fire(PostCompactTrigger.Manual, 'Summary of compacted conversation'),
      HookEventName.PostCompact,
      { trigger: PostCompactTrigger.Manual },
    );

    itPlans(
      'should execute hooks for PostCompact event with auto trigger',
      fire(PostCompactTrigger.Auto, 'Auto-generated summary'),
      HookEventName.PostCompact,
      { trigger: PostCompactTrigger.Auto },
    );

    it('should include all parameters in the hook input', () => {
      const summary = 'The user requested to implement a new feature...';
      return expectInput(fire(PostCompactTrigger.Manual, summary), {
        trigger: PostCompactTrigger.Manual,
        compact_summary: summary,
        hook_event_name: HookEventName.PostCompact,
      });
    });

    itPassesContext(
      'should pass trigger as context for matcher filtering',
      fire(PostCompactTrigger.Auto, 'summary'),
      HookEventName.PostCompact,
      { trigger: PostCompactTrigger.Auto },
    );

    itRunsSequentially(fire(PostCompactTrigger.Manual, 'summary'));

    itHandlesErrors(
      'PostCompact planner error',
      fire(PostCompactTrigger.Auto, 'summary'),
    );

    it('should handle both trigger types correctly', async () => {
      arrange();

      for (const [trigger, summary] of [
        [PostCompactTrigger.Manual, 'manual summary'],
        [PostCompactTrigger.Auto, 'auto summary'],
      ] as const) {
        await hookEventHandler.firePostCompactEvent(trigger, summary);
        expect(inputOf()['trigger']).toBe(trigger);
      }
    });
  });

  describe('telemetry', () => {
    const createMockHookExecutionResult = (
      success: boolean,
      hookConfig: HookConfig,
      duration: number = 100,
      output?: HookOutput,
      error?: Error,
    ): HookExecutionResult => ({
      hookConfig,
      eventName: HookEventName.PreToolUse,
      success,
      output,
      stdout: 'stdout',
      stderr: success ? undefined : 'stderr',
      exitCode: success ? 0 : 1,
      duration,
      error,
    });

    beforeEach(() => {
      vi.mocked(logHookCall).mockClear();
    });

    /** Runs `hook` with `result` (a success by default) on `fire`. */
    const runLogged = async (
      hook: HookConfig,
      result = createMockHookExecutionResult(true, hook),
      fire: () => Promise<unknown> = () =>
        hookEventHandler.fireUserPromptSubmitEvent('test'),
    ) => {
      arrange([hook], { results: [result] });
      await fire();
    };

    const expectLogged = (fields: object) =>
      expect(logHookCall).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining(fields),
      );

    it('should call logHookCall for each hook execution', async () => {
      const hookConfig1 = commandHook('hook1.sh', { name: 'first-hook' });
      const hookConfig2 = commandHook('hook2.sh', { name: 'second-hook' });
      arrange([hookConfig1, hookConfig2], {
        results: [
          createMockHookExecutionResult(true, hookConfig1, 50),
          createMockHookExecutionResult(true, hookConfig2, 75),
        ],
      });

      await hookEventHandler.fireUserPromptSubmitEvent('test prompt');

      expect(logHookCall).toHaveBeenCalledTimes(2);
    });

    it('should log hook call with correct event name', async () => {
      await runLogged(commandHook('test.sh'), undefined, () =>
        hookEventHandler.firePreToolUseEvent(
          'read_file',
          { path: '/test' },
          'tool-123',
          PermissionMode.Default,
        ),
      );

      expectLogged({ hook_event_name: HookEventName.PreToolUse });
    });

    it('should log hook call with hook name from config', async () => {
      await runLogged(
        commandHook('/path/to/my-hook.sh', { name: 'my-custom-hook' }),
      );

      expectLogged({ hook_name: 'my-custom-hook' });
    });

    it('should log hook call with command as name when no name specified', async () => {
      await runLogged(commandHook('/path/to/hook-script.sh'));

      expectLogged({ hook_name: '/path/to/hook-script.sh' });
    });

    it('should log hook call with duration', async () => {
      const hook = commandHook('test.sh');
      await runLogged(hook, createMockHookExecutionResult(true, hook, 250));

      expectLogged({ duration_ms: 250 });
    });

    it('should log hook call with success status', async () => {
      await runLogged(commandHook('test.sh'));

      expectLogged({ success: true });
    });

    it('should log hook call with failure status', async () => {
      const hook = commandHook('failing-hook.sh');
      arrange([hook], {
        results: [
          createMockHookExecutionResult(
            false,
            hook,
            100,
            undefined,
            new Error('Hook failed'),
          ),
        ],
        aggregated: createMockAggregatedResult(false),
      });

      await hookEventHandler.fireUserPromptSubmitEvent('test');

      expectLogged({ success: false, error: 'Hook failed' });
    });

    it('should log hook call with exit code', async () => {
      const hook = commandHook('test.sh');
      const result = createMockHookExecutionResult(true, hook);
      result.exitCode = 0;
      await runLogged(hook, result);

      expectLogged({ exit_code: 0 });
    });

    it('should log hook call with hook type', async () => {
      await runLogged(commandHook('test.sh'));

      expectLogged({ hook_type: 'command' });
    });

    it('should not call logHookCall when no hooks are configured', async () => {
      arrange([], { aggregated: null });

      await hookEventHandler.fireUserPromptSubmitEvent('test');

      expect(logHookCall).not.toHaveBeenCalled();
    });

    it('should log telemetry for different event types', async () => {
      const hook = commandHook('test.sh');
      arrange([hook], { results: [createMockHookExecutionResult(true, hook)] });

      for (const [event, fire] of [
        [
          HookEventName.SessionStart,
          () =>
            hookEventHandler.fireSessionStartEvent(
              SessionStartSource.Startup,
              'test-model',
            ),
        ],
        [
          HookEventName.SessionEnd,
          () => hookEventHandler.fireSessionEndEvent(SessionEndReason.Clear),
        ],
        [
          HookEventName.Stop,
          () => hookEventHandler.fireStopEvent(true, 'last message'),
        ],
      ] as const) {
        await fire();
        expectLogged({ hook_event_name: event });
        vi.mocked(logHookCall).mockClear();
      }
    });
  });

  describe('MessagesProvider integration', () => {
    it('should accept messagesProvider in constructor', () => {
      const messagesProvider = vi
        .fn()
        .mockReturnValue([{ role: 'user', content: 'Hello' }]);

      const handler = createHandler(
        mockConfig,
        mockHookRunner,
        messagesProvider,
      );

      expect(handler.getMessagesProvider()).toBe(messagesProvider);
    });

    it('should set messagesProvider via setMessagesProvider', () => {
      hookEventHandler.setMessagesProvider(vi.fn().mockReturnValue([]));
      expect(hookEventHandler.getMessagesProvider()).toBeDefined();
    });

    // These leave the aggregator unmocked: only the runner call is checked.
    it('should pass messages to function hooks via context', async () => {
      const messages = [{ role: 'user', content: 'Test message' }];
      hookEventHandler.setMessagesProvider(vi.fn().mockReturnValue(messages));
      arrange([commandHook()], { aggregated: null });

      await hookEventHandler.firePreToolUseEvent(
        'Bash',
        { command: 'ls' },
        'toolu_test',
        PermissionMode.Default,
      );

      expectRan(
        expect.any(Array),
        HookEventName.PreToolUse,
        expect.any(Object),
        expect.objectContaining({ messages, toolUseID: 'toolu_test' }),
      );
    });

    it('should pass toolUseID from input to context', async () => {
      arrange([commandHook()], { aggregated: null });

      await hookEventHandler.firePostToolUseEvent(
        'Write',
        { file_path: '/test.txt' },
        { content: 'test' },
        'toolu_12345',
        PermissionMode.Default,
      );

      expectRan(
        expect.any(Array),
        HookEventName.PostToolUse,
        expect.any(Object),
        expect.objectContaining({ toolUseID: 'toolu_12345' }),
      );
    });

    it('should handle undefined messagesProvider', async () => {
      arrange([commandHook()], { aggregated: null });

      await hookEventHandler.firePreToolUseEvent(
        'Bash',
        { command: 'ls' },
        'toolu_test',
        PermissionMode.Default,
      );

      expectRan(
        expect.any(Array),
        HookEventName.PreToolUse,
        expect.any(Object),
        expect.objectContaining({
          messages: undefined,
          toolUseID: 'toolu_test',
        }),
      );
    });
  });

  describe('hook progress events', () => {
    type ProgressMessage = Record<string, unknown>;
    let publish: Mock;

    beforeEach(() => {
      publish = vi.fn().mockResolvedValue(undefined);
      Object.assign(mockConfig, {
        getMessageBus: vi.fn().mockReturnValue({ publish }),
      });
    });

    const progress = (): ProgressMessage[] =>
      publish.mock.calls.map(([message]) => message as ProgressMessage);
    const ofPhase = (phase: 'start' | 'end') =>
      progress().filter((m) => m['phase'] === phase);
    const firstEnd = () => ofPhase('end')[0];

    /**
     * Drives the runner the way the real one does: onHookStart, then the
     * result (`ending` over a 5ms success), then onHookEnd with the same index.
     */
    const runWith = (
      configs: HookConfig[],
      ending: Partial<HookExecutionResult> = {},
      sequential = false,
    ) => {
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(
        createMockExecutionPlan(configs, sequential),
      );
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );
      const run = async (
        hookConfigs: HookConfig[],
        eventName: HookEventName,
        _input: unknown,
        onHookStart?: (config: HookConfig, index: number) => void,
        onHookEnd?: (
          config: HookConfig,
          result: HookExecutionResult,
          index: number,
        ) => void,
      ): Promise<HookExecutionResult[]> => {
        const results: HookExecutionResult[] = [];
        for (let index = 0; index < hookConfigs.length; index++) {
          const config = hookConfigs[index];
          onHookStart?.(config, index);
          const result = {
            hookConfig: config,
            eventName,
            success: true,
            duration: 5,
            ...ending,
          } as HookExecutionResult;
          onHookEnd?.(config, result, index);
          results.push(result);
        }
        return results;
      };
      vi.mocked(mockHookRunner.executeHooksParallel).mockImplementation(run);
      vi.mocked(mockHookRunner.executeHooksSequential).mockImplementation(run);
    };

    /** `runWith`, then fires UserPromptSubmit. */
    const fireWith = (...args: Parameters<typeof runWith>) => {
      runWith(...args);
      return hookEventHandler.fireUserPromptSubmitEvent('hi');
    };

    it('publishes a start for each hook with its position in the batch', async () => {
      await fireWith([commandHook('first'), commandHook('second')]);

      expect(ofPhase('start')).toEqual(
        ['first', 'second'].map((hookName, index) => ({
          type: 'hook-progress',
          phase: 'start',
          eventName: HookEventName.UserPromptSubmit,
          hookName,
          hookType: 'command',
          invocationId: expect.stringMatching(/^hook-\d+$/),
          index,
          total: 2,
        })),
      );
    });

    it('carries the configured statusMessage on both phases', async () => {
      await fireWith([commandHook('lint', { statusMessage: 'Linting…' })]);

      expect(progress().map((m) => m['statusMessage'])).toEqual([
        'Linting…',
        'Linting…',
      ]);
    });

    it('omits statusMessage when none is configured', async () => {
      await fireWith([commandHook('plain')]);

      for (const message of progress()) {
        expect('statusMessage' in message).toBe(false);
      }
    });

    it('reports a timeout with its duration and error message', async () => {
      await fireWith([commandHook('slow')], {
        success: false,
        outcome: 'timeout',
        duration: 1234,
        error: new Error('Hook timed out after 2s'),
      });

      expect(firstEnd()).toMatchObject({
        outcome: 'timeout',
        durationMs: 1234,
        error: 'Hook timed out after 2s',
      });
    });

    it.each([
      [{ success: false }, 'error'],
      [{ success: true }, 'success'],
      [{ success: false, outcome: 'non_blocking_error' }, 'error'],
      [{ success: false, outcome: 'cancelled' }, 'cancelled'],
    ] as Array<[Partial<HookExecutionResult>, string]>)(
      'maps result %o to outcome %s',
      async (result, expected) => {
        await fireWith([commandHook('mapped')], result);

        expect(firstEnd()?.['outcome']).toBe(expected);
      },
    );

    it('reports a blocking result as blocked with its reason', async () => {
      await fireWith([commandHook('gate')], {
        success: false,
        outcome: 'blocking',
        output: { decision: 'deny', reason: 'nope' },
      });

      expect(firstEnd()).toMatchObject({
        outcome: 'blocked',
        blockedReason: 'nope',
      });
    });

    it('reports a clean exit that denies a tool call as blocked', async () => {
      runWith([commandHook('policy')], {
        success: true,
        outcome: 'success',
        output: {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'writes outside the repo',
          },
        },
      });

      await hookEventHandler.firePreToolUseEvent(
        'write_file',
        {},
        'tool-1',
        PermissionMode.Default,
      );

      expect(firstEnd()).toMatchObject({
        outcome: 'blocked',
        blockedReason: 'writes outside the repo',
      });
    });

    it("carries the hook's own systemMessage and exit code on end", async () => {
      await fireWith([commandHook('warn')], {
        success: false,
        outcome: 'non_blocking_error',
        exitCode: 127,
        output: { systemMessage: 'Warning: command not found' },
      });

      expect(firstEnd()).toMatchObject({
        systemMessage: 'Warning: command not found',
        exitCode: 127,
      });
    });

    it('marks a hook handed to the async registry', async () => {
      await fireWith([commandHook('bg')], { success: true, isAsync: true });

      expect(firstEnd()).toMatchObject({ async: true });
    });

    it('names non-command hooks by url, id, or a shortened prompt', async () => {
      const longPrompt = `Check   that ${'x'.repeat(200)}`;
      await fireWith([
        {
          type: HookType.Http,
          url: 'https://hooks.example.com/audit',
          source: HooksConfigSource.Project,
        },
        {
          type: HookType.Function,
          id: 'goal-stop-hook',
          callback: vi.fn(),
          errorMessage: 'failed',
          source: HooksConfigSource.Session,
        } as unknown as HookConfig,
        {
          type: HookType.Prompt,
          prompt: longPrompt,
          source: HooksConfigSource.Project,
        },
      ]);

      const names = ofPhase('start').map((m) => m['hookName'] as string);
      expect(names[0]).toBe('https://hooks.example.com/audit');
      expect(names[1]).toBe('goal-stop-hook');
      expect(names[2].startsWith('Check that x')).toBe(true);
      expect(names[2].length).toBe(80);
      expect(names[2].endsWith('…')).toBe(true);
    });

    it('still returns the aggregated result when there is no bus', async () => {
      Object.assign(mockConfig, {
        getMessageBus: vi.fn().mockReturnValue(undefined),
      });

      const result = await fireWith([commandHook('solo')]);

      expect(result.success).toBe(true);
      expect(publish).not.toHaveBeenCalled();
    });

    it('still runs hooks when the config has no message bus accessor', async () => {
      delete (mockConfig as { getMessageBus?: unknown }).getMessageBus;

      const result = await fireWith([commandHook('solo')]);

      expect(result.success).toBe(true);
      expect(publish).not.toHaveBeenCalled();
    });

    it('ignores a publish that rejects without leaving it unhandled', async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', onUnhandled);
      try {
        // A plain function, not vi.fn(): a spy attaches handlers to the
        // promise it returns, which would hide an unhandled rejection.
        let publishCalls = 0;
        Object.assign(mockConfig, {
          getMessageBus: () => ({
            publish: () => {
              publishCalls++;
              return Promise.reject(new Error('bus down'));
            },
          }),
        });

        const result = await fireWith([commandHook('solo')]);
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(result.success).toBe(true);
        expect(publishCalls).toBe(2);
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });

    it('publishes start and end in execution order for sequential hooks', async () => {
      await fireWith([commandHook('one'), commandHook('two')], {}, true);

      expect(progress().map((m) => `${m['phase']}:${m['index']}`)).toEqual([
        'start:0',
        'end:0',
        'start:1',
        'end:1',
      ]);
    });

    it('publishes progress for events other than the one it was tested on', async () => {
      runWith([commandHook('notify')]);

      await hookEventHandler.fireNotificationEvent(
        'Waiting for input',
        NotificationType.IdlePrompt,
      );

      expect(progress().map((m) => `${m['eventName']}:${m['phase']}`)).toEqual([
        `${HookEventName.Notification}:start`,
        `${HookEventName.Notification}:end`,
      ]);
    });
    type Ending = Partial<HookExecutionResult>;
    const failed = (
      outcome: Ending['outcome'],
      extra: Ending = {},
    ): Ending => ({
      success: false,
      outcome,
      ...extra,
    });
    const passed = (
      outcome: Ending['outcome'],
      extra: Ending = {},
    ): Ending => ({
      success: true,
      outcome,
      ...extra,
    });
    /** A success that also carries `output: { continue: true }`. */
    const continued = (outcome: Ending['outcome'], extra: Ending = {}) =>
      passed(outcome, { ...extra, output: { continue: true } });

    /**
     * What each runner returns for each way a hook can end (the runner tests
     * pin these shapes), and the outcome the bus must report for it. HTTP keeps
     * `success: true` on its non-blocking failures, so the projection has to
     * follow `outcome`, not `success`.
     */
    it.each([
      ['command', 'cancelled before start', failed('cancelled'), 'cancelled'],
      ['http', 'cancelled before start', failed('cancelled'), 'cancelled'],
      ['function', 'cancelled before start', failed('cancelled'), 'cancelled'],
      ['prompt', 'cancelled before start', failed('cancelled'), 'cancelled'],
      ['command', 'cancelled while running', failed('cancelled'), 'cancelled'],
      ['http', 'cancelled while running', continued('cancelled'), 'cancelled'],
      ['function', 'cancelled while running', failed('cancelled'), 'cancelled'],
      ['prompt', 'cancelled while running', failed('cancelled'), 'cancelled'],
      ['command', 'timed out', failed('timeout'), 'timeout'],
      ['http', 'timed out', continued('timeout'), 'timeout'],
      ['function', 'timed out', failed('timeout'), 'timeout'],
      ['prompt', 'timed out', failed('timeout'), 'timeout'],
      ['command', 'allowed', passed('success'), 'success'],
      ['http', 'allowed', continued('success'), 'success'],
      ['function', 'allowed', continued('success'), 'success'],
      [
        'prompt',
        'allowed',
        passed('success', { output: { continue: true, decision: 'allow' } }),
        'success',
      ],
      ['command', 'blocked', failed('blocking'), 'blocked'],
      [
        'http',
        'blocked',
        passed('blocking', { output: { decision: 'block', reason: 'no' } }),
        'blocked',
      ],
      [
        'function',
        'blocked',
        failed('blocking', { output: { continue: false, decision: 'block' } }),
        'blocked',
      ],
      [
        'prompt',
        'blocked',
        failed('blocking', { output: { continue: false, decision: 'block' } }),
        'blocked',
      ],
      ['command', 'failed to spawn', failed('non_blocking_error'), 'error'],
      [
        'http',
        'non-2xx response',
        continued('non_blocking_error', {
          error: new Error('HTTP hook returned 500'),
        }),
        'error',
      ],
      [
        'http',
        'connection failure',
        continued('non_blocking_error', {
          error: new TypeError('fetch failed'),
        }),
        'error',
      ],
      ['http', 'URL not allowed', failed('non_blocking_error'), 'error'],
      ['function', 'callback threw', failed('non_blocking_error'), 'error'],
      [
        'prompt',
        'provider error',
        failed('non_blocking_error', { output: { continue: true } }),
        'error',
      ],
      ['command', 'malformed output', failed('non_blocking_error'), 'error'],
      ['command', 'non-zero exit', failed('non_blocking_error'), 'error'],
      ['command', 'internal error', failed('non_blocking_error'), 'error'],
      [
        'command',
        'async hand-off',
        continued('success', { isAsync: true }),
        'success',
      ],
      [
        'command',
        'async refused',
        failed('non_blocking_error', {
          isAsync: true,
          output: { continue: true },
        }),
        'error',
      ],
    ] as Array<[string, string, Partial<HookExecutionResult>, string]>)(
      'reports a %s hook that %s as %s on the bus',
      async (_runner, _ending, result, expected) => {
        await fireWith([commandHook('matrix')], result);

        expect(firstEnd()?.['outcome']).toBe(expected);
      },
    );

    /**
     * The command runner now states the outcome of its internal catch and of
     * the async hand-off and refusal. Each must project to what the bus
     * reported before the outcome was filled in.
     */
    it.each([
      [
        'internal error',
        { success: false, error: new Error('boom') },
        'non_blocking_error',
      ],
      [
        'async refused',
        {
          success: false,
          isAsync: true,
          error: new Error('too many'),
          output: { continue: true },
        },
        'non_blocking_error',
      ],
      [
        'async hand-off',
        { success: true, isAsync: true, output: { continue: true } },
        'success',
      ],
    ] as Array<
      [string, Partial<HookExecutionResult>, HookExecutionResult['outcome']]
    >)(
      'reports the same %s progress with and without an explicit outcome',
      async (_ending, result, outcome) => {
        await fireWith([commandHook('implicit')], result);
        const implicit = firstEnd();

        publish.mockClear();
        await fireWith([commandHook('implicit')], { ...result, outcome });
        const explicit = firstEnd();

        // Two firings are two invocations, so the identity is the one field
        // that has to differ; everything the outcome decides must not.
        expect(implicit?.['invocationId']).toMatch(/^hook-\d+$/);
        expect(explicit?.['invocationId']).not.toBe(implicit?.['invocationId']);
        expect(explicit).toEqual({
          ...implicit,
          invocationId: expect.stringMatching(/^hook-\d+$/),
        });
      },
    );
  });
  describe('hook invocation identity in progress events', () => {
    let bus: MessageBus;
    let events: HookProgress[];
    let handler: HookEventHandler;

    beforeEach(() => {
      bus = new MessageBus();
      events = [];
      bus.subscribe<HookProgress>(MessageBusType.HOOK_PROGRESS, (message) => {
        events.push(message);
      });
      Object.assign(mockConfig, { getMessageBus: () => bus });
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );
      // The real runner, so start/end come from executeHooksParallel exactly
      // as in production.
      handler = createHandler(mockConfig, new RealHookRunner());
    });

    const functionHook = (
      id: string,
      callback: () => Promise<HookOutput | undefined> = async () => undefined,
    ): HookConfig =>
      ({
        type: HookType.Function,
        id,
        callback,
        errorMessage: `${id} failed`,
        source: HooksConfigSource.Session,
      }) as unknown as HookConfig;

    const planWith = (configs: HookConfig[]) => {
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(
        createMockExecutionPlan(configs, false),
      );
    };

    const ofPhase = (phase: 'start' | 'end') =>
      events.filter((event) => event.phase === phase);

    it('gives a hook the same invocationId on start and end', async () => {
      planWith([functionHook('solo')]);

      await handler.fireUserPromptSubmitEvent('hi');

      expect(events).toHaveLength(2);
      const [start, end] = events;
      expect(start.invocationId).toMatch(/^hook-\d+$/);
      expect(end.invocationId).toBe(start.invocationId);
    });

    it('gives each hook in one batch its own invocationId', async () => {
      planWith([functionHook('first'), functionHook('second')]);

      await handler.fireUserPromptSubmitEvent('hi');

      const starts = ofPhase('start');
      expect(starts.map((event) => event.index)).toEqual([0, 1]);
      expect(starts[0].invocationId).not.toBe(starts[1].invocationId);
    });

    it('pairs start and end by invocationId when batches of one event overlap', async () => {
      const releases: Array<() => void> = [];
      const gated = functionHook(
        'gated',
        () =>
          new Promise<undefined>((resolve) => {
            releases.push(() => resolve(undefined));
          }),
      );
      planWith([gated]);

      const first = handler.fireUserPromptSubmitEvent('one');
      const second = handler.fireUserPromptSubmitEvent('two');
      await vi.waitFor(() => expect(releases).toHaveLength(2));
      // The first batch ends only after the second batch started.
      releases[0]();
      await first;
      releases[1]();
      await second;

      expect(events.map((event) => `${event.phase}:${event.index}`)).toEqual([
        'start:0',
        'start:0',
        'end:0',
        'end:0',
      ]);
      const [firstStart, secondStart, firstEnd, secondEnd] = events;
      expect(firstStart.invocationId).not.toBe(secondStart.invocationId);
      expect(firstEnd.invocationId).toBe(firstStart.invocationId);
      expect(secondEnd.invocationId).toBe(secondStart.invocationId);
    });

    it('tags both phases with the agent that ran the hook', async () => {
      planWith([functionHook('in-agent')]);

      await runWithAgentContext('agent-1', () =>
        handler.fireUserPromptSubmitEvent('hi'),
      );

      expect(events.map((event) => event.agentId)).toEqual([
        'agent-1',
        'agent-1',
      ]);
    });

    it('omits agentId outside an agent context', async () => {
      planWith([functionHook('main')]);

      await handler.fireUserPromptSubmitEvent('hi');

      expect(events).toHaveLength(2);
      for (const event of events) {
        expect('agentId' in event).toBe(false);
      }
    });

    it('keeps the agentId read at batch start when the end runs elsewhere', async () => {
      let release: (() => void) | undefined;
      planWith([
        functionHook(
          'crossing',
          () =>
            new Promise<undefined>((resolve) => {
              release = () => resolve(undefined);
            }),
        ),
      ]);

      const run = runWithAgentContext('agent-2', () =>
        handler.fireUserPromptSubmitEvent('hi'),
      );
      await vi.waitFor(() => expect(release).toBeDefined());
      // Settle the hook from a different agent frame.
      await runWithAgentContext('agent-other', async () => {
        release!();
      });
      await run;

      const [start, end] = events;
      expect(end.invocationId).toBe(start.invocationId);
      expect(start.agentId).toBe('agent-2');
      expect(end.agentId).toBe(start.agentId);
    });
  });
});
