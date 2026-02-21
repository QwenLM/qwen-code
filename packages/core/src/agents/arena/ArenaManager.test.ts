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

const hoistedMockSetupArenaWorktrees = vi.hoisted(() => vi.fn());
const hoistedMockCleanupArenaSession = vi.hoisted(() => vi.fn());
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
    setupArenaWorktrees: hoistedMockSetupArenaWorktrees,
    cleanupArenaSession: hoistedMockCleanupArenaSession,
    getWorktreeDiff: hoistedMockGetWorktreeDiff,
    applyWorktreeChanges: hoistedMockApplyWorktreeChanges,
  }));
  // Static methods called by ArenaManager
  (MockClass as unknown as Record<string, unknown>)['getArenaBaseDir'] = () =>
    path.join(os.tmpdir(), 'arena-mock');
  (MockClass as unknown as Record<string, unknown>)['getArenaSessionDir'] = (
    sessionId: string,
  ) => path.join(os.tmpdir(), 'arena-mock', sessionId);
  (MockClass as unknown as Record<string, unknown>)['getWorktreesDir'] = (
    sessionId: string,
  ) => path.join(os.tmpdir(), 'arena-mock', sessionId, 'worktrees');
  return { GitWorktreeService: MockClass };
});

// Mock the Config class
const createMockConfig = (workingDir: string) => ({
  getWorkingDir: () => workingDir,
  getModel: () => 'test-model',
  getSessionId: () => 'test-session',
  getUserMemory: () => '',
  getToolRegistry: () => ({
    getFunctionDeclarations: () => [],
    getFunctionDeclarationsFiltered: () => [],
    getTool: () => undefined,
  }),
  getAgentsSettings: () => ({}),
});

describe('ArenaManager', () => {
  let tempDir: string;
  let mockConfig: ReturnType<typeof createMockConfig>;
  let mockBackend: ReturnType<typeof createMockBackend>;

  beforeEach(async () => {
    // Create a temp directory - no need for git repo since we mock GitWorktreeService
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'arena-test-'));
    mockConfig = createMockConfig(tempDir);

    mockBackend = createMockBackend();
    hoistedMockDetectBackend.mockResolvedValue({ backend: mockBackend });

    hoistedMockSetupArenaWorktrees.mockImplementation(
      async ({
        arenaSessionId,
        sourceRepoPath,
        worktreeNames,
      }: {
        arenaSessionId: string;
        sourceRepoPath: string;
        worktreeNames: string[];
      }) => {
        const worktrees = worktreeNames.map((name) => ({
          id: `${arenaSessionId}/${name}`,
          name,
          path: path.join(sourceRepoPath, `.arena-${arenaSessionId}`, name),
          branch: `arena/${arenaSessionId}/${name}`,
          isActive: true,
          createdAt: Date.now(),
        }));

        return {
          success: true,
          arenaSessionId,
          worktrees,
          worktreesByName: Object.fromEntries(
            worktrees.map((worktree) => [worktree.name, worktree]),
          ),
          errors: [],
          wasRepoInitialized: false,
        };
      },
    );
    hoistedMockCleanupArenaSession.mockResolvedValue({
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
      expect(warningUpdate?.sessionId).toMatch(/^arena-/);
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

  describe('active session lifecycle', () => {
    it('cancel should stop backend and move session to CANCELLED', async () => {
      const manager = new ArenaManager(mockConfig as never);

      // Disable auto-exit so agents stay running until we cancel.
      mockBackend.setAutoExit(false);

      const startPromise = manager.start({
        ...createValidStartOptions(),
        timeoutSeconds: 30,
      });

      // Wait until the backend has spawned at least one agent.
      await waitForCondition(
        () => mockBackend.spawnAgent.mock.calls.length > 0,
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
      const sessionIdBeforeCleanup = manager.getSessionId();

      await manager.cleanup();

      expect(mockBackend.cleanup).toHaveBeenCalledTimes(1);
      expect(hoistedMockCleanupArenaSession).toHaveBeenCalledWith(
        sessionIdBeforeCleanup,
      );
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
  await Promise.resolve();
  await Promise.resolve();
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
