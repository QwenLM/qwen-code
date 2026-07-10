/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CORS allowlist CRUD endpoints (wire-protocol: "Browser CORS allowlist
 * derived from pairing").
 *
 *   GET    /rc/cors         — list all admitted origins (owner)
 *   POST   /rc/cors         — manually admit an origin (owner)
 *   DELETE /rc/cors/:origin — remove an admitted origin (owner; 409 for config)
 */

import type { RequestHandler } from 'express';
import type { TokenStore } from '../tokenStore.js';
import type { AuditRecorder } from '../auditLog.js';
import type { CorsAllowlist } from '../cors.js';
import { isValidAdmissibleOrigin } from '../cors.js';

export interface CorsRouteDeps {
  store: TokenStore;
  allowlist: CorsAllowlist;
  audit?: AuditRecorder;
  /** Config-sourced origins (read-only; DELETE returns 409). */
  configOrigins?: readonly string[];
}

/**
 * GET /rc/cors — list all admitted origins.
 * Returns `{ origins: CorsOriginRecord[] }`.
 */
export function createListCorsOriginsRoute(
  deps: CorsRouteDeps,
): RequestHandler {
  return (_req, res) => {
    const origins = deps.store.listOrigins(deps.configOrigins ?? []);
    res.json({ origins });
  };
}

/**
 * POST /rc/cors { origin } — manually admit an origin to the allowlist.
 * 400 when the origin is missing/invalid; 200 with the record on success.
 */
export function createAddCorsOriginRoute(deps: CorsRouteDeps): RequestHandler {
  return async (req, res) => {
    const body = (req.body ?? {}) as { origin?: unknown };
    const origin =
      typeof body.origin === 'string' ? body.origin.trim() : undefined;

    if (!origin || !isValidAdmissibleOrigin(origin)) {
      res.status(400).json({
        error:
          'origin must be a valid admissible RFC 6454 origin (https or http-loopback)',
        code: 'invalid_origin',
      });
      return;
    }

    const actorTokenId = req.rcClient?.id;
    const record = await deps.store.admitOrigin(
      origin,
      actorTokenId ?? 'owner',
    );
    deps.allowlist.add(origin);
    void deps.audit?.record({
      action: 'cors_origin_admitted',
      actorTokenId,
      detail: { origin, via: 'owner_api' },
    });
    res.status(200).json({ origin: record });
  };
}

/**
 * DELETE /rc/cors/:origin — remove an admitted origin.
 * 404 when origin is not in the store; 409 when it is config-sourced.
 */
export function createRemoveCorsOriginRoute(
  deps: CorsRouteDeps,
): RequestHandler {
  return async (req, res) => {
    // The origin arrives percent-encoded in the URL segment; decode it.
    const origin = decodeURIComponent(req.params['origin'] ?? '');
    if (!origin) {
      res
        .status(400)
        .json({ error: 'origin required', code: 'invalid_origin' });
      return;
    }

    const result = await deps.store.removeOrigin(
      origin,
      deps.configOrigins ?? [],
    );

    if ('notFound' in result) {
      res
        .status(404)
        .json({ error: 'Origin not found', code: 'origin_not_found' });
      return;
    }
    if ('conflict' in result) {
      res.status(409).json({
        error: 'Origin is config-sourced and cannot be removed via the API',
        code: 'origin_config_sourced',
      });
      return;
    }

    // { removed: true }
    deps.allowlist.remove(origin);
    void deps.audit?.record({
      action: 'cors_origin_removed',
      actorTokenId: req.rcClient?.id,
      detail: { origin },
    });
    res.status(200).json({ removed: true, origin });
  };
}
