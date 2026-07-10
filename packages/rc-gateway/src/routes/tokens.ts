/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { TokenStore } from '../tokenStore.js';
import type { ConnectionRegistry } from '../connectionRegistry.js';
import {
  KNOWN_SCOPES,
  SESSION_READ,
  OWNER,
  BRIDGE,
  expandScopes,
  type RcScope,
} from '../scopes.js';
import type { AuditRecorder } from '../auditLog.js';

/** GET /rc/tokens → metadata list of issued tokens. */
export function createListTokensRoute(store: TokenStore): RequestHandler {
  return (_req, res) => {
    res.status(200).json(store.list());
  };
}

/** POST /rc/tokens { scopes?, label? } → mint a scope-clamped token. */
export function createMintTokenRoute(
  store: TokenStore,
  audit?: AuditRecorder,
): RequestHandler {
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
    // Normal rule: you can only grant a scope you hold. Exception: `bridge` is
    // grantable by an OWNER caller even though owner does NOT hold `bridge` —
    // the spec requires bridge be EXPLICIT (the caller must put it in the body)
    // and NOT implied by owner (an owner token never silently gains the subActor-
    // assertion capability). The route is owner-gated, so the owner check below
    // is structurally guaranteed; we assert it anyway for defense-in-depth.
    const canGrant = (s: RcScope): boolean =>
      s === BRIDGE ? callerScopes.includes(OWNER) : callerScopes.includes(s);
    const ungrantable = requested.filter((s) => !canGrant(s));
    if (ungrantable.length > 0) {
      res.status(403).json({
        error: `Cannot grant scope(s) you do not hold: ${ungrantable.join(', ')}`,
        code: 'insufficient_scope',
      });
      return;
    }
    // Materialize the concrete bundle (a `bridge` request also carries
    // session:read+approve+write) so every flat `includes()`/`scopesFor` check
    // works unchanged, and report the EXPANDED set so the response/audit reflect
    // the token's real capability.
    const granted = expandScopes(requested);
    const { id, token } = await store.issue(granted, label);
    void audit?.record({
      action: 'token_minted',
      actorTokenId: req.rcClient?.id,
      target: id,
      detail: { scopes: granted },
    });
    res.status(200).json({ id, token, scopes: granted });
  };
}

/**
 * DELETE /rc/tokens/:id → revoke + evict live streams. `onTokenRevoked` (when
 * supplied) runs AFTER the revoke+evict and is awaited before the 204, so a
 * caller can cascade-delete token-bound resources in the same request (e.g. APNs
 * subscriptions, add-native-mobile-shells "On token revocation the APNs
 * subscription SHALL be removed"). The hook must not throw — it is awaited and
 * an error would surface as a 500; wrap risky work inside it.
 */
export function createRevokeTokenRoute(
  store: TokenStore,
  registry: ConnectionRegistry,
  audit?: AuditRecorder,
  onTokenRevoked?: (tokenId: string) => void | Promise<void>,
): RequestHandler {
  return async (req, res) => {
    const id = req.params.id;
    if (!(await store.revoke(id))) {
      res.status(404).json({ error: 'No such token', code: 'token_not_found' });
      return;
    }
    registry.evict(id);
    if (onTokenRevoked) await onTokenRevoked(id);
    void audit?.record({
      action: 'token_revoked',
      actorTokenId: req.rcClient?.id,
      target: id,
    });
    res.status(204).end();
  };
}

/**
 * POST /rc/tokens/revoke-all → batch-revoke all tokens (owner-scoped).
 *
 * Body: `{ "except": "self" }` (optional) — when present, spares the calling
 * token from revocation so the owner retains access. Without this field, ALL
 * tokens (including the caller's) are revoked.
 *
 * Response 200: `{ revokedIds: string[] }` — ids of every newly-revoked token.
 * One `token_revoked` audit entry is written per revoked id.
 * Live SSE/WS streams are evicted for every revoked token.
 */
export function createRevokeAllTokensRoute(
  store: TokenStore,
  registry: ConnectionRegistry,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const body = (req.body ?? {}) as { except?: unknown };
    const exceptSelf = body.except === 'self';
    const callerTokenId = req.rcClient?.id;
    const exceptTokenId =
      exceptSelf && callerTokenId ? callerTokenId : undefined;

    const { revokedIds } = await store.revokeAll({ exceptTokenId });

    for (const id of revokedIds) {
      registry.evict(id);
      void audit?.record({
        action: 'token_revoked',
        actorTokenId: callerTokenId,
        target: id,
      });
    }

    res.status(200).json({ revokedIds });
  };
}
