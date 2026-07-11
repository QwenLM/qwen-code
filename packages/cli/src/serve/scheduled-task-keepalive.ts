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

import * as fsSync from 'node:fs';
import * as path from 'node:path';
import {
  readCronTasks,
  updateCronTasks,
  getCronFilePath,
  createDebugLogger,
  SessionService,
  taskHasLegacyCondition,
  type DurableCronTask,
} from '@qwen-code/qwen-code-core';
import { scheduledTaskSessionName } from './routes/scheduled-tasks.js';

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
      taskHasLegacyCondition(task) || // legacy guarded — can never fire, don't pin
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
 * the reaper already let go (a re-enabled task's session). `spawnOrAttach`
 * and `updateSessionMetadata` bind unbound durable tasks to dedicated
 * sessions — the same flow the POST /scheduled-tasks route uses for
 * UI-created tasks, applied retroactively to cron_create tool tasks. */
export interface KeepaliveBridge {
  recordHeartbeat(sessionId: string): unknown;
  loadSession(req: {
    sessionId: string;
    workspaceCwd: string;
    historyReplay?: 'stream' | 'response';
  }): Promise<unknown>;
  spawnOrAttach(req: {
    workspaceCwd: string;
    sessionScope?: 'single' | 'thread';
  }): Promise<{ sessionId: string }>;
  closeSession(sessionId: string): Promise<unknown>;
  updateSessionMetadata(
    sessionId: string,
    metadata: { displayName?: string },
  ): unknown;
}

/** Per-session revive-load timeout: a hung reload must not stall the sweep. */
const KEEPALIVE_REVIVE_TIMEOUT_MS = 30_000;
/** Per-task spawn timeout: a hung spawnOrAttach must not stall the sweep. */
const KEEPALIVE_SPAWN_TIMEOUT_MS = 30_000;
/** Upper bound on the per-session revive backoff, so a permanently-gone session
 * (transcript deleted out-of-band) is retried at most this often rather than
 * every interval forever. */
const MAX_REVIVE_BACKOFF_MS = 30 * 60_000;

/**
 * Bind unbound durable tasks to dedicated sessions, and rename bound
 * sessions that don't yet have the ⏰ prefix. The cron_create tool leaves
 * durable tasks unbound so they stay pickable by any lock owner (CLI/ACP
 * /headless). In daemon mode this keepalive mints a dedicated session per
 * task and names it — binding is a daemon-only concern.
 *
 * For unbound tasks: mints a dedicated session, names it `⏰ prompt`,
 * writes sessionId to disk.
 * For bound tasks without ⏰ name: renames the session to `⏰ prompt`.
 *
 * A Set tracks renamed sessions so we don't call updateSessionMetadata
 * every tick. Best-effort — failures are logged and retried next tick.
 */
async function bindAndNameSessions(
  bridge: KeepaliveBridge,
  boundWorkspace: string,
  tasks: readonly DurableCronTask[],
  renamed: Set<string>,
  spawnTimeoutMs: number,
  binding: Set<string>,
): Promise<void> {
  const unbound = tasks.filter(
    (t) =>
      !t.sessionId &&
      t.enabled !== false &&
      !taskHasLegacyCondition(t) &&
      !binding.has(t.id),
  );
  const needsName = tasks.filter(
    (t) =>
      t.sessionId &&
      t.enabled !== false &&
      !taskHasLegacyCondition(t) &&
      !renamed.has(t.sessionId),
  );

  for (const task of unbound) {
    let spawnedSessionId: string | undefined;
    try {
      binding.add(task.id);
      const rawSpawn = bridge.spawnOrAttach({
        workspaceCwd: boundWorkspace,
        sessionScope: 'thread',
      });
      // spawnOrAttach is not abortable — if the timeout fires first, the
      // raw promise may still resolve later with a live session. Attach a
      // background handler to clean up that orphan immediately. Clear the
      // binding guard on TRUE settlement so retries are possible.
      let timedOut = false;
      rawSpawn
        .then(({ sessionId }) => {
          if (timedOut) {
            log.debug(
              'keepalive: late spawn resolved, cleaning up',
              task.id,
              sessionId,
            );
            bridge.closeSession(sessionId).catch(() => {});
            new SessionService(boundWorkspace)
              .removeSession(sessionId)
              .catch(() => {});
          }
        })
        .catch(() => {})
        .finally(() => {
          binding.delete(task.id);
        });
      const { sessionId } = await withTimeout(
        rawSpawn,
        spawnTimeoutMs,
        `spawnOrAttach(${task.id})`,
      ).catch((err) => {
        timedOut = true; // raw spawn may still resolve — background handler will clean up
        throw err;
      });
      spawnedSessionId = sessionId;
      try {
        bridge.updateSessionMetadata(sessionId, {
          displayName: scheduledTaskSessionName(task.prompt),
        });
        renamed.add(sessionId);
      } catch {
        // naming is non-critical — the session still fires correctly
      }
      let matched = false;
      await updateCronTasks(boundWorkspace, (list) => {
        // Another process may have bound or disabled this task between our
        // read and this write-lock acquisition — only attach when the task is
        // still unbound and enabled. Otherwise return unchanged so the
        // orphan spawn is rolled back below.
        if (
          !list.some(
            (t) => t.id === task.id && !t.sessionId && t.enabled !== false,
          )
        ) {
          return list;
        }
        const result = list.map((t) =>
          t.id === task.id && !t.sessionId && t.enabled !== false
            ? { ...t, sessionId }
            : t,
        );
        matched = true;
        return result;
      });
      if (!matched) {
        // Task was deleted between read and write — roll back the orphan.
        throw new Error(`task ${task.id} no longer on disk`);
      }
      log.debug(
        'keepalive: bound task',
        task.id,
        'to dedicated session',
        sessionId,
      );
    } catch (err) {
      log.debug('keepalive: failed to bind task', task.id, err);
      if (spawnedSessionId !== undefined) {
        await bridge.closeSession(spawnedSessionId).catch(() => {});
        await new SessionService(boundWorkspace)
          .removeSession(spawnedSessionId)
          .catch(() => {});
      }
    }
  }

  for (const task of needsName) {
    const sessionId = task.sessionId!;
    try {
      bridge.updateSessionMetadata(sessionId, {
        displayName: scheduledTaskSessionName(task.prompt),
      });
      renamed.add(sessionId);
    } catch (err) {
      log.debug('keepalive: failed to name session', sessionId, err);
    }
  }
}

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
  /** Per-task spawn timeout; defaults to KEEPALIVE_SPAWN_TIMEOUT_MS. */
  spawnTimeoutMs?: number;
}

export function startScheduledTaskKeepalive(
  opts: StartScheduledTaskKeepaliveOptions,
): ScheduledTaskKeepalive {
  const { bridge, boundWorkspace, intervalMs } = opts;
  const reviveTimeoutMs = opts.reviveTimeoutMs ?? KEEPALIVE_REVIVE_TIMEOUT_MS;
  const spawnTimeoutMs = opts.spawnTimeoutMs ?? KEEPALIVE_SPAWN_TIMEOUT_MS;

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

  // Tasks with a spawn in flight. After withTimeout rejects, the raw
  // spawnOrAttach may still be running — skip the task in subsequent ticks
  // until the raw spawn settles.
  const binding = new Set<string>();

  // Tracks sessions the keepalive has already named with ⏰ prefix,
  // so updateSessionMetadata isn't called every tick.
  const renamed = new Set<string>();

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
          await withTimeout(load, reviveTimeoutMs, `loadSession(${sessionId})`);
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
    // Drop backoff state and renamed entries for sessions no longer bound to any task.
    if (reviveState.size > 0 || renamed.size > 0) {
      const live = new Set(tasks.map((t) => t.sessionId));
      for (const id of reviveState.keys()) {
        if (!live.has(id)) reviveState.delete(id);
      }
      for (const id of renamed) {
        if (!live.has(id)) renamed.delete(id);
      }
    }

    await bindAndNameSessions(
      bridge,
      boundWorkspace,
      tasks,
      renamed,
      spawnTimeoutMs,
      binding,
    );
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

  // Watch the tasks file so a newly created cron_create task is bound to a
  // dedicated session immediately, not after the next interval. Same
  // directory-watch + debounce pattern the scheduler uses.
  let bindDebounce: ReturnType<typeof setTimeout> | undefined;
  const cronFilePath = getCronFilePath(boundWorkspace);
  const cronDir = path.dirname(cronFilePath);
  const cronFileName = path.basename(cronFilePath);
  let fileWatcher: ReturnType<typeof fsSync.watch> | undefined;
  try {
    fsSync.mkdirSync(cronDir, { recursive: true });
    fileWatcher = fsSync.watch(
      cronDir,
      { persistent: false },
      (_event, filename) => {
        // On Linux fs.watch delivers null as filename — treat it as a match
        // (could be our file); non-matching filenames are skipped.
        if (filename !== null && filename !== cronFileName) return;
        if (bindDebounce) clearTimeout(bindDebounce);
        bindDebounce = setTimeout(() => {
          if (running) return;
          running = true;
          void tick().finally(() => {
            running = false;
          });
        }, 500);
        bindDebounce.unref?.();
      },
    );
    fileWatcher.on('error', () => {
      // Watch errors are non-fatal — the interval timer still ticks.
    });
  } catch {
    // Directory doesn't exist or can't be watched — interval timer still runs.
  }

  let stopped = false;
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      if (bindDebounce) clearTimeout(bindDebounce);
      fileWatcher?.close();
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
      await withTimeout(load, timeoutMs, `loadSession(${sessionId})`);
      loaded.push(sessionId);
    } catch (err) {
      // Timed out (or the load rejected). Do NOT await the raw `load` here: a
      // genuinely hung, non-abortable load would pin this worker forever and, if
      // enough loads hang, the whole boot sweep never completes (`Promise.all`
      // never settles) — later task sessions would then never rehydrate. Record
      // it as failed and free the worker to pull the next queued session; the
      // background load, if it ever settles, just warms that session late.
      failed.push(sessionId);
      // The onError callback must never abort the sweep: if it throws (e.g. a
      // stderr EPIPE during log rotation) the rejection would escape loadOne,
      // fail its worker, and short-circuit the `Promise.all` below — stranding
      // every other queued session. Swallow the callback's own failure.
      try {
        deps.onError?.(sessionId, err);
      } catch {
        /* a broken error sink must not strand the rest of the sweep */
      }
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
      reject(new Error(`${label} timed out after ${ms}ms`));
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
