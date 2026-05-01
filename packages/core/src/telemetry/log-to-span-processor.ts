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
  private readonly flushIntervalMs: number;

  constructor(
    private readonly spanExporter: SpanExporter,
    flushIntervalMs = 5000,
  ) {
    this.flushIntervalMs = flushIntervalMs;
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
    this.flushTimer.unref();
  }

  onEmit(logRecord: ReadableLogRecord): void {
    const name = String(logRecord.body ?? 'unknown');
    const startTime = logRecord.hrTime;

    const attributes: Record<string, string | number | boolean> = {};
    if (logRecord.attributes) {
      for (const [key, value] of Object.entries(logRecord.attributes)) {
        if (value !== undefined && value !== null) {
          attributes[key] =
            typeof value === 'object' ? JSON.stringify(value) : value;
        }
      }
    }
    attributes['log.bridge'] = true;

    let endTime = startTime;
    const durationMs = logRecord.attributes?.['duration_ms'];
    if (typeof durationMs === 'number' && durationMs > 0) {
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
      instrumentationScope: {
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
    if (this.buffer.length === 0) return Promise.resolve();
    const spans = this.buffer.splice(0);
    return new Promise<void>((resolve) => {
      this.spanExporter.export(spans as unknown as ReadableSpan[], (result) => {
        if (result.code !== 0) {
          process.stderr.write(
            `[LogToSpan] export failed: code=${result.code} error=${result.error?.message ?? 'unknown'}\n`,
          );
        }
        resolve();
      });
    });
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.flush();
    await this.spanExporter.shutdown();
  }

  async forceFlush(): Promise<void> {
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

function randomHexString(length: number): string {
  const bytes = new Uint8Array(length / 2);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Derive a deterministic 32-char hex traceId from a session ID.
 * All events in the same session will share this traceId,
 * making them appear under a single trace in the backend.
 */
function deriveTraceId(sessionId: string): string {
  return createHash('md5').update(sessionId).digest('hex');
}

/**
 * Derive span status from log record attributes.
 * Marks the span as ERROR when common error indicators are present.
 */
function deriveSpanStatus(attrs: Record<string, unknown> | undefined): {
  code: SpanStatusCode;
  message?: string;
} {
  if (!attrs) return { code: SpanStatusCode.OK };
  if (
    attrs['success'] === false ||
    attrs['error'] !== undefined ||
    attrs['error_message'] !== undefined ||
    attrs['error_type'] !== undefined
  ) {
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
