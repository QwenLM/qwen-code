/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import type { SessionArchiveState } from '@qwen-code/qwen-code-core';
import type { BridgeSessionSummary } from '../acp-session-bridge.js';

export interface PersistedSessionListScope {
  runtimeBaseDir: string;
  workspaceCwd: string;
  archiveState: SessionArchiveState;
}

export interface PersistedSessionListSnapshot {
  sessions: ReadonlyArray<Readonly<BridgeSessionSummary>>;
  truncated: boolean;
  scanPages: number;
  scanDurationMs: number;
}

export type PersistedSessionListCacheStatus =
  | 'scan'
  | 'cache_hit'
  | 'single_flight';

export interface PersistedSessionListLookup {
  status: PersistedSessionListCacheStatus;
  promise: Promise<PersistedSessionListSnapshot>;
  cacheAgeMs?: number;
}

interface CachedSnapshot {
  snapshot: PersistedSessionListSnapshot;
  completedAt: number;
  expiryTimer: ReturnType<typeof setTimeout>;
}

interface InFlightLoad {
  generation: number;
  controller: AbortController;
  promise: Promise<PersistedSessionListSnapshot>;
  waiterCount: number;
  settled: boolean;
}

interface CacheSlot {
  generation: number;
  value?: CachedSnapshot;
  inFlight?: InFlightLoad;
}

export class PersistedSessionListCache {
  private readonly slots = new Map<string, CacheSlot>();
  private retainedSummaries = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly maxRetainedSummaries: number,
  ) {}

  lookup(
    scope: PersistedSessionListScope,
    loader: (signal: AbortSignal) => Promise<PersistedSessionListSnapshot>,
    options: { signal?: AbortSignal } = {},
  ): PersistedSessionListLookup {
    options.signal?.throwIfAborted();
    const key = this.key(scope);
    let slot = this.slots.get(key);
    if (!slot) {
      slot = { generation: 0 };
      this.slots.set(key, slot);
    }

    const now = Date.now();
    if (slot.value) {
      const cacheAgeMs = Math.max(0, now - slot.value.completedAt);
      if (cacheAgeMs < this.ttlMs) {
        const snapshot = slot.value.snapshot;
        return {
          status: 'cache_hit',
          promise: Promise.resolve().then(() => {
            options.signal?.throwIfAborted();
            return snapshot;
          }),
          cacheAgeMs,
        };
      }
      this.removeValue(slot);
    }

    if (
      slot.inFlight !== undefined &&
      slot.inFlight.generation === slot.generation &&
      !slot.inFlight.controller.signal.aborted
    ) {
      return {
        status: 'single_flight',
        promise: this.attachWaiter(key, slot, slot.inFlight, options.signal),
      };
    }

    const generation = slot.generation;
    const controller = new AbortController();
    const load: InFlightLoad = {
      generation,
      controller,
      promise: undefined as unknown as Promise<PersistedSessionListSnapshot>,
      waiterCount: 0,
      settled: false,
    };
    const managed = Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        return loader(controller.signal);
      })
      .then(
        (snapshot) => {
          load.settled = true;
          const current = this.slots.get(key);
          if (current === slot && current.inFlight === load) {
            current.inFlight = undefined;
            if (
              current.generation === generation &&
              !controller.signal.aborted &&
              snapshot.sessions.length <= this.maxRetainedSummaries
            ) {
              this.installValue(key, current, snapshot);
            } else if (current.value === undefined) {
              this.slots.delete(key);
            }
          }
          return snapshot;
        },
        (error: unknown) => {
          load.settled = true;
          const current = this.slots.get(key);
          if (current === slot && current.inFlight === load) {
            current.inFlight = undefined;
            if (current.value === undefined) this.slots.delete(key);
          }
          throw error;
        },
      );
    load.promise = managed;
    slot.inFlight = load;

    return {
      status: 'scan',
      promise: this.attachWaiter(key, slot, load, options.signal),
    };
  }

  invalidate(scope: PersistedSessionListScope): void {
    const key = this.key(scope);
    const slot = this.slots.get(key);
    if (!slot) return;
    slot.generation += 1;
    this.removeValue(slot);
    if (slot.inFlight === undefined) this.slots.delete(key);
  }

  clear(): void {
    for (const slot of this.slots.values()) {
      if (slot.value) clearTimeout(slot.value.expiryTimer);
    }
    this.slots.clear();
    this.retainedSummaries = 0;
  }

  private installValue(
    key: string,
    slot: CacheSlot,
    snapshot: PersistedSessionListSnapshot,
  ): void {
    const completedAt = Date.now();
    this.evictFor(snapshot.sessions.length);
    const remainingTtlMs = Math.max(0, this.ttlMs - (Date.now() - completedAt));
    const expiryTimer = setTimeout(() => {
      const current = this.slots.get(key);
      if (current !== slot || current.value?.expiryTimer !== expiryTimer) {
        return;
      }
      this.removeValue(current);
      if (current.inFlight === undefined) this.slots.delete(key);
    }, remainingTtlMs);
    if (typeof expiryTimer.unref === 'function') expiryTimer.unref();
    const value = { snapshot, completedAt, expiryTimer };
    slot.value = value;
    this.retainedSummaries += snapshot.sessions.length;
  }

  private evictFor(incomingSummaries: number): void {
    while (
      this.retainedSummaries + incomingSummaries >
      this.maxRetainedSummaries
    ) {
      let oldest:
        | { key: string; slot: CacheSlot; completedAt: number }
        | undefined;
      for (const [key, slot] of this.slots) {
        if (
          slot.value &&
          (oldest === undefined || slot.value.completedAt < oldest.completedAt)
        ) {
          oldest = { key, slot, completedAt: slot.value.completedAt };
        }
      }
      if (!oldest) return;
      this.removeValue(oldest.slot);
      if (oldest.slot.inFlight === undefined) this.slots.delete(oldest.key);
    }
  }

  private removeValue(slot: CacheSlot): void {
    const value = slot.value;
    if (!value) return;
    clearTimeout(value.expiryTimer);
    this.retainedSummaries -= value.snapshot.sessions.length;
    slot.value = undefined;
  }

  private attachWaiter(
    key: string,
    slot: CacheSlot,
    load: InFlightLoad,
    signal?: AbortSignal,
  ): Promise<PersistedSessionListSnapshot> {
    load.waiterCount += 1;
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        load.waiterCount -= 1;
        if (load.waiterCount === 0 && !load.settled) {
          load.controller.abort(
            new DOMException('No active session list waiters', 'AbortError'),
          );
          const current = this.slots.get(key);
          if (current === slot && current.inFlight === load) {
            current.inFlight = undefined;
            if (current.value === undefined) this.slots.delete(key);
          }
        }
        finish();
      };
      const onAbort = () => {
        if (load.settled) return;
        settle(() => reject(signal?.reason));
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      void load.promise.then(
        (snapshot) => settle(() => resolve(snapshot)),
        (error: unknown) => settle(() => reject(error)),
      );
    });
  }

  private key(scope: PersistedSessionListScope): string {
    return JSON.stringify([
      path.resolve(scope.runtimeBaseDir),
      scope.workspaceCwd,
      scope.archiveState,
    ]);
  }
}
