/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cross-package sink for startup-time profiler events.
 *
 * The cli package owns the actual startup profiler (`packages/cli/src/utils/startupProfiler.ts`)
 * but core-package code (config init, MCP discovery, GeminiClient.setTools, etc.) is
 * the source of several first-screen / first-paint metrics. To avoid an
 * undesirable core → cli dependency, core code records events via this sink,
 * and the cli registers a real handler at startup.
 *
 * When no handler is registered (the common case in tests / non-interactive
 * paths / when QWEN_CODE_PROFILE_STARTUP=0), `recordStartupEvent` is a no-op
 * with O(1) overhead.
 */

import { createDebugLogger } from './debugLogger.js';

const debugLogger = createDebugLogger('STARTUP_EVENT_SINK');

export type StartupEventAttrs = Record<string, string | number | boolean>;

export type StartupEventSink = (
  name: string,
  attrs?: StartupEventAttrs,
) => void;

let sink: StartupEventSink | null = null;

/**
 * Registers the active sink. Typically called once at cli entry.
 */
export function setStartupEventSink(handler: StartupEventSink | null): void {
  sink = handler;
}

/**
 * Records a startup event. Safe to call from any package; no-op when no sink
 * is registered.
 */
export function recordStartupEvent(
  name: string,
  attrs?: StartupEventAttrs,
): void {
  if (sink) {
    try {
      sink(name, attrs);
    } catch (err) {
      // Profiler sinks must never throw into hot paths (this is called
      // from startup-critical code: config init, MCP discovery, setTools),
      // but route the failure through `debugLogger` so a corrupted sink
      // doesn't silently drop every subsequent event. `debugLogger` is
      // quiet by default and visible under `QWEN_CODE_DEBUG=1` and in the
      // debug log file — matching how other "must never throw" sites in
      // this PR (e.g. AppContainer's `setTools` flush) surface errors.
      debugLogger.error(
        `startup event sink threw for '${name}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
