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
 * The client returned by `createClient` should invoke
 * `opts.onSseStreamAccepted?.(streamId)` once its live event stream is ready
 * so `DaemonSessionClient.waitForEventStream()` unblocks immediately.
 *
 * The host supplies user messages through its live events and restored history.
 * WebShell does not insert an optimistic copy for adapter submissions.
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
  /** Resolve once the prompt is identified and report native stream failure through completion. */
  submitPrompt(
    session: DaemonSessionClient,
    request: PromptRequest,
    signal?: AbortSignal,
  ): Promise<{ promptId: string; completion: Promise<void> }>;
}
