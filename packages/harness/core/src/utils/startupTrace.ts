/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { performance } from 'node:perf_hooks';
import { isMainThread, threadId } from 'node:worker_threads';
import { runLogger } from './runLogger.js';
import { BRAND_PROTOCOL_NAMESPACE } from '../config/brand.js';
import {
  STARTUP_SLOW_THRESHOLD_MS,
  type StartupPhaseAttrs,
} from '../startup/startupDiagnostics.js';

let nextObservationId = 0;

/**
 * Durable breadcrumbs, including before synchronous work that can block timers.
 * A missing finish is an incomplete observation, not proof of a particular root
 * cause. The one-shot pending timer is diagnostic only and cannot keep a worker
 * alive. Names are static; never pass paths, argv, credentials or prompt text.
 */
export type StartupStepStatus = 'resolved' | 'rejected';
export type StartupStepObserver = (
  durationMs: number,
  status?: StartupStepStatus,
) => void;

export function beginStartupStep(
  step: string,
  observePending = false,
  onFinish?: StartupStepObserver,
): (status?: StartupStepStatus) => void {
  const startedAt = performance.now();
  const observationId = ++nextObservationId;
  let finished = false;
  const log = (state: string, status?: StartupStepStatus): void => {
    try {
      runLogger.log(`[startup-trace] step=${step} state=${state}`, {
        observation_id: observationId,
        pid: process.pid,
        thread_id: threadId,
        is_main_thread: isMainThread,
        duration_ms: Math.round(performance.now() - startedAt),
        ...(status ? { status } : {}),
      });
    } catch {
      // A diagnostic writer failure must not change startup or cleanup results.
    }
  };
  log('started');
  // Legacy callers may not close on failure; only settlement-safe callers opt in.
  const timer = observePending
    ? setTimeout(() => log('still_pending'), STARTUP_SLOW_THRESHOLD_MS)
    : undefined;
  timer?.unref();
  return (status) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    const durationMs = Math.round(performance.now() - startedAt);
    log('finished', status);
    try {
      onFinish?.(durationMs, status);
    } catch {
      // An observer failure is diagnostics-only and must not change the outcome.
    }
  };
}

/** Observe synchronous work without changing its result or thrown error. */
export function traceStartupStep<T>(step: string, action: () => T): T {
  const done = beginStartupStep(step, true);
  try {
    const result = action();
    done('resolved');
    return result;
  } catch (error) {
    done('rejected');
    throw error;
  }
}

/**
 * User-visible startup boundaries. A closed union keeps milestone names in one
 * place so every entry point (TUI / headless / SDK) reports the same vocabulary.
 */
export type StartupMilestone =
  | 'mcp_manager_ready'
  | 'mcp_user_servers_settled'
  | 'model_catalog_ready'
  | 'tui_first_frame'
  | 'tui_input_ready'
  | 'tui_first_turn_ready'
  | 'session_opened'
  | 'session_initialized'
  | 'first_stream_event'
  | 'first_text';

export type StartupMilestoneListener = (
  name: StartupMilestone,
  key: string,
) => void;

export const STARTUP_MILESTONE_MARK_PREFIX = `${BRAND_PROTOCOL_NAMESPACE}:milestone:`;

const reachedMilestones = new Map<string, number>();
const milestoneListeners = new Set<StartupMilestoneListener>();

function milestoneKey(name: StartupMilestone, scope?: string): string {
  return scope ? `${name}:${scope}` : name;
}

/**
 * Records the first arrival at a milestone and returns its process-relative
 * monotonic time; later calls return the first time without side effects.
 * `scope` separates per-session milestones (pass the sessionId). Attributes
 * follow the breadcrumb rule above: static values and counts only.
 */
export function markStartupMilestone(
  name: StartupMilestone,
  scope?: string,
  attrs?: StartupPhaseAttrs,
): number {
  const key = milestoneKey(name, scope);
  const existing = reachedMilestones.get(key);
  if (existing !== undefined) return existing;
  const elapsedMs = Math.round(performance.now());
  reachedMilestones.set(key, elapsedMs);
  try {
    performance.mark(`${STARTUP_MILESTONE_MARK_PREFIX}${key}`, {
      detail: { name, ...(scope ? { scope } : {}), ...attrs },
    });
    runLogger.log(`[startup-trace] milestone=${name}`, {
      pid: process.pid,
      elapsed_ms: elapsedMs,
      ...(scope ? { scope } : {}),
      ...attrs,
    });
  } catch {
    // A diagnostic writer failure must not change startup results.
  }
  for (const listener of milestoneListeners) {
    try {
      listener(name, key);
    } catch {
      // An observer failure is diagnostic-only.
    }
  }
  return elapsedMs;
}

export function getStartupMilestone(
  name: StartupMilestone,
  scope?: string,
): number | undefined {
  return reachedMilestones.get(milestoneKey(name, scope));
}

/** Drops a closed session's milestones so a long-lived daemon stays bounded. */
export function clearStartupMilestones(scope: string): void {
  const suffix = `:${scope}`;
  for (const key of reachedMilestones.keys()) {
    if (!key.endsWith(suffix)) continue;
    reachedMilestones.delete(key);
    performance.clearMarks(`${STARTUP_MILESTONE_MARK_PREFIX}${key}`);
  }
}

export function onStartupMilestone(
  listener: StartupMilestoneListener,
): () => void {
  milestoneListeners.add(listener);
  return () => {
    milestoneListeners.delete(listener);
  };
}

/** Test-only: milestones are process-global by design. */
export function resetStartupMilestonesForTesting(): void {
  reachedMilestones.clear();
  milestoneListeners.clear();
}

/** Observe settlement while preserving the original promise and error. */
export function traceStartupStepAsync<T>(
  step: string,
  action: () => Promise<T>,
  onFinish?: StartupStepObserver,
): Promise<T> {
  const done = beginStartupStep(step, true, onFinish);
  try {
    const result = action();
    void result.then(
      () => done('resolved'),
      () => done('rejected'),
    );
    return result;
  } catch (error) {
    done('rejected');
    throw error;
  }
}
