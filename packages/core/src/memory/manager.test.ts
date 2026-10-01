/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ExtractResult,
  ScheduleSkillReviewParams,
  MemoryTaskRecord,
} from './manager.js';
import { globalMemoryManager, MemoryManager } from './manager.js';
import { ensureAutoMemoryScaffold } from './store.js';
import {
  getAutoMemoryMetadataPath,
  getAutoMemoryConsolidationLockPath,
  clearAutoMemoryRootCache,
  getAutoMemoryRoot,
  getTeamAutoMemoryRoot,
  getUserAutoMemoryRoot,
  getUserAutoMemoryMetadataPath,
} from './paths.js';
import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import * as metadataMigration from './metadata-migration.js';
import { ToolNames } from '../tools/tool-names.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const telemetryMocks = vi.hoisted(() => ({
  logMemoryExtract: vi.fn(),
  logMemoryDream: vi.fn(),
  logMemoryMigration: vi.fn(),
}));

vi.mock('../telemetry/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../telemetry/index.js')>()),
  logMemoryExtract: telemetryMocks.logMemoryExtract,
  logMemoryDream: telemetryMocks.logMemoryDream,
  logMemoryMigration: telemetryMocks.logMemoryMigration,
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
    getMemoryRecallMode: vi.fn().mockReturnValue('legacy'),
    // On by default here: these suites exercise the migration/dream machinery
    // itself. The opted-out behaviour has its own cases below.
    getStructuredMemoryRecallEnabled: vi.fn().mockReturnValue(true),
    isTrustedFolder: vi.fn().mockReturnValue(true),
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
  createdEntries: 0,
  updatedEntries: 0,
  deletedEntries: 0,
  dedupedEntries: 0,
  splitEntries: 0,
  keywordBackfilled: 0,
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

    it('reports a running migration outside the display task limit', async () => {
      const manager = new MemoryManager();
      const records: MemoryTaskRecord[] = Array.from(
        { length: 9 },
        (_, index) => ({
          id: `completed-${index}`,
          taskType: 'migration',
          projectRoot,
          status: 'completed',
          createdAt: `2026-01-01T00:00:${index.toString().padStart(2, '0')}.000Z`,
          updatedAt: `2026-01-01T00:00:${index.toString().padStart(2, '0')}.000Z`,
        }),
      );
      records.push({
        id: 'older-running',
        taskType: 'migration',
        projectRoot,
        status: 'running',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
      });
      vi.spyOn(manager, 'listTasksByType').mockImplementation((taskType) =>
        taskType === 'migration' ? records : [],
      );

      await expect(manager.getStatus(projectRoot)).resolves.toMatchObject({
        migrationRunning: true,
        migrationTasks: expect.not.arrayContaining([
          expect.objectContaining({ id: 'older-running' }),
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

    it('skips migration entirely while the structured protocol is opted out', async () => {
      // The migration exists only to make the corpus structured-ready, so an
      // opted-out corpus must not pay for a candidate scan or a forked agent.
      const scan = vi.spyOn(
        metadataMigration,
        'scanMemoryMetadataMigrationCandidates',
      );
      const run = vi.spyOn(metadataMigration, 'runMemoryMetadataMigration');
      await writeLegacy(getAutoMemoryRoot(projectRoot), 'project.md');
      const manager = new MemoryManager();
      const config = makeMockConfig({
        getStructuredMemoryRecallEnabled: vi.fn().mockReturnValue(false),
      });

      for (const scope of ['project', 'user'] as const) {
        await expect(
          manager.scheduleMetadataMigration({ projectRoot, scope, config }),
        ).resolves.toEqual({ status: 'skipped', skippedReason: 'disabled' });
      }
      expect(scan).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    });

    it('scans team migration candidates in structured mode', async () => {
      await writeLegacy(getTeamAutoMemoryRoot(projectRoot), 'team.md');
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

      const result = await new MemoryManager().scheduleMetadataMigration({
        projectRoot,
        scope: 'team',
        config: makeMockConfig({
          getMemoryRecallMode: vi.fn().mockReturnValue('structured'),
        }),
      });

      expect(result.status).toBe('scheduled');
      await result.promise;
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

    it('cancels a migration during the candidate scan and never spawns the agent', async () => {
      // The scan phase reads the whole corpus and used to run untracked:
      // cancelMigrations() had no controller to abort and drain() no promise
      // to await, so a forked migration agent could still be spawned after
      // shutdown was requested.
      await writeLegacy(getAutoMemoryRoot(projectRoot), 'project.md');
      const runMigration = vi.spyOn(
        metadataMigration,
        'runMemoryMetadataMigration',
      );
      let releaseScan: (() => void) | undefined;
      vi.spyOn(
        metadataMigration,
        'scanMemoryMetadataMigrationCandidates',
      ).mockImplementationOnce(
        () =>
          new Promise<metadataMigration.MemoryMetadataMigrationCandidate[]>(
            (resolve) => {
              releaseScan = () => resolve([]);
            },
          ),
      );
      const manager = new MemoryManager();
      const config = makeMockConfig();

      const scheduled = manager.scheduleMetadataMigration({
        projectRoot,
        scope: 'project',
        config,
      });
      await vi.waitFor(() => expect(releaseScan).toBeDefined());

      // drain() must see the scan phase, not just the forked-agent phase.
      await expect(manager.drain({ timeoutMs: 50 })).resolves.toBe(false);

      manager.cancelMigrations();
      releaseScan?.();

      await expect(scheduled).resolves.toEqual({
        status: 'skipped',
        skippedReason: 'cancelled',
      });
      expect(runMigration).not.toHaveBeenCalled();
    });

    it('emits no unhandledRejection when a cancelled scan rejects', async () => {
      // The real scan rejects with AbortError when its signal fires
      // (abortSignal.throwIfAborted); the manager's task tracking must not
      // let a derivative promise turn that expected rejection into a
      // process-level unhandledRejection on top of the handled 'cancelled'
      // result.
      await writeLegacy(getAutoMemoryRoot(projectRoot), 'project.md');
      const scan = vi
        .spyOn(metadataMigration, 'scanMemoryMetadataMigrationCandidates')
        .mockImplementation(
          (_root, _scope, abortSignal?: AbortSignal) =>
            new Promise((_resolve, reject) => {
              if (abortSignal?.aborted) {
                reject(new DOMException('aborted', 'AbortError'));
                return;
              }
              abortSignal?.addEventListener('abort', () =>
                reject(new DOMException('aborted', 'AbortError')),
              );
            }),
        );
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', onUnhandled);
      try {
        const manager = new MemoryManager();
        const scheduled = manager.scheduleMetadataMigration({
          projectRoot,
          scope: 'project',
          config: makeMockConfig(),
        });
        await vi.waitFor(() => expect(scan).toHaveBeenCalled());
        manager.cancelMigrations();

        await expect(scheduled).resolves.toEqual({
          status: 'skipped',
          skippedReason: 'cancelled',
        });
        await manager.drain({ timeoutMs: 1000 });
        // unhandledRejection fires once the microtask queue has drained.
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
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

    it.each(['legacy', 'structured'] as const)(
      'repairs a failed index after every file has migrated in %s mode',
      async (mode) => {
        const root = getAutoMemoryRoot(projectRoot);
        await writeLegacy(root, 'project.md');
        const index = path.join(root, 'MEMORY.md');
        await fs.rm(index, { force: true });
        await fs.mkdir(index);
        const runMigration = metadataMigration.runMemoryMetadataMigration;
        const generateMetadata = vi.fn(
          async (
            _config: Config,
            candidate: metadataMigration.MemoryMetadataMigrationCandidate,
          ) => ({
            relativePath: candidate.relativePath,
            sourceHash: candidate.sourceHash,
            name: 'Project memory',
            description: 'Project context',
            type: 'project',
            category: 'project_introduction',
            keywords: ['project context', 'memory migration'],
            usage_scenarios: ['Working on this project'],
          }),
        );
        vi.spyOn(
          metadataMigration,
          'runMemoryMetadataMigration',
        ).mockImplementation((params) =>
          runMigration({ ...params, generateMetadata }),
        );
        const manager = new MemoryManager();
        const params = {
          projectRoot,
          scope: 'project' as const,
          config: makeMockConfig(),
        };
        const first = await manager.scheduleMetadataMigration(params);
        await first.promise;
        expect(manager.getTask(first.taskId!)?.status).toBe('failed');
        expect(
          await metadataMigration.scanMemoryMetadataMigrationCandidates(
            root,
            'project',
          ),
        ).toEqual([]);
        await fs.rmdir(index);
        vi.spyOn(params.config, 'getMemoryRecallMode').mockReturnValue(mode);
        const retry = await manager.scheduleMetadataMigration(params);
        expect(retry.status).toBe('scheduled');
        await retry.promise;
        expect(manager.getTask(retry.taskId!)?.status).toBe('completed');
        expect(await fs.readFile(index, 'utf-8')).toContain('project.md');
        expect(generateMetadata).toHaveBeenCalledTimes(1);
        await expect(
          manager.scheduleMetadataMigration(params),
        ).resolves.toMatchObject({
          status: 'skipped',
          skippedReason: 'complete',
        });
      },
    );

    it('stops retrying migration exceptions after three failed attempts', async () => {
      await writeLegacy(getAutoMemoryRoot(projectRoot), 'project.md');
      const run = vi
        .spyOn(metadataMigration, 'runMemoryMetadataMigration')
        .mockRejectedValue(new Error('index write failed'));
      const manager = new MemoryManager();
      const params = {
        projectRoot,
        scope: 'project' as const,
        config: makeMockConfig(),
      };
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await manager.scheduleMetadataMigration(params);
        expect(result.status).toBe('scheduled');
        await result.promise;
        expect(manager.getTask(result.taskId!)?.status).toBe('failed');
      }
      await expect(
        manager.scheduleMetadataMigration(params),
      ).resolves.toMatchObject({ status: 'skipped', skippedReason: 'stalled' });
      expect(run).toHaveBeenCalledTimes(3);
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

    it('does not pause dream while the structured protocol is opted out', async () => {
      // With the protocol off the migration is never scheduled, so its
      // candidates never drain and the stall counter never advances. The
      // migration_pending gate must not fire at all in that state, or
      // consolidation would be suppressed for the life of the process.
      await writeLegacy(getAutoMemoryRoot(projectRoot), 'project.md');
      await writeLegacy(getUserAutoMemoryRoot(), 'user.md');
      const scan = vi.spyOn(
        metadataMigration,
        'scanMemoryMetadataMigrationCandidates',
      );
      const dreamResult = {
        touchedTopics: [],
        createdEntries: 0,
        updatedEntries: 0,
        deletedEntries: 0,
        dedupedEntries: 0,
        splitEntries: 0,
        keywordBackfilled: 0,
        systemMessage: undefined,
      };
      vi.mocked(runManagedAutoMemoryDream).mockResolvedValue(dreamResult);
      vi.mocked(runManagedUserAutoMemoryDream).mockResolvedValue(dreamResult);
      const manager = new MemoryManager();
      const config = makeMockConfig({
        getStructuredMemoryRecallEnabled: vi.fn().mockReturnValue(false),
      });

      const project = await manager.scheduleDream({
        projectRoot,
        sessionId: 'session',
        config,
      });
      const user = await manager.scheduleUserDream({ projectRoot, config });

      expect(project.skippedReason).not.toBe('migration_pending');
      expect(user.skippedReason).not.toBe('migration_pending');
      // Short-circuit witness: the gate must not even pay for the scan.
      expect(scan).not.toHaveBeenCalled();
      await project.promise;
      await user.promise;
    });

    it('still schedules dream when the migration candidate scan fails', async () => {
      // A trusted repo that ships .qwen/memory as a symlink makes
      // resolveTrustedMemoryRoot throw inside the scan. The gate has to fail
      // open — a root that cannot be scanned cannot be migrated either —
      // because rejecting escapes before the task record and telemetry exist,
      // and the stall counter only advances on a completed run, so the gate
      // would re-fire and re-reject on every user turn for the whole process.
      await writeLegacy(getAutoMemoryRoot(projectRoot), 'project.md');
      vi.spyOn(
        metadataMigration,
        'scanMemoryMetadataMigrationCandidates',
      ).mockRejectedValue(
        new Error('Refusing symlinked memory root or non-directory'),
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
      const manager = new MemoryManager(async () => [
        's1',
        's2',
        's3',
        's4',
        's5',
        's6',
      ]);
      const config = makeMockConfig();

      const result = await manager.scheduleDream({
        projectRoot,
        sessionId: 's6',
        config,
        minHoursBetweenDreams: 0,
        minSessionsBetweenDreams: 1,
      });

      expect(result.status).toBe('scheduled');
      if (result.status === 'scheduled') {
        await result.promise;
      }
    });

    it('stops rescheduling a migration that never makes progress', async () => {
      // A file the migration agent can never enrich must not spawn a forked
      // agent on every user turn: after a few consecutive non-progressing
      // runs the domain stops being scheduled, the terminal record is marked
      // failed (not 'completed'), and consolidation is no longer blocked by
      // the unmigratable candidate.
      await writeLegacy(getAutoMemoryRoot(projectRoot), 'project.md');
      const nonProgressing = {
        filesScanned: 1,
        legacyFiles: 1,
        remainingLegacyFiles: 1,
        attempted: 1,
        committed: 0,
        conflicts: 1,
        failed: 0,
        agentDurationMs: 1,
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      };
      const runMigration = vi
        .spyOn(metadataMigration, 'runMemoryMetadataMigration')
        .mockResolvedValue(nonProgressing);
      const manager = new MemoryManager(async () => [
        's1',
        's2',
        's3',
        's4',
        's5',
        's6',
      ]);
      const config = makeMockConfig();
      const params = { projectRoot, scope: 'project' as const, config };

      let lastTaskId: string | undefined;
      for (let i = 0; i < 3; i++) {
        const scheduled = await manager.scheduleMetadataMigration(params);
        expect(scheduled.status).toBe('scheduled');
        lastTaskId = scheduled.taskId;
        await scheduled.promise;
      }
      expect(runMigration).toHaveBeenCalledTimes(3);
      expect(manager.getTask(lastTaskId!)?.status).toBe('failed');

      await expect(manager.scheduleMetadataMigration(params)).resolves.toEqual({
        status: 'skipped',
        skippedReason: 'stalled',
      });
      expect(runMigration).toHaveBeenCalledTimes(3);

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
      const dream = await manager.scheduleDream({
        projectRoot,
        sessionId: 's6',
        config,
        minHoursBetweenDreams: 0,
        minSessionsBetweenDreams: 1,
      });
      expect(dream.status).toBe('scheduled');
      if (dream.status === 'scheduled') {
        await dream.promise;
      }
    });

    it('preserves committed counts when the index rebuild fails', async () => {
      telemetryMocks.logMemoryMigration.mockClear();
      await writeLegacy(getAutoMemoryRoot(projectRoot), 'project.md');
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
        indexRebuildError: 'Index rebuild failed',
      });
      const manager = new MemoryManager();
      const params = {
        projectRoot,
        scope: 'project' as const,
        config: makeMockConfig(),
      };
      const scheduled = await manager.scheduleMetadataMigration(params);

      expect(scheduled.status).toBe('scheduled');
      if (scheduled.status !== 'scheduled') return;
      const record = await scheduled.promise;
      expect(record).toMatchObject({
        status: 'failed',
        error: 'Index rebuild failed',
        metadata: {
          attempted: 1,
          committed: 1,
          remainingLegacyFiles: 0,
          indexRebuildError: 'Index rebuild failed',
        },
      });
      // The telemetry event must agree with the task record: a failed run
      // with the committed counts intact and the reason attached.
      expect(telemetryMocks.logMemoryMigration).toHaveBeenCalledTimes(1);
      expect(
        telemetryMocks.logMemoryMigration.mock.calls[0]?.[1],
      ).toMatchObject({
        status: 'failed',
        failure_reason: 'Index rebuild failed',
        committed: 1,
        failed: 0,
        remaining_legacy_files: 0,
      });
      for (let attempt = 1; attempt < 3; attempt++) {
        const retry = await manager.scheduleMetadataMigration(params);
        expect(retry.status).toBe('scheduled');
        await retry.promise;
      }
      await expect(manager.scheduleMetadataMigration(params)).resolves.toEqual({
        status: 'skipped',
        skippedReason: 'stalled',
      });
      expect(
        metadataMigration.runMemoryMetadataMigration,
      ).toHaveBeenCalledTimes(3);
    });

    it('tells the manual dream gate that the migration has stalled', async () => {
      // dream.ts owns the manual migration gate but cannot read the stall
      // counter, so the manager has to hand it over. Without the flag a
      // migration that gave up for this session leaves /dream and the daemon's
      // workspaceMemoryDream RPC refused for the life of the process, while
      // the skip message points the user at that same abandoned migration.
      await writeLegacy(getAutoMemoryRoot(projectRoot), 'project.md');
      const nonProgressing = {
        filesScanned: 1,
        legacyFiles: 1,
        remainingLegacyFiles: 1,
        attempted: 1,
        committed: 0,
        conflicts: 1,
        failed: 0,
        agentDurationMs: 1,
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      };
      vi.spyOn(
        metadataMigration,
        'runMemoryMetadataMigration',
      ).mockResolvedValue(nonProgressing);
      const manager = new MemoryManager(async () => [
        's1',
        's2',
        's3',
        's4',
        's5',
        's6',
      ]);
      const config = makeMockConfig();
      const params = { projectRoot, scope: 'project' as const, config };

      for (let i = 0; i < 3; i++) {
        const scheduled = await manager.scheduleMetadataMigration(params);
        expect(scheduled.status).toBe('scheduled');
        await scheduled.promise;
      }

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
      await manager.runManualDream(projectRoot, config, 's6');

      expect(runManagedAutoMemoryDream).toHaveBeenCalledWith(
        projectRoot,
        expect.any(Date),
        config,
        undefined,
        expect.objectContaining({
          trigger: 'manual',
          migrationStalled: true,
        }),
      );
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

      await expect(
        manager.scheduleUserDream({
          projectRoot,
          config,
          now: new Date('2026-08-29T00:30:00.000Z'),
        }),
      ).resolves.toEqual({
        status: 'skipped',
        skippedReason: 'failure_backoff',
      });
    });

    it('keeps User Dream completed when completion metadata cannot persist', async () => {
      const now = new Date('2026-08-27T00:00:00.000Z');
      for (let index = 0; index < 10; index += 1) {
        await recordUserAutoMemoryMutation(now);
      }
      // Distinct, non-zero counters on purpose: this is the only assertion
      // in the repo on the user-dream MemoryDreamEvent payload, and a
      // 12-field literal is exactly where a transposed field lands. With
      // five of six counters at 0 a swap between two zero-valued counters
      // survives even a full-payload assertion.
      //
      // The clock is flipped from inside the dream mock, not by
      // `mockReturnValueOnce`: a once-value is consumed by whichever code
      // calls `Date.now()` first, so any timestamp added to the scheduling
      // prologue would move `startedAt` and fail `duration_ms` from inside
      // the telemetry payload, far from this setup. Holding the pre-dream
      // value at 1_000 makes `duration_ms` a property of the flip alone.
      const dateNow = vi.spyOn(Date, 'now').mockReturnValue(1_000);
      vi.mocked(runManagedUserAutoMemoryDream).mockImplementationOnce(
        async () => {
          dateNow.mockReturnValue(1_025);
          return {
            touchedTopics: ['user', 'feedback'],
            createdEntries: 3,
            updatedEntries: 5,
            deletedEntries: 7,
            dedupedEntries: 11,
            splitEntries: 13,
            keywordBackfilled: 17,
          };
        },
      );
      vi.spyOn(userDream, 'completeUserAutoMemoryDream').mockRejectedValueOnce(
        new Error('metadata unavailable'),
      );
      const manager = new MemoryManager();
      const config = makeMockConfig({
        getMemoryRecallMode: vi.fn().mockReturnValue('structured'),
      });
      telemetryMocks.logMemoryDream.mockClear();

      const result = await manager.scheduleUserDream({
        projectRoot,
        config,
        now,
      });
      await result.promise;
      dateNow.mockRestore();

      expect(manager.getTask(result.taskId!)).toMatchObject({
        status: 'completed',
        metadata: { metadataWriteError: 'metadata unavailable' },
      });
      expect(telemetryMocks.logMemoryDream).toHaveBeenCalledWith(
        config,
        expect.objectContaining({
          trigger: 'auto',
          scope: 'user',
          status: 'updated',
          created_entries: 3,
          updated_entries: 5,
          deleted_entries: 7,
          deduped_entries: 11,
          split_entries: 13,
          keyword_backfilled: 17,
          dirty_mutations: 10,
          scheduling_reason: 'dirty_mutations',
          touched_topics: 'user,feedback',
          touched_topics_count: 2,
          duration_ms: 25,
        }),
      );
      expect(telemetryMocks.logMemoryDream).toHaveBeenCalledTimes(1);
      await expect(
        manager.scheduleUserDream({
          projectRoot,
          config,
          now: new Date('2026-08-27T00:30:00.000Z'),
        }),
      ).resolves.toEqual({
        status: 'skipped',
        skippedReason: 'failure_backoff',
      });
    });

    it('reports a User Dream that consolidated nothing as noop', async () => {
      // Pins the `noop` arm of
      // `result.touchedTopics.length > 0 ? 'updated' : 'noop'`. Without it
      // a constant `'updated'` keeps the suite green and every
      // consolidated-nothing user dream is reported to telemetry as an
      // update, inflating the consolidation-effectiveness rate.
      const now = new Date('2026-08-27T00:00:00.000Z');
      for (let index = 0; index < 10; index += 1) {
        await recordUserAutoMemoryMutation(now);
      }
      vi.mocked(runManagedUserAutoMemoryDream).mockResolvedValueOnce({
        touchedTopics: [],
        createdEntries: 0,
        updatedEntries: 0,
        deletedEntries: 0,
        dedupedEntries: 0,
        splitEntries: 0,
        keywordBackfilled: 0,
      });
      const manager = new MemoryManager();
      const config = makeMockConfig({
        getMemoryRecallMode: vi.fn().mockReturnValue('structured'),
      });
      telemetryMocks.logMemoryDream.mockClear();

      const result = await manager.scheduleUserDream({
        projectRoot,
        config,
        now,
      });
      await result.promise;

      expect(manager.getTask(result.taskId!)).toMatchObject({
        status: 'completed',
      });
      expect(telemetryMocks.logMemoryDream).toHaveBeenCalledWith(
        config,
        expect.objectContaining({
          scope: 'user',
          status: 'noop',
          touched_topics: '',
          touched_topics_count: 0,
        }),
      );
      expect(telemetryMocks.logMemoryDream).toHaveBeenCalledTimes(1);
    });

    it('keeps a cancelled User Dream cancelled when the dream resolves after abort', async () => {
      // User-dream mirror of the project-dream case in `cancelTask()`
      // below. The callee can still return normally with the signal
      // already aborted: the agent reaches its goal and the cancel lands
      // during or after the apply, so `dream-operations.ts`'s per-delete
      // check is already behind it (see `does not rebuild the user index
      // after cancellation` in user-dream.test.ts). A *cancelled* agent
      // result never gets that far — the planner throws on any
      // non-`completed` status. What keeps the
      // record from flipping to `completed` is the manager's post-await
      // abort guard plus the `abortSignal.aborted && record.status ===
      // 'cancelled'` discrimination in runUserDream's catch.
      const now = new Date('2026-08-27T00:00:00.000Z');
      for (let index = 0; index < 10; index += 1) {
        await recordUserAutoMemoryMutation(now);
      }
      let resolveDreamStarted!: () => void;
      const dreamStarted = new Promise<void>((r) => {
        resolveDreamStarted = r;
      });
      vi.mocked(runManagedUserAutoMemoryDream).mockImplementationOnce(
        async (_projectRoot, _config, signal) => {
          resolveDreamStarted();
          await new Promise<void>((resolve) => {
            signal?.addEventListener('abort', () => resolve());
          });
          return {
            touchedTopics: ['user'],
            createdEntries: 0,
            updatedEntries: 1,
            deletedEntries: 0,
            dedupedEntries: 0,
            splitEntries: 0,
            keywordBackfilled: 0,
          };
        },
      );
      const manager = new MemoryManager();
      const config = makeMockConfig({
        getMemoryRecallMode: vi.fn().mockReturnValue('structured'),
      });
      telemetryMocks.logMemoryDream.mockClear();

      const result = await manager.scheduleUserDream({
        projectRoot,
        config,
        now,
      });
      const taskId = result.taskId!;
      // Wait for the dream to actually enter so the cancel does not race
      // the abort-signal capture.
      await dreamStarted;
      expect(manager.cancelTask(taskId)).toBe(true);
      await result.promise;

      expect(manager.getTask(taskId)).toMatchObject({ status: 'cancelled' });
      expect(telemetryMocks.logMemoryDream).toHaveBeenCalledWith(
        config,
        expect.objectContaining({ scope: 'user', status: 'cancelled' }),
      );
      expect(telemetryMocks.logMemoryDream).toHaveBeenCalledTimes(1);
      // The cancelled run must not bump lastDreamAt — that would suppress
      // the next legitimate dream for DEFAULT_USER_DREAM_MIN_HOURS.
      // (lastAttemptAt *is* set for 'cancelled' too, so this case says
      // nothing about immediate rescheduling.)
      const metaRaw = await fs.readFile(
        getUserAutoMemoryMetadataPath(),
        'utf-8',
      );
      const meta = JSON.parse(metaRaw) as { lastDreamAt?: string };
      expect(meta.lastDreamAt).not.toBe('2026-08-27T00:00:00.000Z');
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
      const coverage = mgr.getBodyCoverageInHistory();
      versions.set('project:one.md', 1);
      versions.set('project:two.md', 2);
      coverage.set('project:partial.md', {
        version: 3,
        total: 10,
        ranges: [{ start: 0, end: 5 }],
      });

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
      expect(coverage.size).toBe(0);

      // Eviction must also release the turn-scoped guards that asserted the
      // evicted state, or a same-turn re-read is refused as a duplicate or
      // budget-exhausted while the body is no longer in history.
      const signature = '{"mode":"fetch","refs":["project:one.md"]}';
      versions.set('project:one.md', 1);
      versions.set('project:two.md', 2);
      mgr.getExhaustedBodyRefsForCurrentTurn().add('project:one.md');
      mgr.getExhaustedBodyRefsForCurrentTurn().add('project:two.md');
      expect(mgr.claimSearchMemoryRequestForCurrentTurn(signature)).toBe(true);
      expect(mgr.claimSearchMemoryRequestForCurrentTurn(signature)).toBe(false);

      mgr.markAllMemoryBodiesEvictedFromHistory();
      expect(mgr.getExhaustedBodyRefsForCurrentTurn()).toEqual(new Set());
      expect(mgr.claimSearchMemoryRequestForCurrentTurn(signature)).toBe(true);

      // A targeted eviction drops the exhausted claim only for refs whose
      // resident version actually left history; the rest stay guarded.
      versions.set('project:one.md', 1);
      mgr.getExhaustedBodyRefsForCurrentTurn().add('project:one.md');
      mgr.getExhaustedBodyRefsForCurrentTurn().add('project:two.md');
      mgr.markMemoryBodiesEvictedFromHistory([
        { memoryRef: 'project:one.md', mtimeMs: 1 },
      ]);
      expect(mgr.getExhaustedBodyRefsForCurrentTurn()).toEqual(
        new Set(['project:two.md']),
      );
    });

    it('preserves partial body coverage when history only grows', () => {
      const mgr = new MemoryManager();
      const coverage = mgr.getBodyCoverageInHistory();
      coverage.set('project:partial.md', {
        version: 3,
        total: 10,
        ranges: [{ start: 0, end: 5 }],
      });

      mgr.reconcileMemoryBodiesPresentInHistory([]);

      expect(mgr.getBodyPresentVersionsInHistory().size).toBe(0);
      expect(coverage.get('project:partial.md')).toEqual({
        version: 3,
        total: 10,
        ranges: [{ start: 0, end: 5 }],
      });
    });
  });

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
        projectRoot: tmp.projectRoot,
        sessionId: 'sess-1',
        config,
        history: [{ role: 'user', parts: [{ text: 'hi' }] }],
      });

      expect(recordUserMutation).toHaveBeenCalledWith(
        tmp.projectRoot,
        config,
        expect.any(Date),
      );
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

    it('skips only the turn containing a successful manage_memory call', async () => {
      vi.mocked(runAutoMemoryExtract).mockResolvedValue({
        touchedTopics: [],
        cursor: { sessionId: 'sess-1', updatedAt: new Date().toISOString() },
      });
      const history: Content[] = [
        { role: 'user', parts: [{ text: 'Remember my unit preference.' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'manage-memory',
                name: ToolNames.MANAGE_MEMORY,
                args: { action: 'remember', content: 'Use microseconds.' },
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'manage-memory',
                name: ToolNames.MANAGE_MEMORY,
                response: { output: '{"updated":1}' },
              },
            },
          ],
        },
        { role: 'model', parts: [{ text: 'Remembered.' }] },
        { role: 'user', parts: [{ text: 'The release window is Friday.' }] },
        { role: 'model', parts: [{ text: 'Understood.' }] },
      ];
      const mgr = new MemoryManager();
      const sameTurn = await mgr.scheduleExtract({
        projectRoot: tmp.projectRoot,
        sessionId: 'sess-1',
        history: history.slice(0, 3),
      });

      expect(sameTurn.skippedReason).toBe('memory_tool');
      expect(runAutoMemoryExtract).not.toHaveBeenCalled();
      const laterTurn = await mgr.scheduleExtract({
        projectRoot: tmp.projectRoot,
        sessionId: 'sess-1',
        history: [...history],
      });

      expect(laterTurn.skippedReason).toBeUndefined();
      expect(runAutoMemoryExtract).toHaveBeenCalledOnce();
    });

    it('does not skip extraction after manage_memory fails', async () => {
      vi.mocked(runAutoMemoryExtract).mockResolvedValue({
        touchedTopics: [],
        cursor: { sessionId: 'sess-1', updatedAt: new Date().toISOString() },
      });
      const mgr = new MemoryManager();
      const result = await mgr.scheduleExtract({
        projectRoot: tmp.projectRoot,
        sessionId: 'sess-1',
        history: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'manage-memory',
                  name: ToolNames.MANAGE_MEMORY,
                  args: { action: 'remember', content: 'Use microseconds.' },
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'manage-memory',
                  name: ToolNames.MANAGE_MEMORY,
                  response: { error: 'failed' },
                },
              },
            ],
          },
        ],
      });

      expect(result.skippedReason).toBeUndefined();
      expect(runAutoMemoryExtract).toHaveBeenCalledOnce();
    });

    it('does not skip extraction after a direct memory write is rejected', async () => {
      // Same invariant as `manage_memory` above, applied to the other arm of
      // the predicate: prior-read enforcement, a `permissions.deny` rule on a
      // memory path, EISDIR or ENOSPC all reject a `write_file` before anything
      // reaches memory, so the turn's content still needs extracting.
      vi.mocked(runAutoMemoryExtract).mockResolvedValue({
        touchedTopics: [],
        cursor: { sessionId: 'sess-1', updatedAt: new Date().toISOString() },
      });
      const mgr = new MemoryManager();
      const rejected = await mgr.scheduleExtract({
        projectRoot: tmp.projectRoot,
        sessionId: 'sess-1',
        history: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'write-1',
                  name: 'write_file',
                  args: {
                    file_path: path.join(
                      tmp.projectRoot,
                      '.qwen/memory/user/test.md',
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
                  id: 'write-1',
                  name: 'write_file',
                  response: { error: 'permission denied by rule' },
                },
              },
            ],
          },
        ],
      });

      expect(rejected.skippedReason).toBeUndefined();
      expect(runAutoMemoryExtract).toHaveBeenCalledOnce();

      // Control: the same shape with a successful response still suppresses,
      // so the gate is absence-of-failure and not "always extract".
      vi.mocked(runAutoMemoryExtract).mockClear();
      const succeeded = await mgr.scheduleExtract({
        projectRoot: tmp.projectRoot,
        sessionId: 'sess-2',
        history: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'write-2',
                  name: 'write_file',
                  args: {
                    file_path: path.join(
                      tmp.projectRoot,
                      '.qwen/memory/user/test.md',
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
                  id: 'write-2',
                  name: 'write_file',
                  response: { output: 'wrote file' },
                },
              },
            ],
          },
        ],
      });

      expect(succeeded.skippedReason).toBe('memory_tool');
      expect(runAutoMemoryExtract).not.toHaveBeenCalled();
    });

    it('does not skip extraction after a no-op manage_memory forget', async () => {
      vi.mocked(runAutoMemoryExtract).mockResolvedValue({
        touchedTopics: [],
        cursor: { sessionId: 'sess-1', updatedAt: new Date().toISOString() },
      });
      const mgr = new MemoryManager();
      const result = await mgr.scheduleExtract({
        projectRoot: tmp.projectRoot,
        sessionId: 'sess-1',
        history: [
          {
            role: 'user',
            parts: [
              {
                text: 'Forget the old deploy rule - and note deploys now need two approvals.',
              },
            ],
          },
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'manage-memory',
                  name: ToolNames.MANAGE_MEMORY,
                  args: { action: 'forget', content: 'old deploy rule' },
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'manage-memory',
                  name: ToolNames.MANAGE_MEMORY,
                  // manage_memory reports forget success with removed: 0 when
                  // nothing matched - no error key, no throw.
                  response: {
                    output:
                      '{"action":"forget","removed":0,"touchedScopes":[]}',
                  },
                },
              },
            ],
          },
          { role: 'model', parts: [{ text: 'Nothing matched that rule.' }] },
        ],
      });

      // A successful call does not imply a write, so skipping here would
      // silently drop the new durable fact stated in the same turn.
      expect(result.skippedReason).toBeUndefined();
      expect(runAutoMemoryExtract).toHaveBeenCalledOnce();
    });

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

    it.each(['native', 'bridge-object', 'bridge-json'])(
      'records a user mutation when %s history writes User Memory',
      async (mode) => {
        const mgr = new MemoryManager();
        const recordUserMutation = vi
          .spyOn(mgr, 'recordUserMutation')
          .mockResolvedValue();
        const config = makeMockConfig();
        const now = new Date('2026-08-27T00:00:00.000Z');

        const writeArgs = {
          file_path: path.join(
            getUserAutoMemoryRoot(),
            'user',
            'preference.md',
          ),
        };
        const name = mode === 'native' ? 'write_file' : ToolNames.TOOL_CALL;
        const args =
          mode === 'native'
            ? writeArgs
            : {
                name: 'write_file',
                arguments:
                  mode === 'bridge-json'
                    ? JSON.stringify(writeArgs)
                    : writeArgs,
              };

        const result = await mgr.scheduleExtract({
          projectRoot: tmp.projectRoot,
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
                    name,
                    args,
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
                    name,
                    response: { output: 'updated' },
                  },
                },
              ],
            },
          ],
        });

        expect(result.skippedReason).toBe('memory_tool');
        expect(recordUserMutation).toHaveBeenCalledWith(
          tmp.projectRoot,
          config,
          now,
        );
      },
    );

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

    it('runs a manual dream through the managed path and releases the lock', async () => {
      const mgr = new MemoryManager();
      const config = makeMockConfig();
      vi.mocked(runManagedAutoMemoryDream).mockResolvedValue({
        touchedTopics: ['project'],
        createdEntries: 1,
        updatedEntries: 0,
        deletedEntries: 0,
        dedupedEntries: 0,
        splitEntries: 0,
        keywordBackfilled: 0,
        systemMessage: 'Managed auto-memory dream (agent): consolidated',
      });

      const result = await mgr.runManualDream(
        tmp.projectRoot,
        config,
        'sess-1',
      );

      expect(result.systemMessage).toContain('consolidated');
      expect(runManagedAutoMemoryDream).toHaveBeenCalledWith(
        tmp.projectRoot,
        expect.any(Date),
        config,
        undefined,
        {
          trigger: 'manual',
          recordMetadata: true,
          sessionId: 'sess-1',
          migrationStalled: false,
        },
      );
      // The consolidation lock is released after the run.
      await expect(
        fs.stat(getAutoMemoryConsolidationLockPath(tmp.projectRoot)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('skips a manual dream while another dream holds the lock', async () => {
      const mgr = new MemoryManager();
      const config = makeMockConfig();
      await fs.writeFile(
        getAutoMemoryConsolidationLockPath(tmp.projectRoot),
        String(process.pid),
      );

      const result = await mgr.runManualDream(
        tmp.projectRoot,
        config,
        'sess-1',
      );

      expect(result.systemMessage).toContain('already running');
      expect(runManagedAutoMemoryDream).not.toHaveBeenCalled();
    });

    it('sweeps a stale lock orphaned by a crashed process before a manual dream', async () => {
      // acquireDreamLock creates with 'wx', so it fails on ANY existing
      // lock — including one a crashed CLI left behind. The scheduled path
      // sweeps by holder liveness; the manual path must do the same or the
      // orphan blocks /dream for the whole session.
      const mgr = new MemoryManager();
      const config = makeMockConfig();
      const lockPath = getAutoMemoryConsolidationLockPath(tmp.projectRoot);
      await fs.writeFile(lockPath, String(process.pid));
      const stale = new Date(Date.now() - 2 * 60 * 60 * 1000);
      await fs.utimes(lockPath, stale, stale);

      const result = await mgr.runManualDream(
        tmp.projectRoot,
        config,
        'sess-1',
      );

      expect(runManagedAutoMemoryDream).toHaveBeenCalled();
      expect(result.systemMessage ?? '').not.toContain('already running');
      // The swept-then-released lock is gone after the run.
      await expect(fs.stat(lockPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });

    it('returns the dream result when the lock release fails, and lets the next scheduleDream recover', async () => {
      // A failed release (Windows EPERM/EBUSY, ENOENT race) used to replace
      // the successful result with the release error AND leave the lock on
      // disk owned by our own live PID — dreamLockExists() then reports
      // 'locked' until the staleness window expires. The release is guarded
      // and flagged instead, so the next scheduleDream force-cleans it.
      const lockPath = getAutoMemoryConsolidationLockPath(tmp.projectRoot);
      const mgr = new MemoryManager(async () => ['sess-9']);
      const config = makeMockConfig();
      vi.mocked(runManagedAutoMemoryDream).mockImplementation(async () => {
        // Replace the acquired lock file with a directory: fs.rm without
        // recursive then fails with ERR_FS_EISDIR on every platform.
        await fs.rm(lockPath, { force: true });
        await fs.mkdir(lockPath);
        return {
          touchedTopics: ['project'],
          createdEntries: 1,
          updatedEntries: 0,
          deletedEntries: 0,
          dedupedEntries: 0,
          splitEntries: 0,
          keywordBackfilled: 0,
          systemMessage: 'Managed auto-memory dream (agent): consolidated',
        };
      });

      const result = await mgr.runManualDream(
        tmp.projectRoot,
        config,
        'sess-1',
      );
      expect(result.systemMessage).toContain('consolidated');
      // The release failed: the lock path is still occupied.
      await expect(fs.stat(lockPath)).resolves.toBeDefined();

      // Restore the leaked-lock shape (fresh mtime, our own live PID): the
      // staleness sweep cannot clear it, only the release-failed flag can.
      await fs.rmdir(lockPath);
      await fs.writeFile(lockPath, String(process.pid));

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
      const scheduled = await mgr.scheduleDream({
        projectRoot: tmp.projectRoot,
        sessionId: 'sess-2',
        config,
        now: new Date('2026-04-02T10:00:00.000Z'),
        minHoursBetweenDreams: 0,
        minSessionsBetweenDreams: 1,
      });

      expect(scheduled).not.toMatchObject({
        status: 'skipped',
        skippedReason: 'locked',
      });
      if (scheduled.status === 'scheduled') {
        await scheduled.promise;
      }
    });

    it('recovers the leaked lock on the next manual dream when the release failed', async () => {
      // The release-failure flag is what makes a leaked lock (our own live
      // PID, fresh mtime) clearable at all, but right after a manual run the
      // scheduled path that consults it is unreachable: the same_session /
      // min_hours gates return first. runManualDream must force-clean the
      // leaked lock itself or every later /dream falsely reports 'already
      // running' until the staleness window expires.
      const lockPath = getAutoMemoryConsolidationLockPath(tmp.projectRoot);
      const mgr = new MemoryManager(async () => ['sess-9']);
      const config = makeMockConfig();
      vi.mocked(runManagedAutoMemoryDream).mockImplementation(async () => {
        // Make the release fail: swap the lock file for a directory so the
        // rm without `recursive` fails on every platform.
        await fs.rm(lockPath, { force: true });
        await fs.mkdir(lockPath);
        return {
          touchedTopics: ['project'],
          createdEntries: 1,
          updatedEntries: 0,
          deletedEntries: 0,
          dedupedEntries: 0,
          splitEntries: 0,
          keywordBackfilled: 0,
          systemMessage: 'Managed auto-memory dream (agent): consolidated',
        };
      });

      const first = await mgr.runManualDream(tmp.projectRoot, config, 'sess-1');
      expect(first.systemMessage).toContain('consolidated');
      await expect(fs.stat(lockPath)).resolves.toBeDefined();

      // Restore the leaked-lock shape: fresh mtime, our own live PID, so
      // neither staleness nor liveness can clear it.
      await fs.rmdir(lockPath);
      await fs.writeFile(lockPath, String(process.pid));

      vi.mocked(runManagedAutoMemoryDream).mockResolvedValue({
        touchedTopics: ['project'],
        createdEntries: 0,
        updatedEntries: 0,
        deletedEntries: 0,
        dedupedEntries: 0,
        splitEntries: 0,
        keywordBackfilled: 0,
        systemMessage: 'Managed auto-memory dream (agent): consolidated',
      });

      const second = await mgr.runManualDream(
        tmp.projectRoot,
        config,
        'sess-1',
      );

      expect(runManagedAutoMemoryDream).toHaveBeenCalledTimes(2);
      expect(second.systemMessage ?? '').not.toContain('already running');
      await expect(fs.stat(lockPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
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
        createdEntries: 0,
        updatedEntries: 1,
        deletedEntries: 1,
        dedupedEntries: 1,
        splitEntries: 0,
        keywordBackfilled: 0,
        systemMessage: 'Dream complete.',
      });

      const mgr = new MemoryManager(async () => ['s0', 's1', 's2', 's3', 's4']);

      const result = await mgr.scheduleDream(
        dreamParams('sess-x', APR1_10, 0, 3),
      );

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
        ...emptyDream(),
        updatedEntries: 2,
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
