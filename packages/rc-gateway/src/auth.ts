/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { TokenStore } from './tokenStore.js';
import type { RcScope } from './scopes.js';
import './types.js';

/** Resolve the bearer token to `req.rcClient`, or 401. */
export function bearerResolve(store: TokenStore): RequestHandler {
  return (req, res, next) => {
    const header = req.headers.authorization ?? '';
    const resolved = store.resolve(header);
    if (!resolved) {
      res.status(401).json({ error: 'Unauthorized', code: 'unauthorized' });
      return;
    }
    req.rcClient = resolved;
    next();
  };
}

/** Require a scope on the resolved client, or 403. */
export function requireScope(scope: RcScope): RequestHandler {
  return (req, res, next) => {
    if (!req.rcClient || !req.rcClient.scopes.includes(scope)) {
      res
        .status(403)
        .json({ error: 'Insufficient scope', code: 'insufficient_scope' });
      return;
    }
    next();
  };
}
