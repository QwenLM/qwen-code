/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { startDaemon } from './daemonSupervisor.js';
import { TokenStore } from './tokenStore.js';
import { PairingService } from './pairing.js';
import { VapidStore } from './webpush/vapid.js';
import { PushStore } from './pushStore.js';
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
import { BridgeClient } from './bridges/client.js';
import { TelegramBotApi } from './bridges/telegram/botApi.js';
import { TelegramChatStore } from './bridges/telegram/chatStore.js';
import { TelegramBridge } from './bridges/telegram/runner.js';
import { DiscordRestApi } from './bridges/discord/restApi.js';
import { DiscordChannelStore } from './bridges/discord/channelStore.js';
import { DiscordBridge } from './bridges/discord/runner.js';
import { makeDiscordGateway } from './bridges/discord/gateway.js';
import { MatrixRestApi } from './bridges/matrix/restApi.js';
import { MatrixRoomStore } from './bridges/matrix/roomStore.js';
import { MatrixBridge } from './bridges/matrix/runner.js';
import { IdleSessionToggles } from './idle/sessionToggles.js';
import type { IdleStatusResolver } from './routes/idleToggle.js';
import { SessionEventPump } from './webpush/pump.js';
import {
  DEFAULT_RATE_TABLE,
  RateTableHolder,
  loadRateTableFile,
  rateTablePath,
} from './cost/rateTable.js';
import { UsageIngester, UsageTickCoalescer } from './cost/ingester.js';
import { SessionAttributionMap } from './cost/sessionAttribution.js';
import { UsageTickBroadcaster } from './cost/usageTickBroadcaster.js';
import {
  resolveSuggestConfig,
  createChatTransport,
} from './idle/chatTransport.js';
import {
  resolveIdleEnabled,
  createIdleSuggestionHandler,
} from './idle/idleSuggestions.js';
import { readFile } from 'node:fs/promises';
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
  type Policy,
} from './policy/loader.js';
import { explainPolicy } from './policy/evaluator.js';
import { parseExplainArgs, formatExplanation } from './policy/explain.js';
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
} from './search/searchCli.js';

export interface ServeOptions {
  gatewayPort?: number;
  daemonPort?: number;
}

/** Boot the daemon + gateway and print the owner pairing code. */
export async function runServe(opts: ServeOptions = {}): Promise<void> {
  const handle = await startDaemon({ port: opts.daemonPort ?? 4180 });
  const store = await TokenStore.open(
    join(homedir(), '.qwen', 'rc', 'tokens.json'),
  );
  const pairing = new PairingService();
  const vapid = await VapidStore.open(
    join(homedir(), '.qwen', 'rc', 'vapid.json'),
  );
  const pushStore = await PushStore.open(
    join(homedir(), '.qwen', 'rc', 'push-subscriptions.json'),
  );
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
    // Daemon not reporting capabilities → no workspace override layer.
  }
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

  const { app, notifier, audit, ownerEvents, bridgeRegistry } =
    createGatewayApp({
      daemon: handle.daemon,
      store,
      pairing,
      vapid,
      pushStore,
      snooze,
      routing,
      idleToggles,
      idleStatus,
      usageReader: usageStore,
      usageBroadcaster: usageStore ? usageBroadcaster : undefined,
      costCurrencyLabel: () => rates.current().currencyLabel,
      onPromptAccepted: usageStore
        ? (sid, attr) => {
            sessionAttribution.set(sid, attr);
            usageIngester?.notePromptBoundary(sid);
          }
        : undefined,
    });

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
  const policy = await loadLayeredPolicy(
    userPolicyPath,
    workspaceCwd,
    // eslint-disable-next-line no-console
    (msg) => console.warn(msg),
  );
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
  const enforcer = notifier
    ? new PolicyEnforcer(handle.daemon, policy, audit, quota)
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

  const port = opts.gatewayPort ?? 4170;
  app.listen(port, '127.0.0.1', () => {
    const { code, expiresAt } = pairing.mint([
      OWNER,
      SESSION_READ,
      APPROVE,
      WRITE,
    ]);
    // eslint-disable-next-line no-console
    console.log(
      [
        `qwen-rc gateway listening on http://127.0.0.1:${port}`,
        `web viewer: http://127.0.0.1:${port}/ui/`,
        `webpush: enabled (key ${vapid.getApplicationServerKey().slice(0, 8)}…)`,
        `policy: ${policy.rules.length === 0 ? 'default-prompt' : `${policy.rules.length} rule(s)`}`,
        `routing: ${routingRuleCount === 0 ? 'none' : `${routingRuleCount} rule(s)`}`,
        `owner pairing code: ${code}`,
        `  (expires ${new Date(expiresAt).toISOString()}, grants [${OWNER}, ${SESSION_READ}, ${APPROVE}, ${WRITE}])`,
        `redeem: POST /rc/pair/redeem { "code": "${code}", "label": "<name>" }`,
      ].join('\n'),
    );
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
    onSessionIdle = createIdleSuggestionHandler({
      chat: createChatTransport(suggestCfg),
      bus: ownerEvents,
      audit,
      getConfig: () => idleConfig,
      limiter: idleLimiter,
      // Per-session `/suggest off` override (narrows only — never widens past the
      // global egress gate above).
      getSessionEnabled: (id) => idleToggles.get(id),
    });
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
  if (notifier || usageIngester) {
    pump = new SessionEventPump(handle.daemon, notifier, {
      enforcer,
      ...(onSessionIdle ? { onSessionIdle } : {}),
      ...(usageIngester
        ? {
            onEvent: (sid, ev) =>
              usageIngester!.ingest(sid, ev.data, sessionAttribution.get(sid)),
          }
        : {}),
    });
    await pump.start();
    // eslint-disable-next-line no-console
    console.log(
      notifier ? 'push pump: started' : 'session pump: started (cost tracking)',
    );
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

  // In-process Telegram bridge (add-telegram-bridge), opt-in. The HYBRID: it runs
  // in this process but talks the gateway ONLY over the loopback contract with an
  // OPERATOR-MINTED bridge token (QWEN_BRIDGE_TOKEN, minted via POST /rc/tokens
  // {scopes:['bridge']}) — never an auto-minted internal token — so it stays
  // extractable to a sidecar by changing only its config. Started only when both
  // a bot token and a bridge token are present.
  let telegramAbort: AbortController | undefined;
  const tgBotToken =
    process.env.QWEN_RC_TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  if (tgBotToken) {
    const bridgeToken = process.env.QWEN_BRIDGE_TOKEN;
    if (!bridgeToken) {
      // eslint-disable-next-line no-console
      console.warn(
        'telegram bridge: bot token set but QWEN_BRIDGE_TOKEN missing — mint a ' +
          "bridge token (POST /rc/tokens {scopes:['bridge']}) and set " +
          'QWEN_BRIDGE_TOKEN. Bridge NOT started.',
      );
    } else {
      const loopbackUrl = `http://127.0.0.1:${port}`;
      const runner = new TelegramBridge({
        botApi: new TelegramBotApi({ botToken: tgBotToken }),
        client: new BridgeClient({ baseUrl: loopbackUrl, token: bridgeToken }),
        chats: await TelegramChatStore.open(
          join(homedir(), '.qwen', 'rc', 'bridges', 'telegram', 'chats.json'),
        ),
        // Deeplinks must be user-reachable (a phone can't hit loopback); prefer
        // QWEN_DAEMON_URL when the operator set a reachable address.
        baseUrl: process.env.QWEN_DAEMON_URL || loopbackUrl,
        // eslint-disable-next-line no-console
        log: (m) => console.log(m),
      });
      telegramAbort = new AbortController();
      void runner.start(telegramAbort.signal);
      // eslint-disable-next-line no-console
      console.log('telegram bridge: started (in-process, loopback contract)');
    }
  }

  // In-process Discord bridge (add-discord-bridge), opt-in. Same HYBRID as the
  // Telegram bridge: in-process but loopback-contract-only with an OPERATOR-MINTED
  // QWEN_BRIDGE_TOKEN, so it's sidecar-extractable by config alone. Per the
  // operator's choice (spec D2), discord.js owns the stateful gateway protocol.
  // Started only when bot token, application id, and bridge token are all present.
  let discordAbort: AbortController | undefined;
  const discordBotToken = process.env.DISCORD_BOT_TOKEN;
  const discordAppId = process.env.DISCORD_APPLICATION_ID;
  if (discordBotToken && discordAppId) {
    const bridgeToken = process.env.QWEN_BRIDGE_TOKEN;
    if (!bridgeToken) {
      // eslint-disable-next-line no-console
      console.warn(
        'discord bridge: bot token set but QWEN_BRIDGE_TOKEN missing — mint a ' +
          "bridge token (POST /rc/tokens {scopes:['bridge']}) and set " +
          'QWEN_BRIDGE_TOKEN. Bridge NOT started.',
      );
    } else {
      const loopbackUrl = `http://127.0.0.1:${port}`;
      const runner = new DiscordBridge({
        client: new BridgeClient({ baseUrl: loopbackUrl, token: bridgeToken }),
        rest: new DiscordRestApi({
          botToken: discordBotToken,
          applicationId: discordAppId,
        }),
        channels: await DiscordChannelStore.open(
          join(homedir(), '.qwen', 'rc', 'bridges', 'discord', 'channels.json'),
        ),
        makeGateway: makeDiscordGateway({
          botToken: discordBotToken,
          applicationId: discordAppId,
          guildId: process.env.DISCORD_GUILD_ID,
          // eslint-disable-next-line no-console
          log: (m) => console.log(m),
        }),
        // Deeplinks must be user-reachable; prefer QWEN_DAEMON_URL when set.
        baseUrl: process.env.QWEN_DAEMON_URL || loopbackUrl,
        // eslint-disable-next-line no-console
        log: (m) => console.log(m),
      });
      discordAbort = new AbortController();
      void runner.start(discordAbort.signal);
      // eslint-disable-next-line no-console
      console.log('discord bridge: started (in-process, loopback contract)');
    }
  }

  // In-process Matrix bridge (add-matrix-bridge), opt-in. Same HYBRID as the
  // others: in-process but loopback-contract-only with an OPERATOR-MINTED
  // QWEN_BRIDGE_TOKEN. UNENCRYPTED rooms only — encrypted rooms are detected and
  // refused (E2EE/olm crypto is deferred). Started only when homeserver, MXID,
  // access token, and bridge token are all present AND whoami matches the MXID.
  let matrixAbort: AbortController | undefined;
  const mxHomeserver = process.env.MATRIX_HOMESERVER_URL;
  const mxUserId = process.env.MATRIX_USER_ID;
  const mxAccessToken = process.env.MATRIX_ACCESS_TOKEN;
  if (mxHomeserver && mxUserId && mxAccessToken) {
    const bridgeToken = process.env.QWEN_BRIDGE_TOKEN;
    if (!bridgeToken) {
      // eslint-disable-next-line no-console
      console.warn(
        'matrix bridge: homeserver creds set but QWEN_BRIDGE_TOKEN missing — ' +
          "mint a bridge token (POST /rc/tokens {scopes:['bridge']}) and set " +
          'QWEN_BRIDGE_TOKEN. Bridge NOT started.',
      );
    } else {
      const loopbackUrl = `http://127.0.0.1:${port}`;
      const mxRest = new MatrixRestApi({
        homeserverUrl: mxHomeserver,
        accessToken: mxAccessToken,
      });
      // whoami fail-fast (in-process analog: log + don't start, never kill the
      // gateway). The configured MXID must match the access token's identity.
      // Bounded by a 5s timeout so a hung homeserver can't wedge boot before the
      // signal handlers register; on timeout `userId` is undefined → fail-open
      // (the bridge starts) rather than blocking the gateway.
      const who = await mxRest.whoami(AbortSignal.timeout(5000));
      if (who.userId && who.userId !== mxUserId) {
        // eslint-disable-next-line no-console
        console.warn(
          `matrix bridge: MXID mismatch (token resolves to a different user than ${mxUserId}). Bridge NOT started.`,
        );
      } else {
        const runner = new MatrixBridge({
          client: new BridgeClient({
            baseUrl: loopbackUrl,
            token: bridgeToken,
          }),
          rest: mxRest,
          rooms: await MatrixRoomStore.open(
            join(homedir(), '.qwen', 'rc', 'bridges', 'matrix', 'rooms.json'),
          ),
          botUserId: mxUserId,
          baseUrl: process.env.QWEN_DAEMON_URL || loopbackUrl,
          commandPrefix: process.env.MATRIX_COMMAND_PREFIX || '!qwen',
          syncOnce: (since, signal) =>
            mxRest.sync(since, 30000, signal).then((r) => r.body),
          // eslint-disable-next-line no-console
          log: (m) => console.log(m),
        });
        matrixAbort = new AbortController();
        void runner.start(matrixAbort.signal);
        // eslint-disable-next-line no-console
        console.log('matrix bridge: started (in-process, loopback contract)');
      }
    }
  }

  const shutdown = async () => {
    for (const w of watchers) w.close();
    reloader?.stop();
    routingReloader?.stop();
    if (quietDigestTimer) clearInterval(quietDigestTimer);
    clearInterval(bridgeReaper);
    telegramAbort?.abort();
    discordAbort?.abort();
    matrixAbort?.abort();
    if (pump) await pump.stop();
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

// Entrypoint: `qwen-rc serve`
if (process.argv[2] === 'serve') {
  runServe().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('qwen-rc serve failed:', err);
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
  // `qwen-rc policy explain <toolName> [--args=…] [--path=…] [--scope=…]
  // [--tag=…]` — daemon-free dry-run of the layered policy (user
  // ~/.qwen/rc/policy.yaml + <cwd>/.qwen/policy.yaml). Read-only INSPECTOR:
  // exit 0 on success, 2 on a missing tool, 1 when the policy is malformed (it
  // cannot be explained — surface the loader error rather than pretend). The
  // bug-prone logic is in the pure, unit-tested parseExplainArgs/explainPolicy/
  // formatExplanation; this is glue. No quota oracle (no live store) → a
  // maxPerWindow rule shows as prompt, as formatExplanation's caveat notes.
  const { tool, ctx } = parseExplainArgs(process.argv.slice(4));
  if (!tool) {
    // eslint-disable-next-line no-console
    console.error(
      'usage: qwen-rc policy explain <toolName> [--args=…] [--path=…] [--scope=…] [--tag=…]',
    );
    process.exit(2);
  }
  loadLayeredPolicy(
    join(homedir(), '.qwen', 'rc', 'policy.yaml'),
    process.cwd(),
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
  // [--limit=…] [--session=…]` — daemon-free on-disk transcript search. Derives
  // the chats dir from --cwd (default cwd) via the exact resolveChatsDir and
  // reuses searchTranscriptsDetailed (identical matcher to the HTTP route). The
  // bug-prone logic is in the pure, unit-tested parseSearchArgs/
  // formatSearchResults; this is glue. INSPECTOR: exit 0 on success (incl. 0
  // hits), 2 on usage. The scan sets no timeout → it never throws; the catch is
  // a defensive exit 1 only.
  void (async () => {
    const parsed = parseSearchArgs(process.argv.slice(3));
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
    // eslint-disable-next-line no-console
    console.error(`search: ${(err as Error).message}`);
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
}
