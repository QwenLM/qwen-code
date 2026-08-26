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
 *   config.getMemoryManager().buildAutoMemoryPrompt(projectRoot)
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
import { atomicWriteFile } from '../utils/atomicFileWrite.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  logMemoryDream,
  logMemoryExtract,
  logMemoryMigration,
  MemoryDreamEvent,
  MemoryExtractEvent,
  MemoryMigrationEvent,
} from '../telemetry/index.js';
import {
  getUserAutoMemoryConsolidationLockPath,
  getAutoMemoryRoot,
  getTeamAutoMemoryRoot,
  getUserAutoMemoryRoot,
  isAnyAutoMemPath,
  isTeamAutoMemPath,
  isUserAutoMemPath,
} from './paths.js';
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
import {
  buildManagedAutoMemoryPrompt,
  type BuildMemoryPromptOptions,
  type UserAutoMemorySection,
  type TeamAutoMemorySection,
} from './prompt.js';
import { writeDreamManualRunToMetadata } from './dream.js';
import { buildConsolidationTaskPrompt } from './dreamAgentPlanner.js';
import {
  runSkillReviewByAgent,
  listExistingSkillDirNames,
} from './skillReviewAgentPlanner.js';
import {
  stageSkillDirs,
  acceptPendingSkill,
  rejectPendingSkill,
  type PendingSkill,
} from './pending-skills.js';
import type { AutoMemoryMetadata } from './types.js';
import type { MemoryBodyCoverage } from './search-memory.js';
import {
  runMemoryMetadataMigration,
  getProjectMetadataMigrationRoots,
  scanMemoryMetadataMigrationCandidates,
  type MetadataMigrationScope,
} from './metadata-migration.js';
import {
  completeUserAutoMemoryDream,
  DEFAULT_USER_DREAM_MIN_HOURS,
  failUserAutoMemoryDream,
  markUserAutoMemoryDreamRunning,
  readUserAutoMemoryMetadata,
  recordUserAutoMemoryMutation,
  runManagedUserAutoMemoryDream,
} from './user-dream.js';

const debugLogger = createDebugLogger('AUTO_MEMORY_MANAGER');

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
  | 'cancelled'
  | 'skipped';

export interface MemoryTaskRecord {
  id: string;
  taskType: 'extract' | 'dream' | 'skill-review' | 'migration';
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

export interface ScheduleSkillReviewParams {
  projectRoot: string;
  sessionId: string;
  history: Content[];
  toolCallCount: number;
  skillsModified: boolean;
  now?: Date;
  config?: Config;
  enabled?: boolean;
  threshold?: number;
  maxTurns?: number;
  timeoutMs?: number;
  /** When true, stage created skills for user confirmation instead of
   * leaving them live in the skills root. Sourced from
   * Config.getAutoSkillConfirmEnabled(). */
  confirmBeforePersist?: boolean;
}

export interface SkillReviewScheduleResult {
  status: 'scheduled' | 'skipped';
  taskId?: string;
  skippedReason?:
    | 'below_threshold'
    | 'skills_modified_in_session'
    | 'disabled'
    | 'already_running'
    | 'memory_pressure';
  promise?: Promise<MemoryTaskRecord>;
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
    | 'running'
    | 'memory_pressure'
    | 'migration_pending';
  promise?: Promise<MemoryTaskRecord>;
}

export interface ScheduleUserDreamParams {
  projectRoot: string;
  config?: Config;
  now?: Date;
  minHoursBetweenDreams?: number;
}

export interface UserDreamScheduleResult {
  status: 'scheduled' | 'skipped';
  taskId?: string;
  skippedReason?:
    | 'disabled'
    | 'not_pending'
    | 'min_hours'
    | 'locked'
    | 'running'
    | 'memory_pressure'
    | 'migration_pending';
  promise?: Promise<MemoryTaskRecord>;
}

export interface ScheduleMetadataMigrationParams {
  projectRoot: string;
  scope: MetadataMigrationScope;
  config: Config;
}

export interface MetadataMigrationScheduleResult {
  status: 'scheduled' | 'skipped';
  taskId?: string;
  skippedReason?: 'complete' | 'running' | 'memory_pressure';
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
export const USER_DREAM_TASK_TYPE = 'managed-user-auto-memory-dream' as const;
export const SKILL_REVIEW_TASK_TYPE = 'managed-skill-extractor' as const;
export const AUTO_SKILL_THRESHOLD = 20;

export const DEFAULT_AUTO_DREAM_MIN_HOURS = 24;
export const DEFAULT_AUTO_DREAM_MIN_SESSIONS = 5;

const DREAM_LOCK_STALE_MS = 60 * 60 * 1000; // 1 hour
const SESSION_SCAN_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const activeMigrationDomains = new Set<string>();

const WRITE_TOOL_NAMES = new Set([
  'write_file',
  'edit',
  'replace',
  'create_file',
]);

// ─── Internal helpers ─────────────────────────────────────────────────────────

function makeTaskRecord(
  type: MemoryTaskRecord['taskType'],
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

// INVARIANT: mutates `record` in place. `resolvePendingSkill`'s concurrency
// safety (concurrent Keep-all/Discard-all each removing only their own entry)
// relies on this — it re-reads `record.metadata.pendingSkills` after its await
// and expects to see writes from sibling calls. A refactor to immutable
// record updates would reintroduce the "all-but-one left behind" race.
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
    if (
      typeof filePath === 'string' &&
      (isAnyAutoMemPath(filePath, projectRoot) ||
        isTeamAutoMemPath(filePath, projectRoot))
    ) {
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

function latestHistoryWritesToUserMemory(history: Content[]): boolean {
  const queryIndex = history.findLastIndex(
    (message) =>
      message.role === 'user' &&
      (message.parts ?? []).some(
        (part) => typeof part.text === 'string' && part.text.trim().length > 0,
      ) &&
      !(message.parts ?? []).some((part) => part.functionResponse),
  );
  if (queryIndex < 0) return false;

  const successfulCallIds = new Set<string>();
  for (const message of history.slice(queryIndex + 1)) {
    for (const part of message.parts ?? []) {
      const response = part.functionResponse as
        | { id?: string; response?: Record<string, unknown> }
        | undefined;
      if (
        response?.id &&
        response.response &&
        !('error' in response.response)
      ) {
        successfulCallIds.add(response.id);
      }
    }
  }

  return history.slice(queryIndex + 1).some((message) =>
    (message.parts ?? []).some((part) => {
      const name = part.functionCall?.name;
      if (!name || !WRITE_TOOL_NAMES.has(name)) return false;
      if (
        !part.functionCall?.id ||
        !successfulCallIds.has(part.functionCall.id)
      ) {
        return false;
      }
      const args = part.functionCall?.args as
        | Record<string, unknown>
        | undefined;
      const filePath =
        args?.['file_path'] ?? args?.['path'] ?? args?.['target_file'];
      return typeof filePath === 'string' && isUserAutoMemPath(filePath);
    }),
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
  await atomicWriteFile(
    getAutoMemoryMetadataPath(projectRoot),
    `${JSON.stringify(metadata, null, 2)}\n`,
    { encoding: 'utf-8' },
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

async function dreamLockExistsAt(lockPath: string): Promise<boolean> {
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

async function dreamLockExists(projectRoot: string): Promise<boolean> {
  return dreamLockExistsAt(getAutoMemoryConsolidationLockPath(projectRoot));
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

async function acquireUserDreamLock(): Promise<void> {
  await fs.writeFile(
    getUserAutoMemoryConsolidationLockPath(),
    String(process.pid),
    { flag: 'wx' },
  );
}

async function releaseUserDreamLock(): Promise<void> {
  await fs.rm(getUserAutoMemoryConsolidationLockPath(), { force: true });
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
  // Subscribers without a taskType filter receive every notify; those
  // with a filter receive only notifies whose changed record matches
  // (extract OR dream). Filtered subscribers exist so high-frequency
  // consumers (e.g. the bg-tasks UI hook, which only cares about
  // dream) can skip the per-extract O(n) work that would otherwise
  // run on every UserQuery.
  private readonly subscribers = new Set<() => void>();
  private readonly subscribersByType = new Map<
    MemoryTaskRecord['taskType'],
    Set<() => void>
  >();
  // ── In-flight promises (for drain) ──────────────────────────────────────────
  private readonly inFlight = new Map<string, Promise<unknown>>();

  // ── Extract scheduling state ─────────────────────────────────────────────────
  private readonly extractRunning = new Set<string>();
  private readonly extractCurrentTaskId = new Map<string, string>();
  private readonly extractQueued = new Map<
    string,
    { taskId: string; params: ScheduleExtractParams }
  >();

  // ── Skill-review in-flight dedup ─────────────────────────────────────────────
  private readonly skillReviewInFlightByProject = new Map<string, string>();

  // ── Dream scheduling state ───────────────────────────────────────────────────
  private readonly dreamInFlightByKey = new Map<string, string>();
  private readonly dreamLastSessionScanAt = new Map<string, number>();
  // AbortControllers for in-flight dream tasks, keyed by record id.
  // cancelTask() looks up the controller, aborts it (the abort signal
  // propagates into runForkedAgent), and marks the record cancelled.
  // The runDream finally block clears the entry on settle.
  private readonly dreamAbortControllers = new Map<string, AbortController>();
  private readonly migrationInFlightByDomain = new Map<string, string>();
  private readonly migrationAbortControllers = new Map<
    string,
    AbortController
  >();
  // Set to true when releaseDreamLock() throws (e.g., Windows EPERM,
  // ENOENT race, disk full). The lock file is then left on disk and
  // dreamLockExists() sees a fresh-mtime lock owned by a still-alive
  // PID (us!), suppressing every subsequent scheduleDream() call as
  // `{status: 'skipped', skippedReason: 'locked'}` — invisible to the
  // user once the surfacing UI just shows "Lock release failed" without
  // re-firing. Setting this flag tells the next scheduleDream() to
  // force-clean the leaked lock file before the existence check, so
  // scheduling resumes within the same session instead of waiting for
  // next session start's staleness sweep.
  private dreamLockReleaseFailed = false;
  private userDreamLockReleaseFailed = false;
  private readonly sessionScanner: SessionScannerFn;
  private readonly bodyPresentVersionsInHistory = new Map<string, number>();
  private readonly bodyCoverageInHistory = new Map<
    string,
    MemoryBodyCoverage
  >();
  private readonly exhaustedBodyRefsInCurrentTurn = new Set<string>();
  private readonly searchMemoryRequestsInCurrentTurn = new Set<string>();

  constructor(sessionScanner: SessionScannerFn = defaultSessionScanner) {
    this.sessionScanner = sessionScanner;
  }
  // ─── Subscribe ───────────────────────────────────────────────────────────────────

  /**
   * Register a listener that is called whenever any task record changes.
   * Compatible with React’s `useSyncExternalStore`.
   * Returns an unsubscribe function.
   *
   * Pass `{ taskType: 'dream' }` (or `'extract'`) to receive only
   * notifies whose changed record matches that type. Filtered
   * subscribers skip the wakeup entirely for unrelated transitions —
   * the dream-only UI hook uses this to avoid doing O(n) signature
   * work on every per-UserQuery extract notify.
   */
  subscribe(
    listener: () => void,
    opts?: { taskType?: MemoryTaskRecord['taskType'] },
  ): () => void {
    if (opts?.taskType) {
      const type = opts.taskType;
      let set = this.subscribersByType.get(type);
      if (!set) {
        set = new Set();
        this.subscribersByType.set(type, set);
      }
      set.add(listener);
      return () => {
        set!.delete(listener);
        // Drop the Map entry when the per-type bucket is empty so the
        // long-lived MemoryManager doesn't accumulate empty Sets across
        // repeated subscribe/unsubscribe cycles (e.g. React mount /
        // unmount in the bg-tasks UI hook).
        if (set!.size === 0) this.subscribersByType.delete(type);
      };
    }
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  /**
   * Notify subscribers. Pass the changed task's type so type-filtered
   * subscribers can be reached too; the unfiltered subscriber set
   * always receives the wakeup either way.
   */
  private notify(taskType?: MemoryTaskRecord['taskType']): void {
    for (const fn of this.subscribers) fn();
    if (taskType) {
      const typed = this.subscribersByType.get(taskType);
      if (typed) for (const fn of typed) fn();
    }
  }

  /** Update a record and notify subscribers. */
  private update(
    record: MemoryTaskRecord,
    patch: Partial<
      Pick<MemoryTaskRecord, 'status' | 'progressText' | 'error' | 'metadata'>
    >,
  ): void {
    updateRecord(record, patch);
    this.notify(record.taskType);
  }

  /**
   * Register a brand-new record in the task map and notify once.
   * Use this for records that start in 'pending' and need no immediate patch.
   */
  private store(record: MemoryTaskRecord): void {
    this.tasks.set(record.id, record);
    this.notify(record.taskType);
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
    this.notify(record.taskType);
  }
  // ─── Task record query ────────────────────────────────────────────────────────

  /** Return task records filtered by type and optionally by projectRoot. */
  listTasksByType(
    taskType: MemoryTaskRecord['taskType'],
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

  async scheduleMetadataMigration(
    params: ScheduleMetadataMigrationParams,
  ): Promise<MetadataMigrationScheduleResult> {
    if (this.isUnderMemoryPressure(params.config)) {
      return { status: 'skipped', skippedReason: 'memory_pressure' };
    }
    const root =
      params.scope === 'project'
        ? getAutoMemoryRoot(params.projectRoot)
        : params.scope === 'user'
          ? getUserAutoMemoryRoot()
          : getTeamAutoMemoryRoot(params.projectRoot);
    const roots =
      params.scope === 'project'
        ? getProjectMetadataMigrationRoots(params.projectRoot)
        : [root];
    if (
      (
        await Promise.all(
          roots.map((candidateRoot) =>
            scanMemoryMetadataMigrationCandidates(candidateRoot, params.scope),
          ),
        )
      ).every((candidates) => candidates.length === 0)
    ) {
      return { status: 'skipped', skippedReason: 'complete' };
    }
    const domain = `${params.scope}:${root}`;
    const existingId = this.migrationInFlightByDomain.get(domain);
    if (existingId || activeMigrationDomains.has(domain)) {
      return {
        status: 'skipped',
        skippedReason: 'running',
        ...(existingId ? { taskId: existingId } : {}),
      };
    }

    const record = makeTaskRecord('migration', params.projectRoot);
    const abortController = new AbortController();
    this.migrationAbortControllers.set(record.id, abortController);
    this.migrationInFlightByDomain.set(domain, record.id);
    activeMigrationDomains.add(domain);
    this.storeWith(record, {
      status: 'running',
      progressText: `Migrating ${params.scope} memory metadata.`,
      metadata: { scope: params.scope },
    });
    const promise = this.track(
      record.id,
      this.runMetadataMigration(
        record,
        domain,
        roots,
        params,
        abortController.signal,
      ),
    );
    return { status: 'scheduled', taskId: record.id, promise };
  }

  private async runMetadataMigration(
    record: MemoryTaskRecord,
    domain: string,
    roots: readonly string[],
    params: ScheduleMetadataMigrationParams,
    abortSignal: AbortSignal,
  ): Promise<MemoryTaskRecord> {
    const startedAt = Date.now();
    try {
      const result = await runMemoryMetadataMigration({
        config: params.config,
        projectRoot: params.projectRoot,
        roots,
        scope: params.scope,
        abortSignal,
      });
      if (abortSignal.aborted || record.status === 'cancelled') {
        logMemoryMigration(
          params.config,
          new MemoryMigrationEvent({
            scope: params.scope,
            status: 'cancelled',
            files_scanned: result.filesScanned,
            legacy_files: result.legacyFiles,
            remaining_legacy_files: result.remainingLegacyFiles,
            batch_files: result.attempted,
            committed: result.committed,
            conflicts: result.conflicts,
            failed: result.failed,
            agent_duration_ms: result.agentDurationMs,
            input_tokens: result.inputTokens,
            output_tokens: result.outputTokens,
            total_tokens: result.totalTokens,
            duration_ms: Date.now() - startedAt,
          }),
        );
        return record;
      }
      this.update(record, {
        status: 'completed',
        progressText: `Migrated ${result.committed} memory file(s).`,
        metadata: { scope: params.scope, ...result },
      });
      logMemoryMigration(
        params.config,
        new MemoryMigrationEvent({
          scope: params.scope,
          status: 'completed',
          files_scanned: result.filesScanned,
          legacy_files: result.legacyFiles,
          remaining_legacy_files: result.remainingLegacyFiles,
          batch_files: result.attempted,
          committed: result.committed,
          conflicts: result.conflicts,
          failed: result.failed,
          agent_duration_ms: result.agentDurationMs,
          input_tokens: result.inputTokens,
          output_tokens: result.outputTokens,
          total_tokens: result.totalTokens,
          duration_ms: Date.now() - startedAt,
        }),
      );
    } catch (error) {
      if (abortSignal.aborted && record.status === 'cancelled') {
        logMemoryMigration(
          params.config,
          new MemoryMigrationEvent({
            scope: params.scope,
            status: 'cancelled',
            files_scanned: 0,
            legacy_files: 0,
            remaining_legacy_files: 0,
            batch_files: 0,
            committed: 0,
            conflicts: 0,
            failed: 0,
            agent_duration_ms: 0,
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
            duration_ms: Date.now() - startedAt,
          }),
        );
        return record;
      }
      this.update(record, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      logMemoryMigration(
        params.config,
        new MemoryMigrationEvent({
          scope: params.scope,
          status: 'failed',
          files_scanned: 0,
          legacy_files: 0,
          remaining_legacy_files: 0,
          batch_files: 0,
          committed: 0,
          conflicts: 0,
          failed: 1,
          agent_duration_ms: 0,
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          duration_ms: Date.now() - startedAt,
        }),
      );
    } finally {
      this.migrationAbortControllers.delete(record.id);
      this.migrationInFlightByDomain.delete(domain);
      activeMigrationDomains.delete(domain);
    }
    return record;
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
    const wroteUserMemory = latestHistoryWritesToUserMemory(params.history);
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
      if (wroteUserMemory && params.config) {
        await this.recordUserMutation(
          params.projectRoot,
          params.config,
          params.now ?? new Date(),
        );
      }
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

  /**
   * True when the runtime is under hard or critical memory pressure, as
   * reported by the shared MemoryPressureMonitor (#5147). The monitor is
   * cgroup-aware and compares RSS/heap against their actual limits as a
   * ratio, so this adapts to `--max-old-space-size`, containers, and large
   * hosts alike — unlike an absolute megabyte threshold. Returns false when
   * no monitor is wired (e.g. unit tests, headless), so extraction proceeds
   * normally in those contexts.
   */
  private isUnderMemoryPressure(config?: Config): boolean {
    const level = config?.getMemoryPressureMonitor?.()?.getPressureLevel?.();
    return level === 'hard' || level === 'critical';
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
      // Memory-pressure gate. Checked inside try so the finally block
      // always runs — extractRunning/extractCurrentTaskId are cleaned up
      // and startQueuedExtract is called regardless of the gate outcome.
      if (this.isUnderMemoryPressure(params.config)) {
        debugLogger.warn('Skipping extract: memory pressure too high.');
        this.update(record, {
          status: 'skipped',
          progressText: 'Skipped: memory pressure too high for extraction.',
          metadata: { skippedReason: 'memory_pressure' },
        });
        if (params.config) {
          logMemoryExtract(
            params.config,
            new MemoryExtractEvent({
              trigger: 'auto',
              status: 'skipped',
              skipped_reason: 'memory_pressure',
              patches_count: 0,
              touched_topics: [],
              duration_ms: 0,
            }),
          );
        }
        return {
          touchedTopics: [],
          skippedReason: 'memory_pressure' as const,
          cursor: {
            sessionId: params.sessionId,
            updatedAt: (params.now ?? new Date()).toISOString(),
          },
        };
      }

      const result = await runAutoMemoryExtract(params);
      if (result.touchedUserScope && params.config) {
        await this.recordUserMutation(
          params.projectRoot,
          params.config,
          params.now ?? new Date(),
        );
      }
      const durationMs = Date.now() - t0;
      const skippedReason = result.skippedReason;
      const status = skippedReason ? 'skipped' : 'completed';
      this.update(record, {
        status,
        progressText:
          result.systemMessage ??
          (skippedReason
            ? `Skipped: ${skippedReason.replaceAll('_', ' ')}.`
            : result.touchedTopics.length > 0
              ? `Managed auto-memory updated: ${result.touchedTopics.join(', ')}.`
              : 'Managed auto-memory extraction completed without durable changes.'),
        metadata: {
          touchedTopics: result.touchedTopics,
          processedOffset: result.cursor.processedOffset,
          skippedReason,
        },
      });
      if (params.config) {
        logMemoryExtract(
          params.config,
          new MemoryExtractEvent({
            trigger: 'auto',
            status,
            ...(skippedReason ? { skipped_reason: skippedReason } : {}),
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

  // ─── Skill review ─────────────────────────────────────────────────────────────

  scheduleSkillReview(
    params: ScheduleSkillReviewParams,
  ): SkillReviewScheduleResult {
    if (params.enabled === false) {
      return { status: 'skipped', skippedReason: 'disabled' };
    }

    if (params.skillsModified) {
      return { status: 'skipped', skippedReason: 'skills_modified_in_session' };
    }

    const threshold = params.threshold ?? AUTO_SKILL_THRESHOLD;
    if (params.toolCallCount < threshold) {
      return { status: 'skipped', skippedReason: 'below_threshold' };
    }

    if (!params.config) {
      return { status: 'skipped', skippedReason: 'disabled' };
    }

    const existingTaskId = this.skillReviewInFlightByProject.get(
      params.projectRoot,
    );
    if (existingTaskId) {
      return {
        status: 'skipped',
        skippedReason: 'already_running',
        taskId: existingTaskId,
      };
    }

    const record = makeTaskRecord(
      'skill-review',
      params.projectRoot,
      params.sessionId,
    );
    this.storeWith(record, {
      status: 'running',
      progressText: 'Running managed skill review.',
      metadata: {
        historyLength: params.history.length,
        toolCallCount: params.toolCallCount,
        threshold,
      },
    });

    const promise = this.track(record.id, this.runSkillReview(record, params));
    return { status: 'scheduled', taskId: record.id, promise };
  }

  private async runSkillReview(
    record: MemoryTaskRecord,
    params: ScheduleSkillReviewParams,
  ): Promise<MemoryTaskRecord> {
    this.skillReviewInFlightByProject.set(params.projectRoot, record.id);

    try {
      // Memory-pressure gate — inside try so finally always cleans up
      // the skillReviewInFlightByProject entry.
      if (this.isUnderMemoryPressure(params.config)) {
        this.update(record, {
          status: 'skipped',
          progressText: 'Skipped: memory pressure too high.',
          metadata: { skippedReason: 'memory_pressure' },
        });
        debugLogger.warn('Skipping skill review: memory pressure too high.');
        return record;
      }

      // Snapshot existing skill dirs BEFORE the agent runs so staging can tell
      // newly-created skills from in-place edits of already-confirmed ones
      // (only new skills should enter the confirmation flow).
      const preExistingSkillDirs = params.confirmBeforePersist
        ? new Set(await listExistingSkillDirNames(params.projectRoot))
        : undefined;

      const result = await runSkillReviewByAgent({
        config: params.config!,
        projectRoot: params.projectRoot,
        history: params.history,
        maxTurns: params.maxTurns,
        timeoutMs: params.timeoutMs,
      });

      if (params.confirmBeforePersist && result.touchedSkillFiles.length > 0) {
        const pending = await stageSkillDirs(
          result.touchedSkillFiles,
          params.projectRoot,
          preExistingSkillDirs,
          record.id,
        );
        this.update(record, {
          status: 'completed',
          progressText:
            pending.length > 0
              ? `${pending.length} skill(s) awaiting review.`
              : (result.systemMessage ??
                'Managed skill review completed without durable changes.'),
          metadata: {
            touchedSkillFiles: result.touchedSkillFiles,
            ...(pending.length > 0 ? { pendingSkills: pending } : {}),
          },
        });
      } else {
        this.update(record, {
          status: 'completed',
          progressText:
            result.systemMessage ??
            'Managed skill review completed without durable changes.',
          metadata: { touchedSkillFiles: result.touchedSkillFiles },
        });
      }
    } catch (error) {
      this.update(record, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.skillReviewInFlightByProject.delete(params.projectRoot);
    }
    return record;
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
    // `params.config` is optional only because some test paths omit it;
    // production callers always pass it. Without a config the
    // fork-agent execution can't start (`runManagedAutoMemoryDream`
    // throws). Skip early so a missing-config call doesn't surface a
    // failed dream entry in the bg-tasks dialog.
    if (!params.config || !params.config.getManagedAutoDreamEnabled()) {
      return { status: 'skipped', skippedReason: 'disabled' };
    }

    // Also skip dream under memory pressure — dream does its own
    // structuredClone of full history, and shouldn't add extra pressure
    // when the heap is already under hard/critical load.
    if (this.isUnderMemoryPressure(params.config)) {
      debugLogger.warn('Skipping dream: memory pressure too high.');
      return { status: 'skipped', skippedReason: 'memory_pressure' };
    }
    if (
      (
        await Promise.all(
          getProjectMetadataMigrationRoots(params.projectRoot).map((root) =>
            scanMemoryMetadataMigrationCandidates(root, 'project'),
          ),
        )
      ).some((candidates) => candidates.length > 0)
    ) {
      return { status: 'skipped', skippedReason: 'migration_pending' };
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

    // If the previous dream's release failed (lockReleaseError surfaced
    // on the dialog), the lock file is still on disk and dreamLockExists()
    // would silently suppress every subsequent dream until next process
    // start. Force-clean it here so the same session recovers.
    if (this.dreamLockReleaseFailed) {
      await fs
        .rm(getAutoMemoryConsolidationLockPath(params.projectRoot), {
          force: true,
        })
        .catch(() => {
          // Best-effort recovery — if even the forced rm fails (truly
          // unrecoverable filesystem state), fall through and let the
          // existence check below report 'locked' as before.
        });
      this.dreamLockReleaseFailed = false;
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
    // Register the AbortController BEFORE storeWith. storeWith fires
    // a notify which can synchronously call cancelTask via subscribers
    // (e.g. a UI listener). If the controller isn't in
    // `dreamAbortControllers` by then, cancelTask falls into the
    // missing-controller defensive warn-and-return-false path and the
    // model gets a phantom failure on a brand-new dream. Registering
    // first means any reentrant cancel sees a complete state.
    const abortController = new AbortController();
    this.dreamAbortControllers.set(record.id, abortController);
    this.dreamInFlightByKey.set(dedupeKey, record.id);
    this.storeWith(record, {
      status: 'running',
      // Set the initial progressText so the dialog's Progress section
      // has something to show during the in-flight window — fork-agent
      // execution exposes no per-turn callback today, so without this
      // the section stays empty until completion.
      progressText: 'Scheduled managed auto-memory dream.',
      metadata: { sessionCount: sessionIds.length },
    });

    const promise = this.track(
      record.id,
      this.runDream(record, dedupeKey, params, now, abortController.signal),
    );

    return { status: 'scheduled', taskId: record.id, promise };
  }

  async scheduleUserDream(
    params: ScheduleUserDreamParams,
  ): Promise<UserDreamScheduleResult> {
    if (!params.config || !params.config.getManagedAutoDreamEnabled()) {
      return { status: 'skipped', skippedReason: 'disabled' };
    }
    if (this.isUnderMemoryPressure(params.config)) {
      return { status: 'skipped', skippedReason: 'memory_pressure' };
    }
    if (
      (
        await scanMemoryMetadataMigrationCandidates(
          getUserAutoMemoryRoot(),
          'user',
        )
      ).length > 0
    ) {
      return { status: 'skipped', skippedReason: 'migration_pending' };
    }

    const now = params.now ?? new Date();
    const metadata = await readUserAutoMemoryMetadata(now);
    if (!metadata.pendingReason) {
      return { status: 'skipped', skippedReason: 'not_pending' };
    }
    const elapsed = hoursSince(metadata.lastDreamAt, now);
    if (
      elapsed !== null &&
      elapsed < (params.minHoursBetweenDreams ?? DEFAULT_USER_DREAM_MIN_HOURS)
    ) {
      return { status: 'skipped', skippedReason: 'min_hours' };
    }

    const lockPath = getUserAutoMemoryConsolidationLockPath();
    if (this.userDreamLockReleaseFailed) {
      await fs.rm(lockPath, { force: true }).catch(() => {});
      this.userDreamLockReleaseFailed = false;
    }
    if (await dreamLockExistsAt(lockPath)) {
      return { status: 'skipped', skippedReason: 'locked' };
    }

    const dedupeKey = USER_DREAM_TASK_TYPE;
    const existingId = this.dreamInFlightByKey.get(dedupeKey);
    if (existingId) {
      return {
        status: 'skipped',
        skippedReason: 'running',
        taskId: existingId,
      };
    }

    const record = makeTaskRecord('dream', getUserAutoMemoryRoot());
    const abortController = new AbortController();
    this.dreamAbortControllers.set(record.id, abortController);
    this.dreamInFlightByKey.set(dedupeKey, record.id);
    this.storeWith(record, {
      status: 'running',
      progressText: 'Scheduled global User Memory dream.',
      metadata: {
        scope: 'user',
        dirtyMutations: metadata.dirtyMutations,
        schedulingReason: metadata.pendingReason,
      },
    });

    const promise = this.track(
      record.id,
      this.runUserDream(record, dedupeKey, params, now, abortController.signal),
    );
    return { status: 'scheduled', taskId: record.id, promise };
  }

  /**
   * Look up a single task record by id. Used by `task_stop` and other
   * cross-cutting consumers that have a task id but no project root.
   */
  getTask(taskId: string): MemoryTaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  /** Promote one staged skill (by dir name) for the given skill-review task. */
  async acceptPendingSkillFromTask(
    taskId: string,
    skillName: string,
  ): Promise<void> {
    await this.resolvePendingSkill(taskId, skillName, 'accept');
  }

  /** Discard one staged skill (by dir name) for the given skill-review task. */
  async rejectPendingSkillFromTask(
    taskId: string,
    skillName: string,
  ): Promise<void> {
    await this.resolvePendingSkill(taskId, skillName, 'reject');
  }

  private async resolvePendingSkill(
    taskId: string,
    skillName: string,
    action: 'accept' | 'reject',
  ): Promise<void> {
    const record = this.tasks.get(taskId);
    if (!record) {
      debugLogger.warn(`Cannot resolve pending skill: no task ${taskId}.`);
      return;
    }
    const target = (
      (record.metadata?.['pendingSkills'] as PendingSkill[]) ?? []
    ).find((p) => p.name === skillName);
    if (!target) {
      debugLogger.warn(
        `Cannot resolve pending skill "${skillName}": not pending on task ${taskId}.`,
      );
      return;
    }
    try {
      if (action === 'accept') {
        await acceptPendingSkill(target);
      } else {
        await rejectPendingSkill(target);
      }
    } catch (error) {
      // Leave the skill in pendingSkills so the user can retry, and surface the
      // failure instead of silently dropping it.
      debugLogger.warn(
        `Failed to ${action} pending skill "${skillName}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw error;
    }
    // Re-read pendingSkills AFTER the await: concurrent Keep-all/Discard-all
    // calls each remove only their own entry. read+filter+update runs with no
    // intervening await, so it is atomic under the single-threaded event loop.
    const remaining = (
      (record.metadata?.['pendingSkills'] as PendingSkill[]) ?? []
    ).filter((p) => p.name !== skillName);
    this.update(record, { metadata: { pendingSkills: remaining } });
  }

  /**
   * Cancel a running dream or migration task. Aborts the fork agent (the
   * abort signal threads through `runForkedAgent`), marks the record
   * cancelled immediately so the UI reflects user intent, and lets the
   * existing `runDream` finally block release the consolidation lock
   * via the natural error propagation path.
   *
   * Returns true if a running task was aborted, false if the task is
   * unknown / already terminal / unsupported. Extract is short-lived and runs
   * synchronously through the request loop; cancelling it would
   * interfere with the user's own turn.
   */
  cancelTask(taskId: string): boolean {
    const record = this.tasks.get(taskId);
    if (!record) return false;
    if (record.taskType !== 'dream' && record.taskType !== 'migration') {
      return false;
    }
    if (record.status !== 'running') return false;

    // The AbortController is registered synchronously alongside the
    // status='running' transition in scheduleDream and only cleared in
    // runDream's finally block (which only runs after a terminal
    // status transition has already happened). So under normal flow
    // an entry that is `running` MUST have a controller. Treat the
    // missing-controller case as a contract violation: don't flip
    // status (a cancelled record without an aborted fork would leak
    // the consolidation lock until the agent finishes naturally) and
    // return false so the caller knows the abort didn't take. Log at
    // warn level so the inconsistency is observable in debug bundles
    // — silent failure here would leave a runaway dream burning tokens
    // with no signal to the user or to telemetry.
    const ac =
      record.taskType === 'dream'
        ? this.dreamAbortControllers.get(taskId)
        : this.migrationAbortControllers.get(taskId);
    if (!ac) {
      debugLogger.warn(
        `cancelTask: AbortController missing for running ${record.taskType} task ${taskId}; ` +
          `not flipping status. This indicates a logic bug — the controller ` +
          `should have been registered in scheduleDream and only cleared ` +
          `after a terminal status transition.`,
      );
      return false;
    }

    // Mark cancelled BEFORE aborting so the runDream catch path can
    // detect the user-cancel intent (signal.aborted + status already
    // 'cancelled') and avoid overwriting with a generic 'failed'.
    this.update(record, {
      status: 'cancelled',
      progressText: 'Cancelled by user.',
    });
    ac.abort();
    return true;
  }

  cancelMigrations(): void {
    for (const taskId of [...this.migrationAbortControllers.keys()]) {
      this.cancelTask(taskId);
    }
  }

  private async runDream(
    record: MemoryTaskRecord,
    dedupeKey: string,
    params: ScheduleDreamParams,
    now: Date,
    abortSignal: AbortSignal,
  ): Promise<MemoryTaskRecord> {
    const dreamStartMs = Date.now();
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
          abortSignal,
        );
        // Defense-in-depth: runForkedAgent maps cancelled fork-agents
        // to a resolved `{status: 'cancelled'}` rather than a rejection.
        // dreamAgentPlanner now rethrows that case so the catch path
        // below handles it, but if anything in the call chain ever
        // forgets to propagate, this guard prevents the success path
        // from clobbering the user-cancelled record with 'completed'
        // and bumping dream metadata for an aborted run.
        if (abortSignal.aborted) {
          return record;
        }

        // Atomic-from-cancel sequence: flip status='completed' BEFORE
        // any scheduler-gating metadata write. Once status is no
        // longer 'running', cancelTask refuses, so the writeFile that
        // follows can't race a flip-to-cancelled. The cancel-raced-
        // status-update branch below covers the remaining window
        // (cancel landed between the pre-update check and the
        // synchronous update).
        this.update(record, {
          status: 'completed',
          progressText:
            result.systemMessage ?? 'Managed auto-memory dream completed.',
          metadata: {
            touchedTopics: result.touchedTopics,
            createdEntries: result.createdEntries,
            updatedEntries: result.updatedEntries,
            deletedEntries: result.deletedEntries,
            dedupedEntries: result.dedupedEntries,
            splitEntries: result.splitEntries,
            keywordBackfilled: result.keywordBackfilled,
            lastDreamAt: now.toISOString(),
          },
        });
        if (abortSignal.aborted) {
          // Defense-in-depth: unreachable today (no `await` between
          // the pre-update check and the synchronous update above,
          // so JS's single-threaded execution prevents
          // `signal.aborted` from transitioning between them — a
          // cancelTask landing inside the storeWith notify would
          // already have flipped status, and our update would have
          // raced ahead of it to 'completed'). Kept against a future
          // refactor that introduces an `await` between the two
          // checks. Preserves the touched-topic metadata on the
          // restored cancelled record so the user can still tell
          // memory files were modified before the abort took.
          this.update(record, {
            status: 'cancelled',
            progressText: 'Cancelled after memory changes.',
            metadata: {
              touchedTopics: result.touchedTopics,
              createdEntries: result.createdEntries,
              updatedEntries: result.updatedEntries,
              deletedEntries: result.deletedEntries,
              dedupedEntries: result.dedupedEntries,
              splitEntries: result.splitEntries,
              keywordBackfilled: result.keywordBackfilled,
            },
          });
          return record;
        }
        // Status is now 'completed'; cancelTask will refuse from
        // here on out. Safe to write scheduler-gating metadata
        // without a race window.
        //
        // Wrap the read/write in a try/catch — pre-PR `bumpMetadata`
        // in dream.ts swallowed errors as best-effort; without this
        // wrap a transient ENOENT / EPERM on the metadata file would
        // propagate to the outer catch and overwrite a
        // legitimately-completed dream with `'failed'`. The dream
        // already did its work (touched files are on disk and
        // visible). Trade-off: the next dream cycle won't see a
        // bumped lastDreamAt and may re-fire — same trade as the
        // original best-effort behavior.
        try {
          const nextMetadata = await readDreamMetadata(params.projectRoot);
          nextMetadata.lastDreamAt = now.toISOString();
          nextMetadata.lastDreamSessionId = params.sessionId;
          nextMetadata.updatedAt = now.toISOString();
          nextMetadata.lastDreamTouchedTopics = result.touchedTopics;
          nextMetadata.lastDreamStatus =
            result.touchedTopics.length > 0 ? 'updated' : 'noop';
          // Mirror the manual /dream path's reset so the two write
          // sites don't drift. The field is currently dead code on
          // main (only ever written, never read) but keeping the two
          // paths in sync avoids surprises if a future change starts
          // reading it.
          nextMetadata.recentSessionIdsSinceDream = [];
          await writeDreamMetadata(params.projectRoot, nextMetadata);
        } catch (metaError) {
          const message =
            metaError instanceof Error ? metaError.message : String(metaError);
          debugLogger.warn(
            `Failed to persist dream gating metadata for ${record.id}: ${message}`,
          );
          this.update(record, {
            metadata: { metadataWriteError: message },
          });
        }
      } finally {
        // Lock release errors are logged AND surfaced on the record's
        // metadata so the user can see why subsequent dreams may be
        // skipped as 'locked'. If releasing throws (e.g., EPERM on
        // Windows, ENOENT race), letting it propagate to the outer
        // catch would overwrite a successfully-completed dream with
        // 'failed'. The on-disk lock will be cleaned up on the next
        // session start via the staleness sweep, so swallowing the
        // error here doesn't risk a permanently-stuck lock.
        try {
          await releaseDreamLock(params.projectRoot);
        } catch (lockError) {
          const message =
            lockError instanceof Error ? lockError.message : String(lockError);
          debugLogger.warn(
            `Failed to release dream lock for task ${record.id}: ${message}. ` +
              `Next scheduleDream() will force-clean the leaked lock.`,
          );
          this.dreamLockReleaseFailed = true;
          this.update(record, {
            metadata: { lockReleaseError: message },
          });
        }
      }
    } catch (error) {
      // User-cancel path: cancelTask already aborted the signal AND
      // marked the record cancelled. The fork agent throws an abort
      // error which lands here; don't overwrite with 'failed'.
      if (abortSignal.aborted && record.status === 'cancelled') {
        if (params.config) {
          logMemoryDream(
            params.config,
            new MemoryDreamEvent({
              trigger: 'auto',
              status: 'cancelled',
              deduped_entries: 0,
              touched_topics: [],
              // Real elapsed time the cancelled dream consumed before
              // the user stopped it — without this, latency histograms
              // / p95 metrics would silently treat cancelled dreams as
              // 0ms and skew toward the success path.
              duration_ms: Date.now() - dreamStartMs,
            }),
          );
        }
        return record;
      }
      this.update(record, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      if (params.config) {
        logMemoryDream(
          params.config,
          new MemoryDreamEvent({
            trigger: 'auto',
            status: 'failed',
            deduped_entries: 0,
            touched_topics: [],
            duration_ms: Date.now() - dreamStartMs,
          }),
        );
      }
    } finally {
      this.dreamInFlightByKey.delete(dedupeKey);
      this.dreamAbortControllers.delete(record.id);
    }
    return record;
  }

  async recordUserMutation(
    projectRoot: string,
    config: Config,
    now = new Date(),
  ): Promise<void> {
    try {
      const state = await recordUserAutoMemoryMutation(now);
      if (state.metadata.pendingReason) {
        await this.scheduleUserDream({ projectRoot, config, now });
      }
    } catch (error) {
      debugLogger.warn('Failed to update User Dream state:', error);
    }
  }

  private async runUserDream(
    record: MemoryTaskRecord,
    dedupeKey: string,
    params: ScheduleUserDreamParams,
    now: Date,
    abortSignal: AbortSignal,
  ): Promise<MemoryTaskRecord> {
    const startedAt = Date.now();
    let lockAcquired = false;
    let dirtyAtStart = 0;
    try {
      try {
        await acquireUserDreamLock();
        lockAcquired = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          this.update(record, {
            status: 'skipped',
            progressText: 'Skipped User Memory dream: global lock exists.',
            metadata: { skippedReason: 'locked' },
          });
          return record;
        }
        throw error;
      }

      const runningMetadata = await markUserAutoMemoryDreamRunning(now);
      dirtyAtStart = runningMetadata.dirtyMutations;
      const result = await runManagedUserAutoMemoryDream(
        params.projectRoot,
        now,
        params.config!,
        abortSignal,
      );
      if (abortSignal.aborted) {
        throw new Error('User Memory dream cancelled.');
      }

      this.update(record, {
        status: 'completed',
        progressText:
          result.systemMessage ?? 'Global User Memory dream completed.',
        metadata: {
          scope: 'user',
          touchedTopics: result.touchedTopics,
          createdEntries: result.createdEntries,
          updatedEntries: result.updatedEntries,
          deletedEntries: result.deletedEntries,
          dedupedEntries: result.dedupedEntries,
          splitEntries: result.splitEntries,
          keywordBackfilled: result.keywordBackfilled,
        },
      });
      try {
        const metadata = await completeUserAutoMemoryDream(
          dirtyAtStart,
          result,
          now,
        );
        this.update(record, {
          metadata: {
            dirtyMutations: metadata.dirtyMutations,
            userDreamStatus: metadata.status,
            pendingReason: metadata.pendingReason,
            lastDreamAt: metadata.lastDreamAt,
          },
        });
        logMemoryDream(
          params.config!,
          new MemoryDreamEvent({
            trigger: 'auto',
            scope: 'user',
            status: result.touchedTopics.length > 0 ? 'updated' : 'noop',
            created_entries: result.createdEntries,
            updated_entries: result.updatedEntries,
            deleted_entries: result.deletedEntries,
            deduped_entries: result.dedupedEntries,
            split_entries: result.splitEntries,
            keyword_backfilled: result.keywordBackfilled,
            dirty_mutations: dirtyAtStart,
            scheduling_reason: runningMetadata.pendingReason,
            touched_topics: result.touchedTopics,
            duration_ms: Date.now() - startedAt,
          }),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        debugLogger.warn('Failed to persist User Dream metadata:', error);
        this.update(record, { metadata: { metadataWriteError: message } });
        throw new Error(`Failed to persist User Dream completion: ${message}`);
      }
    } catch (error) {
      const cancelled = abortSignal.aborted && record.status === 'cancelled';
      if (!cancelled) {
        this.update(record, {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await failUserAutoMemoryDream(
        cancelled ? 'cancelled' : 'failed',
        now,
      ).catch((metadataError: unknown) => {
        debugLogger.warn(
          'Failed to persist failed User Dream state:',
          metadataError,
        );
      });
      if (params.config) {
        logMemoryDream(
          params.config,
          new MemoryDreamEvent({
            trigger: 'auto',
            scope: 'user',
            dirty_mutations: dirtyAtStart,
            scheduling_reason:
              typeof record.metadata?.['schedulingReason'] === 'string'
                ? record.metadata['schedulingReason']
                : undefined,
            status: cancelled ? 'cancelled' : 'failed',
            deduped_entries: 0,
            touched_topics: [],
            duration_ms: Date.now() - startedAt,
          }),
        );
      }
    } finally {
      if (lockAcquired) {
        try {
          await releaseUserDreamLock();
        } catch (error) {
          this.userDreamLockReleaseFailed = true;
          const message =
            error instanceof Error ? error.message : String(error);
          this.update(record, { metadata: { lockReleaseError: message } });
        }
      }
      this.dreamInFlightByKey.delete(dedupeKey);
      this.dreamAbortControllers.delete(record.id);
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

  getBodyPresentVersionsInHistory(): Map<string, number> {
    return this.bodyPresentVersionsInHistory;
  }

  getBodyCoverageInHistory(): Map<string, MemoryBodyCoverage> {
    return this.bodyCoverageInHistory;
  }

  markMemoryBodiesEvictedFromHistory(
    bodies: ReadonlyArray<{ memoryRef: string; mtimeMs: number }>,
  ): void {
    for (const { memoryRef, mtimeMs } of bodies) {
      const coverage = this.bodyCoverageInHistory.get(memoryRef);
      if (coverage?.version === mtimeMs) {
        this.bodyCoverageInHistory.delete(memoryRef);
      }
      if (this.bodyPresentVersionsInHistory.get(memoryRef) === mtimeMs) {
        this.bodyPresentVersionsInHistory.delete(memoryRef);
      }
    }
  }

  markAllMemoryBodiesEvictedFromHistory(): void {
    this.bodyPresentVersionsInHistory.clear();
    this.bodyCoverageInHistory.clear();
  }

  restoreMemoryBodiesPresentInHistory(
    bodies: ReadonlyArray<{ memoryRef: string; mtimeMs: number }>,
  ): void {
    this.bodyPresentVersionsInHistory.clear();
    this.bodyCoverageInHistory.clear();
    for (const { memoryRef, mtimeMs } of bodies) {
      this.bodyPresentVersionsInHistory.set(memoryRef, mtimeMs);
    }
  }

  getExhaustedBodyRefsForCurrentTurn(): Set<string> {
    return this.exhaustedBodyRefsInCurrentTurn;
  }

  claimSearchMemoryRequestForCurrentTurn(signature: string): boolean {
    if (this.searchMemoryRequestsInCurrentTurn.has(signature)) return false;
    this.searchMemoryRequestsInCurrentTurn.add(signature);
    return true;
  }

  releaseSearchMemoryRequestForCurrentTurn(signature: string): void {
    this.searchMemoryRequestsInCurrentTurn.delete(signature);
  }

  resetExhaustedBodyRefsForCurrentTurn(): void {
    this.exhaustedBodyRefsInCurrentTurn.clear();
    this.searchMemoryRequestsInCurrentTurn.clear();
  }

  resetMemoryBodyStateForSession(): void {
    this.bodyPresentVersionsInHistory.clear();
    this.bodyCoverageInHistory.clear();
    this.resetExhaustedBodyRefsForCurrentTurn();
  }

  // ─── Forget ───────────────────────────────────────────────────────────────────

  /** Select candidate memory entries matching the given query (step 1 of forget). */
  selectForgetCandidates(
    projectRoot: string,
    query: string,
    options: {
      config?: Config;
      limit?: number;
      abortSignal?: AbortSignal;
    } = {},
  ): Promise<AutoMemoryForgetSelectionResult> {
    return selectManagedAutoMemoryForgetCandidates(projectRoot, query, options);
  }

  /** Remove the selected memory entries (step 2 of forget). */
  async forgetMatches(
    projectRoot: string,
    matches: AutoMemoryForgetMatch[],
    now?: Date,
    options: { config?: Config; abortSignal?: AbortSignal } = {},
  ): Promise<AutoMemoryForgetResult> {
    const result = await forgetManagedAutoMemoryMatches(
      projectRoot,
      matches,
      now,
      options,
    );
    if (result.touchedScopes.includes('user') && options.config) {
      await this.recordUserMutation(
        projectRoot,
        options.config,
        now ?? new Date(),
      );
    }
    return result;
  }

  /** Convenience: select + remove in a single call. */
  async forget(
    projectRoot: string,
    query: string,
    options: { config?: Config; abortSignal?: AbortSignal } = {},
    now?: Date,
  ): Promise<AutoMemoryForgetResult> {
    const result = await forgetManagedAutoMemoryEntries(
      projectRoot,
      query,
      options,
      now,
    );
    if (result.touchedScopes.includes('user') && options.config) {
      await this.recordUserMutation(
        projectRoot,
        options.config,
        now ?? new Date(),
      );
    }
    return result;
  }

  // ─── Status ───────────────────────────────────────────────────────────────────

  /** Return a full status snapshot for the given project's memory. */
  getStatus(projectRoot: string) {
    return getManagedAutoMemoryStatus(projectRoot, this);
  }

  // ─── Prompt build ─────────────────────────────────────────────────────────────

  /**
   * Build the managed auto-memory section of the system prompt. This is the
   * volatile prompt layer — it is rewritten in-session on every memory save,
   * so callers must keep it after the stable/context layers. When
   * `userSection` is provided, the prompt teaches the model to route saves
   * between the project dir and the user (cross-project) dir using the
   * per-type scope guidance.
   */
  buildAutoMemoryPrompt(
    memoryDir: string,
    indexContent?: string | null,
    userSection?: UserAutoMemorySection,
    teamSection?: TeamAutoMemorySection,
    options?: BuildMemoryPromptOptions,
  ): string {
    return buildManagedAutoMemoryPrompt(
      memoryDir,
      indexContent,
      userSection,
      teamSection,
      options,
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
