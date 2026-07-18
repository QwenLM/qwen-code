/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { DaemonClient } from '@qwen-code/sdk';
import type { AuditRecorder } from '../auditLog.js';
import { resolveChatsDir, isValidSessionId } from '../sessions/chatsPath.js';
import { resolveTurn } from '../sessions/turnResolver.js';
import {
  forkRecords,
  serializeForked,
  buildForkTitleRecord,
  buildForkHeader,
} from '../sessions/forkTranscript.js';
import {
  readParentRecords,
  writeFork,
  removeFork,
  ForkExistsError,
} from '../sessions/forkStore.js';
import type { OwnerEventBus } from '../ownerEvents.js';
import { SessionWal } from '../wal.js';

/** The daemon surface this route needs: just `loadSession`. */
type ForkDaemon = Pick<DaemonClient, 'loadSession'>;

export interface ForkRouteDeps {
  audit?: AuditRecorder;
  /** Wall-clock for the `forkedAt` stamp (injectable for tests). */
  now?: () => Date;
  /** New session id generator (injectable for tests; defaults to randomUUID). */
  randomId?: () => string;
  /**
   * Owner-event bus: when provided, publishes `session_event` frames for
   * `session_forked` (parent) and `child_forked` (child) after a successful
   * fork so SSE subscribers observe fork lifecycle in real time.
   */
  bus?: OwnerEventBus;
  /**
   * Root directory for WAL files. When provided (together with or without
   * `bus`), the fork route seeds two WAL entries:
   *  - `session_forked` on the parent session WAL at id = `fromEventId + 1`
   *    (defaults to 1 when no `fromEventId` is supplied).
   *  - `child_forked` on the child session WAL at id = 1 (the child is fresh).
   */
  walDir?: string;
}

/**
 * POST /session/:id/fork — fork a settled session into a brand-new
 * daemon-hosted session that inherits the parent's full on-disk transcript.
 *
 * Replicates core `SessionService.forkSession` from OUTSIDE the daemon: read
 * the parent's JSONL at the derived chats path, rewrite each record's
 * `sessionId`/`parentUuid`-chain/`forkedFrom`, write a new `<newId>.jsonl`
 * exclusively, then drive the daemon's public `loadSession(newId)` (via the
 * SDK) so it restores the fork as a live, listable session — exactly what the
 * core `/branch` TUI command does internally.
 *
 * `resolveWorkspaceCwd` yields the trusted `workspaceCwd` (no request input
 * ever reaches a filesystem path). Supported transcript modes:
 *  - `include` (default): full copy of the parent transcript up to
 *    `fromEventId` records (all records when absent).
 *  - `empty`: no transcript records copied (fork header only).
 *  - `summary`: not yet implemented (returns 400).
 *
 * Fork header: the very first JSONL line of every fork is a
 * `{type:"fork", parentSessionId, ...}` record that provides machine-readable
 * lineage without interfering with core's `reconstructHistory`.
 *
 * WAL seeding: when `walDir` is provided, seeds `session_forked` on the parent
 * WAL (id = fromEventId + 1) and `child_forked` on the child WAL (id = 1) so
 * SSE subscribers reconnecting at any cursor see the fork event.
 */
export function createForkRoute(
  daemon: ForkDaemon,
  resolveWorkspaceCwd: () => Promise<string | undefined>,
  deps: ForkRouteDeps = {},
): RequestHandler {
  const now = deps.now ?? (() => new Date());
  const randomId = deps.randomId ?? randomUUID;
  const { audit, bus, walDir } = deps;

  return async (req, res) => {
    try {
      await handleFork(req, res);
    } catch {
      // No global Express error middleware is mounted, and Express 4 does not
      // catch rejections from async handlers — an uncaught throw here (e.g. an
      // EACCES/ENOTDIR from reading the parent or writing the fork) would
      // otherwise hang the request until socket timeout. Map any unexpected
      // failure to a clean 500. Guard against a double-send in case a response
      // was already partially written before the throw.
      if (!res.headersSent) {
        res.status(500).json({ error: 'Fork failed', code: 'fork_failed' });
      }
    }
  };

  async function handleFork(
    req: Parameters<RequestHandler>[0],
    res: Parameters<RequestHandler>[1],
  ): Promise<void> {
    const body = (req.body ?? {}) as {
      transcript?: unknown;
      fromEventId?: unknown;
      fromTurn?: unknown;
      name?: unknown;
    };

    // An optional human name for the fork. Trim, then cap to a sane length so a
    // pathological client can't append a giant title record. A blank/absent
    // name leaves the no-name fork path byte-identical to before this slice.
    const name =
      typeof body.name === 'string' ? body.name.trim().slice(0, 200) : '';

    // Resolve transcript mode. Default is 'include' (full copy).
    // 'summary' is deferred and returns 400. 'empty' is supported (header only).
    const transcriptMode =
      body.transcript === undefined || body.transcript === 'include'
        ? 'include'
        : body.transcript === 'empty'
          ? 'empty'
          : null;

    if (transcriptMode === null) {
      res.status(400).json({
        error: 'Unsupported fork mode',
        code: 'unsupported_fork_mode',
      });
      return;
    }

    // fromEventId: optional non-negative integer. When provided, the transcript
    // slice is capped at this many records (0 = empty body; n = first n records).
    // Validated as a non-negative integer; anything else is ignored (full copy).
    let fromEventId =
      typeof body.fromEventId === 'number' &&
      Number.isInteger(body.fromEventId) &&
      body.fromEventId >= 0
        ? body.fromEventId
        : undefined;

    // fromTurn: an alternative, turn-numbered way to name the same slice
    // boundary fromEventId already names (add-remote-rewind). Resolved via
    // the shared resolveTurn once the parent records are read below;
    // mutually exclusive with fromEventId (checked eagerly, before any
    // filesystem read).
    const hasFromTurn = body.fromTurn !== undefined;
    if (hasFromTurn && fromEventId !== undefined) {
      res.status(400).json({
        error: 'fromTurn and fromEventId are mutually exclusive',
        code: 'mutually_exclusive',
      });
      return;
    }

    // 2. An invalid id can't name a file → treat as a missing parent.
    const parentId = req.params.id;
    if (!isValidSessionId(parentId)) {
      res.status(404).json({
        error: 'Parent transcript not found',
        code: 'parent_transcript_not_found',
      });
      return;
    }

    // 3. Trusted workspace cwd → derived chats dir.
    const cwd = await resolveWorkspaceCwd();
    if (!cwd) {
      res
        .status(502)
        .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
      return;
    }
    const chatsDir = resolveChatsDir(cwd);

    // 4. Read the parent transcript (missing/empty/all-corrupt → 404).
    const allRecords = await readParentRecords(chatsDir, parentId);
    if (!allRecords) {
      res.status(404).json({
        error: 'Parent transcript not found',
        code: 'parent_transcript_not_found',
      });
      return;
    }

    if (hasFromTurn) {
      const resolved = resolveTurn(allRecords, body.fromTurn);
      if (!resolved.ok) {
        const status = resolved.error === 'invalid_turn' ? 400 : 409;
        res
          .status(status)
          .json({ error: resolved.error, code: resolved.error });
        return;
      }
      fromEventId = resolved.truncatedEventId;
    }

    // Apply fromEventId slicing: when present, take only the first fromEventId
    // records (so fromEventId=0 gives an empty slice, =1 takes the first record).
    // Empty mode always yields an empty slice regardless.
    const records =
      transcriptMode === 'empty'
        ? []
        : fromEventId !== undefined
          ? allRecords.slice(0, fromEventId)
          : allRecords;

    // 5. Replicate forkSession's copy and write the new file exclusively.
    const newId = randomId();
    // Defense-in-depth: the default generator is randomUUID (always valid), but
    // a misconfigured injected `randomId` must never produce an id that escapes
    // the chats dir on the path join below.
    if (!isValidSessionId(newId)) {
      res.status(500).json({ error: 'Fork failed', code: 'fork_failed' });
      return;
    }

    const forkedAt = now().toISOString();

    // Build the fork header — the very first JSONL line of the fork transcript.
    const forkHeader = buildForkHeader({
      parentSessionId: parentId,
      ...(fromEventId !== undefined ? { parentEventId: fromEventId } : {}),
      transcriptMode,
      forkedAt,
    });

    const forkedRecords = forkRecords(records, parentId, newId);
    // When named, append a core-faithful custom_title record (chained onto the
    // tail) so the fork shows its name in the picker, on resume, and via
    // /rc/sessions. Appended BEFORE writeFork → loadSession, so a malformed
    // record falls into the existing removeFork+502 rollback (never corruption).
    if (name) {
      forkedRecords.push(
        buildForkTitleRecord(forkedRecords, name, {
          uuid: randomUUID(),
          timestamp: forkedAt,
        }),
      );
    }

    // Prepend the fork header, then the copied (and optionally named) records.
    const allForked = [forkHeader, ...forkedRecords];
    const forked = serializeForked(allForked);
    try {
      await writeFork(chatsDir, newId, forked);
    } catch (err) {
      if (err instanceof ForkExistsError) {
        res.status(500).json({ error: 'Fork conflict', code: 'fork_conflict' });
        return;
      }
      throw err;
    }

    // 6. Drive the daemon to restore the fork by path. On failure, roll back
    //    the just-written file and report the daemon as unavailable.
    try {
      await daemon.loadSession(newId);
    } catch {
      await removeFork(chatsDir, newId);
      res
        .status(502)
        .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
      return;
    }

    // 7. Seed the WAL and publish SSE events when deps are wired.
    //    session_forked id = fromEventId + 1 (defaults to 1 when absent).
    //    child_forked id = 1 (the child WAL is always fresh).
    const parentEventId = fromEventId ?? 0;
    const sessionForkedId = parentEventId + 1;

    if (walDir) {
      const parentWal = new SessionWal({ dir: walDir, sessionId: parentId });
      parentWal.append({
        id: sessionForkedId,
        v: 1,
        type: 'session_forked',
        data: { childSessionId: newId, forkedAt },
      });
      parentWal.close();

      const childWal = new SessionWal({ dir: walDir, sessionId: newId });
      childWal.append({
        id: 1,
        v: 1,
        type: 'child_forked',
        data: { parentSessionId: parentId, forkedAt },
      });
      childWal.close();
    }

    if (bus) {
      bus.publish({
        type: 'session_event',
        sessionId: parentId,
        event: {
          id: sessionForkedId,
          v: 1,
          type: 'session_forked',
          data: { childSessionId: newId, forkedAt },
        },
      });
      bus.publish({
        type: 'session_event',
        sessionId: newId,
        event: {
          id: 1,
          v: 1,
          type: 'child_forked',
          data: { parentSessionId: parentId, forkedAt },
        },
      });
    }

    // 8. Audit ids + count only — never transcript content.
    void audit?.record({
      action: 'session_forked',
      actorTokenId: req.rcClient?.id,
      target: parentId,
      detail: {
        newSessionId: newId,
        copiedCount: records.length,
        named: !!name,
      },
    });

    res.status(200).json({
      sessionId: newId,
      parentSessionId: parentId,
      forkedAt,
    });
  }
}
