/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ApprovalMode,
  SessionGroupPresetColor,
} from '@qwen-code/qwen-code-core';
import type {
  CancelNotification,
  LoadSessionResponse,
  PromptRequest,
  PromptResponse,
  RequestPermissionResponse,
  ResumeSessionResponse,
  SetSessionModelRequest,
  SetSessionModelResponse,
  SessionUpdate,
} from '@agentclientprotocol/sdk';
import type {
  BridgeEvent,
  SessionReplaySnapshot,
  SubscribeOptions,
} from './eventBus.js';
import type { PermissionPolicy } from './permission.js';
import type {
  SessionArtifactInput,
  SessionArtifactMutationResult,
  SessionArtifactsEnvelope,
} from './sessionArtifacts.js';
import type {
  ServeSessionContextStatus,
  ServeSessionHooksStatus,
  ServeSessionLspStatus,
  ServeSessionSupportedCommandsStatus,
  ServeSessionTasksStatus,
  ServeWorkspaceExtensionsStatus,
  ServeWorkspaceHooksStatus,
  ServeWorkspaceMcpToolsStatus,
  ServeWorkspaceMcpResourcesStatus,
  ServeWorkspaceToolsStatus,
  ServeSessionContextUsageStatus,
  ServeSessionStatsStatus,
} from './status.js';

export interface RewindSnapshotInfo {
  promptId: string;
  turnIndex: number;
  timestamp: string;
  diffStats: { filesChanged: number; insertions: number; deletions: number };
}

export interface RewindRequest {
  promptId: string;
  rewindFiles?: boolean;
}

export interface RewindResponse {
  rewound: boolean;
  targetTurnIndex: number;
  filesChanged: string[];
  filesFailed: string[];
  warnings?: string[];
}

export interface BridgeSpawnRequest {
  /** Absolute path to the workspace root the child inherits as cwd. */
  workspaceCwd: string;
  /** Optional explicit model service id; falls back to settings default. */
  modelServiceId?: string;
  /**
   * Optional echo of a daemon-issued client id from a previous attach to the
   * same live session. Unknown ids are ignored on create/attach and replaced
   * with a freshly stamped id.
   */
  clientId?: string;
  /**
   * Per-request override for `sessionScope`. When set, takes precedence
   * over the bridge-wide default (`BridgeOptions.sessionScope`). When
   * omitted, the bridge-wide default applies.
   */
  sessionScope?: 'single' | 'thread';
  /**
   * Id of the session that spawned this one (a `create_sub_session` caller).
   * Recorded as the new session's immutable parent lineage, only when a fresh
   * session is created — an attach never adopts a parent. Absent for a
   * top-level session that no other session spawned.
   */
  parentSessionId?: string;
  /** Immutable attribution supplied by the creator of a fresh session. */
  sourceType?: string;
  /** Optional source-specific identifier. Valid only with `sourceType`. */
  sourceId?: string;
  approvalMode?: ApprovalMode;
  /** Worktree isolation metadata, set by the daemon route before spawn. */
  worktree?: { slug: string; path: string; branch: string };
}

export interface BridgeSession {
  sessionId: string;
  workspaceCwd: string;
  /** True if this attach reused an existing session under `sessionScope: 'single'`. */
  attached: boolean;
  /**
   * Opaque daemon-issued id for the attaching HTTP client. Subsequent
   * session-scoped requests may echo it so daemon events can identify the
   * initiating client without trusting request bodies.
   */
  clientId?: string;
  /** ISO 8601 timestamp of when the session was created. */
  createdAt?: string;
  /** True while the live session has an in-flight prompt. */
  hasActivePrompt?: boolean;
  /**
   * Only present when this spawn carried a `parentSessionId`. `true` iff the
   * parent lineage was durably written to the child's transcript (survives a
   * daemon restart); `false` means the link is live-only and will disappear
   * from the persisted session list on restart. Lets `create_sub_session` / the
   * SDK distinguish a durably linked child from a degraded one instead of
   * treating every spawn as an equally successful link.
   */
  parentSessionPersisted?: boolean;
  /** Immutable creator attribution for this session, when supplied. */
  sourceType?: string;
  /** Optional source-specific identifier paired with `sourceType`. */
  sourceId?: string;
  /** True iff the source metadata was durably written to the transcript. */
  sourcePersisted?: boolean;
  /** Present when the session was created with worktree isolation. */
  worktree?: { slug: string; path: string; branch: string };
}

export interface BridgeRestoreSessionRequest {
  /** Session id to restore through ACP `session/load` or `session/resume`. */
  sessionId: string;
  /** Absolute path to the workspace root the child inherits as cwd. */
  workspaceCwd: string;
  /** Optional echo of a daemon-issued client id for this session. */
  clientId?: string;
  /** Internal replay transport for `session/load`; defaults to bulk response. */
  historyReplay?: 'stream' | 'response';
  /** Optional newest persisted-record page requested for response replay. */
  historyPageSize?: number;
  approvalMode?: ApprovalMode;
  /**
   * Persisted parent lineage recovered from the transcript by the caller (the
   * serve layer reads it before restore). Re-seeds the restored live entry so a
   * restored sub-session's `getSessionSummary`/status still reports its parent
   * after a daemon restart — the entry is otherwise created without it. Absent
   * for a top-level session.
   */
  parentSessionId?: string;
  /** Persisted creator attribution recovered from the transcript. */
  sourceType?: string;
  /** Optional persisted identifier paired with `sourceType`. */
  sourceId?: string;
}

export const LOAD_REPLAY_MODE_META_KEY = 'qwen.session.loadReplayMode';
export const LOAD_REPLAY_META_KEY = 'qwen.session.loadReplay';
export const LOAD_REPLAY_PAGE_SIZE_META_KEY = 'qwen.session.loadReplayPageSize';
export const LOAD_REPLAY_BULK_MODE = 'bulk';
export const LOAD_REPLAY_VERSION = 1 as const;

export const CHANNEL_STARTUP_PROFILE_META_KEY =
  'qwen.daemon.channelStartupProfile';
export const CHANNEL_STARTUP_PROFILE_VERSION = 1 as const;

export interface ChannelStartupProfileV1 {
  v: typeof CHANNEL_STARTUP_PROFILE_VERSION;
  complete: boolean;
  responseBuiltAtEpochMs?: number;
  processToResponseMs?: number;
  phases: {
    processToProfilerReadyMs?: number;
    geminiImportMs?: number;
    argsParseMs?: number;
    settingsLoadMs?: number;
    configConstructionMs?: number;
    appInitializationMs?: number;
    acpImportMs?: number;
    bootstrapConfigInitializationMs?: number;
    transportSetupMs?: number;
    initializeHandlerMs?: number;
    unattributedMs?: number;
  };
  config: {
    extensionsInitialMs?: number;
    hooksMs?: number;
    skillsMs?: number;
    extensionsFinalMs?: number;
    hierarchicalMemoryMs?: number;
    toolRegistryMs?: number;
    ripgrepProbeMs?: number;
    toolWarmupMs?: number;
    otherMs?: number;
  };
}

export interface BridgeLoadReplayEnvelope {
  v: typeof LOAD_REPLAY_VERSION;
  updates: SessionUpdate[];
  hasMore?: boolean;
  partial?: true;
  replayError?: string;
}

export type BridgeSessionState = (
  | LoadSessionResponse
  | ResumeSessionResponse
) & {
  artifactSnapshot?: unknown;
  artifactSnapshotUnavailable?: unknown;
};

export interface BridgeRestoredSession extends BridgeSession {
  /** ACP state returned by `session/load` / `session/resume`. */
  state: BridgeSessionState;
  /** Artifact restore warnings surfaced during session load/resume. */
  artifactWarnings?: string[];
  /** True when response-mode history replay aborted after emitting a prefix. */
  partial?: true;
  /** Agent-provided replay failure detail when `partial` is true. */
  replayError?: string;
  /** Compacted events for all completed turns (O(turns) size). */
  compactedReplay?: BridgeEvent[];
  /** Raw events since last turn boundary (current incomplete turn). */
  liveJournal?: BridgeEvent[];
  /** True when persisted records exist before the returned replay page. */
  historyHasMore?: boolean;
  /** High-water mark event ID — client uses this as initial SSE cursor. */
  lastEventId?: number;
}

export interface BridgeSessionTranscriptPageRequest {
  sessionId: string;
  cursor?: string;
  beforeRecordId?: string;
  /** Internal newest-page read used to refresh an attached session's UI. */
  direction?: 'backward';
  limit?: number;
}

export interface BridgeSessionTranscriptPage {
  v: 1;
  sessionId: string;
  events: BridgeEvent[];
  nextCursor?: string;
  hasMore: boolean;
  startTime?: string;
  lastUpdated?: string;
  partial?: true;
  replayError?: string;
}

export interface BridgeBranchSessionRequest {
  name?: string;
}

export interface BridgeBranchedSession extends BridgeRestoredSession {
  displayName: string;
  forkedFrom: { sessionId: string; displayName: string };
}

export interface BridgeForkAgentResult {
  sessionId: string;
  description: string;
  launched: boolean;
}

export interface ChangeSessionCwdRequest {
  path: string;
  /**
   * Server-controlled containment roots. When present, the agent-side
   * sessionCd handler verifies (after its own realpath) that the
   * canonical target is under one of these roots. Only set by the
   * daemon's worktree create/restore paths; direct user cd omits this
   * field, preserving existing behavior.
   */
  allowedRoots?: string[];
}

export interface ChangeSessionCwdResult {
  sessionId: string;
  previousCwd: string;
  newCwd: string;
  warnings: string[];
}

export type BridgeWorkspaceMemoryRememberContextMode = 'workspace' | 'clean';
export type BridgeAutoMemoryTopic =
  | 'user'
  | 'feedback'
  | 'project'
  | 'reference';

export interface BridgeWorkspaceMemoryRememberRequest {
  content: string;
  contextMode: BridgeWorkspaceMemoryRememberContextMode;
}

export interface BridgeWorkspaceMemoryRememberResult {
  summary?: string;
  filesTouched: string[];
  touchedScopes: Array<'user' | 'project'>;
}

export interface BridgeWorkspaceMemoryForgetRequest {
  query: string;
}

export interface BridgeWorkspaceMemoryForgetMatch {
  topic: BridgeAutoMemoryTopic;
  summary: string;
  filePath: string;
}

export interface BridgeWorkspaceMemoryForgetResult {
  summary?: string;
  removedEntries: BridgeWorkspaceMemoryForgetMatch[];
  touchedTopics: BridgeAutoMemoryTopic[];
  touchedScopes: Array<'user' | 'project'>;
}

export interface BridgeWorkspaceMemoryDreamResult {
  summary?: string;
  touchedTopics: BridgeAutoMemoryTopic[];
  dedupedEntries: number;
}

/**
 * Wire-format mirror of `DaemonPendingInteraction*` in
 * `packages/sdk-typescript/src/daemon/types.ts`; keep fields synchronized.
 * Pending interaction details are exposed by live session status endpoints.
 */
export interface BridgePendingInteractionOption {
  optionId: string;
  label?: string;
  kind?: string;
}

export interface BridgePendingPermissionInteraction {
  requestId: string;
  kind: 'permission';
  createdAt: string;
  action: {
    type?: string;
    title?: string;
    content?: unknown;
    locations?: unknown;
    input?: unknown;
  };
  options: BridgePendingInteractionOption[];
}

export interface BridgePendingUserQuestion {
  /** Key to use in `PermissionResponse.answers` when voting. */
  answerKey: string;
  header?: string;
  question?: string;
  options?: Array<{ label?: string; description?: string }>;
  multiSelect?: boolean;
  [key: string]: unknown;
}

export interface BridgePendingUserQuestionInteraction {
  requestId: string;
  kind: 'user_question';
  createdAt: string;
  title?: string;
  questions: BridgePendingUserQuestion[];
  options: BridgePendingInteractionOption[];
}

export type BridgePendingInteraction =
  | BridgePendingPermissionInteraction
  | BridgePendingUserQuestionInteraction;

/** Wire-format mirror of the SDK's `DaemonSessionSummary`; keep fields synchronized. */
export interface BridgeSessionSummary {
  sessionId: string;
  workspaceCwd: string;
  createdAt: string;
  updatedAt?: string;
  displayName?: string;
  /** Id of the session that spawned this one (via `create_sub_session`), or
   * absent for a top-level session. Lets a UI link a sub-session back to its
   * parent. Immutable — set when the session is created. */
  parentSessionId?: string;
  /** Immutable creator attribution, absent on legacy/unattributed sessions. */
  sourceType?: string;
  /** Optional source-specific identifier paired with `sourceType`. */
  sourceId?: string;
  clientCount: number;
  hasActivePrompt: boolean;
  /** True while a non-question permission request awaits a response. */
  isWaitingForPermission?: boolean;
  /** True while an ask_user_question request awaits a response. */
  isWaitingForUserQuestion?: boolean;
  /** Number of permission or user-question interactions awaiting a response. */
  pendingInteractionCount?: number;
  /** True when the most recently completed turn failed. */
  hasTurnError?: boolean;
  /** Present for live sessions in status and workspace-list responses. */
  turnError?: {
    message: string;
    code?: string;
    errorKind?: string;
  };
  /**
   * Pending approvals/questions that can be resolved through the vote API.
   * Present for live sessions in status and workspace-list responses.
   */
  pendingInteractions?: BridgePendingInteraction[];
  isArchived?: boolean;
  isPinned?: boolean;
  pinnedAt?: string;
  groupId?: string | null;
  /** Quick color grouping tag; mutually exclusive with `groupId` in the UI. */
  color?: SessionGroupPresetColor | null;
  /** Present when the session was created with worktree isolation. */
  worktree?: { slug: string; path: string; branch: string };
}

/**
 * A session's live `/goal` state, as reported by the `qwen --acp` child.
 *
 * Only the active goal crosses the bridge. The child also caches the most
 * recent goal that ended on its own, but nothing on this side reads it, so it
 * is not part of the wire shape — add it back alongside the first consumer.
 */
export interface BridgeSessionGoal {
  active: {
    condition: string;
    /** Judge turns completed so far; 0 before the first stop-hook evaluation. */
    iterations: number;
    setAt: number;
    /** The judge's verdict on the most recent turn, when it has run. */
    lastReason?: string;
  } | null;
}

export interface SessionMetadataUpdate {
  displayName?: string;
}

export interface CloseSessionOpts {
  /** Override the default `'client_close'` reason in the `session_closed` event. */
  reason?: string;
  /**
   * Require pending recorder writes to flush successfully. All closes await
   * the ACP child acknowledgement and may cancel in-flight turns even when
   * the close attempt ultimately fails.
   */
  requireAgentClose?: boolean;
}

export interface BridgeClientRequestContext {
  /** Daemon-issued client id echoed through the HTTP transport header. */
  clientId?: string;
  /**
   * `true` when the request arrived from a loopback peer (kernel-stamped
   * `req.socket.remoteAddress` ∈ {`127.0.0.1`, `::1`, `::ffff:127.0.0.1`}).
   * Populated by permission-vote routes for the `local-only` mediation
   * policy; other routes leave this undefined.
   *
   * **Security**: this is NOT computed from `X-Forwarded-For` or any
   * other forwardable HTTP header — those are forgeable. Callers that
   * reverse-proxy `qwen serve` should not rely on `local-only` (use a
   * dedicated daemon or `designated` policy instead).
   */
  fromLoopback?: boolean;
  /**
   * Caller-generated correlation id for non-blocking prompt mode.
   * When present, the bridge stamps turn-scoped event envelopes with this id.
   * The legacy `turn_complete.data.promptId` / `turn_error.data.promptId`
   * fields remain populated so the SDK's `prompt()` can match the terminal
   * SSE event to the pending HTTP 202 request.
   */
  promptId?: string;
  /**
   * Internal: set ONLY by `continueSession` to re-arm the continuation meta
   * key that `sendPrompt` strips from untrusted callers. HTTP routes never
   * populate this from request input, so an external caller cannot use it to
   * smuggle a continuation through the prompt path.
   */
  continue?: boolean;
}

/**
 * Returned from `recordHeartbeat`. `lastSeenAt` is the server-side
 * `Date.now()` epoch (ms) the bridge stored for this session/client
 * pair. `clientId` is echoed only when the caller provided a trusted
 * one through `X-Qwen-Client-Id`; anonymous heartbeats omit it but
 * still bump the per-session timestamp.
 */
export interface BridgeHeartbeatResult {
  sessionId: string;
  clientId?: string;
  lastSeenAt: number;
}

/**
 * Read-only snapshot of last-seen timestamps the bridge has recorded for
 * a session. `sessionLastSeenAt` is the most recent heartbeat across any
 * client (anonymous or identified). `clientLastSeenAt` maps each
 * registered `clientId` to its own last heartbeat. Returned by
 * `getHeartbeatState` for in-process diagnostics.
 */
export interface BridgeHeartbeatState {
  sessionLastSeenAt?: number;
  clientLastSeenAt: ReadonlyMap<string, number>;
}

/**
 * ACP ext-method the spawned `qwen --acp` child calls between tool batches to
 * pull user messages the browser queued mid-turn. The child-side caller
 * (`cli/src/acp-integration/session/Session.ts`) and the daemon-side answerer
 * (`bridgeClient.ts`) both import THIS single definition, so a rename can't
 * silently desync them into a runtime `-32601 methodNotFound` (which would
 * latch the drain off for the session). The desktop ACP client answers the same
 * method from its own in-memory queue; in `qwen serve` the daemon answers it
 * from `SessionEntry.midTurnMessageQueue`. Responses may also carry
 * `hasQueuedPrompt` so an armed daemon Todo guard yields to complete FIFO
 * prompts; older clients can omit it.
 */
export const MID_TURN_QUEUE_DRAIN_METHOD = 'craft/drainMidTurnQueue';

/**
 * Parent-to-agent request reporting that the daemon FIFO no longer contains the
 * complete prompt an active Todo Stop Guard yielded to. The child clears the
 * old guard instead of letting background work revive it or leaving unrelated
 * automatic turns blocked forever.
 */
export const TODO_STOP_GUARD_QUEUE_RELEASE_METHOD =
  'craft/todoStopGuardQueueReleased';

/**
 * Reverse tool channel marker (issue #5626, Phase 2). The parent serve process
 * stamps this boolean on a client-hosted (extension) MCP server's
 * runtime-MCP-add config. The `qwen --acp` child reads it in its
 * `workspaceMcpRuntimeAdd` handler to (1) KEEP `type: 'sdk'` instead of
 * stripping it and (2) let the session `McpClientManager` bind that server's
 * `sendSdkMcpMessage` to the `qwen/control/client_mcp/message` ext-method.
 * Defined here — the single contract package both the parent provider
 * (`cli/src/serve/acp-http`) and the child handler (`cli/src/acp-integration`)
 * import — so a rename can't silently break the handshake.
 */
export const CLIENT_MCP_OVER_WS_CONFIG_FLAG = '__clientMcpOverWs';

/**
 * Typed carrier for the reverse tool channel's runtime-MCP-add config: the
 * plain `Record<string, unknown>` shape `addRuntimeMcpServer` accepts, plus the
 * optional {@link CLIENT_MCP_OVER_WS_CONFIG_FLAG} marker declared as a real
 * (boolean) property. Lets the parent provider stamp the flag and the child
 * handler read it through one shared, type-checked shape instead of an untyped
 * string-keyed access on a bare `Record`.
 */
export type ClientMcpOverWsRuntimeConfig = Record<string, unknown> & {
  [CLIENT_MCP_OVER_WS_CONFIG_FLAG]?: boolean;
};

/**
 * One queued mid-turn message. `originatorClientId` is the trusted client id
 * that pushed it (from `resolveTrustedClientId`), carried so the drain's SSE
 * echo can be routed/filtered to that client only — a peer attached to the
 * same session must not dedupe a message it did not queue.
 */
export interface MidTurnQueueEntry {
  text: string;
  originatorClientId?: string;
}

/**
 * Internal record for a prompt accepted into the per-session FIFO queue.
 * Lives on `SessionEntry.pendingPromptList` so the daemon can report
 * pending prompts and let callers remove specific items. The
 * `abortController` is wired to the caller's signal (if any) so
 * `removePendingPrompt` can cancel a queued-but-not-yet-started prompt.
 */
export interface PendingPromptEntry {
  promptId: string;
  queuedAt: number;
  originatorClientId?: string;
  text: string;
  abortController: AbortController;
  state: 'queued' | 'running';
}

/**
 * Public projection of `PendingPromptEntry` returned by
 * `getPendingPrompts` and the HTTP API. Omits the internal
 * `abortController` and raw prompt content blocks.
 */
export interface PendingPromptSummary {
  promptId: string;
  text: string;
  queuedAt: number;
  state: 'queued' | 'running';
  originatorClientId?: string;
}

export interface BridgeDaemonStatusLimits {
  maxSessions: number | null;
  maxPendingPromptsPerSession: number | null;
  eventRingSize: number;
  compactedReplayMaxBytes: number;
  channelIdleTimeoutMs: number;
  sessionIdleTimeoutMs: number;
}

export interface BridgeDaemonSessionDiagnostic {
  sessionId: string;
  workspaceCwd: string;
  createdAt: string;
  displayName?: string;
  clientCount: number;
  subscriberCount: number;
  attachCount: number;
  pendingPromptCount: number;
  pendingPermissionCount: number;
  hasActivePrompt: boolean;
  lastEventId: number;
  lastSeenAt?: number;
  currentModelId?: string;
  currentApprovalMode?: string;
}

export interface BridgeDaemonStatusSnapshot {
  limits: BridgeDaemonStatusLimits;
  sessionCount: number;
  pendingPermissionCount: number;
  channelLive: boolean;
  permissionPolicy: PermissionPolicy;
  sessions: BridgeDaemonSessionDiagnostic[];
}

export interface BridgeExtensionsChangedData {
  refreshed: number;
  failed: number;
  status?:
    | 'installed'
    | 'enabled'
    | 'disabled'
    | 'updated'
    | 'uninstalled'
    | 'failed';
  source?: string;
  name?: string;
  version?: string;
  error?: string;
}

export type BridgeGenerationModelSource = 'fast' | 'main';

export type BridgeGenerationStreamEvent =
  | {
      type: 'started';
      requestId: string;
      model: string;
      modelSource: BridgeGenerationModelSource;
    }
  | {
      type: 'thinking';
      requestId: string;
    }
  | {
      type: 'delta';
      requestId: string;
      seq: number;
      text: string;
    }
  | {
      type: 'done';
      requestId: string;
      model: string;
      modelSource: BridgeGenerationModelSource;
      inputTokens?: number;
      outputTokens?: number;
    };

export type BridgeGenerationNotificationEvent = Exclude<
  BridgeGenerationStreamEvent,
  { type: 'done' }
>;

export interface AcpSessionBridge {
  /** Read-only daemon diagnostics for status endpoints. */
  getDaemonStatusSnapshot(): BridgeDaemonStatusSnapshot;

  /**
   * Create a new session, or — under `sessionScope: 'single'` — attach to an
   * existing session for the same workspace.
   */
  spawnOrAttach(req: BridgeSpawnRequest): Promise<BridgeSession>;

  /**
   * Load an existing persisted session and replay its history through
   * session_update notifications. Returns `attached: true` when the requested
   * session is already live in this daemon.
   */
  loadSession(req: BridgeRestoreSessionRequest): Promise<BridgeRestoredSession>;

  /**
   * Resume an existing persisted session without requesting history replay.
   * Returns `attached: true` when the requested session is already live in
   * this daemon.
   */
  resumeSession(
    req: BridgeRestoreSessionRequest,
  ): Promise<BridgeRestoredSession>;

  /**
   * Fork a live session's JSONL transcript and load the fork via resume
   * semantics (no history replay). Source must be idle (no active prompt).
   */
  branchSession(
    sessionId: string,
    req: BridgeBranchSessionRequest,
    context?: BridgeClientRequestContext,
  ): Promise<BridgeBranchedSession>;

  /**
   * Change the working directory of a live session. The session must be
   * idle (no active prompt). Chains onto `entry.promptQueue` and updates
   * the tail to prevent concurrent mutations.
   *
   * Throws `CdWhilePromptActiveError` when a prompt is running,
   * `SessionNotFoundError` for unknown ids, and `InvalidClientIdError`
   * when the caller's client id is not bound to the session.
   */
  changeSessionCwd(
    sessionId: string,
    req: ChangeSessionCwdRequest,
    context?: BridgeClientRequestContext,
  ): Promise<ChangeSessionCwdResult>;

  /**
   * Set worktree metadata on an existing session entry. Used when
   * restoring a worktree session after daemon restart — the sidecar
   * file provides the metadata, and this populates the in-memory entry
   * so `getSessionSummary` returns it.
   */
  setSessionWorktree(
    sessionId: string,
    worktree: { slug: string; path: string; branch: string },
  ): void;

  /**
   * Forward a prompt to the agent. Concurrent prompts against the same
   * session FIFO-serialize through a per-session queue.
   *
   * Admission contract: implementations must not be `async`. Admission
   * failures such as `InvalidClientIdError`, `PromptQueueFullError`, and
   * pre-aborted signals throw synchronously so HTTP routes can reject before
   * returning 202. Deferred failures such as `SessionNotFoundError` may be
   * returned as rejected promises.
   */
  sendPrompt(
    sessionId: string,
    req: PromptRequest,
    signal?: AbortSignal,
    context?: BridgeClientRequestContext,
  ): Promise<PromptResponse>;

  /**
   * Return the pending prompt queue for a session. Includes the currently
   * running prompt (state `'running'`) and any prompts waiting in the FIFO
   * (state `'queued'`). Throws `SessionNotFoundError` for unknown ids.
   */
  getPendingPrompts(
    sessionId: string,
    context?: BridgeClientRequestContext,
  ): readonly PendingPromptSummary[];

  /**
   * Remove a specific prompt from the pending queue. For `queued` prompts,
   * aborts them so the FIFO skips dispatch. For `running` prompts, aborts
   * the in-flight turn (equivalent to cancel). Returns `{ removed: false }`
   * when the promptId is not found. Throws `SessionNotFoundError` for
   * unknown session ids.
   */
  removePendingPrompt(
    sessionId: string,
    promptId: string,
    context?: BridgeClientRequestContext,
  ): { removed: boolean };

  /**
   * Cancel the in-flight prompt on the session. Throws
   * `SessionNotFoundError` when the id is unknown.
   */
  cancelSession(
    sessionId: string,
    req?: CancelNotification,
    context?: BridgeClientRequestContext,
  ): Promise<void>;

  /**
   * Subscribe to the session's event stream. Throws
   * `SessionNotFoundError` when the id is unknown.
   */
  subscribeEvents(
    sessionId: string,
    opts?: SubscribeOptions & {
      /** Yield a synthetic `session_snapshot` frame after replay completes. */
      snapshot?: boolean;
    },
  ): AsyncIterable<BridgeEvent>;

  /**
   * Return the most recent monotonic event id for this session's bus.
   * Used by non-blocking prompt responses to tell the client where to
   * start SSE replay so no events are missed.
   */
  getSessionLastEventId(sessionId: string): number;

  /**
   * Return the current compacted replay snapshot for a loaded session, when
   * the bridge has a compaction engine configured.
   */
  getSessionReplaySnapshot(
    sessionId: string,
  ): SessionReplaySnapshot | undefined;

  /**
   * Explicitly close a live session. Force-closes even when other clients
   * are attached. Throws `SessionNotFoundError` for unknown ids.
   */
  closeSession(
    sessionId: string,
    context?: BridgeClientRequestContext,
    opts?: CloseSessionOpts,
  ): Promise<void>;

  /**
   * Update mutable session metadata. Currently supports `displayName` only.
   * Throws `SessionNotFoundError` for unknown ids.
   */
  updateSessionMetadata(
    sessionId: string,
    metadata: SessionMetadataUpdate,
    context?: BridgeClientRequestContext,
  ): SessionMetadataUpdate;

  /**
   * List the structured artifacts registered for a live session. Throws
   * `SessionNotFoundError` when the id is unknown.
   */
  getSessionArtifacts(
    sessionId: string,
    context?: BridgeClientRequestContext,
  ): Promise<SessionArtifactsEnvelope>;

  /**
   * Register a client-supplied artifact for the session. Client artifacts use
   * the daemon-issued client id from the request context for retention/audit;
   * request bodies cannot self-assign client ids.
   */
  addSessionArtifact(
    sessionId: string,
    artifact: SessionArtifactInput,
    context?: BridgeClientRequestContext,
  ): Promise<SessionArtifactMutationResult>;

  /**
   * Remove an artifact from the session. Missing artifact ids are idempotent
   * no-ops; unknown session ids still throw `SessionNotFoundError`.
   */
  removeSessionArtifact(
    sessionId: string,
    artifactId: string,
    context?: BridgeClientRequestContext,
  ): Promise<SessionArtifactMutationResult>;

  /**
   * Cast a vote on a pending `permission_request` (first-responder wins).
   */
  respondToPermission(
    requestId: string,
    response: RequestPermissionResponse,
    context?: BridgeClientRequestContext,
  ): boolean;

  /**
   * Cast a vote scoped to an explicit session route.
   */
  respondToSessionPermission(
    sessionId: string,
    requestId: string,
    response: RequestPermissionResponse,
    context?: BridgeClientRequestContext,
  ): boolean;

  /**
   * List all live sessions whose canonical workspace path matches the
   * supplied cwd. Empty array (not throw) when no sessions exist.
   */
  listWorkspaceSessions(workspaceCwd: string): BridgeSessionSummary[];

  /**
   * Live status summary for a single session by id — the same shape
   * `listWorkspaceSessions` produces per item. Throws
   * `SessionNotFoundError` when no live session with that id exists on
   * this daemon. Lets a caller that already holds a session id poll
   * `hasActivePrompt` / `clientCount` without scanning the whole list.
   */
  getSessionSummary(sessionId: string): BridgeSessionSummary;

  /**
   * Record a client heartbeat for the session. Throws
   * `SessionNotFoundError` for unknown ids and `InvalidClientIdError`
   * when the supplied `clientId` is not registered for this session.
   */
  recordHeartbeat(
    sessionId: string,
    context?: BridgeClientRequestContext,
  ): BridgeHeartbeatResult;

  /**
   * Read the bridge's recorded last-seen timestamps for a session.
   * Returns `undefined` for unknown sessions.
   */
  getHeartbeatState(sessionId: string): BridgeHeartbeatState | undefined;

  /**
   * Workspace-level event fan-out for mutations that change daemon-wide state.
   * Best-effort per session; closed buses silently skipped.
   */
  publishWorkspaceEvent(event: Omit<BridgeEvent, 'id' | 'v'>): void;

  /**
   * Union of every live session's `clientIds`. Used by workspace-level
   * mutation routes to validate the optional `X-Qwen-Client-Id` header.
   * Returns a snapshot — callers must not mutate.
   */
  knownClientIds(): ReadonlySet<string>;

  /**
   * Generic workspace-status query delegated through the live ACP channel.
   * Returns `idle()` when no child is running. Used by DaemonWorkspaceService
   * to forward status methods without coupling to their concrete shapes.
   */
  queryWorkspaceStatus<T>(method: string, idle: () => T): Promise<T>;

  /**
   * Generic workspace command invocation delegated through the live ACP
   * channel. Throws `SessionNotFoundError` when no child is running (no
   * idle fallback). Used by DaemonWorkspaceService for mutations that
   * require an active channel (e.g. MCP restart).
   */
  invokeWorkspaceCommand<T>(
    method: string,
    params?: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<T>;

  /**
   * Run a hidden workspace-level managed-memory remember task. This
   * ensures the ACP child exists but must not create/load/resume an ACP
   * session or touch the per-session prompt queue.
   */
  runWorkspaceMemoryRemember(
    request: BridgeWorkspaceMemoryRememberRequest,
  ): Promise<BridgeWorkspaceMemoryRememberResult>;

  /**
   * Run a hidden workspace-level managed-memory forget task. This
   * ensures the ACP child exists but must not create/load/resume an ACP
   * session or touch the per-session prompt queue.
   */
  runWorkspaceMemoryForget(
    request: BridgeWorkspaceMemoryForgetRequest,
  ): Promise<BridgeWorkspaceMemoryForgetResult>;

  /**
   * Run a hidden workspace-level managed-memory dream task. This
   * ensures the ACP child exists but must not create/load/resume an ACP
   * session or touch the per-session prompt queue.
   */
  runWorkspaceMemoryDream(): Promise<BridgeWorkspaceMemoryDreamResult>;

  /**
   * Check whether the ACP child can run managed-memory remember for the
   * current workspace. Used by HTTP POST to return a synchronous 409 in
   * bare/unavailable modes without creating a session.
   */
  isWorkspaceMemoryRememberAvailable(): Promise<boolean>;

  /**
   * Start workspace-scoped MCP discovery without creating an ACP session.
   * The result only confirms the background task was accepted; callers read
   * progress from the normal workspace MCP status endpoint.
   */
  initializeWorkspaceMcp(): Promise<{ accepted: boolean }>;

  /** Reload persisted MCP settings into workspace and active session configs. */
  reloadWorkspaceMcp(): Promise<{ accepted: boolean }>;

  /**
   * Read discovered MCP tools for one server from the live ACP registry.
   * (New in upstream — kept in bridge pending workspace service migration.)
   */
  getWorkspaceMcpToolsStatus(
    serverName: string,
  ): Promise<ServeWorkspaceMcpToolsStatus>;

  /**
   * Read discovered MCP resources (`resources/list`) for one server from
   * the live ACP registry. Drill-down companion to
   * `getWorkspaceMcpToolsStatus`; the per-server `resourceCount` rides
   * the base `/workspace/mcp` status.
   */
  getWorkspaceMcpResourcesStatus(
    serverName: string,
  ): Promise<ServeWorkspaceMcpResourcesStatus>;

  /**
   * Read the live built-in tool registry for the bound workspace.
   * (New in upstream — kept in bridge pending workspace service migration.)
   */
  getWorkspaceToolsStatus(): Promise<ServeWorkspaceToolsStatus>;

  /** Read the current ACP context/config state for a live session. */
  getSessionContextStatus(
    sessionId: string,
  ): Promise<ServeSessionContextStatus>;

  /** Read structured context-window usage for a live session. */
  getSessionContextUsageStatus(
    sessionId: string,
    opts?: { detail?: boolean },
  ): Promise<ServeSessionContextUsageStatus>;

  /** Read slash-command/skill command availability for a live session. */
  getSessionSupportedCommandsStatus(
    sessionId: string,
  ): Promise<ServeSessionSupportedCommandsStatus>;

  /** Read the live background task snapshot for a live session. */
  getSessionTasksStatus(sessionId: string): Promise<ServeSessionTasksStatus>;

  /** Read sanitized LSP server status for a live session. */
  getSessionLspStatus(sessionId: string): Promise<ServeSessionLspStatus>;

  /**
   * Read a page of persisted transcript replay events through the ACP child.
   * This is workspace-scoped and read-only: implementations must not attach a
   * session client, seed the EventBus, or create a live SessionEntry.
   */
  getSessionTranscriptPage(
    req: BridgeSessionTranscriptPageRequest,
  ): Promise<BridgeSessionTranscriptPage>;

  /** Cancel a background task in a live session. */
  cancelSessionTask(
    sessionId: string,
    taskId: string,
    taskKind: 'agent' | 'shell' | 'monitor',
  ): Promise<{ cancelled: boolean }>;

  /** Clear an active goal in a live session without cancelling the running prompt. */
  clearSessionGoal(
    sessionId: string,
  ): Promise<{ cleared: boolean; condition?: string }>;

  /**
   * Read a live session's goal state. Throws `SessionNotFoundError` when the
   * session is not resident — goals live in the child's memory, so a
   * non-resident session has no goal to report.
   */
  getSessionGoal(sessionId: string): Promise<BridgeSessionGoal>;

  /**
   * Resume a live session's unfinished previous turn — an interrupted prompt
   * (model never answered) or a turn left with dangling tool calls — without
   * injecting a synthetic "continue" user message. Idempotent no-op when the
   * last turn ended cleanly. Mirrors the SDK's `continueLastTurn` and the core
   * `detectTurnInterruption` classification.
   */
  continueSession(
    sessionId: string,
    context?: BridgeClientRequestContext,
  ): Promise<{
    accepted: boolean;
    interruption: 'none' | 'interrupted_prompt' | 'interrupted_turn';
    /**
     * Replay cursor + correlation id for an accepted continuation, mirroring
     * the `POST /session/:id/prompt` 202 body. Present only when `accepted` —
     * the continuation runs as a tracked async turn, so clients use `promptId`
     * to correlate turn-scoped events, including `turn_complete` /
     * `turn_error`, while `lastEventId` resumes events emitted before they
     * (re)attach the SSE stream.
     */
    promptId?: string;
    lastEventId?: number;
  }>;

  /** Read structured session usage stats (tokens, tools, files). */
  getSessionStatsStatus(sessionId: string): Promise<ServeSessionStatsStatus>;

  /** Read workspace-level hook configuration status. */
  getWorkspaceHooksStatus(): Promise<ServeWorkspaceHooksStatus>;

  /** Read session-scoped hook status for a live session. */
  getSessionHooksStatus(sessionId: string): Promise<ServeSessionHooksStatus>;

  /** Read workspace-level installed extension status. */
  getWorkspaceExtensionsStatus(): Promise<ServeWorkspaceExtensionsStatus>;

  /**
   * Broadcast extension refresh to all active sessions and emit an
   * `extensions_changed` workspace event when complete.
   */
  refreshExtensionsForAllSessions(
    data?: Omit<BridgeExtensionsChangedData, 'refreshed' | 'failed'>,
  ): Promise<{
    refreshed: number;
    failed: number;
  }>;

  /** Emit an extension lifecycle event without refreshing sessions. */
  broadcastExtensionsChanged(data: BridgeExtensionsChangedData): void;

  /**
   * Switch the active model service for a session. Throws
   * `SessionNotFoundError` for unknown ids.
   */
  setSessionModel(
    sessionId: string,
    req: SetSessionModelRequest,
    context?: BridgeClientRequestContext,
  ): Promise<SetSessionModelResponse>;

  /**
   * Switch UI language and optionally LLM output language for a live
   * session, then broadcast a `language_changed` event.  When
   * `syncOutputLanguage` is true the handler also refreshes every
   * session's system prompt so the next LLM call uses the new language.
   */
  setSessionLanguage(
    sessionId: string,
    params: { language: string; syncOutputLanguage: boolean },
    context?: BridgeClientRequestContext,
  ): Promise<{
    language: string;
    outputLanguage: string | null;
    refreshed: boolean;
  }>;

  /**
   * Change the approval mode of a live session and broadcast an
   * `approval_mode_changed` event. `opts.persist === true` also writes
   * `tools.approvalMode` to workspace settings.
   */
  setSessionApprovalMode(
    sessionId: string,
    mode: ApprovalMode,
    opts: { persist: boolean },
    context?: BridgeClientRequestContext,
  ): Promise<{
    sessionId: string;
    mode: ApprovalMode;
    previous: ApprovalMode;
    persisted: boolean;
  }>;

  /**
   * Generate a one-sentence "where did I leave off" recap of a live
   * session. Forwards through `qwen/control/session/recap`, which
   * invokes `generateSessionRecap` (`core/services/sessionRecap.ts`) in
   * the ACP child against the per-session chat history.
   *
   * Best-effort: the helper returns `null` when history is too short or
   * the underlying side-query fails — both surface as a 200 response
   * with `recap: null`. Hard errors (unknown session, ACP transport
   * down) throw as usual.
   */
  generateSessionRecap(
    sessionId: string,
    context?: BridgeClientRequestContext,
  ): Promise<{ sessionId: string; recap: string | null }>;

  /**
   * Run a stateless, tool-free text generation request in the ACP child and
   * stream model deltas back only to this caller. The child prefers the
   * configured fast model and falls back to the session's main model.
   */
  generateSessionContent?(
    sessionId: string,
    prompt: string,
    signal: AbortSignal,
    context?: BridgeClientRequestContext,
  ): AsyncIterable<BridgeGenerationStreamEvent>;

  /**
   * Run a side question (/btw) against the session's conversation context.
   * Uses runForkedAgent (cache path) for a single-turn, tool-free LLM call.
   * Returns `answer: null` on empty/failed generation.
   */
  generateSessionBtw(
    sessionId: string,
    question: string,
    signal?: AbortSignal,
    context?: BridgeClientRequestContext,
  ): Promise<{ sessionId: string; answer: string | null }>;

  /**
   * Launch a background fork agent that inherits the live session's current
   * conversation context. This is CLI `/fork`, not ACP `session/fork`
   * (which maps to `/branch`).
   */
  launchSessionForkAgent(
    sessionId: string,
    directive: string,
    context?: BridgeClientRequestContext,
  ): Promise<BridgeForkAgentResult>;

  /**
   * Queue a mid-turn user message for the running turn. The ACP child drains
   * it between tool batches via the `craft/drainMidTurnQueue` ext-method so
   * the model sees it before the turn ends. Accepted only while the session
   * is busy (a prompt is queued or active); an idle (or full-queue) session
   * returns `{ accepted: false }` so the caller falls back to a normal
   * next-turn prompt. `context.clientId` is authorized against the session
   * like `/prompt` and `/btw` — throws `InvalidClientIdError` when the id is
   * not bound to the session, and `SessionNotFoundError` for unknown ids. The
   * trusted client id is recorded as the message's originator so the drain's
   * SSE echo only dedupes that client's pending queue.
   */
  enqueueMidTurnMessage(
    sessionId: string,
    message: string,
    context?: BridgeClientRequestContext,
  ): { accepted: boolean };

  /**
   * Execute a shell command directly on the daemon (no LLM involvement).
   * Streams output through the session's SSE bus and injects the
   * command+result into the LLM's chat history via extMethod.
   * Throws `SessionShellDisabledError` when direct shell is not enabled,
   * `SessionShellClientRequiredError` when no session-bound client id is
   * provided, `InvalidClientIdError` when the client id is not bound to the
   * session, and `SessionNotFoundError` for unknown ids.
   */
  executeShellCommand(
    sessionId: string,
    command: string,
    signal?: AbortSignal,
    context?: BridgeClientRequestContext,
  ): Promise<ShellCommandResult>;

  /**
   * List rewindable snapshots for a session with per-turn diff stats.
   */
  getRewindSnapshots(
    sessionId: string,
  ): Promise<{ snapshots: RewindSnapshotInfo[] }>;

  /**
   * Rewind a session to a previous turn: truncates conversation history
   * and restores files. File restore is best-effort — if the snapshot
   * is missing, conversation is still rewound and `filesChanged` is empty.
   */
  rewindSession(
    sessionId: string,
    req: RewindRequest,
    context?: BridgeClientRequestContext,
  ): Promise<RewindResponse>;

  /**
   * T2.8 (#4514): Add a runtime MCP server through the ACP child's
   * `McpClientManager.addRuntimeMcpServer`. On success, broadcasts an
   * `mcp_server_added` event to every session bus. Soft-refuse
   * (`budget_warning_only` skip) does NOT emit an event — the caller
   * receives the skip shape and decides locally.
   *
   * Throws `SessionNotFoundError` when no ACP channel is live (caller
   * should spawn or attach first). Typed ACP errors (budget-exceeded,
   * spawn-failed, invalid-config) are re-instantiated from the
   * JSON-RPC `data.errorKind` so the route's `sendBridgeError` can
   * map them to stable HTTP status codes.
   */
  addRuntimeMcpServer(
    name: string,
    config: Record<string, unknown>,
    originatorClientId?: string,
  ): Promise<
    | {
        name: string;
        transport: string;
        replaced: boolean;
        shadowedSettings: boolean;
        toolCount: number;
        originatorClientId: string;
      }
    | {
        name: string;
        skipped: true;
        reason: 'budget_warning_only' | 'runtime_name_conflict';
      }
  >;

  /**
   * Remove a runtime MCP server through the ACP child's
   * `McpClientManager.removeRuntimeMcpServer`. On success, broadcasts
   * an `mcp_server_removed` event. Idempotent skip (`not_present`)
   * does NOT emit — the caller receives the skip shape.
   *
   * Throws `SessionNotFoundError` when no ACP channel is live.
   */
  removeRuntimeMcpServer(
    name: string,
    originatorClientId?: string,
  ): Promise<
    | {
        name: string;
        removed: true;
        wasShadowingSettings: boolean;
        originatorClientId: string;
      }
    | { name: string; skipped: true; reason: 'not_present' }
  >;

  manageMcpServer(
    serverName: string,
    action: 'approve' | 'enable' | 'disable' | 'authenticate' | 'clear-auth',
    originatorClientId: string | undefined,
  ): Promise<{
    serverName: string;
    action: 'approve' | 'enable' | 'disable' | 'authenticate' | 'clear-auth';
    ok: true;
    changed?: boolean;
    messages?: string[];
    authUrl?: string;
    pending?: boolean;
  }>;

  generateWorkspaceAgent(
    description: string,
    originatorClientId: string | undefined,
  ): Promise<{
    name: string;
    description: string;
    systemPrompt: string;
  }>;

  /**
   * Tear down a session — kill the child, drop from maps, publish
   * `session_died`. Idempotent on already-dead sessions.
   *
   * `requireZeroAttaches: true` makes the call a no-op when at
   * least one other client has called `spawnOrAttach` for this
   * entry and got `attached: true`.
   *
   * Returns true only when this call removed the live session.
   */
  killSession(
    sessionId: string,
    opts?: { requireZeroAttaches?: boolean },
  ): Promise<boolean>;

  /**
   * Roll back a prior attach: decrement `attachCount` and reap if the
   * session has no other live attaches/subscribers.
   */
  detachClient(sessionId: string, clientId?: string): Promise<void>;

  /** Test/inspection hook: number of live sessions. */
  readonly sessionCount: number;

  /**
   * Whether an ACP channel is currently live (spawned and not dying).
   * Distinct from `sessionCount > 0`: a channel can be live with zero
   * attached sessions during the cold-spawn window, and conversely a
   * killed channel may briefly retain sessions before reaping. Consumers
   * that need true channel liveness (e.g. the workspace service's
   * `acpChannelLive` envelope field) must use this rather than the
   * session count.
   */
  isChannelLive(): boolean;

  /** Number of sessions with an active prompt. */
  readonly activePromptCount: number;

  /** Queued prompts across all sessions — accepted but not yet dispatched,
   *  excluding the one running per session — i.e. the queue-depth gauge for the
   *  Daemon Status charts (distinct from `activePromptCount`). Optional: a
   *  bridge injected via `RunQwenServeDeps.bridge` may predate these Daemon
   *  Status hooks, so the sampler treats them as absent (→ 0 / skipped). */
  readonly pendingPromptTotal?: number;

  /** Latest self-reported ACP-child rss/cpu (Daemon Status child-resource
   *  chart), or undefined before the first successful poll / when no child is
   *  live. Synchronous cache read for the metrics sampler. Optional — see
   *  {@link pendingPromptTotal}. */
  getChildResourceSnapshot?():
    | { rssBytes: number; cpuPercent: number }
    | undefined;
  /** Poll the live child's resource extMethod and refresh the cache that
   *  {@link getChildResourceSnapshot} reads. Fired fire-and-forget by the
   *  sampler each tick. Optional — see {@link pendingPromptTotal}. */
  refreshChildResource?(): Promise<void>;

  /**
   * Epoch-ms timestamp of the last "activity" event (prompt start/end,
   * session spawn/restore). `null` when the daemon has never processed
   * any activity since boot.
   */
  readonly lastActivityAt: number | null;

  /**
   * Milliseconds since the last activity event (`Date.now() - lastActivityAt`).
   * `null` when no activity has occurred since boot. Computed atomically to
   * avoid race windows between reading `lastActivityAt` and `Date.now()`.
   */
  readonly idleSinceMs: number | null;

  /** Test/inspection hook: number of permission requests awaiting a vote. */
  readonly pendingPermissionCount: number;

  /**
   * Active permission mediation policy. Reflects
   * the value `runQwenServe` resolved from
   * `settings.policy.permissionStrategy` (or the
   * `'first-responder'` default). Surfaced through the
   * `/capabilities` envelope's `policy.permission` field so SDK
   * clients can feature-detect at runtime which strategy is in
   * effect, distinct from the build-supported set advertised on
   * the `permission_mediation` capability tag.
   */
  readonly permissionPolicy: PermissionPolicy;

  /**
   * Synchronous force-kill of every live channel. Called by signal
   * handlers when the operator double-taps Ctrl+C.
   */
  killAllSync(): void;

  /** Close all live child processes; called on daemon/workspace shutdown. */
  shutdown(options?: BridgeShutdownOptions): Promise<void>;

  /**
   * Eagerly spawn the ACP child so the first session doesn't pay
   * cold-start latency. Fire-and-forget; failures are logged and the
   * first session falls back to lazy spawn.
   */
  preheat(): Promise<void>;
}

export interface BridgeShutdownOptions {
  reason?: 'daemon_shutdown' | 'workspace_removed';
}

export interface ShellCommandResult {
  exitCode: number | null;
  output: string;
  aborted: boolean;
}

/** @deprecated Use `AcpSessionBridge` instead. */
export type HttpAcpBridge = AcpSessionBridge;
