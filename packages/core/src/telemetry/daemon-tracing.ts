/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import {
  context as otelContext,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
} from '@opentelemetry/api';
import { logs, type LogAttributes } from '@opentelemetry/api-logs';
import { SERVICE_NAME } from './constants.js';
import { isTelemetrySdkInitialized } from './sdk.js';
import { truncateSpanError } from './session-tracing.js';

export const DAEMON_TRACEPARENT_META_KEY = 'qwen.telemetry.traceparent';
export const DAEMON_TRACESTATE_META_KEY = 'qwen.telemetry.tracestate';

const SPAN_DAEMON_REQUEST = 'qwen-code.daemon.request';
const SPAN_DAEMON_BRIDGE = 'qwen-code.daemon.bridge';
const EVENT_DAEMON_ERROR = 'qwen-code.daemon.error';

type DaemonAttributes = Record<string, string | number | boolean>;

interface CapturedDaemonContext {
  context: Context;
}

export interface DaemonRequestSpanOptions {
  method: string;
  route: string;
  workspaceHash?: string;
  sessionId?: string;
}

function toOtelAttributes(attrs: DaemonAttributes): Attributes {
  return attrs;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function errorType(error: unknown): string {
  if (error instanceof Error) return error.name || 'Error';
  return typeof error;
}

function activeSpanContextIsValid(): boolean {
  const span = trace.getSpan(otelContext.active());
  if (!span) return false;
  const ctx = span.spanContext();
  return ctx.traceId !== '0'.repeat(32) && ctx.spanId !== '0'.repeat(16);
}

function stripReservedTraceMeta(meta: unknown): Record<string, unknown> {
  const out =
    meta && typeof meta === 'object' && !Array.isArray(meta)
      ? { ...(meta as Record<string, unknown>) }
      : {};
  delete out[DAEMON_TRACEPARENT_META_KEY];
  delete out[DAEMON_TRACESTATE_META_KEY];
  return out;
}

export function hashDaemonWorkspace(workspace: string): string {
  return createHash('sha256').update(workspace).digest('hex').slice(0, 16);
}

export async function withDaemonSpan<T>(
  name: string,
  attributes: DaemonAttributes,
  fn: (span: Span) => Promise<T>,
  options: { autoOkOnSuccess?: boolean } = {},
): Promise<T> {
  const autoOkOnSuccess = options.autoOkOnSuccess ?? true;
  const tracer = trace.getTracer(SERVICE_NAME);
  return await tracer.startActiveSpan(
    name,
    { kind: SpanKind.INTERNAL, attributes: toOtelAttributes(attributes) },
    async (span) => {
      try {
        const result = await fn(span);
        if (autoOkOnSuccess) {
          span.setStatus({ code: SpanStatusCode.OK });
        }
        return result;
      } catch (error) {
        recordDaemonError(span, error);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

export async function withDaemonRequestSpan<T>(
  options: DaemonRequestSpanOptions,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return await withDaemonSpan(
    SPAN_DAEMON_REQUEST,
    {
      'http.request.method': options.method,
      'http.route': options.route,
      'qwen-code.daemon.operation': 'http_request',
      ...(options.workspaceHash
        ? { 'qwen-code.workspace.hash': options.workspaceHash }
        : {}),
      ...(options.sessionId ? { 'session.id': options.sessionId } : {}),
    },
    fn,
    { autoOkOnSuccess: false },
  );
}

export async function withDaemonBridgeSpan<T>(
  operation: string,
  attributes: DaemonAttributes,
  fn: () => Promise<T>,
): Promise<T> {
  return await withDaemonSpan(
    SPAN_DAEMON_BRIDGE,
    {
      'qwen-code.daemon.operation': operation,
      ...attributes,
    },
    async () => await fn(),
  );
}

export function recordDaemonHttpResponse(
  span: Span | undefined,
  statusCode: number,
): void {
  try {
    span?.setAttribute('http.response.status_code', statusCode);
    if (statusCode >= 500) {
      span?.setStatus({
        code: SpanStatusCode.ERROR,
        message: `HTTP ${statusCode}`,
      });
    } else {
      span?.setStatus({ code: SpanStatusCode.OK });
    }
  } catch {
    // Telemetry must not affect request handling.
  }
}

export function recordDaemonError(
  span: Span | undefined,
  error: unknown,
  attributes: DaemonAttributes = {},
): void {
  const target = span ?? trace.getSpan(otelContext.active());
  if (!target) return;
  try {
    const message = truncateSpanError(errorMessage(error));
    target.recordException(error instanceof Error ? error : new Error(message));
    target.setAttributes({
      'error.type': errorType(error),
      'error.message': message,
      ...attributes,
    });
    target.setStatus({ code: SpanStatusCode.ERROR, message });
  } catch {
    // Telemetry must not affect request handling.
  }
}

export function emitDaemonLog(
  body: string,
  attributes: LogAttributes = {},
): void {
  if (!isTelemetrySdkInitialized()) return;
  try {
    logs.getLogger(SERVICE_NAME).emit({
      body,
      attributes: {
        'event.name': EVENT_DAEMON_ERROR,
        'event.timestamp': new Date().toISOString(),
        ...attributes,
      },
    });
  } catch {
    // Telemetry must not affect daemon behavior.
  }
}

export function captureDaemonTelemetryContext(): CapturedDaemonContext {
  return { context: otelContext.active() };
}

export async function runWithDaemonTelemetryContext<T>(
  captured: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  const ctx =
    captured &&
    typeof captured === 'object' &&
    'context' in captured &&
    (captured as CapturedDaemonContext).context
      ? (captured as CapturedDaemonContext).context
      : undefined;
  if (!ctx) return await fn();
  return await otelContext.with(ctx, fn);
}

export function injectDaemonTraceContext<T extends object>(request: T): T {
  const currentMeta = (request as { _meta?: unknown })._meta;
  const nextMeta = stripReservedTraceMeta(currentMeta);

  if (activeSpanContextIsValid()) {
    const carrier: Record<string, string> = {};
    propagation.inject(otelContext.active(), carrier);
    if (carrier['traceparent']) {
      nextMeta[DAEMON_TRACEPARENT_META_KEY] = carrier['traceparent'];
    }
    if (carrier['tracestate']) {
      nextMeta[DAEMON_TRACESTATE_META_KEY] = carrier['tracestate'];
    }
  }

  return {
    ...request,
    _meta: nextMeta,
  };
}

export function extractDaemonTraceContext(
  source: unknown,
): Context | undefined {
  const meta = (source as { _meta?: unknown } | undefined)?._meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return undefined;
  }
  const record = meta as Record<string, unknown>;
  const traceparent = record[DAEMON_TRACEPARENT_META_KEY];
  if (typeof traceparent !== 'string' || traceparent.length === 0) {
    return undefined;
  }
  const carrier: Record<string, string> = { traceparent };
  const tracestate = record[DAEMON_TRACESTATE_META_KEY];
  if (typeof tracestate === 'string' && tracestate.length > 0) {
    carrier['tracestate'] = tracestate;
  }
  const extracted = propagation.extract(otelContext.active(), carrier);
  if (trace.getSpanContext(extracted)) return extracted;

  const parts = traceparent.split('-');
  const traceId = parts[1];
  const spanId = parts[2];
  const flags = parts[3];
  if (
    parts[0] !== '00' ||
    !traceId?.match(/^[0-9a-f]{32}$/) ||
    !spanId?.match(/^[0-9a-f]{16}$/) ||
    !flags?.match(/^[0-9a-f]{2}$/)
  ) {
    return undefined;
  }
  return trace.setSpan(
    otelContext.active(),
    trace.wrapSpanContext({
      traceId,
      spanId,
      traceFlags: Number.parseInt(flags, 16),
    }),
  );
}

export function createDaemonBridgeTelemetry(): {
  captureContext(): unknown;
  runWithContext<T>(captured: unknown, fn: () => Promise<T>): Promise<T>;
  withSpan<T>(
    operation: string,
    attributes: DaemonAttributes,
    fn: () => Promise<T>,
  ): Promise<T>;
  event(name: string, attributes: DaemonAttributes): void;
  injectPromptContext<T extends object>(request: T): T;
} {
  return {
    captureContext: captureDaemonTelemetryContext,
    runWithContext: runWithDaemonTelemetryContext,
    withSpan: withDaemonBridgeSpan,
    event(name, attributes) {
      try {
        const activeSpan = trace.getSpan(otelContext.active());
        if (activeSpan) {
          activeSpan.addEvent(name, attributes);
          return;
        }
        const span = trace
          .getTracer(SERVICE_NAME)
          .startSpan(SPAN_DAEMON_BRIDGE, {
            kind: SpanKind.INTERNAL,
            attributes: {
              'event.name': name,
              'qwen-code.daemon.operation': `event.${name}`,
              ...attributes,
            },
          });
        span.addEvent(name, attributes);
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
      } catch {
        // Telemetry must not affect bridge behavior.
      }
    },
    injectPromptContext: injectDaemonTraceContext,
  };
}
