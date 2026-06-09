/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router } from 'express';
import type { TokenStore } from '../tokenStore.js';
import type { ConnectionRegistry } from '../connectionRegistry.js';
import { SHARE, SESSION_READ, APPROVE } from '../scopes.js';
import type { AuditRecorder } from '../auditLog.js';

/**
 * Owner-gated share mint/list/revoke routes. A share token is a normal
 * `TokenStore` token carrying `[SHARE, session:read(, approve)]` plus a session
 * lock and a TTL — never `write` or `owner`. Mount at `/rc/share` behind
 * `requireScope(OWNER)`.
 */
export function createShareRouter(
  store: TokenStore,
  registry: ConnectionRegistry,
  audit?: AuditRecorder,
): Router {
  const router = Router();

  // POST / → mint a session-locked, TTL-bounded view/approve share token.
  router.post('/', async (req, res) => {
    const body = (req.body ?? {}) as {
      sessionId?: unknown;
      ttlSec?: unknown;
      label?: unknown;
      scope?: unknown;
    };
    const sessionId = body.sessionId;
    const ttlSec = body.ttlSec;
    if (
      typeof sessionId !== 'string' ||
      sessionId.length === 0 ||
      typeof ttlSec !== 'number' ||
      !Number.isFinite(ttlSec) ||
      ttlSec <= 0
    ) {
      res.status(400).json({
        error: 'Invalid share: sessionId (non-empty) and ttlSec (>0) required',
        code: 'invalid_share',
      });
      return;
    }

    const scope = body.scope === 'approve' ? 'approve' : 'view';
    const scopes =
      scope === 'approve'
        ? [SHARE, SESSION_READ, APPROVE]
        : [SHARE, SESSION_READ];
    const label = typeof body.label === 'string' ? body.label : 'share';

    const { id, token, expiresAt } = await store.issueShare({
      scopes,
      label,
      sessionLockId: sessionId,
      ttlSec,
      parentId: req.rcClient!.id,
    });
    void audit?.record({
      action: 'share_created',
      actorTokenId: req.rcClient?.id,
      target: id,
      detail: { shareId: id, sessionId, scope, label },
    });
    res.status(201).json({ id, token, url: '/ui/share/' + token, expiresAt });
  });

  // GET / → list share-token metadata (no secret material).
  router.get('/', (_req, res) => {
    res.status(200).json({ shares: store.listShares() });
  });

  // DELETE /:id → revoke a share + evict its live streams (story L3).
  router.delete('/:id', async (req, res) => {
    const id = req.params.id;
    const rec = store.listShares().find((s) => s.id === id);
    if (!rec) {
      res.status(404).json({ error: 'No such share', code: 'share_not_found' });
      return;
    }
    await store.revoke(id);
    registry.evict(id);
    void audit?.record({
      action: 'share_revoked',
      actorTokenId: req.rcClient?.id,
      target: id,
      detail: { shareId: id },
    });
    res.status(204).end();
  });

  return router;
}
