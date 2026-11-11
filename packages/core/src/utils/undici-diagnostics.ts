/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import diagnosticsChannel from 'node:diagnostics_channel';
import {
  getModelStreamDiagnosticsConfig,
  type ModelStreamDiagnosticsConfig,
} from '../config-service/features/modelStreamDiagnostics.js';


import {
  compactObject,
  type ErrorDiagnostic,
  formatErrorDiagnostic,
  getErrorDiagnostic,
} from './error-fields.js';
import {
  getProcessResourceSnapshot,
  type ProcessResourceSnapshot,
  formatResourceSnapshotLogSuffix,
} from './process-resource-snapshot.js';
import { runLogger } from './runLogger.js';

type UndiciDiagnosticPhase =
  | 'create'
  | 'body_sent'
  | 'headers'
  | 'body_chunk'
  | 'trailers'
  | 'error';

interface UndiciRequestState {
  id: number;
  startedAt: number;
  method?: string;
  origin?: string;
  path?: string;
  traceparent?: string;
  requestTraceId?: string;
  clientRequestId?: string;
  bodyBytes: number;
  bodyChunkCount: number;
  lastProgressAt: number;
  headersAt?: number;
  firstChunkAt?: number;
  lastChunkAt?: number;
  maxChunkGapMs: number;
  statusCode?: number;
  contentType?: string;
  contentLength?: string;
}

interface UndiciRequestMeta {
  method?: string;
  origin?: string;
  path?: string;
  headers: Record<string, string>;
}

interface UndiciResponseMeta {
  statusCode?: number;
  contentType?: string;
  contentLength?: string;
}

interface UndiciDiagnosticExtra {
  chunkBytes?: number;
  chunkGapMs?: number;
  error?: ErrorDiagnostic;
  errorLogMessage?: string;
  resourceSnapshot?: ProcessResourceSnapshot;
}

export interface FetchRuntimeDiagnostics {
  fetchRuntime: string;
  nodeVersion?: string;
  electronVersion?: string;
  chromeVersion?: string;
  undiciVersion?: string;
}

const requestStates = new WeakMap<object, UndiciRequestState>();
let installed = false;
let nextUndiciRequestId = 1;

let cachedRuntimeDiagnostics: FetchRuntimeDiagnostics | undefined;

export function getFetchRuntimeDiagnostics(): FetchRuntimeDiagnostics {
  if (cachedRuntimeDiagnostics) return cachedRuntimeDiagnostics;

  const versions = getProcessVersions();
  const globalWithBun = globalThis as { Bun?: unknown };
  const fetchRuntime =
    globalWithBun.Bun !== undefined || versions?.['bun']
      ? 'bun'
      : versions?.['electron']
        ? 'electron'
        : versions?.['node']
          ? 'node'
          : typeof globalThis.fetch === 'function'
            ? 'browser_or_custom'
            : 'unknown';

  cachedRuntimeDiagnostics = compactObject({
    fetchRuntime,
    nodeVersion: versions?.['node'],
    electronVersion: versions?.['electron'],
    chromeVersion: versions?.['chrome'],
    undiciVersion: versions?.['undici'],
  });
  return cachedRuntimeDiagnostics;
}

export function ensureUndiciDiagnosticsInstalled(): void {
  if (installed) return;

  if (!getModelStreamDiagnosticsConfig().enabled) return;
  installed = true;

  if (getFetchRuntimeDiagnostics().fetchRuntime === 'bun') return;

  try {
    diagnosticsChannel
      .channel('undici:request:create')
      .subscribe(guarded(onRequestCreate));
    diagnosticsChannel
      .channel('undici:request:bodySent')
      .subscribe(guarded(onRequestBodySent));
    diagnosticsChannel
      .channel('undici:request:headers')
      .subscribe(guarded(onRequestHeaders));
    diagnosticsChannel
      .channel('undici:request:bodyChunkReceived')
      .subscribe(guarded(onRequestBodyChunkReceived));
    diagnosticsChannel
      .channel('undici:request:trailers')
      .subscribe(guarded(onRequestTrailers));
    diagnosticsChannel
      .channel('undici:request:error')
      .subscribe(guarded(onRequestError));
  } catch (error) {
    runLogger.debug(
      '[UndiciStreamDiagnostic] Failed to install diagnostics_channel hooks:',
      error instanceof Error ? error.message : String(error),
    );
  }
}

function onRequestCreate(message: unknown, config: ModelStreamDiagnosticsConfig): void {
  const request = getMessageObject(message, 'request');
  if (!request) return;

  const meta = getUndiciRequestMeta(request);
  if (!isRelevantRequest(meta)) return;

  const traceparent = getHeader(meta.headers, 'traceparent');
  const state: UndiciRequestState = {
    id: nextUndiciRequestId++,
    startedAt: Date.now(),
    method: meta.method,
    origin: meta.origin,
    path: meta.path,
    traceparent,
    requestTraceId: parseTraceIdFromTraceparent(traceparent),
    clientRequestId:
      getHeader(meta.headers, 'x-request-id') ??
      getHeader(meta.headers, 'x-qoder-request-id') ??
      getHeader(meta.headers, 'request-id'),
    bodyBytes: 0,
    bodyChunkCount: 0,
    lastProgressAt: 0,
    maxChunkGapMs: 0,
  };
  requestStates.set(request, state);
  reportUndiciDiagnostic(state, 'create', {}, config);
}

function onRequestBodySent(message: unknown, config: ModelStreamDiagnosticsConfig): void {
  const state = getStateFromMessage(message);
  if (!state) return;
  reportUndiciDiagnostic(state, 'body_sent', {}, config);
}

function onRequestHeaders(message: unknown, config: ModelStreamDiagnosticsConfig): void {
  const state = getStateFromMessage(message);
  if (!state) return;
  state.headersAt = Date.now();
  const response = getMessageObject(message, 'response');
  if (response) {
    const meta = getUndiciResponseMeta(response);
    state.statusCode = meta.statusCode;
    state.contentType = meta.contentType;
    state.contentLength = meta.contentLength;
  }
  reportUndiciDiagnostic(state, 'headers', {}, config);
}

function onRequestBodyChunkReceived(message: unknown, config: ModelStreamDiagnosticsConfig): void {
  const state = getStateFromMessage(message);
  if (!state) return;
  const chunkBytes = getChunkBytes(getMessageValue(message, 'chunk'));
  const now = Date.now();
  const previousChunkAt = state.lastChunkAt ?? state.headersAt ?? state.startedAt;
  const chunkGapMs = Math.max(now - previousChunkAt, 0);
  if (state.firstChunkAt === undefined) {
    state.firstChunkAt = now;
  }
  state.lastChunkAt = now;
  state.maxChunkGapMs = Math.max(state.maxChunkGapMs, chunkGapMs);
  state.bodyChunkCount++;
  state.bodyBytes += chunkBytes;

  const shouldReport =
    state.bodyChunkCount === 1 ||
    state.bodyChunkCount % config.progressChunkEvery === 0 ||
    now - state.lastProgressAt >= config.progressIntervalMs;
  if (!shouldReport) return;
  state.lastProgressAt = now;
  reportUndiciDiagnostic(state, 'body_chunk', { chunkBytes, chunkGapMs }, config);
}

function onRequestTrailers(message: unknown, config: ModelStreamDiagnosticsConfig): void {
  const state = getStateFromMessage(message);
  if (!state) return;
  reportUndiciDiagnostic(state, 'trailers', {}, config);
}

function onRequestError(message: unknown, config: ModelStreamDiagnosticsConfig): void {
  const state = getStateFromMessage(message);
  if (!state) return;
  const error = getMessageValue(message, 'error');
  const errorDiag = getErrorDiagnostic(error);
  reportUndiciDiagnostic(
    state,
    'error',
    {
      error: errorDiag,
      errorLogMessage: errorDiag
        ? formatErrorDiagnostic(errorDiag)
        : undefined,
      resourceSnapshot: config.includeResourceSnapshotOnError
        ? getProcessResourceSnapshot()
        : undefined,
    },
    config,
    true,
  );
}

function reportUndiciDiagnostic(
  state: UndiciRequestState,
  phase: UndiciDiagnosticPhase,
  extra: UndiciDiagnosticExtra,
  config: ModelStreamDiagnosticsConfig,
  warn = false,
): void {
  const now = Date.now();
  const elapsedMs = now - state.startedAt;
  const lastChunkAgeMs =
    state.lastChunkAt === undefined ? undefined : Math.max(now - state.lastChunkAt, 0);
  const errorMessage = extra.errorLogMessage;
  const resourceSnapshot = extra.resourceSnapshot;
  const line =
    `[UndiciStreamDiagnostic] phase=${phase}, id=${state.id}, ` +
    `method=${state.method ?? ''}, origin=${state.origin ?? ''}, ` +
    `path=${state.path ?? ''}, status=${state.statusCode ?? ''}, ` +
    `bytes=${state.bodyBytes}, chunkCount=${state.bodyChunkCount}, ` +
    `chunkBytes=${extra.chunkBytes ?? 'n/a'}, chunkGapMs=${extra.chunkGapMs ?? 'n/a'}, ` +
    `maxChunkGapMs=${state.maxChunkGapMs}, lastChunkAgeMs=${lastChunkAgeMs ?? 'n/a'}, ` +
    `elapsedMs=${elapsedMs}, ` +
    `traceId=${state.requestTraceId ?? ''}, requestId=${state.clientRequestId ?? ''}` +
    (errorMessage ? `, error=${errorMessage}` : '') +
    formatResourceSnapshotLogSuffix(resourceSnapshot);

  if (warn || phase === 'error') {
    runLogger.warn(line);
  } else if (phase === 'body_chunk') {
    runLogger.debug(line);
  } else {
    runLogger.log(line);
  }
}

function getEnabledDiagnosticsConfig(): ModelStreamDiagnosticsConfig | undefined {
  const config = getModelStreamDiagnosticsConfig();
  return config.enabled ? config : undefined;
}

function guarded(
  fn: (message: unknown, config: ModelStreamDiagnosticsConfig) => void,
): (message: unknown) => void {
  return (message: unknown) => {
    const config = getEnabledDiagnosticsConfig();
    if (config) fn(message, config);
  };
}

function getStateFromMessage(message: unknown): UndiciRequestState | undefined {
  const request = getMessageObject(message, 'request');
  if (!request) return undefined;
  return requestStates.get(request);
}

function isRelevantRequest(meta: UndiciRequestMeta): boolean {
  const path = meta.path ?? '';
  if (path.includes('/algo/api/v2/service/pro/sse/agent_chat_generation')) {
    return true;
  }
  if (path.includes('/model/v1/chat/completions')) {
    return true;
  }
  return false;
}

function getUndiciRequestMeta(request: object): UndiciRequestMeta {
  const record = request as Record<string, unknown>;
  return {
    method: stringify(record['method']),
    origin: stringify(record['origin']),
    path: stringify(record['path']),
    headers: parseHeaders(record['headers']),
  };
}

function getUndiciResponseMeta(response: object): UndiciResponseMeta {
  const record = response as Record<string, unknown>;
  const headers = parseHeaders(record['headers']);
  return {
    statusCode: toNumber(record['statusCode']),
    contentType: getHeader(headers, 'content-type'),
    contentLength: getHeader(headers, 'content-length'),
  };
}

function parseHeaders(value: unknown): Record<string, string> {
  const headers: Record<string, string> = {};

  if (Array.isArray(value)) {
    for (let i = 0; i + 1 < value.length; i += 2) {
      const key = stringify(value[i]);
      if (!key) continue;
      headers[key.toLowerCase()] = stringify(value[i + 1]) ?? '';
    }
    return headers;
  }

  if (typeof value === 'string') {
    for (const line of value.split(/\r?\n/)) {
      const colonIndex = line.indexOf(':');
      if (colonIndex <= 0) continue;
      const key = line.slice(0, colonIndex).trim().toLowerCase();
      if (!key) continue;
      headers[key] = line.slice(colonIndex + 1).trim();
    }
    return headers;
  }

  if (isObject(value)) {
    for (const [key, raw] of Object.entries(value)) {
      headers[key.toLowerCase()] = stringify(raw) ?? '';
    }
  }

  return headers;
}

function getHeader(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const value = headers[name.toLowerCase()];
  return value === '' ? undefined : value;
}

function parseTraceIdFromTraceparent(
  traceparent: string | undefined,
): string | undefined {
  const match = traceparent?.match(/^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/i);
  return match?.[1];
}

function getChunkBytes(chunk: unknown): number {
  if (chunk instanceof Uint8Array) return chunk.byteLength;
  if (typeof chunk === 'string') return Buffer.byteLength(chunk);
  if (chunk instanceof ArrayBuffer) return chunk.byteLength;
  return 0;
}

function getMessageObject(message: unknown, key: string): object | undefined {
  const value = getMessageValue(message, key);
  return isObject(value) ? value : undefined;
}

function getMessageValue(message: unknown, key: string): unknown {
  return isObject(message) ? message[key] : undefined;
}

function stringify(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  return String(value);
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getProcessVersions(): Record<string, string | undefined> | undefined {
  const maybeProcess = globalThis as {
    process?: { versions?: Record<string, string | undefined> };
  };
  return maybeProcess.process?.versions;
}
