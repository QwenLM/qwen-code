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
import type { Part, PartListUnion } from '@google/genai';
import type { ToolResultDisplay, AgentResultDisplay } from '../tools.js';
import { ToolConfirmationOutcome } from '../tools.js';
import { ToolNames } from '../tool-names.js';
import { type Config, ApprovalMode } from '../../config/config.js';
import { SubagentManager } from '../../subagents/subagent-manager.js';
import type { SubagentConfig } from '../../subagents/types.js';
import { BUBBLE_APPROVAL_MODE } from '../../subagents/types.js';
import {
  buildChildMessage,
  FORK_AGENT,
  FORK_DEFAULT_MAX_TURNS,
  runInForkContext,
} from './fork-subagent.js';
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
import {
  runWithAgentContext,
  runWithAgentHistory,
} from '../../agents/runtime/agent-context.js';
import { runWithTeammateIdentity } from '../../agents/team/identity.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
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

// Spies for the subagent-span layer so tests can assert what status taxonomy
// was published. The real runInSubagentSpanContext sets up OTel context-with,
// which is irrelevant here — we just need the body to run. Review wenshao
// @ #4410.
const mockStartSubagentSpan = vi.fn();
const mockEndSubagentSpan = vi.fn();

vi.mock('../../telemetry/index.js', async (importOriginal) => {
  const orig =
    await importOriginal<typeof import('../../telemetry/index.js')>();
  return {
    ...orig,
    startSubagentSpan: (opts: unknown) => {
      mockStartSubagentSpan(opts);
      // Minimal stand-in — endSubagentSpan is mocked too, so no method
      // on this object is ever invoked.
      return {} as ReturnType<typeof orig.startSubagentSpan>;
    },
    endSubagentSpan: (span: unknown, metadata: unknown) => {
      mockEndSubagentSpan(span, metadata);
    },
    runInSubagentSpanContext: <T>(_span: unknown, fn: () => Promise<T>) => fn(),
  };
});

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
      assertCanStartBackgroundAgent: vi.fn(),
      canStartBackgroundAgent: vi.fn().mockReturnValue(true),
      tryReserveBackgroundSlot: vi
        .fn()
        .mockReturnValue({ id: Symbol('background-slot') }),
      waitForBackgroundSlot: vi
        .fn()
        .mockResolvedValue({ id: Symbol('background-slot') }),
      releaseBackgroundSlot: vi.fn(),
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
      getTargetDir: vi.fn().mockReturnValue('/test/project'),
      getCwd: vi.fn().mockReturnValue('/test/project'),
      getWorkingDir: vi.fn().mockReturnValue('/test/project'),
      getSessionId: vi.fn().mockReturnValue('test-session-id'),
      getCliVersion: vi.fn().mockReturnValue('test-version'),
      getSubagentManager: vi.fn(),
      getGeminiClient: vi.fn().mockReturnValue(undefined),
      getHookSystem: vi.fn().mockReturnValue(undefined),
      getStopHookBlockingCap: vi.fn().mockReturnValue(8),
      getTranscriptPath: vi.fn().mockReturnValue('/test/transcript'),
      getTeamManager: vi.fn().mockReturnValue(undefined),
      isAgentTeamEnabled: vi.fn().mockReturnValue(false),
      getApprovalMode: vi.fn().mockReturnValue('default'),
      getModel: vi.fn().mockReturnValue('parent-model'),
      getBareMode: vi.fn().mockReturnValue(false),
      isSafeMode: vi.fn().mockReturnValue(false),
      getSandbox: vi.fn().mockReturnValue(undefined),
      getScreenReader: vi.fn().mockReturnValue(false),
      getMaxSessionTurns: vi.fn().mockReturnValue(-1),
      getMaxSubagentDepth: vi.fn().mockReturnValue(5),
      getMaxToolCalls: vi.fn().mockReturnValue(-1),
      isTrustedFolder: vi.fn().mockReturnValue(true),
      isInteractive: vi.fn().mockReturnValue(false),
      isForkSubagentEnabled: vi.fn().mockReturnValue(false),
      getFileFilteringOptions: vi.fn().mockReturnValue({
        respectGitIgnore: true,
        respectQwenIgnore: true,
        customIgnoreFiles: ['.agentignore', '.aiignore'],
      }),
      getWorktreeSymlinkDirectories: vi.fn().mockReturnValue([]),
      getBackgroundTaskRegistry: vi.fn().mockReturnValue(stubRegistry),
      getMonitorRegistry: vi.fn().mockReturnValue(stubMonitorRegistry),
      getToolRegistry: vi.fn().mockReturnValue(stubToolRegistry),
      createToolRegistry: vi.fn().mockResolvedValue(stubToolRegistry),
      storage: {
        getProjectDir: vi.fn().mockReturnValue('/test/project/.qwen'),
      },
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
      expect(agentTool.kind).toBe('agent');
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

    it('includes "When to fork" section in description when fork enabled + interactive', async () => {
      (config as unknown as Record<string, unknown>)['isInteractive'] = vi
        .fn()
        .mockReturnValue(true);

      const interactiveTool = new AgentTool(config);
      await vi.runAllTimersAsync();

      expect(interactiveTool.description).toContain('When to fork');
      expect(interactiveTool.description).toContain("Don't peek");
      expect(interactiveTool.description).toContain("Don't race");
      expect(interactiveTool.description).toContain('Writing a fork prompt');
    });

    it('omits fork discipline but keeps "Writing the prompt" when non-interactive', async () => {
      (config as unknown as Record<string, unknown>)['isInteractive'] = vi
        .fn()
        .mockReturnValue(false);

      const nonInteractiveTool = new AgentTool(config);
      await vi.runAllTimersAsync();

      // Fork-specific sections must be absent
      expect(nonInteractiveTool.description).not.toContain('When to fork');
      expect(nonInteractiveTool.description).not.toContain("Don't peek");
      expect(nonInteractiveTool.description).not.toContain("Don't race");
      expect(nonInteractiveTool.description).not.toContain(
        'Writing a fork prompt',
      );

      // "Writing the prompt" section is always present (useful for fresh agents too)
      expect(nonInteractiveTool.description).toContain('Writing the prompt');
      expect(nonInteractiveTool.description).toContain(
        'Never delegate understanding',
      );
    });

    it('includes fork discipline when interactive', async () => {
      (config as unknown as Record<string, unknown>)['isInteractive'] = vi
        .fn()
        .mockReturnValue(true);

      const tool = new AgentTool(config);
      await vi.runAllTimersAsync();

      expect(tool.description).toContain('When to fork');
      expect(tool.description).toContain("Don't peek");
      expect(tool.description).toContain("Don't race");
      expect(tool.description).toContain('Writing a fork prompt');
    });

    it('advertises background execution as the default with a foreground opt-out', async () => {
      const tool = new AgentTool(config);
      await vi.runAllTimersAsync();

      expect(tool.description).toContain('background by default');
      expect(tool.description).toContain('run_in_background: false');
    });

    it('requires bounded delegation and verification of subagent results', async () => {
      const tool = new AgentTool(config);
      await vi.runAllTimersAsync();

      expect(tool.description).toContain('concrete, bounded tasks');
      expect(tool.description).toContain('immediate critical-path work local');
      expect(tool.description).toContain(
        'Do not duplicate work between the parent and subagents',
      );
      expect(tool.description).toContain('disjoint write scopes');
      expect(tool.description).toContain(
        "Treat the agent's output as evidence, not as automatically correct",
      );
      expect(tool.description).not.toContain(
        "The agent's outputs should generally be trusted",
      );
      expect(tool.description).not.toContain(
        'Launch multiple agents concurrently whenever possible',
      );
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

    it('declares the background default and foreground opt-out', () => {
      const properties = agentTool.schema.parametersJsonSchema as {
        properties: {
          run_in_background: {
            default?: boolean;
            description?: string;
          };
        };
      };

      expect(properties.properties.run_in_background.default).toBe(true);
      expect(properties.properties.run_in_background.description).toContain(
        'Set to false',
      );
    });

    it('declares fork_turns with the backward-compatible none default', () => {
      const properties = agentTool.schema.parametersJsonSchema as {
        properties: {
          fork_turns: {
            default?: string;
            description?: string;
            oneOf?: unknown[];
          };
        };
      };

      expect(properties.properties.fork_turns.default).toBe('none');
      expect(properties.properties.fork_turns.description).toContain(
        'positive integer string',
      );
      expect(properties.properties.fork_turns.description).toContain(
        'Omit this parameter when subagent_type is "fork"',
      );
      expect(properties.properties.fork_turns.oneOf).toHaveLength(2);
    });

    it('does not advertise "fork" in the enum, even when interactive', async () => {
      // `fork` is intentionally omitted from the enum so the model is not
      // steered to fork result-bearing work; it stays valid via validation.
      (config as unknown as Record<string, unknown>)['isInteractive'] = vi
        .fn()
        .mockReturnValue(true);
      const interactiveTool = new AgentTool(config);
      await vi.runAllTimersAsync();

      const schema = interactiveTool.schema;
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
      expect(properties.properties.subagent_type.enum).not.toContain('fork');
    });

    it('does not expose teammate name when teams are disabled', () => {
      const schema = agentTool.schema;
      const parameters = schema.parametersJsonSchema as {
        properties: {
          name?: unknown;
        };
      };

      expect(parameters.properties.name).toBeUndefined();
    });

    it('exposes teammate name when teams are enabled', async () => {
      vi.mocked(config.isAgentTeamEnabled).mockReturnValue(true);

      const teamAgentTool = new AgentTool(config);
      await vi.runAllTimersAsync();

      const schema = teamAgentTool.schema;
      const parameters = schema.parametersJsonSchema as {
        properties: {
          name?: {
            description?: string;
          };
        };
      };

      expect(parameters.properties.name?.description).toContain('active team');
    });

    it('exposes plan_mode_required only when teams are enabled', async () => {
      vi.mocked(config.isAgentTeamEnabled).mockReturnValue(true);

      const teamAgentTool = new AgentTool(config);
      await vi.runAllTimersAsync();

      const schema = teamAgentTool.schema;
      const parameters = schema.parametersJsonSchema as {
        properties: {
          plan_mode_required?: {
            description?: string;
          };
        };
      };
      expect(parameters.properties.plan_mode_required?.description).toContain(
        'named teammate',
      );

      vi.mocked(config.isAgentTeamEnabled).mockReturnValue(false);
      const ordinaryAgentTool = new AgentTool(config);
      await vi.runAllTimersAsync();

      const ordinarySchema = ordinaryAgentTool.schema;
      const ordinaryParameters = ordinarySchema.parametersJsonSchema as {
        properties: {
          plan_mode_required?: unknown;
        };
      };
      expect(ordinaryParameters.properties.plan_mode_required).toBeUndefined();
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

    it.each(['all', 'none', '1', '12'] as const)(
      'accepts fork_turns=%s',
      (forkTurns) => {
        expect(
          agentTool.validateToolParams({
            ...validParams,
            fork_turns: forkTurns,
          }),
        ).toBeNull();
      },
    );

    it.each(['', '0', '-1', '1.5', ' 3 '] as const)(
      'rejects invalid fork_turns=%j',
      (forkTurns) => {
        expect(
          agentTool.validateToolParams({
            ...validParams,
            fork_turns: forkTurns as AgentParams['fork_turns'],
          }),
        ).toMatch(/fork_turns/i);
      },
    );

    it('rejects explicit fork_turns for detached fork agents', () => {
      expect(
        agentTool.validateToolParams({
          ...validParams,
          subagent_type: 'fork',
          fork_turns: 'none',
        }),
      ).toMatch(/always inherit the full parent context/i);
    });

    it('accepts a subagent_type missing from the cache (may have been created after startup)', () => {
      const result = agentTool.validateToolParams({
        ...validParams,
        subagent_type: 'created-after-startup',
      });
      expect(result).toBeNull();
    });

    it('kicks a cache refresh on a subagent_type cache miss', () => {
      vi.mocked(mockSubagentManager.listSubagents).mockClear();
      agentTool.validateToolParams({
        ...validParams,
        subagent_type: 'created-after-startup',
      });
      expect(mockSubagentManager.listSubagents).toHaveBeenCalled();
    });

    it('does not refresh the cache when the subagent_type is already known', () => {
      vi.mocked(mockSubagentManager.listSubagents).mockClear();
      agentTool.validateToolParams(validParams);
      expect(mockSubagentManager.listSubagents).not.toHaveBeenCalled();
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

    it('rejects isolation without an explicit subagent_type', () => {
      const { subagent_type: _ignored, ...noTypeParams } = validParams;
      void _ignored;
      expect(
        agentTool.validateToolParams({
          ...noTypeParams,
          isolation: 'worktree',
        }),
      ).toMatch(/subagent_type/i);
    });

    it('accepts subagent_type "fork" without consulting the registry', () => {
      expect(
        agentTool.validateToolParams({
          ...validParams,
          subagent_type: 'fork',
        }),
      ).toBeNull();
    });

    it('rejects isolation combined with subagent_type "fork"', () => {
      expect(
        agentTool.validateToolParams({
          ...validParams,
          subagent_type: 'fork',
          isolation: 'worktree',
        }),
      ).toMatch(/fork/i);
    });

    it('accepts working_dir when subagent_type is set', () => {
      expect(
        agentTool.validateToolParams({
          ...validParams,
          working_dir: '.qwen/tmp/review-pr-1',
        }),
      ).toBeNull();
    });

    it('rejects an empty working_dir', () => {
      expect(
        agentTool.validateToolParams({
          ...validParams,
          working_dir: '',
        }),
      ).toMatch(/working_dir/i);
    });

    it('rejects a whitespace-only working_dir', () => {
      expect(
        agentTool.validateToolParams({
          ...validParams,
          working_dir: '   ',
        }),
      ).toMatch(/working_dir/i);
    });

    it('rejects working_dir combined with isolation', () => {
      expect(
        agentTool.validateToolParams({
          ...validParams,
          working_dir: '.qwen/tmp/review-pr-1',
          isolation: 'worktree',
        }),
      ).toMatch(/mutually exclusive/i);
    });

    it('rejects working_dir without an explicit subagent_type', () => {
      const { subagent_type: _ignored, ...noTypeParams } = validParams;
      void _ignored;
      expect(
        agentTool.validateToolParams({
          ...noTypeParams,
          working_dir: '.qwen/tmp/review-pr-1',
        }),
      ).toMatch(/subagent_type/i);
    });

    it('rejects working_dir combined with subagent_type "fork"', () => {
      expect(
        agentTool.validateToolParams({
          ...validParams,
          subagent_type: 'fork',
          working_dir: '.qwen/tmp/review-pr-1',
        }),
      ).toMatch(/fork/i);
    });

    it('rejects working_dir combined with run_in_background', () => {
      expect(
        agentTool.validateToolParams({
          ...validParams,
          working_dir: '.qwen/tmp/review-pr-1',
          run_in_background: true,
        }),
      ).toMatch(/run_in_background|incompatible/i);
    });

    it('rejects plan_mode_required without a named teammate', () => {
      expect(
        agentTool.validateToolParams({
          ...validParams,
          plan_mode_required: true,
        }),
      ).toMatch(/named teammate/i);
    });

    it('rejects plan_mode_required when no team is active', () => {
      vi.mocked(config.getTeamManager).mockReturnValue(null);

      expect(
        agentTool.validateToolParams({
          ...validParams,
          name: 'planner',
          plan_mode_required: true,
        }),
      ).toMatch(/active team/i);
    });

    it('accepts plan_mode_required for a named teammate in an active team', () => {
      vi.mocked(config.getTeamManager).mockReturnValue({
        spawnTeammate: vi.fn(),
      } as never);

      expect(
        agentTool.validateToolParams({
          ...validParams,
          name: 'planner',
          plan_mode_required: true,
        }),
      ).toBeNull();
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

  describe('execution with an unknown subagent', () => {
    it('reports not-found with the available list when the agent is missing on disk', async () => {
      vi.mocked(mockSubagentManager.loadSubagent).mockResolvedValue(null);

      const invocation = agentTool.build({
        description: 'Use missing agent',
        prompt: 'Do work',
        subagent_type: 'non-existent',
      });
      const result = await invocation.execute(new AbortController().signal);

      expect(mockSubagentManager.loadSubagent).toHaveBeenCalledWith(
        'non-existent',
      );
      expect(result.llmContent).toBe(
        'Subagent "non-existent" not found. Available subagents: file-search, code-review',
      );
    });

    it('still reports not-found when listing available subagents fails', async () => {
      vi.mocked(mockSubagentManager.loadSubagent).mockResolvedValue(null);
      vi.mocked(mockSubagentManager.listSubagents).mockRejectedValue(
        new Error('fs error'),
      );

      const invocation = agentTool.build({
        description: 'Use missing agent',
        prompt: 'Do work',
        subagent_type: 'non-existent',
      });
      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).toBe('Subagent "non-existent" not found');
    });
  });

  describe('team routing', () => {
    it('falls back to one-shot when `name` is supplied without a team', async () => {
      vi.mocked(config.getTeamManager).mockReturnValue(null);
      vi.mocked(mockSubagentManager.loadSubagent).mockResolvedValue(null);

      const invocation = agentTool.build({
        description: 'Spawn helper',
        prompt: 'Do work',
        subagent_type: 'file-search',
        name: 'helper',
      });
      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).not.toContain('no active team');
      expect(mockSubagentManager.loadSubagent).toHaveBeenCalledWith(
        'file-search',
      );
    });

    it('passes plan_mode_required through to TeamManager for named teammates', async () => {
      const spawnTeammate = vi.fn().mockResolvedValue(undefined);
      vi.mocked(config.getTeamManager).mockReturnValue({
        spawnTeammate,
      } as never);

      const invocation = agentTool.build({
        description: 'Plan implementation',
        prompt: 'Investigate and propose a plan',
        subagent_type: 'file-search',
        name: 'planner',
        plan_mode_required: true,
      });

      await invocation.execute(new AbortController().signal);

      expect(spawnTeammate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'planner',
          planModeRequired: true,
        }),
      );
    });

    it('passes selected parent history to named teammates', async () => {
      const spawnTeammate = vi.fn().mockResolvedValue(undefined);
      vi.mocked(config.getTeamManager).mockReturnValue({
        spawnTeammate,
      } as never);
      vi.mocked(config.getGeminiClient).mockReturnValue({
        getHistoryForSubagent: vi.fn().mockReturnValue([
          {
            role: 'user',
            parts: [
              {
                text: '<system-reminder>\nstartup\n</system-reminder>',
              },
            ],
          },
          { role: 'user', parts: [{ text: 'parent question' }] },
          { role: 'model', parts: [{ text: 'parent answer' }] },
        ]),
      } as unknown as ReturnType<Config['getGeminiClient']>);

      const invocation = agentTool.build({
        description: 'Investigate issue',
        prompt: 'Find the cause',
        subagent_type: 'file-search',
        name: 'investigator',
        fork_turns: '1',
      });

      await invocation.execute(new AbortController().signal);

      expect(spawnTeammate).toHaveBeenCalledWith(
        expect.objectContaining({
          chatHistory: [
            { role: 'user', parts: [{ text: 'parent question' }] },
            { role: 'model', parts: [{ text: 'parent answer' }] },
          ],
        }),
      );
    });

    it('rejects plan_mode_required direct execution from a subagent context', async () => {
      const spawnTeammate = vi.fn().mockResolvedValue(undefined);
      vi.mocked(config.getTeamManager).mockReturnValue({
        spawnTeammate,
      } as never);

      const invocation = agentTool.build({
        description: 'Plan implementation',
        prompt: 'Investigate and propose a plan',
        name: 'planner',
        plan_mode_required: true,
      });

      const result = await runWithAgentContext('child-agent', () =>
        invocation.execute(new AbortController().signal),
      );

      expect(result.llmContent).toContain('from the team leader');
      expect(spawnTeammate).not.toHaveBeenCalled();
    });

    it('rejects working_dir when a named teammate would spawn (worktree pin would be silently ignored)', async () => {
      const spawnTeammate = vi.fn().mockResolvedValue(undefined);
      vi.mocked(config.getTeamManager).mockReturnValue({
        spawnTeammate,
      } as never);

      const invocation = agentTool.build({
        description: 'Review',
        prompt: 'Review the diff',
        subagent_type: 'file-search',
        name: 'reviewer',
        working_dir: '.qwen/tmp/review-pr-1',
      });

      const result = await invocation.execute(new AbortController().signal);

      expect(partToString(result.llmContent)).toMatch(
        /not supported for a named teammate/i,
      );
      expect(spawnTeammate).not.toHaveBeenCalled();
    });
  });

  describe('nesting depth guard', () => {
    it('rejects a spawn that would exceed maxSubagentDepth', async () => {
      vi.mocked(config.getMaxSubagentDepth).mockReturnValue(1);
      const invocation = agentTool.build({
        description: 'Spawn deeper',
        prompt: 'Do work',
        subagent_type: 'file-search',
      });
      // One agent frame → invoker is a level-1 sub-agent; its child would be
      // level 2, which exceeds max=1 → rejected before any subagent load.
      const result = await runWithAgentContext('sub-1', () =>
        invocation.execute(new AbortController().signal),
      );

      expect(result.llmContent).toContain('nesting depth limit reached');
      // The user-facing display mirrors a failed task execution, not a bare
      // string, so the UI renders it like any other failed sub-agent run.
      expect(result.returnDisplay).toMatchObject({
        type: 'task_execution',
        status: 'failed',
        subagentName: 'file-search',
        terminateReason: 'Nesting depth limit reached (max 1)',
      });
      expect(mockSubagentManager.loadSubagent).not.toHaveBeenCalled();
      // A blocked spawn must take the scheduler's failure path: `error` keeps
      // tool-usage stats from counting it as a spawned sub-agent (and fires
      // failure-path hooks), and the display row reports it as failed. The
      // scheduler sends only `error.message` to the model (llmContent is
      // discarded on the failure path), so the message must carry the full
      // actionable guidance, not just the terse reason label.
      expect(result.error?.message).toContain('nesting depth limit reached');
      expect(result.error?.message).toContain('Complete this task directly');
      const display = result.returnDisplay as AgentResultDisplay;
      expect(display.status).toBe('failed');
    });

    it('allows a spawn from the top-level session at maxSubagentDepth=1', async () => {
      vi.mocked(config.getMaxSubagentDepth).mockReturnValue(1);
      vi.mocked(mockSubagentManager.loadSubagent).mockResolvedValue(null);
      const invocation = agentTool.build({
        description: 'Spawn helper',
        prompt: 'Do work',
        subagent_type: 'file-search',
      });
      // No agent frame → invoker level 0 → child level 1 ≤ 1 → allowed; the
      // guard lets execution proceed to subagent resolution.
      await invocation.execute(new AbortController().signal);

      expect(mockSubagentManager.loadSubagent).toHaveBeenCalledWith(
        'file-search',
      );
    });

    it('does not route a nested sub-agent to a teammate even with a name + active team', async () => {
      // Regression: nested sub-agents now carry the AgentTool. A sub-agent
      // passing `name` must NOT reach executeTeammate (which would bypass the
      // depth guard and the v1 "teammates do not nest" rule). With max depth 1
      // and one agent frame, the spawn falls through team routing to the depth
      // guard and is rejected — proving executeTeammate was not taken.
      vi.mocked(config.getMaxSubagentDepth).mockReturnValue(1);
      vi.mocked(config.getTeamManager).mockReturnValue({} as never);
      const invocation = agentTool.build({
        description: 'Spawn teammate from within a sub-agent',
        prompt: 'Do work',
        subagent_type: 'file-search',
        name: 'helper',
      });
      const result = await runWithAgentContext('sub-1', () =>
        invocation.execute(new AbortController().signal),
      );

      expect(result.llmContent).toContain('nesting depth limit reached');
      expect(mockSubagentManager.loadSubagent).not.toHaveBeenCalled();
    });

    it('blocks a teammate from spawning any sub-agent', async () => {
      // Teammates do not nest in v1. The schema layer strips `agent` from
      // teammate tool lists; this pins the symmetric runtime backstop for a
      // hallucinated call that slips past schema-hiding. Depth would permit
      // the spawn here (max 5), so a pass proves the teammate guard fired.
      vi.mocked(config.getMaxSubagentDepth).mockReturnValue(5);
      const invocation = agentTool.build({
        description: 'Spawn from a teammate',
        prompt: 'Do work',
        subagent_type: 'file-search',
      });
      const result = await runWithTeammateIdentity(
        {
          agentId: 'scribe@demo',
          agentName: 'scribe',
          teamName: 'demo',
          isTeamLead: false,
        },
        () =>
          runWithAgentContext('teammate-1', () =>
            invocation.execute(new AbortController().signal),
          ),
      );

      expect(result.llmContent).toContain('Teammates cannot spawn sub-agents');
      expect(mockSubagentManager.loadSubagent).not.toHaveBeenCalled();
    });

    it('blocks a fork child from spawning any sub-agent', async () => {
      // Forks must never spawn sub-agents. The runtime guard blocks ALL agent
      // calls from within a fork (not just fork-in-fork), catching the
      // wildcard/fallback tool path that could otherwise re-add `agent`.
      const invocation = agentTool.build({
        description: 'Spawn from within a fork',
        prompt: 'Do work',
        subagent_type: 'file-search',
      });
      const result = await runInForkContext(() =>
        invocation.execute(new AbortController().signal),
      );

      expect(result.llmContent).toContain(
        'Cannot spawn sub-agents from within a fork',
      );
      expect(mockSubagentManager.loadSubagent).not.toHaveBeenCalled();
      // Same failure-path contract as the depth guard above: the model-facing
      // message keeps the actionable instruction.
      expect(result.error?.message).toContain(
        'Cannot spawn sub-agents from within a fork',
      );
      expect(result.error?.message).toContain('execute tasks directly');
      const display = result.returnDisplay as AgentResultDisplay;
      expect(display.status).toBe('failed');
    });

    it('allows nesting while depth remains under the cap', async () => {
      vi.mocked(config.getMaxSubagentDepth).mockReturnValue(5);
      vi.mocked(mockSubagentManager.loadSubagent).mockResolvedValue(null);
      const invocation = agentTool.build({
        description: 'Spawn deeper',
        prompt: 'Do work',
        subagent_type: 'file-search',
      });
      // Two frames → invoker is level 2; child would be level 3 ≤ 5 → allowed.
      await runWithAgentContext('sub-1', () =>
        runWithAgentContext('sub-2', () =>
          invocation.execute(new AbortController().signal),
        ),
      );

      expect(mockSubagentManager.loadSubagent).toHaveBeenCalledWith(
        'file-search',
      );
    });

    it('ignores a teammate name from a nested sub-agent and spawns a regular sub-agent', async () => {
      // With a team active and depth permitting the spawn, a nested
      // sub-agent's `name` must not reach executeTeammate (teammates do not
      // nest in v1) — the spawn proceeds as a regular one-shot agent of the
      // requested type. Pins the silent-success path at the default cap.
      vi.mocked(config.getMaxSubagentDepth).mockReturnValue(5);
      const spawnTeammate = vi.fn().mockResolvedValue(undefined);
      vi.mocked(config.getTeamManager).mockReturnValue({
        spawnTeammate,
      } as never);
      vi.mocked(mockSubagentManager.loadSubagent).mockResolvedValue(null);
      const invocation = agentTool.build({
        description: 'Spawn with a name from a nested sub-agent',
        prompt: 'Do work',
        subagent_type: 'file-search',
        name: 'helper',
      });
      await runWithAgentContext('sub-1', () =>
        invocation.execute(new AbortController().signal),
      );

      expect(spawnTeammate).not.toHaveBeenCalled();
      expect(mockSubagentManager.loadSubagent).toHaveBeenCalledWith(
        'file-search',
      );
    });

    it('falls back to a regular general-purpose sub-agent when a nested sub-agent requests a fork', async () => {
      // Fork is a top-level-only capability in v1. A nested sub-agent
      // requesting `subagent_type: "fork"` must get the awaitable
      // general-purpose sub-agent, not an error and not a nested fork.
      vi.mocked(config.getMaxSubagentDepth).mockReturnValue(5);
      vi.mocked(mockSubagentManager.loadSubagent).mockResolvedValue(null);
      const invocation = agentTool.build({
        description: 'Fork from a nested sub-agent',
        prompt: 'Do work',
        subagent_type: 'fork',
      });
      await runWithAgentContext('sub-1', () =>
        invocation.execute(new AbortController().signal),
      );

      expect(mockSubagentManager.loadSubagent).toHaveBeenCalledWith(
        'general-purpose',
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
        getCore: vi.fn().mockReturnValue({
          modelConfig: { model: 'subagent-model' },
        }),
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
      vi.mocked(mockSubagentManager.createAgentHeadless).mockResolvedValue({
        subagent: mockAgent,
        dispose: vi.fn().mockResolvedValue(undefined),
      });
    });

    it('should execute subagent successfully', async () => {
      const params: AgentParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
        run_in_background: false,
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

    it('rejects working_dir when the resolved subagent config runs in the background', async () => {
      // The explicit run_in_background param is caught in validateToolParams;
      // this covers the other route into the background — a subagent config
      // with background: true — which is only known after loadSubagent.
      vi.mocked(mockSubagentManager.loadSubagent).mockResolvedValue({
        ...mockSubagents[0],
        background: true,
      });

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation({
        description: 'Review',
        prompt: 'Review the diff',
        subagent_type: 'file-search',
        working_dir: '.qwen/tmp/review-pr-1',
      });
      const result = await invocation.execute();

      expect(partToString(result.llmContent)).toMatch(/background agent/i);
      expect(mockSubagentManager.createAgentHeadless).not.toHaveBeenCalled();
    });

    it('allows working_dir for a background:true subagent that downgrades to foreground when nested', async () => {
      // Nested → isTopLevelSession() is false → the config's background: true
      // is downgraded to an awaited foreground run, so shouldRunInBackground
      // is false and the background guard must NOT fire. Execution proceeds to
      // worktree validation (which rejects this non-worktree path), proving
      // the guard keys off the effective decision and does not over-reject the
      // foreground path. A regression back to `backgroundRequested` would flip
      // this to the background-agent error.
      vi.useRealTimers();
      // A real, existing directory that is not a git repo — so the
      // GitWorktreeService probe constructs cleanly and isGitRepository()
      // returns false (the default '/test/project' mock does not exist on CI,
      // where simple-git throws at construction).
      const nonRepo = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-agent-wd-nested-')),
      );
      try {
        vi.mocked(config.getProjectRoot).mockReturnValue(nonRepo);
        vi.mocked(config.getTargetDir).mockReturnValue(nonRepo);
        vi.mocked(config.getCwd).mockReturnValue(nonRepo);
        vi.mocked(config.getWorkingDir).mockReturnValue(nonRepo);
        vi.mocked(mockSubagentManager.loadSubagent).mockResolvedValue({
          ...mockSubagents[0],
          background: true,
        });

        const invocation = (
          agentTool as AgentToolWithProtectedMethods
        ).createInvocation({
          description: 'Review',
          prompt: 'Review the diff',
          subagent_type: 'file-search',
          working_dir: 'some-worktree',
        });
        const result = await runWithAgentContext('sub-1', () =>
          invocation.execute(new AbortController().signal),
        );

        const text = partToString(result.llmContent);
        expect(text).not.toMatch(/background agent/i);
        expect(text).toMatch(/not a git repository|not a registered/i);
      } finally {
        fs.rmSync(nonRepo, { recursive: true, force: true });
        vi.useFakeTimers();
      }
    });

    it('strips internal analysis and summary tags from subagent result', async () => {
      vi.mocked(mockAgent.getFinalText).mockReturnValue(
        [
          '<analysis>',
          'Scratchpad details should stay out of the parent context.',
          '</analysis>',
          '',
          '<summary>',
          'Task completed successfully',
          '',
          '- Found the target file',
          '</summary>',
        ].join('\n'),
      );

      const params: AgentParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
        run_in_background: false,
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      const result = await invocation.execute();

      const llmText = partToString(result.llmContent);
      expect(llmText).toBe(
        'Task completed successfully\n\n- Found the target file',
      );
      expect(llmText).not.toContain('<analysis>');
      expect(llmText).not.toContain('<summary>');
    });

    it('preserves diagnostic tags from failed subagent result', async () => {
      const raw = '<analysis>debug</analysis><summary>partial</summary>';
      vi.mocked(mockAgent.getFinalText).mockReturnValue(raw);
      vi.mocked(mockAgent.getTerminateMode).mockReturnValue(
        AgentTerminateMode.ERROR,
      );

      const params: AgentParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
        run_in_background: false,
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      const result = await invocation.execute();

      expect(partToString(result.llmContent)).toBe(raw);
    });

    it('explains successful subagents with no model-visible output', async () => {
      vi.mocked(mockAgent.getFinalText).mockReturnValue(
        '<analysis>scratch only</analysis>',
      );

      const params: AgentParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
        run_in_background: false,
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      const result = await invocation.execute();

      expect(partToString(result.llmContent)).toBe(
        '(subagent produced no model-visible output)',
      );
    });

    it('passes custom ignore files into worktree isolation file service', async () => {
      vi.useRealTimers();
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-agent-wt-'));
      try {
        execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
        execFileSync('git', ['config', 'user.email', 't@e.com'], {
          cwd: repo,
        });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
        execFileSync('git', ['config', 'commit.gpgsign', 'false'], {
          cwd: repo,
        });
        fs.writeFileSync(path.join(repo, '.cursorignore'), 'secret.txt\n');
        fs.writeFileSync(path.join(repo, 'secret.txt'), 'secret\n');
        execFileSync('git', ['add', '.'], { cwd: repo });
        execFileSync('git', ['commit', '-q', '-m', 'init', '--no-verify'], {
          cwd: repo,
        });

        vi.mocked(config.getProjectRoot).mockReturnValue(repo);
        vi.mocked(config.getTargetDir).mockReturnValue(repo);
        vi.mocked(config.getCwd).mockReturnValue(repo);
        vi.mocked(config.getWorkingDir).mockReturnValue(repo);
        vi.mocked(config.getFileFilteringOptions).mockReturnValue({
          respectGitIgnore: true,
          respectQwenIgnore: true,
          customIgnoreFiles: ['.cursorignore'],
        });

        const invocation = (
          agentTool as AgentToolWithProtectedMethods
        ).createInvocation({
          description: 'Search files',
          prompt: 'Find all TypeScript files',
          subagent_type: 'file-search',
          isolation: 'worktree',
        });
        await invocation.execute();

        const createCall = vi.mocked(mockSubagentManager.createAgentHeadless)
          .mock.calls[0];
        const agentConfig = createCall[1] as Config;
        expect(agentConfig.getProjectRoot()).not.toBe(repo);
        expect(
          agentConfig.getFileService().getQwenIgnoreFileNamesDisplay(),
        ).toBe('.qwenignore, .cursorignore');
        expect(
          agentConfig.getFileService().shouldQwenIgnoreFile('secret.txt'),
        ).toBe(true);
        expect(
          agentConfig
            .getFileService()
            .getQwenIgnoreFileDisplayForPath('secret.txt'),
        ).toBe('.cursorignore');
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
        vi.useFakeTimers();
      }
    }, 20000);

    it('pins the sub-agent to a caller-owned worktree via working_dir and leaves it in place', async () => {
      vi.useRealTimers();
      const repo = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-agent-wd-')),
      );
      try {
        execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
        execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: repo });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
        execFileSync('git', ['config', 'commit.gpgsign', 'false'], {
          cwd: repo,
        });
        fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n');
        execFileSync('git', ['add', '.'], { cwd: repo });
        execFileSync('git', ['commit', '-q', '-m', 'init', '--no-verify'], {
          cwd: repo,
        });

        // A real, registered worktree the caller owns — mirrors the PR
        // worktree `/review`'s fetch-pr provisions at `.qwen/tmp/review-pr-<n>`.
        const wt = path.join(repo, '.qwen', 'tmp', 'review-pr-1');
        fs.mkdirSync(path.dirname(wt), { recursive: true });
        execFileSync(
          'git',
          ['worktree', 'add', '-b', 'review-pr-1', wt, 'HEAD'],
          {
            cwd: repo,
          },
        );

        vi.mocked(config.getProjectRoot).mockReturnValue(repo);
        vi.mocked(config.getTargetDir).mockReturnValue(repo);
        vi.mocked(config.getCwd).mockReturnValue(repo);
        vi.mocked(config.getWorkingDir).mockReturnValue(repo);

        const invocation = (
          agentTool as AgentToolWithProtectedMethods
        ).createInvocation({
          description: 'Review',
          prompt: 'Review the diff',
          subagent_type: 'file-search',
          working_dir: wt,
        });
        const result = await invocation.execute();

        const createCall = vi.mocked(mockSubagentManager.createAgentHeadless)
          .mock.calls[0];
        const agentConfig = createCall[1] as Config;
        // Every cwd surface is rebound to the caller's worktree...
        expect(agentConfig.getProjectRoot()).toBe(wt);
        expect(agentConfig.getTargetDir()).toBe(wt);
        expect(agentConfig.getCwd()).toBe(wt);
        expect(agentConfig.getWorkingDir()).toBe(wt);
        expect(agentConfig.getProjectRoot()).not.toBe(repo);
        // ...and the caller-owned worktree is NOT torn down by cleanup, nor
        // reported as preserved (the externallyManaged guard skips teardown).
        expect(fs.existsSync(wt)).toBe(true);
        expect(partToString(result.llmContent)).not.toContain(
          '[worktree preserved',
        );
        // A pinned worktree gets the narrow notice, not the isolation notice
        // (which tells the agent to translate the parent's paths).
        expect(mockContextState.set).toHaveBeenCalledWith(
          'task_prompt',
          expect.stringContaining('Your working directory is'),
        );
        expect(mockContextState.set).not.toHaveBeenCalledWith(
          'task_prompt',
          expect.stringContaining('translate it to the corresponding path'),
        );
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
        vi.useFakeTimers();
      }
    }, 20000);

    it('keeps a working_dir launch in the foreground when the flag is omitted', async () => {
      // The default-background rule excludes caller-owned worktree launches
      // (`this.params.working_dir === undefined` in backgroundRequested). Guard
      // the core dispatch directly so a future refactor that drops the
      // working_dir exclusion is caught here, not only in the UI classifiers.
      vi.useRealTimers();
      const repo = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-agent-wd-fg-')),
      );
      try {
        execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
        execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: repo });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
        execFileSync('git', ['config', 'commit.gpgsign', 'false'], {
          cwd: repo,
        });
        fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n');
        execFileSync('git', ['add', '.'], { cwd: repo });
        execFileSync('git', ['commit', '-q', '-m', 'init', '--no-verify'], {
          cwd: repo,
        });

        const wt = path.join(repo, '.qwen', 'tmp', 'review-pr-1');
        fs.mkdirSync(path.dirname(wt), { recursive: true });
        execFileSync(
          'git',
          ['worktree', 'add', '-b', 'review-pr-1', wt, 'HEAD'],
          { cwd: repo },
        );

        vi.mocked(config.getProjectRoot).mockReturnValue(repo);
        vi.mocked(config.getTargetDir).mockReturnValue(repo);
        vi.mocked(config.getCwd).mockReturnValue(repo);
        vi.mocked(config.getWorkingDir).mockReturnValue(repo);

        const invocation = (
          agentTool as AgentToolWithProtectedMethods
        ).createInvocation({
          description: 'Review',
          prompt: 'Review the diff',
          subagent_type: 'file-search',
          working_dir: wt,
          // run_in_background intentionally omitted.
        });
        const result = await invocation.execute();

        // Foreground: the omitted flag must NOT route a caller-owned worktree
        // launch through the background registry path.
        expect(partToString(result.llmContent)).not.toContain(
          'Background agent launched',
        );
        expect(
          vi.mocked(mockSubagentManager.createAgentHeadless),
        ).toHaveBeenCalled();
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
        vi.useFakeTimers();
      }
    }, 20000);

    it('rejects working_dir that is not a registered worktree of this repo', async () => {
      vi.useRealTimers();
      const repo = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-agent-wd-bad-')),
      );
      try {
        execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
        execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: repo });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
        execFileSync('git', ['config', 'commit.gpgsign', 'false'], {
          cwd: repo,
        });
        fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n');
        execFileSync('git', ['add', '.'], { cwd: repo });
        execFileSync('git', ['commit', '-q', '-m', 'init', '--no-verify'], {
          cwd: repo,
        });

        // A plain sub-directory that was never `git worktree add`-ed.
        const plain = path.join(repo, 'not-a-worktree');
        fs.mkdirSync(plain);

        vi.mocked(config.getProjectRoot).mockReturnValue(repo);
        vi.mocked(config.getTargetDir).mockReturnValue(repo);
        vi.mocked(config.getCwd).mockReturnValue(repo);
        vi.mocked(config.getWorkingDir).mockReturnValue(repo);

        const invocation = (
          agentTool as AgentToolWithProtectedMethods
        ).createInvocation({
          description: 'Review',
          prompt: 'Review the diff',
          subagent_type: 'file-search',
          working_dir: plain,
        });
        const result = await invocation.execute();

        expect(partToString(result.llmContent)).toMatch(
          /not a registered linked worktree/i,
        );
        expect(mockSubagentManager.createAgentHeadless).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
        vi.useFakeTimers();
      }
    }, 20000);

    it('resolves a repo-relative working_dir against the parent cwd (the /review production form)', async () => {
      vi.useRealTimers();
      const repo = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-agent-wd-rel-')),
      );
      try {
        execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
        execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: repo });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
        execFileSync('git', ['config', 'commit.gpgsign', 'false'], {
          cwd: repo,
        });
        fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n');
        execFileSync('git', ['add', '.'], { cwd: repo });
        execFileSync('git', ['commit', '-q', '-m', 'init', '--no-verify'], {
          cwd: repo,
        });

        // fetch-pr creates the worktree at <cwd>/.qwen/tmp/review-pr-<n> and
        // the /review skill passes that repo-relative path verbatim.
        const wt = path.join(repo, '.qwen', 'tmp', 'review-pr-1');
        fs.mkdirSync(path.dirname(wt), { recursive: true });
        execFileSync(
          'git',
          ['worktree', 'add', '-b', 'review-pr-1', wt, 'HEAD'],
          { cwd: repo },
        );

        vi.mocked(config.getProjectRoot).mockReturnValue(repo);
        vi.mocked(config.getTargetDir).mockReturnValue(repo);
        vi.mocked(config.getCwd).mockReturnValue(repo);
        vi.mocked(config.getWorkingDir).mockReturnValue(repo);

        const invocation = (
          agentTool as AgentToolWithProtectedMethods
        ).createInvocation({
          description: 'Review',
          prompt: 'Review the diff',
          subagent_type: 'file-search',
          // Relative form, exactly as the skill passes it.
          working_dir: path.join('.qwen', 'tmp', 'review-pr-1'),
        });
        await invocation.execute();

        const createCall = vi.mocked(mockSubagentManager.createAgentHeadless)
          .mock.calls[0];
        const agentConfig = createCall[1] as Config;
        // The relative path resolves to the correct absolute worktree.
        expect(agentConfig.getProjectRoot()).toBe(wt);
        expect(agentConfig.getTargetDir()).toBe(wt);
        expect(agentConfig.getCwd()).toBe(wt);
        expect(agentConfig.getWorkingDir()).toBe(wt);
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
        vi.useFakeTimers();
      }
    }, 20000);

    it('rejects working_dir pointing at the repository main working tree', async () => {
      vi.useRealTimers();
      const repo = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-agent-wd-main-')),
      );
      try {
        execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
        execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: repo });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
        execFileSync('git', ['config', 'commit.gpgsign', 'false'], {
          cwd: repo,
        });
        fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n');
        execFileSync('git', ['add', '.'], { cwd: repo });
        execFileSync('git', ['commit', '-q', '-m', 'init', '--no-verify'], {
          cwd: repo,
        });

        vi.mocked(config.getProjectRoot).mockReturnValue(repo);
        vi.mocked(config.getTargetDir).mockReturnValue(repo);
        vi.mocked(config.getCwd).mockReturnValue(repo);
        vi.mocked(config.getWorkingDir).mockReturnValue(repo);

        const invocation = (
          agentTool as AgentToolWithProtectedMethods
        ).createInvocation({
          description: 'Review',
          prompt: 'Review the diff',
          subagent_type: 'file-search',
          // The main checkout is a registered worktree of itself, but pinning
          // here would defeat the isolation — must be rejected.
          working_dir: repo,
        });
        const result = await invocation.execute();

        expect(partToString(result.llmContent)).toMatch(/main working tree/i);
        expect(mockSubagentManager.createAgentHeadless).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
        vi.useFakeTimers();
      }
    }, 20000);

    it('rejects working_dir when the parent directory is not a git repository', async () => {
      vi.useRealTimers();
      const nonRepo = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-agent-wd-nogit-')),
      );
      try {
        vi.mocked(config.getProjectRoot).mockReturnValue(nonRepo);
        vi.mocked(config.getTargetDir).mockReturnValue(nonRepo);
        vi.mocked(config.getCwd).mockReturnValue(nonRepo);
        vi.mocked(config.getWorkingDir).mockReturnValue(nonRepo);

        const invocation = (
          agentTool as AgentToolWithProtectedMethods
        ).createInvocation({
          description: 'Review',
          prompt: 'Review the diff',
          subagent_type: 'file-search',
          working_dir: 'some-worktree',
        });
        const result = await invocation.execute();

        // The isGitRepository() preflight names the real cause instead of
        // the confusing "not a registered git worktree" fallback.
        expect(partToString(result.llmContent)).toMatch(
          /not a git repository/i,
        );
        expect(mockSubagentManager.createAgentHeadless).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(nonRepo, { recursive: true, force: true });
        vi.useFakeTimers();
      }
    }, 20000);

    it('accepts a registered worktree in detached HEAD state (no branch)', async () => {
      vi.useRealTimers();
      const repo = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-agent-wd-detached-')),
      );
      try {
        execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
        execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: repo });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
        execFileSync('git', ['config', 'commit.gpgsign', 'false'], {
          cwd: repo,
        });
        fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n');
        execFileSync('git', ['add', '.'], { cwd: repo });
        execFileSync('git', ['commit', '-q', '-m', 'init', '--no-verify'], {
          cwd: repo,
        });
        // A detached worktree is registered but has no branch, so
        // getRegisteredWorktreeBranch returns null for it. That must not gate
        // the pin — `git worktree add --detach` is a legitimate setup.
        const wt = path.join(repo, '.qwen', 'tmp', 'review-pr-1');
        fs.mkdirSync(path.dirname(wt), { recursive: true });
        execFileSync('git', ['worktree', 'add', '--detach', wt, 'HEAD'], {
          cwd: repo,
        });

        vi.mocked(config.getProjectRoot).mockReturnValue(repo);
        vi.mocked(config.getTargetDir).mockReturnValue(repo);
        vi.mocked(config.getCwd).mockReturnValue(repo);
        vi.mocked(config.getWorkingDir).mockReturnValue(repo);

        const invocation = (
          agentTool as AgentToolWithProtectedMethods
        ).createInvocation({
          description: 'Review',
          prompt: 'Review the diff',
          subagent_type: 'file-search',
          working_dir: wt,
        });
        await invocation.execute();

        const createCall = vi.mocked(mockSubagentManager.createAgentHeadless)
          .mock.calls[0];
        const agentConfig = createCall[1] as Config;
        expect(agentConfig.getProjectRoot()).toBe(wt);
        expect(agentConfig.getTargetDir()).toBe(wt);
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
        vi.useFakeTimers();
      }
    }, 20000);

    it('leaves the caller-owned worktree in place when the sub-agent fails', async () => {
      vi.useRealTimers();
      const repo = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-agent-wd-failpath-')),
      );
      try {
        execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
        execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: repo });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
        execFileSync('git', ['config', 'commit.gpgsign', 'false'], {
          cwd: repo,
        });
        fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n');
        execFileSync('git', ['add', '.'], { cwd: repo });
        execFileSync('git', ['commit', '-q', '-m', 'init', '--no-verify'], {
          cwd: repo,
        });
        const wt = path.join(repo, '.qwen', 'tmp', 'review-pr-1');
        fs.mkdirSync(path.dirname(wt), { recursive: true });
        execFileSync(
          'git',
          ['worktree', 'add', '-b', 'review-pr-1', wt, 'HEAD'],
          { cwd: repo },
        );

        vi.mocked(config.getProjectRoot).mockReturnValue(repo);
        vi.mocked(config.getTargetDir).mockReturnValue(repo);
        vi.mocked(config.getCwd).mockReturnValue(repo);
        vi.mocked(config.getWorkingDir).mockReturnValue(repo);
        // The sub-agent throws mid-execution, so the finally / outer-catch
        // path runs cleanupWorktreeIsolation(). The externallyManaged guard
        // must still stop it from removing the caller's worktree — this is the
        // error-recovery path where teardown bugs hide.
        vi.mocked(mockAgent.execute).mockRejectedValue(
          new Error('subagent boom'),
        );

        const invocation = (
          agentTool as AgentToolWithProtectedMethods
        ).createInvocation({
          description: 'Review',
          prompt: 'Review the diff',
          subagent_type: 'file-search',
          working_dir: wt,
        });
        const result = await invocation.execute();

        expect(fs.existsSync(wt)).toBe(true);
        expect(partToString(result.llmContent)).not.toContain(
          '[worktree preserved',
        );
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
        vi.useFakeTimers();
      }
    }, 20000);

    it('re-anchors validation at the repo root when launched from a monorepo subdirectory', async () => {
      vi.useRealTimers();
      const repo = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-agent-wd-mono-')),
      );
      try {
        execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
        execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: repo });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
        execFileSync('git', ['config', 'commit.gpgsign', 'false'], {
          cwd: repo,
        });
        // A nested package directory the CLI could be launched from.
        const subdir = path.join(repo, 'packages', 'core');
        fs.mkdirSync(subdir, { recursive: true });
        fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n');
        execFileSync('git', ['add', '.'], { cwd: repo });
        execFileSync('git', ['commit', '-q', '-m', 'init', '--no-verify'], {
          cwd: repo,
        });
        const wt = path.join(repo, '.qwen', 'tmp', 'review-pr-1');
        fs.mkdirSync(path.dirname(wt), { recursive: true });
        execFileSync(
          'git',
          ['worktree', 'add', '-b', 'review-pr-1', wt, 'HEAD'],
          { cwd: repo },
        );

        // getTargetDir() is the subdirectory, not the repo root, so the
        // helper's `repoRoot !== parentCwd` re-anchoring branch executes.
        vi.mocked(config.getProjectRoot).mockReturnValue(subdir);
        vi.mocked(config.getTargetDir).mockReturnValue(subdir);
        vi.mocked(config.getCwd).mockReturnValue(subdir);
        vi.mocked(config.getWorkingDir).mockReturnValue(subdir);

        const invocation = (
          agentTool as AgentToolWithProtectedMethods
        ).createInvocation({
          description: 'Review',
          prompt: 'Review the diff',
          subagent_type: 'file-search',
          // Absolute worktree path registered at the repo root.
          working_dir: wt,
        });
        await invocation.execute();

        const createCall = vi.mocked(mockSubagentManager.createAgentHeadless)
          .mock.calls[0];
        const agentConfig = createCall[1] as Config;
        expect(agentConfig.getProjectRoot()).toBe(wt);
        expect(agentConfig.getTargetDir()).toBe(wt);
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
        vi.useFakeTimers();
      }
    }, 20000);

    it('resolves a repo-relative working_dir against the subdirectory cwd, not the repo root (monorepo)', async () => {
      vi.useRealTimers();
      const repo = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-agent-wd-monorel-')),
      );
      try {
        execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
        execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: repo });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
        execFileSync('git', ['config', 'commit.gpgsign', 'false'], {
          cwd: repo,
        });
        fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n');
        execFileSync('git', ['add', '.'], { cwd: repo });
        execFileSync('git', ['commit', '-q', '-m', 'init', '--no-verify'], {
          cwd: repo,
        });

        // fetch-pr creates the worktree cwd-relative (git resolves a relative
        // worktree path against the process cwd), so when the CLI runs from a
        // package subdirectory the worktree lands under the SUBDIR's .qwen,
        // NOT the repo root's. Mimic that exactly.
        const subdir = path.join(repo, 'packages', 'core');
        fs.mkdirSync(subdir, { recursive: true });
        const wt = path.join(subdir, '.qwen', 'tmp', 'review-pr-1');
        fs.mkdirSync(path.dirname(wt), { recursive: true });
        execFileSync(
          'git',
          [
            'worktree',
            'add',
            '-b',
            'review-pr-1',
            path.join('.qwen', 'tmp', 'review-pr-1'),
            'HEAD',
          ],
          { cwd: subdir },
        );

        vi.mocked(config.getProjectRoot).mockReturnValue(subdir);
        vi.mocked(config.getTargetDir).mockReturnValue(subdir);
        vi.mocked(config.getCwd).mockReturnValue(subdir);
        vi.mocked(config.getWorkingDir).mockReturnValue(subdir);

        const invocation = (
          agentTool as AgentToolWithProtectedMethods
        ).createInvocation({
          description: 'Review',
          prompt: 'Review the diff',
          subagent_type: 'file-search',
          // Relative form, resolved against the subdir cwd — must land on the
          // subdir worktree, not <repo>/.qwen/tmp/review-pr-1.
          working_dir: path.join('.qwen', 'tmp', 'review-pr-1'),
        });
        await invocation.execute();

        const createCall = vi.mocked(mockSubagentManager.createAgentHeadless)
          .mock.calls[0];
        const agentConfig = createCall[1] as Config;
        expect(agentConfig.getProjectRoot()).toBe(wt);
        expect(agentConfig.getTargetDir()).toBe(wt);
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
        vi.useFakeTimers();
      }
    }, 20000);

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
        run_in_background: false,
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
        run_in_background: false,
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
        run_in_background: false,
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

    it("L3 default is 'ask' so AUTO mode routes through the classifier", async () => {
      // Previously this returned 'allow', but launching a sub-agent
      // hands control to a new instance with its own tool access — a
      // privileged sink. The AUTO scheduler short-circuits at L4 when
      // finalPermission === 'allow', so without this override the
      // classifier projection added in PR #4151 would never be reached
      // and arbitrary sub-agent spawns would bypass classifier review.
      const params: AgentParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      const permission = await invocation.getDefaultPermission();

      expect(permission).toBe('ask');
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

    describe('qwen-code.subagent span outcome (#4410 wenshao)', () => {
      beforeEach(() => {
        mockStartSubagentSpan.mockClear();
        mockEndSubagentSpan.mockClear();
      });

      async function runForegroundOnce(): Promise<void> {
        const params: AgentParams = {
          description: 'Search files',
          prompt: 'Find all TypeScript files',
          subagent_type: 'file-search',
          run_in_background: false,
        };
        const invocation = (
          agentTool as AgentToolWithProtectedMethods
        ).createInvocation(params);
        await invocation.execute();
      }

      function lastEndMeta(): {
        status?: string;
        terminateReason?: string;
        resultSummaryPresent?: boolean;
        error?: string;
        errorType?: string;
      } {
        const calls = mockEndSubagentSpan.mock.calls;
        return calls[calls.length - 1][1] as {
          status?: string;
          terminateReason?: string;
          resultSummaryPresent?: boolean;
          error?: string;
          errorType?: string;
        };
      }

      function lastStartSpec(): {
        depth?: number;
        parentAgentId?: string;
      } {
        const calls = mockStartSubagentSpan.mock.calls;
        return calls[calls.length - 1][0] as {
          depth?: number;
          parentAgentId?: string;
        };
      }

      it('GOAL terminateMode → status="completed" + resultSummaryPresent', async () => {
        vi.mocked(mockAgent.getTerminateMode).mockReturnValue(
          AgentTerminateMode.GOAL,
        );
        await runForegroundOnce();
        expect(mockEndSubagentSpan).toHaveBeenCalledTimes(1);
        const meta = lastEndMeta();
        expect(meta.status).toBe('completed');
        expect(meta.resultSummaryPresent).toBe(true);
      });

      it('ERROR terminateMode → status="failed" + terminateReason="error"', async () => {
        vi.mocked(mockAgent.getTerminateMode).mockReturnValue(
          AgentTerminateMode.ERROR,
        );
        await runForegroundOnce();
        const meta = lastEndMeta();
        expect(meta.status).toBe('failed');
        expect(meta.terminateReason).toBe('error');
      });

      it('MAX_TURNS terminateMode → status="failed" + error/errorType populated', async () => {
        vi.mocked(mockAgent.getTerminateMode).mockReturnValue(
          AgentTerminateMode.MAX_TURNS,
        );
        await runForegroundOnce();
        const meta = lastEndMeta();
        expect(meta.status).toBe('failed');
        expect(meta.terminateReason).toBe('max_turns');
        // Same shape as the ERROR test above so a regression in the
        // error-stamping for non-throwing failure paths is caught here
        // too. wenshao @ #4410 DeepSeek 3292521241.
        expect(meta.error).toBe('subagent terminated with mode: MAX_TURNS');
        expect(meta.errorType).toBe('MAX_TURNS');
      });

      it('CANCELLED terminateMode → status="cancelled"', async () => {
        vi.mocked(mockAgent.getTerminateMode).mockReturnValue(
          AgentTerminateMode.CANCELLED,
        );
        await runForegroundOnce();
        // No external signal abort → "subagent_cancelled" branch (terminate
        // mode came from inside the subagent itself).
        const meta = lastEndMeta();
        expect(meta.status).toBe('cancelled');
        expect(meta.terminateReason).toBe('subagent_cancelled');
      });

      it('SHUTDOWN terminateMode → status="cancelled" + terminateReason="subagent_shutdown"', async () => {
        // SHUTDOWN is graceful arena/team-session-end, not failure.
        // wenshao @ #4410 DeepSeek 3291876034.
        vi.mocked(mockAgent.getTerminateMode).mockReturnValue(
          AgentTerminateMode.SHUTDOWN,
        );
        await runForegroundOnce();
        const meta = lastEndMeta();
        expect(meta.status).toBe('cancelled');
        expect(meta.terminateReason).toBe('subagent_shutdown');
      });

      it('ERROR terminateMode populates error + errorType for OTel exception attrs', async () => {
        // Non-throwing failure paths (ERROR/MAX_TURNS/TIMEOUT) must
        // populate error/errorType so endSubagentSpan sets the standard
        // OTel exception attributes — generic 'subagent failed' was
        // hiding the reason from dashboards. wenshao @ #4410 DeepSeek
        // 3291876053.
        vi.mocked(mockAgent.getTerminateMode).mockReturnValue(
          AgentTerminateMode.ERROR,
        );
        await runForegroundOnce();
        const meta = lastEndMeta();
        expect(meta.status).toBe('failed');
        expect(meta.error).toBe('subagent terminated with mode: ERROR');
        expect(meta.errorType).toBe('ERROR');
      });

      it('subagent.execute throws → status="failed" + errorType=Error', async () => {
        vi.mocked(mockAgent.execute).mockRejectedValue(
          new Error('catastrophic boom'),
        );
        await runForegroundOnce();
        const meta = lastEndMeta();
        expect(meta.status).toBe('failed');
        expect(meta.error).toBe('catastrophic boom');
        expect(meta.errorType).toBe('Error');
        expect(meta.terminateReason).toBe('exception');
      });

      it('non-Error throw → errorType="NonErrorThrown"', async () => {
        vi.mocked(mockAgent.execute).mockRejectedValue('plain string');
        await runForegroundOnce();
        const meta = lastEndMeta();
        expect(meta.status).toBe('failed');
        expect(meta.error).toBe('plain string');
        expect(meta.errorType).toBe('NonErrorThrown');
      });

      it('endSubagentSpan is always called exactly once per invocation', async () => {
        // Lifecycle invariant: the wrapper's finally block fires once
        // for every runWithSubagentSpan call regardless of the body's
        // path. Default mockAgent here uses GOAL termination →
        // runSubagentWithHooks calls recordSpanOutcome internally.
        await runForegroundOnce();
        expect(mockEndSubagentSpan).toHaveBeenCalledTimes(1);
      });

      it('fallback: body that skips recordOutcome → status="failed" + wiring-bug terminateReason', async () => {
        // Defensive fallback in runWithSubagentSpan's finally — fires
        // when the body returns without calling recordOutcome. Today
        // no production path hits this (runSubagentWithHooks always
        // records), so we have to STUB out runSubagentWithHooks to
        // exercise the branch. wenshao @ #4410 DeepSeek 3292521244.
        const params: AgentParams = {
          description: 'Search files',
          prompt: 'Find all TypeScript files',
          subagent_type: 'file-search',
          run_in_background: false,
        };
        const invocation = (
          agentTool as AgentToolWithProtectedMethods
        ).createInvocation(params);
        // Replace runSubagentWithHooks on this instance so it returns
        // without calling recordSpanOutcome.
        (
          invocation as unknown as { runSubagentWithHooks: () => Promise<void> }
        ).runSubagentWithHooks = vi.fn().mockResolvedValue(undefined);
        await invocation.execute();
        const meta = lastEndMeta();
        expect(meta.status).toBe('failed');
        expect(meta.terminateReason).toBe(
          'wiring_bug_record_outcome_not_called',
        );
        expect(meta.error).toBe('recordOutcome was never called (wiring bug)');
      });

      it('startSubagentSpan receives depth=0 for top-level foreground (no parent ALS frame)', async () => {
        await runForegroundOnce();
        expect(mockStartSubagentSpan).toHaveBeenCalledTimes(1);
        const spec = lastStartSpec();
        expect(spec.depth).toBe(0);
        expect(spec.parentAgentId).toBeUndefined();
      });

      it('startSubagentSpan receives depth=parentDepth+1 when invoked inside an outer agent frame', async () => {
        await runWithAgentContext('outer-parent', async () => {
          await runForegroundOnce();
        });
        // Outer ALS frame at depth=0 → subagent itself records depth=1.
        // This regression-guards wenshao's depth-off-by-one fix at #4410.
        const spec = lastStartSpec();
        expect(spec.depth).toBe(1);
        expect(spec.parentAgentId).toBe('outer-parent');
      });

      it('CANCELLED terminateMode + aborted signal → status="cancelled" + terminateReason="signal_aborted"', async () => {
        // The signalAborted=true branch in deriveSubagentOutcomeMetadata —
        // user-initiated stop (Ctrl-C / task_stop) must classify as
        // signal_aborted, not subagent_cancelled. wenshao @ #4410.
        vi.mocked(mockAgent.getTerminateMode).mockReturnValue(
          AgentTerminateMode.CANCELLED,
        );
        const params: AgentParams = {
          description: 'Search files',
          prompt: 'Find all TypeScript files',
          subagent_type: 'file-search',
          run_in_background: false,
        };
        const invocation = (
          agentTool as AgentToolWithProtectedMethods
        ).createInvocation(params);
        const controller = new AbortController();
        controller.abort();
        await invocation.execute(controller.signal);
        const meta = lastEndMeta();
        expect(meta.status).toBe('cancelled');
        expect(meta.terminateReason).toBe('signal_aborted');
      });

      it('throw + aborted signal → status="aborted" + terminateReason="signal_aborted"', async () => {
        // The signalAborted=true branch in deriveSubagentExceptionMetadata.
        // A throw under an already-aborted signal is user-cancellation,
        // not a programmer error — must classify as aborted, not failed.
        vi.mocked(mockAgent.execute).mockRejectedValue(
          new Error('boom mid-cancel'),
        );
        const params: AgentParams = {
          description: 'Search files',
          prompt: 'Find all TypeScript files',
          subagent_type: 'file-search',
          run_in_background: false,
        };
        const invocation = (
          agentTool as AgentToolWithProtectedMethods
        ).createInvocation(params);
        const controller = new AbortController();
        controller.abort();
        await invocation.execute(controller.signal);
        const meta = lastEndMeta();
        expect(meta.status).toBe('aborted');
        expect(meta.terminateReason).toBe('signal_aborted');
      });
    });
  });

  describe('Fork dispatch (subagent_type: "fork")', () => {
    let mockAgent: AgentHeadless;
    let mockContextState: ContextState;

    beforeEach(() => {
      mockAgent = {
        execute: vi.fn().mockResolvedValue(undefined),
        getCore: vi.fn().mockReturnValue({
          modelConfig: { model: 'subagent-model' },
        }),
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

      vi.mocked(AgentHeadless.create).mockClear();
      vi.mocked(AgentHeadless.create).mockResolvedValue(mockAgent);

      (config as unknown as Record<string, unknown>)['isInteractive'] = vi
        .fn()
        .mockReturnValue(true);
    });

    it('does not require a commit unless the directive asks for one', () => {
      const childMessage = buildChildMessage('update the implementation');

      expect(childMessage).toContain(
        'Do NOT create a commit unless the directive explicitly asks you to',
      );
      expect(childMessage).toContain(
        'Verification: <checks performed and their outcome',
      );
      expect(childMessage).not.toContain(
        'commit your changes before reporting',
      );
    });

    it('forks in interactive mode', async () => {
      const mockLoadedSubagent: SubagentConfig = {
        name: 'general-purpose',
        description: 'General-purpose agent',
        systemPrompt: 'You are a general-purpose agent.',
        level: 'builtin',
        filePath: '<builtin:general-purpose>',
      };
      vi.mocked(mockSubagentManager.loadSubagent).mockResolvedValue(
        mockLoadedSubagent,
      );

      const params: AgentParams = {
        description: 'some task',
        prompt: 'do the thing',
        subagent_type: 'fork',
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      await invocation.execute();

      expect(mockSubagentManager.loadSubagent).not.toHaveBeenCalledWith(
        'general-purpose',
      );
      expect(AgentHeadless.create).toHaveBeenCalledTimes(1);
    });

    it('caps fork turns and uses bubble approval mode', async () => {
      const mockLoadedSubagent: SubagentConfig = {
        name: 'general-purpose',
        description: 'General-purpose agent',
        systemPrompt: 'You are a general-purpose agent.',
        level: 'builtin',
        filePath: '<builtin:general-purpose>',
      };
      vi.mocked(mockSubagentManager.loadSubagent).mockResolvedValue(
        mockLoadedSubagent,
      );

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation({
        description: 'some task',
        prompt: 'do the thing',
        subagent_type: 'fork',
      });
      await invocation.execute();

      expect(AgentHeadless.create).toHaveBeenCalledTimes(1);
      const createArgs = vi.mocked(AgentHeadless.create).mock.calls[0];
      // RunConfig (5th positional) carries the detached-fork turn cap so a
      // fire-and-forget fork can't loop unbounded.
      expect(createArgs[4]).toEqual({ max_turns: FORK_DEFAULT_MAX_TURNS });
      // The fork agent uses `bubble` approval so its permission prompts surface
      // to the parent's Background-tasks UI instead of being auto-denied.
      expect(FORK_AGENT.approvalMode).toBe(BUBBLE_APPROVAL_MODE);
    });

    it('omitting subagent_type uses general-purpose, not fork', async () => {
      // Omission resolves to the regular general-purpose subagent, never a
      // context-inheriting fork — even in interactive mode.
      const mockLoadedSubagent: SubagentConfig = {
        name: 'general-purpose',
        description: 'General-purpose agent',
        systemPrompt: 'You are a general-purpose agent.',
        level: 'builtin',
        filePath: '<builtin:general-purpose>',
      };
      vi.mocked(mockSubagentManager.loadSubagent).mockResolvedValue(
        mockLoadedSubagent,
      );

      const params: AgentParams = {
        description: 'some task',
        prompt: 'do the thing',
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      await invocation.execute();

      expect(mockSubagentManager.loadSubagent).toHaveBeenCalledWith(
        'general-purpose',
      );
      expect(AgentHeadless.create).not.toHaveBeenCalled();
    });

    it('falls back to general-purpose when non-interactive', async () => {
      vi.mocked(
        config.isInteractive as ReturnType<typeof vi.fn>,
      ).mockReturnValue(false);
      // Non-interactive sessions cannot service fork progress or prompts.

      const mockLoadedSubagent: SubagentConfig = {
        name: 'general-purpose',
        description: 'General-purpose agent',
        systemPrompt: 'You are a general-purpose agent.',
        level: 'builtin',
        filePath: '<builtin:general-purpose>',
      };
      vi.mocked(mockSubagentManager.loadSubagent).mockResolvedValue(
        mockLoadedSubagent,
      );

      const params: AgentParams = {
        description: 'fork task',
        prompt: 'do the thing',
        subagent_type: 'fork',
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      await invocation.execute();

      // Should fall back to general-purpose
      expect(mockSubagentManager.loadSubagent).toHaveBeenCalledWith(
        'general-purpose',
      );
      expect(AgentHeadless.create).not.toHaveBeenCalled();
    });

    it('falls back to general-purpose when a nested sub-agent requests a fork', async () => {
      // v1: fork is a top-level-only capability. A sub-agent — which may
      // carry the AgentTool via nesting — that requests a fork downgrades to
      // the awaitable general-purpose subagent instead of opening a nested
      // fork, even in interactive mode where fork is otherwise enabled.
      const mockLoadedSubagent: SubagentConfig = {
        name: 'general-purpose',
        description: 'General-purpose agent',
        systemPrompt: 'You are a general-purpose agent.',
        level: 'builtin',
        filePath: '<builtin:general-purpose>',
      };
      vi.mocked(mockSubagentManager.loadSubagent).mockResolvedValue(
        mockLoadedSubagent,
      );

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation({
        description: 'fork task',
        prompt: 'do the thing',
        subagent_type: 'fork',
      });
      // One agent frame → the invoker is a level-1 sub-agent, not the
      // top-level session, so the fork request must take the fallback path.
      await runWithAgentContext('parent-sub', () => invocation.execute());

      expect(mockSubagentManager.loadSubagent).toHaveBeenCalledWith(
        'general-purpose',
      );
      expect(AgentHeadless.create).not.toHaveBeenCalled();
    });

    it('should call AgentHeadless.create directly and execute without options', async () => {
      const params: AgentParams = {
        description: 'fork task',
        prompt: 'do the thing',
        subagent_type: 'fork',
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
      expect(createArgs[1].getApprovalMode()).toBe(ApprovalMode.DEFAULT);
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
        subagent_type: 'fork',
      };
      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      await invocation.execute();

      // Drain the detached fork body so its finally block runs.
      await vi.runAllTimersAsync();

      expect(stopSpy).toHaveBeenCalledTimes(1);
    });

    it('routes owned monitor notifications and cleanup for forks', async () => {
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
        subagent_type: 'fork',
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

    it('reserves a background slot with the resolved parent model when fork runs in background', async () => {
      // Removing the `!isFork` guard from the slot-reservation condition
      // silently subjected fork agents to background slot reservation and
      // per-model concurrency caps. This test pins the contract: a fork
      // launched with run_in_background: true resolves its concrete model
      // from the parent config (FORK_AGENT has no model selector, so it
      // inherits) and passes that model to tryReserveBackgroundSlot and
      // the registry register call.
      (mockAgent as unknown as Record<string, unknown>)['getCore'] = vi
        .fn()
        .mockReturnValue({
          getEventEmitter: () => ({ on: vi.fn(), off: vi.fn() }),
        });
      (mockAgent as unknown as Record<string, unknown>)[
        'setExternalMessageProvider'
      ] = vi.fn();
      (mockAgent as unknown as Record<string, unknown>)[
        'setExternalMessageWaiter'
      ] = vi.fn();
      (mockAgent as unknown as Record<string, unknown>)[
        'setExternalMessageWaitPredicate'
      ] = vi.fn();

      const stubRegistry = (
        config as unknown as {
          getBackgroundTaskRegistry: () => {
            tryReserveBackgroundSlot: ReturnType<typeof vi.fn>;
            register: ReturnType<typeof vi.fn>;
          };
        }
      ).getBackgroundTaskRegistry();

      const params: AgentParams = {
        description: 'fork task',
        prompt: 'do the thing',
        subagent_type: 'fork',
        run_in_background: true,
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      await invocation.execute();

      // createForkSubagent runs unconditionally before the background
      // branch, so AgentHeadless.create fires once for the foreground
      // probe and again for the background agent body. The load-bearing
      // assertions are on the registry calls below.
      expect(AgentHeadless.create).toHaveBeenCalled();
      // Fork inherits the parent model (FORK_AGENT has no model selector),
      // so resolveModelId returns the parent's current model.
      expect(stubRegistry.tryReserveBackgroundSlot).toHaveBeenCalledWith(
        'parent-model',
      );
      expect(stubRegistry.register).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'parent-model',
          isBackgrounded: true,
          subagentType: 'fork',
        }),
        expect.objectContaining({
          slotReservation: expect.objectContaining({
            id: expect.any(Symbol),
          }),
        }),
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
        getCore: vi.fn().mockReturnValue({
          modelConfig: { model: 'subagent-model' },
        }),
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
      vi.mocked(mockSubagentManager.createAgentHeadless).mockResolvedValue({
        subagent: mockAgent,
        dispose: vi.fn().mockResolvedValue(undefined),
      });

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
        run_in_background: false,
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

    it('inherits all parent turns when explicitly requested', async () => {
      vi.mocked(config.getGeminiClient).mockReturnValue({
        getHistoryForSubagent: vi.fn().mockReturnValue([
          {
            role: 'user',
            parts: [
              {
                text: '<system-reminder>\nstartup\n</system-reminder>',
              },
            ],
          },
          { role: 'user', parts: [{ text: 'parent question' }] },
          { role: 'model', parts: [{ text: 'parent answer' }] },
        ]),
      } as unknown as ReturnType<Config['getGeminiClient']>);

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation({
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
        fork_turns: 'all',
        run_in_background: false,
      });

      await invocation.execute();

      expect(mockSubagentManager.createAgentHeadless).toHaveBeenCalledWith(
        mockSubagents[0],
        expect.anything(),
        expect.objectContaining({
          promptConfigOverrides: {
            extraHistory: [
              { role: 'user', parts: [{ text: 'parent question' }] },
              { role: 'model', parts: [{ text: 'parent answer' }] },
            ],
          },
        }),
      );
    });

    it('starts without parent history by default', async () => {
      vi.mocked(config.getGeminiClient).mockReturnValue({
        getHistoryForSubagent: vi.fn().mockReturnValue([
          { role: 'user', parts: [{ text: 'parent question' }] },
          { role: 'model', parts: [{ text: 'parent answer' }] },
        ]),
      } as unknown as ReturnType<Config['getGeminiClient']>);

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation({
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
        run_in_background: false,
      });

      await invocation.execute();

      expect(mockSubagentManager.createAgentHeadless).toHaveBeenCalledWith(
        mockSubagents[0],
        expect.anything(),
        {
          eventEmitter: expect.anything(),
        },
      );
    });

    it('inherits from the direct parent agent instead of the top-level session', async () => {
      const topLevelHistorySpy = vi.fn().mockReturnValue([
        { role: 'user', parts: [{ text: 'top-level question' }] },
        { role: 'model', parts: [{ text: 'top-level answer' }] },
      ]);
      vi.mocked(config.getGeminiClient).mockReturnValue({
        getHistoryForSubagent: topLevelHistorySpy,
      } as unknown as ReturnType<Config['getGeminiClient']>);
      const directParentHistory = [
        { role: 'user' as const, parts: [{ text: 'direct parent question' }] },
        { role: 'model' as const, parts: [{ text: 'direct parent answer' }] },
      ];

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation({
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
        fork_turns: 'all',
        run_in_background: false,
      });

      await runWithAgentHistory(
        () => directParentHistory,
        () => invocation.execute(),
      );

      expect(mockSubagentManager.createAgentHeadless).toHaveBeenCalledWith(
        mockSubagents[0],
        expect.anything(),
        expect.objectContaining({
          promptConfigOverrides: {
            extraHistory: directParentHistory,
          },
        }),
      );
      expect(topLevelHistorySpy).not.toHaveBeenCalled();
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
        run_in_background: false,
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

    it('should inject hook_context as empty string when additionalContext is undefined', async () => {
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
        run_in_background: false,
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      await invocation.execute();

      // hook_context is always set (to empty string) so ${hook_context} in
      // systemPrompt does not throw even when hook returns no additional context.
      expect(mockContextState.set).toHaveBeenCalledWith('hook_context', '');
      expect(mockContextState.set).not.toHaveBeenCalledWith(
        'hook_context',
        expect.stringMatching(/.+/),
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
        run_in_background: false,
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

    it('should set hook_context to empty string even when hookSystem is not available', async () => {
      (config as unknown as Record<string, unknown>)['getHookSystem'] = vi
        .fn()
        .mockReturnValue(undefined);

      const params: AgentParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
        run_in_background: false,
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      const result = await invocation.execute();

      expect(mockHookSystem.fireSubagentStartEvent).not.toHaveBeenCalled();
      // hook_context is always set so ${hook_context} in systemPrompt does not throw.
      expect(mockContextState.set).toHaveBeenCalledWith('hook_context', '');
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
        getCore: vi.fn().mockReturnValue({
          modelConfig: { model: 'subagent-model' },
        }),
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
      vi.mocked(mockSubagentManager.createAgentHeadless).mockResolvedValue({
        subagent: mockAgent,
        dispose: vi.fn().mockResolvedValue(undefined),
      });

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
        run_in_background: false,
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
        run_in_background: false,
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
        run_in_background: false,
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      await invocation.execute();

      expect(mockAgent.execute).toHaveBeenCalledTimes(2);
    });

    it('uses the configured SubagentStop blocking cap', async () => {
      (
        config as unknown as {
          getStopHookBlockingCap: ReturnType<typeof vi.fn>;
        }
      ).getStopHookBlockingCap.mockReturnValue(2);
      const mockBlockOutput = {
        isBlockingDecision: vi.fn().mockReturnValue(true),
        shouldStopExecution: vi.fn().mockReturnValue(false),
        getEffectiveReason: vi.fn().mockReturnValue('Keep working'),
      };

      vi.mocked(mockHookSystem.fireSubagentStopEvent).mockResolvedValue(
        mockBlockOutput as never,
      );

      const params: AgentParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
        run_in_background: false,
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      const result = await invocation.execute();

      expect(mockHookSystem.fireSubagentStopEvent).toHaveBeenCalledTimes(2);
      expect(mockAgent.execute).toHaveBeenCalledTimes(2);
      expect(partToString(result.llmContent)).toContain(
        'SubagentStop hook blocked continuation 2 consecutive times; overriding and ending the turn.',
      );
    });

    it('should allow stop when SubagentStop hook fails', async () => {
      vi.mocked(mockHookSystem.fireSubagentStopEvent).mockRejectedValue(
        new Error('Stop hook failed'),
      );

      const params: AgentParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
        run_in_background: false,
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
        run_in_background: false,
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
        run_in_background: false,
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
        run_in_background: false,
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
        run_in_background: false,
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
        getCore: vi.fn().mockReturnValue({
          modelConfig: { model: 'subagent-model' },
        }),
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

      vi.mocked(mockSubagentManager.createAgentHeadless).mockResolvedValue({
        subagent: mockAgent,
        dispose: vi.fn().mockResolvedValue(undefined),
      });

      const params: AgentParams = {
        description: 'Edit files',
        prompt: 'Fix the bug',
        subagent_type: 'file-search',
        run_in_background: false,
      };

      capturedInvocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);

      return capturedInvocation;
    }

    it('preserves subagent tool protocol payloads in non-interactive mode', async () => {
      vi.mocked(config.isInteractive).mockReturnValue(false);
      const responseParts: Part[] = [{ text: 'raw protocol result' }];
      const snapshots: AgentResultDisplay[] = [];

      const invocation = createInvocationWithEventDrivenAgent((emitter) => {
        emitter.emit(AgentEventType.TOOL_CALL, {
          subagentId: 'sub-1',
          round: 1,
          callId: 'call-read-1',
          name: 'read_file',
          args: { path: '/test.ts' },
          description: 'Reading test.ts',
          timestamp: Date.now(),
        } satisfies AgentToolCallEvent);

        emitter.emit(AgentEventType.TOOL_RESULT, {
          subagentId: 'sub-1',
          round: 1,
          callId: 'call-read-1',
          name: 'read_file',
          success: true,
          responseParts,
          timestamp: Date.now(),
        } satisfies AgentToolResultEvent);
      });

      await invocation.execute(undefined, (output) => {
        snapshots.push(output as AgentResultDisplay);
      });

      const resultSnapshot = snapshots.find((snapshot) =>
        snapshot.toolCalls?.some(
          (toolCall) =>
            toolCall.callId === 'call-read-1' && toolCall.status === 'success',
        ),
      );
      const toolCall = resultSnapshot?.toolCalls?.find(
        (entry) => entry.callId === 'call-read-1',
      );
      expect(toolCall?.args).toEqual({ path: '/test.ts' });
      expect(toolCall?.responseParts).toBe(responseParts);
    });

    it('omits subagent protocol payloads from interactive display state', async () => {
      vi.mocked(config.isInteractive).mockReturnValue(true);
      const responseParts: Part[] = [{ text: 'raw protocol result' }];
      const snapshots: AgentResultDisplay[] = [];

      const invocation = createInvocationWithEventDrivenAgent((emitter) => {
        emitter.emit(AgentEventType.TOOL_CALL, {
          subagentId: 'sub-1',
          round: 1,
          callId: 'call-read-1',
          name: 'read_file',
          args: { path: '/test.ts' },
          description: 'Reading test.ts',
          timestamp: Date.now(),
        } satisfies AgentToolCallEvent);

        emitter.emit(AgentEventType.TOOL_RESULT, {
          subagentId: 'sub-1',
          round: 1,
          callId: 'call-read-1',
          name: 'read_file',
          success: true,
          responseParts,
          resultDisplay: 'Rendered result',
          timestamp: Date.now(),
        } satisfies AgentToolResultEvent);
      });

      await invocation.execute(undefined, (output) => {
        snapshots.push(output as AgentResultDisplay);
      });

      const resultSnapshot = snapshots.find((snapshot) =>
        snapshot.toolCalls?.some(
          (toolCall) =>
            toolCall.callId === 'call-read-1' && toolCall.status === 'success',
        ),
      );
      const toolCall = resultSnapshot?.toolCalls?.find(
        (entry) => entry.callId === 'call-read-1',
      );
      expect(toolCall?.description).toBe('Reading test.ts');
      expect(toolCall?.resultDisplay).toBe('Rendered result');
      expect(toolCall).not.toHaveProperty('args');
      expect(toolCall).not.toHaveProperty('responseParts');
    });

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
      assertCanStartBackgroundAgent: ReturnType<typeof vi.fn>;
      canStartBackgroundAgent: ReturnType<typeof vi.fn>;
      tryReserveBackgroundSlot: ReturnType<typeof vi.fn>;
      waitForBackgroundSlot: ReturnType<typeof vi.fn>;
      releaseBackgroundSlot: ReturnType<typeof vi.fn>;
      getQueuedCount: ReturnType<typeof vi.fn>;
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
          modelConfig: { model: 'subagent-model' },
          getEventEmitter: () => ({ on: vi.fn(), off: vi.fn() }),
        }),
      } as unknown as AgentHeadless;

      mockContextState = { set: vi.fn() } as unknown as ContextState;
      MockedContextState.mockImplementation(() => mockContextState);

      mockRegistry = {
        assertCanStartBackgroundAgent: vi.fn(),
        canStartBackgroundAgent: vi.fn().mockReturnValue(true),
        tryReserveBackgroundSlot: vi
          .fn()
          .mockReturnValue({ id: Symbol('background-slot') }),
        waitForBackgroundSlot: vi
          .fn()
          .mockResolvedValue({ id: Symbol('background-slot') }),
        releaseBackgroundSlot: vi.fn(),
        getQueuedCount: vi.fn().mockReturnValue(0),
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
      vi.mocked(mockSubagentManager.createAgentHeadless).mockResolvedValue({
        subagent: mockAgent,
        dispose: vi.fn().mockResolvedValue(undefined),
      });
    });

    it('should run in background when agent definition has background: true', async () => {
      const writeMetaSpy = vi.spyOn(transcript, 'writeAgentMeta');
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
        expect.objectContaining({
          slotReservation: expect.objectContaining({
            id: expect.any(Symbol),
          }),
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
      expect(writeMetaSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          persistedCliFlags: expect.objectContaining({
            model: 'subagent-model',
          }),
        }),
      );
      writeMetaSpy.mockRestore();
    });

    it('stores sanitized background results in the registry', async () => {
      vi.mocked(mockAgent.getFinalText).mockReturnValue(
        '<analysis>scratch</analysis><summary>visible</summary>',
      );

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation({
        description: 'Start monitor',
        prompt: 'Watch for changes',
        subagent_type: 'monitor',
      });

      await invocation.execute();
      await vi.runAllTimersAsync();

      expect(mockRegistry.complete).toHaveBeenCalledWith(
        expect.any(String),
        'visible',
        expect.any(Object),
      );
    });

    it('stores a fallback for background results with no model-visible text', async () => {
      vi.mocked(mockAgent.getFinalText).mockReturnValue(
        '<analysis>scratch only</analysis>',
      );

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation({
        description: 'Start monitor',
        prompt: 'Watch for changes',
        subagent_type: 'monitor',
      });

      await invocation.execute();
      await vi.runAllTimersAsync();

      expect(mockRegistry.complete).toHaveBeenCalledWith(
        expect.any(String),
        '(subagent produced no model-visible output)',
        expect.any(Object),
      );
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

    it('runs a top-level subagent in the background when the flag is omitted', async () => {
      const defaultSubagent: SubagentConfig = {
        ...bgSubagent,
        name: 'file-search',
        background: undefined,
      };
      vi.mocked(mockSubagentManager.loadSubagent).mockResolvedValue(
        defaultSubagent,
      );

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation({
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
      });
      const result = await invocation.execute();

      expect(partToString(result.llmContent)).toContain(
        'Background agent launched',
      );
      expect(mockRegistry.register).toHaveBeenCalled();
    });

    it('persists inherited context for background-agent revival', async () => {
      const attachSpy = vi.spyOn(transcript, 'attachJsonlTranscriptWriter');
      vi.mocked(config.getGeminiClient).mockReturnValue({
        getHistoryForSubagent: vi.fn().mockReturnValue([
          { role: 'user', parts: [{ text: 'parent question' }] },
          { role: 'model', parts: [{ text: 'parent answer' }] },
        ]),
      } as unknown as ReturnType<Config['getGeminiClient']>);

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation({
        description: 'Start monitor',
        prompt: 'Watch for changes',
        subagent_type: 'monitor',
        fork_turns: 'all',
      });

      await invocation.execute();

      expect(attachSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        expect.objectContaining({
          bootstrapKind: 'context',
          bootstrapHistory: [
            { role: 'user', parts: [{ text: 'parent question' }] },
            { role: 'model', parts: [{ text: 'parent answer' }] },
          ],
        }),
      );
      attachSpy.mockRestore();
    });

    it('keeps a named-teammate launch in the foreground when no team is active and the flag is omitted', async () => {
      // A `name` passed without an active team manager falls through to a
      // regular one-shot agent (agent.ts logs and continues), and
      // backgroundRequested excludes `name` (`this.params.name === undefined`).
      // Guard the core dispatch directly so a future refactor that drops the
      // `name` exclusion is caught here, not only in the UI classifiers (both
      // of which treat named calls as foreground).
      vi.mocked(config.getTeamManager).mockReturnValue(null);
      const defaultSubagent: SubagentConfig = {
        ...bgSubagent,
        name: 'file-search',
        background: undefined,
      };
      vi.mocked(mockSubagentManager.loadSubagent).mockResolvedValue(
        defaultSubagent,
      );

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation({
        description: 'Review the diff',
        prompt: 'Review the diff',
        subagent_type: 'file-search',
        name: 'reviewer',
        // run_in_background intentionally omitted.
      });
      const result = await invocation.execute();

      // Foreground: an omitted flag on a named launch must NOT route through
      // the background registry path.
      expect(partToString(result.llmContent)).not.toContain(
        'Background agent launched',
      );
      expect(mockRegistry.register).toHaveBeenCalledWith(
        expect.objectContaining({ isBackgrounded: false }),
      );
    });

    it('runs in the foreground when run_in_background is false', async () => {
      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation({
        description: 'Start monitor',
        prompt: 'Watch for changes',
        subagent_type: 'monitor',
        run_in_background: false,
      });
      const result = await invocation.execute();

      expect(partToString(result.llmContent)).toBe('Monitor done');
      expect(mockRegistry.register).toHaveBeenCalledWith(
        expect.objectContaining({ isBackgrounded: false }),
      );
    });

    it('lets an explicit run_in_background: false override a config with background: true', async () => {
      // Precedence contract: the explicit tool parameter wins over the
      // subagent config's background flag (`run_in_background ?? config`).
      // A `||` here would let background: true override the explicit false
      // and detach the agent when the caller asked for an inline result.
      const explicitBackgroundConfig: SubagentConfig = {
        ...bgSubagent,
        name: 'file-search',
      };
      vi.mocked(mockSubagentManager.loadSubagent).mockResolvedValue(
        explicitBackgroundConfig,
      );

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation({
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
        run_in_background: false,
      });
      const result = await invocation.execute();

      expect(partToString(result.llmContent)).toBe('Monitor done');
      expect(mockRegistry.register).toHaveBeenCalledWith(
        expect.objectContaining({ isBackgrounded: false }),
      );
    });

    it('downgrades a background request from a nested sub-agent to an awaited foreground run', async () => {
      // Background delegation is top-level-only in v1: a nested launcher
      // cannot honor the background completion contract (send_message /
      // task_stop are excluded from its toolset, and completion
      // notifications go to the top-level session). The run must complete
      // inline instead of orphaning the child's results.
      vi.mocked(config.getMaxSubagentDepth).mockReturnValue(5);
      const params: AgentParams = {
        description: 'Start monitor from a nested sub-agent',
        prompt: 'Watch for changes',
        subagent_type: 'monitor',
        run_in_background: true,
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      const result = await runWithAgentContext('sub-1', () =>
        invocation.execute(),
      );

      const llmText = partToString(result.llmContent);
      expect(llmText).not.toContain('Background agent launched');
      expect(llmText).toContain('Monitor done');
      expect(mockRegistry.register).toHaveBeenCalledWith(
        expect.objectContaining({ isBackgrounded: false }),
      );
    });

    it('keeps an omitted background flag in the foreground for nested sub-agents', async () => {
      vi.mocked(config.getMaxSubagentDepth).mockReturnValue(5);
      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation({
        description: 'Search from a nested sub-agent',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
      });

      const result = await runWithAgentContext('sub-1', () =>
        invocation.execute(),
      );

      expect(partToString(result.llmContent)).toBe('Monitor done');
      expect(mockRegistry.register).toHaveBeenCalledWith(
        expect.objectContaining({ isBackgrounded: false }),
      );
      expect(mockRegistry.tryReserveBackgroundSlot).not.toHaveBeenCalled();
    });

    it('returns registry registration errors to the model without launching the background body', async () => {
      const errorMessage =
        'Cannot start background agent: maximum concurrent background agents ' +
        '(1) reached. Stop an existing agent first.';
      mockRegistry.register.mockImplementation(() => {
        throw new Error(errorMessage);
      });
      const attachSpy = vi.spyOn(transcript, 'attachJsonlTranscriptWriter');

      try {
        const params: AgentParams = {
          description: 'Start monitor',
          prompt: 'Watch for changes',
          subagent_type: 'monitor',
        };

        const invocation = (
          agentTool as AgentToolWithProtectedMethods
        ).createInvocation(params);
        const result = await invocation.execute();

        expect(partToString(result.llmContent)).toBe(errorMessage);
        expect((result.returnDisplay as AgentResultDisplay).status).toBe(
          'failed',
        );
        expect(attachSpy).not.toHaveBeenCalled();
        expect(mockAgent.execute).not.toHaveBeenCalled();
        expect(mockRegistry.complete).not.toHaveBeenCalled();
        expect(mockRegistry.fail).not.toHaveBeenCalled();
      } finally {
        attachSpy.mockRestore();
      }
    });

    it('fires SubagentStop when the final background register check fails after SubagentStart', async () => {
      const errorMessage =
        'Cannot start background agent: maximum concurrent background agents ' +
        '(1) reached. Stop an existing agent first.';
      mockRegistry.register.mockImplementation(() => {
        throw new Error(errorMessage);
      });
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
      const result = await invocation.execute();

      expect(partToString(result.llmContent)).toBe(errorMessage);
      expect(mockHookSystem.fireSubagentStartEvent).toHaveBeenCalledOnce();
      expect(mockHookSystem.fireSubagentStopEvent).toHaveBeenCalledWith(
        expect.stringContaining('monitor-'),
        'monitor',
        expect.stringMatching(
          /subagents[\\/]test-session-id[\\/]agent-monitor-.*\.jsonl$/,
        ),
        'Monitor done',
        false,
        PermissionMode.AutoEdit,
        undefined,
      );
      expect(mockAgent.execute).not.toHaveBeenCalled();
    });

    it('waits for a background slot before hooks and subagent setup', async () => {
      let releaseSlot:
        | ((reservation: { readonly id: symbol }) => void)
        | undefined;
      const slotReservation = { id: Symbol('background-slot') };
      mockRegistry.canStartBackgroundAgent.mockReturnValue(false);
      mockRegistry.tryReserveBackgroundSlot.mockReturnValue(undefined);
      mockRegistry.getQueuedCount.mockReturnValue(1);
      mockRegistry.waitForBackgroundSlot.mockReturnValue(
        new Promise((resolve) => {
          releaseSlot = resolve;
        }),
      );
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
      const updates: ToolResultDisplay[] = [];
      const executePromise = invocation.execute(undefined, (output) => {
        updates.push(output);
      });
      await Promise.resolve();

      expect(mockRegistry.waitForBackgroundSlot).toHaveBeenCalled();
      // Per-model cap: resolved model ID must flow through to the registry.
      expect(mockRegistry.tryReserveBackgroundSlot).toHaveBeenCalledWith(
        'parent-model',
      );
      expect(mockRegistry.waitForBackgroundSlot).toHaveBeenCalledWith(
        undefined,
        'parent-model',
      );
      expect(mockHookSystem.fireSubagentStartEvent).not.toHaveBeenCalled();
      expect(mockSubagentManager.createAgentHeadless).not.toHaveBeenCalled();
      expect(mockRegistry.register).not.toHaveBeenCalled();
      expect(
        updates.some(
          (update) =>
            (update as AgentResultDisplay).terminateReason ===
            'Waiting for a sub-agent slot (1 already queued).',
        ),
      ).toBe(true);

      releaseSlot?.(slotReservation);
      const result = await executePromise;

      expect(partToString(result.llmContent)).toContain(
        'Background agent launched',
      );
      expect(mockRegistry.register).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'running' }),
        expect.objectContaining({ slotReservation }),
      );
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

    it('should run in foreground when run_in_background is false', async () => {
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
        run_in_background: false,
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      const result = await invocation.execute();

      const llmText = partToString(result.llmContent);
      expect(llmText).not.toContain('Background agent launched');
      // Foreground subagents register in the same registry with
      // isBackgrounded: false so the pill+dialog can surface them while
      // the parent's tool-call awaits, then unregister in the finally
      // path once the call returns. (The tool-result is the durable
      // record — the entry does not persist.)
      expect(mockRegistry.register).toHaveBeenCalledWith(
        expect.objectContaining({
          isBackgrounded: false,
          description: 'Search files',
          subagentType: 'file-search',
          status: 'running',
        }),
      );
      expect(mockRegistry.unregisterForeground).toHaveBeenCalledWith(
        expect.stringContaining('file-search-'),
      );
      expect(mockRegistry.tryReserveBackgroundSlot).not.toHaveBeenCalled();
      expect(mockRegistry.waitForBackgroundSlot).not.toHaveBeenCalled();
      expect(mockRegistry.releaseBackgroundSlot).not.toHaveBeenCalled();
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

    it('does not wait for a background slot before foreground subagent setup', async () => {
      const fgSubagent: SubagentConfig = {
        ...bgSubagent,
        name: 'file-search',
        background: undefined,
      };
      vi.mocked(mockSubagentManager.loadSubagent).mockResolvedValue(fgSubagent);
      mockRegistry.tryReserveBackgroundSlot.mockReturnValue(undefined);

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation({
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
        run_in_background: false,
      });
      await invocation.execute();

      expect(mockSubagentManager.createAgentHeadless).toHaveBeenCalled();
      expect(mockRegistry.register).toHaveBeenCalledWith(
        expect.objectContaining({ isBackgrounded: false }),
      );
      expect(mockRegistry.waitForBackgroundSlot).not.toHaveBeenCalled();
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
        run_in_background: false,
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

    it('foreground subagent reserves a JSONL+meta path on the registry entry', async () => {
      // Foreground subagents persist a JSONL transcript + meta sidecar
      // symmetrically with the background path. Without this, a cancelled
      // or crashed foreground run leaves no on-disk evidence beyond
      // whatever made it into the parent's tool result.
      const fgSubagent: SubagentConfig = {
        ...bgSubagent,
        name: 'file-search',
        background: undefined,
      };
      vi.mocked(mockSubagentManager.loadSubagent).mockResolvedValue(fgSubagent);

      const attachSpy = vi.spyOn(transcript, 'attachJsonlTranscriptWriter');
      const writeMetaSpy = vi.spyOn(transcript, 'writeAgentMeta');
      const patchMetaSpy = vi.spyOn(transcript, 'patchAgentMeta');

      const params: AgentParams = {
        description: 'Search files',
        prompt: 'Find all TypeScript files',
        subagent_type: 'file-search',
        run_in_background: false,
      };

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation(params);
      await invocation.execute();

      expect(mockRegistry.register).toHaveBeenCalledWith(
        expect.objectContaining({
          isBackgrounded: false,
          outputFile: expect.stringMatching(
            /subagents[\\/]test-session-id[\\/]agent-file-search-.*\.jsonl$/,
          ),
          metaPath: expect.stringMatching(
            /subagents[\\/]test-session-id[\\/]agent-file-search-.*\.meta\.json$/,
          ),
        }),
      );
      // Writer attached to the AgentTool's emitter so foreground tool
      // calls / round text get recorded into the JSONL.
      expect(attachSpy).toHaveBeenCalled();
      // Meta sidecar is seeded eagerly at register time so resume
      // discovery can surface paused foreground runs.
      expect(writeMetaSpy).toHaveBeenCalledWith(
        expect.stringMatching(/agent-file-search-.*\.meta\.json$/),
        expect.objectContaining({
          status: 'running',
          agentType: 'file-search',
          description: 'Search files',
          persistedCliFlags: expect.objectContaining({
            approvalMode: 'auto-edit',
            bare: false,
            sandbox: null,
            screenReader: false,
            model: 'subagent-model',
            maxSessionTurns: -1,
            maxToolCalls: -1,
            maxSubagentDepth: 5,
          }),
        }),
      );
      // Finally block patches the sidecar to the terminal status —
      // without this a completed foreground run leaves the on-disk meta
      // frozen at `running`.
      expect(patchMetaSpy).toHaveBeenCalledWith(
        expect.stringMatching(/agent-file-search-.*\.meta\.json$/),
        expect.objectContaining({ status: 'completed' }),
      );

      attachSpy.mockRestore();
      writeMetaSpy.mockRestore();
      patchMetaSpy.mockRestore();
    });

    it.each([
      [AgentTerminateMode.CANCELLED, 'cancelled'],
      [AgentTerminateMode.ERROR, 'failed'],
      [AgentTerminateMode.MAX_TURNS, 'failed'],
      [AgentTerminateMode.TIMEOUT, 'failed'],
    ] as const)(
      'foreground %s terminate mode patches meta as %s',
      async (mode, expectedStatus) => {
        // The fgTerminalStatus ternary maps GOAL → completed, CANCELLED →
        // cancelled, and *everything else* → failed. GOAL is covered by
        // the "foreground subagent reserves a JSONL+meta path" test above;
        // CANCELLED and the fallback branch are covered here. A regression
        // that flipped CANCELLED → 'failed' or the fallback back to
        // 'completed' (an earlier fallback bug shipped and was fixed in
        // d67db4c50) would now fail at least one of these cases.
        const fgSubagent: SubagentConfig = {
          ...bgSubagent,
          name: 'file-search',
          background: undefined,
        };
        vi.mocked(mockSubagentManager.loadSubagent).mockResolvedValue(
          fgSubagent,
        );
        vi.mocked(mockAgent.getTerminateMode).mockReturnValue(mode);

        const patchMetaSpy = vi.spyOn(transcript, 'patchAgentMeta');

        const params: AgentParams = {
          description: 'Search files',
          prompt: 'Find all TypeScript files',
          subagent_type: 'file-search',
          run_in_background: false,
        };

        const invocation = (
          agentTool as AgentToolWithProtectedMethods
        ).createInvocation(params);
        await invocation.execute();

        expect(patchMetaSpy).toHaveBeenCalledWith(
          expect.stringMatching(/agent-file-search-.*\.meta\.json$/),
          expect.objectContaining({ status: expectedStatus }),
        );

        patchMetaSpy.mockRestore();
      },
    );

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
        run_in_background: false,
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

    it('keeps bubble-mode background agents on auto-deny in non-interactive mode', async () => {
      vi.mocked(
        config.isInteractive as ReturnType<typeof vi.fn>,
      ).mockReturnValue(false);
      vi.mocked(mockSubagentManager.loadSubagent).mockResolvedValue({
        ...bgSubagent,
        approvalMode: 'bubble',
      });

      const invocation = (
        agentTool as AgentToolWithProtectedMethods
      ).createInvocation({
        description: 'Start monitor',
        prompt: 'Watch for changes',
        subagent_type: 'monitor',
      });

      await invocation.execute();

      const createCalls = vi.mocked(mockSubagentManager.createAgentHeadless)
        .mock.calls;
      const createdConfig = createCalls[createCalls.length - 1][1] as Config;
      expect(createdConfig.getShouldAvoidPermissionPrompts()).toBe(true);
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
        expect.objectContaining({
          slotReservation: expect.anything(),
        }),
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
      (config as unknown as Record<string, unknown>)['isInteractive'] = vi
        .fn()
        .mockReturnValue(true);

      const forkParams: AgentParams = {
        description: 'Fork task',
        prompt: 'Investigate issue',
        subagent_type: 'fork',
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

  it('should resolve the subagent-only "bubble" mode to Default (confirmation required)', () => {
    // `bubble` is not a privileged mode — it requires confirmation like
    // `default`, so it resolves to Default in both trusted and untrusted
    // folders (the background launch path is what flips deny → surface).
    expect(
      resolveSubagentApprovalMode(ApprovalMode.DEFAULT, 'bubble', true),
    ).toBe(PermissionMode.Default);
    expect(
      resolveSubagentApprovalMode(ApprovalMode.DEFAULT, 'bubble', false),
    ).toBe(PermissionMode.Default);
  });

  it('should let a permissive parent win over a "bubble" subagent mode', () => {
    // Consistent with every other mode: a yolo/auto-edit parent wins, so a
    // bubble agent under such a parent runs permissively (and never bubbles,
    // since no confirmation is ever requested).
    expect(resolveSubagentApprovalMode(ApprovalMode.YOLO, 'bubble', true)).toBe(
      PermissionMode.Yolo,
    );
    expect(
      resolveSubagentApprovalMode(ApprovalMode.AUTO_EDIT, 'bubble', true),
    ).toBe(PermissionMode.AutoEdit);
  });
});
