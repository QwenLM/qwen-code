/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express, { type Express } from 'express';
import type { DaemonClient } from '@qwen-code/sdk';
import type { TokenStore } from './tokenStore.js';
import type { PairingService } from './pairing.js';
import { bearerResolve, requireScope } from './auth.js';
import { SESSION_READ } from './scopes.js';
import { createPairRedeemRoute } from './routes/pair.js';
import { createSessionEventsRoute } from './routes/sessionEvents.js';

export interface GatewayDeps {
  daemon: DaemonClient;
  store: TokenStore;
  pairing: PairingService;
}

export function createGatewayApp(deps: GatewayDeps): Express {
  const app = express();
  app.use(express.json());

  app.get('/rc/health', (_req, res) => res.json({ status: 'ok' }));

  // Pairing redemption is gated by the code itself, not a bearer token.
  app.post('/rc/pair/redeem', createPairRedeemRoute(deps.pairing, deps.store));

  // Everything below requires a resolved client identity.
  app.use(bearerResolve(deps.store));
  app.get(
    '/rc/session/:id/events',
    requireScope(SESSION_READ),
    createSessionEventsRoute(deps.daemon),
  );

  return app;
}
