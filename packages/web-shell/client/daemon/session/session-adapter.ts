/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CreateStandaloneSessionOptions,
  DaemonClient,
  DaemonClientOptions,
  DaemonSessionClient,
  PromptRequest,
  RestoreStandaloneSessionRequest,
} from '@qwen-code/sdk/daemon';

/**
 * Standalone session integration for an embedded WebShell.
 *
 * The client returned by `createClient` supplies capabilities and branding.
 * Custom subscriptions should call `opts.onEventStreamReady?.()` once ready
 * to deliver session events so the first prompt can be submitted on an idle stream.
 *
 * The host supplies admitted user messages through live events and restored
 * history. WebShell records local submission failures for recovery.
 * Continuations and other actions use the returned session client directly.
 */
export interface WebShellSessionAdapter {
  createClient(
    options: DaemonClientOptions,
    Client: typeof DaemonClient,
  ): DaemonClient;
  /** Apply and verify any startup configuration before returning the client. */
  create(
    client: DaemonClient,
    options: CreateStandaloneSessionOptions,
    SessionClient: typeof DaemonSessionClient,
  ): Promise<DaemonSessionClient>;
  load(
    client: DaemonClient,
    sessionId: string,
    options: RestoreStandaloneSessionRequest,
    clientId: string | undefined,
    SessionClient: typeof DaemonSessionClient,
  ): Promise<DaemonSessionClient>;
  /** Return the admitted prompt ID. Settle `completion` after the final transcript events or on stream failure. */
  submitPrompt(
    session: DaemonSessionClient,
    request: PromptRequest,
    signal?: AbortSignal,
  ): Promise<{ promptId: string; completion: Promise<void> }>;
}
