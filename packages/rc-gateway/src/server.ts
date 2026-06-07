/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import type { DaemonClient } from '@qwen-code/sdk';
import type { TokenStore } from './tokenStore.js';
import type { PairingService } from './pairing.js';
import { bearerResolve, requireScope } from './auth.js';
import { OWNER, SESSION_READ } from './scopes.js';
import { ConnectionRegistry } from './connectionRegistry.js';
import { AuditLog } from './auditLog.js';
import { createPairRedeemRoute } from './routes/pair.js';
import { createSessionEventsRoute } from './routes/sessionEvents.js';
import {
  createListTokensRoute,
  createMintTokenRoute,
  createRevokeTokenRoute,
} from './routes/tokens.js';
import { createAuditQueryRoute } from './routes/audit.js';

export interface GatewayDeps {
  daemon: DaemonClient;
  store: TokenStore;
  pairing: PairingService;
  /** Audit log path; defaults to ~/.qwen/rc/audit.log. */
  auditPath?: string;
}

export function createGatewayApp(deps: GatewayDeps): Express {
  const app = express();
  app.use(express.json());

  const registry = new ConnectionRegistry();
  const audit = new AuditLog(
    deps.auditPath ?? join(homedir(), '.qwen', 'rc', 'audit.log'),
  );

  app.get('/rc/health', (_req, res) => res.json({ status: 'ok' }));

  app.post(
    '/rc/pair/redeem',
    createPairRedeemRoute(deps.pairing, deps.store, audit),
  );

  app.use(bearerResolve(deps.store, audit));
  app.get(
    '/rc/session/:id/events',
    requireScope(SESSION_READ, audit),
    createSessionEventsRoute(deps.daemon, registry, audit),
  );
  app.get(
    '/rc/tokens',
    requireScope(OWNER, audit),
    createListTokensRoute(deps.store),
  );
  app.post(
    '/rc/tokens',
    requireScope(OWNER, audit),
    createMintTokenRoute(deps.store, audit),
  );
  app.delete(
    '/rc/tokens/:id',
    requireScope(OWNER, audit),
    createRevokeTokenRoute(deps.store, registry, audit),
  );
  app.get(
    '/rc/audit',
    requireScope(OWNER, audit),
    createAuditQueryRoute(audit),
  );

  return app;
}
