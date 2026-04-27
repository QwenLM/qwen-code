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
} from './paths.js';
import type { Config } from '../config/config.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('./extract.js', () => ({
  runAutoMemoryExtract: vi.fn(),
}));

vi.mock('./dream.js', () => ({
  runManagedAutoMemoryDream: vi.fn(),
}));

vi.mock('./skillReviewAgentPlanner.js', () => ({
  runSkillReviewByAgent: vi.fn(),
}));

import { runAutoMemoryExtract } from './extract.js';
import { runManagedAutoMemoryDream } from './dream.js';
import { runSkillReviewByAgent } from './skillReviewAgentPlanner.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMockConfig(overrides: Partial<Config> = {}): Config {
  return {
    getManagedAutoMemoryEnabled: vi.fn().mockReturnValue(true),
    getManagedAutoDreamEnabled: vi.fn().mockReturnValue(true),
    getSessionId: vi.fn().mockReturnValue('session-1'),
    getModel: vi.fn().mockReturnValue('test-model'),
    logEvent: vi.fn(),
    ...overrides,
  } as unknown as Config;
}

// ─── MemoryManager ────────────────────────────────────────────────────────────

describe('MemoryManager', () => {
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

    it('skips extraction when history writes to a memory file', async () => {
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
                    file_path: `${projectRoot}/.qwen/memory/user/test.md`,
                  },
                },
              },
            ],
          },
        ],
      });

      expect(result.skippedReason).toBe('memory_tool');
      expect(vi.mocked(runAutoMemoryExtract)).not.toHaveBeenCalled();
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
        config: makeMockConfig(),
      });

      expect(result).toEqual({
        status: 'skipped',
        skippedReason: 'below_threshold',
      });
      expect(runSkillReviewByAgent).not.toHaveBeenCalled();
    });

    it('skips when skill_manage was called in history', () => {
      const mgr = new MemoryManager();
      const result = mgr.scheduleSkillReview({
        projectRoot: '/project',
        sessionId: 'sess',
        history: [
          {
            role: 'model',
            parts: [{ functionCall: { name: 'skill_manage', args: {} } }],
          },
        ],
        toolCallCount: 20,
        threshold: 2,
        config: makeMockConfig(),
      });

      expect(result).toEqual({
        status: 'skipped',
        skippedReason: 'skill_manage_called',
      });
      expect(runSkillReviewByAgent).not.toHaveBeenCalled();
    });

    it('schedules skill review at threshold', async () => {
      const mgr = new MemoryManager();
      const result = mgr.scheduleSkillReview({
        projectRoot: '/project',
        sessionId: 'sess',
        history: [{ role: 'user', parts: [{ text: 'hi' }] }],
        toolCallCount: 2,
        threshold: 2,
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
        dedupedEntries: 0,
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

    it('skips when called again in the same session', async () => {
      const scanner = vi
        .fn()
        .mockResolvedValue(['sess-0', 'sess-1', 'sess-2', 'sess-3', 'sess-4']);
      const mgr = new MemoryManager(scanner);

      const first = await mgr.scheduleDream({
        projectRoot,
        sessionId: 'sess-x',
        now: new Date('2026-04-01T10:00:00.000Z'),
        minHoursBetweenDreams: 0,
        minSessionsBetweenDreams: 1,
      });
      expect(first.status).toBe('scheduled');
      await first.promise;

      const second = await mgr.scheduleDream({
        projectRoot,
        sessionId: 'sess-x',
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
        dedupedEntries: 1,
        systemMessage: 'Dream complete.',
      });

      const mgr = new MemoryManager(async () => ['s0', 's1', 's2', 's3', 's4']);

      const result = await mgr.scheduleDream({
        projectRoot,
        sessionId: 'sess-x',
        now: new Date('2026-04-01T10:00:00.000Z'),
        minHoursBetweenDreams: 0,
        minSessionsBetweenDreams: 3,
      });

      expect(result.status).toBe('scheduled');
      const finalRecord = await result.promise;
      expect(finalRecord?.status).toBe('completed');
      expect(finalRecord?.metadata?.['touchedTopics']).toEqual(['user']);

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

  // ─── scheduleSkillReview: merge with running extract ──────────────────────

  describe('scheduleSkillReview(): merged_with_extract (checklist 6)', () => {
    it('returns merged_with_extract when extract is already running for same project', async () => {
      // arrange: extract never resolves so it stays "running"
      vi.mocked(runAutoMemoryExtract).mockReturnValue(new Promise(() => {}));

      const mgr = new MemoryManager();
      const projectRoot = '/test-project-merge';
      const config = makeMockConfig();

      // Start extract (will stay in-flight)
      void mgr.scheduleExtract({
        projectRoot,
        sessionId: 'sess-extract',
        history: [{ role: 'user', parts: [{ text: 'do some work' }] }],
        config,
      });

      // Now schedule skill review while extract is running
      const result = mgr.scheduleSkillReview({
        projectRoot,
        sessionId: 'sess-extract',
        history: [{ role: 'user', parts: [{ text: 'do some work' }] }],
        toolCallCount: 25,
        threshold: 20,
        enabled: true,
        config,
      });

      expect(result.status).toBe('skipped');
      expect(result.skippedReason).toBe('merged_with_extract');
      expect(result.taskId).toBeDefined();
    });

    it('marks the extract record with shouldReviewSkillsAlso metadata', async () => {
      vi.mocked(runAutoMemoryExtract).mockReturnValue(new Promise(() => {}));

      const mgr = new MemoryManager();
      const projectRoot = '/test-project-metadata';
      const config = makeMockConfig();

      void mgr.scheduleExtract({
        projectRoot,
        sessionId: 'sess-meta',
        history: [{ role: 'user', parts: [{ text: 'work' }] }],
        config,
      });

      mgr.scheduleSkillReview({
        projectRoot,
        sessionId: 'sess-meta',
        history: [{ role: 'user', parts: [{ text: 'work' }] }],
        toolCallCount: 30,
        threshold: 20,
        enabled: true,
        config,
      });

      // The extract task record should now carry the merge flag
      const extractRecords = mgr.listTasksByType('extract', projectRoot);
      expect(extractRecords.length).toBeGreaterThan(0);
      const extractRecord = extractRecords[0]!;
      expect(extractRecord.metadata?.['shouldReviewSkillsAlso']).toBe(true);
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
        config,
      });

      expect(result.status).toBe('scheduled');
      expect(result.skippedReason).toBeUndefined();
      expect(result.taskId).toBeDefined();
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
});
