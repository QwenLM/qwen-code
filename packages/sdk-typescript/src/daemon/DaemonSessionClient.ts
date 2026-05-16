/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonClient } from './DaemonClient.js';
import {
  type CreateSessionRequest,
  type PromptRequest,
  type SubscribeOptions,
} from './DaemonClient.js';
import type {
  DaemonEvent,
  DaemonSession,
  PermissionResponse,
  PromptResult,
  SetModelResult,
} from './types.js';

export interface DaemonSessionClientOptions {
  client: DaemonClient;
  session: DaemonSession;
  /**
   * Seed replay state for callers that persisted the last seen SSE event id.
   * When omitted, the first event subscription starts live.
   */
  lastEventId?: number;
}

export interface DaemonSessionSubscribeOptions extends SubscribeOptions {
  /**
   * Reuse this client's last seen SSE event id when `lastEventId` is not
   * supplied. Defaults to true so reconnecting client adapters get replay
   * behavior without carrying the id through every call.
   */
  resume?: boolean;
}

/**
 * Session-scoped wrapper around `DaemonClient`.
 *
 * `DaemonClient` mirrors the raw HTTP API and requires a `sessionId` on each
 * method. `DaemonSessionClient` is the adapter-facing layer for TUI, channel,
 * IDE, and web backends: it binds one daemon session, forwards the existing
 * Stage 1 routes, and preserves SSE replay state. It intentionally does not
 * interpret daemon event payloads; typed event reducers belong to the protocol
 * schema layer.
 */
export class DaemonSessionClient {
  readonly client: DaemonClient;
  readonly session: DaemonSession;
  private lastSeenEventId: number | undefined;
  private subscriptionActive = false;

  constructor(opts: DaemonSessionClientOptions) {
    this.client = opts.client;
    this.session = { ...opts.session };
    this.lastSeenEventId = opts.lastEventId;
  }

  /**
   * Creates a new daemon session or attaches to an existing matching session.
   */
  static async createOrAttach(
    client: DaemonClient,
    req: CreateSessionRequest = {},
  ): Promise<DaemonSessionClient> {
    const session = await client.createOrAttachSession(req);
    // `modelServiceId` switch failures are reported on SSE, not the
    // create/attach HTTP response. Seed the first subscription from the
    // daemon replay ring so create-then-subscribe clients observe attach-time
    // `model_switch_failed` / `model_switched` events.
    const lastEventId = req.modelServiceId ? 0 : undefined;
    return new DaemonSessionClient({ client, session, lastEventId });
  }

  get sessionId(): string {
    return this.session.sessionId;
  }

  get workspaceCwd(): string {
    return this.session.workspaceCwd;
  }

  get attached(): boolean {
    return this.session.attached;
  }

  get lastEventId(): number | undefined {
    return this.lastSeenEventId;
  }

  setLastEventId(lastEventId: number | undefined): void {
    this.lastSeenEventId = lastEventId;
  }

  async prompt(
    req: PromptRequest,
    signal?: AbortSignal,
  ): Promise<PromptResult> {
    return await this.client.prompt(this.sessionId, req, signal);
  }

  async cancel(): Promise<void> {
    await this.client.cancel(this.sessionId);
  }

  async setModel(modelId: string): Promise<SetModelResult> {
    return await this.client.setSessionModel(this.sessionId, modelId);
  }

  async respondToPermission(
    requestId: string,
    response: PermissionResponse,
  ): Promise<boolean> {
    return await this.client.respondToPermission(requestId, response);
  }

  events(
    opts: DaemonSessionSubscribeOptions = {},
  ): AsyncGenerator<DaemonEvent> {
    return this.subscribeEvents(opts);
  }

  async *subscribeEvents(
    opts: DaemonSessionSubscribeOptions = {},
  ): AsyncGenerator<DaemonEvent> {
    if (this.subscriptionActive) {
      throw new Error(
        'Another event subscription is already active on this session. ' +
          'Reuse the existing AsyncGenerator or create a separate DaemonSessionClient.',
      );
    }

    this.subscriptionActive = true;
    try {
      const { resume = true, ...subscribeOpts } = opts;
      const lastEventId =
        subscribeOpts.lastEventId ??
        (resume ? this.lastSeenEventId : undefined);

      for await (const event of this.client.subscribeEvents(this.sessionId, {
        ...subscribeOpts,
        lastEventId,
      })) {
        yield event;
        // Terminal/synthetic frames may not carry an SSE id.
        if (event.id !== undefined) this.lastSeenEventId = event.id;
      }
    } finally {
      this.subscriptionActive = false;
    }
  }
}
