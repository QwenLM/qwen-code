/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ArenaManager } from './ArenaManager.js';
import { ArenaEventType } from './arena-events.js';
import type { ArenaSessionUpdateEvent } from './arena-events.js';
import { ArenaSessionStatus, ARENA_MAX_AGENTS } from './types.js';
import { AgentStatus } from '../runtime/agent-types.js';
import { ApprovalMode } from '../../config/config.js';
import { getBuiltInOutputStyle } from '../../core/output-styles.js';
import { modelText, userText } from '../../test-utils/model-fixtures.js';

const hoistedMockSetupWorktrees = vi.hoisted(() => vi.fn());
const hoistedMockCleanupSession = vi.hoisted(() => vi.fn());
const hoistedMockGetWorktreeDiff = vi.hoisted(() => vi.fn());
const hoistedMockApplyWorktreeChanges = vi.hoisted(() => vi.fn());
const hoistedMockDetectBackend = vi.hoisted(() => vi.fn());

vi.mock('../index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../index.js')>();
  return {
    ...actual,
    detectBackend: hoistedMockDetectBackend,
  };
});

// Mock GitWorktreeService (including the static methods ArenaManager calls)
// to avoid real git operations. Other exports are preserved via
// `importOriginal`: consumers such as `worktreeCleanup.ts` statically import
// constants and helpers (slug pattern, branch prefix, session markers) and
// would blow up at load time if vitest replaced the whole module surface.
vi.mock('../../services/gitWorktreeService.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../services/gitWorktreeService.js')
    >();
  const MockClass = vi.fn().mockImplementation(() => ({
    checkGitAvailable: vi.fn().mockResolvedValue({ available: true }),
    isGitRepository: vi.fn().mockResolvedValue(true),
    setupWorktrees: hoistedMockSetupWorktrees,
    cleanupSession: hoistedMockCleanupSession,
    getWorktreeDiff: hoistedMockGetWorktreeDiff,
    applyWorktreeChanges: hoistedMockApplyWorktreeChanges,
  }));
  // Static methods called by ArenaManager
  (MockClass as unknown as Record<string, unknown>)['getBaseDir'] = () =>
    path.join(os.tmpdir(), 'arena-mock');
  (MockClass as unknown as Record<string, unknown>)['getSessionDir'] = (
    sessionId: string,
  ) => path.join(os.tmpdir(), 'arena-mock', sessionId);
  (MockClass as unknown as Record<string, unknown>)['getWorktreesDir'] = (
    sessionId: string,
  ) => path.join(os.tmpdir(), 'arena-mock', sessionId, 'worktrees');
  return { ...actual, GitWorktreeService: MockClass };
});

// Mock the Config class
const createMockConfig = (
  workingDir: string,
  arenaSettings: Record<string, unknown> = {},
) => ({
  getWorkingDir: () => workingDir,
  getModel: () => 'test-model',
  getSessionId: () => 'test-session',
  getUserMemory: () => '',
  getOutputStyle: (): ReturnType<typeof getBuiltInOutputStyle> => undefined,
  getCodeModeOnly: () => false,
  isTodoWriteEnabled: () => false,
  // Read by resolveMainSessionOutputStyle: the peer inherits the style the
  // main session actually carries, so the main session's prompt-override and
  // interaction-mode state is part of that decision.
  getSystemPrompt: (): string | undefined => undefined,
  getExperimentalZedIntegration: () => false,
  isInteractive: () => true,
  getAutoMemoryPrompt: () => '',
  getToolRegistry: () => ({
    getFunctionDeclarations: () => [],
    getFunctionDeclarationsFiltered: () => [],
    getTool: () => undefined,
  }),
  getAgentsSettings: () => ({ arena: arenaSettings }),
  getUsageStatisticsEnabled: () => false,
  getTelemetryEnabled: () => false,
  getTelemetryLogPromptsEnabled: () => false,
});

type InProcessSpawn = {
  approvalMode?: unknown;
  chatHistory?: unknown;
  runtimeConfig?: { promptConfig?: { systemPrompt?: string } };
};

describe('ArenaManager', () => {
  let tempDir: string;
  let mockConfig: ReturnType<typeof createMockConfig>;
  let mockBackend: ReturnType<typeof createMockBackend>;

  const newManager = (overrides: object = {}) =>
    new ArenaManager({ ...mockConfig, ...overrides } as never);
  /** Starts a manager (config overrides, extra start options) to completion. */
  const startWith = async (overrides: object = {}, opts: object = {}) => {
    const manager = newManager(overrides);
    const result = await manager.start({
      ...createValidStartOptions(),
      ...opts,
    });
    return { manager, result };
  };
  /** Asserts both agents were spawned; returns each spawn's inProcess config. */
  const spawnedInProcess = () => {
    expect(mockBackend.spawnAgent).toHaveBeenCalledTimes(2);
    return mockBackend.spawnAgent.mock.calls.map(
      (call) => (call[0] as { inProcess?: InProcessSpawn }).inProcess,
    );
  };
  const spawnedSystemPrompts = () =>
    spawnedInProcess().map((p) => p?.runtimeConfig?.promptConfig?.systemPrompt);

  beforeEach(async () => {
    // Create a temp directory - no need for git repo since we mock GitWorktreeService
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'arena-test-'));
    // Use tempDir as worktreeBaseDir to avoid slow filesystem access in deriveWorktreeDirName
    mockConfig = createMockConfig(tempDir, { worktreeBaseDir: tempDir });

    mockBackend = createMockBackend();
    hoistedMockDetectBackend.mockResolvedValue({ backend: mockBackend });

    hoistedMockSetupWorktrees.mockImplementation(
      async ({
        sessionId,
        sourceRepoPath,
        worktreeNames,
      }: {
        sessionId: string;
        sourceRepoPath: string;
        worktreeNames: string[];
      }) => {
        const worktrees = worktreeNames.map((name) => ({
          id: `${sessionId}/${name}`,
          name,
          path: path.join(sourceRepoPath, `.arena-${sessionId}`, name),
          branch: `arena/${sessionId}/${name}`,
          isActive: true,
          createdAt: Date.now(),
        }));

        return {
          success: true,
          sessionId,
          worktrees,
          worktreesByName: Object.fromEntries(
            worktrees.map((worktree) => [worktree.name, worktree]),
          ),
          errors: [],
        };
      },
    );
    hoistedMockCleanupSession.mockResolvedValue({
      success: true,
      removedWorktrees: [],
      removedBranches: [],
      errors: [],
    });
    hoistedMockGetWorktreeDiff.mockResolvedValue('');
    hoistedMockApplyWorktreeChanges.mockResolvedValue({ success: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('constructor', () => {
    it('should create an ArenaManager instance', () => {
      const manager = newManager();
      expect(manager).toBeDefined();
      expect(manager.getSessionId()).toBeUndefined();
      expect(manager.getSessionStatus()).toBe(ArenaSessionStatus.INITIALIZING);
    });

    it('should not have a backend before start', () => {
      expect(newManager().getBackend()).toBeNull();
    });
  });

  describe('start validation', () => {
    it('refuses required-container sessions before initializing state or worktrees', async () => {
      const manager = newManager({
        getAgentExecutionBackend: () => 'container',
      });
      const onStart = vi.fn();
      manager.getEventEmitter().on(ArenaEventType.SESSION_START, onStart);

      await expect(manager.start(createValidStartOptions())).rejects.toThrow(
        'Container execution is required',
      );

      expect(manager.getSessionId()).toBeUndefined();
      expect(manager.getBackend()).toBeNull();
      expect(manager.getAgentStates()).toEqual([]);
      expect(onStart).not.toHaveBeenCalled();
      expect(hoistedMockDetectBackend).not.toHaveBeenCalled();
      expect(hoistedMockSetupWorktrees).not.toHaveBeenCalled();
      expect(await fs.readdir(tempDir)).toEqual([]);
    });

    it.each([
      [
        'should reject start with less than 2 models',
        [model('model-1')],
        'Test task',
        'Arena requires at least 2 models',
      ],
      [
        'should reject start with more than max models',
        Array.from({ length: ARENA_MAX_AGENTS + 1 }, (_, i) =>
          model(`model-${i}`),
        ),
        'Test task',
        `Arena supports a maximum of ${ARENA_MAX_AGENTS} models`,
      ],
      [
        'should reject start with empty task',
        [model('model-1'), model('model-2')],
        '',
        'Arena requires a task/prompt',
      ],
      [
        'should reject start with duplicate model IDs',
        [model('model-1'), model('model-1')],
        'Test task',
        'Arena models must have unique identifiers',
      ],
    ])('%s', async (_title, models, task, message) => {
      await expect(newManager().start({ models, task })).rejects.toThrow(
        message,
      );
    });
  });

  describe('event emitter', () => {
    it('should return the event emitter', () => {
      const emitter = newManager().getEventEmitter();
      expect(emitter).toBeDefined();
      expect(typeof emitter.on).toBe('function');
      expect(typeof emitter.off).toBe('function');
      expect(typeof emitter.emit).toBe('function');
    });
  });

  describe('PTY interaction methods', () => {
    it('should expose PTY interaction methods', () => {
      const manager = newManager();
      expect(typeof manager.switchToAgent).toBe('function');
      expect(typeof manager.switchToNextAgent).toBe('function');
      expect(typeof manager.switchToPreviousAgent).toBe('function');
      expect(typeof manager.getActiveAgentId).toBe('function');
      expect(typeof manager.getActiveSnapshot).toBe('function');
      expect(typeof manager.getAgentSnapshot).toBe('function');
      expect(typeof manager.forwardInput).toBe('function');
      expect(typeof manager.resizeAgents).toBe('function');
    });

    it('should return null for active agent ID when no session', () => {
      expect(newManager().getActiveAgentId()).toBeNull();
    });

    it('should return null for active snapshot when no session', () => {
      expect(newManager().getActiveSnapshot()).toBeNull();
    });
  });

  describe('cancel', () => {
    it('should handle cancel when no session is active', async () => {
      await expect(newManager().cancel()).resolves.not.toThrow();
    });
  });

  describe('cleanup', () => {
    it('should handle cleanup when no session is active', async () => {
      await expect(newManager().cleanup()).resolves.not.toThrow();
    });
  });

  describe('getAgentStates', () => {
    it('should return empty array when no agents', () => {
      expect(newManager().getAgentStates()).toEqual([]);
    });
  });

  describe('getAgentState', () => {
    it('should return undefined for non-existent agent', () => {
      expect(newManager().getAgentState('non-existent')).toBeUndefined();
    });
  });

  describe('applyAgentResult', () => {
    it('should return error for non-existent agent', async () => {
      const result = await newManager().applyAgentResult('non-existent');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('getAgentDiff', () => {
    it('should return error message for non-existent agent', async () => {
      const diff = await newManager().getAgentDiff('non-existent');
      expect(diff).toContain('not found');
    });
  });

  describe('backend initialization', () => {
    it('should emit SESSION_UPDATE with type warning when backend detection returns warning', async () => {
      const manager = newManager();
      const updates: ArenaSessionUpdateEvent[] = [];
      manager.getEventEmitter().on(ArenaEventType.SESSION_UPDATE, (event) => {
        updates.push(event);
      });

      hoistedMockDetectBackend.mockResolvedValueOnce({
        backend: mockBackend,
        warning: 'fallback to tmux backend',
      });

      await manager.start(createValidStartOptions());

      expect(hoistedMockDetectBackend).toHaveBeenCalledWith(
        undefined,
        expect.anything(),
      );
      const warningUpdate = updates.find((u) => u.type === 'warning');
      expect(warningUpdate).toBeDefined();
      expect(warningUpdate?.message).toContain('fallback to tmux backend');
      expect(warningUpdate?.sessionId).toBe('test-session');
    });

    it('should emit SESSION_ERROR and mark FAILED when backend init fails', async () => {
      const manager = newManager();
      const sessionErrors: string[] = [];
      manager.getEventEmitter().on(ArenaEventType.SESSION_ERROR, (event) => {
        sessionErrors.push(event.error);
      });

      mockBackend.init.mockRejectedValueOnce(new Error('init failed'));

      await expect(manager.start(createValidStartOptions())).rejects.toThrow(
        'init failed',
      );
      expect(manager.getSessionStatus()).toBe(ArenaSessionStatus.FAILED);
      expect(sessionErrors).toEqual(['init failed']);
    });
  });

  describe('chat history forwarding', () => {
    it('passes approvalMode to in-process backend spawn configs', async () => {
      mockBackend.type = 'in-process';
      await startWith({}, { approvalMode: ApprovalMode.PLAN });

      for (const inProcess of spawnedInProcess()) {
        expect(inProcess?.approvalMode).toBe(ApprovalMode.PLAN);
      }
    });

    it('should pass chatHistory to backend spawnAgent calls', async () => {
      const chatHistory = [
        userText('prior question'),
        modelText('prior answer'),
      ];
      await startWith({}, { chatHistory });

      // Both agents should have been spawned with chatHistory in
      // the inProcess config.
      for (const inProcess of spawnedInProcess()) {
        expect(inProcess?.chatHistory).toEqual(chatHistory);
      }
    });

    it('should pass undefined chatHistory when not provided', async () => {
      await startWith();

      for (const inProcess of spawnedInProcess()) {
        expect(inProcess?.chatHistory).toBeUndefined();
      }
    });

    it('builds the in-process worker prompt with headless mode and the active style', async () => {
      // Arena workers run non-interactively, so ArenaManager passes 'headless'
      // (4th arg) to getCoreSystemPrompt. Dropping it would fall back to the
      // interactive prompt, telling workers to ask questions no one can
      // answer. The headless variant's single-turn marker is absent from
      // every other interaction mode.
      mockBackend.type = 'in-process';
      await startWith({
        getOutputStyle: () => getBuiltInOutputStyle('Concise'),
        isTodoWriteEnabled: () => true,
      });

      for (const systemPrompt of spawnedSystemPrompts()) {
        expect(systemPrompt).toContain(
          'This is a non-interactive, single-turn run',
        );
        expect(systemPrompt).toContain('# Output Style: Concise');
        expect(systemPrompt).toContain('# Task Management');
      }
    });

    // The peer's whole job is to produce a diff it is judged on, so it must
    // keep the software-engineering guidance — Verify, Report outcomes
    // faithfully — that a `keepCodingInstructions: false` style deletes from
    // the base prompt.
    it('does not let a style strip the coding instructions from a peer', async () => {
      mockBackend.type = 'in-process';
      const haiku = {
        name: 'Haiku',
        source: 'user' as const,
        description: 'Answer in haiku',
        keepCodingInstructions: false,
        prompt: 'Answer in haiku.',
      };
      await startWith({ getOutputStyle: () => haiku });

      for (const systemPrompt of spawnedSystemPrompts()) {
        expect(systemPrompt).toContain('## Software Engineering Tasks');
        expect(systemPrompt).not.toContain('# Output Style: Haiku');
      }
    });

    // A replaced main-session prompt carries no style section; the peer must
    // not reintroduce one the main session deliberately dropped.
    it('gives a peer no style when a custom system prompt replaces the main one', async () => {
      mockBackend.type = 'in-process';
      await startWith({
        getSystemPrompt: () => 'You are terse.',
        getOutputStyle: () => getBuiltInOutputStyle('Concise'),
      });

      for (const systemPrompt of spawnedSystemPrompts()) {
        expect(systemPrompt).not.toContain('# Output Style: Concise');
      }
    });

    it('does not embed the auto-memory section in the worker system prompt', async () => {
      // The in-process worker's AgentCore appends the volatile auto-memory
      // section itself (buildChatSystemPrompt), and the per-agent Config
      // inherits a non-empty getAutoMemoryPrompt() from this base. If
      // ArenaManager also appended it, the section would appear twice.
      const marker = '__ARENA_AUTO_MEMORY_MARKER__';
      mockBackend.type = 'in-process';
      await startWith({ getAutoMemoryPrompt: () => marker });

      for (const systemPrompt of spawnedSystemPrompts()) {
        expect(systemPrompt).not.toContain(marker);
      }
    });
  });

  describe('active session lifecycle', () => {
    it('collects diff summaries and fallback approach summaries', async () => {
      const manager = newManager();
      mockBackend.setAutoExit(false);
      hoistedMockGetWorktreeDiff.mockResolvedValue(`diff --git a/src/auth.ts b/src/auth.ts
index 111..222 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1 +1,2 @@
-old
+new
+extra`);

      const startPromise = manager.start(createValidStartOptions());
      await waitForCondition(
        () => mockBackend.spawnAgent.mock.calls.length >= 2,
      );

      const agentsDir = path.join(
        os.tmpdir(),
        'arena-mock',
        'testsess',
        'agents',
      );
      await fs.mkdir(agentsDir, { recursive: true });
      for (const modelId of ['model-1', 'model-2']) {
        await fs.writeFile(
          path.join(agentsDir, `${modelId}.json`),
          JSON.stringify({
            agentId: modelId,
            status: AgentStatus.COMPLETED,
            updatedAt: Date.now(),
            rounds: 1,
            stats: {
              rounds: 1,
              totalTokens: 0,
              inputTokens: 0,
              outputTokens: 0,
              durationMs: 0,
              toolCalls: 0,
              successfulToolCalls: 0,
              failedToolCalls: 0,
            },
            finalSummary: null,
            error: null,
          }),
          'utf-8',
        );
      }

      const result = await startPromise;

      expect(result.agents).toHaveLength(2);
      expect(result.agents[0]?.modifiedFiles).toEqual(['src/auth.ts']);
      expect(result.agents[0]?.diffSummary).toEqual({
        files: [{ path: 'src/auth.ts', additions: 2, deletions: 1 }],
        additions: 2,
        deletions: 1,
      });
      expect(result.agents[0]?.approachSummary).toBe(
        'Changed 1 file with 0 tool calls (+2/-1).',
      );
    });

    it('routes all approach summaries through the chokepoint, not per-agent generators', async () => {
      const summaryReply = (summary: string) => ({
        text: JSON.stringify({ summary }),
        usage: undefined,
      });
      const summaryGenerateText = vi
        .fn()
        .mockResolvedValueOnce(summaryReply('Model 1 used a strategy pattern.'))
        .mockResolvedValueOnce(summaryReply('Model 2 made inline edits.'));
      mockBackend.type = 'in-process';
      mockBackend.setAutoExit(false);
      const agentInteractives = new Map<
        string,
        ReturnType<typeof createMockInteractive>
      >();
      mockBackend.getAgent.mockImplementation((agentId: string) =>
        agentInteractives.get(agentId),
      );
      mockBackend.spawnAgent.mockImplementation(
        async (config: { agentId: string }) => {
          agentInteractives.set(
            config.agentId,
            createMockInteractive(config.agentId),
          );
        },
      );

      const { result } = await startWith({
        getBaseLlmClient: () => ({ generateText: summaryGenerateText }),
      });

      // Both summaries should hit the single chokepoint generator.
      expect(summaryGenerateText).toHaveBeenCalledTimes(2);

      const allPrompts = summaryGenerateText.mock.calls
        .map((call: unknown[]) => {
          const options = call[0] as {
            contents: Array<{ parts: Array<{ text: string }> }>;
          };
          return options.contents[0]?.parts[0]?.text ?? '';
        })
        .join('\n');
      expect(allPrompts).toContain('"agentId": "model-1"');
      expect(allPrompts).toContain('"agentId": "model-2"');

      expect(result.agents[0]?.approachSummary).toBe(
        'Model 1 used a strategy pattern.',
      );
      expect(result.agents[1]?.approachSummary).toBe(
        'Model 2 made inline edits.',
      );
    });

    it('cancel should stop backend and move session to CANCELLED', async () => {
      const manager = newManager();

      // Disable auto-exit so agents stay running until we cancel.
      mockBackend.setAutoExit(false);

      const startPromise = manager.start({
        ...createValidStartOptions(),
        timeoutSeconds: 30,
      });

      // Wait until all agents are spawned: they spawn sequentially, and
      // cancelling between spawns would let spawnAgentPty overwrite the
      // CANCELLED status back to RUNNING.
      await waitForCondition(
        () => mockBackend.spawnAgent.mock.calls.length >= 2,
      );

      await manager.cancel();
      expect(mockBackend.stopAll).toHaveBeenCalledTimes(1);
      expect(manager.getSessionStatus()).toBe(ArenaSessionStatus.CANCELLED);

      await startPromise;
      expect(manager.getSessionStatus()).toBe(ArenaSessionStatus.CANCELLED);
    });

    it('cleanup should release backend and worktree resources after start', async () => {
      // auto-exit is on by default, so agents terminate quickly.
      const { manager } = await startWith();

      await manager.cleanup();

      expect(mockBackend.cleanup).toHaveBeenCalledTimes(1);
      // cleanupSession gets worktreeDirName (short ID), not the full
      // sessionId: 'test-session' -> 'testsess' (first 8 chars, no dashes).
      expect(hoistedMockCleanupSession).toHaveBeenCalledWith('testsess');
      expect(manager.getBackend()).toBeNull();
      expect(manager.getSessionId()).toBeUndefined();
    });
  });
});

describe('ARENA_MAX_AGENTS', () => {
  it('should be 5', () => {
    expect(ARENA_MAX_AGENTS).toBe(5);
  });
});

function createMockBackend() {
  type ExitCb = (
    agentId: string,
    exitCode: number | null,
    signal: number | null,
  ) => void;
  let onAgentExit: ExitCb | null = null;
  let autoExit = true;

  const backend = {
    type: 'tmux' as 'tmux' | 'in-process',
    init: vi.fn().mockResolvedValue(undefined),
    spawnAgent: vi.fn(async (config: { agentId: string }) => {
      // By default, simulate immediate agent termination so tests
      // don't hang in waitForAllAgentsSettled.
      if (autoExit) {
        setTimeout(() => onAgentExit?.(config.agentId, 0, null), 5);
      }
    }),
    stopAgent: vi.fn(),
    stopAll: vi.fn(),
    cleanup: vi.fn().mockResolvedValue(undefined),
    setOnAgentExit: vi.fn((cb: ExitCb) => {
      onAgentExit = cb;
    }),
    waitForAll: vi.fn().mockResolvedValue(true),
    switchTo: vi.fn(),
    switchToNext: vi.fn(),
    switchToPrevious: vi.fn(),
    getActiveAgentId: vi.fn().mockReturnValue(null),
    getActiveSnapshot: vi.fn().mockReturnValue(null),
    getAgentSnapshot: vi.fn().mockReturnValue(null),
    getAgentScrollbackLength: vi.fn().mockReturnValue(0),
    forwardInput: vi.fn().mockReturnValue(false),
    writeToAgent: vi.fn().mockReturnValue(false),
    resizeAll: vi.fn(),
    getAttachHint: vi.fn().mockReturnValue(null),
    getAgent: vi.fn().mockReturnValue(undefined),
    /** Disable automatic agent exit for tests that need to control timing. */
    setAutoExit(value: boolean) {
      autoExit = value;
    },
  };
  return backend;
}

function createMockInteractive(agentId: string) {
  const emitter = {
    on: vi.fn(),
    off: vi.fn(),
  };
  return {
    getMessages: vi.fn().mockReturnValue([
      {
        role: 'assistant',
        content: `${agentId} final response`,
        timestamp: Date.now(),
      },
    ]),
    getStatus: vi.fn().mockReturnValue(AgentStatus.IDLE),
    getStats: vi.fn().mockReturnValue({
      rounds: 1,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalToolCalls: 0,
      successfulToolCalls: 0,
      failedToolCalls: 0,
      totalDurationMs: 1,
    }),
    getLastRoundError: vi.fn().mockReturnValue(undefined),
    getError: vi.fn().mockReturnValue(undefined),
    getEventEmitter: vi.fn().mockReturnValue(emitter),
  };
}

function model(modelId: string) {
  return { modelId, authType: 'openai' };
}

function createValidStartOptions() {
  return {
    models: [model('model-1'), model('model-2')],
    task: 'Implement feature X',
  };
}

/** Polls `predicate`, yielding to the event loop so start() can progress. */
async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out while waiting for condition');
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
