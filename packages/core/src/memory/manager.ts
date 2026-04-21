/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MemoryManager — the single entry-point for all memory module operations.
 *
 * # Design
 * All background-task state (in-flight promises, per-project extraction queues,
 * per-project dream-scan timestamps, task records) is owned directly by
 * MemoryManager using plain Maps and sets. There are no separate
 * BackgroundTaskRegistry / BackgroundTaskDrainer / BackgroundTaskScheduler
 * helper classes; those abstractions are replaced by straightforward inline
 * state management inside this class.
 *
 * Public API — everything external callers need:
 *   config.getMemoryManager().scheduleExtract(params)
 *   config.getMemoryManager().scheduleDream(params)
 *   config.getMemoryManager().recall(projectRoot, query, options)
 *   config.getMemoryManager().forget(projectRoot, query, options)
 *   config.getMemoryManager().getStatus(projectRoot)
 *   config.getMemoryManager().drain(options?)
 *   config.getMemoryManager().appendToUserMemory(userMemory, projectRoot)
 *
 * # Task records
 * Each scheduled operation is tracked as a lightweight MemoryTaskRecord.
 * These are queryable by type and projectRoot for status display.
 *
 * # Injection for tests
 * Production code uses `config.getMemoryManager()`. Tests that need isolation
 * construct `new MemoryManager()` directly.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Content, Part } from '@google/genai';
import type { Config } from '../config/config.js';
import { Storage } from '../config/storage.js';
import { logMemoryExtract, MemoryExtractEvent } from '../telemetry/index.js';
import { isAutoMemPath } from './paths.js';
import {
  getAutoMemoryConsolidationLockPath,
  getAutoMemoryMetadataPath,
} from './paths.js';
import { ensureAutoMemoryScaffold } from './store.js';
import { runAutoMemoryExtract } from './extract.js';
import { runManagedAutoMemoryDream } from './dream.js';
import {
  forgetManagedAutoMemoryEntries,
  forgetManagedAutoMemoryMatches,
  selectManagedAutoMemoryForgetCandidates,
  type AutoMemoryForgetMatch,
  type AutoMemoryForgetResult,
  type AutoMemoryForgetSelectionResult,
} from './forget.js';
import {
  resolveRelevantAutoMemoryPromptForQuery,
  type RelevantAutoMemoryPromptResult,
  type ResolveRelevantAutoMemoryPromptOptions,
} from './recall.js';
import { getManagedAutoMemoryStatus } from './status.js';
import { appendManagedAutoMemoryToUserMemory } from './prompt.js';
import { writeDreamManualRunToMetadata } from './dream.js';
import { buildConsolidationTaskPrompt } from './dreamAgentPlanner.js';
import type { AutoMemoryMetadata } from './types.js';

// ─── Re-export public types consumed by callers ───────────────────────────────

export type {
  AutoMemoryForgetResult,
  AutoMemoryForgetMatch,
  AutoMemoryForgetSelectionResult,
};
export type {
  RelevantAutoMemoryPromptResult,
  ResolveRelevantAutoMemoryPromptOptions,
};
export type { ManagedAutoMemoryStatus } from './status.js';

// ─── Task record ──────────────────────────────────────────────────────────────

export type MemoryTaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped';

export interface MemoryTaskRecord {
  id: string;
  taskType: 'extract' | 'dream';
  projectRoot: string;
  sessionId?: string;
  status: MemoryTaskStatus;
  createdAt: string;
  updatedAt: string;
  progressText?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

// ─── Extract params / result ──────────────────────────────────────────────────

export interface ScheduleExtractParams {
  projectRoot: string;
  sessionId: string;
  history: Content[];
  now?: Date;
  config?: Config;
}

// AutoMemoryExtractResult is re-used as the return type
export type { AutoMemoryExtractResult as ExtractResult } from './extract.js';

// ─── Dream params / result ────────────────────────────────────────────────────

export interface ScheduleDreamParams {
  projectRoot: string;
  sessionId: string;
  config?: Config;
  now?: Date;
  minHoursBetweenDreams?: number;
  minSessionsBetweenDreams?: number;
}

export interface DreamScheduleResult {
  status: 'scheduled' | 'skipped';
  taskId?: string;
  skippedReason?:
    | 'disabled'
    | 'same_session'
    | 'min_hours'
    | 'min_sessions'
    | 'scan_throttled'
    | 'locked'
    | 'running';
  promise?: Promise<MemoryTaskRecord>;
}

/** Function type for scanning session files by mtime. Injected for testing. */
export type SessionScannerFn = (
  projectRoot: string,
  sinceMs: number,
  excludeSessionId: string,
) => Promise<string[]>;

// ─── Drain options ────────────────────────────────────────────────────────────

export interface DrainOptions {
  timeoutMs?: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const EXTRACT_TASK_TYPE = 'managed-auto-memory-extraction' as const;
export const DREAM_TASK_TYPE = 'managed-auto-memory-dream' as const;

export const DEFAULT_AUTO_DREAM_MIN_HOURS = 24;
export const DEFAULT_AUTO_DREAM_MIN_SESSIONS = 5;

const DREAM_LOCK_STALE_MS = 60 * 60 * 1000; // 1 hour
const SESSION_SCAN_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

const WRITE_TOOL_NAMES = new Set([
  'write_file',
  'edit',
  'replace',
  'create_file',
]);

// ─── Internal helpers ─────────────────────────────────────────────────────────

function makeTaskRecord(
  type: 'extract' | 'dream',
  projectRoot: string,
  sessionId?: string,
): MemoryTaskRecord {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    taskType: type,
    projectRoot,
    sessionId,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };
}

function updateRecord(
  record: MemoryTaskRecord,
  patch: Partial<
    Pick<MemoryTaskRecord, 'status' | 'progressText' | 'error' | 'metadata'>
  >,
): void {
  if (patch.status !== undefined) record.status = patch.status;
  if (patch.progressText !== undefined)
    record.progressText = patch.progressText;
  if (patch.error !== undefined) record.error = patch.error;
  if (patch.metadata !== undefined) {
    record.metadata = { ...(record.metadata ?? {}), ...patch.metadata };
  }
  record.updatedAt = new Date().toISOString();
}

function partWritesToMemory(part: Part, projectRoot: string): boolean {
  const name = part.functionCall?.name;
  if (name && WRITE_TOOL_NAMES.has(name)) {
    const args = part.functionCall?.args as Record<string, unknown> | undefined;
    const filePath =
      args?.['file_path'] ?? args?.['path'] ?? args?.['target_file'];
    if (typeof filePath === 'string' && isAutoMemPath(filePath, projectRoot)) {
      return true;
    }
  }
  return false;
}

function historyWritesToMemory(
  history: Content[],
  projectRoot: string,
): boolean {
  return history.some((msg) =>
    (msg.parts ?? []).some((p) => partWritesToMemory(p, projectRoot)),
  );
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readDreamMetadata(
  projectRoot: string,
): Promise<AutoMemoryMetadata> {
  const content = await fs.readFile(
    getAutoMemoryMetadataPath(projectRoot),
    'utf-8',
  );
  return JSON.parse(content) as AutoMemoryMetadata;
}

async function writeDreamMetadata(
  projectRoot: string,
  metadata: AutoMemoryMetadata,
): Promise<void> {
  await fs.writeFile(
    getAutoMemoryMetadataPath(projectRoot),
    `${JSON.stringify(metadata, null, 2)}\n`,
    'utf-8',
  );
}

function hoursSince(lastDreamAt: string | undefined, now: Date): number | null {
  if (!lastDreamAt) return null;
  const timestamp = Date.parse(lastDreamAt);
  if (Number.isNaN(timestamp)) return null;
  return (now.getTime() - timestamp) / (1000 * 60 * 60);
}

const SESSION_FILE_PATTERN = /^[0-9a-fA-F-]{32,36}\.jsonl$/;

async function defaultSessionScanner(
  projectRoot: string,
  sinceMs: number,
  excludeSessionId: string,
): Promise<string[]> {
  const chatsDir = path.join(new Storage(projectRoot).getProjectDir(), 'chats');
  let names: string[];
  try {
    names = await fs.readdir(chatsDir);
  } catch {
    return [];
  }
  const results: string[] = [];
  await Promise.all(
    names.map(async (name) => {
      if (!SESSION_FILE_PATTERN.test(name)) return;
      const sessionId = name.slice(0, -'.jsonl'.length);
      if (sessionId === excludeSessionId) return;
      try {
        const stats = await fs.stat(path.join(chatsDir, name));
        if (stats.mtimeMs > sinceMs) results.push(sessionId);
      } catch {
        // skip unreadable files
      }
    }),
  );
  return results;
}

async function dreamLockExists(projectRoot: string): Promise<boolean> {
  const lockPath = getAutoMemoryConsolidationLockPath(projectRoot);
  let mtimeMs: number;
  let holderPid: number | undefined;
  try {
    const [stats, content] = await Promise.all([
      fs.stat(lockPath),
      fs.readFile(lockPath, 'utf-8').catch(() => ''),
    ]);
    mtimeMs = stats.mtimeMs;
    const parsed = parseInt(content.trim(), 10);
    holderPid = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  } catch {
    return false; // ENOENT — no lock
  }
  const ageMs = Date.now() - mtimeMs;
  if (ageMs <= DREAM_LOCK_STALE_MS) {
    if (holderPid !== undefined && isProcessRunning(holderPid)) return true;
    await fs.rm(lockPath, { force: true });
    return false;
  }
  await fs.rm(lockPath, { force: true });
  return false;
}

async function acquireDreamLock(projectRoot: string): Promise<void> {
  await fs.writeFile(
    getAutoMemoryConsolidationLockPath(projectRoot),
    String(process.pid),
    { flag: 'wx' },
  );
}

async function releaseDreamLock(projectRoot: string): Promise<void> {
  await fs.rm(getAutoMemoryConsolidationLockPath(projectRoot), {
    force: true,
  });
}

// ─── MemoryManager ────────────────────────────────────────────────────────────

/**
 * MemoryManager owns all runtime state for the memory subsystem and exposes a
 * clean, stable API. It is created once per Config instance and returned by
 * `config.getMemoryManager()`. Tests pass a fresh `new MemoryManager()`.
 */
export class MemoryManager {
  // ── Task records ────────────────────────────────────────────────────────────
  private readonly tasks = new Map<string, MemoryTaskRecord>();
  // ── Subscribers (useSyncExternalStore / custom listeners) ────────────────
  private readonly subscribers = new Set<() => void>();
  // ── In-flight promises (for drain) ──────────────────────────────────────────
  private readonly inFlight = new Map<string, Promise<unknown>>();

  // ── Extract scheduling state ─────────────────────────────────────────────────
  private readonly extractRunning = new Set<string>();
  private readonly extractCurrentTaskId = new Map<string, string>();
  private readonly extractQueued = new Map<
    string,
    { taskId: string; params: ScheduleExtractParams }
  >();

  // ── Dream scheduling state ───────────────────────────────────────────────────
  private readonly dreamInFlightByKey = new Map<string, string>();
  private readonly dreamLastSessionScanAt = new Map<string, number>();
  private readonly sessionScanner: SessionScannerFn;

  constructor(sessionScanner: SessionScannerFn = defaultSessionScanner) {
    this.sessionScanner = sessionScanner;
  }
  // ─── Subscribe ───────────────────────────────────────────────────────────────────

  /**
   * Register a listener that is called whenever any task record changes.
   * Compatible with React’s `useSyncExternalStore`.
   * Returns an unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  private notify(): void {
    for (const fn of this.subscribers) fn();
  }

  /** Update a record and notify subscribers. */
  private update(
    record: MemoryTaskRecord,
    patch: Partial<
      Pick<MemoryTaskRecord, 'status' | 'progressText' | 'error' | 'metadata'>
    >,
  ): void {
    updateRecord(record, patch);
    this.notify();
  }

  /**
   * Register a brand-new record in the task map and notify once.
   * Use this for records that start in 'pending' and need no immediate patch.
   */
  private store(record: MemoryTaskRecord): void {
    this.tasks.set(record.id, record);
    this.notify();
  }

  /**
   * Register a brand-new record AND apply an initial status patch in a single
   * notify. Avoids the double-render that separate store()+update() causes.
   */
  private storeWith(
    record: MemoryTaskRecord,
    patch: Partial<
      Pick<MemoryTaskRecord, 'status' | 'progressText' | 'error' | 'metadata'>
    >,
  ): void {
    updateRecord(record, patch);
    this.tasks.set(record.id, record);
    this.notify();
  }
  // ─── Task record query ────────────────────────────────────────────────────────

  /** Return task records filtered by type and optionally by projectRoot. */
  listTasksByType(
    taskType: 'extract' | 'dream',
    projectRoot?: string,
  ): MemoryTaskRecord[] {
    return [...this.tasks.values()]
      .filter(
        (t) =>
          t.taskType === taskType &&
          (!projectRoot || t.projectRoot === projectRoot),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  // ─── Drain ────────────────────────────────────────────────────────────────────

  /** Wait for all in-flight tasks to settle, with optional timeout. */
  async drain(options: DrainOptions = {}): Promise<boolean> {
    const promises = [...this.inFlight.values()];
    if (promises.length === 0) return true;
    const waitAll = Promise.allSettled(promises).then(() => true);
    if (!options.timeoutMs || options.timeoutMs <= 0) return waitAll;
    return Promise.race<boolean>([
      waitAll,
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), options.timeoutMs),
      ),
    ]);
  }

  private track<T>(taskId: string, promise: Promise<T>): Promise<T> {
    this.inFlight.set(taskId, promise);
    void promise.finally(() => this.inFlight.delete(taskId));
    return promise;
  }

  // ─── Extract ──────────────────────────────────────────────────────────────────

  /**
   * Schedule a managed auto-memory extraction for the given session turn.
   *
   * Returns immediately with a skipped result if:
   *   - The last history turn wrote to a memory file (memory_tool)
   *   - Extraction is already running for this project (queues trailing request)
   *
   * The trailing request starts automatically when the active extraction
   * completes.
   */
  async scheduleExtract(
    params: ScheduleExtractParams,
  ): Promise<
    ReturnType<typeof runAutoMemoryExtract> extends Promise<infer T> ? T : never
  > {
    if (historyWritesToMemory(params.history, params.projectRoot)) {
      const record = makeTaskRecord(
        'extract',
        params.projectRoot,
        params.sessionId,
      );
      this.storeWith(record, {
        status: 'skipped',
        progressText: 'Skipped: main agent wrote to memory files this turn.',
        metadata: {
          skippedReason: 'memory_tool',
          historyLength: params.history.length,
        },
      });
      return {
        touchedTopics: [],
        skippedReason: 'memory_tool' as const,
        cursor: {
          sessionId: params.sessionId,
          updatedAt: (params.now ?? new Date()).toISOString(),
        },
      } as never;
    }

    if (this.extractRunning.has(params.projectRoot)) {
      const currentTaskId = this.extractCurrentTaskId.get(params.projectRoot);
      if (!currentTaskId) {
        return {
          touchedTopics: [],
          skippedReason: 'already_running' as const,
          cursor: {
            sessionId: params.sessionId,
            updatedAt: (params.now ?? new Date()).toISOString(),
          },
        } as never;
      }

      const queued = this.extractQueued.get(params.projectRoot);
      if (queued) {
        // Supersede the existing queued request with newer params
        queued.params = params;
        const queuedRecord = this.tasks.get(queued.taskId);
        if (queuedRecord) {
          this.update(queuedRecord, {
            status: 'pending',
            progressText:
              'Updated trailing managed auto-memory extraction request while another extraction is running.',
            metadata: {
              queuedBehindTaskId: currentTaskId,
              historyLength: params.history.length,
              supersededAt: new Date().toISOString(),
            },
          });
        }
      } else {
        const record = makeTaskRecord(
          'extract',
          params.projectRoot,
          params.sessionId,
        );
        this.storeWith(record, {
          status: 'pending',
          progressText:
            'Queued trailing managed auto-memory extraction until the active extraction completes.',
          metadata: {
            trailing: true,
            queuedBehindTaskId: currentTaskId,
            historyLength: params.history.length,
          },
        });
        this.extractQueued.set(params.projectRoot, {
          taskId: record.id,
          params,
        });
      }

      return {
        touchedTopics: [],
        skippedReason: 'queued' as const,
        cursor: {
          sessionId: params.sessionId,
          updatedAt: (params.now ?? new Date()).toISOString(),
        },
      } as never;
    }

    const record = makeTaskRecord(
      'extract',
      params.projectRoot,
      params.sessionId,
    );
    this.store(record);
    return this.track(record.id, this.runExtract(record.id, params)) as never;
  }

  private async runExtract(
    taskId: string,
    params: ScheduleExtractParams,
  ): Promise<Awaited<ReturnType<typeof runAutoMemoryExtract>>> {
    const record = this.tasks.get(taskId)!;
    this.extractCurrentTaskId.set(params.projectRoot, taskId);
    this.extractRunning.add(params.projectRoot);
    this.update(record, {
      status: 'running',
      progressText: 'Running managed auto-memory extraction.',
      metadata: { historyLength: params.history.length },
    });

    const t0 = Date.now();
    try {
      const result = await runAutoMemoryExtract(params);
      const durationMs = Date.now() - t0;
      this.update(record, {
        status: result.skippedReason ? 'skipped' : 'completed',
        progressText:
          result.systemMessage ??
          (result.touchedTopics.length > 0
            ? `Managed auto-memory updated: ${result.touchedTopics.join(', ')}.`
            : 'Managed auto-memory extraction completed without durable changes.'),
        metadata: {
          touchedTopics: result.touchedTopics,
          processedOffset: result.cursor.processedOffset,
          skippedReason: result.skippedReason,
        },
      });
      if (params.config) {
        logMemoryExtract(
          params.config,
          new MemoryExtractEvent({
            trigger: 'auto',
            status: 'completed',
            patches_count: result.touchedTopics.length,
            touched_topics: result.touchedTopics,
            duration_ms: durationMs,
          }),
        );
      }
      return result;
    } catch (error) {
      const durationMs = Date.now() - t0;
      this.update(record, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      if (params.config) {
        logMemoryExtract(
          params.config,
          new MemoryExtractEvent({
            trigger: 'auto',
            status: 'failed',
            patches_count: 0,
            touched_topics: [],
            duration_ms: durationMs,
          }),
        );
      }
      throw error;
    } finally {
      this.extractCurrentTaskId.delete(params.projectRoot);
      this.extractRunning.delete(params.projectRoot);
      void this.startQueuedExtract(params.projectRoot);
    }
  }

  private async startQueuedExtract(projectRoot: string): Promise<void> {
    if (this.extractRunning.has(projectRoot)) return;
    const queued = this.extractQueued.get(projectRoot);
    if (!queued) return;
    this.extractQueued.delete(projectRoot);
    await this.track(
      queued.taskId,
      this.runExtract(queued.taskId, queued.params),
    );
  }

  // ─── Dream ────────────────────────────────────────────────────────────────────

  /**
   * Maybe schedule a managed auto-memory dream (consolidation).
   * Returns immediately if preconditions aren't met (time gate, session count,
   * lock, or duplicate).
   */
  async scheduleDream(
    params: ScheduleDreamParams,
  ): Promise<DreamScheduleResult> {
    if (params.config && !params.config.getManagedAutoDreamEnabled()) {
      return { status: 'skipped', skippedReason: 'disabled' };
    }

    const now = params.now ?? new Date();
    const minHours =
      params.minHoursBetweenDreams ?? DEFAULT_AUTO_DREAM_MIN_HOURS;
    const minSessions =
      params.minSessionsBetweenDreams ?? DEFAULT_AUTO_DREAM_MIN_SESSIONS;

    await ensureAutoMemoryScaffold(params.projectRoot, now);
    const metadata = await readDreamMetadata(params.projectRoot);

    if (metadata.lastDreamSessionId === params.sessionId) {
      return { status: 'skipped', skippedReason: 'same_session' };
    }

    const elapsedHours = hoursSince(metadata.lastDreamAt, now);
    if (elapsedHours !== null && elapsedHours < minHours) {
      return { status: 'skipped', skippedReason: 'min_hours' };
    }

    // Throttle the expensive session-count filesystem scan.
    // Return a distinct reason so callers can tell the difference between
    // "we know there aren't enough sessions" and "we haven't checked yet".
    const lastScan = this.dreamLastSessionScanAt.get(params.projectRoot) ?? 0;
    if (now.getTime() - lastScan < SESSION_SCAN_INTERVAL_MS) {
      return { status: 'skipped', skippedReason: 'scan_throttled' };
    }

    const lastDreamMs = metadata.lastDreamAt
      ? Date.parse(metadata.lastDreamAt)
      : 0;
    const sessionIds = await this.sessionScanner(
      params.projectRoot,
      lastDreamMs,
      params.sessionId,
    );
    // Record scan time only after we actually performed the filesystem scan.
    this.dreamLastSessionScanAt.set(params.projectRoot, now.getTime());
    if (sessionIds.length < minSessions) {
      return { status: 'skipped', skippedReason: 'min_sessions' };
    }

    if (await dreamLockExists(params.projectRoot)) {
      return { status: 'skipped', skippedReason: 'locked' };
    }

    // Deduplication — only one dream per projectRoot at a time
    const dedupeKey = `${DREAM_TASK_TYPE}:${params.projectRoot}`;
    const existingId = this.dreamInFlightByKey.get(dedupeKey);
    if (existingId) {
      return {
        status: 'skipped',
        skippedReason: 'running',
        taskId: existingId,
      };
    }

    const record = makeTaskRecord(
      'dream',
      params.projectRoot,
      params.sessionId,
    );
    this.storeWith(record, {
      status: 'running',
      metadata: { sessionCount: sessionIds.length },
    });
    this.dreamInFlightByKey.set(dedupeKey, record.id);

    const promise = this.track(
      record.id,
      this.runDream(record, dedupeKey, params, now),
    );

    return { status: 'scheduled', taskId: record.id, promise };
  }

  private async runDream(
    record: MemoryTaskRecord,
    dedupeKey: string,
    params: ScheduleDreamParams,
    now: Date,
  ): Promise<MemoryTaskRecord> {
    try {
      try {
        await acquireDreamLock(params.projectRoot);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          this.update(record, {
            status: 'skipped',
            progressText:
              'Skipped managed auto-memory dream: consolidation lock already exists.',
            metadata: { skippedReason: 'locked' },
          });
          return record;
        }
        throw error;
      }

      try {
        const result = await runManagedAutoMemoryDream(
          params.projectRoot,
          now,
          params.config,
        );
        const nextMetadata = await readDreamMetadata(params.projectRoot);
        nextMetadata.lastDreamAt = now.toISOString();
        nextMetadata.lastDreamSessionId = params.sessionId;
        nextMetadata.updatedAt = now.toISOString();
        await writeDreamMetadata(params.projectRoot, nextMetadata);

        this.update(record, {
          status: 'completed',
          progressText:
            result.systemMessage ?? 'Managed auto-memory dream completed.',
          metadata: {
            touchedTopics: result.touchedTopics,
            dedupedEntries: result.dedupedEntries,
            lastDreamAt: now.toISOString(),
          },
        });
      } finally {
        await releaseDreamLock(params.projectRoot);
      }
    } catch (error) {
      this.update(record, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.dreamInFlightByKey.delete(dedupeKey);
    }
    return record;
  }

  // ─── Recall ───────────────────────────────────────────────────────────────────

  /** Select and format relevant memory for the given query. */
  recall(
    projectRoot: string,
    query: string,
    options: ResolveRelevantAutoMemoryPromptOptions = {},
  ): Promise<RelevantAutoMemoryPromptResult> {
    return resolveRelevantAutoMemoryPromptForQuery(projectRoot, query, options);
  }

  // ─── Forget ───────────────────────────────────────────────────────────────────

  /** Select candidate memory entries matching the given query (step 1 of forget). */
  selectForgetCandidates(
    projectRoot: string,
    query: string,
    options: { config?: Config; limit?: number } = {},
  ): Promise<AutoMemoryForgetSelectionResult> {
    return selectManagedAutoMemoryForgetCandidates(projectRoot, query, options);
  }

  /** Remove the selected memory entries (step 2 of forget). */
  forgetMatches(
    projectRoot: string,
    matches: AutoMemoryForgetMatch[],
    now?: Date,
  ): Promise<AutoMemoryForgetResult> {
    return forgetManagedAutoMemoryMatches(projectRoot, matches, now);
  }

  /** Convenience: select + remove in a single call. */
  forget(
    projectRoot: string,
    query: string,
    options: { config?: Config } = {},
    now?: Date,
  ): Promise<AutoMemoryForgetResult> {
    return forgetManagedAutoMemoryEntries(projectRoot, query, options, now);
  }

  // ─── Status ───────────────────────────────────────────────────────────────────

  /** Return a full status snapshot for the given project's memory. */
  getStatus(projectRoot: string) {
    return getManagedAutoMemoryStatus(projectRoot, this);
  }

  // ─── Prompt append ────────────────────────────────────────────────────────────

  /** Append the managed auto-memory section to a user memory string. */
  appendToUserMemory(
    userMemory: string,
    memoryDir: string,
    indexContent?: string | null,
  ): string {
    return appendManagedAutoMemoryToUserMemory(
      userMemory,
      memoryDir,
      indexContent,
    );
  }

  // ─── Dream utilities ──────────────────────────────────────────────────────────

  /**
   * Record that a manual dream run has completed for the given session.
   * Call this from the dreamCommand's onComplete callback.
   */
  writeDreamManualRun(
    projectRoot: string,
    sessionId: string,
    now?: Date,
  ): Promise<void> {
    return writeDreamManualRunToMetadata(projectRoot, sessionId, now);
  }

  /**
   * Build the consolidation task prompt used by the dream slash command.
   * Returns a prompt string describing what the agent should do.
   */
  buildConsolidationPrompt(memoryRoot: string, transcriptDir: string): string {
    return buildConsolidationTaskPrompt(memoryRoot, transcriptDir);
  }

  // ─── Test helpers ─────────────────────────────────────────────────────────────

  /** Reset all extract scheduling state. Call from afterEach in tests. */
  resetExtractStateForTests(): void {
    this.extractRunning.clear();
    this.extractCurrentTaskId.clear();
    this.extractQueued.clear();
  }

  /** Reset all dream scheduling state. */
  resetDreamStateForTests(): void {
    this.dreamInFlightByKey.clear();
    this.dreamLastSessionScanAt.clear();
  }
}

/**
 * Application-wide singleton. In a fully wired application Config creates its
 * own MemoryManager accessible via `config.getMemoryManager()`.
 */
export const globalMemoryManager = new MemoryManager();
