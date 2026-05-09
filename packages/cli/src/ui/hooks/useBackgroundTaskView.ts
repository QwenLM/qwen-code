/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * useBackgroundTaskView — subscribes to the three background-task
 * registries (background subagents, managed shells, and event monitors)
 * AND to `MemoryManager` for dream consolidation tasks, merging them
 * into a single ordered snapshot of `DialogEntry`s. Each registry fires
 * `statusChange` on register too, so a single subscription per registry
 * is enough to keep the snapshot fresh for new + transitioning entries.
 * The `MemoryManager.subscribe({ taskType: 'dream' })` filter routes
 * dream-task transitions to the same refresh path while skipping the
 * per-UserQuery extract notifies that have no dialog surface.
 *
 * Surfaces that only care about live work (the footer pill, the
 * composer's Down-arrow route) filter for `running` themselves.
 *
 * Intentionally ignores activity updates (appendActivity). Tool-call
 * traffic from a running background agent would otherwise churn the
 * Footer pill and the AppContainer every few hundred ms. The detail
 * dialog subscribes to the activity callback directly when it needs
 * live Progress updates.
 */

import { useState, useEffect } from 'react';
import {
  type BackgroundTaskEntry,
  type BackgroundShellEntry,
  type Config,
  type MemoryTaskRecord,
  type MonitorEntry,
} from '@qwen-code/qwen-code-core';

// Cap on retained terminal dream entries surfaced via the dialog.
// `MemoryManager.tasks` has no eviction; without this cap the list
// grows unboundedly with completed dreams over the project's lifetime.
// 3 is small enough to stay glanceable yet keeps the most recent
// outcomes visible across rapid succession (e.g. the user opening the
// dialog right after two dreams completed).
const MAX_RETAINED_TERMINAL_DREAMS = 3;

export type AgentDialogEntry = BackgroundTaskEntry & {
  kind: 'agent';
  resumeBlockedReason?: string;
};

/**
 * Dream-task adapter. MemoryManager owns its own task records
 * (MemoryTaskRecord) and intentionally lives outside the registry trio;
 * this view-model wraps the subset of fields the dialog needs and
 * narrows status to the four values that ever appear in the dialog
 * (skipped/pending records are filtered out at the source).
 */
export type DreamDialogEntry = {
  kind: 'dream';
  /** MemoryTaskRecord.id — used as React key + lookup. */
  dreamId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startTime: number;
  /**
   * Wall-clock instant the record's `status` last changed. For
   * `completed` / `failed` this is when the dream actually finished;
   * for `cancelled` this is the moment `cancelTask` ran (NOT when
   * the fork agent finishes unwinding — that can lag by seconds for
   * agents mid-tool-call). The dialog renders elapsed from this
   * value, so a freshly-cancelled record snaps to "Stopped · Ns"
   * even while the underlying fork is still releasing the lock.
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
   * informational so the user can explain why subsequent dreams may
   * be silently skipped as `'locked'` or why the scheduler gate
   * isn't seeing the most recent dream's timestamp.
   */
  lockReleaseError?: string;
  metadataWriteError?: string;
};

/**
 * A unified view-model entry the dialog/pill/context render against.
 * Discriminated by `kind`; per-kind fields are inlined verbatim so
 * renderer code can stay mechanical (`entry.kind === 'agent'` /
 * `'shell'` / `'monitor'` / `'dream'` guard, then access fields directly).
 */
export type DialogEntry =
  | AgentDialogEntry
  | (BackgroundShellEntry & { kind: 'shell' })
  | (MonitorEntry & { kind: 'monitor' })
  | DreamDialogEntry;

export interface UseBackgroundTaskViewResult {
  entries: readonly DialogEntry[];
}

/** Stable id of an entry regardless of kind — used as React key + lookup. */
export function entryId(entry: DialogEntry): string {
  switch (entry.kind) {
    case 'agent':
      return entry.agentId;
    case 'shell':
      return entry.shellId;
    case 'monitor':
      return entry.monitorId;
    case 'dream':
      return entry.dreamId;
    default: {
      const _exhaustive: never = entry;
      throw new Error(
        `entryId: unknown DialogEntry kind: ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
}

export function useBackgroundTaskView(
  config: Config | null,
): UseBackgroundTaskViewResult {
  const [entries, setEntries] = useState<DialogEntry[]>([]);

  useEffect(() => {
    if (!config) return;
    const agentRegistry = config.getBackgroundTaskRegistry();
    const shellRegistry = config.getBackgroundShellRegistry();
    const monitorRegistry = config.getMonitorRegistry();
    const memoryManager = config.getMemoryManager();
    const projectRoot = config.getProjectRoot();
    // Dream snapshot signature, kept as a defense-in-depth dedup for
    // the dream-filtered memory listener below. The taskType filter
    // already skips the listener entirely on extract notifies; this
    // signature additionally absorbs the rare case where dream
    // metadata is updated without an observable dialog change.
    let lastDreamSig = '';

    // Declared before `refresh` so the function ordering can't trip
    // the temporal-dead-zone if a future refactor adds a synchronous
    // call to refresh between the two `const` bindings.
    const computeDreamSig = (dreams: readonly MemoryTaskRecord[]): string =>
      dreams.map((t) => `${t.id}:${t.status}:${t.updatedAt}`).join('|');

    // refresh accepts a pre-fetched dream snapshot so the memory
    // listener can reuse the same array it computed for its dedup
    // check — avoids a second listTasksByType call AND eliminates the
    // race window where the listener's gate sig and the entries it
    // builds would otherwise come from two separate snapshots.
    const refresh = (dreamSnapshot?: readonly MemoryTaskRecord[]) => {
      const agentEntries: DialogEntry[] = agentRegistry
        .getAll()
        .map((e) => ({ ...e, kind: 'agent' as const }));
      const shellEntries: DialogEntry[] = shellRegistry
        .getAll()
        .map((e) => ({ ...e, kind: 'shell' as const }));
      const monitorEntries: DialogEntry[] = monitorRegistry
        .getAll()
        .map((e) => ({ ...e, kind: 'monitor' as const }));
      // Dream entries: only surface tasks that actually fired.
      // `pending` is a sub-second transition state and `skipped`
      // records arise from the rare race where the schedule-time
      // lock check passed but `acquireDreamLock` then hit EEXIST in
      // runDream — these never reflect user-visible work, so filter
      // them out. (Most gate misses don't create a record at all;
      // scheduleDream returns `{status: 'skipped'}` early without
      // touching the task map.) Extract tasks also intentionally
      // stay out of this view — they fire on every UserQuery and
      // their completion is already covered by the `memory_saved`
      // toast in useGeminiStream.
      //
      // Cap retained terminal entries — MemoryManager.tasks Map has no
      // eviction path, so completed/failed dreams accumulate forever
      // (every fired dream over the project's lifetime). Without this
      // cap the dialog would grow unbounded; with it the user sees all
      // running dreams plus the most recent few terminal results
      // (mirrors MonitorRegistry.MAX_RETAINED_TERMINAL_MONITORS).
      const allDreams =
        dreamSnapshot ?? memoryManager.listTasksByType('dream', projectRoot);
      const runningDreams = allDreams.filter((t) => t.status === 'running');
      const terminalDreams = allDreams
        .filter(
          (t) =>
            t.status === 'completed' ||
            t.status === 'failed' ||
            t.status === 'cancelled',
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, MAX_RETAINED_TERMINAL_DREAMS);
      const dreamEntries: DialogEntry[] = [
        ...runningDreams,
        ...terminalDreams,
      ].map((t) => {
        const sessionCount = t.metadata?.['sessionCount'];
        const touchedTopics = t.metadata?.['touchedTopics'];
        const lockReleaseError = t.metadata?.['lockReleaseError'];
        const metadataWriteError = t.metadata?.['metadataWriteError'];
        return {
          kind: 'dream' as const,
          dreamId: t.id,
          status: t.status as 'running' | 'completed' | 'failed' | 'cancelled',
          startTime: Date.parse(t.createdAt),
          endTime: t.status === 'running' ? undefined : Date.parse(t.updatedAt),
          progressText: t.progressText,
          error: t.error,
          sessionCount:
            typeof sessionCount === 'number' ? sessionCount : undefined,
          touchedTopics: Array.isArray(touchedTopics)
            ? (touchedTopics.filter((s) => typeof s === 'string') as string[])
            : undefined,
          lockReleaseError:
            typeof lockReleaseError === 'string' ? lockReleaseError : undefined,
          metadataWriteError:
            typeof metadataWriteError === 'string'
              ? metadataWriteError
              : undefined,
        };
      });
      // Merge by startTime so the order matches launch order across all
      // sources (matters when an agent, shell, monitor, and dream are
      // launched alternately).
      const merged = [
        ...agentEntries,
        ...shellEntries,
        ...monitorEntries,
        ...dreamEntries,
      ].sort((a, b) => a.startTime - b.startTime);
      // Cache the dream signature derived from the freshly-built
      // entries — the memory listener uses this to skip redundant
      // setEntries calls when an extract notify fires (extract has no
      // dialog surface, so the merged result is identical). Computed
      // from the same `allDreams` snapshot used to build dreamEntries
      // so the gate value can never desync from what's on screen.
      lastDreamSig = computeDreamSig(allDreams);
      setEntries(merged);
    };

    // Wrap registry callbacks in a thunk so React's setStatusChange
    // signature (no-arg) doesn't accidentally pass an entry into
    // refresh's `dreamSnapshot` parameter.
    const refreshFromRegistry = () => refresh();

    refresh();

    agentRegistry.setStatusChangeCallback(refreshFromRegistry);
    shellRegistry.setStatusChangeCallback(refreshFromRegistry);
    monitorRegistry.setStatusChangeCallback(refreshFromRegistry);

    // Memory listener fires only on dream-task transitions —
    // `subscribe({ taskType: 'dream' })` skips the per-extract notify
    // entirely so we don't pay the per-UserQuery O(n) signature cost
    // for transitions we have no surface for. The dream-content
    // signature dedup remains as a second-line guard against the rare
    // case where dream metadata is updated without observable changes
    // to the dialog (e.g. a future progressText-only patch on the
    // same status). The fetched snapshot is forwarded to refresh so
    // both the gate and the rendered dreamEntries come from one read.
    const memoryListener = () => {
      const dreams = memoryManager.listTasksByType('dream', projectRoot);
      const sig = computeDreamSig(dreams);
      if (sig === lastDreamSig) return;
      refresh(dreams);
    };
    const unsubscribeMemory = memoryManager.subscribe(memoryListener, {
      taskType: 'dream',
    });

    return () => {
      agentRegistry.setStatusChangeCallback(undefined);
      shellRegistry.setStatusChangeCallback(undefined);
      monitorRegistry.setStatusChangeCallback(undefined);
      unsubscribeMemory();
    };
  }, [config]);

  return { entries };
}
