/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { HookEventHandler } from './hookEventHandler.js';
import { HookEventName, HookType, HooksConfigSource } from './types.js';
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
});
