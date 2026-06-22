/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExportResult } from '@opentelemetry/core';
import { ExportResultCode } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import type {
  ReadableLogRecord,
  LogRecordExporter,
} from '@opentelemetry/sdk-logs';
import type {
  ResourceMetrics,
  PushMetricExporter,
} from '@opentelemetry/sdk-metrics';
import { AggregationTemporality } from '@opentelemetry/sdk-metrics';
import { safeJsonStringify } from '../utils/safeJsonStringify.js';

class FileExporter {
  protected writeStream: fs.WriteStream;

  constructor(filePath: string) {
    // Telemetry is best-effort and must never crash the process. Ensure the
    // parent directory exists (the outfile may be a relative path resolved
    // against a cwd that lacks it), and attach an `error` handler so an open or
    // write failure (missing/read-only dir, EACCES) is absorbed instead of
    // surfacing as an unhandled stream `error` event that takes down the agent.
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    } catch {
      // Directory could not be created; the stream error handler below will
      // absorb the resulting open failure.
    }
    this.writeStream = fs.createWriteStream(filePath, { flags: 'a' });
    this.writeStream.on('error', () => {
      // Swallow telemetry file errors — exporters report failures through the
      // ExportResult callback; an unhandled `error` event would crash Node.
    });
  }

  protected serialize(data: unknown): string {
    return safeJsonStringify(data, 2) + '\n';
  }

  shutdown(): Promise<void> {
    return new Promise((resolve) => {
      this.writeStream.end(resolve);
    });
  }
}

export class FileSpanExporter extends FileExporter implements SpanExporter {
  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    const data = spans.map((span) => this.serialize(span)).join('');
    this.writeStream.write(data, (err) => {
      resultCallback({
        code: err ? ExportResultCode.FAILED : ExportResultCode.SUCCESS,
        error: err || undefined,
      });
    });
  }
}

export class FileLogExporter extends FileExporter implements LogRecordExporter {
  export(
    logs: ReadableLogRecord[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    const data = logs.map((log) => this.serialize(log)).join('');
    this.writeStream.write(data, (err) => {
      resultCallback({
        code: err ? ExportResultCode.FAILED : ExportResultCode.SUCCESS,
        error: err || undefined,
      });
    });
  }
}

export class FileMetricExporter
  extends FileExporter
  implements PushMetricExporter
{
  export(
    metrics: ResourceMetrics,
    resultCallback: (result: ExportResult) => void,
  ): void {
    const data = this.serialize(metrics);
    this.writeStream.write(data, (err) => {
      resultCallback({
        code: err ? ExportResultCode.FAILED : ExportResultCode.SUCCESS,
        error: err || undefined,
      });
    });
  }

  getPreferredAggregationTemporality(): AggregationTemporality {
    return AggregationTemporality.CUMULATIVE;
  }

  async forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}
