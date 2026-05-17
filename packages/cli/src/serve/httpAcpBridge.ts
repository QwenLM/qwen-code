/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from '@agentclientprotocol/sdk';
import { writeStderrLine } from '../utils/stdioHelpers.js';
import { canonicalizeWorkspace } from './fs/paths.js';
import {
  EventBus,
  DEFAULT_RING_SIZE,
  type BridgeEvent,
  type SubscribeOptions,
} from './eventBus.js';
import {
  SERVE_STATUS_EXT_METHODS,
  createIdleWorkspaceMcpStatus,
  createIdleWorkspaceProvidersStatus,
  createIdleWorkspaceSkillsStatus,
  type ServeSessionContextStatus,
  type ServeSessionSupportedCommandsStatus,
  type ServeWorkspaceMcpStatus,
  type ServeWorkspaceProvidersStatus,
  type ServeWorkspaceSkillsStatus,
} from './status.js';
import type {
  CancelNotification,
  Client,
  LoadSessionResponse,
  PromptRequest,
  PromptResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ResumeSessionResponse,
  SessionNotification,
  SetSessionModelRequest,
  SetSessionModelResponse,
  Stream,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk';

/**
 * Stage 1 HTTP→ACP bridge.
 *
 * Per #3803 §02 (architectural revision) and design §08 (Roadmap, Stage 1):
 *   - **1 daemon = 1 workspace**: every bridge instance is bound to a
 *     single canonical workspace path at construction
 *     (`BridgeOptions.boundWorkspace`). All `spawnOrAttach` calls must
 *     target that workspace; cross-workspace requests throw
 *     `WorkspaceMismatchError`. Multi-workspace deployments use multiple
 *     daemon processes (one per workspace, supervised externally).
 *   - One `qwen --acp` child total; multiple sessions multiplex onto it
 *     via `connection.newSession()` (the agent's native
 *     `sessions: Map<string, Session>` — see `acp-integration/acpAgent.ts:194`).
 *     Sessions share the child's process / OAuth state / `FileReadCache` /
 *     hierarchy-memory parse.
 *   - HTTP request bodies are forwarded as ACP NDJSON over the child's stdin.
 *   - Child stdout NDJSON notifications publish onto each session's
 *     `EventBus`; HTTP SSE subscribers (`GET /session/:id/events`) drain
 *     it. Cross-client fan-out + `Last-Event-ID` reconnect supported.
 *   - Multi-client requests against the same session serialize through this
 *     bridge (FIFO; honors ACP's "one active prompt per session" invariant).
 *     Different sessions on the same channel can prompt concurrently —
 *     the ACP layer demultiplexes by sessionId.
 *
 * Stage 2 replaces the spawn step with an in-process call into core's
 * ACP-equivalent API. The `HttpAcpBridge` interface stays the same so HTTP
 * route handlers don't need to change.
 */

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
   * over the bridge-wide default (`BridgeOptions.sessionScope`, which
   * direct embeds may set at construction time; the production daemon
   * has no CLI flag for it today and currently always uses `'single'`).
   * When omitted, the bridge-wide default applies — preserving exact
   * pre-#4175-PR-5 behavior for any caller that doesn't set the field.
   *
   * Resolves the FIXME at `BridgeOptions.sessionScope` (#3803 — VSCode
   * needing per-window isolation against a daemon defaulting to
   * `'single'`) and unblocks the baseline harness from honestly
   * measuring per-session cost (the harness in
   * `qwen-serve-baseline.test.ts` notes it cannot surface the P1 MCP
   * N×M amplification under the shared default).
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
 * pair — the same value future diagnostics and revocation policy
 * (Wave 5 PR 24) will read. `clientId` is echoed only when the caller
 * provided a trusted one through `X-Qwen-Client-Id`; anonymous
 * heartbeats omit it but still bump the per-session timestamp.
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
 * `getHeartbeatState` for in-process diagnostics; the eventual read-only
 * `GET /session/:id/heartbeat-state` route (Wave 3 PR 12) will surface
 * the same shape over HTTP.
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
   * session FIFO-serialize through a per-session queue (ACP guarantees
   * "one active prompt per session"). Throws `SessionNotFoundError` when
   * the id is unknown.
   *
   * Optional `signal` — abort cancels the in-flight prompt by sending an
   * ACP `cancel` notification to the agent (which causes the agent to
   * resolve its `prompt()` with `stopReason: 'cancelled'`). Used by the
   * SSE route to propagate `req.on('close')` so a disconnected HTTP
   * client unblocks the per-session FIFO instead of poisoning it.
   */
  sendPrompt(
    sessionId: string,
    req: PromptRequest,
    signal?: AbortSignal,
    context?: BridgeClientRequestContext,
  ): Promise<PromptResponse>;

  /**
   * Cancel the in-flight prompt on the session. ACP-side this is a
   * notification, not a request — the agent acknowledges by resolving the
   * active `prompt()` with a `cancelled` stop reason. Throws
   * `SessionNotFoundError` when the id is unknown.
   */
  cancelSession(
    sessionId: string,
    req?: CancelNotification,
    context?: BridgeClientRequestContext,
  ): Promise<void>;

  /**
   * Subscribe to the session's event stream. Returns an AsyncIterable that
   * yields published events; supports `Last-Event-ID` reconnect through
   * `opts.lastEventId`. Throws `SessionNotFoundError` when the id is
   * unknown.
   */
  subscribeEvents(
    sessionId: string,
    opts?: SubscribeOptions,
  ): AsyncIterable<BridgeEvent>;

  /**
   * Explicitly close a live session. Force-closes even when other clients
   * are attached — cancels any active prompt, resolves pending permissions
   * as cancelled, publishes `session_closed`, closes the EventBus, and
   * removes the session from daemon maps. Throws `SessionNotFoundError`
   * for unknown ids (the SDK absorbs 404 to provide client-side
   * idempotency). On-disk persisted sessions are NOT deleted — they can
   * still be reloaded via `POST /session/:id/load`.
   */
  closeSession(
    sessionId: string,
    context?: BridgeClientRequestContext,
  ): Promise<void>;

  /**
   * Update mutable session metadata. Currently supports `displayName` only.
   * Publishes a `session_metadata_updated` event when fields change.
   * Returns the effective stored metadata. Throws `SessionNotFoundError`
   * for unknown ids.
   */
  updateSessionMetadata(
    sessionId: string,
    metadata: SessionMetadataUpdate,
    context?: BridgeClientRequestContext,
  ): SessionMetadataUpdate;

  /**
   * Cast a vote on a pending `permission_request` (first-responder wins).
   * Returns true when the vote was accepted, false when the requestId is
   * unknown — either never existed or already resolved by another client.
   */
  respondToPermission(
    requestId: string,
    response: RequestPermissionResponse,
    context?: BridgeClientRequestContext,
  ): boolean;

  /**
   * Cast a vote scoped to an explicit session route. This keeps the legacy
   * first-responder behavior but lets clients avoid accidentally voting on a
   * request id that belongs to another live session.
   */
  respondToSessionPermission(
    sessionId: string,
    requestId: string,
    response: RequestPermissionResponse,
    context?: BridgeClientRequestContext,
  ): boolean;

  /**
   * List all live sessions whose canonical workspace path matches the
   * supplied cwd. Empty array (not throw) when no sessions exist —
   * a session-picker UI shouldn't 404 just because the workspace is idle.
   */
  listWorkspaceSessions(workspaceCwd: string): BridgeSessionSummary[];

  /**
   * Record a client heartbeat for the session. Bumps the per-session
   * `sessionLastSeenAt` and, when a trusted `clientId` is supplied,
   * the per-client entry in `clientLastSeenAt`. Throws
   * `SessionNotFoundError` when the id is unknown and
   * `InvalidClientIdError` when the supplied `clientId` is not
   * registered for this session — the same shape `sendPrompt` /
   * `setSessionModel` use, so HTTP routes can map it to `400
   * invalid_client_id` consistently.
   *
   * The recorded timestamps are exposed via `getHeartbeatState`; this
   * PR keeps them in-process only (future diagnostics route in PR 12,
   * future revocation policy in PR 24).
   */
  recordHeartbeat(
    sessionId: string,
    context?: BridgeClientRequestContext,
  ): BridgeHeartbeatResult;

  /**
   * Read the bridge's recorded last-seen timestamps for a session.
   * Returns `undefined` for unknown sessions. The map is a snapshot —
   * callers must not mutate it. Stage 1 surfaces this only to in-
   * process callers (tests, future read-only diagnostics routes).
   */
  getHeartbeatState(sessionId: string): BridgeHeartbeatState | undefined;

  /**
   * Read daemon-runtime MCP status for the bound workspace. Does not spawn an
   * ACP child when the daemon is idle; idle daemons return initialized:false.
   */
  getWorkspaceMcpStatus(): Promise<ServeWorkspaceMcpStatus>;

  /**
   * Read daemon-runtime skill status for the bound workspace. Does not spawn an
   * ACP child when the daemon is idle; idle daemons return initialized:false.
   */
  getWorkspaceSkillsStatus(): Promise<ServeWorkspaceSkillsStatus>;

  /**
   * Read daemon-runtime model-provider status for the bound workspace. Does
   * not spawn an ACP child when the daemon is idle.
   */
  getWorkspaceProvidersStatus(): Promise<ServeWorkspaceProvidersStatus>;

  /** Read the current ACP context/config state for a live session. */
  getSessionContextStatus(
    sessionId: string,
  ): Promise<ServeSessionContextStatus>;

  /** Read slash-command/skill command availability for a live session. */
  getSessionSupportedCommandsStatus(
    sessionId: string,
  ): Promise<ServeSessionSupportedCommandsStatus>;

  /**
   * Switch the active model service for a session. Forwards through ACP's
   * (currently unstable) `unstable_setSessionModel` and broadcasts a
   * `model_switched` event so cross-client UIs reflect the change.
   * Throws `SessionNotFoundError` for unknown ids.
   */
  setSessionModel(
    sessionId: string,
    req: SetSessionModelRequest,
    context?: BridgeClientRequestContext,
  ): Promise<SetSessionModelResponse>;

  /**
   * Kill the agent process for the session and remove it from the maps.
   * Used by the HTTP route layer to reap orphans created when a client
   * disconnects mid-spawn (the server-side child kept being created
   * even though no caller will ever know the sessionId). Idempotent —
   * unknown / already-dead sessions are no-ops.
   */
  /**
   * Tear down a session — kill the child, drop from maps, publish
   * `session_died`. Idempotent on already-dead sessions.
   *
   * `requireZeroAttaches: true` makes the call a no-op when at
   * least one other client has called `spawnOrAttach` for this
   * entry and got `attached: true`. Used by the disconnect-reaper
   * in `server.ts` so a fast reattach by client B doesn't lose its
   * session to client A's "I disconnected mid-spawn" cleanup.
   */
  killSession(
    sessionId: string,
    opts?: { requireZeroAttaches?: boolean },
  ): Promise<void>;

  /**
   * Roll back a prior attach: decrement `attachCount` and, if the
   * session now has neither attaching clients (`attachCount === 0`)
   * nor live SSE subscribers, reap it.
   *
   * Called from the server's `POST /session` route handler when the
   * attaching client disconnected before the response could be
   * written (`!res.writable && session.attached === true`). Without
   * this, the BQ9tV `attachCount`-based race guard would persist
   * monotonically: once any attach bumped the counter, the
   * spawn-owner's disconnect-reaper would never run again — even if
   * the attacher themselves disconnected (tanzhenxin issue 2). This
   * is the symmetric "I bumped, but my socket died so the bump is
   * fictitious" cleanup. When `clientId` is provided, the daemon-issued
   * identity reference acquired by that failed attach is released too;
   * echoed ids are ref-counted so a failed reconnect does not revoke an
   * older live owner of the same id.
   */
  detachClient(sessionId: string, clientId?: string): Promise<void>;

  /** Test/inspection hook: number of live sessions. */
  readonly sessionCount: number;

  /** Test/inspection hook: number of permission requests awaiting a vote. */
  readonly pendingPermissionCount: number;

  /**
   * Bd1y6: synchronous force-kill of every live channel. Called by
   * the runQwenServe SIGINT/SIGTERM handler when the operator
   * double-taps — the second signal can't afford the async
   * `shutdown()` Promise that the first signal is still in the
   * middle of. Without this, `process.exit(1)` would leave agent
   * children running after the daemon vanishes.
   */
  killAllSync(): void;

  /** Close all live child processes; called on daemon shutdown. */
  shutdown(): Promise<void>;
}

/**
 * Routes catch this to map to HTTP 404. Distinct from generic Error so the
 * route layer doesn't have to brittle-match on message text.
 */
export class SessionNotFoundError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string, extra?: string) {
    super(`No session with id "${sessionId}"` + (extra ? `. ${extra}` : ''));
    this.name = 'SessionNotFoundError';
    this.sessionId = sessionId;
  }
}

export class RestoreInProgressError extends Error {
  readonly sessionId: string;
  readonly activeAction: 'load' | 'resume';
  readonly requestedAction: 'load' | 'resume';

  constructor(
    sessionId: string,
    activeAction: 'load' | 'resume',
    requestedAction: 'load' | 'resume',
  ) {
    super(
      `Session "${sessionId}" is already being restored via session/${activeAction}; retry session/${requestedAction} after it completes`,
    );
    this.name = 'RestoreInProgressError';
    this.sessionId = sessionId;
    this.activeAction = activeAction;
    this.requestedAction = requestedAction;
  }
}

/**
 * Thrown by `spawnOrAttach` when `req.sessionScope` is set to a value
 * outside the `'single' | 'thread'` enum. The HTTP route validates the
 * body field at the boundary first (so HTTP callers get a typed
 * `400 invalid_session_scope` before ever reaching the bridge); this
 * class exists for direct callers — tests, embeds, future entry points
 * — and so the route's catch-block can translate it back to the same
 * 400 shape rather than the generic 500 every other thrown `Error`
 * collapses to. Distinct type so routes can branch without
 * text-matching the message.
 */
export class InvalidSessionScopeError extends Error {
  readonly sessionScope: unknown;
  constructor(sessionScope: unknown) {
    super(
      `Invalid sessionScope: ${JSON.stringify(sessionScope)}. ` +
        `Expected 'single' or 'thread'.`,
    );
    this.name = 'InvalidSessionScopeError';
    this.sessionScope = sessionScope;
  }
}

/**
 * Thrown by `spawnOrAttach` when a fresh-spawn would push `sessionCount`
 * past `BridgeOptions.maxSessions`. The HTTP route maps this to 503
 * with a `Retry-After` hint. Attaches (same workspace under `single`
 * scope) never trip this — only NEW children. Distinct error type so
 * routes can branch without text-matching.
 */
export class SessionLimitExceededError extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super(`Session limit reached (${limit})`);
    this.name = 'SessionLimitExceededError';
    this.limit = limit;
  }
}

/**
 * Thrown by `spawnOrAttach` when the requested `workspaceCwd` doesn't
 * canonicalize to the daemon's bound workspace. Per #3803 §02 every
 * bridge instance is bound to exactly one workspace; cross-workspace
 * requests are rejected at the daemon boundary. The server route
 * translates this to a 400 response with `code: 'workspace_mismatch'`
 * and both paths in the body so clients can fall through to spawning
 * their own daemon / routing to a different one via an orchestrator.
 */
export class WorkspaceMismatchError extends Error {
  readonly bound: string;
  readonly requested: string;
  constructor(bound: string, requested: string) {
    // Truncate `requested` to PATH_MAX so a malicious or buggy client
    // can't amplify a multi-MB `cwd` body through this error. The
    // constructor interpolates `requested` into `.message` TWICE, the
    // route's `sendBridgeError` echoes it in stderr (now JSON.stringify
    // -wrapped per the log-injection fix), and `res.json` echoes it in
    // the 400 body — without truncation a ~10 MB cwd (right under the
    // `express.json({limit: '10mb'})` cap) becomes ~20 MB message +
    // ~10 MB stderr + ~30 MB JSON response per request, ×
    // `maxConnections` (default 256). The route also caps `cwd.length`
    // at this same limit upstream (POST /session); this is
    // defense-in-depth for non-HTTP callers (tests, embeds, future
    // entry points that throw the error directly).
    const safeRequested =
      requested.length > MAX_WORKSPACE_PATH_LENGTH
        ? `${requested.slice(0, MAX_WORKSPACE_PATH_LENGTH)}…[truncated]`
        : requested;
    super(
      `Workspace mismatch: daemon is bound to "${bound}" but ` +
        `request asked for "${safeRequested}". Each \`qwen serve\` ` +
        `daemon binds to exactly one workspace; start a separate ` +
        `daemon for "${safeRequested}" (or route the request to one ` +
        `via an orchestrator).`,
    );
    this.name = 'WorkspaceMismatchError';
    this.bound = bound;
    this.requested = safeRequested;
  }
}

/**
 * Thrown when an HTTP caller echoes a client id that this daemon did not
 * issue for the addressed live session. Create/attach calls may receive a
 * fresh id instead; state-changing session routes reject unknown ids so
 * originator metadata stays daemon-stamped rather than caller-asserted.
 */
export class InvalidClientIdError extends Error {
  readonly sessionId: string;
  readonly clientId: string;
  constructor(sessionId: string, clientId: string) {
    super(`Client id "${clientId}" is not registered for session ${sessionId}`);
    this.name = 'InvalidClientIdError';
    this.sessionId = sessionId;
    this.clientId = clientId;
  }
}

/**
 * PATH_MAX on Linux is 4096; macOS / BSD is 1024. We use the Linux
 * value as a generous ceiling — anything bigger is either a
 * malformed client request (memory amplification attack against the
 * 400 / stderr / error-message echo paths) or a synthetic test
 * input. The route's POST /session pre-check rejects bodies past
 * this; `WorkspaceMismatchError` truncates for any caller that
 * skips the pre-check.
 */
export const MAX_WORKSPACE_PATH_LENGTH = 4096;

/**
 * One ACP NDJSON channel to a single agent. Tests inject a fake by replacing
 * the channel factory; production uses `defaultSpawnChannelFactory`.
 */
export interface AcpChannel {
  stream: Stream;
  /** Best-effort terminate; resolves when teardown is complete. */
  kill(): Promise<void>;
  /**
   * Bd1y6: synchronous force-kill for the second-signal force-exit
   * path. Fires SIGKILL on the underlying child (or equivalent
   * in-process tear-down) and returns immediately — no Promise. The
   * daemon's signal handler can call this before `process.exit(1)`
   * so that double-Ctrl+C doesn't leave the agent child running
   * after the daemon vanishes.
   */
  killSync(): void;
  /**
   * Resolves when the channel has terminated for any reason — planned
   * (`kill()` called) OR unexpected (child process crashed, stream closed).
   * The bridge subscribes to this so a SessionEntry whose underlying
   * channel dies between requests is removed from `byId` /
   * `defaultEntry` instead of lingering as a stuck session.
   *
   * Resolves to `{ exitCode, signalCode }` when the spawn factory can
   * capture them (the standard `child.on('exit', code, signal)` path),
   * or `undefined` when termination didn't go through the OS exit path
   * (programmatic kill via the in-process channel, channel-factory
   * error path, etc.). The bridge threads this through the
   * `session_died` event so an operator triaging a crash doesn't need
   * to grep stderr for the pid (BX9_P).
   */
  exited: Promise<AcpChannelExitInfo | undefined>;
}

export interface AcpChannelExitInfo {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}

export type ChannelFactory = (workspaceCwd: string) => Promise<AcpChannel>;

// FIXME(stage-1.5, chiga0 finding 1 + 4):
// Stage 1.5 should split this file's responsibilities into:
//   - `AcpChannel` interface (sendPrompt/cancel/setModel/sessionUpdate)
//     with `SpawnedAcpChannel` (Stage 1) + `InProcessAcpChannel`
//     (Stage 2) implementations — lifted to `@qwen-code/acp-bridge`
//     so `channels/base/AcpBridge.ts` can consume the same primitive
//     (today both reimplement the child lifecycle independently).
//   - `Transport` interface (`SseTransport` (Stage 1) +
//     `WebSocketTransport` / `InProcessTransport` seams visible) so
//     adding wire formats doesn't require rewriting the bridge.
// Plus a `fileSystem?: FileSystemService` option to BridgeOptions
// (finding 4) so the BridgeClient writeTextFile/readTextFile stop
// reimplementing core's filesystem semantics — closes the Stage 1
// known-divergence on BOM / non-UTF-8 / line-ending handling. Cost:
// one constructor dep; benefit: Stage 1 clients see correct fs
// semantics today instead of a wire-level break at Stage 2. Tracked
// under #3803. Reference:
// https://github.com/QwenLM/qwen-code/pull/3889#issuecomment-4427773706
export interface BridgeOptions {
  /**
   * §03 decision §1. `single` shares one session per workspace across HTTP
   * clients (live-collaboration default); `thread` gives each `spawnOrAttach`
   * call its own session for strict isolation.
   *
   * Daemon-wide default. Per-request callers can override via
   * `BridgeSpawnRequest.sessionScope` — the override wins and the
   * daemon-wide value acts only as the fallback when the request
   * omits the field. See the `session_scope_override` capability on
   * `/capabilities.features` for negotiation.
   * Reference:
   * https://github.com/QwenLM/qwen-code/pull/3889#issuecomment-4427875644
   */
  sessionScope?: 'single' | 'thread';
  /** Channel factory; defaults to spawning `qwen --acp` as a child process. */
  channelFactory?: ChannelFactory;
  /** How long to wait for the child's `initialize` reply before giving up. */
  initializeTimeoutMs?: number;
  /**
   * Cap on concurrent live sessions. `spawnOrAttach` calls that would
   * cross this throw `SessionLimitExceededError`; attaches to an
   * existing session (same workspace under `single` scope) are not
   * counted. `0` / `Infinity` disable the cap. Defaults to 20 — see
   * `ServeOptions.maxSessions` for the rationale.
   */
  maxSessions?: number;
  /**
   * Per-session SSE replay ring depth. Sets `ringSize` on every
   * `new EventBus(...)` the bridge constructs (both fresh sessions
   * and restored sessions). Defaults to `DEFAULT_RING_SIZE` (8000,
   * #3803 §02 target). Must be a positive finite integer; `0` /
   * `NaN` / negative throw at boot (fail-CLOSED — same posture as
   * `maxSessions`, where silently disabling a backpressure knob on a
   * config typo is worse than failing to start).
   *
   * Operators tune via `qwen serve --event-ring-size <n>`. Cost
   * scales linearly with `ringSize`; each retained `BridgeEvent` is
   * an object reference plus its serialized payload (text chunks /
   * tool-call args / etc.), so the per-session memory ceiling is
   * `ringSize × average-event-size` held until the session ends.
   */
  eventRingSize?: number;
  /**
   * Bd1yh: per-`requestPermission` wall clock. After this many ms with
   * no client vote, the agent's permission promise resolves as
   * cancelled — the per-session FIFO can drain instead of poisoning
   * forever on a missing SSE subscriber. Defaults to 5 minutes.
   * `0` / `Infinity` / non-finite disable the timeout (matches
   * legacy behavior, NOT recommended).
   */
  permissionResponseTimeoutMs?: number;
  /**
   * Bd1z5: per-session cap on pending permissions in flight. New
   * `requestPermission` calls past this cap resolve as cancelled with
   * a stderr warning. Defaults to 64. `0` / `Infinity` disable the
   * cap.
   */
  maxPendingPermissionsPerSession?: number;
  /**
   * Absolute, **already-canonical** path this daemon is bound to (per
   * #3803 §02: 1 daemon = 1 workspace). `spawnOrAttach` calls whose
   * `workspaceCwd` doesn't canonicalize to this same value throw
   * `WorkspaceMismatchError` (route → 400 with code `workspace_mismatch`).
   *
   * **Caller contract**: pass the result of
   * `canonicalizeWorkspace(path)`. `runQwenServe` does this at boot
   * and threads the same canonical value into the bridge AND
   * `createServeApp` (via `deps.boundWorkspace`) so all three —
   * `/capabilities.workspaceCwd`, the `POST /session` cwd fallback,
   * and this bridge's mismatch check — share one canonical form. The
   * constructor only checks `path.isAbsolute`; it does NOT
   * re-canonicalize (a redundant `realpathSync.native` could
   * theoretically diverge from the runQwenServe canonicalize on
   * NFS-transient / mid-rename filesystems, landing the bridge with
   * one canonical form while `/capabilities` advertises another).
   * Direct embeds / tests calling `createHttpAcpBridge` themselves
   * MUST canonicalize before passing.
   */
  boundWorkspace: string;
}

/**
 * The single `qwen --acp` child + the ACP connection on top of it,
 * shared by every SessionEntry in this daemon. Per #3803 §02 the
 * bridge is bound to one workspace at construction, so there is at
 * most one channel alive at any moment. Multiple sessions multiplex
 * onto it via the agent's native `sessions: Map<string, Session>`
 * (see `acp-integration/acpAgent.ts:194`), each `newSession()` call
 * returning a distinct id while sharing the child's process / OAuth /
 * file-cache / hierarchy-memory parse.
 *
 * Lifetime: created on first `spawnOrAttach`, kept alive while
 * `sessionIds.size > 0`, and killed by `killSession` when the last
 * entry leaves OR by `channel.exited` when the child dies.
 */
interface ChannelInfo {
  channel: AcpChannel;
  connection: ClientSideConnection;
  /** Shared BridgeClient — its methods route ACP params by sessionId. */
  client: BridgeClient;
  // Note: pre-§02 a `workspaceCwd: string` field lived here so the
  // `byWorkspaceChannel.get(entry.workspaceCwd)` lookup could route
  // multi-workspace requests. Under "1 daemon = 1 workspace" the
  // module-scope `boundWorkspace` is the single source of truth and
  // every channel inherits it. Per-channel storage would suggest
  // variance the model doesn't allow; dropping it makes the
  // single-workspace invariant visible at the type level.
  /**
   * Live session ids multiplexed on this channel. Updated when
   * `doSpawn` registers a new session and when `killSession` /
   * `channel.exited` removes one. When the set drops to empty under
   * `killSession`, the channel is marked `isDying = true` and its
   * `channel.kill()` is awaited; `channelInfo` itself is left
   * pointing at the dying channel until `channel.exited` fires (see
   * BkUyD invariant on `isDying` below).
   */
  sessionIds: Set<string>;
  /**
   * Restore calls currently executing on this channel but not yet registered
   * in `sessionIds`. Used to avoid killing the shared channel when one pending
   * restore fails while another is still healthy.
   */
  pendingRestoreIds: Set<string>;
  /**
   * Cached channel-close race for workspace-scoped status requests. Workspace
   * status can be polled frequently by dashboards, so keep one promise per
   * channel instead of attaching a new `.then()` to `channel.exited` per poll.
   */
  statusClosedReject?: Promise<never>;
  /**
   * MUST be set to `true` synchronously by any teardown path BEFORE
   * awaiting `channel.kill()`. `ensureChannel` treats a dying channel
   * as absent and spawns a fresh one — without this flag a concurrent
   * `spawnOrAttach` arriving during the SIGTERM grace window (up to
   * 10s) would attach to a transport about to close, landing the
   * caller with a sessionId that 404s on every follow-up request.
   *
   * **Set-sites (5)** — any new teardown path MUST call into one of
   * these or replicate the pattern:
   *
   *   1. `ensureChannel`: `initialize`-failure catch.
   *   2. `ensureChannel`: late-shutdown re-check (shuttingDown flipped
   *      during handshake).
   *   3. `doSpawn`: newSession-failure on an empty channel
   *      (sessionIds.size === 0).
   *   4. `killSession`: last session leaving (sessionIds.size === 0
   *      after the delete).
   *   5. `shutdown`: bulk-mark every entry in `aliveChannels`.
   *
   * **BkUyD invariant (why we don't clear `channelInfo` here)**:
   * `killAllSync` must still find the channel during the SIGTERM
   * grace window to fire SIGKILL on `process.exit(1)`. `aliveChannels`
   * holds the dying entry until `channel.exited` fires (OS-level
   * reap); `isDying` is the "available-for-new-spawns" half of the
   * two-bit (alive, dying) state.
   */
  isDying: boolean;
}

interface SessionEntry {
  sessionId: string;
  workspaceCwd: string;
  createdAt: string;
  displayName?: string;
  channel: AcpChannel;
  connection: ClientSideConnection;
  /** Per-session event bus drives `GET /session/:id/events`. */
  events: EventBus;
  /**
   * Tail of the per-session prompt queue. Each new prompt chains off the
   * resolved (or rejected) state of this promise so prompts run one at a
   * time in arrival order. Always resolves — failures are swallowed at the
   * tail so a prior failure doesn't block subsequent prompts; the original
   * caller still observes the rejection on its own returned promise.
   */
  promptQueue: Promise<void>;
  /**
   * Per-session model-change FIFO. Prevents two concurrent
   * `applyModelServiceId` calls (e.g. simultaneous attach-with-different-
   * model requests) from racing into `unstable_setSessionModel` and
   * leaving the agent in non-deterministic state. Always resolves —
   * failures swallowed at the tail like `promptQueue`.
   */
  modelChangeQueue: Promise<void>;
  /**
   * Cached "transport closed" promise. The first `sendPrompt` on a
   * session lazy-builds this from `channel.exited.then(throw)`; every
   * subsequent prompt's race uses the SAME promise so the listener
   * count on `channel.exited` stays at one regardless of how many
   * prompts run on the session over its lifetime.
   */
  transportClosedReject?: Promise<never>;
  /**
   * Permission requestIds belonging to this session, kept so cancelSession
   * + shutdown can resolve them as `cancelled` per ACP requirement
   * (cancelled prompt MUST resolve outstanding requestPermission with
   * outcome.cancelled).
   */
  pendingPermissionIds: Set<string>;
  /**
   * Daemon-issued client ids currently known for this live session. HTTP
   * clients may echo one through `X-Qwen-Client-Id`; the bridge only treats
   * it as trusted originator metadata if it appears in this set.
   */
  clientIds: Map<string, number>;
  /**
   * Originator for the prompt currently running on this session. ACP enforces
   * one active prompt per session, and this bridge FIFO-serializes prompts, so
   * inline session updates / permission requests can safely inherit this id.
   */
  activePromptOriginatorClientId?: string;
  /**
   * Count of times `spawnOrAttach` has returned `attached: true` for
   * this entry — i.e. a second-or-subsequent client claimed this
   * session under `sessionScope: 'single'`. Used by the disconnect-
   * reaper in `server.ts`: if the spawn-owner client disconnected
   * during the spawn handshake but another client has already
   * attached, the reaper must NOT tear the session down (option 1
   * from PR #3889 review BQ9tV — "track an attached-after-spawn
   * counter and skip kill if any other client attached"). The
   * increment + the killSession-skip-check both happen in the
   * synchronous portion of their respective async functions, so the
   * counter is observed atomically across the awaiting boundary.
   */
  attachCount: number;
  /**
   * BkwQP: tombstone for the spawn-owner-disconnect path. When the
   * spawn owner's HTTP response can't be written and they call
   * `killSession({ requireZeroAttaches: true })` but the bail
   * triggers (because some other client already bumped
   * `attachCount`), set this flag — it remembers the spawn owner
   * wanted the session reaped. A later `detachClient()` that brings
   * `attachCount` back to 0 then completes the deferred reap. Stays
   * `false` for sessions the spawn owner never tried to kill, so
   * `detachClient` of a transient attach doesn't reap a still-valid
   * session.
   */
  spawnOwnerWantedKill: boolean;
  /**
   * ACP state captured at `session/load` / `session/resume` time so
   * late attachers (existing-byId early-return + coalesced restore
   * waiters) get the same payload the original restore caller did.
   * `undefined` for sessions created via `doSpawn` — those have never
   * had an ACP load/resume response, so attaches return `state: {}`.
   */
  restoreState?: BridgeSessionState;
  /**
   * Most recent heartbeat across any client on this session (Date.now()
   * epoch ms). Set on every `recordHeartbeat` call regardless of whether
   * the caller identified themselves; consumed by future diagnostics
   * (PR 12) and revocation policy (PR 24). Undefined until the first
   * heartbeat lands.
   */
  sessionLastSeenAt?: number;
  /**
   * Per-`clientId` last heartbeat (Date.now() epoch ms). Only populated
   * when the heartbeat carried a trusted `X-Qwen-Client-Id`. Entries are
   * dropped together with the parent session — there's no per-client
   * eviction in this PR; revocation policy (PR 24) will own that.
   */
  clientLastSeenAt: Map<string, number>;
}

interface PendingPermission {
  requestId: string;
  sessionId: string;
  resolve: (resp: RequestPermissionResponse) => void;
  /**
   * BkwQI: the option IDs the agent originally offered to clients in
   * the `permission_request` event. `respondToPermission` validates
   * the voter's `optionId` against this set so an authenticated
   * client can't smuggle in a hidden outcome (e.g.
   * `ProceedAlwaysProject` when the prompt's
   * `hideAlwaysAllow` / forced-ask policy intentionally omitted it).
   * Stored as a Set for O(1) membership check.
   */
  allowedOptionIds: ReadonlySet<string>;
}

interface PermissionResolutionRecord {
  requestId: string;
  sessionId: string;
  outcome: RequestPermissionResponse['outcome'];
}

// Bounded duplicate-vote cache. Stores only requestId/sessionId/outcome, so
// 512 records stays small while covering normal UI reconnect/race windows.
const MAX_RESOLVED_PERMISSION_RECORDS = 512;

function isServeDebugLoggingEnabled(): boolean {
  const value = process.env['QWEN_SERVE_DEBUG'];
  if (!value) return false;
  return !['0', 'false', 'off', 'no'].includes(value.trim().toLowerCase());
}

function writeServeDebugLine(message: string): void {
  if (!isServeDebugLoggingEnabled()) return;
  writeStderrLine(`qwen serve debug: ${message}`);
}

/**
 * BkwQI: thrown by `bridge.respondToPermission` when the voter's
 * `optionId` isn't in the set of options the agent originally
 * offered. Server route catches this and returns 400 (distinct from
 * 404 unknown-requestId).
 */
export class InvalidPermissionOptionError extends Error {
  readonly requestId: string;
  readonly optionId: string;
  constructor(requestId: string, optionId: string) {
    super(
      `Permission ${requestId}: optionId "${optionId}" is not in the ` +
        `set of options the agent offered.`,
    );
    this.name = 'InvalidPermissionOptionError';
    this.requestId = requestId;
    this.optionId = optionId;
  }
}

const MAX_DISPLAY_NAME_LENGTH = 256;

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export class InvalidSessionMetadataError extends Error {
  readonly field: string;
  constructor(field: string, reason: string) {
    super(`Invalid session metadata: ${field} ${reason}`);
    this.name = 'InvalidSessionMetadataError';
    this.field = field;
  }
}

/**
 * Bridge `Client` implementation — the daemon's response surface for things
 * the agent asks the client (file reads/writes, permission prompts).
 *
 * Stage 1 behavior:
 *   - `requestPermission` publishes a `permission_request` event onto the
 *     session bus and awaits the first HTTP `POST /permission/:requestId`
 *     vote (first-responder wins). When the session is cancelled or the
 *     daemon shuts down, the pending promise resolves with
 *     `{ outcome: { outcome: 'cancelled' } }` per ACP spec.
 *   - `sessionUpdate` notifications publish onto the session's EventBus; SSE
 *     subscribers (`GET /session/:id/events`) drain it.
 *   - File reads/writes proxy to local fs (daemon and agent share the host).
 *
 * Stage 1 trust model: the spawned `qwen --acp` child runs as the same user
 * as the daemon, so the file-proxy methods do NOT enforce a workspace-cwd
 * sandbox. The agent could already read or write the same files via its
 * built-in tools (e.g. shell). Restricting the bridge here would be
 * theatre. Stage 4+ remote-sandbox deployments swap this `Client` for a
 * sandbox-aware variant — see issue #3803 §11.
 */
class BridgeClient implements Client {
  constructor(
    /**
     * Look up the `SessionEntry` for an ACP call. Stage 1.5 multi-
     * session on one channel means `BridgeClient` is shared across
     * many sessions, so we can't bind the entry in a closure — we
     * dispatch by the `sessionId` ACP includes in every per-session
     * notification / request. `undefined` sessionId is the fallback
     * for ACP calls that don't carry one (none expected on the
     * client surface as of this writing) and resolves to whatever
     * the channel's most-recent entry is — kept defensive to avoid
     * silent drops if ACP grows a no-sessionId call.
     */
    private readonly resolveEntry: (
      sessionId?: string,
    ) => SessionEntry | undefined,
    private readonly resolvePendingRestoreEvents: (
      sessionId?: string,
    ) => EventBus | undefined,
    private readonly registerPending: (pending: PendingPermission) => void,
    /**
     * Roll back a `registerPending` call when the subsequent publish
     * fails (closed bus). Resolves the pending promise as cancelled
     * and removes it from the daemon-wide maps so a late
     * `respondToPermission` for this id returns 404 cleanly.
     */
    private readonly rollbackPending: (requestId: string) => void,
    /**
     * Bd1yh: wall-clock ms before `requestPermission` resolves as
     * cancelled if no client vote arrives. 0 = disabled. Prevents
     * the per-session FIFO `promptQueue` from poisoning forever
     * when no SSE subscriber is connected.
     */
    private readonly permissionTimeoutMs: number,
    /**
     * Bd1z5: per-session cap on in-flight permissions. New requests
     * past this cap resolve as cancelled with a stderr warning.
     * Infinity = disabled.
     */
    private readonly maxPendingPerSession: number,
  ) {}

  // FIXME(stage-1.5, chiga0 finding 3):
  // The first-responder permission flow here is a third permission
  // model in the codebase (alongside ACP `requestPermission` direct
  // and stream-json `ControlDispatcher`). Stage 1.5 should lift
  // "permission request lifecycle" into a `PermissionMediator`
  // interface with strategy-pluggable policies (`first-responder` |
  // `designated` | `consensus` | `local-only`) so all four
  // agent-exposing surfaces share one lifecycle. This is also the
  // closure point for the prior chiga0 audit Risk 2 (first-responder
  // lacks an authorization model). Reference:
  // https://github.com/QwenLM/qwen-code/pull/3889#issuecomment-4427773706
  async requestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const entry = this.resolveEntry(params.sessionId);
    if (!entry) return { outcome: { outcome: 'cancelled' } };

    // Bd1z5: per-session cap. Reject before registering so we never
    // grow `pendingPermissionIds` past the limit.
    if (entry.pendingPermissionIds.size >= this.maxPendingPerSession) {
      writeStderrLine(
        `qwen serve: session ${entry.sessionId} exceeded ` +
          `maxPendingPermissionsPerSession (${this.maxPendingPerSession}) — ` +
          `resolving new permission as cancelled.`,
      );
      return { outcome: { outcome: 'cancelled' } };
    }

    const requestId = randomUUID();
    return await new Promise<RequestPermissionResponse>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const settleOnce = (response: RequestPermissionResponse) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(response);
      };

      // BkwQI: snapshot the option-id set the agent is offering for
      // this prompt. `respondToPermission` checks the voter's
      // `optionId` against this set so a malicious client can't
      // forge an option (e.g. `ProceedAlways*`) the agent
      // intentionally hid.
      const allowedOptionIds = new Set(
        params.options.map((o: { optionId?: unknown }) =>
          String(o.optionId ?? ''),
        ),
      );
      allowedOptionIds.delete('');
      this.registerPending({
        requestId,
        sessionId: entry.sessionId,
        resolve: settleOnce,
        allowedOptionIds,
      });
      // `publish()` returns `undefined` on a closed bus — the
      // shutdown path closes per-session buses BEFORE awaiting
      // `channel.kill()`, leaving a small window where the agent
      // can still issue `requestPermission`. If we registered the
      // pending entry above but the publish fails, no SSE
      // subscriber will ever see the request → no client can vote
      // → the pending promise never resolves → agent's
      // `requestPermission` hangs forever (a real bug, not a
      // theoretical one — the daemon's shutdown.kill() loop awaits
      // each child, and a child stuck waiting on permission would
      // pin shutdown until the kill timer expires).
      //
      // Resolve as `cancelled` immediately if the bus rejected
      // the publish. Mirrors the orphan-permission handling in
      // `registerPending` itself for the entry-already-gone case.
      const published = entry.events.publish({
        type: 'permission_request',
        data: {
          requestId,
          sessionId: entry.sessionId,
          toolCall: params.toolCall,
          options: params.options,
        },
        ...(entry.activePromptOriginatorClientId
          ? { originatorClientId: entry.activePromptOriginatorClientId }
          : {}),
      });
      if (!published) {
        // Roll back the pending registration and resolve cancelled.
        this.rollbackPending(requestId);
        return;
      }

      // Bd1yh: arm the deadline AFTER publish so we don't fire-and-
      // cancel a no-subscriber request before the bus even saw it.
      // When the deadline fires, roll back the pending (so a late
      // vote returns 404) and resolve as cancelled (unwinding the
      // agent's awaiting promise so the per-session FIFO can drain).
      if (this.permissionTimeoutMs > 0) {
        timer = setTimeout(() => {
          if (settled) return;
          writeStderrLine(
            `qwen serve: session ${entry.sessionId} permission ` +
              `${requestId} timed out after ${this.permissionTimeoutMs}ms ` +
              `(no client voted) — resolving as cancelled.`,
          );
          this.rollbackPending(requestId);
        }, this.permissionTimeoutMs);
        if (typeof timer === 'object' && timer && 'unref' in timer) {
          (timer as { unref: () => void }).unref();
        }
      }
    });
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    const entry = this.resolveEntry(params.sessionId);
    const events =
      entry?.events ?? this.resolvePendingRestoreEvents(params.sessionId);
    if (!events) return;
    events.publish({
      type: 'session_update',
      data: params,
      ...(entry?.activePromptOriginatorClientId
        ? { originatorClientId: entry.activePromptOriginatorClientId }
        : {}),
    });
  }

  async writeTextFile(
    params: WriteTextFileRequest,
  ): Promise<WriteTextFileResponse> {
    // Stage 1 known divergence: this raw `fs.writeFile` reimplements file
    // I/O instead of delegating to core's filesystem service. The
    // user-visible scenarios where they differ:
    //   - BOM handling: this drops/re-encodes whatever the agent passed;
    //     core would preserve.
    //   - Non-UTF-8 source files: round-tripping through utf8 mangles
    //     content.
    //   - Original line endings: core preserves CRLF on Windows files;
    //     this writes whatever the agent buffered.
    // Wiring core's FileSystemService through the bridge requires
    // exposing it as a constructor dep; the cost-benefit is low for
    // Stage 1 (most agent-side tools call core directly, NOT through
    // these ACP fs methods) and Stage 2 in-process eliminates the
    // bridge fs proxy entirely. Tracked as a Stage 2 prerequisite.
    //
    // BSA0D: write-then-rename so a SIGKILL / OOM mid-write doesn't
    // leave the target truncated. POSIX `rename` is atomic within the
    // same filesystem; on Windows it's atomic when the target doesn't
    // exist (we tolerate the race-on-overwrite case as a Stage 2
    // gap). The tmp file lives in the same directory so the rename
    // can't cross filesystem boundaries (which would degrade to a
    // copy + race re-emerges).
    //
    // BX8Yw: rename would replace a symlink at the target path with a
    // regular file, leaving the original symlink target unchanged
    // while the write appears successful. Resolve symlinks via
    // `realpath` first so the atomic write lands at the actual file.
    //
    // BfFvO: dangling-symlink case — `realpath` throws ENOENT when
    // the symlink's target doesn't exist. A blanket catch then
    // silently falls back to `params.path` (the symlink itself), and
    // `rename(tmp, params.path)` would replace the symlink with a
    // regular file — exactly the bug BX8Yw was supposed to fix.
    // Distinguish "path doesn't exist at all" (truly new file →
    // write through) from "dangling symlink" (symlink exists, target
    // doesn't → write through to the symlink's intended target so
    // the symlink stays a symlink and points at a fresh file).
    let realTarget = params.path;
    try {
      realTarget = await fs.realpath(params.path);
    } catch (err) {
      const code =
        err && typeof err === 'object' && 'code' in err
          ? (err as { code?: unknown }).code
          : undefined;
      if (code !== 'ENOENT') throw err;
      // realpath ENOENT can mean (a) path doesn't exist at all, or
      // (b) the path is a symlink whose target doesn't exist. Use
      // `readlink` to disambiguate. If it succeeds we've got a
      // dangling symlink → resolve its target manually so the
      // subsequent rename creates the target instead of replacing
      // the symlink.
      try {
        const linkTarget = await fs.readlink(params.path);
        realTarget = path.resolve(path.dirname(params.path), linkTarget);
      } catch {
        // readlink also failed → truly non-existent path → write
        // through to the original (it'll be created).
      }
    }
    // BX8Yp + BX9_h: temp filename must include random bytes —
    // PID+ms alone collides under `sessionScope: 'thread'` (two
    // concurrent sessions writing the same path in the same ms) AND
    // can collide between concurrent prompts in one session. Add a
    // UUID and create exclusively (`flag: 'wx'`) so any residual
    // collision fails before content is overwritten.
    const tmp = `${realTarget}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    // BkwQW: preserve the existing target's mode bits (and owner/group
    // where possible) so editing a `0600` secret doesn't downgrade
    // it to `0644` via the process umask, and an executable file
    // doesn't lose its `+x` bit. Snapshot before write — if the
    // target doesn't exist yet, fall through to umask defaults
    // (which is correct for a new file).
    let preserveMode: { mode: number; uid: number; gid: number } | undefined;
    try {
      const targetStat = await fs.stat(realTarget);
      preserveMode = {
        mode: targetStat.mode & 0o7777,
        uid: targetStat.uid,
        gid: targetStat.gid,
      };
    } catch (err) {
      const code =
        err && typeof err === 'object' && 'code' in err
          ? (err as { code?: unknown }).code
          : undefined;
      if (code !== 'ENOENT') throw err;
      // New file — accept umask defaults.
    }
    try {
      // Blehd: pass `mode` to `writeFile` so the temp file is
      // CREATED with the preserved mode (atomically, via the
      // syscall's open(O_CREAT, mode)). The previous "create with
      // umask defaults → chmod after" had a window where a `0600`
      // secret-edit existed at `0644` on disk before chmod ran,
      // briefly readable by anyone with directory access. Passing
      // `mode` shrinks that window to "doesn't exist". On Windows
      // the mode bits are mostly ignored by the OS; that's fine
      // since the platform has no equivalent threat model here.
      await fs.writeFile(tmp, params.content, {
        encoding: 'utf8',
        flag: 'wx',
        mode: preserveMode?.mode ?? 0o600,
      });
      if (preserveMode) {
        // `writeFile`'s `mode` option is `mode & ~umask` on POSIX,
        // so a tight umask (e.g. operator's shell `umask 077` for
        // 0o600 default) could still drop bits we wanted preserved.
        // Belt-and-suspenders chmod brings the file to EXACTLY the
        // target's preserved mode regardless of umask interference.
        await fs.chmod(tmp, preserveMode.mode).catch(() => {
          /* chmod failed (Windows / fs without permission bits) */
        });
        // chown is owner-restricted on POSIX; non-root daemons hit
        // EPERM here. Silent ignore — preserving mode is the
        // first-order goal, ownership is a stretch goal.
        await fs.chown(tmp, preserveMode.uid, preserveMode.gid).catch(() => {
          /* expected EPERM for non-root operators */
        });
      }
      await fs.rename(tmp, realTarget);
    } catch (err) {
      // Best-effort cleanup if the write succeeded but rename failed
      // (e.g. permission change between calls). Swallow cleanup
      // errors — the original failure is the meaningful one.
      await fs.unlink(tmp).catch(() => {});
      throw err;
    }
    return {};
  }

  async readTextFile(
    params: ReadTextFileRequest,
  ): Promise<ReadTextFileResponse> {
    // Reject obviously-degenerate `limit` up front. Without this,
    // `sliceLineRange` hits the `end < start` path and returns an
    // unexpectedly-larger slice (or empty depending on internals).
    // ACP doesn't define semantics for limit ≤ 0, so treat as "no
    // bytes wanted".
    if (typeof params.limit === 'number' && params.limit <= 0) {
      return { content: '' };
    }
    // BSA0E: cap the file size we'll buffer into RSS at 100 MiB so a
    // request like `{ line: 1, limit: 10 }` against a 500 MB log
    // doesn't cost the daemon 500 MB of memory just to return 10
    // lines. Stage 2's in-process refactor will replace this proxy
    // with a streaming readline implementation that stops at the
    // requested range; until then the cap is the cheapest defense.
    //
    // BX8YO: also reject non-regular files. Character devices, named
    // pipes (FIFOs), procfs / sysfs entries, sockets etc. can report
    // `stats.size === 0` while producing unbounded data on read, so
    // a size-only cap doesn't protect against `/dev/zero` /
    // `/dev/urandom` / `/proc/kcore`-style inputs. ACP's contract
    // for `readTextFile` is "regular file"; everything else is an
    // operator-supplied path mistake or an adversarial-prompt
    // attempt and should fail loud.
    const READ_FILE_SIZE_CAP = 100 * 1024 * 1024;
    const stats = await fs.stat(params.path);
    if (!stats.isFile()) {
      throw new Error(
        `readTextFile: ${params.path} is not a regular file ` +
          `(reported as ${describeStatKind(stats)}). ` +
          `Pipe / device / proc-like inputs can produce unbounded data ` +
          `and aren't supported by the bridge fs proxy.`,
      );
    }
    if (stats.size > READ_FILE_SIZE_CAP) {
      throw new Error(
        `readTextFile: ${params.path} is ${stats.size} bytes, ` +
          `exceeds the ${READ_FILE_SIZE_CAP}-byte daemon cap. ` +
          `Tail/grep externally and feed the relevant slice instead.`,
      );
    }
    const content = await fs.readFile(params.path, 'utf8');
    if (typeof params.line === 'number' || typeof params.limit === 'number') {
      // ACP `ReadTextFileRequest.line` is 1-based per spec — clients passing
      // `{ line: 1, limit: 2 }` mean "the first two lines", not "skip the
      // first then take two". Convert to a 0-based slice index, clamping
      // values < 1 to 0 to be tolerant of unusual inputs.
      const startLine = params.line ?? 1;
      const start = startLine > 0 ? startLine - 1 : 0;
      const end = params.limit != null ? start + params.limit : undefined;
      // Avoid `content.split('\n')` — allocating a per-line String[] for
      // a 100 MB file roughly doubles the memory footprint just to
      // extract a few lines. Manual scan walks `indexOf('\n', …)` only
      // until the end-of-range boundary is found, then slices a single
      // range of the original string. Stage 2 in-process replaces this
      // proxy entirely (the bridge stops reading user fs).
      return { content: sliceLineRange(content, start, end) };
    }
    return { content };
  }
}

const DEFAULT_INIT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_SESSIONS = 20;
/**
 * Soft upper bound on `BridgeOptions.eventRingSize` to catch operator
 * typos before they OOM the daemon. At ~500 B per `BridgeEvent` an
 * 1 000 000-frame ring already pins ~500 MB per session — well past
 * any realistic workload. Not a security boundary (the flag is
 * operator-controlled), just typo defense.
 */
const MAX_EVENT_RING_SIZE = 1_000_000;
// Bd1yh: per-permission-request wall clock. Without this, an agent
// calling `requestPermission` while no SSE subscriber is connected
// would hang the per-session FIFO promptQueue forever (the prompt
// can't complete, every subsequent prompt is blocked behind it).
// 5 minutes is generous for "human reads UI, decides, clicks
// approve" while still bounded enough to recover from a wedged
// state. Configurable via `BridgeOptions.permissionResponseTimeoutMs`.
const DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;
// Bd1z5: per-session cap on pending permissions in flight. A chatty
// agent making rapid `requestPermission` calls would otherwise grow
// `pendingPermissions` unboundedly — each entry is a UUID + closure
// + bus event. 64 mirrors `DEFAULT_MAX_SUBSCRIBERS` (one pending
// per subscriber feels like a reasonable headroom). Excess requests
// resolve as cancelled and emit a stderr warning so operators see
// the limit being hit. Configurable via
// `BridgeOptions.maxPendingPermissionsPerSession`.
const DEFAULT_MAX_PENDING_PER_SESSION = 64;

export function createHttpAcpBridge(opts: BridgeOptions): HttpAcpBridge {
  const defaultSessionScope = opts.sessionScope ?? 'single';
  // `undefined` → default 20 (intentionally tight per #3803 N≈50 cliff).
  // `0` → explicitly unlimited (operator opt-out).
  // `Infinity` → unlimited (programmatic opt-out — accepted as a
  //              long-standing alias since the cap check is `>= max`).
  // `NaN` / negative → throw. A typo / parse error in CLI/config
  //                    silently disabling the daemon's only resource
  //                    guard is fail-OPEN behavior; gpt-5.5 flagged
  //                    this as critical (BRApy) — we'd rather fail
  //                    boot than serve unbounded.
  let maxSessions: number;
  if (opts.maxSessions === undefined) {
    maxSessions = DEFAULT_MAX_SESSIONS;
  } else if (Number.isNaN(opts.maxSessions)) {
    throw new TypeError(
      `Invalid maxSessions: NaN. Must be a number >= 0 ` +
        `(0 / Infinity = unlimited).`,
    );
  } else if (opts.maxSessions < 0) {
    throw new TypeError(
      `Invalid maxSessions: ${opts.maxSessions}. Must be >= 0 ` +
        `(0 / Infinity = unlimited).`,
    );
  } else if (opts.maxSessions === 0 || opts.maxSessions === Infinity) {
    maxSessions = Infinity;
  } else {
    maxSessions = opts.maxSessions;
  }
  if (defaultSessionScope !== 'single' && defaultSessionScope !== 'thread') {
    throw new TypeError(
      `Invalid sessionScope: ${JSON.stringify(defaultSessionScope)}. ` +
        `Expected 'single' or 'thread'.`,
    );
  }
  // `eventRingSize` follows the same fail-CLOSED posture as
  // `maxSessions`: silently disabling SSE backpressure on a config
  // typo is worse than failing to start. Unlike `maxSessions` there
  // is NO unlimited sentinel — an unbounded ring would grow forever.
  // Soft upper bound MAX_EVENT_RING_SIZE catches operator typos
  // (`--event-ring-size 80000000` instead of `8000000`); at 1M
  // frames × ~500 B/frame the per-session ceiling is already
  // ~500 MB, well past any legitimate use.
  const eventRingSize = opts.eventRingSize ?? DEFAULT_RING_SIZE;
  // `Number.isInteger` already rejects NaN / Infinity / non-finite
  // — no separate `Number.isFinite` guard needed.
  if (
    !Number.isInteger(eventRingSize) ||
    eventRingSize < 1 ||
    eventRingSize > MAX_EVENT_RING_SIZE
  ) {
    throw new TypeError(
      `Invalid eventRingSize: ${opts.eventRingSize}. ` +
        `Must be a positive integer in [1, ${MAX_EVENT_RING_SIZE}].`,
    );
  }
  const channelFactory = opts.channelFactory ?? defaultSpawnChannelFactory;
  const initTimeoutMs = opts.initializeTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
  if (initTimeoutMs <= 0) {
    throw new TypeError(
      `Invalid initializeTimeoutMs: ${initTimeoutMs}. Must be > 0.`,
    );
  }
  // Bd1yh + Bd1z5: per-permission deadline + per-session pending cap.
  // 0 / Infinity / non-finite (NaN, -1) all disable — same sentinel
  // convention as maxSessions / maxConnections.
  const permissionTimeoutRaw =
    opts.permissionResponseTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
  const permissionTimeoutMs =
    permissionTimeoutRaw > 0 && Number.isFinite(permissionTimeoutRaw)
      ? permissionTimeoutRaw
      : 0; // 0 = disabled
  const maxPendingRaw =
    opts.maxPendingPermissionsPerSession ?? DEFAULT_MAX_PENDING_PER_SESSION;
  const maxPendingPerSession =
    maxPendingRaw > 0 && Number.isFinite(maxPendingRaw)
      ? maxPendingRaw
      : Infinity;
  // #3803 §02: the bound path is the canonical form `spawnOrAttach`
  // compares incoming `workspaceCwd` against. The caller MUST pass an
  // already-canonical value (via `canonicalizeWorkspace`). `runQwenServe`
  // does this at boot and threads the same value into both
  // `createHttpAcpBridge` and `createServeApp` (via
  // `deps.boundWorkspace`); direct embeds / tests that construct the
  // bridge themselves must call `canonicalizeWorkspace` first.
  //
  // Pre-fix the bridge re-canonicalized defensively here. The fix
  // (deepseek-v4-pro review) drops the redundant `realpathSync.native`:
  // (a) on case-insensitive / symlinked filesystems two independent
  // `realpathSync.native` calls could theoretically disagree if the FS
  // mutates between them (NFS transient, operator rename), landing
  // the bridge with one canonical form while `runQwenServe` advertises
  // another and `/capabilities` clients see `workspace_mismatch` on
  // every POST; (b) it's a syscall removed from the boot path. The
  // `path.isAbsolute` guard stays — it's a structural input check, not
  // a syscall.
  if (!path.isAbsolute(opts.boundWorkspace)) {
    throw new TypeError(
      `Invalid boundWorkspace: "${opts.boundWorkspace}". Must be an ` +
        `absolute path.`,
    );
  }
  const boundWorkspace = opts.boundWorkspace;

  // #3803 §02 single-workspace model: the bridge hosts AT MOST one
  // ATTACH-AVAILABLE channel and one default attach-target entry.
  // Multi-session multiplexing happens through `channelInfo.sessionIds`;
  // the `defaultEntry` slot is the FIRST session created (the one a
  // same-workspace attach under `single` scope reuses). Thread-scope
  // sessions add to `byId` but don't displace `defaultEntry`.
  let defaultEntry: SessionEntry | undefined;
  // `channelInfo` is the SINGLE attach-available channel. Cleared
  // ONLY by the `channel.exited` handler (see below) when the OS
  // reaps the underlying child process. Teardown initiators
  // (`killSession` last-session-leaving, `doSpawn`-newSession-failure
  // on an empty channel, `ensureChannel` init-failure /
  // late-shutdown, `shutdown`) set `isDying = true` but LEAVE
  // `channelInfo` pointing at the dying channel until OS reap — that
  // asymmetry IS the BkUyD invariant. It lets `killAllSync` reach a
  // mid-SIGTERM-grace channel through `aliveChannels` while a
  // concurrent `spawnOrAttach` can already start spawning a fresh
  // replacement (which overwrites `channelInfo` when its
  // handshake completes). Race-aware code paths (`ensureChannel`,
  // `killAllSync`) gate on `isDying` rather than presence; see
  // `ChannelInfo.isDying` for the per-set-site rationale.
  let channelInfo: ChannelInfo | undefined;
  // tanzhenxin BkUyD: superset of `channelInfo` covering channels
  // that are dying but not yet OS-reaped. `killSession` /
  // `doSpawn`-newSession-failure / `shutdown` mark a channel as
  // `isDying` and start its async kill; meanwhile a concurrent
  // `spawnOrAttach` can spawn a FRESH channel and reassign
  // `channelInfo`. Without this set, the dying channel becomes
  // unreachable — a double-Ctrl+C arriving mid-grace would call
  // `killAllSync()`, find only the fresh channel in `channelInfo`,
  // force-kill it, and `process.exit(1)` would orphan the dying one
  // whose SIGTERM hadn't yet completed. The set is the OS-level
  // "still alive" source of truth: entries are added when a channel
  // is created and removed when its `channel.exited` resolves.
  // `killAllSync` iterates THIS set to fire SIGKILL on every alive
  // child regardless of whether it's still the attach target.
  const aliveChannels = new Set<ChannelInfo>();
  // Coalesces a concurrent second `ensureChannel()` call onto the
  // first one's spawn so we never create two children for the same
  // daemon. Cleared in the `finally` of the creator.
  let inFlightChannelSpawn: Promise<ChannelInfo> | undefined;
  const byId = new Map<string, SessionEntry>();
  // Daemon-wide pending permission table; requestIds are UUIDs so collisions
  // across sessions are infeasible in practice.
  const pendingPermissions = new Map<string, PendingPermission>();
  const resolvedPermissions = new Map<string, PermissionResolutionRecord>();
  const resolvedPermissionOrder: string[] = [];
  // Set by `shutdown()` so any in-flight `spawnOrAttach` that was
  // dispatched on an existing connection AFTER the shutdown snapshot
  // taken in `shutdown()` fails fast instead of creating a child the
  // shutdown path has no more visibility into. Without this, the
  // server.listen → bridge.shutdown ordering in `runQwenServe` leaves
  // a window between (a) shutdown snapshotting `byId` for kills and
  // (b) `server.close` rejecting new connections, during which a
  // late-arriving `POST /session` slips a fresh child past cleanup.
  let shuttingDown = false;
  // Coalesces concurrent `spawnOrAttach` calls under single-scope and
  // tracks in-progress thread-scope spawns for shutdown to await.
  // Single-scope uses the workspaceKey as the dedup key (at most one
  // entry; concurrent callers pass the `defaultEntry` check together
  // and coalesce here). Thread-scope uses `workspaceKey#uuid` so
  // simultaneous calls don't collide while still being awaitable from
  // `shutdown()`.
  const inFlightSpawns = new Map<string, Promise<BridgeSession>>();

  interface InFlightRestore {
    action: 'load' | 'resume';
    promise: Promise<BridgeRestoredSession>;
    /**
     * Synchronous reservation slot for callers that coalesce onto this
     * restore. Coalescers do `count++` BEFORE awaiting `promise` so the
     * spawn-owner's disconnect-reaper (`killSession({ requireZeroAttaches:
     * true })`) sees a non-zero `attachCount` on the freshly registered
     * entry and skips the kill. The IIFE folds this counter into
     * `entry.attachCount` when it calls `createSessionEntry`. BQ9tV
     * race-guard equivalent for coalesced restore waiters.
     */
    coalesceState: { count: number };
  }

  // Coalesces concurrent explicit restore calls for the same session id.
  // `session/load` replays history through SSE and `session/resume` restores
  // context; running either twice for the same id at the same time can
  // duplicate history frames or race two entries into `byId`.
  const inFlightRestores = new Map<string, InFlightRestore>();
  // `session/load` emits history replay as session_update notifications before
  // the ACP request returns. Keep a temporary bus so those replay frames land in
  // the ring, then promote the same bus into the registered SessionEntry.
  const pendingRestoreEvents = new Map<string, EventBus>();

  const createClientId = (): string => `client_${randomUUID()}`;

  const registerClient = (
    entry: SessionEntry,
    requestedClientId?: string,
  ): string => {
    if (requestedClientId && entry.clientIds.has(requestedClientId)) {
      entry.clientIds.set(
        requestedClientId,
        (entry.clientIds.get(requestedClientId) ?? 0) + 1,
      );
      return requestedClientId;
    }
    const clientId = createClientId();
    entry.clientIds.set(clientId, 1);
    return clientId;
  };

  const unregisterClient = (entry: SessionEntry, clientId?: string): void => {
    if (clientId === undefined) return;
    const count = entry.clientIds.get(clientId);
    if (count === undefined) return;
    if (count <= 1) {
      entry.clientIds.delete(clientId);
      // Drop the last-seen entry alongside the registration ref.
      // Otherwise a long-lived daemon servicing a churn of disconnect/
      // reconnect clients (each picking a fresh `clientId`) would
      // accumulate stale heartbeat timestamps for clients that no
      // longer exist — the very leak revocation policy (PR 24) is
      // meant to plug.
      entry.clientLastSeenAt.delete(clientId);
    } else {
      entry.clientIds.set(clientId, count - 1);
    }
  };

  const resolveTrustedClientId = (
    entry: SessionEntry,
    clientId?: string,
  ): string | undefined => {
    if (clientId === undefined) return undefined;
    if (!entry.clientIds.has(clientId)) {
      throw new InvalidClientIdError(entry.sessionId, clientId);
    }
    return clientId;
  };

  const resolveAnyTrustedClientId = (clientId: string): string => {
    for (const entry of byId.values()) {
      if (entry.clientIds.has(clientId)) return clientId;
    }
    throw new InvalidClientIdError('unknown', clientId);
  };

  const registerPending = (p: PendingPermission) => {
    const entry = byId.get(p.sessionId);
    if (!entry) {
      // The session was torn down (channel.exited, killSession, shutdown)
      // between when the agent decided to ask for permission and when the
      // request reached this function. There's no SessionEntry to chain
      // the requestId onto and no SSE bus to publish `permission_request`
      // — nobody can vote, so the permission would hang the agent's
      // `requestPermission` forever. Resolve immediately as cancelled to
      // unwind the agent side; matches the shutdown / killSession path.
      p.resolve({ outcome: { outcome: 'cancelled' } });
      return;
    }
    pendingPermissions.set(p.requestId, p);
    entry.pendingPermissionIds.add(p.requestId);
  };

  const rememberResolvedPermission = (record: PermissionResolutionRecord) => {
    if (!resolvedPermissions.has(record.requestId)) {
      resolvedPermissionOrder.push(record.requestId);
    }
    resolvedPermissions.set(record.requestId, record);
    while (resolvedPermissionOrder.length > MAX_RESOLVED_PERMISSION_RECORDS) {
      const oldest = resolvedPermissionOrder.shift();
      if (oldest !== undefined) resolvedPermissions.delete(oldest);
    }
  };

  const publishPermissionAlreadyResolved = (
    record: PermissionResolutionRecord,
  ) => {
    const entry = byId.get(record.sessionId);
    if (!entry) return;
    try {
      writeServeDebugLine(
        `permission ${JSON.stringify(record.requestId)} ` +
          `for session ${JSON.stringify(record.sessionId)} was already ` +
          'resolved; publishing duplicate-vote notification.',
      );
      entry.events.publish({
        type: 'permission_already_resolved',
        data: {
          requestId: record.requestId,
          sessionId: record.sessionId,
          outcome: record.outcome,
        },
      });
    } catch {
      writeServeDebugLine(
        `skipped duplicate-vote notification for permission ` +
          `${JSON.stringify(record.requestId)} during shutdown.`,
      );
    }
  };

  /** Resolve a single pending request and clean up its bookkeeping. */
  const resolvePending = (
    requestId: string,
    response: RequestPermissionResponse,
    originatorClientId?: string,
  ): boolean => {
    const pending = pendingPermissions.get(requestId);
    if (!pending) return false;
    pendingPermissions.delete(requestId);
    const entry = byId.get(pending.sessionId);
    if (entry) {
      entry.pendingPermissionIds.delete(requestId);
      // Fan-out a follow-up event so other clients update their UI when the
      // race is decided. Best-effort — failure to publish (e.g. bus closed
      // mid-shutdown) doesn't block resolution.
      try {
        entry.events.publish({
          type: 'permission_resolved',
          data: { requestId, outcome: response.outcome },
          ...(originatorClientId ? { originatorClientId } : {}),
        });
      } catch {
        /* bus closed during shutdown */
      }
    }
    rememberResolvedPermission({
      requestId,
      sessionId: pending.sessionId,
      outcome: response.outcome,
    });
    pending.resolve(response);
    return true;
  };

  /**
   * Get-or-create the daemon's single `qwen --acp` channel (#3803 §02).
   * N sessions multiplex onto it via `connection.newSession()`.
   * Concurrent callers coalesce through `inFlightChannelSpawn` so we
   * never spawn two children. The returned `ChannelInfo` is shared —
   * the caller adds their session id to `sessionIds` and uses
   * `info.connection.newSession()`.
   *
   * Wires up the one-and-only `channel.exited` cleanup on first
   * creation so the late-arriving event tears down ALL multiplexed
   * sessions.
   */
  async function ensureChannel(): Promise<ChannelInfo> {
    // Skip a channel that's marked dying — its underlying transport is
    // mid-SIGTERM-or-already-dead and `connection.newSession()` on it
    // would either hang or land the caller with a sessionId that
    // immediately 404s on every follow-up.
    if (channelInfo && !channelInfo.isDying) return channelInfo;
    if (inFlightChannelSpawn) return await inFlightChannelSpawn;

    const promise = (async () => {
      const channel = await channelFactory(boundWorkspace);
      const client = new BridgeClient(
        // BfFut: ACP today carries a sessionId on every per-session
        // notification / request, so the no-sessionId branch is
        // technically unreachable. But the channel is multi-session
        // (Stage 1.5 multiplex), so if ACP ever grows a no-sessionId
        // call we'd silently drop it on a multi-session channel
        // instead of throwing. Surface that ambiguity loudly.
        (sessionId) => {
          if (sessionId) return byId.get(sessionId);
          if (channelInfo && channelInfo.sessionIds.size > 1) {
            throw new Error(
              'BridgeClient: ACP call without sessionId on a ' +
                'multi-session channel cannot be routed — workspace=' +
                boundWorkspace,
            );
          }
          return undefined;
        },
        (sessionId) =>
          sessionId ? pendingRestoreEvents.get(sessionId) : undefined,
        registerPending,
        (rid) =>
          // Roll back a register-then-publish-failed pending so the agent
          // doesn't hang waiting on a vote nobody can see.
          resolvePending(rid, { outcome: { outcome: 'cancelled' } }),
        permissionTimeoutMs,
        maxPendingPerSession,
      );
      const connection = new ClientSideConnection(() => client, channel.stream);

      // Add to `aliveChannels` + register the `channel.exited` handler
      // BEFORE the `initialize` handshake (tanzhenxin cold-spawn-window
      // finding): the agent child exists from the moment
      // `channelFactory(boundWorkspace)` returns, so a `killAllSync()`
      // during the handshake window (up to `initTimeoutMs`, default
      // 10s) must find it to avoid orphaning on `process.exit(1)`.
      // Init-failure / child-crash / late-shutdown all converge on
      // the same cleanup path via the handler below.
      // `channelInfo` (the attach target) is assigned only AFTER
      // initialize succeeds so callers don't attach to a still-
      // handshaking channel.
      const info: ChannelInfo = {
        channel,
        connection,
        client,
        sessionIds: new Set(),
        pendingRestoreIds: new Set(),
        isDying: false,
      };
      aliveChannels.add(info);
      // Belt-and-suspenders leak detection. The set is intentionally
      // multi-entry to cover the `killSession`-then-`spawnOrAttach`
      // overlap window (size 2 is legitimate: one dying + one fresh
      // attach-target). Anything higher implies a `channel.exited`
      // handler never fired for some prior channel — a real leak we'd
      // otherwise notice only as gradually-growing RSS over hours.
      // The warning surfaces it the moment it happens. Threshold is
      // 2 because that's the design ceiling; bumping it requires
      // updating both this guard and the comments around
      // `aliveChannels` declaration.
      if (aliveChannels.size > 2) {
        writeStderrLine(
          `qwen serve: WARNING aliveChannels.size=${aliveChannels.size} ` +
            `(expected 1, max 2 during killSession-then-spawnOrAttach ` +
            `overlap) — possible channel leak; check that prior channels' ` +
            `channel.exited fired and the handler ran cleanup.`,
        );
      }

      // One-time channel.exited cleanup. The child dying takes ALL
      // multiplexed sessions with it — iterate `sessionIds` (snapshot
      // first to be safe against concurrent killSession during
      // iteration), publish `session_died` on each session's bus,
      // remove from byId / defaultEntry / pending tables.
      //
      // Registered BEFORE the `initialize` await (tanzhenxin
      // cold-spawn-window fix above) so init-failure / child-crash /
      // late-shutdown all converge here. During handshake
      // `sessionIds` is empty — the loop below no-ops, the stderr
      // line still fires to tell operators "agent process gone
      // during init", and `aliveChannels.delete(info)` clears the
      // entry through the normal exit path.
      //
      // tanzhenxin BkUyD: drop from `aliveChannels` ONLY when the OS
      // process is actually gone. Async kill paths (`killSession`
      // reap, `shutdown()` await, `doSpawn`'s newSession-failure
      // tear-down) mark `isDying = true` but leave the entry in
      // `aliveChannels` until this handler fires, so the double-Ctrl+C
      // `killAllSync` force-kill path still has a reference to fire
      // SIGKILL against during the SIGTERM grace window — even if a
      // concurrent `spawnOrAttach` has already reassigned
      // `channelInfo` to a fresh channel.
      void channel.exited.then((exitInfo) => {
        aliveChannels.delete(info);
        if (channelInfo === info) channelInfo = undefined;
        const sessions = Array.from(info.sessionIds);
        info.sessionIds.clear();
        // Operator breadcrumb for UNEXPECTED channel exits. Without
        // this an agent crash (OOM / segfault) is invisible from the
        // daemon log: each affected SSE subscriber sees a
        // `session_died` frame and disconnects, the daemon's
        // child-stderr forwarder emits whatever the child wrote before
        // dying (often nothing on a SIGKILL / segfault), and operators
        // can't tell from `qwen serve`'s own output that the agent
        // process is gone.
        //
        // Suppressed during `shuttingDown` because the operator
        // already saw "received SIGINT, draining..." from
        // `runQwenServe`'s signal handler. The standalone
        // killSession case (last session leaves, channel torn down
        // but daemon stays up) still logs — there's no upstream
        // context line in that flow, and the message confirms the
        // cleanup actually ran.
        if (!shuttingDown) {
          writeStderrLine(
            `qwen serve: channel exited (code=${exitInfo?.exitCode ?? 'none'}, signal=${exitInfo?.signalCode ?? 'none'}, ${sessions.length} session(s) torn down)`,
          );
        }
        for (const sid of sessions) {
          const sessEntry = byId.get(sid);
          if (!sessEntry) continue;
          cancelPendingForSession(sid);
          try {
            sessEntry.events.publish({
              type: 'session_died',
              data: {
                sessionId: sid,
                reason: 'channel_closed',
                // BX9_P: thread exitCode/signalCode through.
                exitCode: exitInfo?.exitCode ?? null,
                signalCode: exitInfo?.signalCode ?? null,
              },
            });
          } catch {
            /* bus already closed */
          }
          byId.delete(sid);
          if (defaultEntry === sessEntry) defaultEntry = undefined;
          sessEntry.events.close();
        }
      });

      // Initialize handshake. The channel is already in
      // `aliveChannels` and the `channel.exited` handler above is
      // registered, so failure paths (init throw, timeout, late
      // shutdown) only need to mark dying + kill — the handler does
      // the alive-set cleanup when the OS reaps the child.
      try {
        await withTimeout(
          connection.initialize({
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {
              fs: { readTextFile: true, writeTextFile: true },
            },
            clientInfo: { name: 'qwen-serve-bridge', version: '0' },
          }),
          initTimeoutMs,
          'initialize',
        );
      } catch (err) {
        // Mark the half-initialized channel as dying/unavailable, then
        // kill it. Coalesced callers (`inFlightChannelSpawn` branch in
        // `ensureChannel`) observe the same rejection on this promise
        // and propagate it to their callers; the `inFlightSpawns`
        // tracker is cleared in `spawnOrAttach`'s finally so a follow-
        // up call retries cleanly. The `channel.exited` handler
        // registered earlier removes `info` from `aliveChannels` once
        // the OS reaps the child. `isDying` here is the cross-path
        // invariant marker (matches `killSession` / `doSpawn`-
        // newSession-failure / `shutdown`): "any channel in
        // `aliveChannels` with `isDying === true` is mid-teardown."
        info.isDying = true;
        await channel.kill().catch(() => {});
        throw err;
      }

      // Late-shutdown re-check: if shutdown flipped during the
      // handshake, tear this channel down rather than leak past
      // `process.exit(0)`. Same cleanup pattern as the init-failure
      // path: mark dying + kill, let the exited handler reap.
      if (shuttingDown) {
        info.isDying = true;
        await channel.kill().catch(() => {});
        throw new Error('HttpAcpBridge is shutting down');
      }

      // Handshake succeeded — now publish the channel as the
      // attach-available slot. `channelInfo` is assigned LAST so
      // `ensureChannel`'s fast-path (`if (channelInfo && !.isDying)`)
      // never returns a still-handshaking channel to a concurrent
      // caller.
      channelInfo = info;
      return info;
    })();

    inFlightChannelSpawn = promise;
    try {
      return await promise;
    } finally {
      inFlightChannelSpawn = undefined;
    }
  }

  async function doSpawn(
    modelServiceId: string | undefined,
    effectiveScope: 'single' | 'thread',
    requestedClientId?: string,
  ): Promise<BridgeSession> {
    // #3803 §02: get-or-create the daemon's single channel, then call
    // `connection.newSession()` on it. Sessions share the child's
    // process / OAuth / file-cache / hierarchy-memory parse via the
    // agent's `sessions: Map<string, Session>` (see
    // `acp-integration/acpAgent.ts:194`).
    //
    // newSession on an established channel can fail (auth, config,
    // etc.) without the channel dying. We DON'T kill the channel on
    // newSession failure when OTHER sessions are still using it —
    // they'd lose their work for a problem orthogonal to them.
    //
    // BkwQA: when the failed newSession was the channel's ONLY
    // attempt (sessionIds.size === 0), the empty channel must NOT
    // linger — it would stay set as `channelInfo` invisible to
    // `sessionCount` / `maxSessions` (both backed by `byId`), and
    // repeated failing creates would still find this channel via
    // `ensureChannel`, never spawning a fresh one. Tear down the
    // empty channel so the next attempt gets a clean spawn.
    const ci = await ensureChannel();
    let newSessionResp: { sessionId: string };
    try {
      newSessionResp = await withTimeout(
        ci.connection.newSession({
          cwd: boundWorkspace,
          mcpServers: [],
        }),
        initTimeoutMs,
        'newSession',
      );
    } catch (err) {
      // Only reap when this newSession was the channel's first/only
      // attempt — a populated channel keeps running for its other
      // live sessions.
      if (ci.sessionIds.size === 0) {
        // Mark dying SYNCHRONOUSLY so a concurrent `spawnOrAttach`
        // calling `ensureChannel()` between this point and the
        // `channel.exited` cleanup spawns a fresh channel instead of
        // attaching to the one we're about to tear down. `channelInfo`
        // stays set until OS reap so `killAllSync` mid-SIGTERM still
        // finds a target (tanzhenxin BkUyD invariant).
        ci.isDying = true;
        await ci.channel.kill().catch(() => {
          /* best-effort — channel.exited handler still runs */
        });
      }
      throw err;
    }

    // Late-shutdown re-check (BUy4U): shutdown() may have flipped
    // while we were in `connection.newSession` (~1s on cold start).
    if (shuttingDown) {
      // Don't kill the channel — see comment above. Just throw.
      throw new Error('HttpAcpBridge is shutting down');
    }

    const entry = createSessionEntry(
      ci,
      newSessionResp.sessionId,
      boundWorkspace,
    );
    const clientId = registerClient(entry, requestedClientId);
    // `defaultEntry` is the single-scope attach target — only sessions
    // SPAWNED UNDER `'single'` may claim it. A thread-scope spawn must
    // never become the attach target, otherwise a later omitted-scope
    // (or daemon-default-`single`) caller would attach with
    // `attached: true` to what its sender promised was an isolated
    // session — see #4175 PR 5 (mixed-scope leak found in review).
    // Subsequent same-scope spawns also don't overwrite (first wins).
    if (effectiveScope === 'single' && !defaultEntry) defaultEntry = entry;

    // ACP `newSession` doesn't take a model id; honor the caller's
    // `modelServiceId` via `unstable_setSessionModel`. See
    // `applyModelServiceId` for rationale (race against
    // transportClosedReject, publish model_switched on success,
    // model_switch_failed on failure, don't tear down the session).
    if (modelServiceId) {
      await applyModelServiceId(
        entry,
        modelServiceId,
        initTimeoutMs,
        clientId,
      ).catch(() => {
        // Already published `model_switch_failed`; session stays
        // operational on the agent's default model.
      });
    }

    // Bd1zc: re-check that the entry is still live before returning.
    // The model-switch call yields and races against
    // `channel.exited` — if the child crashed during the model
    // switch, the exited handler already removed the entry from
    // byId. Without this check, the caller would get HTTP 200 with
    // a sessionId that already 404s on every subsequent request.
    if (!byId.has(entry.sessionId)) {
      throw new Error(
        `Session ${entry.sessionId} died during model-switch ` +
          `initialization`,
      );
    }

    return {
      sessionId: entry.sessionId,
      workspaceCwd: entry.workspaceCwd,
      attached: false,
      clientId,
      createdAt: entry.createdAt,
    };
  }

  /**
   * Send `unstable_setSessionModel` and broadcast a `model_switched`
   * event. Used at create-session time (via doSpawn) AND on attach when
   * the caller passes a modelServiceId — the existing session may be
   * running a different model.
   *
   * Serialized through `entry.modelChangeQueue` so two concurrent
   * attach-with-different-model requests can't race into the agent.
   * On failure, publishes a `model_switch_failed` event for cross-client
   * observability and re-throws so the HTTP caller sees the error
   * (session keeps running its previous model — that's the safer
   * default than tearing down a shared session because one client
   * asked for an unknown model).
   */
  async function applyModelServiceId(
    entry: SessionEntry,
    modelId: string,
    timeoutMs: number,
    originatorClientId?: string,
  ): Promise<void> {
    const conn = entry.connection as unknown as {
      unstable_setSessionModel(p: {
        sessionId: string;
        modelId: string;
      }): Promise<unknown>;
    };
    // Race against `transportClosedReject` so a child crash during
    // model switch fails the call immediately instead of waiting the
    // full `timeoutMs`. Matches what `sendPrompt` and `setSessionModel`
    // already do — without this, a callback-attach with a broken model
    // wedges the HTTP handler for 10s.
    const transportClosed = getTransportClosedReject(entry);
    const work = entry.modelChangeQueue.then(async () => {
      try {
        await Promise.race([
          withTimeout(
            conn.unstable_setSessionModel({
              sessionId: entry.sessionId,
              modelId,
            }),
            timeoutMs,
            'setSessionModel',
          ),
          transportClosed,
        ]);
        entry.events.publish({
          type: 'model_switched',
          data: { sessionId: entry.sessionId, modelId },
          ...(originatorClientId ? { originatorClientId } : {}),
        });
      } catch (err) {
        // Surface the failure to ALL attached clients, not just the
        // caller — a shared session swallowing a denied model change
        // silently would surprise the others.
        entry.events.publish({
          type: 'model_switch_failed',
          data: {
            sessionId: entry.sessionId,
            requestedModelId: modelId,
            error: err instanceof Error ? err.message : String(err),
          },
          ...(originatorClientId ? { originatorClientId } : {}),
        });
        throw err;
      }
    });
    // Tail swallows failures so subsequent model changes still run; the
    // original caller still observes the rejection on `work`.
    entry.modelChangeQueue = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }

  /**
   * Resolve every pending request belonging to one session as cancelled.
   *
   * **Scope contract (per ACP spec / live-collab default):**
   * Permissions are issued by the agent inline DURING an active
   * prompt — `requestPermission` returns a Promise the agent awaits
   * before continuing. Per the bridge's per-session FIFO + ACP's
   * "one active prompt per session" guarantee, ALL outstanding
   * permissions at any moment belong to the **currently active
   * prompt**. So "cancel all pending permissions for this session"
   * is equivalent to "cancel the active prompt's permissions" — and
   * that's exactly what ACP requires when a prompt is cancelled
   * ("cancelling a prompt MUST resolve outstanding requestPermission
   * calls with outcome.cancelled").
   *
   * **Multi-client live-collab caveat:** under `sessionScope: 'single'`
   * Client B may have been about to vote on A's pending permission
   * via SSE — when A disconnects mid-prompt, B's vote (if it arrives
   * after the abort) gets `404`. This is the right behavior: A's
   * prompt is being cancelled, so the permission belongs to a turn
   * that no longer matters. From B's side they see
   * `permission_resolved` with `outcome: cancelled` on the SSE
   * stream, then the prompt's `cancelled` stop reason. Voting on a
   * cancelled-prompt's permission was never going to drive the
   * agent forward anyway.
   */
  const cancelPendingForSession = (sessionId: string) => {
    const entry = byId.get(sessionId);
    if (!entry) return;
    // Snapshot ids — resolvePending mutates the underlying set.
    const ids = Array.from(entry.pendingPermissionIds);
    for (const id of ids) {
      resolvePending(id, { outcome: { outcome: 'cancelled' } });
    }
  };

  /**
   * Lazy-init the per-session `transportClosedReject` promise that
   * `sendPrompt` / `setSessionModel` / `applyModelServiceId` race their
   * ACP calls against. ONE listener is attached to `channel.exited`
   * over the session's lifetime (the first caller "wins" and creates
   * the promise; subsequent callers reuse it) — a per-call attach
   * would grow Node's listener list linearly with prompt count on
   * chatty sessions. The rejection message names the FIRST caller,
   * which can be misleading if a later method observes the failure;
   * the cost-benefit favors the single-listener invariant.
   */
  const getTransportClosedReject = (entry: SessionEntry): Promise<never> => {
    if (!entry.transportClosedReject) {
      entry.transportClosedReject = entry.channel.exited.then(() => {
        throw new Error(
          `agent channel closed mid-request (session ${entry.sessionId})`,
        );
      });
    }
    return entry.transportClosedReject;
  };

  const resolveWorkspaceKey = (workspaceCwd: string): string => {
    if (!path.isAbsolute(workspaceCwd)) {
      throw new Error(
        `workspaceCwd must be an absolute path; got "${workspaceCwd}"`,
      );
    }
    const workspaceKey =
      workspaceCwd === boundWorkspace
        ? boundWorkspace
        : canonicalizeWorkspace(workspaceCwd);
    if (workspaceKey !== boundWorkspace) {
      throw new WorkspaceMismatchError(boundWorkspace, workspaceKey);
    }
    return workspaceKey;
  };

  const liveChannelInfo = (): ChannelInfo | undefined => {
    if (!channelInfo || channelInfo.isDying) return undefined;
    return channelInfo;
  };

  const channelInfoForEntry = (
    entry: SessionEntry,
  ): ChannelInfo | undefined => {
    if (channelInfo?.channel === entry.channel) return channelInfo;
    for (const info of aliveChannels) {
      if (info.channel === entry.channel) return info;
    }
    return undefined;
  };

  const getChannelClosedReject = (info: ChannelInfo): Promise<never> => {
    if (!info.statusClosedReject) {
      info.statusClosedReject = info.channel.exited.then(() => {
        throw new Error('agent channel closed mid-request (workspace status)');
      });
    }
    return info.statusClosedReject;
  };

  const requestWorkspaceStatus = async <T>(
    method: string,
    idle: () => T,
  ): Promise<T> => {
    const info = liveChannelInfo();
    if (!info) return idle();
    const response = await withTimeout(
      Promise.race([
        info.connection.extMethod(method, { cwd: boundWorkspace }),
        getChannelClosedReject(info),
      ]),
      initTimeoutMs,
      method,
    );
    return response as unknown as T;
  };

  const requestSessionStatus = async <T>(
    sessionId: string,
    method: string,
  ): Promise<T> => {
    const entry = byId.get(sessionId);
    if (!entry) throw new SessionNotFoundError(sessionId);
    const info = channelInfoForEntry(entry);
    if (!info || info.isDying) throw new SessionNotFoundError(sessionId);
    const response = await Promise.race([
      withTimeout(
        entry.connection.extMethod(method, { sessionId }),
        initTimeoutMs,
        method,
      ),
      getTransportClosedReject(entry),
    ]);
    return response as unknown as T;
  };

  const createSessionEntry = (
    ci: ChannelInfo,
    sessionId: string,
    workspaceCwd: string,
    events = new EventBus(eventRingSize),
  ): SessionEntry => {
    const entry: SessionEntry = {
      sessionId,
      workspaceCwd,
      createdAt: new Date().toISOString(),
      channel: ci.channel,
      connection: ci.connection,
      events,
      promptQueue: Promise.resolve(),
      modelChangeQueue: Promise.resolve(),
      pendingPermissionIds: new Set(),
      clientIds: new Map(),
      clientLastSeenAt: new Map(),
      attachCount: 0,
      spawnOwnerWantedKill: false,
    };
    ci.sessionIds.add(entry.sessionId);
    byId.set(entry.sessionId, entry);
    return entry;
  };

  const isAcpSessionResourceNotFound = (
    err: unknown,
    sessionId: string,
  ): boolean => {
    if (!err || typeof err !== 'object') return false;
    const maybe = err as {
      code?: unknown;
      data?: unknown;
      message?: unknown;
    };
    if (maybe.code !== -32002) return false;
    const expectedUri = `session:${sessionId}`;
    if (
      maybe.data &&
      typeof maybe.data === 'object' &&
      (maybe.data as { uri?: unknown }).uri === expectedUri
    ) {
      return true;
    }
    // Fallback for ACP servers that omit `data.uri` and embed the
    // URI in the human-readable message. Use exact equality on the
    // canonical "Resource not found: <uri>" form rather than
    // `includes(expectedUri)` — a substring match would cause a
    // sessionId of `"a"` to falsely match a message containing
    // `"session:abc"`.
    return (
      typeof maybe.message === 'string' &&
      maybe.message === `Resource not found: ${expectedUri}`
    );
  };

  async function restoreSession(
    action: 'load' | 'resume',
    req: BridgeRestoreSessionRequest,
  ): Promise<BridgeRestoredSession> {
    if (shuttingDown) {
      throw new Error('HttpAcpBridge is shutting down');
    }
    const workspaceKey = resolveWorkspaceKey(req.workspaceCwd);

    const existing = byId.get(req.sessionId);
    if (existing) {
      existing.attachCount++;
      const clientId = registerClient(existing, req.clientId);
      return {
        sessionId: existing.sessionId,
        workspaceCwd: existing.workspaceCwd,
        attached: true,
        clientId,
        createdAt: existing.createdAt,
        // Late attachers get the same ACP state the original restore
        // caller saw; spawn-only sessions don't carry a state payload.
        state: existing.restoreState ?? {},
      };
    }

    const inFlight = inFlightRestores.get(req.sessionId);
    if (inFlight) {
      // Cross-action races BOTH ways must reject. A `resume` arriving
      // while a `load` is in flight cannot quietly coalesce: the load
      // is replaying full history through SSE on a shared EventBus,
      // and `DaemonSessionClient.resume()` seeds `lastEventId: 0`,
      // which means the resume client would receive every replayed
      // frame — directly violating resume's "no UI replay" contract.
      // The mirror direction (`load` onto `resume`) is rejected for
      // the same reason: a load caller expects history but resume
      // didn't replay any. Same-action coalescing is unaffected.
      if (action !== inFlight.action) {
        throw new RestoreInProgressError(
          req.sessionId,
          inFlight.action,
          action,
        );
      }
      // Reserve the attach SYNCHRONOUSLY before awaiting so the spawn
      // owner's `requireZeroAttaches` disconnect-reaper observes our
      // intent. The IIFE folds this counter into `entry.attachCount`
      // at `createSessionEntry` time.
      inFlight.coalesceState.count++;
      let restored: BridgeRestoredSession;
      try {
        restored = await inFlight.promise;
      } catch (err) {
        // Roll back our reservation so a subsequent retry isn't
        // permanently skewed if the in-flight restore failed.
        inFlight.coalesceState.count--;
        throw err;
      }
      const entry = byId.get(restored.sessionId);
      if (!entry) {
        // Restore owner's session got reaped before our await
        // resumed (channel died mid-microtask, etc). Roll back the
        // reservation too — there's no entry for it to live on.
        inFlight.coalesceState.count--;
        throw new SessionNotFoundError(
          restored.sessionId,
          'the agent child likely crashed during session restore — retry to restore the session',
        );
      }
      // NOTE: do NOT bump entry.attachCount here — `createSessionEntry`
      // already initialized it from coalesceState.count synchronously
      // when the IIFE registered the entry. Spread `restored` so the
      // ACP state propagates to coalesced waiters (BQ9tV-equivalent
      // for restore waiter consistency).
      return {
        ...restored,
        attached: true,
        clientId: registerClient(entry, req.clientId),
        createdAt: entry.createdAt,
      };
    }

    if (
      byId.size + inFlightSpawns.size + inFlightRestores.size >=
      maxSessions
    ) {
      throw new SessionLimitExceededError(maxSessions);
    }

    const restoreEvents = new EventBus(eventRingSize);
    let registeredEntry: SessionEntry | undefined;
    let ci: ChannelInfo | undefined;
    // Live counter shared with coalesced waiters (see InFlightRestore
    // doc comment). Mutated synchronously by the coalesce branch above
    // and read once by the IIFE when seeding `entry.attachCount`.
    const coalesceState = { count: 0 };
    const promise = (async (): Promise<BridgeRestoredSession> => {
      pendingRestoreEvents.set(req.sessionId, restoreEvents);
      ci = await ensureChannel();
      ci.pendingRestoreIds.add(req.sessionId);
      // Restore is a low-frequency one-shot path, so we register a
      // fresh `channel.exited` listener per call instead of going
      // through `getTransportClosedReject` (which exists to keep
      // sendPrompt's per-session listener count at 1 over the
      // session's lifetime). The listener is bound to this restore's
      // race only — once the race settles, no new awaits attach to
      // it, so there's no listener leak across restores.
      const transportClosed = ci.channel.exited.then(() => {
        throw new Error(`agent channel closed during session/${action}`);
      });
      // Suppress the dangling rejection if `withTimeout` wins the
      // race below: `transportClosed` then stays pending, and a
      // later `channel.exited` settle fires the inner `throw` with
      // no observer attached. Node 22 logs `unhandledRejection`;
      // under `--unhandled-rejections=throw` (common in container
      // deployments) the daemon process crashes. The `Promise.race`
      // path's own consumer below catches the rejection in the
      // try/catch, so the suppressed rejection here is the
      // race-loser case only.
      transportClosed.catch(() => {});
      let state: BridgeSessionState;
      try {
        if (action === 'load') {
          state = await Promise.race([
            withTimeout(
              ci.connection.loadSession({
                sessionId: req.sessionId,
                cwd: workspaceKey,
                // Restore path drops per-request `mcpServers` (matches
                // `doSpawn`); daemon-wide MCP comes from settings on
                // the agent side. The SDK's `RestoreSessionRequest`
                // intentionally has no `mcpServers` field for the
                // same reason.
                mcpServers: [],
              }),
              initTimeoutMs,
              'loadSession',
            ),
            transportClosed,
          ]);
        } else {
          state = await Promise.race([
            withTimeout(
              ci.connection.unstable_resumeSession({
                sessionId: req.sessionId,
                cwd: workspaceKey,
                mcpServers: [],
              }),
              initTimeoutMs,
              'resumeSession',
            ),
            transportClosed,
          ]);
        }
      } catch (err) {
        restoreEvents.close();
        if (isAcpSessionResourceNotFound(err, req.sessionId)) {
          throw new SessionNotFoundError(req.sessionId);
        }
        if (
          ci.sessionIds.size === 0 &&
          ci.pendingRestoreIds.size === 1 &&
          ci.pendingRestoreIds.has(req.sessionId)
        ) {
          ci.isDying = true;
          await ci.channel.kill().catch(() => {
            /* best-effort — channel.exited handler still runs */
          });
        }
        throw err;
      }

      if (shuttingDown) {
        restoreEvents.close();
        throw new Error('HttpAcpBridge is shutting down');
      }
      if (ci.isDying || !aliveChannels.has(ci)) {
        restoreEvents.close();
        throw new Error(
          `Session ${req.sessionId} restored on a closed agent channel`,
        );
      }
      const racedEntry = byId.get(req.sessionId);
      if (racedEntry) {
        restoreEvents.close();
        // Self + any coalescers we accumulated while the restore was
        // in flight. Coalescers must not bump attachCount themselves
        // (they read it off the registered entry on the next tick).
        racedEntry.attachCount += 1 + coalesceState.count;
        const clientId = registerClient(racedEntry, req.clientId);
        return {
          sessionId: racedEntry.sessionId,
          workspaceCwd: racedEntry.workspaceCwd,
          attached: true,
          clientId,
          createdAt: racedEntry.createdAt,
          state: racedEntry.restoreState ?? {},
        };
      }

      const entry = createSessionEntry(
        ci,
        req.sessionId,
        workspaceKey,
        restoreEvents,
      );
      entry.restoreState = state;
      const clientId = registerClient(entry, req.clientId);
      // Fold synchronous coalesce reservations into the new entry's
      // `attachCount`. By this point all coalescers that beat us must
      // have hit the inFlightRestores branch and bumped
      // `coalesceState.count`; later coalescers will hit the byId
      // early-return path instead and increment `entry.attachCount`
      // directly.
      entry.attachCount = coalesceState.count;
      registeredEntry = entry;
      // Explicit `session/load` / `session/resume` is "give me THIS
      // id"; it must NOT become the implicit attach target for
      // subsequent omitted-id `POST /session` callers under `single`
      // scope. Those callers asked for "any default", and silently
      // joining a restored live history would surprise them.
      // `defaultEntry` is reserved for sessions created through
      // `doSpawn` under `'single'` scope.
      return {
        sessionId: entry.sessionId,
        workspaceCwd: entry.workspaceCwd,
        attached: false,
        clientId,
        createdAt: entry.createdAt,
        state,
      };
    })().finally(() => {
      ci?.pendingRestoreIds.delete(req.sessionId);
      pendingRestoreEvents.delete(req.sessionId);
      if (!registeredEntry) {
        restoreEvents.close();
      }
    });

    inFlightRestores.set(req.sessionId, { action, promise, coalesceState });
    try {
      return await promise;
    } finally {
      inFlightRestores.delete(req.sessionId);
    }
  }

  return {
    get sessionCount() {
      return byId.size;
    },

    get pendingPermissionCount() {
      return pendingPermissions.size;
    },

    async loadSession(req) {
      return restoreSession('load', req);
    },

    async resumeSession(req) {
      return restoreSession('resume', req);
    },

    async spawnOrAttach(req) {
      if (shuttingDown) {
        // `runQwenServe.close()` calls `bridge.shutdown()` BEFORE
        // `server.close()`. During that window, established HTTP
        // connections can still hit `POST /session`. Refuse here so
        // late-arrivers don't spawn children the shutdown path won't
        // see — they'd otherwise leak past `process.exit(0)`.
        throw new Error('HttpAcpBridge is shutting down');
      }
      // Fast-path the common §02 case: clients pre-flight `caps.workspaceCwd`
      // and post back the exact same string, so the equality check
      // saves a `realpathSync.native` syscall per spawnOrAttach. The
      // omit-cwd path in `server.ts` also synthesizes `cwd =
      // boundWorkspace` before calling here, so it hits this branch
      // too. Falls through to the full canonicalize when the client
      // sent a non-canonical alias (`/work/./bound`, mixed casing on
      // case-insensitive FS, a symlinked aliased path, …) — that
      // still needs the realpath to compare correctly.
      const workspaceKey = resolveWorkspaceKey(req.workspaceCwd);

      // Resolve the effective scope for THIS call. A per-request
      // `req.sessionScope` overrides the daemon-wide default; omitting
      // it falls back to `defaultSessionScope` so every existing caller
      // observes pre-#4175-PR-5 behavior bit-for-bit. The string-validation
      // happens here (rather than at the route layer alone) so direct
      // callers — tests, embeds, future entry points — can't bypass it.
      if (
        req.sessionScope !== undefined &&
        req.sessionScope !== 'single' &&
        req.sessionScope !== 'thread'
      ) {
        throw new InvalidSessionScopeError(req.sessionScope);
      }
      const effectiveScope = req.sessionScope ?? defaultSessionScope;

      if (effectiveScope === 'single') {
        const existing = defaultEntry;
        if (existing) {
          // BRSCi: bump attach counter BEFORE any await so the
          // spawn-owner's disconnect reaper (server.ts:
          // `requireZeroAttaches: true`) sees this attach even when
          // we yield on the model-switch below. Increment is
          // synchronous → atomic against the killSession
          // sync-prefix check.
          //
          // BVryk + BWGSL: counter is NOT strictly monotonic any
          // more — `detachClient()` decrements it to roll back an
          // attach whose HTTP response couldn't be written
          // (tanzhenxin issue 2). The race-guard invariant we still
          // hold is "attachCount reflects the number of attaching
          // clients whose response was written or is about to be
          // written"; decrementing is the symmetric cleanup for
          // attaches that turned out to be fictitious. The
          // ordering guarantee that matters for the killSession
          // race is "bump runs before any await inside this
          // microtask," which is what we get here.
          existing.attachCount++;
          const clientId = registerClient(existing, req.clientId);
          // If the caller passed a modelServiceId on attach, the session
          // may currently be running a DIFFERENT model. Honor the request
          // by issuing setSessionModel — same call we'd use on
          // /session/:id/model. Surfaces a `model_switched` event so
          // every attached client sees the change. If the new model is
          // rejected, propagate as a spawn-style error rather than
          // silently returning an attach-with-stale-model.
          if (req.modelServiceId) {
            // Swallow: matches the create-session catch in `doSpawn`
            // below — a model-switch rejection on an already-running
            // session must NOT 500 the attach (the session is fully
            // operational on its current model; tearing it down or
            // returning an error without the sessionId would deny
            // the caller any way to recover). The
            // `model_switch_failed` SSE event is the visible signal.
            await applyModelServiceId(
              existing,
              req.modelServiceId,
              initTimeoutMs,
              clientId,
            ).catch(() => {});
          }
          return {
            sessionId: existing.sessionId,
            workspaceCwd: existing.workspaceCwd,
            attached: true,
            clientId,
            createdAt: existing.createdAt,
          };
        }
        // Coalesce: if another caller is already mid-spawn for this same
        // workspace, await their result. The reporter's call appears as an
        // attach (the spawn was someone else's, not theirs). If the
        // reporter asked for a different modelServiceId than the spawn
        // chose, apply it now.
        const inFlight = inFlightSpawns.get(workspaceKey);
        if (inFlight) {
          const session = await inFlight;
          // BRSCi: bump attach counter SYNCHRONOUSLY in the same
          // microtask the in-flight spawn resolves to us, BEFORE
          // any further await. The spawn-owner's route handler
          // microtask (which calls `killSession({requireZeroAttaches})`)
          // runs after our spawnOrAttach() resolves; the ordering
          // guarantee is "every attach-bump runs before the
          // matching killSession sync prefix" only if the bump is
          // the first sync step after `await inFlight`. Doing the
          // model-switch await first re-opens the race deepseek-v4-pro
          // flagged in BRSCi.
          const attachedEntry = byId.get(session.sessionId);
          if (attachedEntry) attachedEntry.attachCount++;
          // BX9_U: even with the BRSCi bump-before-await ordering,
          // there are still adversarial paths where the entry could
          // be torn down between `await inFlight` resolving and our
          // continuation running (e.g. channel.exited firing during
          // a crash spawn, or a direct bridge.killSession call from
          // outside the route handler). In those cases byId.get()
          // returned undefined. Fail loud with a descriptive error
          // so the caller can distinguish "immediate agent death"
          // from a stale sessionId and retry into a fresh spawn.
          if (!attachedEntry) {
            throw new SessionNotFoundError(
              session.sessionId,
              'the agent child likely crashed during initialization — retry to spawn a new session',
            );
          }
          const clientId = registerClient(attachedEntry, req.clientId);
          if (req.modelServiceId) {
            // Same swallow as above — we picked up an in-flight
            // spawn, the session is real, model-switch failure
            // shouldn't deny us the sessionId.
            await applyModelServiceId(
              attachedEntry,
              req.modelServiceId,
              initTimeoutMs,
              clientId,
            ).catch(() => {});
          }
          return { ...session, attached: true, clientId };
        }
      }

      // Cap check: count both registered sessions and in-flight spawns
      // (a fresh-spawn races that's about to register hasn't hit
      // `byId` yet but should still count toward the limit). Attaches
      // returned above bypass this — only NEW children are gated.
      if (
        byId.size + inFlightSpawns.size + inFlightRestores.size >=
        maxSessions
      ) {
        throw new SessionLimitExceededError(maxSessions);
      }

      const promise = doSpawn(req.modelServiceId, effectiveScope, req.clientId);
      // Track in-flight spawns regardless of scope. Under `single`
      // this also serves the coalescing path above (a parallel
      // `spawnOrAttach` finds the entry and waits for the same
      // promise). Under `thread` we don't need coalescing — every
      // call gets its own session — but `shutdown()` snapshots
      // `inFlightSpawns.values()` to know which spawns to await
      // for graceful tear-down. Without this, a `thread`-scope
      // shutdown returns before in-progress spawns finish their
      // child cleanup, surfacing stderr noise after the daemon
      // claimed graceful shutdown. Use a unique key per spawn so
      // simultaneous thread-scope spawns don't collide on the
      // workspace key.
      const tracker =
        effectiveScope === 'single'
          ? workspaceKey
          : `${workspaceKey}#${randomUUID()}`;
      inFlightSpawns.set(tracker, promise);
      try {
        return await promise;
      } finally {
        // Always clear the in-flight slot whether the spawn resolved
        // or rejected — leaving a rejected promise behind would
        // poison every future coalescing-path call for this
        // workspace (single-scope) or grow unbounded (thread-scope).
        inFlightSpawns.delete(tracker);
      }
    },

    async sendPrompt(sessionId, req, signal, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      const originatorClientId = resolveTrustedClientId(
        entry,
        context?.clientId,
      );
      // Pre-aborted: skip the queue entirely. Without this the prompt
      // chains onto promptQueue, waits its turn, and the FIFO worker
      // checks `signal.aborted` only AFTER reaching the head — wasted
      // queue churn on every retry-after-abort, plus a confusing trace
      // where the prompt appears to "run" before erroring.
      if (signal?.aborted) {
        throw new DOMException('Prompt aborted', 'AbortError');
      }
      // Force the body's sessionId to match the routing id — a client that
      // sent a stale id in the body would otherwise be dispatched to the
      // wrong agent process.
      const normalized: PromptRequest = { ...req, sessionId };
      const result = entry.promptQueue.then(() => {
        // If the caller aborted while we were queued behind earlier
        // prompts, don't even start this one.
        if (signal?.aborted) {
          throw new DOMException('Prompt aborted', 'AbortError');
        }
        if (originatorClientId === undefined) {
          delete entry.activePromptOriginatorClientId;
        } else {
          entry.activePromptOriginatorClientId = originatorClientId;
        }
        const promptPromise = entry.connection
          .prompt(normalized)
          .finally(() => {
            delete entry.activePromptOriginatorClientId;
          });

        // Race against channel termination: if the underlying transport
        // dies (child crashed, stream torn down) WHILE the prompt is in
        // flight, the SDK's pending-request promise can hang because the
        // wire never delivers a response. Make the prompt fail-fast in
        // that case so the per-session FIFO doesn't poison the next
        // queued prompt with an unbounded await. See
        // `getTransportClosedReject` for the single-listener invariant.
        //
        // FIXME(stage-2): no absolute prompt deadline. A buggy agent
        // that ignores `cancel()` while keeping the channel alive can
        // hold this race open indefinitely — the abort path fires
        // `cancel()` and resolves pending permissions, but the
        // `promptPromise` itself only settles when the agent
        // cooperates. Stage 2 should add a configurable per-prompt
        // wall clock (e.g. `--prompt-deadline 30m`) into this race so
        // a wedged agent can't slow-leak prompt promises. Tracked
        // under #3803 follow-ups.
        const racedPromise = Promise.race([
          promptPromise,
          getTransportClosedReject(entry),
        ]);

        if (!signal) return racedPromise;
        // Wire the abort: when the signal fires (e.g. SSE route's
        // req.on('close')), tell the agent to wind down. ACP cancel is a
        // notification — the active prompt resolves with
        // stopReason: 'cancelled', then the next queued prompt can run.
        //
        // Also resolve any pending permission requests as `cancelled`.
        // ACP spec requires `cancel` to settle outstanding
        // `requestPermission` calls — `cancelSession()` already does
        // this; the abort path here was missing the call. Without it,
        // a client disconnecting while the agent is inside
        // `requestPermission` leaves the permission promise unresolved
        // forever (the agent is stuck waiting on a vote that no SSE
        // subscriber will ever cast).
        const onAbort = () => {
          cancelPendingForSession(sessionId);
          entry.connection.cancel({ sessionId }).catch(() => {
            // Cancel is fire-and-forget; the agent may already be dead.
          });
        };
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener('abort', onAbort, { once: true });
          // The aborted state can flip synchronously between the early-exit
          // check at the top of `sendPrompt` and addEventListener — re-check
          // after registration so a microsecond-window abort still fires
          // `cancel()` instead of letting the prompt run uncancellable.
          if (signal.aborted) onAbort();
          // Detach the listener once the prompt resolves so the
          // AbortController can be GC'd. The `.finally()` returns a
          // promise chained on `racedPromise`; if `racedPromise`
          // rejects, that returned promise rejects too — and we
          // never await it, so under Node's default
          // unhandled-rejection behavior the daemon could terminate
          // even though the route's own catch handles the original
          // rejection. Attach `.catch(() => {})` to the
          // listener-cleanup chain only — the caller's reference to
          // `racedPromise` (via `return racedPromise` below) still
          // surfaces failures normally.
          racedPromise
            .finally(() => signal.removeEventListener('abort', onAbort))
            .catch(() => {});
        }
        return racedPromise;
      });
      // Tail swallows failures so subsequent prompts still run. The caller
      // still sees rejections on its own `result` reference.
      entry.promptQueue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },

    async cancelSession(sessionId, req, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      resolveTrustedClientId(entry, context?.clientId);
      // Validation-only: cancellation resolves permissions as system
      // cancellations, so those generated events intentionally omit an
      // originator client id.
      // ACP spec: cancelling a prompt MUST resolve outstanding
      // requestPermission calls with outcome.cancelled. Do this *before*
      // forwarding the notification so the agent's wind-down sees the
      // resolutions.
      cancelPendingForSession(sessionId);
      // Cancel intentionally bypasses the prompt queue: it's a notification
      // that the agent uses to wind down the *currently active* prompt, not
      // something to wait behind queued work.
      //
      // CONTRACT (multi-prompt clients): cancel affects ONLY the active
      // prompt. Any prompts the client previously POSTed and that are
      // still queued behind the active one will continue to execute
      // after the active prompt resolves with `stopReason: 'cancelled'`.
      // This matches ACP's "cancel is a wind-down notification for the
      // current turn" semantics — multi-prompt queueing is a daemon
      // convenience, not in spec, so we don't extend cancel's reach
      // there. Clients that want a hard stop should stop posting new
      // prompts and call `cancelSession` after their last prompt
      // resolves, or kill the session via the channel-exit path.
      const notif: CancelNotification = req
        ? { ...req, sessionId }
        : { sessionId };
      await entry.connection.cancel(notif);
    },

    subscribeEvents(sessionId, subOpts) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      return entry.events.subscribe(subOpts);
    },

    respondToPermission(requestId, response, context) {
      const pending = pendingPermissions.get(requestId);
      let originatorClientId: string | undefined;
      if (context?.clientId !== undefined && !pending) {
        resolveAnyTrustedClientId(context.clientId);
      } else if (pending && context?.clientId !== undefined) {
        const entry = byId.get(pending.sessionId);
        if (entry) {
          originatorClientId = resolveTrustedClientId(entry, context.clientId);
        } else {
          resolveAnyTrustedClientId(context.clientId);
        }
      }
      if (!pending) {
        const record = resolvedPermissions.get(requestId);
        if (record) {
          publishPermissionAlreadyResolved(record);
        }
        return false;
      }
      // BkwQI: validate the voter's optionId against the original
      // options the agent advertised. The route already enforces
      // "non-empty string" structurally; this layer enforces
      // semantic membership in the agent-published set so a
      // malicious client can't forge hidden outcomes (e.g.
      // `ProceedAlways*` when the prompt's `hideAlwaysAllow`
      // policy intentionally suppressed them).
      if (response.outcome.outcome === 'selected') {
        if (!pending.allowedOptionIds.has(response.outcome.optionId)) {
          throw new InvalidPermissionOptionError(
            requestId,
            response.outcome.optionId,
          );
        }
      }
      return resolvePending(requestId, response, originatorClientId);
    },

    respondToSessionPermission(sessionId, requestId, response, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      const pending = pendingPermissions.get(requestId);
      if (!pending) {
        const record = resolvedPermissions.get(requestId);
        if (record?.sessionId === sessionId) {
          resolveTrustedClientId(entry, context?.clientId);
          publishPermissionAlreadyResolved(record);
        } else if (record) {
          writeServeDebugLine(
            `rejected permission vote ${JSON.stringify(requestId)} ` +
              `for session ${JSON.stringify(sessionId)}; request belongs to ` +
              `session ${JSON.stringify(record.sessionId)}.`,
          );
        }
        return false;
      }
      if (pending.sessionId !== sessionId) {
        writeServeDebugLine(
          `rejected permission vote ${JSON.stringify(requestId)} ` +
            `for session ${JSON.stringify(sessionId)}; request belongs to ` +
            `session ${JSON.stringify(pending.sessionId)}.`,
        );
        return false;
      }
      const originatorClientId = resolveTrustedClientId(
        entry,
        context?.clientId,
      );
      if (
        response.outcome.outcome === 'selected' &&
        !pending.allowedOptionIds.has(response.outcome.optionId)
      ) {
        throw new InvalidPermissionOptionError(
          requestId,
          response.outcome.optionId,
        );
      }
      return resolvePending(requestId, response, originatorClientId);
    },

    async closeSession(sessionId, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      let originatorClientId: string | undefined;
      if (context?.clientId !== undefined) {
        originatorClientId = resolveTrustedClientId(entry, context.clientId);
      }
      writeStderrLine(
        `qwen serve: closing session ${JSON.stringify(sessionId)}` +
          (originatorClientId
            ? ` by client ${JSON.stringify(originatorClientId)}`
            : ''),
      );
      if (defaultEntry === entry) defaultEntry = undefined;
      const ci = channelInfo;
      if (ci && ci.channel === entry.channel) {
        ci.sessionIds.delete(sessionId);
      }
      for (const id of Array.from(entry.pendingPermissionIds)) {
        resolvePending(id, { outcome: { outcome: 'cancelled' } });
      }
      byId.delete(sessionId);
      try {
        entry.events.publish({
          type: 'session_closed',
          data: {
            sessionId,
            reason: 'client_close',
            ...(originatorClientId ? { closedBy: originatorClientId } : {}),
          },
        });
      } catch {
        /* bus already closed */
      }
      // `session_closed` is terminal. Close the bus before ACP cancel so any
      // late cancellation frames from the agent are intentionally dropped.
      entry.events.close();
      try {
        await entry.connection.cancel({ sessionId });
      } catch {
        /* no active prompt or session already torn down */
      }
      if (ci && ci.sessionIds.size === 0 && ci.pendingRestoreIds.size === 0) {
        ci.isDying = true;
        await ci.channel.kill().catch((err) => {
          writeStderrLine(
            `qwen serve: closeSession channel kill failed for session ` +
              `${JSON.stringify(sessionId)}: ${String(err)}`,
          );
        });
      }
    },

    updateSessionMetadata(sessionId, metadata, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      if (context?.clientId !== undefined) {
        resolveTrustedClientId(entry, context.clientId);
      }
      if (metadata.displayName !== undefined) {
        if (
          typeof metadata.displayName !== 'string' ||
          metadata.displayName.length > MAX_DISPLAY_NAME_LENGTH
        ) {
          throw new InvalidSessionMetadataError(
            'displayName',
            `must be a string of at most ${MAX_DISPLAY_NAME_LENGTH} characters`,
          );
        }
        if (hasControlCharacter(metadata.displayName)) {
          throw new InvalidSessionMetadataError(
            'displayName',
            'must not contain control characters',
          );
        }
        const nextDisplayName = metadata.displayName || undefined;
        if (entry.displayName !== nextDisplayName) {
          entry.displayName = nextDisplayName;
          writeStderrLine(
            `qwen serve: updated session metadata ${JSON.stringify(sessionId)} ` +
              `displayName=${entry.displayName === undefined ? 'cleared' : 'set'}` +
              (context?.clientId
                ? ` by client ${JSON.stringify(context.clientId)}`
                : ''),
          );
          try {
            entry.events.publish({
              type: 'session_metadata_updated',
              data: { sessionId, displayName: entry.displayName },
            });
          } catch {
            /* bus already closed */
          }
        }
      }
      return { displayName: entry.displayName };
    },

    listWorkspaceSessions(workspaceCwd) {
      if (!path.isAbsolute(workspaceCwd)) return [];
      const key =
        workspaceCwd === boundWorkspace
          ? boundWorkspace
          : canonicalizeWorkspace(workspaceCwd);
      if (key !== boundWorkspace) return [];
      const out: BridgeSessionSummary[] = [];
      for (const entry of byId.values()) {
        if (entry.workspaceCwd === key) {
          out.push({
            sessionId: entry.sessionId,
            workspaceCwd: entry.workspaceCwd,
            createdAt: entry.createdAt,
            displayName: entry.displayName,
            clientCount: entry.clientIds.size,
            hasActivePrompt: entry.activePromptOriginatorClientId !== undefined,
          });
        }
      }
      return out;
    },

    recordHeartbeat(sessionId, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      // Validate the optional client id BEFORE bumping any timestamp so
      // an unknown client doesn't get to advance the per-session
      // watermark — that would let an attacker with a valid bearer
      // token mask client absence by spamming heartbeats with random
      // ids. `resolveTrustedClientId` throws `InvalidClientIdError`,
      // which the route layer maps to `400 invalid_client_id`.
      const clientId = resolveTrustedClientId(entry, context?.clientId);
      const lastSeenAt = Date.now();
      entry.sessionLastSeenAt = lastSeenAt;
      if (clientId !== undefined) {
        entry.clientLastSeenAt.set(clientId, lastSeenAt);
      }
      return {
        sessionId: entry.sessionId,
        ...(clientId !== undefined ? { clientId } : {}),
        lastSeenAt,
      };
    },

    getHeartbeatState(sessionId) {
      const entry = byId.get(sessionId);
      if (!entry) return undefined;
      // Snapshot the client map so callers can't mutate the live one;
      // `sessionLastSeenAt` is undefined for sessions that have never
      // received a heartbeat (the typical state right after spawn).
      return {
        ...(entry.sessionLastSeenAt !== undefined
          ? { sessionLastSeenAt: entry.sessionLastSeenAt }
          : {}),
        clientLastSeenAt: new Map(entry.clientLastSeenAt),
      };
    },

    async getWorkspaceMcpStatus() {
      return requestWorkspaceStatus(SERVE_STATUS_EXT_METHODS.workspaceMcp, () =>
        createIdleWorkspaceMcpStatus(boundWorkspace),
      );
    },

    async getWorkspaceSkillsStatus() {
      return requestWorkspaceStatus(
        SERVE_STATUS_EXT_METHODS.workspaceSkills,
        () => createIdleWorkspaceSkillsStatus(boundWorkspace),
      );
    },

    async getWorkspaceProvidersStatus() {
      return requestWorkspaceStatus(
        SERVE_STATUS_EXT_METHODS.workspaceProviders,
        () => createIdleWorkspaceProvidersStatus(boundWorkspace),
      );
    },

    async getSessionContextStatus(sessionId) {
      return requestSessionStatus(
        sessionId,
        SERVE_STATUS_EXT_METHODS.sessionContext,
      );
    },

    async getSessionSupportedCommandsStatus(sessionId) {
      return requestSessionStatus(
        sessionId,
        SERVE_STATUS_EXT_METHODS.sessionSupportedCommands,
      );
    },

    async setSessionModel(sessionId, req, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      const originatorClientId = resolveTrustedClientId(
        entry,
        context?.clientId,
      );
      const normalized: SetSessionModelRequest = { ...req, sessionId };
      // The ACP SDK marks setSessionModel as unstable (not in spec yet); the
      // method on AgentSideConnection is `unstable_setSessionModel`. Cast
      // through the shape we know rather than couple to the prefix in case
      // it's renamed when the spec stabilizes.
      const conn = entry.connection as unknown as {
        unstable_setSessionModel(
          p: SetSessionModelRequest,
        ): Promise<SetSessionModelResponse>;
      };
      // Serialize through `entry.modelChangeQueue` so a `POST /session/:id/model`
      // can't race with `applyModelServiceId` (e.g. an attach-with-different-
      // modelServiceId) and leave the agent connection in an indeterminate
      // model. `applyModelServiceId` already chains on this queue; without
      // mirroring that here, two concurrent model changes interleave and the
      // last `model_switched` event published may not match the actual model
      // the agent is on.
      //
      // Race the agent call against `transportClosedReject` and a
      // `withTimeout` so a wedged child can't block the HTTP handler
      // forever. Matches `sendPrompt` (transport race) and
      // `applyModelServiceId` (timeout) — the absence of either was an
      // attack surface for "POST /session/:id/model never returns".
      // See `getTransportClosedReject` for the single-listener invariant.
      //
      // FIXME(stage-2): we reuse `initTimeoutMs` (default 10s) as the
      // model-switch deadline because the two values happen to share
      // a sensible order of magnitude today. They're conceptually
      // distinct (cold-start handshake vs in-flight model swap) and
      // a Stage 2 split into `modelSwitchTimeoutMs` would let
      // operators tune them independently — also a good time to
      // remove the no-abort behavior of `withTimeout` (it rejects
      // the promise but leaves the underlying ACP call running, so a
      // late-arriving `model_switched` can race a previously-fired
      // `model_switch_failed`). Both depend on ACP exposing a cancel
      // signal for `unstable_setSessionModel`.
      const transportClosed = getTransportClosedReject(entry);
      const work = entry.modelChangeQueue.then(() =>
        Promise.race([
          withTimeout(
            conn.unstable_setSessionModel(normalized),
            initTimeoutMs,
            'setSessionModel',
          ),
          transportClosed,
        ]),
      );
      // Tail-swallow on the queue so a model-change failure doesn't poison
      // every subsequent change (matches `applyModelServiceId`'s pattern).
      entry.modelChangeQueue = work.then(
        () => undefined,
        () => undefined,
      );
      let response: SetSessionModelResponse;
      try {
        response = await work;
      } catch (err) {
        // Mirror `applyModelServiceId`'s observability contract: surface
        // failed model changes on the SSE bus so subscribers can update
        // their UI / retry. Without this the only signal is the HTTP
        // 5xx, which doesn't reach passive viewers.
        try {
          entry.events.publish({
            type: 'model_switch_failed',
            data: {
              sessionId: entry.sessionId,
              requestedModelId: req.modelId,
              error: err instanceof Error ? err.message : String(err),
            },
            ...(originatorClientId ? { originatorClientId } : {}),
          });
        } catch {
          /* bus closed */
        }
        throw err;
      }
      try {
        entry.events.publish({
          type: 'model_switched',
          data: { sessionId: entry.sessionId, modelId: req.modelId },
          ...(originatorClientId ? { originatorClientId } : {}),
        });
      } catch {
        /* bus closed */
      }
      return response;
    },

    async killSession(sessionId, opts) {
      const entry = byId.get(sessionId);
      if (!entry) return;
      // BQ9tV race guard: skip the reap if any other client already
      // attached to this entry. The disconnect-reaper in server.ts
      // sets `requireZeroAttaches: true` because it only wants to
      // reap when the spawn-owner that disconnected truly was the
      // sole client. Counter increment + this check both run
      // synchronously, so no microtask boundary lets a race slip
      // through.
      // BkwQP: when bailing because of an attach, set the tombstone
      // so a later `detachClient` (that brings attachCount back to
      // 0) can complete the deferred reap. Without this, both
      // spawn-owner-and-attach disconnecting leaves the session
      // orphaned forever (spawn owner's reap bails here, attach's
      // detach does nothing structural).
      if (opts?.requireZeroAttaches && entry.attachCount > 0) {
        entry.spawnOwnerWantedKill = true;
        return;
      }
      // Remove from the state eagerly so concurrent `spawnOrAttach`
      // can't reattach to a session we're tearing down.
      if (defaultEntry === entry) defaultEntry = undefined;
      byId.delete(sessionId);
      // Detach from the channel. The channel dies only when its LAST
      // session leaves — other sessions on the same channel keep
      // running.
      const ci = channelInfo;
      if (ci && ci.channel === entry.channel) {
        ci.sessionIds.delete(sessionId);
      }
      // Resolve any still-pending permission as cancelled (matches the
      // shutdown path) so callers awaiting requestPermission unwind.
      for (const id of Array.from(entry.pendingPermissionIds)) {
        resolvePending(id, { outcome: { outcome: 'cancelled' } });
      }
      // Publish `session_died` BEFORE closing the bus. After the eager
      // `byId.delete` above, the channel.exited handler's
      // `byId.get(...)` returns undefined so the automatic publish
      // at crash time wouldn't fire. SSE subscribers need this
      // terminal frame to know the session is gone.
      try {
        entry.events.publish({
          type: 'session_died',
          data: { sessionId, reason: 'killed' },
        });
      } catch {
        /* bus already closed */
      }
      entry.events.close();
      // Only kill the channel when no other sessions remain AND no
      // restore is in flight. ACP doesn't expose a per-session "close"
      // call on the agent side, so the agent's `sessions: Map<string,
      // Session>` grows by one until the channel dies — bounded by
      // `maxSessions` (default 20) so memory is capped. FIXME(stage-
      // 1.5): if ACP grows a `closeSession` notification, send it
      // here so the agent can drop the entry from its map immediately
      // rather than at channel exit. (`channelInfo` itself is cleared
      // by the `channel.exited` handler once the OS reaps the child —
      // tanzhenxin BkUyD invariant.)
      //
      // `pendingRestoreIds` covers in-flight `session/load` and
      // `session/resume` calls that haven't yet registered into
      // `sessionIds`. Killing the channel out from under them would
      // SIGTERM the restore mid-flight and 500 the caller for a
      // failure orthogonal to their request.
      if (ci && ci.sessionIds.size === 0 && ci.pendingRestoreIds.size === 0) {
        // Mark dying SYNCHRONOUSLY before the await so a concurrent
        // `spawnOrAttach` arriving during the SIGTERM grace window
        // doesn't attach to a transport we're tearing down — without
        // this it would land the caller with a sessionId that 404s on
        // every follow-up once `channel.exited` fires (the equivalent
        // of the pre-PR eager `byWorkspaceChannel.delete()` from the
        // Stage 1 routing era). `channelInfo` stays set until OS reap
        // so `killAllSync` still finds a target (BkUyD).
        ci.isDying = true;
        await ci.channel.kill().catch(() => {
          // Best-effort kill — channel may already be dead.
        });
      }
    },

    async detachClient(sessionId, clientId) {
      // tanzhenxin issue 2: the BQ9tV `attachCount` race guard is
      // monotonic — once any attach bumps it, the spawn-owner's
      // disconnect-reaper becomes a permanent no-op even if the
      // attaching client itself disconnected. This is the symmetric
      // rollback the server's `!res.writable && session.attached`
      // path calls into.
      //
      // BkwQP: detachClient ONLY decrements; it does NOT reap on
      // its own. Reaping is the spawn-owner's responsibility, and
      // the spawn owner's `killSession({ requireZeroAttaches: true })`
      // sets `spawnOwnerWantedKill` if they had to bail because we
      // already had `attachCount > 0`. Only when that tombstone is
      // set do we complete the deferred reap from here. Without
      // this restraint, a transient attach disconnecting would
      // reap a still-valid session whose spawn owner is alive but
      // hasn't opened SSE yet.
      const entry = byId.get(sessionId);
      if (!entry) return;
      if (entry.attachCount > 0) entry.attachCount--;
      unregisterClient(entry, clientId);
      if (
        entry.spawnOwnerWantedKill &&
        entry.attachCount === 0 &&
        entry.events.subscriberCount === 0
      ) {
        // Defer-completed reap. Re-use killSession's logic; pass
        // `requireZeroAttaches: false` (default) because we've
        // already validated all the conditions ourselves.
        await this.killSession(sessionId).catch(() => {
          /* best-effort; channel.exited will eventually reap anyway */
        });
      }
    },

    killAllSync() {
      // Bd1y6: synchronous best-effort SIGKILL on EVERY alive channel
      // (typically 1, but during a `killSession`-then-`spawnOrAttach`
      // overlap there can be 2 — the dying one in `aliveChannels`
      // plus a fresh attach-target in `channelInfo`). Set
      // `shuttingDown` so any racing async path fails fast.
      //
      // tanzhenxin BkUyD: iterate `aliveChannels` (the OS-level "still
      // alive" source of truth) — `channelInfo` only points at the
      // CURRENT attach target, missing any dying channel whose
      // `channel.exited` hasn't fired yet. Without this, a fresh
      // spawn overwriting `channelInfo` during the prior channel's
      // SIGTERM grace would leave the dying child without SIGKILL
      // escalation when `process.exit(1)` fires.
      shuttingDown = true;
      const channels = Array.from(aliveChannels);
      defaultEntry = undefined;
      byId.clear();
      for (const info of channels) {
        try {
          info.channel.killSync();
        } catch {
          /* best-effort — already-dead child / pid race */
        }
      }
    },

    async shutdown() {
      // Set BEFORE the snapshot so any racing `spawnOrAttach` triggered
      // by an in-flight HTTP connection after `runQwenServe.close()`
      // entered the bridge.shutdown() phase fails fast instead of
      // spawning a child this teardown won't see.
      shuttingDown = true;
      const entries = Array.from(byId.values());
      // Snapshot every alive channel (typically 1; up to 2 during a
      // `killSession`-then-`spawnOrAttach` overlap) — entries are
      // intentionally NOT removed from `aliveChannels` here; their
      // `channel.exited` handlers clear them once the OS has reaped
      // each child. That preserves the BkUyD invariant: a
      // double-Ctrl+C arriving mid-SIGTERM-grace can still find every
      // alive channel via `killAllSync`. Marking each `isDying` makes
      // them invisible to any racing `ensureChannel` call — but
      // `shuttingDown` already blocks new `spawnOrAttach` upstream,
      // so this is mostly belt-and-suspenders (a direct internal
      // `ensureChannel` past the gate would still see the dying
      // state and not attach).
      const channels = Array.from(aliveChannels);
      for (const ci of channels) ci.isDying = true;
      // Resolve every still-pending permission as cancelled before clearing
      // the maps so callers awaiting `requestPermission` unwind cleanly.
      for (const e of entries) {
        const ids = Array.from(e.pendingPermissionIds);
        for (const id of ids) {
          resolvePending(id, { outcome: { outcome: 'cancelled' } });
        }
      }
      defaultEntry = undefined;
      byId.clear();
      pendingPermissions.clear();
      // Publish a terminal `session_died` BEFORE closing each bus so SSE
      // subscribers can distinguish "daemon shut down" from a transient
      // network error and don't sit indefinitely retrying. The
      // channel.exited handler also publishes this on a child crash,
      // but at shutdown time the entry has already been removed from
      // `byId` (above), so the handler's `byId.get(...)` is undefined
      // and the automatic publish wouldn't fire.
      for (const e of entries) {
        try {
          e.events.publish({
            type: 'session_died',
            data: { sessionId: e.sessionId, reason: 'daemon_shutdown' },
          });
        } catch {
          /* bus already closed */
        }
        e.events.close();
      }
      // Wait for in-flight channel + session spawns. The snapshot
      // above only sees what's already registered; a doSpawn past
      // `newSession()` but pre-`byId.set` is missed, as is an
      // `ensureChannel` past `channelFactory()` but pre-`channelInfo
      // = info`. The late-shutdown re-checks at doSpawn/ensureChannel
      // catch both — but without these awaits, `bridge.shutdown()`
      // would resolve before they finish, and the orphan stderr
      // error from a half-built child would fire AFTER the daemon
      // claimed graceful shutdown (log-confusing).
      const inFlightSessionAwaits = Array.from(inFlightSpawns.values()).map(
        (p): Promise<void> =>
          p.then(
            () => undefined,
            () => undefined,
          ),
      );
      const inFlightRestoreAwaits = Array.from(inFlightRestores.values()).map(
        (restore): Promise<void> =>
          restore.promise.then(
            () => undefined,
            () => undefined,
          ),
      );
      const inFlightChannelAwait: Promise<void> = inFlightChannelSpawn
        ? inFlightChannelSpawn.then(
            () => undefined,
            () => undefined,
          )
        : Promise.resolve();
      await Promise.all([
        ...channels.map((ci) => ci.channel.kill().catch(() => {})),
        ...inFlightSessionAwaits,
        ...inFlightRestoreAwaits,
        inFlightChannelAwait,
      ]);
    },
  };
}

/**
 * Human-readable label for a `fs.Stats` object's kind, used in the
 * `readTextFile` "not a regular file" rejection message (BX8YO).
 * Sockets, pipes, char-devices etc. all report `size: 0` but stream
 * unbounded data; the operator wants to know which one they hit so
 * the path-mistake is obvious.
 */
function describeStatKind(stats: import('node:fs').Stats): string {
  if (stats.isDirectory()) return 'directory';
  if (stats.isSymbolicLink()) return 'symlink';
  if (stats.isCharacterDevice()) return 'character device';
  if (stats.isBlockDevice()) return 'block device';
  if (stats.isFIFO()) return 'named pipe (FIFO)';
  if (stats.isSocket()) return 'socket';
  return 'non-regular file';
}

/**
 * Extract the line range `[startLine, endLine)` (0-based) from a string
 * without allocating a per-line array. Equivalent to
 * `content.split('\n').slice(startLine, endLine).join('\n')` but
 * O(file size) string scan rather than O(file size) string + O(line
 * count) array. Matters for the partial-read path of `readTextFile`
 * where the limit is small and the file is large.
 */
function sliceLineRange(
  content: string,
  startLine: number,
  endLine: number | undefined,
): string {
  // Find the byte offset where line `startLine` begins.
  let offset = 0;
  for (let i = 0; i < startLine; i++) {
    const nl = content.indexOf('\n', offset);
    if (nl === -1) return '';
    offset = nl + 1;
  }
  if (endLine === undefined) return content.slice(offset);
  // Walk `endLine - startLine` newlines forward to find the end byte.
  let end = offset;
  const want = endLine - startLine;
  for (let i = 0; i < want; i++) {
    const nl = content.indexOf('\n', end);
    if (nl === -1) return content.slice(offset);
    end = nl + 1;
  }
  // Trim the trailing `\n` so the slice mirrors `lines.slice(...).join('\n')`.
  return content.slice(offset, end > offset ? end - 1 : end);
}

/**
 * Re-export of the workspace canonicalizer for callers that historically
 * imported it from `httpAcpBridge.ts`. The implementation was extracted
 * to `./fs/paths.ts` in #4175 PR 18 (commit 1) so the forthcoming
 * `WorkspaceFileSystem` boundary can reuse the same primitive without
 * pulling in the 3.6k-line bridge module. See `./fs/paths.ts` for the
 * cross-module contract that governs this function.
 */
export { canonicalizeWorkspace };

/**
 * Race `p` against a timeout. The timeout REJECTS the returned
 * promise but does NOT abort the underlying operation — `p` keeps
 * running to completion (or its own failure) and its eventual
 * resolution is silently dropped.
 *
 * Stage 1 limitation: for `unstable_setSessionModel` the agent may
 * complete the model switch AFTER we surfaced the timeout to the
 * HTTP caller, leading to drift between caller's perceived model
 * and agent's actual model. Subscribers also see contradictory
 * SSE events (`model_switch_failed` from the timeout, then a late
 * `model_switched` if the agent succeeds). Acceptable for Stage 1
 * because:
 *   1. ACP's `unstable_setSessionModel` doesn't accept a cancel
 *      signal yet (the SDK's `prompt` does, hence `sendPrompt`'s
 *      explicit `cancel` notification on abort).
 *   2. Model switches complete in milliseconds in practice; a
 *      timeout firing means the agent is genuinely wedged, not
 *      just slow, and would have been DOA anyway.
 * Stage 2 will add abort plumbing once ACP exposes a cancel hook
 * for `unstable_setSessionModel`. Tracked in the model-change
 * concurrency notes in `applyModelServiceId`. BSA0C suggested a
 * `modelSwitchTimedOut` flag + `model_switch_late_success`
 * synthetic frame for full observability of the divergent state;
 * recorded as a Stage 2 follow-up so the timeout/late-success
 * handshake is implemented once across both ACP-side cancel and
 * the bridge-side state flag (rather than just papering over the
 * symptom).
 */
async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutP = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`HttpAcpBridge ${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([p, timeoutP]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Default channel factory: spawn the current Node executable running this
 * CLI's entry script in `--acp` mode. `process.argv[1]` resolves to the qwen
 * entry script when launched via the `qwen` bin shim.
 *
 * Note on `cwd`: CodeQL flags the `workspaceCwd` flow into `spawn({cwd})`
 * as an "uncontrolled data used in path expression" finding. That's the
 * Stage 1 trust model speaking — the caller (a token-authenticated HTTP
 * client) is treated as an extension of the operator. The agent already
 * runs as the same UID with shell-tool access, so restricting the spawn
 * cwd to a sandbox here would be theatre. Stage 4+ remote-sandbox swaps
 * this factory for a sandbox-aware variant; see issue #3803 §11.
 */
export const defaultSpawnChannelFactory: ChannelFactory = async (
  workspaceCwd,
) => {
  // Resolution order:
  //   1. `QWEN_CLI_ENTRY` env override — escape hatch for non-standard
  //      launch paths (bundled binaries, npx wrappers, `node -e`,
  //      `tsx ./src/...`, custom shims, container images that
  //      relocate the entry script). Anyone hitting "process.argv[1]
  //      is empty" or "process.argv[1] points at the wrong file" can
  //      set this without code changes.
  //   2. `process.argv[1]` — works when launched via the `qwen` bin
  //      shim, which is the common path.
  // Fail loudly with an actionable error if neither resolves.
  const cliEntry = process.env['QWEN_CLI_ENTRY'] || process.argv[1];
  if (!cliEntry) {
    throw new Error(
      'Cannot determine CLI entry path for spawning the ACP child: ' +
        'process.argv[1] is empty and QWEN_CLI_ENTRY is unset. ' +
        'Set QWEN_CLI_ENTRY to the absolute path of the qwen entry ' +
        'script (e.g. `export QWEN_CLI_ENTRY=$(which qwen)`) to override.',
    );
  }
  // Each session takes ~3 file descriptors (stdin/stdout/stderr) for the
  // child plus a few sockets. Operators running many concurrent sessions
  // should bump `ulimit -n` accordingly. Stage 1 doesn't pre-flight FD
  // headroom — Stage 2 in-process drops the per-session FD cost entirely.
  // Child stderr is piped (NOT `inherit`ed) so we can prefix each
  // line with `[serve pid=… cwd=…]` before forwarding to the
  // daemon's stderr — see the prefix-and-forward loop below the
  // `spawn(...)` call. Sessions are still interleaved on the
  // daemon's stderr stream but each line carries its own session
  // identifier, so operators can `grep pid=12345` to pull one
  // session's trace cleanly. Stage 4+ remote sandboxes will isolate
  // stderr at the transport level.
  //
  // Note: spawning `process.execPath` only works when the entry script can
  // be loaded by raw Node. In dev (e.g. `npm run dev` via `tsx`) the entry
  // is a `.ts` file Node can't run; users should `npm run build` before
  // `qwen serve` or set `process.execPath` to a tsx-aware shim. Stage 1
  // accepts this — the daemon is meant for built deployments.
  // Pass through the daemon's full environment to the child, scrubbing
  // ONLY daemon-internal secrets (see SCRUBBED_CHILD_ENV_KEYS at module
  // scope). An earlier version used an allowlist, but that broke the
  // common deployment shape: users export `OPENAI_API_KEY` /
  // `ANTHROPIC_API_KEY` / `QWEN_*` / `DASHSCOPE_API_KEY` / a custom
  // `modelProviders[].envKey` to authenticate the agent's LLM calls,
  // and core's model config resolves those from `process.env`. An
  // exhaustive allowlist can't enumerate user-defined provider keys,
  // so the agent ends up unable to authenticate.
  //
  // Threat-model rationale: the agent already runs as the same UID
  // with shell-tool access — anything in `~/.bashrc`, `~/.npmrc`,
  // `~/.aws/credentials`, etc. is reachable by prompt injection
  // regardless of what we put in `env`. The env passthrough is not
  // the security boundary; the user-as-trust-root is. The only thing
  // we MUST scrub is `QWEN_SERVER_TOKEN` (daemon-only auth that
  // would let a prompt-injected shell turn the agent into an
  // authenticated client of its own daemon — escalation the agent
  // doesn't otherwise have).
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of SCRUBBED_CHILD_ENV_KEYS) {
    delete childEnv[key];
  }
  // CodeQL `js/path-injection` flags the `cwd: workspaceCwd` flow.
  // Stage 1 trust model accepts this — see the function-level comment
  // above for the design rationale. Defense-in-depth: the cwd is
  // canonicalized via `path.resolve()` upstream in `spawnOrAttach`,
  // and `spawn`'s `cwd` only changes the child's working directory,
  // it doesn't pass through any shell.
  //
  // NOTE: GitHub Code Scanning does NOT honor inline `// lgtm` /
  // `// codeql` annotations (LGTM.com retired in 2021). Suppressing
  // this alert requires either (a) UI dismissal as "won't fix" with
  // the rationale above, or (b) a repo-level
  // `.github/codeql/codeql-config.yml` query exclusion. Both are
  // out of scope for a code-only PR; flagging here for the human
  // reviewer.
  const child = spawn(process.execPath, [cliEntry, '--acp'], {
    cwd: workspaceCwd,
    // Pipe stderr (was: 'inherit') so we can prefix each line with
    // the spawn's pid + workspace, making per-session crash output
    // attributable. Bare 'inherit' sends every child's stderr to
    // the daemon's stderr verbatim and unprefixed — under any
    // multi-session load the operator's log becomes a salad of
    // unattributed traces.
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnv,
  });

  // Forward child stderr to the daemon's stderr line-by-line, with a
  // `[serve pid=… cwd=…]` prefix on each line so operators can
  // correlate stack traces back to the spawning request. Best-effort:
  // a child that prints partial lines without a trailing newline is
  // flushed when the stream emits `end`.
  if (child.stderr) {
    let buf = '';
    const prefix = `[serve pid=${child.pid} cwd=${workspaceCwd}] `;
    // BRAp3 cap: a buggy child that writes a huge stderr line, or
    // never emits `\n`, would otherwise grow `buf` per spawn
    // unboundedly. 64 KiB is generous for the longest legitimate
    // stack trace line we'd expect from a Node child; anything
    // past that gets force-flushed with a `[truncated]` marker so
    // the operator still sees a prefix-attributed log line and
    // memory stays bounded. We DON'T drop content — we flush
    // chunks at the cap. (Picking 64 KiB matches our SSE per-frame
    // write budget; anything above this already implies the child
    // is misbehaving.)
    const STDERR_LINE_CAP_CHARS = 64 * 1024;
    const flush = (line: string) => {
      if (line.length > 0) process.stderr.write(prefix + line + '\n');
    };
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      buf += chunk;
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        flush(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
      }
      // Force-flush the unterminated tail if it's grown past the cap
      // — keeps memory bounded against a `\n`-less stderr storm.
      while (buf.length > STDERR_LINE_CAP_CHARS) {
        flush(buf.slice(0, STDERR_LINE_CAP_CHARS) + ' [truncated]');
        buf = buf.slice(STDERR_LINE_CAP_CHARS);
      }
    });
    child.stderr.on('end', () => {
      if (buf.length > 0) flush(buf);
    });
    child.stderr.on('error', () => {
      // Don't crash the daemon if the pipe breaks; the child is
      // already gone or about to be.
    });
  }

  // Build the `exited` promise BEFORE checking stdin/stdout so the listener
  // is in place before any error event can fire. We treat both `exit` and
  // `error` as termination — without an `error` listener Node would treat
  // an async spawn failure (ENOMEM, EACCES, …) as an unhandled error and
  // crash the whole daemon.
  const exited = new Promise<AcpChannelExitInfo | undefined>((resolve) => {
    let resolved = false;
    const finish = (info?: AcpChannelExitInfo) => {
      if (resolved) return;
      resolved = true;
      resolve(info);
    };
    child.once('exit', (code, signal) =>
      finish({ exitCode: code, signalCode: signal }),
    );
    child.once('error', () => finish(undefined));
  });

  if (!child.stdin || !child.stdout) {
    child.kill('SIGKILL');
    throw new Error(
      'Spawned ACP child has no stdin/stdout — cannot establish NDJSON channel.',
    );
  }

  const writable = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
  const readable = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(writable, readable);

  return {
    stream,
    kill: () => killChild(child),
    killSync: () => {
      // Bd1y6: synchronous SIGKILL for the double-signal force-exit
      // path. Skip if child already exited (kill on a dead process
      // raises an OS-level error that's noise here).
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already dead / pid recycled — ignore */
        }
      }
    },
    exited,
  };
};

const KILL_HARD_DEADLINE_MS = 10_000;

/**
 * Environment variables stripped from the spawned `qwen --acp` child's
 * environment. Everything else is passed through — see the
 * threat-model rationale at the call site in `defaultSpawnChannelFactory`.
 *
 * Currently just `QWEN_SERVER_TOKEN`: the daemon's own bearer token,
 * which the agent doesn't need (it speaks to the daemon over stdio,
 * not HTTP). Leaving it in the child's env would let prompt injection
 * turn the agent into an authenticated client of its own daemon — an
 * escalation the agent doesn't otherwise have.
 *
 * **WARNING**: this denylist is correct *only because the agent
 * already has unrestricted shell-tool access* — anything in the env
 * is reachable via `~/.bashrc`/`~/.aws/credentials`/etc. anyway.
 * Any future mode that **removes** shell-tool access (e.g. a
 * sandbox-locked agent variant) MUST switch this back to an
 * allowlist OR significantly expand the denylist to cover common
 * provider/CI/cloud secret prefixes (`OPENAI_*`, `ANTHROPIC_*`,
 * `AWS_*`, `GITHUB_TOKEN`, `CI_*`, `*_API_KEY`, `*_SECRET`, …).
 * See issue #3803 §11 for the Stage 4+ remote-sandbox plan.
 *
 * Defined at module scope so the Set is allocated once at load.
 */
const SCRUBBED_CHILD_ENV_KEYS: ReadonlySet<string> = new Set([
  'QWEN_SERVER_TOKEN',
]);

function killChild(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      child.removeListener('exit', finish);
      resolve();
    };
    child.once('exit', finish);
    try {
      child.kill('SIGTERM');
    } catch {
      finish();
      return;
    }
    setTimeout(() => {
      if (!resolved && child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* swallow */
        }
      }
    }, 5_000).unref();
    // Even SIGKILL doesn't return if the child is in uninterruptible
    // sleep (D-state, e.g. NFS read blocked on a dead server). Without
    // this hard deadline, `bridge.shutdown()`'s `Promise.all` waits
    // forever on that one wedged child and SHUTDOWN_FORCE_CLOSE_MS in
    // `runQwenServe` only covers `server.close()`, not the bridge.
    // After the deadline give up: the child is probably stuck in a
    // kernel call we can't cancel, and `process.exit(0)` will reap it
    // when the daemon returns to its caller.
    setTimeout(() => {
      if (!resolved) finish();
    }, KILL_HARD_DEADLINE_MS).unref();
  });
}
