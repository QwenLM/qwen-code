/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { performance } from 'node:perf_hooks';
import { isMainThread, threadId } from 'node:worker_threads';
import { runLogger } from '../utils/runLogger.js';

export const STARTUP_SLOW_THRESHOLD_MS = 5_000;

type Outcome = 'resolved' | 'rejected';

/** Result attributes: static values and counts only, never paths or prompt text. */
export type StartupPhaseAttrs = Readonly<
  Record<string, string | number | boolean>
>;

/** Optional sink so callers can forward existing startup diagnostics. */
export interface StartupPhaseObservation {
  readonly kind: 'phase' | 'operation';
  readonly name: string;
  readonly durationMs: number;
  readonly status: Outcome;
  readonly attrs?: StartupPhaseAttrs;
}

export type StartupPhaseObserver = (record: StartupPhaseObservation) => void;
let nextObservationId = 0;

/** Lexical classification only: drive letters may themselves be network mounts. */
export function startupPathKind(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  if (/^\/\/[?.]\/UNC\//i.test(normalized)) return 'unc';
  if (/^\/\/[?.]\/[a-z]:\//i.test(normalized)) return 'windows_drive';
  if (/^\/\/[^/]+\/[^/]+/.test(normalized)) return 'unc';
  if (/^[a-z]:\//i.test(normalized)) return 'windows_drive';
  return normalized.startsWith('/') ? 'posix' : 'other';
}

/**
 * Process-log observations, never readiness gates. Actions run immediately and
 * callers receive the original promise (including its original rejection).
 */
export class StartupDiagnostics {
  private readonly pathKind: string;

  constructor(
    private readonly sessionId: string,
    cwd: string,
    private readonly onObservation?: StartupPhaseObserver,
  ) {
    this.pathKind = startupPathKind(cwd);
  }

  /** `describe` turns the resolved value into attributes on the finished record. */
  phase<T>(
    name: string,
    action: () => Promise<T>,
    describe?: (result: T) => StartupPhaseAttrs,
  ): Promise<T> {
    return this.observe('phase', name, action, describe);
  }

  operation<T>(name: string, action: () => Promise<T>): Promise<T> {
    return this.observe('operation', name, action);
  }

  private observe<T>(
    kind: 'phase' | 'operation',
    name: string,
    action: () => Promise<T>,
    describe?: (result: T) => StartupPhaseAttrs,
  ): Promise<T> {
    const startedAt = performance.now();
    const observationId = ++nextObservationId;
    const log = (
      event: string,
      status?: Outcome,
      attrs?: StartupPhaseAttrs,
    ): void => {
      try {
        runLogger.log('[startup.diagnostic]', {
          ...attrs,
          event,
          kind,
          name,
          observation_id: observationId,
          session_id: this.sessionId,
          pid: process.pid,
          thread_id: threadId,
          is_main_thread: isMainThread,
          workspace_path_kind: this.pathKind,
          duration_ms: Math.round(performance.now() - startedAt),
          ...(status ? { status } : {}),
        });
      } catch {
        // Diagnostics must not change task outcomes, even if the writer fails.
      }
    };
    if (kind === 'phase') log('started');
    // One observation, not a deadline or periodic heartbeat. An unref'ed timer
    // must not keep a hung/background startup task's process alive.
    const timer = setTimeout(
      () => log('still_pending'),
      STARTUP_SLOW_THRESHOLD_MS,
    );
    timer.unref();
    const finish = (status: Outcome, attrs?: StartupPhaseAttrs): void => {
      clearTimeout(timer);
      const durationMs = Math.round(performance.now() - startedAt);
      if (
        kind === 'phase' ||
        status === 'rejected' ||
        durationMs >= STARTUP_SLOW_THRESHOLD_MS
      ) {
        log('finished', status, attrs);
      }
      try {
        this.onObservation?.({ kind, name, durationMs, status, attrs });
      } catch {
        // An observer failure is diagnostics-only and must not change the outcome.
      }
    };
    const describeResult = (result: T): StartupPhaseAttrs | undefined => {
      if (!describe) return undefined;
      try {
        return describe(result);
      } catch {
        return undefined;
      }
    };
    try {
      const promise = action();
      void promise.then(
        (result) => finish('resolved', describeResult(result)),
        () => finish('rejected'),
      );
      return promise;
    } catch (error) {
      finish('rejected');
      throw error;
    }
  }
}
