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

import {
  readCronTasks,
  createDebugLogger,
  type DurableCronTask,
} from '@qwen-code/qwen-code-core';

const log = createDebugLogger('SCHED_KEEPALIVE');

/** Distinct `sessionId`s of enabled, session-bound tasks, in first-seen order.
 * A task is skipped when it's disabled (its session may be let go by the reaper),
 * unbound, or a duplicate of one already collected. The heartbeat pass and the
 * boot rehydrate share this so the "which sessions to keep resident" filter lives
 * in exactly one place and can't drift between them. */
function collectBoundSessionIds(tasks: readonly DurableCronTask[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const task of tasks) {
    const sessionId = task.sessionId;
    if (
      task.enabled === false || // disabled (e.g. archived) — let it be reaped
      typeof sessionId !== 'string' ||
      sessionId.length === 0 ||
      seen.has(sessionId)
    ) {
      continue;
    }
    seen.add(sessionId);
    ids.push(sessionId);
  }
  return ids;
}

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
/** Upper bound on the per-session revive backoff, so a permanently-gone session
 * (transcript deleted out-of-band) is retried at most this often rather than
 * every interval forever. */
const MAX_REVIVE_BACKOFF_MS = 30 * 60_000;

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
  /** Per-session revive timeout; defaults to KEEPALIVE_REVIVE_TIMEOUT_MS. */
  reviveTimeoutMs?: number;
}

export function startScheduledTaskKeepalive(
  opts: StartScheduledTaskKeepaliveOptions,
): ScheduledTaskKeepalive {
  const { bridge, boundWorkspace, intervalMs } = opts;
  const reviveTimeoutMs = opts.reviveTimeoutMs ?? KEEPALIVE_REVIVE_TIMEOUT_MS;

  // Per-session revive state: `nextAttemptAt` gates retries after failures so a
  // permanently-gone session isn't reloaded every interval; cleared on success.
  const reviveState = new Map<
    string,
    { failures: number; nextAttemptAt: number }
  >();
  // Sessions with a revive in flight. loadSession isn't abortable, so a
  // timed-out revive keeps running in the background; without this guard a later
  // tick would spawn a SECOND loadSession (a duplicate child) for it. Cleared on
  // the load's TRUE settlement, not the timeout.
  const reviving = new Set<string>();

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
    for (const sessionId of collectBoundSessionIds(tasks)) {
      try {
        bridge.recordHeartbeat(sessionId);
        reviveState.delete(sessionId); // resident again — reset any backoff
      } catch (err) {
        // Heartbeat failed → the session isn't resident. For an ENABLED bound
        // task that means the reaper let it go while the task was disabled/
        // archived and it's now re-enabled: revive it so its in-child scheduler
        // resumes. Best-effort and debug-only (an expected, recoverable case).
        const state = reviveState.get(sessionId);
        if (reviving.has(sessionId)) {
          continue; // a prior revive is still running — don't spawn a duplicate
        }
        if (state && Date.now() < state.nextAttemptAt) {
          continue; // still backing off from prior revive failures
        }
        log.debug('keepalive: recordHeartbeat failed for', sessionId, err);
        const load = bridge.loadSession({
          sessionId,
          workspaceCwd: boundWorkspace,
          historyReplay: 'response',
        });
        reviving.add(sessionId);
        // Clear the in-flight guard on the load's TRUE settlement (not the
        // timeout below) so a still-running load keeps blocking a duplicate.
        void load
          .catch(() => {})
          .finally(() => {
            reviving.delete(sessionId);
          });
        try {
          await withTimeout(load, reviveTimeoutMs, sessionId);
          log.debug('keepalive: revived non-resident session', sessionId);
          reviveState.delete(sessionId);
        } catch (loadErr) {
          // Back off exponentially so a permanently-gone transcript isn't
          // retried every interval for the daemon's lifetime.
          const failures = (state?.failures ?? 0) + 1;
          const backoff = Math.min(
            intervalMs * 2 ** Math.min(failures - 1, 6),
            MAX_REVIVE_BACKOFF_MS,
          );
          reviveState.set(sessionId, {
            failures,
            nextAttemptAt: Date.now() + backoff,
          });
          log.debug(
            'keepalive: failed to revive session',
            sessionId,
            `(failure ${failures}, next retry in ${backoff}ms)`,
            loadErr,
          );
        }
      }
    }
    // Drop backoff state for sessions no longer bound to any task.
    if (reviveState.size > 0) {
      const live = new Set(tasks.map((t) => t.sessionId));
      for (const id of reviveState.keys()) {
        if (!live.has(id)) reviveState.delete(id);
      }
    }
  };

  // In-flight guard: a pass can outlast the interval (each revive awaits up to
  // the revive timeout), so skip a tick while the previous is still running —
  // overlapping passes would issue duplicate concurrent loadSession spawns for
  // the same dead sessions.
  let running = false;
  const timer: ReturnType<typeof setInterval> = setInterval(() => {
    if (running) return;
    running = true;
    void tick().finally(() => {
      running = false;
    });
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

  // Distinct sessions of enabled bound tasks — same filter the heartbeat uses.
  const sessionIds = collectBoundSessionIds(tasks);

  const loaded: string[] = [];
  const failed: string[] = [];
  const loadOne = async (sessionId: string) => {
    const load = bridge.loadSession({
      sessionId,
      workspaceCwd: boundWorkspace,
      historyReplay: 'response',
    });
    // loadSession isn't abortable, so a timed-out load keeps forking/replaying
    // in the background. Swallow its eventual settlement up front so it can't
    // raise an unhandled rejection once we've stopped awaiting it below.
    void load.catch(() => {});
    try {
      await withTimeout(load, timeoutMs, sessionId);
      loaded.push(sessionId);
    } catch (err) {
      // Timed out (or the load rejected). Do NOT await the raw `load` here: a
      // genuinely hung, non-abortable load would pin this worker forever and, if
      // enough loads hang, the whole boot sweep never completes (`Promise.all`
      // never settles) — later task sessions would then never rehydrate. Record
      // it as failed and free the worker to pull the next queued session; the
      // background load, if it ever settles, just warms that session late.
      failed.push(sessionId);
      deps.onError?.(sessionId, err);
    }
  };
  // Bounded worker pool: REHYDRATE_MAX_CONCURRENCY workers pull from a shared
  // queue, each awaiting one load at a time — which bounds concurrent child
  // spawns to the pool size in the common case. A load that exceeds the timeout
  // is left running in the background (see loadOne) so a hang can't wedge the
  // sweep, at the cost of a transient over-shoot only while such loads linger.
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
