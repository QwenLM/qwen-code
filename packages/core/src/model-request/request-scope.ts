/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import type { SystemMessage } from '../protocol/transcript/message.js';
import type { ModelRequestObservation, ModelRequestObserver } from './types.js';

/** In-process only. The provider may copy the request, but JSON transports never serialize symbol keys. */
export const SINGLE_REQUEST_FORK = Symbol.for(
  'cli.prompt_suggestion.single_attempt',
);
/** @deprecated Use SINGLE_REQUEST_FORK. Both exports identify the same request. */
export { SINGLE_REQUEST_FORK as PREDICTION_FORK_REQUEST };

/** In-process control plane; never part of provider messages or wire JSON. */
export interface ModelRequestProgressIdentity {
  readonly sessionId: string;
  readonly requestSetId: string;
  readonly requestId: string;
}

const observationListeners = new Map<string, Set<ModelRequestObserver>>();

/** The key uses the initial scope IDs; records may contain later attempt IDs. */
export function onModelRequestObservation(
  identity: ModelRequestProgressIdentity,
  observer: ModelRequestObserver,
): () => void {
  try {
    const id = key(identity);
    const subscribers = observationListeners.get(id) ?? new Set();
    // Each registration owns its unsubscribe, even for the same observer.
    const listener: ModelRequestObserver = (record) => observer(record);
    subscribers.add(listener);
    observationListeners.set(id, subscribers);
    return () => {
      subscribers.delete(listener);
      if (!subscribers.size) observationListeners.delete(id);
    };
  } catch {
    return () => {};
  }
}

export function hasModelRequestObservationListeners(
  identity: ModelRequestProgressIdentity,
): boolean {
  try {
    return (observationListeners.get(key(identity))?.size ?? 0) > 0;
  } catch {
    return false;
  }
}

/** Observation callbacks never participate in Provider or transport control. */
export function publishModelRequestObservation(
  identity: ModelRequestProgressIdentity,
  observation: ModelRequestObservation,
): void {
  try {
    for (const observer of [
      ...(observationListeners.get(key(identity)) ?? []),
    ]) {
      try {
        const result = observer(observation) as unknown;
        if (result instanceof Promise) void result.catch(() => {});
      } catch {
        // A broken subscriber must not suppress another subscriber or request.
      }
    }
  } catch {
    // Invalid diagnostic identity or listener access cannot change inference.
  }
}
export type ModelRequestRecoveryEvent =
  | { kind: 'waiting'; requestId: string; error: unknown }
  | { kind: 'resubmitting'; requestId: string }
  | {
      kind: 'poll';
      failed: boolean;
      serviceAvailable?: boolean;
      serverRetryAfterMs?: number;
      serverWaitTimeMs?: number;
    }
  | {
      kind: 'wait_ended';
      requestId: string;
      waitMs: number;
      nextRequestId?: string;
    };
const recoveryListeners = new Map<
  string,
  Set<(event: ModelRequestRecoveryEvent) => void>
>();
export function onModelRequestRecovery(
  identity: ModelRequestProgressIdentity,
  listener: (event: ModelRequestRecoveryEvent) => void,
): () => void {
  const id = key(identity);
  const subscribers = recoveryListeners.get(id) ?? new Set();
  subscribers.add(listener);
  recoveryListeners.set(id, subscribers);
  return () => {
    subscribers.delete(listener);
    if (!subscribers.size) recoveryListeners.delete(id);
  };
}
export function publishModelRequestRecovery(
  identity: ModelRequestProgressIdentity,
  event: ModelRequestRecoveryEvent,
): void {
  for (const listener of recoveryListeners.get(key(identity)) ?? []) {
    // Observability must never change recovery or the business result.
    try {
      listener(event);
    } catch {
      /* best effort observer */
    }
  }
}
const listeners = new Map<string, Set<(message: SystemMessage) => void>>();
const scopeListeners = new Set<
  (sessionId: string, requestSetId?: string) => Promise<void>
>();
function key(identity: ModelRequestProgressIdentity): string {
  return JSON.stringify([
    identity.sessionId,
    identity.requestSetId,
    identity.requestId,
  ]);
}
export function publishModelRequestProgress(
  identity: ModelRequestProgressIdentity,
  message: SystemMessage,
): void {
  for (const listener of listeners.get(key(identity)) ?? []) listener(message);
}
export function onModelRequestScopeEnd(
  listener: (sessionId: string, requestSetId?: string) => Promise<void>,
): () => void {
  scopeListeners.add(listener);
  return () => {
    scopeListeners.delete(listener);
  };
}
/** Omit the turn identity only for a session-wide disposal. */
export async function endModelRequestScope(
  sessionId: string,
  requestSetId?: string,
): Promise<void> {
  await Promise.allSettled(
    [...scopeListeners].map((listener) => listener(sessionId, requestSetId)),
  );
}

/** Subscribe before advancing source; progress can wake a blocked inference. */
export async function* mergeModelRequestProgress<T, R>(
  identity: ModelRequestProgressIdentity,
  source: AsyncGenerator<T, R>,
): AsyncGenerator<T | SystemMessage, R> {
  const id = key(identity);
  const queued: SystemMessage[] = [];
  let wake: (() => void) | undefined;
  const receive = (message: SystemMessage) => {
    // Progress is replaceable, not a lossless data stream. Bound stalled readers.
    if (queued.length === 32) queued.shift();
    queued.push(message);
    wake?.();
  };
  const subscribers = listeners.get(id) ?? new Set();
  subscribers.add(receive);
  listeners.set(id, subscribers);
  let pending: Promise<IteratorResult<T, R>> | undefined;
  let done = false;
  try {
    for (;;) {
      pending ??= source.next();
      if (queued.length) {
        yield queued.shift()!;
        continue;
      }
      const progress = new Promise<undefined>((resolve) => {
        wake = () => resolve(undefined);
      });
      const next = await Promise.race([pending, progress]);
      wake = undefined;
      if (!next) continue;
      pending = undefined;
      if (next.done) {
        done = true;
        return next.value;
      }
      try {
        yield next.value;
      } catch (error) {
        // Preserve yield* semantics: the runner handles consumer interruptions
        // at its suspended delivery point, including validated terminal frames.
        pending = source.throw(error);
      }
    }
  } finally {
    subscribers.delete(receive);
    if (!subscribers.size) listeners.delete(id);
    if (!done) await source.return(undefined as R);
  }
}
