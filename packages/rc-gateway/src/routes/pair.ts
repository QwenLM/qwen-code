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

/** POST /rc/pair/redeem { code, label } → { id, token, scopes }. */
export function createPairRedeemRoute(
  pairing: PairingService,
  store: TokenStore,
  audit?: AuditRecorder,
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
    res.status(200).json({ id, token, scopes: granted });
  };
}
