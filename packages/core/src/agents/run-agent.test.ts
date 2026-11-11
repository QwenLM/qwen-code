/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readGitHead, resolveGitRepositoryLayout } from '../utils/gitUtils.js';
import { runLogger } from '../utils/runLogger.js';
import { getSessionTranscriptPath } from '../services/transcript-paths.js';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setConfigHomeDirOverride } from '../utils/paths.js';
import { createToolFileStateCache } from '../utils/fileStateCache.js';
import { createAttachmentMessage } from '../attachments/factory.js';
import { EnvironmentAttachment } from '../attachments/models/environment-attachment.js';
import { SessionContextAttachment } from '../attachments/models/session-context-attachment.js';
import { buildForkContextMessages } from '../utils/forkContextUtils.js';

import {
  testModelResolution,
  testRequestConfig,
} from '../test-utils/model-resolution.js';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildAgentWorktreeSlug,
  resolveAgentModel,
  runAgent,
} from './run-agent.js';
import { getCustomContextFromContext } from '../utils/sessionIdContext.js';
import { AgentTerminateMode, type LocalAgentDefinition } from './types.js';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import { drainSubagentSdkEvents } from './subagent-sdk-events.js';
import { runSubagent } from './run-subagent.js';
import {
  buildSubagentRegistries,
  buildSubagentSystemPrompt,
} from './agent-setup.js';
import { CoreToolCallStatus } from '../tool-executor/types.js';
import {
  completeAgentTaskRecord,
  updateAgentTaskRecord,
} from './agent-task-runtime.js';
import { REJECT_MESSAGE } from '../protocol/transcript/message-utils.js';
import {
  createAssistantAPIErrorMessage,
  createUserMessage,
} from '../protocol/transcript/conversions.js';
import type { QueryEvent } from '../core/query-event.js';
import {
  createSubagentTranscriptRecorder,
  writeSubagentMetadata,
} from '../services/subagent-transcript.js';
import {
  MAX_WORKTREE_SLUG_LENGTH,
  validateWorktreeSlug,
} from '../services/worktreeService.js';
import {
  buildSkillPromptContent,
  prepareSkillBody,
} from '../skills/inlineSkillActivation.js';
import { runWithAgentContext } from '../utils/agentContext.js';
import { ModelProviderManager } from '../provider/impl/modelProviderManager.js';
import { ModelTransportManager } from '../provider/transport/modelTransportManager.js';
import { SettingsService } from '@qwen-code/resource';
import { ENV_SUBAGENT_MODEL } from '../config/brand.js';
import { TaskRegistry } from '../tasks/task-registry.js';
import { runWithCwdOverride } from '../utils/Shell.js';
import { createPermissionManager } from '../test-utils/config.js';
import { constrainAgentPermissions } from '../permissions/agent-tool-constraints.js';
import { SkillManager } from '../skills/skillManager.js';
import { workflowToSkill } from '../workflows/workflow-skills.js';
import { MockTool } from '../test-utils/mock-tool.js';
import {
  completedToolCallToResult,
  convertToolResultToCompletedToolCall,
  LocalToolCallExecutor,
} from '../tool-executor/index.js';
import {
  claimWorktreeOwnership,
  readWorktreeOwnerState,
} from '../services/worktree-owner-state.js';
import {
  addWorktreeReservation,
  type WorktreeCreationReservation,
} from '../services/worktree/creationReservation.js';

vi.mock('../utils/gitUtils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/gitUtils.js')>()),
  readGitHead: vi.fn(),
  resolveGitRepositoryLayout: vi.fn(),
}));

const mockRunForkedAgent = vi.fn();
const worktreeServiceMocks = vi.hoisted(() => ({
  createAgentWorktree: vi.fn(),
  removeAgentWorktree: vi.fn(),
  cleanupStaleAgentWorktrees: vi.fn(),
  hasWorktreeChanges: vi.fn(),
  findProjectRootForWorktree: vi.fn(),
}));

vi.mock('../services/worktreeService.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../services/worktreeService.js')>();
  return {
    ...actual,
    createAgentWorktree: worktreeServiceMocks.createAgentWorktree,
    removeAgentWorktree: worktreeServiceMocks.removeAgentWorktree,
    cleanupStaleAgentWorktrees: worktreeServiceMocks.cleanupStaleAgentWorktrees,
    hasWorktreeChanges: worktreeServiceMocks.hasWorktreeChanges,
    findProjectRootForWorktree: worktreeServiceMocks.findProjectRootForWorktree,
  };
});

vi.mock('./agent-setup.js', () => ({
  buildSubagentRegistries: vi.fn(async (_definition, context) => {
    const toolRegistry = {
      getTool: vi.fn(() => undefined),
      getAllToolNames: vi.fn(() => ['Read', 'Bash']),
      dispose: vi.fn(),
    };
    return {
      toolRegistry,
      promptRegistry: {},
      resourceRegistry: {},
      schedulerContext: { ...context, toolRegistry },
    };
  }),
  buildSubagentSystemPrompt: vi.fn(async () => [
    { type: 'text', text: 'subagent system prompt' },
  ]),
}));

vi.mock('../services/subagent-transcript.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../services/subagent-transcript.js')
  >()),
  createSubagentTranscriptRecorder: vi.fn(async () => ({
    recordSidechainMessages: vi.fn(async () => null),
    close: vi.fn(async () => {}),
  })),
  getSubagentTranscriptDir: vi.fn(() => '/tmp/subagents'),
  getSubagentTranscriptPath: vi.fn(() => '/tmp/subagent.jsonl'),
  writeSubagentMetadata: vi.fn(async () => {}),
}));

vi.mock('./agent-task-runtime.js', () => ({
  completeAgentTaskRecord: vi.fn(async () => {}),
  updateAgentTaskRecord: vi.fn(async () => {}),
}));

vi.mock('../skills/inlineSkillActivation.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../skills/inlineSkillActivation.js')
  >()),
  prepareSkillBody: vi.fn(async () => ''),
  buildSkillPromptContent: vi.fn(
    (skill: { skillRoot: string }, body: string) =>
      `Base directory for this skill: ${skill.skillRoot}\n\n${body}`,
  ),
  buildSkillMetadataTags: vi.fn(
    (skillName: string) => `<skill-name>${skillName}</skill-name>`,
  ),
}));

vi.mock('./fork-subagent.js', () => ({
  FORK_QUERY_SOURCE: 'fork-query',
  buildForkDirectivePrompt: vi.fn(
    (directive: string) => `wrapped fork directive: ${directive}`,
  ),
  buildWorktreeNotice: vi.fn(() => 'worktree notice'),
  wrapWithParentToolSchemas: vi.fn(
    (_schemas: unknown, _config: unknown, childRegistry: unknown) =>
      childRegistry,
  ),
}));

vi.mock('../utils/forkContextUtils.js', () => ({
  buildForkContextMessages: vi.fn(() => [
    {
      role: 'user',
      content: [{ type: 'text', text: 'parent context' }],
    },
  ]),
  completeForkContextMessages: vi.fn((messages) => [...messages]),
}));

vi.mock('./registry/agentRegistry.js', () => ({
  getModelConfigAlias: vi.fn(() => 'agent:test'),
}));

vi.mock('../utils/agentContext.js', () => ({
  getAgentContext: vi.fn(() => undefined),
  runWithAgentContext: vi.fn(async (_ctx, fn: () => unknown) => await fn()),
}));

vi.mock('../hooks/sessionHooks.js', () => ({
  clearFrontmatterHooks: vi.fn(),
  registerFrontmatterHooks: vi.fn(),
}));

vi.mock('./run-subagent.js', () => ({
  runSubagent: vi.fn(),
}));

vi.mock('../core/forkedAgent.js', () => ({
  runForkedAgent: vi.fn((...args: unknown[]) => mockRunForkedAgent(...args)),
}));

vi.mock('../utils/task/diskOutput.js', () => ({
  flushTaskOutput: vi.fn(async () => {}),
}));

vi.mock('../provider/impl/modelProviderManager.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../provider/impl/modelProviderManager.js')
    >();
  const { testProviderModel } = await import(
    '../test-utils/model-resolution.js'
  );
  class TestManager extends actual.ModelProviderManager {
    override async getModel(key: string) {
      return testProviderModel(key);
    }
    override async listModels() {
      return [{ ...testProviderModel('default-model'), isDefault: true }];
    }
    override getModelConfig() {
      return undefined;
    }
  }
  return { ...actual, ModelProviderManager: TestManager };
});

function createDefinition(): LocalAgentDefinition {
  return {
    kind: 'local',
    name: 'explore',
    description: 'Explore the repository',
    modelConfig: {
      model: 'inherit',
    },
    promptConfig: {
      systemPrompt: 'unused',
    },
    runConfig: {
      maxTurns: 3,
      maxTimeMinutes: 1,
    },
  };
}

function createContext(sessionPersistence = true): AgentLoopContext {
  const workspaceContext = {
    addDirectory: vi.fn(),
    addReadOnlyPath: vi.fn(),
    getDirectories: vi.fn(() => ['/project']),
  };
  const modelProviderManager = new ModelProviderManager({
    userProviders: [],
    modelTransportManager: new ModelTransportManager([]),
    settingsService: new SettingsService(),
  });
  return {
    config: {
      ...testRequestConfig(),
      isWorkflowsEnabled: vi.fn(() => false),
      getSessionId: vi.fn(() => 'session-1'),
      getSessionPersistence: vi.fn(() => sessionPersistence),
      getProjectRoot: vi.fn(() => '/project'),
      getSessionArtifactProjectRoot: vi.fn(() => '/project'),
      getActiveSessionTranscriptPath(): string {
        return getSessionTranscriptPath(
          this.getSessionArtifactProjectRoot(),
          this.getSessionId(),
        );
      },
      getTargetDir: vi.fn(() => '/project'),
      getWorktreeCreationSettings: vi.fn(() => ({})),
      getHookSystem: vi.fn(() => undefined),
      getWorkspaceContext: vi.fn(() => workspaceContext),
      getSkillManager: vi.fn(() => ({
        getSkill: vi.fn(() => undefined),
      })),
      getSessionMemory: vi.fn(() => ''),
      getSystemInstructionMemory: vi.fn(() => undefined),
      getMcpClientManager: vi.fn(() => undefined),
      getModel: vi.fn(() => 'active-model'),
      getActiveModel: vi.fn(() => 'active-model'),
      getModelProviderManager: vi.fn(() => modelProviderManager),
      getToolExecutor: vi.fn(),
    },
    toolRegistry: {
      getTool: vi.fn((name: string) => {
        if (name !== 'Read') {
          return undefined;
        }
        return {
          build: vi.fn(() => ({
            getDescription: vi.fn(() => 'Reading package.json'),
          })),
        };
      }),
      dispose: vi.fn(),
    },
    getConversationMessages: vi.fn(() => [
      {
        type: 'user',
        uuid: 'parent-user',
        timestamp: '2026-04-20T00:00:00.000Z',
        message: {
          role: 'user',
          content: 'parent question',
        },
      },
      {
        type: 'assistant',
        uuid: 'parent-assistant',
        timestamp: '2026-04-20T00:00:01.000Z',
        message: {
          id: 'resp-parent',
          type: 'message',
          role: 'assistant',
          model: 'active-model',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
            service_tier: 'standard',
            cache_creation: {
              ephemeral_1h_input_tokens: 0,
              ephemeral_5m_input_tokens: 0,
            },
            inference_geo: '',
            iterations: [],
            speed: 'standard',
          },
          content: [{ type: 'text', text: 'parent answer', citations: null }],
          container: null,
          context_management: null,
        },
      },
    ]),
    getSystemPrompt: vi.fn(() => [
      { type: 'text', text: 'parent system prompt' },
    ]),
    getParentToolSchemas: vi.fn(() => undefined),
  } as unknown as AgentLoopContext;
}

describe('buildAgentWorktreeSlug', () => {
  it('keeps workflow custom agent worktree slugs under the git limit', () => {
    const slug = buildAgentWorktreeSlug(
      'workflow-regression-agent',
      'aworkflow-regression-agent-1234567890abcdef',
    );

    expect(slug).toBe('agent-workflow-regression-agent-90abcdef');
    expect(slug.length).toBeLessThanOrEqual(MAX_WORKTREE_SLUG_LENGTH);
    expect(() => validateWorktreeSlug(slug)).not.toThrow();
  });

  it('truncates very long agent names before appending the unique suffix', () => {
    const slug = buildAgentWorktreeSlug(
      `very-long-agent-name-${'segment-'.repeat(40)}`,
      'avery-long-agent-name-1234567890abcdef',
    );

    expect(slug).toMatch(/^agent-very-long-agent-name-segment-/);
    expect(slug).toMatch(/-90abcdef$/);
    expect(slug.length).toBe(MAX_WORKTREE_SLUG_LENGTH);
    expect(() => validateWorktreeSlug(slug)).not.toThrow();
  });

  it('sanitizes agent names that are not valid worktree slug segments', () => {
    const slug = buildAgentWorktreeSlug(
      '代码 Reviewer / v2',
      'agent-without-hex-suffix',
    );

    expect(slug).toMatch(/^agent-Reviewer-v2-[0-9a-f]{8}$/);
    expect(slug.length).toBeLessThanOrEqual(MAX_WORKTREE_SLUG_LENGTH);
    expect(() => validateWorktreeSlug(slug)).not.toThrow();
  });
});

describe('runAgent', () => {
  let configHome: string;
  beforeEach(() => {
    configHome = mkdtempSync(join(tmpdir(), 'run-agent-config-'));
    setConfigHomeDirOverride(configHome);
    vi.clearAllMocks();
    vi.mocked(resolveGitRepositoryLayout).mockResolvedValue({
      worktreeRoot: '/project',
      gitDir: '/project/.git',
      commonDir: '/project/.git',
      isWorktree: false,
    });
    vi.mocked(readGitHead).mockResolvedValue(null);
    worktreeServiceMocks.cleanupStaleAgentWorktrees.mockResolvedValue(0);
    worktreeServiceMocks.hasWorktreeChanges.mockResolvedValue(false);
    worktreeServiceMocks.findProjectRootForWorktree.mockResolvedValue(
      '/project',
    );
    worktreeServiceMocks.removeAgentWorktree.mockResolvedValue(true);
    drainSubagentSdkEvents('session-1', () => true);
    mockRunForkedAgent.mockResolvedValue({
      textContent: 'done',
      messages: [
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
          },
        },
      ],
      totalUsage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
  });

  afterEach(() => {
    setConfigHomeDirOverride(undefined);
    rmSync(configHome, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('gives the process-wide subagent model precedence over an invocation override', async () => {
    const context = createContext();
    vi.stubEnv(ENV_SUBAGENT_MODEL, 'environment-model');

    expect(
      await resolveAgentModel(context, createDefinition(), 'invocation-model'),
    ).toBe('environment-model');
  });

  it('inherits the triggering parent request model instead of the CLI base model', async () => {
    const context = createContext();
    vi.mocked(context.config.getModel).mockReturnValue('ultimate');
    vi.mocked(context.config.getActiveModel).mockReturnValue('ultimate');
    Object.defineProperty(context, 'getCacheSafeQuerySnapshot', {
      value: vi.fn(() => ({ model: 'previous-request-model' })),
      configurable: true,
    });

    expect(
      await resolveAgentModel(context, createDefinition(), undefined, 'auto'),
    ).toBe('auto');
  });

  it('falls back to the parent query snapshot when no tool model is available', async () => {
    const context = createContext();
    vi.mocked(context.config.getModel).mockReturnValue('ultimate');
    vi.mocked(context.config.getActiveModel).mockReturnValue('ultimate');
    Object.defineProperty(context, 'getCacheSafeQuerySnapshot', {
      value: vi.fn(() => ({ model: 'auto' })),
      configurable: true,
    });

    expect(await resolveAgentModel(context, createDefinition())).toBe('auto');
  });

  it('keeps an explicit agent model ahead of the inherited parent model', async () => {
    const context = createContext();
    const definition = createDefinition();
    definition.modelConfig.model = 'agent-model';

    expect(
      await resolveAgentModel(context, definition, undefined, 'auto'),
    ).toBe('agent-model');
  });

  it.each(['definition', 'invocation', 'environment'] as const)(
    'resolves the %s display name to its catalog key before running',
    async (source) => {
      const context = createContext();
      const manager = context.config.getModelProviderManager();
      const model = {
        ...(await manager.getModel('gm51model'))!,
        displayName: 'GLM-5.3',
      };
      vi.spyOn(manager, 'getModel').mockImplementation(async (key) =>
        key === model.key ? model : undefined,
      );
      vi.spyOn(manager, 'listModels').mockResolvedValue([model]);
      const definition = createDefinition();
      if (source === 'definition') definition.modelConfig.model = 'GLM-5.3';
      if (source === 'environment') vi.stubEnv(ENV_SUBAGENT_MODEL, 'glm-5.3');

      expect(
        await resolveAgentModel(
          context,
          definition,
          source === 'invocation' ? 'GLM-5.3' : undefined,
          'active-model',
        ),
      ).toBe('gm51model');
    },
  );

  it('does not silently replace an unknown explicit model with the parent model', async () => {
    const context = createContext();
    const manager = context.config.getModelProviderManager();
    const parent = (await manager.getModel('active-model'))!;
    vi.spyOn(manager, 'getModel').mockImplementation(async (key) =>
      key === parent.key ? parent : undefined,
    );
    vi.spyOn(manager, 'listModels').mockResolvedValue([parent]);
    const definition = createDefinition();
    definition.modelConfig.model = 'missing-model';

    expect(await resolveAgentModel(context, definition)).toBe('missing-model');
  });

  it('prefers an existing model ID over another model with that display name', async () => {
    const context = createContext();
    const manager = context.config.getModelProviderManager();
    const model = (await manager.getModel('gm51model'))!;
    const getModel = vi.spyOn(manager, 'getModel');
    const listModels = vi
      .spyOn(manager, 'listModels')
      .mockResolvedValue([
        model,
        { ...model, key: 'another-model', displayName: 'gm51model' },
      ]);
    const definition = createDefinition();
    definition.modelConfig.model = 'gm51model';

    expect(await resolveAgentModel(context, definition)).toBe('gm51model');
    expect(listModels).toHaveBeenCalledOnce();
    expect(getModel).not.toHaveBeenCalled();
  });

  it('rejects an ambiguous display name at execution even without effort', async () => {
    const context = createContext();
    const manager = context.config.getModelProviderManager();
    const model = (await manager.getModel('first'))!;
    vi.spyOn(manager, 'getModel').mockResolvedValue(undefined);
    vi.spyOn(manager, 'listModels').mockResolvedValue([
      { ...model, key: 'first', displayName: 'Shared Name' },
      { ...model, key: 'second', displayName: 'Shared Name' },
    ]);
    const definition = createDefinition();
    definition.modelConfig.model = 'Shared Name';

    await expect(resolveAgentModel(context, definition)).rejects.toThrow(
      'ambiguous',
    );
  });

  it.each(['definition', 'invocation', 'environment'] as const)(
    'rejects an ambiguous model ID from the %s before a loose key lookup',
    async (source) => {
      const context = createContext();
      const manager = context.config.getModelProviderManager();
      const base = (await manager.getModel('Target'))!;
      const models = [base, { ...base, key: 'TARGET' }];
      const getModel = vi.spyOn(manager, 'getModel').mockResolvedValue(base);
      vi.spyOn(manager, 'listModels').mockResolvedValue(models);
      const definition = createDefinition();
      if (source === 'definition') definition.modelConfig.model = 'target';
      if (source === 'environment') vi.stubEnv(ENV_SUBAGENT_MODEL, 'target');

      await expect(
        resolveAgentModel(
          context,
          definition,
          source === 'invocation' ? 'target' : undefined,
        ),
      ).rejects.toThrow('ambiguous');
      expect(getModel).not.toHaveBeenCalled();
    },
  );

  it.each(['Target', 'TARGET'])(
    'keeps exact model ID %s authoritative when IDs differ only by case',
    async (key) => {
      const context = createContext();
      const manager = context.config.getModelProviderManager();
      const base = (await manager.getModel('Target'))!;
      const getModel = vi.spyOn(manager, 'getModel').mockResolvedValue(base);
      vi.spyOn(manager, 'listModels').mockResolvedValue([
        base,
        { ...base, key: 'TARGET' },
      ]);
      const definition = createDefinition();
      definition.modelConfig.model = key;

      expect(await resolveAgentModel(context, definition)).toBe(key);
      expect(getModel).not.toHaveBeenCalled();
    },
  );

  it('preserves an unlisted utility model through provider key lookup', async () => {
    const context = createContext();
    const manager = context.config.getModelProviderManager();
    const model = (await manager.getModel('lite'))!;
    const getModel = vi.spyOn(manager, 'getModel').mockResolvedValue(model);
    vi.spyOn(manager, 'listModels').mockResolvedValue([]);
    const definition = createDefinition();
    definition.modelConfig.model = 'lite';

    expect(await resolveAgentModel(context, definition)).toBe('lite');
    expect(getModel).toHaveBeenCalledExactlyOnceWith('lite');
  });

  it('keeps a restored agent on its saved model after the parent switches', async () => {
    const context = createContext();

    expect(
      await resolveAgentModel(context, createDefinition(), 'auto', 'ultimate'),
    ).toBe('auto');
  });

  it('logs worktree startup failure before task persistence and preserves the error', async () => {
    const error = new Error('worktree creation failed');
    worktreeServiceMocks.createAgentWorktree.mockRejectedValueOnce(error);
    const logs = vi.spyOn(runLogger, 'log');
    const warn = vi.spyOn(runLogger, 'warn');
    try {
      await expect(
        runAgent({
          definition: { ...createDefinition(), isolation: 'worktree' },
          context: createContext(),
          agentArgs: { query: 'inspect files' },
          tracker: {
            recentActivity: [],
            makeProgress: vi.fn(),
            handleQueryEvent: vi.fn(),
          } as never,
          signal: new AbortController().signal,
          taskId: 'task-worktree',
          agentId: 'agent-00000001',
          outputPath: '/tmp/out',
          description: 'inspect files',
          isForkPath: false,
        }),
      ).rejects.toBe(error);
      const identity =
        'agentId=agent-00000001 taskId=task-worktree sessionId=session-1 stage=worktree';
      expect(logs).toHaveBeenCalledWith(
        `[SubagentRun] startup.start ${identity}`,
      );
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        expect.stringMatching(
          new RegExp(
            `^\\[SubagentRun\\] startup.failed ${identity} durationMs=\\d+$`,
          ),
        ),
      );
      expect(logs).not.toHaveBeenCalledWith(
        expect.stringContaining(`[SubagentRun] startup.finish ${identity}`),
      );
      expect(warn.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(completeAgentTaskRecord).mock.invocationCallOrder[0],
      );
      expect(runSubagent).not.toHaveBeenCalled();
    } finally {
      logs.mockRestore();
      warn.mockRestore();
    }
  });

  it('uses the parent checkout HEAD and preserves a worktree when cleanup fails', async () => {
    const context = createContext();
    vi.mocked(context.config.getProjectRoot).mockReturnValue(
      '/project/parent-worktree',
    );
    vi.mocked(context.config.getWorktreeCreationSettings).mockReturnValue({
      baseRef: 'head',
    });
    worktreeServiceMocks.findProjectRootForWorktree.mockResolvedValue(
      '/project',
    );
    worktreeServiceMocks.createAgentWorktree.mockResolvedValue({
      worktreePath: '/project/.qwen/worktrees/agent-explore-00000001',
      worktreeBranch: 'worktree-agent-explore-00000001',
      headCommit: 'parent-head',
      gitRoot: '/project',
      existed: false,
    });
    worktreeServiceMocks.removeAgentWorktree.mockResolvedValue(false);
    vi.mocked(runSubagent).mockResolvedValueOnce({
      textContent: 'done',
      messages: [],
      totalUsage: undefined,
      terminal: { reason: 'end_turn' },
    } as never);

    const definition = createDefinition();
    definition.isolation = 'worktree';
    const result = await runWithCwdOverride('/project/parent-worktree', () =>
      runAgent({
        definition,
        context,
        agentArgs: { query: 'inspect files' },
        tracker: {
          recentActivity: [],
          makeProgress: vi.fn(() => 'progress'),
          handleQueryEvent: vi.fn(),
        } as never,
        signal: new AbortController().signal,
        taskId: 'task-worktree',
        agentId: 'agent-00000001',
        outputPath: '/tmp/out',
        description: 'inspect files',
        isForkPath: false,
      }),
    );

    expect(readGitHead).not.toHaveBeenCalled();
    expect(createSubagentTranscriptRecorder).toHaveBeenCalledWith(
      expect.anything(),
      'agent-00000001',
      'task-worktree',
      expect.any(Function),
      expect.objectContaining({ gitBranch: 'worktree-agent-explore-00000001' }),
    );
    expect(worktreeServiceMocks.createAgentWorktree).toHaveBeenCalledWith(
      'agent-explore-00000001',
      '/project',
      {
        baseRef: 'head',
        fromCwd: '/project/parent-worktree',
      },
    );
    expect(worktreeServiceMocks.removeAgentWorktree).toHaveBeenCalledWith(
      '/project/.qwen/worktrees/agent-explore-00000001',
      'worktree-agent-explore-00000001',
      '/project',
      { baseSha: 'parent-head' },
    );
    expect(result.worktreePath).toBe(
      '/project/.qwen/worktrees/agent-explore-00000001',
    );
    expect(result.toolResult.data).toMatchObject({
      worktreePath: '/project/.qwen/worktrees/agent-explore-00000001',
    });
  });

  it.each([
    'create-owned',
    'cleanup-owned',
    'cleanup-reserved',
    'cleanup-changed',
    'cleanup-unowned',
  ] as const)(
    'preserves unsafe agent hook cleanup targets: %s',
    async (scenario) => {
      const context = createContext();
      const target = join(realpathSync(configHome), 'hook-checkout');
      mkdirSync(target);
      const reservations: WorktreeCreationReservation[] = [];
      const removeHook = vi.fn(async () => ({
        success: true,
        successfulHookCount: 1,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
      }));
      const hookSystem = {
        getRegistry: () => ({
          getHooksForEvent: (event: string) =>
            event === 'WorktreeRemove' ||
            (event === 'WorktreeCreate' && scenario === 'create-owned')
              ? [{}]
              : [],
        }),
        fireWorktreeCreateEvent: async () => ({
          success: true,
          successfulHookCount: 1,
          allOutputs: [{ hookSpecificOutput: { worktreePath: target } }],
          errors: [],
          totalDuration: 0,
        }),
        fireWorktreeRemoveEvent: removeHook,
        fireSubagentStartEvent: async () => undefined,
      };
      vi.mocked(context.config.getHookSystem).mockReturnValue(
        hookSystem as never,
      );
      vi.mocked(context.config.getProjectRoot).mockReturnValue(configHome);
      worktreeServiceMocks.createAgentWorktree.mockResolvedValue({
        worktreePath: target,
        headCommit: 'base',
        gitRoot: configHome,
      });
      if (scenario === 'cleanup-changed') {
        // 外层初检后出现新改动，最终持锁检查必须拒绝调用删除 Hook。
        worktreeServiceMocks.hasWorktreeChanges
          .mockResolvedValueOnce(false)
          .mockResolvedValue(true);
      }
      if (scenario === 'create-owned') {
        expect(
          await claimWorktreeOwnership(target, 'owner-session', configHome),
        ).toBe('owned');
      }
      vi.mocked(runSubagent)
        .mockReset()
        .mockImplementationOnce(async () => {
          // 模拟 Agent 执行期间，目标被会话认领或进入切换事务。
          if (scenario === 'cleanup-owned') {
            expect(
              await claimWorktreeOwnership(target, 'owner-session', configHome),
            ).toBe('owned');
          } else if (scenario === 'cleanup-reserved') {
            await addWorktreeReservation(reservations, target);
          }
          return {
            textContent: 'done',
            messages: [],
            terminal: { reason: 'end_turn' },
          } as never;
        });
      const definition = {
        ...createDefinition(),
        isolation: 'worktree' as const,
      };
      const invocation = runAgent({
        definition,
        context,
        agentArgs: { query: 'inspect files' },
        tracker: {
          recentActivity: [],
          makeProgress: vi.fn(),
          handleQueryEvent: vi.fn(),
        } as never,
        signal: new AbortController().signal,
        taskId: 'task-hook-worktree',
        agentId: 'agent-00000001',
        outputPath: '/tmp/out',
        description: 'inspect files',
        isForkPath: false,
      });
      try {
        if (scenario === 'create-owned') {
          await expect(invocation).rejects.toThrow(/ownership/i);
          expect(runSubagent).not.toHaveBeenCalled();
        } else {
          const result = await invocation;
          expect(result.worktreePath).toBe(
            scenario === 'cleanup-unowned' ? undefined : target,
          );
        }
        if (scenario === 'cleanup-unowned') {
          expect(removeHook).toHaveBeenCalledWith(target);
        } else {
          expect(removeHook).not.toHaveBeenCalled();
        }
        if (scenario.endsWith('-owned')) {
          expect(await readWorktreeOwnerState(target)).toMatchObject({
            ownerSessionId: 'owner-session',
          });
        }
      } finally {
        await Promise.all(
          reservations.map((reservation) => reservation.release()),
        );
      }
    },
  );

  it('runs SubagentStart hooks inside the subagent customContext snapshot', async () => {
    let observed: Readonly<Record<string, string>> | undefined;
    const context = createContext();
    vi.mocked(context.config.getHookSystem).mockReturnValue({
      fireSubagentStartEvent: vi.fn(async () => {
        observed = getCustomContextFromContext();
        return undefined;
      }),
    } as never);
    vi.mocked(runSubagent).mockResolvedValueOnce({
      textContent: 'done',
      messages: [],
      totalUsage: undefined,
      terminal: { reason: 'end_turn' },
    } as never);

    await runAgent({
      definition: createDefinition(),
      context,
      agentArgs: { query: 'inspect files' },
      tracker: {
        recentActivity: [],
        makeProgress: vi.fn(() => 'progress'),
        handleQueryEvent: vi.fn(),
      } as never,
      signal: new AbortController().signal,
      taskId: 'task-1',
      agentId: 'agent-1',
      outputPath: '',
      description: 'inspect files',
      isForkPath: false,
      customContext: { tenant: 'hook' },
    });

    expect(observed).toEqual({ tenant: 'hook' });
    expect(Object.isFrozen(observed)).toBe(true);
  });

  it('defaults local subagents to 150 turns when maxTurns is omitted', async () => {
    vi.mocked(runSubagent).mockResolvedValueOnce({
      textContent: 'done',
      messages: [],
      totalUsage: undefined,
      terminal: { reason: 'end_turn' },
    } as never);
    const definition = createDefinition();
    definition.runConfig = { maxTimeMinutes: 1 };

    await runAgent({
      definition,
      context: createContext(false),
      agentArgs: { query: 'inspect files' },
      tracker: {
        recentActivity: [],
        makeProgress: vi.fn(() => 'progress'),
        handleQueryEvent: vi.fn(),
      } as never,
      signal: new AbortController().signal,
      taskId: 'task-1',
      agentId: 'agent-1',
      outputPath: '',
      description: 'inspect files',
      isForkPath: false,
      customContext: { tenant: 'pds' },
    });

    expect(runSubagent).toHaveBeenCalledWith(
      expect.objectContaining({
        maxTurns: 150,
        customContext: { tenant: 'pds' },
      }),
    );
  });

  it('preserves an explicitly configured local subagent maxTurns', async () => {
    vi.mocked(runSubagent).mockResolvedValueOnce({
      textContent: 'done',
      messages: [],
      totalUsage: undefined,
      terminal: { reason: 'end_turn' },
    } as never);

    await runAgent({
      definition: createDefinition(),
      context: createContext(false),
      agentArgs: { query: 'inspect files' },
      tracker: {
        recentActivity: [],
        makeProgress: vi.fn(() => 'progress'),
        handleQueryEvent: vi.fn(),
      } as never,
      signal: new AbortController().signal,
      taskId: 'task-1',
      agentId: 'agent-1',
      outputPath: '',
      description: 'inspect files',
      isForkPath: false,
    });

    expect(runSubagent).toHaveBeenCalledWith(
      expect.objectContaining({ maxTurns: 3 }),
    );
  });

  it('forwards every query event before updating the progress tracker', async () => {
    const events = [
      { type: 'request_start' },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: '正在分析' },
        },
      },
      {
        type: 'assistant_block',
        index: 0,
        message: {
          messageId: 'forwarded-message',
          model: 'test-model',
          blocks: [],
        },
      },
      createAssistantAPIErrorMessage({ content: '请求失败' }),
      createUserMessage('继续'),
    ] satisfies QueryEvent[];
    vi.mocked(runSubagent).mockImplementationOnce(async (params) => {
      for (const event of events) params.onEvent?.(event);
      return {
        textContent: '',
        messages: [],
        totalUsage: undefined,
        terminal: { reason: 'end_turn' },
      } as never;
    });
    const order: string[] = [];
    const tracker = {
      recentActivity: [],
      makeProgress: vi.fn(() => 'progress'),
      handleQueryEvent: vi.fn((event: { type: string }) => {
        order.push(`tracker:${event.type}`);
      }),
    };
    const onQueryEvent = vi.fn((event: { type: string }) => {
      order.push(`query:${event.type}`);
    });

    await runAgent({
      definition: createDefinition(),
      context: createContext(false),
      agentArgs: { query: 'inspect files' },
      tracker: tracker as never,
      signal: new AbortController().signal,
      taskId: 'task-1',
      agentId: 'agent-1',
      outputPath: '',
      description: 'inspect files',
      isForkPath: false,
      onQueryEvent,
    });

    expect(onQueryEvent.mock.calls.map(([event]) => event.type)).toEqual(
      events.map((event) => event.type),
    );
    expect(order).toEqual(
      events.flatMap((event) => [
        `query:${event.type}`,
        `tracker:${event.type}`,
      ]),
    );
  });

  it('updates unresolved tool IDs incrementally for each transcript event', async () => {
    const appendMessage = vi.fn();
    vi.mocked(runSubagent).mockImplementationOnce(async (params) => {
      params.onEvent?.({
        type: 'assistant',
        uuid: 'assistant-1',
        message: {
          content: [
            { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} },
          ],
        },
      } as never);
      params.onEvent?.({
        type: 'assistant',
        uuid: 'assistant-2',
        message: {
          content: [
            { type: 'tool_use', id: 'tool-2', name: 'Read', input: {} },
          ],
        },
      } as never);
      params.onEvent?.({
        type: 'user',
        uuid: 'user-1',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tool-1', content: '' },
          ],
        },
      } as never);
      params.onEvent?.({
        type: 'system',
        uuid: 'system-1',
        subtype: 'compact_boundary',
      } as never);
      return {
        textContent: '',
        messages: [],
        totalUsage: undefined,
        terminal: { reason: 'end_turn' },
      } as never;
    });
    const context = {
      ...createContext(false),
      taskRegistry: {
        appendMessage,
        flushMessages: vi.fn(),
      },
    } as unknown as AgentLoopContext;

    await runAgent({
      definition: createDefinition(),
      context,
      agentArgs: { query: 'inspect files' },
      tracker: {
        recentActivity: [],
        toolUseCount: 2,
        makeProgress: vi.fn(() => 'progress'),
        handleQueryEvent: vi.fn(),
      } as never,
      signal: new AbortController().signal,
      taskId: 'task-1',
      agentId: 'agent-1',
      outputPath: '',
      description: 'inspect files',
      isForkPath: false,
    });

    expect(appendMessage.mock.calls.map((call) => call[2])).toEqual([
      ['tool-1'],
      ['tool-1', 'tool-2'],
      ['tool-2'],
      ['tool-2'],
    ]);
  });

  it('keeps teammate sidechain frames internal while emitting task lifecycle events', async () => {
    vi.mocked(runSubagent).mockImplementationOnce(async (params) => {
      params.onEvent?.({
        type: 'user',
        message: { role: 'user', content: [] },
      } as never);
      params.onEvent?.({
        type: 'assistant',
        message: { role: 'assistant', content: [] },
      } as never);
      params.onEvent?.({
        type: 'stream_event',
        event: { type: 'content_block_delta' },
      } as never);
      return {
        textContent: 'done',
        messages: [],
        totalUsage: undefined,
        terminal: { reason: 'end_turn' },
      } as never;
    });

    await runAgent({
      definition: createDefinition(),
      context: createContext(false),
      agentArgs: { query: 'inspect files' },
      tracker: {
        recentActivity: [],
        makeProgress: vi.fn(() => 'progress'),
        handleQueryEvent: vi.fn(),
      } as never,
      signal: new AbortController().signal,
      taskId: 'task-1',
      taskType: 'in_process_teammate',
      agentId: 'reviewer@session-1',
      invocationName: 'reviewer',
      teamName: 'session-1',
      outputPath: '',
      description: 'inspect files',
      isForkPath: false,
      parentToolUseId: 'toolu-parent-1',
    });

    const events = drainSubagentSdkEvents('session-1', () => true);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'system',
          subtype: 'task_started',
          task_id: 'task-1',
          task_type: 'in_process_teammate',
        }),
      ]),
    );
    expect(
      events.some(
        (event) =>
          event.type === 'user' ||
          event.type === 'assistant' ||
          event.type === 'stream_event',
      ),
    ).toBe(false);
  });

  it('returns actionable structured details when a subagent reaches maxTurns', async () => {
    vi.mocked(runSubagent).mockResolvedValueOnce({
      textContent: 'partial result',
      messages: [
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'partial result' }],
          },
        },
      ],
      totalUsage: undefined,
      terminal: { reason: 'max_turns' },
    } as never);
    const definition = createDefinition();
    definition.runConfig = {};
    const tracker = {
      recentActivity: [],
      makeProgress: vi.fn(() => 'progress'),
      handleQueryEvent: vi.fn(),
    };

    const result = await runAgent({
      definition,
      context: createContext(false),
      agentArgs: { query: 'inspect files' },
      tracker: tracker as never,
      signal: new AbortController().signal,
      taskId: 'task-1',
      agentId: 'agent-1',
      outputPath: '',
      description: 'inspect files',
      isForkPath: false,
      parentToolUseId: 'toolu-parent-1',
    });

    expect(result).toMatchObject({
      terminateReason: AgentTerminateMode.MAX_TURNS,
      terminationDetails: { maxTurns: 150 },
      toolResult: {
        llmContent: [
          {
            text: expect.stringContaining(
              'Reached the maximum turn limit (150).',
            ),
          },
        ],
        toolUseResult: {
          terminateReason: AgentTerminateMode.MAX_TURNS,
          terminationDetails: { maxTurns: 150 },
        },
      },
    });
    expect(result.toolResult.isError).toBeUndefined();
    expect(result.toolResult.llmContent).toEqual([
      { text: expect.stringContaining('Partial result:') },
    ]);
    expect(tracker.makeProgress).toHaveBeenCalledWith(
      'completed',
      expect.objectContaining({
        terminateReason: AgentTerminateMode.MAX_TURNS,
        terminationDetails: { maxTurns: 150 },
      }),
    );

    const notification = drainSubagentSdkEvents('session-1', () => true).find(
      (event) =>
        event.type === 'system' && event.subtype === 'task_notification',
    );
    expect(notification).toMatchObject({
      status: 'failed',
      summary: expect.stringContaining('Reached the maximum turn limit (150).'),
    });
  });

  it('does not access task records when session persistence is disabled', async () => {
    vi.mocked(runSubagent).mockResolvedValueOnce({
      textContent: 'done',
      messages: [],
      totalUsage: undefined,
      terminal: { reason: 'end_turn' },
    } as never);

    const context = createContext(false);
    await runAgent({
      definition: createDefinition(),
      context,
      agentArgs: { query: 'inspect files' },
      tracker: {
        recentActivity: [],
        makeProgress: vi.fn(() => 'progress'),
        handleQueryEvent: vi.fn(),
      } as never,
      signal: new AbortController().signal,
      taskId: 'task-1',
      agentId: 'agent-1',
      outputPath: '',
      description: 'inspect files',
      isForkPath: false,
    });

    expect(context.config.getSessionPersistence).toHaveBeenCalledTimes(1);
    expect(writeSubagentMetadata).not.toHaveBeenCalled();
    expect(updateAgentTaskRecord).not.toHaveBeenCalled();
    expect(completeAgentTaskRecord).not.toHaveBeenCalled();
  });

  it('does not access task records after a temporary subagent fails', async () => {
    vi.mocked(runSubagent).mockRejectedValueOnce(new Error('subagent failed'));

    await expect(
      runAgent({
        definition: createDefinition(),
        context: createContext(false),
        agentArgs: { query: 'inspect files' },
        tracker: {
          recentActivity: [],
          makeProgress: vi.fn(() => 'progress'),
          handleQueryEvent: vi.fn(),
        } as never,
        signal: new AbortController().signal,
        taskId: 'task-1',
        agentId: 'agent-1',
        outputPath: '',
        description: 'inspect files',
        isForkPath: false,
      }),
    ).rejects.toThrow('subagent failed');

    expect(updateAgentTaskRecord).not.toHaveBeenCalled();
    expect(completeAgentTaskRecord).not.toHaveBeenCalled();
  });

  it('writes the parent Agent tool_use id into subagent metadata', async () => {
    const usage = {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      service_tier: 'standard',
      cache_creation: {
        ephemeral_1h_input_tokens: 0,
        ephemeral_5m_input_tokens: 0,
      },
      inference_geo: '',
      iterations: [],
      speed: 'standard',
    };
    vi.mocked(runSubagent).mockResolvedValueOnce({
      textContent: 'done',
      messages: [],
      totalUsage: usage,
      terminal: {
        reason: 'end_turn',
        numTurns: 1,
        usage,
        durationMs: 10,
      },
    } as never);

    const tracker = {
      recentActivity: [],
      makeProgress: vi.fn(() => 'progress'),
      handleQueryEvent: vi.fn(),
    };

    await runAgent({
      definition: createDefinition(),
      context: createContext(),
      agentArgs: { query: 'inspect files' },
      tracker: tracker as never,
      signal: new AbortController().signal,
      taskId: 'task-1',
      agentId: 'agent-1',
      outputPath: '/tmp/out',
      description: 'inspect files',
      isForkPath: false,
      parentToolUseId: 'toolu-parent-1',
      updateOutput: vi.fn(),
    });

    expect(writeSubagentMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        getProjectRoot: expect.any(Function),
        getSessionId: expect.any(Function),
      }),
      'agent-1',
      expect.objectContaining({
        toolUseId: 'toolu-parent-1',
      }),
    );
    expect(
      vi.mocked(writeSubagentMetadata).mock.calls[0]?.[2],
    ).not.toHaveProperty('parentToolUseId');
  });

  it.each([
    { persistence: true, pendingLayout: false },
    { persistence: false, pendingLayout: false },
    { persistence: true, pendingLayout: true },
  ])(
    'starts query while metadata is pending and ignores late results (%j)',
    async ({ persistence, pendingLayout }) => {
      let resolveGit!: (value: Awaited<ReturnType<typeof readGitHead>>) => void;
      const pendingGit = new Promise<Awaited<ReturnType<typeof readGitHead>>>(
        (resolve) => {
          resolveGit = resolve;
        },
      );
      let resolveLayout!: (
        value: Awaited<ReturnType<typeof resolveGitRepositoryLayout>>,
      ) => void;
      if (pendingLayout) {
        vi.mocked(resolveGitRepositoryLayout).mockReturnValueOnce(
          new Promise((resolve) => {
            resolveLayout = resolve;
          }),
        );
      } else {
        vi.mocked(readGitHead).mockReturnValueOnce(pendingGit);
      }
      vi.mocked(runSubagent).mockResolvedValueOnce({
        textContent: 'done',
        messages: [],
        totalUsage: { input_tokens: 1, output_tokens: 1 },
        terminal: { reason: 'end_turn' },
      } as never);
      const running = runAgent({
        definition: createDefinition(),
        context: createContext(persistence),
        agentArgs: { query: 'inspect files' },
        tracker: {
          recentActivity: [],
          makeProgress: vi.fn(),
          handleQueryEvent: vi.fn(),
        } as never,
        signal: new AbortController().signal,
        taskId: 'task-1',
        agentId: 'agent-1',
        outputPath: '/tmp/out',
        description: 'inspect files',
        isForkPath: false,
      });
      await vi.waitFor(() => expect(runSubagent).toHaveBeenCalledOnce(), {
        timeout: 1000,
      });
      expect(createSubagentTranscriptRecorder).toHaveBeenCalledTimes(
        persistence ? 1 : 0,
      );
      await running;
      expect(
        vi.mocked(resolveGitRepositoryLayout).mock.calls[0]?.[1]?.signal
          ?.aborted,
      ).toBe(true);
      if (pendingLayout) {
        resolveLayout({
          worktreeRoot: '/project',
          gitDir: '/project/.git',
          commonDir: '/project/.git',
          isWorktree: false,
        });
        await Promise.resolve();
        expect(readGitHead).not.toHaveBeenCalled();
      } else {
        resolveGit({ branch: 'late-branch' });
        await pendingGit;
      }
      await Promise.resolve();
      expect(writeSubagentMetadata).toHaveBeenCalledTimes(persistence ? 1 : 0);
    },
  );

  it.each([false, true])(
    'records branch observations without changing task outcome (write failure=%s)',
    async (writeFails) => {
      let resolveGit!: (value: Awaited<ReturnType<typeof readGitHead>>) => void;
      const pendingGit = new Promise<Awaited<ReturnType<typeof readGitHead>>>(
        (resolve) => {
          resolveGit = resolve;
        },
      );
      vi.mocked(readGitHead).mockReturnValueOnce(pendingGit);
      vi.mocked(runSubagent).mockImplementationOnce(async () => {
        resolveGit({ branch: 'observed-branch' });
        await pendingGit;
        if (writeFails)
          vi.mocked(writeSubagentMetadata).mockRejectedValueOnce(
            new Error('disk unavailable'),
          );
        return {
          textContent: 'done',
          messages: [
            {
              type: 'assistant',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'done' }],
              },
            },
          ],
          totalUsage: { input_tokens: 1, output_tokens: 1 },
          terminal: { reason: 'end_turn' },
        } as never;
      });
      const running = runAgent({
        definition: createDefinition(),
        context: createContext(),
        agentArgs: { query: 'inspect files' },
        tracker: {
          recentActivity: [],
          makeProgress: vi.fn(),
          handleQueryEvent: vi.fn(),
        } as never,
        signal: new AbortController().signal,
        taskId: 'task-1',
        agentId: 'agent-1',
        outputPath: '/tmp/out',
        description: 'inspect files',
        isForkPath: false,
      });
      await vi.waitFor(() => expect(runSubagent).toHaveBeenCalledOnce(), {
        timeout: 1000,
      });
      expect(createSubagentTranscriptRecorder).toHaveBeenCalledOnce();
      expect((await running).terminateReason).toBe(AgentTerminateMode.GOAL);
      expect(vi.mocked(readGitHead).mock.calls[0]?.[1]?.signal?.aborted).toBe(
        true,
      );
      resolveGit({ branch: 'late-branch' });
      await pendingGit;
      await Promise.resolve();
      expect(writeSubagentMetadata).toHaveBeenCalledTimes(2);
      expect(
        vi.mocked(writeSubagentMetadata).mock.calls[0][2],
      ).not.toHaveProperty('gitBranchObservation');
      expect(vi.mocked(writeSubagentMetadata).mock.calls[1][2]).toMatchObject({
        gitBranchObservation: {
          branch: 'observed-branch',
          cwd: expect.any(String),
          observedAt: expect.any(String),
        },
      });
      expect(
        vi.mocked(writeSubagentMetadata).mock.calls[1][2].worktreeBranch,
      ).toBeUndefined();
    },
  );

  it('starts the query with unavailable Git metadata and reports startup stages', async () => {
    const logs = vi.spyOn(runLogger, 'log');
    vi.mocked(runSubagent).mockResolvedValueOnce({
      textContent: 'done',
      messages: [
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
          },
        },
      ],
      totalUsage: { input_tokens: 1, output_tokens: 1 },
      terminal: { reason: 'end_turn' },
    } as never);
    try {
      const result = await runAgent({
        definition: createDefinition(),
        context: createContext(),
        agentArgs: { query: 'inspect files' },
        tracker: {
          recentActivity: [],
          makeProgress: vi.fn(),
          handleQueryEvent: vi.fn(),
        } as never,
        signal: new AbortController().signal,
        taskId: 'task-1',
        agentId: 'agent-1',
        outputPath: '/tmp/out',
        description: 'inspect files',
        isForkPath: false,
      });
      expect(result.terminateReason).toBe(AgentTerminateMode.GOAL);
      expect(runSubagent).toHaveBeenCalledOnce();
      expect(readGitHead).toHaveBeenCalledOnce();
      expect(createSubagentTranscriptRecorder).toHaveBeenCalledWith(
        expect.anything(),
        'agent-1',
        'task-1',
        expect.any(Function),
        expect.objectContaining({ gitBranch: undefined }),
      );
      const messages = logs.mock.calls.map(([message]) => String(message));
      for (const stage of [
        'transcript_writer',
        'transcript_metadata',
        'task_record',
        'registries',
        'system_prompt',
        'request',
      ]) {
        const start = messages.findIndex(
          (message) =>
            message.includes('startup.start ') &&
            message.includes(`stage=${stage}`),
        );
        const finish = messages.findIndex(
          (message) =>
            message.includes('startup.finish ') &&
            message.includes(`stage=${stage} `),
        );
        expect(start).toBeGreaterThanOrEqual(0);
        expect(finish).toBeGreaterThan(start);
        expect(messages[finish]).toContain('durationMs=');
      }
      expect(
        messages.some((message) =>
          message.includes('startup.ready agentId=agent-1 taskId=task-1'),
        ),
      ).toBe(true);
    } finally {
      logs.mockRestore();
    }
  });

  it('continues without a transcript when subagent persistence is denied', async () => {
    const updateTask = vi.fn();
    vi.mocked(writeSubagentMetadata).mockRejectedValueOnce(
      Object.assign(new Error('operation not permitted'), { code: 'EPERM' }),
    );
    vi.mocked(runSubagent).mockResolvedValueOnce({
      textContent: 'done',
      messages: [
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
          },
        },
      ],
      totalUsage: { input_tokens: 1, output_tokens: 1 },
      terminal: { reason: 'end_turn' },
    } as never);

    const context = {
      ...createContext(),
      taskRegistry: {
        update: updateTask,
        appendMessage: vi.fn(),
        flushMessages: vi.fn(),
      },
    } as unknown as AgentLoopContext;
    const result = await runAgent({
      definition: createDefinition(),
      context,
      agentArgs: { query: 'inspect files' },
      tracker: {
        recentActivity: [],
        makeProgress: vi.fn(() => 'progress'),
        handleQueryEvent: vi.fn(),
      } as never,
      signal: new AbortController().signal,
      taskId: 'task-1',
      agentId: 'agent-1',
      outputPath: '/tmp/out',
      description: 'inspect files',
      isForkPath: false,
    });

    expect(runSubagent).toHaveBeenCalledOnce();
    expect(result.terminateReason).toBe(AgentTerminateMode.GOAL);
    expect(result.finalResult).toBe('done');
    expect(result.transcriptPath).toBeUndefined();
    expect(updateTask).toHaveBeenCalledWith('a-agent-1', {
      outputPath: undefined,
    });
  });

  it('surfaces non-permission transcript failures', async () => {
    const warn = vi.spyOn(runLogger, 'warn');
    vi.mocked(writeSubagentMetadata).mockRejectedValueOnce(
      Object.assign(new Error('input/output error'), { code: 'EIO' }),
    );

    await expect(
      runAgent({
        definition: createDefinition(),
        context: createContext(),
        agentArgs: { query: 'inspect files' },
        tracker: {
          recentActivity: [],
          makeProgress: vi.fn(() => 'progress'),
          handleQueryEvent: vi.fn(),
        } as never,
        signal: new AbortController().signal,
        taskId: 'task-1',
        agentId: 'agent-1',
        outputPath: '/tmp/out',
        description: 'inspect files',
        isForkPath: false,
      }),
    ).rejects.toThrow('input/output error');
    expect(runSubagent).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /startup.failed .*stage=transcript_metadata durationMs=/,
      ),
    );
    warn.mockRestore();
  });

  it('surfaces a non-permission close failure after metadata access is denied', async () => {
    const closeError = Object.assign(new Error('input/output error'), {
      code: 'EIO',
    });
    vi.mocked(createSubagentTranscriptRecorder).mockResolvedValueOnce({
      recordSidechainMessages: vi.fn(async () => null),
      close: vi.fn().mockRejectedValue(closeError),
    });
    vi.mocked(writeSubagentMetadata).mockRejectedValueOnce(
      Object.assign(new Error('operation not permitted'), { code: 'EPERM' }),
    );

    await expect(
      runAgent({
        definition: createDefinition(),
        context: createContext(),
        agentArgs: { query: 'inspect files' },
        tracker: {
          recentActivity: [],
          makeProgress: vi.fn(() => 'progress'),
          handleQueryEvent: vi.fn(),
        } as never,
        signal: new AbortController().signal,
        taskId: 'task-1',
        agentId: 'agent-1',
        outputPath: '/tmp/out',
        description: 'inspect files',
        isForkPath: false,
      }),
    ).rejects.toBe(closeError);
    expect(runSubagent).not.toHaveBeenCalled();
  });

  it.each(['same-model', 'different-model', 'no-snapshot'] as const)(
    'passes the captured parent selection to ordinary subagents only for the same model (%s)',
    async (mode) => {
      vi.mocked(runSubagent).mockResolvedValueOnce({
        textContent: 'done',
        messages: [],
        terminal: { reason: 'end_turn' },
      } as never);
      const parentSelection = testModelResolution('parent-model', {
        reasoningEffort: 'high',
      });
      const context: AgentLoopContext = {
        ...createContext(),
        getCacheSafeQuerySnapshot: () =>
          mode === 'no-snapshot'
            ? null
            : {
                model: 'parent-model',
                modelResolution: parentSelection,
                forkContextMessages: [],
                toolSchemas: [],
              },
      };
      const model = mode === 'different-model' ? 'child-model' : 'parent-model';
      await runAgent({
        definition: createDefinition(),
        context,
        agentArgs: { query: 'inspect files' },
        tracker: {
          recentActivity: [],
          makeProgress: vi.fn(() => 'progress'),
          handleQueryEvent: vi.fn(),
        } as never,
        signal: new AbortController().signal,
        taskId: 'task-parent-selection',
        agentId: 'agent-parent-selection',
        outputPath: '/tmp/out',
        description: 'inspect files',
        isForkPath: false,
        resolvedModel: model,
      });
      expect(runSubagent).toHaveBeenCalledOnce();
      const options = vi.mocked(runSubagent).mock.calls[0]![0];
      expect(options.model).toBe(model);
      expect(options.parentSelection).toBe(
        mode === 'same-model' ? parentSelection : undefined,
      );
      expect(options).not.toHaveProperty('modelResolution');
    },
  );

  it('passes modelOverride to runSubagent as-is', async () => {
    vi.mocked(runSubagent).mockResolvedValueOnce({
      textContent: 'done',
      messages: [
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
          },
        },
      ],
      totalUsage: undefined,
      terminal: { reason: 'end_turn' },
    } as never);
    const context = createContext();

    await runAgent({
      definition: createDefinition(),
      context,
      agentArgs: { query: 'inspect files' },
      tracker: {
        recentActivity: [],
        makeProgress: vi.fn(() => 'progress'),
        handleQueryEvent: vi.fn(),
      } as never,
      signal: new AbortController().signal,
      taskId: 'task-1',
      agentId: 'agent-1',
      outputPath: '/tmp/out',
      description: 'inspect files',
      isForkPath: false,
      modelOverride: 'workflow-model-alias',
      cwdOverride: '/subagent-workdir',
    });

    expect(runSubagent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'workflow-model-alias',
        attachmentCtx: expect.objectContaining({ cwd: '/subagent-workdir' }),
      }),
    );
    expect(buildSubagentSystemPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      context,
      'workflow-model-alias',
    );
  });

  it('keeps the launching task separate from synthetic subagent context', async () => {
    vi.mocked(runSubagent).mockResolvedValueOnce({
      textContent: 'done',
      messages: [],
      totalUsage: undefined,
      terminal: { reason: 'end_turn' },
    } as never);
    const context = createContext(false);
    vi.mocked(context.config.getSystemInstructionMemory).mockReturnValue(
      'project instructions',
    );
    vi.mocked(context.config.getSessionMemory).mockReturnValue(
      'session instructions',
    );

    await runAgent({
      definition: createDefinition(),
      context,
      agentArgs: { query: 'inspect only the requested file' },
      tracker: {
        recentActivity: [],
        makeProgress: vi.fn(() => 'progress'),
        handleQueryEvent: vi.fn(),
      } as never,
      signal: new AbortController().signal,
      taskId: 'task-1',
      agentId: 'agent-1',
      outputPath: '',
      description: 'inspect files',
      isForkPath: false,
      cwdOverride: '/subagent-workdir',
    });

    const call = vi.mocked(runSubagent).mock.calls[0]?.[0];
    expect(call?.prompt).toBe('inspect only the requested file');
    expect(call?.contextMessages).toHaveLength(3);
    expect(
      call?.contextMessages?.map((message) =>
        message.type === 'user' ? message.message.content : undefined,
      ),
    ).toEqual([
      expect.stringContaining('project instructions'),
      'session instructions',
      '<working_directory>/subagent-workdir</working_directory>',
    ]);
    expect(
      call?.contextMessages?.every((message) => message.isMeta === true),
    ).toBe(true);
  });

  it('omits instruction memory by definition flag rather than reserved agent name', async () => {
    vi.mocked(runSubagent).mockResolvedValue({
      textContent: 'done',
      messages: [],
      totalUsage: undefined,
      terminal: { reason: 'end_turn' },
    } as never);
    const context = createContext(false);
    vi.mocked(context.config.getSystemInstructionMemory).mockReturnValue(
      'project instructions',
    );
    vi.mocked(context.config.getSessionMemory).mockReturnValue(
      'session instructions',
    );
    const common = {
      context,
      agentArgs: { query: 'inspect files' },
      tracker: {
        recentActivity: [],
        makeProgress: vi.fn(() => 'progress'),
        handleQueryEvent: vi.fn(),
      } as never,
      signal: new AbortController().signal,
      taskId: 'task-1',
      agentId: 'agent-1',
      outputPath: '',
      description: 'inspect files',
      isForkPath: false,
      cwdOverride: '/subagent-workdir',
    };

    await runAgent({
      ...common,
      definition: { ...createDefinition(), name: 'Explore' },
    });
    expect(
      vi.mocked(runSubagent).mock.calls[0]?.[0].contextMessages,
    ).toHaveLength(3);

    vi.mocked(runSubagent).mockClear();
    await runAgent({
      ...common,
      taskId: 'task-2',
      agentId: 'agent-2',
      definition: {
        ...createDefinition(),
        name: 'custom-read-only',
        omitAgentsMd: true,
      },
    });
    const contextMessages =
      vi.mocked(runSubagent).mock.calls[0]?.[0].contextMessages;
    expect(contextMessages).toHaveLength(1);
    expect(contextMessages?.[0]).toMatchObject({
      type: 'user',
      isMeta: true,
      message: {
        content: '<working_directory>/subagent-workdir</working_directory>',
      },
    });
  });

  it('keeps the caller Agent allowlist instead of applying the child definition allowlist', async () => {
    const setAllowedAgentTypes = vi.fn();
    vi.mocked(buildSubagentRegistries).mockResolvedValueOnce({
      toolRegistry: {
        getTool: vi.fn(() => ({ setAllowedAgentTypes })),
        getAllToolNames: vi.fn(() => ['Agent']),
        dispose: vi.fn(),
      },
      promptRegistry: {},
      resourceRegistry: {},
    } as never);
    vi.mocked(runSubagent).mockResolvedValueOnce({
      textContent: 'done',
      messages: [],
      totalUsage: undefined,
      terminal: { reason: 'end_turn' },
    } as never);

    await runAgent({
      definition: createDefinition(),
      context: createContext(false),
      agentArgs: { query: 'inspect files' },
      tracker: {
        recentActivity: [],
        makeProgress: vi.fn(() => 'progress'),
        handleQueryEvent: vi.fn(),
      } as never,
      signal: new AbortController().signal,
      taskId: 'task-agent-allowlist',
      agentId: 'agent-allowlist',
      outputPath: '',
      description: 'inspect files',
      isForkPath: false,
    });

    expect(setAllowedAgentTypes).not.toHaveBeenCalled();
  });

  it('preloads each configured skill as a separate synthetic context message', async () => {
    vi.mocked(runSubagent).mockResolvedValueOnce({
      textContent: 'done',
      messages: [],
      totalUsage: undefined,
      terminal: { reason: 'end_turn' },
    } as never);
    vi.mocked(prepareSkillBody).mockResolvedValueOnce('review instructions');
    const context = createContext(false);
    const workspaceContext = context.config.getWorkspaceContext();
    vi.mocked(context.config.getWorkspaceContext).mockReturnValue(
      workspaceContext,
    );
    vi.mocked(context.config.getSkillManager).mockReturnValue({
      getSkill: vi.fn(() => ({
        name: 'review',
        description: 'Review changes',
        location: '/skills/review/SKILL.md',
        skillRoot: '/skills/review',
      })),
    } as never);
    const definition = {
      ...createDefinition(),
      skills: ['review'],
    };

    await runAgent({
      definition,
      context,
      agentArgs: { query: 'review the change' },
      tracker: {
        recentActivity: [],
        makeProgress: vi.fn(() => 'progress'),
        handleQueryEvent: vi.fn(),
      } as never,
      signal: new AbortController().signal,
      taskId: 'task-1',
      agentId: 'agent-1',
      outputPath: '',
      description: 'review files',
      isForkPath: false,
    });

    const call = vi.mocked(runSubagent).mock.calls[0]?.[0];
    expect(call?.prompt).toBe('review the change');
    expect(call?.contextMessages).toHaveLength(1);
    expect(call?.contextMessages?.[0]).toMatchObject({
      type: 'user',
      isMeta: true,
      message: {
        role: 'user',
        content:
          '<skill-name>review</skill-name>\n\nBase directory for this skill: /skills/review\n\nreview instructions',
      },
    });
    expect(workspaceContext.addDirectory).not.toHaveBeenCalled();
    expect(workspaceContext.addReadOnlyPath).not.toHaveBeenCalled();
    expect(prepareSkillBody).toHaveBeenCalledWith(
      context.config,
      expect.objectContaining({ skillRoot: '/skills/review' }),
      'review',
      '/skills/review',
      '',
      expect.any(Function),
      { toolNames: ['Read', 'Bash'] },
    );
    expect(buildSkillPromptContent).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'review', skillRoot: '/skills/review' }),
      'review instructions',
    );
  });

  it.each([
    { childTools: ['Read'], guideAllowed: true, showsGuide: false },
    { childTools: ['Read', 'Skill'], guideAllowed: true, showsGuide: true },
    { childTools: ['Read', 'Skill'], guideAllowed: false, showsGuide: false },
  ])(
    'preloaded Workflow respects child tools $childTools and guide eligibility $guideAllowed',
    async ({ childTools, guideAllowed, showsGuide }) => {
      const actual = await vi.importActual<
        typeof import('../skills/inlineSkillActivation.js')
      >('../skills/inlineSkillActivation.js');
      vi.mocked(prepareSkillBody).mockImplementationOnce(
        actual.prepareSkillBody,
      );
      vi.mocked(runSubagent).mockResolvedValueOnce({
        textContent: 'done',
        messages: [],
        totalUsage: undefined,
        terminal: { reason: 'end_turn' },
      } as never);
      const context = createContext(false);
      const manager = new SkillManager();
      Object.assign(context.config, {
        isWorkflowsEnabled: () => true,
        getToolRegistry: () => ({
          getFunctionDeclarations: () => [
            { name: 'Read' },
            { name: 'Workflow' },
            { name: 'Skill' },
          ],
        }),
      });
      vi.mocked(context.config.getSkillManager).mockReturnValue(manager);
      manager.addSkills([
        workflowToSkill(
          {
            name: 'audit',
            description: 'Audit the repository',
            source: 'project',
            scriptPath: '/project/audit.js',
          },
          context.config,
        ),
        {
          name: 'workflow-authoring',
          description: 'Author workflow scripts',
          location: 'bundled',
          skillRoot: '/skills/workflow-authoring',
          body: '',
        },
      ]);
      if (!guideAllowed) manager.setSessionSkillAllowlist(['audit']);
      const definition = { ...createDefinition(), skills: ['audit'] };
      const registries = await buildSubagentRegistries(
        definition,
        context,
        'fixture',
      );
      const childRegistry = registries.toolRegistry;
      vi.mocked(childRegistry.getAllToolNames).mockReturnValue(childTools);
      vi.mocked(buildSubagentRegistries).mockResolvedValueOnce({
        ...registries,
        toolRegistry: childRegistry,
        schedulerContext: { ...context, toolRegistry: childRegistry },
      });

      await runAgent({
        definition,
        context,
        agentArgs: { query: 'audit the repository' },
        tracker: {
          recentActivity: [],
          makeProgress: vi.fn(() => 'progress'),
          handleQueryEvent: vi.fn(),
        } as never,
        signal: new AbortController().signal,
        taskId: 'preload-task',
        agentId: 'preload-agent',
        outputPath: '',
        description: 'audit',
        isForkPath: false,
      });

      const messages =
        vi.mocked(runSubagent).mock.calls[0]?.[0].contextMessages;
      expect(messages).toHaveLength(1);
      const message = messages?.[0];
      expect(message).toMatchObject({ type: 'user', isMeta: true });
      const content =
        message?.type === 'user' ? message.message.content : undefined;
      expect(content).toContain('Run the "audit" workflow.');
      const guideHint =
        'If the user asks you to modify this workflow or write a new script, load the `workflow-authoring` skill first.';
      if (showsGuide) {
        expect(content).toContain(guideHint);
      } else {
        expect(content).not.toContain(guideHint);
      }
      expect(prepareSkillBody).toHaveBeenCalledWith(
        context.config,
        expect.objectContaining({ name: 'audit' }),
        'audit',
        '/project',
        '',
        expect.any(Function),
        { toolNames: childTools },
      );
    },
  );

  it('checks a preloaded Skill shell against the resolved child constraints before inference', async () => {
    const actual = await vi.importActual<
      typeof import('../skills/inlineSkillActivation.js')
    >('../skills/inlineSkillActivation.js');
    vi.mocked(prepareSkillBody).mockImplementationOnce(actual.prepareSkillBody);
    const context = createContext(false);
    Object.assign(context.config, {
      isWorkflowsEnabled: () => true,
      isSkillShellExecutionDisabled: () => false,
    });
    vi.mocked(context.config.getSkillManager).mockReturnValue({
      getSkill: () => ({
        name: 'review',
        description: 'Review',
        location: '/skills/review/SKILL.md',
        skillRoot: '/skills/review',
        body: 'Result: !`printf should-not-execute`',
        allowedTools: ['Bash'],
      }),
    } as never);
    const permission = createPermissionManager({
      cwd: '/tmp',
      permissionMode: 'yolo',
      checkerDeps: {
        skill: {
          isAllowedForMainSession: () => true,
          isDisabled: () => false,
          hasOnlySafeProperties: () => false,
        },
        mcpCall: { isKnownTool: () => false, parseQualifiedName: () => ({}) },
      },
    });
    const definition = { ...createDefinition(), skills: ['review'] };
    const registries = await buildSubagentRegistries(
      definition,
      context,
      'fixture',
    );
    vi.mocked(buildSubagentRegistries).mockResolvedValueOnce({
      ...registries,
      schedulerContext: {
        ...context,
        toolRegistry: registries.toolRegistry,
        permission: constrainAgentPermissions(permission, [], ['Bash(git:*)']),
      },
    });
    await expect(
      runAgent({
        definition,
        context,
        agentArgs: { query: 'review' },
        tracker: {
          recentActivity: [],
          makeProgress: vi.fn(() => 'progress'),
          handleQueryEvent: vi.fn(),
        } as never,
        signal: new AbortController().signal,
        taskId: 'preload-task',
        agentId: 'preload-agent',
        outputPath: '',
        description: 'review',
        isForkPath: false,
        toolConstraints: { bashCommandClamp: ['Bash(git:*)'] },
      }),
    ).rejects.toThrow('permission denied');
    expect(runSubagent).not.toHaveBeenCalled();
  });

  it('does not preload a disabled configured skill', async () => {
    vi.mocked(runSubagent).mockResolvedValueOnce({
      textContent: 'done',
      messages: [],
      totalUsage: undefined,
      terminal: { reason: 'end_turn' },
    } as never);
    const context = createContext(false);
    const blockedSkill = {
      name: 'review',
      description: 'Review changes',
      location: '/skills/review/SKILL.md',
      skillRoot: '/skills/review',
      disabled: true,
    };
    vi.mocked(context.config.getSkillManager).mockReturnValue({
      getSkill: vi.fn(() => blockedSkill),
    } as never);

    await runAgent({
      definition: { ...createDefinition(), skills: ['review'] },
      context,
      agentArgs: { query: 'review the change' },
      tracker: {
        recentActivity: [],
        makeProgress: vi.fn(() => 'progress'),
        handleQueryEvent: vi.fn(),
      } as never,
      signal: new AbortController().signal,
      taskId: 'task-disabled-skill',
      agentId: 'agent-disabled-skill',
      outputPath: '',
      description: 'review files',
      isForkPath: false,
    });

    const call = vi.mocked(runSubagent).mock.calls[0]?.[0];
    expect(call?.contextMessages).toEqual([]);
    expect(prepareSkillBody).not.toHaveBeenCalled();
  });

  it('returns aggregate token and tool call usage from the subagent transcript', async () => {
    const usage = {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 3,
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      service_tier: 'standard',
      cache_creation: {
        ephemeral_1h_input_tokens: 0,
        ephemeral_5m_input_tokens: 0,
      },
      inference_geo: '',
      iterations: [],
      speed: 'standard',
    };
    vi.mocked(runSubagent).mockResolvedValueOnce({
      textContent: 'done',
      messages: [
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu-1',
                name: 'Read',
                input: { file_path: 'package.json' },
              },
            ],
          },
        },
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
          },
        },
      ],
      totalUsage: usage,
      modelRequestIds: ['request-subagent-1'],
      credits: 1.25,
      terminal: {
        reason: 'end_turn',
        numTurns: 1,
        usage,
        durationMs: 10,
        requestSetId: 'request-set-child',
      },
    } as never);

    const tracker = {
      recentActivity: [],
      makeProgress: vi.fn(() => 'progress'),
      handleQueryEvent: vi.fn(),
    };

    const result = await runAgent({
      definition: createDefinition(),
      context: createContext(),
      agentArgs: { query: 'inspect files' },
      tracker: tracker as never,
      signal: new AbortController().signal,
      taskId: 'task-1',
      agentId: 'agent-1',
      outputPath: '/tmp/out',
      description: 'inspect files',
      isForkPath: false,
      parentToolUseId: 'toolu-parent-1',
      parentRequestSetId: 'request-set-parent',
      ownerAgentId: 'owner-agent-1',
      runInBackground: false,
      internalExecutionOwner: {
        kind: 'workflow-agent',
        workflowRunId: 'workflow-run-1',
        workflowExecutionId: 'workflow-execution-1',
        workflowAgentIndex: 2,
        workflowPhaseIndex: 1,
        workflowAttempt: 2,
        suppressMainSessionNotification: true,
        disableShellAutoBackground: true,
      },
      updateOutput: vi.fn(),
    });

    expect(result.totalTokens).toBe(20);
    expect(result.toolCalls).toBe(1);
  });

  it.each(
    [
      { markedAsApiError: true, expectedApiError: 'provider unavailable' },
      { markedAsApiError: false, expectedApiError: undefined },
    ].flatMap((testCase) =>
      [false, true].map((isForkPath) => ({ ...testCase, isForkPath })),
    ),
  )(
    'preserves terminal failures through hooks and model projection (API: $markedAsApiError, fork: $isForkPath)',
    async ({ markedAsApiError, expectedApiError, isForkPath }) => {
      const modelContent =
        'Agent did not complete its task (ERROR).\n\nprovider unavailable';
      const usage = {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
        service_tier: 'standard',
        cache_creation: {
          ephemeral_1h_input_tokens: 0,
          ephemeral_5m_input_tokens: 0,
        },
        inference_geo: '',
        iterations: [],
        speed: 'standard',
      };
      const run = isForkPath ? mockRunForkedAgent : vi.mocked(runSubagent);
      run.mockResolvedValueOnce({
        textContent: 'provider unavailable',
        messages: [
          {
            type: 'assistant',
            isApiErrorMessage: markedAsApiError,
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'provider unavailable' }],
            },
          },
        ],
        totalUsage: usage,
        terminal: {
          reason: 'error',
          error: new Error('provider unavailable'),
          numTurns: 1,
          usage,
          durationMs: 10,
        },
      } as never);

      const context = createContext();
      const tracker = {
        recentActivity: [],
        makeProgress: vi.fn(() => 'progress'),
        handleQueryEvent: vi.fn(),
      };
      const result = await runAgent({
        definition: createDefinition(),
        context,
        agentArgs: { query: 'inspect files' },
        tracker: tracker as never,
        signal: new AbortController().signal,
        taskId: 'task-1',
        agentId: 'agent-1',
        outputPath: '/tmp/out',
        description: 'inspect files',
        isForkPath,
      });

      expect(result.terminateReason).toBe(AgentTerminateMode.ERROR);
      expect(result.apiError).toBe(expectedApiError);
      expect(result.toolResult.isError).toBe(true);
      expect(result.toolResult.error).toBeUndefined();
      expect(tracker.makeProgress).toHaveBeenLastCalledWith(
        'error',
        expect.objectContaining({
          result: 'provider unavailable',
          terminateReason: AgentTerminateMode.ERROR,
        }),
      );
      expect(result.toolResult.toolUseResult).toMatchObject({
        state: 'error',
        ...(expectedApiError ? { apiError: expectedApiError } : {}),
      });
      if (!expectedApiError) {
        expect(result.toolResult.toolUseResult).not.toHaveProperty('apiError');
      }

      const failureHook = vi.fn().mockResolvedValue(undefined);
      const successHook = vi.fn();
      Object.assign(context.config, {
        getShellExecutionConfig: () => ({}),
        getFileHistoryManager: () => undefined,
        getHookSystem: () => ({
          firePostToolUseFailureEvent: failureHook,
          firePostToolUseEvent: successHook,
        }),
      });
      const tool = new MockTool({
        name: 'Agent',
        execute: async () => result.toolResult,
      });
      const invocation = tool.build({});
      const request = {
        callId: 'agent-call',
        name: 'Agent',
        args: {},
        prompt_id: 'prompt-1',
      };
      const output = await new LocalToolCallExecutor(context).execute({
        call: {
          status: CoreToolCallStatus.Scheduled,
          request,
          tool,
          invocation,
        },
        signal: new AbortController().signal,
        onUpdateToolCall: vi.fn(),
      });
      expect(output.result.error).toBeUndefined();
      expect(output.result.llmContent).toEqual(result.toolResult.llmContent);
      expect(failureHook).toHaveBeenCalledTimes(1);
      expect(failureHook.mock.calls[0].slice(0, 4)).toEqual([
        'Agent',
        {},
        modelContent,
        'agent-call',
      ]);
      expect(successHook).not.toHaveBeenCalled();
      const completed = convertToolResultToCompletedToolCall(
        {
          request,
          tool,
          invocation,
          result: output.result,
          error: undefined,
          cancelled: false,
          durationMs: 1,
        },
        'root',
        undefined,
      );
      expect(completedToolCallToResult(completed)).toMatchObject({
        content: modelContent,
        is_error: true,
        toolUseResult: { state: 'error', outputPath: '/tmp/out' },
      });
    },
  );

  it('marks timeouts as semantic failures and reports error progress', async () => {
    const timeout = new AbortController();
    const timeoutSpy = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(timeout.signal);
    vi.mocked(runSubagent).mockImplementationOnce(async () => {
      timeout.abort();
      throw Object.assign(new Error('timed out'), { name: 'AbortError' });
    });
    const tracker = {
      recentActivity: [],
      makeProgress: vi.fn(() => 'progress'),
      handleQueryEvent: vi.fn(),
    };
    try {
      const result = await runAgent({
        definition: createDefinition(),
        context: createContext(),
        agentArgs: { query: 'inspect files' },
        tracker: tracker as never,
        signal: new AbortController().signal,
        taskId: 'timeout-task',
        agentId: 'timeout-agent',
        outputPath: '/tmp/partial-output',
        description: 'inspect files',
        isForkPath: false,
      });
      expect(result.terminateReason).toBe(AgentTerminateMode.TIMEOUT);
      expect(result.toolResult).toMatchObject({
        isError: true,
        llmContent: [
          {
            text: 'Agent did not complete its task (TIMEOUT).\n\nAgent timed out.',
          },
        ],
        toolUseResult: { state: 'error', outputPath: '/tmp/partial-output' },
      });
      expect(tracker.makeProgress).toHaveBeenLastCalledWith(
        'error',
        expect.objectContaining({
          terminateReason: AgentTerminateMode.TIMEOUT,
        }),
      );
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('includes a terminal error alongside an existing partial report', async () => {
    const partialReport =
      'Found relevant files: src/a.ts. Still need to inspect callers.';
    const errorMessage = 'The usage limit has been reached.';
    vi.mocked(runSubagent).mockResolvedValueOnce({
      messages: [
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: partialReport }],
          },
        },
      ],
      terminal: { reason: 'error', error: new Error(errorMessage) },
    } as never);
    const result = await runAgent({
      definition: createDefinition(),
      context: createContext(),
      agentArgs: { query: 'inspect files' },
      tracker: {
        recentActivity: [],
        makeProgress: vi.fn(() => 'progress'),
        handleQueryEvent: vi.fn(),
      } as never,
      signal: new AbortController().signal,
      taskId: 'partial-task',
      agentId: 'partial-agent',
      outputPath: '/tmp/partial-output',
      description: 'inspect files',
      isForkPath: false,
    });
    expect(result.toolResult).toMatchObject({
      isError: true,
      llmContent: [
        {
          text: `Agent did not complete its task (ERROR).\n\nError: ${errorMessage}\n\n${partialReport}`,
        },
      ],
      toolUseResult: { state: 'error', outputPath: '/tmp/partial-output' },
    });
  });

  it.each([true, false])(
    'uses the registered fork model without forwarding it (registered=%s)',
    async (registered) => {
      const context = createContext(false);
      if (registered) {
        context.config.taskRegistry = new TaskRegistry();
        context.config.taskRegistry.register({
          id: 'a-agent-1',
          agentId: 'agent-1',
          agentName: 'fork',
          agentType: 'fork',
          resolvedModel: 'child-model',
          type: 'local_agent',
          status: 'running',
          description: 'Fork',
          startTime: 0,
          notified: false,
          executionId: 1,
          completionBehavior: 'silent',
          prompt: 'Inspect',
          isBackgrounded: false,
          taskId: 'task-1',
        });
      }
      await runAgent({
        definition: {
          ...createDefinition(),
          name: 'fork',
          pinToParentModel: true,
        },
        context,
        agentArgs: { query: 'inspect files' },
        tracker: {
          recentActivity: [],
          makeProgress: vi.fn(() => 'progress'),
        } as never,
        signal: new AbortController().signal,
        taskId: 'task-1',
        agentId: 'agent-1',
        outputPath: '/tmp/out',
        description: 'Inspect',
        isForkPath: true,
        resolvedModel: 'child-model',
      });
      expect(mockRunForkedAgent).toHaveBeenCalledOnce();
      expect(
        mockRunForkedAgent.mock.calls[0][0].parentSelection,
      ).toBeUndefined();
      expect(mockRunForkedAgent.mock.calls[0][0].model).toBe(
        registered ? undefined : 'child-model',
      );
    },
  );

  it('does not persist parent conversation history into fork sidechain transcripts', async () => {
    const tracker = {
      recentActivity: [],
      makeProgress: vi.fn(() => 'progress'),
    };

    const result = await runAgent({
      definition: createDefinition(),
      context: createContext(),
      agentArgs: { query: 'inspect files' },
      tracker: tracker as never,
      signal: new AbortController().signal,
      taskId: 'task-1',
      agentId: 'agent-1',
      outputPath: '/tmp/out',
      description: 'inspect files',
      isForkPath: true,
      parentToolUseId: 'toolu-parent-1',
      customContext: { tenant: 'pds' },
    });

    expect(mockRunForkedAgent).toHaveBeenCalledTimes(1);
    const params = mockRunForkedAgent.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(params['forkContextMessages']).toBeDefined();
    expect(params['parentSelection']).toBeUndefined();
    expect(params['modelResolution']).toBeUndefined();
    expect(params['generation']).toBeUndefined();
    expect(params['contextWindow']).toBeUndefined();
    expect(params['prompt']).toBe('wrapped fork directive: inspect files');
    expect(params['initialTranscriptMessages']).toBeUndefined();
    expect(params['maxTurns']).toBe(200);
    expect(params['agentType']).toBe('explore');
    expect(params['customContext']).toEqual({ tenant: 'pds' });
    expect(params['attachmentCtx']).toMatchObject({
      agentId: 'agent-1',
      cwd: process.cwd(),
      isMainAgent: false,
      pendingHookOutputs: [],
      pendingHookAttachments: [],
    });
    expect(runWithAgentContext).toHaveBeenCalledWith(
      {
        agentId: 'agent-1',
        agentType: 'explore',
        agentName: 'explore',
        teamName: undefined,
      },
      expect.any(Function),
    );
    expect(result.terminateReason).toBe(AgentTerminateMode.GOAL);
  });

  it.each([true, false])(
    'passes cache-safe model, reads and environment to forks (snapshot has baselines=%s)',
    async (hasSnapshotReads) => {
      const setQuerySource = vi.fn();
      vi.mocked(buildSubagentRegistries).mockResolvedValueOnce({
        toolRegistry: {
          getTool: vi.fn((name: string) =>
            name === 'Agent' ? { setQuerySource } : undefined,
          ),
          getAllToolNames: vi.fn(() => ['Agent', 'Read']),
          dispose: vi.fn(),
        },
        promptRegistry: {},
        resourceRegistry: {},
      } as never);
      const snapshotAttachment = new EnvironmentAttachment({
        type: 'environment',
        snapshot: {
          workingDirectory: '/parent',
          additionalWorkingDirectories: [],
          isWorktree: false,
          isGitRepo: true,
          platform: 'darwin',
          shell: '/bin/zsh',
          osVersion: '24.0.0',
          architecture: 'arm64',
          nodeVersion: 'v22.0.0',
        },
      });
      const snapshotEnvironment = createAttachmentMessage(snapshotAttachment);
      const liveEnvironment = createAttachmentMessage(
        new EnvironmentAttachment({
          type: 'environment',
          snapshot: {
            ...snapshotAttachment.snapshot,
            workingDirectory: '/late',
          },
        }),
      );
      const snapshotGit = createAttachmentMessage(
        new SessionContextAttachment({
          type: 'session_context',
          context: { gitStatus: 'parent Git snapshot' },
          changed: true,
          reason: 'compaction',
        }),
      );
      const liveGit = createAttachmentMessage(
        new SessionContextAttachment({
          type: 'session_context',
          context: { gitStatus: 'later unseen Git snapshot' },
        }),
      );

      const forkContextMessages = [
        ...buildForkContextMessages([snapshotEnvironment, snapshotGit]),
        {
          role: 'user',
          content: [{ type: 'text', text: 'direct caller history' }],
        },
      ];
      const toolSchemas = [{ name: 'DirectCallerTool' }];
      const snapshotReads = createToolFileStateCache();
      snapshotReads.set('/tmp/visible.txt', {
        content: 'visible',
        timestamp: 1,
        offset: 1,
        limit: undefined,
      });
      const liveReads = createToolFileStateCache();
      liveReads.set('/tmp/late.txt', {
        content: 'unseen',
        timestamp: 2,
        offset: 1,
        limit: undefined,
      });
      const context = {
        ...createContext(),
        fileReadState: liveReads,
        getConversationMessages: () => [liveEnvironment, liveGit],
        getCacheSafeQuerySnapshot: vi.fn(() => ({
          fileReadState: hasSnapshotReads ? snapshotReads : undefined,
          systemPrompt: [
            { type: 'text' as const, text: 'stable parent prompt' },
            { type: 'text' as const, text: 'dynamic parent prompt' },
          ],
          forkContextMessages,
          contextAttachmentMessages: hasSnapshotReads
            ? [snapshotEnvironment, snapshotGit]
            : undefined,
          model: 'policy-direct-model',
          modelResolution: testModelResolution('policy-direct-model'),
          toolSchemas,
          generation: { temperature: 0.7, topK: 20 },
          contextWindow: 256_000,
        })),
      } as unknown as AgentLoopContext;

      await runAgent({
        // isForkPath 只会配 FORK_AGENT，而它带 pinToParentModel——复用 parent 的
        // 模型解析结果正是以此为前提。
        definition: { ...createDefinition(), pinToParentModel: true },
        context,
        agentArgs: { query: 'inspect files' },
        tracker: {
          recentActivity: [],
          makeProgress: vi.fn(() => 'progress'),
        } as never,
        signal: new AbortController().signal,
        taskId: 'task-1',
        agentId: 'agent-1',
        outputPath: '/tmp/out',
        description: 'inspect files',
        isForkPath: true,
        parentToolUseId: 'toolu-parent-1',
      });

      expect(mockRunForkedAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'policy-direct-model',
          systemPrompt: [
            { type: 'text', text: 'stable parent prompt' },
            { type: 'text', text: 'dynamic parent prompt' },
          ],
          forkContextMessages,
          contextAttachmentMessages: hasSnapshotReads
            ? [snapshotEnvironment, snapshotGit]
            : undefined,
          generation: { temperature: 0.7, topK: 20 },
          contextWindow: 256_000,
        }),
      );
      const forkParams = mockRunForkedAgent.mock.calls[0][0];
      expect(forkParams.parentSelection).toEqual(
        context.getCacheSafeQuerySnapshot!()!.modelResolution,
      );
      expect(forkParams).not.toHaveProperty('modelResolution');
      const inherited =
        mockRunForkedAgent.mock.calls[0][0].attachmentCtx!.fileReadState;
      expect(inherited.has('/tmp/late.txt')).toBe(false);
      expect(inherited.get('/tmp/visible.txt')?.content).toBe(
        hasSnapshotReads ? 'visible' : undefined,
      );
      expect(inherited).not.toBe(snapshotReads);
      expect(inherited.get('/tmp/visible.txt')).not.toBe(
        snapshotReads.get('/tmp/visible.txt'),
      );
      expect(setQuerySource).toHaveBeenCalledWith('fork-query');
    },
  );

  it('pairs a cross-model fork projection with that runtime history context baseline', async () => {
    const parentBaseline = createAttachmentMessage(
      new SessionContextAttachment({
        type: 'session_context',
        context: { gitStatus: 'runtime projection baseline' },
      }),
    );
    const snapshotBaseline = createAttachmentMessage(
      new SessionContextAttachment({
        type: 'session_context',
        context: { gitStatus: 'other-model snapshot baseline' },
      }),
    );
    const parentMessages = [parentBaseline, createUserMessage('fork history')];
    const context = {
      ...createContext(),
      getConversationMessages: () => parentMessages,
      getCacheSafeQuerySnapshot: () => ({
        model: 'parent-model',
        modelResolution: testModelResolution('parent-model'),
        forkContextMessages: [{ role: 'user', content: 'other-model prefix' }],
        contextAttachmentMessages: [snapshotBaseline],
        toolSchemas: [],
      }),
    } as unknown as AgentLoopContext;
    await runAgent({
      definition: createDefinition(),
      context,
      resolvedModel: 'different-model',
      agentArgs: { query: 'inspect files' },
      tracker: {
        recentActivity: [],
        makeProgress: vi.fn(() => 'progress'),
      } as never,
      signal: new AbortController().signal,
      taskId: 'cross-model-task',
      agentId: 'cross-model-agent',
      outputPath: '/tmp/out',
      description: 'inspect files',
      isForkPath: true,
      parentToolUseId: 'toolu-parent-1',
    });
    expect(buildForkContextMessages).toHaveBeenCalledWith(
      parentMessages,
      undefined,
      expect.objectContaining({ targetModel: 'different-model' }),
    );
    expect(mockRunForkedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'different-model',
        contextAttachmentMessages: [parentBaseline],
      }),
    );
  });

  it('ignores an explicit model override and keeps the parent model for forks', async () => {
    const context = {
      ...createContext(),
      getCacheSafeQuerySnapshot: vi.fn(() => ({
        systemPrompt: [{ type: 'text' as const, text: 'parent system prompt' }],
        forkContextMessages: [],
        model: 'policy-direct-model',
        modelResolution: testModelResolution('policy-direct-model'),
        toolSchemas: [],
      })),
    } as unknown as AgentLoopContext;

    vi.mocked(context.config.getHookSystem).mockReturnValue({
      fireSubagentStartEvent: vi.fn(async () => {
        vi.mocked(context.config.getModel).mockReturnValue('gateway/new-model');
        context.config.getModelProviderManager().setMainModel(
          {
            ...testModelResolution('gateway/new-model').model,
            source: 'gateway',
          },
          false,
        );
        return undefined;
      }),
    } as never);

    await runAgent({
      // FORK_AGENT carries pinToParentModel; the fork path always runs it.
      definition: { ...createDefinition(), pinToParentModel: true },
      context,
      agentArgs: { query: 'inspect files' },
      tracker: {
        recentActivity: [],
        makeProgress: vi.fn(() => 'progress'),
      } as never,
      signal: new AbortController().signal,
      taskId: 'task-1',
      agentId: 'agent-1',
      outputPath: '/tmp/out',
      description: 'inspect files',
      isForkPath: true,
      parentToolUseId: 'toolu-parent-1',
      modelOverride: 'explicit-model-alias',
    });

    expect(context.config.getModel()).toBe('gateway/new-model');
    expect(mockRunForkedAgent.mock.calls[0][0].parentSelection).toEqual(
      context.getCacheSafeQuerySnapshot!()!.modelResolution,
    );
    expect(mockRunForkedAgent.mock.calls[0][0]).not.toHaveProperty(
      'modelResolution',
    );
    expect(mockRunForkedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'policy-direct-model',
      }),
    );
  });

  it('treats an abort terminal as a cancelled subagent result', async () => {
    const controller = new AbortController();
    const usage = {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      service_tier: 'standard',
      cache_creation: {
        ephemeral_1h_input_tokens: 0,
        ephemeral_5m_input_tokens: 0,
      },
      inference_geo: '',
      iterations: [],
      speed: 'standard',
    };
    vi.mocked(runSubagent).mockImplementationOnce(async () => {
      controller.abort();
      return {
        textContent: '',
        messages: [
          {
            type: 'user',
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'toolu-1',
                  content: REJECT_MESSAGE,
                  is_error: true,
                },
              ],
            },
          },
        ] as never[],
        totalUsage: usage as never,
        terminal: {
          reason: 'abort',
          numTurns: 1,
          usage: usage as never,
          durationMs: 10,
        },
      };
    });

    const tracker = {
      recentActivity: [],
      makeProgress: vi.fn(() => 'progress'),
      handleQueryEvent: vi.fn(),
    };

    await expect(
      runAgent({
        definition: createDefinition(),
        context: createContext(),
        agentArgs: { query: 'inspect files' },
        tracker: tracker as never,
        signal: controller.signal,
        taskId: 'task-1',
        agentId: 'agent-1',
        outputPath: '/tmp/out',
        description: 'inspect files',
        isForkPath: false,
        parentToolUseId: 'toolu-parent-1',
        updateOutput: vi.fn(),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(tracker.makeProgress).toHaveBeenCalledWith('cancelled');
    expect(completeAgentTaskRecord).toHaveBeenLastCalledWith(
      {
        sessionTranscriptPath: getSessionTranscriptPath(
          '/project',
          'session-1',
        ),
      },
      'session-1',
      'task-1',
      expect.objectContaining({
        status: 'cancelled',
        summary: 'Agent "inspect files" cancelled',
        result: 'Operation cancelled by user',
      }),
    );
  });

  it('treats a completed-looking result as cancelled when the signal is already aborted', async () => {
    const controller = new AbortController();
    const usage = {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      service_tier: 'standard',
      cache_creation: {
        ephemeral_1h_input_tokens: 0,
        ephemeral_5m_input_tokens: 0,
      },
      inference_geo: '',
      iterations: [],
      speed: 'standard',
    };
    vi.mocked(runSubagent).mockImplementationOnce(async () => {
      controller.abort();
      return {
        textContent: 'partial final answer',
        messages: [
          {
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'text',
                  text: 'partial final answer',
                },
              ],
            },
          },
        ] as never[],
        totalUsage: usage as never,
        terminal: {
          reason: 'end_turn',
          numTurns: 1,
          usage: usage as never,
          durationMs: 10,
        },
      };
    });

    const tracker = {
      recentActivity: [],
      makeProgress: vi.fn(() => 'progress'),
      handleQueryEvent: vi.fn(),
    };

    await expect(
      runAgent({
        definition: createDefinition(),
        context: createContext(),
        agentArgs: { query: 'inspect files' },
        tracker: tracker as never,
        signal: controller.signal,
        taskId: 'task-1',
        agentId: 'agent-1',
        outputPath: '/tmp/out',
        description: 'inspect files',
        isForkPath: false,
        parentToolUseId: 'toolu-parent-1',
        updateOutput: vi.fn(),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(completeAgentTaskRecord).toHaveBeenLastCalledWith(
      {
        sessionTranscriptPath: getSessionTranscriptPath(
          '/project',
          'session-1',
        ),
      },
      'session-1',
      'task-1',
      expect.objectContaining({
        status: 'cancelled',
        result: 'Operation cancelled by user',
      }),
    );
  });

  it('emits one task_progress per tool_use with cumulative usage', async () => {
    vi.mocked(runSubagent).mockImplementationOnce(async (params) => {
      const usage = {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
        service_tier: 'standard',
        cache_creation: {
          ephemeral_1h_input_tokens: 0,
          ephemeral_5m_input_tokens: 0,
        },
        inference_geo: '',
        iterations: [],
        speed: 'standard',
        request_id: 'req-1',
      };

      params.onEvent?.({
        type: 'assistant',
        uuid: 'assistant-tool-1',
        timestamp: '2026-04-24T00:00:00.000Z',
        sessionId: 'session-1',
        message: {
          id: 'resp-1',
          type: 'message',
          role: 'assistant',
          model: 'active-model',
          stop_reason: null,
          stop_sequence: null,
          usage,
          content: [
            {
              type: 'tool_use',
              id: 'toolu-1',
              name: 'Read',
              input: { file_path: 'package.json' },
            },
          ],
          container: null,
          context_management: null,
        },
      } as never);

      params.onEvent?.({
        type: 'assistant',
        uuid: 'assistant-text-1',
        timestamp: '2026-04-24T00:00:01.000Z',
        sessionId: 'session-1',
        message: {
          id: 'resp-1',
          type: 'message',
          role: 'assistant',
          model: 'active-model',
          stop_reason: 'tool_use',
          stop_sequence: null,
          usage,
          content: [{ type: 'text', text: 'reading file', citations: null }],
          container: null,
          context_management: null,
        },
      } as never);

      params.onEvent?.({
        type: 'user',
        uuid: 'user-tool-result-1',
        timestamp: '2026-04-24T00:00:02.000Z',
        sessionId: 'session-1',
        parent_tool_use_id: 'toolu-parent-1',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu-1',
              content: 'ok',
              is_error: false,
            },
          ],
        },
      } as never);

      return {
        textContent: 'done',
        messages: [] as never[],
        totalUsage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
          service_tier: 'standard',
          cache_creation: {
            ephemeral_1h_input_tokens: 0,
            ephemeral_5m_input_tokens: 0,
          },
          inference_geo: '',
          iterations: [],
          speed: 'standard',
        },
      };
    });

    const recentActivity: Array<{
      type: 'tool_call';
      description?: string;
    }> = [];
    const tracker = {
      recentActivity,
      makeProgress: vi.fn(() => 'progress'),
      handleQueryEvent: vi.fn((event: { type: string }) => {
        if (event.type === 'assistant') {
          recentActivity.push({
            type: 'tool_call',
            description: 'Reading package.json',
          });
        }
      }),
    };

    await runAgent({
      definition: createDefinition(),
      context: createContext(),
      agentArgs: { query: 'inspect files' },
      tracker: tracker as never,
      signal: new AbortController().signal,
      taskId: 'task-1',
      agentId: 'agent-1',
      outputPath: '/tmp/out',
      description: 'inspect files',
      isForkPath: false,
      parentToolUseId: 'toolu-parent-1',
    });

    const events = drainSubagentSdkEvents('session-1', () => true);
    const startedEvents = events.filter(
      (event) => event.type === 'system' && event.subtype === 'task_started',
    );
    const progressEvents = events.filter(
      (event) => event.type === 'system' && event.subtype === 'task_progress',
    );

    expect(startedEvents).toHaveLength(1);
    expect(startedEvents[0]).toMatchObject({
      tools: ['Read', 'Bash'],
    });
    expect(progressEvents).toHaveLength(1);
    expect(progressEvents[0]).toMatchObject({
      description: 'Reading package.json',
      last_tool_name: 'Read',
      subagent_type: 'explore',
      usage: {
        total_tokens: 15,
        tool_uses: 1,
        duration_ms: expect.any(Number),
      },
    });
  });

  it('reports actual model request IDs from the fork query loop', async () => {
    mockRunForkedAgent.mockImplementationOnce(async (params: unknown) => {
      const onCompleted = (
        params as {
          onCompleted?: (completion: {
            modelRequestIds: string[];
            modelRequests: Array<{
              usage: { credits?: number; billable?: boolean };
            }>;
            totalUsage: { credits?: number; billable?: boolean };
          }) => void;
        }
      ).onCompleted;
      onCompleted?.({
        modelRequestIds: ['fork-request-1', 'fork-request-2'],
        modelRequests: [{ usage: { credits: 2.5, billable: true } }],
        totalUsage: { credits: 2.5, billable: true },
      });
      return {
        textContent: 'done',
        messages: [
          {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'done' }],
            },
          },
        ],
        totalUsage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      };
    });

    await runAgent({
      definition: createDefinition(),
      context: createContext(),
      agentArgs: { query: 'inspect files' },
      tracker: {
        recentActivity: [],
        makeProgress: vi.fn(() => 'progress'),
      } as never,
      signal: new AbortController().signal,
      taskId: 'task-1',
      agentId: 'agent-1',
      outputPath: '/tmp/out',
      description: 'inspect files',
      isForkPath: true,
    });
  });

  it('can suppress terminal task_notification while keeping task side events enabled', async () => {
    vi.mocked(runSubagent).mockResolvedValueOnce({
      textContent: 'done',
      messages: [] as never[],
      totalUsage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
        service_tier: 'standard',
        cache_creation: {
          ephemeral_1h_input_tokens: 0,
          ephemeral_5m_input_tokens: 0,
        },
        inference_geo: '',
        iterations: [],
        speed: 'standard',
      },
    });

    const tracker = {
      recentActivity: [],
      makeProgress: vi.fn(() => 'progress'),
      handleQueryEvent: vi.fn(),
    };

    await runAgent({
      definition: createDefinition(),
      context: createContext(),
      agentArgs: { query: 'inspect files' },
      tracker: tracker as never,
      signal: new AbortController().signal,
      taskId: 'task-1',
      agentId: 'agent-1',
      outputPath: '/tmp/out',
      description: 'inspect files',
      isForkPath: false,
      parentToolUseId: 'toolu-parent-1',
      emitSdkSideEvents: true,
      emitSdkTaskNotification: false,
    });

    const events = drainSubagentSdkEvents('session-1', () => true);
    const taskStarted = events.find(
      (event) => event.type === 'system' && event.subtype === 'task_started',
    );

    expect(taskStarted).toMatchObject({ tools: ['Read', 'Bash'] });
    expect(
      events.some(
        (event) =>
          event.type === 'system' && event.subtype === 'task_notification',
      ),
    ).toBe(false);
  });

  it('uses normalized request metadata for errored completed tool display', async () => {
    vi.mocked(runSubagent).mockResolvedValueOnce({
      textContent: 'done',
      messages: [] as never[],
      totalUsage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
        service_tier: 'standard',
        cache_creation: {
          ephemeral_1h_input_tokens: 0,
          ephemeral_5m_input_tokens: 0,
        },
        inference_geo: '',
        iterations: [],
        speed: 'standard',
      },
    });

    const tracker = {
      recentActivity: [],
      makeProgress: vi.fn(() => 'progress'),
      handleQueryEvent: vi.fn(),
      updateToolDisplay: vi.fn(),
    };

    await runAgent({
      definition: createDefinition(),
      context: createContext(),
      agentArgs: { query: 'inspect files' },
      tracker: tracker as never,
      signal: new AbortController().signal,
      taskId: 'task-1',
      agentId: 'agent-1',
      outputPath: '/tmp/out',
      description: 'inspect files',
      isForkPath: false,
      parentToolUseId: 'toolu-parent-1',
    });

    const registriesOptions = vi.mocked(buildSubagentRegistries).mock
      .calls[0][3];
    if (!registriesOptions) {
      throw new Error('Expected subagent registries options');
    }
    registriesOptions.onCompletedToolCall?.({
      status: CoreToolCallStatus.Error,
      request: {
        callId: 'toolu-1',
        name: 'Read',
        args: {
          file_path: '/project/xxx.txt',
        },
      },
      tool: {
        displayName: 'Read',
      },
      response: {
        resultDisplay: 'File not found.',
      },
    } as never);

    expect(tracker.updateToolDisplay).toHaveBeenCalledWith({
      toolUseId: 'toolu-1',
      status: 'error',
      displayName: 'Read',
      description: 'xxx.txt',
    });
  });
});
