/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import { stat } from 'node:fs/promises';
import { WorkspacePoolFullError, type SessionDaemon } from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';
import { isValidSessionId } from '../sessions/chatsPath.js';

/**
 * POST /session/:id/resume — reactivate a past (ended) conversation on its
 * workspace's daemon so a phone can pick it back up (add-resume-conversations).
 *
 * Body: `{ cwd: string }` — the workspace the session originally ran in.
 * Unlike `POST /session` (create), `cwd` is REQUIRED here: a resumed session
 * was never in this process's memory (the gateway may have restarted since
 * it ended), so there is no default workspace to fall back to — the caller
 * must supply the one the session's transcript lives under.
 *
 * `cwd` MUST name an existing directory (checked here, before any daemon
 * call) or the request is rejected `400 invalid_workspace` — mirrors
 * `sessionCreate.ts`'s cwd validation exactly.
 *
 * On success, `daemon.resumeSession(sessionId, { workspaceCwd: cwd })` (a
 * `SessionDaemon` — either a single `DaemonClient` or the multi-workspace
 * `DaemonPool`, add-workspace-pool) spawns/reuses the daemon bound to `cwd`
 * and resumes the session there, returning `200 { sessionId, workspaceCwd }`
 * so the caller can immediately attach/watch it.
 *
 * Audit carries only the session id (`target`) — never the `cwd` path (audit
 * records stay free of paths/args per the gateway's data contract).
 */
export function createSessionResumeRoute(
  daemon: Pick<SessionDaemon, 'resumeSession'>,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    // Reject a malformed/path-traversal-shaped id BEFORE any work — mirrors
    // every sibling session route (sessionEvents.ts, sessionContext.ts,
    // fork.ts, rewind.ts).
    if (!isValidSessionId(sessionId)) {
      res
        .status(404)
        .json({ error: 'Session not found', code: 'session_not_found' });
      return;
    }

    const body = (req.body ?? {}) as { cwd?: unknown };
    const workspaceCwd =
      typeof body.cwd === 'string' && body.cwd.length > 0
        ? body.cwd
        : undefined;
    const actorTokenId = req.rcClient?.id;

    // A resumed session's workspace was never in this process's memory —
    // require a non-empty cwd naming an existing directory BEFORE any daemon
    // call. Any stat failure (ENOENT, EACCES, not-a-dir, …) or a missing cwd
    // collapses to the same 400 — the error message never echoes the path
    // (audit/error-hygiene invariant, see the module doc above).
    let isDir = false;
    if (workspaceCwd !== undefined) {
      try {
        isDir = (await stat(workspaceCwd)).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (!isDir || workspaceCwd === undefined) {
      res.status(400).json({
        error: 'cwd must be an existing directory',
        code: 'invalid_workspace',
      });
      return;
    }

    try {
      await daemon.resumeSession(sessionId, { workspaceCwd });
    } catch (err) {
      // A full workspace daemon pool (max concurrent workspace daemons, all
      // busy) is a distinct, RETRYABLE condition — surface it as its own 503
      // rather than collapsing it into the generic 502 below (mirrors
      // sessionCreate.ts).
      if (err instanceof WorkspacePoolFullError) {
        res.status(503).json({
          error: 'Workspace pool full',
          code: 'workspace_pool_full',
        });
        return;
      }
      if (isSessionNotFoundError(err)) {
        res
          .status(404)
          .json({ error: 'Session not found', code: 'session_not_found' });
        return;
      }
      res
        .status(502)
        .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
      return;
    }

    void audit?.record({
      action: 'session_resumed',
      actorTokenId,
      target: sessionId,
    });

    res.status(200).json({ sessionId, workspaceCwd });
  };
}

/**
 * Whether `err` indicates the daemon couldn't find the session's transcript
 * on disk (as opposed to being unreachable or erroring some other way) — a
 * distinct `404 session_not_found` rather than the generic `502
 * daemon_unavailable`. `DaemonHttpError` (thrown by `DaemonClient`) carries a
 * numeric `status`; a plain 404 there is unambiguous. Otherwise fall back to
 * a case-insensitive "not found" match in the error message, which is what
 * both `DaemonHttpError`'s formatted message and `UnknownSessionError`
 * (thrown by `DaemonPool` for a session id it has no record of) produce.
 */
function isSessionNotFoundError(err: unknown): boolean {
  const status = (err as { status?: unknown } | undefined)?.status;
  if (status === 404) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /not found/i.test(message);
}
