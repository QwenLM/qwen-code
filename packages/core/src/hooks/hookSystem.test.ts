/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from 'vitest';
import { HookSystem } from './hookSystem.js';
import { HookRegistry } from './hookRegistry.js';
import { HookRunner } from './hookRunner.js';
import { HookAggregator } from './hookAggregator.js';
import { HookPlanner } from './hookPlanner.js';
import { HookEventHandler } from './hookEventHandler.js';
import { SessionHooksManager } from './sessionHooksManager.js';
import {
  HookType,
  HooksConfigSource,
  HookEventName,
  SessionStartSource,
  SessionEndReason,
  PermissionMode,
  AgentType,
  PreCompactTrigger,
  NotificationType,
  type PermissionSuggestion,
  HookPhase,
  DefaultHookOutput,
  PreToolUseHookOutput,
  PostToolUseHookOutput,
  PostToolUseFailureHookOutput,
  UserPromptExpansionHookOutput,
  PostToolBatchHookOutput,
  StopHookOutput,
  PermissionRequestHookOutput,
} from './types.js';
import * as hookOutputs from './types.js';
import type { Config } from '../config/config.js';
import type { AggregatedHookResult } from './hookAggregator.js';
import type { HookOutput } from './types.js';

vi.mock('./hookRegistry.js');
vi.mock('./hookRunner.js');
vi.mock('./hookAggregator.js');
vi.mock('./hookPlanner.js');
vi.mock('./hookEventHandler.js');

const aggregated = (
  finalOutput?: HookOutput,
  totalDuration = 0,
  success = true,
): AggregatedHookResult => ({
  success,
  allOutputs: [],
  errors: [],
  totalDuration,
  finalOutput,
});
const registryEntry = (eventName: HookEventName) => ({
  config: {
    type: HookType.Command as const,
    command: 'echo test',
    source: HooksConfigSource.Project,
  },
  source: HooksConfigSource.Project,
  eventName,
  enabled: true,
});

/** `fire*` methods HookSystem delegates to the handler method of the same name. */
type FireMethod = Extract<
  keyof HookSystem & keyof HookEventHandler,
  `fire${string}`
>;

describe('HookSystem', () => {
  let mockConfig: Config;
  let mockHookRegistry: HookRegistry;
  let mockHookRunner: HookRunner;
  let mockHookAggregator: HookAggregator;
  let mockHookPlanner: HookPlanner;
  let mockHookEventHandler: HookEventHandler;
  let hookSystem: HookSystem;

  beforeEach(() => {
    mockConfig = {
      getSessionId: vi.fn().mockReturnValue('test-session-id'),
      getTranscriptPath: vi.fn().mockReturnValue('/test/transcript'),
      getApprovalMode: vi.fn().mockReturnValue('default'),
      getWorkingDir: vi.fn().mockReturnValue('/test/cwd'),
      getAllowedHttpHookUrls: vi.fn().mockReturnValue([]),
      getAllowPrivateNetworkHooks: vi.fn().mockReturnValue(false),
    } as unknown as Config;

    mockHookRegistry = {
      initialize: vi.fn().mockResolvedValue(undefined),
      reloadConfiguredHooks: vi.fn().mockResolvedValue(undefined),
      setHookEnabled: vi.fn(),
      getAllHooks: vi.fn().mockReturnValue([]),
      getHooksForEvent: vi.fn().mockReturnValue([]),
    } as unknown as HookRegistry;

    mockHookRunner = {
      executeHooksSequential: vi.fn(),
      executeHooksParallel: vi.fn(),
    } as unknown as HookRunner;

    mockHookAggregator = {
      aggregateResults: vi.fn(),
    } as unknown as HookAggregator;

    mockHookPlanner = {
      createExecutionPlan: vi.fn(),
    } as unknown as HookPlanner;

    mockHookEventHandler = {
      fireUserPromptSubmitEvent: vi.fn(),
      fireInstructionsLoadedEvent: vi.fn(),
      fireUserPromptExpansionEvent: vi.fn(),
      fireStopEvent: vi.fn(),
      fireMessageDisplayEvent: vi.fn(),
      fireSessionStartEvent: vi.fn(),
      fireSessionEndEvent: vi.fn(),
      fireSessionDeleteEvent: vi.fn(),
      firePreToolUseEvent: vi.fn(),
      firePostToolUseEvent: vi.fn(),
      firePostToolUseFailureEvent: vi.fn(),
      firePostToolBatchEvent: vi.fn(),
      firePreCompactEvent: vi.fn(),
      fireNotificationEvent: vi.fn(),
      firePermissionRequestEvent: vi.fn(),
      firePermissionDeniedEvent: vi.fn(),
      fireSubagentStartEvent: vi.fn(),
      fireSubagentStopEvent: vi.fn(),
      fireTodoCreatedEvent: vi.fn(),
      fireTodoCompletedEvent: vi.fn(),
      setMessagesProvider: vi.fn(),
    } as unknown as HookEventHandler;

    vi.mocked(HookRegistry).mockImplementation(() => mockHookRegistry);
    vi.mocked(HookRunner).mockImplementation(() => mockHookRunner);
    vi.mocked(HookAggregator).mockImplementation(() => mockHookAggregator);
    vi.mocked(HookPlanner).mockImplementation(() => mockHookPlanner);
    vi.mocked(HookEventHandler).mockImplementation(() => mockHookEventHandler);

    hookSystem = new HookSystem(mockConfig);
  });

  /** Resolve the handler's `method` with `result`, then call the same method on the HookSystem. */
  const fire = <M extends FireMethod>(
    method: M,
    args: Parameters<HookSystem[M]>,
    result = aggregated(),
  ): ReturnType<HookSystem[M]> => {
    (mockHookEventHandler[method] as Mock).mockResolvedValue(result);
    return Reflect.apply(hookSystem[method], hookSystem, args);
  };
  afterEach(() => vi.restoreAllMocks());

  describe('constructor', () => {
    it('should create instance with all dependencies', () => {
      expect(HookRegistry).toHaveBeenCalledWith(mockConfig);
      expect(HookRunner).toHaveBeenCalled();
      expect(HookAggregator).toHaveBeenCalled();
      expect(HookPlanner).toHaveBeenCalledWith(mockHookRegistry);
      expect(HookEventHandler).toHaveBeenCalledWith(
        mockConfig,
        mockHookPlanner,
        mockHookRunner,
        mockHookAggregator,
        expect.any(SessionHooksManager),
        undefined,
        hookSystem.runtimeId,
        undefined,
      );
    });
  });

  describe('initialize', () => {
    it('should initialize hook registry', async () => {
      await hookSystem.initialize();
      expect(mockHookRegistry.initialize).toHaveBeenCalled();
    });
  });

  describe('reload', () => {
    it('should reload configured hooks', async () => {
      await hookSystem.reload();
      expect(mockHookRegistry.reloadConfiguredHooks).toHaveBeenCalled();
    });
  });

  describe('getEventHandler', () => {
    it('should return the hook event handler', () => {
      expect(hookSystem.getEventHandler()).toBe(mockHookEventHandler);
    });
  });

  describe('getRegistry', () => {
    it('should return the hook registry', () => {
      expect(hookSystem.getRegistry()).toBe(mockHookRegistry);
    });
  });

  describe('setHookEnabled', () => {
    it('should enable a hook', () => {
      hookSystem.setHookEnabled('test-hook', true);
      expect(mockHookRegistry.setHookEnabled).toHaveBeenCalledWith(
        'test-hook',
        true,
      );
    });

    it('should disable a hook', () => {
      hookSystem.setHookEnabled('test-hook', false);
      expect(mockHookRegistry.setHookEnabled).toHaveBeenCalledWith(
        'test-hook',
        false,
      );
    });
  });

  describe('getAllHooks', () => {
    it('should return all registered hooks', () => {
      const mockHooks = [registryEntry(HookEventName.PreToolUse)];
      vi.mocked(mockHookRegistry.getAllHooks).mockReturnValue(mockHooks);

      expect(hookSystem.getAllHooks()).toEqual(mockHooks);
      expect(mockHookRegistry.getAllHooks).toHaveBeenCalled();
    });
  });

  describe('hasHooksForEvent', () => {
    it('should return false when no hooks are registered for the event', () => {
      vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue([]);

      expect(hookSystem.hasHooksForEvent('Stop')).toBe(false);
      expect(mockHookRegistry.getHooksForEvent).toHaveBeenCalledWith('Stop');
    });

    it('should return true when hooks are registered for the event', () => {
      vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue([
        registryEntry(HookEventName.Stop),
      ]);

      expect(hookSystem.hasHooksForEvent('Stop')).toBe(true);
    });

    it.each([
      ['UserPromptSubmit'],
      ['UserPromptExpansion'],
      ['SessionEnd'],
      ['SessionDelete'],
    ])('should check the correct event name for %s', (eventName) => {
      vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue([]);

      hookSystem.hasHooksForEvent(eventName);

      expect(mockHookRegistry.getHooksForEvent).toHaveBeenCalledWith(eventName);
    });

    it('returns true when only a session function hook is registered', () => {
      vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue([]);
      const sessionId = 'sess-1';
      hookSystem.addFunctionHook(
        sessionId,
        HookEventName.Stop,
        '',
        async () => ({ continue: true }),
        'error',
      );
      // Without a sessionId, hasHooksForEvent still finds it across any session.
      expect(hookSystem.hasHooksForEvent('Stop')).toBe(true);
      // With the correct sessionId.
      expect(hookSystem.hasHooksForEvent('Stop', sessionId)).toBe(true);
      // With a different sessionId.
      expect(hookSystem.hasHooksForEvent('Stop', 'other-session')).toBe(false);
    });
  });

  const signal = new AbortController().signal;
  const input = { command: 'ls -la' };
  const response = { output: 'file1.txt\nfile2.txt' };
  const suggestions: PermissionSuggestion[] = [
    { type: 'toolAlwaysAllow', tool: 'Bash' },
  ];
  const toolCalls = [
    {
      tool_name: 'read_file',
      tool_input: { path: 'README.md' },
      tool_use_id: 'call-1',
      status: 'success' as const,
      tool_response: { output: 'contents' },
    },
  ];
  type OutputMethod = Exclude<
    FireMethod,
    | 'fireStopEvent'
    | 'fireMessageDisplayEvent'
    | 'fireTodoCreatedEvent'
    | 'fireTodoCompletedEvent'
    | 'fireStopFailureEvent'
    | 'firePostCompactEvent'
  >;
  type OutputContract = {
    [M in OutputMethod]: {
      method: M;
      event: HookEventName;
      outputType: typeof DefaultHookOutput;
      args: Parameters<HookSystem[M]>;
      required: Parameters<HookSystem[M]>;
      defaults: unknown[];
    };
  }[OutputMethod];
  const outputContracts = [
    {
      method: 'fireUserPromptSubmitEvent',
      event: HookEventName.UserPromptSubmit,
      outputType: DefaultHookOutput,
      args: ['model prompt', signal, 'submitted prompt'],
      required: ['test prompt'],
      defaults: [undefined, undefined],
    },
    {
      method: 'fireInstructionsLoadedEvent',
      event: HookEventName.InstructionsLoaded,
      outputType: DefaultHookOutput,
      args: [
        '/repo/QWEN.md',
        'local',
        'include',
        {
          triggerFilePath: '/repo/src/app.ts',
          parentFilePath: '/repo/QWEN.md',
        },
        signal,
      ],
      required: ['/repo/QWEN.md', 'project', 'session_start'],
      defaults: [{}, undefined],
    },
    {
      method: 'fireUserPromptExpansionEvent',
      event: HookEventName.UserPromptExpansion,
      outputType: UserPromptExpansionHookOutput,
      args: ['goal', 'write tests', 'expanded prompt', signal],
      required: ['goal', '', 'expanded prompt'],
      defaults: [undefined],
    },
    {
      method: 'fireSessionStartEvent',
      event: HookEventName.SessionStart,
      outputType: DefaultHookOutput,
      args: [
        SessionStartSource.Clear,
        'claude-3',
        PermissionMode.AutoEdit,
        AgentType.Custom,
        signal,
      ],
      required: [SessionStartSource.Startup, 'gpt-4'],
      defaults: [undefined, undefined, undefined],
    },
    {
      method: 'fireSessionEndEvent',
      event: HookEventName.SessionEnd,
      outputType: DefaultHookOutput,
      args: [SessionEndReason.Other, signal],
      required: [SessionEndReason.Other],
      defaults: [undefined],
    },
    {
      method: 'fireSessionDeleteEvent',
      event: HookEventName.SessionDelete,
      outputType: DefaultHookOutput,
      args: ['deleted-id', signal],
      required: ['deleted-id'],
      defaults: [undefined],
    },
    {
      method: 'firePreToolUseEvent',
      event: HookEventName.PreToolUse,
      outputType: PreToolUseHookOutput,
      args: [
        'Bash',
        input,
        'toolu-pre',
        PermissionMode.Yolo,
        signal,
        'call-pre',
      ],
      required: ['Bash', input, 'toolu-default', PermissionMode.Default],
      defaults: [undefined, undefined],
    },
    {
      method: 'firePostToolUseEvent',
      event: HookEventName.PostToolUse,
      outputType: PostToolUseHookOutput,
      args: [
        'Bash',
        input,
        response,
        'toolu-post',
        PermissionMode.Plan,
        signal,
        'call-post',
        57,
      ],
      required: [
        'Bash',
        input,
        response,
        'toolu-default',
        PermissionMode.Default,
      ],
      defaults: [undefined, undefined, undefined],
    },
    {
      method: 'firePostToolUseFailureEvent',
      event: HookEventName.PostToolUseFailure,
      outputType: PostToolUseFailureHookOutput,
      args: [
        'toolu-failed',
        'Bash',
        input,
        'Permission denied',
        true,
        PermissionMode.Yolo,
        signal,
        'call-failed',
        83,
      ],
      required: ['toolu-default', 'Bash', input, 'Error occurred'],
      defaults: [undefined, undefined, undefined, undefined, undefined],
    },
    {
      method: 'firePostToolBatchEvent',
      event: HookEventName.PostToolBatch,
      outputType: PostToolBatchHookOutput,
      args: [toolCalls, PermissionMode.AutoEdit, signal],
      required: [toolCalls],
      defaults: [PermissionMode.Default, undefined],
    },
    {
      method: 'firePreCompactEvent',
      event: HookEventName.PreCompact,
      outputType: DefaultHookOutput,
      args: [
        PreCompactTrigger.Manual,
        'Custom compression instructions',
        signal,
      ],
      required: [PreCompactTrigger.Auto],
      defaults: ['', undefined],
    },
    {
      method: 'fireNotificationEvent',
      event: HookEventName.Notification,
      outputType: DefaultHookOutput,
      args: [
        'Dialog shown to user',
        NotificationType.ElicitationDialog,
        'Dialog',
        signal,
      ],
      required: ['Authentication successful', NotificationType.AuthSuccess],
      defaults: [undefined, undefined],
    },
    {
      method: 'firePermissionRequestEvent',
      event: HookEventName.PermissionRequest,
      outputType: PermissionRequestHookOutput,
      args: ['Bash', input, PermissionMode.Yolo, suggestions, signal],
      required: ['ReadFile', { file_path: '/test.txt' }, PermissionMode.Plan],
      defaults: [undefined, undefined],
    },
    {
      method: 'firePermissionDeniedEvent',
      event: HookEventName.PermissionDenied,
      outputType: DefaultHookOutput,
      args: [
        'Bash',
        input,
        'toolu-denied',
        'classifier_blocked',
        signal,
        'call-denied',
      ],
      required: [
        'ReadFile',
        { path: '/secret.txt' },
        'toolu-default',
        'classifier_unavailable',
      ],
      defaults: [undefined, undefined],
    },
    {
      method: 'fireSubagentStartEvent',
      event: HookEventName.SubagentStart,
      outputType: DefaultHookOutput,
      args: ['agent-456', AgentType.Bash, PermissionMode.Yolo, signal],
      required: ['agent-123', 'code-reviewer', PermissionMode.Default],
      defaults: [undefined],
    },
    {
      method: 'fireSubagentStopEvent',
      event: HookEventName.SubagentStop,
      outputType: StopHookOutput,
      args: [
        'agent-456',
        'qwen-tester',
        '/transcript/path.jsonl',
        'last message from agent',
        true,
        PermissionMode.Plan,
        signal,
      ],
      required: [
        'agent-123',
        'code-reviewer',
        '/path/transcript.jsonl',
        'Final output from subagent',
        false,
        PermissionMode.Default,
      ],
      defaults: [undefined],
    },
  ] satisfies OutputContract[];

  describe.each(outputContracts)(
    '$method',
    ({ method, event, outputType, args, required, defaults }) => {
      it('forwards every argument and wraps the final output for this event', async () => {
        const factory = vi.spyOn(hookOutputs, 'createHookOutput');
        const finalOutput: HookOutput = {
          continue: true,
          decision: 'block',
          reason: 'Blocked by policy',
          systemMessage: 'Hook status',
          hookSpecificOutput: {
            hookEventName: event,
            additionalContext: '<context>',
          },
        };
        const result = await fire(method, args, aggregated(finalOutput, 50));
        expect(mockHookEventHandler[method]).toHaveBeenCalledExactlyOnceWith(
          ...args,
        );
        expect(factory).toHaveBeenCalledExactlyOnceWith(event, finalOutput);
        expect(result?.constructor).toBe(outputType);
        expect(result).toMatchObject(finalOutput);
        expect(result?.hookSpecificOutput).toBe(finalOutput.hookSpecificOutput);
        expect(result?.isBlockingDecision()).toBe(true);
        expect(result?.getEffectiveReason()).toBe('Blocked by policy');
        expect(result?.getAdditionalContext()).toBe('&lt;context&gt;');
      });

      it('forwards omitted-argument defaults and returns undefined without final output', async () => {
        const result = await fire(method, required);
        expect(mockHookEventHandler[method]).toHaveBeenCalledExactlyOnceWith(
          ...required,
          ...defaults,
        );
        expect(result).toBeUndefined();
      });
    },
  );

  describe('output semantics', () => {
    it('preserves deny decisions and additional context for PreToolUse', async () => {
      const result = await fire(
        'firePreToolUseEvent',
        ['Bash', input, 'toolu-deny', PermissionMode.Default],
        aggregated({
          decision: 'deny',
          reason: 'Permission denied by policy',
          hookSpecificOutput: {
            additionalContext: 'Tool execution monitored for security',
          },
        }),
      );
      expect(result?.isBlockingDecision()).toBe(true);
      expect(result?.getEffectiveReason()).toBe('Permission denied by policy');
      expect((result as PreToolUseHookOutput).getPermissionDecision()).toBe(
        'deny',
      );
      expect(result?.getAdditionalContext()).toBe(
        'Tool execution monitored for security',
      );
    });

    it('preserves the system message and supplies PostToolUse defaults', async () => {
      const result = await fire(
        'firePostToolUseEvent',
        ['Bash', input, response, 'toolu-post', PermissionMode.Default],
        aggregated({ systemMessage: 'Tool executed successfully' }),
      );
      expect(result?.systemMessage).toBe('Tool executed successfully');
      expect(result?.decision).toBe('allow');
      expect(result?.reason).toBe('No reason provided');
    });

    it('escapes ampersands in UserPromptExpansion context', async () => {
      const result = await fire(
        'fireUserPromptExpansionEvent',
        ['goal', '', 'prompt'],
        aggregated({ hookSpecificOutput: { additionalContext: 'A & <B>' } }),
      );
      expect(result?.getAdditionalContext()).toBe('A &amp; &lt;B&gt;');
    });

    it('stops PostToolBatch when its decision blocks despite continue being true', async () => {
      const result = await fire(
        'firePostToolBatchEvent',
        [toolCalls],
        aggregated({ continue: true, decision: 'block' }),
      );
      expect(result?.shouldStopExecution()).toBe(true);
    });

    it('preserves permission decisions, absent outputs and hook errors', async () => {
      const args: Parameters<HookSystem['firePermissionRequestEvent']> = [
        'Bash',
        input,
        PermissionMode.Default,
      ];
      const decision = { behavior: 'allow' as const };
      const result = await fire(
        'firePermissionRequestEvent',
        args,
        aggregated({ hookSpecificOutput: { decision } }),
      );
      expect(
        (result as PermissionRequestHookOutput).getPermissionDecision(),
      ).toBe(decision);
      expect(
        await fire(
          'firePermissionRequestEvent',
          args,
          aggregated(undefined, 100, false),
        ),
      ).toBeUndefined();
      expect(
        await fire('firePermissionRequestEvent', args, {
          ...aggregated(undefined, 100, false),
          errors: [new Error('PermissionRequest hook error')],
        }),
      ).toBeUndefined();
    });

    it('preserves PermissionDenied fields without interpreting them as PreToolUse', async () => {
      const finalOutput = {
        hookSpecificOutput: {
          hookEventName: 'PermissionDenied',
          permissionDecision: 'deny',
          permissionDecisionReason: 'policy denied',
        },
      };
      const result = await fire(
        'firePermissionDeniedEvent',
        ['Bash', input, 'toolu-denied', 'classifier_blocked'],
        aggregated(finalOutput),
      );
      expect(result?.constructor).toBe(DefaultHookOutput);
      expect(result?.hookSpecificOutput).toEqual({
        hookEventName: 'PermissionDenied',
        permissionDecision: 'deny',
        permissionDecisionReason: 'policy denied',
      });
      expect(result?.decision).toBeUndefined();
    });

    it('allows SubagentStop and exposes its stop-specific reason', async () => {
      const result = await fire(
        'fireSubagentStopEvent',
        [
          'agent-222',
          'code-reviewer',
          '/path/transcript.jsonl',
          'A comprehensive review of the code...',
          false,
          PermissionMode.Default,
        ],
        aggregated({ decision: 'allow', stopReason: 'Output looks good' }),
      );
      expect(result?.isBlockingDecision()).toBe(false);
      expect((result as StopHookOutput).getStopReason()).toBe(
        'Stop hook feedback:\nOutput looks good',
      );
    });
  });

  type PassthroughMethod =
    | 'fireStopEvent'
    | 'fireMessageDisplayEvent'
    | 'fireTodoCreatedEvent'
    | 'fireTodoCompletedEvent';
  type PassthroughContract = {
    [M in PassthroughMethod]: {
      method: M;
      args: Parameters<HookSystem[M]>;
      required: Parameters<HookSystem[M]>;
      forwarded: Parameters<HookEventHandler[M]>;
    };
  }[PassthroughMethod];
  const pending = [{ id: '1', content: 'Task', status: 'pending' as const }];
  const completed = [
    { id: '1', content: 'Task', status: 'completed' as const },
  ];
  describe.each([
    {
      method: 'fireStopEvent',
      args: [
        true,
        'last message',
        { context_usage: 0.75, context_limit: 200000, input_tokens: 150000 },
        signal,
      ],
      required: [],
      forwarded: [false, '', undefined, undefined],
    },
    {
      method: 'fireMessageDisplayEvent',
      args: ['msg-1', 'Hello', false, signal],
      required: ['msg-1', 'Hello, world.', true],
      forwarded: ['msg-1', 'Hello, world.', true, undefined],
    },
    {
      method: 'fireTodoCreatedEvent',
      args: ['1', 'Task', 'pending', pending, HookPhase.Validation, signal],
      required: ['1', 'Task', 'pending', pending, HookPhase.Validation],
      forwarded: [
        '1',
        'Task',
        'pending',
        pending,
        HookPhase.Validation,
        undefined,
      ],
    },
    {
      method: 'fireTodoCompletedEvent',
      args: [
        '1',
        'Task',
        'in_progress',
        completed,
        HookPhase.Validation,
        signal,
      ],
      required: ['1', 'Task', 'pending', completed, HookPhase.Validation],
      forwarded: [
        '1',
        'Task',
        'pending',
        completed,
        HookPhase.Validation,
        undefined,
      ],
    },
  ] satisfies PassthroughContract[])(
    '$method',
    ({ method, args, required, forwarded }) => {
      it('forwards every argument and preserves the complete blocking result by identity', async () => {
        const handlerResult = {
          ...aggregated(
            {
              continue: false,
              decision: 'block',
              reason: 'Blocked',
              stopReason: 'user_stop',
            },
            50,
            false,
          ),
          errors: [new Error('Hook error')],
        };
        const result = await fire(method, args, handlerResult);
        expect(mockHookEventHandler[method]).toHaveBeenCalledExactlyOnceWith(
          ...args,
        );
        expect(result).toBe(handlerResult);
      });

      it('forwards defaults and preserves the result without final output by identity', async () => {
        const handlerResult = aggregated();
        const result = await fire(method, required, handlerResult);
        expect(mockHookEventHandler[method]).toHaveBeenCalledExactlyOnceWith(
          ...forwarded,
        );
        expect(result).toBe(handlerResult);
        expect(result.finalOutput).toBeUndefined();
      });
    },
  );

  describe('MessagesProvider', () => {
    it('should set messagesProvider and forward to eventHandler', () => {
      const provider = vi
        .fn()
        .mockReturnValue([{ role: 'user', content: 'test' }]);

      hookSystem.setMessagesProvider(provider);

      expect(mockHookEventHandler.setMessagesProvider).toHaveBeenCalledWith(
        provider,
      );
      expect(hookSystem.getMessagesProvider()).toBe(provider);
    });

    it('should return undefined when no provider is set', () => {
      expect(hookSystem.getMessagesProvider()).toBeUndefined();
    });
  });
});
