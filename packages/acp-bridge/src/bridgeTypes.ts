/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ApprovalMode } from '@qwen-code/qwen-code-core';
import type {
  CancelNotification,
  LoadSessionResponse,
  PromptRequest,
  PromptResponse,
  RequestPermissionResponse,
  ResumeSessionResponse,
  SetSessionModelRequest,
  SetSessionModelResponse,
} from '@agentclientprotocol/sdk';
import type { BridgeEvent, SubscribeOptions } from './eventBus.js';
import type { PermissionPolicy } from './permission.js';
import type {
  ServeSessionContextStatus,
  ServeSessionHooksStatus,
  ServeSessionSupportedCommandsStatus,
  ServeSessionTasksStatus,
  ServeWorkspaceExtensionsStatus,
  ServeWorkspaceHooksStatus,
  ServeWorkspaceMcpToolsStatus,
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
}

export interface RewindResponse {
  rewound: boolean;
  targetTurnIndex: number;
  filesChanged: string[];
  filesFailed: string[];
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
}

export interface BridgeRestoreSessionRequest {
  /** Session id to restore through ACP `session/load` or `session/resume`. */
  sessionId: string;
  /** Absolute path to the workspace root the child inherits as cwd. */
  workspaceCwd: string;
  /** Optional echo of a daemon-issued client id for this session. */
  clientId?: string;
}

export type BridgeSessionState = LoadSessionResponse | ResumeSessionResponse;

export interface BridgeRestoredSession extends BridgeSession {
  /** ACP state returned by `session/load` / `session/resume`. */
  state: BridgeSessionState;
  /** Compacted events for all completed turns (O(turns) size). */
  compactedReplay?: BridgeEvent[];
  /** Raw events since last turn boundary (current incomplete turn). */
  liveJournal?: BridgeEvent[];
  /** High-water mark event ID — client uses this as initial SSE cursor. */
  lastEventId?: number;
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

/** Sparse summary used by `GET /workspace/:id/sessions`. */
export interface BridgeSessionSummary {
  sessionId: string;
  workspaceCwd: string;
  createdAt: string;
  updatedAt?: string;
  displayName?: string;
  clientCount: number;
  hasActivePrompt: boolean;
}

export interface SessionMetadataUpdate {
  displayName?: string;
}

export interface CloseSessionOpts {
  /** Override the default `'client_close'` reason in the `session_closed` event. */
  reason?: string;
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
   * When present, the bridge stamps `turn_complete` / `turn_error` events
   * with this id so the SDK's `prompt()` can match the SSE event to the
   * pending HTTP 202 request.
   */
  promptId?: string;
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
 * from `SessionEntry.midTurnMessageQueue`.
 */
export const MID_TURN_QUEUE_DRAIN_METHOD = 'craft/drainMidTurnQueue';

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

export interface BridgeDaemonStatusLimits {
  maxSessions: number | null;
  maxPendingPromptsPerSession: number | null;
  eventRingSize: number;
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
   * Forward a prompt to the agent. Concurrent prompts against the same
   * session FIFO-serialize through a per-session queue.
   *
   * Admission contract: implementations must not be `async`. Admission
   * failures such as `PromptQueueFullError` and pre-aborted signals throw
   * synchronously so HTTP routes can reject before returning 202. Deferred
   * failures such as `SessionNotFoundError` may be returned as rejected
   * promises.
   */
  sendPrompt(
    sessionId: string,
    req: PromptRequest,
    signal?: AbortSignal,
    context?: BridgeClientRequestContext,
  ): Promise<PromptResponse>;

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
   * Read discovered MCP tools for one server from the live ACP registry.
   * (New in upstream — kept in bridge pending workspace service migration.)
   */
  getWorkspaceMcpToolsStatus(
    serverName: string,
  ): Promise<ServeWorkspaceMcpToolsStatus>;

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
    originatorClientId: string,
  ): Promise<
    | {
        name: string;
        transport: string;
        replaced: boolean;
        shadowedSettings: boolean;
        toolCount: number;
        originatorClientId: string;
      }
    | { name: string; skipped: true; reason: 'budget_warning_only' }
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
    originatorClientId: string,
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
    action: 'enable' | 'disable' | 'authenticate' | 'clear-auth',
    originatorClientId: string | undefined,
  ): Promise<{
    serverName: string;
    action: 'enable' | 'disable' | 'authenticate' | 'clear-auth';
    ok: true;
    changed?: boolean;
    messages?: string[];
    authUrl?: string;
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
   */
  killSession(
    sessionId: string,
    opts?: { requireZeroAttaches?: boolean },
  ): Promise<void>;

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

  /** Number of sessions with an active prompt (promptActive === true). */
  readonly activePromptCount: number;

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

  /** Close all live child processes; called on daemon shutdown. */
  shutdown(): Promise<void>;

  /**
   * Eagerly spawn the ACP child so the first session doesn't pay
   * cold-start latency. Fire-and-forget; failures are logged and the
   * first session falls back to lazy spawn.
   */
  preheat(): Promise<void>;
}

export interface ShellCommandResult {
  exitCode: number | null;
  output: string;
  aborted: boolean;
}

/** @deprecated Use `AcpSessionBridge` instead. */
export type HttpAcpBridge = AcpSessionBridge;
