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
import type { PushNotifier } from '../webpush/notifier.js';
import type { PushPayload } from '../webpush/payload.js';

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
  notifier: PushNotifier,
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
          prefs: r.prefs,
        })),
      });
      return;
    }
    res.json({
      subscriptions: store.listFor(req.rcClient!.id).map((r) => ({
        id: r.id,
        endpoint: r.endpoint,
        createdAt: r.createdAt,
        prefs: r.prefs,
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

  // Set per-subscription notification prefs (kind allowlist). Authorization
  // mirrors DELETE: existence + ownership are checked first (hide existence of
  // another token's subscription from non-owners with a 404, NOT a 403/400),
  // and only then is the body validated. `prefs` must be null/absent (clears to
  // "receive all") OR an array of strings; otherwise 400 invalid_prefs. An
  // empty array is valid and means "receive nothing".
  router.patch('/subscriptions/:id', async (req, res) => {
    const rec = store.get(req.params.id);
    const isOwnerScope = req.rcClient!.scopes.includes(OWNER);
    if (!rec || (rec.tokenId !== req.rcClient!.id && !isOwnerScope)) {
      res.status(404).json({ error: 'Not found', code: 'not_found' });
      return;
    }
    const body = (req.body ?? {}) as { prefs?: unknown };
    const { prefs } = body;
    const isValid =
      prefs === undefined ||
      prefs === null ||
      (Array.isArray(prefs) && prefs.every((p) => typeof p === 'string'));
    if (!isValid) {
      res.status(400).json({ error: 'Invalid prefs', code: 'invalid_prefs' });
      return;
    }
    const next = Array.isArray(prefs) ? (prefs as string[]) : undefined;
    await store.setPrefs(rec.id, next);
    void audit?.record({
      action: 'push_prefs_updated',
      actorTokenId: req.rcClient!.id,
      detail: { subscriptionId: rec.id },
    });
    res.status(200).json({ id: rec.id, prefs: next });
  });

  // Owner-gated self-test: fan a synthetic task.completed out to the caller's
  // own subscriptions. The router is mounted under session:read; owner is
  // required in-handler. `sent` is the number of subscriptions attempted
  // (delivery is async/best-effort, so success is not reflected here).
  router.post('/test', async (req, res) => {
    if (!req.rcClient!.scopes.includes(OWNER)) {
      res
        .status(403)
        .json({ error: 'Insufficient scope', code: 'insufficient_scope' });
      return;
    }
    const body = (req.body ?? {}) as { sessionId?: unknown };
    const sessionId = isNonEmptyString(body.sessionId)
      ? body.sessionId
      : 'test';
    const payload: PushPayload = {
      v: 1,
      kind: 'task.completed',
      sessionId,
      summary: 'Task finished',
      url: '/ui/?session=' + encodeURIComponent(sessionId),
    };
    // Fire-and-forget: delivery is async/best-effort (send() never throws, so
    // this floating promise can never reject). Blocking the response on the
    // retry/backoff sequence would stall it for tens of seconds on a dead sub.
    void notifier.notifyToken(req.rcClient!.id, payload);
    res.status(200).json({ sent: store.listFor(req.rcClient!.id).length });
  });

  return router;
}
