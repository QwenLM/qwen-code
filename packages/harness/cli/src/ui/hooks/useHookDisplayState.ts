/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect } from 'react';
import {
  coreEvents,
  CoreEvent,
  type HookStartPayload,
  type HookEndPayload,
} from '@qwen-code/core';
import { type ActiveHook } from '../types.js';

/** Batches finishing faster than this are never shown in the UI */
const DEBOUNCE_MS = 200;

/** Once visible, a batch stays displayed for at least this long */
const MIN_DISPLAY_MS = 1500;

/**
 * After the last visible batch is removed, wait this long before clearing the
 * state. Prevents flicker if another batch starts shortly after.
 */
const LINGER_MS = 600;

interface Batch {
  id: string;
  total: number;
  startedAt: number;
  endedAt?: number;
  cancelled?: boolean;
  /** hookIndex → entry, for hooks that have started. */
  hooks: Map<number, ActiveHook>;
  settled: Set<number>;
  /** Set once the debounce elapses and the batch becomes visible. */
  shownAt?: number;
  debounceTimer?: NodeJS.Timeout;
  removalTimer?: NodeJS.Timeout;
}

const isVisible = (batch: Batch): boolean =>
  !batch.cancelled && batch.shownAt !== undefined;

/**
 * The batch the status row shows: the most recent visible batch that still has
 * running hooks, else the most recent visible batch that finished and is
 * inside its minimum display window. A finished batch never hides a running
 * one.
 */
function selectDisplayedBatch(batches: readonly Batch[]): Batch | undefined {
  const visible = batches.filter(isVisible);
  return visible.findLast((b) => b.settled.size < b.total) ?? visible.at(-1);
}

function toActiveHooks(batch: Batch | undefined): ActiveHook[] {
  if (!batch) return [];
  return [...batch.hooks.values()]
    .sort((a, b) => a.index - b.index)
    .map((hook) => ({
      ...hook,
      settled: batch.settled.has(hook.index),
      batchStartedAt: batch.startedAt,
      batchEndedAt: batch.endedAt,
    }));
}

/**
 * Groups hook lifecycle events into execution batches and returns the hooks of
 * the batch to display. Core only emits these events for user-visible hooks;
 * batches that run inside a subagent are ignored here.
 */
export const useHookDisplayState = () => {
  const [activeHooks, setActiveHooks] = useState<ActiveHook[]>([]);

  useEffect(() => {
    const batches: Batch[] = [];
    let lingerTimer: NodeJS.Timeout | undefined;

    const sync = () => {
      setActiveHooks(toActiveHooks(selectDisplayedBatch(batches)));
    };

    const removeBatch = (batch: Batch) => {
      const idx = batches.indexOf(batch);
      if (idx !== -1) batches.splice(idx, 1);
      clearTimeout(batch.debounceTimer);
      clearTimeout(batch.removalTimer);

      if (batches.some(isVisible)) {
        sync();
        return;
      }
      // Keep the last frame while a pending batch may still become visible,
      // or while a clear is already scheduled.
      if (batches.length > 0 || lingerTimer) return;
      lingerTimer = setTimeout(() => {
        lingerTimer = undefined;
        if (!batches.some(isVisible)) setActiveHooks([]);
      }, LINGER_MS);
    };

    const handleHookStart = (payload: HookStartPayload) => {
      if (payload.agentId) return;

      if (lingerTimer) {
        clearTimeout(lingerTimer);
        lingerTimer = undefined;
      }

      let batch = batches.find((b) => b.id === payload.batchId);
      if (!batch) {
        const created: Batch = {
          id: payload.batchId,
          total: payload.totalHooks,
          startedAt: Date.now(),
          hooks: new Map(),
          settled: new Set(),
        };
        created.debounceTimer = setTimeout(() => {
          created.debounceTimer = undefined;
          created.shownAt = Date.now();
          sync();
        }, DEBOUNCE_MS);
        batches.push(created);
        batch = created;
      }

      batch.hooks.set(payload.hookIndex, {
        eventName: payload.eventName,
        index: payload.hookIndex,
        total: batch.total,
        statusMessage: payload.statusMessage,
        settled: false,
      });
      if (isVisible(batch)) sync();
    };

    const handleHookEnd = (payload: HookEndPayload) => {
      const batch = batches.find((b) => b.id === payload.batchId);
      if (!batch || batch.settled.has(payload.hookIndex)) return;
      batch.settled.add(payload.hookIndex);

      if (payload.cancelled || batch.cancelled) {
        batch.cancelled = true;
        clearTimeout(batch.debounceTimer);
        clearTimeout(batch.removalTimer);
        // Do not publish cancelled hooks as completed progress or retain a
        // misleading final frame. Keep the batch until its remaining ends arrive.
        sync();
        if (batch.settled.size === batch.total) removeBatch(batch);
        return;
      }

      if (batch.settled.size < batch.total) {
        if (isVisible(batch)) sync();
        return;
      }

      batch.endedAt = Date.now();

      // Finished within the debounce window: never shown, nothing to hold.
      if (batch.shownAt === undefined) {
        removeBatch(batch);
        return;
      }

      // Publish the final execution time even when only the linger frame remains.
      sync();
      const remaining = MIN_DISPLAY_MS - (Date.now() - batch.shownAt);
      if (remaining <= 0) {
        removeBatch(batch);
        return;
      }
      batch.removalTimer = setTimeout(() => removeBatch(batch), remaining);
    };

    coreEvents.on(CoreEvent.HookStart, handleHookStart);
    coreEvents.on(CoreEvent.HookEnd, handleHookEnd);

    return () => {
      coreEvents.off(CoreEvent.HookStart, handleHookStart);
      coreEvents.off(CoreEvent.HookEnd, handleHookEnd);
      for (const batch of batches) {
        clearTimeout(batch.debounceTimer);
        clearTimeout(batch.removalTimer);
      }
      batches.length = 0;
      clearTimeout(lingerTimer);
      lingerTimer = undefined;
    };
  }, []);

  return activeHooks;
};
