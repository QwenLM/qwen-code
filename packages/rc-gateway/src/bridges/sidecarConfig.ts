/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Sidecar configuration resolution for the standalone bridge processes
 * (`add-{telegram,discord,matrix}-bridge`: "Bridge process configuration"). Each
 * bridge can run as its own process distinct from the gateway, reading its config
 * EXCLUSIVELY from environment variables; this module turns that env into a typed,
 * validated config or fails fast with a specific message.
 *
 * Pure — no fs, no network, no `process` access (env + home dir are passed in) —
 * so the fail-fast scenarios (a missing required var → exact stderr) are unit-
 * testable without spawning a process.
 *
 * The two QWEN_DAEMON_URL meanings collapse here: for a sidecar it is BOTH the
 * gateway transport target (loopback meaning is gone — the gateway is elsewhere)
 * AND the user-facing deeplink base. In-process the transport is loopback and
 * QWEN_DAEMON_URL is deeplink-only; that distinction does not exist out-of-process.
 */

import { join } from 'node:path';
import { parseE2eeEnabled } from './matrix/e2ee.js';

export type BridgeKind = 'telegram' | 'discord' | 'matrix';

export const BRIDGE_KINDS: readonly BridgeKind[] = [
  'telegram',
  'discord',
  'matrix',
];

/** A required-variable / malformed-config failure — caught by the entrypoint to
 * print the message and exit non-zero (the spec's fail-fast contract). */
export class SidecarConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SidecarConfigError';
  }
}

interface SidecarConfigBase {
  kind: BridgeKind;
  /** Gateway transport target AND deeplink base (both QWEN_DAEMON_URL). */
  gatewayUrl: string;
  /** Persistent storage root for this bridge. */
  stateDir: string;
  /** Operator-minted bridge token, when supplied directly. */
  bridgeToken?: string;
  /** One-time pairing code to bootstrap a token, when no token is supplied. */
  pairingCode?: string;
}

export interface TelegramSidecarConfig extends SidecarConfigBase {
  kind: 'telegram';
  botToken: string;
}

export interface DiscordSidecarConfig extends SidecarConfigBase {
  kind: 'discord';
  botToken: string;
  applicationId: string;
  guildId?: string;
}

export interface MatrixSidecarConfig extends SidecarConfigBase {
  kind: 'matrix';
  homeserverUrl: string;
  userId: string;
  accessToken: string;
  commandPrefix: string;
  /** `MATRIX_ENABLE_E2EE` — opt-in encrypted-room support (default OFF). */
  e2eeEnabled: boolean;
}

export type SidecarConfig =
  | TelegramSidecarConfig
  | DiscordSidecarConfig
  | MatrixSidecarConfig;

export type Env = Record<string, string | undefined>;

/** Read a required var or throw the spec's `"<NAME> is required"` message. */
function required(env: Env, name: string): string {
  const v = env[name];
  if (typeof v === 'string' && v.length > 0) return v;
  throw new SidecarConfigError(`${name} is required`);
}

function optional(env: Env, name: string): string | undefined {
  const v = env[name];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Validate and resolve a sidecar config for `kind` from `env`. Throws
 * {@link SidecarConfigError} (message = `"<VAR> is required"`) on a missing
 * required variable. Bridge-specific creds are checked BEFORE the shared vars so
 * the pinned "<KIND>_BOT_TOKEN is required" scenarios win regardless of what else
 * is unset. `whoami`/MXID validation is NOT done here (it needs the network) —
 * the entrypoint does it after token bootstrap.
 */
export function resolveSidecarConfig(
  kind: BridgeKind,
  env: Env,
  homeDir: string,
): SidecarConfig {
  const stateDir =
    optional(env, 'QWEN_BRIDGE_STATE_DIR') ??
    join(homeDir, '.qwen', 'rc', 'bridges', kind);

  // Shared credential check: exactly one of token / pairing code is required.
  const sharedCredentials = (): Pick<
    SidecarConfigBase,
    'bridgeToken' | 'pairingCode'
  > => {
    const bridgeToken = optional(env, 'QWEN_BRIDGE_TOKEN');
    const pairingCode = optional(env, 'QWEN_BRIDGE_PAIRING_CODE');
    if (!bridgeToken && !pairingCode) {
      throw new SidecarConfigError(
        'QWEN_BRIDGE_TOKEN or QWEN_BRIDGE_PAIRING_CODE is required',
      );
    }
    return { bridgeToken, pairingCode };
  };

  if (kind === 'telegram') {
    const botToken = required(env, 'TELEGRAM_BOT_TOKEN');
    const gatewayUrl = required(env, 'QWEN_DAEMON_URL');
    return {
      kind,
      botToken,
      gatewayUrl,
      stateDir,
      ...sharedCredentials(),
    };
  }

  if (kind === 'discord') {
    const botToken = required(env, 'DISCORD_BOT_TOKEN');
    const applicationId = required(env, 'DISCORD_APPLICATION_ID');
    const gatewayUrl = required(env, 'QWEN_DAEMON_URL');
    return {
      kind,
      botToken,
      applicationId,
      guildId: optional(env, 'DISCORD_GUILD_ID'),
      gatewayUrl,
      stateDir,
      ...sharedCredentials(),
    };
  }

  // matrix
  const homeserverUrl = required(env, 'MATRIX_HOMESERVER_URL');
  const userId = required(env, 'MATRIX_USER_ID');
  const accessToken = required(env, 'MATRIX_ACCESS_TOKEN');
  const gatewayUrl = required(env, 'QWEN_DAEMON_URL');
  return {
    kind,
    homeserverUrl,
    userId,
    accessToken,
    commandPrefix: optional(env, 'MATRIX_COMMAND_PREFIX') ?? '!qwen',
    e2eeEnabled: parseE2eeEnabled(env['MATRIX_ENABLE_E2EE']),
    gatewayUrl,
    stateDir,
    ...sharedCredentials(),
  };
}

/**
 * Matrix MXID fail-fast check (spec: "fail-fast … if `whoami` returns an MXID that
 * does not match `MATRIX_USER_ID`"). Returns an error message to print + exit on,
 * or `null` to proceed. A missing/unresolved `whoami.userId` is fail-OPEN (return
 * null) — a hung/old homeserver shouldn't block boot; only a CONFIRMED mismatch
 * aborts. Pure so the entrypoint glue stays a one-liner and this is unit-tested.
 */
export function checkMxid(
  whoamiUserId: string | undefined,
  expectedUserId: string,
): string | null {
  if (whoamiUserId && whoamiUserId !== expectedUserId) {
    return `MXID mismatch: access token resolves to ${whoamiUserId}, not ${expectedUserId}`;
  }
  return null;
}
