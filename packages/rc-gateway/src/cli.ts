/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { watch, readFileSync, type FSWatcher } from 'node:fs';
import { createPrivateKey, createHash } from 'node:crypto';
import { writeBootstrapCode, displayHint } from './bootstrap.js';
import { createServer as createHttpsServer } from 'node:https';
import { createSecureContext } from 'node:tls';
import { homedir, hostname } from 'node:os';
import { join, basename } from 'node:path';
import { createInterface } from 'node:readline';
import { resolveBindSecurity, BindSecurityError } from './bindSecurity.js';
import {
  MdnsConfigError,
  mdnsDecision,
  validateMdnsLabel,
  deriveWorkspaceName,
  deriveInstanceName,
  buildTxtRecord,
  parseDiscoverArgs,
  formatDaemonsTable,
  formatDaemonsJson,
  type MdnsSuppressReason,
} from './mdns/advert.js';
import {
  MdnsAdvertiser,
  MDNS_UNAVAILABLE_KEYWORD,
  type BonjourFactory,
} from './mdns/advertiser.js';
import { browseDaemons, type BrowserFactory } from './mdns/browser.js';
import { startDaemon } from './daemonSupervisor.js';
import { DaemonPool } from './daemonPool.js';
import { getFreePort } from './freePort.js';
import { buildAcmeManager } from './tls/acme/buildAcmeStack.js';
import type { AcmeManager } from './tls/acme/acmeManager.js';
import { createLiveTlsContext, type LiveTlsContext } from './tls/acmeHttps.js';
import { TokenStore } from './tokenStore.js';
import { PairingService } from './pairing.js';
import { VapidStore } from './webpush/vapid.js';
import { PushStore } from './pushStore.js';
import { ApnsStore } from './nativePush/apnsStore.js';
import { ApnsJwtSigner } from './nativePush/apnsJwt.js';
import { apnsHost } from './nativePush/apnsSender.js';
import {
  parseNativePushConfig,
  buildNativeShellsCapability,
  resolveApnsEnabled,
  buildAssetLinks,
} from './nativePush/nativeShells.js';
import { SnoozeStore } from './routing/snooze.js';
import {
  loadLayeredRoutingMatcher,
  loadLayeredRoutingMatcherStrict,
  loadResolvedRoutingRules,
  formatResolvedRouting,
} from './routing/rules.js';
import {
  parseRoutingTest,
  evaluateRoutingTest,
  formatRoutingTest,
} from './routing/test.js';
import { createGatewayApp } from './server.js';
import { pruneStaleBridges, HEARTBEAT_INTERVAL_SEC } from './routes/bridges.js';
import { startBridge, type StartedBridge } from './bridges/start.js';
import { resolveInProcessBridges } from './bridges/inProcess.js';
import { checkMxid } from './bridges/sidecarConfig.js';
import { MatrixRestApi } from './bridges/matrix/restApi.js';
import { IdleSessionToggles } from './idle/sessionToggles.js';
import type { IdleStatusResolver } from './routes/idleToggle.js';
import { SessionEventPump } from './webpush/pump.js';
import { forwardApprovalModeChange } from './webpush/approvalModeForward.js';
import { AgentRegistry } from './agents/agentRegistry.js';
import { ReviewRegistry, type ReviewRecord } from './reviews/reviewRegistry.js';
import { loadOrCreateHookIngestToken } from './agents/hookIngestToken.js';
import {
  DEFAULT_RATE_TABLE,
  RateTableHolder,
  loadRateTableFile,
  rateTablePath,
  createRateTableReloader,
} from './cost/rateTable.js';
import { UsageIngester, UsageTickCoalescer } from './cost/ingester.js';
import { resolveNamedWorkflow } from '@qwen-code/qwen-code-core';
import { SessionAttributionMap } from './cost/sessionAttribution.js';
import { UsageTickBroadcaster } from './cost/usageTickBroadcaster.js';
import { formatUsageCsv, type UsageResponseRow } from './cost/usageQuery.js';
import {
  parseUsageArgs,
  parsePruneArgs,
  formatUsageTable,
} from './cost/usageCli.js';
import {
  resolveSuggestConfig,
  createChatTransport,
} from './idle/chatTransport.js';
import {
  resolveIdleEnabled,
  createIdleSuggestionHandler,
} from './idle/idleSuggestions.js';
import { readFile, readdir } from 'node:fs/promises';
import {
  loadIdleConfig,
  applyIdleReload,
  DEFAULT_IDLE_CONFIG,
} from './idle/config.js';
import { PushRateLimiter } from './webpush/rateLimiter.js';
import {
  loadLayeredPolicy,
  lintPolicyFile,
  formatPolicyLint,
  policyAdvisories,
  type Policy,
} from './policy/loader.js';
import { explainPolicy } from './policy/evaluator.js';
import {
  parseExplainArgs,
  formatExplanation,
  ExplainArgsError,
} from './policy/explain.js';
import { PolicyEnforcer } from './policy/enforcer.js';
import {
  QuotaStore,
  FileQuotaWal,
  quotaLimitsFromPolicy,
} from './policy/quotas.js';
import { PolicyReloader } from './policy/reloader.js';
import { DebouncedReloader } from './reload/debouncedReloader.js';
import {
  checkPolicyFilePermissions,
  formatInsecurePolicyWarning,
} from './policy/permissions.js';
import { OWNER, SESSION_READ, APPROVE, WRITE } from './scopes.js';
import {
  resolveChatsDir,
  resolveSearchIndexDir,
} from './sessions/chatsPath.js';
import { searchTranscriptsDetailed } from './search/transcripts.js';
import {
  parseSearchArgs,
  formatSearchResults,
  formatSearchResultsJson,
  buildSearchApiQuery,
  searchFromApiResponse,
} from './search/searchCli.js';
import { listSessions, type SessionListItem } from './sessions/sessionList.js';
import {
  parseForkArgs,
  buildForkPayload,
  formatForkOutput,
} from './sessions/forkCli.js';
import {
  parseSessionsArgs,
  buildForkTree,
  renderForkTree,
  formatSessionsJson,
  sessionsApiPath,
  sessionsFromApiResponse,
} from './sessions/sessionsCli.js';
import { DaemonRegistry } from './daemons/registry.js';
import { FileTokenStore, defaultTokensDir } from './daemons/tokenStore.js';
import {
  resolveDaemonTarget,
  splitTargetFlags,
  type DaemonTarget,
  type SplitTargetFlagsResult,
} from './daemons/daemonTarget.js';
import {
  daemonRequest,
  probeHealth,
  DaemonHttpError,
  DaemonUnreachableError,
} from './daemons/daemonClient.js';
import {
  readTokenMeta,
  writeTokenMeta,
  deleteTokenMeta,
} from './daemons/tokenMeta.js';
import {
  parseDaemonsArgs,
  formatDaemonsListTable,
  formatHealthLine,
  formatWhoami,
  type DaemonRow,
} from './daemons/daemonsCli.js';
import { AuditLog } from './auditLog.js';

/**
 * Per-daemon target resolution shared by the `--daemon`-threaded commands
 * (`fork`, `sessions`, `search` — add-multi-workspace-client task 1.4).
 *
 * Precedence: an EXPLICIT `--daemon`/`--url`/`--token` always targets the
 * daemon API. With no target flags at all, a NON-EMPTY registry resolves to
 * its default daemon (API mode, spec: "default to the registry's default
 * daemon when omitted"); an EMPTY registry means the zero-config LOCAL setup
 * and the command keeps its daemon-free on-disk behaviour (`target` is
 * undefined — `sessions` scans the chats dir, `search` scans transcripts,
 * exactly as the daemon's own routes do, so the two can never drift).
 * `required: true` (fork) has no on-disk mode: an empty registry resolves to
 * the local daemon default instead of `undefined`.
 */
async function resolveCliDaemonTarget(
  split: SplitTargetFlagsResult,
  opts: { required?: boolean } = {},
): Promise<
  | { ok: true; target?: DaemonTarget; insecure: boolean }
  | { ok: false; error: string; exitCode: 1 | 2 }
> {
  const registry = new DaemonRegistry();
  const tokens = new FileTokenStore();
  const entries = await registry.list();
  const explicit =
    split.target.daemonName !== undefined ||
    split.target.url !== undefined ||
    split.target.token !== undefined;
  if (!explicit && entries.length === 0 && !opts.required) {
    return { ok: true, target: undefined, insecure: split.insecure };
  }
  const resolved = await resolveDaemonTarget(split.target, entries, (key) =>
    tokens.get(key),
  );
  if (!resolved.ok) {
    // Spec: unknown --daemon → exit 1 (`daemon_unknown`); a malformed
    // --url is a usage error → exit 2.
    return {
      ok: false,
      error: resolved.error,
      exitCode: resolved.code === 'daemon_unknown' ? 1 : 2,
    };
  }
  return { ok: true, target: resolved.target, insecure: split.insecure };
}

export interface ServeOptions {
  gatewayPort?: number;
  daemonPort?: number;
  /** Bind host (default 127.0.0.1). A non-loopback host requires a TLS story. */
  host?: string;
  /** PEM cert path for native TLS termination (with tlsKey). */
  tlsCert?: string;
  /** PEM private-key path for native TLS termination (with tlsCert). */
  tlsKey?: string;
  /** Assert an upstream TLS terminator → allow a cleartext non-loopback bind. */
  insecureBehindProxy?: boolean;
  /** Disable mDNS advertisement (`--no-mdns` / `QWEN_RC_NO_MDNS=1`). */
  noMdns?: boolean;
  /** Override the advertised TXT `workspace` value (default = cwd basename). */
  mdnsWorkspaceName?: string;
  /** Override the mDNS service instance name (default = host-workspace). */
  mdnsInstanceName?: string;
  /**
   * Attach to an ALREADY-RUNNING `qwen serve` daemon instead of spawning one
   * (handoff Phase 1): the gateway shares that daemon's sessions, so a terminal
   * session becomes reachable from mobile. Requires the daemon's token
   * (`--daemon-token` / `QWEN_RC_DAEMON_TOKEN`). The gateway never kills a daemon
   * it did not start.
   */
  attachDaemonUrl?: string;
  /** Token (`QWEN_SERVER_TOKEN`) of the daemon to attach to. */
  attachDaemonToken?: string;
  /**
   * `--acme-domain` values: bind with native TLS using an auto-obtained (and
   * auto-renewed) Let's Encrypt cert via DNS-01. Requires {@link acmeEmail} and
   * {@link acmeDnsProvider}; DNS-provider creds come from env. See
   * `docs/acme-dns01-design.md`.
   */
  acmeDomains?: string[];
  acmeEmail?: string;
  /** `route53` | `cloudflare`. */
  acmeDnsProvider?: string;
  /** Use LE staging (untrusted certs, loose limits) for testing. */
  acmeStaging?: boolean;
  /** Override the ACME directory URL (private CA / Pebble). */
  acmeDirectoryUrl?: string;
}

/** Boot the daemon + gateway and print the owner pairing code. */
export async function runServe(opts: ServeOptions = {}): Promise<void> {
  // Resolve + ENFORCE bind safety BEFORE any side effect (no daemon spawn on a
  // misconfigured bind). Throws BindSecurityError on a non-loopback bind with no
  // TLS story; the entrypoint prints the message and exits non-zero.
  const bind = resolveBindSecurity({
    host: opts.host,
    tlsCert: opts.tlsCert,
    tlsKey: opts.tlsKey,
    insecureBehindProxy: opts.insecureBehindProxy,
    acmeDomains: opts.acmeDomains,
  });
  // Read AND validate the cert/key NOW (before spawning the daemon) so a bad
  // path OR malformed PEM fails fast with a clean BindSecurityError and never
  // orphans a daemon — keeping the "ENFORCE bind safety before any side effect"
  // contract genuinely true. createSecureContext builds the context the https
  // server would build at listen time and throws on malformed PEM, with no bind
  // and no side effect. (A key that simply doesn't match the cert is only caught
  // at handshake time and is out of scope here.)
  let tlsMaterial: { cert: Buffer; key: Buffer } | undefined;
  // PEM text of the leaf cert (first PEM block) used for fingerprinting in the
  // pairing banner. Set for both native-TLS and ACME paths.
  let tlsCertPem: string | undefined;
  if (bind.mode === 'tls') {
    let cert: Buffer;
    let key: Buffer;
    try {
      cert = readFileSync(bind.tls!.certPath);
      key = readFileSync(bind.tls!.keyPath);
    } catch (err) {
      throw new BindSecurityError(
        `cannot read TLS cert/key (${bind.tls!.certPath}, ${bind.tls!.keyPath}): ${(err as Error).message}`,
      );
    }
    try {
      createSecureContext({ cert, key });
    } catch (err) {
      throw new BindSecurityError(
        `invalid TLS cert/key (${bind.tls!.certPath}, ${bind.tls!.keyPath}): ${(err as Error).message}`,
      );
    }
    tlsMaterial = { cert, key };
    tlsCertPem = cert.toString('utf8');
  }
  // ACME (auto Let's Encrypt): obtain the cert BEFORE spawning the daemon so an
  // issuance failure fails fast without orphaning a daemon (same contract as the
  // file-cert path above). `start()` loads a cached cert (fast) or obtains one via
  // DNS-01 (slow first boot); it then keeps an auto-renewal loop running. The
  // `liveTls` SNICallback serves the current cert and swaps on renewal (onChange).
  let acmeManager: AcmeManager | undefined;
  let acmeTls: LiveTlsContext | undefined;
  if (bind.mode === 'acme') {
    if (!opts.acmeEmail) {
      throw new BindSecurityError(
        '--acme-domain requires --acme-email <email>',
      );
    }
    if (!opts.acmeDnsProvider) {
      throw new BindSecurityError(
        '--acme-domain requires --acme-dns-provider <route53|cloudflare>',
      );
    }
    acmeManager = await buildAcmeManager(
      {
        domains: opts.acmeDomains!,
        email: opts.acmeEmail,
        dnsProvider: opts.acmeDnsProvider,
        staging: opts.acmeStaging,
        directoryUrl: opts.acmeDirectoryUrl,
      },
      {
        baseDir: join(homedir(), '.qwen', 'rc', 'acme'),
        // eslint-disable-next-line no-console
        log: (m) => console.log(`acme: ${m}`),
        onChange: (b) => acmeTls?.update(b),
      },
    );
    const initial = await acmeManager.start();
    acmeTls = createLiveTlsContext(initial);
    tlsCertPem = initial.cert;
    // eslint-disable-next-line no-console
    console.log(
      `acme: certificate ready for ${opts.acmeDomains!.join(', ')} ` +
        `(${opts.acmeStaging ? 'LE staging' : 'LE production'}, ` +
        `notAfter=${initial.meta.notAfter})`,
    );
  }
  // Validate any mDNS name overrides NOW (before side effects) so a path-traversal
  // value refuses to start cleanly (add-mdns-discovery: "rejected at startup").
  if (opts.mdnsWorkspaceName !== undefined) {
    validateMdnsLabel(opts.mdnsWorkspaceName, 'workspace-name');
  }
  if (opts.mdnsInstanceName !== undefined) {
    validateMdnsLabel(opts.mdnsInstanceName, 'instance-name');
  }
  // Attach to an existing daemon (handoff Phase 1) when a URL is given, else spawn
  // our own. Attach requires the daemon's token so the gateway can authenticate
  // against its `--require-auth` surface.
  if (opts.attachDaemonUrl && !opts.attachDaemonToken) {
    throw new Error(
      'attach-daemon requires the daemon token (--daemon-token / QWEN_RC_DAEMON_TOKEN)',
    );
  }
  const handle = opts.attachDaemonUrl
    ? await startDaemon({
        attach: {
          url: opts.attachDaemonUrl,
          token: opts.attachDaemonToken!,
        },
      })
    : await startDaemon({ port: opts.daemonPort ?? 4180 });
  if (handle.attached) {
    // eslint-disable-next-line no-console
    console.log(
      `qwen-rc: attached to existing daemon at ${opts.attachDaemonUrl} (will not stop it on exit)`,
    );
  }
  const store = await TokenStore.open(
    join(homedir(), '.qwen', 'rc', 'tokens.json'),
  );
  // Owner-bootstrap pairing code TTL. This PairingService mints ONLY the
  // single owner bootstrap code (below); no guest/device codes flow through
  // it. The generic 5-min default is far too short for a human first-run
  // (scan QR → install PWA → type a case-sensitive code on a phone), and
  // bootstrap.ts already documents an intended distinct bootstrap TTL that was
  // never wired. Give it a bounded 30-minute window; the code remains
  // single-use (redeem consumes it) and stays in the 0600 file.
  const OWNER_BOOTSTRAP_TTL_MS = 30 * 60 * 1000;
  const pairing = new PairingService(Date.now, OWNER_BOOTSTRAP_TTL_MS);
  const vapid = await VapidStore.open(
    join(homedir(), '.qwen', 'rc', 'vapid.json'),
  );
  const pushStore = await PushStore.open(
    join(homedir(), '.qwen', 'rc', 'push-subscriptions.json'),
  );
  // APNs device-token subscriptions for the iOS native shell
  // (add-native-mobile-shells). Always opened so the register/delete endpoints
  // and the token-revoke cascade are live; the APNs SENDER + capability gating
  // are wired separately (a registration is harmless storage until then).
  const apnsStore = await ApnsStore.open(
    join(homedir(), '.qwen', 'rc', 'apns-subscriptions.json'),
  );
  // Native-shell config (add-native-mobile-shells): APNs identifiers + Android
  // TWA asset-link material. Read once at boot; the P-8 key's presence is
  // re-checked live per /rc/capabilities request so apnsEnabled tracks the key
  // file appearing/disappearing without a restart.
  const nativePushConfig = parseNativePushConfig(
    await readFile(
      join(homedir(), '.qwen', 'rc', 'native-push.yaml'),
      'utf8',
    ).catch(() => null),
  );
  const expandTilde = (p: string): string =>
    p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
  // APNs delivery materials (add-native-mobile-shells): built once at boot when
  // the config is complete AND the P-8 key parses. Absent → the notifier skips
  // APNs (a registration is harmless storage). NOTE: the SENDER is built from the
  // key read here, so toggling delivery requires a restart — whereas the
  // capability's `apnsEnabled` is re-checked live per request.
  let apnsDelivery:
    | { signer: { token(): string }; bundleId: string; host: string }
    | undefined;
  {
    const a = nativePushConfig.apns;
    // Same predicate as resolveApnsEnabled (the capability flag) minus the live
    // key re-check — so `enabled: false` turns delivery OFF, not just the
    // capability. (Key loadability is validated by signer.token() below.)
    if (a?.enabled && a.keyPath && a.keyId && a.teamId && a.bundleId) {
      try {
        const keyPem = readFileSync(expandTilde(a.keyPath), 'utf8');
        const signer = new ApnsJwtSigner({
          keyPem,
          keyId: a.keyId,
          teamId: a.teamId,
          now: () => Date.now(),
        });
        signer.token(); // parse-validate the key now; throws on malformed → off
        apnsDelivery = {
          signer,
          bundleId: a.bundleId,
          host: apnsHost(a.environment ?? 'production'),
        };
      } catch {
        // Unreadable/malformed P-8 key → APNs delivery stays off (plain push only).
        apnsDelivery = undefined;
      }
    }
  }
  const snooze = await SnoozeStore.open(
    join(homedir(), '.qwen', 'rc', 'snooze.state'),
  );
  // Load routing rules FAIL-OPEN across two layers: the user-level
  // ~/.qwen/rc/routing.yaml and the workspace override
  // <workspaceCwd>/.qwen/routing.yaml (workspace rules prepended — cycle 36).
  // A missing/malformed file at either layer is logged + ignored (routing only
  // suppresses, so the safe default on misconfig is more notifications, never
  // fewer). 1-daemon-1-workspace ⇒ resolve the cwd once at boot; a capabilities
  // failure simply skips the workspace layer. Hot-reload is deferred.
  let workspaceCwd: string | undefined;
  try {
    workspaceCwd = (await handle.daemon.capabilities()).workspaceCwd;
  } catch {
    // Daemon not reporting capabilities → no workspace override layer. This
    // also leaves `workspaceCwd` undefined for the policy enforcer below, so
    // any `pathGlob` anchoring falls back to the GATEWAY PROCESS's own cwd
    // (not the daemon's workspace) — every path-based policy rule may be
    // silently inert until the daemon reports capabilities successfully.
    // eslint-disable-next-line no-console
    console.warn(
      'qwen-rc: daemon capabilities() failed; policy pathGlob anchoring ' +
        "falls back to the gateway's own process cwd, not the daemon's " +
        'workspace — path-based policy rules may not match as expected',
    );
  }
  // Multi-workspace daemon pool (add-multi-workspace-daemon-pool): the boot
  // daemon above stays the DEFAULT daemon (an empty/omitted `cwd` on
  // POST /session routes there, unchanged), while `POST /session { cwd }`
  // naming a DIFFERENT workspace spawns (or reuses) its own `qwen serve` on a
  // fresh loopback port. `defaultWorkspaceCwd` falls back to the gateway
  // process's own cwd when the boot daemon's capabilities() failed above —
  // the same degraded fallback already used for policy/routing pathGlob
  // anchoring (mirrors lines 614/783 below). NOTE: if capabilities() merely
  // failed transiently (the boot daemon IS healthy, just didn't answer in
  // time) and a later POST /session names that same true boot workspace, the
  // pool won't recognise it as the default and will spawn a REDUNDANT second
  // daemon for it — a known residual of resolving this fallback once at boot.
  const defaultWorkspaceCwd = workspaceCwd ?? process.cwd();
  const daemonPool = new DaemonPool({
    defaultDaemon: handle.daemon,
    defaultWorkspaceCwd,
    // Reuses the exact boot path above (startDaemon → defaultSpawner →
    // `qwen serve`), parameterized with the requested workspace on a freshly
    // allocated loopback port instead of the fixed boot port.
    spawn: async (cwd) => {
      const port = await getFreePort();
      const spawned = await startDaemon({ port, workspaceCwd: cwd });
      return { client: spawned.daemon, stop: spawned.stop, workspaceCwd: cwd };
    },
    maxDaemons: 3,
    idleReapMs: 15 * 60_000,
  });
  const { matcher: routing, ruleCount: routingRuleCount } =
    await loadLayeredRoutingMatcher(
      join(homedir(), '.qwen', 'rc', 'routing.yaml'),
      workspaceCwd,
      // eslint-disable-next-line no-console
      (msg) => console.warn(msg),
    );
  // Idle suggestions pre-wiring (built before createGatewayApp so the toggle
  // store + status resolver can be injected): the per-session override store, the
  // rolling-hour limiter, and the live idle.yaml config. `suggestCfg` (resolved
  // model creds) decides whether idle is wired at all — when absent, the status
  // route reports `available:false`. The idleStatus closure reads idleConfig +
  // idleLimiter LIVE so a hot-reload / consumed budget is reflected immediately.
  const idleToggles = new IdleSessionToggles();
  const idleLimiter = new PushRateLimiter();
  const idleConfig = await loadIdleConfig(
    join(homedir(), '.qwen', 'rc', 'idle.yaml'),
    // eslint-disable-next-line no-console
    (msg) => console.warn(`idle: ${msg}`),
  );
  if (resolveIdleEnabled()) idleConfig.enabled = true;
  const suggestCfg = resolveSuggestConfig();
  const idleStatus: IdleStatusResolver = (sessionId) => {
    if (!suggestCfg) return undefined; // idle not wired → available:false
    return {
      globalEnabled: idleConfig.enabled,
      maxSuggestionsPerHour: idleConfig.maxSuggestionsPerHour,
      remainingThisHour: idleLimiter.remaining(
        sessionId,
        idleConfig.maxSuggestionsPerHour,
        Date.now(),
      ),
    };
  };
  // Cost tracking (add-cost-tracking): open the usage store (native sqlite,
  // dynamically loaded so a missing build disables tracking, not the gateway) and
  // the rate table (built-in defaults, overlaid by the operator file if it parses).
  // The ingester is created after the app (it needs `audit`); attribution +
  // broadcaster exist now so they can be passed into the app deps.
  const usageStore = await openUsageStore();
  // Agent observability (add-agent-observability): persisted registry of
  // spawned-agent records, booted before createGatewayApp so agent routes
  // mount from the very first request.
  const agentRegistry = await AgentRegistry.open(
    join(homedir(), '.qwen', 'rc', 'agents.json'),
  );
  // Remote review control plane (add-remote-review): persisted registry of
  // triggered-review records, booted before createGatewayApp so review routes
  // mount from the very first request (mirrors agentRegistry above).
  const reviewRegistry = await ReviewRegistry.open(
    join(homedir(), '.qwen', 'rc', 'reviews.json'),
  );
  // Hook event mirror (add-agent-observability): mint-or-load the dedicated
  // loopback ingest token once and persist it 0600 alongside the bootstrap
  // code file. Regenerating per start would invalidate the hook config that
  // interpolates it, so the value is stable across restarts.
  const hookIngestToken = await loadOrCreateHookIngestToken(
    join(homedir(), '.qwen', 'rc', 'hook-ingest-token'),
  );
  // Shared read-time cost rollup (UsageStore.sessionTotals) — the SAME
  // function is handed to both `agents.costFor` and `review.costFor` so the
  // two control planes never disagree on a session's cost.
  const costFor = usageStore
    ? (sid: string) => usageStore.sessionTotals(sid).costMicrocentsSesTotal
    : undefined;
  /**
   * Resolve the saved review report + (for a PR target) its cached findings
   * summary. Best-effort throughout: any fs/daemon failure collapses to
   * `{reportPath: null, summary: null}` rather than breaking review
   * completion. Mirrors the bundled `review` skill's Step 10 persistence:
   *   - report dir: `<workspaceCwd>/.qwen/reviews/`
   *   - filename:   `<date>-<time>-<suffix>.md`, suffix = `pr-<n>` | `local` |
   *     `<basename-of-path>`; filenames sort lexically newest-last.
   *   - PR summary: `<workspaceCwd>/.qwen/review-cache/pr-<n>.json`
   *     (`{findingsCount, verdict}`).
   * Fetches `capabilities()` fresh (rather than reusing the boot-time
   * `workspaceCwd`) so a daemon that was unreachable at boot still resolves
   * once it comes back.
   */
  async function resolveReviewReport(
    rec: ReviewRecord,
  ): Promise<{ reportPath: string | null; summary: ReviewRecord['summary'] }> {
    try {
      const caps = await handle.daemon.capabilities();
      const cwd = caps.workspaceCwd;
      if (!cwd) return { reportPath: null, summary: null };

      const suffix =
        rec.target.kind === 'pr'
          ? `pr-${rec.target.number}`
          : rec.target.kind === 'path'
            ? basename(rec.target.path)
            : 'local';

      let reportPath: string | null = null;
      try {
        const reviewsDir = join(cwd, '.qwen', 'reviews');
        const entries = await readdir(reviewsDir);
        const matches = entries.filter((f) => f.endsWith(`-${suffix}.md`));
        // Filenames sort lexically by <date>-<time>-<suffix> — the max string
        // is the newest report.
        matches.sort();
        const newest = matches.at(-1);
        reportPath = newest ? join(reviewsDir, newest) : null;
      } catch {
        reportPath = null;
      }

      let summary: ReviewRecord['summary'] = null;
      if (rec.target.kind === 'pr') {
        try {
          const cachePath = join(
            cwd,
            '.qwen',
            'review-cache',
            `pr-${rec.target.number}.json`,
          );
          const parsed = JSON.parse(await readFile(cachePath, 'utf8')) as {
            findingsCount?: number;
            verdict?: string;
          };
          summary = {
            findingsCount: parsed.findingsCount,
            verdict: parsed.verdict,
          };
        } catch {
          summary = null;
        }
      }
      return { reportPath, summary };
    } catch {
      return { reportPath: null, summary: null };
    }
  }
  const rates = new RateTableHolder(DEFAULT_RATE_TABLE);
  if (usageStore) {
    try {
      rates.set(await loadRateTableFile(rateTablePath()));
    } catch {
      // No file / malformed at boot → keep the built-in defaults.
    }
  }
  const sessionAttribution = new SessionAttributionMap();
  const usageBroadcaster = new UsageTickBroadcaster();
  let usageIngester: UsageIngester | undefined;
  let rateReloader: { stop(): void; trigger(): void } | undefined;
  // mDNS advertiser is created after listen() (it needs the bound port); the
  // capability route reads its live state through this closure.
  let mdnsAdvertiser: MdnsAdvertiser | undefined;
  // Live policy for POST /policy/explain, read through a closure so the route
  // always sees the hot-reloaded ruleset (set at load + in the reloader apply).
  let currentPolicy: Policy | undefined;

  const {
    app,
    notifier,
    audit,
    ownerEvents,
    bridgeRegistry,
    agentLifecycle,
    reviewLifecycle,
  } = createGatewayApp({
    daemon: daemonPool,
    store,
    pairing,
    vapid,
    pushStore,
    apnsStore,
    ...(apnsDelivery ? { apns: apnsDelivery } : {}),
    nativeShellsCapability: () => {
      const keyPath = nativePushConfig.apns?.keyPath;
      // apnsEnabled reflects a LOADABLE P-8 key, not mere file presence: parse
      // it as an EC private key so a present-but-malformed key reads false
      // (mirrors bind-security's createSecureContext check). Re-checked live.
      let keyLoadable = false;
      if (keyPath) {
        try {
          createPrivateKey(readFileSync(expandTilde(keyPath)));
          keyLoadable = true;
        } catch {
          keyLoadable = false;
        }
      }
      return buildNativeShellsCapability(
        resolveApnsEnabled(nativePushConfig, keyLoadable),
      );
    },
    assetLinks: () => buildAssetLinks(nativePushConfig),
    snooze,
    routing,
    idleToggles,
    idleStatus,
    usageReader: usageStore,
    usageBroadcaster: usageStore ? usageBroadcaster : undefined,
    costCurrencyLabel: () => rates.current().currencyLabel,
    mdnsStatus: () =>
      mdnsAdvertiser?.advertising
        ? { advertising: true, instanceName: mdnsAdvertiser.instanceName }
        : { advertising: false },
    // GET /rc/peers: browse the LAN via the OPTIONAL bonjour-service factory
    // (same pair behind `qwen-rc daemons discover`). null → dependency absent.
    browsePeers: async (timeoutMs: number) => {
      const factory = await loadBonjourFactory();
      if (!factory) return null;
      return browseDaemons({
        factory: factory as unknown as BrowserFactory,
        timeoutMs,
      });
    },
    policyExplain: {
      policy: () => currentPolicy,
      projectRoot: () => workspaceCwd ?? process.cwd(),
      // Local alias so the truthiness narrowing survives into the nested
      // arrow at tsc time (a bare `quota.state` inside the inner closure does
      // not stay narrowed — this is why enforcer.ts:106 uses `this.quota!`).
      quotaOracle: () => {
        const q = quota;
        return q ? { state: (id, ms) => q.state(id, ms) } : undefined;
      },
    },
    clientsManifestReadToml: () =>
      readFile(join(homedir(), '.qwen', 'rc', 'clients.toml'), 'utf8').then(
        (text) => text,
        (err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') return null; // not configured → warning
          throw err; // unexpected → route degrades to warning, never 5xx
        },
      ),
    onPromptAccepted: usageStore
      ? (sid, attr) => {
          sessionAttribution.set(sid, attr);
          usageIngester?.notePromptBoundary(sid);
        }
      : undefined,
    agents: {
      registry: agentRegistry,
      costFor,
    },
    review: {
      registry: reviewRegistry,
      costFor,
      resolveReport: resolveReviewReport,
    },
    workflows: {
      runsDir: join(homedir(), '.qwen', 'workflows', 'runs'),
      // Gateway { name } resolution reuses the CLI tool's EXACT guarded
      // resolver (core resolveNamedWorkflow): project `.qwen/workflows` then
      // user `~/.qwen/workflows`, with the same traversal guard. The gateway
      // is deliberately NOT given an unguarded name resolver.
      resolveNamed: (name: string) =>
        resolveNamedWorkflow(name, {
          workingDir: process.cwd(),
          homeDir: homedir(),
        }),
    },
    hookIngest: { ingestToken: hookIngestToken },
  });

  // Startup reconciliation (design: "Reconciliation"): running/blocked agent
  // records whose daemon session is gone become `orphaned` — surfaced in
  // GET /rc/agents, never silently dropped. Best-effort: an unreachable
  // daemon at boot leaves records untouched for the next start.
  try {
    const caps = await handle.daemon.capabilities();
    // Skip reconciliation if workspaceCwd is absent: undefined capability means
    // "unknown", not "no sessions". Must not false-orphan running agents.
    if (caps.workspaceCwd) {
      const live = await handle.daemon.listWorkspaceSessions(caps.workspaceCwd);
      const orphaned = await agentRegistry.reconcile(
        live.map((s) => s.sessionId),
      );
      if (orphaned.length > 0) {
        // eslint-disable-next-line no-console
        console.warn(`agents: marked ${orphaned.length} record(s) orphaned`);
      }
      // Same reconciliation for triggered reviews (add-remote-review): a
      // running/blocked review whose session is gone becomes `orphaned` —
      // surfaced in GET /rc/reviews, never silently dropped.
      const orphanedReviews = await reviewRegistry.reconcile(
        live.map((s) => s.sessionId),
      );
      if (orphanedReviews.length > 0) {
        // eslint-disable-next-line no-console
        console.warn(`reviews: marked ${orphanedReviews.length} orphaned`);
      }
    }
  } catch {
    // Daemon unreachable at boot → reconcile on the next start.
  }

  // Now that `audit` exists, build the ingester. usage_tick emissions fan through
  // the broadcaster (relay registration lands in the next slice; until then they
  // fan to nobody, harmlessly). Rows are still written + queryable via /rc/usage.
  if (usageStore) {
    const coalescer = new UsageTickCoalescer({
      emit: (tick) => usageBroadcaster.emit(tick),
    });
    usageIngester = new UsageIngester({
      rates,
      store: usageStore,
      coalescer,
      now: () => Date.now(),
      onRateMiss: (modelServiceId, modelId) =>
        void audit.record({
          action: 'rate_table_miss',
          detail: { modelServiceId, modelId },
        }),
    });
  }

  // Bridge staleness reaper: every heartbeat interval, drop bridges that missed
  // ~3 heartbeats and audit each (bridge_stale_deregistered). Unref'd so it never
  // keeps the process alive; cleared in shutdown so it doesn't leak.
  const bridgeReaper = setInterval(
    () => pruneStaleBridges(bridgeRegistry, Date.now(), audit),
    HEARTBEAT_INTERVAL_SEC * 1000,
  );
  bridgeReaper.unref();

  // Load the policy fail-closed, layered over the same workspace cwd resolved
  // for routing above (cycle 38): user ~/.qwen/rc/policy.yaml + workspace
  // <cwd>/.qwen/policy.yaml (workspace rules prepended → override at equal
  // specificity). Absent user file → default-prompt; a MALFORMED user file still
  // throws (cycle-14 boot-fail, unchanged — do NOT wrap in a swallowing catch); a
  // malformed workspace file is logged + ignored (fail-closed: keep user policy).
  const userPolicyPath = join(homedir(), '.qwen', 'rc', 'policy.yaml');
  // eslint-disable-next-line no-console
  const warn = (msg: string) => console.warn(msg);
  const policy = await loadLayeredPolicy(userPolicyPath, workspaceCwd, warn);
  currentPolicy = policy;
  // Advisory-only lint warnings: alias-widened `allow` rules and the
  // newly-live-allow-rules note from policyAdvisories. Emitted ONCE at boot on
  // the merged policy — never on hot-reload (cycle 45's reloader), which fires
  // on every file change and would spam the same notes repeatedly. Reuses the
  // same warn sink as loadLayeredPolicy rather than a new logging mechanism.
  for (const w of policyAdvisories(policy)) warn(w);
  // Boot hygiene (cycle 48): warn if either policy file is group/world-writable
  // (design threat model — a non-owner could rewrite the tool-permission policy).
  // Advisory only: the policy still loads. The check never throws (best-effort).
  for (const insecure of await checkPolicyFilePermissions([
    userPolicyPath,
    ...(workspaceCwd ? [join(workspaceCwd, '.qwen', 'policy.yaml')] : []),
  ])) {
    // eslint-disable-next-line no-console
    console.warn(formatInsecurePolicyWarning(insecure));
  }
  // Per-rule quota store (cycle 43): limits keyed by rule id from the active
  // policy; persisted to ~/.qwen/rc/quotas.wal (survives restart). Only built
  // when the enforcer runs. The QuotaStore's limitsFor closure reads THIS map by
  // reference, so hot-reload (cycle 45) rebuilds limits by mutating it in place
  // (applyQuotaLimits) — no store reconstruction needed.
  const quotaLimits = new Map<string, { count: number; windowSec: number }>();
  const applyQuotaLimits = (p: Policy): void => {
    quotaLimits.clear();
    for (const [id, lim] of quotaLimitsFromPolicy(p)) quotaLimits.set(id, lim);
  };
  applyQuotaLimits(policy);
  const quota = notifier
    ? await QuotaStore.create(
        new FileQuotaWal(
          join(homedir(), '.qwen', 'rc', 'quotas.wal'),
          // eslint-disable-next-line no-console
          (msg) => console.warn(msg),
        ),
        (id) => quotaLimits.get(id),
      )
    : undefined;
  // projectRoot for pathGlob anchoring MUST be the daemon's own workspaceCwd
  // (resolved above for routing/policy layering), never a frame-supplied
  // value — see enforcer.ts's constructor doc. Read lazily via a closure
  // (rather than capturing `workspaceCwd` by value here) so a future boot
  // reordering that resolves it after the enforcer is constructed still
  // sees the final value.
  const enforcer = notifier
    ? new PolicyEnforcer(
        handle.daemon,
        policy,
        audit,
        quota,
        Date.now,
        () => workspaceCwd ?? process.cwd(),
      )
    : undefined;

  // Policy hot-reload (cycle 45, Phase 3.1): watch both policy files; on a
  // debounced (250 ms) change, reload the LAYERED policy and, on success, swap
  // it into the enforcer AND rebuild the quota limits IN PLACE. A malformed
  // reload RETAINS the previous ruleset (PolicyReloader never throws) and audits
  // policy_reload_failed — a running gateway must not crash/widen on a half-typed
  // save (spec "Parse error preserves previous ruleset"). NOTE: a rule id reused
  // across a reload inherits its prior consumption counts (fail-safe: more
  // prompting, not a loosening). The policy_load_error SSE frame is deferred —
  // no gateway-level owner-broadcast surface exists yet (Phase 4).
  const watchers: FSWatcher[] = [];
  let reloader: PolicyReloader | undefined;
  // Routing hot-reload (notification-routing spec: "hot-reloaded on change with a
  // 250 ms debounce; on parse failure retain the previously-compiled ruleset and
  // emit routing_reload_failed"). Symmetric to the policy reloader above and
  // shares its dir watchers. The STRICT loader throws on a malformed layer so a
  // half-typed save RETAINS the prior rules (a silent fail-open would instead
  // WIDEN the fan-out). The swap is a sync notifier.setRouting; per-event
  // atomicity is handled by notify() capturing the matcher once.
  let routingReloader:
    | DebouncedReloader<
        Awaited<ReturnType<typeof loadLayeredRoutingMatcherStrict>>
      >
    | undefined;
  if (enforcer) {
    const activeEnforcer = enforcer;
    reloader = new PolicyReloader({
      load: () =>
        loadLayeredPolicy(
          join(homedir(), '.qwen', 'rc', 'policy.yaml'),
          workspaceCwd,
          // eslint-disable-next-line no-console
          (msg) => console.warn(msg),
          // RELOAD semantics: a malformed workspace file must RETAIN the
          // previous ruleset (throw → onError), not silently drop the layer and
          // widen permissions. A deleted (ENOENT) workspace file still resolves
          // to user-only (an intended layer removal).
          { strictWorkspace: true },
        ),
      // apply MUST stay synchronous (atomic vs handlePermission's await-vote).
      apply: (p) => {
        activeEnforcer.setPolicy(p);
        applyQuotaLimits(p);
        currentPolicy = p;
      },
      onReloaded: (p) => {
        void audit.record({
          action: 'policy_reloaded',
          detail: { ruleCount: p.rules.length },
        });
        // eslint-disable-next-line no-console
        console.log(`policy: reloaded (${p.rules.length} rule(s))`);
      },
      onError: (err) => {
        const reason = (err as Error)?.name ?? 'error';
        void audit.record({
          action: 'policy_reload_failed',
          detail: { reason },
        });
        // eslint-disable-next-line no-console
        console.warn(
          `policy: reload failed, keeping previous ruleset (${reason})`,
        );
      },
    });
    const activeReloader = reloader;
    // Routing shares the same workspace cwd + parent dirs as policy, so build its
    // reloader here and dispatch from the one dir watcher below. enforcer is only
    // ever set when notifier exists, but narrow explicitly for the type-checker.
    if (notifier) {
      const activeNotifier = notifier;
      const routingPath = join(homedir(), '.qwen', 'rc', 'routing.yaml');
      routingReloader = new DebouncedReloader({
        load: () => loadLayeredRoutingMatcherStrict(routingPath, workspaceCwd),
        // Sync field swap; notify() captures the matcher once per event.
        apply: ({ matcher }) => activeNotifier.setRouting(matcher),
        onReloaded: ({ ruleCount }) => {
          void audit.record({
            action: 'routing_reloaded',
            detail: { ruleCount },
          });
          // eslint-disable-next-line no-console
          console.log(
            `routing: reloaded (${ruleCount === 0 ? 'no' : ruleCount} rule(s))`,
          );
        },
        onError: (err) => {
          const reason = (err as Error)?.name ?? 'error';
          void audit.record({
            action: 'routing_reload_failed',
            detail: { reason },
          });
          // eslint-disable-next-line no-console
          console.warn(
            `routing: reload failed, keeping previous ruleset (${reason})`,
          );
        },
      });
    }
    const activeRoutingReloader = routingReloader;
    // Watch the PARENT DIR of each config file (survives an editor's atomic
    // rename-replace, unlike a file watch), dispatching by basename to the
    // policy and routing reloaders. fs.watch THROWS SYNCHRONOUSLY on a missing
    // dir → guard the CALL; a missing/unwatchable dir simply won't hot-reload.
    const dirs = [join(homedir(), '.qwen', 'rc')];
    if (workspaceCwd) dirs.push(join(workspaceCwd, '.qwen'));
    for (const dir of dirs) {
      try {
        watchers.push(
          watch(dir, (_event, filename) => {
            // filename can be null on some platforms/events → trigger anyway
            // (the watched dirs are tiny; debounce collapses spurious wakes).
            if (filename === null || filename === 'policy.yaml') {
              activeReloader.trigger();
            }
            if (filename === null || filename === 'routing.yaml') {
              activeRoutingReloader?.trigger();
            }
          }),
        );
      } catch {
        // Missing/unwatchable dir → no hot-reload for that layer.
      }
    }
  }

  // Rate-table hot-reload (add-cost-tracking): watch ~/.qwen/rc for
  // model-rates.yaml; a valid edit swaps the live table within the 250ms debounce,
  // a malformed edit retains the previous table and audits rate_table_parse_failed.
  if (usageStore) {
    rateReloader = createRateTableReloader(rateTablePath(), rates, {
      onParseFailed: (message) =>
        void audit.record({
          action: 'rate_table_parse_failed',
          detail: { message },
        }),
    });
    try {
      watchers.push(
        watch(join(homedir(), '.qwen', 'rc'), (_event, filename) => {
          if (filename === null || filename === 'model-rates.yaml') {
            rateReloader!.trigger();
          }
        }),
      );
    } catch {
      // Missing/unwatchable dir → rate table simply won't hot-reload.
    }
  }

  const port = opts.gatewayPort ?? 4170;
  // http vs native-TLS https per the bind decision. The cert/key were already
  // read+validated above (before startDaemon) so a bad path fails fast without
  // orphaning the daemon; here we just hand the buffers to the https server.
  const listener = acmeTls
    ? createHttpsServer({ SNICallback: acmeTls.sniCallback }, app)
    : tlsMaterial
      ? createHttpsServer(tlsMaterial, app)
      : app;
  const scheme = bind.mode === 'tls' || bind.mode === 'acme' ? 'https' : 'http';
  // mDNS advertise/suppress decision (add-mdns-discovery). Only a native-TLS
  // bind advertises; loopback and insecure-proxy are suppressed (the latter
  // because the upstream proxy, not this cleartext bind, is the right mDNS
  // source). The synchronous decision drives the banner; the actual publish is
  // async (it dynamically loads the optional bonjour-service library).
  const mdns = mdnsDecision({
    bindMode: bind.mode,
    noMdnsFlag: opts.noMdns,
    envDisabled: process.env.QWEN_RC_NO_MDNS === '1',
  });
  listener.listen(port, bind.host, () => {
    const { code, expiresAt } = pairing.mint([
      OWNER,
      SESSION_READ,
      APPROVE,
      WRITE,
    ]);
    // Write the bootstrap code to the secrets dir (0700) as a 0600 file; print
    // only the path to stdout — never the code (pairing-auth spec invariant).
    const rcDir = join(homedir(), '.qwen', 'rc');
    const { path: bootstrapPath } = writeBootstrapCode(rcDir, code);
    const banner = [
      `qwen-rc gateway listening on ${scheme}://${bind.host}:${port}`,
      `web viewer: ${scheme}://${bind.host}:${port}/ui/`,
    ];
    if (bind.mode === 'insecure-proxy') {
      banner.push(
        '⚠ bound non-loopback as PLAIN HTTP (--insecure-behind-proxy): a ' +
          'TLS-terminating reverse proxy MUST front this gateway, or bearer ' +
          'tokens transit in cleartext.',
      );
    } else if (bind.mode === 'tls') {
      banner.push('TLS: native termination enabled');
    } else if (bind.mode === 'acme') {
      banner.push(
        `TLS: auto Let's Encrypt (${opts.acmeStaging ? 'staging' : 'production'}), auto-renewing`,
      );
    }
    // TLS fingerprint: SHA-256 of the DER-encoded leaf cert, formatted as
    // uppercase hex pairs separated by spaces (e.g. "A1B2 C3D4 …"). Included
    // in the pairing banner so the owner can pin the cert out-of-band.
    if (tlsCertPem) {
      const fingerprint = tlsCertFingerprint(tlsCertPem);
      if (fingerprint) {
        banner.push(`TLS fingerprint (SHA-256): ${fingerprint}`);
      }
    }
    banner.push(
      `webpush: enabled (key ${vapid.getApplicationServerKey().slice(0, 8)}…)`,
      `policy: ${policy.rules.length === 0 ? 'default-prompt' : `${policy.rules.length} rule(s)`}`,
      `routing: ${routingRuleCount === 0 ? 'none' : `${routingRuleCount} rule(s)`}`,
      displayHint(bootstrapPath),
      `  (expires ${new Date(expiresAt).toISOString()}, grants [${OWNER}, ${SESSION_READ}, ${APPROVE}, ${WRITE}])`,
      `redeem: POST /rc/pair/redeem { "code": "<see ${bootstrapPath}>", "label": "<name>" }`,
    );
    banner.push(`mDNS: ${mdnsBannerLine(mdns.reason)}`);
    // eslint-disable-next-line no-console
    console.log(banner.join('\n'));
    if (mdns.advertise) {
      // Publish asynchronously: derive names (workspace basename or override),
      // build the strict TXT record, load the optional library, and register.
      // A missing library or publish failure disables advertising, never the
      // gateway. mdnsAdvertiser is set so /rc/capabilities + shutdown see it.
      const workspace = deriveWorkspaceName(
        workspaceCwd ?? process.cwd(),
        opts.mdnsWorkspaceName,
      );
      const instanceName = deriveInstanceName(
        hostname(),
        workspace,
        opts.mdnsInstanceName,
      );
      const txt = buildTxtRecord({
        name: instanceName,
        workspace,
        tlsRequired: bind.tlsRequired,
      });
      void loadBonjourFactory()
        .then((factory) => {
          if (!factory) {
            // eslint-disable-next-line no-console
            console.warn(
              `${MDNS_UNAVAILABLE_KEYWORD}: optional bonjour-service dependency not installed`,
            );
            return;
          }
          const adv = new MdnsAdvertiser({ instanceName, port, txt, factory });
          adv.start();
          mdnsAdvertiser = adv;
          // eslint-disable-next-line no-console
          console.log(
            `mDNS: advertising "${instanceName}" on ${bind.host}:${port} ` +
              `(workspace=${workspace}, tlsRequired=${txt.tlsRequired}; use --no-mdns to disable)`,
          );
        })
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.warn(
            `mDNS: advertising failed: ${(err as Error).message ?? err}`,
          );
        });
    }
  });

  // Idle suggestions (proposal `add-idle-suggestions`): build the gateway-own
  // handler that fires on a session's active-prompt true→false edge WHENEVER a
  // coherent model endpoint resolves — but the `enabled` flag (read live at fire
  // time from idle.yaml) is the SOLE egress guard, OFF by default, so a
  // workstation that merely has model creds in its env never ships transcript
  // content to a model without the operator opting in. No coherent (key,host) →
  // no handler (a model call is impossible anyway). The handler never touches the
  // daemon session (option B) and degrades to silence on any failure. The config,
  // limiter, and toggle store were created above (so /suggest status can read
  // them); here we wire the handler that consumes them.
  let onSessionIdle:
    | ((sessionId: string, workspaceCwd: string) => void)
    | undefined;
  if (suggestCfg) {
    const idleHandle = createIdleSuggestionHandler({
      chat: createChatTransport(suggestCfg),
      bus: ownerEvents,
      audit,
      getConfig: () => idleConfig,
      limiter: idleLimiter,
      // Per-session `/suggest off` override (narrows only — never widens past the
      // global egress gate above).
      getSessionEnabled: (id) => idleToggles.get(id),
    });
    onSessionIdle = idleHandle.onSessionIdle;
    // eslint-disable-next-line no-console
    console.log(
      idleConfig.enabled
        ? `idle suggestions: enabled (model ${suggestCfg.model}, ` +
            `${idleConfig.maxSuggestionsPerHour}/hr)`
        : 'idle suggestions: available but disabled ' +
            '(set `enabled: true` in ~/.qwen/rc/idle.yaml)',
    );

    // Hot-reload idle.yaml (debounced 250 ms): on a successful reparse, mutate
    // the shared `idleConfig` ref IN PLACE (the handler reads it live, so the new
    // enabled/maxSuggestions* apply on the next idle edge with no rebuild). A
    // parse error RETAINS the previous good config and audits
    // idle_config_parse_failed (never crashes/widens on a half-typed save —
    // mirrors the policy reloader). A deleted file reverts to shipped defaults.
    // The env force (QWEN_RC_IDLE_SUGGESTIONS) is re-applied each reload so a file
    // edit can't silently disable an env-enabled feature.
    const idlePath = join(homedir(), '.qwen', 'rc', 'idle.yaml');
    const forceIdleEnabled = resolveIdleEnabled();
    let idleReloadTimer: ReturnType<typeof setTimeout> | undefined;
    const reloadIdle = (): void => {
      if (idleReloadTimer) clearTimeout(idleReloadTimer);
      idleReloadTimer = setTimeout(() => {
        void (async () => {
          let text: string;
          try {
            text = await readFile(idlePath, 'utf8');
          } catch {
            // Deleted/unreadable → revert to shipped defaults (+ env force).
            Object.assign(idleConfig, DEFAULT_IDLE_CONFIG);
            if (forceIdleEnabled) idleConfig.enabled = true;
            return;
          }
          try {
            Object.assign(
              idleConfig,
              applyIdleReload(text, { forceEnabled: forceIdleEnabled }),
            );
            // eslint-disable-next-line no-console
            console.log(
              `idle: reloaded (enabled=${idleConfig.enabled}, ` +
                `${idleConfig.maxSuggestionsPerHour}/hr)`,
            );
          } catch (err) {
            void audit.record({
              action: 'idle_config_parse_failed',
              detail: { reason: (err as Error)?.name ?? 'error' },
            });
            // eslint-disable-next-line no-console
            console.warn('idle: reload failed, keeping previous config');
          }
        })();
      }, 250);
      if (
        typeof idleReloadTimer === 'object' &&
        idleReloadTimer &&
        'unref' in idleReloadTimer
      ) {
        (idleReloadTimer as { unref: () => void }).unref();
      }
    };
    try {
      watchers.push(
        watch(join(homedir(), '.qwen', 'rc'), (_event, filename) => {
          if (filename === null || filename === 'idle.yaml') reloadIdle();
        }),
      );
    } catch {
      // Missing/unwatchable dir → no idle hot-reload (boot value stands).
    }
  }

  // Hold the gateway's own daemon subscriptions so push fires with no browser
  // open. Best-effort: start() always resolves, even if the daemon is unhappy.
  // The session-event pump runs when EITHER push is configured OR cost tracking
  // is on (cost ingestion must see every session_update, independent of push).
  let pump: SessionEventPump | undefined;
  if (notifier || usageIngester || agentLifecycle || reviewLifecycle) {
    pump = new SessionEventPump(handle.daemon, notifier, {
      enforcer, // already notifier-gated (undefined when push off) → no auto-vote change
      // Idle suggestions previously rode on the push pump (they only ran when a
      // notifier was present). Keep that coupling: a cost-only pump (push off) must
      // NOT newly activate idle suggestions — enabling cost tracking must not change
      // idle behavior. So gate the idle hook on `notifier`, not just `onSessionIdle`.
      ...(onSessionIdle && notifier ? { onSessionIdle } : {}),
      onEvent: (sid: string, ev: { type: string; data: unknown }) => {
        usageIngester?.ingest(sid, ev.data, sessionAttribution.get(sid));
        // Fire-and-forget: lifecycle transitions must never block or
        // break the pump's subscribe loop.
        agentLifecycle
          ?.handleSessionEvent(sid, {
            type: ev.type,
            data: ev.data,
          })
          .catch(() => {});
        // Review lifecycle (add-remote-review): a mid-review daemon
        // session_died drives the review to `failed` and emits
        // review_failed — the wire-protocol registry promise. Same
        // fire-and-forget contract as agents above.
        void reviewLifecycle
          ?.handleSessionEvent(sid, { type: ev.type, data: ev.data })
          .catch(() => {});
        // Approval-mode forward (add-remote-approval-mode): the daemon's own
        // approval_mode_changed event is the single source of truth for the
        // owner-stream frame — the route (routes/approvalMode.ts) deliberately
        // does not publish/notify itself, so this is the ONLY owner-bus
        // broadcast per change. The forward publishes to `ownerEvents` ONLY;
        // it does NOT also call notifier.notify — the push for this event is
        // already delivered by this same pump's own universal notify path
        // just above (`await this.notifier?.notify(...)` in
        // SessionEventPump.runLoop, pump.ts), identical to how every other
        // event type reaches push. Calling notify again here previously
        // double-pushed (verified bug, fixed by removing the forward's
        // notifier param). Bounded by the pump running at all
        // (notifier || usageIngester || agentLifecycle || reviewLifecycle),
        // per the design's documented "pump must be subscribed" residual.
        if (ev.type === 'approval_mode_changed') {
          forwardApprovalModeChange(sid, ev.data, ownerEvents);
        }
      },
    });
    await pump.start();
    const consumers: string[] = [];
    if (notifier) consumers.push('push');
    if (usageIngester) consumers.push('cost tracking');
    if (agentLifecycle) consumers.push('agents');
    if (reviewLifecycle) consumers.push('reviews');
    // eslint-disable-next-line no-console
    console.log(`session pump: started (${consumers.join(', ')})`);
  }

  // End-of-quiet-window digest flush (webpush D4, cycle 75): poll on an unref'd
  // interval so a "while you were away" digest fires the moment each
  // subscription leaves its quiet window. flushQuietDigests is sync and never
  // throws (best-effort send); the only behaviour it can add is an extra digest
  // push, never a suppressed prompt. Re-reads the live subscription list each
  // tick, so PATCH-quietHours / unsubscribe need no per-sub timer plumbing.
  let quietDigestTimer: NodeJS.Timeout | undefined;
  if (notifier) {
    const intervalMs = Number(process.env.QWEN_RC_QUIET_DIGEST_MS) || 60000;
    quietDigestTimer = setInterval(
      () => notifier.flushQuietDigests(),
      intervalMs,
    );
    quietDigestTimer.unref();
  }

  // In-process bridges (add-{telegram,discord,matrix}-bridge), opt-in. The HYBRID:
  // each runs in THIS process but talks the gateway ONLY over the loopback contract
  // with an OPERATOR-MINTED bridge token (QWEN_BRIDGE_TOKEN) — never an auto-minted
  // internal token — so it stays extractable to a sidecar by changing only config.
  // Construction is shared with the standalone sidecar via startBridge; the pure
  // resolver decides which bridges are configured (and threads MATRIX_ENABLE_E2EE
  // into the in-process Matrix bridge too). Transport is loopback; deeplinks use
  // QWEN_DAEMON_URL when set (a phone can't reach loopback).
  const startedBridges: StartedBridge[] = [];
  {
    const { plans, warnings } = resolveInProcessBridges(process.env, {
      port,
      homeDir: homedir(),
    });
    for (const w of warnings) {
      // eslint-disable-next-line no-console
      console.warn(w);
    }
    for (const plan of plans) {
      // Matrix fail-fast (in-process analog: log + don't start, never kill the
      // gateway): the configured MXID must match the access token's identity.
      // Bounded by a 5s timeout; on timeout or a network error `userId` is
      // undefined → fail-open (the bridge starts) rather than wedging boot.
      if (plan.cfg.kind === 'matrix') {
        let whoamiUserId: string | undefined;
        try {
          const mxRest = new MatrixRestApi({
            homeserverUrl: plan.cfg.homeserverUrl,
            accessToken: plan.cfg.accessToken,
          });
          whoamiUserId = (await mxRest.whoami(AbortSignal.timeout(5000)))
            .userId;
        } catch {
          // Unreachable/slow homeserver → fail-open (do not block the gateway).
        }
        const mismatch = checkMxid(whoamiUserId, plan.cfg.userId);
        if (mismatch) {
          // eslint-disable-next-line no-console
          console.warn(`matrix bridge: ${mismatch}. Bridge NOT started.`);
          continue;
        }
      }
      startedBridges.push(
        await startBridge(plan.cfg, {
          token: plan.token,
          deeplinkUrl: plan.deeplinkUrl,
          ...(plan.healthzPort != null
            ? { healthzPort: plan.healthzPort }
            : {}),
          // eslint-disable-next-line no-console
          log: (m) => console.log(m),
        }),
      );
      // eslint-disable-next-line no-console
      console.log(
        `${plan.cfg.kind} bridge: started (in-process, loopback contract)`,
      );
    }
  }

  const shutdown = async () => {
    for (const w of watchers) w.close();
    reloader?.stop();
    routingReloader?.stop();
    rateReloader?.stop();
    if (quietDigestTimer) clearInterval(quietDigestTimer);
    clearInterval(bridgeReaper);
    for (const b of startedBridges) b.stop();
    // mDNS Goodbye (design D4): withdraw the advertisement so a stale record does
    // not haunt the LAN for the 75-min TTL; bounded to 500 ms.
    if (mdnsAdvertiser) await mdnsAdvertiser.stop(500);
    if (pump) await pump.stop();
    acmeManager?.stop();
    // Stop every workspace daemon the pool spawned (add-multi-workspace
    // -daemon-pool) alongside the boot daemon below — otherwise a POST
    // /session { cwd } that spawned a pooled `qwen serve` leaves it running
    // as an orphan after the gateway exits.
    await daemonPool.stopAll();
    await handle.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/** Read all of stdin as UTF-8 (used by `routing test` when no positional). */
async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Dynamically load the BM25 index module (the ONLY importer of the NATIVE,
 * OPTIONAL `better-sqlite3`). When the optional dep is absent or its native
 * build failed, exit 1 with an actionable hint instead of a cryptic stack — so
 * `qwen serve` (which never loads this) installs and runs regardless.
 */
async function loadSearchIndexModule(): Promise<
  typeof import('./search/searchIndex.js')
> {
  try {
    return await import('./search/searchIndex.js');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const msg = (err as Error).message ?? '';
    if (
      code === 'ERR_MODULE_NOT_FOUND' ||
      code === 'MODULE_NOT_FOUND' ||
      /better[-_]sqlite3/.test(msg)
    ) {
      // eslint-disable-next-line no-console
      console.error(
        'ranked search needs the optional better-sqlite3 dependency — run: npm install better-sqlite3',
      );
      process.exit(1);
    }
    throw err;
  }
}

/**
 * Open the cost-tracking usage store, or return undefined to DISABLE cost
 * tracking when the optional native `better-sqlite3` build is absent (unlike
 * ranked search, a missing dep here must not stop the gateway — cost tracking is
 * simply off). The store dynamically imports the native dep, so this is the only
 * place that can throw a module-not-found for it on the serve path.
 */
async function openUsageStore(): Promise<
  import('./cost/usageStore.js').UsageStore | undefined
> {
  try {
    const { UsageStore } = await import('./cost/usageStore.js');
    return UsageStore.open(join(homedir(), '.qwen', 'rc', 'usage.db'));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const msg = (err as Error).message ?? '';
    if (
      code === 'ERR_MODULE_NOT_FOUND' ||
      code === 'MODULE_NOT_FOUND' ||
      /better[-_]sqlite3/.test(msg)
    ) {
      // eslint-disable-next-line no-console
      console.warn(
        'cost tracking disabled: optional better-sqlite3 dependency not built',
      );
      return undefined;
    }
    // eslint-disable-next-line no-console
    console.warn('cost tracking disabled: failed to open usage store:', msg);
    return undefined;
  }
}

/**
 * Compute the SHA-256 fingerprint of a PEM certificate's DER bytes, formatted
 * as uppercase hex pairs separated by spaces (e.g. `A1B2 C3D4 …`).  Returns
 * `undefined` when the PEM cannot be parsed (rather than throwing), so a
 * malformed cert never crashes the startup banner.
 *
 * Algorithm: strip the PEM armor, base64-decode to DER, SHA-256 the DER, format
 * as `XX XX …` using only the FIRST PEM block (the leaf certificate).
 */
function tlsCertFingerprint(pem: string): string | undefined {
  try {
    // Extract the first PEM block body (leaf cert, before any intermediates).
    const match =
      /-----BEGIN CERTIFICATE-----\r?\n([\s\S]+?)\r?\n-----END CERTIFICATE-----/.exec(
        pem,
      );
    if (!match) return undefined;
    const der = Buffer.from(match[1].replace(/\r?\n/g, ''), 'base64');
    const hash = createHash('sha256').update(der).digest('hex').toUpperCase();
    // Group into 4-char chunks separated by spaces: "A1B2 C3D4 E5F6 …"
    return hash.match(/.{1,4}/g)!.join(' ');
  } catch {
    return undefined;
  }
}

/** One-line mDNS status for the startup banner (transparency: design open-Q 1). */
function mdnsBannerLine(reason: MdnsSuppressReason): string {
  switch (reason) {
    case 'loopback':
      return 'suppressed (loopback-only bind)';
    case 'insecure-proxy':
      return 'suppressed (insecure-proxy bind — the upstream proxy should advertise)';
    case 'flag':
      return 'disabled by --no-mdns';
    case 'env':
      return 'disabled by QWEN_RC_NO_MDNS';
    default:
      return 'advertising (registering shortly)';
  }
}

/**
 * Dynamically load the OPTIONAL `bonjour-service` library and return a factory
 * for a fresh instance, or `null` when the dependency is not installed (mDNS is
 * then simply off — it must never stop the gateway, mirroring the cost-store
 * loader). Any non-module-not-found error propagates.
 */
async function loadBonjourFactory(): Promise<BonjourFactory | null> {
  try {
    const mod = await import('bonjour-service');
    const Bonjour = mod.Bonjour;
    return () => new Bonjour() as unknown as ReturnType<BonjourFactory>;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const msg = (err as Error).message ?? '';
    if (
      code === 'ERR_MODULE_NOT_FOUND' ||
      code === 'MODULE_NOT_FOUND' ||
      /bonjour-service/.test(msg)
    ) {
      return null;
    }
    throw err;
  }
}

/** Prompt the operator for a y/N confirmation on stdin (prune without --yes). */
async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) =>
      rl.question(question, resolve),
    );
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

// Entrypoint: `qwen-rc serve`
if (process.argv[2] === 'serve') {
  // Flags: --host <h> --tls <cert> --tls-key <key> --insecure-behind-proxy
  //        --port <n> --daemon-port <n> --no-mdns --mdns-workspace-name <s>
  //        --mdns-instance-name <s> --attach-daemon <url> --daemon-token <tok>
  //        --acme-domain <d[,d]> --acme-email <e> --acme-dns-provider <route53|cloudflare>
  //        --acme-staging --acme-directory <url>
  const argv = process.argv.slice(3);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    if (i >= 0) return argv[i + 1];
    const eq = argv.find((a) => a.startsWith(`--${name}=`));
    return eq ? eq.slice(name.length + 3) : undefined;
  };
  const port = flag('port');
  const daemonPort = flag('daemon-port');
  const acmeDomain = flag('acme-domain');
  const serveOpts: ServeOptions = {
    host: flag('host'),
    tlsCert: flag('tls'),
    tlsKey: flag('tls-key'),
    insecureBehindProxy: argv.includes('--insecure-behind-proxy'),
    gatewayPort: port ? Number(port) : undefined,
    daemonPort: daemonPort ? Number(daemonPort) : undefined,
    noMdns: argv.includes('--no-mdns'),
    mdnsWorkspaceName: flag('mdns-workspace-name'),
    mdnsInstanceName: flag('mdns-instance-name'),
    // Handoff Phase 1: attach to an existing daemon instead of spawning.
    attachDaemonUrl: flag('attach-daemon') ?? process.env.QWEN_RC_DAEMON_URL,
    attachDaemonToken: flag('daemon-token') ?? process.env.QWEN_RC_DAEMON_TOKEN,
    // Auto TLS (Let's Encrypt, DNS-01). Provider creds come from env.
    acmeDomains: acmeDomain
      ? acmeDomain
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
    acmeEmail: flag('acme-email'),
    acmeDnsProvider: flag('acme-dns-provider'),
    acmeStaging: argv.includes('--acme-staging'),
    acmeDirectoryUrl: flag('acme-directory'),
  };
  runServe(serveOpts).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(
      err instanceof BindSecurityError || err instanceof MdnsConfigError
        ? `qwen-rc serve: ${err.message}`
        : `qwen-rc serve failed: ${err instanceof Error ? (err.stack ?? err.message) : err}`,
    );
    process.exit(1);
  });
} else if (process.argv[2] === 'policy' && process.argv[3] === 'lint') {
  // `qwen-rc policy lint <file>` — daemon-free schema check (exit 0 valid,
  // 1 invalid, 2 usage). The bug-prone logic is in the pure, unit-tested
  // lintPolicyFile/formatPolicyLint; this is trivial glue.
  const file = process.argv[4];
  if (!file) {
    // eslint-disable-next-line no-console
    console.error('usage: qwen-rc policy lint <file>');
    process.exit(2);
  }
  lintPolicyFile(file).then((result) => {
    // eslint-disable-next-line no-console
    console.log(formatPolicyLint(file, result));
    process.exit(result.ok ? 0 : 1);
  });
} else if (process.argv[2] === 'policy' && process.argv[3] === 'explain') {
  // `qwen-rc policy explain <toolName> [--args=…] [--path=…] [--operation=…]
  // [--scope=…] [--tag=…] [--project-root=…]` — daemon-free dry-run of the
  // layered policy (user ~/.qwen/rc/policy.yaml + <project-root>/.qwen/policy.yaml).
  // Read-only INSPECTOR: exit 0 on success, 2 on a missing tool or an invalid
  // `--operation` value, 1 when the policy is malformed (it cannot be
  // explained — surface the loader error rather than pretend). The bug-prone
  // logic is in the pure, unit-tested parseExplainArgs/explainPolicy/
  // formatExplanation; this is glue. No quota oracle (no live store) → a
  // maxPerWindow rule shows as prompt, as formatExplanation's caveat notes.
  // `--operation` populates `ctx.operations` (without it, a rule using
  // `match.operation` always reported `operation-mismatch` here, even when
  // it would match in production). `--project-root` overrides the
  // `process.cwd()` default for both the evaluator's anchor
  // (`ctx.projectRoot`/`ctx.cwd`) and the workspace policy-file layer below —
  // running `explain` from outside the daemon's actual workspace otherwise
  // yields a verdict that can diverge from real enforcement.
  let tool: string | undefined;
  let ctx: ReturnType<typeof parseExplainArgs>['ctx'];
  try {
    ({ tool, ctx } = parseExplainArgs(process.argv.slice(4)));
  } catch (err) {
    if (err instanceof ExplainArgsError) {
      // eslint-disable-next-line no-console
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }
  if (!tool) {
    // eslint-disable-next-line no-console
    console.error(
      'usage: qwen-rc policy explain <toolName> [--args=…] [--path=…] ' +
        '[--operation=read|write|execute] [--scope=…] [--tag=…] ' +
        '[--project-root=…]',
    );
    process.exit(2);
  }
  loadLayeredPolicy(
    join(homedir(), '.qwen', 'rc', 'policy.yaml'),
    ctx.projectRoot,
    // eslint-disable-next-line no-console
    (msg) => console.warn(msg),
  )
    .then((policy) => {
      // eslint-disable-next-line no-console
      console.log(`policy explain: tool=${tool}`);
      // eslint-disable-next-line no-console
      console.log(formatExplanation(explainPolicy(policy, ctx)));
      process.exit(0);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`cannot explain: ${(err as Error).message}`);
      process.exit(1);
    });
} else if (process.argv[2] === 'routing' && process.argv[3] === 'rules') {
  // `qwen-rc routing rules [--resolved]` — print the effective routing ruleset.
  // Read-only INSPECTOR (always exit 0): a malformed file fail-opens (logged +
  // omitted), faithfully reflecting the gateway's suppress-only behavior — NOT a
  // lint. `--resolved` overlays the workspace file from the current directory.
  const resolved = process.argv.includes('--resolved');
  loadResolvedRoutingRules(
    join(homedir(), '.qwen', 'rc', 'routing.yaml'),
    resolved ? process.cwd() : undefined,
    // eslint-disable-next-line no-console
    (msg) => console.warn(msg),
  ).then((rules) => {
    // eslint-disable-next-line no-console
    console.log(formatResolvedRouting(rules));
    process.exit(0);
  });
} else if (process.argv[2] === 'routing' && process.argv[3] === 'test') {
  // `qwen-rc routing test [<event-json>] [--sub=<scopes>[@id]]... [--resolved]`
  // Daemon-free dry-run of the routing.yaml DROP layer ONLY (the output carries
  // a NOTE that downstream gates - snooze/prefs/quiet-hours/working-device/
  // rate-limit - are NOT considered). INSPECTOR: exit 0 on success, 2 on a
  // usage/parse error. The routing config FAIL-OPENS, so there is no exit 1.
  void (async () => {
    const argv = process.argv.slice(4);
    // Read stdin ONLY when no positional event was given AND stdin is piped:
    // an isTTY-only guard would block forever when a positional IS supplied but
    // stdin is a non-TTY handle that never delivers EOF (e.g. a CI pipe).
    const hasPositional = argv.some((a) => !a.startsWith('--'));
    const stdin =
      hasPositional || process.stdin.isTTY ? null : await readAllStdin();
    const parsed = parseRoutingTest(argv, stdin);
    if (!parsed.ok) {
      // eslint-disable-next-line no-console
      console.error(parsed.error);
      process.exit(2);
      return;
    }
    const { request } = parsed;
    const { matcher, ruleCount } = await loadLayeredRoutingMatcher(
      join(homedir(), '.qwen', 'rc', 'routing.yaml'),
      request.resolved ? process.cwd() : undefined,
      // eslint-disable-next-line no-console
      (msg) => console.warn(msg),
    );
    // eslint-disable-next-line no-console
    console.log(
      formatRoutingTest(evaluateRoutingTest(matcher, request, ruleCount)),
    );
    process.exit(0);
  })().catch((err: unknown) => {
    // The only throw source is readAllStdin (the matcher load never throws, the
    // trio is pure). Keep the inspector's exit-code contract (0/2, never a raw
    // exit 1 from an unhandled rejection).
    // eslint-disable-next-line no-console
    console.error(`routing test: ${(err as Error).message}`);
    process.exit(2);
  });
} else if (process.argv[2] === 'search') {
  // `qwen-rc search <query…> [--cwd=…] [--kind=…] [--since=…] [--until=…]
  // [--limit=…] [--session=…] [--daemon <name>|--url <u>] [--token <t>]
  // [--insecure]` — on-disk transcript search, daemon-free by default:
  // derives the chats dir from --cwd (default cwd) via the exact
  // resolveChatsDir and reuses searchTranscriptsDetailed (identical matcher
  // to the HTTP route). add-multi-workspace-client task 1.4: with a target
  // flag OR a non-empty registry the query goes to GET <daemon>/rc/search
  // instead (the daemon's OWN workspace; --cwd is then ignored, --rank maps
  // to ?rank=bm25 which the daemon answers with its index or a transparent
  // scan fallback). The bug-prone logic is in the pure, unit-tested
  // parseSearchArgs/formatSearchResults/buildSearchApiQuery; this is glue.
  // Exit 0 on success (incl. 0 hits), 2 on usage, 1 on runtime failure.
  void (async () => {
    let split;
    try {
      split = splitTargetFlags(process.argv.slice(3));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`search: ${(e as Error).message}`);
      process.exit(2);
      return;
    }
    const parsed = parseSearchArgs(split.core);
    if (!parsed.ok) {
      // eslint-disable-next-line no-console
      console.error(parsed.error);
      process.exit(2);
      return;
    }
    // `--rank`: a relevance-ranked (BM25) query over the prebuilt FTS5 index
    // instead of the live substring scan. TOKEN/prefix matching — deliberately
    // different hits/order from the default scan; build the index with
    // `qwen-rc reindex` first. The NATIVE better-sqlite3 is loaded HERE via a
    // dynamic import, so `qwen serve` / the gateway never load the addon.
    // `--json` switches stdout to a stable JSON object; stderr hints (empty
    // index / short-term floor) still go to stderr so stdout stays clean JSON.
    const render = (result: import('./search/transcripts.js').SearchResult) =>
      parsed.value.json
        ? formatSearchResultsJson(result)
        : formatSearchResults(result);
    const resolved = await resolveCliDaemonTarget(split);
    if (!resolved.ok) {
      // eslint-disable-next-line no-console
      console.error(`search: ${resolved.error}`);
      process.exit(resolved.exitCode);
      return;
    }
    if (resolved.target) {
      const { target } = resolved;
      if (!target.token) {
        // eslint-disable-next-line no-console
        console.error(
          `search: no token for daemon "${target.name}" — pass --token <t> or ` +
            `register + pair first: qwen-rc daemons add <name> <url>`,
        );
        process.exit(1);
        return;
      }
      if (parsed.value.cwd) {
        // eslint-disable-next-line no-console
        console.error(
          `(remote daemon "${target.name}" — --cwd is ignored; its own workspace is searched)`,
        );
      }
      const res = await daemonRequest(target, {
        method: 'GET',
        path: `/rc/search?${buildSearchApiQuery(parsed.value)}`,
        insecure: resolved.insecure,
      });
      // eslint-disable-next-line no-console
      console.log(render(searchFromApiResponse(res.json)));
      process.exit(0);
      return;
    }
    if (parsed.value.rank) {
      const { SearchIndex } = await loadSearchIndexModule();
      const dbPath = join(
        resolveSearchIndexDir(parsed.value.cwd ?? process.cwd()),
        'index.db',
      );
      const idx = SearchIndex.open(dbPath);
      try {
        if (idx.count() === 0) {
          // eslint-disable-next-line no-console
          console.error('(index empty — run: qwen-rc reindex)');
        }
        const result = idx.query(parsed.value.query, parsed.value.opts);
        // The trigram index can't match a term shorter than 3 chars (uniform
        // across scripts, incl. 2-char CJK words). When that yields nothing,
        // point the user at the default scan, which has no length floor.
        if (result.hits.length === 0) {
          const hasShort = parsed.value.query.split(/\s+/).some((t) => {
            const chars = [...t].filter((c) => /[\p{L}\p{N}]/u.test(c));
            return chars.length > 0 && chars.length < 3;
          });
          if (hasShort) {
            // eslint-disable-next-line no-console
            console.error(
              '(--rank matches terms ≥3 chars; for shorter terms use the default scan)',
            );
          }
        }
        // eslint-disable-next-line no-console
        console.log(render(result));
      } finally {
        idx.close();
      }
      process.exit(0);
      return;
    }
    const chatsDir = resolveChatsDir(parsed.value.cwd ?? process.cwd());
    const result = await searchTranscriptsDetailed(
      chatsDir,
      parsed.value.query,
      parsed.value.opts,
    );
    // eslint-disable-next-line no-console
    console.log(render(result));
    process.exit(0);
  })().catch((err: unknown) => {
    if (err instanceof DaemonHttpError && err.status === 401) {
      // eslint-disable-next-line no-console
      console.error(
        'search: token rejected (401) — re-pair: qwen-rc daemons remove <name> && qwen-rc daemons add <name> <url>',
      );
    } else if (err instanceof DaemonUnreachableError) {
      // eslint-disable-next-line no-console
      console.error(`search: ${err.message}`);
    } else {
      // The local scan never throws (no timeout); daemon mode can.
      // eslint-disable-next-line no-console
      console.error(`search: ${(err as Error).message}`);
    }
    process.exit(1);
  });
} else if (process.argv[2] === 'reindex') {
  // `qwen-rc reindex [--cwd=<dir>] [--full]` — update the BM25 full-text index
  // for a workspace's transcripts. DEFAULT is INCREMENTAL (only new/changed
  // files re-indexed, vanished files pruned via per-file mtime) — cheap to
  // re-run; `--full` forces a drop+rebuild. The index db lives under the
  // workspace's 0700 search-index dir. The NATIVE better-sqlite3 is loaded HERE
  // via a dynamic import, so `qwen serve` / the gateway never load the addon.
  void (async () => {
    const args = process.argv.slice(3);
    const cwdFlag = args.find((a) => a.startsWith('--cwd='));
    const cwd = cwdFlag ? cwdFlag.slice('--cwd='.length) : process.cwd();
    const full = args.includes('--full');
    const { SearchIndex } = await loadSearchIndexModule();
    const chatsDir = resolveChatsDir(cwd);
    const dbPath = join(resolveSearchIndexDir(cwd), 'index.db');
    const idx = SearchIndex.open(dbPath);
    try {
      if (full) {
        const { files, records } = idx.reindex(chatsDir);
        // eslint-disable-next-line no-console
        console.log(`indexed ${records} record(s) from ${files} file(s)`);
      } else {
        const { scanned, updated, removed, records } =
          idx.reindexIncremental(chatsDir);
        // eslint-disable-next-line no-console
        console.log(
          `reindexed ${updated} changed + ${removed} removed file(s) ` +
            `(${records} record(s); ${scanned} scanned). Use --full to rebuild.`,
        );
      }
    } finally {
      idx.close();
    }
    process.exit(0);
  })().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(`reindex: ${(err as Error).message}`);
    process.exit(1);
  });
} else if (process.argv[2] === 'usage' && process.argv[3] === 'prune') {
  // `qwen-rc usage prune --before <iso> [--yes]` — delete usage rows older than a
  // timestamp (add-cost-tracking "Operator CLI"). Prompts unless --yes.
  void (async () => {
    const store = await openUsageStore();
    if (!store) {
      // eslint-disable-next-line no-console
      console.error('cost tracking unavailable (better-sqlite3 not built)');
      process.exit(1);
    }
    let args;
    try {
      args = parsePruneArgs(process.argv.slice(4));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`usage prune: ${(e as Error).message}`);
      process.exit(2);
    }
    if (!args.yes) {
      const ok = await confirm(
        `Delete usage rows before ${new Date(args.beforeMs).toISOString()}? [y/N] `,
      );
      if (!ok) {
        // eslint-disable-next-line no-console
        console.log('aborted');
        process.exit(0);
      }
    }
    const removed = store.prune(args.beforeMs);
    store.close();
    // eslint-disable-next-line no-console
    console.log(`${removed} rows removed`);
    process.exit(0);
  })().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(`usage prune: ${(err as Error).message}`);
    process.exit(1);
  });
} else if (process.argv[2] === 'usage') {
  // `qwen-rc usage [--since <d>] [--group-by <axis>] [--sub-actor <s>]
  // [--format json|csv|table]` — query aggregated usage (add-cost-tracking). Reads
  // the same ~/.qwen/rc/usage.db the gateway writes; daemon-free.
  void (async () => {
    const store = await openUsageStore();
    if (!store) {
      // eslint-disable-next-line no-console
      console.error('cost tracking unavailable (better-sqlite3 not built)');
      process.exit(1);
    }
    let args;
    try {
      args = parseUsageArgs(process.argv.slice(3), Date.now());
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`usage: ${(e as Error).message}`);
      process.exit(2);
    }
    const rates = new RateTableHolder(DEFAULT_RATE_TABLE);
    try {
      rates.set(await loadRateTableFile(rateTablePath()));
    } catch {
      // keep defaults
    }
    const rows = store.aggregate({
      sinceMs: args.sinceMs,
      untilMs: Date.now(),
      groupBy: args.groupBy,
      subActor: args.subActor,
    });
    store.close();
    const MICRO = 1_000_000;
    const out: UsageResponseRow[] = rows.map((r) => ({
      key: r.key,
      displayLabel: r.key,
      tokensIn: r.tokensIn,
      tokensOut: r.tokensOut,
      tokensCached: r.tokensCached,
      costMicrocents: r.costMicrocents,
      costCents: r.costMicrocents / MICRO,
      efficiency: {
        costCentsPer1kOutputTokens:
          r.tokensOut > 0
            ? (r.costMicrocents / MICRO / r.tokensOut) * 1000
            : null,
        tokensPerDollar:
          r.costMicrocents > 0
            ? (r.tokensOut / (r.costMicrocents / MICRO)) * 100
            : null,
      },
    }));
    // eslint-disable-next-line no-console
    console.log(
      args.format === 'json'
        ? JSON.stringify(out, null, 2)
        : args.format === 'csv'
          ? formatUsageCsv(out)
          : formatUsageTable(out, rates.current().currencyLabel),
    );
    process.exit(0);
  })().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(`usage: ${(err as Error).message}`);
    process.exit(1);
  });
} else if (process.argv[2] === 'daemons' && process.argv[3] === 'discover') {
  // `qwen-rc daemons discover [--timeout <d>] [--format json|table]` — browse
  // the LAN for `_qwen-rc._tcp.local.` daemons (add-mdns-discovery). Daemon-free
  // and read-only; exits 0 even when nothing advertises. Needs the optional
  // bonjour-service dependency.
  void (async () => {
    let args;
    try {
      args = parseDiscoverArgs(process.argv.slice(4));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`daemons discover: ${(e as Error).message}`);
      process.exit(2);
    }
    const factory = await loadBonjourFactory();
    if (!factory) {
      // eslint-disable-next-line no-console
      console.error(
        'daemons discover: needs the optional bonjour-service dependency — run: npm install bonjour-service',
      );
      process.exit(1);
    }
    const records = await browseDaemons({
      factory: factory as unknown as BrowserFactory,
      timeoutMs: args.timeoutMs,
    });
    // eslint-disable-next-line no-console
    console.log(
      args.format === 'json'
        ? formatDaemonsJson(records)
        : formatDaemonsTable(records, args.timeoutMs),
    );
    process.exit(0);
  })().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(`daemons discover: ${(err as Error).message}`);
    process.exit(1);
  });
} else if (process.argv[2] === 'fork') {
  // `qwen-rc fork <sessionId> [--from-event <n>] [--mode include|empty]
  // [--name <s>] [--daemon <name>|--url <u>] [--token <t>] [--insecure]`
  // (add-session-forking task 3.4). POST /session/:id/fork (WRITE scope) and
  // print ONLY the new sessionId to stdout; hints go to stderr. This repo has
  // no interactive session REPL, so this command is also the terminal-client
  // "fork from here" (task 3.2). Pure logic: sessions/forkCli.ts.
  void (async () => {
    let split;
    try {
      split = splitTargetFlags(process.argv.slice(3));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`fork: ${(e as Error).message}`);
      process.exit(2);
      return;
    }
    const parsed = parseForkArgs(split.core);
    if (!parsed.ok) {
      // eslint-disable-next-line no-console
      console.error(parsed.error);
      process.exit(2);
      return;
    }
    const resolved = await resolveCliDaemonTarget(split, { required: true });
    if (!resolved.ok) {
      // eslint-disable-next-line no-console
      console.error(`fork: ${resolved.error}`);
      process.exit(resolved.exitCode);
      return;
    }
    const target = resolved.target!; // required: true → always set
    if (!target.token) {
      // eslint-disable-next-line no-console
      console.error(
        `fork: no token for daemon "${target.name}" — pass --token <t> or ` +
          `register + pair first: qwen-rc daemons add <name> <url>`,
      );
      process.exit(1);
      return;
    }
    const res = await daemonRequest(target, {
      method: 'POST',
      path: `/session/${parsed.value.sessionId}/fork`,
      body: buildForkPayload(parsed.value),
      insecure: resolved.insecure,
    });
    // eslint-disable-next-line no-console
    console.log(formatForkOutput(res.json));
    // eslint-disable-next-line no-console
    console.error(
      `forked ${parsed.value.sessionId} → see it in the session list: qwen-rc sessions`,
    );
    process.exit(0);
  })().catch((err: unknown) => {
    if (err instanceof DaemonHttpError && err.status === 401) {
      // eslint-disable-next-line no-console
      console.error(
        'fork: token rejected (401) — re-pair: qwen-rc daemons remove <name> && qwen-rc daemons add <name> <url>',
      );
    } else if (err instanceof DaemonHttpError && err.code === 'name_taken') {
      // eslint-disable-next-line no-console
      console.error(`fork: name already used in this workspace (409)`);
    } else if (
      err instanceof DaemonHttpError &&
      err.code === 'fork_mid_prompt'
    ) {
      // eslint-disable-next-line no-console
      console.error(
        'fork: parent is mid-prompt (409 fork_mid_prompt) — wait for the turn to settle and retry',
      );
    } else if (err instanceof DaemonUnreachableError) {
      // eslint-disable-next-line no-console
      console.error(`fork: ${err.message}`);
    } else {
      // eslint-disable-next-line no-console
      console.error(`fork: ${(err as Error).message}`);
    }
    process.exit(1);
  });
} else if (process.argv[2] === 'sessions') {
  // `qwen-rc sessions [--cwd <dir>] [--json] [--daemon <name>|--url <u>]
  // [--token <t>] [--insecure]` (add-session-forking task 3.3: "the terminal
  // renders a static tree with unicode box-drawing" + add-multi-workspace-
  // client task 1.4: `--daemon` threading). Zero-config (no target flags,
  // empty registry) stays DAEMON-FREE: it scans the on-disk chats dir via the
  // EXACT listSessions the daemon's GET /rc/sessions uses, so the tree can
  // never drift from the web UI's. With a target flag OR a non-empty
  // registry the SAME tree renders over GET <daemon>/rc/sessions (OWNER),
  // which is how a remote daemon's sessions are listed from this machine.
  void (async () => {
    let split;
    try {
      split = splitTargetFlags(process.argv.slice(3));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`sessions: ${(e as Error).message}`);
      process.exit(2);
      return;
    }
    const parsed = parseSessionsArgs(split.core);
    if (!parsed.ok) {
      // eslint-disable-next-line no-console
      console.error(parsed.error);
      process.exit(2);
      return;
    }
    const resolved = await resolveCliDaemonTarget(split);
    if (!resolved.ok) {
      // eslint-disable-next-line no-console
      console.error(`sessions: ${resolved.error}`);
      process.exit(resolved.exitCode);
      return;
    }
    let result: { sessions: SessionListItem[]; truncated: boolean };
    if (resolved.target) {
      const { target } = resolved;
      if (!target.token) {
        // eslint-disable-next-line no-console
        console.error(
          `sessions: no token for daemon "${target.name}" — pass --token <t> or ` +
            `register + pair first: qwen-rc daemons add <name> <url>`,
        );
        process.exit(1);
        return;
      }
      const res = await daemonRequest(target, {
        method: 'GET',
        path: sessionsApiPath(parsed.value.cwd),
        insecure: resolved.insecure,
      });
      result = sessionsFromApiResponse(res.json);
      if (parsed.value.cwd) {
        // eslint-disable-next-line no-console
        console.error(
          `(remote daemon "${target.name}" — --cwd selects a workspace on THAT daemon)`,
        );
      }
    } else {
      const chatsDir = resolveChatsDir(parsed.value.cwd ?? process.cwd());
      result = await listSessions(chatsDir);
    }
    // eslint-disable-next-line no-console
    console.log(
      parsed.value.json
        ? formatSessionsJson(result)
        : renderForkTree(buildForkTree(result.sessions)),
    );
    if (result.truncated) {
      // eslint-disable-next-line no-console
      console.error('(listing truncated at the scan cap)');
    }
    process.exit(0);
  })().catch((err: unknown) => {
    if (err instanceof DaemonHttpError && err.status === 401) {
      // eslint-disable-next-line no-console
      console.error(
        'sessions: token rejected (401) — re-pair: qwen-rc daemons remove <name> && qwen-rc daemons add <name> <url>',
      );
    } else if (err instanceof DaemonUnreachableError) {
      // eslint-disable-next-line no-console
      console.error(`sessions: ${err.message}`);
    } else {
      // eslint-disable-next-line no-console
      console.error(`sessions: ${(err as Error).message}`);
    }
    process.exit(1);
  });
} else if (process.argv[2] === 'daemons') {
  // `qwen-rc daemons <list|add|remove|set-default|health|whoami>` — the local
  // multi-daemon registry (add-multi-workspace-client task 1.3). Registry I/O:
  // ./daemons/registry.js (clients.toml); token I/O: ./daemons/tokenStore.js
  // (0600 files); pairing + probes: ./daemons/daemonClient.js. Pure parsing /
  // rendering: ./daemons/daemonsCli.js.
  void (async () => {
    const parsed = parseDaemonsArgs(process.argv.slice(3));
    if (!parsed.ok) {
      // eslint-disable-next-line no-console
      console.error(`daemons: ${parsed.error}`);
      process.exit(2);
      return;
    }
    const a = parsed.value;
    const registry = new DaemonRegistry();
    const tokens = new FileTokenStore();
    const tokensDir = defaultTokensDir();

    if (a.sub === 'list') {
      const entries = await registry.list();
      const defaultName = (await registry.getDefault())?.name;
      const rows = await Promise.all(
        entries.map(async (e): Promise<DaemonRow> => {
          const [tokenPresent, health] = await Promise.all([
            tokens.get(e.tokenStorageKey).then((t) => t !== undefined),
            probeHealth(e.url, 2000),
          ]);
          return {
            name: e.name,
            url: e.url,
            isDefault: e.name === defaultName,
            tokenPresent,
            health,
          };
        }),
      );
      if (a.format === 'json') {
        // First-time hint (spec "First-time creation": the registry file is
        // NOT auto-created — the hint goes to stderr so stdout stays
        // machine-readable).
        if (entries.length === 0) {
          // eslint-disable-next-line no-console
          console.error(
            'no daemons registered — add one: qwen-rc daemons add <name> <url>',
          );
        }
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(rows, null, 2));
      } else {
        // The table renderer carries the same hint for an empty list.
        // eslint-disable-next-line no-console
        console.log(formatDaemonsListTable(rows));
      }
      process.exit(0);
    } else if (a.sub === 'add') {
      const base = a.url!.replace(/\/+$/, '');
      const entries = await registry.list();
      const existing = entries.find((e) => e.name === a.name!);
      if (existing && !a.force) {
        // eslint-disable-next-line no-console
        console.error(
          `daemons add: "${a.name}" already exists (${existing.url}) — pass --force to replace`,
        );
        process.exit(1);
        return;
      }
      // Spec "Duplicate URL rejected": `daemon_url_duplicate` (exit 1) is
      // checked BEFORE any pairing, so a rejected add never touches the daemon
      // and the registry is trivially unchanged. Re-adding the SAME name+url
      // under --force is not a duplicate.
      const dupUrl = entries.find((e) => e.url === base && e.name !== a.name!);
      if (dupUrl) {
        // eslint-disable-next-line no-console
        console.error(
          `daemons add: daemon_url_duplicate: "${dupUrl.name}" already uses ${base} — remove it first: qwen-rc daemons remove ${dupUrl.name}`,
        );
        process.exit(1);
        return;
      }
      // 1. Probe: GET /rc/capabilities proves liveness AND identity — a
      //    qwen-rc daemon answers 2xx or an auth wall (401/403 pre-pairing),
      //    a foreign server 404s (spec code `not_a_qwen_daemon`). The bare
      //    /capabilities mount is the transparent-proxy alias: try it when the
      //    /rc/-prefixed path 404s.
      const probeCaps = async (
        path: string,
      ): Promise<'daemon' | 'not_found'> => {
        try {
          await daemonRequest(
            { url: base, ...(a.token ? { token: a.token } : {}) },
            { method: 'GET', path, timeoutMs: 5000, insecure: a.insecure },
          );
          return 'daemon';
        } catch (err) {
          if (err instanceof DaemonHttpError) {
            if (err.status === 401 || err.status === 403) return 'daemon';
            if (err.status === 404) return 'not_found';
          }
          throw err; // unreachable / other HTTP error → outer catch
        }
      };
      let caps = await probeCaps('/rc/capabilities');
      if (caps === 'not_found') caps = await probeCaps('/capabilities');
      if (caps === 'not_found') {
        // eslint-disable-next-line no-console
        console.error(
          `daemons add: not_a_qwen_daemon: ${base} answered 404 on /rc/capabilities (and /capabilities) — not a remote-control daemon`,
        );
        process.exit(1);
        return;
      }
      // 2. Trust confirmation (spec "Trust step on adding a daemon"): the
      //    warning MUST carry the arbitrary-JavaScript sentence, the answer
      //    defaults to NO, and declining writes nothing and pairs nothing.
      // eslint-disable-next-line no-console
      console.error(
        `\nTrust check — about to pair with ${base}\n` +
          '  This daemon can serve arbitrary JavaScript to your browser\n' +
          '  when you open its UI. The token will be stored at\n' +
          '  ~/.qwen/rc/tokens/ (0600); a daemon sees your session transcripts.\n',
      );
      let trustOk: boolean;
      if (a.yes) {
        trustOk = true;
      } else if (!process.stdin.isTTY) {
        // eslint-disable-next-line no-console
        console.error(
          'daemons add: trust confirmation required — re-run interactively, or pass --yes to confirm',
        );
        process.exit(2);
        return;
      } else {
        trustOk = await confirm('Continue? [y/N] ');
      }
      if (!trustOk) {
        // eslint-disable-next-line no-console
        console.log('aborted — no pairing attempted, registry unchanged');
        process.exit(0);
        return;
      }
      // 3. Pair (only after the trust confirmation).
      const key = a.tokenStorageKey ?? a.name!;
      let pairedScopes: string[] | undefined;
      let pairedTokenId: string | undefined;
      if (a.noPair) {
        // Bare registry entry; commands against it will prompt for a token.
      } else if (a.token !== undefined) {
        await tokens.set(key, a.token);
        // eslint-disable-next-line no-console
        console.error('stored the provided token (no pairing)');
      } else {
        let code = a.code;
        if (code === undefined) {
          if (!process.stdin.isTTY) {
            // eslint-disable-next-line no-console
            console.error(
              'daemons add: non-interactive stdin — pass --code <code> (or --token <t> / --no-pair)',
            );
            process.exit(2);
            return;
          }
          const rl = createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          try {
            code = await new Promise<string>((resolve) =>
              rl.question(
                `Pairing code for ${a.name} (shown by qwen-rc serve): `,
                resolve,
              ),
            );
          } finally {
            rl.close();
          }
        }
        const redeem = await daemonRequest(
          { url: base },
          {
            method: 'POST',
            path: '/rc/pair/redeem',
            body: { code: code.trim(), label: a.name! },
            timeoutMs: 10000,
            insecure: a.insecure,
          },
        );
        const body = redeem.json as {
          id?: unknown;
          token?: unknown;
          scopes?: unknown;
        };
        if (typeof body.token !== 'string') {
          throw new Error('pairing response missing the token');
        }
        await tokens.set(key, body.token);
        pairedTokenId = typeof body.id === 'string' ? body.id : undefined;
        pairedScopes = Array.isArray(body.scopes)
          ? body.scopes.map(String)
          : undefined;
        // eslint-disable-next-line no-console
        console.error(`paired with ${a.name}`);
      }
      const updated = await registry.upsert({
        name: a.name!,
        url: base,
        tokenStorageKey: key,
      });
      if (pairedTokenId && pairedScopes) {
        await writeTokenMeta(tokensDir, key, {
          tokenId: pairedTokenId,
          scopes: pairedScopes,
          label: a.name!,
          addedAt: new Date().toISOString(),
        });
      }
      if (updated.length === 1) {
        // eslint-disable-next-line no-console
        console.error(`added ${a.name} (now the default daemon)`);
      } else {
        // eslint-disable-next-line no-console
        console.error(
          `added ${a.name} (default unchanged: ${updated.find((e) => e.default)?.name ?? updated[0].name})`,
        );
      }
      // eslint-disable-next-line no-console
      console.error(
        'Note: the browser aggregation views need the owner to admit this UI origin on each daemon (POST /rc/cors).',
      );
      process.exit(0);
    } else if (a.sub === 'remove') {
      const entry = await registry.getByName(a.name!);
      if (!entry) {
        // eslint-disable-next-line no-console
        console.error(`daemons remove: unknown daemon "${a.name}"`);
        process.exit(1);
        return;
      }
      if (!a.yes) {
        const ok = await confirm(
          `Remove daemon "${a.name}"? (its token is revoked on the daemon, best-effort) [y/N] `,
        );
        if (!ok) {
          // eslint-disable-next-line no-console
          console.log('aborted');
          process.exit(0);
          return;
        }
      }
      const token = await tokens.get(entry.tokenStorageKey);
      const meta = await readTokenMeta(tokensDir, entry.tokenStorageKey);
      if (token && meta) {
        try {
          await daemonRequest(
            { url: entry.url, token },
            {
              method: 'DELETE',
              path: `/rc/tokens/${meta.tokenId}`,
              timeoutMs: 5000,
              insecure: a.insecure,
            },
          );
        } catch {
          // Best-effort per spec: the daemon may already be gone or the token
          // already revoked — the local entry still comes off.
          // eslint-disable-next-line no-console
          console.error(
            '(daemon unreachable or token already gone — local entry removed)',
          );
        }
      }
      await registry.remove(a.name!);
      await tokens.delete(entry.tokenStorageKey);
      await deleteTokenMeta(tokensDir, entry.tokenStorageKey);
      // eslint-disable-next-line no-console
      console.log(`removed ${a.name}`);
      process.exit(0);
    } else if (a.sub === 'set-default') {
      try {
        await registry.setDefault(a.name!);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`daemons set-default: ${(e as Error).message}`);
        process.exit(1);
        return;
      }
      // eslint-disable-next-line no-console
      console.log(`default daemon: ${a.name}`);
      process.exit(0);
    } else if (a.sub === 'health') {
      const entries = await registry.list();
      let targets = entries;
      if (!a.all && a.daemonName !== undefined) {
        const one = entries.find((e) => e.name === a.daemonName);
        if (!one) {
          // eslint-disable-next-line no-console
          console.error(`daemons health: unknown daemon "${a.daemonName}"`);
          process.exit(2);
          return;
        }
        targets = [one];
      } else if (!a.all && !a.daemonName) {
        const def = entries.find((e) => e.default) ?? entries[0];
        if (!def) {
          // eslint-disable-next-line no-console
          console.error('daemons health: no daemons registered');
          process.exit(1);
          return;
        }
        targets = [def];
      }
      let failed = false;
      for (const e of targets) {
        const started = Date.now();
        try {
          const res = await daemonRequest(
            { url: e.url },
            {
              method: 'GET',
              path: '/rc/health',
              timeoutMs: 5000,
              insecure: a.insecure,
            },
          );
          // eslint-disable-next-line no-console
          console.log(
            formatHealthLine(
              e.name,
              e.url,
              'ok',
              Date.now() - started,
              `HTTP ${res.status}`,
            ),
          );
        } catch (err) {
          failed = true;
          const detail =
            err instanceof DaemonHttpError
              ? `HTTP ${err.status}`
              : err instanceof Error
                ? err.message
                : String(err);
          // eslint-disable-next-line no-console
          console.log(
            formatHealthLine(
              e.name,
              e.url,
              err instanceof DaemonHttpError ? 'error' : 'unreachable',
              undefined,
              detail,
            ),
          );
        }
      }
      process.exit(failed ? 1 : 0);
    } else {
      // whoami
      const entries = await registry.list();
      const entry =
        a.daemonName !== undefined
          ? entries.find((e) => e.name === a.daemonName)
          : (entries.find((e) => e.default) ?? entries[0]);
      if (!entry) {
        // eslint-disable-next-line no-console
        console.error(
          a.daemonName
            ? `whoami: unknown daemon "${a.daemonName}"`
            : 'whoami: no daemons registered — add one: qwen-rc daemons add <name> <url>',
        );
        process.exit(2);
        return;
      }
      const token = await tokens.get(entry.tokenStorageKey);
      if (!token) {
        // eslint-disable-next-line no-console
        console.error(
          `whoami: no stored token for "${entry.name}" — pair first: qwen-rc daemons add ${entry.name} ${entry.url}`,
        );
        process.exit(1);
        return;
      }
      const target = { url: entry.url.replace(/\/+$/, ''), token };
      const meta = await readTokenMeta(tokensDir, entry.tokenStorageKey);
      // 1. Share tokens answer /rc/share/whoami (SHARE scope). A 401 here
      //    means the bearer itself was rejected (the token is dead) — a live
      //    non-share token gets 403/404 and falls through to the owner probe.
      try {
        const res = await daemonRequest(target, {
          method: 'GET',
          path: '/rc/share/whoami',
          insecure: a.insecure,
        });
        const body = res.json as Record<string, unknown>;
        const label =
          (typeof body['label'] === 'string' && body['label']) ||
          (typeof body['name'] === 'string' && body['name']) ||
          meta?.label ||
          entry.name;
        const scopes = Array.isArray(body['scopes'])
          ? body['scopes'].map(String)
          : (meta?.scopes ?? []);
        const expiresAt =
          typeof body['expiresAt'] === 'string' ? body['expiresAt'] : undefined;
        // eslint-disable-next-line no-console
        console.log(
          formatWhoami({ kind: 'share', name: label, scopes, expiresAt }),
        );
        process.exit(0);
        return;
      } catch (err) {
        if (err instanceof DaemonHttpError && err.status === 401) {
          // eslint-disable-next-line no-console
          console.log(formatWhoami({ kind: 'invalid', scopes: [] }));
          process.exit(1);
          return;
        }
        if (
          !(
            err instanceof DaemonHttpError &&
            (err.status === 403 || err.status === 404)
          )
        ) {
          throw err;
        }
      }
      // 2. Non-share: owner-class tokens can list /rc/tokens (metadata).
      if (meta) {
        // eslint-disable-next-line no-console
        console.log(
          formatWhoami({
            kind: 'owner',
            name: meta.label || entry.name,
            scopes: meta.scopes,
          }),
        );
        process.exit(0);
        return;
      }
      // 3. No recorded metadata: probe the owner listing to at least confirm
      //    the token is live.
      try {
        await daemonRequest(target, {
          method: 'GET',
          path: '/rc/tokens',
          insecure: a.insecure,
        });
        // eslint-disable-next-line no-console
        console.log(
          formatWhoami({ kind: 'owner', name: entry.name, scopes: ['owner'] }),
        );
      } catch (err) {
        if (err instanceof DaemonHttpError && err.status === 401) {
          // eslint-disable-next-line no-console
          console.log(formatWhoami({ kind: 'invalid', scopes: [] }));
          process.exit(1);
          return;
        }
        throw err;
      }
      process.exit(0);
    }
  })().catch((err: unknown) => {
    if (err instanceof DaemonUnreachableError) {
      // eslint-disable-next-line no-console
      console.error(`daemons: ${err.message}`);
    } else {
      // eslint-disable-next-line no-console
      console.error(`daemons: ${(err as Error).message}`);
    }
    process.exit(1);
  });
} else if (
  process.argv[2] === 'up' ||
  process.argv[2] === 'down' ||
  process.argv[2] === 'status'
) {
  // `qwen-rc up|down|status [--json] [--port <n>]` — the local launcher
  // (add-remote-peers-launcher): bring up (or tear down / report on) the
  // Tailscale + native-TLS + systemd --user gateway unit on this machine.
  // Daemon-free glue: all logic lives in ./launcher/orchestrator.js — this
  // branch only parses argv, wires the real exec boundary, and renders the
  // result as text or `--json`. `--json` carries connect metadata only — it
  // deliberately OMITS the one-time owner pairing code (see upJson below);
  // only the human-readable terminal path prints that code.
  void (async () => {
    const { up, down, status, upJson } = await import(
      './launcher/orchestrator.js'
    );
    const { realRunCommand } = await import('./launcher/exec.js');
    const wantJson = process.argv.includes('--json');
    const portFlag = (() => {
      const i = process.argv.indexOf('--port');
      return i >= 0 ? Number(process.argv[i + 1]) : undefined;
    })();
    // A missing/non-numeric --port (NaN) must fall back to the default, not
    // propagate into the URL / persisted state / serve argv as "NaN".
    const port = Number.isFinite(portFlag) ? (portFlag as number) : 8443;
    const deps = {
      run: realRunCommand,
      dir: join(homedir(), '.qwen', 'rc'),
      port,
      unit: 'qwen-rc-gateway',
      // PATH-independent self-invocation: [node, this cli.js] so the systemd
      // --user unit can exec qwen-rc even when it isn't on PATH.
      serveCmd: [process.argv[0], process.argv[1]],
    };
    const cmd = process.argv[2];
    if (cmd === 'up') {
      const r = await up(deps);
      if (wantJson) {
        // Deliberately NOT the raw UpResult: upJson() strips bootstrapCode —
        // a one-time OWNER credential — before it reaches this
        // machine-captured stream (e.g. the Electron/wsl.exe launcher path).
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(upJson(r)));
      } else if (r.ok) {
        // eslint-disable-next-line no-console
        console.log(
          `\nConnect from your phone:\n  ${r.url}\n\nPairing code: ${r.bootstrapCode ?? '(see gateway logs)'}\n\n${r.qr ?? ''}`,
        );
      } else {
        // eslint-disable-next-line no-console
        console.error(`qwen-rc up: ${r.hint}`);
      }
      process.exit(r.ok ? 0 : 1);
    } else if (cmd === 'down') {
      const r = await down(deps);
      if (wantJson)
        console.log(JSON.stringify({ status: 'stopped' })); // eslint-disable-line no-console
      else console.log('qwen-rc: stopped'); // eslint-disable-line no-console
      process.exit(r.ok ? 0 : 1);
    } else {
      const r = await status(deps);
      if (wantJson)
        console.log(JSON.stringify(r)); // eslint-disable-line no-console
      else console.log(r.running ? `running\n  ${r.url ?? ''}` : 'stopped'); // eslint-disable-line no-console
      process.exit(0);
    }
  })().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(
      `qwen-rc ${process.argv[2]} failed: ${(err as Error).message}`,
    );
    process.exit(1);
  });
} else if (process.argv[2] === 'audit' && process.argv[3] === 'verify') {
  // `qwen-rc audit verify [--dir <path>]` -- walk all retained audit-*.log
  // files in the audit directory and verify the prevHash chain of each file.
  // Exits 0 when all chains are intact, 1 when any chain is broken (with a
  // human-readable report on stdout), 2 on a usage error. Daemon-free and
  // read-only: the verify pass never modifies any file.
  const argv = process.argv.slice(4);
  const dirFlag = argv.find((a) => a.startsWith('--dir='));
  const auditDir = dirFlag
    ? dirFlag.slice('--dir='.length)
    : join(homedir(), '.qwen', 'rc');
  const result = AuditLog.verifyChain(auditDir);
  if (result.ok) {
    // eslint-disable-next-line no-console
    console.log(`audit verify: OK (directory: ${auditDir})`);
    process.exit(0);
  } else {
    // eslint-disable-next-line no-console
    console.error(
      `audit verify: FAILED - ${result.failures.length} broken chain(s):`,
    );
    for (const { file, line } of result.failures) {
      // eslint-disable-next-line no-console
      console.error(`  ${file}:${line}`);
    }
    process.exit(1);
  }
}
