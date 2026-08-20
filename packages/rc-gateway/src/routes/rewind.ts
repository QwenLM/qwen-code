/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { DaemonClient } from '@qwen-code/sdk';
import type { AuditRecorder } from '../auditLog.js';
import { resolveChatsDir, isValidSessionId } from '../sessions/chatsPath.js';
import { readParentRecords } from '../sessions/forkStore.js';
import { resolveTurn } from '../sessions/turnResolver.js';
import type { OwnerEventBus } from '../ownerEvents.js';
import type { PushNotifier } from '../webpush/notifier.js';
import { SessionWal } from '../wal.js';
import { PromptQueue, QueueTimeoutError } from './promptQueue.js';

/**
 * The daemon surface this route needs: `rewindSession` plus
 * `getRewindSnapshots`, which the route uses to map the gateway's
 * turn-counted `toTurn` onto the daemon's promptId-keyed rewind target.
 */
export type RewindDaemon = Pick<
  DaemonClient,
  'rewindSession' | 'getRewindSnapshots'
>;

/** Fallback queue when a route set is wired without an explicit queue. */
const defaultQueue = new PromptQueue();

export interface RewindRouteDeps {
  audit?: AuditRecorder;
  /** Wall-clock for the `rewoundAt` stamp (injectable for tests). */
  now?: () => Date;
  /**
   * Owner-event bus: when provided, publishes the `session_rewound` marker
   * as a `session_event` frame (the SAME `OwnerEvent` variant
   * `session_forked`/`child_forked` already use — no new variant).
   */
  bus?: OwnerEventBus;
  /** Root directory for WAL files; when provided, seeds the WAL marker. */
  walDir?: string;
  /** Routes `session.rewound` through the existing notification pipeline. */
  notifier?: PushNotifier;
  /** Override the shared PromptQueue (for tests that need isolated queues). */
  queue?: PromptQueue;
}

/**
 * POST /session/:id/rewind — proxy the daemon's ACP `rewindSession` (via the
 * SDK) and append a `session_rewound` marker to the session's own WAL.
 *
 * Saga (mirrors routes/fork.ts's rollback discipline):
 *  1. Guard: `queue.acquire(sessionId, 0)` — an immediate (zero-wait) attempt
 *     at the session's existing prompt FIFO slot. A free slot resolves
 *     synchronously and is HELD for the whole saga (blocking a new prompt
 *     from starting mid-rewind); a busy slot throws `QueueTimeoutError`
 *     within the same tick, mapped to `409 rewind_in_progress` with the
 *     daemon never touched. The slot is released in a `finally`.
 *  2. Read the parent transcript (`readParentRecords`, same source
 *     routes/fork.ts reads) and resolve `toTurn` via the shared
 *     `resolveTurn`. `invalid_turn` -> 400; `rewind_not_applicable` -> 409.
 *  3. Map `toTurn` onto the daemon's promptId-keyed rewind: the daemon
 *     exposes one rewind snapshot per user turn (`getRewindSnapshots`; a
 *     snapshot's `turnIndex` counts the same user turns the resolver does),
 *     and `rewindSession(id, promptId)` truncates history before that
 *     snapshot's turn. `toTurn === addressableTurnCount` is the TIP (no
 *     truncation): no snapshot exists there, the daemon is NOT called, and
 *     only the marker below is recorded. For a non-tip turn, a missing
 *     snapshot means the daemon's view does not support that boundary ->
 *     409 `rewind_not_applicable`. The daemon's own `409` (session_busy) is
 *     surfaced verbatim as 409; every other failure (unreachable, 4xx/5xx,
 *     network) maps to 502 `daemon_unavailable`. On ANY failure: no WAL
 *     marker, no audit — nothing half-applied.
 *  4. Append `session_rewound` to the session's `SessionWal` at
 *     `(wal.latestId() ?? 0) + 1` (unlike fork, rewind has no caller-supplied
 *     WAL coordinate to derive an id from, so it uses the WAL's own next
 *     sequence number). A synchronous append failure is retried once; if the
 *     retry also fails, respond 500 `rewind_marker_failed` — the daemon has
 *     ALREADY rewound at this point, so the gateway/daemon views diverge; this
 *     is logged loudly and NO audit row is written (marker-absent state is the
 *     consistent one: never a marker without an audit or an audit without a
 *     marker).
 *  5. Publish the marker as a `session_event` frame on the owner bus
 *     (independent of `walDir`, exactly as fork.ts publishes outside its
 *     `if (walDir)` block).
 *  6. Audit `session_rewound` (ids + turn numbers only, never content), derived
 *     from the AUTHENTICATED `req.rcClient` (never from the request body); hand
 *     `session_rewound` to the notifier.
 *  7. Respond 202 `{ toTurn, truncatedEventId }`.
 */
export function createRewindRoute(
  daemon: RewindDaemon,
  resolveWorkspaceCwd: () => Promise<string | undefined>,
  deps: RewindRouteDeps = {},
): RequestHandler {
  const now = deps.now ?? (() => new Date());
  const { audit, bus, walDir, notifier } = deps;
  const queue = deps.queue ?? defaultQueue;

  return async (req, res) => {
    try {
      await handleRewind(req, res);
    } catch {
      // No global Express error middleware is mounted and Express 4 does not
      // catch async-handler rejections; map any unexpected failure to a clean
      // 500. Guard against a double-send if a response was already written.
      if (!res.headersSent) {
        res.status(500).json({ error: 'Rewind failed', code: 'rewind_failed' });
      }
    }
  };

  async function handleRewind(
    req: Parameters<RequestHandler>[0],
    res: Parameters<RequestHandler>[1],
  ): Promise<void> {
    const sessionId = req.params.id;
    if (!isValidSessionId(sessionId)) {
      res.status(404).json({
        error: 'Session transcript not found',
        code: 'session_transcript_not_found',
      });
      return;
    }

    const body = (req.body ?? {}) as { toTurn?: unknown };

    // 1. Immediate, non-blocking prompt-in-flight guard. A free slot is HELD
    //    by this call for the rest of the saga (released in `finally`).
    let release: (() => void) | undefined;
    try {
      release = await queue.acquire(sessionId, 0);
    } catch (err) {
      if (err instanceof QueueTimeoutError) {
        res
          .status(409)
          .json({ error: 'Rewind in progress', code: 'rewind_in_progress' });
        return;
      }
      throw err;
    }

    try {
      // 2. Resolve the trusted workspace cwd -> chats dir -> parent records.
      const cwd = await resolveWorkspaceCwd();
      if (!cwd) {
        res
          .status(502)
          .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
        return;
      }
      const chatsDir = resolveChatsDir(cwd);
      const records = await readParentRecords(chatsDir, sessionId);
      if (!records) {
        res.status(404).json({
          error: 'Session transcript not found',
          code: 'session_transcript_not_found',
        });
        return;
      }

      const resolved = resolveTurn(records, body.toTurn);
      if (!resolved.ok) {
        const status = resolved.error === 'invalid_turn' ? 400 : 409;
        res
          .status(status)
          .json({ error: resolved.error, code: resolved.error });
        return;
      }
      const { targetTurnIndex, addressableTurnCount, truncatedEventId } =
        resolved;

      // 3. Map `toTurn` onto the daemon's promptId-keyed rewind and proxy
      //    it. The daemon's snapshot `turnIndex` counts the same user turns
      //    the resolver does, so the snapshot with `turnIndex === toTurn`
      //    is the checkpoint taken when turn toTurn+1 was submitted — the
      //    state after `toTurn` turns completed. The TIP
      //    (`toTurn === addressableTurnCount`) has no snapshot: a rewind to
      //    the tip truncates nothing, so the daemon is NOT called and only
      //    the marker below is recorded. Any failure aborts the saga cleanly
      //    BEFORE any WAL marker or audit is written. The daemon's own 409
      //    (session_busy) is surfaced as 409; everything else -> 502.
      try {
        if (targetTurnIndex < addressableTurnCount) {
          const { snapshots } = await daemon.getRewindSnapshots(sessionId);
          const snapshot = snapshots.find(
            (s) => s.turnIndex === targetTurnIndex,
          );
          if (!snapshot) {
            // The gateway's transcript view names a turn boundary the
            // daemon's snapshot list does not support (e.g. the daemon was
            // already rewound from the TUI): from the daemon's view that
            // turn is beyond its tip.
            res.status(409).json({
              error: 'Rewind not applicable',
              code: 'rewind_not_applicable',
            });
            return;
          }
          await daemon.rewindSession(sessionId, snapshot.promptId);
        }
      } catch (err) {
        const status = (err as { status?: unknown }).status;
        if (typeof status === 'number' && status === 409) {
          res
            .status(409)
            .json({ error: 'Rewind in progress', code: 'rewind_in_progress' });
          return;
        }
        res
          .status(502)
          .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
        return;
      }

      const rewoundAt = now().toISOString();
      // Owner-scope: the actor is derived from the AUTHENTICATED client, never
      // from the request body — a non-owner can never spoof this.
      const rewoundByTokenId = req.rcClient?.id;
      const markerData = {
        toTurn: targetTurnIndex,
        truncatedEventId,
        rewoundByTokenId,
        rewoundAt,
      };

      // 4. WAL marker (persisted only when walDir is wired), with a single
      //    retry on a synchronous write failure.
      let markerId = 1;
      if (walDir) {
        const wal = new SessionWal({ dir: walDir, sessionId });
        markerId = (wal.latestId() ?? 0) + 1;
        try {
          appendMarkerWithRetry(wal, markerId, markerData);
        } catch (err) {
          safeCloseWal(wal, sessionId, markerId);
          // The daemon has ALREADY rewound — the gateway WAL now diverges from
          // the daemon's view. Log loudly so an operator can reconcile.
          // eslint-disable-next-line no-console
          console.error(
            `[rewind] WAL marker append failed after daemon rewind succeeded ` +
              `(session=${sessionId}, markerId=${markerId}); ` +
              `gateway and daemon views now diverge`,
            err,
          );
          res.status(500).json({
            error: 'Rewind marker failed',
            code: 'rewind_marker_failed',
          });
          return;
        }
        // The marker bytes are now DURABLE (writeSync succeeded). From here the
        // rewind is COMMITTED: a subsequent close() failure (e.g. a deferred
        // writeback EIO on NFS) must NOT abort the post-commit steps. Swallow
        // and log it — never let it skip audit / bus.publish / the 202. A
        // marker on disk without an audit row is the exact inconsistency the
        // saga must never produce.
        safeCloseWal(wal, sessionId, markerId);
      }

      // 5. Publish the marker on the owner bus, reusing the existing
      //    session_event variant — no new OwnerEvent type for rewind. Not
      //    nested under `if (walDir)`, mirroring fork.ts's `if (bus)`.
      if (bus) {
        bus.publish({
          type: 'session_event',
          sessionId,
          event: {
            id: markerId,
            v: 1,
            type: 'session_rewound',
            data: markerData,
          },
        });
      }

      // 6. Audit + notify. Audit records ids + turn numbers only (never
      //    content) and the AUTHENTICATED actor. Fire-and-forget.
      void audit?.record({
        action: 'session_rewound',
        actorTokenId: rewoundByTokenId,
        target: sessionId,
        detail: { toTurn: targetTurnIndex, truncatedEventId },
      });
      void notifier?.notify(
        { type: 'session_rewound', data: markerData },
        { sessionId },
      );

      // 7. Success.
      res.status(202).json({ toTurn: targetTurnIndex, truncatedEventId });
    } finally {
      release();
    }
  }
}

/**
 * Close the WAL fd, swallowing any error. `close()` runs only AFTER the marker
 * bytes are already durable (append used `writeSync`), so a `closeSync` failure
 * cannot un-persist the marker; it must never propagate out of the success path
 * and skip the post-commit audit / publish / 202. At most it is logged.
 */
function safeCloseWal(
  wal: SessionWal,
  sessionId: string,
  markerId: number,
): void {
  try {
    wal.close();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[rewind] WAL close failed after durable marker append ` +
        `(session=${sessionId}, markerId=${markerId}); ` +
        `marker is persisted, continuing with audit/publish`,
      err,
    );
  }
}

/** Append the marker; on failure, retry exactly once before giving up. */
function appendMarkerWithRetry(
  wal: SessionWal,
  id: number,
  data: Record<string, unknown>,
): void {
  try {
    wal.append({ id, v: 1, type: 'session_rewound', data });
  } catch {
    wal.append({ id, v: 1, type: 'session_rewound', data });
  }
}
