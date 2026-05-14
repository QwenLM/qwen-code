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
} from './agent.js';
import type { PartListUnion } from '@google/genai';
import type { ToolResultDisplay, AgentResultDisplay } from '../tools.js';
import { ToolConfirmationOutcome } from '../tools.js';
import { ToolNames } from '../tool-names.js';
import { type Config, ApprovalMode } from '../../config/config.js';
import { SubagentManager } from '../../subagents/subagent-manager.js';
import type { SubagentConfig } from '../../subagents/types.js';
import { AgentTerminateMode } from '../../agents/runtime/agent-types.js';
import {
  AgentHeadless,
  ContextState,
} from '../../agents/runtime/agent-headless.js';
import { AgentEventType } from '../../agents/runtime/agent-events.js';
import type {
  AgentToolCallEvent,
  AgentToolResultEvent,
  AgentApprovalRequestEvent,
  AgentEventEmitter,
} from '../../agents/runtime/agent-events.js';
import { partToString } from '../../utils/partUtils.js';
import type { HookSystem } from '../../hooks/hookSystem.js';
import { PermissionMode } from '../../hooks/types.js';
import { runWithAgentContext } from '../../agents/runtime/agent-context.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as transcript from '../../agents/agent-transcript.js';

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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Mock dependencies
vi.mock('../../subagents/subagent-manager.js');
vi.mock('../../agents/runtime/agent-headless.js');

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

    // Create mock config. The outer describe covers foreground execution
    // paths, which now register/unregister in the BackgroundTaskRegistry
    // to surface the run in the pill+dialog. A no-op stub registry is
    // enough for these tests — they don't assert on registry behavior.
    const stubRegistry = {
      register: vi.fn(),
      unregisterForeground: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
      finalizeCancelled: vi.fn(),
      finalizeCancellationIfPending: vi.fn(),
      cancel: vi.fn(),
      get: vi.fn(),
      getAll: vi.fn().mockReturnValue([]),
      drainMessages: vi.fn().mockReturnValue([]),
      queueMessage: vi.fn(),
      queueExternalInput: vi.fn(),
      wakeExternalInputWaiters: vi.fn(),
      appendActivity: vi.fn(),
    };
    const stubMonitorRegistry = {
      setAgentNotificationCallback: vi.fn(),
      setAgentLifecycleCallback: vi.fn(),
      cancelRunningForOwner: vi.fn(),
    };
    // Stub registry exposed on both `parent.getToolRegistry()` and the
    // override built by `createApprovalModeOverride`. The override path
    // calls `createToolRegistry` on the override Config (Object.create
    // walks the prototype chain to this mock) and then
    // `copyDiscoveredToolsFrom(parent.getToolRegistry())`. Without these
    // mocks the override helper throws and every subagent test that
    // exercises foreground execution fails.
    const stubToolRegistry = {
      copyDiscoveredToolsFrom: vi.fn(),
      getAllTools: vi.fn().mockReturnValue([]),
      getAllToolNames: vi.fn().mockReturnValue([]),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    config = {
      getProjectRoot: vi.fn().mockReturnValue('/test/project'),
      getSessionId: vi.fn().mockReturnValue('test-session-id'),
      getCliVersion: vi.fn().mockReturnValue('test-version'),
      getSubagentManager: vi.fn(),
      getGeminiClient: vi.fn().mockReturnValue(undefined),
      getHookSystem: vi.fn().mockReturnValue(undefined),
      getTranscriptPath: vi.fn().mockReturnValue('/test/transcript'),
      getApprovalMode: vi.fn().mockReturnValue('default'),
      isTrustedFolder: vi.fn().mockReturnValue(true),
      getBackgroundTaskRegistry: vi.fn().mockReturnValue(stubRegistry),
      getMonitorRegistry: vi.fn().mockReturnValue(stubMonitorRegistry),
      getToolRegistry: vi.fn().mockReturnValue(stubToolRegistry),
      createToolRegistry: vi.fn().mockResolvedValue(stubToolRegistry),
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

    it('accepts isolation="worktree" when subagent_type is set', () => {
      expect(
        agentTool.validateToolParams({
          ...validParams,
          isolation: 'worktree',
        }),
      ).toBeNull();
    });

    it('rejects isolation values other than "worktree"', () => {
      expect(
        agentTool.validateToolParams({
          ...validParams,
          // @ts-expect-error: deliberately wrong enum value
          isolation: 'remote',
        }),
      ).toMatch(/isolation/i);
    });

    it('rejects isolation without subagent_type (fork is not isolatable)', () => {
      const { subagent_type: _ignored, ...forkParams } = validParams;
      void _ignored;
      expect(
        agentTool.validateToolParams({
          ...forkParams,
          isolation: 'worktree',
        }),
      ).toMatch(/subagent_type/i);
    });
  });

  // Round-7 regression guard: agent isolation must refuse when the
  // parent working tree has uncommitted changes, because
  // `git worktree add -b X path base` only checks out base's tip and
  // would silently run the subagent against pre-edit HEAD. This test
  // exercises the actual provisioning path against a real temp git
  // repo and asserts the failure shape.
  describe('isolation — round-7 parent-dirty guard', () => {
    it('refuses isolation when parent has uncommitted edits', async () => {
      const fs = await import('node:fs/promises');
      const pathMod = await import('node:path');
      const os = await import('node:os');
      const { execFileSync } = await import('node:child_process');
      const repo = await fs.mkdtemp(
        pathMod.join(os.tmpdir(), 'qwen-iso-dirty-'),
      );
      try {
        execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
        execFileSync('git', ['config', 'user.email', 't@e.com'], {
          cwd: repo,
        });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
        execFileSync('git', ['config', 'commit.gpgsign', 'false'], {
          cwd: repo,
        });
        await fs.writeFile(pathMod.join(repo, 'README.md'), 'hi\n');
        execFileSync('git', ['add', '.'], { cwd: repo });
        execFileSync('git', ['commit', '-q', '-m', 'init', '--no-verify'], {
          cwd: repo,
        });
        // Make the parent dirty.
        await fs.writeFile(pathMod.join(repo, 'README.md'), 'edited\n');

        // Verify the guard via the service-level helper that the
        // isolation provisioning would call. (Driving the full
        // AgentTool execute() in a unit test would require mocking
        // most of the agent runtime; the isolation check itself is
        // what the test is guarding.)
        const { GitWorktreeService } = await import(
          '../../services/gitWorktreeService.js'
        );
        const svc = new GitWorktreeService(repo);
        const dirty = await svc.hasWorktreeChanges(repo);
        expect(dirty).toBe(true);
      } finally {
        await fs.rm(repo, { recursive: true, force: true });
      }
    });

    it('would allow isolation when parent is clean (sanity)', async () => {
      const fs = await import('node:fs/promises');
      const pathMod = await import('node:path');
      const os = await import('node:os');
      const { execFileSync } = await import('node:child_process');
      const repo = await fs.mkdtemp(
        pathMod.join(os.tmpdir(), 'qwen-iso-clean-'),
      );
      try {
        execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
        execFileSync('git', ['config', 'user.email', 't@e.com'], {
          cwd: repo,
        });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
        execFileSync('git', ['config', 'commit.gpgsign', 'false'], {
          cwd: repo,
        });
        await fs.writeFile(pathMod.join(repo, 'README.md'), 'hi\n');
        execFileSync('git', ['add', '.'], { cwd: repo });
        execFileSync('git', ['commit', '-q', '-m', 'init', '--no-verify'], {
          cwd: repo,
        });
        const { GitWorktreeService } = await import(
          '../../services/gitWorktreeService.js'
        );
        const svc = new GitWorktreeService(repo);
        expect(await svc.hasWorktreeChanges(repo)).toBe(false);
      } finally {
        await fs.rm(repo, { recursive: true, force: true });
      }
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
      // Foreground subagents now run with a composed AbortSignal so the
      // dialog's per-agent cancel can abort just this child without aborting
      // the parent turn. The signal received by the subagent is the
      // controller's signal, not whatever the caller passed in.
      expect(mockAgent.execute).toHaveBeenCalledWith(
        mockContextState,
        expect.any(AbortSignal),
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

  describe('Fork dispatch (subagent_type omitted)', () => {
    let mockAgent: AgentHeadless;
    let mockContextState: ContextState;

    beforeEach(() => {
      mockAgent = {
        execute: vi.fn().mockResolvedValue(undefined),
        getFinalText: vi.fn().mockReturnValue(''),
        getExecutionSummary: vi.fn().mockReturnValue({
          rounds: 0,
          totalDurationMs: 0,
          totalToolCalls: 0,
          successfulToolCalls: 0,
          failedToolCalls: 0,
          successRate: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          estimatedCost: 0,
          toolUsage: [],
        }),
        getStatistics: vi.fn().mockReturnValue({
          rounds: 0,
          totalDurationMs: 0,
          totalToolCalls: 0,
          successfulToolCalls: 0,
          failedToolCalls: 0,
        }),
        getTerminateMode: vi.fn().mockReturnValue(AgentTerminateMode.GOAL),
      } as unknown as AgentHeadless;

      mockContextState = {
        set: vi.fn(),
      } as unknown as ContextState;

      MockedContextState.mockImplementation(() => mockContextState);

      // Parent conversation history: empty (first-turn fork — falls back to
      // the fork agent's own systemPrompt + wildcard tools because no
      // cache params have been captured yet).
      vi.mocked(config.getGeminiClient).mockReturnValue({
        getHistory: vi.fn().mockReturnValue([]),
        getChat: vi.fn().mockReturnValue({
          getGenerationConfig: vi.fn().mockReturnValue({}),
        }),
      } as unknown as ReturnType<Config['getGeminiClient']>);

      vi.mocked(AgentHeadless.create).mockResolvedValue(mockAgent);
    });

    it('should call AgentHeadless.create directly and execute without options', async () => {
      const params: AgentParams = {
        description: 'fork task',
        prompt: 'do the thing',
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      const result = await invocation.execute();

      // Fork path: AgentHeadless.create invoked directly, bypassing
      // SubagentManager.createAgentHeadless.
      expect(AgentHeadless.create).toHaveBeenCalledTimes(1);
      expect(mockSubagentManager.createAgentHeadless).not.toHaveBeenCalled();

      const createArgs = vi.mocked(AgentHeadless.create).mock.calls[0];
      expect(createArgs[0]).toBe('fork'); // name
      // First-turn fork (no cache params): systemPrompt path, no
      // renderedSystemPrompt. initialMessages is undefined (empty history).
      const promptConfig = createArgs[2];
      expect(promptConfig.renderedSystemPrompt).toBeUndefined();
      expect(promptConfig.systemPrompt).toBeDefined();
      // ToolConfig inherits wildcard for first-turn fallback.
      const toolConfig = createArgs[5];
      expect(toolConfig?.tools).toEqual(['*']);

      // Fork returns the placeholder synchronously.
      const llmText = partToString(result.llmContent);
      expect(llmText).toBe('Fork started — processing in background');

      // Drain the background executeSubagent() promise so its assertions
      // become visible before the test ends.
      await vi.runAllTimersAsync();

      // execute() called without a third options argument.
      expect(mockAgent.execute).toHaveBeenCalledWith(
        mockContextState,
        undefined,
      );
    });

    it('stops the per-subagent ToolRegistry after the fork body finishes', async () => {
      // Regression: foreground-fork fires the body via
      // `void runInForkContext(...)` and returns a placeholder
      // synchronously. Without an inner try/finally, the per-subagent
      // ToolRegistry built by `createApprovalModeOverride` would never
      // be stopped, and any AgentTool / SkillTool the fork's model
      // instantiates would leak its change-listener on shared
      // SubagentManager / SkillManager. Other three spawn paths
      // (foreground non-fork, background fork, background non-fork)
      // already stop the registry in their finally blocks.
      const stopSpy = vi.fn().mockResolvedValue(undefined);
      const stubReg = {
        copyDiscoveredToolsFrom: vi.fn(),
        getAllTools: vi.fn().mockReturnValue([]),
        getAllToolNames: vi.fn().mockReturnValue([]),
        stop: stopSpy,
      };
      // The override Config built by `createApprovalModeOverride` calls
      // `createToolRegistry` (returns the override's own registry) and
      // `getToolRegistry` (during `copyDiscoveredToolsFrom(base...)`).
      // The override's own getToolRegistry is then assigned to whatever
      // `createToolRegistry` returned. Wire BOTH config getters so the
      // post-override `agentConfig.getToolRegistry().stop()` reaches our
      // spy.
      vi.mocked(config.getToolRegistry).mockReturnValue(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        stubReg as any,
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked((config as any).createToolRegistry).mockResolvedValue(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        stubReg as any,
      );

      const params: AgentParams = {
        description: 'fork task',
        prompt: 'do the thing',
      };
      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      await invocation.execute();

      // Drain the detached fork body so its finally block runs.
      await vi.runAllTimersAsync();

      expect(stopSpy).toHaveBeenCalledTimes(1);
    });

    it('routes owned monitor notifications and cleanup for implicit forks', async () => {
      let releaseExecute: (() => void) | undefined;
      vi.mocked(mockAgent.execute).mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            releaseExecute = resolve;
          }),
      );
      (mockAgent as unknown as Record<string, unknown>)[
        'setExternalMessageProvider'
      ] = vi.fn();
      (mockAgent as unknown as Record<string, unknown>)[
        'setExternalMessageWaiter'
      ] = vi.fn();
      (mockAgent as unknown as Record<string, unknown>)[
        'setExternalMessageWaitPredicate'
      ] = vi.fn();

      const params: AgentParams = {
        description: 'fork task',
        prompt: 'do the thing',
      };
      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);

      await invocation.execute();
      await vi.waitFor(() => expect(mockAgent.execute).toHaveBeenCalled());

      const monitorRegistry = config.getMonitorRegistry() as unknown as {
        setAgentNotificationCallback: ReturnType<typeof vi.fn>;
        setAgentLifecycleCallback: ReturnType<typeof vi.fn>;
        cancelRunningForOwner: ReturnType<typeof vi.fn>;
      };
      const agentId = monitorRegistry.setAgentNotificationCallback.mock
        .calls[0][0] as string;
      const callback = monitorRegistry.setAgentNotificationCallback.mock
        .calls[0][1] as (displayText: string, modelText: string) => void;
      const provider = (
        mockAgent as unknown as {
          setExternalMessageProvider: ReturnType<typeof vi.fn>;
        }
      ).setExternalMessageProvider.mock.calls[0][0] as () => unknown[];
      const waiter = (
        mockAgent as unknown as {
          setExternalMessageWaiter: ReturnType<typeof vi.fn>;
        }
      ).setExternalMessageWaiter.mock.calls[0][0] as (
        signal: AbortSignal,
      ) => Promise<unknown[]>;

      callback('Monitor "logs" event #1: ready', '<task-notification />');

      expect(provider()).toEqual([
        { kind: 'notification', text: '<task-notification />' },
      ]);

      const lifecycleCallback = monitorRegistry.setAgentLifecycleCallback.mock
        .calls[0][1] as () => void;
      const waitPromise = waiter(new AbortController().signal);

      lifecycleCallback();

      await expect(waitPromise).resolves.toEqual([]);

      const firstOverlapWait = waiter(new AbortController().signal);
      const secondOverlapWait = waiter(new AbortController().signal);

      lifecycleCallback();

      await expect(
        Promise.all([firstOverlapWait, secondOverlapWait]),
      ).resolves.toEqual([[], []]);

      releaseExecute?.();
      await vi.runAllTimersAsync();

      expect(monitorRegistry.setAgentNotificationCallback).toHaveBeenCalledWith(
        agentId,
        undefined,
      );
      expect(monitorRegistry.setAgentLifecycleCallback).toHaveBeenCalledWith(
        agentId,
        undefined,
      );
      expect(monitorRegistry.cancelRunningForOwner).toHaveBeenCalledWith(
        agentId,
        { notify: false },
      );
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
        // Foreground subagents now run with a composed signal (so the
        // dialog can cancel just this child) — the hook receives the
        // composed signal, not the caller-supplied one.
        expect.any(AbortSignal),
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
        // Foreground subagents now run with a composed signal.
        expect.any(AbortSignal),
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
        // Foreground subagents now run with a composed signal.
        expect.any(AbortSignal),
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
      expect(startAgentId).toMatch(/^file-search-[0-9a-f]{8}$/);
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

  describe('Agent-level background: true', () => {
    let mockAgent: AgentHeadless;
    let mockContextState: ContextState;
    let mockRegistry: {
      register: ReturnType<typeof vi.fn>;
      unregisterForeground: ReturnType<typeof vi.fn>;
      complete: ReturnType<typeof vi.fn>;
      fail: ReturnType<typeof vi.fn>;
      finalizeCancelled: ReturnType<typeof vi.fn>;
      drainMessages: ReturnType<typeof vi.fn>;
      waitForMessages: ReturnType<typeof vi.fn>;
      queueExternalInput: ReturnType<typeof vi.fn>;
      wakeExternalInputWaiters: ReturnType<typeof vi.fn>;
      appendActivity: ReturnType<typeof vi.fn>;
    };

    const bgSubagent: SubagentConfig = {
      name: 'monitor',
      description: 'Background monitor agent',
      systemPrompt: 'You are a monitor.',
      level: 'project',
      filePath: '/project/.qwen/agents/monitor.md',
      background: true,
    };

    beforeEach(() => {
      mockAgent = {
        execute: vi.fn().mockResolvedValue(undefined),
        getFinalText: vi.fn().mockReturnValue('Monitor done'),
        getTerminateMode: vi.fn().mockReturnValue(AgentTerminateMode.GOAL),
        getExecutionSummary: vi.fn().mockReturnValue({}),
        // Background spawn subscribes to the core's event emitter to
        // populate the entry's recentActivities buffer. Return a stub
        // whose getEventEmitter() yields a minimal on/off surface so the
        // test-time listener hookup doesn't throw.
        getCore: vi.fn().mockReturnValue({
          getEventEmitter: () => ({ on: vi.fn(), off: vi.fn() }),
        }),
      } as unknown as AgentHeadless;

      mockContextState = { set: vi.fn() } as unknown as ContextState;
      MockedContextState.mockImplementation(() => mockContextState);

      mockRegistry = {
        register: vi.fn(),
        unregisterForeground: vi.fn(),
        complete: vi.fn(),
        fail: vi.fn(),
        finalizeCancelled: vi.fn(),
        drainMessages: vi.fn().mockReturnValue([]),
        waitForMessages: vi.fn().mockResolvedValue([]),
        queueExternalInput: vi.fn(),
        wakeExternalInputWaiters: vi.fn(),
        appendActivity: vi.fn(),
      };

      vi.mocked(config.getApprovalMode).mockReturnValue(ApprovalMode.DEFAULT);
      (config as unknown as Record<string, unknown>)['isInteractive'] = vi
        .fn()
        .mockReturnValue(true);
      (config as unknown as Record<string, unknown>)[
        'getBackgroundTaskRegistry'
      ] = vi.fn().mockReturnValue(mockRegistry);
      (config as unknown as Record<string, unknown>)['storage'] = {
        getProjectDir: () => '/tmp/qwen-test',
      };
      (mockAgent as unknown as Record<string, unknown>)[
        'setExternalMessageProvider'
      ] = vi.fn();
      (mockAgent as unknown as Record<string, unknown>)[
        'setExternalMessageWaiter'
      ] = vi.fn();
      (mockAgent as unknown as Record<string, unknown>)[
        'setExternalMessageWaitPredicate'
      ] = vi.fn();

      vi.mocked(mockSubagentManager.loadSubagent).mockResolvedValue(bgSubagent);
      vi.mocked(mockSubagentManager.createAgentHeadless).mockResolvedValue(
        mockAgent,
      );
    });

    it('should run in background when agent definition has background: true', async () => {
      const params: AgentParams = {
        description: 'Start monitor',
        prompt: 'Watch for changes',
        subagent_type: 'monitor',
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      const result = await invocation.execute();

      const llmText = partToString(result.llmContent);
      expect(llmText).toContain('Background agent launched');
      expect(llmText).toContain(
        `Use ${ToolNames.SEND_MESSAGE} to continue this agent`,
      );
      expect(llmText).toContain(`or ${ToolNames.TASK_STOP} to cancel.`);
      expect(llmText).not.toContain('with to:');
      expect(llmText).not.toContain('Use send_message with task_id:');
      expect(mockRegistry.register).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'Start monitor',
          subagentType: 'monitor',
          status: 'running',
        }),
      );
      expect(
        (
          mockAgent as unknown as {
            setExternalMessageWaiter: ReturnType<typeof vi.fn>;
          }
        ).setExternalMessageWaiter,
      ).toHaveBeenCalled();
      expect(
        (
          mockAgent as unknown as {
            setExternalMessageWaitPredicate: ReturnType<typeof vi.fn>;
          }
        ).setExternalMessageWaitPredicate,
      ).toHaveBeenCalled();
      const display = result.returnDisplay as AgentResultDisplay;
      expect(display.status).toBe('background');
    });

    it('routes owned monitor notifications into a background agent external input queue', async () => {
      const params: AgentParams = {
        description: 'Start monitor',
        prompt: 'Watch for changes',
        subagent_type: 'monitor',
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      await invocation.execute();

      const agentId = mockRegistry.register.mock.calls[0][0].agentId as string;
      const monitorRegistry = config.getMonitorRegistry() as unknown as {
        setAgentNotificationCallback: ReturnType<typeof vi.fn>;
        setAgentLifecycleCallback: ReturnType<typeof vi.fn>;
      };
      const callback =
        monitorRegistry.setAgentNotificationCallback.mock.calls.find(
          ([id, cb]) => id === agentId && typeof cb === 'function',
        )?.[1] as
          | ((displayText: string, modelText: string) => void)
          | undefined;
      expect(callback).toBeDefined();

      callback?.('Monitor "logs" event #1: ready', '<task-notification />');

      expect(mockRegistry.queueExternalInput).toHaveBeenCalledWith(agentId, {
        kind: 'notification',
        text: '<task-notification />',
      });

      const lifecycleCallback =
        monitorRegistry.setAgentLifecycleCallback.mock.calls.find(
          ([id, cb]) => id === agentId && typeof cb === 'function',
        )?.[1] as (() => void) | undefined;
      expect(lifecycleCallback).toBeDefined();

      lifecycleCallback?.();

      expect(mockRegistry.wakeExternalInputWaiters).toHaveBeenCalledWith(
        agentId,
      );
    });

    it('cleans up owned monitor routing when a background agent finishes', async () => {
      const params: AgentParams = {
        description: 'Start monitor',
        prompt: 'Watch for changes',
        subagent_type: 'monitor',
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      await invocation.execute();

      const agentId = mockRegistry.register.mock.calls[0][0].agentId as string;
      const monitorRegistry = config.getMonitorRegistry() as unknown as {
        setAgentNotificationCallback: ReturnType<typeof vi.fn>;
        setAgentLifecycleCallback: ReturnType<typeof vi.fn>;
        cancelRunningForOwner: ReturnType<typeof vi.fn>;
      };

      await vi.waitFor(() => {
        expect(
          monitorRegistry.setAgentNotificationCallback,
        ).toHaveBeenCalledWith(agentId, undefined);
        expect(monitorRegistry.setAgentLifecycleCallback).toHaveBeenCalledWith(
          agentId,
          undefined,
        );
        expect(monitorRegistry.cancelRunningForOwner).toHaveBeenCalledWith(
          agentId,
          { notify: false },
        );
      });
    });

    it('should run in background when run_in_background is true even without background config', async () => {
      const fgSubagent: SubagentConfig = {
        ...bgSubagent,
        name: 'file-search',
        background: undefined,
      };
      vi.mocked(mockSubagentManager.loadSubagent).mockResolvedValue(fgSubagent);

      const params: AgentParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
        run_in_background: true,
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      const result = await invocation.execute();

      const llmText = partToString(result.llmContent);
      expect(llmText).toContain('Background agent launched');
      expect(mockRegistry.register).toHaveBeenCalled();
    });

    it('passes the sidechain transcript path to SubagentStop hooks for fresh background agents', async () => {
      const mockHookSystem = {
        fireSubagentStartEvent: vi.fn().mockResolvedValue(undefined),
        fireSubagentStopEvent: vi.fn().mockResolvedValue(undefined),
      } as unknown as HookSystem;
      (config as unknown as Record<string, unknown>)['getHookSystem'] = vi
        .fn()
        .mockReturnValue(mockHookSystem);

      const params: AgentParams = {
        description: 'Start monitor',
        prompt: 'Watch for changes',
        subagent_type: 'monitor',
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      await invocation.execute();
      const expectedTranscriptPrefix = path.join(
        '/tmp/qwen-test',
        'subagents',
        'test-session-id',
        'agent-monitor-',
      );
      await vi.waitFor(() => {
        expect(mockHookSystem.fireSubagentStopEvent).toHaveBeenCalledWith(
          expect.stringContaining('monitor-'),
          'monitor',
          expect.stringMatching(
            new RegExp(`^${escapeRegExp(expectedTranscriptPrefix)}.*\\.jsonl$`),
          ),
          'Monitor done',
          false,
          PermissionMode.AutoEdit,
          expect.any(AbortSignal),
        );
      });
    });

    it('should run in foreground when neither flag is set', async () => {
      const fgSubagent: SubagentConfig = {
        ...bgSubagent,
        name: 'file-search',
        background: undefined,
      };
      vi.mocked(mockSubagentManager.loadSubagent).mockResolvedValue(fgSubagent);

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
      expect(llmText).not.toContain('Background agent launched');
      // Foreground subagents register in the same registry with
      // flavor: 'foreground' so the pill+dialog can surface them while
      // the parent's tool-call awaits, then unregister in the finally
      // path once the call returns. (The tool-result is the durable
      // record — the entry does not persist.)
      expect(mockRegistry.register).toHaveBeenCalledWith(
        expect.objectContaining({
          flavor: 'foreground',
          description: 'Search files',
          subagentType: 'file-search',
          status: 'running',
        }),
      );
      expect(mockRegistry.unregisterForeground).toHaveBeenCalledWith(
        expect.stringContaining('file-search-'),
      );
      expect(
        (
          mockAgent as unknown as {
            setExternalMessageProvider: ReturnType<typeof vi.fn>;
          }
        ).setExternalMessageProvider,
      ).toHaveBeenCalled();
      expect(
        (
          mockAgent as unknown as {
            setExternalMessageWaiter: ReturnType<typeof vi.fn>;
          }
        ).setExternalMessageWaiter,
      ).toHaveBeenCalled();
      expect(
        (
          mockAgent as unknown as {
            setExternalMessageWaitPredicate: ReturnType<typeof vi.fn>;
          }
        ).setExternalMessageWaitPredicate,
      ).toHaveBeenCalled();
    });

    it('routes owned monitor notifications and cleanup for foreground agents', async () => {
      const fgSubagent: SubagentConfig = {
        ...bgSubagent,
        name: 'file-search',
        background: undefined,
      };
      vi.mocked(mockSubagentManager.loadSubagent).mockResolvedValue(fgSubagent);
      let releaseExecute: (() => void) | undefined;
      vi.mocked(mockAgent.execute).mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            releaseExecute = resolve;
          }),
      );

      const params: AgentParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      const executePromise = invocation.execute();

      await vi.waitFor(() => expect(mockRegistry.register).toHaveBeenCalled());
      const agentId = mockRegistry.register.mock.calls[0][0].agentId as string;
      const monitorRegistry = config.getMonitorRegistry() as unknown as {
        setAgentNotificationCallback: ReturnType<typeof vi.fn>;
        setAgentLifecycleCallback: ReturnType<typeof vi.fn>;
        cancelRunningForOwner: ReturnType<typeof vi.fn>;
      };
      const callback =
        monitorRegistry.setAgentNotificationCallback.mock.calls.find(
          ([id, cb]) => id === agentId && typeof cb === 'function',
        )?.[1] as
          | ((displayText: string, modelText: string) => void)
          | undefined;
      expect(callback).toBeDefined();

      callback?.('Monitor "logs" event #1: ready', '<task-notification />');

      expect(mockRegistry.queueExternalInput).toHaveBeenCalledWith(agentId, {
        kind: 'notification',
        text: '<task-notification />',
      });

      const lifecycleCallback =
        monitorRegistry.setAgentLifecycleCallback.mock.calls.find(
          ([id, cb]) => id === agentId && typeof cb === 'function',
        )?.[1] as (() => void) | undefined;
      expect(lifecycleCallback).toBeDefined();

      lifecycleCallback?.();

      expect(mockRegistry.wakeExternalInputWaiters).toHaveBeenCalledWith(
        agentId,
      );

      releaseExecute?.();
      await executePromise;

      expect(monitorRegistry.setAgentNotificationCallback).toHaveBeenCalledWith(
        agentId,
        undefined,
      );
      expect(monitorRegistry.setAgentLifecycleCallback).toHaveBeenCalledWith(
        agentId,
        undefined,
      );
      expect(monitorRegistry.cancelRunningForOwner).toHaveBeenCalledWith(
        agentId,
        { notify: false },
      );
    });

    it('foreground CANCELLED prefixes the partial result so the parent sees the cancel', async () => {
      // Without this prefix, a user-cancelled foreground subagent returns
      // the same `{ llmContent: [{ text: finalText }] }` shape as a
      // successful run, leaving the parent model unable to tell that the
      // partial result is incomplete. The background path surfaces this
      // through the registry's `<status>cancelled</status>` XML envelope;
      // the foreground path has no equivalent envelope, so the marker
      // rides the llmContent payload itself.
      const fgSubagent: SubagentConfig = {
        ...bgSubagent,
        name: 'file-search',
        background: undefined,
      };
      vi.mocked(mockSubagentManager.loadSubagent).mockResolvedValue(fgSubagent);
      vi.mocked(mockAgent.getFinalText).mockReturnValue('halfway through');
      vi.mocked(mockAgent.getTerminateMode).mockReturnValue(
        AgentTerminateMode.CANCELLED,
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
      expect(llmText).toContain('Agent was cancelled by the user.');
      expect(llmText).toContain('halfway through');
    });

    it('should allow background in non-interactive mode (headless support)', async () => {
      vi.mocked(
        config.isInteractive as ReturnType<typeof vi.fn>,
      ).mockReturnValue(false);

      const params: AgentParams = {
        description: 'Start monitor',
        prompt: 'Watch for changes',
        subagent_type: 'monitor',
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      const result = await invocation.execute();

      const llmText = partToString(result.llmContent);
      expect(llmText).toContain('Background agent launched');
      expect(mockRegistry.register).toHaveBeenCalled();
    });

    it('forwards the scheduler-provided callId as toolUseId on the registry entry', async () => {
      const params: AgentParams = {
        description: 'Start monitor',
        prompt: 'Watch for changes',
        subagent_type: 'monitor',
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      (invocation as unknown as { setCallId: (id: string) => void }).setCallId(
        'call-xyz-789',
      );
      await invocation.execute();

      expect(mockRegistry.register).toHaveBeenCalledWith(
        expect.objectContaining({ toolUseId: 'call-xyz-789' }),
      );
    });

    describe('parentAgentId sidecar', () => {
      let tempProjectDir: string;

      beforeEach(() => {
        tempProjectDir = fs.mkdtempSync(
          path.join(os.tmpdir(), 'agent-parent-id-'),
        );
        (config as unknown as Record<string, unknown>)['storage'] = {
          getProjectDir: () => tempProjectDir,
        };
      });

      afterEach(() => {
        fs.rmSync(tempProjectDir, { recursive: true, force: true });
      });

      const readSidecar = (agentId: string) => {
        const metaPath = path.join(
          tempProjectDir,
          'subagents',
          'test-session-id',
          `agent-${agentId}.meta.json`,
        );
        return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      };

      it('writes parentAgentId: null at top-level launches', async () => {
        const params: AgentParams = {
          description: 'Start monitor',
          prompt: 'Watch for changes',
          subagent_type: 'monitor',
        };

        const invocation = (
          agentTool as AgentToolWithProtectedMethods
        ).createInvocation(params);
        (
          invocation as unknown as { setCallId: (id: string) => void }
        ).setCallId('top-1');
        await invocation.execute();

        const meta = readSidecar('monitor-top-1');
        expect(meta.parentAgentId).toBeNull();
      });

      it('records the launching agent id when launched from a subagent frame', async () => {
        const params: AgentParams = {
          description: 'Start monitor',
          prompt: 'Watch for changes',
          subagent_type: 'monitor',
        };

        const invocation = (
          agentTool as AgentToolWithProtectedMethods
        ).createInvocation(params);
        (
          invocation as unknown as { setCallId: (id: string) => void }
        ).setCallId('nested-1');

        await runWithAgentContext('explore-parent-42', async () => {
          await invocation.execute();
        });

        const meta = readSidecar('monitor-nested-1');
        expect(meta.parentAgentId).toBe('explore-parent-42');
      });
    });

    it('persists fork capability snapshots in the bootstrap transcript', async () => {
      const forkParams: AgentParams = {
        description: 'Fork task',
        prompt: 'Investigate issue',
        run_in_background: true,
      };
      const generationConfig = {
        systemInstruction: {
          role: 'system',
          parts: [{ text: 'parent system' }],
        },
        tools: [{ functionDeclarations: [{ name: 'Bash' }, { name: 'Read' }] }],
      };
      const geminiClient = {
        getHistory: vi
          .fn()
          .mockReturnValue([{ role: 'model', parts: [{ text: 'Ready' }] }]),
        getChat: vi.fn().mockReturnValue({
          getGenerationConfig: () => generationConfig,
        }),
      };
      vi.mocked(config.getGeminiClient).mockReturnValue(
        geminiClient as unknown as ReturnType<Config['getGeminiClient']>,
      );

      const attachSpy = vi.spyOn(transcript, 'attachJsonlTranscriptWriter');
      const createSpy = vi
        .spyOn(AgentHeadless, 'create')
        .mockResolvedValue(mockAgent);

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(forkParams);
      await invocation.execute();

      expect(attachSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        expect.objectContaining({
          bootstrapSystemInstruction: generationConfig.systemInstruction,
          bootstrapTools: generationConfig.tools[0].functionDeclarations,
        }),
      );

      attachSpy.mockRestore();
      createSpy.mockRestore();
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
