/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Progressive MCP tool availability for the OpenTUI backend (ink parity).
 *
 * As each MCP server completes discovery, `McpClientManager` emits
 * `mcp-client-update`. The ink tree coalesces those events into at most one
 * `GeminiClient.setTools()` call per ~16ms window
 * (`AppContainer.tsx:1044-1175`), so the model sees one consolidated tool
 * refresh instead of N back-to-back ones. The OpenTUI tree had NO
 * subscriber, so MCP tools discovered after startup never reached the model
 * tool table for the whole session. This module replicates the batch-flush.
 *
 * Events arrive on the shared `appEvents` emitter (the same instance the
 * registry's MCP manager emits on), so this works regardless of when
 * `config.initialize()` runs.
 */

import type { Config } from '@qwen-code/qwen-code-core';
import { appEvents } from '../../utils/events.js';

/**
 * Coalescing window for `mcp-client-update` → `setTools()`. Matches ink's
 * `MCP_BATCH_FLUSH_MS` (16 ≈ one 60Hz frame).
 */
export const MCP_BATCH_FLUSH_MS = 16;

/**
 * Subscribes to `mcp-client-update` and batch-flushes `setTools()`. Returns
 * a disposer that removes the listener and cancels any pending flush. The
 * client is read lazily at flush time so a not-yet-initialised config still
 * wires up correctly.
 */
export function startMcpProgressiveDiscovery(
  config: Config | undefined,
  opts: {
    setTimeoutFn?: (fn: () => void, ms: number) => unknown;
    clearTimeoutFn?: (handle: unknown) => void;
    onError?: (err: unknown) => void;
  } = {},
): () => void {
  if (!config) return () => {};
  const setTimeoutFn =
    opts.setTimeoutFn ??
    ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
  const clearTimeoutFn =
    opts.clearTimeoutFn ??
    ((handle: unknown): void =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));
  const onError = opts.onError ?? (() => {});

  let flushTimer: unknown = null;

  const flushNow = (): Promise<void> => {
    if (flushTimer !== null) {
      clearTimeoutFn(flushTimer);
      flushTimer = null;
    }
    const client = config.getGeminiClient?.();
    if (!client) return Promise.resolve();
    // GeminiClient.setTools() has no internal try/catch; route failures to
    // the error sink instead of dropping them on the floor.
    return Promise.resolve(client.setTools()).catch((err) => {
      onError(err);
    });
  };

  const scheduleFlush = () => {
    if (flushTimer !== null) return;
    flushTimer = setTimeoutFn(() => {
      flushTimer = null;
      void flushNow();
    }, MCP_BATCH_FLUSH_MS);
  };

  const onMcpUpdate = () => {
    scheduleFlush();
  };

  appEvents.on('mcp-client-update', onMcpUpdate);

  return () => {
    appEvents.off('mcp-client-update', onMcpUpdate);
    if (flushTimer !== null) {
      clearTimeoutFn(flushTimer);
      flushTimer = null;
    }
  };
}
