/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonClient } from './DaemonClient.js';
import {
  isNonBlockingAccepted,
  matchTurnEvent,
  type CreateSessionRequest,
  type PromptRequest,
  type RestoreSessionRequest,
  type SubscribeOptions,
} from './DaemonClient.js';
import type {
  DaemonEvent,
  DaemonSessionContextStatus,
  DaemonSessionContextUsageStatus,
  DaemonSessionRecapResult,
  DaemonShellCommandResult,
  DaemonSessionState,
  DaemonSession,
  DaemonSessionSupportedCommandsStatus,
  DaemonSessionTasksStatus,
  HeartbeatResult,
  PermissionResponse,
  PromptResult,
  SetModelResult,
  SessionMetadataResult,
} from './types.js';

export interface DaemonSessionClientOptions {
  client: DaemonClient;
  session: DaemonSession;
  /** ACP state returned by load/resume; empty for create/attach clients. */
  state?: DaemonSessionState;
  /**
   * Seed replay state for callers that persisted the last seen SSE event id.
   * When omitted, the first event subscription starts live. Values must be
   * finite, non-negative integers because the daemon uses these ids as
   * `Last-Event-ID` resume cursors.
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
 * schema layer — see `asKnownDaemonEvent` and `reduceDaemonSessionEvent` in
 * `./events.js` for the typed consumption surface.
 */
export class DaemonSessionClient {
  readonly client: DaemonClient;
  readonly session: DaemonSession;
  readonly state: DaemonSessionState;
  private lastSeenEventId: number | undefined;
  private subscriptionActive = false;
  private readonly _pendingPrompts = new Map<
    string,
    {
      resolve: (r: PromptResult) => void;
      reject: (e: unknown) => void;
    }
  >();

  constructor(opts: DaemonSessionClientOptions) {
    this.client = opts.client;
    this.session = { ...opts.session };
    this.state = { ...(opts.state ?? {}) };
    this.lastSeenEventId = validateLastEventId(opts.lastEventId);
  }

  /**
   * Creates a new daemon session or attaches to an existing matching session.
   */
  static async createOrAttach(
    client: DaemonClient,
    req: CreateSessionRequest = {},
    clientId?: string,
  ): Promise<DaemonSessionClient> {
    const session = await client.createOrAttachSession(req, clientId);
    // Seed the first subscription from the daemon replay ring whenever
    // events can fire during the session-creation window — otherwise
    // they land in the per-session ring before the consumer's first
    // `events()` call and never reach the live stream.
    //
    // Two such windows exist today:
    // - **Newly-created sessions** (`session.attached === false`): the
    //   child's `newSession` handler runs MCP discovery synchronously
    //   in legacy blocking mode and as background work in progressive
    //   mode. PR 14b's `mcp_budget_warning` / `mcp_child_refused_batch`
    //   push events fire during this window and are buffered on
    //   `BridgeClient.earlyEvents` until `byId.set` runs, then drained
    //   into the per-session bus before `spawnOrAttach` returns. The
    //   guardrail events advertised via `mcp_guardrail_events` are
    //   useless without this seed because they predate any live
    //   subscription.
    // - **Pre-PR 14b carve-out**: `modelServiceId` switch failures are
    //   reported on SSE, not the create/attach HTTP response. The
    //   original carve-out covered just this case; the unified rule
    //   below subsumes it (newly-created sessions always seed) while
    //   preserving the semantics for re-attached sessions where the
    //   caller may have an existing event cursor it doesn't want to
    //   reset.
    //
    // The daemon treats Last-Event-ID: 0 as "replay from the beginning
    // of the bounded ring"; if older events have already been evicted,
    // clients receive the retained suffix and continue live from there.
    const lastEventId = !session.attached || req.modelServiceId ? 0 : undefined;
    return new DaemonSessionClient({ client, session, lastEventId });
  }

  /**
   * Loads an existing daemon session and seeds the first event subscription
   * from the start of the daemon replay ring so history replay frames emitted
   * during `session/load` are visible to this client.
   */
  static async load(
    client: DaemonClient,
    sessionId: string,
    req: RestoreSessionRequest = {},
    clientId?: string,
  ): Promise<DaemonSessionClient> {
    const { state, ...session } = await client.loadSession(
      sessionId,
      req,
      clientId,
    );
    return new DaemonSessionClient({
      client,
      session,
      state,
      lastEventId: 0,
    });
  }

  /**
   * Resumes an existing daemon session without requesting history replay.
   * Seeds the first event subscription from the start of the daemon
   * replay ring (`lastEventId: 0`) symmetric with `load()` — the agent's
   * `unstable_resumeSession` schedules an `available_commands_update`
   * via `setTimeout(0)`, which can publish to the daemon bus between
   * the HTTP response and the consumer's first `events()` call. Seeding
   * ensures that frame is observed instead of dropped.
   */
  static async resume(
    client: DaemonClient,
    sessionId: string,
    req: RestoreSessionRequest = {},
    clientId?: string,
  ): Promise<DaemonSessionClient> {
    const { state, ...session } = await client.resumeSession(
      sessionId,
      req,
      clientId,
    );
    return new DaemonSessionClient({
      client,
      session,
      state,
      lastEventId: 0,
    });
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

  get clientId(): string | undefined {
    return this.session.clientId;
  }

  get lastEventId(): number | undefined {
    return this.lastSeenEventId;
  }

  setLastEventId(lastEventId: number | undefined): void {
    this.lastSeenEventId = validateLastEventId(lastEventId);
  }

  async prompt(
    req: PromptRequest,
    signal?: AbortSignal,
  ): Promise<PromptResult> {
    if (!this.subscriptionActive) {
      return await this.client.prompt(
        this.sessionId,
        req,
        signal,
        this.clientId,
      );
    }

    const accepted = await this.client.promptNonBlocking(
      this.sessionId,
      req,
      signal,
      this.clientId,
    );
    if (!isNonBlockingAccepted(accepted)) {
      return accepted;
    }

    return new Promise<PromptResult>((resolve, reject) => {
      const onAbort = () => {
        if (this._pendingPrompts.delete(accepted.promptId)) {
          this.client.cancel(this.sessionId, this.clientId).catch(() => {});
          reject(signal!.reason ?? new DOMException('Aborted', 'AbortError'));
        }
      };
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      this._pendingPrompts.set(accepted.promptId, {
        resolve: (r) => {
          cleanup();
          resolve(r);
        },
        reject: (e) => {
          cleanup();
          reject(e);
        },
      });
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  async cancel(): Promise<void> {
    await this.client.cancel(this.sessionId, this.clientId);
  }

  /**
   * Bump the daemon's last-seen bookkeeping for this session. Adapters
   * with a long-lived view of a session (TUI/IDE/web) can fire this on
   * an interval to keep diagnostics fresh and feed PR 24 revocation
   * policy. Forwards the bound `clientId` so identified clients update
   * their per-client timestamp instead of just the session-wide one.
   */
  async heartbeat(): Promise<HeartbeatResult> {
    return await this.client.heartbeat(this.sessionId, this.clientId);
  }

  async setModel(modelId: string): Promise<SetModelResult> {
    return await this.client.setSessionModel(
      this.sessionId,
      modelId,
      this.clientId,
    );
  }

  /**
   * One-sentence "where did I leave off" recap of this session. See
   * `DaemonClient.recapSession` for the full contract: best-effort
   * (may return `recap: null`); the optional `signal` aborts only the
   * local HTTP fetch — the daemon-side wait + the LLM call in the ACP
   * child both run to completion regardless (no cross-process abort
   * plumbing in v1).
   */
  async recap(opts?: {
    signal?: AbortSignal;
  }): Promise<DaemonSessionRecapResult> {
    return await this.client.recapSession(this.sessionId, {
      ...(opts?.signal ? { signal: opts.signal } : {}),
      ...(this.clientId ? { clientId: this.clientId } : {}),
    });
  }

  async shellCommand(
    command: string,
    signal?: AbortSignal,
  ): Promise<DaemonShellCommandResult> {
    return await this.client.shellCommand(this.sessionId, command, {
      ...(signal ? { signal } : {}),
      ...(this.clientId ? { clientId: this.clientId } : {}),
    });
  }

  async context(): Promise<DaemonSessionContextStatus> {
    return await this.client.sessionContext(this.sessionId, this.clientId);
  }

  async contextUsage(
    opts: { detail?: boolean } = {},
  ): Promise<DaemonSessionContextUsageStatus> {
    return await this.client.sessionContextUsage(
      this.sessionId,
      opts,
      this.clientId,
    );
  }

  async supportedCommands(): Promise<DaemonSessionSupportedCommandsStatus> {
    return await this.client.sessionSupportedCommands(
      this.sessionId,
      this.clientId,
    );
  }

  async tasks(): Promise<DaemonSessionTasksStatus> {
    return await this.client.sessionTasks(this.sessionId, this.clientId);
  }

  async respondToPermission(
    requestId: string,
    response: PermissionResponse,
  ): Promise<boolean> {
    return await this.client.respondToPermission(
      requestId,
      response,
      this.clientId,
    );
  }

  async respondToSessionPermission(
    requestId: string,
    response: PermissionResponse,
  ): Promise<boolean> {
    return await this.client.respondToSessionPermission(
      this.sessionId,
      requestId,
      response,
      this.clientId,
    );
  }

  async close(): Promise<void> {
    return await this.client.closeSession(this.sessionId, this.clientId);
  }

  async updateMetadata(metadata: {
    displayName?: string;
  }): Promise<SessionMetadataResult> {
    return await this.client.updateSessionMetadata(
      this.sessionId,
      metadata,
      this.clientId,
    );
  }

  events(
    opts: DaemonSessionSubscribeOptions = {},
  ): AsyncGenerator<DaemonEvent, void, unknown> {
    return this.openEventSubscription(opts);
  }

  /**
   * @deprecated Use {@link events} instead. Both methods are equivalent.
   */
  subscribeEvents(
    opts: DaemonSessionSubscribeOptions = {},
  ): AsyncGenerator<DaemonEvent, void, unknown> {
    return this.openEventSubscription(opts);
  }

  private openEventSubscription(
    opts: DaemonSessionSubscribeOptions,
  ): AsyncGenerator<DaemonEvent, void, unknown> {
    const requestedLastEventId = validateLastEventId(opts.lastEventId);
    let started = false;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.subscriptionActive = false;
    };
    const acquire = () => {
      if (started) return;
      if (this.subscriptionActive) {
        throw new Error(
          'Another event subscription is already active on this session. ' +
            'Reuse the existing AsyncGenerator or create a separate DaemonSessionClient.',
        );
      }
      this.subscriptionActive = true;
      started = true;
    };
    const iterator = this.iterateEvents(
      { ...opts, lastEventId: requestedLastEventId },
      release,
    );

    return {
      next: async (value?: unknown) => {
        if (!released) {
          acquire();
        }
        return await iterator.next(value);
      },
      return: async () => {
        try {
          return await iterator.return(undefined);
        } finally {
          release();
        }
      },
      throw: async (error?: unknown) => {
        try {
          return await iterator.throw(error);
        } finally {
          release();
        }
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }

  private async *iterateEvents(
    opts: DaemonSessionSubscribeOptions,
    release: () => void,
  ): AsyncGenerator<DaemonEvent, void, unknown> {
    try {
      const { resume = true, ...subscribeOpts } = opts;
      const lastEventId =
        subscribeOpts.lastEventId ??
        (resume ? this.lastSeenEventId : undefined);

      for await (const event of this.client.subscribeEvents(this.sessionId, {
        ...subscribeOpts,
        lastEventId,
      })) {
        this._dispatchTurnEvent(event);
        yield event;
        if (event.id !== undefined) {
          this.lastSeenEventId = Math.max(
            this.lastSeenEventId ?? 0,
            validateLastEventId(event.id),
          );
        }
      }
    } finally {
      this._rejectAllPending(new Error('SSE stream ended'));
      release();
    }
  }

  private _dispatchTurnEvent(event: DaemonEvent): void {
    if (event.type !== 'turn_complete' && event.type !== 'turn_error') return;
    const promptId = (event.data as { promptId?: string } | null | undefined)
      ?.promptId;
    if (!promptId) return;
    const pending = this._pendingPrompts.get(promptId);
    if (!pending) return;
    this._pendingPrompts.delete(promptId);
    try {
      const result = matchTurnEvent(event, promptId);
      if (result !== undefined) pending.resolve(result);
    } catch (err) {
      pending.reject(err);
    }
  }

  private _rejectAllPending(err: unknown): void {
    for (const [, pending] of this._pendingPrompts) {
      pending.reject(err);
    }
    this._pendingPrompts.clear();
  }
}

function validateLastEventId(lastEventId: number): number;
function validateLastEventId(lastEventId: undefined): undefined;
function validateLastEventId(
  lastEventId: number | undefined,
): number | undefined;
function validateLastEventId(
  lastEventId: number | undefined,
): number | undefined {
  if (lastEventId === undefined) return undefined;
  if (!Number.isInteger(lastEventId) || lastEventId < 0) {
    throw new TypeError('lastEventId must be a finite non-negative integer');
  }
  return lastEventId;
}
