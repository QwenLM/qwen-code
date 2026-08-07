/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { DaemonClient } from '@qwen-code/sdk';
import type { AuditRecorder } from '../auditLog.js';

/**
 * POST /session — create (or attach to) a daemon session so a freshly-paired
 * client (the web UI's "New conversation" button) has a session to watch and
 * prompt. Write-scoped. Bare namespace, mirroring the daemon's own
 * `POST /session` 1:1 (transparent-proxy topology).
 *
 * Body: `{ cwd?: string; scope?: 'single' | 'thread' }`.
 *  - `cwd` omitted/empty → the daemon falls back to its bound workspace.
 *  - `scope` defaults to `'single'` (coalesce onto the workspace's session);
 *    `'thread'` opens a fresh independent session.
 *
 * The gateway itself never spawns sessions — it holds the daemon token and the
 * daemon's `createOrAttachSession` does the real work. On success returns the
 * new session's id (+ its workspace) so the caller can immediately watch it.
 *
 * Audit carries only the session id (`target`) and the scope enum — never the
 * `cwd` path (audit records stay free of paths/args per the gateway's data
 * contract).
 */
export function createSessionCreateRoute(
  daemon: DaemonClient,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const body = (req.body ?? {}) as { cwd?: unknown; scope?: unknown };
    const workspaceCwd =
      typeof body.cwd === 'string' && body.cwd.length > 0
        ? body.cwd
        : undefined;
    const sessionScope = body.scope === 'thread' ? 'thread' : 'single';
    const actorTokenId = req.rcClient?.id;

    let session;
    try {
      session = await daemon.createOrAttachSession({
        workspaceCwd,
        sessionScope,
      });
    } catch {
      res
        .status(502)
        .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
      return;
    }

    void audit?.record({
      action: 'session_created',
      actorTokenId,
      target: session.sessionId,
      detail: { scope: sessionScope },
    });

    res.status(200).json({
      sessionId: session.sessionId,
      workspaceCwd: session.workspaceCwd,
    });
  };
}
