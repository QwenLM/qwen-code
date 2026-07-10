/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { AuditRecorder } from '../auditLog.js';
import { resolveChatsDir, isValidSessionId } from '../sessions/chatsPath.js';
import { readParentRecords } from '../sessions/forkStore.js';
import { walkLineage } from '../sessions/lineage.js';
import { readSessionTitle } from '../sessions/sessionList.js';

/**
 * GET /session/:id/lineage — the fork lineage chain of a session, from the
 * session itself up to its root ancestor.
 *
 * OWNER-scoped at the mount (a lineage chain enumerates ancestor session ids; a
 * session-locked share token must never learn sibling/ancestor ids it isn't
 * locked to). Read-only: walks each transcript's first-record
 * `forkedFrom.sessionId` on demand — no daemon call beyond resolving the trusted
 * workspace cwd, no in-memory adjacency map, no write path. `resolveWorkspaceCwd`
 * yields the trusted `workspaceCwd`; no request input ever reaches a path.
 */
export function createLineageRoute(
  resolveWorkspaceCwd: () => Promise<string | undefined>,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    try {
      // An invalid id can't name a transcript file -> "not found".
      const sessionId = req.params.id;
      if (!isValidSessionId(sessionId)) {
        res.status(404).json({
          error: 'Session not found',
          code: 'session_not_found',
        });
        return;
      }

      const cwd = await resolveWorkspaceCwd();
      if (!cwd) {
        res
          .status(502)
          .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
        return;
      }
      const chatsDir = resolveChatsDir(cwd);

      const result = await walkLineage(sessionId, {
        readRecords: (id) => readParentRecords(chatsDir, id),
        isValidId: isValidSessionId,
      });
      // null = the START transcript is missing.
      if (result === null) {
        res.status(404).json({
          error: 'Session not found',
          code: 'session_not_found',
        });
        return;
      }

      // Enrich each node with its human title (bounded tail read, never throws),
      // so the lineage chain renders names instead of bare ids — same source of
      // truth as /rc/sessions. Best-effort: a missing title just omits the field.
      for (const node of result.chain) {
        const title = await readSessionTitle(chatsDir, node.sessionId);
        if (title) node.title = title;
      }

      // Privacy: depth + truncated flag only — never the session ids themselves.
      void audit?.record({
        action: 'session_lineage_read',
        actorTokenId: req.rcClient?.id,
        target: sessionId,
        detail: { depth: result.chain.length, truncated: result.truncated },
      });

      res.status(200).json(result);
    } catch {
      // No global Express error middleware; an uncaught async rejection would
      // hang the request. Map any unexpected failure (e.g. EACCES reading a
      // transcript) to a clean 500. Guard against a double-send.
      if (!res.headersSent) {
        res
          .status(500)
          .json({ error: 'Lineage failed', code: 'lineage_failed' });
      }
    }
  };
}
