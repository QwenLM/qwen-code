/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isInvalidDaemonClientIdError } from '../../daemon/DaemonHttpError.js';
import { createEventStream, startEventStream, stopEventStream } from './sse.js';
import type { BridgeState, SessionBinding } from './types.js';

const SESSION_TTL_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

export function createBinding(
  sessionId: string,
  clientId?: string,
): SessionBinding {
  return {
    sessionId,
    clientId,
    stream: createEventStream(sessionId),
  };
}

export async function replaceBinding(
  state: BridgeState,
  next: SessionBinding,
): Promise<void> {
  const previous = state.bindings.get(next.sessionId);
  if (previous?.stream.activeCollector) {
    await releaseBinding(state, next);
    throw new Error(
      'Cannot replace a session binding while a prompt is in progress.',
    );
  }
  if (state.disposed) {
    await releaseBinding(state, next);
    throw new Error('qwen-serve-bridge is shutting down.');
  }

  state.bindings.set(next.sessionId, next);
  state.defaultSessionId = next.sessionId;
  startEventStream(state, next, () => {
    void withSessionLock(state, next.sessionId, async () => {
      if (state.bindings.get(next.sessionId) === next) {
        await releaseBinding(state, next);
      }
    });
  });

  if (previous) {
    await releaseBinding(state, previous);
  }
}

export function releaseBinding(
  state: BridgeState,
  binding: SessionBinding,
  detach = true,
): Promise<void> {
  if (binding.releasePromise) return binding.releasePromise;

  if (state.bindings.get(binding.sessionId) === binding) {
    state.bindings.delete(binding.sessionId);
    if (state.defaultSessionId === binding.sessionId) {
      state.defaultSessionId = undefined;
    }
  }

  const releasePromise = (
    detach && binding.clientId
      ? state.client.detachSession(binding.sessionId, binding.clientId)
      : Promise.resolve()
  )
    .catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[serve-bridge] Failed to detach session ${binding.sessionId}: ${detail}\n`,
      );
    })
    .finally(() => {
      state.pendingReleases.delete(releasePromise);
    });
  binding.releasePromise = releasePromise;
  state.pendingReleases.add(releasePromise);
  stopEventStream(binding.stream);
  return releasePromise;
}

export async function withSessionLock<T>(
  state: BridgeState,
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = state.sessionLocks.get(sessionId) ?? Promise.resolve();
  let unlock!: () => void;
  const current = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const tail = previous.then(() => current);
  state.sessionLocks.set(sessionId, tail);
  await previous;
  try {
    return await fn();
  } finally {
    unlock();
    if (state.sessionLocks.get(sessionId) === tail) {
      state.sessionLocks.delete(sessionId);
    }
  }
}

export function trackLifecycle<T>(
  state: BridgeState,
  fn: () => Promise<T>,
): Promise<T> {
  if (state.disposed) {
    return Promise.reject(new Error('qwen-serve-bridge is shutting down.'));
  }

  const operation = Promise.resolve().then(fn);
  const tracked = operation.then(
    () => undefined,
    () => undefined,
  );
  state.pendingLifecycles.add(tracked);
  void tracked.then(() => state.pendingLifecycles.delete(tracked));
  return operation;
}

export function resolveBinding(
  state: BridgeState,
  sessionId: string,
): SessionBinding {
  const binding = state.bindings.get(sessionId);
  if (!binding) {
    throw new Error(
      `No active binding for session ${sessionId}. Call session_resume first.`,
    );
  }
  binding.stream.lastActivityMs = Date.now();
  return binding;
}

export async function invalidateBinding(
  state: BridgeState,
  binding: SessionBinding,
): Promise<boolean> {
  if (state.bindings.get(binding.sessionId) !== binding) return false;
  await releaseBinding(state, binding, false);
  return true;
}

export async function rethrowBindingError(
  state: BridgeState,
  binding: SessionBinding,
  err: unknown,
): Promise<never> {
  if (!isInvalidDaemonClientIdError(err)) throw err;

  if (await invalidateBinding(state, binding)) {
    throw new Error(
      `The daemon rejected the client binding for session ${binding.sessionId}. Call session_resume before retrying.`,
      { cause: err },
    );
  }

  throw new Error(
    `The binding for session ${binding.sessionId} changed while the request was in flight. Retry the request.`,
    { cause: err },
  );
}

export function startSessionCleanup(state: BridgeState): () => void {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const binding of state.bindings.values()) {
      if (
        !binding.stream.activeCollector &&
        now - binding.stream.lastActivityMs > SESSION_TTL_MS
      ) {
        process.stderr.write(
          `[serve-bridge] Cleaning up idle session SSE: ${binding.sessionId}\n`,
        );
        void releaseBinding(state, binding);
      }
    }
  }, CLEANUP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

export async function disposeBindings(state: BridgeState): Promise<void> {
  state.disposed = true;
  while (state.pendingLifecycles.size > 0) {
    await Promise.all([...state.pendingLifecycles]);
  }
  await Promise.all(
    [...state.bindings.values()].map((binding) =>
      releaseBinding(state, binding),
    ),
  );
  while (state.pendingReleases.size > 0) {
    await Promise.all([...state.pendingReleases]);
  }
}
