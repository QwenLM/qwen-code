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

/**
 * Create a new PromptCollector that resolves when called.
 */
export function createPromptCollector(): PromptCollector {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  const collector: PromptCollector = {
    texts: [],
    resolve,
    promise,
    resolved: false,
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

/**
 * Start a persistent SSE subscription for a session.
 * Collects agent_message_chunk events into the active PromptCollector.
 */
export function startEventStream(state: BridgeState, sessionId: string): void {
  // Don't create duplicate streams
  if (state.eventStreams.has(sessionId)) return;

  const abortCtrl = new AbortController();
  const stream: SessionEventStream = {
    sessionId,
    abortCtrl,
    activeCollector: null,
    lastActivityMs: Date.now(),
  };
  state.eventStreams.set(sessionId, stream);

  // Start consuming SSE in the background (fire-and-forget)
  (async () => {
    try {
      for await (const event of state.client.subscribeEvents(sessionId, {
        signal: abortCtrl.signal,
      })) {
        const data = event.data as Record<string, unknown> | undefined;
        if (!data) continue;
        const update = data['update'] as Record<string, unknown> | undefined;
        if (!update) continue;
        if (update['sessionUpdate'] === 'agent_message_chunk') {
          const content = update['content'] as
            | Record<string, unknown>
            | undefined;
          if (!content) continue;
          stream.lastActivityMs = Date.now();
          const collector = stream.activeCollector;
          if (collector) {
            const text = content['text'];
            if (typeof text === 'string' && text) {
              collector.texts.push(text);
            }
            // _meta is emitted at the update level (sibling of sessionUpdate/content)
            if ('_meta' in update) {
              collector.resolve();
            }
          }
        }
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
      // Resolve any pending collector so prompt doesn't hang on disconnect
      stream.activeCollector?.resolve();
      state.eventStreams.delete(sessionId);
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
    stream.activeCollector?.resolve();
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
