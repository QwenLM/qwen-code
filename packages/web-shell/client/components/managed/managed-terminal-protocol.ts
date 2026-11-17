/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const MANAGED_TERMINAL_SUBPROTOCOL = 'qwen-ws';
export const MANAGED_TERMINAL_BEARER_PREFIX = 'qwen-bearer.';

/**
 * The ticket is already base64url. The Managed relay consumes it verbatim,
 * unlike the daemon terminal whose token is base64url-encoded here.
 */
export function managedTerminalProtocols(ticket: string): string[] {
  return [
    MANAGED_TERMINAL_SUBPROTOCOL,
    `${MANAGED_TERMINAL_BEARER_PREFIX}${ticket}`,
  ];
}

let nextTerminalId = 0;

/** Stable per-Session id; reconnect reuse is what restores the PTY. */
export function newManagedTerminalId(now = Date.now()): string {
  nextTerminalId += 1;
  return `managed-${now.toString(36)}-${nextTerminalId.toString(36)}`;
}
