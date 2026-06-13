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
import { OWNER, SESSION_READ, APPROVE, WRITE, SHARE } from './scopes.js';
import { ConnectionRegistry } from './connectionRegistry.js';
import { AuditLog, type AuditRecorder } from './auditLog.js';
import { createPairRedeemRoute } from './routes/pair.js';
import { createPermissionVoteRoute } from './routes/permission.js';
import { createPromptRoute } from './routes/prompt.js';
import { createForkRoute } from './routes/fork.js';
import { createLineageRoute } from './routes/lineage.js';
import { createSessionListRoute } from './routes/sessions.js';
import { createSessionEventsRoute } from './routes/sessionEvents.js';
import {
  createListTokensRoute,
  createMintTokenRoute,
  createRevokeTokenRoute,
} from './routes/tokens.js';
import { createShareRouter, createShareWhoamiHandler } from './routes/share.js';
import { createAuditQueryRoute } from './routes/audit.js';
import { createOwnerEventsRoute } from './routes/ownerEvents.js';
import { OwnerEventBus } from './ownerEvents.js';
import { createPushRouter } from './routes/push.js';
import { createRoutingRouter } from './routes/routing.js';
import { createSearchRoute } from './routes/search.js';
import { resolveChatsDir } from './sessions/chatsPath.js';
import { CommandLoader } from './commands/loader.js';
import {
  createListCommandsRoute,
  createInvokeCommandRoute,
} from './routes/commands.js';
import { PushSender } from './webpush/sender.js';
import { PushNotifier } from './webpush/notifier.js';
import { PushRateLimiter } from './webpush/rateLimiter.js';
import { PushCoalescer } from './webpush/coalescer.js';
import { PushDigest } from './webpush/digest.js';
import type { SnoozeStore } from './routing/snooze.js';
import type { RoutingMatcher } from './routing/rules.js';
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
  /** Compiled routing matcher; notifier drop-gating wires only when set. */
  routing?: RoutingMatcher;
  /** Pre-built command loader (test injection). Built from deps when omitted. */
  commandLoader?: CommandLoader;
  /** User-level slash-command root; defaults to ~/.qwen/commands. */
  commandsUserDir?: string;
  /**
   * Same-kind push coalescing window in ms (design D6). Default 0 = DISABLED
   * (the prompt-safety default: coalescing is the one fail-CLOSED gate, so it is
   * opt-in). Falls back to the `QWEN_RC_COALESCE_MS` env when unset.
   */
  coalesceWindowMs?: number;
}

export interface GatewayApp {
  app: Express;
  /** Present only when both `vapid` and `pushStore` deps are supplied. */
  notifier?: PushNotifier;
  /** The gateway's audit log — shared with the policy enforcer at boot. */
  audit: AuditRecorder;
  /**
   * The owner-event bus backing GET /rc/events. Exposed so the boot wiring
   * (cli.ts) can publish gateway-originated frames — e.g. the idle-suggestions
   * handler emitting `idle_suggestions` when a session's active prompt finishes.
   */
  ownerEvents: OwnerEventBus;
}

export function createGatewayApp(deps: GatewayDeps): GatewayApp {
  const app = express();
  app.use(express.json());

  const registry = new ConnectionRegistry();
  // Owner-level event bus (cycle 49): every durably-appended audit record is
  // fanned out to OWNER subscribers of GET /rc/events. Internal to the app — the
  // enforcer/reloader broadcast for free because they share this `audit`
  // instance, so policy_decision/policy_reloaded/policy_reload_failed all stream.
  const ownerEvents = new OwnerEventBus();
  const audit = new AuditLog(
    deps.auditPath ?? join(homedir(), '.qwen', 'rc', 'audit.log'),
    undefined,
    { onRecord: (record) => ownerEvents.publish({ type: 'audit', record }) },
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

  // Guest share landing page. Served for BOTH /ui/share/<token> (first visit)
  // and /ui/share (after the page scrubs the token from the URL, so a reload
  // still resolves the page; the page then reads the token from sessionStorage).
  // Registered BEFORE the fallthrough:false static mount (which would otherwise
  // 404 these paths). It is a DUMB sendFile: the `:token` is never read/logged/
  // validated server-side — GET /rc/share/whoami is the sole auth gate. The
  // error callback is required (no global error middleware → a sendFile error
  // must not hang/throw the request).
  const sharePage = join(webRoot, 'share.html');
  const serveSharePage: express.RequestHandler = (_req, res) => {
    res.sendFile(sharePage, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  };
  app.get('/ui/share', serveSharePage);
  app.get('/ui/share/:token', serveSharePage);

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
    '/rc/session/:id/fork',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    enforceSessionLock(audit),
    createForkRoute(
      deps.daemon,
      async () => {
        try {
          return (await deps.daemon.capabilities()).workspaceCwd;
        } catch {
          return undefined;
        }
      },
      { audit },
    ),
  );
  // Read-only fork lineage chain. OWNER-scoped (NOT session-locked): the chain
  // enumerates ancestor session ids, which a confined share token must not see.
  app.get(
    '/rc/session/:id/lineage',
    requireScope(OWNER, audit),
    createLineageRoute(async () => {
      try {
        return (await deps.daemon.capabilities()).workspaceCwd;
      } catch {
        return undefined;
      }
    }, audit),
  );
  // Flat workspace-wide session list with fork lineage (parentSessionId +
  // derived forks[]). OWNER-scoped like lineage. Scans the on-disk chats dir
  // (NOT the daemon's active-only listWorkspaceSessions) so dormant parents
  // appear in the tree.
  app.get(
    '/rc/sessions',
    requireScope(OWNER, audit),
    createSessionListRoute(async () => {
      try {
        return (await deps.daemon.capabilities()).workspaceCwd;
      } catch {
        return undefined;
      }
    }, audit),
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
  // Live owner-only stream of audit records (incl. policy_decision / reload
  // frames). OWNER-scoped — it surfaces token/scope/session ids across the
  // whole gateway, never for a session-locked guest.
  app.get(
    '/rc/events',
    requireScope(OWNER, audit),
    createOwnerEventsRoute(ownerEvents),
  );
  // Guest redemption endpoint — SHARE-scoped, mounted BEFORE the owner-gated
  // share router so a share token reaches it (the owner router would 403 it).
  app.get(
    '/rc/share/whoami',
    requireScope(SHARE, audit),
    createShareWhoamiHandler(deps.store, audit),
  );
  app.use(
    '/rc/share',
    requireScope(OWNER, audit),
    createShareRouter(deps.store, registry, audit),
  );
  app.get(
    '/rc/search',
    // SESSION_READ at the mount admits both owners and session-locked share
    // tokens; createSearchRoute does the per-caller authorization in-handler
    // (cycle 76): a share is confined to its locked session, everyone else
    // needs OWNER.
    requireScope(SESSION_READ, audit),
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
    // Per-subscription rolling-hour push rate limiter (cycle 46). In-memory:
    // a restart resets the counters (fail-open — never suppress a notification).
    const rateLimiter = new PushRateLimiter();
    // Same-kind coalescing (cycle 63, design D6). DISABLED by default (window 0
    // -> tryPass always true -> no behavior change); an operator opts in via
    // deps.coalesceWindowMs or the QWEN_RC_COALESCE_MS env. Opt-in because it is
    // the one fail-CLOSED gate (it can drop a real second prompt).
    const coalesceWindowMs =
      deps.coalesceWindowMs ?? (Number(process.env.QWEN_RC_COALESCE_MS) || 0);
    const coalescer = new PushCoalescer(coalesceWindowMs);
    // Always-on digest tracker (cycle 71): records what quiet hours suppressed
    // ("while you were away"); record-only, never affects delivery.
    const digest = new PushDigest();
    notifier = new PushNotifier(
      deps.store,
      deps.pushStore,
      sender,
      deps.snooze,
      audit,
      workingDevice,
      deps.routing,
      rateLimiter,
      coalescer,
      digest,
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

  return { app, notifier, audit, ownerEvents };
}
