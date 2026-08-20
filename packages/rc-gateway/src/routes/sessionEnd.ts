/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { SessionDaemon } from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';

/**
 * POST /session/:id/end — tell the daemon to end (terminate) the named session.
 *
 * Write-scoped. On success the daemon emits `session_died` with
 * `reason: "ended_by_client"` on the session's event stream (spec:
 * remote-session-host "Requirement: Explicit session termination").
 *
 * The gateway does not need to fan-out anything itself here — the daemon's
 * `session_died` event flows naturally through the live SSE relay.
 */
export function createSessionEndRoute(
  daemon: SessionDaemon,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    const actorTokenId = req.rcClient?.id;

    try {
      await daemon.closeSession(sessionId);
    } catch {
      res.status(502).json({
        error: 'Daemon unavailable',
        code: 'daemon_unavailable',
      });
      return;
    }

    void audit?.record({
      action: 'session_ended',
      actorTokenId,
      target: sessionId,
    });

    res.status(200).json({ sessionId, ended: true });
  };
}
