/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InProcessBackend } from './InProcessBackend.js';
import { DISPLAY_MODE } from './types.js';
import type { AgentSpawnConfig } from './types.js';
import { AgentCore } from '../runtime/agent-core.js';
import { getTeammateContext } from '../team/identity.js';
import { createContentGenerator } from '../../core/contentGenerator.js';
import { ApprovalMode, type Config } from '../../config/config.js';

const DEFAULT_MODE = 'default' as ApprovalMode;
const PLAN_MODE = 'plan' as ApprovalMode;

// Mock createContentGenerator to avoid real API client setup
const mockContentGenerator = {
  generateContentStream: vi.fn(),
};
const runReasoningLoopMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    text: 'Done',
    terminateMode: null,
    turnsUsed: 1,
  }),
);
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

// Mock AgentCore and AgentInteractive to avoid real model calls.
// The mock must also expose the observable-state accessors that
// AgentInteractive now delegates to (getMessages, pendingApprovals,
// liveOutputs, shellPids, pushMessage, etc.) — otherwise agent lifecycle
// methods like abort() / addMessage() fail on missing prototype methods.
vi.mock('../runtime/agent-core.js', () => ({
  AgentCore: vi.fn().mockImplementation(() => {
    const messages: Array<Record<string, unknown>> = [];
    const pendingApprovals = new Map<string, unknown>();
    const liveOutputs = new Map<string, unknown>();
    const shellPids = new Map<string, number>();
    const emitter = {
      on: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
    };
    return {
      subagentId: 'mock-id',
      name: 'mock-agent',
      eventEmitter: emitter,
      stats: {
        start: vi.fn(),
        getSummary: vi.fn().mockReturnValue({}),
      },
      createChat: vi.fn().mockResolvedValue({}),
      prepareTools: vi.fn().mockReturnValue([]),
      runReasoningLoop: runReasoningLoopMock,
      getEventEmitter: vi.fn().mockReturnValue(emitter),
      getExecutionSummary: vi.fn().mockReturnValue({}),
      getMessages: () => messages,
      getPendingApprovals: () => pendingApprovals,
      getLiveOutputs: () => liveOutputs,
      getShellPids: () => shellPids,
      pushMessage: (
        role: string,
        content: string,
        options?: { thought?: boolean; metadata?: Record<string, unknown> },
      ) => {
        const message: Record<string, unknown> = {
          role,
          content,
          timestamp: Date.now(),
        };
        if (options?.thought) message['thought'] = true;
        if (options?.metadata) message['metadata'] = options.metadata;
        messages.push(message);
      },
      setPendingApproval: (callId: string, details: unknown) =>
        pendingApprovals.set(callId, details),
      deletePendingApproval: (callId: string) =>
        pendingApprovals.delete(callId),
      clearPendingApprovals: () => pendingApprovals.clear(),
    };
  }),
}));

// Mirrors the positional AgentCore constructor parameters so tests can
// destructure by name instead of indexing — adding new parameters can't
// silently shift assertions onto the wrong slot.
function destructureAgentCoreCall(call: unknown[]) {
  return {
    name: call[0] as string,
    runtimeContext: call[1] as Record<string, unknown>,
    promptConfig: call[2],
    modelConfig: call[3],
    runConfig: call[4],
    toolConfig: call[5],
    eventEmitter: call[6],
    hooks: call[7],
    runtimeView: call[8] as
      | {
          contentGenerator: unknown;
          contentGeneratorConfig: { authType: string; model?: string };
        }
      | undefined,
  };
}

function createMockToolRegistry() {
  return {
    getFunctionDeclarations: vi.fn().mockReturnValue([]),
    getAllTools: vi.fn().mockReturnValue([]),
    getAllToolNames: vi.fn().mockReturnValue([]),
    registerTool: vi.fn(),
    copyDiscoveredToolsFrom: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockConfig() {
  const registry = createMockToolRegistry();
  return {
    getModel: vi.fn().mockReturnValue('test-model'),
    getToolRegistry: vi.fn().mockReturnValue(registry),
    getSessionId: vi.fn().mockReturnValue('test-session'),
    getPlansDir: vi.fn().mockReturnValue('/tmp/plans'),
    getApprovalMode: vi.fn().mockReturnValue(DEFAULT_MODE),
    getPrePlanMode: vi.fn().mockReturnValue(DEFAULT_MODE),
    getPlanGateState: vi.fn().mockReturnValue(undefined),
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

function createSpawnConfig(agentId: string): AgentSpawnConfig {
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
    },
  };
}

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

  it('should have IN_PROCESS type', () => {
    expect(backend.type).toBe(DISPLAY_MODE.IN_PROCESS);
  });

  it('should init without error', async () => {
    await expect(backend.init()).resolves.toBeUndefined();
  });

  it('should throw when spawning without inProcess config', async () => {
    const config: AgentSpawnConfig = {
      agentId: 'test',
      command: 'node',
      args: [],
      cwd: '/tmp',
    };

    await expect(backend.spawnAgent(config)).rejects.toThrow(
      'InProcessBackend requires inProcess config',
    );
  });

  it('should spawn an agent with inProcess config', async () => {
    await backend.init();
    await backend.spawnAgent(createSpawnConfig('agent-1'));

    expect(backend.getActiveAgentId()).toBe('agent-1');
    expect(backend.getAgent('agent-1')).toBeDefined();
  });

  it('should set first spawned agent as active', async () => {
    await backend.init();
    await backend.spawnAgent(createSpawnConfig('agent-1'));
    await backend.spawnAgent(createSpawnConfig('agent-2'));

    expect(backend.getActiveAgentId()).toBe('agent-1');
  });

  it('should navigate between agents', async () => {
    await backend.init();
    await backend.spawnAgent(createSpawnConfig('agent-1'));
    await backend.spawnAgent(createSpawnConfig('agent-2'));
    await backend.spawnAgent(createSpawnConfig('agent-3'));

    expect(backend.getActiveAgentId()).toBe('agent-1');

    backend.switchToNext();
    expect(backend.getActiveAgentId()).toBe('agent-2');

    backend.switchToNext();
    expect(backend.getActiveAgentId()).toBe('agent-3');

    // Wraps around
    backend.switchToNext();
    expect(backend.getActiveAgentId()).toBe('agent-1');

    backend.switchToPrevious();
    expect(backend.getActiveAgentId()).toBe('agent-3');
  });

  it('should switch to a specific agent', async () => {
    await backend.init();
    await backend.spawnAgent(createSpawnConfig('agent-1'));
    await backend.spawnAgent(createSpawnConfig('agent-2'));

    backend.switchTo('agent-2');
    expect(backend.getActiveAgentId()).toBe('agent-2');
  });

  it('should forward input to active agent', async () => {
    await backend.init();
    await backend.spawnAgent(createSpawnConfig('agent-1'));

    const result = backend.forwardInput('hello');
    expect(result).toBe(true);
  });

  it('should return false for forwardInput with no active agent', () => {
    expect(backend.forwardInput('hello')).toBe(false);
  });

  it('should write to specific agent', async () => {
    await backend.init();
    await backend.spawnAgent(createSpawnConfig('agent-1'));

    expect(backend.writeToAgent('agent-1', 'hello')).toBe(true);
    expect(backend.writeToAgent('nonexistent', 'hello')).toBe(false);
  });

  it('runs direct enqueued teammate messages inside teammate identity', async () => {
    const seenContexts: unknown[] = [];
    runReasoningLoopMock.mockImplementation(async () => {
      seenContexts.push(getTeammateContext());
      return { text: 'Done', terminateMode: null, turnsUsed: 1 };
    });
    await backend.init();
    const config = createSpawnConfig('planner@test-team');
    config.inProcess!.initialTask = undefined;
    Object.assign(config.inProcess!, {
      teammateIdentity: {
        agentId: 'planner@test-team',
        agentName: 'planner',
        teamName: 'test-team',
        isTeamLead: false,
        planModeRequired: true,
      },
    });

    await backend.spawnAgent(config);
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
    await backend.init();
    await backend.spawnAgent(createSpawnConfig('agent-1'));

    expect(backend.getActiveSnapshot()).toBeNull();
    expect(backend.getAgentSnapshot('agent-1')).toBeNull();
    expect(backend.getAgentScrollbackLength('agent-1')).toBe(0);
  });

  it('should return null for attach hint', () => {
    expect(backend.getAttachHint()).toBeNull();
  });

  it('should stop a specific agent', async () => {
    await backend.init();
    await backend.spawnAgent(createSpawnConfig('agent-1'));

    const agent = backend.getAgent('agent-1');
    expect(agent).toBeDefined();

    backend.stopAgent('agent-1');
    // Agent should eventually reach cancelled state
  });

  it('stopAgent disposes the per-agent tool registry and clears the Map entry', async () => {
    // Regression: per-agent tool registries used to live in a flat array
    // and only got disposed at backend cleanup(). With the Map, stopAgent
    // must (1) call registry.stop() so listeners on shared managers
    // (SkillManager / SubagentManager) get released immediately, and (2)
    // delete the Map entry so a subsequent cleanup() doesn't double-stop
    // and a re-spawn with the same id can take a fresh registry.
    await backend.init();
    await backend.spawnAgent(createSpawnConfig('agent-1'));

    type AgentRegistries = Map<string, { stop: ReturnType<typeof vi.fn> }>;
    const registries = (
      backend as unknown as { agentRegistries: AgentRegistries }
    ).agentRegistries;

    const registry = registries.get('agent-1');
    expect(registry).toBeDefined();
    expect(registries.has('agent-1')).toBe(true);

    backend.stopAgent('agent-1');

    expect(registry!.stop).toHaveBeenCalledTimes(1);
    expect(registries.has('agent-1')).toBe(false);
  });

  it('stopAgent on a non-existent id is a no-op (no throw, Map untouched)', async () => {
    // Defensive: if an upstream caller (e.g. SubagentManager) loses track
    // and asks to stop an unknown agent, we silently ignore rather than
    // throwing — matches the behavior of `agents.get` returning undefined
    // for the agent itself in the same method.
    await backend.init();
    await backend.spawnAgent(createSpawnConfig('agent-1'));

    type AgentRegistries = Map<string, { stop: ReturnType<typeof vi.fn> }>;
    const registries = (
      backend as unknown as { agentRegistries: AgentRegistries }
    ).agentRegistries;
    const sizeBefore = registries.size;

    expect(() => backend.stopAgent('agent-does-not-exist')).not.toThrow();
    expect(registries.size).toBe(sizeBefore);
  });

  it('cleanup disposes all remaining registries (covers the in-flight shutdown path)', async () => {
    // Even when stopAgent has not been called for every agent (fast-path
    // shutdown / tab close), cleanup must drain the Map so listeners
    // don't leak past process exit.
    //
    // Build a config whose createToolRegistry returns a fresh mock per
    // call — the shared `createMockConfig` returns the same singleton
    // every spawn, which would conflate r1/r2 into a single instance and
    // make per-registry call counts ambiguous.
    const config = createMockConfig() as unknown as {
      createToolRegistry: ReturnType<typeof vi.fn>;
    };
    config.createToolRegistry = vi
      .fn()
      .mockImplementation(() => Promise.resolve(createMockToolRegistry()));
    const localBackend = new InProcessBackend(config as never);
    await localBackend.init();
    await localBackend.spawnAgent(createSpawnConfig('agent-1'));
    await localBackend.spawnAgent(createSpawnConfig('agent-2'));

    type AgentRegistries = Map<string, { stop: ReturnType<typeof vi.fn> }>;
    const registries = (
      localBackend as unknown as { agentRegistries: AgentRegistries }
    ).agentRegistries;
    const r1 = registries.get('agent-1')!;
    const r2 = registries.get('agent-2')!;
    expect(r1).not.toBe(r2);

    await localBackend.cleanup();

    expect(r1.stop).toHaveBeenCalledTimes(1);
    expect(r2.stop).toHaveBeenCalledTimes(1);
    expect(registries.size).toBe(0);
  });

  it('should stop all agents', async () => {
    const config = createMockConfig() as unknown as {
      createToolRegistry: ReturnType<typeof vi.fn>;
    };
    config.createToolRegistry = vi
      .fn()
      .mockImplementation(() => Promise.resolve(createMockToolRegistry()));
    const localBackend = new InProcessBackend(config as never);
    await localBackend.init();
    await localBackend.spawnAgent(createSpawnConfig('agent-1'));
    await localBackend.spawnAgent(createSpawnConfig('agent-2'));

    type AgentRegistries = Map<string, { stop: ReturnType<typeof vi.fn> }>;
    const registries = (
      localBackend as unknown as { agentRegistries: AgentRegistries }
    ).agentRegistries;
    const r1 = registries.get('agent-1')!;
    const r2 = registries.get('agent-2')!;

    localBackend.stopAll();

    expect(r1.stop).toHaveBeenCalledTimes(1);
    expect(r2.stop).toHaveBeenCalledTimes(1);
    expect(registries.size).toBe(0);
  });

  it('restores approval override cleanup when per-agent setup fails', async () => {
    const restoreDangerousRules = vi.fn();
    const stripDangerousRulesForAutoMode = vi.fn();
    const parentConfig = createMockConfig() as unknown as {
      createToolRegistry: ReturnType<typeof vi.fn>;
      getPermissionManager: ReturnType<typeof vi.fn>;
    };
    parentConfig.createToolRegistry.mockRejectedValueOnce(
      new Error('registry boom'),
    );
    parentConfig.getPermissionManager.mockReturnValue({
      restoreDangerousRules,
      stripDangerousRulesForAutoMode,
    });
    const localBackend = new InProcessBackend(parentConfig as never);
    await localBackend.init();

    const config = createSpawnConfig('agent-1');
    config.inProcess!.approvalMode = ApprovalMode.AUTO;

    await expect(localBackend.spawnAgent(config)).rejects.toThrow(
      'registry boom',
    );
    expect(stripDangerousRulesForAutoMode).toHaveBeenCalledTimes(1);
    expect(restoreDangerousRules).toHaveBeenCalledTimes(1);
  });

  it('keeps dangerous rules stripped until the last AUTO child exits', async () => {
    const restoreDangerousRules = vi.fn();
    const stripDangerousRulesForAutoMode = vi.fn();
    const parentConfig = createMockConfig() as unknown as {
      getPermissionManager: ReturnType<typeof vi.fn>;
    };
    parentConfig.getPermissionManager.mockReturnValue({
      restoreDangerousRules,
      stripDangerousRulesForAutoMode,
    });
    const localBackend = new InProcessBackend(parentConfig as never);
    await localBackend.init();

    const first = createSpawnConfig('agent-1');
    first.inProcess!.approvalMode = ApprovalMode.AUTO;
    first.inProcess!.initialTask = undefined;
    const second = createSpawnConfig('agent-2');
    second.inProcess!.approvalMode = ApprovalMode.AUTO;
    second.inProcess!.initialTask = undefined;

    await localBackend.spawnAgent(first);
    await localBackend.spawnAgent(second);

    expect(stripDangerousRulesForAutoMode).toHaveBeenCalledTimes(1);
    localBackend.stopAgent('agent-1');
    expect(restoreDangerousRules).not.toHaveBeenCalled();

    localBackend.stopAgent('agent-2');
    expect(restoreDangerousRules).toHaveBeenCalledTimes(1);
  });

  it('continues tracking AUTO children while the parent mode changes', async () => {
    const restoreDangerousRules = vi.fn();
    const stripDangerousRulesForAutoMode = vi.fn();
    let parentMode = DEFAULT_MODE;
    const parentConfig = createMockConfig() as unknown as {
      getApprovalMode: ReturnType<typeof vi.fn>;
      getPermissionManager: ReturnType<typeof vi.fn>;
    };
    parentConfig.getApprovalMode.mockImplementation(() => parentMode);
    parentConfig.getPermissionManager.mockReturnValue({
      restoreDangerousRules,
      stripDangerousRulesForAutoMode,
    });
    const localBackend = new InProcessBackend(parentConfig as never);
    await localBackend.init();

    const first = createSpawnConfig('agent-1');
    first.inProcess!.approvalMode = ApprovalMode.AUTO;
    first.inProcess!.initialTask = undefined;
    const second = createSpawnConfig('agent-2');
    second.inProcess!.approvalMode = ApprovalMode.AUTO;
    second.inProcess!.initialTask = undefined;

    await localBackend.spawnAgent(first);
    await localBackend.spawnAgent(second);
    parentMode = ApprovalMode.AUTO;
    localBackend.stopAgent('agent-1');
    parentMode = DEFAULT_MODE;
    localBackend.stopAgent('agent-2');

    expect(stripDangerousRulesForAutoMode).toHaveBeenCalledTimes(1);
    expect(restoreDangerousRules).toHaveBeenCalledTimes(1);
  });

  it('should cleanup all agents', async () => {
    await backend.init();
    await backend.spawnAgent(createSpawnConfig('agent-1'));

    await backend.cleanup();

    expect(backend.getActiveAgentId()).toBeNull();
    expect(backend.getAgent('agent-1')).toBeUndefined();
  });

  it('should fire exit callback when agent completes', async () => {
    await backend.init();

    const exitCallback = vi.fn();
    backend.setOnAgentExit(exitCallback);

    await backend.spawnAgent(createSpawnConfig('agent-1'));

    // The mock agent stays idle after processing initialTask.
    // Trigger a graceful shutdown to make it complete.
    const agent = backend.getAgent('agent-1');
    expect(agent).toBeDefined();
    await agent!.shutdown();

    // Wait for the exit callback to fire
    await vi.waitFor(() => {
      expect(exitCallback).toHaveBeenCalledWith(
        'agent-1',
        expect.any(Number),
        null,
      );
    });
  });

  it('should pass per-agent cwd to AgentCore via config proxy', async () => {
    const parentConfig = createMockConfig();
    const backendWithParentCwd = new InProcessBackend(parentConfig);
    await backendWithParentCwd.init();

    const agentCwd = '/worktree/agent-1';
    const config = createSpawnConfig('agent-1');
    config.cwd = agentCwd;

    await backendWithParentCwd.spawnAgent(config);

    const MockAgentCore = AgentCore as unknown as ReturnType<typeof vi.fn>;
    const lastCall = MockAgentCore.mock.calls.at(-1);
    expect(lastCall).toBeDefined();

    const { runtimeContext } = destructureAgentCoreCall(lastCall!);
    const agentContext = runtimeContext as unknown as {
      getWorkingDir: () => string;
      getTargetDir: () => string;
      getToolRegistry: () => unknown;
    };
    expect(agentContext.getWorkingDir()).toBe(agentCwd);
    expect(agentContext.getTargetDir()).toBe(agentCwd);
    expect(agentContext.getToolRegistry()).toBeDefined();
  });

  it('uses a per-agent approval mode without mutating the parent config', async () => {
    const parentConfig = createMockConfig() as unknown as {
      getApprovalMode: ReturnType<typeof vi.fn>;
      setApprovalMode: ReturnType<typeof vi.fn>;
    };
    const backendWithParentMode = new InProcessBackend(parentConfig as never);
    await backendWithParentMode.init();

    const config = createSpawnConfig('agent-1');
    config.inProcess!.approvalMode = PLAN_MODE;

    await backendWithParentMode.spawnAgent(config);

    const MockAgentCore = AgentCore as unknown as ReturnType<typeof vi.fn>;
    const lastCall = MockAgentCore.mock.calls.at(-1);
    expect(lastCall).toBeDefined();

    const { runtimeContext } = destructureAgentCoreCall(lastCall!);
    const agentContext = runtimeContext as unknown as {
      getApprovalMode: () => ApprovalMode;
      getPrePlanMode: () => ApprovalMode;
    };
    expect(agentContext.getApprovalMode()).toBe(PLAN_MODE);
    expect(agentContext.getPrePlanMode()).toBe(DEFAULT_MODE);
    expect(parentConfig.getApprovalMode()).toBe(DEFAULT_MODE);
    expect(parentConfig.setApprovalMode).not.toHaveBeenCalled();
  });

  it('uses a teammate-scoped plan file path in per-agent config', async () => {
    const parentConfig = createMockConfig() as unknown as {
      getPlanFilePath: ReturnType<typeof vi.fn>;
    };
    parentConfig.getPlanFilePath = vi
      .fn()
      .mockReturnValue('/tmp/plans/test-session.md');
    const backendWithParentMode = new InProcessBackend(parentConfig as never);
    await backendWithParentMode.init();

    await backendWithParentMode.spawnAgent(createSpawnConfig('agent-1'));

    const MockAgentCore = AgentCore as unknown as ReturnType<typeof vi.fn>;
    const lastCall = MockAgentCore.mock.calls.at(-1);
    expect(lastCall).toBeDefined();

    const { runtimeContext } = destructureAgentCoreCall(lastCall!);
    const agentContext = runtimeContext as unknown as {
      getPlanFilePath: () => string;
    };
    expect(agentContext.getPlanFilePath()).toBe(
      '/tmp/plans/test-session-agent-1.md',
    );
    expect(agentContext.getPlanFilePath()).not.toBe(
      parentConfig.getPlanFilePath(),
    );
  });

  it('keeps Config approval-mode safety checks on per-agent config', async () => {
    const parentConfig = createMockConfig() as unknown as {
      isTrustedFolder: ReturnType<typeof vi.fn>;
    };
    parentConfig.isTrustedFolder.mockReturnValue(false);
    const backendWithUntrustedParent = new InProcessBackend(
      parentConfig as never,
    );
    await backendWithUntrustedParent.init();

    const config = createSpawnConfig('agent-1');
    config.inProcess!.approvalMode = PLAN_MODE;

    await backendWithUntrustedParent.spawnAgent(config);

    const MockAgentCore = AgentCore as unknown as ReturnType<typeof vi.fn>;
    const lastCall = MockAgentCore.mock.calls.at(-1);
    expect(lastCall).toBeDefined();

    const { runtimeContext } = destructureAgentCoreCall(lastCall!);
    const agentContext = runtimeContext as unknown as Config;
    expect(() => agentContext.setApprovalMode(ApprovalMode.AUTO_EDIT)).toThrow(
      'Cannot enable privileged approval modes in an untrusted folder.',
    );
  });

  it('downgrades privileged initial approval modes in untrusted folders', async () => {
    const parentConfig = createMockConfig() as unknown as {
      isTrustedFolder: ReturnType<typeof vi.fn>;
    };
    parentConfig.isTrustedFolder.mockReturnValue(false);
    const backendWithUntrustedParent = new InProcessBackend(
      parentConfig as never,
    );
    await backendWithUntrustedParent.init();

    const config = createSpawnConfig('agent-1');
    config.inProcess!.approvalMode = ApprovalMode.AUTO_EDIT;

    await backendWithUntrustedParent.spawnAgent(config);

    const MockAgentCore = AgentCore as unknown as ReturnType<typeof vi.fn>;
    const lastCall = MockAgentCore.mock.calls.at(-1);
    expect(lastCall).toBeDefined();

    const { runtimeContext } = destructureAgentCoreCall(lastCall!);
    const agentContext = runtimeContext as unknown as Config;
    expect(agentContext.getApprovalMode()).toBe(ApprovalMode.DEFAULT);
  });

  it('should pass parent custom ignore files to per-agent file service', async () => {
    const parentConfig = createMockConfig() as unknown as {
      getFileFilteringOptions: ReturnType<typeof vi.fn>;
    };
    const backendWithCustomIgnore = new InProcessBackend(parentConfig as never);
    await backendWithCustomIgnore.init();

    await backendWithCustomIgnore.spawnAgent(createSpawnConfig('agent-1'));

    const MockAgentCore = AgentCore as unknown as ReturnType<typeof vi.fn>;
    const lastCall = MockAgentCore.mock.calls.at(-1);
    expect(lastCall).toBeDefined();

    const { runtimeContext } = destructureAgentCoreCall(lastCall!);
    const agentContext = runtimeContext as unknown as {
      getFileService: () => {
        getQwenIgnoreFileNamesDisplay: () => string;
      };
    };

    expect(parentConfig.getFileFilteringOptions).toHaveBeenCalled();
    expect(agentContext.getFileService().getQwenIgnoreFileNamesDisplay()).toBe(
      '.qwenignore, .cursorignore',
    );
  });

  it('should propagate runConfig limits to AgentInteractive', async () => {
    await backend.init();

    const config = createSpawnConfig('agent-1');
    config.inProcess!.runtimeConfig.runConfig = {
      max_turns: 5,
      max_time_minutes: 10,
    };

    await backend.spawnAgent(config);

    const agent = backend.getAgent('agent-1');
    expect(agent).toBeDefined();
    expect(agent!.config.maxTurnsPerMessage).toBe(5);
    expect(agent!.config.maxTimeMinutesPerMessage).toBe(10);
  });

  it('should default limits to undefined when runConfig omits them', async () => {
    await backend.init();

    const config = createSpawnConfig('agent-1');
    config.inProcess!.runtimeConfig.runConfig = {};

    await backend.spawnAgent(config);

    const agent = backend.getAgent('agent-1');
    expect(agent).toBeDefined();
    expect(agent!.config.maxTurnsPerMessage).toBeUndefined();
    expect(agent!.config.maxTimeMinutesPerMessage).toBeUndefined();
  });

  it('should give each agent its own cwd even when sharing a backend', async () => {
    await backend.init();

    const config1 = createSpawnConfig('agent-1');
    config1.cwd = '/worktree/agent-1';
    const config2 = createSpawnConfig('agent-2');
    config2.cwd = '/worktree/agent-2';

    await backend.spawnAgent(config1);
    await backend.spawnAgent(config2);

    const MockAgentCore = AgentCore as unknown as ReturnType<typeof vi.fn>;
    const calls = MockAgentCore.mock.calls;

    const ctx1 = calls.at(-2)![1] as {
      getWorkingDir: () => string;
      getTargetDir: () => string;
    };
    const ctx2 = calls.at(-1)![1] as {
      getWorkingDir: () => string;
      getTargetDir: () => string;
    };

    expect(ctx1.getWorkingDir()).toBe('/worktree/agent-1');
    expect(ctx1.getTargetDir()).toBe('/worktree/agent-1');
    expect(ctx2.getWorkingDir()).toBe('/worktree/agent-2');
    expect(ctx2.getTargetDir()).toBe('/worktree/agent-2');
  });

  it('should throw when spawning a duplicate agent ID', async () => {
    await backend.init();
    await backend.spawnAgent(createSpawnConfig('agent-1'));

    await expect(
      backend.spawnAgent(createSpawnConfig('agent-1')),
    ).rejects.toThrow('Agent "agent-1" already exists.');
  });

  it('should fire exit callback with code 1 when start() throws', async () => {
    const registry = createMockToolRegistry();
    const parentConfig = createMockConfig() as unknown as {
      createToolRegistry: ReturnType<typeof vi.fn>;
    };
    parentConfig.createToolRegistry = vi.fn().mockResolvedValue(registry);
    const failingBackend = new InProcessBackend(parentConfig as never);
    // Make createChat throw for this test
    const MockAgentCore = AgentCore as unknown as ReturnType<typeof vi.fn>;
    MockAgentCore.mockImplementationOnce(() => ({
      subagentId: 'mock-id',
      name: 'mock-agent',
      eventEmitter: {
        on: vi.fn(),
        off: vi.fn(),
        emit: vi.fn(),
      },
      stats: {
        start: vi.fn(),
        getSummary: vi.fn().mockReturnValue({}),
      },
      createChat: vi.fn().mockRejectedValue(new Error('Auth failed')),
      prepareTools: vi.fn().mockReturnValue([]),
      getEventEmitter: vi.fn().mockReturnValue({
        on: vi.fn(),
        off: vi.fn(),
        emit: vi.fn(),
      }),
      getExecutionSummary: vi.fn().mockReturnValue({}),
    }));

    await failingBackend.init();

    const exitCallback = vi.fn();
    failingBackend.setOnAgentExit(exitCallback);

    // spawnAgent should NOT throw — it catches the error internally
    await expect(
      failingBackend.spawnAgent(createSpawnConfig('agent-fail')),
    ).resolves.toBeUndefined();

    // Exit callback should have been fired with exit code 1
    expect(exitCallback).toHaveBeenCalledWith('agent-fail', 1, null);
    expect(registry.stop).toHaveBeenCalledTimes(1);
    expect(failingBackend.getAgent('agent-fail')).toBeUndefined();
    expect(failingBackend.getActiveAgentId()).toBeNull();
    expect(
      (
        failingBackend as unknown as {
          agentApprovalCleanups: Map<string, () => void>;
          agentRegistries: Map<string, unknown>;
        }
      ).agentApprovalCleanups.size,
    ).toBe(0);
    expect(
      (
        failingBackend as unknown as {
          agentRegistries: Map<string, unknown>;
        }
      ).agentRegistries.size,
    ).toBe(0);
  });

  it('should return true immediately from waitForAll after cleanup', async () => {
    await backend.init();
    await backend.spawnAgent(createSpawnConfig('agent-1'));

    await backend.cleanup();

    // waitForAll should return immediately after cleanup
    const result = await backend.waitForAll(5000);
    expect(result).toBe(true);
  });

  describe('chat history', () => {
    it('should pass chatHistory to AgentInteractive config', async () => {
      await backend.init();

      const chatHistory = [
        { role: 'user' as const, parts: [{ text: 'prior question' }] },
        { role: 'model' as const, parts: [{ text: 'prior answer' }] },
      ];
      const config = createSpawnConfig('agent-1');
      config.inProcess!.chatHistory = chatHistory;

      await backend.spawnAgent(config);

      const agent = backend.getAgent('agent-1');
      expect(agent).toBeDefined();
      expect(agent!.config.chatHistory).toEqual(chatHistory);
    });

    it('should leave chatHistory undefined when not provided', async () => {
      await backend.init();
      await backend.spawnAgent(createSpawnConfig('agent-1'));

      const agent = backend.getAgent('agent-1');
      expect(agent).toBeDefined();
      expect(agent!.config.chatHistory).toBeUndefined();
    });
  });

  describe('auth isolation', () => {
    it('should create per-agent ContentGenerator when authOverrides is provided', async () => {
      await backend.init();

      const config = createSpawnConfig('agent-1');
      config.inProcess!.authOverrides = {
        authType: 'anthropic',
        apiKey: 'agent-key-123',
        baseUrl: 'https://agent.example.com',
      };

      await backend.spawnAgent(config);

      const mockCreate = createContentGenerator as ReturnType<typeof vi.fn>;
      // Owner must be the per-agent override Config (the same instance
      // AgentCore receives as runtimeContext) — NOT the parent. Asserting
      // that match exactly catches a regression where `base` slips in.
      const MockAgentCore = AgentCore as unknown as ReturnType<typeof vi.fn>;
      const { runtimeContext: agentContext } = destructureAgentCoreCall(
        MockAgentCore.mock.calls.at(-1)!,
      );
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
      const mockCreate = createContentGenerator as ReturnType<typeof vi.fn>;
      mockCreate.mockResolvedValueOnce(agentGenerator);

      await backend.init();

      const config = createSpawnConfig('agent-1');
      config.inProcess!.authOverrides = {
        authType: 'anthropic',
        apiKey: 'agent-key',
      };

      await backend.spawnAgent(config);

      const MockAgentCore = AgentCore as unknown as ReturnType<typeof vi.fn>;
      const lastCall = MockAgentCore.mock.calls.at(-1);
      const { runtimeView } = destructureAgentCoreCall(lastCall!);

      expect(runtimeView).toBeDefined();
      expect(runtimeView!.contentGenerator).toBe(agentGenerator);
      expect(runtimeView!.contentGeneratorConfig.authType).toBe('anthropic');
      expect(backend.getAgentContentGenerator('agent-1')).toBe(agentGenerator);
    });

    it('should leave parent ContentGenerator unchanged without authOverrides', async () => {
      const mockCreate = createContentGenerator as ReturnType<typeof vi.fn>;
      mockCreate.mockClear();

      await backend.init();
      await backend.spawnAgent(createSpawnConfig('agent-1'));

      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('should fall back to parent ContentGenerator if per-agent creation fails', async () => {
      const mockCreate = createContentGenerator as ReturnType<typeof vi.fn>;
      mockCreate.mockRejectedValueOnce(new Error('Auth failed'));

      await backend.init();

      const config = createSpawnConfig('agent-1');
      config.inProcess!.authOverrides = {
        authType: 'anthropic',
        apiKey: 'bad-key',
      };

      // Should not throw — falls back gracefully
      await expect(backend.spawnAgent(config)).resolves.toBeUndefined();

      const MockAgentCore = AgentCore as unknown as ReturnType<typeof vi.fn>;
      const lastCall = MockAgentCore.mock.calls.at(-1);

      // No runtimeView when per-agent creation failed; agent inherits parent.
      expect(destructureAgentCoreCall(lastCall!).runtimeView).toBeUndefined();
      expect(backend.getAgentContentGenerator('agent-1')).toBeUndefined();
    });

    it('should give different agents different ContentGenerators', async () => {
      const gen1 = { generateContentStream: vi.fn() };
      const gen2 = { generateContentStream: vi.fn() };
      const mockCreate = createContentGenerator as ReturnType<typeof vi.fn>;
      mockCreate.mockResolvedValueOnce(gen1).mockResolvedValueOnce(gen2);

      await backend.init();

      const config1 = createSpawnConfig('agent-1');
      config1.inProcess!.authOverrides = {
        authType: 'openai',
        apiKey: 'key-1',
        baseUrl: 'https://api1.example.com',
      };
      const config2 = createSpawnConfig('agent-2');
      config2.inProcess!.authOverrides = {
        authType: 'anthropic',
        apiKey: 'key-2',
        baseUrl: 'https://api2.example.com',
      };

      await backend.spawnAgent(config1);
      await backend.spawnAgent(config2);

      const MockAgentCore = AgentCore as unknown as ReturnType<typeof vi.fn>;
      const calls = MockAgentCore.mock.calls;

      const view1 = calls.at(-2)![8] as { contentGenerator: unknown };
      const view2 = calls.at(-1)![8] as { contentGenerator: unknown };

      expect(view1.contentGenerator).toBe(gen1);
      expect(view2.contentGenerator).toBe(gen2);
      expect(view1.contentGenerator).not.toBe(view2.contentGenerator);
    });
  });
});
