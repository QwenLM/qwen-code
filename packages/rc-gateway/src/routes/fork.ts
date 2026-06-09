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
import { forkRecords, serializeForked } from '../sessions/forkTranscript.js';
import {
  readParentRecords,
  writeFork,
  removeFork,
  ForkExistsError,
} from '../sessions/forkStore.js';

/** The daemon surface this route needs: just `loadSession`. */
type ForkDaemon = Pick<DaemonClient, 'loadSession'>;

export interface ForkRouteDeps {
  audit?: AuditRecorder;
  /** Wall-clock for the `forkedAt` stamp (injectable for tests). */
  now?: () => Date;
  /** New session id generator (injectable for tests; defaults to randomUUID). */
  randomId?: () => string;
}

/**
 * POST /rc/session/:id/fork — fork a settled session into a brand-new
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
 * ever reaches a filesystem path). Only full-copy `include` mode is supported
 * this slice; `transcript` other than `include`, or any `fromEventId`, is
 * rejected up front so deferred modes fail clearly.
 */
export function createForkRoute(
  daemon: ForkDaemon,
  resolveWorkspaceCwd: () => Promise<string | undefined>,
  deps: ForkRouteDeps = {},
): RequestHandler {
  const now = deps.now ?? (() => new Date());
  const randomId = deps.randomId ?? randomUUID;
  const { audit } = deps;

  return async (req, res) => {
    const body = (req.body ?? {}) as {
      transcript?: unknown;
      fromEventId?: unknown;
    };

    // 1. Reject deferred fork modes explicitly (don't silently full-copy).
    if (
      (body.transcript !== undefined && body.transcript !== 'include') ||
      body.fromEventId !== undefined
    ) {
      res
        .status(400)
        .json({
          error: 'Unsupported fork mode',
          code: 'unsupported_fork_mode',
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
    const records = await readParentRecords(chatsDir, parentId);
    if (!records) {
      res.status(404).json({
        error: 'Parent transcript not found',
        code: 'parent_transcript_not_found',
      });
      return;
    }

    // 5. Replicate forkSession's copy and write the new file exclusively.
    const newId = randomId();
    const forked = serializeForked(forkRecords(records, parentId, newId));
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

    // 7. Audit ids + count only — never transcript content.
    void audit?.record({
      action: 'session_forked',
      actorTokenId: req.rcClient?.id,
      target: parentId,
      detail: { newSessionId: newId, copiedCount: records.length },
    });

    res.status(200).json({
      sessionId: newId,
      parentSessionId: parentId,
      forkedAt: now().toISOString(),
    });
  };
}
