/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { SessionDaemon } from '../daemonPool.js';
import { isValidSessionId } from '../sessions/chatsPath.js';

/**
 * GET /session/:id/context — relay the daemon's per-session context status so a
 * remote client (the web UI's status footer) can show "model · N-token context
 * window · approval mode · cwd" without the terminal TUI. The payload is the
 * daemon's `DaemonSessionContextStatus`: `state.models` (available models, each
 * flagged `isCurrent` and carrying its `contextLimit`), `state.modes`
 * (`currentModeId` + `availableModes`), and the workspace cwd.
 *
 * Read-scoped, bare namespace (transparent-proxy topology — 1:1 with the
 * daemon's own `GET /session/:id/context`). The gateway holds the daemon token;
 * the daemon does the work. Not audited: a context read is a status poll (like
 * the event stream's own idle polling) with no mutation and no path/arg payload.
 */
export function createSessionContextRoute(
  daemon: SessionDaemon,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    // Reject a malformed/path-traversal-shaped id before any daemon call —
    // mirrors the sibling session routes (events, fork, rewind).
    if (!isValidSessionId(sessionId)) {
      res
        .status(404)
        .json({ error: 'Session not found', code: 'session_not_found' });
      return;
    }
    try {
      const status = await daemon.sessionContext(sessionId);
      res.status(200).json(status);
    } catch {
      res
        .status(502)
        .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
    }
  };
}
