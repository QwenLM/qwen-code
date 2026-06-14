/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bridge-token bootstrap for the sidecar processes (`add-*-bridge`: "Pairing-code
 * bootstrap persists token"). Resolves the bridge-scope token a sidecar will
 * present to the gateway, with this precedence:
 *
 *   1. `QWEN_BRIDGE_TOKEN` (explicit operator token) — used as-is, not persisted.
 *   2. A previously persisted `$STATE_DIR/token` — short-circuits the pairing
 *      code, so "subsequent boots ignore QWEN_BRIDGE_PAIRING_CODE if the token
 *      file exists" (the spec scenario).
 *   3. `QWEN_BRIDGE_PAIRING_CODE` — redeemed against the gateway's
 *      `POST /rc/pair/redeem` (a PRE-AUTH bootstrap call: no bearer), and the
 *      resulting token persisted to `$STATE_DIR/token` at mode 0600.
 *
 * fs + fetch are injected so the precedence and the 0600 persistence are
 * unit-testable without touching disk or the network. The persisted token is a
 * credential — never logged (this module returns it; callers must not print it).
 */

import { join } from 'node:path';
import type { SidecarConfig } from './sidecarConfig.js';
import { SidecarConfigError } from './sidecarConfig.js';

export interface TokenBootstrapDeps {
  /** Read the persisted token file; resolves undefined when absent. */
  readToken(path: string): Promise<string | undefined>;
  /** Persist the token at mode 0600 (creating parents as needed). */
  writeToken(path: string, token: string): Promise<void>;
  /** POST {gatewayUrl}/rc/pair/redeem {code,label} → token (or throws). */
  redeemPairingCode(
    gatewayUrl: string,
    code: string,
    label: string,
  ): Promise<string>;
  /** Logger for boot lines (never receives the token). */
  log?: (msg: string) => void;
}

/** The on-disk path the redeemed token is persisted to / read back from. */
export function tokenFilePath(stateDir: string): string {
  return join(stateDir, 'token');
}

/**
 * Resolve the bridge token for `cfg`, redeeming + persisting a pairing code on
 * first boot. Throws {@link SidecarConfigError} if no credential can be resolved
 * (should not happen — the resolver guarantees one) or if redemption fails.
 */
export async function resolveBridgeToken(
  cfg: SidecarConfig,
  deps: TokenBootstrapDeps,
): Promise<string> {
  // 1. Explicit operator token wins and is used verbatim (not persisted).
  if (cfg.bridgeToken) return cfg.bridgeToken;

  const path = tokenFilePath(cfg.stateDir);

  // 2. A persisted token short-circuits the pairing code on later boots.
  const persisted = await deps.readToken(path);
  if (persisted) {
    deps.log?.(`bridge token: using persisted token at ${path}`);
    return persisted;
  }

  // 3. Redeem the one-time pairing code and persist the result.
  if (cfg.pairingCode) {
    const label = `${cfg.kind}-bridge`;
    const token = await deps.redeemPairingCode(
      cfg.gatewayUrl,
      cfg.pairingCode,
      label,
    );
    await deps.writeToken(path, token);
    deps.log?.(`bridge token: redeemed pairing code, persisted to ${path}`);
    return token;
  }

  throw new SidecarConfigError(
    'QWEN_BRIDGE_TOKEN or QWEN_BRIDGE_PAIRING_CODE is required',
  );
}
