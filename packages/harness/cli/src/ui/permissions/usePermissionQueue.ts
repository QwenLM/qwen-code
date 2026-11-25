/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * React hook for the permission queue store.
 *
 * Uses `useSyncExternalStore` for tear-free reads from the
 * PermissionQueueStore. The store's snapshot is replaced (new array
 * reference) on each mutation, so React detects changes correctly.
 */

import { useSyncExternalStore } from 'react';
import type {
  PermissionQueueStore,
  QueuedPermissionPrompt,
} from './permissionQueueStore.js';
import { useOptionalPermissionQueueStore } from './PermissionQueueContext.js';

/** Empty snapshot for server-side rendering (not used in CLI, but required by React). */
const EMPTY_SNAPSHOT: readonly QueuedPermissionPrompt[] = [];

/** No-op subscribe — never fires, returns no-op unsubscribe. */
const NOOP_SUBSCRIBE =
  (_listener: () => void): (() => void) =>
  () => {};

/** Always returns the empty snapshot. */
const GET_EMPTY = (): readonly QueuedPermissionPrompt[] => EMPTY_SNAPSHOT;

/**
 * Subscribes to a PermissionQueueStore and returns the current queue snapshot.
 *
 * @param store The permission queue store to subscribe to
 * @returns Current queue snapshot (readonly array of PermissionRequestItem)
 */
export function usePermissionQueue(
  store: PermissionQueueStore,
): readonly QueuedPermissionPrompt[] {
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    () => EMPTY_SNAPSHOT,
  );
}

/**
 * Like usePermissionQueue, but accepts a nullable store.
 * Returns an empty array when no store is provided.
 * Safe to call unconditionally (no rules-of-hooks violation).
 */
export function useOptionalPermissionQueue(
  store: PermissionQueueStore | null | undefined,
): readonly QueuedPermissionPrompt[] {
  return useSyncExternalStore(
    store ? store.subscribe : NOOP_SUBSCRIBE,
    store ? store.getSnapshot : GET_EMPTY,
    GET_EMPTY,
  );
}

/**
 * Convenience hook: resolves the optional store from context and
 * returns the current queue snapshot. Always safe to call unconditionally.
 */
export function usePermissionQueueItems(): readonly QueuedPermissionPrompt[] {
  const store = useOptionalPermissionQueueStore();
  return useOptionalPermissionQueue(store);
}
