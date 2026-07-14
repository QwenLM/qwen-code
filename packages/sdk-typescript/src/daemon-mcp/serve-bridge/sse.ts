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
  SessionBinding,
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
export function createEventStream(sessionId: string): SessionEventStream {
  const abortCtrl = new AbortController();
  return {
    sessionId,
    abortCtrl,
    activeCollector: null,
    lastActivityMs: Date.now(),
  };
}

export function startEventStream(
  state: BridgeState,
  binding: SessionBinding,
  onEnd: () => void,
): void {
  const { sessionId, stream } = binding;
  // Start consuming SSE in the background (fire-and-forget)
  (async () => {
    try {
      for await (const event of state.client.subscribeEvents(sessionId, {
        signal: stream.abortCtrl.signal,
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
            // Protocol contract: daemon emits _meta only on the final
            // agent_message_chunk update (sibling of sessionUpdate/content).
            // If future daemon versions move _meta elsewhere, this check
            // will need updating — the collector will hang until timeout.
            if ('_meta' in update) {
              collector.resolve();
            }
          }
        } else if (
          typeof update['sessionUpdate'] === 'string' &&
          // Best-effort error detection: daemon does not yet define a formal
          // error event enum, so we match common patterns. This may produce
          // false positives (e.g. "default_fallback") or miss events like
          // "quota_exceeded". Update once daemon publishes an error event spec.
          /error|fail/i.test(update['sessionUpdate'] as string)
        ) {
          process.stderr.write(
            `[serve-bridge] daemon error event for ${sessionId}: ${JSON.stringify(update)}\n`,
          );
          // Resolve collector so prompt returns immediately with partial text
          if (stream.activeCollector) {
            stream.activeCollector.interrupted = true;
            stream.activeCollector.resolve();
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
      if (stream.activeCollector) {
        stream.activeCollector.interrupted = true;
        stream.activeCollector.resolve();
      }
      onEnd();
    }
  })();
}

/**
 * Stop the persistent SSE subscription for a session.
 */
export function stopEventStream(stream: SessionEventStream): void {
  stream.abortCtrl.abort();
  // Resolve any pending collector so prompt doesn't hang
  if (stream.activeCollector) {
    stream.activeCollector.interrupted = true;
    stream.activeCollector.resolve();
  }
}
