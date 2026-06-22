/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonClient } from './DaemonClient.js';
import {
  isNonBlockingAccepted,
  matchTurnEvent,
  normalizePendingPromptLimit,
  type CreateSessionRequest,
  type NonBlockingPromptAccepted,
  type PromptRequest,
  type RestoreSessionRequest,
  type SubscribeOptions,
} from './DaemonClient.js';
import type {
  DaemonForkSessionResult,
  DaemonEvent,
  DaemonRewindResult,
  DaemonRewindSnapshotInfo,
  DaemonSessionBtwResult,
  DaemonMidTurnMessageResult,
  DaemonSessionContextStatus,
  DaemonSessionContextUsageStatus,
  DaemonSessionRecapResult,
  DaemonShellCommandResult,
  DaemonSessionState,
  DaemonSession,
  DaemonSessionStatsStatus,
  DaemonSessionSupportedCommandsStatus,
  DaemonSessionTaskStatus,
  DaemonSessionTasksStatus,
  HeartbeatResult,
  PermissionResponse,
  PromptResult,
  SetModelResult,
  SessionMetadataResult,
} from './types.js';

/** Compacted replay snapshot returned by the daemon on session load. */
export interface DaemonReplaySnapshot {
  compactedReplay: DaemonEvent[];
  liveJournal: DaemonEvent[];
}

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
  /** Compacted replay snapshot from daemon load response. */
  replaySnapshot?: DaemonReplaySnapshot;
  /**
   * Local per-session prompt cap. The counter is shared with the parent
   * `DaemonClient`; other session clients using the same parent instance
   * contend on the same count. Set to `null`, `0`, or `Infinity` to disable
   * the local guard. Server-side admission still applies.
   */
  maxPendingPromptsPerSession?: number | null;
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
  readonly replaySnapshot: DaemonReplaySnapshot;
  private lastSeenEventId: number | undefined;
  private subscriptionActive = false;
  private readonly promptLimit: number;
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
    this.replaySnapshot = opts.replaySnapshot ?? {
      compactedReplay: [],
      liveJournal: [],
    };
    this.lastSeenEventId = validateLastEventId(opts.lastEventId);
    this.promptLimit =
      opts.maxPendingPromptsPerSession === undefined
        ? opts.client.maxPendingPromptsPerSession
        : normalizePendingPromptLimit(opts.maxPendingPromptsPerSession);
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
    //   mode. The daemon's `mcp_budget_warning` / `mcp_child_refused_batch`
    //   push events fire during this window and are buffered on
    //   `BridgeClient.earlyEvents` until `byId.set` runs, then drained
    //   into the per-session bus before `spawnOrAttach` returns. The
    //   guardrail events advertised via `mcp_guardrail_events` are
    //   useless without this seed because they predate any live
    //   subscription.
    // - **Carve-out**: `modelServiceId` switch failures are
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
    const {
      state,
      compactedReplay,
      liveJournal,
      lastEventId: serverLastEventId,
      ...session
    } = await client.loadSession(sessionId, req, clientId);
    return new DaemonSessionClient({
      client,
      session,
      state,
      lastEventId: serverLastEventId ?? 0,
      replaySnapshot: {
        compactedReplay: compactedReplay ?? [],
        liveJournal: liveJournal ?? [],
      },
    });
  }

  /**
   * Resumes an existing daemon session without requesting history replay.
   * When the daemon returns a watermark (`lastEventId`), uses it as the
   * initial SSE cursor. Falls back to 0 for older daemons so
   * post-resume events (e.g. `available_commands_update`) are captured.
   */
  static async resume(
    client: DaemonClient,
    sessionId: string,
    req: RestoreSessionRequest = {},
    clientId?: string,
  ): Promise<DaemonSessionClient> {
    const {
      state,
      lastEventId: serverLastEventId,
      ...session
    } = await client.resumeSession(sessionId, req, clientId);
    return new DaemonSessionClient({
      client,
      session,
      state,
      lastEventId: serverLastEventId ?? 0,
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
    signal?.throwIfAborted();
    if (!this.subscriptionActive) {
      return await this.client.prompt(
        this.sessionId,
        req,
        signal,
        this.clientId,
      );
    }

    const releaseAdmission = this.client.reservePromptSlot(
      this.sessionId,
      this.promptLimit,
    );
    let accepted: NonBlockingPromptAccepted | PromptResult;
    try {
      accepted = await this.client.promptNonBlocking(
        this.sessionId,
        req,
        signal,
        this.clientId,
      );
      if (!isNonBlockingAccepted(accepted)) {
        releaseAdmission();
        return accepted;
      }
      if (!this.subscriptionActive) {
        throw Error('SSE stream ended');
      }
    } catch (err) {
      releaseAdmission();
      throw err;
    }

    return new Promise<PromptResult>((resolve, reject) => {
      const onAbort = () => {
        const pending = this._pendingPrompts.get(accepted.promptId);
        if (pending && this._pendingPrompts.delete(accepted.promptId)) {
          this.client.cancel(this.sessionId, this.clientId).catch(() => {});
          pending.reject(
            signal!.reason ?? new DOMException('Aborted', 'AbortError'),
          );
        }
      };
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      this._pendingPrompts.set(accepted.promptId, {
        resolve: (r) => {
          cleanup();
          releaseAdmission();
          resolve(r);
        },
        reject: (e) => {
          cleanup();
          releaseAdmission();
          reject(e);
        },
      });
      if (signal?.aborted) {
        onAbort();
      } else {
        signal?.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  async cancel(): Promise<void> {
    await this.client.cancel(this.sessionId, this.clientId);
  }

  /**
   * Bump the daemon's last-seen bookkeeping for this session. Adapters
   * with a long-lived view of a session (TUI/IDE/web) can fire this on
   * an interval to keep diagnostics fresh and feed future revocation
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

  async getRewindSnapshots(): Promise<{
    snapshots: DaemonRewindSnapshotInfo[];
  }> {
    return await this.client.getRewindSnapshots(this.sessionId);
  }

  async rewind(promptId: string): Promise<DaemonRewindResult> {
    return await this.client.rewindSession(this.sessionId, promptId, {
      clientId: this.clientId,
    });
  }

  async fork(directive: string): Promise<DaemonForkSessionResult> {
    return await this.client.forkSession(
      this.sessionId,
      { directive },
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

  async btw(
    question: string,
    opts?: { signal?: AbortSignal },
  ): Promise<DaemonSessionBtwResult> {
    return await this.client.btwSession(this.sessionId, question, {
      ...(opts?.signal ? { signal: opts.signal } : {}),
      ...(this.clientId ? { clientId: this.clientId } : {}),
    });
  }

  /**
   * Queue a user message typed while this session's turn is still running so
   * the ACP child can drain it mid-turn. Forwards the client id bound at
   * create/attach. Resolves `{ accepted: false }` when the session is idle —
   * the caller should then send the message as a normal next-turn prompt.
   */
  async enqueueMidTurnMessage(
    message: string,
    opts?: { signal?: AbortSignal },
  ): Promise<DaemonMidTurnMessageResult> {
    return await this.client.enqueueMidTurnMessage(this.sessionId, message, {
      ...(opts?.signal ? { signal: opts.signal } : {}),
      ...(this.clientId ? { clientId: this.clientId } : {}),
    });
  }

  /**
   * Execute a direct daemon-side shell command for this session. Requires the
   * daemon to opt in to direct session shell and bearer auth; this wrapper
   * automatically forwards the client id bound when the session was created
   * or attached.
   */
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

  async cancelTask(
    taskId: string,
    kind: DaemonSessionTaskStatus['kind'],
  ): Promise<{ cancelled: boolean }> {
    return await this.client.sessionTaskCancel(
      this.sessionId,
      taskId,
      kind,
      this.clientId,
    );
  }

  async clearGoal(): Promise<{ cleared: boolean; condition?: string }> {
    return await this.client.sessionGoalClear(this.sessionId, this.clientId);
  }

  async stats(): Promise<DaemonSessionStatsStatus> {
    return await this.client.sessionStats(this.sessionId, this.clientId);
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
        throw new Error('subscription active');
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
    throw new TypeError('invalid lastEventId');
  }
  return lastEventId;
}
