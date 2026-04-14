/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  AgentTool,
  type AgentParams,
  resolveSubagentApprovalMode,
  AGENT_BATCH_MAX_CONCURRENCY,
} from './agent.js';
import type { PartListUnion } from '@google/genai';
import type { ToolResultDisplay, AgentResultDisplay } from './tools.js';
import { ToolConfirmationOutcome } from './tools.js';
import { type Config, ApprovalMode } from '../config/config.js';
import { SubagentManager } from '../subagents/subagent-manager.js';
import type { SubagentConfig } from '../subagents/types.js';
import { AgentTerminateMode } from '../agents/runtime/agent-types.js';
import {
  type AgentHeadless,
  ContextState,
} from '../agents/runtime/agent-headless.js';
import { AgentEventType } from '../agents/runtime/agent-events.js';
import type {
  AgentToolCallEvent,
  AgentToolResultEvent,
  AgentApprovalRequestEvent,
  AgentEventEmitter,
} from '../agents/runtime/agent-events.js';
import { partToString } from '../utils/partUtils.js';
import type { HookSystem } from '../hooks/hookSystem.js';
import { PermissionMode } from '../hooks/types.js';

// Type for accessing protected methods in tests
type AgentToolInvocation = {
  execute: (
    signal?: AbortSignal,
    updateOutput?: (output: ToolResultDisplay) => void,
  ) => Promise<{
    llmContent: PartListUnion;
    returnDisplay: ToolResultDisplay;
  }>;
  getDescription: () => string;
  eventEmitter: AgentEventEmitter;
};

type AgentToolWithProtectedMethods = AgentTool & {
  createInvocation: (params: AgentParams) => AgentToolInvocation;
};

// Mock dependencies
vi.mock('../subagents/subagent-manager.js');
vi.mock('../agents/runtime/agent-headless.js');

const MockedSubagentManager = vi.mocked(SubagentManager);
const MockedContextState = vi.mocked(ContextState);

describe('AgentTool', () => {
  let config: Config;
  let agentTool: AgentTool;
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
      getApprovalMode: vi.fn().mockReturnValue('default'),
      isTrustedFolder: vi.fn().mockReturnValue(true),
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

    // Create AgentTool instance
    agentTool = new AgentTool(config);

    // Allow async initialization to complete
    await vi.runAllTimersAsync();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('initialization', () => {
    it('should initialize with correct name and properties', () => {
      expect(agentTool.name).toBe('agent');
      expect(agentTool.displayName).toBe('Agent');
      expect(agentTool.kind).toBe('other');
    });

    it('should load available subagents during initialization', () => {
      expect(mockSubagentManager.listSubagents).toHaveBeenCalled();
    });

    it('should subscribe to subagent manager changes', () => {
      expect(mockSubagentManager.addChangeListener).toHaveBeenCalledTimes(1);
    });

    it('should update description with available subagents', () => {
      expect(agentTool.description).toContain('file-search');
      expect(agentTool.description).toContain(
        'Specialized agent for searching and analyzing files',
      );
      expect(agentTool.description).toContain('code-review');
      expect(agentTool.description).toContain(
        'Agent for reviewing code quality and best practices',
      );
    });

    it('should handle empty subagents list gracefully', async () => {
      vi.mocked(mockSubagentManager.listSubagents).mockResolvedValue([]);

      const emptyAgentTool = new AgentTool(config);
      await vi.runAllTimersAsync();

      expect(emptyAgentTool.description).toContain(
        'No subagents are currently configured',
      );
    });

    it('should handle subagent loading errors gracefully', async () => {
      vi.mocked(mockSubagentManager.listSubagents).mockRejectedValue(
        new Error('Loading failed'),
      );

      const failedAgentTool = new AgentTool(config);
      await vi.runAllTimersAsync();

      // Should fall back to built-in agents instead of showing "no subagents"
      expect(failedAgentTool.description).toContain('general-purpose');
      expect(failedAgentTool.description).toContain('Explore');
    });
  });

  describe('schema generation', () => {
    it('should generate schema with subagent names as enum', () => {
      const schema = agentTool.schema;
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

      const emptyAgentTool = new AgentTool(config);
      await vi.runAllTimersAsync();

      const schema = emptyAgentTool.schema;
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
    const validParams: AgentParams = {
      description: 'Search files',
      prompt: 'Find all TypeScript files in the project',
      subagent_type: 'file-search',
    };

    it('should validate valid parameters', async () => {
      const result = agentTool.validateToolParams(validParams);
      expect(result).toBeNull();
    });

    it('should reject empty description', async () => {
      const result = agentTool.validateToolParams({
        ...validParams,
        description: '',
      });
      expect(result).toBe(
        'Parameter "description" must be a non-empty string.',
      );
    });

    it('should reject empty prompt', async () => {
      const result = agentTool.validateToolParams({
        ...validParams,
        prompt: '',
      });
      expect(result).toBe('Parameter "prompt" must be a non-empty string.');
    });

    it('should reject empty subagent_type', async () => {
      const result = agentTool.validateToolParams({
        ...validParams,
        subagent_type: '',
      });
      expect(result).toBe(
        'Parameter "subagent_type" must be a non-empty string.',
      );
    });

    it('should reject non-existent subagent', async () => {
      const result = agentTool.validateToolParams({
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

      expect(agentTool.description).toContain('new-agent');
      expect(agentTool.description).toContain('A brand new agent');
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

      await agentTool.refreshSubagents();

      expect(agentTool.description).toContain('test-agent');
      expect(agentTool.description).toContain('A test agent');
    });
  });

  describe('AgentToolInvocation', () => {
    let mockAgent: AgentHeadless;
    let mockContextState: ContextState;

    beforeEach(() => {
      mockAgent = {
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
        mockAgent,
      );
    });

    it('should execute subagent successfully', async () => {
      const params: AgentParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      const result = await invocation.execute();

      expect(mockSubagentManager.loadSubagent).toHaveBeenCalledWith(
        'file-search',
      );
      expect(mockSubagentManager.createAgentHeadless).toHaveBeenCalledWith(
        mockSubagents[0],
        expect.any(Object), // config (may be approval-mode override)
        expect.any(Object), // eventEmitter parameter
      );
      expect(mockAgent.execute).toHaveBeenCalledWith(
        mockContextState,
        undefined, // signal parameter (undefined when not provided)
      );

      const llmText = partToString(result.llmContent);
      expect(llmText).toBe('Task completed successfully');
      const display = result.returnDisplay as AgentResultDisplay;
      expect(display.type).toBe('task_execution');
      expect(display.status).toBe('completed');
      expect(display.subagentName).toBe('file-search');
    });

    it('should handle subagent not found error', async () => {
      vi.mocked(mockSubagentManager.loadSubagent).mockResolvedValue(null);

      const params: AgentParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'non-existent',
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      const result = await invocation.execute();

      const llmText = partToString(result.llmContent);
      expect(llmText).toContain('Subagent "non-existent" not found');
      const display = result.returnDisplay as AgentResultDisplay;
      expect(display.status).toBe('failed');
      expect(display.subagentName).toBe('non-existent');
    });

    it('should handle execution errors gracefully', async () => {
      vi.mocked(mockSubagentManager.createAgentHeadless).mockRejectedValue(
        new Error('Creation failed'),
      );

      const params: AgentParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      const result = await invocation.execute();

      const llmText = partToString(result.llmContent);
      expect(llmText).toContain('Failed to run subagent');
      expect(llmText).toContain('Creation failed');
      const display = result.returnDisplay as AgentResultDisplay;

      expect(display.status).toBe('failed');
    });

    it('should execute subagent without live output callback', async () => {
      const params: AgentParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      const result = await invocation.execute();

      // Verify that the task completed successfully
      expect(result.llmContent).toBeDefined();
      expect(result.returnDisplay).toBeDefined();

      // Verify the result has the expected structure
      const text = partToString(result.llmContent);
      expect(text).toBe('Task completed successfully');
      const display = result.returnDisplay as AgentResultDisplay;
      expect(display.status).toBe('completed');
      expect(display.subagentName).toBe('file-search');
    });

    it('should set context variables correctly', async () => {
      const params: AgentParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      await invocation.execute();

      expect(mockContextState.set).toHaveBeenCalledWith(
        'task_prompt',
        'Find all TypeScript files',
      );
    });

    it('should return structured display object', async () => {
      const params: AgentParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
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
      const params: AgentParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      const permission = await invocation.getDefaultPermission();

      expect(permission).toBe('allow');
    });

    it('should provide correct description', async () => {
      const params: AgentParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      const description = invocation.getDescription();

      expect(description).toBe('Search files');
    });
  });

  describe('SubagentStart hook integration', () => {
    let mockAgent: AgentHeadless;
    let mockContextState: ContextState;
    let mockHookSystem: HookSystem;

    beforeEach(() => {
      mockAgent = {
        execute: vi.fn().mockResolvedValue(undefined),
        result: 'Task completed successfully',
        terminateMode: AgentTerminateMode.GOAL,
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
        mockAgent,
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
      const params: AgentParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      await invocation.execute();

      expect(mockHookSystem.fireSubagentStartEvent).toHaveBeenCalledWith(
        expect.stringContaining('file-search-'),
        'file-search',
        PermissionMode.AutoEdit,
        undefined,
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

      const params: AgentParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
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

      const params: AgentParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
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

      const params: AgentParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      const result = await invocation.execute();

      // Should still complete successfully despite hook failure
      const llmText = partToString(result.llmContent);
      expect(llmText).toBe('Task completed successfully');
      const display = result.returnDisplay as AgentResultDisplay;
      expect(display.status).toBe('completed');
    });

    it('should skip hooks when hookSystem is not available', async () => {
      (config as unknown as Record<string, unknown>)['getHookSystem'] = vi
        .fn()
        .mockReturnValue(undefined);

      const params: AgentParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      const result = await invocation.execute();

      expect(mockHookSystem.fireSubagentStartEvent).not.toHaveBeenCalled();
      const llmText = partToString(result.llmContent);
      expect(llmText).toBe('Task completed successfully');
    });
  });

  describe('SubagentStop hook integration', () => {
    let mockAgent: AgentHeadless;
    let mockContextState: ContextState;
    let mockHookSystem: HookSystem;

    beforeEach(() => {
      mockAgent = {
        execute: vi.fn().mockResolvedValue(undefined),
        result: 'Task completed successfully',
        terminateMode: AgentTerminateMode.GOAL,
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
        mockAgent,
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
      const params: AgentParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      await invocation.execute();

      expect(mockHookSystem.fireSubagentStopEvent).toHaveBeenCalledWith(
        expect.stringContaining('file-search-'),
        'file-search',
        '/test/transcript',
        'Task completed successfully',
        false,
        PermissionMode.AutoEdit,
        undefined,
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

      const params: AgentParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      await invocation.execute();

      // Should have called execute twice (initial + re-execution)
      expect(mockAgent.execute).toHaveBeenCalledTimes(2);
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
        PermissionMode.AutoEdit,
        undefined,
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

      const params: AgentParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      await invocation.execute();

      expect(mockAgent.execute).toHaveBeenCalledTimes(2);
    });

    it('should allow stop when SubagentStop hook fails', async () => {
      vi.mocked(mockHookSystem.fireSubagentStopEvent).mockRejectedValue(
        new Error('Stop hook failed'),
      );

      const params: AgentParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      const result = await invocation.execute();

      // Should still complete successfully despite hook failure
      const llmText = partToString(result.llmContent);
      expect(llmText).toBe('Task completed successfully');
      const display = result.returnDisplay as AgentResultDisplay;
      expect(display.status).toBe('completed');
    });

    it('should skip SubagentStop hook when signal is aborted', async () => {
      const abortController = new AbortController();
      abortController.abort();

      const params: AgentParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
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
      vi.mocked(mockAgent.execute).mockImplementation(async () => {
        const callCount = vi.mocked(mockAgent.execute).mock.calls.length;
        if (callCount >= 2) {
          abortController.abort();
        }
      });

      const params: AgentParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      await invocation.execute(abortController.signal);

      // Should have stopped the loop after abort
      expect(mockAgent.execute).toHaveBeenCalledTimes(2);
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

      const params: AgentParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      await invocation.execute();

      expect(callOrder).toEqual(['start', 'stop']);
    });

    it('should pass consistent agentId to both start and stop hooks', async () => {
      const params: AgentParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      await invocation.execute();

      const startAgentId = vi.mocked(mockHookSystem.fireSubagentStartEvent).mock
        .calls[0]?.[0] as string;
      const stopAgentId = vi.mocked(mockHookSystem.fireSubagentStopEvent).mock
        .calls[0]?.[0] as string;

      expect(startAgentId).toBe(stopAgentId);
      expect(startAgentId).toMatch(/^file-search-\d+-[a-z0-9]+$/);
    });
  });

  describe('IDE diff-tab confirmation clears pendingConfirmation', () => {
    let mockAgent: AgentHeadless;
    let mockContextState: ContextState;

    // We capture the eventEmitter from the invocation so we can simulate
    // events during subagent execution.
    let capturedInvocation: AgentToolInvocation;

    beforeEach(() => {
      mockContextState = {
        set: vi.fn(),
      } as unknown as ContextState;

      MockedContextState.mockImplementation(() => mockContextState);

      vi.mocked(mockSubagentManager.loadSubagent).mockResolvedValue(
        mockSubagents[0],
      );
    });

    function createInvocationWithEventDrivenAgent(
      emitDuringExecute: (emitter: AgentEventEmitter) => void,
    ) {
      // Create a mock agent whose execute() emits events on the invocation's
      // eventEmitter, simulating a real subagent lifecycle.
      mockAgent = {
        execute: vi.fn(),
        result: 'Done',
        terminateMode: AgentTerminateMode.GOAL,
        getFinalText: vi.fn().mockReturnValue('Done'),
        formatCompactResult: vi.fn().mockReturnValue('✅ Success'),
        getExecutionSummary: vi.fn().mockReturnValue({
          rounds: 1,
          totalDurationMs: 100,
          totalToolCalls: 1,
          successfulToolCalls: 1,
          failedToolCalls: 0,
          successRate: 100,
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          toolUsage: [],
        }),
        getStatistics: vi.fn().mockReturnValue({
          rounds: 1,
          totalDurationMs: 100,
          totalToolCalls: 1,
          successfulToolCalls: 1,
          failedToolCalls: 0,
        }),
        getTerminateMode: vi.fn().mockReturnValue(AgentTerminateMode.GOAL),
      } as unknown as AgentHeadless;

      vi.mocked(mockAgent.execute).mockImplementation(async () => {
        emitDuringExecute(capturedInvocation.eventEmitter);
      });

      vi.mocked(mockSubagentManager.createAgentHeadless).mockResolvedValue(
        mockAgent,
      );

      const params: AgentParams = {
        description: 'Edit files',
        prompt: 'Fix the bug',
        subagent_type: 'file-search',
      };

      capturedInvocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);

      return capturedInvocation;
    }

    it('should clear pendingConfirmation when TOOL_RESULT arrives for the pending tool (IDE accept path)', async () => {
      // Track whether pendingConfirmation was set then cleared, using
      // snapshots that safely handle function properties (structuredClone
      // can't serialize functions).
      const snapshots: Array<{
        hasPendingConfirmation: boolean;
        toolStatuses: Array<{ callId: string; status: string }>;
      }> = [];

      const invocation = createInvocationWithEventDrivenAgent((emitter) => {
        emitter.emit(AgentEventType.TOOL_CALL, {
          subagentId: 'sub-1',
          round: 1,
          callId: 'call-edit-1',
          name: 'edit_file',
          args: { path: '/test.ts' },
          description: 'Editing test.ts',
          timestamp: Date.now(),
        } satisfies AgentToolCallEvent);

        // Tool needs approval → pendingConfirmation is set
        emitter.emit(AgentEventType.TOOL_WAITING_APPROVAL, {
          subagentId: 'sub-1',
          round: 1,
          callId: 'call-edit-1',
          name: 'edit_file',
          description: 'Editing test.ts',
          timestamp: Date.now(),
          confirmationDetails: {
            type: 'edit' as const,
            title: 'Edit file',
            fileName: 'test.ts',
            filePath: '/test.ts',
            fileDiff: '',
            originalContent: 'old',
            newContent: 'new',
          },
          respond: vi.fn(),
        } as unknown as AgentApprovalRequestEvent);

        // IDE diff-tab accepted → TOOL_RESULT arrives without onConfirm
        emitter.emit(AgentEventType.TOOL_RESULT, {
          subagentId: 'sub-1',
          round: 1,
          callId: 'call-edit-1',
          name: 'edit_file',
          success: true,
          timestamp: Date.now(),
        } satisfies AgentToolResultEvent);
      });

      await invocation.execute(undefined, (output) => {
        const display = output as AgentResultDisplay;
        snapshots.push({
          hasPendingConfirmation: display.pendingConfirmation !== undefined,
          toolStatuses: (display.toolCalls ?? []).map((tc) => ({
            callId: tc.callId,
            status: tc.status,
          })),
        });
      });

      // Should have at least one snapshot with pendingConfirmation set
      const hasApproval = snapshots.some((s) => s.hasPendingConfirmation);
      expect(hasApproval).toBe(true);

      // The final snapshot after TOOL_RESULT should have cleared it
      const resultSnapshot = snapshots.find(
        (s) =>
          !s.hasPendingConfirmation &&
          s.toolStatuses.some(
            (tc) => tc.callId === 'call-edit-1' && tc.status === 'success',
          ),
      );
      expect(resultSnapshot).toBeDefined();
    });

    it('should NOT clear pendingConfirmation when TOOL_RESULT is for a different tool', async () => {
      const snapshots: Array<{
        hasPendingConfirmation: boolean;
        toolStatuses: Array<{ callId: string; status: string }>;
      }> = [];

      const invocation = createInvocationWithEventDrivenAgent((emitter) => {
        // Tool A starts
        emitter.emit(AgentEventType.TOOL_CALL, {
          subagentId: 'sub-1',
          round: 1,
          callId: 'call-read-1',
          name: 'read_file',
          args: {},
          description: 'Reading',
          timestamp: Date.now(),
        } satisfies AgentToolCallEvent);

        // Tool B starts
        emitter.emit(AgentEventType.TOOL_CALL, {
          subagentId: 'sub-1',
          round: 1,
          callId: 'call-edit-1',
          name: 'edit_file',
          args: {},
          description: 'Editing',
          timestamp: Date.now(),
        } satisfies AgentToolCallEvent);

        // Tool B needs approval
        emitter.emit(AgentEventType.TOOL_WAITING_APPROVAL, {
          subagentId: 'sub-1',
          round: 1,
          callId: 'call-edit-1',
          name: 'edit_file',
          description: 'Editing',
          timestamp: Date.now(),
          confirmationDetails: {
            type: 'edit' as const,
            title: 'Edit',
            fileName: 'test.ts',
            filePath: '/test.ts',
            fileDiff: '',
            originalContent: '',
            newContent: 'new',
          },
          respond: vi.fn(),
        } as unknown as AgentApprovalRequestEvent);

        // Tool A finishes (different callId)
        emitter.emit(AgentEventType.TOOL_RESULT, {
          subagentId: 'sub-1',
          round: 1,
          callId: 'call-read-1',
          name: 'read_file',
          success: true,
          timestamp: Date.now(),
        } satisfies AgentToolResultEvent);
      });

      await invocation.execute(undefined, (output) => {
        const display = output as AgentResultDisplay;
        snapshots.push({
          hasPendingConfirmation: display.pendingConfirmation !== undefined,
          toolStatuses: (display.toolCalls ?? []).map((tc) => ({
            callId: tc.callId,
            status: tc.status,
          })),
        });
      });

      // The snapshot for read_file's TOOL_RESULT should still have
      // pendingConfirmation because the result was for a different tool.
      const readResultSnapshot = snapshots.find((s) =>
        s.toolStatuses.some(
          (tc) => tc.callId === 'call-read-1' && tc.status === 'success',
        ),
      );
      expect(readResultSnapshot).toBeDefined();
      expect(readResultSnapshot!.hasPendingConfirmation).toBe(true);
    });

    it('should clear pendingConfirmation via onConfirm callback (terminal UI path)', async () => {
      let capturedOnConfirm:
        | ((outcome: ToolConfirmationOutcome) => Promise<void>)
        | undefined;
      const snapshots: Array<{ hasPendingConfirmation: boolean }> = [];

      const invocation = createInvocationWithEventDrivenAgent((emitter) => {
        emitter.emit(AgentEventType.TOOL_CALL, {
          subagentId: 'sub-1',
          round: 1,
          callId: 'call-edit-1',
          name: 'edit_file',
          args: {},
          description: 'Editing',
          timestamp: Date.now(),
        } satisfies AgentToolCallEvent);

        emitter.emit(AgentEventType.TOOL_WAITING_APPROVAL, {
          subagentId: 'sub-1',
          round: 1,
          callId: 'call-edit-1',
          name: 'edit_file',
          description: 'Editing',
          timestamp: Date.now(),
          confirmationDetails: {
            type: 'edit' as const,
            title: 'Edit',
            fileName: 'test.ts',
            filePath: '/test.ts',
            fileDiff: '',
            originalContent: '',
            newContent: 'new',
          },
          respond: vi.fn(),
        } as unknown as AgentApprovalRequestEvent);
      });

      await invocation.execute(undefined, (output) => {
        const display = output as AgentResultDisplay;
        snapshots.push({
          hasPendingConfirmation: display.pendingConfirmation !== undefined,
        });
        if (display.pendingConfirmation?.onConfirm) {
          capturedOnConfirm = display.pendingConfirmation.onConfirm;
        }
      });

      expect(capturedOnConfirm).toBeDefined();

      // Call onConfirm as if the user pressed "accept" in the terminal UI
      snapshots.length = 0;
      await capturedOnConfirm!(ToolConfirmationOutcome.ProceedOnce);

      // The onConfirm callback should have cleared pendingConfirmation
      expect(snapshots.some((s) => !s.hasPendingConfirmation)).toBe(true);
    });
  });

  describe('batch mode (tasks[])', () => {
    let mockAgent: AgentHeadless;
    let mockContextState: ContextState;

    beforeEach(() => {
      mockAgent = {
        execute: vi.fn().mockResolvedValue(undefined),
        getFinalText: vi.fn().mockReturnValue('batch task result'),
        getExecutionSummary: vi.fn().mockReturnValue({
          rounds: 1,
          totalDurationMs: 100,
          totalToolCalls: 0,
          successfulToolCalls: 0,
          failedToolCalls: 0,
          successRate: 100,
          inputTokens: 10,
          outputTokens: 10,
          totalTokens: 20,
          toolUsage: [],
        }),
        getTerminateMode: vi.fn().mockReturnValue(AgentTerminateMode.GOAL),
      } as unknown as AgentHeadless;
      mockContextState = { set: vi.fn() } as unknown as ContextState;
      MockedContextState.mockImplementation(() => mockContextState);
      vi.mocked(mockSubagentManager.loadSubagent).mockResolvedValue(
        mockSubagents[0],
      );
      vi.mocked(mockSubagentManager.createAgentHeadless).mockResolvedValue(
        mockAgent,
      );
    });

    it('schema exposes tasks[] with subagent enum on items', () => {
      const schema = agentTool.schema.parametersJsonSchema as {
        properties: {
          tasks: {
            items: {
              properties: {
                subagent_type: { enum?: string[] };
              };
            };
          };
        };
      };
      expect(
        schema.properties.tasks.items.properties.subagent_type.enum,
      ).toEqual(['file-search', 'code-review']);
    });

    it('validates a well-formed batch of tasks', () => {
      expect(
        agentTool.validateToolParams({
          tasks: [
            { description: 't1', prompt: 'p1', subagent_type: 'file-search' },
            { description: 't2', prompt: 'p2', subagent_type: 'code-review' },
          ],
        }),
      ).toBeNull();
    });

    it('rejects mixing single-task fields and tasks[]', () => {
      const result = agentTool.validateToolParams({
        description: 'mixed',
        prompt: 'p',
        subagent_type: 'file-search',
        tasks: [
          { description: 't1', prompt: 'p1', subagent_type: 'file-search' },
        ],
      });
      expect(result).toContain('not both');
    });

    it('rejects empty params (neither shape provided)', () => {
      const result = agentTool.validateToolParams({} as AgentParams);
      expect(result).toContain('missing');
    });

    it('rejects invalid subagent_type inside tasks[]', () => {
      const result = agentTool.validateToolParams({
        tasks: [
          { description: 't1', prompt: 'p1', subagent_type: 'file-search' },
          { description: 't2', prompt: 'p2', subagent_type: 'does-not-exist' },
        ],
      });
      expect(result).toContain('tasks[1]');
      expect(result).toContain('does-not-exist');
    });

    it('rejects missing fields inside tasks[]', () => {
      const result = agentTool.validateToolParams({
        tasks: [{ description: '', prompt: 'p', subagent_type: 'file-search' }],
      });
      expect(result).toContain('tasks[0]');
      expect(result).toContain('description');
    });

    it('executes all tasks in a batch and returns task_execution_batch display', async () => {
      const params: AgentParams = {
        tasks: [
          {
            description: 'Task A',
            prompt: 'prompt A',
            subagent_type: 'file-search',
          },
          {
            description: 'Task B',
            prompt: 'prompt B',
            subagent_type: 'file-search',
          },
          {
            description: 'Task C',
            prompt: 'prompt C',
            subagent_type: 'file-search',
          },
        ],
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      const result = await invocation.execute();

      // All 3 tasks should have triggered createAgentHeadless
      expect(mockSubagentManager.createAgentHeadless).toHaveBeenCalledTimes(3);
      expect(mockAgent.execute).toHaveBeenCalledTimes(3);

      const display = result.returnDisplay as {
        type: string;
        tasks: AgentResultDisplay[];
        status: string;
      };
      expect(display.type).toBe('task_execution_batch');
      expect(display.tasks).toHaveLength(3);
      expect(display.status).toBe('completed');
      for (const task of display.tasks) {
        expect(task.type).toBe('task_execution');
        expect(task.status).toBe('completed');
      }

      const llmText = partToString(result.llmContent);
      expect(llmText).toContain('Task A');
      expect(llmText).toContain('Task B');
      expect(llmText).toContain('Task C');
    });

    it('runs batch tasks concurrently (all executes start before any resolves)', async () => {
      // Make each agent execute pend on an external resolver, so we can
      // observe that all 3 start before any complete.
      const resolvers: Array<() => void> = [];
      const executeStartCounts = { value: 0 };
      vi.mocked(mockAgent.execute).mockImplementation(
        () =>
          new Promise((resolve) => {
            executeStartCounts.value += 1;
            resolvers.push(() => resolve(undefined));
          }),
      );

      const params: AgentParams = {
        tasks: [
          { description: 'A', prompt: 'a', subagent_type: 'file-search' },
          { description: 'B', prompt: 'b', subagent_type: 'file-search' },
          { description: 'C', prompt: 'c', subagent_type: 'file-search' },
        ],
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      const execPromise = invocation.execute();

      // Drain microtasks so all 3 runOneTask calls reach subagent.execute().
      await vi.runAllTimersAsync();

      expect(executeStartCounts.value).toBe(3);
      expect(resolvers).toHaveLength(3);

      // Now release all pending executes and let the invocation finish.
      resolvers.forEach((r) => r());
      await execPromise;
    });

    it('isolates per-task failures via allSettled (one failure does not block others)', async () => {
      // First call succeeds, second throws, third succeeds.
      let call = 0;
      vi.mocked(mockSubagentManager.createAgentHeadless).mockImplementation(
        async () => {
          call += 1;
          if (call === 2) {
            throw new Error('slot 2 boom');
          }
          return mockAgent;
        },
      );

      const params: AgentParams = {
        tasks: [
          { description: 'A', prompt: 'a', subagent_type: 'file-search' },
          { description: 'B', prompt: 'b', subagent_type: 'file-search' },
          { description: 'C', prompt: 'c', subagent_type: 'file-search' },
        ],
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      const result = await invocation.execute();

      const display = result.returnDisplay as {
        type: string;
        tasks: AgentResultDisplay[];
        status: string;
      };
      expect(display.type).toBe('task_execution_batch');
      expect(display.tasks[0].status).toBe('completed');
      expect(display.tasks[1].status).toBe('failed');
      expect(display.tasks[1].terminateReason).toContain('slot 2 boom');
      expect(display.tasks[2].status).toBe('completed');
      // Aggregate status is failed because at least one failed
      expect(display.status).toBe('failed');
    });

    it('emits task_execution_batch live updates via updateOutput', async () => {
      const updates: ToolResultDisplay[] = [];
      const params: AgentParams = {
        tasks: [
          { description: 'A', prompt: 'a', subagent_type: 'file-search' },
          { description: 'B', prompt: 'b', subagent_type: 'file-search' },
        ],
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      await invocation.execute(undefined, (u) => updates.push(u));

      // The first emit is the initial running state, and every update must
      // carry the batch discriminator.
      expect(updates.length).toBeGreaterThan(0);
      for (const u of updates) {
        expect(typeof u).toBe('object');
        expect(u).toHaveProperty('type', 'task_execution_batch');
      }
      const last = updates[updates.length - 1] as {
        tasks: AgentResultDisplay[];
        status: string;
      };
      expect(last.tasks).toHaveLength(2);
      expect(last.status).toBe('completed');
    });

    it('getDescription summarizes a batch', () => {
      const params: AgentParams = {
        tasks: [
          { description: 'Audit A', prompt: 'p', subagent_type: 'file-search' },
          { description: 'Audit B', prompt: 'p', subagent_type: 'file-search' },
        ],
      };
      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      const desc = invocation.getDescription();
      expect(desc).toContain('2 tasks');
      expect(desc).toContain('Audit A');
      expect(desc).toContain('Audit B');
    });

    it('exposes per-slot eventEmitters and slotSubagentTypes aligned with tasks', () => {
      const params: AgentParams = {
        tasks: [
          { description: 'A', prompt: 'a', subagent_type: 'file-search' },
          { description: 'B', prompt: 'b', subagent_type: 'code-review' },
          { description: 'C', prompt: 'c', subagent_type: 'file-search' },
        ],
      };
      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params) as unknown as {
        eventEmitter: AgentEventEmitter;
        eventEmitters: AgentEventEmitter[];
        slotSubagentTypes: string[];
      };

      expect(invocation.eventEmitters).toHaveLength(3);
      expect(invocation.slotSubagentTypes).toEqual([
        'file-search',
        'code-review',
        'file-search',
      ]);
      // Legacy singular field points at slot 0
      expect(invocation.eventEmitter).toBe(invocation.eventEmitters[0]);
      // All three emitters must be distinct instances (no shared state)
      const unique = new Set(invocation.eventEmitters);
      expect(unique.size).toBe(3);
    });

    it('legacy single-task form exposes a one-element eventEmitters array', () => {
      const params: AgentParams = {
        description: 'Legacy',
        prompt: 'legacy prompt',
        subagent_type: 'file-search',
      };
      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params) as unknown as {
        eventEmitter: AgentEventEmitter;
        eventEmitters: AgentEventEmitter[];
        slotSubagentTypes: string[];
      };

      expect(invocation.eventEmitters).toHaveLength(1);
      expect(invocation.eventEmitter).toBe(invocation.eventEmitters[0]);
      expect(invocation.slotSubagentTypes).toEqual(['file-search']);
    });

    it('caps concurrency: a batch larger than the limit runs in waves', async () => {
      // Force task count above the batch concurrency cap so we can observe
      // that not all subagent.execute() calls start at once. Pulls the
      // cap from the exported constant rather than hardcoding so this
      // test tracks any future cap change automatically.
      const limit = AGENT_BATCH_MAX_CONCURRENCY;
      const batchSize = limit + 4;

      const releasers: Array<() => void> = [];
      let inFlight = 0;
      let peakInFlight = 0;

      vi.mocked(mockAgent.execute).mockImplementation(
        () =>
          new Promise((resolve) => {
            inFlight += 1;
            if (inFlight > peakInFlight) peakInFlight = inFlight;
            releasers.push(() => {
              inFlight -= 1;
              resolve(undefined);
            });
          }),
      );

      const tasks = Array.from({ length: batchSize }, (_, i) => ({
        description: `T${i}`,
        prompt: `prompt ${i}`,
        subagent_type: 'file-search',
      }));

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation({ tasks });
      const execPromise = invocation.execute();

      // Let the first wave reach subagent.execute().
      await vi.runAllTimersAsync();

      // At most `limit` should be in flight at any point in the first wave.
      expect(peakInFlight).toBeLessThanOrEqual(limit);
      expect(releasers.length).toBeLessThanOrEqual(limit);
      expect(releasers.length).toBeGreaterThan(0);

      // Drain waves until everything completes, releasing pending executes
      // as they queue up. Each release frees a worker slot for the next
      // queued task.
      while (releasers.length > 0) {
        const next = releasers.shift()!;
        next();
        await vi.runAllTimersAsync();
      }

      await execPromise;

      // Across the whole run, peak concurrency must have stayed at or
      // below the cap — the waves property we care about.
      expect(peakInFlight).toBeLessThanOrEqual(limit);
      // And every task must have executed exactly once.
      expect(mockAgent.execute).toHaveBeenCalledTimes(batchSize);
    });

    it('legacy single-task form still returns task_execution (backwards compat)', async () => {
      const params: AgentParams = {
        description: 'Legacy',
        prompt: 'legacy prompt',
        subagent_type: 'file-search',
      };
      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      const result = await invocation.execute();
      const display = result.returnDisplay as AgentResultDisplay;
      expect(display.type).toBe('task_execution');
      expect(display.status).toBe('completed');
    });
  });
});

describe('resolveSubagentApprovalMode', () => {
  it('should return yolo when parent is yolo, regardless of agent config', () => {
    expect(resolveSubagentApprovalMode(ApprovalMode.YOLO, 'plan', true)).toBe(
      PermissionMode.Yolo,
    );
    expect(
      resolveSubagentApprovalMode(ApprovalMode.YOLO, undefined, false),
    ).toBe(PermissionMode.Yolo);
  });

  it('should return auto-edit when parent is auto-edit, regardless of agent config', () => {
    expect(
      resolveSubagentApprovalMode(ApprovalMode.AUTO_EDIT, 'plan', true),
    ).toBe(PermissionMode.AutoEdit);
    expect(
      resolveSubagentApprovalMode(ApprovalMode.AUTO_EDIT, 'default', false),
    ).toBe(PermissionMode.AutoEdit);
  });

  it('should respect agent-declared mode when parent is default and folder is trusted', () => {
    expect(
      resolveSubagentApprovalMode(ApprovalMode.DEFAULT, 'plan', true),
    ).toBe(PermissionMode.Plan);
    expect(
      resolveSubagentApprovalMode(ApprovalMode.DEFAULT, 'auto-edit', true),
    ).toBe(PermissionMode.AutoEdit);
    expect(
      resolveSubagentApprovalMode(ApprovalMode.DEFAULT, 'yolo', true),
    ).toBe(PermissionMode.Yolo);
  });

  it('should block privileged agent-declared modes in untrusted folders', () => {
    expect(
      resolveSubagentApprovalMode(ApprovalMode.DEFAULT, 'auto-edit', false),
    ).toBe(PermissionMode.Default);
    expect(
      resolveSubagentApprovalMode(ApprovalMode.DEFAULT, 'yolo', false),
    ).toBe(PermissionMode.Default);
  });

  it('should allow non-privileged agent-declared modes in untrusted folders', () => {
    expect(
      resolveSubagentApprovalMode(ApprovalMode.DEFAULT, 'plan', false),
    ).toBe(PermissionMode.Plan);
    expect(
      resolveSubagentApprovalMode(ApprovalMode.DEFAULT, 'default', false),
    ).toBe(PermissionMode.Default);
  });

  it('should default to plan when parent is plan and no agent config', () => {
    expect(
      resolveSubagentApprovalMode(ApprovalMode.PLAN, undefined, true),
    ).toBe(PermissionMode.Plan);
    expect(
      resolveSubagentApprovalMode(ApprovalMode.PLAN, undefined, false),
    ).toBe(PermissionMode.Plan);
  });

  it('should allow agent-declared mode to override plan parent', () => {
    expect(
      resolveSubagentApprovalMode(ApprovalMode.PLAN, 'auto-edit', true),
    ).toBe(PermissionMode.AutoEdit);
  });

  it('should default to auto-edit when parent is default and folder is trusted', () => {
    expect(
      resolveSubagentApprovalMode(ApprovalMode.DEFAULT, undefined, true),
    ).toBe(PermissionMode.AutoEdit);
  });

  it('should default to parent mode when parent is default and folder is untrusted', () => {
    expect(
      resolveSubagentApprovalMode(ApprovalMode.DEFAULT, undefined, false),
    ).toBe(PermissionMode.Default);
  });
});
