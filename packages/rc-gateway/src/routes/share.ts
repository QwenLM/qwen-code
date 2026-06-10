/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router } from 'express';
import type { RequestHandler } from 'express';
import type { TokenStore } from '../tokenStore.js';
import type { ConnectionRegistry } from '../connectionRegistry.js';
import { SHARE, SESSION_READ, APPROVE } from '../scopes.js';
import type { AuditRecorder } from '../auditLog.js';

/** Lower/upper bound on a share's redemption count (design table). */
const MAX_USES_MIN = 1;
const MAX_USES_MAX = 100;

/** Coerce a request `maxUses` to a clamped integer, or undefined (unlimited). */
function clampMaxUses(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return Math.min(MAX_USES_MAX, Math.max(MAX_USES_MIN, Math.floor(v)));
}

/** Bounds on a share's lifetime: 5 minutes … 30 days (design threat table). */
const TTL_MIN = 300;
const TTL_MAX = 2592000;

/**
 * Clamp an already-validated (finite, `> 0`) `ttlSec` into `[TTL_MIN, TTL_MAX]`.
 * Capping the max is the safe direction (the share expires earlier than an
 * over-asking caller imagined) and is transparent (the response's `expiresAt`
 * reflects the effective value). The 5-minute floor is a usability guard.
 */
function clampTtlSec(v: number): number {
  return Math.min(TTL_MAX, Math.max(TTL_MIN, Math.floor(v)));
}

/** True when the raw `Cookie` header carries a cookie named `name`. */
function hasCookie(header: string | undefined, name: string): boolean {
  if (!header) return false;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return true;
  }
  return false;
}

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
      maxUses?: unknown;
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
    const maxUses = clampMaxUses(body.maxUses);
    const effectiveTtl = clampTtlSec(ttlSec);

    const { id, token, expiresAt } = await store.issueShare({
      scopes,
      label,
      sessionLockId: sessionId,
      ttlSec: effectiveTtl,
      parentId: req.rcClient!.id,
      maxUses,
    });
    void audit?.record({
      action: 'share_created',
      actorTokenId: req.rcClient?.id,
      target: id,
      shareId: id,
      shareLabel: label,
      detail: {
        shareId: id,
        sessionId,
        scope,
        label,
        maxUses,
        ttlSec: effectiveTtl,
      },
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
      shareId: id,
      shareLabel: rec.label,
      detail: { shareId: id },
    });
    res.status(204).end();
  });

  return router;
}

/**
 * Guest-facing share redemption endpoint (`GET /rc/share/whoami`). Mount behind
 * `requireScope(SHARE)` and BEFORE the owner-gated share router. Returns the
 * watermark/bootstrap metadata for the share token in `req.rcClient` and, on the
 * first redemption of a browser session, consumes one use.
 *
 * A use is counted once per browser session, deduped by an httpOnly
 * `rc_share_<id>` cookie — so an SSE reconnect or a tab refresh does NOT burn a
 * use. Because consumption lives here (an authenticated XHR) and never in
 * `resolve()`, a link-unfurl/prefetch of the public bootstrap URL cannot consume
 * a use, and an already-redeemed session keeps working until TTL/revoke even
 * after the share is exhausted. `maxUses` is thus a soft browser-session cap;
 * TTL + revoke are the hard bounds.
 */
export function createShareWhoamiHandler(
  store: TokenStore,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    try {
      const id = req.rcClient!.id;
      const info = store.listShares().find((s) => s.id === id);
      if (!info) {
        // A SHARE-scoped token with no share record is not expected; defensive.
        res
          .status(404)
          .json({ error: 'No such share', code: 'share_not_found' });
        return;
      }

      const meta = (usesRemaining: number | null) => ({
        sessionId: info.sessionLockId,
        scope: info.scopes.includes(APPROVE) ? 'approve' : 'view',
        label: info.label,
        expiresAt: info.expiresAt,
        usesRemaining,
      });

      const cookieName = 'rc_share_' + id;
      if (hasCookie(req.headers.cookie, cookieName)) {
        // Already redeemed this browser session — return metadata, no bump.
        res.status(200).json(meta(info.usesRemaining));
        return;
      }

      const result = await store.consumeUse(id);
      if (!result.ok) {
        if (result.reason === 'exhausted') {
          void audit?.record({
            action: 'share_exhausted',
            actorTokenId: id,
            target: id,
            shareId: id,
            shareLabel: info.label,
            detail: { shareId: id },
          });
          res
            .status(410)
            .json({ error: 'Share exhausted', code: 'share_exhausted' });
          return;
        }
        res
          .status(404)
          .json({ error: 'No such share', code: 'share_not_found' });
        return;
      }

      // Mark this browser session redeemed so a refresh does not re-bump.
      const maxAgeMs =
        info.expiresAt !== undefined
          ? Math.max(0, info.expiresAt - Date.now())
          : undefined;
      res.cookie(cookieName, '1', {
        httpOnly: true,
        sameSite: 'strict',
        ...(maxAgeMs !== undefined ? { maxAge: maxAgeMs } : {}),
      });
      void audit?.record({
        action: 'share_redeemed',
        actorTokenId: id,
        target: id,
        shareId: id,
        shareLabel: info.label,
        detail: { shareId: id, usesRemaining: result.usesRemaining },
      });
      res.status(200).json(meta(result.usesRemaining));
    } catch {
      if (!res.headersSent) {
        res
          .status(500)
          .json({ error: 'Internal error', code: 'internal_error' });
      }
    }
  };
}
