/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Request, RequestHandler } from 'express';
import type { AuditRecorder } from '../auditLog.js';
import { resolveChatsDir } from '../sessions/chatsPath.js';
import { listSessions } from '../sessions/sessionList.js';

/**
 * GET /rc/sessions — a flat, workspace-wide list of sessions with fork lineage:
 * each item carries its `parentSessionId` (when a fork) and a derived `forks[]`
 * reverse index, so a client can render the fork tree. `truncated` flags a
 * partial scan (the file-count cap was hit).
 *
 * OWNER-scoped at the mount (same posture as `/session/:id/lineage`): a flat
 * topology enumerates sibling/ancestor ids a session-locked share token must
 * never see. Read-only and daemon-light — `resolveWorkspaceCwd` is
 * request-aware (callers may honor a `?cwd`/`:cwd` override, `path.resolve`d,
 * falling back to the trusted boot `workspaceCwd`), then the listing scans
 * the on-disk chats dir (the same first-record `forkedFrom` source lineage
 * reads). Any request-supplied cwd only ever becomes a `sanitizeCwd` project-id
 * segment (every non-alphanumeric char becomes a dash) before touching disk, so it
 * can never escape the chats root. The on-disk scan (NOT the daemon's
 * active-only `listWorkspaceSessions`) is deliberate: dormant parents must
 * appear.
 */
export function createSessionListRoute(
  resolveWorkspaceCwd: (req: Request) => Promise<string | undefined>,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    try {
      const cwd = await resolveWorkspaceCwd(req);
      if (!cwd) {
        res
          .status(502)
          .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
        return;
      }

      const result = await listSessions(resolveChatsDir(cwd));

      // Privacy: count + truncated flag only — never the session ids.
      void audit?.record({
        action: 'session_list_read',
        actorTokenId: req.rcClient?.id,
        detail: { count: result.sessions.length, truncated: result.truncated },
      });

      res.status(200).json(result);
    } catch {
      // No global Express error middleware; an uncaught async rejection would
      // hang the request. Map any unexpected failure (e.g. EACCES on readdir)
      // to a clean 500. Guard against a double-send.
      if (!res.headersSent) {
        res
          .status(500)
          .json({ error: 'Listing failed', code: 'session_list_failed' });
      }
    }
  };
}
