/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TaskTool, type TaskParams } from './task.js';
import type { PartListUnion } from '@google/genai';
import type { ToolResultDisplay, TaskResultDisplay } from './tools.js';
import type { Config } from '../config/config.js';
import { SubagentManager } from '../subagents/subagent-manager.js';
import type { SubagentConfig } from '../subagents/types.js';
import { AgentTerminateMode } from '../agents/runtime/agent-types.js';
import {
  type AgentHeadless,
  ContextState,
} from '../agents/runtime/agent-headless.js';
import { partToString } from '../utils/partUtils.js';
import type { HookSystem } from '../hooks/hookSystem.js';
import { PermissionMode } from '../hooks/types.js';

// Type for accessing protected methods in tests
type TaskToolWithProtectedMethods = TaskTool & {
  createInvocation: (params: TaskParams) => {
    execute: (
      signal?: AbortSignal,
      liveOutputCallback?: (chunk: string) => void,
    ) => Promise<{
      llmContent: PartListUnion;
      returnDisplay: ToolResultDisplay;
    }>;
    getDescription: () => string;
    shouldConfirmExecute: () => Promise<boolean>;
  };
};

// Mock dependencies
vi.mock('../subagents/subagent-manager.js');
vi.mock('../agents/runtime/agent-headless.js');

const MockedSubagentManager = vi.mocked(SubagentManager);
const MockedContextState = vi.mocked(ContextState);

describe('TaskTool', () => {
  let config: Config;
  let taskTool: TaskTool;
  let mockSubagentManager: SubagentManager;
  let changeListeners: Array<() => void>;

  const mockSubagents: SubagentConfig[] = [
    {
      name: 'file-search',
      description: 'Specialized agent for searching and analyzing files',
      systemPrompt: 'You are a file search specialist.',
      level: 'project',
      filePath: '/project/.qwen/agents/file-search.md',
    },
    {
      name: 'code-review',
      description: 'Agent for reviewing code quality and best practices',
      systemPrompt: 'You are a code review specialist.',
      level: 'user',
      filePath: '/home/user/.qwen/agents/code-review.md',
    },
  ];

  beforeEach(async () => {
    // Setup fake timers
    vi.useFakeTimers();

    // Create mock config
    config = {
      getProjectRoot: vi.fn().mockReturnValue('/test/project'),
      getSessionId: vi.fn().mockReturnValue('test-session-id'),
      getSubagentManager: vi.fn(),
      getGeminiClient: vi.fn().mockReturnValue(undefined),
      getHookSystem: vi.fn().mockReturnValue(undefined),
      getTranscriptPath: vi.fn().mockReturnValue('/test/transcript'),
    } as unknown as Config;

    changeListeners = [];

    // Setup SubagentManager mock
    mockSubagentManager = {
      listSubagents: vi.fn().mockResolvedValue(mockSubagents),
      loadSubagent: vi.fn(),
      createAgentHeadless: vi.fn(),
      addChangeListener: vi.fn((listener: () => void) => {
        changeListeners.push(listener);
        return () => {
          const index = changeListeners.indexOf(listener);
          if (index >= 0) {
            changeListeners.splice(index, 1);
          }
        };
      }),
    } as unknown as SubagentManager;

    MockedSubagentManager.mockImplementation(() => mockSubagentManager);

    // Make config return the mock SubagentManager
    vi.mocked(config.getSubagentManager).mockReturnValue(mockSubagentManager);

    // Create TaskTool instance
    taskTool = new TaskTool(config);

    // Allow async initialization to complete
    await vi.runAllTimersAsync();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('initialization', () => {
    it('should initialize with correct name and properties', () => {
      expect(taskTool.name).toBe('task');
      expect(taskTool.displayName).toBe('Task');
      expect(taskTool.kind).toBe('other');
    });

    it('should load available subagents during initialization', () => {
      expect(mockSubagentManager.listSubagents).toHaveBeenCalled();
    });

    it('should subscribe to subagent manager changes', () => {
      expect(mockSubagentManager.addChangeListener).toHaveBeenCalledTimes(1);
    });

    it('should update description with available subagents', () => {
      expect(taskTool.description).toContain('file-search');
      expect(taskTool.description).toContain(
        'Specialized agent for searching and analyzing files',
      );
      expect(taskTool.description).toContain('code-review');
      expect(taskTool.description).toContain(
        'Agent for reviewing code quality and best practices',
      );
    });

    it('should handle empty subagents list gracefully', async () => {
      vi.mocked(mockSubagentManager.listSubagents).mockResolvedValue([]);

      const emptyTaskTool = new TaskTool(config);
      await vi.runAllTimersAsync();

      expect(emptyTaskTool.description).toContain(
        'No subagents are currently configured',
      );
    });

    it('should handle subagent loading errors gracefully', async () => {
      vi.mocked(mockSubagentManager.listSubagents).mockRejectedValue(
        new Error('Loading failed'),
      );

      const failedTaskTool = new TaskTool(config);
      await vi.runAllTimersAsync();

      expect(failedTaskTool.description).toContain(
        'No subagents are currently configured',
      );
    });
  });

  describe('schema generation', () => {
    it('should generate schema with subagent names as enum', () => {
      const schema = taskTool.schema;
      const properties = schema.parametersJsonSchema as {
        properties: {
          subagent_type: {
            enum?: string[];
          };
        };
      };
      expect(properties.properties.subagent_type.enum).toEqual([
        'file-search',
        'code-review',
      ]);
    });

    it('should generate schema without enum when no subagents available', async () => {
      vi.mocked(mockSubagentManager.listSubagents).mockResolvedValue([]);

      const emptyTaskTool = new TaskTool(config);
      await vi.runAllTimersAsync();

      const schema = emptyTaskTool.schema;
      const properties = schema.parametersJsonSchema as {
        properties: {
          subagent_type: {
            enum?: string[];
          };
        };
      };
      expect(properties.properties.subagent_type.enum).toBeUndefined();
    });
  });

  describe('validateToolParams', () => {
    const validParams: TaskParams = {
      description: 'Search files',
      prompt: 'Find all TypeScript files in the project',
      subagent_type: 'file-search',
    };

    it('should validate valid parameters', async () => {
      const result = taskTool.validateToolParams(validParams);
      expect(result).toBeNull();
    });

    it('should reject empty description', async () => {
      const result = taskTool.validateToolParams({
        ...validParams,
        description: '',
      });
      expect(result).toBe(
        'Parameter "description" must be a non-empty string.',
      );
    });

    it('should reject empty prompt', async () => {
      const result = taskTool.validateToolParams({
        ...validParams,
        prompt: '',
      });
      expect(result).toBe('Parameter "prompt" must be a non-empty string.');
    });

    it('should reject empty subagent_type', async () => {
      const result = taskTool.validateToolParams({
        ...validParams,
        subagent_type: '',
      });
      expect(result).toBe(
        'Parameter "subagent_type" must be a non-empty string.',
      );
    });

    it('should reject non-existent subagent', async () => {
      const result = taskTool.validateToolParams({
        ...validParams,
        subagent_type: 'non-existent',
      });
      expect(result).toBe(
        'Subagent "non-existent" not found. Available subagents: file-search, code-review',
      );
    });
  });

  describe('refreshSubagents', () => {
    it('should refresh when change listener fires', async () => {
      const newSubagents: SubagentConfig[] = [
        {
          name: 'new-agent',
          description: 'A brand new agent',
          systemPrompt: 'Do new things.',
          level: 'project',
          filePath: '/project/.qwen/agents/new-agent.md',
        },
      ];

      vi.mocked(mockSubagentManager.listSubagents).mockResolvedValueOnce(
        newSubagents,
      );

      const listener = changeListeners[0];
      expect(listener).toBeDefined();

      listener?.();
      await vi.runAllTimersAsync();

      expect(taskTool.description).toContain('new-agent');
      expect(taskTool.description).toContain('A brand new agent');
    });

    it('should refresh available subagents and update description', async () => {
      const newSubagents: SubagentConfig[] = [
        {
          name: 'test-agent',
          description: 'A test agent',
          systemPrompt: 'Test prompt',
          level: 'project',
          filePath: '/project/.qwen/agents/test-agent.md',
        },
      ];

      vi.mocked(mockSubagentManager.listSubagents).mockResolvedValue(
        newSubagents,
      );

      await taskTool.refreshSubagents();

      expect(taskTool.description).toContain('test-agent');
      expect(taskTool.description).toContain('A test agent');
    });
  });

  describe('TaskToolInvocation', () => {
    let mockSubagentScope: AgentHeadless;
    let mockContextState: ContextState;

    beforeEach(() => {
      mockSubagentScope = {
        execute: vi.fn().mockResolvedValue(undefined),
        result: 'Task completed successfully',
        terminateMode: AgentTerminateMode.GOAL,
        getFinalText: vi.fn().mockReturnValue('Task completed successfully'),
        formatCompactResult: vi
          .fn()
          .mockReturnValue(
            '✅ Success: Search files completed with GOAL termination',
          ),
        getExecutionSummary: vi.fn().mockReturnValue({
          rounds: 2,
          totalDurationMs: 1500,
          totalToolCalls: 3,
          successfulToolCalls: 3,
          failedToolCalls: 0,
          successRate: 100,
          inputTokens: 1000,
          outputTokens: 500,
          totalTokens: 1500,
          toolUsage: [
            {
              name: 'grep',
              count: 2,
              success: 2,
              failure: 0,
              totalDurationMs: 800,
              averageDurationMs: 400,
            },
            {
              name: 'read_file',
              count: 1,
              success: 1,
              failure: 0,
              totalDurationMs: 200,
              averageDurationMs: 200,
            },
          ],
        }),
        getStatistics: vi.fn().mockReturnValue({
          rounds: 2,
          totalDurationMs: 1500,
          totalToolCalls: 3,
          successfulToolCalls: 3,
          failedToolCalls: 0,
        }),
        getTerminateMode: vi.fn().mockReturnValue(AgentTerminateMode.GOAL),
      } as unknown as AgentHeadless;

      mockContextState = {
        set: vi.fn(),
      } as unknown as ContextState;

      MockedContextState.mockImplementation(() => mockContextState);

      vi.mocked(mockSubagentManager.loadSubagent).mockResolvedValue(
        mockSubagents[0],
      );
      vi.mocked(mockSubagentManager.createAgentHeadless).mockResolvedValue(
        mockSubagentScope,
      );
    });

    it('should execute subagent successfully', async () => {
      const params: TaskParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
      };

      const invocation = (
        taskTool as TaskToolWithProtectedMethods
      ).createInvocation(params);
      const result = await invocation.execute();

      expect(mockSubagentManager.loadSubagent).toHaveBeenCalledWith(
        'file-search',
      );
      expect(mockSubagentManager.createAgentHeadless).toHaveBeenCalledWith(
        mockSubagents[0],
        config,
        expect.any(Object), // eventEmitter parameter
      );
      expect(mockSubagentScope.execute).toHaveBeenCalledWith(
        mockContextState,
        undefined, // signal parameter (undefined when not provided)
      );

      const llmText = partToString(result.llmContent);
      expect(llmText).toBe('Task completed successfully');
      const display = result.returnDisplay as TaskResultDisplay;
      expect(display.type).toBe('task_execution');
      expect(display.status).toBe('completed');
      expect(display.subagentName).toBe('file-search');
    });

    it('should handle subagent not found error', async () => {
      vi.mocked(mockSubagentManager.loadSubagent).mockResolvedValue(null);

      const params: TaskParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'non-existent',
      };

      const invocation = (
        taskTool as TaskToolWithProtectedMethods
      ).createInvocation(params);
      const result = await invocation.execute();

      const llmText = partToString(result.llmContent);
      expect(llmText).toContain('Subagent "non-existent" not found');
      const display = result.returnDisplay as TaskResultDisplay;
      expect(display.status).toBe('failed');
      expect(display.subagentName).toBe('non-existent');
    });

    it('should handle execution errors gracefully', async () => {
      vi.mocked(mockSubagentManager.createAgentHeadless).mockRejectedValue(
        new Error('Creation failed'),
      );

      const params: TaskParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
      };

      const invocation = (
        taskTool as TaskToolWithProtectedMethods
      ).createInvocation(params);
      const result = await invocation.execute();

      const llmText = partToString(result.llmContent);
      expect(llmText).toContain('Failed to run subagent: Creation failed');
      const display = result.returnDisplay as TaskResultDisplay;

      expect(display.status).toBe('failed');
    });

    it('should execute subagent without live output callback', async () => {
      const params: TaskParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
      };

      const invocation = (
        taskTool as TaskToolWithProtectedMethods
      ).createInvocation(params);
      const result = await invocation.execute();

      // Verify that the task completed successfully
      expect(result.llmContent).toBeDefined();
      expect(result.returnDisplay).toBeDefined();

      // Verify the result has the expected structure
      const text = partToString(result.llmContent);
      expect(text).toBe('Task completed successfully');
      const display = result.returnDisplay as TaskResultDisplay;
      expect(display.status).toBe('completed');
      expect(display.subagentName).toBe('file-search');
    });

    it('should set context variables correctly', async () => {
      const params: TaskParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
      };

      const invocation = (
        taskTool as TaskToolWithProtectedMethods
      ).createInvocation(params);
      await invocation.execute();

      expect(mockContextState.set).toHaveBeenCalledWith(
        'task_prompt',
        'Find all TypeScript files',
      );
    });

    it('should return structured display object', async () => {
      const params: TaskParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
      };

      const invocation = (
        taskTool as TaskToolWithProtectedMethods
      ).createInvocation(params);
      const result = await invocation.execute();

      expect(typeof result.returnDisplay).toBe('object');
      expect(result.returnDisplay).toHaveProperty('type', 'task_execution');
      expect(result.returnDisplay).toHaveProperty(
        'subagentName',
        'file-search',
      );
      expect(result.returnDisplay).toHaveProperty(
        'taskDescription',
        'Search files',
      );
      expect(result.returnDisplay).toHaveProperty('status', 'completed');
    });

    it('should not require confirmation', async () => {
      const params: TaskParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
      };

      const invocation = (
        taskTool as TaskToolWithProtectedMethods
      ).createInvocation(params);
      const shouldConfirm = await invocation.shouldConfirmExecute();

      expect(shouldConfirm).toBe(false);
    });

    it('should provide correct description', async () => {
      const params: TaskParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
      };

      const invocation = (
        taskTool as TaskToolWithProtectedMethods
      ).createInvocation(params);
      const description = invocation.getDescription();

      expect(description).toBe('file-search subagent: "Search files"');
    });
  });

  describe('SubagentStart hook integration', () => {
    let mockSubagentScope: SubAgentScope;
    let mockContextState: ContextState;
    let mockHookSystem: HookSystem;

    beforeEach(() => {
      mockSubagentScope = {
        runNonInteractive: vi.fn().mockResolvedValue(undefined),
        result: 'Task completed successfully',
        terminateMode: SubagentTerminateMode.GOAL,
        getFinalText: vi.fn().mockReturnValue('Task completed successfully'),
        formatCompactResult: vi.fn().mockReturnValue('✅ Success'),
        getExecutionSummary: vi.fn().mockReturnValue({
          rounds: 1,
          totalDurationMs: 500,
          totalToolCalls: 1,
          successfulToolCalls: 1,
          failedToolCalls: 0,
          successRate: 100,
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          estimatedCost: 0.01,
          toolUsage: [],
        }),
        getStatistics: vi.fn().mockReturnValue({
          rounds: 1,
          totalDurationMs: 500,
          totalToolCalls: 1,
          successfulToolCalls: 1,
          failedToolCalls: 0,
        }),
        getTerminateMode: vi.fn().mockReturnValue(SubagentTerminateMode.GOAL),
      } as unknown as SubAgentScope;

      mockContextState = {
        set: vi.fn(),
      } as unknown as ContextState;

      MockedContextState.mockImplementation(() => mockContextState);

      vi.mocked(mockSubagentManager.loadSubagent).mockResolvedValue(
        mockSubagents[0],
      );
      vi.mocked(mockSubagentManager.createSubagentScope).mockResolvedValue(
        mockSubagentScope,
      );

      mockHookSystem = {
        fireSubagentStartEvent: vi.fn().mockResolvedValue(undefined),
        fireSubagentStopEvent: vi.fn().mockResolvedValue(undefined),
      } as unknown as HookSystem;

      vi.mocked(config.getGeminiClient).mockReturnValue(undefined as never);
      (config as unknown as Record<string, unknown>)['getHookSystem'] = vi
        .fn()
        .mockReturnValue(mockHookSystem);
      (config as unknown as Record<string, unknown>)['getTranscriptPath'] = vi
        .fn()
        .mockReturnValue('/test/transcript');
    });

    it('should call fireSubagentStartEvent before execution', async () => {
      const params: TaskParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
      };

      const invocation = (
        taskTool as TaskToolWithProtectedMethods
      ).createInvocation(params);
      await invocation.execute();

      expect(mockHookSystem.fireSubagentStartEvent).toHaveBeenCalledWith(
        expect.stringContaining('file-search-'),
        'file-search',
        PermissionMode.Default,
      );
    });

    it('should inject additionalContext from SubagentStart hook into context', async () => {
      const mockStartOutput = {
        getAdditionalContext: vi
          .fn()
          .mockReturnValue('Extra context from hook'),
      };
      vi.mocked(mockHookSystem.fireSubagentStartEvent).mockResolvedValue(
        mockStartOutput as never,
      );

      const params: TaskParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
      };

      const invocation = (
        taskTool as TaskToolWithProtectedMethods
      ).createInvocation(params);
      await invocation.execute();

      expect(mockContextState.set).toHaveBeenCalledWith(
        'hook_context',
        'Extra context from hook',
      );
    });

    it('should not inject hook_context when additionalContext is undefined', async () => {
      const mockStartOutput = {
        getAdditionalContext: vi.fn().mockReturnValue(undefined),
      };
      vi.mocked(mockHookSystem.fireSubagentStartEvent).mockResolvedValue(
        mockStartOutput as never,
      );

      const params: TaskParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
      };

      const invocation = (
        taskTool as TaskToolWithProtectedMethods
      ).createInvocation(params);
      await invocation.execute();

      expect(mockContextState.set).not.toHaveBeenCalledWith(
        'hook_context',
        expect.anything(),
      );
    });

    it('should continue execution when SubagentStart hook fails', async () => {
      vi.mocked(mockHookSystem.fireSubagentStartEvent).mockRejectedValue(
        new Error('Hook failed'),
      );

      const params: TaskParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
      };

      const invocation = (
        taskTool as TaskToolWithProtectedMethods
      ).createInvocation(params);
      const result = await invocation.execute();

      // Should still complete successfully despite hook failure
      const llmText = partToString(result.llmContent);
      expect(llmText).toBe('Task completed successfully');
      const display = result.returnDisplay as TaskResultDisplay;
      expect(display.status).toBe('completed');
    });

    it('should skip hooks when hookSystem is not available', async () => {
      (config as unknown as Record<string, unknown>)['getHookSystem'] = vi
        .fn()
        .mockReturnValue(undefined);

      const params: TaskParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
      };

      const invocation = (
        taskTool as TaskToolWithProtectedMethods
      ).createInvocation(params);
      const result = await invocation.execute();

      expect(mockHookSystem.fireSubagentStartEvent).not.toHaveBeenCalled();
      const llmText = partToString(result.llmContent);
      expect(llmText).toBe('Task completed successfully');
    });
  });

  describe('SubagentStop hook integration', () => {
    let mockSubagentScope: SubAgentScope;
    let mockContextState: ContextState;
    let mockHookSystem: HookSystem;

    beforeEach(() => {
      mockSubagentScope = {
        runNonInteractive: vi.fn().mockResolvedValue(undefined),
        result: 'Task completed successfully',
        terminateMode: SubagentTerminateMode.GOAL,
        getFinalText: vi.fn().mockReturnValue('Task completed successfully'),
        formatCompactResult: vi.fn().mockReturnValue('✅ Success'),
        getExecutionSummary: vi.fn().mockReturnValue({
          rounds: 1,
          totalDurationMs: 500,
          totalToolCalls: 1,
          successfulToolCalls: 1,
          failedToolCalls: 0,
          successRate: 100,
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          estimatedCost: 0.01,
          toolUsage: [],
        }),
        getStatistics: vi.fn().mockReturnValue({
          rounds: 1,
          totalDurationMs: 500,
          totalToolCalls: 1,
          successfulToolCalls: 1,
          failedToolCalls: 0,
        }),
        getTerminateMode: vi.fn().mockReturnValue(SubagentTerminateMode.GOAL),
      } as unknown as SubAgentScope;

      mockContextState = {
        set: vi.fn(),
      } as unknown as ContextState;

      MockedContextState.mockImplementation(() => mockContextState);

      vi.mocked(mockSubagentManager.loadSubagent).mockResolvedValue(
        mockSubagents[0],
      );
      vi.mocked(mockSubagentManager.createSubagentScope).mockResolvedValue(
        mockSubagentScope,
      );

      mockHookSystem = {
        fireSubagentStartEvent: vi.fn().mockResolvedValue(undefined),
        fireSubagentStopEvent: vi.fn().mockResolvedValue(undefined),
      } as unknown as HookSystem;

      vi.mocked(config.getGeminiClient).mockReturnValue(undefined as never);
      (config as unknown as Record<string, unknown>)['getHookSystem'] = vi
        .fn()
        .mockReturnValue(mockHookSystem);
      (config as unknown as Record<string, unknown>)['getTranscriptPath'] = vi
        .fn()
        .mockReturnValue('/test/transcript');
    });

    it('should call fireSubagentStopEvent after execution', async () => {
      const params: TaskParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
      };

      const invocation = (
        taskTool as TaskToolWithProtectedMethods
      ).createInvocation(params);
      await invocation.execute();

      expect(mockHookSystem.fireSubagentStopEvent).toHaveBeenCalledWith(
        expect.stringContaining('file-search-'),
        'file-search',
        '/test/transcript',
        'Task completed successfully',
        false,
        PermissionMode.Default,
      );
    });

    it('should re-execute subagent when stop hook returns blocking decision', async () => {
      const mockBlockOutput = {
        isBlockingDecision: vi
          .fn()
          .mockReturnValueOnce(true)
          .mockReturnValueOnce(false),
        shouldStopExecution: vi.fn().mockReturnValue(false),
        getEffectiveReason: vi
          .fn()
          .mockReturnValue('Continue working on the task'),
      };

      // First call returns block, second call returns allow (no output)
      vi.mocked(mockHookSystem.fireSubagentStopEvent)
        .mockResolvedValueOnce(mockBlockOutput as never)
        .mockResolvedValueOnce(undefined as never);

      const params: TaskParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
      };

      const invocation = (
        taskTool as TaskToolWithProtectedMethods
      ).createInvocation(params);
      await invocation.execute();

      // Should have called runNonInteractive twice (initial + re-execution)
      expect(mockSubagentScope.runNonInteractive).toHaveBeenCalledTimes(2);
      // Stop hook should have been called twice
      expect(mockHookSystem.fireSubagentStopEvent).toHaveBeenCalledTimes(2);
      // Second call should have stopHookActive=true
      expect(mockHookSystem.fireSubagentStopEvent).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('file-search-'),
        'file-search',
        '/test/transcript',
        'Task completed successfully',
        true,
        PermissionMode.Default,
      );
    });

    it('should re-execute subagent when stop hook returns shouldStopExecution', async () => {
      const mockStopOutput = {
        isBlockingDecision: vi.fn().mockReturnValue(false),
        shouldStopExecution: vi.fn().mockReturnValueOnce(true),
        getEffectiveReason: vi.fn().mockReturnValue('Output is incomplete'),
      };

      vi.mocked(mockHookSystem.fireSubagentStopEvent)
        .mockResolvedValueOnce(mockStopOutput as never)
        .mockResolvedValueOnce(undefined as never);

      const params: TaskParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
      };

      const invocation = (
        taskTool as TaskToolWithProtectedMethods
      ).createInvocation(params);
      await invocation.execute();

      expect(mockSubagentScope.runNonInteractive).toHaveBeenCalledTimes(2);
    });

    it('should allow stop when SubagentStop hook fails', async () => {
      vi.mocked(mockHookSystem.fireSubagentStopEvent).mockRejectedValue(
        new Error('Stop hook failed'),
      );

      const params: TaskParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
      };

      const invocation = (
        taskTool as TaskToolWithProtectedMethods
      ).createInvocation(params);
      const result = await invocation.execute();

      // Should still complete successfully despite hook failure
      const llmText = partToString(result.llmContent);
      expect(llmText).toBe('Task completed successfully');
      const display = result.returnDisplay as TaskResultDisplay;
      expect(display.status).toBe('completed');
    });

    it('should skip SubagentStop hook when signal is aborted', async () => {
      const abortController = new AbortController();
      abortController.abort();

      const params: TaskParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
      };

      const invocation = (
        taskTool as TaskToolWithProtectedMethods
      ).createInvocation(params);
      await invocation.execute(abortController.signal);

      expect(mockHookSystem.fireSubagentStopEvent).not.toHaveBeenCalled();
    });

    it('should stop re-execution loop when signal is aborted during block handling', async () => {
      const abortController = new AbortController();

      const mockBlockOutput = {
        isBlockingDecision: vi.fn().mockReturnValue(true),
        shouldStopExecution: vi.fn().mockReturnValue(false),
        getEffectiveReason: vi.fn().mockReturnValue('Keep working'),
      };

      vi.mocked(mockHookSystem.fireSubagentStopEvent).mockResolvedValue(
        mockBlockOutput as never,
      );

      // Abort after first re-execution
      vi.mocked(mockSubagentScope.runNonInteractive).mockImplementation(
        async () => {
          const callCount = vi.mocked(mockSubagentScope.runNonInteractive).mock
            .calls.length;
          if (callCount >= 2) {
            abortController.abort();
          }
        },
      );

      const params: TaskParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
      };

      const invocation = (
        taskTool as TaskToolWithProtectedMethods
      ).createInvocation(params);
      await invocation.execute(abortController.signal);

      // Should have stopped the loop after abort
      expect(mockSubagentScope.runNonInteractive).toHaveBeenCalledTimes(2);
    });

    it('should call both start and stop hooks in correct order', async () => {
      const callOrder: string[] = [];

      vi.mocked(mockHookSystem.fireSubagentStartEvent).mockImplementation(
        async () => {
          callOrder.push('start');
          return undefined;
        },
      );
      vi.mocked(mockHookSystem.fireSubagentStopEvent).mockImplementation(
        async () => {
          callOrder.push('stop');
          return undefined;
        },
      );

      const params: TaskParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
      };

      const invocation = (
        taskTool as TaskToolWithProtectedMethods
      ).createInvocation(params);
      await invocation.execute();

      expect(callOrder).toEqual(['start', 'stop']);
    });

    it('should pass consistent agentId to both start and stop hooks', async () => {
      const params: TaskParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
      };

      const invocation = (
        taskTool as TaskToolWithProtectedMethods
      ).createInvocation(params);
      await invocation.execute();

      const startAgentId = vi.mocked(mockHookSystem.fireSubagentStartEvent).mock
        .calls[0]?.[0] as string;
      const stopAgentId = vi.mocked(mockHookSystem.fireSubagentStopEvent).mock
        .calls[0]?.[0] as string;

      expect(startAgentId).toBe(stopAgentId);
      expect(startAgentId).toMatch(/^file-search-\d+$/);
    });
  });
});
