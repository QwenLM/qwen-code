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
import { ArenaSessionStatus, ARENA_MAX_AGENTS } from './types.js';
import { AgentStatus } from '../runtime/agent-types.js';

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

// Mock GitWorktreeService to avoid real git operations.
// The class mock includes static methods used by ArenaManager.
vi.mock('../../services/gitWorktreeService.js', () => {
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
  return { GitWorktreeService: MockClass };
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

describe('ArenaManager', () => {
  let tempDir: string;
  let mockConfig: ReturnType<typeof createMockConfig>;
  let mockBackend: ReturnType<typeof createMockBackend>;

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
      const manager = new ArenaManager(mockConfig as never);
      expect(manager).toBeDefined();
      expect(manager.getSessionId()).toBeUndefined();
      expect(manager.getSessionStatus()).toBe(ArenaSessionStatus.INITIALIZING);
    });

    it('should not have a backend before start', () => {
      const manager = new ArenaManager(mockConfig as never);
      expect(manager.getBackend()).toBeNull();
    });
  });

  describe('start validation', () => {
    it('should reject start with less than 2 models', async () => {
      const manager = new ArenaManager(mockConfig as never);

      await expect(
        manager.start({
          models: [{ modelId: 'model-1', authType: 'openai' }],
          task: 'Test task',
        }),
      ).rejects.toThrow('Arena requires at least 2 models');
    });

    it('should reject start with more than max models', async () => {
      const manager = new ArenaManager(mockConfig as never);

      const models = Array.from({ length: ARENA_MAX_AGENTS + 1 }, (_, i) => ({
        modelId: `model-${i}`,
        authType: 'openai',
      }));

      await expect(
        manager.start({
          models,
          task: 'Test task',
        }),
      ).rejects.toThrow(
        `Arena supports a maximum of ${ARENA_MAX_AGENTS} models`,
      );
    });

    it('should reject start with empty task', async () => {
      const manager = new ArenaManager(mockConfig as never);

      await expect(
        manager.start({
          models: [
            { modelId: 'model-1', authType: 'openai' },
            { modelId: 'model-2', authType: 'openai' },
          ],
          task: '',
        }),
      ).rejects.toThrow('Arena requires a task/prompt');
    });

    it('should reject start with duplicate model IDs', async () => {
      const manager = new ArenaManager(mockConfig as never);

      await expect(
        manager.start({
          models: [
            { modelId: 'model-1', authType: 'openai' },
            { modelId: 'model-1', authType: 'openai' },
          ],
          task: 'Test task',
        }),
      ).rejects.toThrow('Arena models must have unique identifiers');
    });
  });

  describe('event emitter', () => {
    it('should return the event emitter', () => {
      const manager = new ArenaManager(mockConfig as never);
      const emitter = manager.getEventEmitter();
      expect(emitter).toBeDefined();
      expect(typeof emitter.on).toBe('function');
      expect(typeof emitter.off).toBe('function');
      expect(typeof emitter.emit).toBe('function');
    });
  });

  describe('PTY interaction methods', () => {
    it('should expose PTY interaction methods', () => {
      const manager = new ArenaManager(mockConfig as never);
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
      const manager = new ArenaManager(mockConfig as never);
      expect(manager.getActiveAgentId()).toBeNull();
    });

    it('should return null for active snapshot when no session', () => {
      const manager = new ArenaManager(mockConfig as never);
      expect(manager.getActiveSnapshot()).toBeNull();
    });
  });

  describe('cancel', () => {
    it('should handle cancel when no session is active', async () => {
      const manager = new ArenaManager(mockConfig as never);
      await expect(manager.cancel()).resolves.not.toThrow();
    });
  });

  describe('cleanup', () => {
    it('should handle cleanup when no session is active', async () => {
      const manager = new ArenaManager(mockConfig as never);
      await expect(manager.cleanup()).resolves.not.toThrow();
    });
  });

  describe('getAgentStates', () => {
    it('should return empty array when no agents', () => {
      const manager = new ArenaManager(mockConfig as never);
      expect(manager.getAgentStates()).toEqual([]);
    });
  });

  describe('getAgentState', () => {
    it('should return undefined for non-existent agent', () => {
      const manager = new ArenaManager(mockConfig as never);
      expect(manager.getAgentState('non-existent')).toBeUndefined();
    });
  });

  describe('applyAgentResult', () => {
    it('should return error for non-existent agent', async () => {
      const manager = new ArenaManager(mockConfig as never);
      const result = await manager.applyAgentResult('non-existent');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('getAgentDiff', () => {
    it('should return error message for non-existent agent', async () => {
      const manager = new ArenaManager(mockConfig as never);
      const diff = await manager.getAgentDiff('non-existent');
      expect(diff).toContain('not found');
    });
  });

  describe('backend initialization', () => {
    it('should emit SESSION_UPDATE with type warning when backend detection returns warning', async () => {
      const manager = new ArenaManager(mockConfig as never);
      const updates: Array<{
        type: string;
        message: string;
        sessionId: string;
      }> = [];
      manager.getEventEmitter().on(ArenaEventType.SESSION_UPDATE, (event) => {
        updates.push({
          type: event.type,
          message: event.message,
          sessionId: event.sessionId,
        });
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
      const manager = new ArenaManager(mockConfig as never);
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
    it('should pass chatHistory to backend spawnAgent calls', async () => {
      const manager = new ArenaManager(mockConfig as never);
      const chatHistory = [
        { role: 'user' as const, parts: [{ text: 'prior question' }] },
        { role: 'model' as const, parts: [{ text: 'prior answer' }] },
      ];

      await manager.start({
        ...createValidStartOptions(),
        chatHistory,
      });

      // Both agents should have been spawned with chatHistory in
      // the inProcess config.
      expect(mockBackend.spawnAgent).toHaveBeenCalledTimes(2);
      for (const call of mockBackend.spawnAgent.mock.calls) {
        const spawnConfig = call[0] as {
          inProcess?: { chatHistory?: unknown };
        };
        expect(spawnConfig.inProcess?.chatHistory).toEqual(chatHistory);
      }
    });

    it('should pass undefined chatHistory when not provided', async () => {
      const manager = new ArenaManager(mockConfig as never);

      await manager.start(createValidStartOptions());

      expect(mockBackend.spawnAgent).toHaveBeenCalledTimes(2);
      for (const call of mockBackend.spawnAgent.mock.calls) {
        const spawnConfig = call[0] as {
          inProcess?: { chatHistory?: unknown };
        };
        expect(spawnConfig.inProcess?.chatHistory).toBeUndefined();
      }
    });
  });

  describe('active session lifecycle', () => {
    it('collects diff summaries and fallback approach summaries', async () => {
      const manager = new ArenaManager(mockConfig as never);
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

    it('uses the current content generator for semantic approach summaries', async () => {
      const generateContent = vi.fn().mockResolvedValue({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    summaries: {
                      'model-1': 'Model 1 used a strategy pattern.',
                      'model-2': 'Model 2 made inline edits.',
                    },
                  }),
                },
              ],
            },
          },
        ],
      });
      const config = {
        ...mockConfig,
        getContentGenerator: () => ({
          generateContent,
        }),
      };
      const manager = new ArenaManager(config as never);

      const result = await manager.start(createValidStartOptions());

      expect(generateContent).toHaveBeenCalledTimes(1);
      expect(result.agents[0]?.approachSummary).toBe(
        'Model 1 used a strategy pattern.',
      );
      expect(result.agents[1]?.approachSummary).toBe(
        'Model 2 made inline edits.',
      );
    });

    it('cancel should stop backend and move session to CANCELLED', async () => {
      const manager = new ArenaManager(mockConfig as never);

      // Disable auto-exit so agents stay running until we cancel.
      mockBackend.setAutoExit(false);

      const startPromise = manager.start({
        ...createValidStartOptions(),
        timeoutSeconds: 30,
      });

      // Wait until the backend has spawned all agents.
      // (Agents are spawned sequentially; cancelling between spawns would
      // cause spawnAgentPty to overwrite the CANCELLED status back to RUNNING.)
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
      const manager = new ArenaManager(mockConfig as never);

      // auto-exit is on by default, so agents terminate quickly.
      await manager.start(createValidStartOptions());

      await manager.cleanup();

      expect(mockBackend.cleanup).toHaveBeenCalledTimes(1);
      // cleanupSession is called with worktreeDirName (short ID), not the full sessionId.
      // For 'test-session', the short ID is 'testsess' (first 8 chars with dashes removed).
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
    type: 'tmux' as const,
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
    /** Disable automatic agent exit for tests that need to control timing. */
    setAutoExit(value: boolean) {
      autoExit = value;
    },
  };
  return backend;
}

function createValidStartOptions() {
  return {
    models: [
      { modelId: 'model-1', authType: 'openai' },
      { modelId: 'model-2', authType: 'openai' },
    ],
    task: 'Implement feature X',
  };
}

async function waitForMicrotask(): Promise<void> {
  // Use setImmediate (or setTimeout fallback) to yield to the event loop
  // and allow other async operations (like the start() method) to progress.
  await new Promise<void>((resolve) => {
    if (typeof setImmediate === 'function') {
      setImmediate(resolve);
    } else {
      setTimeout(resolve, 0);
    }
  });
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out while waiting for condition');
    }
    await waitForMicrotask();
  }
}
