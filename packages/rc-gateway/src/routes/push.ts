/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router } from 'express';
import { OWNER } from '../scopes.js';
import type { AuditRecorder } from '../auditLog.js';
import type { VapidStore } from '../webpush/vapid.js';
import type { PushStore } from '../pushStore.js';

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Push subscription + VAPID routes, mounted under /rc/push (so paths are
 * /vapid, /subscribe, /subscriptions, /subscriptions/:id). The mount site
 * applies requireScope(SESSION_READ); owner-only operations (?all=true,
 * cross-token delete) are checked here against req.rcClient.scopes.
 *
 * Secrecy: the VAPID private key is never returned. Audit entries carry only
 * { subscriptionId } — never the endpoint or keys.
 */
export function createPushRouter(
  vapid: VapidStore,
  store: PushStore,
  audit?: AuditRecorder,
): Router {
  const router = Router();

  router.get('/vapid', (_req, res) => {
    res.json({ applicationServerKey: vapid.getApplicationServerKey() });
  });

  router.post('/subscribe', async (req, res) => {
    const body = (req.body ?? {}) as {
      subscription?: {
        endpoint?: unknown;
        keys?: { p256dh?: unknown; auth?: unknown };
      };
    };
    const sub = body.subscription;
    if (
      !sub ||
      !isNonEmptyString(sub.endpoint) ||
      !sub.keys ||
      !isNonEmptyString(sub.keys.p256dh) ||
      !isNonEmptyString(sub.keys.auth)
    ) {
      res
        .status(400)
        .json({ error: 'Invalid subscription', code: 'invalid_subscription' });
      return;
    }

    const rec = await store.add(req.rcClient!.id, {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    });
    void audit?.record({
      action: 'push_subscribed',
      actorTokenId: req.rcClient!.id,
      detail: { subscriptionId: rec.id },
    });
    res.status(201).json({ id: rec.id });
  });

  router.get('/subscriptions', (req, res) => {
    if (req.query.all === 'true') {
      if (!req.rcClient!.scopes.includes(OWNER)) {
        res
          .status(403)
          .json({ error: 'Insufficient scope', code: 'insufficient_scope' });
        return;
      }
      res.json({
        subscriptions: store.listAll().map((r) => ({
          id: r.id,
          endpoint: r.endpoint,
          createdAt: r.createdAt,
          tokenId: r.tokenId,
        })),
      });
      return;
    }
    res.json({
      subscriptions: store.listFor(req.rcClient!.id).map((r) => ({
        id: r.id,
        endpoint: r.endpoint,
        createdAt: r.createdAt,
      })),
    });
  });

  router.delete('/subscriptions/:id', async (req, res) => {
    const rec = store.get(req.params.id);
    const isOwnerScope = req.rcClient!.scopes.includes(OWNER);
    // Hide existence of another token's subscription from non-owners (404).
    if (!rec || (rec.tokenId !== req.rcClient!.id && !isOwnerScope)) {
      res.status(404).json({ error: 'Not found', code: 'not_found' });
      return;
    }
    await store.remove(rec.id);
    void audit?.record({
      action: 'push_unsubscribed',
      actorTokenId: req.rcClient!.id,
      detail: { subscriptionId: rec.id },
    });
    res.status(204).end();
  });

  return router;
}
