/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { TokenStore } from './tokenStore.js';
import type { RcScope } from './scopes.js';
import type { AuditRecorder } from './auditLog.js';
import './types.js';

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
