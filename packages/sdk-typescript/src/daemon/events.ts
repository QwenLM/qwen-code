/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  DaemonEvent,
  DaemonMcpTransport,
  PermissionOutcome,
} from './types.js';

const DAEMON_KNOWN_EVENT_TYPE_VALUES = [
  'session_update',
  'permission_request',
  'permission_resolved',
  'permission_already_resolved',
  'model_switched',
  'model_switch_failed',
  'session_died',
  'session_closed',
  'session_metadata_updated',
  'client_evicted',
  'slow_client_warning',
  'stream_error',
  // PR 14b — MCP guardrail push events. See `mcp_guardrail_events`
  // capability tag. Both fire on the per-session SSE bus; consumers
  // should pre-flight `caps.features.includes('mcp_guardrail_events')`
  // before relying on these for non-snapshot UX (the `GET /workspace/mcp`
  // snapshot still encodes the same state).
  'mcp_budget_warning',
  'mcp_child_refused_batch',
  // Issue #4175 PR 16: workspace-level mutation signals fanned out
  // through every active session's bus. Non-terminal — informational
  // for adapters that want to render "memory just changed" / "agent X
  // updated" toasts. Read-after-write remains the correctness contract.
  'memory_changed',
  'agent_changed',
  // Issue #4175 PR 21 — workspace-scoped auth device-flow events.
  // These are NOT session-keyed; the session reducer no-ops on them
  // and `reduceDaemonAuthEvent` projects them into a workspace-level
  // state shape (one entry per provider).
  'auth_device_flow_started',
  'auth_device_flow_throttled',
  'auth_device_flow_authorized',
  'auth_device_flow_failed',
  'auth_device_flow_cancelled',
  // #4175 Wave 4 PR 17 — mutation control events.
  'approval_mode_changed',
  'tool_toggled',
  'workspace_initialized',
  'mcp_server_restarted',
  'mcp_server_restart_refused',
  'session_rewound',
] as const;

const DAEMON_KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set<string>(
  DAEMON_KNOWN_EVENT_TYPE_VALUES,
);

const MAX_PENDING_PER_SESSION = 64;

export type DaemonKnownEventType =
  (typeof DAEMON_KNOWN_EVENT_TYPE_VALUES)[number];

export interface DaemonEventEnvelope<TType extends string, TData>
  extends Omit<DaemonEvent, 'type' | 'data'> {
  type: TType;
  data: TData;
}

export type DaemonSessionUpdateData = Record<string, unknown>;

export interface DaemonPermissionOption {
  optionId: string;
  [key: string]: unknown;
}

export interface DaemonPermissionRequestData {
  requestId: string;
  sessionId: string;
  toolCall: unknown;
  options: DaemonPermissionOption[];
  [key: string]: unknown;
}

export interface DaemonPermissionResolvedData {
  requestId: string;
  outcome: PermissionOutcome;
  [key: string]: unknown;
}

export interface DaemonPermissionAlreadyResolvedData {
  requestId: string;
  sessionId: string;
  outcome: PermissionOutcome;
  [key: string]: unknown;
}

export interface DaemonModelSwitchedData {
  sessionId: string;
  modelId: string;
  [key: string]: unknown;
}

export interface DaemonModelSwitchFailedData {
  sessionId: string;
  requestedModelId: string;
  error: string;
  [key: string]: unknown;
}

export interface DaemonSessionDiedData {
  sessionId: string;
  reason: string;
  exitCode?: number | null;
  signalCode?: string | null;
  [key: string]: unknown;
}

export type DaemonSessionClosedReason = 'client_close' | (string & {});

export interface DaemonSessionClosedData {
  sessionId: string;
  reason: DaemonSessionClosedReason;
  closedBy?: string;
  [key: string]: unknown;
}

export interface DaemonSessionMetadataUpdatedData {
  sessionId: string;
  displayName?: string;
  [key: string]: unknown;
}

export interface DaemonClientEvictedData {
  reason: string;
  droppedAfter?: number;
  [key: string]: unknown;
}

export interface DaemonSlowClientWarningData {
  /** Live (non-replay) items currently queued for this subscriber. */
  queueSize: number;
  /** Per-subscriber backlog cap that triggered the warning. */
  maxQueued: number;
  /**
   * Most recent monotonic event id observed by the bus at warning
   * time. Lets the client decide whether to reconnect with a
   * `Last-Event-ID` or detach + drain.
   */
  lastEventId: number;
  [key: string]: unknown;
}

export interface DaemonStreamErrorData {
  error: string;
  [key: string]: unknown;
}

/**
 * PR 14b: payload for the `mcp_budget_warning` SSE frame. Fired on the
 * upward 75% crossing of `reservedSlots.size / clientBudget`. Re-arms
 * only after the ratio drops below 37.5% — so a budget that flaps just
 * above the threshold doesn't produce a flood of identical warnings.
 *
 * `liveCount` (CONNECTED clients) and `reservedCount` (configured set,
 * including in-flight reservations) are exposed separately so SDK
 * consumers can render either lens. The snapshot (`GET /workspace/mcp`)
 * is the source of truth for state-after-reconnect; this event is the
 * change-edge.
 *
 * `mode` is `'warn' | 'enforce'` because the warning fires in either
 * mode (only `'off'` skips the state machine entirely).
 */
export interface DaemonMcpBudgetWarningData {
  liveCount: number;
  reservedCount: number;
  budget: number;
  thresholdRatio: 0.75;
  mode: 'warn' | 'enforce';
  [key: string]: unknown;
}

/**
 * PR 14b: per-server entry inside a `mcp_child_refused_batch` payload.
 * `transport` is the family resolved at refusal time via the daemon's
 * `mcpTransportOf` helper; future refusal causes (Wave 5+) would
 * extend `reason` beyond `'budget_exhausted'`.
 */
export interface DaemonMcpRefusedServer {
  name: string;
  transport: DaemonMcpTransport;
  reason: 'budget_exhausted';
  [key: string]: unknown;
}

/**
 * PR 14b: payload for the `mcp_child_refused_batch` SSE frame. Fires
 * once per `discoverAllMcpTools*` pass when at least one server was
 * refused, OR as a length-1 batch on the `readResource` lazy-spawn
 * refusal path. `mode` is the literal `'enforce'` because `warn` mode
 * never refuses (so this event never fires under `warn`).
 */
export interface DaemonMcpChildRefusedBatchData {
  refusedServers: DaemonMcpRefusedServer[];
  budget: number;
  liveCount: number;
  reservedCount: number;
  mode: 'enforce';
  [key: string]: unknown;
}

/**
 * Issue #4175 PR 16: a `POST /workspace/memory` write completed
 * successfully. `scope` records which file was touched (workspace QWEN.md
 * vs global ~/.qwen/QWEN.md), `mode` is the requested write mode, and
 * `bytesWritten` is the size of the file post-write.
 */
export interface DaemonMemoryChangedData {
  scope: 'workspace' | 'global';
  filePath: string;
  mode: 'append' | 'replace';
  bytesWritten: number;
  [key: string]: unknown;
}

/**
 * Issue #4175 PR 16: a workspace agent CRUD mutation completed
 * successfully. `change` discriminates the operation; `level` records
 * whether the project- or user-level definition was touched. Built-in
 * and extension agents are read-only and never appear here.
 */
export interface DaemonAgentChangedData {
  change: 'created' | 'updated' | 'deleted';
  name: string;
  level: 'project' | 'user';
  [key: string]: unknown;
}

/** Issue #4175 PR 21 — auth device-flow event payloads. */

/** Provider id. Open string union for forward-compatible providers; `qwen-oauth`
 *  is the only value v1 currently emits. */
export type DaemonAuthDeviceFlowProviderId = 'qwen-oauth' | (string & {});

export type DaemonAuthDeviceFlowStatus =
  | 'pending'
  | 'authorized'
  | 'expired'
  | 'error'
  | 'cancelled';

/**
 * Known errorKind values surfaced on `auth_device_flow_failed`. The
 * trailing `(string & {})` keeps this as an OPEN union so a daemon
 * adding a new errorKind doesn't get its event silently dropped by an
 * older SDK's type guard — consumers branching exhaustively on the
 * known literals get the same narrowing as before, while unknown
 * future kinds fall through to a `string` fallback rather than failing
 * `isAuthDeviceFlowFailedData` and being filtered out by
 * `asKnownDaemonEvent` (PR #4255 review C2).
 */
export type DaemonAuthDeviceFlowErrorKind =
  | 'expired_token'
  | 'access_denied'
  | 'invalid_grant'
  | 'upstream_error'
  /** Disk-write / `provider.persist()` failure path. The IdP-side token
   *  exchange succeeded but the daemon couldn't durably store credentials
   *  (EACCES, EROFS, ENOSPC, etc.). Distinct from `upstream_error`. */
  | 'persist_failed'
  /** SDK-synthesized when the daemon's GET returns 404 inside
   *  `DaemonAuthFlow.awaitCompletion`. Surfaced from `getDeviceFlowOrSynthetic404`
   *  rather than the daemon — three reachable causes: (a) the flow expired
   *  past the 5-min terminal grace window and the sweeper reaped it, (b) the
   *  daemon was restarted and lost the in-memory registry, (c) the
   *  `deviceFlowId` was wrong / spoofed. PR #4255 follow-up review thread
   *  (deepseek-v4-pro): added to the typed union so SDK consumers' exhaustive
   *  switches narrow it as a known literal instead of falling into the
   *  `(string & {})` fallback arm. */
  | 'not_found_or_evicted'
  | (string & {});

export interface DaemonAuthDeviceFlowStartedData {
  deviceFlowId: string;
  providerId: DaemonAuthDeviceFlowProviderId;
  /** Daemon-clock epoch ms when the flow's `device_code` expires. */
  expiresAt: number;
  [key: string]: unknown;
}

export interface DaemonAuthDeviceFlowThrottledData {
  deviceFlowId: string;
  /** Bumped polling interval after the daemon honored an upstream `slow_down`. */
  intervalMs: number;
  [key: string]: unknown;
}

export interface DaemonAuthDeviceFlowAuthorizedData {
  deviceFlowId: string;
  providerId: DaemonAuthDeviceFlowProviderId;
  /** Credential expiry, daemon clock. Undefined when the IdP omitted `expires_in`. */
  expiresAt?: number;
  /** Best-effort non-PII account label (nickname / uid hash); never email/phone. */
  accountAlias?: string;
  [key: string]: unknown;
}

export interface DaemonAuthDeviceFlowFailedData {
  deviceFlowId: string;
  errorKind: DaemonAuthDeviceFlowErrorKind;
  hint?: string;
  [key: string]: unknown;
}

export interface DaemonAuthDeviceFlowCancelledData {
  deviceFlowId: string;
  [key: string]: unknown;
}

/**
 * #4175 Wave 4 PR 17. Fired after `POST /session/:id/approval-mode`
 * successfully changes a live session's approval mode. `persisted`
 * reflects whether the change was also written to workspace settings
 * (set via the route's optional `persist: true` body flag).
 *
 * `previous` and `next` are typed as `string` here rather than the
 * `DaemonApprovalMode` union so SDK consumers built against an older
 * daemon don't crash on a future fifth mode literal — the daemon-side
 * enum is the source of truth and SDK reducers should branch on the
 * known values they care about.
 */
export interface DaemonApprovalModeChangedData {
  sessionId: string;
  previous: string;
  next: string;
  persisted: boolean;
  originatorClientId?: string;
  [key: string]: unknown;
}

/**
 * #4175 Wave 4 PR 17. Workspace-scoped: fan-outs to every active
 * session SSE bus when `POST /workspace/tools/:name/enable` mutates
 * the workspace `tools.disabled` settings list. The event is emitted
 * regardless of whether the tool is currently registered — it
 * communicates intent, not registry state. Live sessions retain
 * already-registered tools; the toggle takes effect on the next ACP
 * child spawn or `ToolRegistry.refresh()`.
 */
export interface DaemonToolToggledData {
  toolName: string;
  enabled: boolean;
  originatorClientId?: string;
  [key: string]: unknown;
}

/**
 * #4175 Wave 4 PR 17. Workspace-scoped: fan-outs to every active
 * session SSE bus when `POST /workspace/init` is invoked. The
 * `action` field discriminates between three outcomes:
 *
 * - `'created'`: daemon wrote an empty file at the resolved path
 *   (target did not exist).
 * - `'overwrote'`: daemon truncated an existing non-whitespace file
 *   under `force: true`.
 * - `'noop'`: daemon left an existing whitespace-only file alone
 *   (no on-disk change). Still fan-outs the event so cross-client
 *   UIs can render an "init was attempted" hint without polling.
 *
 * The `path` is absolute on the daemon host filesystem (see
 * runtime-locality contract).
 */
export interface DaemonWorkspaceInitializedData {
  path: string;
  action: 'created' | 'overwrote' | 'noop';
  originatorClientId?: string;
  [key: string]: unknown;
}

/**
 * #4175 Wave 4 PR 17. Workspace-scoped: fired when
 * `POST /workspace/mcp/:server/restart` successfully reconnected and
 * rediscovered the named MCP server. `durationMs` measures the full
 * disconnect+reconnect+rediscover sequence on the ACP-child side.
 */
export interface DaemonMcpServerRestartedData {
  serverName: string;
  durationMs: number;
  originatorClientId?: string;
  [key: string]: unknown;
}

/**
 * #4175 Wave 4 PR 17. Workspace-scoped: fired when
 * `POST /workspace/mcp/:server/restart` was a soft skip
 * (`skipped: true`). `reason` is the same closed enum surfaced on
 * the route's response body, so SDK consumers can branch on a single
 * union when reconciling event-driven state with HTTP-call results.
 */
export interface DaemonMcpServerRestartRefusedData {
  serverName: string;
  reason: 'in_flight' | 'disabled' | 'budget_would_exceed';
  originatorClientId?: string;
  [key: string]: unknown;
}

export interface DaemonSessionRewoundData {
  sessionId: string;
  promptId: string;
  targetTurnIndex: number;
  filesChanged: string[];
  originatorClientId?: string;
  [key: string]: unknown;
}

export type DaemonSessionUpdateEvent = DaemonEventEnvelope<
  'session_update',
  DaemonSessionUpdateData
>;
export type DaemonPermissionRequestEvent = DaemonEventEnvelope<
  'permission_request',
  DaemonPermissionRequestData
>;
export type DaemonPermissionResolvedEvent = DaemonEventEnvelope<
  'permission_resolved',
  DaemonPermissionResolvedData
>;
export type DaemonPermissionAlreadyResolvedEvent = DaemonEventEnvelope<
  'permission_already_resolved',
  DaemonPermissionAlreadyResolvedData
>;
export type DaemonModelSwitchedEvent = DaemonEventEnvelope<
  'model_switched',
  DaemonModelSwitchedData
>;
export type DaemonModelSwitchFailedEvent = DaemonEventEnvelope<
  'model_switch_failed',
  DaemonModelSwitchFailedData
>;
export type DaemonSessionDiedEvent = DaemonEventEnvelope<
  'session_died',
  DaemonSessionDiedData
>;
export type DaemonSessionClosedEvent = DaemonEventEnvelope<
  'session_closed',
  DaemonSessionClosedData
>;
export type DaemonSessionMetadataUpdatedEvent = DaemonEventEnvelope<
  'session_metadata_updated',
  DaemonSessionMetadataUpdatedData
>;
export type DaemonClientEvictedEvent = DaemonEventEnvelope<
  'client_evicted',
  DaemonClientEvictedData
>;
export type DaemonSlowClientWarningEvent = DaemonEventEnvelope<
  'slow_client_warning',
  DaemonSlowClientWarningData
>;
export type DaemonStreamErrorEvent = DaemonEventEnvelope<
  'stream_error',
  DaemonStreamErrorData
>;
export type DaemonMcpBudgetWarningEvent = DaemonEventEnvelope<
  'mcp_budget_warning',
  DaemonMcpBudgetWarningData
>;
export type DaemonMcpChildRefusedBatchEvent = DaemonEventEnvelope<
  'mcp_child_refused_batch',
  DaemonMcpChildRefusedBatchData
>;
export type DaemonMemoryChangedEvent = DaemonEventEnvelope<
  'memory_changed',
  DaemonMemoryChangedData
>;
export type DaemonAgentChangedEvent = DaemonEventEnvelope<
  'agent_changed',
  DaemonAgentChangedData
>;
export type DaemonApprovalModeChangedEvent = DaemonEventEnvelope<
  'approval_mode_changed',
  DaemonApprovalModeChangedData
>;
export type DaemonToolToggledEvent = DaemonEventEnvelope<
  'tool_toggled',
  DaemonToolToggledData
>;
export type DaemonWorkspaceInitializedEvent = DaemonEventEnvelope<
  'workspace_initialized',
  DaemonWorkspaceInitializedData
>;
export type DaemonMcpServerRestartedEvent = DaemonEventEnvelope<
  'mcp_server_restarted',
  DaemonMcpServerRestartedData
>;
export type DaemonMcpServerRestartRefusedEvent = DaemonEventEnvelope<
  'mcp_server_restart_refused',
  DaemonMcpServerRestartRefusedData
>;
export type DaemonSessionRewoundEvent = DaemonEventEnvelope<
  'session_rewound',
  DaemonSessionRewoundData
>;

export type DaemonAuthDeviceFlowStartedEvent = DaemonEventEnvelope<
  'auth_device_flow_started',
  DaemonAuthDeviceFlowStartedData
>;
export type DaemonAuthDeviceFlowThrottledEvent = DaemonEventEnvelope<
  'auth_device_flow_throttled',
  DaemonAuthDeviceFlowThrottledData
>;
export type DaemonAuthDeviceFlowAuthorizedEvent = DaemonEventEnvelope<
  'auth_device_flow_authorized',
  DaemonAuthDeviceFlowAuthorizedData
>;
export type DaemonAuthDeviceFlowFailedEvent = DaemonEventEnvelope<
  'auth_device_flow_failed',
  DaemonAuthDeviceFlowFailedData
>;
export type DaemonAuthDeviceFlowCancelledEvent = DaemonEventEnvelope<
  'auth_device_flow_cancelled',
  DaemonAuthDeviceFlowCancelledData
>;

export type DaemonAuthEvent =
  | DaemonAuthDeviceFlowStartedEvent
  | DaemonAuthDeviceFlowThrottledEvent
  | DaemonAuthDeviceFlowAuthorizedEvent
  | DaemonAuthDeviceFlowFailedEvent
  | DaemonAuthDeviceFlowCancelledEvent;

export type DaemonSessionEvent =
  | DaemonSessionUpdateEvent
  | DaemonModelSwitchedEvent
  | DaemonModelSwitchFailedEvent
  | DaemonSessionDiedEvent
  | DaemonSessionClosedEvent
  | DaemonSessionMetadataUpdatedEvent;

export type DaemonControlEvent =
  | DaemonPermissionRequestEvent
  | DaemonPermissionResolvedEvent
  | DaemonPermissionAlreadyResolvedEvent
  | DaemonApprovalModeChangedEvent
  | DaemonToolToggledEvent
  | DaemonWorkspaceInitializedEvent
  | DaemonMcpServerRestartedEvent
  | DaemonMcpServerRestartRefusedEvent
  | DaemonSessionRewoundEvent;

export type DaemonStreamLifecycleEvent =
  | DaemonClientEvictedEvent
  | DaemonSlowClientWarningEvent
  | DaemonStreamErrorEvent;

/**
 * PR 14b: MCP guardrail push events. Grouped as their own union member
 * (rather than folded into `DaemonStreamLifecycleEvent`) because they
 * report McpClientManager state, not the SSE subscriber's queue health
 * or the daemon's stream lifecycle. Adapters that only care about
 * "is the stream alive" can ignore this whole branch.
 */
export type DaemonMcpGuardrailEvent =
  | DaemonMcpBudgetWarningEvent
  | DaemonMcpChildRefusedBatchEvent;

/**
 * Issue #4175 PR 16: workspace-level mutation signals fanned out
 * through every active session's bus. Non-terminal; clients use them
 * to refresh cached views of workspace memory / agents.
 */
export type DaemonWorkspaceMutationEvent =
  | DaemonMemoryChangedEvent
  | DaemonAgentChangedEvent;

export type KnownDaemonEvent =
  | DaemonSessionEvent
  | DaemonControlEvent
  | DaemonStreamLifecycleEvent
  | DaemonMcpGuardrailEvent
  | DaemonWorkspaceMutationEvent
  | DaemonAuthEvent;

export interface DaemonSessionViewState {
  lastEventId?: number;
  sessionId?: string;
  /**
   * False once this stream observes a terminal frame. For client_evicted and
   * stream_error this only describes the current stream, not the remote
   * daemon session's lifetime.
   */
  alive: boolean;
  currentModelId?: string;
  displayName?: string;
  pendingPermissions: Record<string, DaemonPermissionRequestData>;
  lastSessionUpdate?: DaemonSessionUpdateData;
  lastModelSwitchFailure?: DaemonModelSwitchFailedData;
  terminalEvent?:
    | DaemonSessionDiedEvent
    | DaemonSessionClosedEvent
    | DaemonClientEvictedEvent
    | DaemonStreamErrorEvent;
  streamError?: DaemonStreamErrorData;
  unrecognizedKnownEventCount: number;
  lastUnrecognizedKnownEvent?: DaemonEvent;
  droppedPermissionRequestCount: number;
  lastDroppedPermissionRequestId?: string;
  unmatchedPermissionResolutionCount: number;
  lastUnmatchedPermissionResolutionId?: string;
  /**
   * Count of `slow_client_warning` frames this stream has observed.
   * Non-terminal — warnings precede eviction but don't themselves
   * close the stream. Adapters tap this counter to surface "your
   * stream is lagging" UI before `client_evicted` arrives.
   */
  slowClientWarningCount: number;
  lastSlowClientWarning?: DaemonSlowClientWarningData;
  /**
   * PR 14b: count of `mcp_budget_warning` frames this stream has
   * observed. Non-terminal — warning fires on the upward 75% crossing
   * and re-arms below 37.5%, so a flapping budget produces at most
   * one warning per crossing episode. Adapters tap this counter to
   * surface MCP-pressure UI; the snapshot at `GET /workspace/mcp`
   * still carries the authoritative state-after-reconnect.
   */
  mcpBudgetWarningCount: number;
  lastMcpBudgetWarning?: DaemonMcpBudgetWarningData;
  /**
   * PR 14b: count of `mcp_child_refused_batch` frames this stream has
   * observed. Each frame is a single batch (per discovery pass, or
   * length-1 from `readResource`'s lazy-spawn refusal); the count
   * reflects batches not refused-server entries. Mirrors the
   * snapshot's `disabledReason: 'budget'` per-server tag.
   */
  mcpChildRefusedBatchCount: number;
  lastMcpChildRefusedBatch?: DaemonMcpChildRefusedBatchData;
  /**
   * Issue #4175 PR 16: most recent workspace mutation observed on this
   * stream (memory or agent change). Non-terminal — adapters render a
   * "memory just changed" / "agent X updated" toast and re-fetch the
   * relevant workspace status route. Captures only the latest event;
   * older events are not retained because the route's read-after-write
   * contract makes the event a hint, not the source of truth.
   */
  lastWorkspaceMutation?: DaemonMemoryChangedData | DaemonAgentChangedData;
  lastWorkspaceMutationType?: 'memory_changed' | 'agent_changed';
  /**
   * #4175 Wave 4 PR 17. The most recent approval-mode change observed
   * for this session, plus a count for diagnostic UIs that want to
   * render "approval mode toggled N times this session". Non-terminal.
   */
  approvalMode?: string;
  approvalModeChangedCount: number;
  lastApprovalModeChange?: DaemonApprovalModeChangedData;
  /**
   * #4175 Wave 4 PR 17. Workspace-scoped fan-out — every session bus
   * receives `tool_toggled` events so cross-session UIs can update
   * "this tool is disabled in the workspace" badges in real time.
   * Non-terminal.
   */
  toolToggleCount: number;
  lastToolToggle?: DaemonToolToggledData;
  /**
   * #4175 Wave 4 PR 17. Workspace-scoped — every session bus receives
   * `workspace_initialized` events. `lastWorkspaceInit` records the
   * most recent envelope so adapters can render a "QWEN.md was just
   * scaffolded by another client" notice without polling.
   */
  workspaceInitCount: number;
  lastWorkspaceInit?: DaemonWorkspaceInitializedData;
  /**
   * #4175 Wave 4 PR 17. Workspace-scoped MCP restart counters. Only
   * `mcp_server_restarted` increments `mcpRestartCount`; soft skips
   * (`mcp_server_restart_refused`) increment `mcpRestartRefusedCount`
   * separately so adapters can distinguish "the user kept hitting
   * restart but it's been refused" from "we've actually rotated the
   * server N times."
   */
  mcpRestartCount: number;
  lastMcpRestart?: DaemonMcpServerRestartedData;
  mcpRestartRefusedCount: number;
  lastMcpRestartRefused?: DaemonMcpServerRestartRefusedData;
  rewindCount: number;
  lastRewind?: DaemonSessionRewoundData;
}

export function createDaemonSessionViewState(
  seed: Partial<DaemonSessionViewState> = {},
): DaemonSessionViewState {
  return {
    alive: seed.alive ?? true,
    pendingPermissions: { ...seed.pendingPermissions },
    lastEventId: seed.lastEventId,
    sessionId: seed.sessionId,
    currentModelId: seed.currentModelId,
    displayName: seed.displayName,
    lastSessionUpdate: seed.lastSessionUpdate,
    lastModelSwitchFailure: seed.lastModelSwitchFailure,
    terminalEvent: seed.terminalEvent,
    streamError: seed.streamError,
    unrecognizedKnownEventCount: seed.unrecognizedKnownEventCount ?? 0,
    lastUnrecognizedKnownEvent: seed.lastUnrecognizedKnownEvent,
    droppedPermissionRequestCount: seed.droppedPermissionRequestCount ?? 0,
    lastDroppedPermissionRequestId: seed.lastDroppedPermissionRequestId,
    unmatchedPermissionResolutionCount:
      seed.unmatchedPermissionResolutionCount ?? 0,
    lastUnmatchedPermissionResolutionId:
      seed.lastUnmatchedPermissionResolutionId,
    slowClientWarningCount: seed.slowClientWarningCount ?? 0,
    lastSlowClientWarning: seed.lastSlowClientWarning,
    mcpBudgetWarningCount: seed.mcpBudgetWarningCount ?? 0,
    lastMcpBudgetWarning: seed.lastMcpBudgetWarning,
    mcpChildRefusedBatchCount: seed.mcpChildRefusedBatchCount ?? 0,
    lastMcpChildRefusedBatch: seed.lastMcpChildRefusedBatch,
    lastWorkspaceMutation: seed.lastWorkspaceMutation,
    lastWorkspaceMutationType: seed.lastWorkspaceMutationType,
    approvalMode: seed.approvalMode,
    approvalModeChangedCount: seed.approvalModeChangedCount ?? 0,
    lastApprovalModeChange: seed.lastApprovalModeChange,
    toolToggleCount: seed.toolToggleCount ?? 0,
    lastToolToggle: seed.lastToolToggle,
    workspaceInitCount: seed.workspaceInitCount ?? 0,
    lastWorkspaceInit: seed.lastWorkspaceInit,
    mcpRestartCount: seed.mcpRestartCount ?? 0,
    lastMcpRestart: seed.lastMcpRestart,
    mcpRestartRefusedCount: seed.mcpRestartRefusedCount ?? 0,
    lastMcpRestartRefused: seed.lastMcpRestartRefused,
    rewindCount: seed.rewindCount ?? 0,
    lastRewind: seed.lastRewind,
  };
}

export function isKnownDaemonEvent(
  event: DaemonEvent,
): event is KnownDaemonEvent {
  return asKnownDaemonEvent(event) !== undefined;
}

export function isDaemonEventType<TType extends KnownDaemonEvent['type']>(
  event: DaemonEvent,
  type: TType,
): event is Extract<KnownDaemonEvent, { type: TType }> {
  const known = asKnownDaemonEvent(event);
  return known?.type === type;
}

export function asKnownDaemonEvent(
  event: DaemonEvent,
): KnownDaemonEvent | undefined {
  switch (event.type) {
    case 'session_update':
      return isRecord(event.data)
        ? (event as DaemonSessionUpdateEvent)
        : undefined;
    case 'permission_request':
      return isPermissionRequestData(event.data)
        ? (event as DaemonPermissionRequestEvent)
        : undefined;
    case 'permission_resolved':
      return isPermissionResolvedData(event.data)
        ? (event as DaemonPermissionResolvedEvent)
        : undefined;
    case 'permission_already_resolved':
      return isPermissionAlreadyResolvedData(event.data)
        ? (event as DaemonPermissionAlreadyResolvedEvent)
        : undefined;
    case 'model_switched':
      return isModelSwitchedData(event.data)
        ? (event as DaemonModelSwitchedEvent)
        : undefined;
    case 'model_switch_failed':
      return isModelSwitchFailedData(event.data)
        ? (event as DaemonModelSwitchFailedEvent)
        : undefined;
    case 'session_died':
      return isSessionDiedData(event.data)
        ? (event as DaemonSessionDiedEvent)
        : undefined;
    case 'session_closed':
      return isSessionClosedData(event.data)
        ? (event as DaemonSessionClosedEvent)
        : undefined;
    case 'session_metadata_updated':
      return isSessionMetadataUpdatedData(event.data)
        ? (event as DaemonSessionMetadataUpdatedEvent)
        : undefined;
    case 'client_evicted':
      return isClientEvictedData(event.data)
        ? (event as DaemonClientEvictedEvent)
        : undefined;
    case 'slow_client_warning':
      return isSlowClientWarningData(event.data)
        ? (event as DaemonSlowClientWarningEvent)
        : undefined;
    case 'stream_error':
      return isStreamErrorData(event.data)
        ? (event as DaemonStreamErrorEvent)
        : undefined;
    case 'mcp_budget_warning':
      return isMcpBudgetWarningData(event.data)
        ? (event as DaemonMcpBudgetWarningEvent)
        : undefined;
    case 'mcp_child_refused_batch':
      return isMcpChildRefusedBatchData(event.data)
        ? (event as DaemonMcpChildRefusedBatchEvent)
        : undefined;
    case 'memory_changed':
      return isMemoryChangedData(event.data)
        ? (event as DaemonMemoryChangedEvent)
        : undefined;
    case 'agent_changed':
      return isAgentChangedData(event.data)
        ? (event as DaemonAgentChangedEvent)
        : undefined;
    case 'auth_device_flow_started':
      return isAuthDeviceFlowStartedData(event.data)
        ? (event as DaemonAuthDeviceFlowStartedEvent)
        : undefined;
    case 'auth_device_flow_throttled':
      return isAuthDeviceFlowThrottledData(event.data)
        ? (event as DaemonAuthDeviceFlowThrottledEvent)
        : undefined;
    case 'auth_device_flow_authorized':
      return isAuthDeviceFlowAuthorizedData(event.data)
        ? (event as DaemonAuthDeviceFlowAuthorizedEvent)
        : undefined;
    case 'auth_device_flow_failed':
      return isAuthDeviceFlowFailedData(event.data)
        ? (event as DaemonAuthDeviceFlowFailedEvent)
        : undefined;
    case 'auth_device_flow_cancelled':
      return isAuthDeviceFlowCancelledData(event.data)
        ? (event as DaemonAuthDeviceFlowCancelledEvent)
        : undefined;
    case 'approval_mode_changed':
      return isApprovalModeChangedData(event.data)
        ? (event as DaemonApprovalModeChangedEvent)
        : undefined;
    case 'tool_toggled':
      return isToolToggledData(event.data)
        ? (event as DaemonToolToggledEvent)
        : undefined;
    case 'workspace_initialized':
      return isWorkspaceInitializedData(event.data)
        ? (event as DaemonWorkspaceInitializedEvent)
        : undefined;
    case 'mcp_server_restarted':
      return isMcpServerRestartedData(event.data)
        ? (event as DaemonMcpServerRestartedEvent)
        : undefined;
    case 'mcp_server_restart_refused':
      return isMcpServerRestartRefusedData(event.data)
        ? (event as DaemonMcpServerRestartRefusedEvent)
        : undefined;
    case 'session_rewound':
      return isSessionRewoundData(event.data)
        ? (event as DaemonSessionRewoundEvent)
        : undefined;
    default:
      return undefined;
  }
}

function isSessionRewoundData(
  value: unknown,
): value is DaemonSessionRewoundData {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r['sessionId'] === 'string' &&
    r['sessionId'] !== '' &&
    typeof r['promptId'] === 'string' &&
    r['promptId'] !== '' &&
    typeof r['targetTurnIndex'] === 'number' &&
    Number.isFinite(r['targetTurnIndex']) &&
    Array.isArray(r['filesChanged'])
  );
}

export function reduceDaemonSessionEvent(
  state: DaemonSessionViewState,
  rawEvent: DaemonEvent,
): DaemonSessionViewState {
  const base = advanceLastEventId(state, rawEvent.id);
  const event = asKnownDaemonEvent(rawEvent);
  if (!event) {
    if (!isKnownDaemonEventTypeName(rawEvent.type)) return base;
    return {
      ...base,
      unrecognizedKnownEventCount: base.unrecognizedKnownEventCount + 1,
      lastUnrecognizedKnownEvent: rawEvent,
    };
  }

  switch (event.type) {
    case 'session_update':
      return {
        ...base,
        // ACP SessionNotification carries sessionId at the top level today;
        // keep this aligned with httpAcpBridge's emission shape.
        sessionId: getString(event.data, 'sessionId') ?? base.sessionId,
        lastSessionUpdate: event.data,
      };
    case 'permission_request': {
      const isExistingRequest = event.data.requestId in base.pendingPermissions;
      if (
        !isExistingRequest &&
        Object.keys(base.pendingPermissions).length >= MAX_PENDING_PER_SESSION
      ) {
        return {
          ...base,
          droppedPermissionRequestCount: base.droppedPermissionRequestCount + 1,
          lastDroppedPermissionRequestId: event.data.requestId,
        };
      }
      return {
        ...base,
        sessionId: event.data.sessionId,
        pendingPermissions: {
          ...base.pendingPermissions,
          [event.data.requestId]: clonePermissionRequestData(event.data),
        },
      };
    }
    case 'permission_resolved': {
      if (!(event.data.requestId in base.pendingPermissions)) {
        return {
          ...base,
          unmatchedPermissionResolutionCount:
            base.unmatchedPermissionResolutionCount + 1,
          lastUnmatchedPermissionResolutionId: event.data.requestId,
        };
      }
      const pendingPermissions = { ...base.pendingPermissions };
      delete pendingPermissions[event.data.requestId];
      return { ...base, pendingPermissions };
    }
    case 'permission_already_resolved': {
      if (!(event.data.requestId in base.pendingPermissions)) {
        return {
          ...base,
          unmatchedPermissionResolutionCount:
            base.unmatchedPermissionResolutionCount + 1,
          lastUnmatchedPermissionResolutionId: event.data.requestId,
        };
      }
      const pendingPermissions = { ...base.pendingPermissions };
      delete pendingPermissions[event.data.requestId];
      return { ...base, pendingPermissions };
    }
    case 'model_switched':
      return {
        ...base,
        sessionId: event.data.sessionId,
        currentModelId: event.data.modelId,
        lastModelSwitchFailure: undefined,
      };
    case 'model_switch_failed':
      return {
        ...base,
        sessionId: event.data.sessionId,
        lastModelSwitchFailure: event.data,
      };
    case 'session_died':
      return {
        ...base,
        sessionId: event.data.sessionId,
        alive: false,
        terminalEvent: chooseTerminalEvent(base.terminalEvent, event),
        pendingPermissions: {},
      };
    case 'session_closed':
      return {
        ...base,
        sessionId: event.data.sessionId,
        alive: false,
        terminalEvent: chooseTerminalEvent(base.terminalEvent, event),
        pendingPermissions: {},
      };
    case 'session_metadata_updated':
      return {
        ...base,
        sessionId: event.data.sessionId,
        displayName: event.data.displayName,
      };
    case 'client_evicted':
      return {
        ...base,
        alive: false,
        terminalEvent: chooseTerminalEvent(base.terminalEvent, event),
        pendingPermissions: {},
      };
    case 'slow_client_warning':
      // Non-terminal: warning precedes eviction but doesn't close
      // the stream on its own. Count + capture the latest snapshot
      // so adapters can render lag UI (or pre-emptively detach).
      // `alive` and `pendingPermissions` are unchanged.
      return {
        ...base,
        slowClientWarningCount: base.slowClientWarningCount + 1,
        lastSlowClientWarning: event.data,
      };
    case 'stream_error':
      return {
        ...base,
        alive: false,
        terminalEvent: chooseTerminalEvent(base.terminalEvent, event),
        streamError: event.data,
        pendingPermissions: {},
      };
    case 'mcp_budget_warning':
      // Non-terminal: budget pressure is a status signal, not a stream
      // close. Count + capture latest so adapters can render
      // "MCP pressure" UI; `alive` and `pendingPermissions` unchanged.
      return {
        ...base,
        mcpBudgetWarningCount: base.mcpBudgetWarningCount + 1,
        lastMcpBudgetWarning: event.data,
      };
    case 'mcp_child_refused_batch':
      // Non-terminal: refusals are operator-actionable signals (raise
      // budget / drop servers), not stream lifecycle events. The
      // session keeps running with a smaller MCP fleet.
      return {
        ...base,
        mcpChildRefusedBatchCount: base.mcpChildRefusedBatchCount + 1,
        lastMcpChildRefusedBatch: event.data,
      };
    case 'memory_changed':
      // Non-terminal: adapters render a "memory just changed" hint and
      // re-fetch `GET /workspace/memory` to get the canonical state. We
      // don't append to a list — the latest event is enough since the
      // route's read-after-write contract is the source of truth.
      return {
        ...base,
        lastWorkspaceMutation: event.data,
        lastWorkspaceMutationType: 'memory_changed',
      };
    case 'agent_changed':
      // Same shape as `memory_changed` — non-terminal hint that
      // triggers a `GET /workspace/agents` re-fetch.
      return {
        ...base,
        lastWorkspaceMutation: event.data,
        lastWorkspaceMutationType: 'agent_changed',
      };
    // Auth device-flow events are workspace-scoped; the session reducer
    // is a no-op (consume `lastEventId` via `base` and otherwise pass
    // state through). Workspace-level state lives in `DaemonAuthState`
    // and is projected by `reduceDaemonAuthEvent`.
    case 'auth_device_flow_started':
    case 'auth_device_flow_throttled':
    case 'auth_device_flow_authorized':
    case 'auth_device_flow_failed':
    case 'auth_device_flow_cancelled':
      return base;
    // #4282 fold-in 2 (gpt-5.5 SV3): for the 5 PR 17 mutation events,
    // copy `event.originatorClientId` (envelope-level) into the stored
    // snapshot. Without this, consumers reading
    // `lastApprovalModeChange` / `lastToolToggle` / `lastWorkspaceInit`
    // / `lastMcpRestart{,Refused}` cannot tell whether the mutation
    // originated from themselves — even though the raw event carried
    // that information at the envelope level. `mergeOriginator`
    // preserves any pre-existing `data.originatorClientId` (which the
    // daemon does NOT currently populate, but the field exists on the
    // Data interfaces) and falls back to the envelope.
    case 'approval_mode_changed':
      return {
        ...base,
        approvalMode: event.data.next,
        approvalModeChangedCount: base.approvalModeChangedCount + 1,
        lastApprovalModeChange: mergeOriginator(event.data, event),
      };
    case 'tool_toggled':
      // Workspace-scoped — same `tool_toggled` envelope is fan-out to
      // every session, so adapters can render "this tool was disabled
      // by another client" without polling.
      return {
        ...base,
        toolToggleCount: base.toolToggleCount + 1,
        lastToolToggle: mergeOriginator(event.data, event),
      };
    case 'workspace_initialized':
      // Workspace-scoped fan-out. Non-terminal — just records that a
      // QWEN.md scaffold was performed.
      return {
        ...base,
        workspaceInitCount: base.workspaceInitCount + 1,
        lastWorkspaceInit: mergeOriginator(event.data, event),
      };
    case 'mcp_server_restarted':
      return {
        ...base,
        mcpRestartCount: base.mcpRestartCount + 1,
        lastMcpRestart: mergeOriginator(event.data, event),
      };
    case 'mcp_server_restart_refused':
      return {
        ...base,
        mcpRestartRefusedCount: base.mcpRestartRefusedCount + 1,
        lastMcpRestartRefused: mergeOriginator(event.data, event),
      };
    case 'session_rewound':
      return {
        ...base,
        rewindCount: base.rewindCount + 1,
        lastRewind: mergeOriginator(event.data, event),
      };
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

export function reduceDaemonSessionEvents(
  events: Iterable<DaemonEvent>,
  initialState: DaemonSessionViewState = createDaemonSessionViewState(),
): DaemonSessionViewState {
  let state = initialState;
  for (const event of events) state = reduceDaemonSessionEvent(state, event);
  return state;
}

/** Issue #4175 PR 21 — workspace-scoped auth device-flow state. One entry
 *  per provider; the registry's per-provider singleton constraint is
 *  reflected here so adapters can render `state.flows[providerId]` without
 *  worrying about concurrent flows for the same provider. */
export interface DaemonDeviceFlowReducerState {
  deviceFlowId: string;
  status: DaemonAuthDeviceFlowStatus;
  errorKind?: DaemonAuthDeviceFlowErrorKind;
  hint?: string;
  /** Most recent `intervalMs` reported by `auth_device_flow_throttled`. */
  intervalMs?: number;
  /** Most recent SSE event id observed for this flow (NOT a wall-clock
   *  timestamp). Used as a monotonic counter so out-of-order delivery
   *  doesn't let a stale frame overwrite a newer one. `undefined` if
   *  the underlying envelope omitted `id` (synthetic / SDK-internal
   *  frames). PR #4255 round-9 #6: changed from `number` (defaulting
   *  to 0) to `number | undefined` — the daemon-side EventBus assigns
   *  ids ≥ 1, so `0` is a sentinel that has no meaning in real
   *  traffic, but the monotonic gate (`rawEventId <= lastSeenEventId`)
   *  would reject any future synthetic frame using `id: 0`. The gate
   *  already short-circuits on `existing.lastSeenEventId !== undefined`,
   *  so undefined is safe. */
  lastSeenEventId: number | undefined;
  /** Set on `authorized` to the credential's expiry, when known. */
  authorizedExpiresAt?: number;
  /** Best-effort non-PII account label echoed from `authorized`. */
  accountAlias?: string;
}

export interface DaemonAuthState {
  flows: Partial<
    Record<DaemonAuthDeviceFlowProviderId, DaemonDeviceFlowReducerState>
  >;
}

export function createDaemonAuthState(
  seed: Partial<DaemonAuthState> = {},
): DaemonAuthState {
  return { flows: { ...(seed.flows ?? {}) } };
}

/**
 * Apply a single auth device-flow event to a workspace-scoped auth state.
 * Non-auth events (sessions, control, lifecycle) pass through unchanged so
 * adapters can fan one event stream into both `reduceDaemonSessionEvent`
 * (per session) and `reduceDaemonAuthEvent` (workspace-wide) without
 * filtering ahead of time.
 *
 * Edge cases:
 *   - `throttled` / `authorized` / `failed` / `cancelled` for a deviceFlowId
 *     not matching the current `flows[providerId]` are dropped: by the time
 *     they arrive, that flow's terminal-grace window has already expired or
 *     the SDK has rebased onto a newer flow. Silently ignoring stale events
 *     is the correct behavior here (events are non-authoritative; the
 *     daemon's GET .../device-flow/:id is the source of truth).
 */
export function reduceDaemonAuthEvent(
  state: DaemonAuthState,
  rawEvent: DaemonEvent,
): DaemonAuthState {
  const event = asKnownDaemonEvent(rawEvent);
  if (!event) return state;
  switch (event.type) {
    case 'auth_device_flow_started': {
      // PR #4255 fold-in 8 review thread #2: gate stale `started`
      // frames the same way as the matching-flow handlers. SSE
      // reconnect with `Last-Event-ID < started.id` would otherwise
      // replay an old started for the SAME deviceFlowId after the
      // SDK reducer already advanced to a terminal state, resetting
      // the visible status to 'pending'. A stale started for an
      // OLDER flow (different deviceFlowId, lower id than the
      // current flow's lastSeenEventId) similarly gets ignored.
      const providerId = event.data.providerId;
      const existing = state.flows[providerId];
      if (
        existing !== undefined &&
        rawEvent.id !== undefined &&
        existing.lastSeenEventId !== undefined &&
        rawEvent.id <= existing.lastSeenEventId
      ) {
        return state;
      }
      return {
        flows: {
          ...state.flows,
          [providerId]: {
            deviceFlowId: event.data.deviceFlowId,
            status: 'pending',
            lastSeenEventId: rawEvent.id ?? existing?.lastSeenEventId,
          },
        },
      };
    }
    case 'auth_device_flow_throttled': {
      const updated = updateMatchingFlow(
        state,
        event.data.deviceFlowId,
        rawEvent.id,
        (flow) => ({
          ...flow,
          intervalMs: event.data.intervalMs,
          lastSeenEventId: rawEvent.id ?? flow.lastSeenEventId,
        }),
      );
      return updated ?? state;
    }
    case 'auth_device_flow_authorized': {
      const providerId = event.data.providerId;
      const existing = state.flows[providerId];
      if (!existing || existing.deviceFlowId !== event.data.deviceFlowId) {
        return state;
      }
      // PR #4255 fold-in 8 review thread #2: enforce monotonicity
      // here too. The deviceFlowId equality check above narrows to
      // "this frame is for the current flow"; the id gate then
      // refuses out-of-order replay (e.g. a delayed `authorized`
      // arriving after a more recent `failed` for the same flow,
      // which the daemon's transitionTerminal would never produce
      // but a malformed/synthetic stream could).
      if (
        rawEvent.id !== undefined &&
        existing.lastSeenEventId !== undefined &&
        rawEvent.id <= existing.lastSeenEventId
      ) {
        return state;
      }
      const next: DaemonDeviceFlowReducerState = {
        ...existing,
        status: 'authorized',
        authorizedExpiresAt: event.data.expiresAt,
        accountAlias: event.data.accountAlias,
        errorKind: undefined,
        lastSeenEventId: rawEvent.id ?? existing.lastSeenEventId,
      };
      return { flows: { ...state.flows, [providerId]: next } };
    }
    case 'auth_device_flow_failed': {
      // The daemon's status machine reserves 'expired' for the time-based
      // path (now >= expiresAt). Upstream RFC 8628 errors — including
      // `expired_token` — go to 'error' with `errorKind` carrying the
      // distinction. Earlier drafts collapsed `errorKind: 'expired_token'`
      // to status 'expired', which gave SDK consumers a different
      // status than the daemon's GET endpoint reported. Code-reviewer
      // P1-9 / silent-failure D2: align with daemon, surface errorKind
      // separately.
      const updated = updateMatchingFlow(
        state,
        event.data.deviceFlowId,
        rawEvent.id,
        (flow) => ({
          ...flow,
          status: 'error',
          errorKind: event.data.errorKind,
          hint: event.data.hint,
          lastSeenEventId: rawEvent.id ?? flow.lastSeenEventId,
        }),
      );
      return updated ?? state;
    }
    case 'auth_device_flow_cancelled': {
      const updated = updateMatchingFlow(
        state,
        event.data.deviceFlowId,
        rawEvent.id,
        (flow) => ({
          ...flow,
          status: 'cancelled',
          lastSeenEventId: rawEvent.id ?? flow.lastSeenEventId,
        }),
      );
      return updated ?? state;
    }
    default:
      return state;
  }
}

export function reduceDaemonAuthEvents(
  events: Iterable<DaemonEvent>,
  initialState: DaemonAuthState = createDaemonAuthState(),
): DaemonAuthState {
  let state = initialState;
  for (const event of events) state = reduceDaemonAuthEvent(state, event);
  return state;
}

function updateMatchingFlow(
  state: DaemonAuthState,
  deviceFlowId: string,
  rawEventId: number | undefined,
  patch: (flow: DaemonDeviceFlowReducerState) => DaemonDeviceFlowReducerState,
): DaemonAuthState | undefined {
  const entries = Object.entries(state.flows) as Array<
    [DaemonAuthDeviceFlowProviderId, DaemonDeviceFlowReducerState | undefined]
  >;
  for (const [providerId, flow] of entries) {
    if (flow && flow.deviceFlowId === deviceFlowId) {
      // PR #4255 fold-in 8 review thread #2: enforce the
      // monotonicity guarantee that `lastSeenEventId`'s JSDoc
      // documents. Out-of-order delivery (SSE replay-then-live
      // mixing) could otherwise let a stale frame overwrite a
      // newer terminal state. Synthetic frames without an
      // envelope `id` (rawEventId === undefined) bypass the
      // gate — they originate inside the SDK reducer machinery
      // (e.g. fallback paths) and aren't subject to replay
      // ordering.
      if (
        rawEventId !== undefined &&
        flow.lastSeenEventId !== undefined &&
        rawEventId <= flow.lastSeenEventId
      ) {
        return state;
      }
      return {
        flows: { ...state.flows, [providerId]: patch(flow) },
      };
    }
  }
  return undefined;
}

function isKnownDaemonEventTypeName(
  type: string,
): type is DaemonKnownEventType {
  return DAEMON_KNOWN_EVENT_TYPES.has(type);
}

// Session-lifecycle terminals outrank stream-local terminals in
// `terminalEvent`; they prove the underlying daemon session ended.
type TerminalEvent =
  | DaemonSessionDiedEvent
  | DaemonSessionClosedEvent
  | DaemonClientEvictedEvent
  | DaemonStreamErrorEvent;

function isSessionLifecycleTerminal(type: string): boolean {
  return type === 'session_died' || type === 'session_closed';
}

function chooseTerminalEvent(
  current: TerminalEvent | undefined,
  next: TerminalEvent,
): TerminalEvent {
  if (!current) return next;
  if (
    !isSessionLifecycleTerminal(current.type) &&
    isSessionLifecycleTerminal(next.type)
  ) {
    return next;
  }
  return current;
}

function isPermissionRequestData(
  value: unknown,
): value is DaemonPermissionRequestData {
  return (
    isRecord(value) &&
    isNonEmptyString(value['requestId']) &&
    isNonEmptyString(value['sessionId']) &&
    isRecord(value['toolCall']) &&
    Array.isArray(value['options']) &&
    value['options'].every(isPermissionOption)
  );
}

function isPermissionResolvedData(
  value: unknown,
): value is DaemonPermissionResolvedData {
  return (
    isRecord(value) &&
    isNonEmptyString(value['requestId']) &&
    isPermissionOutcome(value['outcome'])
  );
}

function isPermissionAlreadyResolvedData(
  value: unknown,
): value is DaemonPermissionAlreadyResolvedData {
  return (
    isRecord(value) &&
    isNonEmptyString(value['requestId']) &&
    isNonEmptyString(value['sessionId']) &&
    isPermissionOutcome(value['outcome'])
  );
}

function isModelSwitchedData(value: unknown): value is DaemonModelSwitchedData {
  return (
    isRecord(value) &&
    isNonEmptyString(value['sessionId']) &&
    isNonEmptyString(value['modelId'])
  );
}

function isModelSwitchFailedData(
  value: unknown,
): value is DaemonModelSwitchFailedData {
  return (
    isRecord(value) &&
    isNonEmptyString(value['sessionId']) &&
    isNonEmptyString(value['requestedModelId']) &&
    isNonEmptyString(value['error'])
  );
}

function isSessionDiedData(value: unknown): value is DaemonSessionDiedData {
  return (
    isRecord(value) &&
    isNonEmptyString(value['sessionId']) &&
    isNonEmptyString(value['reason']) &&
    isOptionalNumberOrNull(value['exitCode']) &&
    isOptionalStringOrNull(value['signalCode'])
  );
}

function isSessionClosedData(value: unknown): value is DaemonSessionClosedData {
  return (
    isRecord(value) &&
    isNonEmptyString(value['sessionId']) &&
    isNonEmptyString(value['reason']) &&
    isOptionalStringOrNull(value['closedBy'])
  );
}

function isSessionMetadataUpdatedData(
  value: unknown,
): value is DaemonSessionMetadataUpdatedData {
  return (
    isRecord(value) &&
    isNonEmptyString(value['sessionId']) &&
    isOptionalStringOrNull(value['displayName'])
  );
}

function isClientEvictedData(value: unknown): value is DaemonClientEvictedData {
  return (
    isRecord(value) &&
    isNonEmptyString(value['reason']) &&
    isOptionalNumber(value['droppedAfter'])
  );
}

function isSlowClientWarningData(
  value: unknown,
): value is DaemonSlowClientWarningData {
  // Mirror the sibling predicates' finite-number guard
  // (`isOptionalNumber` → `isFiniteNumber`): `typeof NaN === 'number'`
  // and `typeof Infinity === 'number'` both pass a bare `typeof`
  // check but would be schema garbage for a queue-size measurement.
  return (
    isRecord(value) &&
    isFiniteNumber(value['queueSize']) &&
    isFiniteNumber(value['maxQueued']) &&
    isFiniteNumber(value['lastEventId'])
  );
}

function isStreamErrorData(value: unknown): value is DaemonStreamErrorData {
  return isRecord(value) && isNonEmptyString(value['error']);
}

function isMcpBudgetWarningData(
  value: unknown,
): value is DaemonMcpBudgetWarningData {
  // PR 14b fix (codex round 6): `thresholdRatio` is validated as a
  // finite number, NOT pinned to the literal `0.75`. The SDK's
  // role here is wire-shape validation; threshold semantics are
  // owned by the daemon's `MCP_BUDGET_WARN_FRACTION` constant
  // (`packages/core/src/tools/mcp-client-manager.ts`) and documented
  // in `qwen-serve-protocol.md`. Pinning the literal in the SDK
  // would mean a daemon-side change to e.g. 0.80 silently routes
  // every warning through `unrecognizedKnownEventCount` — a
  // cross-package coordination hazard with no operator-visible
  // failure mode. The `DaemonMcpBudgetWarningData.thresholdRatio`
  // type still narrows to `0.75` for current daemons; future
  // multi-threshold support (e.g. 0.5 critical) would extend the
  // type AND the wire shape via a `severity` discriminator field.
  return (
    isRecord(value) &&
    isFiniteNumber(value['liveCount']) &&
    isFiniteNumber(value['reservedCount']) &&
    isFiniteNumber(value['budget']) &&
    isFiniteNumber(value['thresholdRatio']) &&
    (value['mode'] === 'warn' || value['mode'] === 'enforce')
  );
}

function isMcpRefusedServerEntry(
  value: unknown,
): value is DaemonMcpRefusedServer {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value['name'])) return false;
  if (value['reason'] !== 'budget_exhausted') return false;
  // Transport family must be one of the known kinds. Reject silently
  // for forward-compat: a daemon emitting an unknown transport is
  // likely speaking a newer wire than this SDK release.
  const transport = value['transport'];
  return (
    transport === 'stdio' ||
    transport === 'sse' ||
    transport === 'http' ||
    transport === 'websocket' ||
    transport === 'sdk' ||
    transport === 'unknown'
  );
}

function isMcpChildRefusedBatchData(
  value: unknown,
): value is DaemonMcpChildRefusedBatchData {
  return (
    isRecord(value) &&
    Array.isArray(value['refusedServers']) &&
    value['refusedServers'].every(isMcpRefusedServerEntry) &&
    isFiniteNumber(value['budget']) &&
    isFiniteNumber(value['liveCount']) &&
    isFiniteNumber(value['reservedCount']) &&
    // `mode` is a literal `'enforce'` — `warn` mode never refuses, so
    // `'warn'`-tagged refusal payloads are protocol garbage. Reject
    // them so the reducer sees the raw event under the
    // `unrecognizedKnownEventCount` branch instead of silently
    // accepting a malformed shape.
    value['mode'] === 'enforce'
  );
}

function isMemoryChangedData(value: unknown): value is DaemonMemoryChangedData {
  if (!isRecord(value)) return false;
  const scope = value['scope'];
  const mode = value['mode'];
  return (
    (scope === 'workspace' || scope === 'global') &&
    isNonEmptyString(value['filePath']) &&
    (mode === 'append' || mode === 'replace') &&
    isFiniteNumber(value['bytesWritten'])
  );
}

function isAgentChangedData(value: unknown): value is DaemonAgentChangedData {
  if (!isRecord(value)) return false;
  const change = value['change'];
  const level = value['level'];
  return (
    (change === 'created' || change === 'updated' || change === 'deleted') &&
    isNonEmptyString(value['name']) &&
    (level === 'project' || level === 'user')
  );
}

function isAuthDeviceFlowStartedData(
  value: unknown,
): value is DaemonAuthDeviceFlowStartedData {
  return (
    isRecord(value) &&
    isNonEmptyString(value['deviceFlowId']) &&
    isNonEmptyString(value['providerId']) &&
    isFiniteNumber(value['expiresAt'])
  );
}

function isAuthDeviceFlowThrottledData(
  value: unknown,
): value is DaemonAuthDeviceFlowThrottledData {
  return (
    isRecord(value) &&
    isNonEmptyString(value['deviceFlowId']) &&
    isFiniteNumber(value['intervalMs'])
  );
}

function isAuthDeviceFlowAuthorizedData(
  value: unknown,
): value is DaemonAuthDeviceFlowAuthorizedData {
  return (
    isRecord(value) &&
    isNonEmptyString(value['deviceFlowId']) &&
    isNonEmptyString(value['providerId']) &&
    isOptionalNumber(value['expiresAt']) &&
    isOptionalStringOrNull(value['accountAlias'])
  );
}

function isAuthDeviceFlowFailedData(
  value: unknown,
): value is DaemonAuthDeviceFlowFailedData {
  return (
    isRecord(value) &&
    isNonEmptyString(value['deviceFlowId']) &&
    isAuthDeviceFlowErrorKind(value['errorKind']) &&
    isOptionalStringOrNull(value['hint'])
  );
}

function isAuthDeviceFlowCancelledData(
  value: unknown,
): value is DaemonAuthDeviceFlowCancelledData {
  return isRecord(value) && isNonEmptyString(value['deviceFlowId']);
}

function isAuthDeviceFlowErrorKind(
  value: unknown,
): value is DaemonAuthDeviceFlowErrorKind {
  // Forward-compat: accept ANY non-empty string. The earlier closed
  // allowlist would silently drop a daemon-emitted `failed` event with
  // a future errorKind (e.g. `rate_limited`) — `asKnownDaemonEvent`
  // would treat it as malformed and `reduceDaemonAuthEvent` never
  // transitions the flow's status, leaving SDK consumers stuck on
  // `pending` (PR #4255 review C2). The known literals still narrow
  // exhaustively in consumer `switch` statements; unknown kinds fall
  // into the `(string & {})` arm of the union for graceful handling.
  return typeof value === 'string' && value.length > 0;
}

/**
 * #4282 fold-in 2 (gpt-5.5 SV3). PR 17 mutation events carry
 * `originatorClientId` at the SSE envelope level, separate from
 * `event.data`. Reducer snapshots used to store only `event.data`,
 * leaving consumers unable to tell self-originated mutations apart.
 * This helper stamps the envelope's originator onto the stored
 * snapshot, preserving any pre-existing `data.originatorClientId`
 * (which the daemon does not currently populate, but the field is
 * declared on the Data interfaces).
 */
function mergeOriginator<T extends { originatorClientId?: string }>(
  data: T,
  event: { originatorClientId?: string },
): T {
  if (data.originatorClientId !== undefined) return data;
  if (event.originatorClientId === undefined) return data;
  return { ...data, originatorClientId: event.originatorClientId };
}

function isApprovalModeChangedData(
  value: unknown,
): value is DaemonApprovalModeChangedData {
  // `previous` and `next` are typed as bare strings in the public
  // shape (forward-compat for a future fifth approval-mode literal),
  // so the predicate only checks the structural envelope here.
  return (
    isRecord(value) &&
    isNonEmptyString(value['sessionId']) &&
    isNonEmptyString(value['previous']) &&
    isNonEmptyString(value['next']) &&
    typeof value['persisted'] === 'boolean'
  );
}

function isToolToggledData(value: unknown): value is DaemonToolToggledData {
  return (
    isRecord(value) &&
    isNonEmptyString(value['toolName']) &&
    typeof value['enabled'] === 'boolean'
  );
}

function isWorkspaceInitializedData(
  value: unknown,
): value is DaemonWorkspaceInitializedData {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value['path'])) return false;
  const action = value['action'];
  return action === 'created' || action === 'overwrote' || action === 'noop';
}

function isMcpServerRestartedData(
  value: unknown,
): value is DaemonMcpServerRestartedData {
  return (
    isRecord(value) &&
    isNonEmptyString(value['serverName']) &&
    isFiniteNumber(value['durationMs'])
  );
}

const MCP_RESTART_REFUSED_REASONS: ReadonlySet<string> = new Set([
  'in_flight',
  'disabled',
  'budget_would_exceed',
]);

function isMcpServerRestartRefusedData(
  value: unknown,
): value is DaemonMcpServerRestartRefusedData {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value['serverName'])) return false;
  return (
    typeof value['reason'] === 'string' &&
    MCP_RESTART_REFUSED_REASONS.has(value['reason'])
  );
}

function isPermissionOption(value: unknown): value is DaemonPermissionOption {
  return isRecord(value) && isNonEmptyString(value['optionId']);
}

function isPermissionOutcome(value: unknown): value is PermissionOutcome {
  if (!isRecord(value)) return false;
  if (value['outcome'] === 'cancelled') return true;
  // Empty option ids are intentionally rejected even though the structural
  // type is just string; daemon permission options must be selectable.
  return value['outcome'] === 'selected' && isNonEmptyString(value['optionId']);
}

function getString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value);
}

function isOptionalNumberOrNull(value: unknown): boolean {
  return value === undefined || value === null || isFiniteNumber(value);
}

function isOptionalStringOrNull(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function advanceLastEventId(
  state: DaemonSessionViewState,
  eventId: number | undefined,
): DaemonSessionViewState {
  if (eventId === undefined || !Number.isFinite(eventId)) return state;
  const lastEventId = Math.max(state.lastEventId ?? 0, eventId);
  if (lastEventId === state.lastEventId) return state;
  return { ...state, lastEventId };
}

function clonePermissionRequestData(
  data: DaemonPermissionRequestData,
): DaemonPermissionRequestData {
  return {
    ...data,
    options: data.options.map((option) => ({ ...option })),
  };
}
