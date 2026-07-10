/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { PairingService } from '../pairing.js';
import type { TokenStore } from '../tokenStore.js';
import type { AuditRecorder } from '../auditLog.js';
import { expandScopes } from '../scopes.js';
import { evaluateAdmission, type CorsAllowlist } from '../cors.js';

export interface PairRedeemCorsOpts {
  /** The gateway's own UI origin (used as an unconditional admission bypass). */
  ownUiOrigin: string;
  /** Live allowlist to update on successful admission. */
  allowlist: CorsAllowlist;
}

/** POST /rc/pair/redeem { code, label } → { id, token, scopes }. */
export function createPairRedeemRoute(
  pairing: PairingService,
  store: TokenStore,
  audit?: AuditRecorder,
  corsOpts?: PairRedeemCorsOpts,
): RequestHandler {
  return async (req, res) => {
    const body = (req.body ?? {}) as { code?: unknown; label?: unknown };
    const code = typeof body.code === 'string' ? body.code : '';
    const label = typeof body.label === 'string' ? body.label : 'unnamed';
    const grant = pairing.redeem(code);
    if (!grant) {
      res
        .status(400)
        .json({ error: 'Invalid pairing code', code: 'invalid_pairing_code' });
      return;
    }
    // Materialize the concrete bundle so a (future) bridge-scope pairing code
    // yields a token with session:read+approve+write too. A no-op for codes
    // without `bridge` (e.g. the boot owner code).
    const granted = expandScopes(grant.grantScopes);
    const { id, token } = await store.issue(granted, label);
    void audit?.record({
      action: 'pairing_redeemed',
      target: id,
      detail: { scopes: granted },
    });

    // CORS admission gate (wire-protocol: "Browser CORS allowlist derived from
    // pairing").  Failure is silent: the token is still issued.
    if (corsOpts) {
      const origin = req.headers['origin'] as string | undefined;
      const secFetchSite = req.headers['sec-fetch-site'] as string | undefined;
      const decision = evaluateAdmission({
        origin,
        secFetchSite,
        codeAllowOrigin: grant.allowOrigin,
        ownUiOrigin: corsOpts.ownUiOrigin,
      });
      if (decision.admit && origin) {
        await store.admitOrigin(origin, id);
        corsOpts.allowlist.add(origin);
        void audit?.record({
          action: 'cors_origin_admitted',
          target: id,
          detail: { origin, reason: decision.reason },
        });
      }
    }

    res.status(200).json({ id, token, scopes: granted });
  };
}
