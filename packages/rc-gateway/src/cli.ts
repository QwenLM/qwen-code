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
  loadResolvedRoutingRules,
  formatResolvedRouting,
} from './routing/rules.js';
import {
  parseRoutingTest,
  evaluateRoutingTest,
  formatRoutingTest,
} from './routing/test.js';
import { createGatewayApp } from './server.js';
import { SessionEventPump } from './webpush/pump.js';
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
import { parseSearchArgs, formatSearchResults } from './search/searchCli.js';

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
  const { app, notifier, audit } = createGatewayApp({
    daemon: handle.daemon,
    store,
    pairing,
    vapid,
    pushStore,
    snooze,
    routing,
  });

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
    // Watch the PARENT DIR of each policy file (survives an editor's atomic
    // rename-replace, unlike a file watch), filtering for the policy.yaml
    // basename. fs.watch THROWS SYNCHRONOUSLY on a missing dir → guard the CALL;
    // a missing/unwatchable dir simply won't hot-reload that layer.
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

  // Hold the gateway's own daemon subscriptions so push fires with no browser
  // open. Best-effort: start() always resolves, even if the daemon is unhappy.
  let pump: SessionEventPump | undefined;
  if (notifier) {
    pump = new SessionEventPump(handle.daemon, notifier, { enforcer });
    await pump.start();
    // eslint-disable-next-line no-console
    console.log('push pump: started');
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

  const shutdown = async () => {
    for (const w of watchers) w.close();
    reloader?.stop();
    if (quietDigestTimer) clearInterval(quietDigestTimer);
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
    if (process.argv.includes('--rank')) {
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
        console.log(formatSearchResults(result));
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
    console.log(formatSearchResults(result));
    process.exit(0);
  })().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(`search: ${(err as Error).message}`);
    process.exit(1);
  });
} else if (process.argv[2] === 'reindex') {
  // `qwen-rc reindex [--cwd=<dir>]` — (re)build the BM25 full-text index for a
  // workspace's transcripts (full drop+rebuild). The index db lives under the
  // workspace's 0700 search-index dir. The NATIVE better-sqlite3 is loaded HERE
  // via a dynamic import, so `qwen serve` / the gateway never load the addon.
  void (async () => {
    const cwdFlag = process.argv.slice(3).find((a) => a.startsWith('--cwd='));
    const cwd = cwdFlag ? cwdFlag.slice('--cwd='.length) : process.cwd();
    const { SearchIndex } = await loadSearchIndexModule();
    const chatsDir = resolveChatsDir(cwd);
    const dbPath = join(resolveSearchIndexDir(cwd), 'index.db');
    const idx = SearchIndex.open(dbPath);
    try {
      const { files, records } = idx.reindex(chatsDir);
      // eslint-disable-next-line no-console
      console.log(`indexed ${records} record(s) from ${files} file(s)`);
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
