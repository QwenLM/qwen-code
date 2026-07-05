/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { LOAD_REPLAY_META_KEY } from '@qwen-code/acp-bridge/bridgeTypes';
import type { DaemonLogger } from './daemon-logger.js';

export const LARGE_PIPE_FRAME_THRESHOLD_BYTES = 256 * 1024;
export const LARGE_PIPE_FRAME_LOG_LIMIT = 50;
export const LARGE_PIPE_FRAME_LOG_WINDOW_MS = 60_000;
export const LARGE_PIPE_FRAME_EVENT_NAME = 'qwen-code.daemon.pipe.large_frame';

type PipeDirection = 'inbound' | 'outbound';
type MessageKind = 'request' | 'notification' | 'response' | 'unknown';
type SourceClass =
  | 'session_update_notification'
  | 'load_session_bulk_replay_response'
  | 'load_updates_response'
  | 'jsonrpc_request'
  | 'jsonrpc_response'
  | 'unknown';
type LogValue = string | number | boolean;

const MAX_ATTR_STRING_LENGTH = 128;
const MAX_CONTENT_DEPTH = 32;
const MAX_JSON_APPROX_DEPTH = 32;
const MAX_RAW_OUTPUT_APPROX_BYTES = LARGE_PIPE_FRAME_THRESHOLD_BYTES;
const MAX_SUMMARIZED_UPDATES = 500;

export type LargePipeFrameContext = Record<string, LogValue>;

export interface LargePipeFrameObservation {
  direction: PipeDirection;
  bytes: number;
  message: unknown;
}

export interface LargePipeFrameObserverOptions {
  daemonLog: Pick<DaemonLogger, 'warn'>;
  emitTelemetryLog?: (
    body: string,
    attributes: Record<string, LogValue>,
    options?: { eventName?: string },
  ) => void;
  logLimit?: number;
  now?: () => number;
  thresholdBytes?: number;
  windowMs?: number;
}

interface UpdateSummary {
  maxObservedUpdateBytes?: number;
  maxContentTextBytes?: number;
  maxRawOutputApproxBytes?: number;
  maxRawOutputApproxBytesCapped?: boolean;
  maxRawOutputObservedBytes?: number;
  maxRawOutputTextBytes?: number;
  mixedSessionUpdate?: boolean;
  rawOutputKind?: string;
  sessionUpdate?: string;
  toolName?: string;
  toolProvenance?: string;
}

interface SourceClassification {
  sourceClass: SourceClass;
  replay?: Record<string, unknown>;
  result?: Record<string, unknown>;
  update?: Record<string, unknown>;
}

interface JsonByteLengthApproximation {
  bytes: number;
  capped: boolean;
}

interface JsonByteLengthState {
  budget: number;
  bytes: number;
  capped: boolean;
  seen: WeakSet<object>;
}

export function createLargePipeFrameObserver(
  options: LargePipeFrameObserverOptions,
): (observation: LargePipeFrameObservation) => void {
  const thresholdBytes =
    options.thresholdBytes ?? LARGE_PIPE_FRAME_THRESHOLD_BYTES;
  const windowMs = options.windowMs ?? LARGE_PIPE_FRAME_LOG_WINDOW_MS;
  const logLimit = options.logLimit ?? LARGE_PIPE_FRAME_LOG_LIMIT;
  const now = options.now ?? Date.now;
  let windowStartedAt = now();
  let emittedInWindow = 0;
  let suppressedCount = 0;
  let suppressedWindowStartMs: number | undefined;

  return (observation) => {
    try {
      if (observation.bytes < thresholdBytes) return;

      const currentTime = now();
      if (currentTime - windowStartedAt >= windowMs) {
        windowStartedAt = currentTime;
        emittedInWindow = 0;
      }

      if (emittedInWindow >= logLimit) {
        suppressedCount += 1;
        suppressedWindowStartMs ??= windowStartedAt;
        return;
      }

      const context = classifyLargePipeFrame(observation, thresholdBytes);
      if (!context) return;
      if (suppressedCount > 0) {
        context['suppressedCount'] = suppressedCount;
        if (suppressedWindowStartMs !== undefined) {
          context['suppressedWindowStartMs'] = suppressedWindowStartMs;
        }
        suppressedCount = 0;
        suppressedWindowStartMs = undefined;
      }
      emittedInWindow += 1;

      try {
        options.daemonLog.warn('large ACP pipe frame observed', context);
      } catch {
        // Observability must not affect transport behavior.
      }
      try {
        options.emitTelemetryLog?.('Large ACP pipe frame observed.', context, {
          eventName: LARGE_PIPE_FRAME_EVENT_NAME,
        });
      } catch {
        // Observability must not affect transport behavior.
      }
    } catch {
      // Observability must not affect transport behavior.
    }
  };
}

export function classifyLargePipeFrame(
  observation: LargePipeFrameObservation,
  thresholdBytes = LARGE_PIPE_FRAME_THRESHOLD_BYTES,
): LargePipeFrameContext | undefined {
  if (observation.bytes < thresholdBytes) return undefined;

  const message = asRecord(observation.message);
  const messageKind = message ? getMessageKind(message) : 'unknown';
  const method = message ? stringValue(message['method']) : undefined;
  const classification = classifySource(message, messageKind, method);
  const context: LargePipeFrameContext = {
    direction: observation.direction,
    bytes: observation.bytes,
    thresholdBytes,
    messageKind,
    sourceClass: classification.sourceClass,
  };
  addString(context, 'method', method);

  if (classification.sourceClass === 'session_update_notification') {
    addUpdateSummary(context, summarizeUpdate(classification.update));
  } else if (
    classification.sourceClass === 'load_session_bulk_replay_response'
  ) {
    addUpdatesSummary(context, classification.replay?.['updates']);
  } else if (classification.sourceClass === 'load_updates_response') {
    addUpdatesSummary(context, classification.result?.['updates']);
  }

  return context;
}

function classifySource(
  message: Record<string, unknown> | undefined,
  messageKind: MessageKind,
  method: string | undefined,
): SourceClassification {
  if (!message) return { sourceClass: 'unknown' };
  const params = asRecord(message['params']);
  const update = asRecord(params?.['update']);
  if (messageKind === 'notification' && method === 'session/update' && update) {
    return { sourceClass: 'session_update_notification', update };
  }
  if (messageKind === 'response') {
    const replay = getBulkReplay(message);
    if (replay) {
      return { sourceClass: 'load_session_bulk_replay_response', replay };
    }
    const result = asRecord(message['result']);
    if (isLoadUpdatesResult(result)) {
      return { sourceClass: 'load_updates_response', result };
    }
    return { sourceClass: 'jsonrpc_response' };
  }
  if (method) return { sourceClass: 'jsonrpc_request' };
  return { sourceClass: 'unknown' };
}

function getMessageKind(message: Record<string, unknown>): MessageKind {
  const method = stringValue(message['method']);
  const hasId = Object.hasOwn(message, 'id');
  if (method) return hasId ? 'request' : 'notification';
  if (
    hasId &&
    (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))
  ) {
    return 'response';
  }
  return 'unknown';
}

function getBulkReplay(
  message: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const result = asRecord(message?.['result']);
  const meta = asRecord(result?.['_meta']);
  return asRecord(meta?.[LOAD_REPLAY_META_KEY]);
}

function isLoadUpdatesResult(
  result: Record<string, unknown> | undefined,
): boolean {
  if (!Array.isArray(result?.['updates'])) return false;
  return (
    typeof result['startTime'] === 'string' ||
    typeof result['lastUpdated'] === 'string' ||
    typeof result['replayError'] === 'string' ||
    typeof result['partial'] === 'boolean'
  );
}

function addUpdatesSummary(
  context: LargePipeFrameContext,
  updates: unknown,
): void {
  if (!Array.isArray(updates)) return;
  context['updateCount'] = updates.length;
  const summarizedUpdateCount = Math.min(
    updates.length,
    MAX_SUMMARIZED_UPDATES,
  );
  if (summarizedUpdateCount < updates.length) {
    context['summarizedUpdateCount'] = summarizedUpdateCount;
  }
  const summary: UpdateSummary = {};
  for (let i = 0; i < summarizedUpdateCount; i += 1) {
    mergeUpdateSummary(summary, summarizeUpdate(asRecord(updates[i])));
  }
  addUpdateSummary(context, summary);
}

function summarizeUpdate(
  update: Record<string, unknown> | undefined,
): UpdateSummary {
  if (!update) return {};
  const meta = asRecord(update['_meta']);
  const summary: UpdateSummary = {};
  summary.sessionUpdate = stringValue(update['sessionUpdate']);
  summary.toolName = stringValue(meta?.['toolName']);
  summary.toolProvenance = stringValue(meta?.['provenance']);

  const contentBytes = contentTextBytes(update['content']);
  if (contentBytes > 0) {
    summary.maxContentTextBytes = contentBytes;
  }
  summary.maxObservedUpdateBytes = contentBytes;

  if (Object.hasOwn(update, 'rawOutput')) {
    const rawOutput = update['rawOutput'];
    summary.rawOutputKind = rawOutputKind(rawOutput);
    if (typeof rawOutput === 'string') {
      const rawOutputTextBytes = Buffer.byteLength(rawOutput, 'utf8');
      summary.maxRawOutputTextBytes = rawOutputTextBytes;
      summary.maxRawOutputObservedBytes = rawOutputTextBytes;
      summary.maxObservedUpdateBytes = Math.max(
        summary.maxObservedUpdateBytes,
        rawOutputTextBytes,
      );
    } else {
      const rawOutputApprox = approximateJsonByteLength(rawOutput);
      if (rawOutputApprox !== undefined) {
        summary.maxRawOutputApproxBytes = rawOutputApprox.bytes;
        if (rawOutputApprox.capped) {
          summary.maxRawOutputApproxBytesCapped = true;
        }
        summary.maxRawOutputObservedBytes = rawOutputApprox.bytes;
        summary.maxObservedUpdateBytes = Math.max(
          summary.maxObservedUpdateBytes,
          rawOutputApprox.bytes,
        );
      }
    }
  }

  return summary;
}

function mergeUpdateSummary(target: UpdateSummary, next: UpdateSummary): void {
  if (
    next.sessionUpdate &&
    target.sessionUpdate &&
    next.sessionUpdate !== target.sessionUpdate
  ) {
    target.mixedSessionUpdate = true;
  }
  if (next.mixedSessionUpdate) {
    target.mixedSessionUpdate = true;
  }
  if (
    next.maxObservedUpdateBytes !== undefined &&
    (target.maxObservedUpdateBytes === undefined ||
      next.maxObservedUpdateBytes > target.maxObservedUpdateBytes)
  ) {
    target.maxObservedUpdateBytes = next.maxObservedUpdateBytes;
    target.sessionUpdate = next.sessionUpdate ?? target.sessionUpdate;
    target.toolName = next.toolName ?? target.toolName;
    target.toolProvenance = next.toolProvenance ?? target.toolProvenance;
  }
  if (
    next.maxContentTextBytes !== undefined &&
    (target.maxContentTextBytes === undefined ||
      next.maxContentTextBytes > target.maxContentTextBytes)
  ) {
    target.maxContentTextBytes = next.maxContentTextBytes;
  }
  if (
    next.maxRawOutputTextBytes !== undefined &&
    (target.maxRawOutputTextBytes === undefined ||
      next.maxRawOutputTextBytes > target.maxRawOutputTextBytes)
  ) {
    target.maxRawOutputTextBytes = next.maxRawOutputTextBytes;
  }
  if (
    next.maxRawOutputApproxBytes !== undefined &&
    (target.maxRawOutputApproxBytes === undefined ||
      next.maxRawOutputApproxBytes > target.maxRawOutputApproxBytes)
  ) {
    target.maxRawOutputApproxBytes = next.maxRawOutputApproxBytes;
  }
  if (next.maxRawOutputApproxBytesCapped) {
    target.maxRawOutputApproxBytesCapped = true;
  }
  if (
    next.maxRawOutputObservedBytes !== undefined &&
    (target.maxRawOutputObservedBytes === undefined ||
      next.maxRawOutputObservedBytes > target.maxRawOutputObservedBytes)
  ) {
    target.maxRawOutputObservedBytes = next.maxRawOutputObservedBytes;
    target.rawOutputKind = next.rawOutputKind;
  }
}

function addUpdateSummary(
  context: LargePipeFrameContext,
  summary: UpdateSummary,
): void {
  addString(context, 'sessionUpdate', summary.sessionUpdate);
  addString(context, 'toolName', summary.toolName);
  addString(context, 'toolProvenance', summary.toolProvenance);
  if (summary.mixedSessionUpdate) context['mixedSessionUpdate'] = true;
  addNumber(context, 'maxContentTextBytes', summary.maxContentTextBytes);
  addNumber(context, 'maxRawOutputTextBytes', summary.maxRawOutputTextBytes);
  addNumber(
    context,
    'maxRawOutputApproxBytes',
    summary.maxRawOutputApproxBytes,
  );
  if (summary.maxRawOutputApproxBytesCapped) {
    context['maxRawOutputApproxBytesCapped'] = true;
  }
  addString(context, 'rawOutputKind', summary.rawOutputKind);
}

function contentTextBytes(value: unknown, depth = 0): number {
  if (depth > MAX_CONTENT_DEPTH) return 0;
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (Array.isArray(value)) {
    return value.reduce(
      (sum, item) => sum + contentTextBytes(item, depth + 1),
      0,
    );
  }
  const record = asRecord(value);
  if (!record) return 0;
  let total = 0;
  const text = stringValue(record['text']);
  if (text) total += Buffer.byteLength(text, 'utf8');
  if (Object.hasOwn(record, 'content')) {
    total += contentTextBytes(record['content'], depth + 1);
  }
  return total;
}

function approximateJsonByteLength(
  value: unknown,
): JsonByteLengthApproximation | undefined {
  const state: JsonByteLengthState = {
    budget: MAX_RAW_OUTPUT_APPROX_BYTES,
    bytes: 0,
    capped: false,
    seen: new WeakSet<object>(),
  };
  if (!addJsonValueBytes(value, state, 0)) return undefined;
  return { bytes: state.bytes, capped: state.capped };
}

function addJsonValueBytes(
  value: unknown,
  state: JsonByteLengthState,
  depth: number,
): boolean {
  if (state.capped) return true;
  switch (typeof value) {
    case 'string':
      addJsonStringBytes(value, state);
      return true;
    case 'number':
      addJsonBytes(state, Number.isFinite(value) ? String(value).length : 4);
      return true;
    case 'boolean':
      addJsonBytes(state, value ? 4 : 5);
      return true;
    case 'object':
      if (value === null) {
        addJsonBytes(state, 4);
        return true;
      }
      if (depth >= MAX_JSON_APPROX_DEPTH) {
        capJsonBytes(state);
        return true;
      }
      if (Array.isArray(value)) {
        addJsonArrayBytes(value, state, depth);
      } else {
        addJsonObjectBytes(value, state, depth);
      }
      return true;
    default:
      return false;
  }
}

function addJsonArrayBytes(
  value: unknown[],
  state: JsonByteLengthState,
  depth: number,
): void {
  if (state.seen.has(value)) {
    capJsonBytes(state);
    return;
  }
  state.seen.add(value);
  addJsonBytes(state, 1);
  for (let i = 0; i < value.length && !state.capped; i += 1) {
    if (i > 0) addJsonBytes(state, 1);
    if (!addJsonValueBytes(value[i], state, depth + 1)) {
      addJsonBytes(state, 4);
    }
  }
  addJsonBytes(state, 1);
  state.seen.delete(value);
}

function addJsonObjectBytes(
  value: object,
  state: JsonByteLengthState,
  depth: number,
): void {
  if (state.seen.has(value)) {
    capJsonBytes(state);
    return;
  }
  state.seen.add(value);
  addJsonBytes(state, 1);

  const record = value as Record<string, unknown>;
  let propertyCount = 0;
  for (const key in record) {
    if (state.capped) break;
    if (!Object.hasOwn(record, key)) continue;
    const item = record[key];
    if (isOmittedJsonObjectValue(item)) continue;
    if (propertyCount > 0) addJsonBytes(state, 1);
    addJsonStringBytes(key, state);
    addJsonBytes(state, 1);
    if (!addJsonValueBytes(item, state, depth + 1)) {
      addJsonBytes(state, 4);
    }
    propertyCount += 1;
  }

  addJsonBytes(state, 1);
  state.seen.delete(value);
}

function addJsonStringBytes(value: string, state: JsonByteLengthState): void {
  addJsonBytes(state, 1);
  if (state.capped) return;

  const remainingForContent = Math.max(0, state.budget - state.bytes - 1);
  const sampleLength = Math.min(value.length, remainingForContent);
  const sample =
    sampleLength < value.length ? value.slice(0, sampleLength) : value;
  addJsonBytes(state, Buffer.byteLength(sample, 'utf8'));
  if (sampleLength < value.length) {
    capJsonBytes(state);
    return;
  }

  addJsonBytes(state, 1);
}

function addJsonBytes(state: JsonByteLengthState, bytes: number): void {
  if (state.capped || bytes <= 0) return;
  const nextBytes = state.bytes + bytes;
  if (nextBytes >= state.budget) {
    capJsonBytes(state);
    return;
  }
  state.bytes = nextBytes;
}

function capJsonBytes(state: JsonByteLengthState): void {
  state.bytes = state.budget;
  state.capped = true;
}

function isOmittedJsonObjectValue(value: unknown): boolean {
  return (
    typeof value === 'undefined' ||
    typeof value === 'function' ||
    typeof value === 'symbol'
  );
}

function rawOutputKind(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function addString(
  context: LargePipeFrameContext,
  key: string,
  value: string | undefined,
): void {
  if (value === undefined) return;
  context[key] =
    value.length > MAX_ATTR_STRING_LENGTH
      ? value.slice(0, MAX_ATTR_STRING_LENGTH)
      : value;
}

function addNumber(
  context: LargePipeFrameContext,
  key: string,
  value: number | undefined,
): void {
  if (value !== undefined) context[key] = value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
