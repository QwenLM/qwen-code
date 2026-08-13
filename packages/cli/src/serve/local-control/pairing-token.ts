/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes, randomUUID } from 'node:crypto';

export interface PairingToken {
  /** Handle for revocation; never leaves the daemon in a URL. */
  readonly id: string;
  /** The secret itself. Carried in the URL fragment and never logged. */
  readonly secret: string;
  readonly issuedAt: number;
}

/**
 * 32 bytes, matching the runtime token's strength. base64url because the
 * secret rides in a URL fragment and in a `qwen-bearer.<value>` WebSocket
 * subprotocol, and the subprotocol grammar (RFC 6455 §4.1) admits no `+`,
 * `/`, or `=`.
 */
export function mintPairingToken(): PairingToken {
  return {
    id: randomUUID(),
    secret: randomBytes(32).toString('base64url'),
    issuedAt: Date.now(),
  };
}
