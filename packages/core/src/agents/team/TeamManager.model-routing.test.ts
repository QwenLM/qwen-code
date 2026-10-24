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
// InProcessBackend + AgentInteractive wiring; the factory is shared with
// InProcessBackend.test.ts so both suites assert against the same surface.
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

// Leader route: openai/leader-model @ https://leader.example.com. Anything a
// spawned teammate resolves to differently is observable against these.
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

describe('TeamManager teammate model routing (#10071)', () => {
  let tmpDir: string;
  let projectDir: string;
  let globalDir: string;
  let leaderConfig: Config;
  let backend: InProcessBackend;
  let teamManager: TeamManager;
  const TEAM_NAME = 'route-team';

  const teamFileFixture = (): TeamFile => ({
    name: TEAM_NAME,
    createdAt: Date.now(),
    leadAgentId: formatAgentId('leader', TEAM_NAME),
    members: [],
  });
  const agentId = (name: string) => formatAgentId(name, TEAM_NAME);
  const members = () => teamManager.getTeamFile().members;

  /** Writes `.qwen/agents/<name>.md`; omitting `model` leaves no selector. */
  async function define(name: string, description: string, model?: string) {
    const dir = path.join(projectDir, '.qwen', 'agents');
    await fs.mkdir(dir, { recursive: true });
    const fm = [`name: ${name}`, `description: ${description}`]
      .concat(model ? [`model: ${model}`] : [])
      .join('\n');
    await fs.writeFile(
      path.join(dir, `${name}.md`),
      `---\n${fm}\n---\n\nYou are a worker agent.\n`,
      'utf-8',
    );
  }

  const spawn = (
    opts: { name: string; agentType: string; model?: string },
    manager = teamManager,
  ) => manager.spawnTeammate({ ...opts, cwd: projectDir });

  const lastCoreCall = () =>
    destructureAgentCoreCall(
      (AgentCore as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)!,
    );

  const expectRouteCreated = (model: string) =>
    expect(mockCreateContentGenerator).toHaveBeenCalledWith(
      expect.objectContaining({ authType: 'anthropic', model }),
      expect.anything(),
    );

  function expectLeaderRoute(name: string) {
    expect(mockCreateContentGenerator).not.toHaveBeenCalled();
    expect(backend.getAgentContentGenerator(agentId(name))).toBe(
      leaderConfig.getContentGenerator(),
    );
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
    teamManager = new TeamManager(backend, teamFileFixture(), subagentManager);
  });

  afterEach(async () => {
    await teamManager.cleanup();
    await backend.cleanup();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('routes a teammate through the custom provider selected in its agent definition', async () => {
    // Leader runs on openai/leader-model; the definition selects
    // anthropic:claude-worker. An ordinary subagent gets a dedicated
    // ContentGenerator for that route — a named teammate must too.
    await define(
      'worker',
      'A worker with a custom model route',
      'anthropic:claude-worker',
    );
    await spawn({ name: 'w1', agentType: 'worker' });

    // A dedicated generator for the teammate's own route, not the leader's.
    expectRouteCreated('claude-worker');
    const teammateGenerator = backend.getAgentContentGenerator(agentId('w1'));
    expect(teammateGenerator).toBeDefined();
    expect(teammateGenerator).not.toBe(leaderConfig.getContentGenerator());

    // The runtime receives the view so Config getters resolve the
    // teammate's route during the run.
    const { modelConfig, runtimeView } = lastCoreCall();
    expect(modelConfig.model).toBe('claude-worker');
    expect(runtimeView).toBeDefined();
    expect(runtimeView!.contentGeneratorConfig.authType).toBe('anthropic');
    expect(runtimeView!.contentGenerator).toBe(teammateGenerator);
    // The team file reflects the model the teammate actually runs on.
    expect(members()[0]!.model).toBe('claude-worker');
  });

  it('resolves a fast selector in the definition against the runtime context', async () => {
    // convertToRuntimeConfig alone gets no runtime context, so `fast`
    // could not resolve and the teammate silently inherited the leader's
    // model. The spawn path must resolve it.
    (
      leaderConfig as unknown as { getFastModel: ReturnType<typeof vi.fn> }
    ).getFastModel.mockReturnValue('anthropic:claude-fast');
    await define('fast-worker', 'A worker selecting the fast model', 'fast');
    await spawn({ name: 'w2', agentType: 'fast-worker' });

    expectRouteCreated('claude-fast');
    expect(lastCoreCall().modelConfig.model).toBe('claude-fast');
  });

  it('keeps the leader route for definitions that do not select a model', async () => {
    // Regression guard: no selector means inherit — the teammate keeps
    // running on the leader's ContentGenerator exactly as before.
    await define('plain-worker', 'A worker without a model selector');
    await spawn({ name: 'w3', agentType: 'plain-worker' });

    expectLeaderRoute('w3');
    const { modelConfig, runtimeView } = lastCoreCall();
    expect(modelConfig.model).toBeUndefined();
    expect(runtimeView).toBeUndefined();
  });

  it('keeps the leader route for inherit selectors', async () => {
    await define(
      'inherit-worker',
      'A worker inheriting the leader model',
      'inherit',
    );
    await spawn({ name: 'w4', agentType: 'inherit-worker' });
    expectLeaderRoute('w4');
  });

  it('keeps the leader route when the leader overrides the model at spawn time', async () => {
    // The definition selects a route, but the leader picks the model at
    // spawn time: the definition does not vouch for the route of a model
    // it did not select, so the `!config.model` guard must skip
    // authOverrides entirely.
    await define(
      'overridden-worker',
      'A worker whose route must yield to a spawn override',
      'anthropic:claude-worker',
    );
    await spawn({
      name: 'w5',
      agentType: 'overridden-worker',
      model: 'leader-picked-model',
    });

    // No generator on the definition's route, the teammate runs on the
    // leader's generator, and every surface agrees on the spawn-time model.
    expectLeaderRoute('w5');
    const { modelConfig, runtimeView } = lastCoreCall();
    expect(modelConfig.model).toBe('leader-picked-model');
    expect(runtimeView).toBeUndefined();
    expect(members()[0]!.model).toBe('leader-picked-model');
  });

  it('fails loudly when the dedicated route generator cannot be created', async () => {
    // The route's generator cannot be created (e.g. missing API key).
    // InProcessBackend swallows that and falls back to the leader's
    // generator; the spawn path must detect the missing dedicated generator
    // and fail into the rollback instead of joining misrouted (#10071).
    await define(
      'unroutable-worker',
      'A worker whose route cannot be created',
      'anthropic:claude-worker',
    );
    mockCreateContentGenerator.mockRejectedValueOnce(
      new Error('The API key for Anthropic is not set'),
    );

    // The swallowed failure must surface in the spawn error: the
    // ordinary-subagent path reports the provider's message, and the debug
    // log that used to be the only trace is a no-op without
    // QWEN_DEBUG_LOG_FILE.
    await expect(
      spawn({ name: 'w6', agentType: 'unroutable-worker' }),
    ).rejects.toThrow(
      /could not create a dedicated ContentGenerator for model "claude-worker" \(anthropic\): The API key for Anthropic is not set/,
    );

    // Rollback must run: no member persisted, and the id must stay
    // respawnable — otherwise every retry dies with 'Agent "X" already
    // exists.' masking this route failure. The stopped handle stays readable
    // for post-stop inspection (Arena reads transcripts through it on the
    // timeout path); the backend tracks the stop separately so the respawn
    // gate still clears, as pinned by the retry test below.
    expect(members()).toHaveLength(0);
    expect(backend.getAgent(agentId('w6'))?.getStatus()).toBe(
      AgentStatus.CANCELLED,
    );
  });

  it('releases a rolled-back teammate name so the same spawn can retry', async () => {
    // Route-verification failure rolls back via backend.stopAgent, which
    // used to keep the id in its `agents` map, so the retry — same
    // name/agentId, since generateUniqueTeammateName only dedupes against
    // current members — was permanently rejected with 'Agent "X" already
    // exists.', masking the real route failure.
    await define(
      'retry-worker',
      'A worker whose route fails then succeeds',
      'anthropic:claude-worker',
    );
    mockCreateContentGenerator.mockRejectedValueOnce(
      new Error('The API key for Anthropic is not set'),
    );
    const retry = () => spawn({ name: 'w8', agentType: 'retry-worker' });

    // First attempt: route creation fails, spawn fails, rollback runs.
    await expect(retry()).rejects.toThrow(
      /could not create a dedicated ContentGenerator for model "claude-worker" \(anthropic\)/,
    );
    expect(members()).toHaveLength(0);

    // Same-name respawn must succeed once the route is creatable.
    await retry();
    expect(members()).toHaveLength(1);
    expect(backend.getAgent(agentId('w8'))).toBeDefined();
    expect(backend.getAgentContentGenerator(agentId('w8'))).toBeDefined();

    // A third spawn now fails with the genuine team-level name collision —
    // not the stale backend gate.
    await expect(retry()).rejects.toThrow(/already exists in this team/);
    expect(members()).toHaveLength(1);
  });

  it('treats an empty spawn-time model override the same as none', async () => {
    // `model: ''` must fall back to the definition's route/model like
    // `undefined`. The guards used to mix nullish (`??`) and falsy (`!`)
    // checks, so '' was kept as the model while the route guard saw no
    // override — pinning the teammate to '' over the leader's generator.
    await define(
      'empty-override-worker',
      'A worker with a custom model route',
      'anthropic:claude-worker',
    );
    await spawn({ name: 'w9', agentType: 'empty-override-worker', model: '' });

    expectRouteCreated('claude-worker');
    expect(backend.getAgentContentGenerator(agentId('w9'))).toBeDefined();
    expect(lastCoreCall().modelConfig.model).toBe('claude-worker');
    expect(members()[0]!.model).toBe('claude-worker');
  });

  it('fails loudly on a backend that omits getAgentContentGenerator', async () => {
    // PTY-style backends may omit getAgentContentGenerator (types.ts allows
    // it). A model-selecting definition there must fail with the real cause
    // — not a missing-generator error that looks like a missing API key,
    // and not by silently joining on the leader's generator (#10071).
    await define(
      'routed-worker',
      'A worker with a custom model route',
      'anthropic:claude-worker',
    );

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
      teamFileFixture(),
      new SubagentManager(leaderConfig),
    );

    await expect(
      spawn({ name: 'w7', agentType: 'routed-worker' }, localTeamManager),
    ).rejects.toThrow(
      /does not support dedicated per-agent ContentGenerators required by model "claude-worker" \(anthropic\)/,
    );
    // Rollback must run: no member persisted.
    expect(localTeamManager.getTeamFile().members).toHaveLength(0);
    await localTeamManager.cleanup();
  });
});
