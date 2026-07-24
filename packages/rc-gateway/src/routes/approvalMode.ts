/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { DaemonApprovalMode, DaemonClient } from '@qwen-code/sdk';
import { DAEMON_APPROVAL_MODES } from '@qwen-code/sdk';
import type { AuditRecorder } from '../auditLog.js';
import { OWNER, hasScope } from '../scopes.js';

/** The daemon surface this route needs: just `setSessionApprovalMode`. */
export type ApprovalModeDaemon = Pick<DaemonClient, 'setSessionApprovalMode'>;

/**
 * Type guard narrowing an arbitrary request-body value down to the closed
 * `DaemonApprovalMode` union, so the daemon call below is fully typed rather
 * than needing an `as` cast at the call site.
 */
function isDaemonApprovalMode(v: unknown): v is DaemonApprovalMode {
  return (
    typeof v === 'string' &&
    (DAEMON_APPROVAL_MODES as readonly string[]).includes(v)
  );
}

export interface ApprovalModeRouteDeps {
  audit?: AuditRecorder;
}

/**
 * Modes that grant the caller elevated, less-supervised authority over the
 * session (auto-apply edits / commands without a per-action approval). A
 * durable `persist: true` write to workspace settings is gated the same way
 * regardless of mode, since it outlives the request.
 */
const POWER_MODES = new Set(['auto-edit', 'auto', 'yolo']);

/**
 * POST /session/:id/approval-mode — proxy the daemon's approval-mode change
 * (via the SDK) with a tiered scope gate and a passthrough of the daemon's
 * own trust-gate decision.
 *
 * Tiered scope (fail-closed): `plan`/`default` need only WRITE (the mount
 * floor — see server.ts); a power mode (`auto-edit`/`auto`/`yolo`) OR a
 * durable `persist: true` demands OWNER, checked in-handler BEFORE any
 * daemon call. A rejected escalation is audited as `scope_denied` (mirrors
 * routes/review.ts's privileged-flag gate) and the daemon is never touched.
 *
 * The daemon's own trust-folder gate (core's `setApprovalMode` refusing a
 * power mode in an untrusted folder) responds 403; that status/body is
 * surfaced UNCHANGED so a remote client can distinguish "you lack scope"
 * from "the daemon's folder isn't trusted" and learn the real reason. A 404
 * (older daemon, route absent) maps to 502 `approval_mode_unsupported`; any
 * other failure (network, 5xx, timeout) maps to 502 `daemon_unavailable`.
 *
 * On success, audits `session_approval_mode_set` with ONLY
 * `{ mode, previous, persisted, planExitedOutOfBand }` — never args, paths,
 * or prompt content — and the actor is always the AUTHENTICATED
 * `req.rcClient`, never anything from the request body.
 *
 * This route does NOT publish to the owner-event bus or send a push
 * notification — that fan-out is driven by the daemon's own
 * `approval_mode_changed` event (a later task's pump), so there is exactly
 * one broadcast per change regardless of how the change was triggered
 * (this route, another client, or a local CLI toggle).
 */
export function createApprovalModeRoute(
  daemon: ApprovalModeDaemon,
  deps: ApprovalModeRouteDeps = {},
): RequestHandler {
  return async (req, res) => {
    try {
      await handleApprovalMode(req, res, daemon, deps);
    } catch {
      // No global Express error middleware is mounted and Express 4 does not
      // catch async-handler rejections (mirrors routes/rewind.ts's
      // top-level guard); map any unexpected failure to a clean 500. Guard
      // against a double-send if a response was already written.
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Approval mode change failed',
          code: 'approval_mode_failed',
        });
      }
    }
  };
}

async function handleApprovalMode(
  req: Parameters<RequestHandler>[0],
  res: Parameters<RequestHandler>[1],
  daemon: ApprovalModeDaemon,
  deps: ApprovalModeRouteDeps,
): Promise<void> {
  const sessionId = req.params.id;
  const body = (req.body ?? {}) as { mode?: unknown; persist?: unknown };

  // Validate mode: an unknown string (or non-string) fails closed 400,
  // never silently coerced to a default.
  if (!isDaemonApprovalMode(body.mode)) {
    res.status(400).json({
      error: 'Invalid approval mode',
      code: 'invalid_approval_mode',
      allowed: DAEMON_APPROVAL_MODES,
    });
    return;
  }
  const mode = body.mode;

  // Validate persist: only `true`/absent/`false` are meaningful; any other
  // type (string, number, object) fails closed rather than being coerced.
  if (body.persist !== undefined && typeof body.persist !== 'boolean') {
    res
      .status(400)
      .json({ error: 'Invalid persist flag', code: 'invalid_persist_flag' });
    return;
  }
  const persist = body.persist === true;

  // Tiered scope: OWNER for power modes or a durable persist; WRITE (the
  // mount floor) is enough for plan/default. Fail closed, and never grant
  // more than the request asks for (a WRITE token cannot escalate itself
  // by omitting persist and relying on a defaulted true, etc.).
  const needsOwner = POWER_MODES.has(mode) || persist;
  if (needsOwner && !hasScope(req.rcClient?.scopes ?? [], OWNER)) {
    void deps.audit?.record({
      action: 'scope_denied',
      actorTokenId: req.rcClient?.id,
      subActor: req.rcClient?.subActor,
      detail: { required: 'owner', reason: 'approval_mode', mode, persist },
    });
    res
      .status(403)
      .json({ error: 'Owner scope required', code: 'owner_scope_required' });
    return;
  }

  // Proxy the daemon. Any failure aborts before any audit row is written.
  let result;
  try {
    result = await daemon.setSessionApprovalMode(
      sessionId,
      mode,
      persist ? { persist: true } : {},
    );
  } catch (err) {
    const status = (err as { status?: unknown }).status;
    const eBody = (err as { body?: unknown }).body as
      | {
          code?: unknown;
          errorKind?: unknown;
          error?: unknown;
          message?: unknown;
        }
      | undefined;
    if (status === 403) {
      // Daemon trust gate (a power mode in an untrusted folder) — surface
      // unchanged so the remote client learns the folder is untrusted, not
      // merely that its own scope was insufficient. Prefer the daemon's own
      // human-readable message (`error`, then `message`) when present, so
      // the string is faithful to what the daemon actually said; otherwise
      // fall back to the generic message below. Only that single string is
      // copied — never the whole daemon body.
      const humanError =
        (typeof eBody?.error === 'string' && eBody.error.length > 0
          ? eBody.error
          : undefined) ??
        (typeof eBody?.message === 'string' && eBody.message.length > 0
          ? eBody.message
          : undefined) ??
        'Approval mode blocked by folder trust';
      res.status(403).json({
        error: humanError,
        code: typeof eBody?.code === 'string' ? eBody.code : 'trust_gate',
        ...(typeof eBody?.errorKind === 'string'
          ? { errorKind: eBody.errorKind }
          : {}),
      });
      return;
    }
    if (status === 404) {
      res.status(502).json({
        error: 'Daemon does not support approval-mode control',
        code: 'approval_mode_unsupported',
      });
      return;
    }
    res
      .status(502)
      .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
    return;
  }

  // A plan-mode session that ends up somewhere else counts as exiting plan
  // "out of band" from this request's perspective (e.g. the daemon's own
  // plan-exit heuristic fired), which downstream UIs care about.
  const planExitedOutOfBand =
    result.previous === 'plan' && result.mode !== 'plan';

  void deps.audit?.record({
    action: 'session_approval_mode_set',
    actorTokenId: req.rcClient?.id,
    subActor: req.rcClient?.subActor,
    target: sessionId,
    detail: {
      mode: result.mode,
      previous: result.previous,
      persisted: result.persisted,
      planExitedOutOfBand,
    },
  });

  res.status(200).json({
    sessionId,
    mode: result.mode,
    previous: result.previous,
    persisted: result.persisted,
    planExitedOutOfBand,
  });
}
