/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createAbortError } from '../../utils/delay.js';

const activeControllers = new Set<string>();
const wakeListeners = new Map<string, Set<() => void>>();

export function registerTeammateController(agentId: string): () => void {
  activeControllers.add(agentId);
  return () => {
    activeControllers.delete(agentId);
    const listeners = wakeListeners.get(agentId);
    wakeListeners.delete(agentId);
    for (const listener of listeners ?? []) {
      listener();
    }
  };
}

export function tryRegisterTeammateController(
  agentId: string,
): (() => void) | undefined {
  if (activeControllers.has(agentId)) return undefined;
  return registerTeammateController(agentId);
}

export function signalTeammateController(agentId: string): boolean {
  if (!activeControllers.has(agentId)) return false;
  for (const listener of wakeListeners.get(agentId) ?? []) {
    listener();
  }
  return true;
}

export function waitForTeammateControllerSignal(
  agentId: string,
  signal: AbortSignal,
  timeoutMs = 500,
): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(createAbortError());
  }

  return new Promise((resolve, reject) => {
    const listeners = wakeListeners.get(agentId) ?? new Set<() => void>();
    wakeListeners.set(agentId, listeners);

    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      listeners.delete(onWake);
      if (listeners.size === 0) {
        wakeListeners.delete(agentId);
      }
    };
    const finish = () => {
      cleanup();
      resolve();
    };
    const onWake = () => finish();
    const onAbort = () => {
      cleanup();
      reject(createAbortError());
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();

    listeners.add(onWake);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function resetTeammateControllersForTest(): void {
  activeControllers.clear();
  wakeListeners.clear();
}
