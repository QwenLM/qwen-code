/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react';

/**
 * Mutable queue store with synchronous reads. React subscribes to
 * changes via useSyncExternalStore — no refs, no stale closures.
 */
class MessageQueueStore {
  private queue: string[] = [];
  private snapshot: readonly string[] = Object.freeze([]);
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): readonly string[] => this.snapshot;

  private notify(): void {
    this.snapshot = Object.freeze([...this.queue]);
    for (const l of this.listeners) l();
  }

  addMessage(message: string): void {
    const trimmed = message.trim();
    if (trimmed.length > 0) {
      this.queue.push(trimmed);
      this.notify();
    }
  }

  clearQueue(): void {
    if (this.queue.length > 0) {
      this.queue = [];
      this.notify();
    }
  }

  /**
   * Pop the last queued message. Returns it for the input buffer;
   * removed from queue so it won't fire.
   */
  popLast(): string | undefined {
    if (this.queue.length === 0) return undefined;
    const popped = this.queue.pop();
    this.notify();
    return popped;
  }

  /**
   * Atomically drain all queued messages. Returns the array and clears
   * the queue in one shot — called between tool calls for mid-turn
   * injection.
   */
  drain(): string[] {
    if (this.queue.length === 0) return [];
    const drained = this.queue;
    this.queue = [];
    this.notify();
    return drained;
  }
}

export interface UseMessageQueueReturn {
  messageQueue: readonly string[];
  addMessage: (message: string) => void;
  clearQueue: () => void;
  popLast: () => string | undefined;
  drain: () => string[];
}

/**
 * Pure message queue — no auto-submit, no side effects.
 *
 * Uses useSyncExternalStore for synchronous reads (drain/popLast return
 * values immediately). The idle-drain effect lives in AppContainer
 * where both submitQuery and the queue are in scope.
 */
export function useMessageQueue(): UseMessageQueueReturn {
  const store = useMemo(() => new MessageQueueStore(), []);
  const messageQueue = useSyncExternalStore(store.subscribe, store.getSnapshot);

  const addMessage = useCallback(
    (message: string) => store.addMessage(message),
    [store],
  );
  const clearQueue = useCallback(() => store.clearQueue(), [store]);
  const popLast = useCallback(() => store.popLast(), [store]);
  const drain = useCallback(() => store.drain(), [store]);

  return { messageQueue, addMessage, clearQueue, popLast, drain };
}
