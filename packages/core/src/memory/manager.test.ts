/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { globalMemoryManager, MemoryManager } from './manager.js';
import { ensureAutoMemoryScaffold } from './store.js';
import {
  getAutoMemoryMetadataPath,
  getAutoMemoryConsolidationLockPath,
  clearAutoMemoryRootCache,
  getAutoMemoryRoot,
  getUserAutoMemoryRoot,
} from './paths.js';
import type { Config } from '../config/config.js';
import * as metadataMigration from './metadata-migration.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const telemetryMocks = vi.hoisted(() => ({
  logMemoryExtract: vi.fn(),
}));

vi.mock('../telemetry/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../telemetry/index.js')>()),
  logMemoryExtract: telemetryMocks.logMemoryExtract,
}));

vi.mock('./extract.js', () => ({
  runAutoMemoryExtract: vi.fn(),
}));

vi.mock('./dream.js', () => ({
  runManagedAutoMemoryDream: vi.fn(),
}));

vi.mock('./user-dream.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./user-dream.js')>()),
  runManagedUserAutoMemoryDream: vi.fn(),
}));

vi.mock('./skillReviewAgentPlanner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./skillReviewAgentPlanner.js')>()),
  runSkillReviewByAgent: vi.fn(),
}));

import { runAutoMemoryExtract } from './extract.js';
import { runManagedAutoMemoryDream } from './dream.js';
import {
  recordUserAutoMemoryMutation,
  runManagedUserAutoMemoryDream,
} from './user-dream.js';
import * as userDream from './user-dream.js';
import { runSkillReviewByAgent } from './skillReviewAgentPlanner.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMockConfig(overrides: Partial<Config> = {}): Config {
  return {
    getManagedAutoMemoryEnabled: vi.fn().mockReturnValue(true),
    getManagedAutoDreamEnabled: vi.fn().mockReturnValue(true),
    getMemoryRecallMode: vi.fn().mockReturnValue('legacy'),
    isTrustedFolder: vi.fn().mockReturnValue(true),
    getSessionId: vi.fn().mockReturnValue('session-1'),
    getModel: vi.fn().mockReturnValue('test-model'),
    logEvent: vi.fn(),
    ...overrides,
  } as unknown as Config;
}

// ─── MemoryManager ────────────────────────────────────────────────────────────

describe('MemoryManager', () => {
  describe('metadata migration scheduling', () => {
    let tempDir: string;
    let projectRoot: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mgr-migration-'));
      projectRoot = path.join(tempDir, 'project');
      process.env['QWEN_CODE_MEMORY_LOCAL'] = '1';
      process.env['QWEN_CODE_MEMORY_BASE_DIR'] = path.join(tempDir, 'global');
      clearAutoMemoryRootCache();
      await ensureAutoMemoryScaffold(projectRoot);
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      delete process.env['QWEN_CODE_MEMORY_LOCAL'];
      delete process.env['QWEN_CODE_MEMORY_BASE_DIR'];
      clearAutoMemoryRootCache();
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    async function writeLegacy(root: string, name: string): Promise<void> {
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(
        path.join(root, name),
        ['---', 'type: project', '---', 'Legacy body.'].join('\n'),
        'utf-8',
      );
    }

    it('runs one task per domain while project and user migrate independently', async () => {
      await writeLegacy(getAutoMemoryRoot(projectRoot), 'project.md');
      await writeLegacy(getUserAutoMemoryRoot(), 'user.md');
      const scan = vi.spyOn(
        metadataMigration,
        'scanMemoryMetadataMigrationCandidates',
      );
      const resolvers = new Map<string, () => void>();
      vi.spyOn(
        metadataMigration,
        'runMemoryMetadataMigration',
      ).mockImplementation(
        ({ scope }) =>
          new Promise((resolve) => {
            resolvers.set(scope, () =>
              resolve({
                filesScanned: 1,
                legacyFiles: 1,
                remainingLegacyFiles: 0,
                attempted: 1,
                committed: 1,
                conflicts: 0,
                failed: 0,
                agentDurationMs: 1,
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              }),
            );
          }),
      );

      const manager = new MemoryManager();
      const config = makeMockConfig();
      const project = await manager.scheduleMetadataMigration({
        projectRoot,
        scope: 'project',
        config,
      });
      const user = await manager.scheduleMetadataMigration({
        projectRoot,
        scope: 'user',
        config,
      });

      expect(project.status).toBe('scheduled');
      expect(user.status).toBe('scheduled');
      await expect(manager.getStatus(projectRoot)).resolves.toMatchObject({
        migrationRunning: true,
        migrationTasks: expect.arrayContaining([
          expect.objectContaining({ id: project.taskId, status: 'running' }),
          expect.objectContaining({ id: user.taskId, status: 'running' }),
        ]),
      });
      const scansBeforeDuplicate = scan.mock.calls.length;
      expect(
        await manager.scheduleMetadataMigration({
          projectRoot,
          scope: 'project',
          config,
        }),
      ).toMatchObject({ status: 'skipped', skippedReason: 'running' });
      expect(scan).toHaveBeenCalledTimes(scansBeforeDuplicate);
      expect(
        await new MemoryManager().scheduleMetadataMigration({
          projectRoot,
          scope: 'user',
          config,
        }),
      ).toMatchObject({ status: 'skipped', skippedReason: 'running' });

      resolvers.get('project')?.();
      resolvers.get('user')?.();
      await manager.drain({ timeoutMs: 1000 });
      expect(manager.getTask(project.taskId!)?.status).toBe('completed');
      expect(manager.getTask(user.taskId!)?.status).toBe('completed');
      await expect(manager.getStatus(projectRoot)).resolves.toMatchObject({
        migrationRunning: false,
        migrationTasks: expect.arrayContaining([
          expect.objectContaining({ id: project.taskId, status: 'completed' }),
          expect.objectContaining({ id: user.taskId, status: 'completed' }),
        ]),
      });
    });

    it('skips structured migration without scanning candidates', async () => {
      const scan = vi.spyOn(
        metadataMigration,
        'scanMemoryMetadataMigrationCandidates',
      );
      const manager = new MemoryManager();

      await expect(
        manager.scheduleMetadataMigration({
          projectRoot,
          scope: 'project',
          config: makeMockConfig({
            getMemoryRecallMode: vi.fn().mockReturnValue('structured'),
          }),
        }),
      ).resolves.toEqual({ status: 'skipped', skippedReason: 'complete' });
      expect(scan).not.toHaveBeenCalled();
    });

    it('claims a migration domain before scanning candidates', async () => {
      await writeLegacy(getAutoMemoryRoot(projectRoot), 'project.md');
      const scanCandidates =
        metadataMigration.scanMemoryMetadataMigrationCandidates;
      let releaseScan: (() => void) | undefined;
      vi.spyOn(
        metadataMigration,
        'scanMemoryMetadataMigrationCandidates',
      ).mockImplementationOnce(async (...args) => {
        await new Promise<void>((resolve) => {
          releaseScan = resolve;
        });
        return scanCandidates(...args);
      });
      vi.spyOn(
        metadataMigration,
        'runMemoryMetadataMigration',
      ).mockResolvedValue({
        filesScanned: 1,
        legacyFiles: 1,
        remainingLegacyFiles: 0,
        attempted: 1,
        committed: 1,
        conflicts: 0,
        failed: 0,
        agentDurationMs: 1,
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      });
      const config = makeMockConfig();
      const first = new MemoryManager().scheduleMetadataMigration({
        projectRoot,
        scope: 'project',
        config,
      });
      await vi.waitFor(() => expect(releaseScan).toBeDefined());

      await expect(
        new MemoryManager().scheduleMetadataMigration({
          projectRoot,
          scope: 'project',
          config,
        }),
      ).resolves.toMatchObject({
        status: 'skipped',
        skippedReason: 'running',
      });

      releaseScan?.();
      const scheduled = await first;
      await scheduled.promise;
    });

    it('cancels a running migration without overwriting the terminal state', async () => {
      await writeLegacy(getAutoMemoryRoot(projectRoot), 'project.md');
      let capturedSignal: AbortSignal | undefined;
      vi.spyOn(
        metadataMigration,
        'runMemoryMetadataMigration',
      ).mockImplementation(
        ({ abortSignal }) =>
          new Promise((_resolve, reject) => {
            capturedSignal = abortSignal;
            abortSignal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      );

      const manager = new MemoryManager();
      const scheduled = await manager.scheduleMetadataMigration({
        projectRoot,
        scope: 'project',
        config: makeMockConfig(),
      });

      expect(manager.cancelTask(scheduled.taskId!)).toBe(true);
      expect(capturedSignal?.aborted).toBe(true);
      await manager.drain({ timeoutMs: 1000 });
      expect(manager.getTask(scheduled.taskId!)?.status).toBe('cancelled');
    });

    it('cancels all running migrations during shutdown', async () => {
      await writeLegacy(getAutoMemoryRoot(projectRoot), 'project.md');
      await writeLegacy(getUserAutoMemoryRoot(), 'user.md');
      vi.spyOn(
        metadataMigration,
        'runMemoryMetadataMigration',
      ).mockImplementation(
        ({ abortSignal }) =>
          new Promise((_resolve, reject) => {
            abortSignal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      );
      const manager = new MemoryManager();
      const config = makeMockConfig();
      const project = await manager.scheduleMetadataMigration({
        projectRoot,
        scope: 'project',
        config,
      });
      const user = await manager.scheduleMetadataMigration({
        projectRoot,
        scope: 'user',
        config,
      });

      manager.cancelMigrations();
      await manager.drain({ timeoutMs: 1000 });

      expect(manager.getTask(project.taskId!)?.status).toBe('cancelled');
      expect(manager.getTask(user.taskId!)?.status).toBe('cancelled');
    });

    it('records migration failures and releases the domain for retry', async () => {
      await writeLegacy(getAutoMemoryRoot(projectRoot), 'project.md');
      vi.spyOn(metadataMigration, 'runMemoryMetadataMigration')
        .mockRejectedValueOnce(new Error('agent failed'))
        .mockResolvedValueOnce({
          filesScanned: 1,
          legacyFiles: 1,
          remainingLegacyFiles: 0,
          attempted: 1,
          committed: 1,
          conflicts: 0,
          failed: 0,
          agentDurationMs: 1,
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
        });
      const manager = new MemoryManager();
      const params = {
        projectRoot,
        scope: 'project' as const,
        config: makeMockConfig(),
      };

      const first = await manager.scheduleMetadataMigration(params);
      await first.promise;
      expect(manager.getTask(first.taskId!)).toMatchObject({
        status: 'failed',
        error: 'agent failed',
      });

      const retry = await manager.scheduleMetadataMigration(params);
      expect(retry.status).toBe('scheduled');
      await retry.promise;
      expect(manager.getTask(retry.taskId!)?.status).toBe('completed');
    });

    it('pauses project and user dream while their legacy files remain', async () => {
      await writeLegacy(getAutoMemoryRoot(projectRoot), 'project.md');
      await writeLegacy(getUserAutoMemoryRoot(), 'user.md');
      const manager = new MemoryManager();
      const config = makeMockConfig();

      await expect(
        manager.scheduleDream({
          projectRoot,
          sessionId: 'session',
          config,
        }),
      ).resolves.toMatchObject({
        status: 'skipped',
        skippedReason: 'migration_pending',
      });
      await expect(
        manager.scheduleUserDream({ projectRoot, config }),
      ).resolves.toMatchObject({
        status: 'skipped',
        skippedReason: 'migration_pending',
      });
      expect(runManagedAutoMemoryDream).not.toHaveBeenCalled();
    });

    it('does not pause project dream for user-scope legacy files', async () => {
      await writeLegacy(getUserAutoMemoryRoot(), 'user.md');
      const manager = new MemoryManager();

      const result = await manager.scheduleDream({
        projectRoot,
        sessionId: 'session',
        config: makeMockConfig(),
      });

      expect(result.skippedReason).not.toBe('migration_pending');
    });

    it('does not pause user dream for project-scope legacy files', async () => {
      await writeLegacy(getAutoMemoryRoot(projectRoot), 'project.md');
      const manager = new MemoryManager();

      const result = await manager.scheduleUserDream({
        projectRoot,
        config: makeMockConfig(),
      });

      expect(result.skippedReason).not.toBe('migration_pending');
    });

    it('records a user mutation after forgetting a user-memory entry', async () => {
      const userFile = path.join(getUserAutoMemoryRoot(), 'user', 'note.md');
      await fs.mkdir(path.dirname(userFile), { recursive: true });
      await fs.writeFile(
        userFile,
        [
          '---',
          'name: User note',
          'description: User preference',
          'type: user',
          'category: communication_preference',
          'keywords:',
          '  - concise answers',
          'usage_scenarios:',
          '  - Responding to the user',
          '---',
          '',
          '# User Memory',
          '',
          '- Prefer concise answers',
          '',
        ].join('\n'),
      );
      const manager = new MemoryManager();
      const recordUserMutation = vi
        .spyOn(manager, 'recordUserMutation')
        .mockResolvedValue();
      const config = makeMockConfig();

      const result = await manager.forgetMatches(
        projectRoot,
        [
          {
            topic: 'user',
            summary: 'Prefer concise answers',
            filePath: userFile,
            entryIndex: 0,
          },
        ],
        new Date('2026-08-27T00:00:00.000Z'),
        { config },
      );

      expect(result.touchedScopes).toContain('user');
      expect(recordUserMutation).toHaveBeenCalledWith(
        projectRoot,
        config,
        expect.any(Date),
      );
    });

    it('records completed and failed User Dream tasks', async () => {
      const now = new Date('2026-08-27T00:00:00.000Z');
      for (let index = 0; index < 10; index += 1) {
        await recordUserAutoMemoryMutation(now);
      }
      vi.mocked(runManagedUserAutoMemoryDream).mockResolvedValueOnce({
        touchedTopics: ['user'],
        createdEntries: 0,
        updatedEntries: 1,
        deletedEntries: 0,
        dedupedEntries: 0,
        splitEntries: 0,
        keywordBackfilled: 0,
      });
      const manager = new MemoryManager();
      const config = makeMockConfig({
        getMemoryRecallMode: vi.fn().mockReturnValue('structured'),
      });

      const completed = await manager.scheduleUserDream({
        projectRoot,
        config,
        now,
      });
      await completed.promise;
      expect(manager.getTask(completed.taskId!)).toMatchObject({
        status: 'completed',
        metadata: { scope: 'user', updatedEntries: 1 },
      });

      for (let index = 0; index < 10; index += 1) {
        await recordUserAutoMemoryMutation(
          new Date('2026-08-28T00:00:00.000Z'),
        );
      }
      vi.mocked(runManagedUserAutoMemoryDream).mockRejectedValueOnce(
        new Error('user dream failed'),
      );
      const failed = await manager.scheduleUserDream({
        projectRoot,
        config,
        now: new Date('2026-08-29T00:00:00.000Z'),
      });
      await failed.promise;
      expect(manager.getTask(failed.taskId!)).toMatchObject({
        status: 'failed',
        error: 'user dream failed',
      });
    });

    it('keeps User Dream completed when completion metadata cannot persist', async () => {
      const now = new Date('2026-08-27T00:00:00.000Z');
      for (let index = 0; index < 10; index += 1) {
        await recordUserAutoMemoryMutation(now);
      }
      vi.mocked(runManagedUserAutoMemoryDream).mockResolvedValueOnce({
        touchedTopics: ['user'],
        createdEntries: 0,
        updatedEntries: 1,
        deletedEntries: 0,
        dedupedEntries: 0,
        splitEntries: 0,
        keywordBackfilled: 0,
      });
      vi.spyOn(userDream, 'completeUserAutoMemoryDream').mockRejectedValueOnce(
        new Error('metadata unavailable'),
      );
      const manager = new MemoryManager();

      const result = await manager.scheduleUserDream({
        projectRoot,
        config: makeMockConfig({
          getMemoryRecallMode: vi.fn().mockReturnValue('structured'),
        }),
        now,
      });
      await result.promise;

      expect(manager.getTask(result.taskId!)).toMatchObject({
        status: 'completed',
        metadata: { metadataWriteError: 'metadata unavailable' },
      });
    });
  });

  describe('search memory turn state', () => {
    it('allows rereads after compaction guards are reset', () => {
      const mgr = new MemoryManager();
      const signature = '{"mode":"fetch","refs":["project:a.md"]}';
      mgr.getExhaustedBodyRefsForCurrentTurn().add('project:a.md');

      expect(mgr.claimSearchMemoryRequestForCurrentTurn(signature)).toBe(true);
      expect(mgr.claimSearchMemoryRequestForCurrentTurn(signature)).toBe(false);

      mgr.resetExhaustedBodyRefsForCurrentTurn();

      expect(mgr.getExhaustedBodyRefsForCurrentTurn()).toEqual(new Set());
      expect(mgr.claimSearchMemoryRequestForCurrentTurn(signature)).toBe(true);
    });

    it('tracks resident body versions independently of read history', () => {
      const mgr = new MemoryManager();
      const versions = mgr.getBodyPresentVersionsInHistory();
      versions.set('project:one.md', 1);
      versions.set('project:two.md', 2);

      mgr.markMemoryBodiesEvictedFromHistory([
        { memoryRef: 'project:one.md', mtimeMs: 1 },
        { memoryRef: 'project:two.md', mtimeMs: 1 },
      ]);
      expect([...versions]).toEqual([['project:two.md', 2]]);

      mgr.markAllMemoryBodiesEvictedFromHistory();
      expect(versions.size).toBe(0);

      mgr.restoreMemoryBodiesPresentInHistory([
        { memoryRef: 'project:restored.md', mtimeMs: 3 },
      ]);
      expect([...versions]).toEqual([['project:restored.md', 3]]);
    });
  });

  describe('globalMemoryManager', () => {
    it('is a MemoryManager instance', () => {
      expect(globalMemoryManager).toBeInstanceOf(MemoryManager);
    });
  });

  // ─── drain() ──────────────────────────────────────────────────────────────

  describe('drain()', () => {
    it('resolves true immediately when there are no in-flight tasks', async () => {
      const mgr = new MemoryManager();
      expect(await mgr.drain()).toBe(true);
    });

    it('resolves false when drain times out while a task is in-flight', async () => {
      const mgr = new MemoryManager();
      let resolveExtract!: (
        v: Awaited<ReturnType<typeof runAutoMemoryExtract>>,
      ) => void;

      vi.mocked(runAutoMemoryExtract).mockReturnValue(
        new Promise<Awaited<ReturnType<typeof runAutoMemoryExtract>>>(
          (resolve) => {
            resolveExtract = resolve;
          },
        ),
      );

      void mgr.scheduleExtract({
        projectRoot: '/project',
        sessionId: 'sess',
        history: [{ role: 'user', parts: [{ text: 'hi' }] }],
      });

      expect(await mgr.drain({ timeoutMs: 20 })).toBe(false);

      resolveExtract({
        touchedTopics: [],
        cursor: { sessionId: 'sess', updatedAt: new Date().toISOString() },
      });
      expect(await mgr.drain()).toBe(true);
    });
  });

  // ─── scheduleExtract() ────────────────────────────────────────────────────

  describe('scheduleExtract()', () => {
    let tempDir: string;
    let projectRoot: string;

    beforeEach(async () => {
      vi.resetAllMocks();
      process.env['QWEN_CODE_MEMORY_LOCAL'] = '1';
      clearAutoMemoryRootCache();
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mgr-extract-'));
      projectRoot = path.join(tempDir, 'project');
      await fs.mkdir(projectRoot, { recursive: true });
      await ensureAutoMemoryScaffold(projectRoot);
    });

    afterEach(async () => {
      delete process.env['QWEN_CODE_MEMORY_LOCAL'];
      clearAutoMemoryRootCache();
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('runs extract and records a completed task', async () => {
      vi.mocked(runAutoMemoryExtract).mockResolvedValue({
        touchedTopics: ['user'],
        cursor: { sessionId: 'sess-1', updatedAt: new Date().toISOString() },
      });

      const mgr = new MemoryManager();
      const result = await mgr.scheduleExtract({
        projectRoot,
        sessionId: 'sess-1',
        history: [{ role: 'user', parts: [{ text: 'hi' }] }],
      });

      expect(result.touchedTopics).toEqual(['user']);
      await mgr.drain();
      const tasks = mgr.listTasksByType('extract', projectRoot);
      expect(tasks.some((t) => t.status === 'completed')).toBe(true);
    });

    it('records a user mutation when extraction touches user memory', async () => {
      vi.mocked(runAutoMemoryExtract).mockResolvedValue({
        touchedTopics: ['user'],
        touchedUserScope: true,
        cursor: { sessionId: 'sess-1', updatedAt: new Date().toISOString() },
      });
      const mgr = new MemoryManager();
      const recordUserMutation = vi
        .spyOn(mgr, 'recordUserMutation')
        .mockResolvedValue();
      const config = makeMockConfig();

      await mgr.scheduleExtract({
        projectRoot,
        sessionId: 'sess-1',
        config,
        history: [{ role: 'user', parts: [{ text: 'hi' }] }],
      });

      expect(recordUserMutation).toHaveBeenCalledWith(
        projectRoot,
        config,
        expect.any(Date),
      );
    });

    it('records a session mismatch as skipped', async () => {
      vi.mocked(runAutoMemoryExtract).mockResolvedValue({
        touchedTopics: [],
        skippedReason: 'session_mismatch',
        cursor: { sessionId: 'sess-1', updatedAt: new Date().toISOString() },
      });
      const config = makeMockConfig();

      const mgr = new MemoryManager();
      const result = await mgr.scheduleExtract({
        projectRoot,
        sessionId: 'sess-1',
        config,
        history: [{ role: 'user', parts: [{ text: 'hi' }] }],
      });

      expect(result.skippedReason).toBe('session_mismatch');
      expect(mgr.listTasksByType('extract', projectRoot)[0]).toMatchObject({
        status: 'skipped',
        progressText: 'Skipped: session mismatch.',
        metadata: { skippedReason: 'session_mismatch' },
      });
      const event = telemetryMocks.logMemoryExtract.mock.calls[0]?.[1] as {
        status: string;
        skipped_reason?: string;
      };
      expect(event).toMatchObject({
        status: 'skipped',
        skipped_reason: 'session_mismatch',
      });
    });

    it.each([
      ['private', '.qwen/memory/user/test.md'],
      ['team', '.qwen/team-memory/test.md'],
    ])(
      'skips extraction when history writes to a %s memory file',
      async (_label, filePath) => {
        const mgr = new MemoryManager();
        const result = await mgr.scheduleExtract({
          projectRoot,
          sessionId: 'sess-1',
          history: [
            {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    name: 'write_file',
                    args: {
                      file_path: path.join(projectRoot, filePath),
                    },
                  },
                },
              ],
            },
          ],
        });

        expect(result.skippedReason).toBe('memory_tool');
        expect(vi.mocked(runAutoMemoryExtract)).not.toHaveBeenCalled();
      },
    );

    it('records a user mutation when history writes User Memory', async () => {
      const mgr = new MemoryManager();
      const recordUserMutation = vi
        .spyOn(mgr, 'recordUserMutation')
        .mockResolvedValue();
      const config = makeMockConfig();
      const now = new Date('2026-08-27T00:00:00.000Z');

      const result = await mgr.scheduleExtract({
        projectRoot,
        sessionId: 'sess-1',
        config,
        now,
        history: [
          { role: 'user', parts: [{ text: 'Remember this preference.' }] },
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'write-user-memory',
                  name: 'write_file',
                  args: {
                    file_path: path.join(
                      getUserAutoMemoryRoot(),
                      'user',
                      'preference.md',
                    ),
                  },
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'write-user-memory',
                  name: 'write_file',
                  response: { output: 'updated' },
                },
              },
            ],
          },
        ],
      });

      expect(result.skippedReason).toBe('memory_tool');
      expect(recordUserMutation).toHaveBeenCalledWith(projectRoot, config, now);
    });

    it('queues a trailing extract when one is already running', async () => {
      let resolveFirst!: (
        v: Awaited<ReturnType<typeof runAutoMemoryExtract>>,
      ) => void;
      vi.mocked(runAutoMemoryExtract)
        .mockReturnValueOnce(
          new Promise<Awaited<ReturnType<typeof runAutoMemoryExtract>>>(
            (resolve) => {
              resolveFirst = resolve;
            },
          ),
        )
        .mockResolvedValueOnce({
          touchedTopics: ['reference'],
          cursor: { sessionId: 'sess-1', updatedAt: new Date().toISOString() },
        });

      const mgr = new MemoryManager();
      const firstPromise = mgr.scheduleExtract({
        projectRoot,
        sessionId: 'sess-1',
        history: [{ role: 'user', parts: [{ text: 'first' }] }],
      });

      // Second call while first is in-flight — should be queued
      const queued = await mgr.scheduleExtract({
        projectRoot,
        sessionId: 'sess-1',
        history: [{ role: 'user', parts: [{ text: 'second' }] }],
      });
      expect(queued.skippedReason).toBe('queued');

      // Resolve first so queued one can start
      resolveFirst({
        touchedTopics: ['user'],
        cursor: { sessionId: 'sess-1', updatedAt: new Date().toISOString() },
      });
      await firstPromise;
      await mgr.drain({ timeoutMs: 1_000 });

      // Both extractions should have run
      expect(vi.mocked(runAutoMemoryExtract)).toHaveBeenCalledTimes(2);
    });

    it('isolates state between manager instances', async () => {
      vi.mocked(runAutoMemoryExtract).mockResolvedValue({
        touchedTopics: ['user'],
        cursor: { sessionId: 'sess-1', updatedAt: new Date().toISOString() },
      });

      const mgrA = new MemoryManager();
      const mgrB = new MemoryManager();

      await mgrA.scheduleExtract({
        projectRoot,
        sessionId: 'sess-a',
        history: [{ role: 'user', parts: [{ text: 'hi' }] }],
      });
      await mgrA.drain();

      expect(mgrA.listTasksByType('extract', projectRoot)).toHaveLength(1);
      expect(mgrB.listTasksByType('extract', projectRoot)).toHaveLength(0);
    });
  });

  // ─── Skill review ─────────────────────────────────────────────────────────

  describe('scheduleSkillReview()', () => {
    beforeEach(() => {
      vi.resetAllMocks();
      vi.mocked(runSkillReviewByAgent).mockResolvedValue({
        touchedSkillFiles: ['/project/.qwen/skills/test/SKILL.md'],
      });
    });

    it('skips below threshold', () => {
      const mgr = new MemoryManager();
      const result = mgr.scheduleSkillReview({
        projectRoot: '/project',
        sessionId: 'sess',
        history: [],
        toolCallCount: 1,
        threshold: 2,
        skillsModified: false,
        config: makeMockConfig(),
      });

      expect(result).toEqual({
        status: 'skipped',
        skippedReason: 'below_threshold',
      });
      expect(runSkillReviewByAgent).not.toHaveBeenCalled();
    });

    it('skips when skills were modified in session', () => {
      const mgr = new MemoryManager();
      const result = mgr.scheduleSkillReview({
        projectRoot: '/project',
        sessionId: 'sess',
        history: [{ role: 'user', parts: [{ text: 'hi' }] }],
        toolCallCount: 20,
        threshold: 2,
        skillsModified: true,
        config: makeMockConfig(),
      });

      expect(result).toEqual({
        status: 'skipped',
        skippedReason: 'skills_modified_in_session',
      });
      expect(runSkillReviewByAgent).not.toHaveBeenCalled();
    });

    it('skips second call while first is still in-flight (already_running)', async () => {
      let resolveReview!: (v: { touchedSkillFiles: string[] }) => void;
      vi.mocked(runSkillReviewByAgent).mockReturnValueOnce(
        new Promise<{ touchedSkillFiles: string[] }>((resolve) => {
          resolveReview = resolve;
        }),
      );

      const mgr = new MemoryManager();
      const baseParams = {
        projectRoot: '/project',
        sessionId: 'sess',
        history: [{ role: 'user' as const, parts: [{ text: 'hi' }] }],
        toolCallCount: 25,
        threshold: 2,
        skillsModified: false,
        config: makeMockConfig(),
      };

      const first = mgr.scheduleSkillReview(baseParams);
      expect(first.status).toBe('scheduled');

      // Second call while first is still running
      const second = mgr.scheduleSkillReview({
        ...baseParams,
        sessionId: 'sess-2',
      });
      expect(second.status).toBe('skipped');
      expect(second.skippedReason).toBe('already_running');
      // Returns the existing task id so callers can observe it
      expect(second.taskId).toBe(first.taskId);

      // After first completes, a new call is allowed
      resolveReview({ touchedSkillFiles: [] });
      await first.promise;

      vi.mocked(runSkillReviewByAgent).mockResolvedValueOnce({
        touchedSkillFiles: [],
      });
      const third = mgr.scheduleSkillReview(baseParams);
      expect(third.status).toBe('scheduled');
      expect(third.taskId).not.toBe(first.taskId);
    });

    it('schedules skill review at threshold', async () => {
      const mgr = new MemoryManager();
      const result = mgr.scheduleSkillReview({
        projectRoot: '/project',
        sessionId: 'sess',
        history: [{ role: 'user', parts: [{ text: 'hi' }] }],
        toolCallCount: 2,
        threshold: 2,
        skillsModified: false,
        config: makeMockConfig(),
        maxTurns: 3,
        timeoutMs: 30_000,
      });

      expect(result.status).toBe('scheduled');
      await result.promise;
      expect(runSkillReviewByAgent).toHaveBeenCalledWith({
        config: expect.any(Object),
        projectRoot: '/project',
        history: [{ role: 'user', parts: [{ text: 'hi' }] }],
        maxTurns: 3,
        timeoutMs: 30_000,
      });
      expect(mgr.listTasksByType('skill-review', '/project')[0]?.status).toBe(
        'completed',
      );
    });
  });

  // ─── scheduleSkillReview() confirmBeforePersist ───────────────────────────

  describe('scheduleSkillReview() confirmBeforePersist', () => {
    let tempDir: string;
    let projectRoot: string;
    let skillFilePath: string;

    beforeEach(async () => {
      vi.resetAllMocks();
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mgr-skill-confirm-'));
      projectRoot = path.join(tempDir, 'project');
      await fs.mkdir(projectRoot, { recursive: true });
      skillFilePath = path.join(
        projectRoot,
        '.qwen',
        'skills',
        'auto-skill-foo',
        'SKILL.md',
      );
      // The agent CREATES the skill at run time (it did not exist before the
      // review) — staging only quarantines newly-created skills, so the mock
      // must write the file when invoked rather than the test pre-creating it.
      vi.mocked(runSkillReviewByAgent).mockImplementation(async () => {
        await fs.mkdir(path.dirname(skillFilePath), { recursive: true });
        await fs.writeFile(
          skillFilePath,
          '---\ndescription: Foo skill\n---\n# Foo\n',
        );
        return { touchedSkillFiles: [skillFilePath] };
      });
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('stages the skill and records pendingSkills when confirmBeforePersist is true', async () => {
      const mgr = new MemoryManager();
      const result = mgr.scheduleSkillReview({
        projectRoot,
        sessionId: 'sess',
        history: [{ role: 'user', parts: [{ text: 'hi' }] }],
        toolCallCount: 25,
        threshold: 2,
        skillsModified: false,
        config: makeMockConfig(),
        confirmBeforePersist: true,
      });

      expect(result.status).toBe('scheduled');
      const record = await result.promise!;

      expect(record.status).toBe('completed');
      const pendingSkills = record.metadata?.['pendingSkills'] as
        | unknown[]
        | undefined;
      expect(pendingSkills).toBeDefined();
      expect(pendingSkills).toHaveLength(1);

      // The skill must no longer be under .qwen/skills/
      await expect(fs.access(skillFilePath)).rejects.toThrow();
    });

    it('stages a new skill whose name exists only in the archive', async () => {
      const archivedManifest = path.join(
        projectRoot,
        '.qwen',
        'archived-skills',
        'auto-skill-foo',
        'SKILL.md',
      );
      await fs.mkdir(path.dirname(archivedManifest), { recursive: true });
      await fs.writeFile(archivedManifest, 'archived');
      const mgr = new MemoryManager();
      const record = await mgr.scheduleSkillReview({
        projectRoot,
        sessionId: 'sess',
        history: [{ role: 'user', parts: [{ text: 'hi' }] }],
        toolCallCount: 25,
        threshold: 2,
        skillsModified: false,
        config: makeMockConfig(),
        confirmBeforePersist: true,
      }).promise!;

      const pendingSkills = record.metadata?.['pendingSkills'] as Array<{
        stagedManifestPath: string;
      }>;
      expect(pendingSkills).toHaveLength(1);
      await expect(fs.access(skillFilePath)).rejects.toThrow();
      await expect(
        fs.access(pendingSkills[0]!.stagedManifestPath),
      ).resolves.toBeUndefined();
      await expect(fs.access(archivedManifest)).resolves.toBeUndefined();
    });

    it('leaves the skill in place and sets no pendingSkills when confirmBeforePersist is false', async () => {
      const mgr = new MemoryManager();
      const result = mgr.scheduleSkillReview({
        projectRoot,
        sessionId: 'sess',
        history: [{ role: 'user', parts: [{ text: 'hi' }] }],
        toolCallCount: 25,
        threshold: 2,
        skillsModified: false,
        config: makeMockConfig(),
        confirmBeforePersist: false,
      });

      expect(result.status).toBe('scheduled');
      const record = await result.promise!;

      expect(record.status).toBe('completed');
      expect(record.metadata?.['pendingSkills']).toBeUndefined();

      // The skill must still be under .qwen/skills/
      await expect(fs.access(skillFilePath)).resolves.toBeUndefined();
    });

    it('falls back to systemMessage as progress text when staging yields zero pending', async () => {
      // The skill exists BEFORE the review, so the agent edits it in place and
      // staging skips it (only new skills are staged) — zero pending, but the
      // edit is still a durable change, so the agent's systemMessage should win
      // over the "without durable changes" default.
      await fs.mkdir(path.dirname(skillFilePath), { recursive: true });
      await fs.writeFile(skillFilePath, '---\ndescription: Foo\n---\n# Foo\n');
      vi.mocked(runSkillReviewByAgent).mockImplementation(async () => {
        await fs.writeFile(
          skillFilePath,
          '---\ndescription: Foo v2\n---\n# Foo v2\n',
        );
        return {
          touchedSkillFiles: [skillFilePath],
          systemMessage: 'Skill review updated 1 file(s).',
        };
      });
      const mgr = new MemoryManager();
      const record = await mgr.scheduleSkillReview({
        projectRoot,
        sessionId: 'sess',
        history: [{ role: 'user', parts: [{ text: 'hi' }] }],
        toolCallCount: 25,
        threshold: 2,
        skillsModified: false,
        config: makeMockConfig(),
        confirmBeforePersist: true,
      }).promise!;
      expect(record.metadata?.['pendingSkills']).toBeUndefined();
      expect(record.progressText).toBe('Skill review updated 1 file(s).');
    });
  });

  // ─── listTasksByType() ────────────────────────────────────────────────────

  describe('listTasksByType()', () => {
    it('returns empty array when no tasks of that type exist', () => {
      const mgr = new MemoryManager();
      expect(mgr.listTasksByType('extract')).toEqual([]);
      expect(mgr.listTasksByType('dream')).toEqual([]);
      expect(mgr.listTasksByType('skill-review')).toEqual([]);
    });

    it('filters by projectRoot when provided', async () => {
      vi.mocked(runAutoMemoryExtract).mockResolvedValue({
        touchedTopics: [],
        cursor: { sessionId: 'sess', updatedAt: new Date().toISOString() },
      });

      const mgr = new MemoryManager();

      // Two extractions for different project roots
      await Promise.all([
        mgr.scheduleExtract({
          projectRoot: '/project-a',
          sessionId: 'sess',
          history: [{ role: 'user', parts: [{ text: 'hi' }] }],
        }),
        mgr.scheduleExtract({
          projectRoot: '/project-b',
          sessionId: 'sess',
          history: [{ role: 'user', parts: [{ text: 'hi' }] }],
        }),
      ]);
      await mgr.drain();

      expect(mgr.listTasksByType('extract', '/project-a')).toHaveLength(1);
      expect(mgr.listTasksByType('extract', '/project-b')).toHaveLength(1);
      expect(mgr.listTasksByType('extract')).toHaveLength(2);
    });
  });

  // ─── subscribe() filter ──────────────────────────────────────────────────

  describe('subscribe() taskType filter', () => {
    // The filter exists so high-frequency consumers (the bg-tasks UI
    // hook, only rendering dream entries) can skip the per-extract
    // notify entirely. Pin the routing both ways: filtered subscribers
    // must NOT fire on unrelated transitions, and unfiltered
    // subscribers must continue to fire on everything.
    it('routes notifies to type-filtered subscribers only when taskType matches', async () => {
      vi.mocked(runAutoMemoryExtract).mockResolvedValue({
        touchedTopics: [],
        cursor: { sessionId: 'sess', updatedAt: new Date().toISOString() },
      });
      const mgr = new MemoryManager();
      const dreamFilteredFires = vi.fn();
      const extractFilteredFires = vi.fn();
      const unfilteredFires = vi.fn();
      mgr.subscribe(dreamFilteredFires, { taskType: 'dream' });
      mgr.subscribe(extractFilteredFires, { taskType: 'extract' });
      mgr.subscribe(unfilteredFires);

      await mgr.scheduleExtract({
        projectRoot: '/p',
        sessionId: 'sess',
        history: [{ role: 'user', parts: [{ text: 'hi' }] }],
      });
      await mgr.drain();

      // Extract scheduling fires storeWith (1) + completion update (1) = 2 notifies.
      // Dream-filtered subscriber must NOT see them.
      expect(dreamFilteredFires).not.toHaveBeenCalled();
      // Both extract-filtered and unfiltered subscribers must see them.
      expect(extractFilteredFires.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(unfilteredFires.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    it('returns an unsubscribe function that drops the filtered listener even when later notifies fire', async () => {
      // Verify the unsubscribe actually severs the listener — the
      // earlier version of this test only asserted "not called yet"
      // without ever firing a notify, so the listener could have
      // remained attached and the test would still pass.
      vi.mocked(runAutoMemoryExtract).mockResolvedValue({
        touchedTopics: [],
        cursor: { sessionId: 'sess', updatedAt: new Date().toISOString() },
      });
      const mgr = new MemoryManager();
      const fires = vi.fn();
      const unsubscribe = mgr.subscribe(fires, { taskType: 'extract' });

      // First extract should fire the listener (storeWith + completion update).
      await mgr.scheduleExtract({
        projectRoot: '/p',
        sessionId: 'sess',
        history: [{ role: 'user', parts: [{ text: 'hi' }] }],
      });
      await mgr.drain();
      const firesBeforeUnsubscribe = fires.mock.calls.length;
      expect(firesBeforeUnsubscribe).toBeGreaterThanOrEqual(1);

      // After unsubscribe, a second extract must not increment the count.
      unsubscribe();
      await mgr.scheduleExtract({
        projectRoot: '/p',
        sessionId: 'sess-2',
        history: [{ role: 'user', parts: [{ text: 'hi again' }] }],
      });
      await mgr.drain();
      expect(fires.mock.calls.length).toBe(firesBeforeUnsubscribe);
    });
  });

  // ─── skill-review subscription + accept/reject ───────────────────────────

  describe('skill-review subscriptions and pending APIs', () => {
    let tempDir: string;
    let projectRoot: string;
    let skillFilePath: string;

    beforeEach(async () => {
      vi.resetAllMocks();
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mgr-skill-pending-'));
      projectRoot = path.join(tempDir, 'project');
      await fs.mkdir(projectRoot, { recursive: true });
      skillFilePath = path.join(
        projectRoot,
        '.qwen',
        'skills',
        'auto-skill-foo',
        'SKILL.md',
      );
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    /** Produce a completed skill-review task with one pending skill. */
    async function scheduleAndAwait(mgr: MemoryManager) {
      // The agent creates the skill at run time (not pre-existing) so staging
      // quarantines it.
      vi.mocked(runSkillReviewByAgent).mockImplementation(async () => {
        await fs.mkdir(path.dirname(skillFilePath), { recursive: true });
        await fs.writeFile(
          skillFilePath,
          '---\ndescription: Foo skill\n---\n# Foo\n',
        );
        return { touchedSkillFiles: [skillFilePath] };
      });
      const result = mgr.scheduleSkillReview({
        projectRoot,
        sessionId: 'sess',
        history: [{ role: 'user', parts: [{ text: 'hi' }] }],
        toolCallCount: 25,
        threshold: 2,
        skillsModified: false,
        config: makeMockConfig(),
        confirmBeforePersist: true,
      });
      expect(result.status).toBe('scheduled');
      const record = await result.promise!;
      return record;
    }

    it('skill-review notify wakes type-filtered skill-review subscribers', async () => {
      const mgr = new MemoryManager();
      const fn = vi.fn();
      const dreamFn = vi.fn();
      const unsub = mgr.subscribe(fn, { taskType: 'skill-review' });
      const unsubDream = mgr.subscribe(dreamFn, { taskType: 'dream' });

      await scheduleAndAwait(mgr);

      // At minimum storeWith (running) + update (completed) = 2 notifies
      expect(fn.mock.calls.length).toBeGreaterThanOrEqual(1);
      // skill-review notifies must NOT wake dream-filtered subscribers
      expect(dreamFn).not.toHaveBeenCalled();
      unsub();
      unsubDream();
    });

    it('acceptPendingSkillFromTask promotes the skill and removes it from pendingSkills', async () => {
      const mgr = new MemoryManager();
      const record = await scheduleAndAwait(mgr);

      const taskId = record.id;
      await mgr.acceptPendingSkillFromTask(taskId, 'auto-skill-foo');

      // The skill must now exist at its final path under .qwen/skills/
      const finalPath = path.join(
        projectRoot,
        '.qwen',
        'skills',
        'auto-skill-foo',
        'SKILL.md',
      );
      await expect(fs.access(finalPath)).resolves.toBeUndefined();

      // The task record must reflect 0 remaining pending skills
      const updated = mgr.getTask(taskId);
      const remaining = updated?.metadata?.['pendingSkills'] as unknown[];
      expect(remaining).toHaveLength(0);
    });

    it('rejectPendingSkillFromTask deletes the staged skill and removes it from pendingSkills', async () => {
      const mgr = new MemoryManager();
      const record = await scheduleAndAwait(mgr);

      const taskId = record.id;
      await mgr.rejectPendingSkillFromTask(taskId, 'auto-skill-foo');

      // The skill must NOT exist under .qwen/skills/
      const finalPath = path.join(
        projectRoot,
        '.qwen',
        'skills',
        'auto-skill-foo',
        'SKILL.md',
      );
      await expect(fs.access(finalPath)).rejects.toThrow();

      // The staged dir must also be gone
      const stagedPath = path.join(
        projectRoot,
        '.qwen',
        'pending-skills',
        'auto-skill-foo',
      );
      await expect(fs.access(stagedPath)).rejects.toThrow();

      // The task record must reflect 0 remaining pending skills
      const updated = mgr.getTask(taskId);
      const remaining = updated?.metadata?.['pendingSkills'] as unknown[];
      expect(remaining).toHaveLength(0);
    });

    it('concurrent accept (Keep all) removes every entry, not just the last', async () => {
      const mgr = new MemoryManager();
      const names = ['auto-skill-a', 'auto-skill-b', 'auto-skill-c'];
      const files = names.map((n) =>
        path.join(projectRoot, '.qwen', 'skills', n, 'SKILL.md'),
      );
      vi.mocked(runSkillReviewByAgent).mockImplementation(async () => {
        for (const f of files) {
          await fs.mkdir(path.dirname(f), { recursive: true });
          await fs.writeFile(f, '---\ndescription: x\n---\n# x\n');
        }
        return { touchedSkillFiles: files };
      });
      const record = await mgr.scheduleSkillReview({
        projectRoot,
        sessionId: 'sess',
        history: [{ role: 'user', parts: [{ text: 'hi' }] }],
        toolCallCount: 25,
        threshold: 2,
        skillsModified: false,
        config: makeMockConfig(),
        confirmBeforePersist: true,
      }).promise!;
      const taskId = record.id;
      const pending = record.metadata?.['pendingSkills'] as Array<{
        name: string;
      }>;
      expect(pending).toHaveLength(3);

      // "Keep all" fires onAccept for each skill concurrently. The race bug
      // (reading pendingSkills before the await) left all-but-one behind.
      await Promise.all(
        pending.map((p) => mgr.acceptPendingSkillFromTask(taskId, p.name)),
      );

      const remaining = mgr.getTask(taskId)?.metadata?.['pendingSkills'] as
        | unknown[]
        | undefined;
      expect(remaining).toHaveLength(0);
    });
  });

  // ─── scheduleDream() ─────────────────────────────────────────────────────

  describe('scheduleDream()', () => {
    let tempDir: string;
    let projectRoot: string;

    beforeEach(async () => {
      vi.resetAllMocks();
      process.env['QWEN_CODE_MEMORY_LOCAL'] = '1';
      clearAutoMemoryRootCache();
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mgr-dream-'));
      projectRoot = path.join(tempDir, 'project');
      await fs.mkdir(projectRoot, { recursive: true });
      await ensureAutoMemoryScaffold(
        projectRoot,
        new Date('2026-04-01T00:00:00.000Z'),
      );
      vi.mocked(runManagedAutoMemoryDream).mockResolvedValue({
        touchedTopics: [],
        createdEntries: 0,
        updatedEntries: 0,
        deletedEntries: 0,
        dedupedEntries: 0,
        splitEntries: 0,
        keywordBackfilled: 0,
        systemMessage: undefined,
      });
    });

    afterEach(async () => {
      delete process.env['QWEN_CODE_MEMORY_LOCAL'];
      clearAutoMemoryRootCache();
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('skips when dream is disabled in config', async () => {
      const mgr = new MemoryManager(async () => [
        'sess-0',
        'sess-1',
        'sess-2',
        'sess-3',
        'sess-4',
      ]);
      const config = makeMockConfig({
        getManagedAutoDreamEnabled: vi.fn().mockReturnValue(false),
      });

      const result = await mgr.scheduleDream({
        projectRoot,
        sessionId: 'sess-5',
        config,
        now: new Date('2026-04-01T10:00:00.000Z'),
        minHoursBetweenDreams: 0,
        minSessionsBetweenDreams: 1,
      });

      expect(result).toEqual({ status: 'skipped', skippedReason: 'disabled' });
    });

    it('skips when params.config is omitted entirely', async () => {
      // Without config, runManagedAutoMemoryDream throws — surfacing
      // a noisy failed entry in the bg-tasks dialog. The early skip
      // converts the omitted-config case to the same disabled-skip
      // path so callers can't accidentally produce visible failures
      // by leaving config out (the type allows it for test ergonomics).
      const mgr = new MemoryManager();
      const result = await mgr.scheduleDream({
        projectRoot,
        sessionId: 'sess-no-config',
        // config intentionally omitted
        now: new Date('2026-04-02T10:00:00.000Z'),
      });
      expect(result).toEqual({ status: 'skipped', skippedReason: 'disabled' });
      // Crucially — no record was stored for this skip.
      expect(mgr.listTasksByType('dream', projectRoot)).toEqual([]);
    });

    it('skips when called again in the same session', async () => {
      const scanner = vi
        .fn()
        .mockResolvedValue(['sess-0', 'sess-1', 'sess-2', 'sess-3', 'sess-4']);
      const mgr = new MemoryManager(scanner);

      const config = makeMockConfig();
      const first = await mgr.scheduleDream({
        projectRoot,
        sessionId: 'sess-x',
        config,
        now: new Date('2026-04-01T10:00:00.000Z'),
        minHoursBetweenDreams: 0,
        minSessionsBetweenDreams: 1,
      });
      expect(first.status).toBe('scheduled');
      await first.promise;

      const second = await mgr.scheduleDream({
        projectRoot,
        sessionId: 'sess-x',
        config,
        now: new Date('2026-04-01T11:00:00.000Z'),
        minHoursBetweenDreams: 0,
        minSessionsBetweenDreams: 1,
      });
      expect(second).toEqual({
        status: 'skipped',
        skippedReason: 'same_session',
      });
    });

    it('skips when min_hours has not elapsed', async () => {
      const mgr = new MemoryManager(async () => [
        'sess-0',
        'sess-1',
        'sess-2',
        'sess-3',
        'sess-4',
      ]);

      // Inject lastDreamAt that is very recent
      const metaPath = getAutoMemoryMetadataPath(projectRoot);
      const metadata = JSON.parse(
        await fs.readFile(metaPath, 'utf-8'),
      ) as Record<string, unknown>;
      metadata['lastDreamAt'] = new Date(
        '2026-04-01T09:00:00.000Z',
      ).toISOString();
      await fs.writeFile(metaPath, JSON.stringify(metadata, null, 2), 'utf-8');

      const result = await mgr.scheduleDream({
        projectRoot,
        sessionId: 'sess-new',
        config: makeMockConfig(),
        now: new Date('2026-04-01T10:00:00.000Z'),
        minHoursBetweenDreams: 24,
        minSessionsBetweenDreams: 1,
      });

      expect(result).toEqual({ status: 'skipped', skippedReason: 'min_hours' });
    });

    it('skips when session count is below threshold (via session scanner)', async () => {
      // Only 1 session — need 5
      const mgr = new MemoryManager(async () => ['sess-0']);

      const result = await mgr.scheduleDream({
        projectRoot,
        sessionId: 'sess-new',
        config: makeMockConfig(),
        now: new Date('2026-04-01T10:00:00.000Z'),
        minHoursBetweenDreams: 0,
        minSessionsBetweenDreams: 5,
      });

      expect(result.status).toBe('skipped');
      expect(result.skippedReason).toBe('min_sessions');
    });

    it('schedules when all conditions are met, releases lock, and records metadata', async () => {
      vi.mocked(runManagedAutoMemoryDream).mockResolvedValue({
        touchedTopics: ['user'],
        createdEntries: 0,
        updatedEntries: 1,
        deletedEntries: 1,
        dedupedEntries: 1,
        splitEntries: 0,
        keywordBackfilled: 0,
        systemMessage: 'Dream complete.',
      });

      const mgr = new MemoryManager(async () => ['s0', 's1', 's2', 's3', 's4']);

      const result = await mgr.scheduleDream({
        projectRoot,
        sessionId: 'sess-x',
        config: makeMockConfig(),
        now: new Date('2026-04-01T10:00:00.000Z'),
        minHoursBetweenDreams: 0,
        minSessionsBetweenDreams: 3,
      });

      expect(result.status).toBe('scheduled');
      const finalRecord = await result.promise;
      expect(finalRecord?.status).toBe('completed');
      expect(finalRecord?.metadata).toMatchObject({
        touchedTopics: ['user'],
        createdEntries: 0,
        updatedEntries: 1,
        deletedEntries: 1,
        dedupedEntries: 1,
        splitEntries: 0,
        keywordBackfilled: 0,
      });

      // Lock must be released
      await expect(
        fs.access(getAutoMemoryConsolidationLockPath(projectRoot)),
      ).rejects.toThrow();

      // Metadata must be updated
      const meta = JSON.parse(
        await fs.readFile(getAutoMemoryMetadataPath(projectRoot), 'utf-8'),
      ) as { lastDreamSessionId?: string; lastDreamAt?: string };
      expect(meta.lastDreamSessionId).toBe('sess-x');
      expect(meta.lastDreamAt).toBe('2026-04-01T10:00:00.000Z');
    });
  });

  // ─── scheduleSkillReview: concurrent extract ──────────────────────────────

  describe('scheduleSkillReview(): concurrent extract (checklist 6)', () => {
    it('schedules skill review independently even when extract is already running', async () => {
      // arrange: extract never resolves so it stays "running"
      vi.mocked(runAutoMemoryExtract).mockReturnValue(new Promise(() => {}));
      vi.mocked(runSkillReviewByAgent).mockResolvedValue({
        touchedSkillFiles: [],
      });

      const mgr = new MemoryManager();
      const projectRoot = '/test-project-concurrent';
      const config = makeMockConfig();

      // Start extract (will stay in-flight)
      void mgr.scheduleExtract({
        projectRoot,
        sessionId: 'sess-extract',
        history: [{ role: 'user', parts: [{ text: 'do some work' }] }],
        config,
      });

      // Skill review must be scheduled independently, not silently dropped
      const result = mgr.scheduleSkillReview({
        projectRoot,
        sessionId: 'sess-extract',
        history: [{ role: 'user', parts: [{ text: 'do some work' }] }],
        toolCallCount: 25,
        threshold: 20,
        enabled: true,
        skillsModified: false,
        config,
      });

      expect(result.status).toBe('scheduled');
      expect(result.taskId).toBeDefined();
    });

    it('schedules skill review independently when no extract is running', () => {
      const mgr = new MemoryManager();
      const projectRoot = '/test-project-independent';
      const config = makeMockConfig();

      vi.mocked(runSkillReviewByAgent).mockResolvedValue({
        touchedSkillFiles: [],
      });

      const result = mgr.scheduleSkillReview({
        projectRoot,
        sessionId: 'sess-1',
        history: [{ role: 'user', parts: [{ text: 'work' }] }],
        toolCallCount: 25,
        threshold: 20,
        enabled: true,
        skillsModified: false,
        config,
      });

      expect(result.status).toBe('scheduled');
      expect(result.skippedReason).toBeUndefined();
      expect(result.taskId).toBeDefined();
    });
  });

  // ─── cancelTask() ────────────────────────────────────────────────────────

  describe('cancelTask()', () => {
    let tempDir: string;
    let projectRoot: string;

    beforeEach(async () => {
      vi.resetAllMocks();
      process.env['QWEN_CODE_MEMORY_LOCAL'] = '1';
      clearAutoMemoryRootCache();
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mgr-cancel-'));
      projectRoot = path.join(tempDir, 'project');
      await fs.mkdir(projectRoot, { recursive: true });
      await ensureAutoMemoryScaffold(
        projectRoot,
        new Date('2026-04-01T00:00:00.000Z'),
      );
    });

    afterEach(async () => {
      delete process.env['QWEN_CODE_MEMORY_LOCAL'];
      clearAutoMemoryRootCache();
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('aborts the dream fork agent and marks the record cancelled', async () => {
      // The fork's abort signal is captured here so the test can assert
      // both the status flip AND the actual signal propagation — only
      // the latter guarantees runForkedAgent will unwind.
      let capturedSignal: AbortSignal | undefined;
      let resolveDreamStarted!: () => void;
      const dreamStarted = new Promise<void>((r) => {
        resolveDreamStarted = r;
      });
      vi.mocked(runManagedAutoMemoryDream).mockImplementation(
        async (_root, _now, _config, signal) => {
          capturedSignal = signal;
          resolveDreamStarted();
          // Simulate a long-running dream that respects the signal.
          await new Promise<void>((_, reject) => {
            signal?.addEventListener('abort', () =>
              reject(new Error('aborted')),
            );
          });
          return {
            touchedTopics: [],
            createdEntries: 0,
            updatedEntries: 0,
            deletedEntries: 0,
            dedupedEntries: 0,
            splitEntries: 0,
            keywordBackfilled: 0,
            systemMessage: undefined,
          };
        },
      );

      const mgr = new MemoryManager(async () => [
        'sess-0',
        'sess-1',
        'sess-2',
        'sess-3',
        'sess-4',
      ]);
      const config = makeMockConfig();
      const result = await mgr.scheduleDream({
        projectRoot,
        sessionId: 'sess-x',
        config,
        now: new Date('2026-04-02T10:00:00.000Z'),
      });
      expect(result.status).toBe('scheduled');
      const taskId = result.taskId!;

      // Wait for the fork to actually enter — scheduleDream returns
      // before lock acquisition + the fork-agent invocation actually
      // run. Cancelling before the fork enters would race the abort
      // signal capture and produce a flaky undefined.
      await dreamStarted;

      // Cancel must succeed and synchronously flip status; the fork's
      // unwind happens later via the abort signal.
      const cancelled = mgr.cancelTask(taskId);
      expect(cancelled).toBe(true);
      expect(mgr.getTask(taskId)?.status).toBe('cancelled');
      expect(capturedSignal?.aborted).toBe(true);

      // Drain so the fork-agent rejection lands and runDream's catch
      // path runs — the user-cancel guard must NOT overwrite to
      // 'failed'. (Without the guard, the rejected promise sets the
      // record to failed with error="aborted".)
      await mgr.drain({ timeoutMs: 1000 });
      expect(mgr.getTask(taskId)?.status).toBe('cancelled');
    });

    it('keeps the record cancelled even when runManagedAutoMemoryDream resolves successfully after abort', async () => {
      // The realistic abort path: runForkedAgent maps
      // AgentTerminateMode.CANCELLED to a resolved `{status: 'cancelled'}`
      // rather than a rejection. dreamAgentPlanner is supposed to
      // rethrow that case, but the manager carries an additional
      // signal.aborted check after the await as defense in depth.
      // This test simulates the "resolved despite cancel" scenario by
      // having the mock RESOLVE on abort instead of rejecting — without
      // the guard, runDream's success path would overwrite the
      // user-cancelled record to 'completed' and bump dream metadata
      // for an aborted run.
      let resolveStarted!: () => void;
      const started = new Promise<void>((r) => {
        resolveStarted = r;
      });
      vi.mocked(runManagedAutoMemoryDream).mockImplementation(
        async (_root, _now, _config, signal) => {
          resolveStarted();
          await new Promise<void>((resolve) => {
            signal?.addEventListener('abort', () => resolve());
          });
          return {
            touchedTopics: ['user', 'project'],
            createdEntries: 0,
            updatedEntries: 2,
            deletedEntries: 0,
            dedupedEntries: 0,
            splitEntries: 0,
            keywordBackfilled: 0,
            systemMessage: 'Managed auto-memory dream completed.',
          };
        },
      );

      const mgr = new MemoryManager(async () => [
        'sess-0',
        'sess-1',
        'sess-2',
        'sess-3',
        'sess-4',
      ]);
      const config = makeMockConfig();
      const result = await mgr.scheduleDream({
        projectRoot,
        sessionId: 'sess-x',
        config,
        now: new Date('2026-04-02T10:00:00.000Z'),
      });
      const taskId = result.taskId!;
      await started;
      mgr.cancelTask(taskId);
      await mgr.drain({ timeoutMs: 1000 });

      expect(mgr.getTask(taskId)?.status).toBe('cancelled');
      // Metadata write must NOT have happened — lastDreamAt should
      // still be the scaffold's initial value, not the cancelled-run's
      // `now`. (Bumping it would suppress the next legitimate dream.)
      const metaRaw = await fs.readFile(
        getAutoMemoryMetadataPath(projectRoot),
        'utf-8',
      );
      const meta = JSON.parse(metaRaw) as {
        lastDreamAt?: string;
        lastDreamSessionId?: string;
      };
      expect(meta.lastDreamAt).not.toBe('2026-04-02T10:00:00.000Z');
      expect(meta.lastDreamSessionId).not.toBe('sess-x');
    });

    it('returns false for unknown task ids', async () => {
      const mgr = new MemoryManager();
      expect(mgr.cancelTask('does-not-exist')).toBe(false);
    });

    it('returns false for an already-completed dream', async () => {
      // The dream's natural completion path runs first, marks the
      // record terminal; a subsequent cancel attempt must no-op rather
      // than overwrite the recorded outcome (would erase touchedTopics
      // metadata the user just saw via memory_saved toast).
      vi.mocked(runManagedAutoMemoryDream).mockResolvedValue({
        touchedTopics: [],
        createdEntries: 0,
        updatedEntries: 0,
        deletedEntries: 0,
        dedupedEntries: 0,
        splitEntries: 0,
        keywordBackfilled: 0,
        systemMessage: undefined,
      });
      const mgr = new MemoryManager(async () => [
        'sess-0',
        'sess-1',
        'sess-2',
        'sess-3',
        'sess-4',
      ]);
      const config = makeMockConfig();
      const result = await mgr.scheduleDream({
        projectRoot,
        sessionId: 'sess-x',
        config,
        now: new Date('2026-04-02T10:00:00.000Z'),
      });
      const taskId = result.taskId!;
      // Drain so the dream completes naturally.
      await mgr.drain({ timeoutMs: 1000 });
      expect(mgr.getTask(taskId)?.status).toBe('completed');
      expect(mgr.cancelTask(taskId)).toBe(false);
      expect(mgr.getTask(taskId)?.status).toBe('completed');
    });
  });

  // ─── resetExtractStateForTests() ─────────────────────────────────────────

  describe('resetExtractStateForTests()', () => {
    it('clears in-flight extract state so subsequent calls are not blocked', async () => {
      let resolveExtract!: (
        v: Awaited<ReturnType<typeof runAutoMemoryExtract>>,
      ) => void;
      vi.mocked(runAutoMemoryExtract)
        .mockReturnValueOnce(
          new Promise<Awaited<ReturnType<typeof runAutoMemoryExtract>>>(
            (resolve) => {
              resolveExtract = resolve;
            },
          ),
        )
        .mockResolvedValueOnce({
          touchedTopics: [],
          cursor: { sessionId: 'sess', updatedAt: new Date().toISOString() },
        });

      const mgr = new MemoryManager();
      void mgr.scheduleExtract({
        projectRoot: '/project',
        sessionId: 'sess',
        history: [{ role: 'user', parts: [{ text: 'hi' }] }],
      });

      mgr.resetExtractStateForTests();

      // After reset, a new schedule call should not return 'already_running'
      const result = await mgr.scheduleExtract({
        projectRoot: '/project',
        sessionId: 'sess-2',
        history: [{ role: 'user', parts: [{ text: 'hi' }] }],
      });
      expect(result.skippedReason).not.toBe('already_running');

      resolveExtract({
        touchedTopics: [],
        cursor: { sessionId: 'sess', updatedAt: new Date().toISOString() },
      });
    });
  });

  // ─── #5147 regression: trailing queue + memory pressure ─────────────────

  describe('scheduleExtract #5147', () => {
    /**
     * B1: When an extract is already running and a new extract is queued,
     * superseding the trailing request drops the old params reference (the
     * old history becomes GC-eligible). Verify that only the latest params
     * are retained and the trailing extract executes correctly.
     */
    it('supersedes trailing queue without leaking old history refs', async () => {
      vi.mocked(runAutoMemoryExtract).mockClear();

      const mgr = new MemoryManager();

      let resolveFirst: (
        value: Awaited<ReturnType<typeof runAutoMemoryExtract>>,
      ) => void;
      let resolveTrailing: (
        value: Awaited<ReturnType<typeof runAutoMemoryExtract>>,
      ) => void;
      const firstPromise = new Promise<
        Awaited<ReturnType<typeof runAutoMemoryExtract>>
      >((r) => {
        resolveFirst = r;
      });
      const trailingPromise = new Promise<
        Awaited<ReturnType<typeof runAutoMemoryExtract>>
      >((r) => {
        resolveTrailing = r;
      });

      // First call → starts running
      vi.mocked(runAutoMemoryExtract).mockReturnValueOnce(firstPromise);

      void mgr.scheduleExtract({
        projectRoot: '/project',
        sessionId: 'sess',
        history: [
          { role: 'user', parts: [{ text: 'first history' }] },
          { role: 'model', parts: [{ text: 'first response' }] },
        ],
      });

      expect(runAutoMemoryExtract).toHaveBeenCalledTimes(1);

      // Second call while first is running → queues trailing
      const secondResult = await mgr.scheduleExtract({
        projectRoot: '/project',
        sessionId: 'sess',
        history: [
          { role: 'user', parts: [{ text: 'second history' }] },
          { role: 'model', parts: [{ text: 'second response' }] },
        ],
      });
      expect(secondResult.skippedReason).toBe('queued');

      // Third call while first is STILL running → supersedes trailing
      vi.mocked(runAutoMemoryExtract).mockReturnValueOnce(trailingPromise);
      const thirdResult = await mgr.scheduleExtract({
        projectRoot: '/project',
        sessionId: 'sess',
        history: [
          { role: 'user', parts: [{ text: 'third history' }] },
          { role: 'model', parts: [{ text: 'third response' }] },
        ],
      });
      expect(thirdResult.skippedReason).toBe('queued');
      // Still only 1 actual extract call (first is still running)
      expect(runAutoMemoryExtract).toHaveBeenCalledTimes(1);

      // Finish the first extract
      resolveFirst!({
        touchedTopics: [],
        cursor: {
          sessionId: 'sess',
          processedOffset: 2,
          updatedAt: new Date().toISOString(),
        },
      });
      // Wait for the trailing to be picked up and started
      await vi.waitFor(() => {
        expect(runAutoMemoryExtract).toHaveBeenCalledTimes(2);
      });

      // Verify the trailing extract received the third call's params,
      // not the second call's stale history reference.
      expect(runAutoMemoryExtract).toHaveBeenLastCalledWith(
        expect.objectContaining({
          history: [
            { role: 'user', parts: [{ text: 'third history' }] },
            { role: 'model', parts: [{ text: 'third response' }] },
          ],
        }),
      );

      // Finish the trailing (should use third history, not second)
      resolveTrailing!({
        touchedTopics: ['user'],
        cursor: {
          sessionId: 'sess',
          processedOffset: 2,
          updatedAt: new Date().toISOString(),
        },
      });

      // Drain to ensure everything settles
      await mgr.drain({ timeoutMs: 500 });
    });

    /**
     * B2: extract is skipped with 'memory_pressure' when the shared
     * MemoryPressureMonitor reports hard/critical pressure. The cursor is
     * NOT advanced (runAutoMemoryExtract is never called), so the unread
     * messages are retried on a later, lower-pressure turn.
     */
    it('skips extract with memory_pressure when the monitor reports critical', async () => {
      vi.mocked(runAutoMemoryExtract).mockClear();

      const config = makeMockConfig({
        getMemoryPressureMonitor: vi.fn().mockReturnValue({
          getPressureLevel: vi.fn().mockReturnValue('critical'),
        }),
      } as Partial<Config>);

      const mgr = new MemoryManager();
      const result = await mgr.scheduleExtract({
        projectRoot: '/project',
        sessionId: 'sess',
        config,
        history: [{ role: 'user', parts: [{ text: 'hi' }] }],
      });

      expect(result.skippedReason).toBe('memory_pressure');
      expect(result.touchedTopics).toEqual([]);
      // The cursor is deliberately NOT advanced (no processedOffset) so
      // unprocessed messages are retried on a later lower-pressure turn.
      expect(result.cursor.processedOffset).toBeUndefined();
      // Gate fired before invoking the real extract → cursor untouched.
      expect(runAutoMemoryExtract).not.toHaveBeenCalled();
    });

    /**
     * B3: extract proceeds normally when the monitor reports normal/soft
     * pressure (only hard/critical gate it).
     */
    it('does not skip extract when pressure is normal', async () => {
      vi.mocked(runAutoMemoryExtract).mockClear();
      vi.mocked(runAutoMemoryExtract).mockResolvedValueOnce({
        touchedTopics: ['user'],
        cursor: {
          sessionId: 'sess',
          processedOffset: 1,
          updatedAt: new Date().toISOString(),
        },
      });

      const config = makeMockConfig({
        getMemoryPressureMonitor: vi.fn().mockReturnValue({
          getPressureLevel: vi.fn().mockReturnValue('soft'),
        }),
      } as Partial<Config>);

      const mgr = new MemoryManager();
      const result = await mgr.scheduleExtract({
        projectRoot: '/project',
        sessionId: 'sess',
        config,
        history: [{ role: 'user', parts: [{ text: 'hi' }] }],
      });

      expect(result.skippedReason).toBeUndefined();
      expect(runAutoMemoryExtract).toHaveBeenCalledTimes(1);
    });

    /**
     * B3c: when getMemoryPressureMonitor() returns undefined, the gate
     * allows extraction to proceed — the optional-chain returns undefined
     * (falsy), so isUnderMemoryPressure returns false.
     */
    it('does not skip extract when monitor is absent', async () => {
      vi.mocked(runAutoMemoryExtract).mockClear();
      vi.mocked(runAutoMemoryExtract).mockResolvedValueOnce({
        touchedTopics: ['user'],
        cursor: {
          sessionId: 'sess',
          processedOffset: 1,
          updatedAt: new Date().toISOString(),
        },
      });

      const config = makeMockConfig({
        getMemoryPressureMonitor: vi.fn().mockReturnValue(undefined),
      } as Partial<Config>);

      const mgr = new MemoryManager();
      const result = await mgr.scheduleExtract({
        projectRoot: '/project',
        sessionId: 'sess',
        config,
        history: [{ role: 'user', parts: [{ text: 'hi' }] }],
      });

      expect(result.skippedReason).toBeUndefined();
      expect(runAutoMemoryExtract).toHaveBeenCalledTimes(1);
    });

    /**
     * B3b: 'hard' pressure level also gates extract (not just 'critical').
     * In production 'hard' is the first level to fire as memory climbs, so
     * it needs the same coverage as 'critical'.
     */
    it('skips extract when monitor reports hard pressure', async () => {
      vi.mocked(runAutoMemoryExtract).mockClear();

      const config = makeMockConfig({
        getMemoryPressureMonitor: vi.fn().mockReturnValue({
          getPressureLevel: vi.fn().mockReturnValue('hard'),
        }),
      } as Partial<Config>);

      const mgr = new MemoryManager();
      const result = await mgr.scheduleExtract({
        projectRoot: '/project',
        sessionId: 'sess',
        config,
        history: [{ role: 'user', parts: [{ text: 'hi' }] }],
      });

      expect(result.skippedReason).toBe('memory_pressure');
      expect(result.cursor.processedOffset).toBeUndefined();
      expect(runAutoMemoryExtract).not.toHaveBeenCalled();
    });

    /**
     * B4: a queued (trailing) extract is also gated. Because the gate lives
     * in runExtract — the choke point both the direct and queued paths funnel
     * through — a trailing extract started after pressure spikes is skipped
     * rather than bypassing the gate via startQueuedExtract.
     */
    it('gates queued trailing extracts under memory pressure', async () => {
      vi.mocked(runAutoMemoryExtract).mockClear();

      let pressure: 'normal' | 'critical' = 'normal';
      const config = makeMockConfig({
        getMemoryPressureMonitor: vi.fn().mockReturnValue({
          getPressureLevel: vi.fn(() => pressure),
        }),
      } as Partial<Config>);

      let resolveFirst: (
        value: Awaited<ReturnType<typeof runAutoMemoryExtract>>,
      ) => void;
      const firstPromise = new Promise<
        Awaited<ReturnType<typeof runAutoMemoryExtract>>
      >((r) => {
        resolveFirst = r;
      });
      vi.mocked(runAutoMemoryExtract).mockReturnValueOnce(firstPromise);

      const mgr = new MemoryManager();

      // First extract starts running (pressure normal).
      void mgr.scheduleExtract({
        projectRoot: '/project',
        sessionId: 'sess',
        config,
        history: [{ role: 'user', parts: [{ text: 'first' }] }],
      });
      expect(runAutoMemoryExtract).toHaveBeenCalledTimes(1);

      // Queue a trailing extract while the first is still running.
      const queuedResult = await mgr.scheduleExtract({
        projectRoot: '/project',
        sessionId: 'sess',
        config,
        history: [{ role: 'user', parts: [{ text: 'trailing' }] }],
      });
      expect(queuedResult.skippedReason).toBe('queued');

      // Pressure spikes, then the first extract finishes → trailing dequeues.
      pressure = 'critical';
      resolveFirst!({
        touchedTopics: [],
        cursor: {
          sessionId: 'sess',
          processedOffset: 1,
          updatedAt: new Date().toISOString(),
        },
      });

      // The trailing extract must NOT call the real runAutoMemoryExtract a
      // second time — the gate in runExtract skips it under pressure.
      await mgr.drain({ timeoutMs: 500 });
      expect(runAutoMemoryExtract).toHaveBeenCalledTimes(1);
    });

    /**
     * B4b: skill review pressure gate lives in runSkillReview (mirroring
     * the extract pattern), producing a skipped task record.
     */
    it('skips skill review when monitor reports hard pressure', async () => {
      vi.mocked(runSkillReviewByAgent).mockClear();
      const config = makeMockConfig({
        getMemoryPressureMonitor: vi.fn().mockReturnValue({
          getPressureLevel: vi.fn().mockReturnValue('hard'),
        }),
      } as Partial<Config>);

      const mgr = new MemoryManager();
      const result = mgr.scheduleSkillReview({
        projectRoot: '/project',
        sessionId: 'sess',
        history: [{ role: 'user', parts: [{ text: 'hi' }] }],
        toolCallCount: 25,
        threshold: 2,
        skillsModified: false,
        config,
      });

      expect(result.status).toBe('scheduled');
      const record = await result.promise!;
      expect(record.status).toBe('skipped');
      expect(record.metadata?.['skippedReason']).toBe('memory_pressure');
      expect(runSkillReviewByAgent).not.toHaveBeenCalled();
    });

    /**
     * B4c: after the gate fires, the finally block must clean up the
     * skillReviewInFlightByProject Map entry. A second call to
     * scheduleSkillReview must NOT return already_running.
     */
    it('cleans up Map entry after pressure gate fires', async () => {
      const config = makeMockConfig({
        getMemoryPressureMonitor: vi.fn().mockReturnValue({
          getPressureLevel: vi.fn().mockReturnValue('hard'),
        }),
      } as Partial<Config>);

      const mgr = new MemoryManager();

      // First call: gate fires, skipped record pushed to promise.
      const first = mgr.scheduleSkillReview({
        projectRoot: '/project',
        sessionId: 'sess',
        history: [{ role: 'user', parts: [{ text: 'hi' }] }],
        toolCallCount: 25,
        threshold: 2,
        skillsModified: false,
        config,
      });
      expect(first.status).toBe('scheduled');
      await first.promise!;

      vi.mocked(runSkillReviewByAgent).mockClear();

      // Second call: must not return already_running — the Map entry was
      // cleaned up by the finally block.
      const second = mgr.scheduleSkillReview({
        projectRoot: '/project',
        sessionId: 'sess',
        history: [{ role: 'user', parts: [{ text: 'hi' }] }],
        toolCallCount: 25,
        threshold: 2,
        skillsModified: false,
        config,
      });

      expect(second.status).toBe('scheduled');
      expect(second.skippedReason).toBeUndefined();
    });

    /**
     * B5: scheduleDream also gates on memory pressure. The dream path does
     * its own structuredClone of full history, so hard/critical pressure
     * should skip it alongside extract.
     */
    it('skips dream with memory_pressure when monitor reports critical', async () => {
      const config = makeMockConfig({
        getMemoryPressureMonitor: vi.fn().mockReturnValue({
          getPressureLevel: vi.fn().mockReturnValue('critical'),
        }),
        getManagedAutoDreamEnabled: vi.fn().mockReturnValue(true),
      } as Partial<Config>);

      const mgr = new MemoryManager();
      const result = await mgr.scheduleDream({
        projectRoot: '/project',
        sessionId: 'sess',
        config,
      });

      expect(result.status).toBe('skipped');
      expect(result.skippedReason).toBe('memory_pressure');
    });
  });

  describe('buildAutoMemoryPrompt', () => {
    it('forwards options to buildManagedAutoMemoryPrompt', () => {
      const mgr = new MemoryManager();

      // Without forceFullProtocol (all indexes empty → condensed path)
      const condensed = mgr.buildAutoMemoryPrompt(
        '/project/.qwen/memory',
        null,
      );

      // With forceFullProtocol → full verbose path
      const full = mgr.buildAutoMemoryPrompt(
        '/project/.qwen/memory',
        null,
        undefined,
        undefined,
        { forceFullProtocol: true },
      );

      // Condensed path uses short section headers
      expect(condensed).toContain('## Memory types');
      expect(condensed).not.toContain('## Types of memory');

      // Full path uses verbose section headers
      expect(full).toContain('## Types of memory');
      expect(full).toContain('## What NOT to save in memory');
    });
  });
});
