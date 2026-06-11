/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

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
import { createGatewayApp } from './server.js';
import { SessionEventPump } from './webpush/pump.js';
import {
  loadLayeredPolicy,
  lintPolicyFile,
  formatPolicyLint,
} from './policy/loader.js';
import { PolicyEnforcer } from './policy/enforcer.js';
import { QuotaStore, FileQuotaWal } from './policy/quotas.js';
import { OWNER, SESSION_READ, APPROVE, WRITE } from './scopes.js';

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
  const policy = await loadLayeredPolicy(
    join(homedir(), '.qwen', 'rc', 'policy.yaml'),
    workspaceCwd,
    // eslint-disable-next-line no-console
    (msg) => console.warn(msg),
  );
  // Per-rule quota store (cycle 43): limits keyed by rule id from the active
  // policy; persisted to ~/.qwen/rc/quotas.wal (survives restart). Only built
  // when the enforcer runs. limitsFor reflects the boot policy (hot-reload, a
  // future cycle, would rebuild it).
  const quotaLimits = new Map<string, { count: number; windowSec: number }>();
  for (const r of policy.rules) {
    if (
      r.id !== undefined &&
      r.maxPerWindow !== undefined &&
      !quotaLimits.has(r.id)
    ) {
      quotaLimits.set(r.id, r.maxPerWindow);
    }
  }
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

  const shutdown = async () => {
    if (pump) await pump.stop();
    await handle.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
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
}
