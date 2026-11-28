/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Session-level authorization contract for MCP servers whose credentials are
// brokered by a host service. The product implementation (e.g. a gateway
// coordinator) is injected; the session manager and auth pseudo-tool only see
// these generic shapes.

import type { MCPServerConfig } from './mcpServerConfig.js';
import { getConsentForOauth } from '../utils/authConsent.js';
import { raceWithAbortSignal } from '../utils/abort-race.js';

export interface McpAuthorizationAction {
  readonly type: 'open_url';
  readonly serverId: string;
  readonly connectionId: string;
  readonly authorizationRequestId: string;
  readonly url: URL;
  readonly expiresAtMs: number;
}

export type McpAuthorizationStatusName =
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'expired';

export interface McpAuthorizationStatus {
  readonly status: McpAuthorizationStatusName;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly expiresAtMs?: number;
}

export type McpAuthorizationFailureKind =
  | 'provider_denied'
  | 'provider_unavailable'
  | 'authorization_failed'
  | 'request_expired'
  | 'connection_revoked'
  | 'browser_open_failed'
  | 'protocol_error'
  | 'reconnect_failed'
  | 'unknown';

export interface McpAuthorizationFailure {
  readonly kind: McpAuthorizationFailureKind;
  readonly userMessage: string;
}

/**
 * The connection was rejected because a host-brokered authorization is
 * required. The action is intentionally non-enumerable so generic error
 * logging cannot leak the authorization URL or request identifiers.
 */
export class McpAuthorizationRequiredError extends Error {
  override readonly name: string = 'McpAuthorizationRequiredError';
  declare readonly action: McpAuthorizationAction;

  constructor(action: McpAuthorizationAction) {
    super('MCP authorization is required.');
    Object.defineProperty(this, 'action', {
      value: action,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
}

export type McpAuthorizationOutcome =
  | { state: 'completed' }
  | { state: 'declined' | 'expired'; canRetryAuthorization: true }
  | { state: 'cancelled'; canRetryAuthorization: false }
  | {
      state: 'failed';
      failure: McpAuthorizationFailure;
      canRetryAuthorization: boolean;
    };

export type McpAuthorizationPreparation =
  | { kind: 'action'; action: McpAuthorizationAction }
  | { kind: 'connected' };

export class McpAuthorizationPreparationError extends Error {
  override readonly name: string = 'McpAuthorizationPreparationError';

  constructor(
    readonly kind: 'cancelled' | 'unavailable' | 'unsupported' | 'resolve_failed',
  ) {
    super(
      kind === 'cancelled'
        ? 'MCP authorization preparation was cancelled.'
        : kind === 'unsupported'
          ? 'MCP server does not use host-brokered authorization.'
          : kind === 'unavailable'
            ? 'MCP server is unavailable or disabled.'
            : 'MCP authorization could not be prepared. Retry authentication explicitly.',
    );
  }
}

export type McpAuthorizationState =
  | 'awaiting_confirmation'
  | 'opening_browser'
  | 'polling'
  | 'reconnecting'
  | 'completed'
  | 'declined'
  | 'failed'
  | 'expired'
  | 'cancelled';

export interface McpAuthorizationStateEvent {
  readonly serverNames: string[];
  readonly state: McpAuthorizationState;
  readonly message?: string;
  readonly failureKind?: McpAuthorizationFailureKind;
  readonly canRetryAuthorization?: boolean;
}

export interface McpAuthorizationHost {
  confirmOpenUrl(
    serverName: string,
    action: McpAuthorizationAction,
    signal: AbortSignal,
  ): Promise<'accepted' | 'declined'>;
  openUrl(url: URL, signal: AbortSignal): Promise<void>;
  onStateChanged?(event: McpAuthorizationStateEvent): void;
}

/** Display data the host UI needs for a server this coordinator handles. */
export interface McpServerPresentation {
  /** Label for how the server is reached, shown in connection summaries. */
  readonly connectionLabel: string;
  /** Extra config rows for the server detail view. */
  readonly detailFields?: ReadonlyArray<{
    readonly label: string;
    readonly value: string;
  }>;
}

/**
 * Host-injected coordinator for servers that need a brokered authorization.
 * The session manager owns the prepare/reconnect flow; the coordinator owns
 * the product-specific status polling and state machine.
 */
export interface McpAuthorizationCoordinator {
  canHandle(config: MCPServerConfig): boolean;
  getAction(serverName: string): McpAuthorizationAction | undefined;
  getState(serverName: string): McpAuthorizationState | undefined;
  authorize(
    serverName: string,
    host: McpAuthorizationHost,
  ): Promise<McpAuthorizationOutcome>;
  registerAction(
    serverName: string,
    action: McpAuthorizationAction,
    onSucceeded: () => Promise<void> | void,
  ): void;
  cancelServer(serverName: string): void;
  cancelAll(): void;
  /** Static config validation for a server this coordinator handles; throws when invalid. */
  validateServerConfig?(config: MCPServerConfig): void;
  /** How the host UI presents the server; omitted means it is not brokered. */
  getServerPresentation?(
    config: MCPServerConfig,
  ): McpServerPresentation | undefined;
}

export class McpConfigurationError extends Error {
  override readonly name: string = 'McpConfigurationError';

  constructor(
    message: string,
    readonly configuredAddress?: string,
    readonly expectedAddress?: string,
  ) {
    super(message);
  }
}

/** Confirm only the destination origin; never expose action paths or credentials. */
export const requestMcpAuthorizationConsent: McpAuthorizationHost['confirmOpenUrl'] =
  async (serverName, action, signal) => {
    signal.throwIfAborted();
    const accepted = await raceWithAbortSignal(
      getConsentForOauth(
        `MCP server "${sanitizeMcpAuthorizationMessage(serverName)}" requires authorization.\nYour browser will open this site:\n${action.url.origin}\n`,
        signal,
      ),
      signal,
    );
    signal.throwIfAborted();
    return accepted ? 'accepted' : 'declined';
  };

export function sanitizeMcpAuthorizationMessage(value: unknown): string {
  if (typeof value !== 'string') return 'Authorization failed';
  const sanitized = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f ? ' ' : character;
  })
    .join('')
    .trim();
  return sanitized.slice(0, 256) || 'Authorization failed';
}
