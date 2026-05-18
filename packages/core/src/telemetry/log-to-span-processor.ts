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

import { SERVICE_NAME } from './constants.js';
import {
  deriveTraceId,
  randomHexString,
  randomSpanId,
} from './trace-id-utils.js';
import { getCurrentSessionId } from './session-context.js';

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

interface LogToSpanProcessorOptions {
  flushIntervalMs?: number;
  includeSensitiveSpanAttributes?: boolean;
  maxBufferSize?: number;
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
    } else {
      this.flushIntervalMs = flushIntervalMsOrOptions.flushIntervalMs ?? 5000;
      this.includeSensitiveSpanAttributes =
        flushIntervalMsOrOptions.includeSensitiveSpanAttributes ?? false;
      this.maxBufferSize = normalizeMaxBufferSize(
        flushIntervalMsOrOptions.maxBufferSize,
      );
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
    try {
      process.stderr.write(
        `[LogToSpan] buffer exceeded max size (${this.maxBufferSize}); dropped ${droppedSinceLastWarning} oldest span(s) since last warning, ${this.totalDroppedSpans} total\n`,
      );
    } catch {
      // Logging diagnostics must not interrupt telemetry ingestion.
    }
  }

  private flush(): Promise<void> {
    if (this.inFlightExport) return this.inFlightExport;
    if (this.buffer.length === 0) return Promise.resolve();
    const spans = this.buffer.splice(0);
    const exportPromise = new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        process.stderr.write(
          `[LogToSpan] export timeout after ${EXPORT_TIMEOUT_MS}ms\n`,
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
              process.stderr.write(
                `[LogToSpan] export failed: code=${result.code} error=${result.error?.message ?? 'unknown'}\n`,
              );
            }
            resolve();
          },
        );
      } catch (err) {
        clearTimeout(timeout);
        process.stderr.write(
          `[LogToSpan] export threw: ${err instanceof Error ? err.message : String(err)}\n`,
        );
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

function hrTimeDiff(start: HrTime, end: HrTime): HrTime {
  let secs = end[0] - start[0];
  let nanos = end[1] - start[1];
  if (nanos < 0) {
    secs -= 1;
    nanos += 1e9;
  }
  return [secs, nanos] as HrTime;
}
