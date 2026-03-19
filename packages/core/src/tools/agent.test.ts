/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentTool, type AgentParams } from './agent.js';
import type { PartListUnion } from '@google/genai';
import type { ToolResultDisplay, AgentResultDisplay } from './tools.js';
import type { Config } from '../config/config.js';
import { SubagentManager } from '../subagents/subagent-manager.js';
import type { SubagentConfig } from '../subagents/types.js';
import { AgentTerminateMode } from '../agents/runtime/agent-types.js';
import {
  type AgentHeadless,
  ContextState,
} from '../agents/runtime/agent-headless.js';
import { partToString } from '../utils/partUtils.js';

// Type for accessing protected methods in tests
type AgentToolWithProtectedMethods = AgentTool & {
  createInvocation: (params: AgentParams) => {
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
        config,
        expect.any(Object), // eventEmitter parameter
      );
      expect(mockSubagentScope.execute).toHaveBeenCalledWith(
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
      expect(llmText).toContain('Failed to run subagent: Creation failed');
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
      const shouldConfirm = await invocation.shouldConfirmExecute();

      expect(shouldConfirm).toBe(false);
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
});
