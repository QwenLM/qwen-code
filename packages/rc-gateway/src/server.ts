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
import { bearerResolve, requireScope, enforceSessionLock } from './auth.js';
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
import { createShareRouter } from './routes/share.js';
import { createAuditQueryRoute } from './routes/audit.js';
import { createPushRouter } from './routes/push.js';
import { createRoutingRouter } from './routes/routing.js';
import { createSearchRoute } from './routes/search.js';
import { resolveChatsDir } from './search/transcripts.js';
import { CommandLoader } from './commands/loader.js';
import {
  createListCommandsRoute,
  createInvokeCommandRoute,
} from './routes/commands.js';
import { PushSender } from './webpush/sender.js';
import { PushNotifier } from './webpush/notifier.js';
import type { SnoozeStore } from './routing/snooze.js';
import {
  WorkingDeviceTracker,
  recordActivity,
} from './routing/workingDevice.js';

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
  /** Persisted snooze store. Routing routes + notifier snooze-gating wire only when set. */
  snooze?: SnoozeStore;
  /** Pre-built command loader (test injection). Built from deps when omitted. */
  commandLoader?: CommandLoader;
  /** User-level slash-command root; defaults to ~/.qwen/commands. */
  commandsUserDir?: string;
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
  // Process-local activity tracker: feeds the notifier's working-device
  // suppression and is touched by recordActivity on the human-action POSTs.
  const workingDevice = new WorkingDeviceTracker();

  // Single loader instance: holds the per-process collision-warned set so a
  // workspace>user name collision is audited at most once for the lifetime.
  // Workspace root is the raw capabilities().workspaceCwd (NOT resolveChatsDir).
  const commandLoader =
    deps.commandLoader ??
    new CommandLoader(
      async () => {
        try {
          return (await deps.daemon.capabilities()).workspaceCwd;
        } catch {
          return undefined;
        }
      },
      deps.commandsUserDir ?? join(homedir(), '.qwen', 'commands'),
      audit,
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
    enforceSessionLock(audit),
    createSessionEventsRoute(deps.daemon, registry, audit),
  );
  app.post(
    '/rc/session/:id/permission/:requestId',
    requireScope(APPROVE, audit),
    recordActivity(workingDevice),
    enforceSessionLock(audit),
    createPermissionVoteRoute(deps.daemon, audit),
  );
  app.post(
    '/rc/session/:id/prompt',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    enforceSessionLock(audit),
    createPromptRoute(deps.daemon, audit),
  );
  app.post(
    '/rc/session/:id/command/:name',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    enforceSessionLock(audit),
    createInvokeCommandRoute(deps.daemon, commandLoader, audit),
  );
  app.get(
    '/rc/commands',
    requireScope(SESSION_READ, audit),
    createListCommandsRoute(commandLoader),
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
  app.use(
    '/rc/share',
    requireScope(OWNER, audit),
    createShareRouter(deps.store, registry, audit),
  );
  app.get(
    '/rc/search',
    requireScope(OWNER, audit),
    createSearchRoute(async () => {
      try {
        const caps = await deps.daemon.capabilities();
        return caps.workspaceCwd
          ? resolveChatsDir(caps.workspaceCwd)
          : undefined;
      } catch {
        return undefined;
      }
    }, audit),
  );

  let notifier: PushNotifier | undefined;
  if (deps.vapid && deps.pushStore) {
    const sender = new PushSender(deps.vapid, deps.pushStore, audit);
    notifier = new PushNotifier(
      deps.store,
      deps.pushStore,
      sender,
      deps.snooze,
      audit,
      workingDevice,
    );
    app.use(
      '/rc/push',
      requireScope(SESSION_READ, audit),
      createPushRouter(deps.vapid, deps.pushStore, notifier, audit),
    );
  }

  if (deps.snooze) {
    app.use(
      '/rc/routing',
      requireScope(OWNER, audit),
      createRoutingRouter(deps.snooze, audit),
    );
  }

  return { app, notifier, audit };
}
