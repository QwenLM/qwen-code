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
      // Create a real auto-skill dir under .qwen/skills/
      const skillDir = path.join(
        projectRoot,
        '.qwen',
        'skills',
        'auto-skill-foo',
      );
      await fs.mkdir(skillDir, { recursive: true });
      skillFilePath = path.join(skillDir, 'SKILL.md');
      await fs.writeFile(
        skillFilePath,
        '---\ndescription: Foo skill\n---\n# Foo\n',
      );
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('stages the skill and records pendingSkills when confirmBeforePersist is true', async () => {
      vi.mocked(runSkillReviewByAgent).mockResolvedValue({
        touchedSkillFiles: [skillFilePath],
      });

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

    it('leaves the skill in place and sets no pendingSkills when confirmBeforePersist is false', async () => {
      vi.mocked(runSkillReviewByAgent).mockResolvedValue({
        touchedSkillFiles: [skillFilePath],
      });

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
        dedupedEntries: 1,
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
            dedupedEntries: 0,
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
            dedupedEntries: 0,
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
        dedupedEntries: 0,
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
});
