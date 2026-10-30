/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Reconnect backoff for the daemon CDP client, persisted in
 * `chrome.storage.session` so it survives MV3 service-worker restarts.
 *
 * The in-memory ladder alone never engaged for long failures: Chrome kills an
 * idle worker after ~30s, taking the pending timer and the delay state with
 * it, and the next keepalive alarm started a fresh worker that retried
 * immediately. Against a daemon that rejects the upgrade (e.g. origin not
 * allowlisted) that loop logged thousands of lines a day (#13966). The
 * persisted `nextRetryAt` is the single source of truth shared by the live
 * timer path, the keepalive alarm, and a cold `start()`.
 */

/* global chrome, console */

const STORAGE_KEY = 'qwen.cdpReconnect';

/** Backoff bounds (ms). */
export const RECONNECT_MIN_MS = 1_000;
// 5 minutes. The old 30s cap predates persisted state; with a worker restart
// per retry it was the floor of the rejection spam, not the ceiling.
export const RECONNECT_MAX_MS = 300_000;

export interface ReconnectState {
  /** Consecutive connect attempts that never completed ACP initialization. */
  failures: number;
  /** Epoch ms before which no new attempt should be made. */
  nextRetryAt: number;
  /** The daemon base URL these failures belong to. */
  baseUrl: string;
}

function storage(): typeof chrome.storage.session | undefined {
  return chrome?.storage?.session;
}

/** Delay for the retry after `failures` consecutive failed attempts. */
export function computeBackoffMs(failures: number): number {
  const exp = Math.min(failures, 20); // keep 2**n sane; the cap binds far earlier
  return Math.min(RECONNECT_MIN_MS * 2 ** exp, RECONNECT_MAX_MS);
}

/**
 * Read the persisted backoff for `baseUrl`. Returns null when there is no
 * state, the state belongs to a different daemon config (config changes reset
 * the ladder), or the stored shape is unrecognizable.
 */
export async function readReconnectState(
  baseUrl: string,
): Promise<ReconnectState | null> {
  const store = storage();
  if (!store) return null;
  try {
    const raw = await store.get(STORAGE_KEY);
    const state = raw?.[STORAGE_KEY] as Partial<ReconnectState> | undefined;
    if (
      !state ||
      typeof state.failures !== 'number' ||
      typeof state.nextRetryAt !== 'number' ||
      state.baseUrl !== baseUrl
    ) {
      return null;
    }
    return state as ReconnectState;
  } catch (error) {
    console.warn('[reconnect-backoff] read failed:', error);
    return null;
  }
}

/**
 * Record one more failed attempt for `baseUrl` and return the delay before
 * the next attempt may run.
 */
export async function recordFailure(baseUrl: string): Promise<number> {
  // A failure with no known daemon base (e.g. the config read itself failed
  // before a base URL was known) must not rewrite the single-slot state: it
  // would land under an empty key and evict the real daemon's ladder. Report
  // the floor delay without persisting (#14022).
  if (!baseUrl) {
    return RECONNECT_MIN_MS;
  }
  const prev = await readReconnectState(baseUrl);
  const failures = (prev?.failures ?? 0) + 1;
  const delay = computeBackoffMs(failures - 1);
  const store = storage();
  if (store) {
    try {
      await store.set({
        [STORAGE_KEY]: {
          failures,
          nextRetryAt: Date.now() + delay,
          baseUrl,
        } satisfies ReconnectState,
      });
    } catch (error) {
      console.warn('[reconnect-backoff] persist failed:', error);
    }
  }
  return delay;
}

/** Clear the ladder after successful ACP initialization. */
export async function clearReconnectState(): Promise<void> {
  const store = storage();
  if (!store) return;
  try {
    await store.remove(STORAGE_KEY);
  } catch (error) {
    console.warn('[reconnect-backoff] clear failed:', error);
  }
}

/** True when no new attempt should be made yet for `baseUrl`. */
export async function isBackingOff(baseUrl: string): Promise<boolean> {
  const state = await readReconnectState(baseUrl);
  return state !== null && Date.now() < state.nextRetryAt;
}
