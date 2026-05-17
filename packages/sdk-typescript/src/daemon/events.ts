/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonEvent, PermissionOutcome } from './types.js';

const DAEMON_KNOWN_EVENT_TYPE_VALUES = [
  'session_update',
  'permission_request',
  'permission_resolved',
  'model_switched',
  'model_switch_failed',
  'session_died',
  'client_evicted',
  'slow_client_warning',
  'stream_error',
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

export type DaemonSessionEvent =
  | DaemonSessionUpdateEvent
  | DaemonModelSwitchedEvent
  | DaemonModelSwitchFailedEvent
  | DaemonSessionDiedEvent;

export type DaemonControlEvent =
  | DaemonPermissionRequestEvent
  | DaemonPermissionResolvedEvent;

export type DaemonStreamLifecycleEvent =
  | DaemonClientEvictedEvent
  | DaemonSlowClientWarningEvent
  | DaemonStreamErrorEvent;

export type KnownDaemonEvent =
  | DaemonSessionEvent
  | DaemonControlEvent
  | DaemonStreamLifecycleEvent;

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
  pendingPermissions: Record<string, DaemonPermissionRequestData>;
  lastSessionUpdate?: DaemonSessionUpdateData;
  lastModelSwitchFailure?: DaemonModelSwitchFailedData;
  terminalEvent?:
    | DaemonSessionDiedEvent
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

// Prefer the first stream-local terminal frame, but upgrade to session_died
// once the daemon reports the underlying session actually ended.
function chooseTerminalEvent(
  current:
    | DaemonSessionDiedEvent
    | DaemonClientEvictedEvent
    | DaemonStreamErrorEvent
    | undefined,
  next:
    | DaemonSessionDiedEvent
    | DaemonClientEvictedEvent
    | DaemonStreamErrorEvent,
): DaemonSessionDiedEvent | DaemonClientEvictedEvent | DaemonStreamErrorEvent {
  if (!current) return next;
  if (current.type !== 'session_died' && next.type === 'session_died') {
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
  return (
    isRecord(value) &&
    typeof value['queueSize'] === 'number' &&
    typeof value['maxQueued'] === 'number' &&
    typeof value['lastEventId'] === 'number'
  );
}

function isStreamErrorData(value: unknown): value is DaemonStreamErrorData {
  return isRecord(value) && isNonEmptyString(value['error']);
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
