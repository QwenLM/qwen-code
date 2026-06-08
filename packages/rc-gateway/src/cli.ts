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
import { createGatewayApp } from './server.js';
import { SessionEventPump } from './webpush/pump.js';
import { loadPolicyFile } from './policy/loader.js';
import { PolicyEnforcer } from './policy/enforcer.js';
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
  const { app, notifier, audit } = createGatewayApp({
    daemon: handle.daemon,
    store,
    pairing,
    vapid,
    pushStore,
  });

  // Load the policy fail-closed: absent file → default-prompt (auto-votes
  // nothing → behavior identical to pre-policy). Shares the gateway's audit so
  // policy_decision entries land in the same log.
  const policy = (await loadPolicyFile(
    join(homedir(), '.qwen', 'rc', 'policy.yaml'),
  )) ?? { defaults: { action: 'prompt', requireScope: 'approve' }, rules: [] };
  const enforcer = notifier
    ? new PolicyEnforcer(handle.daemon, policy, audit)
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
}
