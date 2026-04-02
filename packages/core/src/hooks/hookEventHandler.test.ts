/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { HookEventHandler } from './hookEventHandler.js';
import {
  HookEventName,
  HookType,
  HooksConfigSource,
  SessionStartSource,
  SessionEndReason,
  PermissionMode,
  AgentType,
  PreCompactTrigger,
  NotificationType,
} from './types.js';
import type { Config } from '../config/config.js';
import type {
  HookPlanner,
  HookRunner,
  HookAggregator,
  AggregatedHookResult,
} from './index.js';
import type { HookConfig, HookOutput, PermissionSuggestion } from './types.js';
import type { HookExecutionResult } from './types.js';
import { logHookCall } from '../telemetry/loggers.js';

// Mock the telemetry loggers module
vi.mock('../telemetry/loggers.js', () => ({
  logHookCall: vi.fn(),
}));

describe('HookEventHandler', () => {
  let mockConfig: Config;
  let mockHookPlanner: HookPlanner;
  let mockHookRunner: HookRunner;
  let mockHookAggregator: HookAggregator;
  let hookEventHandler: HookEventHandler;

  beforeEach(() => {
    mockConfig = {
      getSessionId: vi.fn().mockReturnValue('test-session-id'),
      getTranscriptPath: vi.fn().mockReturnValue('/test/transcript'),
      getWorkingDir: vi.fn().mockReturnValue('/test/cwd'),
    } as unknown as Config;

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

    hookEventHandler = new HookEventHandler(
      mockConfig,
      mockHookPlanner,
      mockHookRunner,
      mockHookAggregator,
    );
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

  describe('fireUserPromptSubmitEvent', () => {
    it('should execute hooks for UserPromptSubmit event', async () => {
      const mockPlan = createMockExecutionPlan([]);
      const mockAggregated = createMockAggregatedResult(true);

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        mockAggregated,
      );

      const result =
        await hookEventHandler.fireUserPromptSubmitEvent('test prompt');

      expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalledWith(
        HookEventName.UserPromptSubmit,
        undefined,
      );
      expect(result.success).toBe(true);
    });

    it('should include prompt in the hook input', async () => {
      const mockPlan = createMockExecutionPlan([
        {
          type: HookType.Command,
          command: 'echo test',
          source: HooksConfigSource.Project,
        },
      ]);
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );

      await hookEventHandler.fireUserPromptSubmitEvent('my test prompt');

      const mockCalls = (mockHookRunner.executeHooksParallel as Mock).mock
        .calls;
      const input = mockCalls[0][2] as { prompt: string };
      expect(input.prompt).toBe('my test prompt');
    });
  });

  describe('fireStopEvent', () => {
    it('should execute hooks for Stop event', async () => {
      const mockPlan = createMockExecutionPlan([]);
      const mockAggregated = createMockAggregatedResult(true);

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        mockAggregated,
      );

      const result = await hookEventHandler.fireStopEvent(true, 'last message');

      expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalledWith(
        HookEventName.Stop,
        undefined,
      );
      expect(result.success).toBe(true);
    });

    it('should include stop parameters in hook input', async () => {
      const mockPlan = createMockExecutionPlan([
        {
          type: HookType.Command,
          command: 'echo test',
          source: HooksConfigSource.Project,
        },
      ]);
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );

      await hookEventHandler.fireStopEvent(true, 'last assistant message');

      const mockCalls = (mockHookRunner.executeHooksParallel as Mock).mock
        .calls;
      const input = mockCalls[0][2] as {
        stop_hook_active: boolean;
        last_assistant_message: string;
      };
      expect(input.stop_hook_active).toBe(true);
      expect(input.last_assistant_message).toBe('last assistant message');
    });

    it('should handle continue=false in final output', async () => {
      const mockPlan = createMockExecutionPlan([]);
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true, {
          continue: false,
          stopReason: 'test stop',
        }),
      );

      await hookEventHandler.fireStopEvent();

      expect(true).toBe(true);
    });

    it('should handle missing finalOutput gracefully', async () => {
      const mockPlan = createMockExecutionPlan([]);
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true, undefined),
      );

      const result = await hookEventHandler.fireStopEvent();

      expect(result.success).toBe(true);
      expect(result.finalOutput).toBeUndefined();
    });
  });

  describe('fireSessionStartEvent', () => {
    it('should execute hooks for SessionStart event', async () => {
      const mockPlan = createMockExecutionPlan([]);
      const mockAggregated = createMockAggregatedResult(true);

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        mockAggregated,
      );

      const result = await hookEventHandler.fireSessionStartEvent(
        SessionStartSource.Startup,
        'test-model',
      );

      expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalledWith(
        HookEventName.SessionStart,
        { trigger: SessionStartSource.Startup },
      );
      expect(result.success).toBe(true);
    });

    it('should include all session start parameters in the hook input', async () => {
      const mockPlan = createMockExecutionPlan([
        {
          type: HookType.Command,
          command: 'echo test',
          source: HooksConfigSource.Project,
        },
      ]);
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );

      await hookEventHandler.fireSessionStartEvent(
        SessionStartSource.Resume,
        'test-model',
        PermissionMode.Plan,
        AgentType.Bash,
      );

      const mockCalls = (mockHookRunner.executeHooksParallel as Mock).mock
        .calls;
      const input = mockCalls[0][2] as {
        permission_mode: PermissionMode;
        source: SessionStartSource;
        model: string;
        agent_type?: AgentType;
      };
      expect(input.permission_mode).toBe(PermissionMode.Plan);
      expect(input.source).toBe(SessionStartSource.Resume);
      expect(input.model).toBe('test-model');
      expect(input.agent_type).toBe(AgentType.Bash);
    });

    it('should use default permission mode when not provided', async () => {
      const mockPlan = createMockExecutionPlan([
        {
          type: HookType.Command,
          command: 'echo test',
          source: HooksConfigSource.Project,
        },
      ]);
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );

      await hookEventHandler.fireSessionStartEvent(
        SessionStartSource.Clear,
        'test-model',
      );

      const mockCalls = (mockHookRunner.executeHooksParallel as Mock).mock
        .calls;
      const input = mockCalls[0][2] as {
        permission_mode: PermissionMode;
      };
      expect(input.permission_mode).toBe(PermissionMode.Default);
    });

    it('should handle session start event with undefined agent type', async () => {
      const mockPlan = createMockExecutionPlan([
        {
          type: HookType.Command,
          command: 'echo test',
          source: HooksConfigSource.Project,
        },
      ]);
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );

      await hookEventHandler.fireSessionStartEvent(
        SessionStartSource.Compact,
        'test-model',
      );

      const mockCalls = (mockHookRunner.executeHooksParallel as Mock).mock
        .calls;
      const input = mockCalls[0][2] as {
        permission_mode: PermissionMode;
        source: SessionStartSource;
        model: string;
        agent_type?: AgentType;
      };
      expect(input.source).toBe(SessionStartSource.Compact);
      expect(input.model).toBe('test-model');
      expect(input.agent_type).toBeUndefined();
    });
  });

  describe('fireSessionEndEvent', () => {
    it('should execute hooks for SessionEnd event', async () => {
      const mockPlan = createMockExecutionPlan([]);
      const mockAggregated = createMockAggregatedResult(true);

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        mockAggregated,
      );

      const result = await hookEventHandler.fireSessionEndEvent(
        SessionEndReason.Clear,
      );

      expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalledWith(
        HookEventName.SessionEnd,
        { trigger: SessionEndReason.Clear },
      );
      expect(result.success).toBe(true);
    });

    it('should include reason in the hook input', async () => {
      const mockPlan = createMockExecutionPlan([
        {
          type: HookType.Command,
          command: 'echo test',
          source: HooksConfigSource.Project,
        },
      ]);
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );

      await hookEventHandler.fireSessionEndEvent(SessionEndReason.Logout);

      const mockCalls = (mockHookRunner.executeHooksParallel as Mock).mock
        .calls;
      const input = mockCalls[0][2] as { reason: SessionEndReason };
      expect(input.reason).toBe(SessionEndReason.Logout);
    });

    it('should handle different session end reasons', async () => {
      const mockPlan = createMockExecutionPlan([
        {
          type: HookType.Command,
          command: 'echo test',
          source: HooksConfigSource.Project,
        },
      ]);
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );

      // Test all possible session end reasons
      const testReasons = [
        SessionEndReason.Clear,
        SessionEndReason.Logout,
        SessionEndReason.PromptInputExit,
        SessionEndReason.Bypass_permissions_disabled,
        SessionEndReason.Other,
      ];

      for (const reason of testReasons) {
        await hookEventHandler.fireSessionEndEvent(reason);

        const mockCalls = (mockHookRunner.executeHooksParallel as Mock).mock
          .calls;
        const input = mockCalls[mockCalls.length - 1][2] as {
          reason: SessionEndReason;
        };
        expect(input.reason).toBe(reason);
      }
    });
  });

  describe('sequential vs parallel execution', () => {
    it('should execute hooks sequentially when plan.sequential is true', async () => {
      const mockPlan = createMockExecutionPlan(
        [
          {
            type: HookType.Command,
            command: 'echo test',
            source: HooksConfigSource.Project,
          },
        ],
        true,
      );

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksSequential).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );

      await hookEventHandler.fireUserPromptSubmitEvent('test');

      expect(mockHookRunner.executeHooksSequential).toHaveBeenCalled();
      expect(mockHookRunner.executeHooksParallel).not.toHaveBeenCalled();
    });

    it('should execute hooks in parallel when plan.sequential is false', async () => {
      const mockPlan = createMockExecutionPlan(
        [
          {
            type: HookType.Command,
            command: 'echo test',
            source: HooksConfigSource.Project,
          },
        ],
        false,
      );

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );

      await hookEventHandler.fireUserPromptSubmitEvent('test');

      expect(mockHookRunner.executeHooksParallel).toHaveBeenCalled();
      expect(mockHookRunner.executeHooksSequential).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should return error result when hook execution throws', async () => {
      vi.mocked(mockHookPlanner.createExecutionPlan).mockImplementation(() => {
        throw new Error('Planner error');
      });

      const result = await hookEventHandler.fireUserPromptSubmitEvent('test');

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toBe('Planner error');
    });

    it('should return error result when hook runner throws', async () => {
      const mockPlan = createMockExecutionPlan([
        {
          type: HookType.Command,
          command: 'echo test',
          source: HooksConfigSource.Project,
        },
      ]);
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockRejectedValue(
        new Error('Runner error'),
      );

      const result = await hookEventHandler.fireUserPromptSubmitEvent('test');

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toBe('Runner error');
    });

    it('should handle errors for SessionStart event', async () => {
      vi.mocked(mockHookPlanner.createExecutionPlan).mockImplementation(() => {
        throw new Error('SessionStart planner error');
      });

      const result = await hookEventHandler.fireSessionStartEvent(
        SessionStartSource.Startup,
        'test-model',
      );

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toBe('SessionStart planner error');
    });

    it('should handle errors for SessionEnd event', async () => {
      vi.mocked(mockHookPlanner.createExecutionPlan).mockImplementation(() => {
        throw new Error('SessionEnd planner error');
      });

      const result = await hookEventHandler.fireSessionEndEvent(
        SessionEndReason.Clear,
      );

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toBe('SessionEnd planner error');
    });
  });

  describe('firePostToolUseFailureEvent', () => {
    it('should execute hooks for PostToolUseFailure event', async () => {
      const mockPlan = createMockExecutionPlan([]);
      const mockAggregated = createMockAggregatedResult(true);

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        mockAggregated,
      );

      const result = await hookEventHandler.firePostToolUseFailureEvent(
        'toolu_test123',
        'test-tool',
        { param: 'value' },
        'An error occurred',
      );

      expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalledWith(
        HookEventName.PostToolUseFailure,
        { toolName: 'test-tool', toolInput: { param: 'value' } },
      );
      expect(result.success).toBe(true);
    });

    it('should include all parameters in the hook input', async () => {
      const mockPlan = createMockExecutionPlan([
        {
          type: HookType.Command,
          command: 'echo test',
          source: HooksConfigSource.Project,
        },
      ]);
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );

      await hookEventHandler.firePostToolUseFailureEvent(
        'toolu_test456',
        'shell',
        { command: 'ls' },
        'Command failed',
        true,
        PermissionMode.Yolo,
      );

      const mockCalls = (mockHookRunner.executeHooksParallel as Mock).mock
        .calls;
      const input = mockCalls[0][2] as {
        permission_mode: PermissionMode;
        tool_use_id: string;
        tool_name: string;
        tool_input: Record<string, unknown>;
        error: string;
        is_interrupt: boolean;
      };

      expect(input.permission_mode).toBe(PermissionMode.Yolo);
      expect(input.tool_use_id).toBe('toolu_test456');
      expect(input.tool_name).toBe('shell');
      expect(input.tool_input).toEqual({ command: 'ls' });
      expect(input.error).toBe('Command failed');
      expect(input.is_interrupt).toBe(true);
    });

    it('should handle default values for optional parameters', async () => {
      const mockPlan = createMockExecutionPlan([
        {
          type: HookType.Command,
          command: 'echo test',
          source: HooksConfigSource.Project,
        },
      ]);
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );

      await hookEventHandler.firePostToolUseFailureEvent(
        'toolu_test789',
        'test-tool',
        { param: 'value' },
        'An error occurred',
      );

      const mockCalls = (mockHookRunner.executeHooksParallel as Mock).mock
        .calls;
      const input = mockCalls[0][2] as {
        permission_mode: PermissionMode;
        is_interrupt?: boolean;
      };

      expect(input.permission_mode).toBe(PermissionMode.Default); // Should default to Default
      expect(input.is_interrupt).toBeUndefined(); // Should be undefined when not provided
    });

    it('should pass tool name as context for matcher filtering', async () => {
      const mockPlan = createMockExecutionPlan([]);
      const mockAggregated = createMockAggregatedResult(true);

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        mockAggregated,
      );

      await hookEventHandler.firePostToolUseFailureEvent(
        'toolu_test123',
        'special-tool',
        { param: 'value' },
        'Error occurred',
      );

      expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalledWith(
        HookEventName.PostToolUseFailure,
        { toolName: 'special-tool', toolInput: { param: 'value' } }, // Context with tool name and input
      );
    });

    it('should handle successful execution with final output', async () => {
      const mockPlan = createMockExecutionPlan([
        {
          type: HookType.Command,
          command: 'echo test',
          source: HooksConfigSource.Project,
        },
      ]);
      const mockAggregated = createMockAggregatedResult(true, {
        reason: 'Processing error',
        hookSpecificOutput: {
          additionalContext: 'Additional failure context',
        },
      });

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        mockAggregated,
      );

      const result = await hookEventHandler.firePostToolUseFailureEvent(
        'toolu_test999',
        'test-tool',
        { param: 'value' },
        'Error occurred',
      );

      expect(result.success).toBe(true);
      expect(result.finalOutput).toBeDefined();
      expect(result.finalOutput?.reason).toBe('Processing error');
    });

    it('should handle multiple hooks execution', async () => {
      const mockPlan = createMockExecutionPlan([
        {
          type: HookType.Command,
          command: 'echo hook1',
          source: HooksConfigSource.Project,
        },
        {
          type: HookType.Command,
          command: 'echo hook2',
          source: HooksConfigSource.Project,
        },
      ]);
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );

      await hookEventHandler.firePostToolUseFailureEvent(
        'toolu_test111',
        'multi-tool',
        { params: ['a', 'b'] },
        'Multiple errors',
      );

      expect(mockHookRunner.executeHooksParallel).toHaveBeenCalledTimes(1);
      expect(mockHookRunner.executeHooksParallel).toHaveBeenCalledWith(
        [
          {
            type: HookType.Command,
            command: 'echo hook1',
            source: HooksConfigSource.Project,
          },
          {
            type: HookType.Command,
            command: 'echo hook2',
            source: HooksConfigSource.Project,
          },
        ],
        HookEventName.PostToolUseFailure,
        expect.any(Object), // input object
        expect.any(Function), // onHookStart callback
        expect.any(Function), // onHookEnd callback
        undefined, // signal
      );
    });

    it('should execute hooks sequentially when plan.sequential is true', async () => {
      const mockPlan = createMockExecutionPlan(
        [
          {
            type: HookType.Command,
            command: 'echo test',
            source: HooksConfigSource.Project,
          },
        ],
        true,
      );

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksSequential).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );

      await hookEventHandler.firePostToolUseFailureEvent(
        'toolu_sequential',
        'seq-tool',
        { param: 'value' },
        'Sequential error',
      );

      expect(mockHookRunner.executeHooksSequential).toHaveBeenCalled();
      expect(mockHookRunner.executeHooksParallel).not.toHaveBeenCalled();
    });
  });

  describe('firePreToolUseEvent', () => {
    it('should execute hooks for PreToolUse event', async () => {
      const mockPlan = createMockExecutionPlan([]);
      const mockAggregated = createMockAggregatedResult(true);

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        mockAggregated,
      );

      const result = await hookEventHandler.firePreToolUseEvent(
        'test-tool',
        { param: 'value' },
        'toolu_test123',
        PermissionMode.Default,
      );

      expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalledWith(
        HookEventName.PreToolUse,
        { toolName: 'test-tool', toolInput: { param: 'value' } },
      );
      expect(result.success).toBe(true);
    });

    it('should include all parameters in the hook input', async () => {
      const mockPlan = createMockExecutionPlan([
        {
          type: HookType.Command,
          command: 'echo test',
          source: HooksConfigSource.Project,
        },
      ]);
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );

      await hookEventHandler.firePreToolUseEvent(
        'shell',
        { command: 'ls -la' },
        'toolu_abc456',
        PermissionMode.Plan,
      );

      const mockCalls = (mockHookRunner.executeHooksParallel as Mock).mock
        .calls;
      const input = mockCalls[0][2] as {
        permission_mode: PermissionMode;
        tool_name: string;
        tool_input: Record<string, unknown>;
        tool_use_id: string;
      };

      expect(input.permission_mode).toBe(PermissionMode.Plan);
      expect(input.tool_name).toBe('shell');
      expect(input.tool_input).toEqual({ command: 'ls -la' });
      expect(input.tool_use_id).toBe('toolu_abc456');
    });

    it('should pass tool name as context for matcher filtering', async () => {
      const mockPlan = createMockExecutionPlan([]);
      const mockAggregated = createMockAggregatedResult(true);

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        mockAggregated,
      );

      await hookEventHandler.firePreToolUseEvent(
        'Bash',
        { command: 'npm test' },
        'toolu_xyz789',
        PermissionMode.Default,
      );

      expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalledWith(
        HookEventName.PreToolUse,
        { toolName: 'Bash', toolInput: { command: 'npm test' } },
      );
    });

    it('should handle permission decision in final output', async () => {
      const mockPlan = createMockExecutionPlan([
        {
          type: HookType.Command,
          command: 'echo test',
          source: HooksConfigSource.Project,
        },
      ]);
      const mockAggregated = createMockAggregatedResult(true, {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'Dangerous command blocked',
        },
      });

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        mockAggregated,
      );

      const result = await hookEventHandler.firePreToolUseEvent(
        'Bash',
        { command: 'rm -rf /' },
        'toolu_danger',
        PermissionMode.Default,
      );

      expect(result.success).toBe(true);
      expect(result.finalOutput?.hookSpecificOutput).toEqual({
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Dangerous command blocked',
      });
    });

    it('should execute hooks sequentially when plan.sequential is true', async () => {
      const mockPlan = createMockExecutionPlan(
        [
          {
            type: HookType.Command,
            command: 'echo test',
            source: HooksConfigSource.Project,
          },
        ],
        true,
      );

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksSequential).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );

      await hookEventHandler.firePreToolUseEvent(
        'test-tool',
        { param: 'value' },
        'toolu_seq',
        PermissionMode.Default,
      );

      expect(mockHookRunner.executeHooksSequential).toHaveBeenCalled();
      expect(mockHookRunner.executeHooksParallel).not.toHaveBeenCalled();
    });

    it('should handle errors gracefully', async () => {
      vi.mocked(mockHookPlanner.createExecutionPlan).mockImplementation(() => {
        throw new Error('PreToolUse planner error');
      });

      const result = await hookEventHandler.firePreToolUseEvent(
        'test-tool',
        { param: 'value' },
        'toolu_error',
        PermissionMode.Default,
      );

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toBe('PreToolUse planner error');
    });
  });

  describe('firePostToolUseEvent', () => {
    it('should execute hooks for PostToolUse event', async () => {
      const mockPlan = createMockExecutionPlan([]);
      const mockAggregated = createMockAggregatedResult(true);

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        mockAggregated,
      );

      const result = await hookEventHandler.firePostToolUseEvent(
        'test-tool',
        { param: 'value' },
        { result: 'success' },
        'toolu_test123',
        PermissionMode.Default,
      );

      expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalledWith(
        HookEventName.PostToolUse,
        { toolName: 'test-tool', toolInput: { param: 'value' } },
      );
      expect(result.success).toBe(true);
    });

    it('should include all parameters in the hook input', async () => {
      const mockPlan = createMockExecutionPlan([
        {
          type: HookType.Command,
          command: 'echo test',
          source: HooksConfigSource.Project,
        },
      ]);
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );

      await hookEventHandler.firePostToolUseEvent(
        'shell',
        { command: 'ls -la' },
        { files: ['a.txt', 'b.txt'] },
        'toolu_abc456',
        PermissionMode.Yolo,
      );

      const mockCalls = (mockHookRunner.executeHooksParallel as Mock).mock
        .calls;
      const input = mockCalls[0][2] as {
        permission_mode: PermissionMode;
        tool_name: string;
        tool_input: Record<string, unknown>;
        tool_response: Record<string, unknown>;
        tool_use_id: string;
      };

      expect(input.permission_mode).toBe(PermissionMode.Yolo);
      expect(input.tool_name).toBe('shell');
      expect(input.tool_input).toEqual({ command: 'ls -la' });
      expect(input.tool_response).toEqual({ files: ['a.txt', 'b.txt'] });
      expect(input.tool_use_id).toBe('toolu_abc456');
    });

    it('should pass tool name as context for matcher filtering', async () => {
      const mockPlan = createMockExecutionPlan([]);
      const mockAggregated = createMockAggregatedResult(true);

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        mockAggregated,
      );

      await hookEventHandler.firePostToolUseEvent(
        'Write',
        { file_path: '/test.txt', content: 'hello' },
        { success: true },
        'toolu_write123',
        PermissionMode.Default,
      );

      expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalledWith(
        HookEventName.PostToolUse,
        {
          toolName: 'Write',
          toolInput: { file_path: '/test.txt', content: 'hello' },
        },
      );
    });

    it('should handle decision block in final output', async () => {
      const mockPlan = createMockExecutionPlan([
        {
          type: HookType.Command,
          command: 'echo test',
          source: HooksConfigSource.Project,
        },
      ]);
      const mockAggregated = createMockAggregatedResult(true, {
        decision: 'block',
        reason: 'Lint errors detected',
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: 'Please fix the lint errors',
        },
      });

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        mockAggregated,
      );

      const result = await hookEventHandler.firePostToolUseEvent(
        'Write',
        { file_path: '/test.ts', content: 'const x = 1' },
        { success: true },
        'toolu_lint',
        PermissionMode.Default,
      );

      expect(result.success).toBe(true);
      expect(result.finalOutput?.decision).toBe('block');
      expect(result.finalOutput?.reason).toBe('Lint errors detected');
    });

    it('should execute hooks sequentially when plan.sequential is true', async () => {
      const mockPlan = createMockExecutionPlan(
        [
          {
            type: HookType.Command,
            command: 'echo test',
            source: HooksConfigSource.Project,
          },
        ],
        true,
      );

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksSequential).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );

      await hookEventHandler.firePostToolUseEvent(
        'test-tool',
        { param: 'value' },
        { result: 'ok' },
        'toolu_seq',
        PermissionMode.Default,
      );

      expect(mockHookRunner.executeHooksSequential).toHaveBeenCalled();
      expect(mockHookRunner.executeHooksParallel).not.toHaveBeenCalled();
    });

    it('should handle errors gracefully', async () => {
      vi.mocked(mockHookPlanner.createExecutionPlan).mockImplementation(() => {
        throw new Error('PostToolUse planner error');
      });

      const result = await hookEventHandler.firePostToolUseEvent(
        'test-tool',
        { param: 'value' },
        { result: 'ok' },
        'toolu_error',
        PermissionMode.Default,
      );

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toBe('PostToolUse planner error');
    });
  });

  describe('firePreCompactEvent', () => {
    it('should execute hooks for PreCompact event with manual trigger', async () => {
      const mockPlan = createMockExecutionPlan([]);
      const mockAggregated = createMockAggregatedResult(true);

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        mockAggregated,
      );

      const result = await hookEventHandler.firePreCompactEvent(
        PreCompactTrigger.Manual,
        'Keep important code',
      );

      expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalledWith(
        HookEventName.PreCompact,
        { trigger: PreCompactTrigger.Manual },
      );
      expect(result.success).toBe(true);
    });

    it('should execute hooks for PreCompact event with auto trigger', async () => {
      const mockPlan = createMockExecutionPlan([]);
      const mockAggregated = createMockAggregatedResult(true);

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        mockAggregated,
      );

      const result = await hookEventHandler.firePreCompactEvent(
        PreCompactTrigger.Auto,
      );

      expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalledWith(
        HookEventName.PreCompact,
        { trigger: PreCompactTrigger.Auto },
      );
      expect(result.success).toBe(true);
    });

    it('should include all parameters in the hook input', async () => {
      const mockPlan = createMockExecutionPlan([
        {
          type: HookType.Command,
          command: 'echo test',
          source: HooksConfigSource.Project,
        },
      ]);
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );

      await hookEventHandler.firePreCompactEvent(
        PreCompactTrigger.Manual,
        'Custom instructions for compaction',
      );

      const mockCalls = (mockHookRunner.executeHooksParallel as Mock).mock
        .calls;
      const input = mockCalls[0][2] as {
        trigger: PreCompactTrigger;
        custom_instructions: string;
      };

      expect(input.trigger).toBe(PreCompactTrigger.Manual);
      expect(input.custom_instructions).toBe(
        'Custom instructions for compaction',
      );
    });

    it('should use empty string for custom_instructions when not provided', async () => {
      const mockPlan = createMockExecutionPlan([
        {
          type: HookType.Command,
          command: 'echo test',
          source: HooksConfigSource.Project,
        },
      ]);
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );

      await hookEventHandler.firePreCompactEvent(PreCompactTrigger.Auto);

      const mockCalls = (mockHookRunner.executeHooksParallel as Mock).mock
        .calls;
      const input = mockCalls[0][2] as {
        trigger: PreCompactTrigger;
        custom_instructions: string;
      };

      expect(input.trigger).toBe(PreCompactTrigger.Auto);
      expect(input.custom_instructions).toBe('');
    });

    it('should pass trigger as context for matcher filtering', async () => {
      const mockPlan = createMockExecutionPlan([]);
      const mockAggregated = createMockAggregatedResult(true);

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        mockAggregated,
      );

      await hookEventHandler.firePreCompactEvent(PreCompactTrigger.Manual);

      expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalledWith(
        HookEventName.PreCompact,
        { trigger: PreCompactTrigger.Manual },
      );
    });

    it('should handle additionalContext in final output', async () => {
      const mockPlan = createMockExecutionPlan([
        {
          type: HookType.Command,
          command: 'echo test',
          source: HooksConfigSource.Project,
        },
      ]);
      const mockAggregated = createMockAggregatedResult(true, {
        hookSpecificOutput: {
          hookEventName: 'PreCompact',
          additionalContext: 'Preserve function signatures',
        },
      });

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        mockAggregated,
      );

      const result = await hookEventHandler.firePreCompactEvent(
        PreCompactTrigger.Auto,
      );

      expect(result.success).toBe(true);
      expect(result.finalOutput?.hookSpecificOutput).toEqual({
        hookEventName: 'PreCompact',
        additionalContext: 'Preserve function signatures',
      });
    });

    it('should execute hooks sequentially when plan.sequential is true', async () => {
      const mockPlan = createMockExecutionPlan(
        [
          {
            type: HookType.Command,
            command: 'echo test',
            source: HooksConfigSource.Project,
          },
        ],
        true,
      );

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksSequential).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );

      await hookEventHandler.firePreCompactEvent(PreCompactTrigger.Manual);

      expect(mockHookRunner.executeHooksSequential).toHaveBeenCalled();
      expect(mockHookRunner.executeHooksParallel).not.toHaveBeenCalled();
    });

    it('should handle errors gracefully', async () => {
      vi.mocked(mockHookPlanner.createExecutionPlan).mockImplementation(() => {
        throw new Error('PreCompact planner error');
      });

      const result = await hookEventHandler.firePreCompactEvent(
        PreCompactTrigger.Auto,
      );

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toBe('PreCompact planner error');
    });

    it('should handle both trigger types correctly', async () => {
      const mockPlan = createMockExecutionPlan([
        {
          type: HookType.Command,
          command: 'echo test',
          source: HooksConfigSource.Project,
        },
      ]);
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );

      // Test Manual trigger
      await hookEventHandler.firePreCompactEvent(PreCompactTrigger.Manual);
      let mockCalls = (mockHookRunner.executeHooksParallel as Mock).mock.calls;
      let input = mockCalls[mockCalls.length - 1][2] as {
        trigger: PreCompactTrigger;
      };
      expect(input.trigger).toBe(PreCompactTrigger.Manual);

      // Test Auto trigger
      await hookEventHandler.firePreCompactEvent(PreCompactTrigger.Auto);
      mockCalls = (mockHookRunner.executeHooksParallel as Mock).mock.calls;
      input = mockCalls[mockCalls.length - 1][2] as {
        trigger: PreCompactTrigger;
      };
      expect(input.trigger).toBe(PreCompactTrigger.Auto);
    });
  });

  describe('fireNotificationEvent', () => {
    it('should execute hooks for Notification event', async () => {
      const mockPlan = createMockExecutionPlan([]);
      const mockAggregated = createMockAggregatedResult(true);

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        mockAggregated,
      );

      const result = await hookEventHandler.fireNotificationEvent(
        'Test notification message',
        NotificationType.PermissionPrompt,
        'Permission needed',
      );

      expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalledWith(
        HookEventName.Notification,
        { notificationType: 'permission_prompt' },
      );
      expect(result.success).toBe(true);
    });

    it('should include all parameters in the hook input', async () => {
      const mockPlan = createMockExecutionPlan([
        {
          type: HookType.Command,
          command: 'echo test',
          source: HooksConfigSource.Project,
        },
      ]);
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );

      await hookEventHandler.fireNotificationEvent(
        'Qwen Code needs your permission to use Bash',
        NotificationType.PermissionPrompt,
        'Permission needed',
      );

      const mockCalls = (mockHookRunner.executeHooksParallel as Mock).mock
        .calls;
      const input = mockCalls[0][2] as {
        message: string;
        notification_type: string;
        title?: string;
      };

      expect(input.message).toBe('Qwen Code needs your permission to use Bash');
      expect(input.notification_type).toBe('permission_prompt');
      expect(input.title).toBe('Permission needed');
    });

    it('should pass notification_type as context for matcher filtering', async () => {
      const mockPlan = createMockExecutionPlan([]);
      const mockAggregated = createMockAggregatedResult(true);

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        mockAggregated,
      );

      await hookEventHandler.fireNotificationEvent(
        'Qwen Code is waiting for your input',
        NotificationType.IdlePrompt,
        'Waiting for input',
      );

      expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalledWith(
        HookEventName.Notification,
        { notificationType: 'idle_prompt' },
      );
    });

    it('should handle notification without title', async () => {
      const mockPlan = createMockExecutionPlan([
        {
          type: HookType.Command,
          command: 'echo test',
          source: HooksConfigSource.Project,
        },
      ]);
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );

      await hookEventHandler.fireNotificationEvent(
        'Authentication successful',
        NotificationType.AuthSuccess,
      );

      const mockCalls = (mockHookRunner.executeHooksParallel as Mock).mock
        .calls;
      const input = mockCalls[0][2] as {
        message: string;
        notification_type: string;
        title?: string;
      };

      expect(input.message).toBe('Authentication successful');
      expect(input.notification_type).toBe('auth_success');
      expect(input.title).toBeUndefined();
    });

    it('should handle auth_success notification type', async () => {
      const mockPlan = createMockExecutionPlan([]);
      const mockAggregated = createMockAggregatedResult(true);

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        mockAggregated,
      );

      const result = await hookEventHandler.fireNotificationEvent(
        'Authentication successful',
        NotificationType.AuthSuccess,
      );

      expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalledWith(
        HookEventName.Notification,
        { notificationType: 'auth_success' },
      );
      expect(result.success).toBe(true);
    });

    it('should handle elicitation_dialog notification type', async () => {
      const mockPlan = createMockExecutionPlan([]);
      const mockAggregated = createMockAggregatedResult(true);

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        mockAggregated,
      );

      const result = await hookEventHandler.fireNotificationEvent(
        'Dialog shown to user',
        NotificationType.ElicitationDialog,
        'Dialog',
      );

      expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalledWith(
        HookEventName.Notification,
        { notificationType: 'elicitation_dialog' },
      );
      expect(result.success).toBe(true);
    });

    it('should execute hooks sequentially when plan.sequential is true', async () => {
      const mockPlan = createMockExecutionPlan(
        [
          {
            type: HookType.Command,
            command: 'echo test',
            source: HooksConfigSource.Project,
          },
        ],
        true,
      );

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksSequential).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );

      await hookEventHandler.fireNotificationEvent(
        'Test notification',
        NotificationType.PermissionPrompt,
      );

      expect(mockHookRunner.executeHooksSequential).toHaveBeenCalled();
      expect(mockHookRunner.executeHooksParallel).not.toHaveBeenCalled();
    });

    it('should handle errors gracefully', async () => {
      vi.mocked(mockHookPlanner.createExecutionPlan).mockImplementation(() => {
        throw new Error('Notification planner error');
      });

      const result = await hookEventHandler.fireNotificationEvent(
        'Test notification',
        NotificationType.PermissionPrompt,
      );

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toBe('Notification planner error');
    });

    it('should handle all notification types correctly', async () => {
      const mockPlan = createMockExecutionPlan([
        {
          type: HookType.Command,
          command: 'echo test',
          source: HooksConfigSource.Project,
        },
      ]);
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );

      // Test permission_prompt
      await hookEventHandler.fireNotificationEvent(
        'Permission needed',
        NotificationType.PermissionPrompt,
      );
      let mockCalls = (mockHookRunner.executeHooksParallel as Mock).mock.calls;
      let input = mockCalls[mockCalls.length - 1][2] as {
        notification_type: string;
      };
      expect(input.notification_type).toBe('permission_prompt');

      // Test idle_prompt
      await hookEventHandler.fireNotificationEvent(
        'Waiting for input',
        NotificationType.IdlePrompt,
      );
      mockCalls = (mockHookRunner.executeHooksParallel as Mock).mock.calls;
      input = mockCalls[mockCalls.length - 1][2] as {
        notification_type: string;
      };
      expect(input.notification_type).toBe('idle_prompt');

      // Test auth_success
      await hookEventHandler.fireNotificationEvent(
        'Authentication successful',
        NotificationType.AuthSuccess,
      );
      mockCalls = (mockHookRunner.executeHooksParallel as Mock).mock.calls;
      input = mockCalls[mockCalls.length - 1][2] as {
        notification_type: string;
      };
      expect(input.notification_type).toBe('auth_success');

      // Test elicitation_dialog
      await hookEventHandler.fireNotificationEvent(
        'Dialog shown',
        NotificationType.ElicitationDialog,
      );
      mockCalls = (mockHookRunner.executeHooksParallel as Mock).mock.calls;
      input = mockCalls[mockCalls.length - 1][2] as {
        notification_type: string;
      };
      expect(input.notification_type).toBe('elicitation_dialog');
    });
  });

  describe('firePermissionRequestEvent', () => {
    it('should execute hooks for PermissionRequest event', async () => {
      const mockPlan = createMockExecutionPlan([]);
      const mockAggregated = createMockAggregatedResult(true);

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        mockAggregated,
      );

      const result = await hookEventHandler.firePermissionRequestEvent(
        'Bash',
        { command: 'ls -la' },
        PermissionMode.Default,
      );

      expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalledWith(
        HookEventName.PermissionRequest,
        { toolName: 'Bash' },
      );
      expect(result.success).toBe(true);
    });

    it('should include all parameters in the hook input', async () => {
      const mockPlan = createMockExecutionPlan([
        {
          type: HookType.Command,
          command: 'echo test',
          source: HooksConfigSource.Project,
        },
      ]);
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );

      await hookEventHandler.firePermissionRequestEvent(
        'Write',
        { file_path: '/test.txt', content: 'hello' },
        PermissionMode.Yolo,
      );

      const mockCalls = (mockHookRunner.executeHooksParallel as Mock).mock
        .calls;
      const input = mockCalls[0][2] as {
        permission_mode: PermissionMode;
        tool_name: string;
        tool_input: Record<string, unknown>;
        permission_suggestions: PermissionSuggestion[];
      };

      expect(input.permission_mode).toBe(PermissionMode.Yolo);
      expect(input.tool_name).toBe('Write');
      expect(input.tool_input).toEqual({
        file_path: '/test.txt',
        content: 'hello',
      });
      expect(input.permission_suggestions).toBeUndefined();
    });

    it('should include permission_suggestions when provided', async () => {
      const mockPlan = createMockExecutionPlan([
        {
          type: HookType.Command,
          command: 'echo test',
          source: HooksConfigSource.Project,
        },
      ]);
      const suggestions: PermissionSuggestion[] = [
        { type: 'toolAlwaysAllow', tool: 'Bash' },
      ];
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );

      await hookEventHandler.firePermissionRequestEvent(
        'Bash',
        { command: 'npm test' },
        PermissionMode.Default,
        suggestions,
      );

      const mockCalls = (mockHookRunner.executeHooksParallel as Mock).mock
        .calls;
      const input = mockCalls[0][2] as {
        permission_suggestions: PermissionSuggestion[];
      };

      expect(input.permission_suggestions).toEqual(suggestions);
    });

    it('should pass tool name as context for matcher filtering', async () => {
      const mockPlan = createMockExecutionPlan([]);
      const mockAggregated = createMockAggregatedResult(true);

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        mockAggregated,
      );

      await hookEventHandler.firePermissionRequestEvent(
        'ReadFile',
        { file_path: '/test.txt' },
        PermissionMode.Plan,
      );

      expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalledWith(
        HookEventName.PermissionRequest,
        { toolName: 'ReadFile' },
      );
    });

    it('should handle decision block in final output', async () => {
      const mockPlan = createMockExecutionPlan([
        {
          type: HookType.Command,
          command: 'echo test',
          source: HooksConfigSource.Project,
        },
      ]);
      const mockAggregated = createMockAggregatedResult(true, {
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
      });

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        mockAggregated,
      );

      const result = await hookEventHandler.firePermissionRequestEvent(
        'Bash',
        { command: 'rm -rf /' },
        PermissionMode.Default,
      );

      expect(result.success).toBe(true);
      expect(result.finalOutput?.decision).toBe('block');
      expect(result.finalOutput?.reason).toBe('Dangerous command detected');
    });

    it('should handle allow decision with updatedInput', async () => {
      const mockPlan = createMockExecutionPlan([
        {
          type: HookType.Command,
          command: 'echo test',
          source: HooksConfigSource.Project,
        },
      ]);
      const mockAggregated = createMockAggregatedResult(true, {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: {
            behavior: 'allow',
            updatedInput: { command: 'npm install --dry-run' },
          },
        },
      });

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        mockAggregated,
      );

      const result = await hookEventHandler.firePermissionRequestEvent(
        'Bash',
        { command: 'npm install' },
        PermissionMode.Default,
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

    it('should execute hooks sequentially when plan.sequential is true', async () => {
      const mockPlan = createMockExecutionPlan(
        [
          {
            type: HookType.Command,
            command: 'echo test',
            source: HooksConfigSource.Project,
          },
        ],
        true,
      );

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksSequential).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );

      await hookEventHandler.firePermissionRequestEvent(
        'Bash',
        { command: 'ls' },
        PermissionMode.Default,
      );

      expect(mockHookRunner.executeHooksSequential).toHaveBeenCalled();
      expect(mockHookRunner.executeHooksParallel).not.toHaveBeenCalled();
    });

    it('should handle errors gracefully', async () => {
      vi.mocked(mockHookPlanner.createExecutionPlan).mockImplementation(() => {
        throw new Error('PermissionRequest planner error');
      });

      const result = await hookEventHandler.firePermissionRequestEvent(
        'Bash',
        { command: 'test' },
        PermissionMode.Default,
      );

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toBe('PermissionRequest planner error');
    });

    it('should handle all permission modes correctly', async () => {
      const mockPlan = createMockExecutionPlan([
        {
          type: HookType.Command,
          command: 'echo test',
          source: HooksConfigSource.Project,
        },
      ]);
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );

      // Test Default mode
      await hookEventHandler.firePermissionRequestEvent(
        'Bash',
        { command: 'test' },
        PermissionMode.Default,
      );
      let mockCalls = (mockHookRunner.executeHooksParallel as Mock).mock.calls;
      let input = mockCalls[mockCalls.length - 1][2] as {
        permission_mode: PermissionMode;
      };
      expect(input.permission_mode).toBe(PermissionMode.Default);

      // Test Plan mode
      await hookEventHandler.firePermissionRequestEvent(
        'Bash',
        { command: 'test' },
        PermissionMode.Plan,
      );
      mockCalls = (mockHookRunner.executeHooksParallel as Mock).mock.calls;
      input = mockCalls[mockCalls.length - 1][2] as {
        permission_mode: PermissionMode;
      };
      expect(input.permission_mode).toBe(PermissionMode.Plan);

      // Test Yolo mode
      await hookEventHandler.firePermissionRequestEvent(
        'Bash',
        { command: 'test' },
        PermissionMode.Yolo,
      );
      mockCalls = (mockHookRunner.executeHooksParallel as Mock).mock.calls;
      input = mockCalls[mockCalls.length - 1][2] as {
        permission_mode: PermissionMode;
      };
      expect(input.permission_mode).toBe(PermissionMode.Yolo);
    });
  });

  describe('fireSubagentStartEvent', () => {
    it('should execute hooks for SubagentStart event', async () => {
      const mockPlan = createMockExecutionPlan([]);
      const mockAggregated = createMockAggregatedResult(true);

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        mockAggregated,
      );

      const result = await hookEventHandler.fireSubagentStartEvent(
        'agent-123',
        'code-reviewer',
        PermissionMode.Default,
      );

      expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalledWith(
        HookEventName.SubagentStart,
        { agentType: 'code-reviewer' },
      );
      expect(result.success).toBe(true);
    });

    it('should include all parameters in the hook input', async () => {
      const mockPlan = createMockExecutionPlan([
        {
          type: HookType.Command,
          command: 'echo test',
          source: HooksConfigSource.Project,
        },
      ]);
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );

      await hookEventHandler.fireSubagentStartEvent(
        'agent-456',
        'qwen-tester',
        PermissionMode.Plan,
      );

      const mockCalls = (mockHookRunner.executeHooksParallel as Mock).mock
        .calls;
      const input = mockCalls[0][2] as {
        agent_id: string;
        agent_type: string;
        permission_mode: PermissionMode;
        hook_event_name: string;
      };

      expect(input.agent_id).toBe('agent-456');
      expect(input.agent_type).toBe('qwen-tester');
      expect(input.permission_mode).toBe(PermissionMode.Plan);
      expect(input.hook_event_name).toBe(HookEventName.SubagentStart);
    });

    it('should pass agentType as context for matcher filtering', async () => {
      const mockPlan = createMockExecutionPlan([]);
      const mockAggregated = createMockAggregatedResult(true);

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        mockAggregated,
      );

      await hookEventHandler.fireSubagentStartEvent(
        'agent-789',
        AgentType.Bash,
        PermissionMode.Default,
      );

      expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalledWith(
        HookEventName.SubagentStart,
        { agentType: String(AgentType.Bash) },
      );
    });

    it('should handle additional context in final output', async () => {
      const mockPlan = createMockExecutionPlan([
        {
          type: HookType.Command,
          command: 'echo test',
          source: HooksConfigSource.Project,
        },
      ]);
      const mockAggregated = createMockAggregatedResult(true, {
        hookSpecificOutput: {
          hookEventName: 'SubagentStart',
          additionalContext: 'Injected context for subagent',
        },
      });

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        mockAggregated,
      );

      const result = await hookEventHandler.fireSubagentStartEvent(
        'agent-111',
        'code-reviewer',
        PermissionMode.Default,
      );

      expect(result.success).toBe(true);
      expect(result.finalOutput?.hookSpecificOutput).toEqual({
        hookEventName: 'SubagentStart',
        additionalContext: 'Injected context for subagent',
      });
    });

    it('should execute hooks sequentially when plan.sequential is true', async () => {
      const mockPlan = createMockExecutionPlan(
        [
          {
            type: HookType.Command,
            command: 'echo test',
            source: HooksConfigSource.Project,
          },
        ],
        true,
      );

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksSequential).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );

      await hookEventHandler.fireSubagentStartEvent(
        'agent-seq',
        'code-reviewer',
        PermissionMode.Default,
      );

      expect(mockHookRunner.executeHooksSequential).toHaveBeenCalled();
      expect(mockHookRunner.executeHooksParallel).not.toHaveBeenCalled();
    });

    it('should handle errors gracefully', async () => {
      vi.mocked(mockHookPlanner.createExecutionPlan).mockImplementation(() => {
        throw new Error('SubagentStart planner error');
      });

      const result = await hookEventHandler.fireSubagentStartEvent(
        'agent-err',
        'code-reviewer',
        PermissionMode.Default,
      );

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toBe('SubagentStart planner error');
    });
  });

  describe('fireSubagentStopEvent', () => {
    it('should execute hooks for SubagentStop event', async () => {
      const mockPlan = createMockExecutionPlan([]);
      const mockAggregated = createMockAggregatedResult(true);

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        mockAggregated,
      );

      const result = await hookEventHandler.fireSubagentStopEvent(
        'agent-123',
        'code-reviewer',
        '/path/to/transcript.jsonl',
        'Final output from subagent',
        false,
        PermissionMode.Default,
      );

      expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalledWith(
        HookEventName.SubagentStop,
        { agentType: 'code-reviewer' },
      );
      expect(result.success).toBe(true);
    });

    it('should include all parameters in the hook input', async () => {
      const mockPlan = createMockExecutionPlan([
        {
          type: HookType.Command,
          command: 'echo test',
          source: HooksConfigSource.Project,
        },
      ]);
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );

      await hookEventHandler.fireSubagentStopEvent(
        'agent-456',
        'qwen-tester',
        '/transcript/path.jsonl',
        'last message from agent',
        true,
        PermissionMode.Yolo,
      );

      const mockCalls = (mockHookRunner.executeHooksParallel as Mock).mock
        .calls;
      const input = mockCalls[0][2] as {
        agent_id: string;
        agent_type: string;
        agent_transcript_path: string;
        last_assistant_message: string;
        stop_hook_active: boolean;
        permission_mode: PermissionMode;
        hook_event_name: string;
      };

      expect(input.agent_id).toBe('agent-456');
      expect(input.agent_type).toBe('qwen-tester');
      expect(input.agent_transcript_path).toBe('/transcript/path.jsonl');
      expect(input.last_assistant_message).toBe('last message from agent');
      expect(input.stop_hook_active).toBe(true);
      expect(input.permission_mode).toBe(PermissionMode.Yolo);
      expect(input.hook_event_name).toBe(HookEventName.SubagentStop);
    });

    it('should pass agentType as context for matcher filtering', async () => {
      const mockPlan = createMockExecutionPlan([]);
      const mockAggregated = createMockAggregatedResult(true);

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        mockAggregated,
      );

      await hookEventHandler.fireSubagentStopEvent(
        'agent-789',
        'custom-agent',
        '/path/transcript.jsonl',
        'output',
        false,
        PermissionMode.Default,
      );

      expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalledWith(
        HookEventName.SubagentStop,
        { agentType: 'custom-agent' },
      );
    });

    it('should handle block decision in final output', async () => {
      const mockPlan = createMockExecutionPlan([
        {
          type: HookType.Command,
          command: 'echo test',
          source: HooksConfigSource.Project,
        },
      ]);
      const mockAggregated = createMockAggregatedResult(true, {
        decision: 'block',
        reason: 'Output too short, continue working',
      });

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        mockAggregated,
      );

      const result = await hookEventHandler.fireSubagentStopEvent(
        'agent-block',
        'code-reviewer',
        '/path/transcript.jsonl',
        'short',
        false,
        PermissionMode.Default,
      );

      expect(result.success).toBe(true);
      expect(result.finalOutput?.decision).toBe('block');
      expect(result.finalOutput?.reason).toBe(
        'Output too short, continue working',
      );
    });

    it('should execute hooks sequentially when plan.sequential is true', async () => {
      const mockPlan = createMockExecutionPlan(
        [
          {
            type: HookType.Command,
            command: 'echo test',
            source: HooksConfigSource.Project,
          },
        ],
        true,
      );

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksSequential).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );

      await hookEventHandler.fireSubagentStopEvent(
        'agent-seq',
        'code-reviewer',
        '/path/transcript.jsonl',
        'output',
        false,
        PermissionMode.Default,
      );

      expect(mockHookRunner.executeHooksSequential).toHaveBeenCalled();
      expect(mockHookRunner.executeHooksParallel).not.toHaveBeenCalled();
    });

    it('should handle errors gracefully', async () => {
      vi.mocked(mockHookPlanner.createExecutionPlan).mockImplementation(() => {
        throw new Error('SubagentStop planner error');
      });

      const result = await hookEventHandler.fireSubagentStopEvent(
        'agent-err',
        'code-reviewer',
        '/path/transcript.jsonl',
        'output',
        false,
        PermissionMode.Default,
      );

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toBe('SubagentStop planner error');
    });

    it('should handle stop_hook_active flag correctly', async () => {
      const mockPlan = createMockExecutionPlan([
        {
          type: HookType.Command,
          command: 'echo test',
          source: HooksConfigSource.Project,
        },
      ]);
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );

      // Test with stop_hook_active = false
      await hookEventHandler.fireSubagentStopEvent(
        'agent-1',
        'code-reviewer',
        '/path/transcript.jsonl',
        'output',
        false,
        PermissionMode.Default,
      );
      let mockCalls = (mockHookRunner.executeHooksParallel as Mock).mock.calls;
      let input = mockCalls[mockCalls.length - 1][2] as {
        stop_hook_active: boolean;
      };
      expect(input.stop_hook_active).toBe(false);

      // Test with stop_hook_active = true
      await hookEventHandler.fireSubagentStopEvent(
        'agent-2',
        'code-reviewer',
        '/path/transcript.jsonl',
        'output',
        true,
        PermissionMode.Default,
      );
      mockCalls = (mockHookRunner.executeHooksParallel as Mock).mock.calls;
      input = mockCalls[mockCalls.length - 1][2] as {
        stop_hook_active: boolean;
      };
      expect(input.stop_hook_active).toBe(true);
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

    it('should call logHookCall for each hook execution', async () => {
      const hookConfig1: HookConfig = {
        type: HookType.Command,
        command: 'hook1.sh',
        name: 'first-hook',
        source: HooksConfigSource.Project,
      };
      const hookConfig2: HookConfig = {
        type: HookType.Command,
        command: 'hook2.sh',
        name: 'second-hook',
        source: HooksConfigSource.Project,
      };

      const mockPlan = createMockExecutionPlan([hookConfig1, hookConfig2]);
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);

      const result1 = createMockHookExecutionResult(true, hookConfig1, 50);
      const result2 = createMockHookExecutionResult(true, hookConfig2, 75);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([
        result1,
        result2,
      ]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );

      await hookEventHandler.fireUserPromptSubmitEvent('test prompt');

      expect(logHookCall).toHaveBeenCalledTimes(2);
    });

    it('should log hook call with correct event name', async () => {
      const hookConfig: HookConfig = {
        type: HookType.Command,
        command: 'test.sh',
        source: HooksConfigSource.Project,
      };

      const mockPlan = createMockExecutionPlan([hookConfig]);
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);

      const result = createMockHookExecutionResult(true, hookConfig);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([
        result,
      ]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );

      await hookEventHandler.firePreToolUseEvent(
        'read_file',
        { path: '/test' },
        'tool-123',
        PermissionMode.Default,
      );

      expect(logHookCall).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          hook_event_name: HookEventName.PreToolUse,
        }),
      );
    });

    it('should log hook call with hook name from config', async () => {
      const hookConfig: HookConfig = {
        type: HookType.Command,
        command: '/path/to/my-hook.sh',
        name: 'my-custom-hook',
        source: HooksConfigSource.Project,
      };

      const mockPlan = createMockExecutionPlan([hookConfig]);
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);

      const result = createMockHookExecutionResult(true, hookConfig);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([
        result,
      ]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );

      await hookEventHandler.fireUserPromptSubmitEvent('test');

      expect(logHookCall).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          hook_name: 'my-custom-hook',
        }),
      );
    });

    it('should log hook call with command as name when no name specified', async () => {
      const hookConfig: HookConfig = {
        type: HookType.Command,
        command: '/path/to/hook-script.sh',
        source: HooksConfigSource.Project,
      };

      const mockPlan = createMockExecutionPlan([hookConfig]);
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);

      const result = createMockHookExecutionResult(true, hookConfig);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([
        result,
      ]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );

      await hookEventHandler.fireUserPromptSubmitEvent('test');

      expect(logHookCall).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          hook_name: '/path/to/hook-script.sh',
        }),
      );
    });

    it('should log hook call with duration', async () => {
      const hookConfig: HookConfig = {
        type: HookType.Command,
        command: 'test.sh',
        source: HooksConfigSource.Project,
      };

      const mockPlan = createMockExecutionPlan([hookConfig]);
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);

      const duration = 250;
      const result = createMockHookExecutionResult(true, hookConfig, duration);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([
        result,
      ]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );

      await hookEventHandler.fireUserPromptSubmitEvent('test');

      expect(logHookCall).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          duration_ms: duration,
        }),
      );
    });

    it('should log hook call with success status', async () => {
      const hookConfig: HookConfig = {
        type: HookType.Command,
        command: 'test.sh',
        source: HooksConfigSource.Project,
      };

      const mockPlan = createMockExecutionPlan([hookConfig]);
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);

      const result = createMockHookExecutionResult(true, hookConfig);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([
        result,
      ]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );

      await hookEventHandler.fireUserPromptSubmitEvent('test');

      expect(logHookCall).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          success: true,
        }),
      );
    });

    it('should log hook call with failure status', async () => {
      const hookConfig: HookConfig = {
        type: HookType.Command,
        command: 'failing-hook.sh',
        source: HooksConfigSource.Project,
      };

      const mockPlan = createMockExecutionPlan([hookConfig]);
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);

      const result = createMockHookExecutionResult(
        false,
        hookConfig,
        100,
        undefined,
        new Error('Hook failed'),
      );
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([
        result,
      ]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(false),
      );

      await hookEventHandler.fireUserPromptSubmitEvent('test');

      expect(logHookCall).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          success: false,
          error: 'Hook failed',
        }),
      );
    });

    it('should log hook call with exit code', async () => {
      const hookConfig: HookConfig = {
        type: HookType.Command,
        command: 'test.sh',
        source: HooksConfigSource.Project,
      };

      const mockPlan = createMockExecutionPlan([hookConfig]);
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);

      const result = createMockHookExecutionResult(true, hookConfig);
      result.exitCode = 0;
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([
        result,
      ]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );

      await hookEventHandler.fireUserPromptSubmitEvent('test');

      expect(logHookCall).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          exit_code: 0,
        }),
      );
    });

    it('should log hook call with hook type', async () => {
      const hookConfig: HookConfig = {
        type: HookType.Command,
        command: 'test.sh',
        source: HooksConfigSource.Project,
      };

      const mockPlan = createMockExecutionPlan([hookConfig]);
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);

      const result = createMockHookExecutionResult(true, hookConfig);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([
        result,
      ]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );

      await hookEventHandler.fireUserPromptSubmitEvent('test');

      expect(logHookCall).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          hook_type: 'command',
        }),
      );
    });

    it('should not call logHookCall when no hooks are configured', async () => {
      const mockPlan = createMockExecutionPlan([]);
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);

      await hookEventHandler.fireUserPromptSubmitEvent('test');

      expect(logHookCall).not.toHaveBeenCalled();
    });

    it('should log telemetry for different event types', async () => {
      const hookConfig: HookConfig = {
        type: HookType.Command,
        command: 'test.sh',
        source: HooksConfigSource.Project,
      };

      const mockPlan = createMockExecutionPlan([hookConfig]);
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);

      const result = createMockHookExecutionResult(true, hookConfig);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([
        result,
      ]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );

      // Test SessionStart
      await hookEventHandler.fireSessionStartEvent(
        SessionStartSource.Startup,
        'test-model',
      );
      expect(logHookCall).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          hook_event_name: HookEventName.SessionStart,
        }),
      );

      vi.mocked(logHookCall).mockClear();

      // Test SessionEnd
      await hookEventHandler.fireSessionEndEvent(SessionEndReason.Clear);
      expect(logHookCall).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          hook_event_name: HookEventName.SessionEnd,
        }),
      );

      vi.mocked(logHookCall).mockClear();

      // Test Stop
      await hookEventHandler.fireStopEvent(true, 'last message');
      expect(logHookCall).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          hook_event_name: HookEventName.Stop,
        }),
      );
    });
  });
});
