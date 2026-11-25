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
 */
export interface WebShellSessionAdapter {
  createClient(
    options: DaemonClientOptions,
    Client: typeof DaemonClient,
  ): DaemonClient;
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
