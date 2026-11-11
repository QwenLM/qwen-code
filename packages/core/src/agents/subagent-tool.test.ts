/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import {
  AgentTool,
  buildForkSubtaskParams,
  normalizeAgentTypeName,
  spawnForkSubtask,
} from './subagent-tool.js';
import {
  buildForkDirectivePrompt,
  deriveForkName,
  FORK_QUERY_SOURCE,
  truncateDirectiveLabel,
} from './fork-subagent.js';
import { Kind, type DeclarativeTool, type ToolResult } from '../tools/tools.js';
import type { LocalAgentDefinition, SubagentProgress } from './types.js';
import { makeFakeConfig } from '../test-utils/config.js';
import type { Config } from '../config/config.js';

import type { ToolRegistry } from '../tools/tool-registry.js';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import type { TestPermissionManager } from '../test-utils/config.js';
import type { AgentRegistry } from './registry/agentRegistry.js';
import { ExecutionLifecycleService } from '../services/executionLifecycleService.js';
import {
  _resetQueueForTest,
  getCommandQueueSnapshot,
} from '../services/messageQueueManager.js';
import {
  _clearOutputsForTest,
  _resetTaskOutputDirForTest,
  setTaskOutputDir,
} from '../utils/task/diskOutput.js';
import {
  ENV_CONFIG_DIR,
  ENV_AGENT_TEAMS,
  ENV_ENABLE_AGENT_SESSIONS,
  ENV_MAX_CONCURRENT_SUBAGENTS,
  ENV_FORK_SUBAGENT,
} from '../config/brand.js';
import { runWithToolCallContext } from '../utils/toolCallContext.js';
import { drainSubagentSdkEvents } from './subagent-sdk-events.js';
import { _resetConfigHomeDirCache } from '../utils/paths.js';
import { readFile, rm, writeFile } from 'node:fs/promises';
import {
  getAgentTeamConfigPath,
  readAgentTeamConfig,
  sendTeamMessage,
} from './teams/agent-team-runtime.js';
import { signalTeammateController } from './teams/agent-team-controller.js';
import { deriveSessionTeamName } from './teams/agent-teams-feature.js';
import { parseTaskNotificationXml } from '../services/taskNotification.js';
import type { AgentToolBackgroundLaunchResult } from './agent-tool-result.js';
import { getSubagentTranscriptPath } from '../services/subagent-transcript.js';
import { EXPLORE_AGENT_NAME, ExploreAgent } from './builtin/explore-agent.js';
import { SIMPLE_SYSTEM_PROMPT_ENV } from '../prompts/bundle-resolver.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock runSubagent
vi.mock('./run-subagent.js', () => ({
  runSubagent: vi.fn(),
}));

// Mock agent-setup helpers
vi.mock('./agent-setup.js', () => ({
  buildSubagentRegistries: vi.fn().mockResolvedValue({
    toolRegistry: { getSchema: vi.fn(() => []) },
    promptRegistry: {},
    resourceRegistry: {},
    parentCallId: undefined,
  }),
  buildSubagentSystemPrompt: vi.fn().mockResolvedValue('test system prompt'),
}));

// Mock hooks
vi.mock('../hooks/sessionHooks.js', () => ({
  registerFrontmatterHooks: vi.fn(),
  clearFrontmatterHooks: vi.fn(),
}));

vi.mock('../provider/impl/modelProviderManager.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../provider/impl/modelProviderManager.js')
    >();
  const { testListedModel } = await import('../test-utils/listed-model.js');
  class TestManager extends actual.ModelProviderManager {
    override async getModel(key: string) {
      return testListedModel(key);
    }
    override async listModels() {
      return [testListedModel('test-model', { is_default: true })];
    }
  }
  return { ...actual, ModelProviderManager: TestManager };
});

// Mock worktree service
vi.mock('../services/worktreeService.js', () => ({
  findProjectRootForWorktree: vi.fn(async (cwd: string) => cwd),
  readCurrentGitBranch: vi.fn().mockResolvedValue('main'),
  createWorktreeService: vi.fn().mockResolvedValue({
    setup: vi.fn().mockResolvedValue({
      path: '/tmp/worktree',
      name: 'agent-test',
      baseSha: 'abc123',
    }),
    maybeCleanup: vi.fn().mockResolvedValue(true),
  }),
}));

// Mock agent context
vi.mock('../utils/agentContext.js', () => ({
  runWithAgentContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
  runWithoutAgentContext: vi.fn((fn: () => unknown) => fn()),
  getAgentContext: vi.fn(() => undefined),
}));

import { runSubagent } from './run-subagent.js';
import { getAgentContext } from '../utils/agentContext.js';
const mockRunSubagent = vi.mocked(runSubagent);

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const testLocalDefinition: LocalAgentDefinition = {
  kind: 'local',
  name: 'MockAgent',
  description: 'A local agent for testing.',
  metadata: { source: 'project' },
  inputConfig: {
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The query.' },
        priority: { type: 'number', description: 'Priority.' },
      },
      required: ['query'],
    },
  },
  modelConfig: {
    model: 'test-model',
    generateContentConfig: {},
  },
  runConfig: { maxTimeMinutes: 1 },
  promptConfig: { systemPrompt: 'test' },
};

/**
 * Creates a mock AgentRegistry that returns the given definitions.
 */
function createMockAgentRegistry(
  definitions: LocalAgentDefinition[],
): AgentRegistry {
  const defMap = new Map(definitions.map((d) => [d.name, d]));
  return {
    getDefinition: (name: string) => defMap.get(name),
    getAllDefinitions: () => [...defMap.values()],
    getAllAgentNames: () => [...defMap.keys()],
    getDiscoveredDefinition: (name: string) => defMap.get(name),
    getAllDiscoveredAgentNames: () => [...defMap.keys()],
    getAllDiscoveredDefinitions: () => [...defMap.values()],
  } as unknown as AgentRegistry;
}

/**
 * Creates a properly mocked Config with all methods needed by executeLocal().
 */
function setupMockConfig(): Config {
  const config = makeFakeConfig();
  Object.defineProperty(config, 'promptId', {
    get: () => 'test-prompt-id',
    configurable: true,
  });
  const toolRegistryStub = {
    getTool: vi.fn(() => ({ displayName: 'test tool' })),
    // Mirrors the real ToolRegistry so tests only have to drive getTool.
    hasToolEnabled: vi.fn(() => toolRegistryStub.getTool() !== undefined),
    getAllTools: vi.fn(() => [{ name: 'Read' }]),
  };
  Object.defineProperty(config, 'toolRegistry', {
    value: toolRegistryStub,
    configurable: true,
  });
  // Ensure getMcpClientManager is available for cleanup
  const origGetMcp = config.getMcpClientManager?.bind(config);
  if (!origGetMcp || typeof origGetMcp !== 'function') {
    Object.defineProperty(config, 'getMcpClientManager', {
      value: vi.fn(() => ({ removeRegistries: vi.fn() })),
      configurable: true,
    });
  }
  // Ensure getHookSystem is available
  const origGetHook = config.getHookSystem?.bind(config);
  if (!origGetHook || typeof origGetHook !== 'function') {
    Object.defineProperty(config, 'getHookSystem', {
      value: vi.fn(() => null),
      configurable: true,
    });
  }
  return config;
}

function defaultForkedAgentResult() {
  return {
    messages: [
      {
        type: 'assistant',
      } as unknown as import('../protocol/transcript/message.js').Message,
    ],
    totalUsage: {
      input_tokens: 10,
      output_tokens: 20,
    } as unknown as import('../protocol/schemas/common.js').NonNullableUsage,
    textContent: 'Analysis complete.',
  };
}

/** A runSubagent result that stays pending until `settle()` is called. */
function deferredAgentRun() {
  let resolve!: (value: ReturnType<typeof defaultForkedAgentResult>) => void;
  const promise = new Promise<ReturnType<typeof defaultForkedAgentResult>>(
    (resolvePromise) => {
      resolve = resolvePromise;
    },
  );
  return { promise, settle: () => resolve(defaultForkedAgentResult()) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentTool', () => {
  let mockConfig: Config;
  let mockContext: AgentLoopContext;
  let mockRegistry: AgentRegistry;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    ExecutionLifecycleService.resetForTest();
    _resetQueueForTest();
    await _clearOutputsForTest();
    _resetTaskOutputDirForTest();
    setTaskOutputDir(
      path.join(
        os.tmpdir(),
        `subagent-tool-tests-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      ),
    );
    mockConfig = setupMockConfig();
    mockContext = mockConfig as AgentLoopContext;
    mockRegistry = createMockAgentRegistry([testLocalDefinition]);
    mockRunSubagent.mockResolvedValue(defaultForkedAgentResult());
  });

  // ─── Basic tool properties ───

  it('should have Kind.Agent', () => {
    const tool = new AgentTool(mockRegistry, mockContext);
    expect(tool.kind).toBe(Kind.Agent);
  });

  it('should use fixed "Agent" name', () => {
    const tool = new AgentTool(mockRegistry, mockContext);
    expect(tool.name).toBe('Agent');
  });

  it('gives auto-mode review the whole prompt and the execution settings', () => {
    const tool = new AgentTool(mockRegistry, mockContext);
    const prompt = `${'x'.repeat(2000)} then delete the release branch`;
    expect(
      tool.toClassifierInput({
        description: 'cleanup',
        prompt,
        mode: 'yolo',
        cwd: '/elsewhere',
      }),
    ).toMatchObject({ prompt, mode: 'yolo', cwd: '/elsewhere' });
  });

  it('should keep agent type descriptions out of the tool schema', () => {
    const tool = new AgentTool(mockRegistry, mockContext);
    expect(tool.description).toContain(
      'Available agent types are listed in <system-reminder> messages',
    );
    expect(tool.description).not.toContain('MockAgent');
    expect(tool.description).not.toContain('A local agent for testing.');
    expect(tool.description).not.toContain('(Tools:');
  });

  it('should use the compact Agent contract for Lean models', () => {
    vi.stubEnv(SIMPLE_SYSTEM_PROMPT_ENV, '1');
    const tool = new AgentTool(mockRegistry, mockContext);

    const description = tool.getSchema('lean-model').description ?? '';

    expect(description).toContain('final report is not shown to the user');
    expect(description).toContain('worktree');
    expect(description).not.toContain('## Usage notes');
    expect(description).not.toContain('## Writing the prompt');
    expect(description).not.toContain('Trust but verify');
  });

  it('should require sensitive delegated changes in the initial prompt', () => {
    const tool = new AgentTool(mockRegistry, mockContext);

    expect(tool.description).toContain(
      "If the user's request explicitly requires changing permission settings, AGENTS.md, or configuration, state that exact change in the initial prompt",
    );
    expect(tool.description).toContain(
      'later agent messages cannot convey approval for new sensitive changes',
    );
  });

  it('should explain how to brief a fresh agent', () => {
    const tool = new AgentTool(mockRegistry, mockContext);

    expect(tool.description).toContain(
      'Brief the agent like a smart colleague who just walked into the room',
    );
    expect(tool.description).toContain(
      "Explain what you're trying to accomplish and why, what you've already learned or ruled out",
    );
    expect(tool.description).toContain('If you need a short response, say so');
    expect(tool.description).toContain(
      'Lookups: hand over the exact command. Investigations: hand over the question',
    );
    expect(tool.description).toContain(
      'Terse command-style prompts produce shallow, generic work',
    );
    expect(tool.description).toContain('**Never delegate understanding.**');
    expect(tool.description).toContain('based on your findings, fix the bug');
  });

  it('should explain when direct tools are more appropriate', () => {
    const tool = new AgentTool(mockRegistry, mockContext);

    expect(tool.description).toContain(
      'If the target is already known, use the direct tool',
    );
    expect(tool.description).toContain('Read for a known path');
    expect(tool.description).toContain('Grep for a specific symbol or string');
    expect(tool.description).toContain(
      'Reserve this tool for open-ended questions that span the codebase',
    );
    expect(tool.description).not.toContain('Glob tool instead');
    expect(tool.description).not.toContain('context-handoff cost');
    expect(tool.description).not.toContain('## Scope ownership');
  });

  it('should not advertise unavailable direct tools', () => {
    vi.mocked(mockContext.toolRegistry.getTool).mockReturnValue(undefined);

    const tool = new AgentTool(mockRegistry, mockContext);

    expect(tool.description).not.toContain('## When not to use');
    expect(tool.description).not.toContain('Read for a known path');
    expect(tool.description).not.toContain('Grep for a specific symbol');
  });

  it('should refresh direct-tool guidance when rebound to a child registry', () => {
    const tool = new AgentTool(mockRegistry, mockContext);
    expect(tool.description).toContain('Read for a known path');

    tool.bindAgentLoopContext({
      config: mockConfig,
      toolRegistry: {
        getTool: vi.fn(() => undefined),
        hasToolEnabled: vi.fn(() => false),
      } as unknown as ToolRegistry,
    } as unknown as AgentLoopContext);

    expect(tool.description).not.toContain('## When not to use');
    expect(tool.description).not.toContain('Read for a known path');
  });

  it('should require verification of delegated changes', () => {
    const tool = new AgentTool(mockRegistry, mockContext);

    expect(tool.description).toContain(
      "Trust but verify: an agent's summary describes what it intended to do, not necessarily what it did",
    );
    expect(tool.description).toContain(
      'check the actual changes before reporting the work as done',
    );
    expect(tool.description).toContain(
      "Each agent type's model, reasoning effort, and tool access are set in its definition",
    );
    expect(tool.description).not.toContain('should generally be trusted');
  });

  it('should use the Full delegation boundary without forced fan-out', () => {
    const tool = new AgentTool(mockRegistry, mockContext);

    expect(tool.description).toContain(
      'when you have independent work to run in parallel',
    );
    expect(tool.description).toContain(
      'For a single-fact lookup where you already know the file, symbol, or value, search directly',
    );
    expect(tool.description).not.toContain(
      'Use one agent for a single investigation',
    );
    expect(tool.description).not.toContain(
      'Launch multiple agents concurrently whenever possible',
    );
  });

  it('should describe fresh-agent routing when fork is disabled', () => {
    vi.stubEnv(ENV_FORK_SUBAGENT, '0');
    const tool = new AgentTool(mockRegistry, mockContext);

    expect(tool.description).toContain(
      'If omitted, the general-purpose agent is used',
    );
    expect(tool.description).not.toContain(
      'If omitted, a fork is created from the parent conversation context',
    );
  });

  it('should describe inherited context when fork is enabled', () => {
    vi.stubEnv(ENV_FORK_SUBAGENT, '1');
    const tool = new AgentTool(mockRegistry, mockContext);

    expect(tool.description).toContain('`"fork"` forks yourself');
    expect(tool.description).toContain(
      'omitting it — starts a fresh agent (general-purpose by default)',
    );
    expect(tool.description).toContain(
      'Any agent other than a fork starts with zero conversation context',
    );
    expect(tool.description).toContain('## When to fork');
    expect(tool.description).toContain(
      "**Don't peek.** When running a fork in the background",
    );
    expect(tool.description).toContain(
      "**Don't race.** After launching a background fork",
    );
    expect(tool.description).not.toContain('## When not to use');
  });

  it('should hide fork guidance when the caller allowlist excludes fork', () => {
    vi.stubEnv(ENV_FORK_SUBAGENT, '1');
    const tool = new AgentTool(mockRegistry, mockContext);

    tool.setAllowedAgentTypes(new Set(['MockAgent']));

    expect(tool.description).not.toContain('`"fork"` forks yourself');
    expect(tool.description).not.toContain('## When to fork');
  });

  it('should hide fork guidance when fork is disabled by policy', () => {
    vi.stubEnv(ENV_FORK_SUBAGENT, '1');
    const tool = new AgentTool(mockRegistry, mockContext);

    tool.disableAgentType('fork');

    expect(tool.description).not.toContain('`"fork"` forks yourself');
    expect(tool.description).not.toContain('## When to fork');
  });

  it('should describe fork when it is the only allowed agent type', () => {
    vi.stubEnv(ENV_FORK_SUBAGENT, '1');
    const tool = new AgentTool(mockRegistry, mockContext);

    tool.setAllowedAgentTypes(new Set(['fork']));

    expect(tool.description).toContain('`"fork"` forks yourself');
    expect(tool.description).toContain('## When to fork');
    expect(tool.description).not.toContain('Available agent types:');
    expect(tool.description).not.toContain('- MockAgent:');
  });

  it('should hide background agent controls when agent sessions are disabled', () => {
    vi.stubEnv(ENV_ENABLE_AGENT_SESSIONS, '0');
    const tool = new AgentTool(mockRegistry, mockContext);
    const schema = tool.schema.parametersJsonSchema as {
      properties?: Record<string, unknown>;
    };

    expect(schema.properties).not.toHaveProperty('run_in_background');
    expect(schema.properties).not.toHaveProperty('name');
    expect(tool.description).not.toContain(
      'optionally run agents in the background',
    );
    expect(tool.description).toContain(
      `Agent sessions are disabled by ${ENV_ENABLE_AGENT_SESSIONS}=0`,
    );
  });

  it.each([
    { lean: false, fork: false },
    { lean: false, fork: true },
    { lean: true, fork: false },
    { lean: true, fork: true },
  ])(
    '不暴露或描述调用级 model 参数（lean=$lean, fork=$fork）',
    ({ lean, fork }) => {
      vi.stubEnv(SIMPLE_SYSTEM_PROMPT_ENV, lean ? '1' : '0');
      vi.stubEnv(ENV_FORK_SUBAGENT, fork ? '1' : '0');
      const tool = new AgentTool(mockRegistry, mockContext);
      const schema = tool.getSchema();
      const parameters = schema.parametersJsonSchema as {
        properties?: Record<string, unknown>;
      };

      expect(parameters.properties).not.toHaveProperty('model');
      expect(schema.description).not.toContain('`model`');
    },
  );

  it('should preserve ordinary agent naming when agent teams are disabled', () => {
    const disabledTool = new AgentTool(mockRegistry, mockContext);
    const disabledSchema = disabledTool.schema.parametersJsonSchema as {
      properties?: Record<string, { description?: string }>;
    };
    expect(disabledSchema.properties).toHaveProperty('name');
    expect(disabledSchema.properties?.['name']?.description).toContain(
      'stable runtime name',
    );
    expect(disabledTool.description).not.toContain('create a teammate');

    vi.stubEnv(ENV_AGENT_TEAMS, '1');
    const enabledTool = new AgentTool(mockRegistry, mockContext);
    const enabledSchema = enabledTool.schema.parametersJsonSchema as {
      properties?: Record<string, { description?: string }>;
    };
    expect(enabledSchema.properties).toHaveProperty('name');
    expect(enabledSchema.properties?.['name']?.description).toContain(
      'session team',
    );
    expect(enabledTool.description).toContain('create a teammate');
  });

  it('should not advertise background or teammate creation from teammate context', () => {
    vi.stubEnv(ENV_AGENT_TEAMS, '1');
    const tool = new AgentTool(mockRegistry, mockContext);

    tool.setTeammateContext();

    expect(tool.description).toContain(
      'parameters are unavailable in this context',
    );
    expect(tool.description).not.toContain(
      'You can optionally run agents in the background',
    );
    expect(tool.description).not.toContain('To create a teammate');
  });

  it('should hide the internal working directory override', () => {
    const tool = new AgentTool(mockRegistry, mockContext);
    const schema = tool.schema.parametersJsonSchema as {
      properties?: Record<string, unknown>;
    };

    expect(schema.properties).not.toHaveProperty('cwd');
    expect(schema.properties).toHaveProperty('isolation');
  });

  it('should be read-only (delegates permission checks to underlying tools)', () => {
    const tool = new AgentTool(mockRegistry, mockContext);
    expect(tool.isReadOnly).toBe(true);
  });

  it('should be concurrency-safe (multiple subagents can run in parallel)', () => {
    const tool = new AgentTool(mockRegistry, mockContext);
    expect(tool.isConcurrencySafe()).toBe(true);
  });

  // ─── Disabled agent types ───

  it('should track disabled agent types', () => {
    const tool = new AgentTool(mockRegistry, mockContext);
    expect(tool.disabledAgentTypes.has('MockAgent')).toBe(false);

    tool.disableAgentType('MockAgent');
    expect(tool.disabledAgentTypes.has('MockAgent')).toBe(true);
  });

  it('should isolate mutable deny state when cloned into a child registry', () => {
    const parent = new AgentTool(mockRegistry, mockContext);
    const child = parent.clone();

    child.disableAgentType('MockAgent');

    expect(child.disabledAgentTypes.has('MockAgent')).toBe(true);
    expect(parent.disabledAgentTypes.has('MockAgent')).toBe(false);
  });

  it('should throw when invoking a disabled agent type', () => {
    const tool = new AgentTool(mockRegistry, mockContext);
    tool.disableAgentType('MockAgent');

    const params = {
      description: 'test',
      prompt: 'test query',
      subagent_type: 'MockAgent',
    };
    expect(() => {
      // @ts-expect-error - accessing protected method for testing
      tool.createInvocation(params);
    }).toThrow("Agent type 'MockAgent' is disabled");
  });

  it('should throw when subagent_type is unknown', () => {
    const tool = new AgentTool(mockRegistry, mockContext);
    const params = {
      description: 'test',
      prompt: 'test query',
      subagent_type: 'nonexistent',
    };
    expect(() => {
      // @ts-expect-error - accessing protected method for testing
      tool.createInvocation(params);
    }).toThrow("Unknown agent type: 'nonexistent'");
  });

  it('normalizes Unicode whitespace, dash punctuation, underscores, and case', () => {
    expect(normalizeAgentTypeName('  CODE\u2003Review_Agent  ')).toBe(
      'codereviewagent',
    );
    expect(normalizeAgentTypeName('code—review-agent')).toBe('codereviewagent');
  });

  it('dispatches a uniquely normalized agent type to its canonical definition', () => {
    const definition = {
      ...testLocalDefinition,
      name: 'code-review_agent',
    };
    const tool = new AgentTool(
      createMockAgentRegistry([definition]),
      mockContext,
    );

    // @ts-expect-error - accessing protected method for routing verification
    const invocation = tool.createInvocation({
      description: 'test',
      prompt: 'review code',
      subagent_type: ' CODE—REVIEW AGENT ',
    }) as unknown as { definition: LocalAgentDefinition };

    expect(invocation.definition.name).toBe('code-review_agent');
    expect(tool.isAgentTypeAvailable('code review agent')).toBe(true);
  });

  it('rejects an ambiguous normalized agent type and requires an exact name', () => {
    const tool = new AgentTool(
      createMockAgentRegistry([
        { ...testLocalDefinition, name: 'code-review' },
        { ...testLocalDefinition, name: 'code_review' },
      ]),
      mockContext,
    );

    expect(() => {
      // @ts-expect-error - accessing protected method for testing
      tool.createInvocation({
        description: 'test',
        prompt: 'review code',
        subagent_type: 'code review',
      });
    }).toThrow(
      "Agent type 'code review' is ambiguous. Use one of: code-review, code_review",
    );
    expect(tool.isAgentTypeAvailable('code review')).toBe(false);
  });

  it('rejects Agent spawning at the default one-level nesting-depth cap', () => {
    const tool = new AgentTool(mockRegistry, {
      ...mockContext,
      agentDepth: 1,
    });

    expect(() => {
      // @ts-expect-error - accessing protected method for testing
      tool.createInvocation({
        description: 'test',
        prompt: 'spawn too deeply',
        subagent_type: 'MockAgent',
      });
    }).toThrow('Subagent nesting limit reached (depth 1 of 1)');
  });

  // Content-level `Agent(<type>)` rule enforcement (deny > ask > allow,
  // case-insensitive matching) is covered by the registered agent checker's
  // suite: tools/tool-checkers/checkers/agent-checker.test.ts.

  // ─── Invocation description ───

  it('should return a formatted description from the invocation', () => {
    const tool = new AgentTool(mockRegistry, mockContext);
    const params = {
      description: 'analyze code',
      prompt: 'test query',
      subagent_type: 'MockAgent',
    };
    // @ts-expect-error - accessing protected method for testing
    const invocation = tool.createInvocation(params);
    expect(invocation.getDescription()).toBe('analyze code');
  });

  it('should truncate the overall description if it exceeds the limit', () => {
    const tool = new AgentTool(mockRegistry, mockContext);
    const params = {
      description: 'A'.repeat(300),
      prompt: 'test query',
      subagent_type: 'MockAgent',
    };
    // @ts-expect-error - accessing protected method for testing
    const invocation = tool.createInvocation(params);
    const description = invocation.getDescription();
    expect(description.length).toBe(200);
  });

  // ─── refreshDescription ───

  it('should expose agent definitions through the separate listing', () => {
    const registry = createMockAgentRegistry([testLocalDefinition]);
    const tool = new AgentTool(registry, mockContext);
    expect(tool.getAvailableAgentListing()).toEqual([
      { name: 'MockAgent', description: 'A local agent for testing.' },
    ]);

    // Simulate adding a new definition to the registry
    const newDef: LocalAgentDefinition = {
      ...testLocalDefinition,
      name: 'NewAgent',
      description: 'A new agent.',
    };
    const updatedRegistry = createMockAgentRegistry([
      testLocalDefinition,
      newDef,
    ]);
    // Replace the internal registry reference (via a new tool for simplicity).
    const updatedTool = new AgentTool(updatedRegistry, mockContext);
    expect(updatedTool.getAvailableAgentListing()).toEqual([
      { name: 'MockAgent', description: 'A local agent for testing.' },
      { name: 'NewAgent', description: 'A new agent.' },
    ]);
    expect(updatedTool.description).toBe(tool.description);
  });

  it('should use the Lean description in the Agent listing', () => {
    vi.stubEnv(SIMPLE_SYSTEM_PROMPT_ENV, '1');
    const registry = createMockAgentRegistry([
      {
        ...testLocalDefinition,
        descriptionLean: 'Compact agent description.',
      },
    ]);
    const tool = new AgentTool(registry, mockContext);

    expect(tool.getAvailableAgentListing('lean-model')).toEqual([
      { name: 'MockAgent', description: 'Compact agent description.' },
    ]);
  });

  it('should evaluate live Agent(name) deny rules in the visible listing', () => {
    const moduleWithDenyRules = (
      deny: Record<string, string[]>,
    ): TestPermissionManager =>
      ({
        getRules: () => ({ allow: {}, deny, ask: {} }),
      }) as unknown as TestPermissionManager;

    (mockContext as { permission?: TestPermissionManager }).permission =
      moduleWithDenyRules({ userSettings: ['Agent(MockAgent)'] });
    const tool = new AgentTool(mockRegistry, mockContext);

    expect(tool.getAvailableAgentListing()).toEqual([]);
    expect(tool.isAgentTypeAvailable('MockAgent')).toBe(false);

    (mockContext as { permission?: TestPermissionManager }).permission =
      moduleWithDenyRules({});

    expect(tool.getAvailableAgentListing()).toEqual([
      { name: 'MockAgent', description: 'A local agent for testing.' },
    ]);
    expect(tool.isAgentTypeAvailable('MockAgent')).toBe(true);
  });

  // ─── Multiple agent types ───

  it('should dispatch to correct agent type based on subagent_type', () => {
    const multiRegistry = createMockAgentRegistry([
      testLocalDefinition,
      {
        ...testLocalDefinition,
        name: 'OtherAgent',
        description: 'Other agent.',
      },
    ]);
    const tool = new AgentTool(multiRegistry, mockContext);
    const params = {
      description: 'test',
      prompt: 'do something',
      subagent_type: 'OtherAgent',
    };

    // @ts-expect-error - accessing protected method for testing
    const invocation = tool.createInvocation(params);
    expect(invocation.getDescription()).toBe('test');
  });

  it('should refresh the visible agent list when an allowlist is applied', () => {
    const otherDefinition = {
      ...testLocalDefinition,
      name: 'OtherAgent',
      description: 'Other agent.',
    };
    const tool = new AgentTool(
      createMockAgentRegistry([testLocalDefinition, otherDefinition]),
      mockContext,
    );

    tool.setAllowedAgentTypes(new Set(['MockAgent']));

    expect(tool.getAvailableAgentListing()).toEqual([
      { name: 'MockAgent', description: 'A local agent for testing.' },
    ]);
    expect(tool.description).not.toContain('MockAgent');
    expect(tool.description).not.toContain('OtherAgent');
  });

  it('should hide and reject built-in Explore when the caller only exposes Agent', () => {
    const exploreDefinition: LocalAgentDefinition = {
      ...testLocalDefinition,
      name: EXPLORE_AGENT_NAME,
      metadata: { source: 'built-in' },
      checkAvailability: ExploreAgent(mockContext.config).checkAvailability,
    };
    // The caller exposes Agent only — none of Explore's search tools are enabled.
    vi.mocked(mockContext.toolRegistry.hasToolEnabled).mockImplementation(
      (name: string) => name === 'Agent',
    );
    const tool = new AgentTool(
      createMockAgentRegistry([exploreDefinition]),
      mockContext,
    );

    expect(tool.getAvailableAgentListing()).toEqual([]);
    expect(() => {
      // @ts-expect-error - accessing protected method for testing
      tool.createInvocation({
        description: 'search code',
        prompt: 'find the definition',
        subagent_type: EXPLORE_AGENT_NAME,
      });
    }).toThrow(
      "Agent type 'Explore' is unavailable because no usable exploration tools are available to it.",
    );
  });

  it('should default to a fresh general-purpose agent when fork is enabled', () => {
    vi.stubEnv(ENV_FORK_SUBAGENT, '1');
    const generalPurpose = {
      ...testLocalDefinition,
      name: 'general-purpose',
    };
    const tool = new AgentTool(
      createMockAgentRegistry([generalPurpose]),
      mockContext,
    );

    // @ts-expect-error - accessing protected method for routing verification
    const invocation = tool.createInvocation({
      description: 'test',
      prompt: 'do something',
    }) as unknown as {
      definition: LocalAgentDefinition;
      isForkPath: boolean;
    };

    expect(invocation.definition.name).toBe('general-purpose');
    expect(invocation.isForkPath).toBe(false);
  });

  it('should fork only when subagent_type is explicitly fork', () => {
    vi.stubEnv(ENV_FORK_SUBAGENT, '1');
    const tool = new AgentTool(mockRegistry, mockContext);

    // @ts-expect-error - accessing protected method for routing verification
    const invocation = tool.createInvocation({
      description: 'test',
      prompt: 'do something',
      subagent_type: 'fork',
    }) as unknown as {
      definition: LocalAgentDefinition;
      isForkPath: boolean;
    };

    expect(invocation.definition.name).toBe('fork');
    expect(invocation.isForkPath).toBe(true);
    expect(invocation.definition.pinToParentModel).toBe(true);
  });

  it('should reject a recursive fork through the retained AgentTool', () => {
    vi.stubEnv(ENV_FORK_SUBAGENT, '1');
    const tool = new AgentTool(mockRegistry, mockContext);
    tool.setQuerySource(FORK_QUERY_SOURCE);

    expect(() =>
      tool.build({
        description: 'test',
        prompt: 'fork again',
        subagent_type: 'fork',
      }),
    ).toThrow(
      'Fork is not available inside a forked worker. Execute your task directly using tools.',
    );

    expect(() =>
      tool.build({
        description: 'test',
        prompt: 'start a fresh specialist',
        subagent_type: 'MockAgent',
      }),
    ).not.toThrow();
  });

  it('should enforce Agent(name) allowlists for explicit forks', () => {
    vi.stubEnv(ENV_FORK_SUBAGENT, '1');
    const tool = new AgentTool(mockRegistry, mockContext);
    tool.setAllowedAgentTypes(new Set(['MockAgent']));

    expect(() =>
      tool.build({
        description: 'test',
        prompt: 'do something',
        subagent_type: 'fork',
      }),
    ).toThrow("Agent type 'fork' is not allowed");
  });
});

// ---------------------------------------------------------------------------
// Local agent execution
// ---------------------------------------------------------------------------

describe('AgentInvocation — local execution', () => {
  let mockConfig: Config;
  let mockContext: AgentLoopContext;
  let mockRegistry: AgentRegistry;
  let signal: AbortSignal;
  let updateOutput: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    ExecutionLifecycleService.resetForTest();
    _resetQueueForTest();
    await _clearOutputsForTest();
    _resetTaskOutputDirForTest();
    setTaskOutputDir(
      path.join(
        os.tmpdir(),
        `subagent-tool-tests-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      ),
    );
    mockConfig = setupMockConfig();
    mockContext = mockConfig as AgentLoopContext;
    mockRegistry = createMockAgentRegistry([testLocalDefinition]);
    signal = new AbortController().signal;
    updateOutput = vi.fn();
    mockRunSubagent.mockResolvedValue(defaultForkedAgentResult());
  });

  function createLocalInvocation(
    params: {
      description?: string;
      prompt: string;
      subagent_type?: string;
      mode?: 'acceptEdits' | 'plan' | 'yolo';
      run_in_background?: boolean;
      name?: string;
      team_name?: string;
      teammateContext?: boolean;
    } = {
      prompt: 'Execute task',
    },
  ) {
    const fullParams = {
      description: params.description ?? 'test task',
      prompt: params.prompt,
      subagent_type: params.subagent_type ?? 'MockAgent',
      mode: params.mode,
      run_in_background: params.run_in_background,
      name: params.name,
      team_name: params.team_name,
    };
    const tool = new AgentTool(mockRegistry, mockContext);
    if (params.teammateContext) {
      tool.setTeammateContext();
    }
    // @ts-expect-error - accessing protected method for testing
    return tool.createInvocation(fullParams);
  }

  it('should run successfully and return result', async () => {
    const invocation = createLocalInvocation();
    const result = await invocation.execute(signal, updateOutput);

    expect(mockRunSubagent).toHaveBeenCalledWith(
      expect.objectContaining({
        definition: expect.objectContaining({ name: 'MockAgent' }),
        systemPrompt: 'test system prompt',
      }),
    );
    expect(updateOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        isSubagentProgress: true,
        agentName: 'MockAgent',
      }),
    );
    expect(result.llmContent).toEqual([
      {
        text: 'Agent execution completed.',
      },
    ]);
    expect(result.toolUseResult).toEqual(
      expect.objectContaining({
        kind: 'agent-result',
        agentId: expect.any(String),
        agentType: 'MockAgent',
        content: 'Agent execution completed.',
        state: 'completed',
      }),
    );
    expect(result.toolUseResult).not.toHaveProperty('recentActivity');
    const display = result.returnDisplay as SubagentProgress;
    expect(display.isSubagentProgress).toBe(true);
    expect(display.state).toBe('completed');
  });

  it('should execute with the caller AgentLoopContext supplied by the scheduler', async () => {
    const invocation = createLocalInvocation();
    const childContext = {
      ...mockContext,
      config: mockContext.config,
      agentId: 'child-agent',
      toolRegistry: {
        getTool: vi.fn(),
        hasToolEnabled: vi.fn(() => false),
      } as unknown as ToolRegistry,
    } as AgentLoopContext;

    await invocation.executeWithContext!({
      signal,
      updateOutput,
      agentLoopContext: childContext,
    });

    expect(mockRunSubagent).toHaveBeenCalledWith(
      expect.objectContaining({ context: childContext }),
    );
  });

  it('should inherit the model of the parent request supplied by the scheduler', async () => {
    const inheritingDefinition: LocalAgentDefinition = {
      ...testLocalDefinition,
      modelConfig: {
        ...testLocalDefinition.modelConfig,
        model: 'inherit',
      },
    };
    mockRegistry = createMockAgentRegistry([inheritingDefinition]);
    vi.spyOn(mockConfig, 'getModel').mockReturnValue('ultimate');
    vi.spyOn(mockConfig, 'getActiveModel').mockReturnValue('ultimate');
    const { TaskRegistry } = await import('../tasks/task-registry.js');
    const taskRegistry = new TaskRegistry();
    (mockContext as { taskRegistry?: unknown }).taskRegistry = taskRegistry;
    const tool = new AgentTool(mockRegistry, mockContext);
    // @ts-expect-error - accessing protected method for testing
    const invocation = tool.createInvocation({
      description: 'test task',
      prompt: 'Execute task',
      subagent_type: 'MockAgent',
    });

    try {
      await invocation.executeWithContext!({
        signal,
        updateOutput,
        agentLoopContext: mockContext,
        modelKey: 'auto',
      });

      expect(mockRunSubagent).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'auto' }),
      );
      expect(taskRegistry.all()).toEqual([
        expect.objectContaining({ resolvedModel: 'auto' }),
      ]);
    } finally {
      (mockContext as { taskRegistry?: unknown }).taskRegistry = undefined;
      taskRegistry.clear();
    }
  });

  describe('teammate caller guard', () => {
    it('rejects a named spawn from a teammate registry', async () => {
      const invocation = createLocalInvocation({
        prompt: 'Execute task',
        name: 'worker-2',
        teammateContext: true,
      });

      await expect(invocation.execute(signal, updateOutput)).rejects.toThrow(
        'Teammates cannot spawn other teammates',
      );
      expect(mockRunSubagent).not.toHaveBeenCalled();
    });

    it('rejects a background spawn from a teammate registry', async () => {
      const invocation = createLocalInvocation({
        prompt: 'Execute task',
        run_in_background: true,
        teammateContext: true,
      });

      await expect(invocation.execute(signal, updateOutput)).rejects.toThrow(
        'In-process teammates cannot spawn background agents',
      );
      expect(mockRunSubagent).not.toHaveBeenCalled();
    });

    it('allows the main registry to launch a background agent despite leaked ambient teammate context', async () => {
      vi.mocked(getAgentContext).mockReturnValue({
        agentId: 'agent-worker-1',
        agentType: 'MockAgent',
        agentName: 'worker-1',
        teamName: 'team-1',
      });

      try {
        const invocation = createLocalInvocation({
          prompt: 'Execute task',
          description: 'background task',
          run_in_background: true,
        });
        const result = await invocation.execute(signal, updateOutput);

        expect(result.error).toBeUndefined();
        expect(result.llmContent).toContain('working in the background');
        await vi.waitFor(() => {
          expect(getCommandQueueSnapshot()).toHaveLength(1);
        });
      } finally {
        vi.mocked(getAgentContext).mockReturnValue(undefined);
      }
    });
  });

  it('should run successfully without an updateOutput callback', async () => {
    const invocation = createLocalInvocation();
    const result = await invocation.execute(signal);
    expect(result.error).toBeUndefined();
    const display = result.returnDisplay as SubagentProgress;
    expect(display.isSubagentProgress).toBe(true);
    expect(display.state).toBe('completed');
  });

  it('applies the invocation permission mode override', async () => {
    const invocation = createLocalInvocation({
      prompt: 'Execute task',
      mode: 'yolo',
    });

    await invocation.execute(signal, updateOutput);

    expect(mockRunSubagent).toHaveBeenCalledWith(
      expect.objectContaining({
        definition: expect.objectContaining({
          name: 'MockAgent',
          permissionMode: 'yolo',
        }),
        model: 'test-model',
      }),
    );
    expect(testLocalDefinition.permissionMode).toBeUndefined();
  });

  it('should launch in background when run_in_background is requested', async () => {
    const invocation = createLocalInvocation({
      prompt: 'Execute task',
      description: 'background task',
      subagent_type: 'MockAgent',
      run_in_background: true,
    });

    const customContext = Object.freeze({ tenant: 'alpha' });
    const result = await runWithToolCallContext(
      {
        callId: 'toolu-background-agent',
        toolCallScopeId: 'test-scheduler',
      },
      () =>
        invocation.executeWithContext!({
          signal,
          updateOutput,
          customContext,
          options: { setExecutionIdCallback: vi.fn() },
        }),
    );

    expect(result.llmContent).toContain('working in the background');
    expect(result.llmContent).toContain('Do not duplicate');
    expect(result.llmContent).toContain('Do NOT read or tail');
    expect(result.llmContent).toContain('notified automatically');
    expect(result.returnDisplay).toEqual({
      isAsync: true,
      status: 'async_launched',
      agentId: expect.any(String),
      description: 'background task',
      resolvedModel: 'test-model',
      prompt: 'Execute task',
      outputFile: expect.any(String),
      canReadOutputFile: true,
    });
    expect(result.toolUseResult).toEqual(result.returnDisplay);
    const launchResult =
      result.returnDisplay as AgentToolBackgroundLaunchResult;
    const taskStarted = drainSubagentSdkEvents(
      mockConfig.getSessionId(),
      (event) => event.type === 'system' && event.subtype === 'task_started',
    );
    expect(taskStarted).toEqual([
      expect.objectContaining({
        task_id: expect.any(String),
        tool_use_id: 'toolu-background-agent',
        description: 'background task',
        task_type: 'local_agent',
        subagent_type: 'MockAgent',
        prompt: 'Execute task',
      }),
    ]);
    // Drain the completion notification so the next test starts clean.
    await vi.waitFor(() => {
      expect(getCommandQueueSnapshot()).toHaveLength(1);
    });
    const queuedPrompt = getCommandQueueSnapshot()[0]?.prompt;
    expect(queuedPrompt).toBeTypeOf('string');
    const notification = parseTaskNotificationXml(
      typeof queuedPrompt === 'string' ? queuedPrompt : '',
    );
    expect(notification).toMatchObject({
      taskId: expect.any(String),
      toolUseId: 'toolu-background-agent',
      outputFile: launchResult.outputFile,
      status: 'completed',
    });
    expect(getCommandQueueSnapshot()[0]?.customContext).toEqual(customContext);
  });

  it('should launch in background when the agent definition forces it', async () => {
    const backgroundDefinition: LocalAgentDefinition = {
      ...testLocalDefinition,
      background: true,
    };
    const registry = createMockAgentRegistry([backgroundDefinition]);
    const tool = new AgentTool(registry, mockContext);
    // @ts-expect-error - accessing protected method for testing
    const invocation = tool.createInvocation({
      description: 'forced background task',
      prompt: 'Execute task',
      subagent_type: 'MockAgent',
    });

    const result = await invocation.execute(signal, updateOutput);

    expect(result.llmContent).toContain('working in the background');
    expect(result.llmContent).toContain('Do not duplicate');
    expect(result.llmContent).toContain('Do NOT read or tail');
    expect(result.llmContent).toContain('notified automatically');
    expect(result.returnDisplay).toEqual({
      isAsync: true,
      status: 'async_launched',
      agentId: expect.any(String),
      description: 'forced background task',
      resolvedModel: 'test-model',
      prompt: 'Execute task',
      outputFile: expect.any(String),
      canReadOutputFile: true,
    });
    // Drain the completion notification so the next test starts clean.
    await vi.waitFor(() => {
      expect(getCommandQueueSnapshot()).toHaveLength(1);
    });
  });

  it('should force an explicit background request to run synchronously when agent sessions are disabled', async () => {
    vi.stubEnv(ENV_ENABLE_AGENT_SESSIONS, '0');
    const setExecutionIdCallback = vi.fn();
    const invocation = createLocalInvocation({
      prompt: 'Execute task',
      description: 'forced foreground task',
      subagent_type: 'MockAgent',
      run_in_background: true,
    });

    const result = await invocation.execute(signal, updateOutput, {
      setExecutionIdCallback,
    });

    expect(result.llmContent).not.toContain('working in the background');
    expect(result.returnDisplay).toEqual(
      expect.objectContaining({
        isSubagentProgress: true,
        state: 'completed',
      }),
    );
    expect(getCommandQueueSnapshot()).toHaveLength(0);
    expect(setExecutionIdCallback).not.toHaveBeenCalled();
  });

  it('should force a definition-level background agent to run synchronously when agent sessions are disabled', async () => {
    vi.stubEnv(ENV_ENABLE_AGENT_SESSIONS, '0');
    const backgroundDefinition: LocalAgentDefinition = {
      ...testLocalDefinition,
      background: true,
    };
    const registry = createMockAgentRegistry([backgroundDefinition]);
    const tool = new AgentTool(registry, mockContext);
    // @ts-expect-error - accessing protected method for testing
    const invocation = tool.createInvocation({
      description: 'forced foreground definition',
      prompt: 'Execute task',
      subagent_type: 'MockAgent',
    });

    const result = await invocation.execute(signal, updateOutput);

    expect(result.llmContent).not.toContain('working in the background');
    expect(result.returnDisplay).toEqual(
      expect.objectContaining({
        isSubagentProgress: true,
        state: 'completed',
      }),
    );
    expect(getCommandQueueSnapshot()).toHaveLength(0);
  });

  it('should detach to background when execution is backgrounded mid-run', async () => {
    let resolveRun:
      | ((value: ReturnType<typeof defaultForkedAgentResult>) => void)
      | undefined;
    mockRunSubagent.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRun = resolve;
        }),
    );

    const setExecutionIdCallback = vi.fn();
    const invocation = createLocalInvocation();
    const resultPromise = invocation.execute(signal, updateOutput, {
      setExecutionIdCallback,
    });

    await vi.waitFor(() => {
      expect(setExecutionIdCallback).toHaveBeenCalledTimes(1);
    });

    const executionId = setExecutionIdCallback.mock.calls[0]?.[0] as number;
    ExecutionLifecycleService.background(executionId);

    const result = await resultPromise;
    expect(result.llmContent).toContain('working in the background');
    await vi.waitFor(() => {
      expect(resolveRun).toBeTypeOf('function');
    });
    resolveRun?.(defaultForkedAgentResult());

    await vi.waitFor(() => {
      const queue = getCommandQueueSnapshot();
      expect(queue).toHaveLength(1);
      expect(queue[0]?.prompt).toContain('<task-notification>');
      expect(queue[0]?.prompt).toContain('Agent "test task" finished');
    });
  });

  it('should explain how to continue when a background agent reaches maxTurns', async () => {
    const backgroundDefinition: LocalAgentDefinition = {
      ...testLocalDefinition,
      background: true,
    };
    const registry = createMockAgentRegistry([backgroundDefinition]);
    const tool = new AgentTool(registry, mockContext);
    mockRunSubagent.mockResolvedValue({
      ...defaultForkedAgentResult(),
      terminal: {
        reason: 'max_turns',
        numTurns: 150,
        usage: { input_tokens: 10, output_tokens: 20 },
        durationMs: 10,
      } as import('../core/query-event.js').Terminal,
    });
    // @ts-expect-error - accessing protected method for testing
    const invocation = tool.createInvocation({
      description: 'long-running task',
      prompt: 'Execute task',
      subagent_type: 'MockAgent',
    });

    await invocation.execute(signal, updateOutput);

    await vi.waitFor(() => {
      const queue = getCommandQueueSnapshot();
      expect(queue).toHaveLength(1);
      expect(queue[0]?.prompt).toContain('maximum turn limit (150)');
      expect(queue[0]?.prompt).toContain('Increase maxTurns');
    });
  });

  it('should handle runSubagent failure', async () => {
    const error = new Error('Model failed during execution.');
    mockRunSubagent.mockRejectedValue(error);

    const invocation = createLocalInvocation();
    const result = await invocation.execute(signal, updateOutput);

    expect(result.error).toBeUndefined();
    expect(result.llmContent).toBe(
      `Agent 'MockAgent' failed. Error: ${error.message}`,
    );
    const display = result.returnDisplay as SubagentProgress;
    expect(display.isSubagentProgress).toBe(true);
    expect(display.recentActivity).toContainEqual(
      expect.objectContaining({
        type: 'thought',
        content: `Error: ${error.message}`,
        status: 'error',
      }),
    );
    expect(result.toolUseResult).toEqual({
      kind: 'agent-result',
      agentType: 'MockAgent',
      content: `Agent 'MockAgent' failed. Error: ${error.message}`,
      state: 'error',
    });
    expect(result.toolUseResult).not.toHaveProperty('recentActivity');
  });

  it('should include final failure output in background completion', async () => {
    const error = new Error('Model failed during execution.');
    mockRunSubagent.mockRejectedValue(error);
    let resolveCompletion!: (output: string) => void;
    const completion = new Promise<string>((resolve) => {
      resolveCompletion = resolve;
    });
    const listener = (info: { output: string }) =>
      resolveCompletion(info.output);
    ExecutionLifecycleService.onBackgroundComplete(listener);
    const invocation = createLocalInvocation({
      prompt: 'Execute task',
      description: 'background task',
      subagent_type: 'MockAgent',
      run_in_background: true,
    });

    try {
      await invocation.execute(signal, updateOutput, {
        setExecutionIdCallback: vi.fn(),
      });
      await expect(completion).resolves.toContain(
        `Agent 'MockAgent' failed: ${error.message}\n`,
      );
    } finally {
      ExecutionLifecycleService.offBackgroundComplete(listener);
    }
  });

  it('should handle abort signal during execution', async () => {
    const abortError = new Error('Aborted');
    abortError.name = 'AbortError';
    mockRunSubagent.mockRejectedValue(abortError);

    const invocation = createLocalInvocation();
    await expect(invocation.execute(signal, updateOutput)).rejects.toThrow(
      'Operation cancelled by user',
    );
  });

  // ─── TaskRegistry lifecycle ───

  describe('TaskRegistry lifecycle', () => {
    let registry: import('../tasks/task-registry.js').TaskRegistry;

    beforeEach(async () => {
      const { TaskRegistry } = await import('../tasks/task-registry.js');
      registry = new TaskRegistry();
      (mockContext as { taskRegistry?: unknown }).taskRegistry = registry;
    });

    afterEach(() => {
      (mockContext as { taskRegistry?: unknown }).taskRegistry = undefined;
      registry.clear();
    });

    it('should update registry to completed when foreground agent succeeds', async () => {
      const invocation = createLocalInvocation();
      await invocation.execute(signal, updateOutput);

      const tasks = registry.all();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].status).toBe('completed');
      expect(tasks[0].type).toBe('local_agent');
      expect(tasks[0].notified).toBe(true);
    });

    it('holds a concurrency slot until the underlying Agent run settles', async () => {
      vi.stubEnv(ENV_MAX_CONCURRENT_SUBAGENTS, '1');
      const firstRun = deferredAgentRun();
      mockRunSubagent
        .mockImplementationOnce(() => firstRun.promise)
        .mockResolvedValue(defaultForkedAgentResult());

      const firstExecution = createLocalInvocation({
        prompt: 'first task',
      }).execute(signal, updateOutput);
      await vi.waitFor(() => {
        expect(registry.getConcurrentAgentSlotCount()).toBe(1);
        expect(mockRunSubagent).toHaveBeenCalledTimes(1);
      });

      await expect(
        createLocalInvocation({ prompt: 'second task' }).execute(
          signal,
          updateOutput,
        ),
      ).rejects.toThrow('Concurrent subagent limit reached');

      firstRun.settle();
      await firstExecution;
      expect(registry.getConcurrentAgentSlotCount()).toBe(0);
    });

    it('waits for a concurrency slot while UltraCode is active', async () => {
      vi.stubEnv(ENV_MAX_CONCURRENT_SUBAGENTS, '1');
      vi.spyOn(mockConfig, 'isUltracodeActive').mockReturnValue(true);
      const firstRun = deferredAgentRun();
      mockRunSubagent
        .mockImplementationOnce(() => firstRun.promise)
        .mockResolvedValue(defaultForkedAgentResult());

      const firstExecution = createLocalInvocation({
        prompt: 'first task',
      }).execute(signal, updateOutput);
      await vi.waitFor(() => {
        expect(registry.getConcurrentAgentSlotCount()).toBe(1);
        expect(mockRunSubagent).toHaveBeenCalledTimes(1);
      });

      const secondExecution = createLocalInvocation({
        prompt: 'second task',
      }).execute(signal, updateOutput);
      await Promise.resolve();
      expect(mockRunSubagent).toHaveBeenCalledTimes(1);

      firstRun.settle();
      await firstExecution;
      await secondExecution;

      expect(mockRunSubagent).toHaveBeenCalledTimes(2);
      expect(registry.getConcurrentAgentSlotCount()).toBe(0);
    });

    it('cancels an UltraCode Agent while it waits for a concurrency slot', async () => {
      vi.stubEnv(ENV_MAX_CONCURRENT_SUBAGENTS, '1');
      vi.spyOn(mockConfig, 'isUltracodeActive').mockReturnValue(true);
      const firstRun = deferredAgentRun();
      mockRunSubagent.mockImplementationOnce(() => firstRun.promise);

      const firstExecution = createLocalInvocation({
        prompt: 'first task',
      }).execute(signal, updateOutput);
      await vi.waitFor(() => {
        expect(registry.getConcurrentAgentSlotCount()).toBe(1);
        expect(mockRunSubagent).toHaveBeenCalledTimes(1);
      });

      const controller = new AbortController();
      const waitingExecution = createLocalInvocation({
        prompt: 'cancelled task',
      }).execute(controller.signal, updateOutput);
      controller.abort(new DOMException('cancelled', 'AbortError'));

      await expect(waitingExecution).rejects.toMatchObject({
        name: 'AbortError',
      });
      expect(mockRunSubagent).toHaveBeenCalledTimes(1);

      firstRun.settle();
      await firstExecution;
      expect(registry.getConcurrentAgentSlotCount()).toBe(0);
    });

    it('keeps the slot after a background launch until the detached run settles', async () => {
      vi.stubEnv(ENV_MAX_CONCURRENT_SUBAGENTS, '1');
      const backgroundRun = deferredAgentRun();
      mockRunSubagent
        .mockImplementationOnce(() => backgroundRun.promise)
        .mockResolvedValue(defaultForkedAgentResult());

      await createLocalInvocation({
        prompt: 'background task',
        run_in_background: true,
      }).execute(signal, updateOutput, {
        setExecutionIdCallback: vi.fn(),
      });

      expect(registry.getConcurrentAgentSlotCount()).toBe(1);
      await expect(
        createLocalInvocation({ prompt: 'blocked task' }).execute(
          signal,
          updateOutput,
        ),
      ).rejects.toThrow('Concurrent subagent limit reached');

      backgroundRun.settle();
      await vi.waitFor(() => {
        expect(registry.getConcurrentAgentSlotCount()).toBe(0);
      });
    });

    it('releases the slot when teammate session setup fails before launch', async () => {
      vi.stubEnv(ENV_AGENT_TEAMS, '1');
      vi.spyOn(mockConfig, 'waitForAgentTeamSession').mockRejectedValue(
        new Error('team setup failed'),
      );

      await expect(
        createLocalInvocation({
          prompt: 'teammate task',
          name: 'worker',
        }).execute(signal, updateOutput),
      ).rejects.toThrow('team setup failed');

      expect(registry.getConcurrentAgentSlotCount()).toBe(0);
    });

    it('should update registry to failed when foreground agent fails', async () => {
      mockRunSubagent.mockResolvedValue({
        ...defaultForkedAgentResult(),
        terminal: {
          reason: 'error',
          numTurns: 1,
          usage: { input_tokens: 0, output_tokens: 0 },
          durationMs: 0,
        } as import('../core/query-event.js').Terminal,
      });
      const invocation = createLocalInvocation();
      await invocation.execute(signal, updateOutput);

      const tasks = registry.all();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].status).toBe('failed');
      expect(tasks[0].notified).toBe(true);
    });

    it('should update registry to failed when foreground agent throws', async () => {
      mockRunSubagent.mockRejectedValue(new Error('agent crashed'));

      const invocation = createLocalInvocation();
      const result = await invocation.execute(signal, updateOutput);

      expect(result.llmContent).toContain('failed');
      const tasks = registry.all();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].status).toBe('failed');
      expect(tasks[0].notified).toBe(true);
    });

    it('should register agent with isBackgrounded=true for background agents', async () => {
      const invocation = createLocalInvocation({
        prompt: 'bg task',
        description: 'bg desc',
        subagent_type: 'MockAgent',
        run_in_background: true,
      });

      await invocation.execute(signal, updateOutput, {
        setExecutionIdCallback: vi.fn(),
      });

      const tasks = registry.all();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].type).toBe('local_agent');
      expect('isBackgrounded' in tasks[0] && tasks[0].isBackgrounded).toBe(
        true,
      );

      await vi.waitFor(() => {
        expect(getCommandQueueSnapshot()).toHaveLength(1);
      });
      expect(registry.all()[0].notified).toBe(true);
    });

    it('should not register agent tasks when agent sessions are disabled', async () => {
      vi.stubEnv(ENV_ENABLE_AGENT_SESSIONS, '0');
      const invocation = createLocalInvocation({
        prompt: 'bg task',
        description: 'bg desc',
        subagent_type: 'MockAgent',
        run_in_background: true,
      });

      await invocation.execute(signal, updateOutput, {
        setExecutionIdCallback: vi.fn(),
      });

      expect(registry.all()).toHaveLength(0);
    });

    it('preserves a custom runtime name for an ordinary background agent', async () => {
      const invocation = createLocalInvocation({
        prompt: 'bg task',
        description: 'bg desc',
        subagent_type: 'MockAgent',
        run_in_background: true,
        name: 'review-worker',
      });

      const result = await invocation.execute(signal, updateOutput, {
        setExecutionIdCallback: vi.fn(),
      });

      expect(result.toolUseResult).toMatchObject({
        isAsync: true,
        agentId: expect.any(String),
      });
      expect(result.toolUseResult).not.toHaveProperty(
        'status',
        'teammate_spawned',
      );
      expect(registry.all()[0]).toMatchObject({
        type: 'local_agent',
        agentName: 'review-worker',
      });
      await vi.waitFor(() => {
        expect(registry.all()[0]?.notified).toBe(true);
      });
      _resetQueueForTest();
    });

    it('keeps a named teammate running while idle and settles it before session cleanup', async () => {
      vi.stubEnv(ENV_AGENT_TEAMS, '1');
      const tempConfigDir = path.join(
        os.tmpdir(),
        `agent-team-loop-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      );
      vi.stubEnv(ENV_CONFIG_DIR, tempConfigDir);
      _resetConfigHomeDirCache();
      await mockConfig.initializeAgentTeamSession();
      let teammateCycle = 0;
      mockRunSubagent.mockImplementation(async (params) => {
        teammateCycle += 1;
        const userUuid = `teammate-user-${teammateCycle}`;
        const assistantUuid = `teammate-assistant-${teammateCycle}`;
        const messages = [
          {
            type: 'user' as const,
            uuid: userUuid,
            timestamp: `2026-08-03T00:00:0${teammateCycle}.000Z`,
            message: {
              role: 'user' as const,
              content:
                teammateCycle === 1
                  ? 'Review the API.'
                  : 'Check the tests too.',
            },
          },
          {
            type: 'assistant' as const,
            uuid: assistantUuid,
            timestamp: `2026-08-03T00:00:0${teammateCycle}.500Z`,
            message: {
              id: `message-${teammateCycle}`,
              type: 'message' as const,
              role: 'assistant' as const,
              model: 'test-model',
              stop_reason: 'tool_use' as const,
              stop_sequence: null,
              container: null,
              context_management: null,
              content:
                teammateCycle === 1
                  ? [
                      {
                        type: 'tool_use' as const,
                        id: 'tool-send-message',
                        name: 'SendMessage',
                        input: {
                          to: 'main',
                          summary: 'Sending review result',
                          message: 'Review complete.',
                        },
                      },
                    ]
                  : [
                      {
                        type: 'text' as const,
                        text: 'Tests checked.',
                      },
                    ],
            },
          },
        ];
        const toolResultMessage = {
          type: 'user' as const,
          uuid: 'teammate-tool-result-1',
          timestamp: '2026-08-03T00:00:01.600Z',
          message: {
            role: 'user' as const,
            content: [
              {
                type: 'tool_result' as const,
                tool_use_id: 'tool-send-message',
                content: 'Message delivered.',
                is_error: false,
              },
            ],
          },
        };
        const persistedMessages =
          teammateCycle === 1 ? [...messages, toolResultMessage] : messages;
        let transcriptLeafUuid = params.resumeLeafUuid ?? null;
        for (const message of persistedMessages) {
          transcriptLeafUuid =
            (await params.transcriptWriter?.recordSidechainMessages(
              [message],
              params.agentId,
              transcriptLeafUuid,
            )) ?? transcriptLeafUuid;
        }
        return {
          ...defaultForkedAgentResult(),
          messages:
            teammateCycle === 1
              ? [
                  messages[0],
                  {
                    type: 'user' as const,
                    uuid: 'event-only-user-1',
                    timestamp: '2026-08-03T00:00:01.250Z',
                    message: {
                      role: 'user' as const,
                      content: 'This event was not persisted.',
                    },
                  },
                  messages[1],
                  toolResultMessage,
                ]
              : messages,
          ...(transcriptLeafUuid ? { transcriptLeafUuid } : {}),
        };
      });
      const invocation = createLocalInvocation({
        prompt: 'Review the API.',
        description: 'review API',
        subagent_type: 'MockAgent',
        name: 'reviewer',
        team_name: 'ignored-explicit-team',
      });

      try {
        const result = await runWithToolCallContext(
          {
            callId: 'toolu-teammate-reviewer',
            toolCallScopeId: 'test-scheduler',
          },
          () =>
            invocation.execute(signal, updateOutput, {
              setExecutionIdCallback: vi.fn(),
            }),
        );
        expect(result.toolUseResult).toMatchObject({
          status: 'teammate_spawned',
          name: 'reviewer',
          color: 'red',
          tmux_session_name: 'in-process',
          tmux_window_name: 'in-process',
          tmux_pane_id: 'in-process',
          team_name: deriveSessionTeamName(mockConfig.getSessionId()),
          teammate_id: `reviewer@${deriveSessionTeamName(mockConfig.getSessionId())}`,
          agent_id: `reviewer@${deriveSessionTeamName(mockConfig.getSessionId())}`,
          is_splitpane: false,
          plan_mode_required: false,
        });

        const started = drainSubagentSdkEvents(
          mockConfig.getSessionId(),
          (event) =>
            event.type === 'system' && event.subtype === 'task_started',
        );
        expect(started).toEqual([
          expect.objectContaining({
            task_type: 'in_process_teammate',
            task_id: expect.not.stringContaining('@'),
          }),
        ]);

        await vi.waitFor(() => {
          expect(mockRunSubagent).toHaveBeenCalled();
        });
        expect(mockRunSubagent.mock.calls[0]?.[0]).toEqual(
          expect.objectContaining({
            prompt: [
              {
                type: 'text',
                text: '<teammate-message teammate_id="team-lead" summary="review API">\nReview the API.\n</teammate-message>',
              },
              {
                type: 'text',
                text: expect.stringContaining('# Team Coordination'),
              },
            ],
          }),
        );
        const prompt = mockRunSubagent.mock.calls[0]?.[0].prompt;
        if (
          !prompt ||
          typeof prompt === 'string' ||
          prompt[1]?.type !== 'text'
        ) {
          throw new Error('应保留结构化任务和团队上下文');
        }
        expect(prompt[1].text).toContain('- Name: reviewer');
        expect(prompt[1].text).toContain(
          `/tasks/${deriveSessionTeamName(mockConfig.getSessionId())}`,
        );

        await vi.waitFor(() => {
          expect(registry.all()[0]).toMatchObject({
            type: 'in_process_teammate',
            status: 'running',
            isIdle: true,
          });
        });
        const task =
          registry.all()[0] as import('../tasks/unified-task.js').AgentUnifiedTask;
        expect(getCommandQueueSnapshot()).toEqual([
          expect.objectContaining({
            commandMode: 'prompt',
            origin: expect.objectContaining({
              kind: 'peer',
              senderTaskId: task.taskId,
            }),
            prompt: expect.stringContaining(
              '"summary":"[to main] Sending review result"',
            ),
          }),
        ]);

        await sendTeamMessage({
          teamName: task.teamName!,
          from: 'team-lead',
          to: 'reviewer',
          text: 'Check the tests too.',
          summary: 'check tests',
          businessInfo: {
            version: '1',
            id: 'new-user-turn',
            model_key: 'auto',
          },
        });
        expect(signalTeammateController(task.agentId)).toBe(true);

        await vi.waitFor(() => {
          expect(mockRunSubagent).toHaveBeenCalledTimes(2);
        });
        expect(mockRunSubagent.mock.calls[1]?.[0]).toEqual(
          expect.objectContaining({
            parentBusinessInfo: {
              version: '1',
              id: 'new-user-turn',
              model_key: 'auto',
            },
            prompt: expect.stringContaining('Check the tests too.'),
            resumeLeafUuid: 'teammate-tool-result-1',
          }),
        );
        expect(
          mockRunSubagent.mock.calls[1]?.[0].contextMessages?.map(
            (message) => message.uuid,
          ),
        ).toEqual(
          expect.arrayContaining([
            'teammate-user-1',
            'teammate-assistant-1',
            'teammate-tool-result-1',
          ]),
        );
        expect(
          mockRunSubagent.mock.calls[1]?.[0].contextMessages?.map(
            (message) => message.uuid,
          ),
        ).not.toContain('event-only-user-1');
        expect(mockRunSubagent.mock.calls[1]?.[0].prompt).not.toContain(
          '# Team Coordination',
        );
        await vi.waitFor(() => {
          expect(registry.get(task.id)).toMatchObject({
            isIdle: true,
            result: 'Tests checked.',
          });
        });
        const transcriptEntries = (
          await readFile(
            getSubagentTranscriptPath(
              mockConfig.getProjectRoot(),
              mockConfig.getSessionId(),
              task.agentId,
            ),
            'utf8',
          )
        )
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .filter(
            (entry) =>
              entry['type'] === 'user' || entry['type'] === 'assistant',
          );
        expect(transcriptEntries).toHaveLength(5);
        expect(
          transcriptEntries.filter((entry) => entry['parentUuid'] === null),
        ).toHaveLength(1);
        expect(await readAgentTeamConfig(task.teamName!)).toMatchObject({
          members: expect.arrayContaining([
            expect.objectContaining({
              name: 'reviewer',
              resolvedModel: 'test-model',
              status: expect.stringMatching(/running|idle/),
            }),
          ]),
        });

        await ExecutionLifecycleService.kill(task.executionId);
        expect(registry.get(task.id)).toMatchObject({
          status: 'killed',
          notified: true,
        });
        await mockConfig.cleanupAgentTeamSessions();
        await expect(readAgentTeamConfig(task.teamName!)).resolves.toBeNull();
        await new Promise((resolve) => setTimeout(resolve, 25));
        await expect(readAgentTeamConfig(task.teamName!)).resolves.toBeNull();
      } finally {
        await rm(tempConfigDir, { recursive: true, force: true });
        _resetConfigHomeDirCache();
      }
    });

    it('rolls back the roster and claimed task when teammate preparation fails', async () => {
      vi.stubEnv(ENV_AGENT_TEAMS, '1');
      const tempConfigDir = path.join(
        os.tmpdir(),
        `agent-team-rollback-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      );
      vi.stubEnv(ENV_CONFIG_DIR, tempConfigDir);
      _resetConfigHomeDirCache();
      await mockConfig.initializeAgentTeamSession();
      const sharedTask = await mockConfig.getTaskStore().createTask({
        subject: 'Review the API',
        description: 'Check behavior and tests',
      });
      const createExecution = vi
        .spyOn(ExecutionLifecycleService, 'createExecution')
        .mockReturnValue({
          pid: undefined,
        } as unknown as ReturnType<
          typeof ExecutionLifecycleService.createExecution
        >);
      const invocation = createLocalInvocation({
        prompt: 'Review the API.',
        description: 'review API',
        subagent_type: 'MockAgent',
        name: 'reviewer',
      });

      try {
        await expect(invocation.execute(signal, updateOutput)).rejects.toThrow(
          'Failed to allocate an execution ID',
        );
        const teamName = deriveSessionTeamName(mockConfig.getSessionId());
        expect(await readAgentTeamConfig(teamName)).toMatchObject({
          members: [expect.objectContaining({ name: 'team-lead' })],
        });
        const restoredTask = await mockConfig
          .getTaskStore()
          .getTask(sharedTask.id);
        expect(restoredTask).toMatchObject({
          id: sharedTask.id,
          status: 'pending',
        });
        expect(restoredTask).not.toHaveProperty('owner');
      } finally {
        createExecution.mockRestore();
        await rm(tempConfigDir, { recursive: true, force: true });
        _resetConfigHomeDirCache();
      }
    });

    it('reports the classified roster failure when teammate reservation fails', async () => {
      vi.stubEnv(ENV_AGENT_TEAMS, '1');
      const tempConfigDir = path.join(
        os.tmpdir(),
        `agent-team-reservation-failure-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      );
      vi.stubEnv(ENV_CONFIG_DIR, tempConfigDir);
      _resetConfigHomeDirCache();
      await mockConfig.initializeAgentTeamSession();
      const teamName = deriveSessionTeamName(mockConfig.getSessionId());
      await writeFile(getAgentTeamConfigPath(teamName), '{invalid', 'utf8');
      const invocation = createLocalInvocation({
        prompt: 'Review the API.',
        description: 'review API',
        subagent_type: 'MockAgent',
        name: 'reviewer',
      });

      try {
        await expect(
          invocation.execute(signal, updateOutput),
        ).rejects.toMatchObject({
          name: 'AgentTeamReservationError',
          stage: 'roster_read',
          code: 'roster_parse_failed',
          commitState: 'not_written',
        });
      } finally {
        await rm(tempConfigDir, { recursive: true, force: true });
        _resetConfigHomeDirCache();
      }
    });

    it('reports an approved teammate shutdown as stopped without a model continuation', async () => {
      vi.stubEnv(ENV_AGENT_TEAMS, '1');
      const tempConfigDir = path.join(
        os.tmpdir(),
        `agent-team-shutdown-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      );
      vi.stubEnv(ENV_CONFIG_DIR, tempConfigDir);
      _resetConfigHomeDirCache();
      await mockConfig.initializeAgentTeamSession();
      drainSubagentSdkEvents(mockConfig.getSessionId(), () => true);

      try {
        await createLocalInvocation({
          prompt: 'Review the API.',
          description: 'review API',
          subagent_type: 'MockAgent',
          name: 'reviewer',
        }).execute(signal, updateOutput, {
          setExecutionIdCallback: vi.fn(),
        });

        await vi.waitFor(() => {
          expect(registry.all()[0]).toMatchObject({
            type: 'in_process_teammate',
            isIdle: true,
          });
        });
        const task =
          registry.all()[0] as import('../tasks/unified-task.js').AgentUnifiedTask;
        drainSubagentSdkEvents(mockConfig.getSessionId(), () => true);
        _resetQueueForTest();

        task.abortController?.abort('shutdown-approved');
        expect(task.abortController?.signal.reason).toBe('shutdown-approved');

        await vi.waitFor(() => {
          expect(registry.get(task.id)).toMatchObject({
            status: 'killed',
            notified: true,
          });
        });
        const events = drainSubagentSdkEvents(
          mockConfig.getSessionId(),
          () => true,
        );
        const terminalEvents = events.filter(
          (event) =>
            event.type === 'system' &&
            (event.subtype === 'background_tasks_changed' ||
              event.subtype === 'task_updated' ||
              event.subtype === 'task_notification'),
        );
        expect(terminalEvents).toEqual([
          expect.objectContaining({
            subtype: 'background_tasks_changed',
            tasks: [],
          }),
          expect.objectContaining({
            subtype: 'task_updated',
            task_id: task.taskId,
            patch: expect.objectContaining({ status: 'killed' }),
          }),
        ]);
        expect(getCommandQueueSnapshot()).toEqual([]);
      } finally {
        await rm(tempConfigDir, { recursive: true, force: true });
        _resetConfigHomeDirCache();
      }
    });

    it('uses the allocated duplicate suffix in the spawn result and registry', async () => {
      vi.stubEnv(ENV_AGENT_TEAMS, '1');
      const tempConfigDir = path.join(
        os.tmpdir(),
        `agent-team-names-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      );
      vi.stubEnv(ENV_CONFIG_DIR, tempConfigDir);
      _resetConfigHomeDirCache();
      await mockConfig.initializeAgentTeamSession();

      try {
        const first = await createLocalInvocation({
          prompt: 'Review the API.',
          description: 'first reviewer',
          subagent_type: 'MockAgent',
          name: 'reviewer',
        }).execute(signal, updateOutput, {
          setExecutionIdCallback: vi.fn(),
        });
        const second = await createLocalInvocation({
          prompt: 'Review the tests.',
          description: 'second reviewer',
          subagent_type: 'MockAgent',
          name: 'Reviewer',
        }).execute(signal, updateOutput, {
          setExecutionIdCallback: vi.fn(),
        });

        expect(first.toolUseResult).toMatchObject({ name: 'reviewer' });
        expect(second.toolUseResult).toMatchObject({ name: 'Reviewer-2' });
        expect(
          registry
            .all()
            .map((task) => ('agentName' in task ? task.agentName : undefined)),
        ).toEqual(['reviewer', 'Reviewer-2']);
      } finally {
        const taskIds = registry.all().map((task) => task.id);
        await Promise.all(
          registry
            .all()
            .map((task) => ExecutionLifecycleService.kill(task.executionId)),
        );
        await vi.waitFor(() => {
          for (const taskId of taskIds) {
            expect(registry.get(taskId)?.status).toBe('killed');
          }
        });
        await rm(tempConfigDir, { recursive: true, force: true });
        _resetConfigHomeDirCache();
      }
    });
  });
});

describe('AgentTool Read-Only logic', () => {
  let mockConfig: Config;
  let mockContext: AgentLoopContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig = setupMockConfig();
    mockContext = mockConfig as AgentLoopContext;
  });

  it('should always be true', () => {
    const readOnlyTool = {
      name: 'read',
      isReadOnly: true,
    } as unknown as DeclarativeTool<object, ToolResult>;
    const registry = {
      getTool: (name: string) => (name === 'read' ? readOnlyTool : undefined),
      hasToolEnabled: (name: string) => name === 'read',
    };
    vi.spyOn(mockConfig, 'toolRegistry', 'get').mockReturnValue(
      registry as unknown as ToolRegistry,
    );

    const defWithTools: LocalAgentDefinition = {
      ...testLocalDefinition,
      toolConfig: { tools: ['read'] },
    };
    const registryWithReadOnly = createMockAgentRegistry([defWithTools]);
    const tool = new AgentTool(registryWithReadOnly, mockContext);
    expect(tool.isReadOnly).toBe(true);
  });

  it('should be true even for empty agent registry', () => {
    const emptyRegistry = createMockAgentRegistry([]);
    const tool = new AgentTool(emptyRegistry, mockContext);
    expect(tool.isReadOnly).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// /subtask — buildForkSubtaskParams + spawnForkSubtask backstops
// ---------------------------------------------------------------------------

describe('buildForkSubtaskParams', () => {
  it('synthesizes name + description and forces run_in_background', () => {
    const directive = 'Fix the flaky login test in auth module';
    expect(buildForkSubtaskParams(directive)).toEqual({
      description: truncateDirectiveLabel(directive),
      prompt: directive,
      name: deriveForkName(directive),
      run_in_background: true,
    });
  });

  it('keeps the full directive as the prompt even when the label is truncated', () => {
    const directive = 'a'.repeat(200);
    const params = buildForkSubtaskParams(directive);
    expect(params.prompt).toBe(directive);
    expect(params.description.length).toBeLessThanOrEqual(60);
    expect(params.run_in_background).toBe(true);
  });
});

describe('spawnForkSubtask backstops', () => {
  it('rejects when agent sessions are disabled', async () => {
    vi.stubEnv(ENV_ENABLE_AGENT_SESSIONS, '0');
    try {
      await expect(
        spawnForkSubtask({} as AgentLoopContext, 'do something'),
      ).rejects.toThrow(ENV_ENABLE_AGENT_SESSIONS);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('rejects fast when invoked from inside a fork child', async () => {
    const forkChildMessages = [
      {
        type: 'user',
        message: {
          role: 'user',
          content: buildForkDirectivePrompt('earlier task'),
        },
      },
    ];
    const agentContext = {
      getConversationMessages: () => forkChildMessages,
    } as unknown as AgentLoopContext;
    await expect(
      spawnForkSubtask(agentContext, 'do something'),
    ).rejects.toThrow(/forked worker/i);
  });
});
