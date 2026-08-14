/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import { stat } from 'node:fs/promises';
import { WorkspacePoolFullError, type SessionDaemon } from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';

/**
 * POST /session — create (or attach to) a daemon session so a freshly-paired
 * client (the web UI's "New conversation" button) has a session to watch and
 * prompt. Write-scoped. Bare namespace, mirroring the daemon's own
 * `POST /session` 1:1 (transparent-proxy topology).
 *
 * Body: `{ cwd?: string; scope?: 'single' | 'thread' }`.
 *  - `cwd` omitted/empty → routes to the default (boot) daemon/workspace,
 *    unchanged.
 *  - `cwd` non-empty → MUST name an existing directory (checked here, before
 *    any daemon call) or the request is rejected `400 invalid_workspace`; a
 *    valid `cwd` is handed to `daemon` (a `DaemonPool` in production), which
 *    spawns or reuses the `qwen serve` bound to that workspace and routes the
 *    call there (add-multi-workspace-daemon-pool).
 *  - `scope` defaults to `'single'` (coalesce onto the workspace's session);
 *    `'thread'` opens a fresh independent session.
 *
 * The gateway itself never spawns the SESSION — it holds the daemon token and
 * `createOrAttachSession` does the real work (whether against a single daemon
 * or the pool). On success returns the new session's id (+ its workspace) so
 * the caller can immediately watch it.
 *
 * Audit carries only the session id (`target`) and the scope enum — never the
 * `cwd` path (audit records stay free of paths/args per the gateway's data
 * contract).
 */
export function createSessionCreateRoute(
  daemon: SessionDaemon,
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

    // Validate a non-empty cwd BEFORE any daemon call: it must name an
    // existing directory. Any stat failure (ENOENT, EACCES, not-a-dir, …) or
    // a non-directory target collapses to the same 400 — the error message
    // never echoes the path (audit/error-hygiene invariant below).
    if (workspaceCwd !== undefined) {
      let isDir = false;
      try {
        isDir = (await stat(workspaceCwd)).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) {
        res.status(400).json({
          error: 'cwd must be an existing directory',
          code: 'invalid_workspace',
        });
        return;
      }
    }

    let session;
    try {
      session = await daemon.createOrAttachSession({
        workspaceCwd,
        sessionScope,
      });
    } catch (err) {
      // A full workspace daemon pool (max concurrent workspace daemons, all
      // busy — see DaemonPool.evictLruIdle) is a distinct, RETRYABLE
      // condition, not a daemon failure — surface it as its own 503 rather
      // than collapsing it into the generic 502 below.
      if (err instanceof WorkspacePoolFullError) {
        res.status(503).json({
          error: 'Workspace pool full',
          code: 'workspace_pool_full',
        });
        return;
      }
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
