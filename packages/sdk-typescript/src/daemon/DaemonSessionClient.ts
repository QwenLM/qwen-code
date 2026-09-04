/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonClient } from './DaemonClient.js';
import { DaemonHttpError } from './DaemonHttpError.js';
import {
  isNonBlockingAccepted,
  matchTurnEvent,
  normalizePendingPromptLimit,
  type CreateSessionRequest,
  type DaemonSseConnectReason,
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
  DaemonSessionAttachmentData,
  DaemonSessionAttachmentReference,
  DaemonSessionTranscriptPage,
  DaemonSessionTranscriptPageOptions,
  DaemonSessionTurnIndexPage,
  DaemonSessionTurnIndexPageOptions,
  DaemonSessionGenerationEvent,
  DaemonMidTurnMessageResult,
  DaemonMidTurnMessagesResult,
  DaemonRemoveMidTurnMessageResult,
  DaemonPendingPromptsResult,
  DaemonRemovePendingPromptResult,
  DaemonSessionContextStatus,
  DaemonSessionContextUsageStatus,
  DaemonSessionConfigOptionResult,
  ReasoningSelection,
  DaemonSessionLspStatus,
  DaemonSessionResourcesStatus,
  DaemonSessionRecapResult,
  DaemonSessionSummary,
  DaemonShellCommandResult,
  DaemonSessionArtifactInput,
  DaemonSessionArtifactMutationResult,
  DaemonSessionArtifactsEnvelope,
  DaemonSessionState,
  DaemonSession,
  DaemonSessionStatsStatus,
  DaemonSessionSupportedCommandsStatus,
  DaemonSessionTaskWithWorkflowStatus,
  DaemonSessionTasksStatus,
  DaemonSessionWorkflowTaskStatus,
  DaemonSessionWorkflowTasksStatus,
  DaemonSessionSavedWorkflowStatus,
  HeartbeatResult,
  GoalControlRequest,
  GoalStateResponse,
  PermissionResponse,
  PromptContentBlock,
  PromptResult,
  SetModelResult,
  SessionMetadataResult,
  DaemonSessionPrInfo,
} from './types.js';
import type {
  CreateStandaloneSessionOptions,
  DaemonRestoredStandaloneSession,
  RestoreStandaloneSessionRequest,
} from './standalone-sessions.js';

/** Compacted replay snapshot returned by the daemon on session load. */
export interface DaemonReplaySnapshot {
  compactedReplay: DaemonEvent[];
  liveJournal: DaemonEvent[];
}

export interface DaemonSessionClientOptions {
  client: DaemonClient;
  session: DaemonSession;
  /** True when load/resume attached to a session with an in-flight prompt. */
  hasActivePrompt?: boolean;
  /** ACP state returned by load/resume; empty for create/attach clients. */
  state?: DaemonSessionState;
  /**
   * Seed replay state for callers that persisted the last seen SSE event id.
   * When omitted, the first event subscription starts live. Values must be
   * finite, non-negative integers because the daemon uses these ids as
   * `Last-Event-ID` resume cursors.
   */
  lastEventId?: number;
  /**
   * Epoch token of the event bus that produced `lastEventId` (the
   * `eventEpoch` field of load/resume responses). Paired with the cursor
   * on every subscription so a daemon restart is detected as an epoch
   * mismatch instead of a numeric guess. Absent on older daemons — the
   * first subscription then learns the epoch from the
   * `X-Qwen-Event-Epoch` response header.
   */
  eventEpoch?: string;
  /** Compacted replay snapshot from daemon load response. */
  replaySnapshot?: DaemonReplaySnapshot;
  /** True when the load response explicitly carried both replay arrays. */
  replaySnapshotComplete?: boolean;
  /** True when persisted replay was only partially reconstructed. */
  replayPartial?: boolean;
  /** Diagnostic for a partial persisted replay. */
  replayError?: string;
  /** True when older persisted records precede the replay snapshot. */
  historyHasMore?: boolean;
  /**
   * Fallback pagination anchor from the daemon: the oldest
   * `qwen.session.recordId` in the last persisted transcript page,
   * read from the transcript when the replay
   * snapshot's `history_truncated` marker carries none (live sessions
   * whose in-flight turn capped the journal before any turn boundary).
   * Clients use it as `beforeRecordId` when no recordId is available
   * in the retained window.
   */
  historyAnchorRecordId?: string;
  /**
   * True when the daemon reported the replay snapshot as degraded (the
   * compaction engine failed at least once for this session). Consumers
   * should prefer the full transcript over the snapshot when set.
   */
  replayDegraded?: boolean;
  /**
   * Local per-session prompt cap. The counter is shared with the parent
   * `DaemonClient`; other session clients using the same parent instance
   * contend on the same count. Set to `null`, `0`, or `Infinity` to disable
   * the local guard. Server-side admission still applies.
   */
  maxPendingPromptsPerSession?: number | null;
}

export type DaemonSessionRestoreStrategy =
  | { kind: 'workspace'; workspaceCwd: string }
  | { kind: 'standalone' };

export interface DaemonSessionSubscribeOptions
  extends Omit<
    SubscribeOptions,
    'clientId' | 'previousSseStreamId' | 'onSseStreamAccepted'
  > {
  /**
   * Reuse this client's last seen SSE event id when `lastEventId` is not
   * supplied. Defaults to true so reconnecting client adapters get replay
   * behavior without carrying the id through every call.
   */
  resume?: boolean;
}

function isSessionAttachmentReference(
  value: unknown,
): value is DaemonSessionAttachmentReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    (record['type'] === 'image' || record['type'] === 'resource') &&
    typeof record['attachmentId'] === 'string' &&
    record['attachmentId'].length > 0 &&
    typeof record['mimeType'] === 'string' &&
    record['mimeType'].length > 0 &&
    (record['type'] !== 'image' || record['mimeType'].startsWith('image/')) &&
    typeof record['size'] === 'number' &&
    Number.isSafeInteger(record['size']) &&
    record['size'] >= 0 &&
    (record['type'] !== 'image' || record['size'] > 0)
  );
}

const MAX_ATTACHMENT_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_ATTACHMENT_CACHE_ENTRIES = 128;

function createStandaloneRestoredClient(
  client: DaemonClient,
  restored: DaemonRestoredStandaloneSession,
  includeReplay: boolean,
): DaemonSessionClient {
  const {
    state,
    hasActivePrompt,
    compactedReplay,
    liveJournal,
    historyHasMore,
    historyAnchorRecordId,
    replayDegraded,
    partial,
    replayError,
    lastEventId,
    eventEpoch,
    ...session
  } = restored;
  return new DaemonSessionClient({
    client,
    session,
    hasActivePrompt,
    state,
    lastEventId: lastEventId ?? 0,
    eventEpoch,
    ...(includeReplay
      ? {
          replaySnapshot: {
            compactedReplay: compactedReplay ?? [],
            liveJournal: liveJournal ?? [],
          },
          replaySnapshotComplete:
            Array.isArray(compactedReplay) && Array.isArray(liveJournal),
          replayPartial: partial === true,
          replayError,
          historyHasMore,
          historyAnchorRecordId,
          replayDegraded,
        }
      : {}),
  });
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
  readonly restoreStrategy: DaemonSessionRestoreStrategy;
  readonly state: DaemonSessionState;
  /**
   * Not `readonly`: {@link consumeReplaySnapshot} swaps it for an empty
   * snapshot once the provider has injected it into the transcript store,
   * releasing the raw wire events (tens of MiB on busy sessions) instead of
   * retaining them for the session client's lifetime.
   */
  replaySnapshot: DaemonReplaySnapshot;
  readonly replaySnapshotComplete: boolean;
  readonly replayPartial: boolean;
  readonly replayError: string | undefined;
  readonly hasActivePrompt: boolean;
  readonly historyHasMore: boolean;
  /**
   * Fallback pagination anchor from the daemon load response (see
   * {@link DaemonSessionClientOptions.historyAnchorRecordId}). Undefined
   * when the retained window already carries a recordId or the daemon
   * could not read one from the persisted transcript.
   */
  readonly historyAnchorRecordId: string | undefined;
  /**
   * True when the load response flagged the replay snapshot as degraded
   * (`replayDegraded` — compaction failed at least once, so
   * `replaySnapshot` may lag behind live events). Prefer the full
   * transcript (see `fullTranscriptAvailable`) when set.
   */
  readonly replayDegraded: boolean;
  private lastSeenEventId: number | undefined;
  /**
   * Epoch token paired with {@link lastSeenEventId}. Seeded from the
   * load/resume/create response when available, refreshed from every
   * subscription's `X-Qwen-Event-Epoch` response header.
   */
  private lastSeenEpoch: string | undefined;
  private hasAcceptedRestStream = false;
  private lastAcceptedRestStreamId: string | undefined;
  private subscriptionActive = false;
  /** In-flight `reattach()` so concurrent prompts re-register only once. */
  private reattaching?: Promise<void>;
  private cancelling?: Promise<void>;
  private readonly promptLimit: number;
  private readonly attachmentCache = new Map<
    string,
    { pending: Promise<DaemonSessionAttachmentData>; size: number }
  >();
  private attachmentCacheBytes = 0;
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
    const context = (opts.session as { context?: { kind?: unknown } }).context;
    this.restoreStrategy =
      opts.session.sourceType === 'standalone' && context?.kind === 'standalone'
        ? { kind: 'standalone' }
        : { kind: 'workspace', workspaceCwd: opts.session.workspaceCwd };
    this.state = { ...(opts.state ?? {}) };
    this.hasActivePrompt = opts.hasActivePrompt ?? false;
    this.historyHasMore = opts.historyHasMore ?? false;
    this.historyAnchorRecordId = opts.historyAnchorRecordId;
    this.replayDegraded = opts.replayDegraded ?? false;
    this.replaySnapshot = opts.replaySnapshot ?? {
      compactedReplay: [],
      liveJournal: [],
    };
    this.replaySnapshotComplete = opts.replaySnapshotComplete ?? false;
    this.replayPartial = opts.replayPartial ?? false;
    this.replayError = opts.replayError;
    this.lastSeenEventId = validateLastEventId(opts.lastEventId);
    this.lastSeenEpoch = opts.eventEpoch;
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
    // - **Carve-out**: attach-time `modelServiceId` and
    //   `approvalMode` changes are reported on SSE, not only the
    //   create/attach HTTP response. The original carve-out covered
    //   just model changes; approval-mode changes have the same
    //   pre-subscription event window. The unified rule below subsumes
    //   newly-created sessions while preserving re-attach semantics for
    //   callers without attach-time state changes.
    //
    // The daemon treats Last-Event-ID: 0 as "replay from the beginning
    // of the bounded ring"; if older events have already been evicted,
    // clients receive the retained suffix and continue live from there.
    const lastEventId =
      !session.attached || req.modelServiceId || req.approvalMode
        ? 0
        : undefined;
    return new DaemonSessionClient({
      client,
      session,
      hasActivePrompt: session.hasActivePrompt,
      lastEventId,
      // Newer daemons may stamp the bus epoch on the create/attach
      // response; older ones don't — the first subscription then learns it
      // from the `X-Qwen-Event-Epoch` response header.
      eventEpoch: session.eventEpoch,
    });
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
    const restored = await client.loadSession(sessionId, req, clientId);
    const replaySnapshotComplete =
      Array.isArray(restored.compactedReplay) &&
      Array.isArray(restored.liveJournal);
    const {
      state,
      hasActivePrompt,
      compactedReplay,
      liveJournal,
      historyHasMore,
      historyAnchorRecordId,
      replayDegraded,
      partial,
      replayError,
      lastEventId: serverLastEventId,
      eventEpoch,
      ...session
    } = restored;
    const result = new DaemonSessionClient({
      client,
      session,
      hasActivePrompt,
      state,
      lastEventId: serverLastEventId ?? 0,
      eventEpoch,
      replaySnapshot: {
        compactedReplay: compactedReplay ?? [],
        liveJournal: liveJournal ?? [],
      },
      replaySnapshotComplete,
      replayPartial: partial === true,
      replayError,
      historyHasMore,
      historyAnchorRecordId,
      replayDegraded,
    });
    await result.hydrateReplaySnapshot();
    return result;
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
      hasActivePrompt,
      lastEventId: serverLastEventId,
      eventEpoch,
      ...session
    } = await client.resumeSession(sessionId, req, clientId);
    return new DaemonSessionClient({
      client,
      session,
      hasActivePrompt,
      state,
      lastEventId: serverLastEventId ?? 0,
      eventEpoch,
    });
  }

  static async createStandalone(
    client: DaemonClient,
    options: CreateStandaloneSessionOptions = {},
  ): Promise<DaemonSessionClient> {
    const session = await client.createStandaloneSession(options);
    return new DaemonSessionClient({
      client,
      session,
      hasActivePrompt: session.hasActivePrompt,
      lastEventId: 0,
      eventEpoch: session.eventEpoch,
    });
  }

  static async loadStandalone(
    client: DaemonClient,
    sessionId: string,
    request: RestoreStandaloneSessionRequest = {},
    clientId?: string,
  ): Promise<DaemonSessionClient> {
    const restored = await client.loadStandaloneSession(
      sessionId,
      request,
      clientId,
    );
    const result = createStandaloneRestoredClient(client, restored, true);
    await result.hydrateReplaySnapshot();
    return result;
  }

  static async resumeStandalone(
    client: DaemonClient,
    sessionId: string,
    request: RestoreStandaloneSessionRequest = {},
    clientId?: string,
  ): Promise<DaemonSessionClient> {
    const restored = await client.resumeStandaloneSession(
      sessionId,
      request,
      clientId,
    );
    return createStandaloneRestoredClient(client, restored, false);
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

  get worktree(): DaemonSession['worktree'] {
    return this.session.worktree;
  }

  get branch(): DaemonSession['branch'] {
    return this.session.branch;
  }

  /**
   * Present when this client was created with a `modelServiceId`: `false`
   * means the spawn-time model switch failed and the session is running on
   * the agent default model.
   */
  get modelApplied(): DaemonSession['modelApplied'] {
    return this.session.modelApplied;
  }

  get lastEventId(): number | undefined {
    return this.lastSeenEventId;
  }

  get eventEpoch(): string | undefined {
    return this.lastSeenEpoch;
  }

  /**
   * Returns the retained replay snapshot and drops the client's reference
   * to it. Call once the snapshot has been injected into a transcript
   * store; the raw wire events are no longer needed (SSE continues from
   * `lastEventId`, and older history is served by pagination) and can
   * otherwise pin tens of MiB per session client.
   */
  consumeReplaySnapshot(): DaemonReplaySnapshot {
    const snapshot = this.replaySnapshot;
    this.replaySnapshot = { compactedReplay: [], liveJournal: [] };
    return snapshot;
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
      return await this.withClientIdSelfHeal(() =>
        this.client.prompt(this.sessionId, req, signal, this.clientId),
      );
    }

    const releaseAdmission = this.client.reservePromptSlot(
      this.sessionId,
      this.promptLimit,
    );
    let accepted: NonBlockingPromptAccepted | PromptResult;
    try {
      accepted = await this.withClientIdSelfHeal(() =>
        this.client.promptNonBlocking(
          this.sessionId,
          req,
          signal,
          this.clientId,
        ),
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
          this.cancel().catch(() => {});
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

  /**
   * Submit a prompt and return as soon as the daemon accepts it.
   *
   * This is admission-only: it does not reserve a client-side prompt slot,
   * register the prompt in `_pendingPrompts`, or wait for the matching
   * `turn_complete` / `turn_error` SSE event. Callers that need final turn
   * results should use `prompt()` or manage SSE terminal events themselves.
   */
  async submitPrompt(
    req: PromptRequest,
    signal?: AbortSignal,
  ): Promise<NonBlockingPromptAccepted> {
    signal?.throwIfAborted();
    const accepted = await this.withClientIdSelfHeal(() =>
      this.client.promptNonBlocking(this.sessionId, req, signal, this.clientId),
    );
    if (!isNonBlockingAccepted(accepted)) {
      throw new Error('Expected non-blocking prompt acceptance');
    }
    return accepted;
  }

  async uploadAttachment(
    data: Blob,
    name: string,
    mimeType: string,
    signal?: AbortSignal,
  ): Promise<DaemonSessionAttachmentReference> {
    return await this.withClientIdSelfHeal(() =>
      this.client.uploadSessionAttachment(
        this.sessionId,
        data,
        name,
        mimeType,
        {
          ...(signal ? { signal } : {}),
          ...(this.clientId ? { clientId: this.clientId } : {}),
        },
      ),
    );
  }

  async readAttachment(
    attachmentId: string,
    signal?: AbortSignal,
  ): Promise<DaemonSessionAttachmentData> {
    return await this.withClientIdSelfHeal(() =>
      this.client.readSessionAttachment(this.sessionId, attachmentId, {
        ...(signal ? { signal } : {}),
        ...(this.clientId ? { clientId: this.clientId } : {}),
      }),
    );
  }

  async removeAttachment(
    attachmentId: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const removed = await this.withClientIdSelfHeal(() =>
      this.client.removeSessionAttachment(this.sessionId, attachmentId, {
        ...(signal ? { signal } : {}),
        ...(this.clientId ? { clientId: this.clientId } : {}),
      }),
    );
    if (removed) {
      const cached = this.attachmentCache.get(attachmentId);
      this.attachmentCache.delete(attachmentId);
      this.attachmentCacheBytes -= cached?.size ?? 0;
    }
    return removed;
  }

  /**
   * Run a prompt-admission call, recovering from a stale `clientId`.
   *
   * A daemon restart (or session reload) wipes the daemon's in-memory client
   * registration, so a prompt sent with our now-unknown `clientId` is rejected
   * at admission with `400 invalid_client_id` (see PR #5784). That rejection
   * happens before the turn is registered, so the prompt never ran — retrying
   * cannot double-execute. We re-register to obtain a fresh `clientId` and
   * retry the admission exactly once. Any other error (and a second
   * `invalid_client_id`) propagates.
   */
  private async withClientIdSelfHeal<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (!isInvalidClientId(err)) throw err;
      await this.reattach();
      return await fn();
    }
  }

  /**
   * Re-register this client against the (already-restored) session to obtain a
   * fresh daemon-assigned `clientId`. Concurrent callers coalesce onto a single
   * in-flight `resume` so we never orphan extra registrations.
   */
  private async reattach(): Promise<void> {
    if (this.reattaching) return this.reattaching;
    // Send no clientId so the bridge issues a fresh registration rather than
    // validating the stale one. Keep the original context explicit: workspace
    // restore resolves by cwd, while standalone restore must use its dedicated
    // route and never fall back to the primary runtime.
    const resume =
      this.restoreStrategy.kind === 'standalone'
        ? this.client.resumeStandaloneSession(this.sessionId)
        : this.client.resumeSession(this.sessionId, {
            workspaceCwd: this.restoreStrategy.workspaceCwd,
          });
    this.reattaching = resume.then((session) => {
      // Refresh only the clientId; leave the SSE cursor and ACP state intact.
      this.session.clientId = session.clientId;
    });
    try {
      await this.reattaching;
    } finally {
      this.reattaching = undefined;
    }
  }

  async cancel(): Promise<void> {
    const cancelling =
      this.cancelling ?? this.client.cancel(this.sessionId, this.clientId);
    this.cancelling = cancelling;
    try {
      await cancelling;
    } finally {
      if (this.cancelling === cancelling) {
        this.cancelling = undefined;
      }
    }
  }

  /**
   * Bump the daemon's last-seen bookkeeping for this session. Adapters
   * with a long-lived view of a session (TUI/IDE/web) can fire this on
   * an interval to keep diagnostics fresh and feed future revocation
   * policy. Forwards the bound `clientId` so identified clients update
   * their per-client timestamp instead of just the session-wide one.
   */
  heartbeat(): Promise<HeartbeatResult> {
    return this.client.heartbeat(this.sessionId, this.clientId);
  }

  artifacts(): Promise<DaemonSessionArtifactsEnvelope> {
    return this.client.listSessionArtifacts(this.sessionId, this.clientId);
  }

  addArtifact(
    artifact: DaemonSessionArtifactInput,
  ): Promise<DaemonSessionArtifactMutationResult> {
    return this.client.addSessionArtifact(
      this.sessionId,
      artifact,
      this.clientId,
    );
  }

  removeArtifact(
    artifactId: string,
  ): Promise<DaemonSessionArtifactMutationResult> {
    return this.client.removeSessionArtifact(
      this.sessionId,
      artifactId,
      this.clientId,
    );
  }

  setModel(modelId: string): Promise<SetModelResult> {
    return this.client.setSessionModel(this.sessionId, modelId, this.clientId);
  }

  setConfigOption(
    configId: 'reasoning_effort',
    value: ReasoningSelection,
    opts?: { persist?: boolean },
  ): Promise<DaemonSessionConfigOptionResult> {
    return this.client.setSessionConfigOption(this.sessionId, configId, value, {
      clientId: this.clientId,
      persist: opts?.persist,
    });
  }

  getRewindSnapshots(): Promise<{
    snapshots: DaemonRewindSnapshotInfo[];
  }> {
    return this.client.getRewindSnapshots(this.sessionId);
  }

  rewind(
    promptId: string,
    opts?: { rewindFiles?: boolean },
  ): Promise<DaemonRewindResult> {
    return this.client.rewindSession(this.sessionId, promptId, {
      clientId: this.clientId,
      ...(opts?.rewindFiles !== undefined
        ? { rewindFiles: opts.rewindFiles }
        : {}),
    });
  }

  fork(directive: string): Promise<DaemonForkSessionResult> {
    return this.client.forkSession(
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
  recap(opts?: { signal?: AbortSignal }): Promise<DaemonSessionRecapResult> {
    return this.client.recapSession(this.sessionId, {
      ...(opts?.signal ? { signal: opts.signal } : {}),
      ...(this.clientId ? { clientId: this.clientId } : {}),
    });
  }

  generateContent(
    prompt: string,
    opts?: { signal?: AbortSignal },
  ): AsyncGenerator<DaemonSessionGenerationEvent> {
    return this.client.generateSessionContent(this.sessionId, prompt, {
      ...(opts?.signal ? { signal: opts.signal } : {}),
      ...(this.clientId ? { clientId: this.clientId } : {}),
    });
  }

  btw(
    question: string,
    opts?: { signal?: AbortSignal },
  ): Promise<DaemonSessionBtwResult> {
    return this.client.btwSession(this.sessionId, question, {
      ...(opts?.signal ? { signal: opts.signal } : {}),
      ...(this.clientId ? { clientId: this.clientId } : {}),
    });
  }

  /**
   * Queue a user message typed while this session's turn is still running so
   * the ACP child can drain it mid-turn. Forwards the client id bound at
   * create/attach. Accepted requests become daemon-owned even when the active
   * turn settles while the request is in flight.
   */
  enqueueMidTurnMessage(
    message: string,
    opts?: {
      signal?: AbortSignal;
      messageId?: string;
      content?: PromptContentBlock[];
    },
  ): Promise<DaemonMidTurnMessageResult> {
    return this.client.enqueueMidTurnMessage(this.sessionId, message, {
      ...(opts?.signal ? { signal: opts.signal } : {}),
      ...(opts?.messageId ? { messageId: opts.messageId } : {}),
      ...(opts?.content && opts.content.length > 0
        ? { content: opts.content }
        : {}),
      ...(this.clientId ? { clientId: this.clientId } : {}),
    });
  }

  removeMidTurnMessage(
    messageId: string,
  ): Promise<DaemonRemoveMidTurnMessageResult> {
    return this.client.removeMidTurnMessage(this.sessionId, messageId, {
      ...(this.clientId ? { clientId: this.clientId } : {}),
    });
  }

  /**
   * Fetch the mid-turn reconciliation snapshot (queue + delivery-state rings) for
   * this session. Forwards the bound client id. See
   * `DaemonClient.getMidTurnMessages` — requires the daemon to advertise
   * `session_mid_turn_message_query`; older daemons reject with 404 and
   * callers preserve their current state.
   */
  async getMidTurnMessages(opts?: {
    signal?: AbortSignal;
  }): Promise<DaemonMidTurnMessagesResult> {
    const result = await this.client.getMidTurnMessages(this.sessionId, {
      ...(opts?.signal ? { signal: opts.signal } : {}),
      ...(this.clientId ? { clientId: this.clientId } : {}),
    });
    return {
      ...result,
      messages: await Promise.all(
        result.messages.map(async (message) => ({
          ...message,
          ...(message.content
            ? { content: await this.hydrateContent(message.content) }
            : {}),
        })),
      ),
    };
  }

  async getPendingPrompts(): Promise<DaemonPendingPromptsResult> {
    const result = await this.client.getPendingPrompts(this.sessionId, {
      ...(this.clientId ? { clientId: this.clientId } : {}),
    });
    return {
      pendingPrompts: await Promise.all(
        result.pendingPrompts.map(async (prompt) => ({
          ...prompt,
          ...(prompt.content
            ? { content: await this.hydrateContent(prompt.content) }
            : {}),
        })),
      ),
    };
  }

  async getTranscriptPage(
    opts: DaemonSessionTranscriptPageOptions = {},
  ): Promise<DaemonSessionTranscriptPage> {
    const page = await this.client.getSessionTranscriptPage(this.sessionId, {
      ...opts,
      clientId: opts.clientId ?? this.clientId,
    });
    return {
      ...page,
      events: await Promise.all(
        page.events.map(async (event) => await this.hydrateEvent(event)),
      ),
    };
  }

  async getTurnIndexPage(
    opts: DaemonSessionTurnIndexPageOptions = {},
  ): Promise<DaemonSessionTurnIndexPage> {
    return this.client.getSessionTurnIndexPage(this.sessionId, {
      ...opts,
      clientId: opts.clientId ?? this.clientId,
    });
  }

  removePendingPrompt(
    promptId: string,
  ): Promise<DaemonRemovePendingPromptResult> {
    return this.client.removePendingPrompt(this.sessionId, promptId, {
      ...(this.clientId ? { clientId: this.clientId } : {}),
    });
  }

  /**
   * Execute a direct daemon-side shell command for this session. Requires the
   * daemon to opt in to direct session shell with bearer auth or
   * trusted-loopback authority; this wrapper automatically forwards the client
   * id bound when the session was created or attached.
   */
  shellCommand(
    command: string,
    signal?: AbortSignal,
  ): Promise<DaemonShellCommandResult> {
    return this.client.shellCommand(this.sessionId, command, {
      ...(signal ? { signal } : {}),
      ...(this.clientId ? { clientId: this.clientId } : {}),
    });
  }

  context(): Promise<DaemonSessionContextStatus> {
    return this.client.sessionContext(this.sessionId, this.clientId);
  }

  status(): Promise<DaemonSessionSummary> {
    return this.client.sessionStatus(this.sessionId, this.clientId);
  }

  contextUsage(
    opts: { detail?: boolean } = {},
  ): Promise<DaemonSessionContextUsageStatus> {
    return this.client.sessionContextUsage(this.sessionId, opts, this.clientId);
  }

  supportedCommands(): Promise<DaemonSessionSupportedCommandsStatus> {
    return this.client.sessionSupportedCommands(this.sessionId, this.clientId);
  }

  tasks(): Promise<DaemonSessionTasksStatus> {
    return this.client.sessionTasks(this.sessionId, this.clientId);
  }

  workflowTasks(): Promise<DaemonSessionWorkflowTasksStatus> {
    return this.client.sessionWorkflowTasks(this.sessionId, this.clientId);
  }

  savedWorkflow(name: string): Promise<DaemonSessionSavedWorkflowStatus> {
    return this.client.sessionSavedWorkflow(
      this.sessionId,
      name,
      this.clientId,
    );
  }

  lspStatus(): Promise<DaemonSessionLspStatus> {
    return this.client.sessionLspStatus(this.sessionId, this.clientId);
  }

  resources(): Promise<DaemonSessionResourcesStatus> {
    return this.client.sessionResources(this.sessionId, this.clientId);
  }

  cancelTask(
    taskId: string,
    kind: DaemonSessionTaskWithWorkflowStatus['kind'],
  ): Promise<{ cancelled: boolean }> {
    return this.client.sessionTaskCancel(
      this.sessionId,
      taskId,
      kind,
      this.clientId,
    );
  }

  controlWorkflowTask(
    taskId: string,
    action: 'pause' | 'resume' | 'retry' | 'rerun' | 'delete-history',
  ): Promise<{
    changed: boolean;
    status?: DaemonSessionWorkflowTaskStatus['status'];
    taskId?: string;
  }> {
    return this.client.sessionWorkflowTaskAction(
      this.sessionId,
      taskId,
      action,
      this.clientId,
    );
  }

  clearGoal(): Promise<{ cleared: boolean; condition?: string }> {
    return this.client.sessionGoalClear(this.sessionId, this.clientId);
  }

  goal(): Promise<GoalStateResponse> {
    return this.client.sessionGoal(this.sessionId, this.clientId);
  }

  controlGoal(request: GoalControlRequest): Promise<GoalStateResponse> {
    return this.client.sessionGoalControl(
      this.sessionId,
      request,
      this.clientId,
    );
  }

  stats(): Promise<DaemonSessionStatsStatus> {
    return this.client.sessionStats(this.sessionId, this.clientId);
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

  async detach(): Promise<void> {
    return await this.client.detachSession(this.sessionId, this.clientId);
  }

  async updateMetadata(metadata: {
    displayName?: string;
    pr?: Omit<DaemonSessionPrInfo, 'issues'>;
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
      const {
        resume = true,
        sseConnectReason: requestedConnectReason,
        ...sessionSubscribeOpts
      } = opts;
      // `Omit` protects TypeScript callers; sanitize the runtime object too so
      // untyped JavaScript cannot override session-owned REST stream identity.
      const subscribeOpts: SubscribeOptions = { ...sessionSubscribeOpts };
      delete subscribeOpts.clientId;
      delete subscribeOpts.previousSseStreamId;
      delete subscribeOpts.onSseStreamAccepted;
      const lastEventId =
        subscribeOpts.lastEventId ??
        (resume ? this.lastSeenEventId : undefined);
      // Same seeding rhythm as the cursor: an explicit caller epoch wins,
      // otherwise pair the resumed cursor with the epoch it was minted in.
      const epoch =
        subscribeOpts.epoch ?? (resume ? this.lastSeenEpoch : undefined);
      const callerOnEpoch = subscribeOpts.onEpoch;
      const restSubscription = this.client.transport.type === 'rest';
      if (!restSubscription) {
        this.hasAcceptedRestStream = false;
        this.lastAcceptedRestStreamId = undefined;
      }
      const sseConnectReason: DaemonSseConnectReason =
        requestedConnectReason ??
        (this.hasAcceptedRestStream ? 'resume' : 'initial');

      for await (const event of this.client.subscribeEvents(this.sessionId, {
        ...subscribeOpts,
        lastEventId,
        ...(this.clientId ? { clientId: this.clientId } : {}),
        sseConnectReason,
        ...(this.lastAcceptedRestStreamId
          ? {
              previousSseStreamId: this.lastAcceptedRestStreamId,
            }
          : {}),
        onSseStreamAccepted: (streamId: string | undefined) => {
          this.hasAcceptedRestStream = true;
          this.lastAcceptedRestStreamId = streamId;
        },
        ...(epoch !== undefined ? { epoch } : {}),
        onEpoch: (learned) => {
          this.lastSeenEpoch = learned;
          callerOnEpoch?.(learned);
        },
      })) {
        const hydratedEvent = await this.hydrateEvent(event);
        this._dispatchTurnEvent(hydratedEvent);
        yield hydratedEvent;
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

  private async hydrateReplaySnapshot(): Promise<void> {
    this.replaySnapshot.compactedReplay = await Promise.all(
      this.replaySnapshot.compactedReplay.map(
        async (event) => await this.hydrateEvent(event),
      ),
    );
    this.replaySnapshot.liveJournal = await Promise.all(
      this.replaySnapshot.liveJournal.map(
        async (event) => await this.hydrateEvent(event),
      ),
    );
  }

  private async hydrateEvent(event: DaemonEvent): Promise<DaemonEvent> {
    if (!event.data || typeof event.data !== 'object') return event;
    const data = event.data as Record<string, unknown>;
    if (event.type === 'session_update') {
      const update = data['update'];
      if (update && typeof update === 'object' && !Array.isArray(update)) {
        const content = (update as Record<string, unknown>)['content'];
        const hydrated = await this.hydrateBlock(content);
        if (hydrated === content) return event;
        return {
          ...event,
          data: { ...data, update: { ...update, content: hydrated } },
        };
      }
      const content = data['content'];
      const hydrated = await this.hydrateBlock(content);
      if (hydrated === content) return event;
      return { ...event, data: { ...data, content: hydrated } };
    }
    if (event.type !== 'mid_turn_message_injected') return event;
    const items = data['items'];
    if (!Array.isArray(items)) return event;
    return {
      ...event,
      data: {
        ...data,
        items: await Promise.all(
          items.map(async (item) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) {
              return item;
            }
            const record = item as Record<string, unknown>;
            return Array.isArray(record['content'])
              ? {
                  ...record,
                  content: await this.hydrateContent(record['content']),
                }
              : item;
          }),
        ),
      },
    };
  }

  private async hydrateContent(
    content: readonly unknown[],
  ): Promise<PromptContentBlock[]> {
    return await Promise.all(
      content.map(async (block) => await this.hydrateBlock(block)),
    );
  }

  private async hydrateBlock(block: unknown): Promise<PromptContentBlock> {
    if (!isSessionAttachmentReference(block)) {
      return block as PromptContentBlock;
    }
    if (block.type === 'resource') return block;
    let cached = this.attachmentCache.get(block.attachmentId);
    if (cached) {
      this.attachmentCache.delete(block.attachmentId);
      this.attachmentCache.set(block.attachmentId, cached);
    } else {
      const pending = this.withClientIdSelfHeal(() =>
        this.client.readSessionAttachment(this.sessionId, block.attachmentId, {
          ...(this.clientId ? { clientId: this.clientId } : {}),
        }),
      );
      cached = { pending, size: block.size };
      this.attachmentCache.set(block.attachmentId, cached);
      this.attachmentCacheBytes += block.size;
      while (
        this.attachmentCache.size > MAX_ATTACHMENT_CACHE_ENTRIES ||
        this.attachmentCacheBytes > MAX_ATTACHMENT_CACHE_BYTES
      ) {
        const oldestId = this.attachmentCache.keys().next().value;
        if (oldestId === undefined) break;
        const evicted = this.attachmentCache.get(oldestId);
        this.attachmentCache.delete(oldestId);
        this.attachmentCacheBytes -= evicted?.size ?? 0;
      }
      void pending.catch(() => {
        if (this.attachmentCache.get(block.attachmentId)?.pending !== pending)
          return;
        this.attachmentCache.delete(block.attachmentId);
        this.attachmentCacheBytes -= block.size;
      });
    }
    try {
      const attachment = await cached.pending;
      return {
        type: 'image',
        data: attachment.data,
        mimeType: attachment.mimeType,
      };
    } catch (err) {
      // 404/410 means the daemon no longer holds the blob, so pin the
      // placeholder. Any other failure is transient: return the reference
      // unchanged so the snapshot keeps its attachment id and a later hydration
      // pass can retry (the failed cache entry evicted itself above).
      if (
        err instanceof DaemonHttpError &&
        (err.status === 404 || err.status === 410)
      ) {
        return {
          type: 'text',
          text: '[Attachment is no longer available]',
        };
      }
      return block;
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

/**
 * True for the daemon's `400 invalid_client_id` prompt-admission rejection
 * (the stale-clientId signal a daemon restart / session reload produces).
 */
function isInvalidClientId(err: unknown): boolean {
  return (
    err instanceof DaemonHttpError &&
    err.status === 400 &&
    typeof err.body === 'object' &&
    err.body !== null &&
    (err.body as { code?: unknown }).code === 'invalid_client_id'
  );
}
