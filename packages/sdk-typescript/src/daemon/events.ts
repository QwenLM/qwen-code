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
  | DaemonPermissionAlreadyResolvedEvent;

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
  | DaemonWorkspaceMutationEvent;

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
  mcpRefusedBatchCount: number;
  lastMcpRefusedBatch?: DaemonMcpChildRefusedBatchData;
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
    mcpRefusedBatchCount: seed.mcpRefusedBatchCount ?? 0,
    lastMcpRefusedBatch: seed.lastMcpRefusedBatch,
    lastWorkspaceMutation: seed.lastWorkspaceMutation,
    lastWorkspaceMutationType: seed.lastWorkspaceMutationType,
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
    default:
      return undefined;
  }
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
        mcpRefusedBatchCount: base.mcpRefusedBatchCount + 1,
        lastMcpRefusedBatch: event.data,
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
  return (
    isRecord(value) &&
    isFiniteNumber(value['liveCount']) &&
    isFiniteNumber(value['reservedCount']) &&
    isFiniteNumber(value['budget']) &&
    value['thresholdRatio'] === 0.75 &&
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
