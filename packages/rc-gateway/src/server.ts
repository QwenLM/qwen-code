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
import { OWNER, SESSION_READ } from './scopes.js';
import { ConnectionRegistry } from './connectionRegistry.js';
import { createPairRedeemRoute } from './routes/pair.js';
import { createSessionEventsRoute } from './routes/sessionEvents.js';
import {
  createListTokensRoute,
  createMintTokenRoute,
  createRevokeTokenRoute,
} from './routes/tokens.js';

export interface GatewayDeps {
  daemon: DaemonClient;
  store: TokenStore;
  pairing: PairingService;
}

export function createGatewayApp(deps: GatewayDeps): Express {
  const app = express();
  app.use(express.json());

  // One registry shared by the SSE route (registers streams) and the revoke
  // route (evicts them).
  const registry = new ConnectionRegistry();

  app.get('/rc/health', (_req, res) => res.json({ status: 'ok' }));

  app.post('/rc/pair/redeem', createPairRedeemRoute(deps.pairing, deps.store));

  app.use(bearerResolve(deps.store));
  app.get(
    '/rc/session/:id/events',
    requireScope(SESSION_READ),
    createSessionEventsRoute(deps.daemon, registry),
  );
  app.get('/rc/tokens', requireScope(OWNER), createListTokensRoute(deps.store));
  app.post('/rc/tokens', requireScope(OWNER), createMintTokenRoute(deps.store));
  app.delete(
    '/rc/tokens/:id',
    requireScope(OWNER),
    createRevokeTokenRoute(deps.store, registry),
  );

  return app;
}
