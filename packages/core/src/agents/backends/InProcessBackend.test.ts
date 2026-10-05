/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InProcessBackend } from './InProcessBackend.js';
import { DISPLAY_MODE } from './types.js';
import type { AgentSpawnConfig, InProcessSpawnConfig } from './types.js';
import { AgentCore } from '../runtime/agent-core.js';
import { getTeammateContext } from '../team/identity.js';
import { createContentGenerator } from '../../core/contentGenerator.js';
import { ApprovalMode, Config } from '../../config/config.js';
import { hasRebuiltToolRegistry } from '../../tools/agent/agent.js';
import { join } from 'node:path';
import { modelText, userText } from '../../test-utils/model-fixtures.js';

const DEFAULT_MODE = 'default' as ApprovalMode;
const PLAN_MODE = 'plan' as ApprovalMode;

// Mock createContentGenerator to avoid real API client setup
const mockContentGenerator = { generateContentStream: vi.fn() };
vi.mock('../../core/contentGenerator.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../core/contentGenerator.js')>();
  return {
    ...actual,
    createContentGenerator: vi.fn().mockResolvedValue({
      generateContentStream: vi.fn(),
    }),
  };
});

// Mock AgentCore to avoid real model calls. The factory, destructure helper
// and mock ToolRegistry are shared with TeamManager.model-routing.test.ts so
// both suites assert against the same mocked AgentCore surface.
vi.mock('../runtime/agent-core.js', async () =>
  (await import('../runtime/agent-core-test-mock.js')).agentCoreMockModule(),
);
import {
  runReasoningLoopMock,
  destructureAgentCoreCall,
  createMockToolRegistry,
} from '../runtime/agent-core-test-mock.js';

type Mock = ReturnType<typeof vi.fn>;
const mockCreate = createContentGenerator as Mock;

function createMockConfig() {
  const registry = createMockToolRegistry();
  return {
    getModel: vi.fn().mockReturnValue('test-model'),
    getToolRegistry: vi.fn().mockReturnValue(registry),
    getMonitorRegistry: vi.fn().mockReturnValue({
      setAgentNotificationCallback: vi.fn(),
      cancelRunningForOwner: vi.fn(),
    }),
    getSessionId: vi.fn().mockReturnValue('test-session'),
    getPlansDir: vi.fn().mockReturnValue('/tmp/plans'),
    getApprovalMode: vi.fn().mockReturnValue(DEFAULT_MODE),
    getPrePlanMode: vi.fn().mockReturnValue(DEFAULT_MODE),
    setApprovalMode: vi.fn(),
    isTrustedFolder: vi.fn().mockReturnValue(true),
    getPermissionManager: vi.fn().mockReturnValue(null),
    getWorkingDir: vi.fn().mockReturnValue('/tmp'),
    getTargetDir: vi.fn().mockReturnValue('/tmp'),
    createToolRegistry: vi.fn().mockResolvedValue(createMockToolRegistry()),
    getContentGenerator: vi.fn().mockReturnValue(mockContentGenerator),
    getContentGeneratorConfig: vi.fn().mockReturnValue({
      model: 'test-model',
      authType: 'openai',
      apiKey: 'parent-key',
      baseUrl: 'https://parent.example.com',
    }),
    getAuthType: vi.fn().mockReturnValue('openai'),
    getModelsConfig: vi.fn().mockReturnValue({
      getResolvedModel: vi.fn().mockReturnValue(undefined),
    }),
    getFileFilteringOptions: vi.fn().mockReturnValue({
      customIgnoreFiles: ['.cursorignore'],
    }),
  } as never;
}

/** createMockConfig() typed for the getters cases re-stub or inspect. */
type MockConfig = Record<
  | 'createToolRegistry'
  | 'getApprovalMode'
  | 'getFileFilteringOptions'
  | 'getMonitorRegistry'
  | 'getPermissionManager'
  | 'getPlanFilePath'
  | 'isTrustedFolder'
  | 'setApprovalMode',
  Mock
>;
const mockConfig = () => createMockConfig() as unknown as MockConfig;

/** `inProcess` fields in `extra` are set on top of the defaults. */
function createSpawnConfig(
  agentId: string,
  extra: Partial<InProcessSpawnConfig> = {},
): AgentSpawnConfig {
  return {
    agentId,
    command: 'node',
    args: [],
    cwd: '/tmp',
    inProcess: {
      agentName: `Agent ${agentId}`,
      initialTask: 'Do something',
      runtimeConfig: {
        promptConfig: { systemPrompt: 'You are a helpful assistant.' },
        modelConfig: { model: 'test-model' },
        runConfig: { max_turns: 10 },
      },
      ...extra,
    },
  };
}

/** init(), then spawn each spec (an id means createSpawnConfig(id)). */
async function started(
  b: InProcessBackend,
  ...specs: Array<string | AgentSpawnConfig>
) {
  await b.init();
  for (const spec of specs) {
    await b.spawnAgent(
      typeof spec === 'string' ? createSpawnConfig(spec) : spec,
    );
  }
  return b;
}

/** started() on a fresh backend over `parent`. */
const backendOn = (
  parent: unknown,
  ...specs: Array<string | AgentSpawnConfig>
) => started(new InProcessBackend(parent as never), ...specs);

const agentCoreCalls = () => (AgentCore as unknown as Mock).mock.calls;

/** The latest AgentCore construction; `checked` also asserts it happened. */
function lastCoreCall(checked = false) {
  const call = agentCoreCalls().at(-1);
  if (checked) expect(call).toBeDefined();
  return destructureAgentCoreCall(call!);
}

const registriesOf = (b: InProcessBackend) =>
  (b as unknown as { agentRegistries: Map<string, { stop: Mock }> })
    .agentRegistries;

describe('InProcessBackend', () => {
  let backend: InProcessBackend;

  beforeEach(() => {
    runReasoningLoopMock.mockReset();
    runReasoningLoopMock.mockResolvedValue({
      text: 'Done',
      terminateMode: null,
      turnsUsed: 1,
    });
    backend = new InProcessBackend(createMockConfig());
  });

  /** Moves the roster one step, then asserts which agent is active. */
  const nav = (move: 'switchToNext' | 'switchToPrevious', active: string) => {
    backend[move]();
    expect(backend.getActiveAgentId()).toBe(active);
  };

  /** Swaps in a permission manager; returns its strip/restore spies. */
  function mockPermissionManager(parent: MockConfig) {
    const manager = {
      restoreDangerousRules: vi.fn(),
      stripDangerousRulesForAutoMode: vi.fn(),
    };
    parent.getPermissionManager.mockReturnValue(manager);
    return manager;
  }

  /** Spawns two idle AUTO children over `parent` with a mocked manager. */
  async function twoAutoChildren(parent: MockConfig) {
    const manager = mockPermissionManager(parent);
    const auto = (agentId: string) =>
      createSpawnConfig(agentId, {
        approvalMode: ApprovalMode.AUTO,
        initialTask: undefined,
      });
    const b = await backendOn(parent, auto('agent-1'), auto('agent-2'));
    return { manager, localBackend: b };
  }

  /** Spawns agent-1 over `parent`; returns its own Config. */
  async function agentConfigOn(parent: unknown, approvalMode?: ApprovalMode) {
    const extra = approvalMode ? { approvalMode } : {};
    await backendOn(parent, createSpawnConfig('agent-1', extra));
    return lastCoreCall(true).runtimeContext as unknown as Config;
  }

  // agent-1 + agent-2 on a config minting a fresh registry per call: the
  // shared createMockConfig singleton would conflate r1/r2 and make
  // per-registry call counts ambiguous.
  async function twoWithOwnRegistries() {
    const config = mockConfig();
    config.createToolRegistry = vi
      .fn()
      .mockImplementation(() => Promise.resolve(createMockToolRegistry()));
    const localBackend = await backendOn(config, 'agent-1', 'agent-2');
    const registries = registriesOf(localBackend);
    const r1 = registries.get('agent-1')!;
    const r2 = registries.get('agent-2')!;
    return { localBackend, registries, r1, r2 };
  }

  it('should have IN_PROCESS type', () => {
    expect(backend.type).toBe(DISPLAY_MODE.IN_PROCESS);
  });

  it('should init without error', async () => {
    await expect(backend.init()).resolves.toBeUndefined();
  });

  it('rejects a container requirement before constructing team or Arena resources', async () => {
    const config = new Config({
      model: 'test-model',
      targetDir: process.cwd(),
      cwd: process.cwd(),
      debugMode: false,
      agentExecutionBackend: 'container',
    });
    const createRegistry = vi.spyOn(config, 'createToolRegistry');
    const contentGeneratorCalls = vi.mocked(createContentGenerator).mock.calls
      .length;
    const coreCalls = vi.mocked(AgentCore).mock.calls.length;
    const containedBackend = new InProcessBackend(config);

    await expect(
      containedBackend.spawnAgent(createSpawnConfig('contained-team-agent')),
    ).rejects.toThrow('team and Arena agents are unsupported');

    expect(createRegistry).not.toHaveBeenCalled();
    expect(createContentGenerator).toHaveBeenCalledTimes(contentGeneratorCalls);
    expect(AgentCore).toHaveBeenCalledTimes(coreCalls);
    expect(containedBackend.getAgent('contained-team-agent')).toBeUndefined();
    expect(containedBackend.getActiveAgentId()).toBeNull();
  });

  it('should throw when spawning without inProcess config', async () => {
    const config = { agentId: 'test', command: 'node', args: [], cwd: '/tmp' };
    await expect(backend.spawnAgent(config)).rejects.toThrow(
      'InProcessBackend requires inProcess config',
    );
  });

  it('should spawn an agent with inProcess config', async () => {
    await started(backend, 'agent-1');

    expect(backend.getActiveAgentId()).toBe('agent-1');
    expect(backend.getAgent('agent-1')).toBeDefined();
    const call = destructureAgentCoreCall(vi.mocked(AgentCore).mock.calls[0]!);
    expect(call.taskName).toBe('Do something');
    expect(call.subagentId).toBe('agent-1');
  });

  it('routes owned monitor notifications into the agent message queue', async () => {
    // AgentInteractive frames tool bodies under the agent identity, so its
    // monitors are agent-owned with no session fallback: spawn must register
    // the routing; stop must tear it down and cancel anything still running.
    const parent = mockConfig();
    const monitorRegistry = parent.getMonitorRegistry() as Record<
      'setAgentNotificationCallback' | 'cancelRunningForOwner',
      Mock
    >;
    const localBackend = await backendOn(parent, 'agent-1');

    expect(monitorRegistry.setAgentNotificationCallback).toHaveBeenCalledWith(
      'agent-1',
      expect.any(Function),
    );
    const callback = monitorRegistry.setAgentNotificationCallback.mock
      .calls[0]![1] as (displayText: string, modelText: string) => void;

    const agent = localBackend.getAgent('agent-1')!;
    const enqueueSpy = vi.spyOn(agent, 'enqueueMessage');
    callback('display text', 'model text');
    expect(enqueueSpy).toHaveBeenCalledWith('model text');

    localBackend.stopAgent('agent-1');
    expect(monitorRegistry.cancelRunningForOwner).toHaveBeenCalledWith(
      'agent-1',
      { notify: false },
    );
    expect(monitorRegistry.setAgentNotificationCallback).toHaveBeenCalledWith(
      'agent-1',
      undefined,
    );
  });

  it('should set first spawned agent as active', async () => {
    await started(backend, 'agent-1', 'agent-2');
    expect(backend.getActiveAgentId()).toBe('agent-1');
  });

  it('should navigate between agents', async () => {
    await started(backend, 'agent-1', 'agent-2', 'agent-3');
    expect(backend.getActiveAgentId()).toBe('agent-1');
    nav('switchToNext', 'agent-2');
    nav('switchToNext', 'agent-3');
    nav('switchToNext', 'agent-1'); // wraps around
    nav('switchToPrevious', 'agent-3');
  });

  it('should switch to a specific agent', async () => {
    await started(backend, 'agent-1', 'agent-2');
    backend.switchTo('agent-2');
    expect(backend.getActiveAgentId()).toBe('agent-2');
  });

  it('should forward input to active agent', async () => {
    await started(backend, 'agent-1');
    expect(backend.forwardInput('hello')).toBe(true);
  });

  it('should return false for forwardInput with no active agent', () => {
    expect(backend.forwardInput('hello')).toBe(false);
  });

  it('should write to specific agent', async () => {
    await started(backend, 'agent-1');
    expect(backend.writeToAgent('agent-1', 'hello')).toBe(true);
    expect(backend.writeToAgent('nonexistent', 'hello')).toBe(false);
  });

  it('runs direct enqueued teammate messages inside teammate identity', async () => {
    const seenContexts: unknown[] = [];
    runReasoningLoopMock.mockImplementation(async () => {
      seenContexts.push(getTeammateContext());
      return { text: 'Done', terminateMode: null, turnsUsed: 1 };
    });
    await started(
      backend,
      createSpawnConfig('planner@test-team', {
        initialTask: undefined,
        teammateIdentity: {
          agentId: 'planner@test-team',
          agentName: 'planner',
          teamName: 'test-team',
          isTeamLead: false,
          planModeRequired: true,
        },
      }),
    );
    const agent = backend.getAgent('planner@test-team');
    expect(agent).toBeDefined();

    agent!.enqueueMessage('follow-up from teammate tab');
    await agent!.waitForCompletion();

    expect(seenContexts).toEqual([
      expect.objectContaining({
        agentId: 'planner@test-team',
        agentName: 'planner',
        teamName: 'test-team',
        planModeRequired: true,
      }),
    ]);
  });

  it('should return null for screen capture methods', async () => {
    await started(backend, 'agent-1');
    expect(backend.getActiveSnapshot()).toBeNull();
    expect(backend.getAgentSnapshot('agent-1')).toBeNull();
    expect(backend.getAgentScrollbackLength('agent-1')).toBe(0);
  });

  it('should return null for attach hint', () => {
    expect(backend.getAttachHint()).toBeNull();
  });

  it('should stop a specific agent', async () => {
    await started(backend, 'agent-1');
    expect(backend.getAgent('agent-1')).toBeDefined();
    backend.stopAgent('agent-1');
    // Agent should eventually reach cancelled state
  });

  it('stopAgent disposes the per-agent tool registry and clears the Map entry', async () => {
    // Regression: registries lived in a flat array disposed only at cleanup().
    // stopAgent must (1) call registry.stop() so listeners on shared managers
    // (SkillManager / SubagentManager) are released at once, and (2) delete
    // the Map entry so cleanup() doesn't double-stop and a same-id respawn
    // can take a fresh registry.
    const registries = registriesOf(await started(backend, 'agent-1'));
    const registry = registries.get('agent-1');
    expect(registry).toBeDefined();
    expect(registries.has('agent-1')).toBe(true);

    backend.stopAgent('agent-1');

    expect(registry!.stop).toHaveBeenCalledTimes(1);
    expect(registries.has('agent-1')).toBe(false);
  });

  it('stopAgent on a non-existent id is a no-op (no throw, Map untouched)', async () => {
    // Defensive: an upstream caller (e.g. SubagentManager) that lost track may
    // stop an unknown id; ignore it rather than throw, matching `agents.get`
    // returning undefined for the agent itself in the same method.
    const registries = registriesOf(await started(backend, 'agent-1'));
    const sizeBefore = registries.size;

    expect(() => backend.stopAgent('agent-does-not-exist')).not.toThrow();
    expect(registries.size).toBe(sizeBefore);
  });

  it('stopAgent keeps the handle readable for post-stop inspection while freeing the id for respawn', async () => {
    // ArenaManager reads transcripts via getAgent after its timeout path stops
    // agents (collectResults -> getAgentTranscript); deleting the handle in
    // stopAgent silently dropped those reads. Respawns must still work.
    await started(backend, 'agent-1');
    const agent = backend.getAgent('agent-1');
    expect(agent).toBeDefined();

    backend.stopAgent('agent-1');

    const retained = backend.getAgent('agent-1');
    expect(retained).toBeDefined();
    expect(retained).toBe(agent);
    expect(retained!.getMessages()).toEqual(expect.any(Array));

    // Same-id respawn still succeeds and replaces the retained handle.
    await backend.spawnAgent(createSpawnConfig('agent-1'));
    const respawned = backend.getAgent('agent-1');
    expect(respawned).toBeDefined();
    expect(respawned).not.toBe(agent);

    // The respawned agent is live again: input and switching work.
    expect(backend.writeToAgent('agent-1', 'follow-up')).toBe(true);
    backend.switchTo('agent-1');
    expect(backend.getActiveAgentId()).toBe('agent-1');
  });

  it('stopAgent reassigns the active agent and removes the stopped id from navigation', async () => {
    // Mutation pin for stopAgent roster bookkeeping: without the agentOrder
    // splice a same-id respawn duplicates the entry and navigate() wrap-around
    // skews; without the activeAgentId reassignment, forwardInput resolves to
    // a stopped agent and typed input is silently dropped.
    await started(backend, 'agent-1', 'agent-2');
    expect(backend.getActiveAgentId()).toBe('agent-1');

    backend.stopAgent('agent-1');

    expect(backend.getActiveAgentId()).toBe('agent-2');
    expect(backend.forwardInput('typed input')).toBe(true);
    expect(backend.writeToAgent('agent-1', 'to a stopped agent')).toBe(false);

    // Switching back to the stopped agent must not stick the roster
    // on a dead handle (enqueueMessage would restart its run loop).
    backend.switchTo('agent-1');
    expect(backend.getActiveAgentId()).toBe('agent-2');

    // Same-id respawn must not duplicate the roster entry: navigation
    // cycles over exactly the two surviving ids.
    await backend.spawnAgent(createSpawnConfig('agent-1'));
    expect(backend.getActiveAgentId()).toBe('agent-2');
    nav('switchToNext', 'agent-1');
    nav('switchToNext', 'agent-2');
    nav('switchToPrevious', 'agent-1');
  });

  it('cleanup disposes all remaining registries (covers the in-flight shutdown path)', async () => {
    // Even when stopAgent was not called for every agent (fast-path shutdown,
    // tab close), cleanup must drain the Map so listeners don't outlive exit.
    const { localBackend, registries, r1, r2 } = await twoWithOwnRegistries();
    expect(r1).not.toBe(r2);

    await localBackend.cleanup();

    expect(r1.stop).toHaveBeenCalledTimes(1);
    expect(r2.stop).toHaveBeenCalledTimes(1);
    expect(registries.size).toBe(0);
  });

  it('should stop all agents', async () => {
    const { localBackend, registries, r1, r2 } = await twoWithOwnRegistries();

    localBackend.stopAll();

    expect(r1.stop).toHaveBeenCalledTimes(1);
    expect(r2.stop).toHaveBeenCalledTimes(1);
    expect(registries.size).toBe(0);
  });

  it('restores approval override cleanup when per-agent setup fails', async () => {
    const parentConfig = mockConfig();
    parentConfig.createToolRegistry.mockRejectedValueOnce(
      new Error('registry boom'),
    );
    const manager = mockPermissionManager(parentConfig);
    const localBackend = await backendOn(parentConfig);

    const config = createSpawnConfig('agent-1', {
      approvalMode: ApprovalMode.AUTO,
    });
    await expect(localBackend.spawnAgent(config)).rejects.toThrow(
      'registry boom',
    );
    expect(manager.stripDangerousRulesForAutoMode).toHaveBeenCalledTimes(1);
    expect(manager.restoreDangerousRules).toHaveBeenCalledTimes(1);
  });

  it('keeps dangerous rules stripped until the last AUTO child exits', async () => {
    const { manager, localBackend } = await twoAutoChildren(mockConfig());

    expect(manager.stripDangerousRulesForAutoMode).toHaveBeenCalledTimes(1);
    localBackend.stopAgent('agent-1');
    expect(manager.restoreDangerousRules).not.toHaveBeenCalled();

    localBackend.stopAgent('agent-2');
    expect(manager.restoreDangerousRules).toHaveBeenCalledTimes(1);
  });

  it('continues tracking AUTO children while the parent mode changes', async () => {
    let parentMode = DEFAULT_MODE;
    const parentConfig = mockConfig();
    parentConfig.getApprovalMode.mockImplementation(() => parentMode);
    const { manager, localBackend } = await twoAutoChildren(parentConfig);
    parentMode = ApprovalMode.AUTO;
    localBackend.stopAgent('agent-1');
    parentMode = DEFAULT_MODE;
    localBackend.stopAgent('agent-2');

    expect(manager.stripDangerousRulesForAutoMode).toHaveBeenCalledTimes(1);
    expect(manager.restoreDangerousRules).toHaveBeenCalledTimes(1);
  });

  it('should cleanup all agents', async () => {
    await started(backend, 'agent-1');
    await backend.cleanup();

    expect(backend.getActiveAgentId()).toBeNull();
    expect(backend.getAgent('agent-1')).toBeUndefined();
  });

  it('should fire exit callback when agent completes', async () => {
    await backend.init();

    const exitCallback = vi.fn();
    backend.setOnAgentExit(exitCallback);

    await backend.spawnAgent(createSpawnConfig('agent-1'));

    // The mock agent idles after initialTask; a graceful shutdown completes it.
    const agent = backend.getAgent('agent-1');
    expect(agent).toBeDefined();
    await agent!.shutdown();

    await vi.waitFor(() => {
      expect(exitCallback).toHaveBeenCalledWith(
        'agent-1',
        expect.any(Number),
        null,
      );
    });
  });

  it('should pass per-agent cwd to AgentCore via config proxy', async () => {
    const agentCwd = '/worktree/agent-1';
    await backendOn(createMockConfig(), {
      ...createSpawnConfig('agent-1'),
      cwd: agentCwd,
    });

    const agentContext = lastCoreCall(true).runtimeContext as unknown as Config;
    expect(agentContext.getWorkingDir()).toBe(agentCwd);
    expect(agentContext.getTargetDir()).toBe(agentCwd);
    expect(agentContext.getToolRegistry()).toBeDefined();

    // This config is LONG-LIVED (the agent keeps it), so it must NOT carry the
    // rebuilt marker: `hasRebuiltToolRegistry` reads it through the prototype
    // chain, so a later wrapper on it (a dir-scoped workflow dispatch) would
    // skip `buildSubagentContextOverride`'s rebuild, the sole re-anchoring
    // that lifts the subagent's tools above that wrapper, and relative paths
    // would resolve against this agent's cwd, not the provisioned worktree.
    // Pinned HERE, at the call site: the helper's own tests pass explicit
    // options, and dropping `{ markRebuilt: false }` left every suite green.
    expect(hasRebuiltToolRegistry(agentContext)).toBe(false);
  });

  it('uses a per-agent approval mode without mutating the parent config', async () => {
    const parentConfig = mockConfig();
    const agentContext = await agentConfigOn(parentConfig, PLAN_MODE);
    expect(agentContext.getApprovalMode()).toBe(PLAN_MODE);
    expect(agentContext.getPrePlanMode()).toBe(DEFAULT_MODE);
    expect(parentConfig.getApprovalMode()).toBe(DEFAULT_MODE);
    expect(parentConfig.setApprovalMode).not.toHaveBeenCalled();
  });

  it('copies the inherited plan-exit event into a per-agent mode override', async () => {
    const parentConfig: Record<string, unknown> = createMockConfig();
    Object.assign(parentConfig, {
      approvalMode: ApprovalMode.DEFAULT,
      manualPlanExitNoticeEventState: { version: 2, kind: 'manual-exit' },
      takePendingManualPlanExitNotice:
        Config.prototype.takePendingManualPlanExitNotice,
      restorePendingManualPlanExitNotice:
        Config.prototype.restorePendingManualPlanExitNotice,
    });
    await backendOn(
      parentConfig,
      createSpawnConfig('agent-1', { approvalMode: ApprovalMode.AUTO_EDIT }),
    );

    const agentContext = lastCoreCall().runtimeContext as unknown as Config;
    expect(agentContext.takePendingManualPlanExitNotice()).toEqual({
      version: 2,
      currentMode: ApprovalMode.AUTO_EDIT,
    });

    Object.assign(parentConfig['manualPlanExitNoticeEventState'] as object, {
      version: 3,
      kind: 'manual-exit',
    });
    expect(agentContext.takePendingManualPlanExitNotice()).toBeUndefined();
    expect(
      Config.prototype.takePendingManualPlanExitNotice.call(
        parentConfig as unknown as Config,
      ),
    ).toEqual({ version: 3, currentMode: ApprovalMode.DEFAULT });
  });

  it('restores a plan-mode per-agent config to default without mutating the parent config', async () => {
    const parentConfig = mockConfig();
    const agentContext = await agentConfigOn(parentConfig, PLAN_MODE);
    agentContext.setApprovalMode(DEFAULT_MODE);

    expect(agentContext.getApprovalMode()).toBe(DEFAULT_MODE);
    expect(agentContext.getPrePlanMode()).toBe(DEFAULT_MODE);
    expect(parentConfig.getApprovalMode()).toBe(DEFAULT_MODE);
    expect(parentConfig.setApprovalMode).not.toHaveBeenCalled();
  });

  it('lets a teammate without an explicit approval mode switch modes child-locally', async () => {
    // No `inProcess.approvalMode` — TeamManager passes undefined for every
    // non-plan teammate. Tools bind to this config, so "Proceed always"
    // (AUTO_EDIT) and Shift+Tab mode switches must transition child-local
    // state instead of hitting the bare-derived-Config guard.
    const parentConfig = mockConfig();
    const agentContext = await agentConfigOn(parentConfig);

    expect(agentContext.getApprovalMode()).toBe(DEFAULT_MODE);

    // "Proceed always" on a tool confirmation.
    agentContext.setApprovalMode(ApprovalMode.AUTO_EDIT);
    expect(agentContext.getApprovalMode()).toBe(ApprovalMode.AUTO_EDIT);
    expect(parentConfig.getApprovalMode()).toBe(DEFAULT_MODE);
    expect(parentConfig.setApprovalMode).not.toHaveBeenCalled();

    // Shift+Tab back to default.
    agentContext.setApprovalMode(DEFAULT_MODE);
    expect(agentContext.getApprovalMode()).toBe(DEFAULT_MODE);
    expect(parentConfig.getApprovalMode()).toBe(DEFAULT_MODE);
  });

  it('uses a teammate-scoped plan file path in per-agent config', async () => {
    const parentConfig = mockConfig();
    parentConfig.getPlanFilePath = vi
      .fn()
      .mockReturnValue(join('/tmp/plans', 'test-session.md'));
    const agentContext = await agentConfigOn(parentConfig);
    expect(agentContext.getPlanFilePath()).toBe(
      join('/tmp/plans', 'test-session-agent-1.md'),
    );
    expect(agentContext.getPlanFilePath()).not.toBe(
      parentConfig.getPlanFilePath(),
    );
  });

  it('keeps Config approval-mode safety checks on per-agent config', async () => {
    const parentConfig = mockConfig();
    parentConfig.isTrustedFolder.mockReturnValue(false);
    const agentContext = await agentConfigOn(parentConfig, PLAN_MODE);
    expect(() => agentContext.setApprovalMode(ApprovalMode.AUTO_EDIT)).toThrow(
      'Cannot enable privileged approval modes in an untrusted folder.',
    );
  });

  it('downgrades privileged initial approval modes in untrusted folders', async () => {
    const parentConfig = mockConfig();
    parentConfig.isTrustedFolder.mockReturnValue(false);
    const agentContext = await agentConfigOn(
      parentConfig,
      ApprovalMode.AUTO_EDIT,
    );
    expect(agentContext.getApprovalMode()).toBe(ApprovalMode.DEFAULT);
  });

  it('should pass parent custom ignore files to per-agent file service', async () => {
    const parentConfig = mockConfig();
    const agentContext = await agentConfigOn(parentConfig);
    expect(parentConfig.getFileFilteringOptions).toHaveBeenCalled();
    expect(agentContext.getFileService().getQwenIgnoreFileNamesDisplay()).toBe(
      '.qwenignore, .cursorignore',
    );
  });

  it('should propagate runConfig limits to AgentInteractive', async () => {
    const config = createSpawnConfig('agent-1');
    config.inProcess!.runtimeConfig.runConfig = {
      max_turns: 5,
      max_time_minutes: 10,
    };
    await started(backend, config);

    const agent = backend.getAgent('agent-1');
    expect(agent).toBeDefined();
    expect(agent!.config.maxTurnsPerMessage).toBe(5);
    expect(agent!.config.maxTimeMinutesPerMessage).toBe(10);
  });

  it('should default limits to undefined when runConfig omits them', async () => {
    const config = createSpawnConfig('agent-1');
    config.inProcess!.runtimeConfig.runConfig = {};
    await started(backend, config);

    const agent = backend.getAgent('agent-1');
    expect(agent).toBeDefined();
    expect(agent!.config.maxTurnsPerMessage).toBeUndefined();
    expect(agent!.config.maxTimeMinutesPerMessage).toBeUndefined();
  });

  it('should give each agent its own cwd even when sharing a backend', async () => {
    await started(
      backend,
      { ...createSpawnConfig('agent-1'), cwd: '/worktree/agent-1' },
      { ...createSpawnConfig('agent-2'), cwd: '/worktree/agent-2' },
    );

    const calls = agentCoreCalls();
    const ctx1 = calls.at(-2)![1] as Config;
    const ctx2 = calls.at(-1)![1] as Config;

    expect(ctx1.getWorkingDir()).toBe('/worktree/agent-1');
    expect(ctx1.getTargetDir()).toBe('/worktree/agent-1');
    expect(ctx2.getWorkingDir()).toBe('/worktree/agent-2');
    expect(ctx2.getTargetDir()).toBe('/worktree/agent-2');
  });

  it('should throw when spawning a duplicate agent ID', async () => {
    await started(backend, 'agent-1');
    await expect(
      backend.spawnAgent(createSpawnConfig('agent-1')),
    ).rejects.toThrow('Agent "agent-1" already exists.');
  });

  it('should fire exit callback with code 1 when start() throws', async () => {
    const registry = createMockToolRegistry();
    const parentConfig = mockConfig();
    parentConfig.createToolRegistry = vi.fn().mockResolvedValue(registry);
    const failingBackend = new InProcessBackend(parentConfig as never);
    // Make createChat throw for this test
    const emitter = () => ({ on: vi.fn(), off: vi.fn(), emit: vi.fn() });
    const createChat = vi.fn().mockRejectedValue(new Error('Auth failed'));
    (AgentCore as unknown as Mock).mockImplementationOnce(() => ({
      subagentId: 'mock-id',
      name: 'mock-agent',
      runInHookFrame: <T>(fn: () => T): T => fn(),
      eventEmitter: emitter(),
      stats: { start: vi.fn(), getSummary: vi.fn().mockReturnValue({}) },
      createChat,
      prepareTools: vi.fn().mockReturnValue([]),
      getEventEmitter: vi.fn().mockReturnValue(emitter()),
      getExecutionSummary: vi.fn().mockReturnValue({}),
    }));

    await failingBackend.init();

    const exitCallback = vi.fn();
    failingBackend.setOnAgentExit(exitCallback);

    // spawnAgent should NOT throw — it catches the error internally
    await expect(
      failingBackend.spawnAgent(createSpawnConfig('agent-fail')),
    ).resolves.toBeUndefined();

    expect(createChat).toHaveBeenCalledTimes(1);
    expect(exitCallback).toHaveBeenCalledWith('agent-fail', 1, null);
    expect(registry.stop).toHaveBeenCalledTimes(1);
    expect(failingBackend.getAgent('agent-fail')).toBeUndefined();
    expect(failingBackend.getActiveAgentId()).toBeNull();
    const internals = failingBackend as unknown as {
      agentApprovalCleanups: Map<string, () => void>;
      agentRegistries: Map<string, unknown>;
    };
    expect(internals.agentApprovalCleanups.size).toBe(0);
    expect(internals.agentRegistries.size).toBe(0);
  });

  it('should return true immediately from waitForAll after cleanup', async () => {
    await started(backend, 'agent-1');
    await backend.cleanup();

    expect(await backend.waitForAll(5000)).toBe(true);
  });

  describe('chat history', () => {
    it('should pass chatHistory to AgentInteractive config', async () => {
      const chatHistory = [
        userText('prior question'),
        modelText('prior answer'),
      ];
      await started(backend, createSpawnConfig('agent-1', { chatHistory }));

      const agent = backend.getAgent('agent-1');
      expect(agent).toBeDefined();
      expect(agent!.config.chatHistory).toEqual(chatHistory);
    });

    it('should leave chatHistory undefined when not provided', async () => {
      await started(backend, 'agent-1');

      const agent = backend.getAgent('agent-1');
      expect(agent).toBeDefined();
      expect(agent!.config.chatHistory).toBeUndefined();
    });
  });

  describe('auth isolation', () => {
    const withAuth = (
      agentId: string,
      authOverrides: InProcessSpawnConfig['authOverrides'],
    ) => createSpawnConfig(agentId, { authOverrides });

    it('should create per-agent ContentGenerator when authOverrides is provided', async () => {
      await started(
        backend,
        withAuth('agent-1', {
          authType: 'anthropic',
          apiKey: 'agent-key-123',
          baseUrl: 'https://agent.example.com',
        }),
      );

      // Owner must be the per-agent override Config (the same instance
      // AgentCore receives as runtimeContext) — NOT the parent. Asserting
      // that match exactly catches a regression where `base` slips in.
      const { runtimeContext: agentContext } = lastCoreCall();
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          authType: 'anthropic',
          apiKey: 'agent-key-123',
          baseUrl: 'https://agent.example.com',
          model: 'test-model',
        }),
        agentContext,
      );
    });

    it('should pass per-agent ContentGenerator via runtimeView', async () => {
      const agentGenerator = { generateContentStream: vi.fn() };
      mockCreate.mockResolvedValueOnce(agentGenerator);

      await started(
        backend,
        withAuth('agent-1', { authType: 'anthropic', apiKey: 'agent-key' }),
      );

      const { runtimeView } = lastCoreCall();
      expect(runtimeView).toBeDefined();
      expect(runtimeView!.contentGenerator).toBe(agentGenerator);
      expect(runtimeView!.contentGeneratorConfig.authType).toBe('anthropic');
      expect(backend.getAgentContentGenerator('agent-1')).toBe(agentGenerator);
    });

    it('should leave parent ContentGenerator unchanged without authOverrides', async () => {
      mockCreate.mockClear();
      await started(backend, 'agent-1');
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('should fall back to parent ContentGenerator if per-agent creation fails', async () => {
      mockCreate.mockRejectedValueOnce(new Error('Auth failed'));
      await backend.init();

      // Should not throw — falls back gracefully
      await expect(
        backend.spawnAgent(
          withAuth('agent-1', { authType: 'anthropic', apiKey: 'bad-key' }),
        ),
      ).resolves.toBeUndefined();

      // No runtimeView when per-agent creation failed; agent inherits parent.
      expect(lastCoreCall().runtimeView).toBeUndefined();
      expect(backend.getAgentContentGenerator('agent-1')).toBeUndefined();
    });

    it('should give different agents different ContentGenerators', async () => {
      const gen1 = { generateContentStream: vi.fn() };
      const gen2 = { generateContentStream: vi.fn() };
      mockCreate.mockResolvedValueOnce(gen1).mockResolvedValueOnce(gen2);

      await started(
        backend,
        withAuth('agent-1', {
          authType: 'openai',
          apiKey: 'key-1',
          baseUrl: 'https://api1.example.com',
        }),
        withAuth('agent-2', {
          authType: 'anthropic',
          apiKey: 'key-2',
          baseUrl: 'https://api2.example.com',
        }),
      );

      const calls = agentCoreCalls();
      const view1 = calls.at(-2)![8] as { contentGenerator: unknown };
      const view2 = calls.at(-1)![8] as { contentGenerator: unknown };

      expect(view1.contentGenerator).toBe(gen1);
      expect(view2.contentGenerator).toBe(gen2);
      expect(view1.contentGenerator).not.toBe(view2.contentGenerator);
    });
  });
});

describe('InProcessBackend Session Workflow revision write-through', () => {
  // Teammates and arena agents run on InProcessBackend.createPerAgentConfig, a
  // third Config-wrapper family besides createApprovalModeOverride and
  // buildSubagentContextOverride. Its rebuilt registry binds TodoWriteTool to
  // `this.config = wrapper`, so a divergent todo_write clears the approved
  // session-global revision through the wrapper; the clear must land on the
  // root Config, not as a wrapper own property (the base would keep rejecting
  // Agent launches against a plan that no longer exists).
  const approvedRevision = {
    planId: 'plan-approved',
    sourceCallId: 'call-approved',
    todoIds: ['a', 'b'],
  };

  async function spawnWithWorkflowBase(approvalMode?: ApprovalMode) {
    const base = new Config({
      cwd: '/tmp',
      targetDir: '/tmp',
      debugMode: false,
      model: 'test-model',
      usageStatisticsEnabled: false,
      bareMode: true,
      sessionWorkflowEnabled: true,
    });
    const registry = await base.createToolRegistry(undefined, {
      skipDiscovery: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (base as any).toolRegistry = registry;
    base.setSessionWorkflowPlanRevision(approvedRevision);
    expect(base.isSessionWorkflowTodoContextActive()).toBe(true);

    await started(
      new InProcessBackend(base),
      createSpawnConfig('agent-1', {
        initialTask: undefined,
        ...(approvalMode !== undefined ? { approvalMode } : {}),
      }),
    );
    const agentContext = lastCoreCall().runtimeContext as unknown as Config;
    return { base, agentContext };
  }

  it('routes revision mutations from the plain per-agent wrapper to the base Config', async () => {
    const { base, agentContext } = await spawnWithWorkflowBase();
    // Reads keep walking the prototype to the session-global value.
    expect(agentContext.getSessionWorkflowPlanRevision()?.planId).toBe(
      'plan-approved',
    );

    // A divergent todo_write inside the teammate clears through its wrapper.
    agentContext.clearSessionWorkflowPlanRevision();
    expect(base.getSessionWorkflowPlanRevision()).toBeUndefined();
    expect(base.isSessionWorkflowTodoContextActive()).toBe(false);

    // And a bind through the wrapper lands on the base too.
    agentContext.setSessionWorkflowPlanRevision({
      planId: 'plan-teammate',
      sourceCallId: 'call-teammate',
      todoIds: ['c'],
    });
    expect(base.getSessionWorkflowPlanRevision()?.planId).toBe('plan-teammate');
  });

  it('routes revision mutations through the per-agent approval-mode wrapper too', async () => {
    const { base, agentContext } = await spawnWithWorkflowBase(
      ApprovalMode.PLAN,
    );

    agentContext.clearSessionWorkflowPlanRevision();
    expect(base.getSessionWorkflowPlanRevision()).toBeUndefined();

    agentContext.setSessionWorkflowPlanRevision({
      planId: 'plan-arena',
      sourceCallId: 'call-arena',
      todoIds: ['d'],
    });
    expect(base.getSessionWorkflowPlanRevision()?.planId).toBe('plan-arena');
  });
});
