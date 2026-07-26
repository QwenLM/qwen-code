/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router, type RequestHandler } from 'express';
import { OWNER } from '../scopes.js';
import type { AuditRecorder } from '../auditLog.js';
import type { ApnsStore } from '../nativePush/apnsStore.js';

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Defense-in-depth bounds for registration fields BEFORE `deviceToken` is
 * embedded into the outbound APNs HTTP/2 `:path` (apnsSender.ts's
 * `/3/device/<deviceToken>`). APNs device tokens are hex; the classic length
 * is 64 chars (32 bytes) but newer tokens can run longer, so the ceiling here
 * (200) is generous — comfortably above any real token — while still
 * rejecting control characters, path-injection attempts, and absurd lengths
 * from reaching the outbound request line. `bundleId`/`shellVersion` get a
 * reverse-DNS-ish / dotted-version charset and a bounded length for the same
 * reason (they flow into the `apns-topic` header and the stored record).
 */
const DEVICE_TOKEN_RE = /^[0-9a-fA-F]{64,200}$/;
const BUNDLE_ID_MAX = 255;
const BUNDLE_ID_RE = /^[A-Za-z0-9.-]+$/;
const SHELL_VERSION_MAX = 64;
const SHELL_VERSION_RE = /^[A-Za-z0-9._+-]+$/;

function isValidDeviceToken(v: string): boolean {
  return DEVICE_TOKEN_RE.test(v);
}

function isValidBundleId(v: string): boolean {
  return v.length <= BUNDLE_ID_MAX && BUNDLE_ID_RE.test(v);
}

function isValidShellVersion(v: string): boolean {
  return v.length <= SHELL_VERSION_MAX && SHELL_VERSION_RE.test(v);
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
      !isNonEmptyString(body.shellVersion) ||
      !isValidDeviceToken(body.deviceToken) ||
      !isValidBundleId(body.bundleId) ||
      !isValidShellVersion(body.shellVersion)
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

/**
 * GET /.well-known/assetlinks.json (add-native-mobile-shells "Android shell
 * verified TWA"). PUBLIC + unauthenticated (Android fetches it before the TWA
 * launches, with no token). `getLinks()` returns the asset statement array, or
 * `null` when no TWA is configured → 404, on which the shell falls back to a
 * Custom Tab rather than refusing to launch.
 */
export function createAssetLinksRoute(
  getLinks: () => Array<Record<string, unknown>> | null,
): RequestHandler {
  return (_req, res) => {
    const links = getLinks();
    if (!links) {
      res.status(404).json({ error: 'Not found', code: 'not_found' });
      return;
    }
    res.status(200).json(links);
  };
}
