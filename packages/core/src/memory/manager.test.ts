/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtractResult, ScheduleSkillReviewParams } from './manager.js';
import { globalMemoryManager, MemoryManager } from './manager.js';
import { ensureAutoMemoryScaffold } from './store.js';
import {
  getAutoMemoryMetadataPath,
  getAutoMemoryConsolidationLockPath,
  clearAutoMemoryRootCache,
} from './paths.js';
import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import { ToolNames } from '../tools/tool-names.js';

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

vi.mock('./skillReviewAgentPlanner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./skillReviewAgentPlanner.js')>()),
  runSkillReviewByAgent: vi.fn(),
}));

import { runAutoMemoryExtract } from './extract.js';
import { runManagedAutoMemoryDream } from './dream.js';
import { runSkillReviewByAgent } from './skillReviewAgentPlanner.js';
import {
  content,
  fnCall,
  modelText,
  userText,
} from '../test-utils/model-fixtures.js';

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

// A config whose memory-pressure monitor reports `level` (or a live getter).
const pressureConfig = (
  level: string | (() => string),
  extra: Partial<Config> = {},
) =>
  makeMockConfig({
    getMemoryPressureMonitor: vi.fn().mockReturnValue({
      getPressureLevel:
        typeof level === 'function'
          ? vi.fn(level)
          : vi.fn().mockReturnValue(level),
    }),
    ...extra,
  } as Partial<Config>);

// A promise plus its resolver, for holding a mocked task in flight.
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const extractResult = (
  sessionId: string,
  touchedTopics: ExtractResult['touchedTopics'] = [],
  processedOffset?: number,
): ExtractResult => ({
  touchedTopics,
  cursor: {
    sessionId,
    ...(processedOffset === undefined ? {} : { processedOffset }),
    updatedAt: new Date().toISOString(),
  },
});

// scheduleExtract params; a string history is one user turn.
const extractParams = (
  projectRoot: string,
  sessionId: string,
  history: string | Content[] = 'hi',
  config?: Config,
) => ({
  projectRoot,
  sessionId,
  history: typeof history === 'string' ? [userText(history)] : history,
  ...(config ? { config } : {}),
});

const reviewParams = (
  projectRoot: string,
  overrides: Partial<ScheduleSkillReviewParams> = {},
): ScheduleSkillReviewParams => ({
  projectRoot,
  sessionId: 'sess',
  history: [userText('hi')],
  toolCallCount: 25,
  threshold: 2,
  skillsModified: false,
  config: makeMockConfig(),
  ...overrides,
});

const fiveSessions = async () =>
  Array.from({ length: 5 }, (_, i) => `sess-${i}`);
const emptyDream = () => ({
  touchedTopics: [],
  dedupedEntries: 0,
  systemMessage: undefined,
});

// Schedules a skill review, asserts it was scheduled, returns the final record.
function reviewToRecord(mgr: MemoryManager, params: ScheduleSkillReviewParams) {
  const result = mgr.scheduleSkillReview(params);
  expect(result.status).toBe('scheduled');
  return result.promise!;
}

const readMeta = async (projectRoot: string) =>
  JSON.parse(
    await fs.readFile(getAutoMemoryMetadataPath(projectRoot), 'utf-8'),
  ) as Record<string, unknown> & {
    lastDreamAt?: string;
    lastDreamSessionId?: string;
  };

const FOO_SKILL = '---\ndescription: Foo skill\n---\n# Foo\n';

// The agent CREATES the skills at run time (they did not exist before the
// review): staging only quarantines newly-created skills, so the mock must
// write the files when invoked rather than the test pre-creating them.
const agentCreatesSkills = (contents: string, files: string[]) =>
  vi.mocked(runSkillReviewByAgent).mockImplementation(async () => {
    for (const f of files) {
      await fs.mkdir(path.dirname(f), { recursive: true });
      await fs.writeFile(f, contents);
    }
    return { touchedSkillFiles: files };
  });

// Per-case temp project (mocks reset first). With `memory`, managed memory is
// forced local and scaffolded (at `scaffoldAt`, else now) for the case.
function useTempProject(prefix: string, memory?: { scaffoldAt?: string }) {
  const tmp = { tempDir: '', projectRoot: '', skillFilePath: '' };
  beforeEach(async () => {
    vi.resetAllMocks();
    if (memory) {
      process.env['QWEN_CODE_MEMORY_LOCAL'] = '1';
      clearAutoMemoryRootCache();
    }
    tmp.tempDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    tmp.projectRoot = path.join(tmp.tempDir, 'project');
    await fs.mkdir(tmp.projectRoot, { recursive: true });
    tmp.skillFilePath = path.join(
      tmp.projectRoot,
      '.qwen/skills/auto-skill-foo/SKILL.md',
    );
    if (memory) {
      await ensureAutoMemoryScaffold(
        tmp.projectRoot,
        memory.scaffoldAt === undefined
          ? undefined
          : new Date(memory.scaffoldAt),
      );
    }
  });
  afterEach(async () => {
    if (memory) {
      delete process.env['QWEN_CODE_MEMORY_LOCAL'];
      clearAutoMemoryRootCache();
    }
    await fs.rm(tmp.tempDir, { recursive: true, force: true });
  });
  return tmp;
}

describe('MemoryManager', () => {
  describe('globalMemoryManager', () => {
    it('is a MemoryManager instance', () => {
      expect(globalMemoryManager).toBeInstanceOf(MemoryManager);
    });
  });

  describe('drain()', () => {
    it('resolves true immediately when there are no in-flight tasks', async () => {
      const mgr = new MemoryManager();
      expect(await mgr.drain()).toBe(true);
    });

    it('resolves false when drain times out while a task is in-flight', async () => {
      const mgr = new MemoryManager();
      const extract = deferred<ExtractResult>();
      vi.mocked(runAutoMemoryExtract).mockReturnValue(extract.promise);

      void mgr.scheduleExtract(extractParams('/project', 'sess'));

      expect(await mgr.drain({ timeoutMs: 20 })).toBe(false);

      extract.resolve(extractResult('sess'));
      expect(await mgr.drain()).toBe(true);
    });
  });

  describe('scheduleExtract()', () => {
    const tmp = useTempProject('mgr-extract-', {});

    it('does not emit an unhandled rejection when the caller handles a failed extraction', async () => {
      const failure = new Error('extract failed');
      const unhandled = vi.fn();
      vi.mocked(runAutoMemoryExtract).mockRejectedValueOnce(failure);
      process.on('unhandledRejection', unhandled);

      try {
        const mgr = new MemoryManager();
        await expect(
          mgr.scheduleExtract(extractParams(tmp.projectRoot, 'sess')),
        ).rejects.toBe(failure);
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(unhandled).not.toHaveBeenCalled();
        // The rejection handler must still untrack the task. Hollowing it out
        // to `() => {}` keeps the assertion above green while the settled
        // promise and its task id leak for the process lifetime — `inFlight`
        // has no other delete site and no `clear()`.
        expect(
          (mgr as unknown as { inFlight: Map<string, unknown> }).inFlight.size,
        ).toBe(0);
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    });

    it('runs extract and records a completed task', async () => {
      vi.mocked(runAutoMemoryExtract).mockResolvedValue(
        extractResult('sess-1', ['user']),
      );

      const mgr = new MemoryManager();
      const result = await mgr.scheduleExtract(
        extractParams(tmp.projectRoot, 'sess-1'),
      );

      expect(result.touchedTopics).toEqual(['user']);
      await mgr.drain();
      const tasks = mgr.listTasksByType('extract', tmp.projectRoot);
      expect(tasks.some((t) => t.status === 'completed')).toBe(true);
    });

    it('records a session mismatch as skipped', async () => {
      vi.mocked(runAutoMemoryExtract).mockResolvedValue({
        ...extractResult('sess-1'),
        skippedReason: 'session_mismatch',
      });
      const config = makeMockConfig();

      const mgr = new MemoryManager();
      const result = await mgr.scheduleExtract(
        extractParams(tmp.projectRoot, 'sess-1', 'hi', config),
      );

      expect(result.skippedReason).toBe('session_mismatch');
      expect(mgr.listTasksByType('extract', tmp.projectRoot)[0]).toMatchObject({
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
      ['private', '.qwen/memory/user/test.md', false, false],
      ['team', '.qwen/team-memory/test.md', false, false],
      ['bridged private', '.qwen/memory/user/test.md', true, false],
      ['bridged team', '.qwen/team-memory/test.md', true, false],
      [
        'bridged private with JSON arguments',
        '.qwen/memory/user/test.md',
        true,
        true,
      ],
    ])(
      'skips extraction when history writes to a %s memory file',
      async (_label, filePath, bridged, stringified) => {
        const args = { file_path: path.join(tmp.projectRoot, filePath) };
        const call = bridged
          ? fnCall(ToolNames.TOOL_CALL, {
              name: 'write_file',
              arguments: stringified ? JSON.stringify(args) : args,
            })
          : fnCall('write_file', args);
        const mgr = new MemoryManager();
        const result = await mgr.scheduleExtract(
          extractParams(tmp.projectRoot, 'sess-1', [content('model', call)]),
        );

        expect(result.skippedReason).toBe('memory_tool');
        expect(vi.mocked(runAutoMemoryExtract)).not.toHaveBeenCalled();
      },
    );

    it('does not treat an unrelated bridged call as a memory write', async () => {
      vi.mocked(runAutoMemoryExtract).mockResolvedValue(
        extractResult('sess-1'),
      );
      const mgr = new MemoryManager();

      const file_path = path.join(tmp.projectRoot, '.qwen/memory/user/test.md');
      const call = fnCall(ToolNames.TOOL_CALL, {
        name: 'web_fetch',
        arguments: { file_path },
      });
      const result = await mgr.scheduleExtract(
        extractParams(tmp.projectRoot, 'sess-1', [content('model', call)]),
      );

      expect(result.skippedReason).toBeUndefined();
      expect(runAutoMemoryExtract).toHaveBeenCalledOnce();
    });

    it('queues a trailing extract when one is already running', async () => {
      const first = deferred<ExtractResult>();
      vi.mocked(runAutoMemoryExtract)
        .mockReturnValueOnce(first.promise)
        .mockResolvedValueOnce(extractResult('sess-1', ['reference']));

      const mgr = new MemoryManager();
      const firstPromise = mgr.scheduleExtract(
        extractParams(tmp.projectRoot, 'sess-1', 'first'),
      );

      // Second call while first is in-flight — should be queued
      const queued = await mgr.scheduleExtract(
        extractParams(tmp.projectRoot, 'sess-1', 'second'),
      );
      expect(queued.skippedReason).toBe('queued');

      // Resolve first so queued one can start
      first.resolve(extractResult('sess-1', ['user']));
      await firstPromise;
      await mgr.drain({ timeoutMs: 1_000 });

      // Both extractions should have run
      expect(vi.mocked(runAutoMemoryExtract)).toHaveBeenCalledTimes(2);
    });

    it('isolates state between manager instances', async () => {
      vi.mocked(runAutoMemoryExtract).mockResolvedValue(
        extractResult('sess-1', ['user']),
      );

      const mgrA = new MemoryManager();
      const mgrB = new MemoryManager();

      await mgrA.scheduleExtract(extractParams(tmp.projectRoot, 'sess-a'));
      await mgrA.drain();

      expect(mgrA.listTasksByType('extract', tmp.projectRoot)).toHaveLength(1);
      expect(mgrB.listTasksByType('extract', tmp.projectRoot)).toHaveLength(0);
    });
  });

  describe('scheduleSkillReview()', () => {
    beforeEach(() => {
      vi.resetAllMocks();
      vi.mocked(runSkillReviewByAgent).mockResolvedValue({
        touchedSkillFiles: ['/project/.qwen/skills/test/SKILL.md'],
      });
    });

    it('skips below threshold', () => {
      const mgr = new MemoryManager();
      const result = mgr.scheduleSkillReview(
        reviewParams('/project', { history: [], toolCallCount: 1 }),
      );

      expect(result).toEqual({
        status: 'skipped',
        skippedReason: 'below_threshold',
      });
      expect(runSkillReviewByAgent).not.toHaveBeenCalled();
    });

    it('skips when skills were modified in session', () => {
      const mgr = new MemoryManager();
      const result = mgr.scheduleSkillReview(
        reviewParams('/project', { toolCallCount: 20, skillsModified: true }),
      );

      expect(result).toEqual({
        status: 'skipped',
        skippedReason: 'skills_modified_in_session',
      });
      expect(runSkillReviewByAgent).not.toHaveBeenCalled();
    });

    it('skips second call while first is still in-flight (already_running)', async () => {
      const review = deferred<{ touchedSkillFiles: string[] }>();
      vi.mocked(runSkillReviewByAgent).mockReturnValueOnce(review.promise);

      const mgr = new MemoryManager();
      const baseParams = reviewParams('/project');

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
      review.resolve({ touchedSkillFiles: [] });
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
      const result = mgr.scheduleSkillReview(
        reviewParams('/project', {
          toolCallCount: 2,
          maxTurns: 3,
          timeoutMs: 30_000,
        }),
      );

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

  describe('scheduleSkillReview() confirmBeforePersist', () => {
    const tmp = useTempProject('mgr-skill-confirm-');
    beforeEach(() => {
      agentCreatesSkills(FOO_SKILL, [tmp.skillFilePath]);
    });

    it('stages the skill and records pendingSkills when confirmBeforePersist is true', async () => {
      const record = await reviewToRecord(
        new MemoryManager(),
        reviewParams(tmp.projectRoot, { confirmBeforePersist: true }),
      );

      expect(record.status).toBe('completed');
      const pendingSkills = record.metadata?.['pendingSkills'] as
        | unknown[]
        | undefined;
      expect(pendingSkills).toBeDefined();
      expect(pendingSkills).toHaveLength(1);

      // The skill must no longer be under .qwen/skills/
      await expect(fs.access(tmp.skillFilePath)).rejects.toThrow();
    });

    it('stages a new skill whose name exists only in the archive', async () => {
      const archivedManifest = path.join(
        tmp.projectRoot,
        '.qwen/archived-skills/auto-skill-foo/SKILL.md',
      );
      await fs.mkdir(path.dirname(archivedManifest), { recursive: true });
      await fs.writeFile(archivedManifest, 'archived');
      const mgr = new MemoryManager();
      const record = await mgr.scheduleSkillReview(
        reviewParams(tmp.projectRoot, { confirmBeforePersist: true }),
      ).promise!;

      const pendingSkills = record.metadata?.['pendingSkills'] as Array<{
        stagedManifestPath: string;
      }>;
      expect(pendingSkills).toHaveLength(1);
      await expect(fs.access(tmp.skillFilePath)).rejects.toThrow();
      await expect(
        fs.access(pendingSkills[0]!.stagedManifestPath),
      ).resolves.toBeUndefined();
      await expect(fs.access(archivedManifest)).resolves.toBeUndefined();
    });

    it('leaves the skill in place and sets no pendingSkills when confirmBeforePersist is false', async () => {
      const record = await reviewToRecord(
        new MemoryManager(),
        reviewParams(tmp.projectRoot, { confirmBeforePersist: false }),
      );

      expect(record.status).toBe('completed');
      expect(record.metadata?.['pendingSkills']).toBeUndefined();

      // The skill must still be under .qwen/skills/
      await expect(fs.access(tmp.skillFilePath)).resolves.toBeUndefined();
    });

    it('falls back to systemMessage as progress text when staging yields zero pending', async () => {
      // The skill exists BEFORE the review, so the agent edits it in place and
      // staging skips it (only new skills are staged) — zero pending, but the
      // edit is still a durable change, so the agent's systemMessage should win
      // over the "without durable changes" default.
      const skillFilePath = tmp.skillFilePath;
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
      const record = await mgr.scheduleSkillReview(
        reviewParams(tmp.projectRoot, { confirmBeforePersist: true }),
      ).promise!;
      expect(record.metadata?.['pendingSkills']).toBeUndefined();
      expect(record.progressText).toBe('Skill review updated 1 file(s).');
    });
  });

  describe('listTasksByType()', () => {
    it('returns empty array when no tasks of that type exist', () => {
      const mgr = new MemoryManager();
      expect(mgr.listTasksByType('extract')).toEqual([]);
      expect(mgr.listTasksByType('dream')).toEqual([]);
      expect(mgr.listTasksByType('skill-review')).toEqual([]);
    });

    it('filters by projectRoot when provided', async () => {
      vi.mocked(runAutoMemoryExtract).mockResolvedValue(extractResult('sess'));

      const mgr = new MemoryManager();

      // Two extractions for different project roots
      await Promise.all([
        mgr.scheduleExtract(extractParams('/project-a', 'sess')),
        mgr.scheduleExtract(extractParams('/project-b', 'sess')),
      ]);
      await mgr.drain();

      expect(mgr.listTasksByType('extract', '/project-a')).toHaveLength(1);
      expect(mgr.listTasksByType('extract', '/project-b')).toHaveLength(1);
      expect(mgr.listTasksByType('extract')).toHaveLength(2);
    });
  });

  describe('subscribe() taskType filter', () => {
    // The filter lets high-frequency consumers (the bg-tasks UI hook, which
    // renders only dream entries) skip the per-extract notify. Pin the routing
    // both ways: filtered subscribers must NOT fire on unrelated transitions,
    // and unfiltered ones must keep firing on everything.
    it('routes notifies to type-filtered subscribers only when taskType matches', async () => {
      vi.mocked(runAutoMemoryExtract).mockResolvedValue(extractResult('sess'));
      const mgr = new MemoryManager();
      const dreamFilteredFires = vi.fn();
      const extractFilteredFires = vi.fn();
      const unfilteredFires = vi.fn();
      mgr.subscribe(dreamFilteredFires, { taskType: 'dream' });
      mgr.subscribe(extractFilteredFires, { taskType: 'extract' });
      mgr.subscribe(unfilteredFires);

      await mgr.scheduleExtract(extractParams('/p', 'sess'));
      await mgr.drain();

      // Extract scheduling fires storeWith (1) + completion update (1) = 2 notifies.
      // Dream-filtered subscriber must NOT see them.
      expect(dreamFilteredFires).not.toHaveBeenCalled();
      // Both extract-filtered and unfiltered subscribers must see them.
      expect(extractFilteredFires.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(unfilteredFires.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    it('returns an unsubscribe function that drops the filtered listener even when later notifies fire', async () => {
      // Fires a notify after unsubscribing: an earlier version only asserted
      // "not called yet" without firing one, so a still-attached listener
      // would have passed.
      vi.mocked(runAutoMemoryExtract).mockResolvedValue(extractResult('sess'));
      const mgr = new MemoryManager();
      const fires = vi.fn();
      const unsubscribe = mgr.subscribe(fires, { taskType: 'extract' });

      // First extract should fire the listener (storeWith + completion update).
      await mgr.scheduleExtract(extractParams('/p', 'sess'));
      await mgr.drain();
      const firesBeforeUnsubscribe = fires.mock.calls.length;
      expect(firesBeforeUnsubscribe).toBeGreaterThanOrEqual(1);

      // After unsubscribe, a second extract must not increment the count.
      unsubscribe();
      await mgr.scheduleExtract(extractParams('/p', 'sess-2', 'hi again'));
      await mgr.drain();
      expect(fires.mock.calls.length).toBe(firesBeforeUnsubscribe);
    });
  });

  describe('skill-review subscriptions and pending APIs', () => {
    const tmp = useTempProject('mgr-skill-pending-');

    /** Produce a completed skill-review task with one pending skill. */
    async function scheduleAndAwait(mgr: MemoryManager) {
      agentCreatesSkills(FOO_SKILL, [tmp.skillFilePath]);
      const params = { confirmBeforePersist: true };
      return reviewToRecord(mgr, reviewParams(tmp.projectRoot, params));
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
      const taskId = (await scheduleAndAwait(mgr)).id;
      await mgr.acceptPendingSkillFromTask(taskId, 'auto-skill-foo');

      // The skill must now exist at its final path under .qwen/skills/
      await expect(fs.access(tmp.skillFilePath)).resolves.toBeUndefined();

      // The task record must reflect 0 remaining pending skills
      const updated = mgr.getTask(taskId);
      const remaining = updated?.metadata?.['pendingSkills'] as unknown[];
      expect(remaining).toHaveLength(0);
    });

    it('rejectPendingSkillFromTask deletes the staged skill and removes it from pendingSkills', async () => {
      const mgr = new MemoryManager();
      const taskId = (await scheduleAndAwait(mgr)).id;
      await mgr.rejectPendingSkillFromTask(taskId, 'auto-skill-foo');

      // The skill must NOT exist under .qwen/skills/
      await expect(fs.access(tmp.skillFilePath)).rejects.toThrow();

      // The staged dir must also be gone
      const stagedPath = path.join(
        tmp.projectRoot,
        '.qwen/pending-skills/auto-skill-foo',
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
        path.join(tmp.projectRoot, '.qwen', 'skills', n, 'SKILL.md'),
      );
      agentCreatesSkills('---\ndescription: x\n---\n# x\n', files);
      const record = await mgr.scheduleSkillReview(
        reviewParams(tmp.projectRoot, { confirmBeforePersist: true }),
      ).promise!;
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

  describe('scheduleDream()', () => {
    const tmp = useTempProject('mgr-dream-', {
      scaffoldAt: '2026-04-01T00:00:00.000Z',
    });
    beforeEach(() => {
      vi.mocked(runManagedAutoMemoryDream).mockResolvedValue(emptyDream());
    });
    const APR1_10 = '2026-04-01T10:00:00.000Z';
    const dreamParams = (
      sessionId: string,
      now: string,
      minHoursBetweenDreams: number,
      minSessionsBetweenDreams: number,
      config = makeMockConfig(),
    ) => ({
      projectRoot: tmp.projectRoot,
      sessionId,
      config,
      now: new Date(now),
      minHoursBetweenDreams,
      minSessionsBetweenDreams,
    });

    it('skips when dream is disabled in config', async () => {
      const mgr = new MemoryManager(fiveSessions);
      const config = makeMockConfig({
        getManagedAutoDreamEnabled: vi.fn().mockReturnValue(false),
      });

      const result = await mgr.scheduleDream(
        dreamParams('sess-5', APR1_10, 0, 1, config),
      );

      expect(result).toEqual({ status: 'skipped', skippedReason: 'disabled' });
    });

    it('skips when params.config is omitted entirely', async () => {
      // Without config, runManagedAutoMemoryDream throws, surfacing a noisy
      // failed entry in the bg-tasks dialog. The early skip routes the
      // omitted-config case to the same disabled-skip path so callers can't
      // produce visible failures by leaving config out (the type allows it
      // for test ergonomics).
      const mgr = new MemoryManager();
      const result = await mgr.scheduleDream({
        projectRoot: tmp.projectRoot,
        sessionId: 'sess-no-config',
        // config intentionally omitted
        now: new Date('2026-04-02T10:00:00.000Z'),
      });
      expect(result).toEqual({ status: 'skipped', skippedReason: 'disabled' });
      // Crucially — no record was stored for this skip.
      expect(mgr.listTasksByType('dream', tmp.projectRoot)).toEqual([]);
    });

    it('skips when called again in the same session', async () => {
      const scanner = vi
        .fn()
        .mockResolvedValue(['sess-0', 'sess-1', 'sess-2', 'sess-3', 'sess-4']);
      const mgr = new MemoryManager(scanner);

      const config = makeMockConfig();
      const first = await mgr.scheduleDream(
        dreamParams('sess-x', APR1_10, 0, 1, config),
      );
      expect(first.status).toBe('scheduled');
      await first.promise;

      const second = await mgr.scheduleDream(
        dreamParams('sess-x', '2026-04-01T11:00:00.000Z', 0, 1, config),
      );
      expect(second).toEqual({
        status: 'skipped',
        skippedReason: 'same_session',
      });
    });

    it('skips when min_hours has not elapsed', async () => {
      const mgr = new MemoryManager(fiveSessions);

      // Inject lastDreamAt that is very recent
      const metaPath = getAutoMemoryMetadataPath(tmp.projectRoot);
      const metadata = await readMeta(tmp.projectRoot);
      metadata['lastDreamAt'] = '2026-04-01T09:00:00.000Z';
      await fs.writeFile(metaPath, JSON.stringify(metadata, null, 2), 'utf-8');

      const result = await mgr.scheduleDream(
        dreamParams('sess-new', APR1_10, 24, 1),
      );

      expect(result).toEqual({ status: 'skipped', skippedReason: 'min_hours' });
    });

    it('skips when session count is below threshold (via session scanner)', async () => {
      // Only 1 session — need 5
      const mgr = new MemoryManager(async () => ['sess-0']);

      const result = await mgr.scheduleDream(
        dreamParams('sess-new', APR1_10, 0, 5),
      );

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

      const result = await mgr.scheduleDream(
        dreamParams('sess-x', APR1_10, 0, 3),
      );

      expect(result.status).toBe('scheduled');
      const finalRecord = await result.promise;
      expect(finalRecord?.status).toBe('completed');
      expect(finalRecord?.metadata?.['touchedTopics']).toEqual(['user']);

      // Lock must be released
      await expect(
        fs.access(getAutoMemoryConsolidationLockPath(tmp.projectRoot)),
      ).rejects.toThrow();

      // Metadata must be updated
      const meta = await readMeta(tmp.projectRoot);
      expect(meta.lastDreamSessionId).toBe('sess-x');
      expect(meta.lastDreamAt).toBe('2026-04-01T10:00:00.000Z');
    });
  });

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
      void mgr.scheduleExtract(
        extractParams(projectRoot, 'sess-extract', 'do some work', config),
      );

      // Skill review must be scheduled independently, not silently dropped
      const result = mgr.scheduleSkillReview(
        reviewParams(projectRoot, {
          sessionId: 'sess-extract',
          history: [userText('do some work')],
          threshold: 20,
          enabled: true,
          config,
        }),
      );

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

      const result = mgr.scheduleSkillReview(
        reviewParams(projectRoot, {
          sessionId: 'sess-1',
          history: [userText('work')],
          threshold: 20,
          enabled: true,
          config,
        }),
      );

      expect(result.status).toBe('scheduled');
      expect(result.skippedReason).toBeUndefined();
      expect(result.taskId).toBeDefined();
    });
  });

  describe('cancelTask()', () => {
    const tmp = useTempProject('mgr-cancel-', {
      scaffoldAt: '2026-04-01T00:00:00.000Z',
    });

    // Schedules a dream over five prior sessions.
    async function startDream() {
      const mgr = new MemoryManager(fiveSessions);
      const config = makeMockConfig();
      const result = await mgr.scheduleDream({
        projectRoot: tmp.projectRoot,
        sessionId: 'sess-x',
        config,
        now: new Date('2026-04-02T10:00:00.000Z'),
      });
      return { mgr, result, taskId: result.taskId! };
    }

    // Mocks a dream that reports entry via `started`, records its abort
    // signal, then waits for abort and rejects, or resolves with `resolved`.
    function parkDreamUntilAbort(
      resolved?: Awaited<ReturnType<typeof runManagedAutoMemoryDream>>,
    ) {
      const started = deferred<void>();
      const seen: { signal?: AbortSignal } = {};
      vi.mocked(runManagedAutoMemoryDream).mockImplementation(
        async (_root, _now, _config, signal) => {
          seen.signal = signal;
          started.resolve();
          await new Promise<void>((resolve, reject) => {
            signal?.addEventListener('abort', () =>
              resolved ? resolve() : reject(new Error('aborted')),
            );
          });
          return resolved ?? emptyDream();
        },
      );
      return { started: started.promise, seen };
    }

    it('aborts the dream fork agent and marks the record cancelled', async () => {
      // The fork's abort signal is captured so the test can assert both the
      // status flip AND the signal propagation; only the latter guarantees
      // runForkedAgent will unwind.
      const dream = parkDreamUntilAbort();
      const { mgr, result, taskId } = await startDream();
      expect(result.status).toBe('scheduled');

      // Wait for the fork to enter: scheduleDream returns before lock
      // acquisition and the fork-agent invocation run, so cancelling earlier
      // would race the signal capture and flake with undefined.
      await dream.started;

      // Cancel must succeed and synchronously flip status; the fork's
      // unwind happens later via the abort signal.
      const cancelled = mgr.cancelTask(taskId);
      expect(cancelled).toBe(true);
      expect(mgr.getTask(taskId)?.status).toBe('cancelled');
      expect(dream.seen.signal?.aborted).toBe(true);

      // Drain so the fork-agent rejection lands and runDream's catch path
      // runs: the user-cancel guard must NOT overwrite to 'failed' (without
      // it the record becomes failed with error="aborted").
      await mgr.drain({ timeoutMs: 1000 });
      expect(mgr.getTask(taskId)?.status).toBe('cancelled');
    });

    it('keeps the record cancelled even when runManagedAutoMemoryDream resolves successfully after abort', async () => {
      // The realistic abort path: runForkedAgent maps
      // AgentTerminateMode.CANCELLED to a resolved `{status: 'cancelled'}`,
      // not a rejection. dreamAgentPlanner should rethrow it, but the manager
      // also checks signal.aborted after the await as defense in depth. The
      // mock RESOLVES on abort: without the guard, runDream's success path
      // would overwrite the cancelled record to 'completed' and bump dream
      // metadata for an aborted run.
      const dream = parkDreamUntilAbort({
        touchedTopics: ['user', 'project'],
        dedupedEntries: 0,
        systemMessage: 'Managed auto-memory dream completed.',
      });
      const { mgr, taskId } = await startDream();
      await dream.started;
      mgr.cancelTask(taskId);
      await mgr.drain({ timeoutMs: 1000 });

      expect(mgr.getTask(taskId)?.status).toBe('cancelled');
      // No metadata write: lastDreamAt must still be the scaffold's value,
      // not the cancelled run's `now` (bumping it would suppress the next
      // legitimate dream).
      const meta = await readMeta(tmp.projectRoot);
      expect(meta.lastDreamAt).not.toBe('2026-04-02T10:00:00.000Z');
      expect(meta.lastDreamSessionId).not.toBe('sess-x');
    });

    it('returns false for unknown task ids', async () => {
      const mgr = new MemoryManager();
      expect(mgr.cancelTask('does-not-exist')).toBe(false);
    });

    it('returns false for an already-completed dream', async () => {
      // Natural completion marks the record terminal first; a later cancel
      // must no-op rather than overwrite the outcome (it would erase the
      // touchedTopics metadata the user just saw via the memory_saved toast).
      vi.mocked(runManagedAutoMemoryDream).mockResolvedValue(emptyDream());
      const { mgr, taskId } = await startDream();
      // Drain so the dream completes naturally.
      await mgr.drain({ timeoutMs: 1000 });
      expect(mgr.getTask(taskId)?.status).toBe('completed');
      expect(mgr.cancelTask(taskId)).toBe(false);
      expect(mgr.getTask(taskId)?.status).toBe('completed');
    });
  });

  describe('resetExtractStateForTests()', () => {
    it('clears in-flight extract state so subsequent calls are not blocked', async () => {
      const extract = deferred<ExtractResult>();
      vi.mocked(runAutoMemoryExtract)
        .mockReturnValueOnce(extract.promise)
        .mockResolvedValueOnce(extractResult('sess'));

      const mgr = new MemoryManager();
      void mgr.scheduleExtract(extractParams('/project', 'sess'));

      mgr.resetExtractStateForTests();

      // After reset, a new schedule call should not return 'already_running'
      const result = await mgr.scheduleExtract(
        extractParams('/project', 'sess-2'),
      );
      expect(result.skippedReason).not.toBe('already_running');

      extract.resolve(extractResult('sess'));
    });
  });

  // ─── #5147 regression: trailing queue + memory pressure ─────────────────

  describe('scheduleExtract #5147', () => {
    const extractUnder = (config: Config) =>
      new MemoryManager().scheduleExtract(
        extractParams('/project', 'sess', 'hi', config),
      );

    // B1: superseding the queued trailing extract drops the old params
    // reference (its history becomes GC-eligible); only the latest params
    // are retained and the trailing extract runs with them.
    it('supersedes trailing queue without leaking old history refs', async () => {
      vi.mocked(runAutoMemoryExtract).mockClear();

      const mgr = new MemoryManager();
      const first = deferred<ExtractResult>();
      const trailing = deferred<ExtractResult>();
      const turns = (n: string) => [
        userText(`${n} history`),
        modelText(`${n} response`),
      ];
      const params = (n: string) => ({
        projectRoot: '/project',
        sessionId: 'sess',
        history: turns(n),
      });

      // First call → starts running
      vi.mocked(runAutoMemoryExtract).mockReturnValueOnce(first.promise);

      void mgr.scheduleExtract(params('first'));

      expect(runAutoMemoryExtract).toHaveBeenCalledTimes(1);

      // Second call while first is running → queues trailing
      const secondResult = await mgr.scheduleExtract(params('second'));
      expect(secondResult.skippedReason).toBe('queued');

      // Third call while first is STILL running → supersedes trailing
      vi.mocked(runAutoMemoryExtract).mockReturnValueOnce(trailing.promise);
      const thirdResult = await mgr.scheduleExtract(params('third'));
      expect(thirdResult.skippedReason).toBe('queued');
      // Still only 1 actual extract call (first is still running)
      expect(runAutoMemoryExtract).toHaveBeenCalledTimes(1);

      // Finish the first extract
      first.resolve(extractResult('sess', [], 2));
      // Wait for the trailing to be picked up and started
      await vi.waitFor(() => {
        expect(runAutoMemoryExtract).toHaveBeenCalledTimes(2);
      });

      // The trailing extract must get the third call's params, not the
      // second call's stale history reference.
      expect(runAutoMemoryExtract).toHaveBeenLastCalledWith(
        expect.objectContaining({ history: turns('third') }),
      );

      // Finish the trailing (should use third history, not second)
      trailing.resolve(extractResult('sess', ['user'], 2));

      // Drain to ensure everything settles
      await mgr.drain({ timeoutMs: 500 });
    });

    // B2: extract is skipped with 'memory_pressure' when the shared
    // MemoryPressureMonitor reports hard/critical pressure. The cursor is NOT
    // advanced (runAutoMemoryExtract never runs), so the unread messages are
    // retried on a later, lower-pressure turn.
    it('skips extract with memory_pressure when the monitor reports critical', async () => {
      vi.mocked(runAutoMemoryExtract).mockClear();

      const result = await extractUnder(pressureConfig('critical'));

      expect(result.skippedReason).toBe('memory_pressure');
      expect(result.touchedTopics).toEqual([]);
      // The cursor is deliberately NOT advanced (no processedOffset) so
      // unprocessed messages are retried on a later lower-pressure turn.
      expect(result.cursor.processedOffset).toBeUndefined();
      // Gate fired before invoking the real extract → cursor untouched.
      expect(runAutoMemoryExtract).not.toHaveBeenCalled();
    });

    // B3: normal/soft pressure lets extract proceed (only hard/critical gate).
    it('does not skip extract when pressure is normal', async () => {
      vi.mocked(runAutoMemoryExtract).mockClear();
      vi.mocked(runAutoMemoryExtract).mockResolvedValueOnce(
        extractResult('sess', ['user'], 1),
      );

      const result = await extractUnder(pressureConfig('soft'));

      expect(result.skippedReason).toBeUndefined();
      expect(runAutoMemoryExtract).toHaveBeenCalledTimes(1);
    });

    // B3c: getMemoryPressureMonitor() returning undefined lets extraction
    // proceed: the optional chain yields undefined (falsy), so
    // isUnderMemoryPressure returns false.
    it('does not skip extract when monitor is absent', async () => {
      vi.mocked(runAutoMemoryExtract).mockClear();
      vi.mocked(runAutoMemoryExtract).mockResolvedValueOnce(
        extractResult('sess', ['user'], 1),
      );

      const result = await extractUnder(
        makeMockConfig({
          getMemoryPressureMonitor: vi.fn().mockReturnValue(undefined),
        } as Partial<Config>),
      );

      expect(result.skippedReason).toBeUndefined();
      expect(runAutoMemoryExtract).toHaveBeenCalledTimes(1);
    });

    // B3b: 'hard' also gates extract, not just 'critical'. In production
    // 'hard' is the first level to fire as memory climbs, so it needs the
    // same coverage.
    it('skips extract when monitor reports hard pressure', async () => {
      vi.mocked(runAutoMemoryExtract).mockClear();

      const result = await extractUnder(pressureConfig('hard'));

      expect(result.skippedReason).toBe('memory_pressure');
      expect(result.cursor.processedOffset).toBeUndefined();
      expect(runAutoMemoryExtract).not.toHaveBeenCalled();
    });

    // B4: a queued (trailing) extract is also gated. The gate lives in
    // runExtract, the choke point both the direct and queued paths funnel
    // through, so a trailing extract started after pressure spikes is skipped
    // rather than bypassing the gate via startQueuedExtract.
    it('gates queued trailing extracts under memory pressure', async () => {
      vi.mocked(runAutoMemoryExtract).mockClear();

      let pressure: 'normal' | 'critical' = 'normal';
      const config = pressureConfig(() => pressure);

      const first = deferred<ExtractResult>();
      vi.mocked(runAutoMemoryExtract).mockReturnValueOnce(first.promise);

      const mgr = new MemoryManager();

      // First extract starts running (pressure normal).
      void mgr.scheduleExtract(
        extractParams('/project', 'sess', 'first', config),
      );
      expect(runAutoMemoryExtract).toHaveBeenCalledTimes(1);

      // Queue a trailing extract while the first is still running.
      const queuedResult = await mgr.scheduleExtract(
        extractParams('/project', 'sess', 'trailing', config),
      );
      expect(queuedResult.skippedReason).toBe('queued');

      // Pressure spikes, then the first extract finishes → trailing dequeues.
      pressure = 'critical';
      first.resolve(extractResult('sess', [], 1));

      // The trailing extract must NOT call the real runAutoMemoryExtract a
      // second time — the gate in runExtract skips it under pressure.
      await mgr.drain({ timeoutMs: 500 });
      expect(runAutoMemoryExtract).toHaveBeenCalledTimes(1);
    });

    // B4b: the skill review pressure gate lives in runSkillReview (mirroring
    // extract) and produces a skipped task record.
    it('skips skill review when monitor reports hard pressure', async () => {
      vi.mocked(runSkillReviewByAgent).mockClear();

      const record = await reviewToRecord(
        new MemoryManager(),
        reviewParams('/project', { config: pressureConfig('hard') }),
      );
      expect(record.status).toBe('skipped');
      expect(record.metadata?.['skippedReason']).toBe('memory_pressure');
      expect(runSkillReviewByAgent).not.toHaveBeenCalled();
    });

    // B4c: after the gate fires, the finally block must clean up the
    // skillReviewInFlightByProject Map entry, so a second
    // scheduleSkillReview must NOT return already_running.
    it('cleans up Map entry after pressure gate fires', async () => {
      const config = pressureConfig('hard');

      const mgr = new MemoryManager();

      // First call: gate fires, skipped record pushed to promise.
      await reviewToRecord(mgr, reviewParams('/project', { config }));

      vi.mocked(runSkillReviewByAgent).mockClear();

      // Second call: must not return already_running — the Map entry was
      // cleaned up by the finally block.
      const second = mgr.scheduleSkillReview(
        reviewParams('/project', { config }),
      );

      expect(second.status).toBe('scheduled');
      expect(second.skippedReason).toBeUndefined();
    });

    // B5: scheduleDream also gates on memory pressure. The dream path does its
    // own structuredClone of full history, so hard/critical pressure should
    // skip it alongside extract.
    it('skips dream with memory_pressure when monitor reports critical', async () => {
      const config = pressureConfig('critical', {
        getManagedAutoDreamEnabled: vi.fn().mockReturnValue(true),
      });

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
