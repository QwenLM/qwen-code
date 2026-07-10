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
import {
  createListCorsOriginsRoute,
  createAddCorsOriginRoute,
  createRemoveCorsOriginRoute,
} from './routes/cors.js';
import type { CorsAllowlist } from './cors.js';
import {
  allowlistFromRecords,
  evaluatePreflight,
  corsHeadersForActualRequest,
} from './cors.js';
import { createPermissionVoteRoute } from './routes/permission.js';
import { createPromptRoute, type PromptAcceptedHook } from './routes/prompt.js';
import { createUsageRoute, type UsageReader } from './routes/usage.js';
import { createCapabilityRoute } from './routes/capabilities.js';
import { createClientsManifestRoute } from './routes/clientsManifest.js';
import {
  createNativePushRouter,
  createAssetLinksRoute,
} from './routes/nativePush.js';
import type { ApnsStore } from './nativePush/apnsStore.js';
import {
  ApnsSender,
  createHttp2ApnsTransport,
  type ApnsTransport,
} from './nativePush/apnsSender.js';
import type { NativeShellsCapability } from './nativePush/nativeShells.js';
import type { AggregateQuery } from './cost/usageStore.js';
import type { UsageTickBroadcaster } from './cost/usageTickBroadcaster.js';
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
  createHeartbeatRoute,
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
import { versionCheckMiddleware } from './middleware/versionCheck.js';
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
  /**
   * Cost tracking (`add-cost-tracking`). When `usageReader` is set, `GET /rc/usage`
   * mounts; `onPromptAccepted` (when set) captures per-session attribution on each
   * accepted prompt. Both omitted → cost tracking disabled (native sqlite absent
   * or operator opt-out). `usageLabelFor` maps an aggregate key to a display label.
   */
  usageReader?: UsageReader;
  usageLabelFor?: (groupBy: AggregateQuery['groupBy'], key: string) => string;
  onPromptAccepted?: PromptAcceptedHook;
  /** Per-session usage_tick fan-out; the events relay registers per subscriber. */
  usageBroadcaster?: UsageTickBroadcaster;
  /** Live currency label for the cost-tracking capability block. */
  costCurrencyLabel?: () => string;
  /**
   * mDNS advertising state for the capability surface (`add-mdns-discovery`).
   * When set, `/rc/capabilities` reports `remoteControl.mdns`. Omitted → the
   * mdns block is absent (e.g. discovery feature not wired).
   */
  mdnsStatus?: () => { advertising: boolean; instanceName?: string };
  /**
   * Read `~/.qwen/rc/clients.toml` for the owner-only multi-workspace registry
   * (`add-multi-workspace-client`). Resolve `null` on ENOENT, reject on other
   * errors. When set, `GET /ui/clients-manifest.json` mounts.
   */
  clientsManifestReadToml?: () => Promise<string | null>;
  /**
   * APNs device-token subscriptions for the iOS native shell
   * (`add-native-mobile-shells`). When set, `/rc/native-push/apns/*` mounts and
   * token revocation cascade-deletes the token's subscriptions.
   */
  apnsStore?: ApnsStore;
  /**
   * APNs delivery materials (`add-native-mobile-shells` delivery pipeline). When
   * set alongside `apnsStore` and the notifier, push notifications also fan out
   * to APNs devices. The signer/bundle/host are built by the host (cli) from the
   * config + P-8 key; the gateway builds the `ApnsSender` here so it can wire its
   * own audit log and the live-token orphan guard (`isTokenLive`). `transport` is
   * injectable for tests (defaults to the real HTTP/2 transport to Apple).
   */
  apns?: {
    signer: { token(): string };
    bundleId: string;
    host: string;
    transport?: ApnsTransport;
  };
  /**
   * `remoteControl.nativeShells` capability block (`add-native-mobile-shells`).
   * When set, `/rc/capabilities` reports it (`apnsEnabled` reflects a loadable
   * P-8 key + complete config, resolved live by the caller).
   */
  nativeShellsCapability?: () => NativeShellsCapability;
  /**
   * Android TWA Digital Asset Links statement, or `null` when no TWA is
   * configured. When set, the PUBLIC `GET /.well-known/assetlinks.json` mounts;
   * `null` → 404 (the shell falls back to a Custom Tab).
   */
  assetLinks?: () => Array<Record<string, unknown>> | null;
  /**
   * Owner-configured CORS origins (read-only; sourced from config file, not
   * the store).  These are merged at load into the allowlist as `source:
   * 'config'` entries and cannot be deleted via the API (409).
   */
  corsConfigOrigins?: readonly string[];
  /**
   * The gateway's own UI origin, used as the unconditional CORS admission
   * bypass at redemption.  Format: `scheme://host[:port]` (RFC 6454 serialized
   * origin).  When omitted, the admisssion gate still runs but the
   * "own-UI-origin bypass" never fires.
   */
  ownUiOrigin?: string;
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
   * /session/:id/idle-suggest-toggle. Exposed so the boot wiring (cli.ts) can
   * feed the idle handler's `getSessionEnabled` from the same store the route
   * writes to.
   */
  idleToggles: IdleSessionToggles;
  /**
   * The live-bridge registry. Exposed so the boot wiring (cli.ts) can run the
   * staleness reaper on an interval (auto-deregister bridges that stopped
   * heartbeating) — kept out of createGatewayApp so no background timer leaks in
   * tests that construct the app directly.
   */
  bridgeRegistry: BridgeRegistry;
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

  // ---------------------------------------------------------------------------
  // CORS allowlist — built from persisted db origins + config overrides.
  // The `corsAllowlist` instance is mutated live as origins are admitted/removed.
  // ---------------------------------------------------------------------------
  const corsInitialRecords = deps.store.listOrigins(
    deps.corsConfigOrigins ?? [],
  );
  const corsAllowlist: CorsAllowlist = allowlistFromRecords(corsInitialRecords);

  // Owner-configured origins are in-memory overrides (config-sourced).
  for (const o of deps.corsConfigOrigins ?? []) corsAllowlist.add(o);

  // CORS preflight handler — runs BEFORE auth middleware so browsers can
  // complete the preflight without sending credentials.
  app.options('*', (req, res) => {
    const decision = evaluatePreflight(
      {
        method: req.method,
        origin: req.headers['origin'] as string | undefined,
        requestMethod: req.headers['access-control-request-method'] as
          | string
          | undefined,
        requestHeaders: req.headers['access-control-request-headers'] as
          | string
          | undefined,
      },
      corsAllowlist,
    );
    for (const [k, v] of Object.entries(decision.headers)) res.setHeader(k, v);
    if (decision.allowed) {
      res.status(204).end();
    } else {
      void audit.record({
        action: 'cors_denied',
        detail: {
          origin: decision.origin,
          phase: 'preflight',
        },
      });
      res.status(403).end();
    }
  });

  // Actual-request CORS header middleware — runs before auth so browsers
  // receive the CORS headers even on 401/403 responses.
  app.use((req, res, next) => {
    if (req.method === 'OPTIONS') {
      next();
      return;
    }
    const cors = corsHeadersForActualRequest(
      req.headers['origin'] as string | undefined,
      corsAllowlist,
    );
    for (const [k, v] of Object.entries(cors.headers)) res.setHeader(k, v);
    next();
  });
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

  // PUBLIC Android TWA asset-link verification (add-native-mobile-shells).
  // Unauthenticated by design — Android fetches it before the TWA launches.
  // Registered before the bearer middleware; 404 when no TWA is configured.
  if (deps.assetLinks) {
    app.get(
      '/.well-known/assetlinks.json',
      createAssetLinksRoute(deps.assetLinks),
    );
  }

  app.post(
    '/rc/pair/redeem',
    createPairRedeemRoute(
      deps.pairing,
      deps.store,
      audit,
      deps.ownUiOrigin
        ? { ownUiOrigin: deps.ownUiOrigin, allowlist: corsAllowlist }
        : undefined,
    ),
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

  // Multi-workspace daemon registry (add-multi-workspace-client). Lives in the
  // unauthenticated /ui/ namespace but is OWNER-only, so it carries route-level
  // bearerResolve + requireScope(OWNER) and is registered BEFORE the static /ui
  // mount (the global bearer middleware runs after that mount). The handler reads
  // ~/.qwen/rc/clients.toml; the body (urls/tokenStorageKeys) is never logged.
  if (deps.clientsManifestReadToml) {
    app.get(
      '/ui/clients-manifest.json',
      bearerResolve(deps.store, audit),
      requireScope(OWNER, audit),
      createClientsManifestRoute({
        readToml: deps.clientsManifestReadToml,
        now: () => Date.now(),
      }),
    );
  }

  app.use('/ui', express.static(webRoot, { fallthrough: false }));

  app.use(bearerResolve(deps.store, audit));
  // Resolve an asserted sub-actor (bridge "acting for @human") onto rcClient —
  // only honored for bridge-scope tokens. Must follow bearerResolve.
  app.use(resolveSubActor());
  // Protocol version gate: if the client sends X-RC-Version and it does not
  // match RC_PROTOCOL_VERSION, respond 426 before any route handler runs.
  // Absent header → pass through (backward-compatible clients that don't
  // negotiate the version header).
  app.use(versionCheckMiddleware);
  // APNs registration for the iOS native shell (add-native-mobile-shells).
  // Gated at SESSION_READ to mirror the webpush router's floor (a notification
  // channel carries session-read-class payload data, so a zero-scope or guest
  // SHARE token must not mint one); delete is own-or-owner within that.
  // Mounted only when an APNs store is wired.
  if (deps.apnsStore) {
    app.use(
      '/rc/native-push/apns',
      requireScope(SESSION_READ, audit),
      createNativePushRouter(deps.apnsStore, audit),
    );
  }
  // Transparent-proxy topology: the gateway claims the BARE /session/:id/*
  // namespace so a remote client's URL is the same whether it talks to the
  // daemon directly or goes through the gateway.
  app.get(
    '/session/:id/events',
    requireScope(SESSION_READ, audit),
    enforceSessionLock(audit),
    createSessionEventsRoute(
      deps.daemon,
      registry,
      audit,
      deps.usageBroadcaster,
    ),
  );
  app.post(
    '/session/:id/permission/:requestId',
    requireScope(APPROVE, audit),
    recordActivity(workingDevice),
    enforceSessionLock(audit),
    subActorBan, // banned chat user → 403 (before consuming rate budget)
    subActorRateLimit, // bridge fan-in: cap votes per chat user
    createPermissionVoteRoute(deps.daemon, audit),
  );
  app.post(
    '/session/:id/prompt',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    enforceSessionLock(audit),
    subActorBan, // banned chat user → 403 (before consuming rate budget)
    subActorRateLimit, // bridge fan-in: cap prompts per chat user
    createPromptRoute(deps.daemon, audit, deps.onPromptAccepted),
  );
  // GET /rc/usage (add-cost-tracking) — any authenticated token; the route applies
  // owner-sees-all / lesser-sees-own scope filtering internally. Mounted only when
  // a usage store is wired (native sqlite present + cost tracking enabled).
  if (deps.usageReader) {
    app.get(
      '/rc/usage',
      createUsageRoute({
        store: deps.usageReader,
        now: () => Date.now(),
        labelFor: deps.usageLabelFor,
      }),
    );
  }
  // GET /rc/capabilities — always mounted (mDNS reports here even when cost
  // tracking is off). costTracking sub-block is present only when a usage store
  // is wired, so it never claims enabled:true while disabled.
  // GET /capabilities — bare-namespace alias for the transparent-proxy topology
  // so a remote client can discover the gateway's remoteControl capabilities at
  // the same path regardless of whether it speaks directly to the daemon or to
  // the gateway (which merges the daemon's own capabilities with remoteControl).
  {
    const capabilityRoute = createCapabilityRoute({
      costTracking: deps.usageReader
        ? { currencyLabel: deps.costCurrencyLabel ?? (() => 'USD') }
        : undefined,
      mdnsStatus: deps.mdnsStatus,
      nativeShells: deps.nativeShellsCapability,
    });
    app.get('/rc/capabilities', capabilityRoute);
    app.get('/capabilities', capabilityRoute);
  }
  app.post(
    '/session/:id/fork',
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
    '/session/:id/idle-suggest-toggle',
    requireScope(WRITE, audit),
    enforceSessionLock(audit),
    createIdleToggleRoute(idleToggles, idleStatusResolver, audit),
  );
  // GET the same path reports EFFECTIVE idle state (`/suggest status`). SESSION_READ
  // (a read) + session-lock so a confined share token sees only its own session.
  app.get(
    '/session/:id/idle-suggest-toggle',
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
  // Bridge liveness heartbeat (owner-or-self authz inside the handler).
  app.post(
    '/rc/bridges/:id/heartbeat',
    requireScope(SESSION_READ, audit),
    createHeartbeatRoute(bridgeRegistry, audit),
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
    '/session/:id/lineage',
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
  // GET /workspace/:cwd/sessions — bare-namespace proxy for the transparent-proxy
  // topology. The daemon exposes this path; the gateway re-exposes it (OWNER-gated)
  // so remote clients can enumerate sessions at the same URL shape they would use
  // against the daemon directly.
  app.get(
    '/workspace/:cwd/sessions',
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
    '/session/:id/command/:name',
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
  // CORS allowlist CRUD (owner-only; wire-protocol: "Browser CORS allowlist
  // derived from pairing"). GET lists db+config origins; POST manually admits;
  // DELETE removes db-admitted origins (409 for config-sourced).
  app.get(
    '/rc/cors',
    requireScope(OWNER, audit),
    createListCorsOriginsRoute({
      store: deps.store,
      allowlist: corsAllowlist,
      audit,
      configOrigins: deps.corsConfigOrigins,
    }),
  );
  app.post(
    '/rc/cors',
    requireScope(OWNER, audit),
    createAddCorsOriginRoute({
      store: deps.store,
      allowlist: corsAllowlist,
      audit,
      configOrigins: deps.corsConfigOrigins,
    }),
  );
  app.delete(
    '/rc/cors/:origin',
    requireScope(OWNER, audit),
    createRemoveCorsOriginRoute({
      store: deps.store,
      allowlist: corsAllowlist,
      audit,
      configOrigins: deps.corsConfigOrigins,
    }),
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
    createRevokeTokenRoute(
      deps.store,
      registry,
      audit,
      // Cascade APNs subscriptions bound to the revoked token (add-native-mobile
      // -shells "On token revocation the APNs subscription SHALL be removed").
      deps.apnsStore
        ? async (tokenId) => {
            const removed = await deps.apnsStore!.removeByToken(tokenId);
            if (removed > 0) {
              void audit.record({
                action: 'apns_subscription_removed',
                target: tokenId,
                detail: { reason: 'token_revoked', count: removed },
              });
            }
          }
        : undefined,
    ),
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
    // APNs second transport (add-native-mobile-shells): built here so it shares
    // the gateway's audit (push_routed{transport:apns}) and the live-token orphan
    // guard. Only when the host supplied delivery materials AND a store exists.
    const apns =
      deps.apns && deps.apnsStore
        ? {
            store: deps.apnsStore,
            sender: new ApnsSender({
              signer: deps.apns.signer,
              transport: deps.apns.transport ?? createHttp2ApnsTransport(),
              store: deps.apnsStore,
              bundleId: deps.apns.bundleId,
              host: deps.apns.host,
              audit,
              isTokenLive: (tokenId) =>
                deps.store.scopesFor(tokenId) !== undefined,
            }),
          }
        : undefined;
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
      apns,
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

  return { app, notifier, audit, ownerEvents, idleToggles, bridgeRegistry };
}
