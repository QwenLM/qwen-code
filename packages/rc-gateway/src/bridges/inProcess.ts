/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * In-process bridge resolution (`add-{telegram,discord,matrix}-bridge`). The
 * gateway can run a bridge IN-PROCESS (opt-in via env), distinct from the
 * standalone sidecar, but talking the gateway ONLY over the loopback contract
 * with an operator-minted bridge token — so it stays sidecar-extractable.
 *
 * This is the pure resolver: env → the {@link SidecarConfig}s to start (plus the
 * warnings to print) — no fs, network, or `process` access, so the env gating is
 * unit-tested. `startBridge` consumes each plan, so the in-process and sidecar
 * paths share ONE construction (no per-runner duplication). `whoami` validation
 * for Matrix is NOT done here (it needs the network) — the caller does it.
 *
 * The in-process URL split the sidecar does not have: the gateway is reached over
 * LOOPBACK (`gatewayUrl` = `http://127.0.0.1:<port>`), while deeplinks must be
 * user-reachable (`QWEN_DAEMON_URL` when set, else loopback). The sidecar collapses
 * both into `QWEN_DAEMON_URL`; here they are distinct, carried as `cfg.gatewayUrl`
 * (transport) and `deeplinkUrl` (the runner's deeplink base).
 */

import { join } from 'node:path';
import { parseE2eeEnabled } from './matrix/e2ee.js';
import { parseHealthzPort } from './matrix/health.js';
import type { BridgeKind, Env, SidecarConfig } from './sidecarConfig.js';

/** One bridge to start in-process: its config, token, and deeplink base. */
export interface InProcessBridgePlan {
  cfg: SidecarConfig;
  /** The operator-minted bridge-scope token (QWEN_BRIDGE_TOKEN). */
  token: string;
  /** User-reachable deeplink base (QWEN_DAEMON_URL || loopback). */
  deeplinkUrl: string;
  /**
   * Matrix `/healthz` port. In-process this is OPT-IN (only when
   * `QWEN_BRIDGE_HEALTHZ_PORT` is set), so the gateway process never binds a
   * surprise port; undefined for non-Matrix bridges.
   */
  healthzPort?: number;
}

export interface InProcessBridgeResolution {
  /** Bridges whose creds AND bridge token are present — ready to start. */
  plans: InProcessBridgePlan[];
  /** Human warnings (e.g. creds present but the bridge token is missing). */
  warnings: string[];
}

/** Warn line when a bridge's creds are set but QWEN_BRIDGE_TOKEN is absent. */
function needsTokenWarning(kind: BridgeKind): string {
  const credsPhrase =
    kind === 'matrix' ? 'homeserver creds set' : 'bot token set';
  return (
    `${kind} bridge: ${credsPhrase} but QWEN_BRIDGE_TOKEN missing — mint a ` +
    "bridge token (POST /rc/tokens {scopes:['bridge']}) and set " +
    'QWEN_BRIDGE_TOKEN. Bridge NOT started.'
  );
}

/**
 * Resolve which bridges to start in-process from `env`. A bridge is considered
 * configured when its credentials are present; if the shared `QWEN_BRIDGE_TOKEN`
 * is then missing it yields a warning instead of a plan (never an auto-minted
 * internal token — the bridge MUST use an operator token). Pure; the caller
 * starts each plan via `startBridge` (and Matrix `whoami`-validates first).
 */
export function resolveInProcessBridges(
  env: Env,
  opts: { port: number; homeDir: string },
): InProcessBridgeResolution {
  const plans: InProcessBridgePlan[] = [];
  const warnings: string[] = [];

  // Transport is loopback (the gateway is THIS process); deeplinks must be
  // user-reachable, so prefer QWEN_DAEMON_URL when the operator set one.
  const loopbackUrl = `http://127.0.0.1:${opts.port}`;
  const deeplinkUrl = env['QWEN_DAEMON_URL'] || loopbackUrl;
  const token = env['QWEN_BRIDGE_TOKEN'];
  const stateDir = (kind: BridgeKind): string =>
    join(opts.homeDir, '.qwen', 'rc', 'bridges', kind);

  // Telegram: QWEN_RC_TELEGRAM_BOT_TOKEN is the in-process alias for the bot token.
  const tgBotToken =
    env['QWEN_RC_TELEGRAM_BOT_TOKEN'] || env['TELEGRAM_BOT_TOKEN'];
  if (tgBotToken) {
    if (!token) warnings.push(needsTokenWarning('telegram'));
    else
      plans.push({
        cfg: {
          kind: 'telegram',
          botToken: tgBotToken,
          gatewayUrl: loopbackUrl,
          stateDir: stateDir('telegram'),
        },
        token,
        deeplinkUrl,
      });
  }

  // Discord: needs both the bot token and the application id.
  const dcBotToken = env['DISCORD_BOT_TOKEN'];
  const dcAppId = env['DISCORD_APPLICATION_ID'];
  if (dcBotToken && dcAppId) {
    if (!token) warnings.push(needsTokenWarning('discord'));
    else
      plans.push({
        cfg: {
          kind: 'discord',
          botToken: dcBotToken,
          applicationId: dcAppId,
          ...(env['DISCORD_GUILD_ID']
            ? { guildId: env['DISCORD_GUILD_ID'] }
            : {}),
          gatewayUrl: loopbackUrl,
          stateDir: stateDir('discord'),
        },
        token,
        deeplinkUrl,
      });
  }

  // Matrix: needs homeserver + MXID + access token. The E2EE flag is threaded in
  // here (parseE2eeEnabled), so the in-process bridge honors MATRIX_ENABLE_E2EE
  // exactly like the sidecar.
  const mxHomeserver = env['MATRIX_HOMESERVER_URL'];
  const mxUserId = env['MATRIX_USER_ID'];
  const mxAccessToken = env['MATRIX_ACCESS_TOKEN'];
  if (mxHomeserver && mxUserId && mxAccessToken) {
    if (!token) warnings.push(needsTokenWarning('matrix'));
    else
      plans.push({
        cfg: {
          kind: 'matrix',
          homeserverUrl: mxHomeserver,
          userId: mxUserId,
          accessToken: mxAccessToken,
          commandPrefix: env['MATRIX_COMMAND_PREFIX'] || '!qwen',
          e2eeEnabled: parseE2eeEnabled(env['MATRIX_ENABLE_E2EE']),
          gatewayUrl: loopbackUrl,
          stateDir: stateDir('matrix'),
        },
        token,
        deeplinkUrl,
        // In-process healthz is opt-in (no default) — avoid a surprise bind.
        ...(parseHealthzPort(env['QWEN_BRIDGE_HEALTHZ_PORT'], undefined) !==
        undefined
          ? {
              healthzPort: parseHealthzPort(
                env['QWEN_BRIDGE_HEALTHZ_PORT'],
                undefined,
              ),
            }
          : {}),
      });
  }

  return { plans, warnings };
}
