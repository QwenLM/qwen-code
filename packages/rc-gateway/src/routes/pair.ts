/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { PairingService } from '../pairing.js';
import type { TokenStore } from '../tokenStore.js';

/** POST /rc/pair/redeem { code, label } → { id, token, scopes }. */
export function createPairRedeemRoute(
  pairing: PairingService,
  store: TokenStore,
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
    const { id, token } = await store.issue(grant.grantScopes, label);
    res.status(200).json({ id, token, scopes: grant.grantScopes });
  };
}
