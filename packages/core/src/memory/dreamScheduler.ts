/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Config } from '../config/config.js';
import { Storage } from '../config/storage.js';
import {
  BackgroundTaskDrainer,
  type DrainBackgroundTasksOptions,
} from '../background/taskDrainer.js';
import {
  BackgroundTaskRegistry,
  type BackgroundTaskState,
} from '../background/taskRegistry.js';
import { BackgroundTaskScheduler } from '../background/taskScheduler.js';
import {
  getAutoMemoryConsolidationLockPath,
  getAutoMemoryMetadataPath,
} from './paths.js';
import { ensureAutoMemoryScaffold } from './store.js';
import { runManagedAutoMemoryDream } from './dream.js';
import type { AutoMemoryMetadata } from './types.js';

export const DEFAULT_AUTO_DREAM_MIN_HOURS = 24;
export const DEFAULT_AUTO_DREAM_MIN_SESSIONS = 5;
/** Maximum age before a lock is reclaimed even if the PID appears live (PID-reuse guard). */
const DREAM_LOCK_STALE_MS = 60 * 60 * 1000; // 1 hour (same as CC)
/** Minimum interval between session-count filesystem scans when time-gate is open. */
const SESSION_SCAN_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes (same as CC)

/**
 * Returns true if the given process ID is currently alive.
 * Uses kill(pid, 0) — no signal sent, just existence check.
 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface ScheduleManagedAutoMemoryDreamParams {
  projectRoot: string;
  sessionId: string;
  config?: Config;
  now?: Date;
  minHoursBetweenDreams?: number;
  minSessionsBetweenDreams?: number;
}

export interface ManagedAutoMemoryDreamScheduleResult {
  status: 'scheduled' | 'skipped';
  taskId?: string;
  skippedReason?:
    | 'disabled'
    | 'same_session'
    | 'min_hours'
    | 'min_sessions'
    | 'locked'
    | 'running';
  promise?: Promise<BackgroundTaskState>;
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
  if (!lastDreamAt) {
    return null;
  }
  const timestamp = Date.parse(lastDreamAt);
  if (Number.isNaN(timestamp)) {
    return null;
  }
  return (now.getTime() - timestamp) / (1000 * 60 * 60);
}

/** Pattern matching session JSONL files: <uuid>.jsonl */
const SESSION_FILE_PATTERN = /^[0-9a-fA-F-]{32,36}\.jsonl$/;

/**
 * Returns session IDs whose transcript files have mtime after sinceMs.
 * Uses filesystem mtime as ground truth, immune to meta.json corruption or loss.
 * Caller should exclude the current session (its mtime is always recent).
 */
async function listSessionsTouchedSince(
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
        if (stats.mtimeMs > sinceMs) {
          results.push(sessionId);
        }
      } catch {
        // Skip files we cannot stat
      }
    }),
  );
  return results;
}

async function lockExists(projectRoot: string): Promise<boolean> {
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

  // Within stale threshold: check if the holder PID is still alive.
  if (ageMs <= DREAM_LOCK_STALE_MS) {
    if (holderPid !== undefined && isProcessRunning(holderPid)) {
      return true; // live holder
    }
    // Dead PID or unparseable body — reclaim the stale lock immediately.
    await fs.rm(lockPath, { force: true });
    return false;
  }

  // Past stale threshold regardless of PID (PID-reuse guard).
  await fs.rm(lockPath, { force: true });
  return false;
}

async function acquireDreamLock(projectRoot: string): Promise<void> {
  // Write our PID so lockExists() can detect whether we're still alive.
  await fs.writeFile(
    getAutoMemoryConsolidationLockPath(projectRoot),
    String(process.pid),
    { flag: 'wx' }, // exclusive create — throws EEXIST if already locked
  );
}

async function releaseDreamLock(projectRoot: string): Promise<void> {
  await fs.rm(getAutoMemoryConsolidationLockPath(projectRoot), {
    force: true,
  });
}

/** Function type for scanning session files by mtime. Injected for testing. */
export type SessionScannerFn = (
  projectRoot: string,
  sinceMs: number,
  excludeSessionId: string,
) => Promise<string[]>;

export class ManagedAutoMemoryDreamRuntime {
  readonly registry = new BackgroundTaskRegistry();
  readonly drainer = new BackgroundTaskDrainer();
  readonly scheduler = new BackgroundTaskScheduler(this.registry, this.drainer);

  constructor(
    private readonly sessionScanner: SessionScannerFn = listSessionsTouchedSince,
  ) {}
  /**
   * Timestamp (ms) of the last session-count filesystem scan per project root.
   * When the time-gate passes but session-count doesn't, we'd otherwise re-scan
   * every turn. Throttle to SESSION_SCAN_INTERVAL_MS (10 min).
   */
  private lastSessionScanAt = new Map<string, number>();

  async schedule(
    params: ScheduleManagedAutoMemoryDreamParams,
  ): Promise<ManagedAutoMemoryDreamScheduleResult> {
    if (params.config && !params.config.getManagedAutoDreamEnabled()) {
      return {
        status: 'skipped',
        skippedReason: 'disabled',
      };
    }
    const now = params.now ?? new Date();
    const minHoursBetweenDreams =
      params.minHoursBetweenDreams ?? DEFAULT_AUTO_DREAM_MIN_HOURS;
    const minSessionsBetweenDreams =
      params.minSessionsBetweenDreams ?? DEFAULT_AUTO_DREAM_MIN_SESSIONS;

    await ensureAutoMemoryScaffold(params.projectRoot, now);
    const metadata = await readDreamMetadata(params.projectRoot);

    if (metadata.lastDreamSessionId === params.sessionId) {
      return {
        status: 'skipped',
        skippedReason: 'same_session',
      };
    }

    const elapsedHours = hoursSince(metadata.lastDreamAt, now);
    if (elapsedHours !== null && elapsedHours < minHoursBetweenDreams) {
      return {
        status: 'skipped',
        skippedReason: 'min_hours',
      };
    }

    // Scan throttle: when the time-gate passes but the session-gate hasn't, we'd
    // re-scan the session set on every turn. Throttle to SESSION_SCAN_INTERVAL_MS.
    const lastScan = this.lastSessionScanAt.get(params.projectRoot) ?? 0;
    const sinceScanMs = now.getTime() - lastScan;
    if (sinceScanMs < SESSION_SCAN_INTERVAL_MS) {
      return {
        status: 'skipped',
        skippedReason: 'min_sessions',
      };
    }
    this.lastSessionScanAt.set(params.projectRoot, now.getTime());

    // Scan session files by mtime (filesystem ground truth, immune to meta.json loss).
    const lastDreamMs = metadata.lastDreamAt
      ? Date.parse(metadata.lastDreamAt)
      : 0;
    const sessionIds = await this.sessionScanner(
      params.projectRoot,
      lastDreamMs,
      params.sessionId,
    );
    if (sessionIds.length < minSessionsBetweenDreams) {
      return {
        status: 'skipped',
        skippedReason: 'min_sessions',
      };
    }

    if (await lockExists(params.projectRoot)) {
      return {
        status: 'skipped',
        skippedReason: 'locked',
      };
    }

    const scheduled = this.scheduler.schedule({
      taskType: 'managed-auto-memory-dream',
      title: 'Managed auto-memory dream',
      projectRoot: params.projectRoot,
      sessionId: params.sessionId,
      dedupeKey: `managed-auto-memory-dream:${params.projectRoot}`,
      metadata: {
        sessionCount: sessionIds.length,
      },
      run: async () => {
        try {
          await acquireDreamLock(params.projectRoot);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            return {
              progressText:
                'Skipped managed auto-memory dream because consolidation lock already exists.',
              metadata: { skippedReason: 'locked' },
            };
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

          return {
            progressText:
              result.systemMessage ?? 'Managed auto-memory dream completed.',
            metadata: {
              touchedTopics: result.touchedTopics,
              dedupedEntries: result.dedupedEntries,
              lastDreamAt: now.toISOString(),
            },
          };
        } finally {
          await releaseDreamLock(params.projectRoot);
        }
      },
    });

    const initialTask = this.registry.get(scheduled.taskId);
    if (initialTask?.status === 'skipped') {
      return {
        status: 'skipped',
        skippedReason: 'running',
        taskId: scheduled.taskId,
        promise: scheduled.promise,
      };
    }

    return {
      status: 'scheduled',
      taskId: scheduled.taskId,
      promise: scheduled.promise,
    };
  }

  listTasks(projectRoot?: string): BackgroundTaskState[] {
    return this.registry.list(projectRoot);
  }

  drain(options?: DrainBackgroundTasksOptions): Promise<boolean> {
    return this.drainer.drain(options);
  }
}

const defaultManagedAutoMemoryDreamRuntime =
  new ManagedAutoMemoryDreamRuntime();

export async function scheduleManagedAutoMemoryDream(
  params: ScheduleManagedAutoMemoryDreamParams,
): Promise<ManagedAutoMemoryDreamScheduleResult> {
  return defaultManagedAutoMemoryDreamRuntime.schedule(params);
}

export function getManagedAutoMemoryDreamTaskRegistry(): BackgroundTaskRegistry {
  return defaultManagedAutoMemoryDreamRuntime.registry;
}

export async function drainManagedAutoMemoryDreamTasks(
  options?: DrainBackgroundTasksOptions,
): Promise<boolean> {
  return defaultManagedAutoMemoryDreamRuntime.drain(options);
}

export function createManagedAutoMemoryDreamRuntimeForTests(
  sessionScanner?: SessionScannerFn,
): ManagedAutoMemoryDreamRuntime {
  return new ManagedAutoMemoryDreamRuntime(sessionScanner);
}
