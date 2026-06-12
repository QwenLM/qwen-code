/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router } from 'express';
import { OWNER } from '../scopes.js';
import { parseTimeOfDay } from '../policy/conditions.js';
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
      shareId: req.rcClient?.shareId,
      shareLabel: req.rcClient?.shareLabel,
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
          quietHours: r.quietHours,
          maxPerHour: r.maxPerHour,
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
        quietHours: r.quietHours,
        maxPerHour: r.maxPerHour,
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
    // Free the subscription's in-memory rate-limit window so stale counters
    // don't accumulate as subscriptions churn (no-op without a limiter).
    notifier.forgetRateLimit(rec.id);
    void audit?.record({
      action: 'push_unsubscribed',
      actorTokenId: req.rcClient!.id,
      shareId: req.rcClient?.shareId,
      shareLabel: req.rcClient?.shareLabel,
      detail: { subscriptionId: rec.id },
    });
    res.status(204).end();
  });

  // Set per-subscription delivery preferences: `prefs` (kind allowlist) and/or
  // `quietHours` (a `{from, to, timezone}` window). Authorization mirrors
  // DELETE: existence + ownership are checked first (hide existence of another
  // token's subscription from non-owners with a 404, NOT a 403/400), and only
  // then is the body validated. Fields update INDEPENDENTLY — each is applied
  // only when its key is present in the body: a `null` value clears it, a
  // value sets it, an absent key leaves it unchanged (so a PATCH that sets
  // only `quietHours` does not wipe `prefs`). `prefs`: array of strings (empty
  // = "receive nothing") or null (clear → receive all), else 400 invalid_prefs.
  // `quietHours`: a parseable `{from, to, timezone}` (validated by the shared
  // policy `parseTimeOfDay`) or null (clear), else 400 invalid_quiet_hours.
  router.patch('/subscriptions/:id', async (req, res) => {
    const rec = store.get(req.params.id);
    const isOwnerScope = req.rcClient!.scopes.includes(OWNER);
    if (!rec || (rec.tokenId !== req.rcClient!.id && !isOwnerScope)) {
      res.status(404).json({ error: 'Not found', code: 'not_found' });
      return;
    }
    // persist() (writeFile) can reject on EACCES/ENOSPC; server.ts has no
    // global error middleware, so an uncaught rejection would hang the request
    // (the recurring async-route-error bug class). Catch → 500.
    try {
      const body = (req.body ?? {}) as {
        prefs?: unknown;
        quietHours?: unknown;
        maxPerHour?: unknown;
      };

      // Validate BOTH fields up front, then apply — the request is
      // all-or-nothing. A mixed PATCH whose second field is malformed must NOT
      // have already persisted the first field (a partial commit could
      // silently narrow prefs while returning 400 → a missed-prompt-class
      // false suppression the user never knowingly committed).
      let applyPrefs = false;
      let nextPrefs: string[] | undefined;
      if ('prefs' in body) {
        const { prefs } = body;
        const isValid =
          prefs === null ||
          (Array.isArray(prefs) && prefs.every((p) => typeof p === 'string'));
        if (!isValid) {
          res
            .status(400)
            .json({ error: 'Invalid prefs', code: 'invalid_prefs' });
          return;
        }
        nextPrefs = Array.isArray(prefs) ? (prefs as string[]) : undefined;
        applyPrefs = true;
      }

      let applyQuiet = false;
      let nextQuiet: { from: string; to: string; timezone: string } | undefined;
      if ('quietHours' in body) {
        const { quietHours } = body;
        if (quietHours !== null) {
          const parsed = parseTimeOfDay(quietHours);
          if (!parsed) {
            res.status(400).json({
              error: 'Invalid quiet hours',
              code: 'invalid_quiet_hours',
            });
            return;
          }
          const qh = quietHours as {
            from: string;
            to: string;
            timezone: string;
          };
          nextQuiet = { from: qh.from, to: qh.to, timezone: qh.timezone };
        }
        applyQuiet = true;
      }

      // maxPerHour: an integer in [1, 240] (cycle 46) or null (clear → the
      // notifier's default cap). Validated up front with the others so a bad
      // value can't partially apply a sibling field.
      let applyMax = false;
      let nextMax: number | undefined;
      if ('maxPerHour' in body) {
        const { maxPerHour } = body;
        if (maxPerHour !== null) {
          if (
            typeof maxPerHour !== 'number' ||
            !Number.isInteger(maxPerHour) ||
            maxPerHour < 1 ||
            maxPerHour > 240
          ) {
            res.status(400).json({
              error: 'Invalid maxPerHour',
              code: 'invalid_max_per_hour',
            });
            return;
          }
          nextMax = maxPerHour;
        }
        applyMax = true;
      }

      if (applyPrefs) await store.setPrefs(rec.id, nextPrefs);
      if (applyQuiet) await store.setQuietHours(rec.id, nextQuiet);
      if (applyMax) await store.setMaxPerHour(rec.id, nextMax);

      if (applyPrefs || applyQuiet || applyMax) {
        void audit?.record({
          action: 'push_prefs_updated',
          actorTokenId: req.rcClient!.id,
          shareId: req.rcClient?.shareId,
          shareLabel: req.rcClient?.shareLabel,
          detail: { subscriptionId: rec.id },
        });
      }
      // Reflect the current record state (post-update).
      const fresh = store.get(rec.id)!;
      res.status(200).json({
        id: rec.id,
        prefs: fresh.prefs,
        quietHours: fresh.quietHours,
        maxPerHour: fresh.maxPerHour,
      });
    } catch {
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal error', code: 'internal' });
      }
    }
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

  // GET /digest — owner-only summary of pushes suppressed during quiet hours
  // ("what you missed while away", the read half of design D4). The router is
  // mounted under session:read; owner is required in-handler (mirrors the
  // ?all=true subscriptions path). Counts/ids/kind only — no secret material.
  router.get('/digest', (req, res) => {
    if (!req.rcClient!.scopes.includes(OWNER)) {
      res
        .status(403)
        .json({ error: 'Insufficient scope', code: 'insufficient_scope' });
      return;
    }
    res.status(200).json({ digests: notifier.digestSummary() });
  });

  return router;
}
