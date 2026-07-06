/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Keeps scheduled-task-owned sessions resident against the bridge's idle
 * reaper.
 *
 * A durable task created through the Web Shell management page is bound to a
 * dedicated session and fires ONLY inside it (its transcript is the task's run
 * history). For that to keep happening the session must stay loaded so its
 * in-child scheduler ticks — but a session with no client / SSE subscriber is
 * closed by the bridge's idle reaper after the idle timeout, which would
 * silently stop the task.
 *
 * This is a periodic heartbeat: it reads the durable-tasks file, collects the
 * distinct bound session ids, and calls `bridge.recordHeartbeat` on each so the
 * reaper's "idle since" clock never crosses the timeout. When a heartbeat fails
 * because the session is no longer resident — the common case being a task that
 * was disabled/archived (its session let go by the reaper) and then re-enabled/
 * unarchived — it best-effort RELOADS the session so its in-child scheduler
 * resumes ticking. Without that, a re-enabled bound task would show enabled with
 * a live countdown yet never fire until the user opened it or the daemon
 * restarted. This revive covers the unarchive path and the PATCH false→true
 * path uniformly, and retries every interval; a slot missed during the revive
 * gap is caught up when the session loads.
 */

import { readCronTasks, createDebugLogger } from '@qwen-code/qwen-code-core';

const log = createDebugLogger('SCHED_KEEPALIVE');

/** The slice of the bridge the keepalive needs — narrowed for testability.
 * `recordHeartbeat` keeps a live session resident; `loadSession` revives one
 * the reaper already let go (a re-enabled task's session). */
export interface KeepaliveBridge {
  recordHeartbeat(sessionId: string): unknown;
  loadSession(req: {
    sessionId: string;
    workspaceCwd: string;
    historyReplay?: 'stream' | 'response';
  }): Promise<unknown>;
}

/** Per-session revive-load timeout: a hung reload must not stall the sweep. */
const KEEPALIVE_REVIVE_TIMEOUT_MS = 30_000;

export interface ScheduledTaskKeepalive {
  /** Stops the periodic heartbeat. Idempotent. */
  stop(): void;
  /** Runs one heartbeat pass immediately. Exposed for tests / eager warm-up. */
  tick(): Promise<void>;
}

export interface StartScheduledTaskKeepaliveOptions {
  bridge: KeepaliveBridge;
  boundWorkspace: string;
  /** How often to heartbeat; must be comfortably under the reaper timeout. */
  intervalMs: number;
}

export function startScheduledTaskKeepalive(
  opts: StartScheduledTaskKeepaliveOptions,
): ScheduledTaskKeepalive {
  const { bridge, boundWorkspace, intervalMs } = opts;

  const tick = async (): Promise<void> => {
    let tasks;
    try {
      tasks = await readCronTasks(boundWorkspace);
    } catch (err) {
      // A read failure (missing file already maps to [], so this is a real
      // EACCES/corruption) just skips this pass; the next one retries. The
      // interval must never throw. Logged so a persistently-failing keepalive
      // is diagnosable rather than silent.
      log.debug('keepalive: readCronTasks failed, skipping this pass', err);
      return;
    }
    const beaten = new Set<string>();
    for (const task of tasks) {
      const sessionId = task.sessionId;
      if (
        task.enabled === false || // disabled (e.g. archived) — let it be reaped
        typeof sessionId !== 'string' ||
        sessionId.length === 0 ||
        beaten.has(sessionId)
      ) {
        continue;
      }
      beaten.add(sessionId);
      try {
        bridge.recordHeartbeat(sessionId);
      } catch (err) {
        // Heartbeat failed → the session isn't resident. For an ENABLED bound
        // task that means the reaper let it go while the task was disabled/
        // archived and it's now re-enabled: revive it so its in-child scheduler
        // resumes. Best-effort and debug-only (an expected, recoverable case);
        // a persistent failure (transcript truly gone) just retries next pass.
        log.debug('keepalive: recordHeartbeat failed for', sessionId, err);
        try {
          await withTimeout(
            bridge.loadSession({
              sessionId,
              workspaceCwd: boundWorkspace,
              historyReplay: 'response',
            }),
            KEEPALIVE_REVIVE_TIMEOUT_MS,
            sessionId,
          );
          log.debug('keepalive: revived non-resident session', sessionId);
        } catch (loadErr) {
          log.debug('keepalive: failed to revive session', sessionId, loadErr);
        }
      }
    }
  };

  const timer: ReturnType<typeof setInterval> = setInterval(() => {
    void tick();
  }, intervalMs);
  // The heartbeat alone must never hold the daemon process open.
  timer.unref?.();

  let stopped = false;
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
    tick,
  };
}

/** The slice of the bridge rehydration needs — narrowed for testability. */
export interface RehydrateBridge {
  loadSession(req: {
    sessionId: string;
    workspaceCwd: string;
    historyReplay?: 'stream' | 'response';
  }): Promise<unknown>;
}

export interface RehydrateResult {
  loaded: string[];
  failed: string[];
}

/**
 * Reloads every scheduled-task-owned session at daemon startup so its in-child
 * scheduler re-arms after a restart — nothing rehydrates sessions on boot
 * otherwise, so a bound task would sit dormant (its bound session dead, and the
 * lock owner deliberately never fires a bound task) until something loaded it.
 *
 * Best-effort: a session whose transcript is gone (deleted out-of-band) fails
 * its `loadSession` and is skipped rather than aborting the sweep. Distinct
 * session ids only; unbound tasks are ignored (they fire via the lock owner).
 */
/** Per-session load timeout: one hung `loadSession` (cold start, blocked child
 * spawn, huge replay) must not stall the whole boot sweep. */
const REHYDRATE_LOAD_TIMEOUT_MS = 30_000;
/** Max sessions rehydrated at once. Each `loadSession` forks a real agent
 * child, so loading all of them (up to MAX_JOBS = 50) in one shot would spike
 * CPU/memory on boot and, on constrained hosts, hit spawn failures
 * (EAGAIN/ENOMEM) that strand healthy tasks. Load in small batches instead. */
const REHYDRATE_MAX_CONCURRENCY = 4;

export async function rehydrateScheduledTaskSessions(deps: {
  bridge: RehydrateBridge;
  boundWorkspace: string;
  onError?: (sessionId: string, err: unknown) => void;
  loadTimeoutMs?: number;
}): Promise<RehydrateResult> {
  const { bridge, boundWorkspace } = deps;
  const timeoutMs = deps.loadTimeoutMs ?? REHYDRATE_LOAD_TIMEOUT_MS;
  let tasks;
  try {
    tasks = await readCronTasks(boundWorkspace);
  } catch (err) {
    log.debug('rehydrate: readCronTasks failed', err);
    return { loaded: [], failed: [] };
  }

  // Distinct sessions of enabled bound tasks.
  const seen = new Set<string>();
  const sessionIds: string[] = [];
  for (const task of tasks) {
    const sessionId = task.sessionId;
    if (
      task.enabled === false || // disabled (e.g. archived) — don't reload it
      typeof sessionId !== 'string' ||
      sessionId.length === 0 ||
      seen.has(sessionId)
    ) {
      continue;
    }
    seen.add(sessionId);
    sessionIds.push(sessionId);
  }

  const loaded: string[] = [];
  const failed: string[] = [];
  const loadOne = async (sessionId: string) => {
    const load = bridge.loadSession({
      sessionId,
      workspaceCwd: boundWorkspace,
      historyReplay: 'response',
    });
    let settled = false;
    try {
      await withTimeout(load, timeoutMs, sessionId);
      loaded.push(sessionId);
      settled = true;
    } catch (err) {
      failed.push(sessionId);
      deps.onError?.(sessionId, err);
    }
    // loadSession isn't abortable, so a timed-out load keeps forking/replaying
    // in the background. Hold this worker — and thus its concurrency slot —
    // until that real load actually settles, so the number of in-flight child
    // spawns never exceeds REHYDRATE_MAX_CONCURRENCY (the timeout only decides
    // when the RESULT is recorded as failed, not when the slot frees).
    if (!settled) await load.catch(() => {});
  };
  // Bounded worker pool: exactly REHYDRATE_MAX_CONCURRENCY workers pull from a
  // shared queue, each running one real load at a time (held to settlement),
  // so no more than that many child spawns are ever in flight at once.
  const queue = sessionIds.slice();
  const worker = async () => {
    for (
      let sessionId = queue.shift();
      sessionId !== undefined;
      sessionId = queue.shift()
    ) {
      await loadOne(sessionId);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(REHYDRATE_MAX_CONCURRENCY, queue.length) },
      () => worker(),
    ),
  );
  return { loaded, failed };
}

/** Rejects with a clear error if `p` doesn't settle within `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`loadSession(${label}) timed out after ${ms}ms`));
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
