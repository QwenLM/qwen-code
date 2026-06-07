/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { TokenStore } from '../tokenStore.js';
import type { ConnectionRegistry } from '../connectionRegistry.js';
import { KNOWN_SCOPES, SESSION_READ, type RcScope } from '../scopes.js';

/** GET /rc/tokens → metadata list of issued tokens. */
export function createListTokensRoute(store: TokenStore): RequestHandler {
  return (_req, res) => {
    res.status(200).json(store.list());
  };
}

/** POST /rc/tokens { scopes?, label? } → mint a scope-clamped token. */
export function createMintTokenRoute(store: TokenStore): RequestHandler {
  return async (req, res) => {
    const body = (req.body ?? {}) as { scopes?: unknown; label?: unknown };
    const requested: RcScope[] = Array.isArray(body.scopes)
      ? (body.scopes as unknown[]).map(String)
      : [SESSION_READ];
    const label = typeof body.label === 'string' ? body.label : 'unnamed';

    const unknown = requested.filter((s) => !KNOWN_SCOPES.includes(s));
    if (unknown.length > 0) {
      res.status(400).json({
        error: `Unknown scope(s): ${unknown.join(', ')}`,
        code: 'invalid_scope',
      });
      return;
    }
    const callerScopes = req.rcClient?.scopes ?? [];
    const ungrantable = requested.filter((s) => !callerScopes.includes(s));
    if (ungrantable.length > 0) {
      res.status(403).json({
        error: `Cannot grant scope(s) you do not hold: ${ungrantable.join(', ')}`,
        code: 'insufficient_scope',
      });
      return;
    }
    const { id, token } = await store.issue(requested, label);
    res.status(200).json({ id, token, scopes: requested });
  };
}

/** DELETE /rc/tokens/:id → revoke + evict live streams. */
export function createRevokeTokenRoute(
  store: TokenStore,
  registry: ConnectionRegistry,
): RequestHandler {
  return async (req, res) => {
    const id = req.params.id;
    if (!(await store.revoke(id))) {
      res.status(404).json({ error: 'No such token', code: 'token_not_found' });
      return;
    }
    registry.evict(id);
    res.status(204).end();
  };
}
