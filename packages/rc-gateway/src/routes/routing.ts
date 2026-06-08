/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router } from 'express';
import type { AuditRecorder } from '../auditLog.js';
import type { SnoozeStore } from '../routing/snooze.js';

/**
 * Notification-routing routes, mounted under /rc/routing (so paths are
 * /snooze). Owner-gating is applied by the mount site (requireScope(OWNER)),
 * so no in-handler scope check is needed.
 */
export function createRoutingRouter(
  snooze: SnoozeStore,
  audit?: AuditRecorder,
): Router {
  const router = Router();

  router.post('/snooze', async (req, res) => {
    const body = (req.body ?? {}) as { durationSec?: unknown; scope?: unknown };
    const durationSec = body.durationSec;
    if (
      typeof durationSec !== 'number' ||
      !Number.isFinite(durationSec) ||
      durationSec <= 0
    ) {
      res.status(400).json({ error: 'Invalid snooze', code: 'invalid_snooze' });
      return;
    }
    const scope =
      typeof body.scope === 'string' && body.scope.length > 0
        ? body.scope
        : 'all';
    const state = await snooze.snooze(durationSec, scope);
    void audit?.record({
      action: 'routing_snoozed',
      actorTokenId: req.rcClient?.id,
      detail: { scope, durationSec },
    });
    res.status(200).json({ until: state.until, scope: state.scope });
  });

  router.get('/snooze', (_req, res) => {
    const s = snooze.active();
    if (s) {
      res.json({ active: true, until: s.until, scope: s.scope });
    } else {
      res.json({ active: false });
    }
  });

  router.delete('/snooze', async (req, res) => {
    await snooze.clear();
    void audit?.record({
      action: 'routing_unsnoozed',
      actorTokenId: req.rcClient?.id,
    });
    res.status(204).end();
  });

  return router;
}
