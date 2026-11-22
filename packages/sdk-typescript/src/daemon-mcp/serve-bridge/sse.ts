/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Persistent SSE connection lifecycle management.
 */

import type {
  BridgeState,
  PromptCollector,
  SessionEventStream,
} from './types.js';
import { matchTurnEvent } from '../../daemon/DaemonClient.js';
import type { DaemonEvent } from '../../daemon/types.js';

/**
 * Create a new PromptCollector that resolves when called.
 */
export function createPromptCollector(
  awaitingAcceptance = false,
): PromptCollector {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  const collector: PromptCollector = {
    texts: [],
    resolve,
    promise,
    resolved: false,
    ...(awaitingAcceptance ? { pendingEvents: [] } : {}),
  };
  // Wrap resolve to guard against double-resolution
  const originalResolve = resolve;
  collector.resolve = () => {
    if (!collector.resolved) {
      collector.resolved = true;
      originalResolve();
    }
  };
  return collector;
}

/** Preserve the first terminal outcome of a prompt collector. */
export function interruptPromptCollector(
  collector: PromptCollector | null | undefined,
): void {
  if (!collector || collector.completed || collector.interrupted) return;
  if (collector.pendingEvents) {
    collector.pendingEvents.push(null);
    return;
  }
  collector.interrupted = true;
  collector.resolve();
}

/** Bind the admitted turn before replaying events that raced its response. */
export function bindPromptCollector(
  collector: PromptCollector,
  promptId?: string,
): void {
  const pending = collector.pendingEvents ?? [];
  collector.pendingEvents = undefined;
  collector.promptId = promptId;
  for (const event of pending) {
    if (event === null) interruptPromptCollector(collector);
    else collectPromptEvent(collector, event);
  }
}

function collectPromptEvent(
  collector: PromptCollector | null,
  event: DaemonEvent,
): void {
  if (!collector || collector.completed || collector.interrupted) return;
  const data = event.data as Record<string, unknown> | undefined;
  const terminal =
    event.type === 'turn_complete' || event.type === 'turn_error';
  const update = data?.['update'] as Record<string, unknown> | undefined;
  const chunk = update?.['sessionUpdate'] === 'agent_message_chunk';
  const error =
    typeof update?.['sessionUpdate'] === 'string' &&
    /error|fail/i.test(update['sessionUpdate']);
  if (!terminal && !chunk && !error) return;

  const meta = update?.['_meta'];
  if (
    chunk &&
    typeof meta === 'object' &&
    meta !== null &&
    ((meta as Record<string, unknown>)['qwenDiscreteMessage'] === true ||
      (meta as Record<string, unknown>)['backgroundTurn'] !== undefined)
  )
    return;

  if (collector.pendingEvents) {
    collector.pendingEvents.push(event);
    return;
  }
  if (
    collector.promptId &&
    event.promptId &&
    event.promptId !== collector.promptId
  )
    return;
  if (terminal) {
    if (!collector.promptId || data?.['promptId'] !== collector.promptId)
      return;
    try {
      const result = matchTurnEvent(event, collector.promptId);
      if (result) {
        collector.result = result;
        completePromptCollector(collector);
      }
    } catch (error) {
      collector.error =
        error instanceof Error ? error : new Error(String(error));
      interruptPromptCollector(collector);
    }
    return;
  }
  if (error) {
    interruptPromptCollector(collector);
    return;
  }
  const content = update?.['content'] as Record<string, unknown> | undefined;
  if (!update || !content) return;
  const text = content['text'];
  if (typeof text === 'string' && text) collector.texts.push(text);
  const lifecycle =
    typeof meta === 'object' &&
    meta !== null &&
    (Object.hasOwn(meta, 'executionLifecycle') ||
      Object.hasOwn(meta, 'hookLifecycle'));
  // Only legacy blocking replies use metadata to release the collection wait.
  // Nonblocking replies need the matching terminal on this same stream.
  if (!collector.promptId && '_meta' in update && !lifecycle)
    collector.resolve();
}

/** Mark a real terminal success without overwriting an earlier interruption. */
export function completePromptCollector(
  collector: PromptCollector | null | undefined,
): void {
  if (!collector || collector.completed || collector.interrupted) return;
  collector.completed = true;
  collector.resolve();
}

/**
 * Start a persistent SSE subscription for a session.
 * Collects agent_message_chunk events into the active PromptCollector.
 */
export function startEventStream(state: BridgeState, sessionId: string): void {
  // Don't create duplicate streams; allow re-creation if the old stream is dead
  if (state.eventStreams.has(sessionId)) {
    const existing = state.eventStreams.get(sessionId)!;
    if (!existing.abortCtrl.signal.aborted) return;
    // Stale entry from a dead stream — clean up and re-create
    state.eventStreams.delete(sessionId);
  }

  const abortCtrl = new AbortController();
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  abortCtrl.signal.addEventListener('abort', markReady, { once: true });
  const stream: SessionEventStream = {
    sessionId,
    abortCtrl,
    ready,
    activeCollector: null,
    lastActivityMs: Date.now(),
  };
  state.eventStreams.set(sessionId, stream);

  // Start consuming SSE in the background (fire-and-forget)
  (async () => {
    try {
      for await (const event of state.client.subscribeEvents(sessionId, {
        signal: abortCtrl.signal,
        onSseStreamAccepted: markReady,
      })) {
        const data = event.data as Record<string, unknown> | undefined;
        const update = data?.['update'] as Record<string, unknown> | undefined;
        if (update?.['sessionUpdate'] === 'agent_message_chunk') {
          const content = update['content'] as
            | Record<string, unknown>
            | undefined;
          if (!content) continue;
          stream.lastActivityMs = Date.now();
        } else if (
          typeof update?.['sessionUpdate'] === 'string' &&
          // Legacy session_update errors use varied names. Retain this
          // best-effort detection alongside the formal turn_error event.
          /error|fail/i.test(update['sessionUpdate'] as string)
        ) {
          process.stderr.write(
            `[serve-bridge] daemon error event for ${sessionId}: ${JSON.stringify(update)}\n`,
          );
        }
        collectPromptEvent(stream.activeCollector, event);
      }
    } catch (err) {
      // Log unexpected SSE disconnections (skip AbortError from intentional close)
      if (!(err instanceof Error && err.name === 'AbortError')) {
        const detail = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[serve-bridge] SSE stream ended unexpectedly for session ${sessionId}: ${detail}\n`,
        );
      }
    } finally {
      markReady();
      // Resolve any pending collector so prompt doesn't hang on disconnect
      interruptPromptCollector(stream.activeCollector);
      // Only delete if this is still our stream (not replaced by startEventStream)
      if (state.eventStreams.get(sessionId) === stream) {
        state.eventStreams.delete(sessionId);
        // Clear defaultSessionId so callers get a clear error
        if (state.defaultSessionId === sessionId) {
          state.defaultSessionId = undefined;
        }
      }
    }
  })();
}

/**
 * Stop the persistent SSE subscription for a session.
 */
export function stopEventStream(state: BridgeState, sessionId: string): void {
  const stream = state.eventStreams.get(sessionId);
  if (stream) {
    stream.abortCtrl.abort();
    // Resolve any pending collector so prompt doesn't hang
    interruptPromptCollector(stream.activeCollector);
    state.eventStreams.delete(sessionId);
  }
}

/** Default session idle TTL: 30 minutes. */
const SESSION_TTL_MS = 30 * 60 * 1000;
/** Cleanup interval: every 5 minutes. */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Start a periodic cleanup timer that removes idle SSE streams.
 * Returns a cleanup function to stop the timer (call on server shutdown).
 */
export function startSessionCleanup(state: BridgeState): () => void {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [sessionId, stream] of state.eventStreams) {
      if (now - stream.lastActivityMs > SESSION_TTL_MS) {
        process.stderr.write(
          `[serve-bridge] Cleaning up idle session SSE: ${sessionId}\n`,
        );
        stopEventStream(state, sessionId);
        if (state.defaultSessionId === sessionId) {
          state.defaultSessionId = undefined;
        }
      }
    }
  }, CLEANUP_INTERVAL_MS);
  // Don't keep the process alive just for cleanup
  timer.unref();
  return () => clearInterval(timer);
}
