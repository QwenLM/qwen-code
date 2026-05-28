/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonTranscriptStore } from '@qwen-code/sdk/daemon';

const DEFAULT_ACTION_TIMEOUT_MS = 30_000;

export interface TimerRef {
  current: ReturnType<typeof setTimeout> | undefined;
}

export function getReconnectDelayMs(
  attempt: number,
  reconnectDelayMs: number,
  maxReconnectDelayMs: number,
): number {
  const base =
    Number.isFinite(reconnectDelayMs) && reconnectDelayMs > 0
      ? reconnectDelayMs
      : 1_000;
  const max =
    Number.isFinite(maxReconnectDelayMs) && maxReconnectDelayMs > 0
      ? Math.max(base, maxReconnectDelayMs)
      : base;
  const exponential = base * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exponential, max);
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.min(max, Math.max(1, Math.round(capped * jitter)));
}

export async function withActionTimeout<T>(
  promise: Promise<T>,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${message} after ${DEFAULT_ACTION_TIMEOUT_MS}ms`));
        }, DEFAULT_ACTION_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function delay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, delayMs);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}

export function clearPassiveAssistantDoneTimer(timerRef: TimerRef): void {
  if (timerRef.current === undefined) return;
  clearTimeout(timerRef.current);
  timerRef.current = undefined;
}

export function schedulePassiveAssistantDone(
  store: DaemonTranscriptStore,
  timerRef: TimerRef,
  reason: string = 'replay',
  delayMs: number = 80,
  onDone?: () => void,
): void {
  clearPassiveAssistantDoneTimer(timerRef);
  timerRef.current = setTimeout(() => {
    timerRef.current = undefined;
    if (!store.getSnapshot().activeAssistantBlockId) return;
    store.dispatch({ type: 'assistant.done', reason });
    onDone?.();
  }, delayMs);
}
