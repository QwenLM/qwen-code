/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
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
  createHookOutput,
} from './types.js';
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
  /**
   * `fire`, then expect the handler to have received `args` followed by
   * `undefined` for each remaining parameter up to `arity` (the optional
   * arguments, abort signal included, that the caller left unset).
   */
  const forwarding =
    <M extends FireMethod>(method: M, arity: number) =>
    async (args: Parameters<HookSystem[M]>, result?: AggregatedHookResult) => {
      const output = await fire(method, args, result);
      expect(mockHookEventHandler[method]).toHaveBeenCalledWith(
        ...args,
        ...Array(arity - args.length).fill(undefined),
      );
      return output;
    };

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

  describe('fireStopEvent', () => {
    const fireStop = forwarding('fireStopEvent', 4);

    it('should fire stop event and return AggregatedHookResult', async () => {
      const mockResult = aggregated(
        { continue: false, stopReason: 'user_stop' },
        50,
      );
      const result = await fireStop([true, 'last message'], mockResult);
      expect(result).toEqual(mockResult);
    });

    it('should use default parameters when not provided', async () => {
      await fire('fireStopEvent', []);

      expect(mockHookEventHandler.fireStopEvent).toHaveBeenCalledWith(
        false,
        '',
        undefined,
        undefined,
      );
    });

    it('should forward context usage to hookEventHandler', async () => {
      const mockResult = aggregated(undefined, 50);
      const contextUsage = {
        context_usage: 0.75,
        context_limit: 200000,
        input_tokens: 150000,
      };
      const result = await fireStop(
        [true, 'last message', contextUsage],
        mockResult,
      );
      expect(result).toEqual(mockResult);
    });

    it('should return AggregatedHookResult even when no final output', async () => {
      const mockResult = aggregated();
      const result = await fire('fireStopEvent', [], mockResult);

      expect(result).toEqual(mockResult);
      expect(result.finalOutput).toBeUndefined();
    });
  });

  describe('fireMessageDisplayEvent', () => {
    it('should fire message display event and return AggregatedHookResult', async () => {
      const mockResult = aggregated(undefined, 5);
      const result = await forwarding('fireMessageDisplayEvent', 4)(
        ['msg-1', 'Hello', false],
        mockResult,
      );
      expect(result).toEqual(mockResult);
    });

    it('should return AggregatedHookResult even when no final output', async () => {
      const mockResult = aggregated();
      const result = await fire(
        'fireMessageDisplayEvent',
        ['msg-1', 'Hello, world.', true],
        mockResult,
      );

      expect(result).toEqual(mockResult);
      expect(result.finalOutput).toBeUndefined();
    });
  });

  describe('fireUserPromptSubmitEvent', () => {
    const fireSubmit = forwarding('fireUserPromptSubmitEvent', 3);

    it('should fire UserPromptSubmit event and return output', async () => {
      const result = await fireSubmit(
        ['test prompt'],
        aggregated({ continue: true, decision: 'allow' }, 50),
      );
      expect(result).toBeDefined();
    });

    it('should pass prompt to event handler', async () => {
      await fireSubmit(['my custom prompt'], aggregated({ decision: 'allow' }));
    });

    it('should pass submitted prompt after the existing signal argument', async () => {
      const signal = new AbortController().signal;
      await fireSubmit(['model prompt', signal, 'submitted prompt']);
    });

    it('should return undefined when no final output', async () => {
      const result = await fire('fireUserPromptSubmitEvent', ['test']);
      expect(result).toBeUndefined();
    });

    it('should return DefaultHookOutput with blocking decision', async () => {
      const result = await fire(
        'fireUserPromptSubmitEvent',
        ['test'],
        aggregated({ decision: 'block', reason: 'Blocked by policy' }, 50),
      );

      expect(result).toBeDefined();
      expect(result?.isBlockingDecision()).toBe(true);
    });

    it('should return DefaultHookOutput with additional context', async () => {
      const result = await fire(
        'fireUserPromptSubmitEvent',
        ['test'],
        aggregated(
          {
            decision: 'allow',
            hookSpecificOutput: {
              additionalContext: 'Some additional context',
            },
          },
          50,
        ),
      );

      expect(result).toBeDefined();
      expect(result?.getAdditionalContext()).toBe('Some additional context');
    });
  });

  describe('fireInstructionsLoadedEvent', () => {
    it('should delegate to hookEventHandler.fireInstructionsLoadedEvent', async () => {
      const result = await forwarding('fireInstructionsLoadedEvent', 5)(
        [
          '/repo/QWEN.md',
          'project',
          'session_start',
          { triggerFilePath: '/repo/src/app.ts' },
        ],
        aggregated(undefined, 100),
      );
      expect(result).toBeUndefined();
    });

    it('should return DefaultHookOutput when finalOutput exists', async () => {
      const result = await fire(
        'fireInstructionsLoadedEvent',
        [
          '/repo/.qwen/QWEN.local.md',
          'local',
          'include',
          { parentFilePath: '/repo/QWEN.md' },
        ],
        aggregated(
          {
            decision: 'allow',
            hookSpecificOutput: { additionalContext: 'observed load' },
          },
          100,
        ),
      );

      expect(result).toBeDefined();
      expect(result?.getAdditionalContext()).toBe('observed load');
    });
  });

  describe('fireUserPromptExpansionEvent', () => {
    it('should fire UserPromptExpansion event and return output', async () => {
      const result = await forwarding('fireUserPromptExpansionEvent', 4)(
        ['goal', 'write tests', 'expanded prompt'],
        aggregated({ continue: true, decision: 'allow' }, 50),
      );
      expect(result).toBeDefined();
    });

    it('should return DefaultHookOutput with blocking decision', async () => {
      const result = await fire(
        'fireUserPromptExpansionEvent',
        ['goal', '', 'expanded prompt'],
        aggregated({ decision: 'block', reason: 'Blocked by policy' }, 50),
      );

      expect(result).toBeDefined();
      expect(result?.isBlockingDecision()).toBe(true);
    });

    it('should return undefined when no final output', async () => {
      const result = await fire('fireUserPromptExpansionEvent', [
        'goal',
        '',
        'expanded prompt',
      ]);
      expect(result).toBeUndefined();
    });
  });

  describe('fireSessionStartEvent', () => {
    const fireStart = forwarding('fireSessionStartEvent', 5);

    it('should fire session start event and return output', async () => {
      const result = await fireStart(
        [SessionStartSource.Startup, 'gpt-4'],
        aggregated({ continue: true, decision: 'allow' }, 50),
      );
      expect(result).toBeDefined();
    });

    it('should pass all parameters to event handler', async () => {
      await fireStart(
        [
          SessionStartSource.Clear,
          'claude-3',
          PermissionMode.AutoEdit, // Using actual enum value from PermissionMode
          AgentType.Custom,
        ],
        aggregated({ decision: 'allow' }),
      );
    });

    it('should return undefined when no final output', async () => {
      const result = await fire('fireSessionStartEvent', [
        SessionStartSource.Startup,
        'gpt-4',
      ]);
      expect(result).toBeUndefined();
    });
  });

  describe('fireSessionEndEvent', () => {
    const fireEnd = forwarding('fireSessionEndEvent', 2);

    it('should fire session end event and return output', async () => {
      const result = await fireEnd(
        [SessionEndReason.Other],
        aggregated({ continue: true, decision: 'allow' }, 50),
      );
      expect(result).toBeDefined();
    });

    it('should pass reason to event handler', async () => {
      await fireEnd(
        [SessionEndReason.Other],
        aggregated({ decision: 'allow' }),
      );
    });

    it('should return undefined when no final output', async () => {
      const result = await fire('fireSessionEndEvent', [
        SessionEndReason.Other,
      ]);
      expect(result).toBeUndefined();
    });
  });

  describe('fireSessionDeleteEvent', () => {
    it('should fire the event with the deleted session id', async () => {
      const result = await forwarding('fireSessionDeleteEvent', 2)(
        ['deleted-id'],
        aggregated({ decision: 'allow' }, 100),
      );
      expect(result).toBeDefined();
    });
  });

  describe('firePreToolUseEvent', () => {
    const firePre = forwarding('firePreToolUseEvent', 6);

    it('should fire PreToolUse event and return output', async () => {
      const result = await firePre(
        ['bash', { command: 'ls' }, 'toolu_test123', PermissionMode.AutoEdit],
        aggregated({ continue: true, decision: 'allow' }, 50),
      );
      expect(result).toBeDefined();
    });

    it('should pass all parameters to event handler', async () => {
      await firePre(
        [
          'write_file',
          { path: '/test.txt', content: 'test' },
          'toolu_test456',
          PermissionMode.Yolo,
        ],
        aggregated({ decision: 'allow' }),
      );
    });

    it('should forward tool_call_id to event handler', async () => {
      await firePre(
        [
          'bash',
          { command: 'ls' },
          'toolu_test123',
          PermissionMode.AutoEdit,
          undefined,
          'call_abc123',
        ],
        aggregated({ decision: 'allow' }),
      );
    });

    it('should return undefined when no final output', async () => {
      const result = await fire('firePreToolUseEvent', [
        'bash',
        { command: 'ls' },
        'toolu_test789',
        PermissionMode.Default,
      ]);
      expect(result).toBeUndefined();
    });

    it('should return DefaultHookOutput with deny decision', async () => {
      const result = await fire(
        'firePreToolUseEvent',
        [
          'bash',
          { command: 'rm -rf /' },
          'toolu_test999',
          PermissionMode.Default,
        ],
        aggregated(
          { decision: 'deny', reason: 'Permission denied by policy' },
          50,
        ),
      );

      expect(result).toBeDefined();
      expect(result?.isBlockingDecision()).toBe(true);
      expect(result?.getEffectiveReason()).toBe('Permission denied by policy');
    });

    it('should return DefaultHookOutput with additional context', async () => {
      const result = await fire(
        'firePreToolUseEvent',
        ['bash', { command: 'ls' }, 'toolu_test111', PermissionMode.Default],
        aggregated(
          {
            decision: 'allow',
            hookSpecificOutput: {
              additionalContext: 'Tool execution monitored for security',
            },
          },
          50,
        ),
      );

      expect(result).toBeDefined();
      expect(result?.getAdditionalContext()).toBe(
        'Tool execution monitored for security',
      );
    });
  });

  describe('firePostToolUseEvent', () => {
    const firePost = forwarding('firePostToolUseEvent', 8);

    it('should fire PostToolUse event and return output', async () => {
      const result = await firePost(
        [
          'bash',
          { command: 'ls' },
          { output: 'file1.txt\nfile2.txt' },
          'toolu_test123',
          PermissionMode.AutoEdit,
        ],
        aggregated({ continue: true, decision: 'allow' }, 50),
      );
      expect(result).toBeDefined();
    });

    it('should pass all parameters to event handler', async () => {
      await firePost(
        [
          'read_file',
          { path: '/test.txt' },
          { content: 'file content' },
          'toolu_test456',
          PermissionMode.Plan,
        ],
        aggregated({ decision: 'allow' }),
      );
    });

    it('should forward tool_call_id to event handler', async () => {
      await firePost(
        [
          'read_file',
          { path: '/test.txt' },
          { content: 'file content' },
          'toolu_test789',
          PermissionMode.Plan,
          undefined,
          'call_def456',
        ],
        aggregated({ decision: 'allow' }),
      );
    });

    it('should return undefined when no final output', async () => {
      const result = await fire('firePostToolUseEvent', [
        'bash',
        { command: 'ls' },
        { output: 'result' },
        'toolu_test789',
        PermissionMode.Default,
      ]);
      expect(result).toBeUndefined();
    });

    it('should return DefaultHookOutput with system message', async () => {
      const result = await fire(
        'firePostToolUseEvent',
        [
          'bash',
          { command: 'ls' },
          { output: 'result' },
          'toolu_test999',
          PermissionMode.Default,
        ],
        aggregated(
          { decision: 'allow', systemMessage: 'Tool executed successfully' },
          50,
        ),
      );

      expect(result).toBeDefined();
      expect(result?.systemMessage).toBe('Tool executed successfully');
    });
  });

  describe('firePostToolBatchEvent', () => {
    it('should fire PostToolBatch event and return output', async () => {
      const toolCalls = [
        {
          tool_name: 'read_file',
          tool_input: { path: 'README.md' },
          tool_use_id: 'call-1',
          status: 'success' as const,
          tool_response: { output: 'contents' },
        },
      ];
      const result = await fire(
        'firePostToolBatchEvent',
        [toolCalls],
        aggregated(
          {
            hookSpecificOutput: {
              hookEventName: 'PostToolBatch',
              additionalContext: 'batch context',
            },
          },
          50,
        ),
      );

      expect(mockHookEventHandler.firePostToolBatchEvent).toHaveBeenCalledWith(
        toolCalls,
        PermissionMode.Default,
        undefined,
      );
      expect(result).toBeDefined();
      expect(result?.getAdditionalContext()).toBe('batch context');
    });

    it('should return undefined when no final output', async () => {
      const result = await fire('firePostToolBatchEvent', [[]]);
      expect(result).toBeUndefined();
    });
  });

  describe('firePostToolUseFailureEvent', () => {
    const fireFailure = forwarding('firePostToolUseFailureEvent', 9);

    it('should fire PostToolUseFailure event and return output', async () => {
      const result = await fireFailure(
        [
          'toolu_test123',
          'bash',
          { command: 'invalid' },
          'Command not found',
          false,
          PermissionMode.AutoEdit,
        ],
        aggregated({ continue: true, decision: 'allow' }, 50),
      );
      expect(result).toBeDefined();
    });

    it('should pass all parameters to event handler', async () => {
      await fireFailure(
        [
          'toolu_test456',
          'write_file',
          { path: '/test.txt' },
          'Permission denied',
          true,
          PermissionMode.Yolo,
        ],
        aggregated({ decision: 'allow' }),
      );
    });

    it('should forward tool_call_id to event handler', async () => {
      await fireFailure(
        [
          'toolu_test123',
          'bash',
          { command: 'ls' },
          'Command not found',
          false,
          PermissionMode.AutoEdit,
          undefined,
          'call_ghi789',
        ],
        aggregated({ decision: 'allow' }),
      );
    });

    it('should use default values for optional parameters', async () => {
      await fireFailure([
        'toolu_test789',
        'bash',
        { command: 'ls' },
        'Error occurred',
      ]);
    });

    it('should return undefined when no final output', async () => {
      const result = await fire('firePostToolUseFailureEvent', [
        'toolu_test999',
        'bash',
        { command: 'ls' },
        'Error',
      ]);
      expect(result).toBeUndefined();
    });

    it('should return DefaultHookOutput with error context', async () => {
      const result = await fire(
        'firePostToolUseFailureEvent',
        ['toolu_test111', 'bash', { command: 'ls' }, 'Permission denied'],
        aggregated(
          {
            decision: 'allow',
            hookSpecificOutput: {
              additionalContext: 'Failure due to permission issues',
            },
          },
          50,
        ),
      );

      expect(result).toBeDefined();
      expect(result?.getAdditionalContext()).toBe(
        'Failure due to permission issues',
      );
    });
  });

  describe('firePreCompactEvent', () => {
    const fireCompact = forwarding('firePreCompactEvent', 3);

    it('should fire PreCompact event with auto trigger and return output', async () => {
      const result = await fireCompact(
        [PreCompactTrigger.Auto, ''],
        aggregated({ continue: true, decision: 'allow' }, 50),
      );
      expect(result).toBeDefined();
    });

    it('should fire PreCompact event with manual trigger', async () => {
      await fireCompact(
        [PreCompactTrigger.Manual, ''],
        aggregated({ decision: 'allow' }),
      );
    });

    it('should pass custom instructions to event handler', async () => {
      await fireCompact(
        [PreCompactTrigger.Auto, 'Custom compression instructions'],
        aggregated({ decision: 'allow' }),
      );
    });

    it('should return undefined when no final output', async () => {
      const result = await fire('firePreCompactEvent', [
        PreCompactTrigger.Auto,
        '',
      ]);
      expect(result).toBeUndefined();
    });

    it('should return DefaultHookOutput with additional context', async () => {
      const result = await fire(
        'firePreCompactEvent',
        [PreCompactTrigger.Manual, ''],
        aggregated(
          {
            decision: 'allow',
            hookSpecificOutput: {
              additionalContext: 'Context before compression',
            },
          },
          50,
        ),
      );

      expect(result).toBeDefined();
      expect(result?.getAdditionalContext()).toBe('Context before compression');
    });
  });

  describe('fireNotificationEvent', () => {
    const fireNotification = forwarding('fireNotificationEvent', 4);

    it('should fire Notification event and return output', async () => {
      const result = await fireNotification(
        [
          'Test notification message',
          NotificationType.PermissionPrompt,
          'Permission needed',
        ],
        aggregated({ continue: true, decision: 'allow' }, 50),
      );
      expect(result).toBeDefined();
    });

    it('should pass all parameters to event handler', async () => {
      await fireNotification(
        [
          'Qwen Code is waiting for your input',
          NotificationType.IdlePrompt,
          'Waiting for input',
        ],
        aggregated({ decision: 'allow' }),
      );
    });

    it('should handle notification without title', async () => {
      await fireNotification(
        ['Authentication successful', NotificationType.AuthSuccess],
        aggregated({ decision: 'allow' }),
      );
    });

    it('should return undefined when no final output', async () => {
      const result = await fire('fireNotificationEvent', [
        'Test message',
        NotificationType.PermissionPrompt,
      ]);
      expect(result).toBeUndefined();
    });

    it('should return DefaultHookOutput with additional context', async () => {
      const result = await fire(
        'fireNotificationEvent',
        ['Test notification', NotificationType.IdlePrompt],
        aggregated(
          {
            decision: 'allow',
            hookSpecificOutput: {
              additionalContext: 'Notification handled by custom handler',
            },
          },
          50,
        ),
      );

      expect(result).toBeDefined();
      expect(result?.getAdditionalContext()).toBe(
        'Notification handled by custom handler',
      );
    });

    it('should handle elicitation_dialog notification type', async () => {
      await fireNotification(
        ['Dialog shown to user', NotificationType.ElicitationDialog, 'Dialog'],
        aggregated({ decision: 'allow' }),
      );
    });
  });

  describe('firePermissionRequestEvent', () => {
    const fireRequest = forwarding('firePermissionRequestEvent', 5);

    it('should delegate to hookEventHandler.firePermissionRequestEvent', async () => {
      const result = await fireRequest(
        ['Bash', { command: 'ls -la' }, PermissionMode.Default],
        aggregated(
          { hookSpecificOutput: { decision: { behavior: 'allow' as const } } },
          100,
        ),
      );

      expect(result).toBeDefined();
      // getPermissionDecision is specific to PermissionRequestHookOutput.
      const permissionResult = result as unknown as {
        getPermissionDecision: () => { behavior: string } | undefined;
      };
      expect(permissionResult.getPermissionDecision()?.behavior).toBe('allow');
    });

    it('should include permission_suggestions when provided', async () => {
      const suggestions: PermissionSuggestion[] = [
        { type: 'toolAlwaysAllow', tool: 'Bash' },
      ];
      await fireRequest(
        ['Bash', { command: 'npm test' }, PermissionMode.Default, suggestions],
        aggregated(undefined, 100),
      );
    });

    it('should return undefined when hook has no finalOutput', async () => {
      const result = await fire(
        'firePermissionRequestEvent',
        ['ReadFile', { file_path: '/test.txt' }, PermissionMode.Plan],
        aggregated(undefined, 100, false),
      );
      expect(result).toBeUndefined();
    });

    it('should handle all permission modes correctly', async () => {
      const mockAggregated = aggregated(undefined, 100);
      for (const mode of [
        PermissionMode.Default,
        PermissionMode.Plan,
        PermissionMode.Yolo,
      ]) {
        await fire(
          'firePermissionRequestEvent',
          ['Bash', { command: 'test' }, mode],
          mockAggregated,
        );
      }

      expect(
        mockHookEventHandler.firePermissionRequestEvent,
      ).toHaveBeenCalledTimes(3);
    });

    it('should pass through hook errors', async () => {
      const result = await fire(
        'firePermissionRequestEvent',
        ['Bash', { command: 'test' }, PermissionMode.Default],
        {
          ...aggregated(undefined, 100, false),
          errors: [new Error('PermissionRequest hook error')],
        },
      );
      expect(result).toBeUndefined();
    });
  });

  describe('firePermissionDeniedEvent', () => {
    const fireDenied = forwarding('firePermissionDeniedEvent', 6);
    const deniedRm = (): Parameters<
      HookSystem['firePermissionDeniedEvent']
    > => [
      'Bash',
      { command: 'rm -rf /tmp/project' },
      'toolu-denied-1',
      'classifier_blocked',
    ];

    it('should delegate to hookEventHandler.firePermissionDeniedEvent', async () => {
      const result = await fireDenied(deniedRm(), aggregated(undefined, 100));
      expect(result).toBeUndefined();
    });

    it('should forward tool_call_id to event handler', async () => {
      await fireDenied(
        [
          'Bash',
          { command: 'rm -rf /tmp/project' },
          'toolu-denied-2',
          'classifier_blocked',
          undefined,
          'call_jkl012',
        ],
        aggregated(undefined, 100, false),
      );
    });

    it('should return DefaultHookOutput when finalOutput exists', async () => {
      const result = await fire(
        'firePermissionDeniedEvent',
        [
          'ReadFile',
          { path: '/secret.txt' },
          'tool-use-2',
          'classifier_unavailable',
        ],
        aggregated({ decision: 'block', reason: 'Observed denial' }, 100),
      );

      expect(result).toBeDefined();
      expect(result?.isBlockingDecision()).toBe(true);
    });

    it('should return PermissionDenied hook output when present', async () => {
      const finalOutput = {
        hookSpecificOutput: {
          hookEventName: 'PermissionDenied',
          permissionDecision: 'deny',
          permissionDecisionReason: 'policy denied',
        },
      };
      const result = await fire(
        'firePermissionDeniedEvent',
        deniedRm(),
        aggregated(finalOutput, 100),
      );

      expect(result).toEqual(createHookOutput('PermissionDenied', finalOutput));
    });
  });

  describe('fireSubagentStartEvent', () => {
    const fireStart = forwarding('fireSubagentStartEvent', 4);

    it('should fire SubagentStart event and return output', async () => {
      const result = await fireStart(
        ['agent-123', 'code-reviewer', PermissionMode.Default],
        aggregated({ decision: 'allow' }, 50),
      );
      expect(result).toBeDefined();
    });

    it('should pass AgentType enum as agent type', async () => {
      await fireStart(
        ['agent-456', AgentType.Bash, PermissionMode.Yolo],
        aggregated({ decision: 'allow' }),
      );
    });

    it('should return undefined when no final output', async () => {
      const result = await fire('fireSubagentStartEvent', [
        'agent-789',
        'test-agent',
        PermissionMode.Default,
      ]);
      expect(result).toBeUndefined();
    });

    it('should return DefaultHookOutput with additional context', async () => {
      const result = await fire(
        'fireSubagentStartEvent',
        ['agent-111', 'code-reviewer', PermissionMode.Default],
        aggregated(
          {
            decision: 'allow',
            hookSpecificOutput: {
              additionalContext: 'Extra context injected by SubagentStart hook',
            },
          },
          50,
        ),
      );

      expect(result).toBeDefined();
      expect(result?.getAdditionalContext()).toBe(
        'Extra context injected by SubagentStart hook',
      );
    });
  });

  describe('fireSubagentStopEvent', () => {
    const fireStop = forwarding('fireSubagentStopEvent', 7);
    /** Args for agent `id` stopping with `lastMessage` in Default mode. */
    const stopArgs = (
      id: string,
      lastMessage: string,
      agent = 'code-reviewer',
    ): Parameters<HookSystem['fireSubagentStopEvent']> => [
      id,
      agent,
      '/path/transcript.jsonl',
      lastMessage,
      false,
      PermissionMode.Default,
    ];

    it('should fire SubagentStop event and return output', async () => {
      const result = await fireStop(
        [
          'agent-123',
          'code-reviewer',
          '/path/to/transcript.jsonl',
          'Final output from subagent',
          false,
          PermissionMode.Default,
        ],
        aggregated({ continue: true, decision: 'allow' }, 50),
      );
      expect(result).toBeDefined();
    });

    it('should pass all parameters to event handler', async () => {
      await fireStop(
        [
          'agent-456',
          'qwen-tester',
          '/transcript/path.jsonl',
          'last message from agent',
          true,
          PermissionMode.Plan,
        ],
        aggregated({ decision: 'allow' }),
      );
    });

    it('should return undefined when no final output', async () => {
      const result = await fire(
        'fireSubagentStopEvent',
        stopArgs('agent-789', 'output', 'test-agent'),
      );
      expect(result).toBeUndefined();
    });

    it('should return StopHookOutput with blocking decision', async () => {
      const result = await fire(
        'fireSubagentStopEvent',
        stopArgs('agent-999', 'short'),
        aggregated(
          { decision: 'block', reason: 'Output too short, continue working' },
          50,
        ),
      );

      expect(result).toBeDefined();
      expect(result?.isBlockingDecision()).toBe(true);
      expect(result?.getEffectiveReason()).toBe(
        'Output too short, continue working',
      );
    });

    it('should return StopHookOutput with allow decision', async () => {
      const result = await fire(
        'fireSubagentStopEvent',
        stopArgs('agent-222', 'A comprehensive review of the code...'),
        aggregated({ decision: 'allow', reason: 'Output looks good' }, 50),
      );

      expect(result).toBeDefined();
      expect(result?.isBlockingDecision()).toBe(false);
    });
  });

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

  describe('fireTodoCreatedEvent', () => {
    const fireCreated = forwarding('fireTodoCreatedEvent', 6);
    const pending = (content: string) => [
      { id: '1', content, status: 'pending' as const },
    ];

    it('should fire TodoCreated event and return AggregatedHookResult', async () => {
      const mockResult = aggregated({ decision: 'allow', reason: 'OK' }, 50);
      const result = await fireCreated(
        [
          '1',
          'Test Task',
          'pending',
          pending('Test Task'),
          HookPhase.Validation,
        ],
        mockResult,
      );
      expect(result).toEqual(mockResult);
    });

    it('should pass abort signal to event handler', async () => {
      const abortController = new AbortController();
      await fireCreated(
        [
          '1',
          'Task',
          'pending',
          pending('Task'),
          HookPhase.Validation,
          abortController.signal,
        ],
        aggregated(undefined, 100),
      );
    });

    it('should return blocking result when hook blocks', async () => {
      const result = await fire(
        'fireTodoCreatedEvent',
        ['1', 'test', 'pending', pending('test'), HookPhase.Validation],
        aggregated(
          { decision: 'block', reason: 'Invalid todo content' },
          50,
          false,
        ),
      );

      expect(result.finalOutput?.decision).toBe('block');
      expect(result.finalOutput?.reason).toBe('Invalid todo content');
    });
  });

  describe('fireTodoCompletedEvent', () => {
    const fireCompleted = forwarding('fireTodoCompletedEvent', 6);
    const completed = (content: string) => [
      { id: '1', content, status: 'completed' as const },
    ];

    it('should fire TodoCompleted event and return AggregatedHookResult', async () => {
      const mockResult = aggregated({ decision: 'allow', reason: 'OK' }, 50);
      const result = await fireCompleted(
        [
          '1',
          'Test Task',
          'pending',
          completed('Test Task'),
          HookPhase.Validation,
        ],
        mockResult,
      );
      expect(result).toEqual(mockResult);
    });

    it('should pass abort signal to event handler', async () => {
      const abortController = new AbortController();
      await fireCompleted(
        [
          '1',
          'Task',
          'in_progress',
          completed('Task'),
          HookPhase.Validation,
          abortController.signal,
        ],
        aggregated(undefined, 100),
      );
    });

    it('should return blocking result when hook blocks completion', async () => {
      const result = await fire(
        'fireTodoCompletedEvent',
        ['1', 'Task', 'in_progress', completed('Task'), HookPhase.Validation],
        aggregated(
          { decision: 'block', reason: 'Task not ready for completion' },
          50,
          false,
        ),
      );

      expect(result.finalOutput?.decision).toBe('block');
      expect(result.finalOutput?.reason).toBe('Task not ready for completion');
    });
  });
});
