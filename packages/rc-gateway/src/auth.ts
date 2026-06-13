/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { TokenStore } from './tokenStore.js';
import { BRIDGE, type RcScope } from './scopes.js';
import type { AuditRecorder } from './auditLog.js';
import './types.js';

/** Max length of an asserted sub-actor id (bounds audit-row size). */
const SUB_ACTOR_MAX = 128;
/**
 * A sub-actor id must start alphanumeric and use only a safe id charset
 * (`<svc>:<user-id>` shapes like `telegram:evan`, `discord:12345`). The charset
 * deliberately EXCLUDES whitespace and control characters so an asserted value
 * can never inject a newline into a JSONL audit line or smuggle markup into a
 * client that renders it.
 */
const SUB_ACTOR_RE = /^[A-Za-z0-9][A-Za-z0-9:._@-]*$/;

/**
 * Parse + validate an `X-RC-SubActor` header value. Returns the trimmed id, or
 * `null` when absent/empty/too-long/ill-formed. PURE.
 */
export function parseSubActor(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (v.length === 0 || v.length > SUB_ACTOR_MAX) return null;
  return SUB_ACTOR_RE.test(v) ? v : null;
}

/**
 * Resolve an asserted sub-actor (the underlying human behind a bridge) onto
 * `req.rcClient.subActor`. SECURITY: a sub-actor is attached ONLY when the
 * resolved token holds the `bridge` scope AND the header value is valid — a
 * regular client sending `X-RC-SubActor` is silently ignored, so no client can
 * forge "acting for someone else" in the audit log. Mount AFTER `bearerResolve`.
 * Never rejects (a bad/absent header just yields no attribution); total.
 */
export function resolveSubActor(): RequestHandler {
  return (req, _res, next) => {
    const client = req.rcClient;
    if (client && client.scopes.includes(BRIDGE)) {
      // Header `X-RC-SubActor` lowercases on the wire to `x-rc-subactor`.
      const sub = parseSubActor(req.header('x-rc-subactor'));
      if (sub) client.subActor = sub;
    }
    next();
  };
}

/** Resolve the bearer token to `req.rcClient`, or 401 (+ audit auth_failed). */
export function bearerResolve(
  store: TokenStore,
  audit?: AuditRecorder,
): RequestHandler {
  return (req, res, next) => {
    const header = req.headers.authorization ?? '';
    const resolved = store.resolve(header);
    if (!resolved) {
      void audit?.record({ action: 'auth_failed', detail: { path: req.path } });
      res.status(401).json({ error: 'Unauthorized', code: 'unauthorized' });
      return;
    }
    req.rcClient = resolved;
    // A share token (the only kind with a session lock) gets its id + label
    // surfaced so guest-action routes can stamp audit rows with the share's
    // identity at action time. Normal tokens never get these fields.
    if (resolved.sessionLockId !== undefined) {
      req.rcClient.shareId = resolved.id;
      req.rcClient.shareLabel = resolved.shareLabel;
    }
    next();
  };
}

/**
 * Confine a session-locked token (a share) to its one session. When
 * `req.rcClient.sessionLockId` is set and does not match `req.params.id`, 403
 * `session_locked` (audited via the existing `scope_denied` action). A token
 * with no lock (normal owner/paired tokens) passes through unaffected. Mount
 * AFTER `requireScope(...)` on the session routes.
 */
export function enforceSessionLock(audit?: AuditRecorder): RequestHandler {
  return (req, res, next) => {
    const lock = req.rcClient?.sessionLockId;
    if (lock !== undefined && lock !== req.params.id) {
      void audit?.record({
        action: 'scope_denied',
        actorTokenId: req.rcClient?.id,
        shareId: req.rcClient?.shareId,
        shareLabel: req.rcClient?.shareLabel,
        detail: { reason: 'session_locked', path: req.path },
      });
      res.status(403).json({ error: 'Session locked', code: 'session_locked' });
      return;
    }
    next();
  };
}

/** Require a scope on the resolved client, or 403 (+ audit scope_denied). */
export function requireScope(
  scope: RcScope,
  audit?: AuditRecorder,
): RequestHandler {
  return (req, res, next) => {
    if (!req.rcClient || !req.rcClient.scopes.includes(scope)) {
      void audit?.record({
        action: 'scope_denied',
        actorTokenId: req.rcClient?.id,
        shareId: req.rcClient?.shareId,
        shareLabel: req.rcClient?.shareLabel,
        detail: { required: scope },
      });
      res
        .status(403)
        .json({ error: 'Insufficient scope', code: 'insufficient_scope' });
      return;
    }
    next();
  };
}
