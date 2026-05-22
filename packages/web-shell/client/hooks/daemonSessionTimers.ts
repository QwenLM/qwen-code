import type { MutableRefObject } from 'react';
import type { DaemonTranscriptStore } from '@qwen-code/sdk/daemon';

export type TimerRef = MutableRefObject<
  ReturnType<typeof setTimeout> | undefined
>;

export function clearPassiveAssistantDoneTimer(timerRef: TimerRef): void {
  if (timerRef.current) {
    clearTimeout(timerRef.current);
    timerRef.current = undefined;
  }
}

export function schedulePassiveAssistantDone(
  store: DaemonTranscriptStore,
  timerRef: TimerRef,
  reason: string = 'replay',
  delayMs: number = 80,
): void {
  clearPassiveAssistantDoneTimer(timerRef);
  timerRef.current = setTimeout(() => {
    timerRef.current = undefined;
    if (!store.getSnapshot().activeAssistantBlockId) return;
    store.dispatch({ type: 'assistant.done', reason });
  }, delayMs);
}

export function getReconnectDelay(
  attempt: number,
  base: number,
  max: number,
): number {
  const exponential = base * 2 ** Math.max(0, attempt - 1);
  return Math.min(exponential, max);
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}
