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
import type {
  ServeSessionContextStatus,
  ServeSessionSupportedCommandsStatus,
  ServeWorkspaceEnvStatus,
  ServeWorkspaceMcpStatus,
  ServeWorkspacePreflightStatus,
  ServeWorkspaceProvidersStatus,
  ServeWorkspaceSkillsStatus,
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
}

/** Sparse summary used by `GET /workspace/:id/sessions`. */
export interface BridgeSessionSummary {
  sessionId: string;
  workspaceCwd: string;
  createdAt: string;
  displayName?: string;
  clientCount: number;
  hasActivePrompt: boolean;
}

export interface SessionMetadataUpdate {
  displayName?: string;
}

export interface BridgeClientRequestContext {
  /** Daemon-issued client id echoed through the HTTP transport header. */
  clientId?: string;
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

export interface HttpAcpBridge {
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
   * Forward a prompt to the agent. Concurrent prompts against the same
   * session FIFO-serialize through a per-session queue. Throws
   * `SessionNotFoundError` when the id is unknown.
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
    opts?: SubscribeOptions,
  ): AsyncIterable<BridgeEvent>;

  /**
   * Explicitly close a live session. Force-closes even when other clients
   * are attached. Throws `SessionNotFoundError` for unknown ids.
   */
  closeSession(
    sessionId: string,
    context?: BridgeClientRequestContext,
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
   * Read daemon-runtime MCP status for the bound workspace. Does not spawn
   * an ACP child when the daemon is idle.
   */
  getWorkspaceMcpStatus(): Promise<ServeWorkspaceMcpStatus>;

  /**
   * Read daemon-runtime skill status for the bound workspace.
   */
  getWorkspaceSkillsStatus(): Promise<ServeWorkspaceSkillsStatus>;

  /**
   * Read daemon-runtime model-provider status for the bound workspace.
   */
  getWorkspaceProvidersStatus(): Promise<ServeWorkspaceProvidersStatus>;

  /**
   * Read the daemon-process environment snapshot for the bound workspace.
   * Answered entirely from `process.*` state — does not consult ACP.
   */
  getWorkspaceEnvStatus(): Promise<ServeWorkspaceEnvStatus>;

  /**
   * Read daemon-runtime preflight diagnostics. Daemon-level cells are
   * always populated; ACP-level cells require a live ACP child — when
   * the daemon is idle they are emitted with `status: 'not_started'`.
   */
  getWorkspacePreflightStatus(): Promise<ServeWorkspacePreflightStatus>;

  /** Read the current ACP context/config state for a live session. */
  getSessionContextStatus(
    sessionId: string,
  ): Promise<ServeSessionContextStatus>;

  /** Read slash-command/skill command availability for a live session. */
  getSessionSupportedCommandsStatus(
    sessionId: string,
  ): Promise<ServeSessionSupportedCommandsStatus>;

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
   * Add or remove a tool name from the workspace's `tools.disabled`
   * settings list and fan-out a `tool_toggled` event to every live
   * session SSE bus.
   */
  setWorkspaceToolEnabled(
    toolName: string,
    enabled: boolean,
    originatorClientId: string | undefined,
  ): Promise<{ toolName: string; enabled: boolean }>;

  /**
   * Scaffold an empty `QWEN.md` (or whatever
   * `getCurrentGeminiMdFilename()` returns) at the bound workspace
   * root. Default refuses to overwrite via
   * `WorkspaceInitConflictError`; `opts.force === true` overwrites.
   */
  initWorkspace(
    opts: { force?: boolean },
    originatorClientId: string | undefined,
  ): Promise<{
    path: string;
    action: 'created' | 'overwrote' | 'noop';
  }>;

  /**
   * Restart a configured MCP server through the ACP child's
   * `McpClientManager`. Pre-checks the live budget snapshot and
   * returns a structured "skipped" response (200 OK) for soft refusals.
   */
  restartMcpServer(
    serverName: string,
    originatorClientId: string | undefined,
  ): Promise<
    | { serverName: string; restarted: true; durationMs: number }
    | {
        serverName: string;
        restarted: false;
        skipped: true;
        reason: 'in_flight' | 'disabled' | 'budget_would_exceed';
      }
  >;

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

  /** Test/inspection hook: number of permission requests awaiting a vote. */
  readonly pendingPermissionCount: number;

  /**
   * Synchronous force-kill of every live channel. Called by signal
   * handlers when the operator double-taps Ctrl+C.
   */
  killAllSync(): void;

  /** Close all live child processes; called on daemon shutdown. */
  shutdown(): Promise<void>;
}
