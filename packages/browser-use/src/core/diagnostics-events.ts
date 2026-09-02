/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BridgeEvent } from '../bridge/index.js';

import type { DispatchResult, LogEntry, NetworkEntry } from './primitives.js';

const MAX_LOG_ENTRIES = 1_000;
const MAX_NETWORK_ENTRIES = 1_000;
const MAX_LOG_MESSAGE_CHARS = 4_000;
const MAX_LOG_STACK_CHARS = 4_000;

export interface DiagnosticsEventState {
  logs: LogEntry[];
  network: Map<string, NetworkEntry>;
  hiddenNetworkEntries: Set<string>;
  /** Request id -> response receipt time; undefined until a response arrives. */
  inflight: Map<string, number | undefined>;
}

export function readConsoleDiagnostics(
  state: DiagnosticsEventState,
  args: Record<string, unknown>,
): DispatchResult {
  const filter =
    typeof args.filter === 'string' ? args.filter.toLowerCase() : undefined;
  const levels = Array.isArray(args.levels)
    ? new Set(
        args.levels.map((level) =>
          level === 'warning' ? 'warn' : String(level),
        ),
      )
    : undefined;
  const limit = typeof args.limit === 'number' ? args.limit : 100;
  const entries = state.logs
    .filter(
      (entry) =>
        (levels === undefined || levels.has(entry.level)) &&
        (filter === undefined || entry.message.toLowerCase().includes(filter)),
    )
    .slice(-limit)
    .map((entry) => ({ ...entry }));
  if (args.clear === true) state.logs.length = 0;
  return entries as unknown as DispatchResult;
}

export function readNetworkDiagnostics(
  state: DiagnosticsEventState,
  args: Record<string, unknown>,
): DispatchResult {
  const pattern =
    typeof args.urlPattern === 'string' ? args.urlPattern : undefined;
  const limit = typeof args.limit === 'number' ? args.limit : 100;
  const entries = [...state.network.entries()]
    .filter(
      ([requestId, entry]) =>
        !state.hiddenNetworkEntries.has(requestId) &&
        (pattern === undefined || entry.url.includes(pattern)),
    )
    .slice(-limit)
    .map(([_requestId, { respondedAt: _respondedAt, ...entry }]) => ({
      ...entry,
    }));
  if (args.clear === true) {
    // Preserve active requests for networkidle while hiding them from later
    // diagnostic reads; completed entries can be discarded immediately.
    for (const requestId of state.network.keys()) {
      if (state.inflight.has(requestId))
        state.hiddenNetworkEntries.add(requestId);
      else state.network.delete(requestId);
    }
  }
  return entries as unknown as DispatchResult;
}

/** Applies console and network CDP events, returning true when the event belongs to this domain. */
export function applyDiagnosticsEvent(
  state: DiagnosticsEventState,
  event: BridgeEvent,
): boolean {
  const params = objectValue(event.params);
  switch (event.method) {
    case 'Runtime.consoleAPICalled':
      pushLog(state, {
        level: consoleLevel(params.type),
        message: describeRemoteObjects(params.args),
        timestamp: isoTime(params.timestamp, 'ms'),
        ...topFrameLocation(params.stackTrace),
      });
      return true;
    case 'Runtime.exceptionThrown': {
      const details = objectValue(params.exceptionDetails);
      const exception = objectValue(details.exception);
      const description =
        typeof exception.description === 'string'
          ? exception.description
          : `${typeof details.text === 'string' ? details.text : 'Uncaught exception'}`;
      const [message = description, ...stackLines] = description.split('\n');
      const stack = stackLines.join('\n').trim();
      pushLog(state, {
        level: 'error',
        message,
        timestamp: isoTime(params.timestamp, 'ms'),
        ...sourceLocation(details),
        ...(stack === '' ? {} : { stack }),
      });
      return true;
    }
    case 'Network.requestWillBeSent': {
      const requestId = String(params.requestId ?? '');
      const request = objectValue(params.request);
      if (requestId === '') return true;
      const redirect = objectValue(params.redirectResponse);
      const previous = state.network.get(requestId);
      const previousWasHidden = state.hiddenNetworkEntries.delete(requestId);
      if (previous !== undefined && typeof redirect.status === 'number') {
        previous.status = redirect.status;
        previous.finished = true;
        if (!previousWasHidden)
          state.network.set(
            `${requestId}:redirect:${state.network.size}`,
            previous,
          );
      }
      const entry: NetworkEntry = {
        requestId,
        url: typeof request.url === 'string' ? request.url.slice(0, 2_048) : '',
        method: typeof request.method === 'string' ? request.method : 'GET',
        resourceType: typeof params.type === 'string' ? params.type : 'Other',
        startedAt: isoTime(params.wallTime, 's'),
        finished: false,
      };
      state.network.delete(requestId);
      state.hiddenNetworkEntries.delete(requestId);
      state.network.set(requestId, entry);
      state.inflight.set(requestId, undefined);
      trimNetwork(state);
      return true;
    }
    case 'Network.responseReceived': {
      const requestId = String(params.requestId ?? '');
      const entry = state.network.get(requestId);
      const response = objectValue(params.response);
      const respondedAt = Date.now();
      // Liveness is deliberately independent from the bounded diagnostics
      // map: an older in-flight entry may already have been evicted there.
      if (state.inflight.has(requestId))
        state.inflight.set(requestId, respondedAt);
      if (entry !== undefined) {
        entry.respondedAt = respondedAt;
        if (typeof response.status === 'number') entry.status = response.status;
        if (typeof response.statusText === 'string')
          entry.statusText = response.statusText;
        if (typeof response.mimeType === 'string')
          entry.mimeType = response.mimeType;
      }
      return true;
    }
    case 'Network.loadingFinished': {
      const requestId = String(params.requestId ?? '');
      const entry = state.network.get(requestId);
      if (entry !== undefined) {
        entry.finished = true;
        if (typeof params.encodedDataLength === 'number')
          entry.encodedDataLength = params.encodedDataLength;
      }
      state.inflight.delete(requestId);
      if (state.hiddenNetworkEntries.delete(requestId))
        state.network.delete(requestId);
      return true;
    }
    case 'Network.loadingFailed': {
      const requestId = String(params.requestId ?? '');
      const entry = state.network.get(requestId);
      if (entry !== undefined) {
        entry.finished = true;
        entry.failed =
          typeof params.errorText === 'string' ? params.errorText : 'failed';
      }
      state.inflight.delete(requestId);
      if (state.hiddenNetworkEntries.delete(requestId))
        state.network.delete(requestId);
      return true;
    }
    default:
      return false;
  }
}

function pushLog(state: DiagnosticsEventState, entry: LogEntry): void {
  state.logs.push({
    ...entry,
    message: entry.message.slice(0, MAX_LOG_MESSAGE_CHARS),
    ...(entry.stack === undefined
      ? {}
      : { stack: entry.stack.slice(0, MAX_LOG_STACK_CHARS) }),
  });
  if (state.logs.length > MAX_LOG_ENTRIES)
    state.logs.splice(0, state.logs.length - MAX_LOG_ENTRIES);
}

function trimNetwork(state: DiagnosticsEventState): void {
  while (state.network.size > MAX_NETWORK_ENTRIES) {
    const oldest = state.network.keys().next().value;
    if (oldest === undefined) break;
    state.network.delete(oldest);
    state.hiddenNetworkEntries.delete(oldest);
    // The diagnostic record is bounded, but request liveness is not merely
    // diagnostic state: waitForLoadState(networkidle) relies on it. Keep the
    // request id until Chrome reports loadingFinished/loadingFailed so a busy
    // page cannot look idle just because its diagnostics buffer filled up.
  }
}

function consoleLevel(type: unknown): LogEntry['level'] {
  switch (type) {
    case 'debug':
    case 'info':
    case 'warning':
    case 'error':
      return type === 'warning' ? 'warn' : type;
    case 'warn':
      return 'warn';
    default:
      return 'log';
  }
}

function describeRemoteObjects(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((item) => describeRemoteObject(objectValue(item), 0))
    .join(' ');
}

function describeRemoteObject(
  remote: Record<string, unknown>,
  depth: number,
): string {
  if (remote.value !== undefined)
    return typeof remote.value === 'string'
      ? remote.value
      : safeStringify(remote.value);
  if (typeof remote.unserializableValue === 'string')
    return remote.unserializableValue;
  const preview = objectValue(remote.preview);
  const properties = Array.isArray(preview.properties)
    ? preview.properties.map(objectValue)
    : undefined;
  if (properties !== undefined && depth < 3) {
    const overflow = preview.overflow === true ? ', …' : '';
    if (remote.subtype === 'array' || preview.subtype === 'array') {
      return `[${properties.map((property) => previewValue(property, depth)).join(', ')}${overflow}]`;
    }
    const entries = properties.map(
      (property) =>
        `${String(property.name)}: ${previewValue(property, depth)}`,
    );
    const className =
      typeof remote.className === 'string' && remote.className !== 'Object'
        ? `${remote.className} `
        : '';
    return `${className}{${entries.join(', ')}${overflow}}`;
  }
  if (typeof remote.description === 'string') return remote.description;
  return typeof remote.type === 'string' ? `[${remote.type}]` : '';
}

function previewValue(
  property: Record<string, unknown>,
  depth: number,
): string {
  if (property.valuePreview !== undefined) {
    return describeRemoteObject(
      {
        preview: property.valuePreview,
        subtype: objectValue(property.valuePreview).subtype,
      },
      depth + 1,
    );
  }
  if (property.type === 'string') return JSON.stringify(property.value ?? '');
  if (property.value !== undefined) return String(property.value);
  return typeof property.type === 'string' ? `[${property.type}]` : '';
}

export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function topFrameLocation(stackTrace: unknown): Partial<LogEntry> {
  const frames = objectValue(stackTrace).callFrames;
  return sourceLocation(Array.isArray(frames) ? objectValue(frames[0]) : {});
}

function sourceLocation(value: unknown): Partial<LogEntry> {
  const location = objectValue(value);
  return {
    ...(typeof location.url === 'string' && location.url !== ''
      ? { url: location.url }
      : {}),
    ...(typeof location.lineNumber === 'number' &&
    Number.isFinite(location.lineNumber)
      ? { lineNumber: location.lineNumber }
      : {}),
    ...(typeof location.columnNumber === 'number' &&
    Number.isFinite(location.columnNumber)
      ? { columnNumber: location.columnNumber }
      : {}),
  };
}

function isoTime(value: unknown, unit: 'ms' | 's'): string {
  const number =
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const ms =
    number === undefined ? Date.now() : unit === 's' ? number * 1_000 : number;
  return new Date(ms).toISOString();
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
