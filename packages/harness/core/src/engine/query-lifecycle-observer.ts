/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Query lifecycle observer mechanism.
 *
 * Provides a generic extension point for product-level side-effects that
 * need to observe query boundaries (start/end/error) without polluting the
 * agent-loop core. Unlike HookSystem, lifecycle observers are product-internal,
 * always enabled, and not user-configurable.
 */

import type { Terminal } from '../core/query-event.js';
import type { QueryBusinessContext } from '../core/query-business-context.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QueryLifecycleContext {
  sessionId: string;
  promptId: string;
  requestSetId: string;
  model: string;
  workspacePath: string;
  isInteractive: boolean;
}

export interface QueryLifecycleObserver {
  onQueryStart?(ctx: QueryLifecycleContext): void | Promise<void>;

  /** Called synchronously when the main Agent creates its business context. */
  onBusinessContextReady?(ctx: QueryBusinessContext): void;

  onQueryEnd?(
    terminal: Terminal,
    ctx: QueryLifecycleContext,
  ): void | Promise<void>;

  onQueryError?(
    error: unknown,
    ctx: QueryLifecycleContext,
  ): void | Promise<void>;
}

export interface QueryLifecycleRunnerOptions {
  /** Per-observer timeout in milliseconds. Undefined = no timeout. */
  timeoutMs?: number;
  logger?: {
    debug(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default per-observer timeout at the runner level.
 * Acts as a hard cap even if the observer's internal timeout is misconfigured.
 */
export const DEFAULT_LIFECYCLE_OBSERVER_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Wraps a void | Promise<void> with an optional timeout.
 * - If result is void (synchronous return), resolves immediately.
 * - If timeoutMs is undefined or <= 0, awaits without timeout.
 * - Otherwise, rejects with a timeout error if the promise doesn't settle.
 */
async function withOptionalTimeout(
  result: void | Promise<void>,
  timeoutMs?: number,
): Promise<void> {
  if (result === undefined) return;
  if (timeoutMs === undefined || timeoutMs <= 0) {
    await result;
    return;
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`Observer timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
    (result as Promise<void>).then(
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      },
      (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Safe dispatcher for query lifecycle observers.
 *
 * Guarantees:
 * 1. All registered observers are called (Promise.allSettled).
 * 2. Individual observer sync/async errors are caught and logged.
 * 3. Optional per-observer timeout prevents a single observer from hanging.
 * 4. Observer failures never propagate to the calling entry layer.
 */
export class QueryLifecycleRunner {
  constructor(
    private readonly observers: readonly QueryLifecycleObserver[],
    private readonly options: QueryLifecycleRunnerOptions = {},
  ) {}

  async notifyQueryStart(ctx: QueryLifecycleContext): Promise<void> {
    if (!this.observers.some((obs) => obs.onQueryStart)) return;
    await Promise.allSettled(
      this.observers.map((obs) =>
        this.callObserver(obs, 'onQueryStart', () => obs.onQueryStart?.(ctx)),
      ),
    );
  }

  /**
   * Synchronous, failure-isolated handoff from the Agent loop. This method never
   * creates an await boundary in the query path.
   */
  notifyBusinessContextReady(ctx: QueryBusinessContext): void {
    for (const observer of this.observers) {
      if (!observer.onBusinessContextReady) continue;
      try {
        observer.onBusinessContextReady(ctx);
      } catch (error) {
        const name =
          observer.constructor?.name !== 'Object'
            ? observer.constructor.name
            : 'AnonymousObserver';
        this.options.logger?.warn(
          `[QueryLifecycle] Observer ${name}.onBusinessContextReady failed:`,
          error,
        );
      }
    }
  }

  async notifyQueryEnd(
    terminal: Terminal,
    ctx: QueryLifecycleContext,
  ): Promise<void> {
    if (!this.observers.some((obs) => obs.onQueryEnd)) return;
    await Promise.allSettled(
      this.observers.map((obs) =>
        this.callObserver(obs, 'onQueryEnd', () =>
          obs.onQueryEnd?.(terminal, ctx),
        ),
      ),
    );
  }

  async notifyQueryError(
    error: unknown,
    ctx: QueryLifecycleContext,
  ): Promise<void> {
    if (!this.observers.some((obs) => obs.onQueryError)) return;
    await Promise.allSettled(
      this.observers.map((obs) =>
        this.callObserver(obs, 'onQueryError', () =>
          obs.onQueryError?.(error, ctx),
        ),
      ),
    );
  }

  private async callObserver(
    observer: QueryLifecycleObserver,
    eventName: string,
    call: () => void | Promise<void>,
  ): Promise<void> {
    try {
      const result = call();
      await withOptionalTimeout(result, this.options.timeoutMs);
    } catch (error) {
      const name =
        observer.constructor?.name !== 'Object'
          ? observer.constructor.name
          : 'AnonymousObserver';
      this.options.logger?.warn(
        `[QueryLifecycle] Observer ${name}.${eventName} failed:`,
        error,
      );
    }
  }
}
