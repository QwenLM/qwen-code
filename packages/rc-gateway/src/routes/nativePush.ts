/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router } from 'express';
import { OWNER } from '../scopes.js';
import type { AuditRecorder } from '../auditLog.js';
import type { ApnsStore } from '../nativePush/apnsStore.js';

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/**
 * APNs registration routes (add-native-mobile-shells "APNs subscription
 * registration"), mounted at /rc/native-push/apns so paths are /register and
 * /register/:id. Any authenticated token may register its own device token;
 * delete is own-or-owner. Audit rows carry only { subscriptionId } — never the
 * raw device token.
 */
export function createNativePushRouter(
  store: ApnsStore,
  audit?: AuditRecorder,
): Router {
  const router = Router();

  router.post('/register', async (req, res) => {
    const body = (req.body ?? {}) as {
      deviceToken?: unknown;
      bundleId?: unknown;
      shellVersion?: unknown;
    };
    if (
      !isNonEmptyString(body.deviceToken) ||
      !isNonEmptyString(body.bundleId) ||
      !isNonEmptyString(body.shellVersion)
    ) {
      res.status(400).json({
        error: 'Invalid registration',
        code: 'invalid_registration',
      });
      return;
    }
    const rec = await store.register({
      tokenId: req.rcClient!.id,
      deviceToken: body.deviceToken,
      bundleId: body.bundleId,
      shellVersion: body.shellVersion,
    });
    void audit?.record({
      action: 'apns_registered',
      actorTokenId: req.rcClient!.id,
      shareId: req.rcClient?.shareId,
      shareLabel: req.rcClient?.shareLabel,
      detail: { subscriptionId: rec.id },
    });
    res.status(201).json({ id: rec.id });
  });

  router.delete('/register/:id', async (req, res) => {
    const rec = store.get(req.params.id);
    const isOwnerScope = req.rcClient!.scopes.includes(OWNER);
    // Hide existence of another token's subscription from non-owners (404).
    if (!rec || (rec.tokenId !== req.rcClient!.id && !isOwnerScope)) {
      res.status(404).json({ error: 'Not found', code: 'not_found' });
      return;
    }
    await store.remove(rec.id);
    void audit?.record({
      action: 'apns_subscription_removed',
      actorTokenId: req.rcClient!.id,
      shareId: req.rcClient?.shareId,
      shareLabel: req.rcClient?.shareLabel,
      detail: { subscriptionId: rec.id, reason: 'deleted' },
    });
    res.status(204).end();
  });

  return router;
}
