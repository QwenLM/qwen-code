/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

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
  maxContentTextBytes?: number;
  maxRawOutputTextBytes?: number;
  rawOutputKind?: string;
  sessionUpdate?: string;
  toolName?: string;
  toolProvenance?: string;
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
        return;
      }

      const context = classifyLargePipeFrame(observation, thresholdBytes);
      if (!context) return;
      if (suppressedCount > 0) {
        context['suppressedCount'] = suppressedCount;
        suppressedCount = 0;
      }
      emittedInWindow += 1;

      try {
        options.daemonLog.warn('large ACP pipe frame observed', context);
      } catch {
        // Observability must not affect transport behavior.
      }
      options.emitTelemetryLog?.('Large ACP pipe frame observed.', context, {
        eventName: LARGE_PIPE_FRAME_EVENT_NAME,
      });
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
  const sourceClass = classifySource(message, messageKind, method);
  const context: LargePipeFrameContext = {
    direction: observation.direction,
    bytes: observation.bytes,
    thresholdBytes,
    messageKind,
    sourceClass,
  };
  addString(context, 'method', method);

  if (sourceClass === 'session_update_notification') {
    const params = asRecord(message?.['params']);
    const update = asRecord(params?.['update']);
    addUpdateSummary(context, summarizeUpdate(update));
  } else if (sourceClass === 'load_session_bulk_replay_response') {
    const replay = getBulkReplay(message);
    addUpdatesSummary(context, replay?.['updates']);
  } else if (sourceClass === 'load_updates_response') {
    const result = asRecord(message?.['result']);
    addUpdatesSummary(context, result?.['updates']);
  }

  return context;
}

function classifySource(
  message: Record<string, unknown> | undefined,
  messageKind: MessageKind,
  method: string | undefined,
): SourceClass {
  if (!message) return 'unknown';
  if (
    messageKind === 'notification' &&
    method === 'session/update' &&
    asRecord(asRecord(message['params'])?.['update'])
  ) {
    return 'session_update_notification';
  }
  if (messageKind === 'response') {
    if (getBulkReplay(message)) return 'load_session_bulk_replay_response';
    if (isLoadUpdatesResponse(message)) return 'load_updates_response';
    return 'jsonrpc_response';
  }
  if (method) return 'jsonrpc_request';
  return 'unknown';
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
  return asRecord(meta?.['qwen.session.loadReplay']);
}

function isLoadUpdatesResponse(message: Record<string, unknown>): boolean {
  const result = asRecord(message['result']);
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
  const summary: UpdateSummary = {};
  for (const update of updates) {
    mergeUpdateSummary(summary, summarizeUpdate(asRecord(update)));
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

  if (Object.hasOwn(update, 'rawOutput')) {
    const rawOutput = update['rawOutput'];
    summary.rawOutputKind = rawOutputKind(rawOutput);
    if (typeof rawOutput === 'string') {
      summary.maxRawOutputTextBytes = Buffer.byteLength(rawOutput, 'utf8');
    }
  }

  return summary;
}

function mergeUpdateSummary(target: UpdateSummary, next: UpdateSummary): void {
  target.sessionUpdate ??= next.sessionUpdate;
  target.toolName ??= next.toolName;
  target.toolProvenance ??= next.toolProvenance;
  target.rawOutputKind ??= next.rawOutputKind;
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
  addNumber(context, 'maxContentTextBytes', summary.maxContentTextBytes);
  addNumber(context, 'maxRawOutputTextBytes', summary.maxRawOutputTextBytes);
  addString(context, 'rawOutputKind', summary.rawOutputKind);
}

function contentTextBytes(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + contentTextBytes(item), 0);
  }
  const record = asRecord(value);
  if (!record) return 0;
  let total = 0;
  const text = stringValue(record['text']);
  if (text) total += Buffer.byteLength(text, 'utf8');
  if (Object.hasOwn(record, 'content')) {
    total += contentTextBytes(record['content']);
  }
  return total;
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
