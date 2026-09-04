/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import {
  context as otelContext,
  defaultTextMapGetter,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  TraceFlags,
  type Context,
  type Span,
  type TextMapPropagator,
} from '@opentelemetry/api';
import { logs, type LogAttributes } from '@opentelemetry/api-logs';
import { SERVICE_NAME } from './constants.js';
import { isTelemetrySdkInitialized } from './sdk.js';
import { shouldForceSampled } from './tracer.js';
import { truncateSpanError } from './session-tracing.js';
import {
  formatTraceparent,
  getActiveSpanTraceContext,
} from './trace-context.js';
import { setSessionIdOnContext } from './session-context.js';

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
  startTime?: Date;
  deferredRuntimeWaitMs?: number;
  deferredRuntimePath?: 'started_on_request' | 'joined';
  workspaceHash?: string;
  sessionId?: string;
  clientId?: string;
  permissionRequestId?: string;
  parentContext?: Context;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function errorType(error: unknown): string {
  if (error instanceof Error) return error.name || 'Error';
  return typeof error;
}

function stripReservedTraceMeta(meta: unknown): Record<string, unknown> {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {};
  const record = meta as Record<string, unknown>;
  if (
    !(DAEMON_TRACEPARENT_META_KEY in record) &&
    !(DAEMON_TRACESTATE_META_KEY in record)
  ) {
    return { ...record };
  }
  const out = { ...record };
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
  options: {
    autoOkOnSuccess?: boolean;
    parentContext?: Context;
    startTime?: Date;
  } = {},
): Promise<T> {
  if (!isTelemetrySdkInitialized()) {
    return await fn(undefined as unknown as Span);
  }
  const autoOkOnSuccess = options.autoOkOnSuccess ?? true;
  const tracer = trace.getTracer(SERVICE_NAME);
  const spanOptions = {
    kind: SpanKind.INTERNAL,
    attributes,
    ...(options.startTime ? { startTime: options.startTime } : {}),
  };
  const run = async (span: Span): Promise<T> => {
    const sessionId = attributes['session.id'];
    const scopedContext = setSessionIdOnContext(
      otelContext.active(),
      typeof sessionId === 'string' ? sessionId : undefined,
    );
    return await otelContext.with(scopedContext, async () => {
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
    });
  };
  return options.parentContext
    ? await tracer.startActiveSpan(
        name,
        spanOptions,
        options.parentContext,
        run,
      )
    : await tracer.startActiveSpan(name, spanOptions, run);
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
      ...(options.clientId ? { 'qwen-code.client_id': options.clientId } : {}),
      ...(options.permissionRequestId
        ? {
            'qwen-code.daemon.permission.request_id':
              options.permissionRequestId,
          }
        : {}),
      ...(options.deferredRuntimeWaitMs !== undefined
        ? {
            'qwen-code.daemon.runtime.wait_ms': options.deferredRuntimeWaitMs,
          }
        : {}),
      ...(options.deferredRuntimePath
        ? { 'qwen-code.daemon.runtime.path': options.deferredRuntimePath }
        : {}),
    },
    fn,
    {
      autoOkOnSuccess: false,
      startTime: options.startTime,
      parentContext: options.parentContext,
    },
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
  } catch {
    // Telemetry must not affect request handling.
  }
}

export function addDaemonRequestAttribute(
  key: string,
  value: string | number | boolean,
): void {
  try {
    trace.getSpan(otelContext.active())?.setAttribute(key, value);
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
  options?: { eventName?: string; severityNumber?: number },
): void {
  if (!isTelemetrySdkInitialized()) return;
  try {
    logs.getLogger(SERVICE_NAME).emit({
      body,
      timestamp: new Date(),
      attributes: {
        'event.name': options?.eventName ?? EVENT_DAEMON_ERROR,
        ...attributes,
      },
      ...(options?.severityNumber != null
        ? { severityNumber: options.severityNumber }
        : {}),
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

  try {
    const ctx = getActiveSpanTraceContext();
    if (ctx) {
      nextMeta[DAEMON_TRACEPARENT_META_KEY] = formatTraceparent(ctx);
    }
  } catch {
    // Telemetry must not affect prompt forwarding.
  }

  if (!currentMeta && !nextMeta[DAEMON_TRACEPARENT_META_KEY]) {
    return request;
  }

  return {
    ...request,
    _meta: nextMeta,
  };
}

// Fallback propagator for `contextFromTraceparentValues` below. The global
// propagator stays a no-op unless the daemon SDK registered one (opt-in
// outbound propagation), so extraction needs a direct W3C instance to apply
// the same acceptance rules — future traceparent versions, tracestate,
// all-zero ids — as the registered path. The instance is injected by the
// lazy SDK chunk (`sdk-impl.ts`) instead of being constructed here: this
// module sits on every CLI launch's static startup graph, and
// @opentelemetry/core is a CJS barrel that tree-shaking cannot slim down
// (~65 KB per launch even with telemetry off). Until the SDK initializes,
// the holder stays empty and extraction returns no parent context — the
// telemetry-off state, with no OTel side effects.
let daemonFallbackPropagator: TextMapPropagator | undefined;

/**
 * Install the W3C fallback propagator used by inbound traceparent
 * extraction. Called by the dynamically imported SDK chunk (`sdk-impl.ts`)
 * once telemetry is actually enabled, so @opentelemetry/core never enters
 * the static startup graph (the `TextMapPropagator` type import above costs
 * nothing at runtime).
 */
export function setDaemonFallbackPropagator(
  propagator: TextMapPropagator,
): void {
  daemonFallbackPropagator = propagator;
}

function contextFromTraceparentValues(
  traceparent: string,
  tracestate: unknown,
): Context | undefined {
  const carrier: Record<string, string> = { traceparent };
  if (typeof tracestate === 'string' && tracestate.length > 0) {
    carrier['tracestate'] = tracestate;
  }
  const extracted = propagation.extract(ROOT_CONTEXT, carrier);
  if (trace.getSpanContext(extracted)) return extracted;
  if (!daemonFallbackPropagator) return undefined;
  const fallback = daemonFallbackPropagator.extract(
    ROOT_CONTEXT,
    carrier,
    defaultTextMapGetter,
  );
  return trace.getSpanContext(fallback) ? fallback : undefined;
}

// A remote caller's `sampled=0` is head-based ratio sampling on their
// side, not a request to drop daemon telemetry. Under the default
// parentbased_always_on sampler a remote unsampled parent delegates to
// AlwaysOff, silently deleting the request span, everything under it, and —
// via _meta forwarding — the session subprocess spans. Reuse the
// session-root decision matrix: parentbased defaults and always_on force
// SAMPLED; parentbased_always_off honors the operator's opt-out;
// non-parentbased samplers decide per span.
function forceSampledUnderSampler(
  extracted: Context | undefined,
): Context | undefined {
  if (!extracted || !shouldForceSampled()) return extracted;
  const spanContext = trace.getSpanContext(extracted);
  if (!spanContext) return extracted;
  return trace.setSpan(
    extracted,
    trace.wrapSpanContext({
      ...spanContext,
      traceFlags: spanContext.traceFlags | TraceFlags.SAMPLED,
    }),
  );
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
  // The _meta path is reachable from two kinds of callers: the in-process
  // bridge (injectDaemonTraceContext, values already SAMPLED so forcing is a
  // no-op) and direct ACP clients whose request _meta is external input just
  // like the HTTP header — so both edges get the same sampled protection.
  return forceSampledUnderSampler(
    contextFromTraceparentValues(
      traceparent,
      record[DAEMON_TRACESTATE_META_KEY],
    ),
  );
}

export function extractDaemonHttpTraceContext(
  headers: Record<string, unknown> | undefined,
): Context | undefined {
  const traceparent = headers?.['traceparent'];
  if (typeof traceparent !== 'string' || traceparent.length === 0) {
    return undefined;
  }
  const extracted = contextFromTraceparentValues(
    traceparent,
    headers?.['tracestate'],
  );
  return forceSampledUnderSampler(extracted);
}

const TRACEPARENT_RE =
  /^\s?([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?\s?$/;
const ALL_ZERO_TRACE_ID = '0'.repeat(32);
const ALL_ZERO_SPAN_ID = '0'.repeat(16);

/**
 * Extract the caller's trace id from an inbound `traceparent` header without
 * any OpenTelemetry machinery. Unlike {@link extractDaemonHttpTraceContext}
 * (which builds a span parent and needs the W3C propagator — only installed
 * once the telemetry SDK starts), this is a plain format check so the daemon
 * log can carry the caller's trace id even with telemetry disabled: the
 * log-based join then works with no trace backend at all. The acceptance
 * rules mirror the vendored W3C propagator exactly (single optional leading/
 * trailing whitespace, trailing fields allowed above version `00`, `ff` and
 * all-zero ids rejected), so a header either joins on both paths or neither.
 */
export function extractInboundTraceId(
  headers: Record<string, unknown> | undefined,
): string | undefined {
  const traceparent = headers?.['traceparent'];
  if (typeof traceparent !== 'string' || traceparent.length === 0) {
    return undefined;
  }
  const match = TRACEPARENT_RE.exec(traceparent);
  if (!match) return undefined;
  // match: [full, version, traceId, spanId, flags, trailingFields]
  const [, version, traceId, spanId, , trailing] = match;
  // Version 00 must be exactly four fields; higher versions may carry
  // trailing extension fields the parser ignores — same as the propagator.
  if (version === '00' && trailing !== undefined) return undefined;
  if (version === 'ff') return undefined;
  if (traceId === ALL_ZERO_TRACE_ID || spanId === ALL_ZERO_SPAN_ID) {
    return undefined;
  }
  return traceId;
}

export interface DaemonBridgeTelemetryMetrics {
  sessionLifecycle(action: 'spawn' | 'close' | 'die'): void;
  channelLifecycle(action: 'spawn' | 'exit', expected?: boolean): void;
  promptQueueWait(durationMs: number): void;
  promptDuration(durationMs: number): void;
  cancelled(): void;
  /**
   * Per-round model token usage (input/output token increments) observed at the
   * bridge's session/update fan-in, from `agent_message_chunk._meta.usage`.
   * Values are per-round increments, not cumulative. `durationMs` is the same
   * frame's `_meta.durationMs` (the LLM API round-trip time), present only when
   * the emitter stamped it. `apiErrors` / `apiRetries` are the same frame's
   * per-round model-API-error and automatic-retry increments (0 when none), for
   * the Daemon Status model-API-health charts. Optional: only the daemon host
   * wires it (for the token-burn / LLM-latency / API-health charts);
   * embedded/test callers may omit it.
   */
  tokenUsage?(
    inputTokens: number,
    outputTokens: number,
    durationMs?: number,
    apiErrors?: number,
    apiRetries?: number,
  ): void;
}

export function createDaemonBridgeTelemetry(): {
  captureContext(): unknown;
  runWithContext<T>(captured: unknown, fn: () => Promise<T>): Promise<T>;
  withSpan<T>(
    operation: string,
    attributes: DaemonAttributes,
    fn: () => Promise<T>,
  ): Promise<T>;
  setActiveSpanAttributes?(attributes: DaemonAttributes): void;
  event(name: string, attributes: DaemonAttributes): void;
  injectPromptContext<T extends object>(request: T): T;
  metrics?: DaemonBridgeTelemetryMetrics;
} {
  return {
    captureContext: captureDaemonTelemetryContext,
    runWithContext: runWithDaemonTelemetryContext,
    withSpan: withDaemonBridgeSpan,
    setActiveSpanAttributes(attributes) {
      if (!isTelemetrySdkInitialized()) return;
      try {
        trace.getSpan(otelContext.active())?.setAttributes(attributes);
      } catch {
        // Telemetry must not affect bridge behavior.
      }
    },
    event(name, attributes) {
      if (!isTelemetrySdkInitialized()) return;
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
