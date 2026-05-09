/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Dream kind of `TaskState` (adapter shape).
 *
 * Dream consolidation tasks live in `MemoryManager`, not in the unified
 * `TaskRegistry`. The manager has its own subscribe / status / lock
 * machinery (consolidation-lock acquire/release, gating metadata,
 * scheduler throttling) that overlaps with the registry's surface.
 * Folding dream into the registry would require reconciling those
 * mechanics — a deeper change with no incremental UX benefit.
 *
 * Instead, this module exposes a thin adapter:
 *
 *   - {@link listDreamTasks} — synthesizes `DreamTask` view-models from
 *     `MemoryManager.listTasksByType('dream', projectRoot)`. Filters
 *     out `pending` and `skipped` records (transient sub-second states
 *     with no dialog surface) and caps retained terminal entries.
 *   - {@link subscribeDreams} — wraps `MemoryManager.subscribe({
 *     taskType: 'dream' })` so the CLI hook can listen on a single
 *     callback shape regardless of source.
 *   - {@link DreamTaskKind} — `Task` registered with the dispatcher;
 *     `kill` delegates to `MemoryManager.cancelTask`.
 */

import { createDebugLogger } from '../../utils/debugLogger.js';
import type { MemoryManager, MemoryTaskRecord } from '../../memory/manager.js';
import type { Task } from './dispatcher.js';

const debugLogger = createDebugLogger('DREAM_TASK');

/**
 * Cap on retained terminal dream entries surfaced via the adapter.
 * `MemoryManager.tasks` has no eviction; without this cap the list
 * grows unboundedly with completed dreams over the project's lifetime.
 * Mirrors `MAX_RETAINED_TERMINAL_MONITORS` in spirit but tuned smaller
 * because dreams fire much less frequently than monitor events; 3 is
 * small enough to stay glanceable yet keeps the most recent outcomes
 * visible across rapid succession (e.g. the user opening the dialog
 * right after two dreams completed).
 */
export const MAX_RETAINED_TERMINAL_DREAMS = 3;

/**
 * Dream-task adapter view-model. Dreams don't carry a `TaskBase`
 * envelope — they live in `MemoryManager` and have a different
 * persistence shape (memory-topic markdown, not JSONL). This shape
 * narrows `MemoryTaskRecord` to the fields the dialog/pill consume.
 */
export interface DreamTask {
  kind: 'dream';
  /** MemoryTaskRecord.id — used as React key + lookup. */
  dreamId: string;
  /**
   * Same shape the dialog renders. `pending` and `skipped` are filtered
   * out at the source so they never reach this view-model.
   */
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startTime: number;
  /**
   * Wall-clock instant the record's `status` last changed. For
   * `completed` / `failed` this is when the dream actually finished;
   * for `cancelled` this is the moment `cancelTask` ran (NOT when the
   * fork agent finishes unwinding — that can lag by seconds for agents
   * mid-tool-call). The dialog renders elapsed from this value, so a
   * freshly-cancelled record snaps to "Stopped · Ns" even while the
   * underlying fork is still releasing the lock.
   */
  endTime?: number;
  progressText?: string;
  error?: string;
  /** Number of sessions the dream is reviewing — populated on schedule. */
  sessionCount?: number;
  /** Memory topic files written — populated on completion. */
  touchedTopics?: readonly string[];
  /**
   * Best-effort warnings populated by `runDream` when post-fork
   * housekeeping fails (gating-metadata write or consolidation-lock
   * release). The dream itself completed successfully — these are
   * informational so the user can explain why subsequent dreams may be
   * silently skipped as `'locked'` or why the scheduler gate isn't
   * seeing the most recent dream's timestamp.
   */
  lockReleaseError?: string;
  metadataWriteError?: string;
}

/**
 * Snapshot of dream tasks for the dialog. Matches the filtering rules
 * the original `useBackgroundTaskView` hook applied:
 *   - `pending` is a sub-second transition state and `skipped` records
 *     arise from the rare race where the schedule-time lock check
 *     passed but `acquireDreamLock` then hit EEXIST in `runDream`. These
 *     never reflect user-visible work, so filter them out.
 *   - Terminal entries are sorted newest-first by `updatedAt` and
 *     capped at {@link MAX_RETAINED_TERMINAL_DREAMS}.
 *   - Running entries are always included regardless of count.
 */
export function listDreamTasks(
  memoryManager: MemoryManager,
  projectRoot: string,
): DreamTask[] {
  const records = memoryManager.listTasksByType('dream', projectRoot);
  const running = records.filter((t) => t.status === 'running');
  const terminal = records
    .filter(
      (t) =>
        t.status === 'completed' ||
        t.status === 'failed' ||
        t.status === 'cancelled',
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_RETAINED_TERMINAL_DREAMS);
  return [...running, ...terminal].map(toDreamTask);
}

/**
 * Subscribe to dream-task transitions. The wrapped subscription uses
 * `MemoryManager.subscribe({ taskType: 'dream' })` so per-extract
 * notifies don't fire the listener — those have no dialog surface and
 * arrive on every UserQuery, which would dominate the change traffic
 * if forwarded.
 *
 * Returns the unsubscribe function from `MemoryManager`.
 */
export function subscribeDreams(
  memoryManager: MemoryManager,
  listener: () => void,
): () => void {
  return memoryManager.subscribe(listener, { taskType: 'dream' });
}

/**
 * Snapshot signature used by the CLI hook to dedup repeated refresh
 * calls for the same dream-task state. Two snapshots that match on
 * (id, status, updatedAt) for every record are considered equivalent —
 * any dialog-visible field change advances `updatedAt`, so this catches
 * "same content, just an event re-fire" cases.
 */
export function dreamSnapshotSignature(
  records: readonly MemoryTaskRecord[],
): string {
  return records.map((t) => `${t.id}:${t.status}:${t.updatedAt}`).join('|');
}

function toDreamTask(record: MemoryTaskRecord): DreamTask {
  const sessionCount = record.metadata?.['sessionCount'];
  const touchedTopics = record.metadata?.['touchedTopics'];
  const lockReleaseError = record.metadata?.['lockReleaseError'];
  const metadataWriteError = record.metadata?.['metadataWriteError'];
  return {
    kind: 'dream',
    dreamId: record.id,
    status: record.status as DreamTask['status'],
    startTime: Date.parse(record.createdAt),
    endTime:
      record.status === 'running' ? undefined : Date.parse(record.updatedAt),
    progressText: record.progressText,
    error: record.error,
    sessionCount: typeof sessionCount === 'number' ? sessionCount : undefined,
    touchedTopics: Array.isArray(touchedTopics)
      ? (touchedTopics.filter((s) => typeof s === 'string') as string[])
      : undefined,
    lockReleaseError:
      typeof lockReleaseError === 'string' ? lockReleaseError : undefined,
    metadataWriteError:
      typeof metadataWriteError === 'string' ? metadataWriteError : undefined,
  };
}

/**
 * `Task` implementation registered with the dispatcher. Dialog cancel
 * delegates to `MemoryManager.cancelTask`. The manager flips status to
 * `cancelled` before aborting, and the `runDream` finally block
 * releases the consolidation lock as the agent unwinds.
 *
 * `cancelTask` returns false in the contract-violation path (running
 * record without an AbortController). Today this is unreachable because
 * the controller is registered before `storeWith` fires the notify, but
 * if a future refactor breaks the invariant a silent ignore here would
 * let the user think the cancel took. Log + leave the dialog open.
 */
export const DreamTaskKind: Task = {
  kind: 'dream',
  name: 'Dream consolidation',
  kill: (id, ctx) => {
    const ok = ctx.memoryManager.cancelTask(id);
    if (!ok) {
      debugLogger.warn(
        `DreamTaskKind.kill: dream task ${id} could not be cancelled ` +
          `(internal state inconsistency — see MemoryManager.cancelTask warn).`,
      );
    }
  },
};
