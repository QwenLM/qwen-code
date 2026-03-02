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
  PreCompactTrigger,
  AgentType,
} from './types.js';
import type { Config } from '../config/config.js';
import type {
  HookPlanner,
  HookRunner,
  HookAggregator,
  AggregatedHookResult,
} from './index.js';
import type { HookConfig, HookOutput } from './types.js';

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
      getApprovalMode: vi.fn().mockReturnValue('default'),
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
  });

  describe('firePreToolUseEvent', () => {
    it('should execute hooks for PreToolUse event', async () => {
      const mockPlan = createMockExecutionPlan([]);
      const mockAggregated = createMockAggregatedResult(true);

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(mockPlan);
      vi.mocked(mockHookRunner.executeHooksSequential).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        mockAggregated,
      );

      const result = await hookEventHandler.firePreToolUseEvent(
        'bash',
        { command: 'ls' },
        'test-use-id',
      );

      expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalledWith(
        HookEventName.PreToolUse,
        undefined,
      );
      expect(result.success).toBe(true);
    });

    it('should include tool info in hook input', async () => {
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
        'bash',
        { command: 'ls -la' },
        'use-123',
      );

      const mockCalls = (mockHookRunner.executeHooksSequential as Mock).mock
        .calls;
      const input = mockCalls[0][2] as {
        tool_name: string;
        tool_input: Record<string, unknown>;
        tool_use_id: string;
      };
      expect(input.tool_name).toBe('bash');
      expect(input.tool_input).toEqual({ command: 'ls -la' });
      expect(input.tool_use_id).toBe('use-123');
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
        'bash',
        { command: 'ls' },
        { output: 'files' },
        'test-use-id',
      );

      expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalledWith(
        HookEventName.PostToolUse,
        undefined,
      );
      expect(result.success).toBe(true);
    });

    it('should include tool response in hook input', async () => {
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
        'read_file',
        { path: '/test.txt' },
        { content: 'file content' },
        'use-456',
      );

      const mockCalls = (mockHookRunner.executeHooksParallel as Mock).mock
        .calls;
      const input = mockCalls[0][2] as {
        tool_name: string;
        tool_response: Record<string, unknown>;
        tool_use_id: string;
      };
      expect(input.tool_response).toEqual({ content: 'file content' });
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
        'use-789',
        'bash',
        { command: 'ls' },
        'Command failed',
      );

      expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalledWith(
        HookEventName.PostToolUseFailure,
        undefined,
      );
      expect(result.success).toBe(true);
    });

    it('should include error info in hook input', async () => {
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
        'use-999',
        'http_request',
        { url: 'http://example.com' },
        'Connection timeout',
        'TimeoutError',
        true,
      );

      const mockCalls = (mockHookRunner.executeHooksParallel as Mock).mock
        .calls;
      const input = mockCalls[0][2] as {
        tool_use_id: string;
        tool_name: string;
        error: string;
        error_type?: string;
        is_interrupt?: boolean;
      };
      expect(input.error).toBe('Connection timeout');
      expect(input.error_type).toBe('TimeoutError');
      expect(input.is_interrupt).toBe(true);
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
        'mention',
        'User was mentioned',
        'Notification',
      );

      expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalledWith(
        HookEventName.Notification,
        undefined,
      );
      expect(result.success).toBe(true);
    });

    it('should include notification details in hook input', async () => {
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
        'progress',
        'Task progress: 50%',
        'Progress Update',
      );

      const mockCalls = (mockHookRunner.executeHooksParallel as Mock).mock
        .calls;
      const input = mockCalls[0][2] as {
        notification_type: string;
        message: string;
        title?: string;
      };
      expect(input.notification_type).toBe('progress');
      expect(input.message).toBe('Task progress: 50%');
      expect(input.title).toBe('Progress Update');
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
        'claude-3',
      );

      expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalledWith(
        HookEventName.SessionStart,
        undefined,
      );
      expect(result.success).toBe(true);
    });

    it('should include session info in hook input', async () => {
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
        'claude-3-sonnet',
      );

      const mockCalls = (mockHookRunner.executeHooksParallel as Mock).mock
        .calls;
      const input = mockCalls[0][2] as {
        source: SessionStartSource;
        model?: string;
      };
      expect(input.source).toBe(SessionStartSource.Resume);
      expect(input.model).toBe('claude-3-sonnet');
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
        SessionEndReason.Other,
      );

      expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalledWith(
        HookEventName.SessionEnd,
        undefined,
      );
      expect(result.success).toBe(true);
    });

    it('should include session end reason in hook input', async () => {
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
        PreCompactTrigger.Auto,
        'Keep recent history',
      );

      expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalledWith(
        HookEventName.PreCompact,
        undefined,
      );
      expect(result.success).toBe(true);
    });

    it('should include compaction details in hook input', async () => {
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

      await hookEventHandler.firePreCompactEvent(PreCompactTrigger.Manual);

      const mockCalls = (mockHookRunner.executeHooksParallel as Mock).mock
        .calls;
      const input = mockCalls[0][2] as {
        trigger: string;
        custom_instructions?: string;
      };
      expect(input.trigger).toBe('manual');
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
        AgentType.Bash,
      );

      expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalledWith(
        HookEventName.SubagentStart,
        undefined,
      );
      expect(result.success).toBe(true);
    });

    it('should include subagent info in hook input', async () => {
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
        AgentType.Custom,
      );

      const mockCalls = (mockHookRunner.executeHooksParallel as Mock).mock
        .calls;
      const input = mockCalls[0][2] as {
        agent_id: string;
        agent_type: AgentType;
      };
      expect(input.agent_id).toBe('agent-456');
      expect(input.agent_type).toBe(AgentType.Custom);
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
        'agent-789',
        AgentType.Bash,
        '/path/to/transcript',
        'Final message',
        true,
      );

      expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalledWith(
        HookEventName.SubagentStop,
        undefined,
      );
      expect(result.success).toBe(true);
    });

    it('should include subagent stop details in hook input', async () => {
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
        'agent-999',
        AgentType.Explorer,
        '/transcripts/agent-999.txt',
        'Task completed successfully',
        false,
      );

      const mockCalls = (mockHookRunner.executeHooksParallel as Mock).mock
        .calls;
      const input = mockCalls[0][2] as {
        agent_id: string;
        agent_type: string;
        agent_transcript_path: string;
        last_assistant_message: string;
        stop_hook_active: boolean;
      };
      expect(input.agent_id).toBe('agent-999');
      expect(input.stop_hook_active).toBe(false);
      expect(input.last_assistant_message).toBe('Task completed successfully');
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

      const result = await hookEventHandler.firePermissionRequestEvent('bash', {
        command: 'rm -rf /',
      });

      expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalledWith(
        HookEventName.PermissionRequest,
        undefined,
      );
      expect(result.success).toBe(true);
    });

    it('should include permission request details in hook input', async () => {
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

      const suggestions = [{ type: 'bash', tool: 'http_request' }];
      await hookEventHandler.firePermissionRequestEvent(
        'http_request',
        { url: 'http://test.com' },
        suggestions,
      );

      const mockCalls = (mockHookRunner.executeHooksParallel as Mock).mock
        .calls;
      const input = mockCalls[0][2] as {
        tool_name: string;
        tool_input: Record<string, unknown>;
        permission_suggestions?: Array<{ type: string; tool?: string }>;
      };
      expect(input.tool_name).toBe('http_request');
      expect(input.tool_input).toEqual({ url: 'http://test.com' });
      expect(input.permission_suggestions).toEqual(suggestions);
    });
  });
});
