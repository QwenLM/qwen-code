/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Regression tests for #10071: a named Agent Team teammate
 * spawned from a `.qwen/agents/<name>.md` definition must resolve the same
 * model/provider route as the same definition launched as an ordinary
 * subagent. Before the fix, `TeamManager.spawnTeammate` dropped the
 * selector's authType and never set `inProcess.authOverrides`, so
 * InProcessBackend built no per-agent ContentGenerator and the teammate
 * silently ran on the leader's provider route.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { TeamManager } from './TeamManager.js';
import { InProcessBackend } from '../backends/InProcessBackend.js';
import type { Backend } from '../backends/types.js';
import { AgentStatus } from '../runtime/agent-types.js';
import { SubagentManager } from '../../subagents/subagent-manager.js';
import type { Config } from '../../config/config.js';
import type { TeamFile } from './types.js';
import { formatAgentId } from './teamHelpers.js';

// ─── Module mocks ────────────────────────────────────────────

// Mock createContentGenerator so no real API client is created. Every
// call is an observable: a per-agent ContentGenerator is built if and
// only if the spawn path resolved a dedicated route for the agent.
const mockCreateContentGenerator = vi.hoisted(() => vi.fn());
vi.mock('../../core/contentGenerator.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../core/contentGenerator.js')>();
  return {
    ...actual,
    createContentGenerator: mockCreateContentGenerator,
  };
});

// Mock AgentCore to avoid real model calls while keeping the real
// InProcessBackend + AgentInteractive wiring. The factory and helpers
// are shared with InProcessBackend.test.ts so both suites assert
// against the same mocked AgentCore surface.
vi.mock('../runtime/agent-core.js', async () =>
  (await import('../runtime/agent-core-test-mock.js')).agentCoreMockModule(),
);
import { AgentCore } from '../runtime/agent-core.js';
import {
  runReasoningLoopMock,
  destructureAgentCoreCall,
  createMockToolRegistry,
} from '../runtime/agent-core-test-mock.js';

// Mock Storage so team files land in a per-test temp dir (same pattern
// as coordination-harness.test.ts).
vi.mock('../../config/storage.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../config/storage.js')>();
  let mockGlobalDir = '';
  return {
    ...original,
    Storage: {
      ...original.Storage,
      getGlobalQwenDir: () => mockGlobalDir,
      __setMockGlobalDir: (dir: string) => {
        mockGlobalDir = dir;
      },
    },
  };
});
import { Storage } from '../../config/storage.js';

function setMockGlobalDir(dir: string): void {
  (
    Storage as unknown as { __setMockGlobalDir: (d: string) => void }
  ).__setMockGlobalDir(dir);
}

// ─── Leader Config mock ──────────────────────────────────────

const LEADER_MODEL = 'leader-model';
const LEADER_AUTH_TYPE = 'openai';

/**
 * Leader-session Config mock: provider route is
 * openai/leader-model @ https://leader.example.com. Anything a spawned
 * teammate resolves to differently is observable against these values.
 */
function createLeaderConfig(projectRoot: string): Config {
  const leaderGenerator = { generateContentStream: vi.fn() };
  return {
    getModel: vi.fn().mockReturnValue(LEADER_MODEL),
    getFastModel: vi.fn().mockReturnValue(undefined),
    getAllConfiguredModels: vi.fn().mockReturnValue([]),
    getToolRegistry: vi.fn().mockReturnValue(createMockToolRegistry()),
    createToolRegistry: vi.fn().mockResolvedValue(createMockToolRegistry()),
    getMonitorRegistry: vi.fn().mockReturnValue({
      setAgentNotificationCallback: vi.fn(),
      cancelRunningForOwner: vi.fn(),
    }),
    getSessionId: vi.fn().mockReturnValue('leader-session'),
    getPlansDir: vi.fn().mockReturnValue(path.join(projectRoot, 'plans')),
    getApprovalMode: vi.fn().mockReturnValue('default'),
    getPrePlanMode: vi.fn().mockReturnValue('default'),
    setApprovalMode: vi.fn(),
    isTrustedFolder: vi.fn().mockReturnValue(true),
    getPermissionManager: vi.fn().mockReturnValue(null),
    getWorkingDir: vi.fn().mockReturnValue(projectRoot),
    getTargetDir: vi.fn().mockReturnValue(projectRoot),
    getProjectRoot: vi.fn().mockReturnValue(projectRoot),
    getContentGenerator: vi.fn().mockReturnValue(leaderGenerator),
    getContentGeneratorConfig: vi.fn().mockReturnValue({
      model: LEADER_MODEL,
      authType: LEADER_AUTH_TYPE,
      apiKey: 'leader-key',
      baseUrl: 'https://leader.example.com',
    }),
    getAuthType: vi.fn().mockReturnValue(LEADER_AUTH_TYPE),
    getModelsConfig: vi.fn().mockReturnValue({
      getResolvedModel: vi.fn().mockReturnValue(undefined),
    }),
    getFileFilteringOptions: vi.fn().mockReturnValue({
      customIgnoreFiles: [],
    }),
    getAgentsSettings: vi.fn().mockReturnValue({}),
  } as never;
}

// ─── Fixtures ────────────────────────────────────────────────

async function writeAgentDefinition(
  projectRoot: string,
  fileName: string,
  frontmatter: Record<string, string>,
): Promise<void> {
  const dir = path.join(projectRoot, '.qwen', 'agents');
  await fs.mkdir(dir, { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
  await fs.writeFile(
    path.join(dir, fileName),
    `---\n${fm}\n---\n\nYou are a worker agent.\n`,
    'utf-8',
  );
}

describe('TeamManager teammate model routing (#10071)', () => {
  let tmpDir: string;
  let projectDir: string;
  let globalDir: string;
  let leaderConfig: Config;
  let backend: InProcessBackend;
  let teamManager: TeamManager;
  const TEAM_NAME = 'route-team';

  async function writeTeamFileFixture(): Promise<TeamFile> {
    const teamFile: TeamFile = {
      name: TEAM_NAME,
      createdAt: Date.now(),
      leadAgentId: formatAgentId('leader', TEAM_NAME),
      members: [],
    };
    return teamFile;
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-model-route-'));
    projectDir = path.join(tmpDir, 'project');
    globalDir = path.join(tmpDir, 'global');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(globalDir, { recursive: true });
    setMockGlobalDir(globalDir);

    runReasoningLoopMock.mockReset();
    runReasoningLoopMock.mockResolvedValue({
      text: 'Done',
      terminateMode: null,
      turnsUsed: 1,
    });
    mockCreateContentGenerator.mockReset();
    mockCreateContentGenerator.mockResolvedValue({
      generateContentStream: vi.fn(),
    });
    (AgentCore as unknown as ReturnType<typeof vi.fn>).mockClear();

    leaderConfig = createLeaderConfig(projectDir);
    backend = new InProcessBackend(leaderConfig);
    await backend.init();
    const subagentManager = new SubagentManager(leaderConfig);
    teamManager = new TeamManager(
      backend,
      await writeTeamFileFixture(),
      subagentManager,
    );
  });

  afterEach(async () => {
    await teamManager.cleanup();
    await backend.cleanup();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('routes a teammate through the custom provider selected in its agent definition', async () => {
    // Leader runs on openai/leader-model; the definition selects a
    // different provider route (anthropic:claude-worker). An ordinary
    // subagent with this definition gets a dedicated ContentGenerator
    // for the anthropic route — a named teammate must get the same.
    await writeAgentDefinition(projectDir, 'worker.md', {
      name: 'worker',
      description: 'A worker with a custom model route',
      model: 'anthropic:claude-worker',
    });

    await teamManager.spawnTeammate({
      name: 'w1',
      agentType: 'worker',
      cwd: projectDir,
    });

    const agentId = formatAgentId('w1', TEAM_NAME);

    // A dedicated ContentGenerator must have been created for the
    // teammate's own route, not inherited from the leader.
    expect(mockCreateContentGenerator).toHaveBeenCalledWith(
      expect.objectContaining({
        authType: 'anthropic',
        model: 'claude-worker',
      }),
      expect.anything(),
    );

    const teammateGenerator = backend.getAgentContentGenerator(agentId);
    expect(teammateGenerator).toBeDefined();
    expect(teammateGenerator).not.toBe(leaderConfig.getContentGenerator());

    // The agent runtime must receive the view so Config getters resolve
    // the teammate's route during the run.
    const MockAgentCore = AgentCore as unknown as ReturnType<typeof vi.fn>;
    const { modelConfig, runtimeView } = destructureAgentCoreCall(
      MockAgentCore.mock.calls.at(-1)!,
    );
    expect(modelConfig.model).toBe('claude-worker');
    expect(runtimeView).toBeDefined();
    expect(runtimeView!.contentGeneratorConfig.authType).toBe('anthropic');
    expect(runtimeView!.contentGenerator).toBe(teammateGenerator);

    // The team file reflects the model the teammate actually runs on.
    const member = teamManager.getTeamFile().members[0]!;
    expect(member.model).toBe('claude-worker');
  });

  it('resolves a fast selector in the definition against the runtime context', async () => {
    // convertToRuntimeConfig alone receives no runtime context, so a
    // `fast` selector could not resolve and the teammate silently
    // inherited the leader's model. The spawn path must resolve it.
    (
      leaderConfig as unknown as { getFastModel: ReturnType<typeof vi.fn> }
    ).getFastModel.mockReturnValue('anthropic:claude-fast');

    await writeAgentDefinition(projectDir, 'fast-worker.md', {
      name: 'fast-worker',
      description: 'A worker selecting the fast model',
      model: 'fast',
    });

    await teamManager.spawnTeammate({
      name: 'w2',
      agentType: 'fast-worker',
      cwd: projectDir,
    });

    expect(mockCreateContentGenerator).toHaveBeenCalledWith(
      expect.objectContaining({
        authType: 'anthropic',
        model: 'claude-fast',
      }),
      expect.anything(),
    );

    const MockAgentCore = AgentCore as unknown as ReturnType<typeof vi.fn>;
    const { modelConfig } = destructureAgentCoreCall(
      MockAgentCore.mock.calls.at(-1)!,
    );
    expect(modelConfig.model).toBe('claude-fast');
  });

  it('keeps the leader route for definitions that do not select a model', async () => {
    // Regression guard: no selector means inherit — the teammate must
    // keep running on the leader's ContentGenerator exactly as before.
    await writeAgentDefinition(projectDir, 'plain-worker.md', {
      name: 'plain-worker',
      description: 'A worker without a model selector',
    });

    await teamManager.spawnTeammate({
      name: 'w3',
      agentType: 'plain-worker',
      cwd: projectDir,
    });

    const agentId = formatAgentId('w3', TEAM_NAME);

    expect(mockCreateContentGenerator).not.toHaveBeenCalled();
    expect(backend.getAgentContentGenerator(agentId)).toBe(
      leaderConfig.getContentGenerator(),
    );

    const MockAgentCore = AgentCore as unknown as ReturnType<typeof vi.fn>;
    const { modelConfig, runtimeView } = destructureAgentCoreCall(
      MockAgentCore.mock.calls.at(-1)!,
    );
    expect(modelConfig.model).toBeUndefined();
    expect(runtimeView).toBeUndefined();
  });

  it('keeps the leader route for inherit selectors', async () => {
    await writeAgentDefinition(projectDir, 'inherit-worker.md', {
      name: 'inherit-worker',
      description: 'A worker inheriting the leader model',
      model: 'inherit',
    });

    await teamManager.spawnTeammate({
      name: 'w4',
      agentType: 'inherit-worker',
      cwd: projectDir,
    });

    expect(mockCreateContentGenerator).not.toHaveBeenCalled();
    const agentId = formatAgentId('w4', TEAM_NAME);
    expect(backend.getAgentContentGenerator(agentId)).toBe(
      leaderConfig.getContentGenerator(),
    );
  });

  it('keeps the leader route when the leader overrides the model at spawn time', async () => {
    // The definition selects a custom route, but the leader picks the
    // model explicitly at spawn time: the definition does not vouch
    // for the route of a model it did not select, so the `!config.model`
    // guard must skip authOverrides entirely.
    await writeAgentDefinition(projectDir, 'overridden-worker.md', {
      name: 'overridden-worker',
      description: 'A worker whose route must yield to a spawn override',
      model: 'anthropic:claude-worker',
    });

    await teamManager.spawnTeammate({
      name: 'w5',
      agentType: 'overridden-worker',
      model: 'leader-picked-model',
      cwd: projectDir,
    });

    const agentId = formatAgentId('w5', TEAM_NAME);

    // No dedicated generator may be built on the definition's route...
    expect(mockCreateContentGenerator).not.toHaveBeenCalled();
    // ...the teammate runs on the leader's generator...
    expect(backend.getAgentContentGenerator(agentId)).toBe(
      leaderConfig.getContentGenerator(),
    );

    // ...and every surface agrees on the spawn-time model.
    const MockAgentCore = AgentCore as unknown as ReturnType<typeof vi.fn>;
    const { modelConfig, runtimeView } = destructureAgentCoreCall(
      MockAgentCore.mock.calls.at(-1)!,
    );
    expect(modelConfig.model).toBe('leader-picked-model');
    expect(runtimeView).toBeUndefined();
    const member = teamManager.getTeamFile().members[0]!;
    expect(member.model).toBe('leader-picked-model');
  });

  it('fails loudly when the dedicated route generator cannot be created', async () => {
    // The definition selects a route but the generator for it cannot be
    // created (e.g. missing API key). InProcessBackend swallows that
    // failure and falls back to the leader's generator; the spawn path
    // must detect the missing dedicated generator and fail into the
    // rollback instead of letting the teammate join misrouted (#10071).
    await writeAgentDefinition(projectDir, 'unroutable-worker.md', {
      name: 'unroutable-worker',
      description: 'A worker whose route cannot be created',
      model: 'anthropic:claude-worker',
    });

    mockCreateContentGenerator.mockRejectedValueOnce(
      new Error('The API key for Anthropic is not set'),
    );

    // The swallowed creation failure must surface in the spawn error:
    // the ordinary-subagent path reports the provider's message, and
    // the debug log that used to be the only trace is a no-op without
    // QWEN_DEBUG_LOG_FILE.
    await expect(
      teamManager.spawnTeammate({
        name: 'w6',
        agentType: 'unroutable-worker',
        cwd: projectDir,
      }),
    ).rejects.toThrow(
      /could not create a dedicated ContentGenerator for model "claude-worker" \(anthropic\): The API key for Anthropic is not set/,
    );

    // Rollback must run: no member persisted, and the backend released
    // the agent handle during stopAgent — keeping it (the old behaviour
    // held it until cleanup()) permanently blocks respawning the same
    // teammate name, masking this route failure behind 'Agent "X"
    // already exists.' on every retry.
    expect(teamManager.getTeamFile().members).toHaveLength(0);
    const agentId = formatAgentId('w6', TEAM_NAME);
    expect(backend.getAgent(agentId)).toBeUndefined();
  });

  it('releases a rolled-back teammate name so the same spawn can retry', async () => {
    // Route-verification failure rolls the teammate back via
    // backend.stopAgent. The backend used to keep the agent id in its
    // `agents` map after stopAgent, so the retry — which reuses the
    // same name/agentId (generateUniqueTeammateName only dedupes
    // against current members) — was permanently rejected with
    // 'Agent "X" already exists.', masking the real route failure.
    await writeAgentDefinition(projectDir, 'retry-worker.md', {
      name: 'retry-worker',
      description: 'A worker whose route fails then succeeds',
      model: 'anthropic:claude-worker',
    });

    mockCreateContentGenerator.mockRejectedValueOnce(
      new Error('The API key for Anthropic is not set'),
    );

    // First attempt: route creation fails, spawn fails, rollback runs.
    await expect(
      teamManager.spawnTeammate({
        name: 'w8',
        agentType: 'retry-worker',
        cwd: projectDir,
      }),
    ).rejects.toThrow(
      /could not create a dedicated ContentGenerator for model "claude-worker" \(anthropic\)/,
    );
    expect(teamManager.getTeamFile().members).toHaveLength(0);

    // Same-name respawn must succeed once the route is creatable.
    await teamManager.spawnTeammate({
      name: 'w8',
      agentType: 'retry-worker',
      cwd: projectDir,
    });

    const agentId = formatAgentId('w8', TEAM_NAME);
    expect(teamManager.getTeamFile().members).toHaveLength(1);
    expect(backend.getAgent(agentId)).toBeDefined();
    expect(backend.getAgentContentGenerator(agentId)).toBeDefined();

    // A third spawn with the same name now fails with the genuine
    // team-level name collision — not the stale backend gate.
    await expect(
      teamManager.spawnTeammate({
        name: 'w8',
        agentType: 'retry-worker',
        cwd: projectDir,
      }),
    ).rejects.toThrow(/already exists in this team/);
    expect(teamManager.getTeamFile().members).toHaveLength(1);
  });

  it('treats an empty spawn-time model override the same as none', async () => {
    // `model: ''` must fall back to the definition's route/model exactly
    // like `undefined`. The guards used to mix nullish (`??`) and falsy
    // (`!`) checks, so '' kept the empty override as the model while the
    // route guard saw no override — the teammate was pinned to '' over
    // the leader's generator instead of its definition's route.
    await writeAgentDefinition(projectDir, 'empty-override-worker.md', {
      name: 'empty-override-worker',
      description: 'A worker with a custom model route',
      model: 'anthropic:claude-worker',
    });

    await teamManager.spawnTeammate({
      name: 'w9',
      agentType: 'empty-override-worker',
      model: '',
      cwd: projectDir,
    });

    const agentId = formatAgentId('w9', TEAM_NAME);

    expect(mockCreateContentGenerator).toHaveBeenCalledWith(
      expect.objectContaining({
        authType: 'anthropic',
        model: 'claude-worker',
      }),
      expect.anything(),
    );
    expect(backend.getAgentContentGenerator(agentId)).toBeDefined();

    const MockAgentCore = AgentCore as unknown as ReturnType<typeof vi.fn>;
    const { modelConfig } = destructureAgentCoreCall(
      MockAgentCore.mock.calls.at(-1)!,
    );
    expect(modelConfig.model).toBe('claude-worker');
    const member = teamManager.getTeamFile().members[0]!;
    expect(member.model).toBe('claude-worker');
  });

  it('fails loudly on a backend that omits getAgentContentGenerator', async () => {
    // PTY-style backends may omit getAgentContentGenerator (types.ts
    // allows it). A model-selecting definition on such a backend must
    // fail with the real cause — not with a missing-generator error
    // that looks like a missing API key, and not by silently joining
    // on the leader's generator (#10071).
    await writeAgentDefinition(projectDir, 'routed-worker.md', {
      name: 'routed-worker',
      description: 'A worker with a custom model route',
      model: 'anthropic:claude-worker',
    });

    const ptyStyleBackend = {
      type: 'tmux',
      init: vi.fn().mockResolvedValue(undefined),
      spawnAgent: vi.fn().mockResolvedValue(undefined),
      stopAgent: vi.fn(),
      getAgent: vi.fn().mockReturnValue({
        getStatus: vi.fn().mockReturnValue(AgentStatus.IDLE),
        getError: vi.fn().mockReturnValue(undefined),
      }),
      stopAll: vi.fn(),
      cleanup: vi.fn().mockResolvedValue(undefined),
      setOnAgentExit: vi.fn(),
      // getAgentContentGenerator intentionally omitted.
    } as unknown as Backend;

    const localTeamManager = new TeamManager(
      ptyStyleBackend,
      await writeTeamFileFixture(),
      new SubagentManager(leaderConfig),
    );

    await expect(
      localTeamManager.spawnTeammate({
        name: 'w7',
        agentType: 'routed-worker',
        cwd: projectDir,
      }),
    ).rejects.toThrow(
      /does not support dedicated per-agent ContentGenerators required by model "claude-worker" \(anthropic\)/,
    );

    // Rollback must run: no member persisted.
    expect(localTeamManager.getTeamFile().members).toHaveLength(0);
    await localTeamManager.cleanup();
  });
});
