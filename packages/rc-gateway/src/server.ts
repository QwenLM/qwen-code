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
import {
  bearerResolve,
  requireScope,
  enforceSessionLock,
  resolveSubActor,
  enforceSubActorRateLimit,
  enforceSubActorBan,
} from './auth.js';
import {
  SubActorRateLimiter,
  DEFAULT_SUB_ACTOR_CAP,
} from './bridges/subActorRateLimiter.js';
import { SubActorBanStore } from './bridges/subActorBans.js';
import {
  OWNER,
  SESSION_READ,
  APPROVE,
  WRITE,
  SHARE,
  BRIDGE,
} from './scopes.js';
import { ConnectionRegistry } from './connectionRegistry.js';
import { AuditLog, type AuditRecorder } from './auditLog.js';
import { createPairRedeemRoute } from './routes/pair.js';
import { createPermissionVoteRoute } from './routes/permission.js';
import { createPromptRoute } from './routes/prompt.js';
import { createForkRoute } from './routes/fork.js';
import {
  createIdleToggleRoute,
  createIdleStatusRoute,
  type IdleStatusResolver,
} from './routes/idleToggle.js';
import { IdleSessionToggles } from './idle/sessionToggles.js';
import {
  createRegisterBridgeRoute,
  createListBridgesRoute,
  createDeregisterBridgeRoute,
  createBanSubActorRoute,
  createLiftBanRoute,
  createListBansRoute,
  createMintInviteRoute,
  createRedeemInviteRoute,
} from './routes/bridges.js';
import { BridgeRegistry } from './bridges/registry.js';
import { InviteStore } from './bridges/inviteStore.js';
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
import { createSearchRoute, type RankedSearch } from './routes/search.js';
import {
  resolveChatsDir,
  resolveSearchIndexDir,
} from './sessions/chatsPath.js';
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
  /**
   * Per-session idle override store (the `/suggest on|off` toggle). The boot
   * wiring (cli.ts) creates it so the idle handler's `getSessionEnabled` and the
   * toggle route share one instance. Defaults to a fresh store when omitted.
   */
  idleToggles?: IdleSessionToggles;
  /**
   * Live idle runtime snapshot for the `/suggest status` route (cli.ts owns the
   * config + rate-limiter). Omitted → status reports `available:false`.
   */
  idleStatus?: IdleStatusResolver;
  /**
   * Per-sub-actor write cap within the limiter's rolling window (bridge
   * fan-in protection). Defaults to {@link DEFAULT_SUB_ACTOR_CAP}. Falls back to
   * `QWEN_RC_SUBACTOR_CAP` when unset.
   */
  subActorCap?: number;
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
  /**
   * Per-session idle-suggestion overrides backing POST
   * /rc/session/:id/idle-suggest-toggle. Exposed so the boot wiring (cli.ts) can
   * feed the idle handler's `getSessionEnabled` from the same store the route
   * writes to.
   */
  idleToggles: IdleSessionToggles;
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
  // Per-session idle-suggestion overrides (the `/suggest on|off` toggle store).
  // Injected by the boot wiring so the idle handler + toggle route share one
  // instance; a fresh store otherwise (tests, idle-less deployments).
  const idleToggles = deps.idleToggles ?? new IdleSessionToggles();
  // In-memory registry of live bridges (add-bridge-protocol). Advisory presence/
  // capability metadata; a gateway restart drops it and bridges re-register.
  const bridgeRegistry = new BridgeRegistry();
  // Per-sub-actor write limiter: caps prompts/votes per asserted chat user so
  // one rude bridge user can't saturate the per-session FIFO. Only bites when a
  // sub-actor is asserted (bridge-mediated); normal clients pass through.
  const subActorLimiter = new SubActorRateLimiter();
  const rawCap = deps.subActorCap ?? Number(process.env.QWEN_RC_SUBACTOR_CAP);
  const subActorCap =
    typeof rawCap === 'number' && Number.isFinite(rawCap) && rawCap > 0
      ? rawCap
      : DEFAULT_SUB_ACTOR_CAP;
  const subActorRateLimit = enforceSubActorRateLimit(
    subActorLimiter,
    subActorCap,
    audit,
  );
  // Owner-managed per-sub-actor bans (block one chat user without revoking the
  // bridge token). In-memory; ban/lift are audited so they survive in the log.
  const subActorBans = new SubActorBanStore();
  const subActorBan = enforceSubActorBan(subActorBans);
  // One-time bridge invite tokens (operator mints; a bridge redeems to learn the
  // session to bind). In-memory + single-use + TTL, like pairing codes; a restart
  // drops unredeemed invites and the operator re-mints.
  const bridgeInvites = new InviteStore();

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
  // Resolve an asserted sub-actor (bridge "acting for @human") onto rcClient —
  // only honored for bridge-scope tokens. Must follow bearerResolve.
  app.use(resolveSubActor());
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
    subActorBan, // banned chat user → 403 (before consuming rate budget)
    subActorRateLimit, // bridge fan-in: cap votes per chat user
    createPermissionVoteRoute(deps.daemon, audit),
  );
  app.post(
    '/rc/session/:id/prompt',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    enforceSessionLock(audit),
    subActorBan, // banned chat user → 403 (before consuming rate budget)
    subActorRateLimit, // bridge fan-in: cap prompts per chat user
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
  // Per-session idle-suggestion toggle (`add-idle-suggestions` spec). WRITE scope
  // + session-lock so a confined share token can only toggle its own session.
  // No recordActivity: setting a preference is not "working on" the session, and
  // marking the device working here would wrongly suppress a real permission push.
  const idleStatusResolver = deps.idleStatus ?? (() => undefined);
  app.post(
    '/rc/session/:id/idle-suggest-toggle',
    requireScope(WRITE, audit),
    enforceSessionLock(audit),
    createIdleToggleRoute(idleToggles, idleStatusResolver, audit),
  );
  // GET the same path reports EFFECTIVE idle state (`/suggest status`). SESSION_READ
  // (a read) + session-lock so a confined share token sees only its own session.
  app.get(
    '/rc/session/:id/idle-suggest-toggle',
    requireScope(SESSION_READ, audit),
    enforceSessionLock(audit),
    createIdleStatusRoute(idleToggles, idleStatusResolver),
  );
  // Bridge registry (add-bridge-protocol). Register/heartbeat is BRIDGE-scope;
  // listing is owner-only; deregister is owner-or-self (authz inside the handler,
  // so the mount only needs an authenticated token).
  app.post(
    '/rc/bridges',
    requireScope(BRIDGE, audit),
    createRegisterBridgeRoute(bridgeRegistry, audit),
  );
  app.get(
    '/rc/bridges',
    requireScope(OWNER, audit),
    createListBridgesRoute(bridgeRegistry),
  );
  app.delete(
    '/rc/bridges/:id',
    requireScope(SESSION_READ, audit),
    createDeregisterBridgeRoute(bridgeRegistry, audit),
  );
  // Bridge invites: the operator mints a one-time invite (OWNER) so a bridge can
  // redeem it (BRIDGE) to learn which session to bind — a chat user never names a
  // session id directly. `/rc/bridges/invites` is a distinct 3-segment path (no
  // collision with the `:id` routes above), and redeem's `:id` is audit context.
  app.post(
    '/rc/bridges/invites',
    requireScope(OWNER, audit),
    createMintInviteRoute(bridgeInvites, audit),
  );
  app.post(
    '/rc/bridges/:id/invite/redeem',
    requireScope(BRIDGE, audit),
    createRedeemInviteRoute(bridgeInvites, audit),
  );
  // Sub-actor bans (owner-only): ban/lift one chat user; list current bans.
  app.get(
    '/rc/bridges/bans',
    requireScope(OWNER, audit),
    createListBansRoute(subActorBans),
  );
  app.post(
    '/rc/bridges/:id/ban',
    requireScope(OWNER, audit),
    createBanSubActorRoute(subActorBans, audit),
  );
  app.delete(
    '/rc/bridges/:id/ban/:subActor',
    requireScope(OWNER, audit),
    createLiftBanRoute(subActorBans, audit),
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
  // BM25 ranked search provider (search slice 2) — opt-in `?rank=bm25`. The
  // native better-sqlite3 is loaded LAZILY via a dynamic import the FIRST time a
  // ranked query arrives (memoized), so the gateway's static graph never pulls
  // it in and a fresh install / failed native build still boots and serves the
  // scanner. Returns null (→ route falls back to the live scan) when the dep is
  // absent, there is no workspace, the index is empty/never-built, or any error
  // occurs — ranked search is strictly best-effort enrichment over the scan.
  let searchIndexMod:
    | typeof import('./search/searchIndex.js')
    | null
    | undefined;
  const rankedSearch: RankedSearch = async (q, qopts) => {
    let workspaceCwd: string | undefined;
    try {
      workspaceCwd = (await deps.daemon.capabilities()).workspaceCwd;
    } catch {
      return null;
    }
    if (!workspaceCwd) return null;
    if (searchIndexMod === undefined) {
      try {
        searchIndexMod = await import('./search/searchIndex.js');
      } catch {
        // Native dep absent / load failed → permanently fall back to the scan.
        searchIndexMod = null;
      }
    }
    if (!searchIndexMod) return null;
    const dbPath = join(resolveSearchIndexDir(workspaceCwd), 'index.db');
    let idx: ReturnType<typeof searchIndexMod.SearchIndex.open> | undefined;
    try {
      idx = searchIndexMod.SearchIndex.open(dbPath);
      // A never-built (empty) index must not silently return zero hits when the
      // scan would find matches — fall back instead.
      if (idx.count() === 0) return null;
      return idx.query(q, qopts);
    } catch {
      return null;
    } finally {
      try {
        idx?.close();
      } catch {
        /* best-effort */
      }
    }
  };

  app.get(
    '/rc/search',
    // SESSION_READ at the mount admits both owners and session-locked share
    // tokens; createSearchRoute does the per-caller authorization in-handler
    // (cycle 76): a share is confined to its locked session, everyone else
    // needs OWNER.
    requireScope(SESSION_READ, audit),
    createSearchRoute(
      async () => {
        try {
          const caps = await deps.daemon.capabilities();
          return caps.workspaceCwd
            ? resolveChatsDir(caps.workspaceCwd)
            : undefined;
        } catch {
          return undefined;
        }
      },
      audit,
      { ranked: rankedSearch },
    ),
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

  return { app, notifier, audit, ownerEvents, idleToggles };
}
