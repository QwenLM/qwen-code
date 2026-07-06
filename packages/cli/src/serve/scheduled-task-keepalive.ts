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
 * reaper's "idle since" clock never crosses the timeout. It only keeps ALREADY
 * LIVE sessions alive — reloading a session that died (e.g. across a daemon
 * restart) is a separate concern.
 */

import { readCronTasks, createDebugLogger } from '@qwen-code/qwen-code-core';

const log = createDebugLogger('SCHED_KEEPALIVE');

/** The slice of the bridge the keepalive needs — narrowed for testability. */
export interface KeepaliveBridge {
  recordHeartbeat(sessionId: string): unknown;
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
        // The bound session is already gone (task deleted, or session closed
        // out from under us) — its heartbeat is moot. Reloading a dead
        // session is not this component's job. Debug-only: an expected,
        // frequent case, so it must not spam stderr.
        log.debug('keepalive: recordHeartbeat failed for', sessionId, err);
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
  // Load concurrently so one slow/hung session can't block the rest, each
  // bounded by a timeout so a permanently-hung load still resolves as failed.
  await Promise.all(
    sessionIds.map(async (sessionId) => {
      try {
        await withTimeout(
          bridge.loadSession({
            sessionId,
            workspaceCwd: boundWorkspace,
            historyReplay: 'response',
          }),
          timeoutMs,
          sessionId,
        );
        loaded.push(sessionId);
      } catch (err) {
        failed.push(sessionId);
        deps.onError?.(sessionId, err);
      }
    }),
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
