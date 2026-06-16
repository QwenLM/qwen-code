/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Standalone bridge sidecar entrypoint (`add-{telegram,discord,matrix}-bridge`:
 * "Bridge process configuration"). Runs ONE bridge as its own process, distinct
 * from the gateway, talking the gateway over the daemon HTTP+SSE contract with an
 * operator bridge-scope token.
 *
 *   qwen-rc-bridge <telegram|discord|matrix>
 *
 * Config is read EXCLUSIVELY from the environment (see {@link resolveSidecarConfig});
 * a missing required var fails fast with the spec's message and exit 1. The token
 * is either supplied (`QWEN_BRIDGE_TOKEN`) or bootstrapped from a one-time
 * `QWEN_BRIDGE_PAIRING_CODE` (redeemed + persisted at mode 0600). For Matrix the
 * access token's `whoami` MXID must match `MATRIX_USER_ID` or it exits 1.
 *
 * This file is process glue (argv, env, signals, exit) — the bug-prone logic is in
 * the pure, unit-tested resolver / token bootstrap; this path is exercised
 * end-to-end by the sidecar spawn smoke.
 */

import { homedir } from 'node:os';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  resolveSidecarConfig,
  checkMxid,
  SidecarConfigError,
  BRIDGE_KINDS,
  type BridgeKind,
} from './bridges/sidecarConfig.js';
import {
  resolveBridgeToken,
  type TokenBootstrapDeps,
} from './bridges/tokenBootstrap.js';
import { startBridge } from './bridges/start.js';
import { MatrixRestApi } from './bridges/matrix/restApi.js';
import { parseHealthzPort } from './bridges/matrix/health.js';

/* eslint-disable no-console */

function fail(message: string, code = 1): never {
  console.error(`qwen-rc-bridge: ${message}`);
  process.exit(code);
}

/** Real fs + fetch token-bootstrap deps (the entrypoint's only I/O surface). */
const tokenDeps: TokenBootstrapDeps = {
  readToken: async (path) => {
    try {
      const t = (await readFile(path, 'utf8')).trim();
      return t.length > 0 ? t : undefined;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  },
  writeToken: async (path, token) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${token}\n`, { mode: 0o600 });
  },
  redeemPairingCode: async (gatewayUrl, code, label) => {
    const res = await fetch(new URL('/rc/pair/redeem', gatewayUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, label }),
    });
    if (!res.ok) {
      throw new SidecarConfigError(
        `pairing-code redemption failed (${res.status}) — mint a fresh code`,
      );
    }
    const body = (await res.json()) as { token?: unknown };
    if (typeof body.token !== 'string' || !body.token) {
      throw new SidecarConfigError('pairing-code redemption returned no token');
    }
    return body.token;
  },
  log: (m) => console.log(m),
};

async function main(): Promise<void> {
  const kindArg = process.argv[2];
  if (!kindArg || !BRIDGE_KINDS.includes(kindArg as BridgeKind)) {
    fail(`usage: qwen-rc-bridge <${BRIDGE_KINDS.join('|')}>`, 2);
  }
  const kind = kindArg as BridgeKind;

  let cfg;
  try {
    cfg = resolveSidecarConfig(kind, process.env, homedir());
  } catch (err) {
    if (err instanceof SidecarConfigError) fail(err.message);
    throw err;
  }

  const token = await resolveBridgeToken(cfg, tokenDeps).catch((err) => {
    if (err instanceof SidecarConfigError) fail(err.message);
    throw err;
  });

  // Matrix fail-fast: the access token's identity MUST match MATRIX_USER_ID.
  if (cfg.kind === 'matrix') {
    const mxRest = new MatrixRestApi({
      homeserverUrl: cfg.homeserverUrl,
      accessToken: cfg.accessToken,
    });
    const who = await mxRest.whoami(AbortSignal.timeout(10000));
    const mismatch = checkMxid(who.userId, cfg.userId);
    if (mismatch) fail(mismatch);
    // E2EE crypto transport (opt-in via MATRIX_ENABLE_E2EE, OFF by default) is
    // constructed, wired, and started inside startBridge — when on, the SDK
    // crypto client owns /sync and outbound; when off, the plain fetch bridge
    // runs unchanged. Construction failure degrades to the plain bridge.
  }

  // Matrix sidecar exposes GET /healthz (spec default 9100); override or disable
  // via QWEN_BRIDGE_HEALTHZ_PORT (a number, or off/none/0). Non-Matrix: ignored.
  const healthzPort =
    cfg.kind === 'matrix'
      ? parseHealthzPort(process.env.QWEN_BRIDGE_HEALTHZ_PORT, 9100)
      : undefined;
  const bridge = await startBridge(cfg, {
    token,
    log: (m) => console.log(m),
    ...(healthzPort != null ? { healthzPort } : {}),
  });
  console.log(`qwen-rc-bridge: ${kind} bridge started (loopback contract)`);

  const shutdown = () => {
    console.log(`qwen-rc-bridge: ${kind} bridge stopping`);
    bridge.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('qwen-rc-bridge: fatal:', err);
  process.exit(1);
});
