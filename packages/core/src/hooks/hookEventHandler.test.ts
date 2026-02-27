/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { HookEventHandler } from './hookEventHandler.js';
import {
  HookEventName,
  HookType,
  HooksConfigSource,
  NotificationType,
  SessionStartSource,
  SessionEndReason,
  PreCompactTrigger,
} from './types.js';
import type { Config } from '../config/config.js';
import type {
  HookPlanner,
  HookRunner,
  HookAggregator,
  AggregatedHookResult,
} from './index.js';
import type { HookConfig, HookExecutionResult, HookOutput } from './types.js';

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

  const createMockExecutionResult = (
    success: boolean = true,
    output?: HookOutput,
  ): HookExecutionResult => ({
    hookConfig: { type: HookType.Command, command: 'echo test' },
    eventName: HookEventName.PreToolUse,
    success,
    output,
    duration: 100,
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

  describe('firePreToolUseEvent', () => {
    it('should execute hooks for PreToolUse event', async () => {
      const mockPlan = createMockExecutionPlan([
        {
          type: HookType.Command,
          command: 'echo test',
          source: HooksConfigSource.Project,
        },
      ]);
      const mockResults = [
        createMockExecutionResult(true, { decision: 'allow' }),
      ];
      const mockAggregated = createMockAggregatedResult(true, {
        decision: 'allow',
      });

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue(
        mockResults,
      );
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        mockAggregated,
      );

      const result = await hookEventHandler.firePreToolUseEvent('Read', {
        path: '/test/file.txt',
      });

      expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalledWith(
        HookEventName.PreToolUse,
        { toolName: 'Read' },
      );
      expect(mockHookRunner.executeHooksParallel).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should include tool name and input in the hook input', async () => {
      // Need to provide at least one hook config so the runner is called
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

      await hookEventHandler.firePreToolUseEvent('Edit', { file: '/test.txt' });

      // Verify the mock was called
      expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalled();
      expect(mockHookRunner.executeHooksParallel).toHaveBeenCalled();

      // Get the input parameter (3rd argument, index 2)
      const inputArg = (mockHookRunner.executeHooksParallel as Mock).mock
        .calls[0][2];
      expect(inputArg.tool_name).toBe('Edit');
      expect(inputArg.tool_input).toEqual({ file: '/test.txt' });
    });

    it('should include mcp_context when provided', async () => {
      const mockPlan = createMockExecutionPlan([
        {
          type: HookType.Command,
          command: 'echo test',
          source: HooksConfigSource.Project,
        },
      ]);
      const mcpContext = {
        server_name: 'test-server',
        tool_name: 'mcp-tool',
        command: 'npx',
      };

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true),
      );

      await hookEventHandler.firePreToolUseEvent('Bash', {}, mcpContext);

      const mockCalls = (mockHookRunner.executeHooksParallel as Mock).mock
        .calls;
      const input = mockCalls[0][2] as { mcp_context?: typeof mcpContext };
      expect(input.mcp_context).toEqual(mcpContext);
    });

    it('should return empty result when no hooks are configured', async () => {
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(null);

      const result = await hookEventHandler.firePreToolUseEvent('Read', {});

      expect(result.success).toBe(true);
      expect(result.allOutputs).toEqual([]);
    });
  });

  describe('firePostToolUseEvent', () => {
    it('should execute hooks for PostToolUse event', async () => {
      const mockPlan = createMockExecutionPlan([
        {
          type: HookType.Command,
          command: 'echo test',
          source: HooksConfigSource.Project,
        },
      ]);
      const mockResults = [
        createMockExecutionResult(true, { decision: 'allow' }),
      ];
      const mockAggregated = createMockAggregatedResult(true, {
        decision: 'allow',
      });

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue(
        mockResults,
      );
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        mockAggregated,
      );

      const result = await hookEventHandler.firePostToolUseEvent(
        'Read',
        { path: '/test/file.txt' },
        { content: 'file content' },
      );

      expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalledWith(
        HookEventName.PostToolUse,
        { toolName: 'Read' },
      );
      expect(result.success).toBe(true);
    });

    it('should include tool_response in the hook input', async () => {
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
        'Read',
        { path: '/test.txt' },
        { content: 'hello' },
      );

      const mockCalls = (mockHookRunner.executeHooksParallel as Mock).mock
        .calls;
      const input = mockCalls[0][2] as {
        tool_response: Record<string, unknown>;
      };
      expect(input.tool_response).toEqual({ content: 'hello' });
    });
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
        NotificationType.ToolPermission,
        'Test message',
        { key: 'value' },
      );

      expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalledWith(
        HookEventName.Notification,
        undefined,
      );
      expect(result.success).toBe(true);
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
      );

      expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalledWith(
        HookEventName.SessionStart,
        { trigger: SessionStartSource.Startup },
      );
      expect(result.success).toBe(true);
    });

    it('should include source in hook input', async () => {
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

      await hookEventHandler.fireSessionStartEvent(SessionStartSource.Resume);

      const mockCalls = (mockHookRunner.executeHooksParallel as Mock).mock
        .calls;
      const input = mockCalls[0][2] as { source: string };
      expect(input.source).toBe(SessionStartSource.Resume);
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

    it('should include reason in hook input', async () => {
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
      const input = mockCalls[0][2] as { reason: string };
      expect(input.reason).toBe(SessionEndReason.Logout);
    });
  });

  describe('firePreCompactEvent', () => {
    it('should execute hooks for PreCompact event', async () => {
      const mockPlan = createMockExecutionPlan([]);
      const mockAggregated = createMockAggregatedResult(true);

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        mockAggregated,
      );

      const result = await hookEventHandler.firePreCompactEvent(
        PreCompactTrigger.Manual,
      );

      expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalledWith(
        HookEventName.PreCompact,
        { trigger: PreCompactTrigger.Manual },
      );
      expect(result.success).toBe(true);
    });

    it('should include trigger in hook input', async () => {
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
      const input = mockCalls[0][2] as { trigger: string };
      expect(input.trigger).toBe(PreCompactTrigger.Auto);
    });
  });

  describe('base input creation', () => {
    it('should include common fields in all hook inputs', async () => {
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

      await hookEventHandler.firePreToolUseEvent('Read', {});

      const mockCalls = (mockHookRunner.executeHooksParallel as Mock).mock
        .calls;
      const input = mockCalls[0][2] as {
        session_id: string;
        transcript_path: string;
        cwd: string;
        hook_event_name: string;
        timestamp: string;
      };

      expect(input.session_id).toBe('test-session-id');
      expect(input.transcript_path).toBe('/test/transcript');
      expect(input.cwd).toBe('/test/cwd');
      expect(input.hook_event_name).toBe(HookEventName.PreToolUse);
      expect(input.timestamp).toBeDefined();
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

      await hookEventHandler.firePreToolUseEvent('Read', {});

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

      await hookEventHandler.firePreToolUseEvent('Read', {});

      expect(mockHookRunner.executeHooksParallel).toHaveBeenCalled();
      expect(mockHookRunner.executeHooksSequential).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should return error result when hook execution throws', async () => {
      vi.mocked(mockHookPlanner.createExecutionPlan).mockImplementation(() => {
        throw new Error('Planner error');
      });

      const result = await hookEventHandler.firePreToolUseEvent('Read', {});

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

      const result = await hookEventHandler.firePreToolUseEvent('Read', {});

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toBe('Runner error');
    });
  });

  describe('processCommonHookOutputFields', () => {
    it('should handle systemMessage in final output', async () => {
      const mockPlan = createMockExecutionPlan([]);
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true, {
          systemMessage: 'test system message',
        }),
      );

      await hookEventHandler.firePreToolUseEvent('Read', {});

      // The method processes the output - we just verify it doesn't throw
      expect(true).toBe(true);
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

      // The method processes the output - we just verify it doesn't throw
      expect(true).toBe(true);
    });

    it('should handle suppressOutput in final output', async () => {
      const mockPlan = createMockExecutionPlan([]);
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true, { suppressOutput: true }),
      );

      await hookEventHandler.firePreToolUseEvent('Read', {});

      // The method processes the output - we just verify it doesn't throw
      expect(true).toBe(true);
    });

    it('should handle missing finalOutput gracefully', async () => {
      const mockPlan = createMockExecutionPlan([]);
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        createMockAggregatedResult(true, undefined),
      );

      const result = await hookEventHandler.firePreToolUseEvent('Read', {});

      expect(result.success).toBe(true);
      expect(result.finalOutput).toBeUndefined();
    });
  });
});
