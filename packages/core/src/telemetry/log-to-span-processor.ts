/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isSpanContextValid,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  type HrTime,
  type SpanContext,
} from '@opentelemetry/api';
import type {
  LogRecordProcessor,
  ReadableLogRecord,
} from '@opentelemetry/sdk-logs';
import type { SpanExporter, ReadableSpan } from '@opentelemetry/sdk-trace-base';
import {
  type Resource,
  resourceFromAttributes,
} from '@opentelemetry/resources';

import { EVENT_SUBAGENT_EXECUTION, SERVICE_NAME } from './constants.js';
import {
  deriveTraceId,
  randomHexString,
  randomSpanId,
} from './trace-id-utils.js';
import { getCurrentSessionId } from './session-context.js';

/**
 * LogRecord event names that have native span coverage elsewhere and
 * should NOT be bridged to a duplicate `qwen-code.<event>` span. Today
 * subagent_execution is the only one — the native `qwen-code.subagent`
 * span (#3731 Phase 3) provides richer hierarchy via `runInSubagentSpanContext`,
 * so the bridge span here would duplicate without adding anything.
 *
 * The LogRecord itself still flows through to other consumers
 * (QwenLogger RUM, metrics counter) — only the span bridge is skipped.
 */
const BRIDGE_SKIP_EVENT_NAMES = new Set<string>([EVENT_SUBAGENT_EXECUTION]);

const EXPORT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER_SIZE = 10_000;
const BUFFER_OVERFLOW_WARNING_INTERVAL_MS = 30_000;
const LOG_EVENT_ERROR_STATUS_MESSAGE = 'Log event recorded error';
const DEFAULT_LOG_SPAN_NAME = 'log.event';
const MAX_SPAN_NAME_LENGTH = 128;
const SENSITIVE_ATTRIBUTE_KEYS = new Set([
  'error',
  'error.message',
  'error_message',
  'prompt',
  'function_args',
  'response_text',
]);

/**
 * Sink for processor-internal diagnostic messages (export failures, buffer
 * overflows, timeouts). Messages are passed without a trailing newline — the
 * sink implementation decides how to terminate them.
 *
 * Default sink writes to stderr to keep diagnostics visible when the host
 * environment has no other logging pipeline. Hosts running a TUI should
 * inject a sink that routes to a file-based logger to avoid the message
 * landing in the rendered terminal area.
 */
export type LogToSpanDiagnosticsSink = (message: string) => void;

const defaultDiagnosticsSink: LogToSpanDiagnosticsSink = (message) => {
  process.stderr.write(`${message}\n`);
};

interface LogToSpanProcessorOptions {
  flushIntervalMs?: number;
  includeSensitiveSpanAttributes?: boolean;
  maxBufferSize?: number;
  diagnosticsSink?: LogToSpanDiagnosticsSink;
}

/**
 * A LogRecordProcessor that converts each OTel log record into a span
 * and exports it directly through the provided SpanExporter.
 *
 * This bridges the gap for backends (e.g., Alibaba Cloud) that support
 * traces and metrics but not logs over OTLP. Instead of going through
 * the global TracerProvider (which can break in bundled environments),
 * this processor directly constructs ReadableSpan objects and feeds
 * them to the exporter.
 *
 * Internal diagnostics (export failures, buffer overflows, timeouts) are
 * routed through {@link LogToSpanDiagnosticsSink} so TUI hosts can keep
 * them off the rendered terminal area; see the `diagnosticsSink` option.
 *
 * When a log record has a `duration_ms` attribute, the resulting span
 * will have a matching duration. Otherwise, the span is instantaneous.
 */
export class LogToSpanProcessor implements LogRecordProcessor {
  private buffer: ReadableSpanLike[] = [];
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private inFlightExport: Promise<void> | undefined;
  private readonly flushIntervalMs: number;
  private cachedSessionId: string | undefined;
  private cachedTraceId: string | undefined;
  private readonly includeSensitiveSpanAttributes: boolean;
  private readonly maxBufferSize: number;
  private readonly diagnosticsSink: LogToSpanDiagnosticsSink;
  private lastBufferOverflowWarningMs: number | undefined;
  private droppedSpansSinceLastBufferWarning = 0;
  private totalDroppedSpans = 0;
  private isShutdown = false;

  constructor(spanExporter: SpanExporter);
  constructor(
    spanExporter: SpanExporter,
    flushIntervalMs: number,
    maxBufferSize?: number,
  );
  constructor(spanExporter: SpanExporter, options: LogToSpanProcessorOptions);
  constructor(
    private readonly spanExporter: SpanExporter,
    flushIntervalMsOrOptions: number | LogToSpanProcessorOptions = 5000,
    maxBufferSize = DEFAULT_MAX_BUFFER_SIZE,
  ) {
    if (typeof flushIntervalMsOrOptions === 'number') {
      this.flushIntervalMs = flushIntervalMsOrOptions;
      this.includeSensitiveSpanAttributes = false;
      this.maxBufferSize = normalizeMaxBufferSize(maxBufferSize);
      this.diagnosticsSink = defaultDiagnosticsSink;
    } else {
      this.flushIntervalMs = flushIntervalMsOrOptions.flushIntervalMs ?? 5000;
      this.includeSensitiveSpanAttributes =
        flushIntervalMsOrOptions.includeSensitiveSpanAttributes ?? false;
      this.maxBufferSize = normalizeMaxBufferSize(
        flushIntervalMsOrOptions.maxBufferSize,
      );
      this.diagnosticsSink =
        flushIntervalMsOrOptions.diagnosticsSink ?? defaultDiagnosticsSink;
    }
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
    this.flushTimer.unref();
  }

  onEmit(logRecord: ReadableLogRecord): void {
    if (this.isShutdown) {
      return;
    }

    // Short-circuit before any work for events with native span coverage
    // (#3731 Phase 3 — see BRIDGE_SKIP_EVENT_NAMES). LogRecord still
    // reaches other consumers via the normal LogRecord pipeline.
    const eventName = logRecord.attributes?.['event.name'];
    if (
      typeof eventName === 'string' &&
      BRIDGE_SKIP_EVENT_NAMES.has(eventName)
    ) {
      return;
    }

    const name = deriveSpanName(logRecord);
    const startTime = logRecord.hrTime;

    const attributes: Record<string, string | number | boolean> = {};
    if (logRecord.attributes) {
      for (const [key, value] of Object.entries(logRecord.attributes)) {
        if (
          value !== undefined &&
          value !== null &&
          (this.includeSensitiveSpanAttributes ||
            !SENSITIVE_ATTRIBUTE_KEYS.has(key))
        ) {
          attributes[key] =
            typeof value === 'object'
              ? safeStringify(value)
              : (value as string | number | boolean);
        }
      }
    }
    attributes['log.bridge'] = true;

    // Preserve severity so downstream queries can filter by log level.
    if (logRecord.severityNumber !== undefined) {
      attributes['log.severity_number'] = logRecord.severityNumber;
    }
    if (logRecord.severityText) {
      attributes['log.severity_text'] = logRecord.severityText;
    }

    let endTime = startTime;
    const durationMs = logRecord.attributes?.['duration_ms'];
    if (
      typeof durationMs === 'number' &&
      Number.isFinite(durationMs) &&
      durationMs > 0
    ) {
      const [secs, nanos] = startTime;
      const durationNanos = durationMs * 1_000_000;
      const endNanos = nanos + durationNanos;
      endTime = [secs + Math.floor(endNanos / 1e9), endNanos % 1e9] as HrTime;
    }

    // Prefer a real active span context when OTel logs provide one, preserving
    // direct parentage. Otherwise derive traceId from session.id so all events
    // in one session appear under a single trace.  Fall back to
    // getCurrentSessionId() when the log record has no session.id attribute
    // (e.g. after a session change via /clear or /resume).
    const parentSpanContext = getValidParentSpanContext(logRecord.spanContext);
    // || (not ??) so empty-string session.id also falls through to the fallback
    const sessionId =
      logRecord.attributes?.['session.id'] || getCurrentSessionId();
    let traceId: string;
    if (parentSpanContext) {
      traceId = parentSpanContext.traceId;
    } else if (sessionId) {
      const sid = String(sessionId);
      if (sid !== this.cachedSessionId) {
        this.cachedSessionId = sid;
        this.cachedTraceId = deriveTraceId(sid);
      }
      traceId = this.cachedTraceId!;
    } else {
      traceId = randomHexString(32);
    }
    const spanId = randomSpanId();

    this.buffer.push({
      name,
      kind: SpanKind.INTERNAL,
      spanContext: () => ({
        traceId,
        spanId,
        traceFlags: parentSpanContext?.traceFlags ?? TraceFlags.SAMPLED,
      }),
      startTime,
      endTime,
      duration: hrTimeDiff(startTime, endTime),
      attributes,
      status: deriveSpanStatus(logRecord.attributes),
      events: [],
      links: [],
      resource: logRecord.resource ?? resourceFromAttributes({}),
      instrumentationScope: logRecord.instrumentationScope ?? {
        name: SERVICE_NAME,
        version: '',
      },
      ended: true,
      parentSpanContext,
      droppedAttributesCount: 0,
      droppedEventsCount: 0,
      droppedLinksCount: 0,
      recordException: () => {},
    });
    if (this.buffer.length > this.maxBufferSize) {
      const droppedSpanCount = this.buffer.length - this.maxBufferSize;
      this.buffer.splice(0, droppedSpanCount);
      this.warnBufferOverflow(droppedSpanCount);
    }
  }

  private warnBufferOverflow(droppedSpanCount: number): void {
    this.droppedSpansSinceLastBufferWarning += droppedSpanCount;
    this.totalDroppedSpans += droppedSpanCount;
    const now = Date.now();
    if (
      this.lastBufferOverflowWarningMs !== undefined &&
      now - this.lastBufferOverflowWarningMs <
        BUFFER_OVERFLOW_WARNING_INTERVAL_MS
    ) {
      return;
    }

    this.emitBufferOverflowWarning(now);
  }

  private emitBufferOverflowWarning(now = Date.now()): void {
    if (this.droppedSpansSinceLastBufferWarning === 0) {
      return;
    }

    const droppedSinceLastWarning = this.droppedSpansSinceLastBufferWarning;
    this.droppedSpansSinceLastBufferWarning = 0;
    this.lastBufferOverflowWarningMs = now;
    this.emitDiagnostic(
      `[LogToSpan] buffer exceeded max size (${this.maxBufferSize}); dropped ${droppedSinceLastWarning} oldest span(s) since last warning, ${this.totalDroppedSpans} total`,
    );
  }

  /**
   * Route a diagnostic message to the configured sink, swallowing any sink
   * error so a misbehaving sink can never interrupt telemetry ingestion.
   *
   * Tradeoff: when the sink itself is broken (e.g. file-logger failing on
   * EACCES), bridge-specific diagnostics go dark. We accept that — the host
   * surfaces overall logging health via `isDebugLoggingDegraded()`, and
   * falling back to stderr here would re-introduce the TUI-pollution this
   * sink injection was added to prevent.
   */
  private emitDiagnostic(message: string): void {
    try {
      this.diagnosticsSink(message);
    } catch {
      // Diagnostics must never interrupt telemetry ingestion.
    }
  }

  private flush(): Promise<void> {
    if (this.inFlightExport) return this.inFlightExport;
    if (this.buffer.length === 0) return Promise.resolve();
    const spans = this.buffer.splice(0);
    const exportPromise = new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.emitDiagnostic(
          `[LogToSpan] export timeout after ${EXPORT_TIMEOUT_MS}ms (${spans.length} span(s))`,
        );
        resolve();
      }, EXPORT_TIMEOUT_MS);
      timeout.unref();

      try {
        this.spanExporter.export(
          spans as unknown as ReadableSpan[],
          (result) => {
            clearTimeout(timeout);
            if (result.code !== 0) {
              this.emitDiagnostic(
                `[LogToSpan] export failed: code=${result.code} ${formatExportError(result.error)}`,
              );
            }
            resolve();
          },
        );
      } catch (err) {
        clearTimeout(timeout);
        // Reuse formatExportError for Error instances so a sync-thrown
        // OTLPExporterError surfaces httpCode/data the same way callback
        // failures do. Non-Error throws fall back to JSON.stringify to
        // preserve the single-line invariant.
        const detail =
          err instanceof Error
            ? formatExportError(err)
            : `error=${JSON.stringify(String(err))}`;
        this.emitDiagnostic(`[LogToSpan] export threw: ${detail}`);
        resolve();
      }
    });
    this.inFlightExport = exportPromise.finally(() => {
      this.inFlightExport = undefined;
    });
    return this.inFlightExport;
  }

  async shutdown(): Promise<void> {
    if (this.isShutdown) {
      return;
    }
    this.isShutdown = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    // Wait for any in-flight interval-triggered export before final flush.
    if (this.inFlightExport) {
      await this.inFlightExport;
    }
    await this.flush();
    this.emitBufferOverflowWarning();
    await this.spanExporter.shutdown();
  }

  async forceFlush(): Promise<void> {
    if (this.isShutdown) {
      return;
    }
    if (this.inFlightExport) {
      await this.inFlightExport;
    }
    await this.flush();
    await this.spanExporter.forceFlush?.();
  }
}

function normalizeMaxBufferSize(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return DEFAULT_MAX_BUFFER_SIZE;
  }
  return Math.floor(value);
}

interface ReadableSpanLike {
  name: string;
  kind: SpanKind;
  spanContext: () => { traceId: string; spanId: string; traceFlags: number };
  startTime: HrTime;
  endTime: HrTime;
  duration: HrTime;
  attributes: Record<string, string | number | boolean>;
  status: { code: SpanStatusCode; message?: string };
  events: never[];
  links: never[];
  resource: Resource;
  instrumentationScope: { name: string; version?: string; schemaUrl?: string };
  ended: boolean;
  parentSpanContext?: SpanContext;
  droppedAttributesCount: number;
  droppedEventsCount: number;
  droppedLinksCount: number;
  recordException: () => void;
}

function deriveSpanName(logRecord: ReadableLogRecord): string {
  const eventName = logRecord.attributes?.['event.name'] ?? logRecord.eventName;
  if (typeof eventName === 'string' && eventName.trim().length > 0) {
    return sanitizeSpanName(eventName);
  }
  return DEFAULT_LOG_SPAN_NAME;
}

function sanitizeSpanName(body: unknown): string {
  const rawName = String(body ?? 'unknown');
  return rawName.length > MAX_SPAN_NAME_LENGTH
    ? `${rawName.slice(0, MAX_SPAN_NAME_LENGTH)}...`
    : rawName;
}

function getValidParentSpanContext(
  spanContext: SpanContext | undefined,
): SpanContext | undefined {
  if (!spanContext || !isSpanContextValid(spanContext)) {
    return undefined;
  }
  return spanContext;
}

/**
 * Safely stringify an object value for use as a span attribute.
 * Returns a bounded fallback when JSON serialization fails, such as for
 * circular references or BigInt values.
 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

/**
 * Derive span status from log record attributes.
 * Marks the span as ERROR when explicit error indicators are present
 * (truthy `error`, `error_message`, or `error_type` attributes).
 * Does NOT treat `success: false` as an error — declined/cancelled
 * operations are a normal outcome, not failures.
 */
function deriveSpanStatus(attrs: Record<string, unknown> | undefined): {
  code: SpanStatusCode;
  message?: string;
} {
  if (!attrs) return { code: SpanStatusCode.OK };
  if (
    !!attrs['error'] ||
    !!attrs['error.message'] ||
    !!attrs['error_message'] ||
    !!attrs['error_type']
  ) {
    return {
      code: SpanStatusCode.ERROR,
      message: LOG_EVENT_ERROR_STATUS_MESSAGE,
    };
  }
  return { code: SpanStatusCode.OK };
}

// OTLPExporterError carries an HTTP status `code` and response `data`, but its
// `message` is the HTTP reason-phrase — which is empty on HTTP/2 or when the
// gateway strips it. Surface name/code/data so the operator has something to
// act on (e.g. a 403 from ARMS with empty body).
//
// Both `message` and `data` can carry embedded newlines or other characters
// that would break log parsing when the backend returns a JSON error body.
// JSON.stringify each field to keep the diagnostic on a single line —
// otherwise a torn record breaks downstream log greps and corrupts the
// file-logger format. The 200 figure is JS string length (UTF-16 code
// units), not bytes — non-ASCII payloads may stringify to more bytes; this
// is fine because the cap is a leak/noise budget, not a hard byte limit.
function formatExportError(err: Error | undefined): string {
  if (!err) return 'error="unknown"';
  // `code` is typed as `number | string` because Node networking errors (e.g.
  // ECONNREFUSED) surface a string here, while OTLPExporterError uses number.
  // The `typeof === 'number'` guard below is load-bearing — don't relax it to
  // a truthy check or string codes get mislabelled as HTTP statuses.
  const extra = err as { code?: number | string; data?: string };
  const msg = err.message || err.name || 'unknown';
  const parts = [`error=${JSON.stringify(msg)}`];
  // `code` is only meaningful as an HTTP status. Networking errors surface
  // string codes like 'ECONNREFUSED' on the same field — labelling those as
  // `httpCode` would be a lie, so only emit for numeric codes.
  if (typeof extra.code === 'number') parts.push(`httpCode=${extra.code}`);
  if (typeof extra.data === 'string' && extra.data.length > 0) {
    parts.push(`data=${JSON.stringify(extra.data.slice(0, 200))}`);
  }
  return parts.join(' ');
}

function hrTimeDiff(start: HrTime, end: HrTime): HrTime {
  let secs = end[0] - start[0];
  let nanos = end[1] - start[1];
  if (nanos < 0) {
    secs -= 1;
    nanos += 1e9;
  }
  return [secs, nanos] as HrTime;
}
