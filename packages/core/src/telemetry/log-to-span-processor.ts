/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { SpanKind, SpanStatusCode, type HrTime } from '@opentelemetry/api';
import type {
  LogRecordProcessor,
  ReadableLogRecord,
} from '@opentelemetry/sdk-logs';
import type { SpanExporter, ReadableSpan } from '@opentelemetry/sdk-trace-base';
import {
  type Resource,
  resourceFromAttributes,
} from '@opentelemetry/resources';

import { createHash } from 'node:crypto';

import { SERVICE_NAME } from './constants.js';

const EXPORT_TIMEOUT_MS = 30_000;
const MAX_SPAN_NAME_LENGTH = 128;
const SENSITIVE_ATTRIBUTE_KEYS = new Set([
  'prompt',
  'function_args',
  'response_text',
]);

interface LogToSpanProcessorOptions {
  flushIntervalMs?: number;
  includeSensitiveSpanAttributes?: boolean;
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
  private readonly includeSensitiveSpanAttributes: boolean;

  constructor(spanExporter: SpanExporter);
  constructor(spanExporter: SpanExporter, flushIntervalMs: number);
  constructor(spanExporter: SpanExporter, options: LogToSpanProcessorOptions);
  constructor(
    private readonly spanExporter: SpanExporter,
    flushIntervalMsOrOptions: number | LogToSpanProcessorOptions = 5000,
  ) {
    if (typeof flushIntervalMsOrOptions === 'number') {
      this.flushIntervalMs = flushIntervalMsOrOptions;
      this.includeSensitiveSpanAttributes = false;
    } else {
      this.flushIntervalMs = flushIntervalMsOrOptions.flushIntervalMs ?? 5000;
      this.includeSensitiveSpanAttributes =
        flushIntervalMsOrOptions.includeSensitiveSpanAttributes ?? false;
    }
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
    this.flushTimer.unref();
  }

  onEmit(logRecord: ReadableLogRecord): void {
    const name = sanitizeSpanName(logRecord.body);
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

    // Derive traceId from session.id so all events in one session
    // appear under a single trace. spanId is random per event.
    const sessionId = logRecord.attributes?.['session.id'];
    const traceId = sessionId
      ? deriveTraceId(String(sessionId))
      : randomHexString(32);
    const spanId = randomHexString(16);

    this.buffer.push({
      name,
      kind: SpanKind.INTERNAL,
      spanContext: () => ({
        traceId,
        spanId,
        traceFlags: 1, // SAMPLED
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
      parentSpanContext: undefined,
      droppedAttributesCount: 0,
      droppedEventsCount: 0,
      droppedLinksCount: 0,
      recordException: () => {},
    });
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
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    // Wait for any in-flight interval-triggered export before final flush.
    if (this.inFlightExport) {
      await this.inFlightExport;
    }
    await this.flush();
    await this.spanExporter.shutdown();
  }

  async forceFlush(): Promise<void> {
    if (this.inFlightExport) {
      await this.inFlightExport;
    }
    await this.flush();
    await this.spanExporter.forceFlush?.();
  }
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
  parentSpanContext?: { traceId: string; spanId: string; traceFlags: number };
  droppedAttributesCount: number;
  droppedEventsCount: number;
  droppedLinksCount: number;
  recordException: () => void;
}

function sanitizeSpanName(body: unknown): string {
  const rawName = String(body ?? 'unknown');
  return rawName.length > MAX_SPAN_NAME_LENGTH
    ? `${rawName.slice(0, MAX_SPAN_NAME_LENGTH)}...`
    : rawName;
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

function randomHexString(length: number): string {
  const bytes = new Uint8Array(length / 2);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Derive a deterministic 32-char hex traceId from a session ID.
 * All events in the same session will share this traceId,
 * making them appear under a single trace in the backend.
 * Uses SHA-256 truncated to 32 hex chars (128 bits) to match the
 * OTel trace ID format.
 */
function deriveTraceId(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
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
  if (!!attrs['error'] || !!attrs['error_message'] || !!attrs['error_type']) {
    const msg = String(
      attrs['error_message'] ?? attrs['error'] ?? attrs['error_type'] ?? '',
    );
    return { code: SpanStatusCode.ERROR, ...(msg && { message: msg }) };
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
