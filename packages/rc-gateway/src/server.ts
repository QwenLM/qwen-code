/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import type { DaemonClient } from '@qwen-code/sdk';
import type { TokenStore } from './tokenStore.js';
import type { PairingService } from './pairing.js';
import type { VapidStore } from './webpush/vapid.js';
import type { PushStore } from './pushStore.js';
import { bearerResolve, requireScope } from './auth.js';
import { OWNER, SESSION_READ, APPROVE, WRITE } from './scopes.js';
import { ConnectionRegistry } from './connectionRegistry.js';
import { AuditLog, type AuditRecorder } from './auditLog.js';
import { createPairRedeemRoute } from './routes/pair.js';
import { createPermissionVoteRoute } from './routes/permission.js';
import { createPromptRoute } from './routes/prompt.js';
import { createSessionEventsRoute } from './routes/sessionEvents.js';
import {
  createListTokensRoute,
  createMintTokenRoute,
  createRevokeTokenRoute,
} from './routes/tokens.js';
import { createAuditQueryRoute } from './routes/audit.js';
import { createPushRouter } from './routes/push.js';
import { PushSender } from './webpush/sender.js';
import { PushNotifier } from './webpush/notifier.js';

export interface GatewayDeps {
  daemon: DaemonClient;
  store: TokenStore;
  pairing: PairingService;
  /** Audit log path; defaults to ~/.qwen/rc/audit.log. */
  auditPath?: string;
  /** Static web-client root; defaults to the package's public/ dir. */
  webRoot?: string;
  /** Gateway-owned VAPID keypair. Push routes mount only when both this and pushStore are set. */
  vapid?: VapidStore;
  /** Token-bound push subscription store. Push routes mount only when both this and vapid are set. */
  pushStore?: PushStore;
}

export interface GatewayApp {
  app: Express;
  /** Present only when both `vapid` and `pushStore` deps are supplied. */
  notifier?: PushNotifier;
  /** The gateway's audit log — shared with the policy enforcer at boot. */
  audit: AuditRecorder;
}

export function createGatewayApp(deps: GatewayDeps): GatewayApp {
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

  const webRoot =
    deps.webRoot ?? fileURLToPath(new URL('../public', import.meta.url));
  app.use('/ui', express.static(webRoot, { fallthrough: false }));

  app.use(bearerResolve(deps.store, audit));
  app.get(
    '/rc/session/:id/events',
    requireScope(SESSION_READ, audit),
    createSessionEventsRoute(deps.daemon, registry, audit),
  );
  app.post(
    '/rc/session/:id/permission/:requestId',
    requireScope(APPROVE, audit),
    createPermissionVoteRoute(deps.daemon, audit),
  );
  app.post(
    '/rc/session/:id/prompt',
    requireScope(WRITE, audit),
    createPromptRoute(deps.daemon, audit),
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

  let notifier: PushNotifier | undefined;
  if (deps.vapid && deps.pushStore) {
    const sender = new PushSender(deps.vapid, deps.pushStore, audit);
    notifier = new PushNotifier(deps.store, deps.pushStore, sender);
    app.use(
      '/rc/push',
      requireScope(SESSION_READ, audit),
      createPushRouter(deps.vapid, deps.pushStore, notifier, audit),
    );
  }

  return { app, notifier, audit };
}
