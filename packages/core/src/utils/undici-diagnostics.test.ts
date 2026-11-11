/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import diagnosticsChannel from 'node:diagnostics_channel';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelStreamDiagnosticsConfig } from '../config-service/features/modelStreamDiagnostics.js';

const mocks = vi.hoisted(() => ({
  diagnosticsConfig: {
    current: {
      enabled: false,
      progressIntervalMs: 15_000,
      progressChunkEvery: 128,
      includeResourceSnapshotOnError: true,
    } as ModelStreamDiagnosticsConfig,
  },
  runLogger: {
    debug: vi.fn(),
    log: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../config-service/features/modelStreamDiagnostics.js', () => ({
  getModelStreamDiagnosticsConfig: () => mocks.diagnosticsConfig.current,
}));

vi.mock('./runLogger.js', () => ({
  runLogger: mocks.runLogger,
}));

const { ensureUndiciDiagnosticsInstalled } = await import(
  './undici-diagnostics.js'
);

describe('undici-diagnostics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.diagnosticsConfig.current = {
      enabled: false,
      progressIntervalMs: 15_000,
      progressChunkEvery: 128,
      includeResourceSnapshotOnError: true,
    };
    ensureUndiciDiagnosticsInstalled();
  });

  it('does not record diagnostics when the feature gate is disabled', () => {
    const request = createRelevantRequest();

    publishUndici('undici:request:create', { request });
    publishUndici('undici:request:error', {
      request,
      error: new TypeError('terminated'),
    });

    expect(mocks.runLogger.log).not.toHaveBeenCalled();
    expect(mocks.runLogger.warn).not.toHaveBeenCalled();
  });

  it('reports error cause and resource snapshot when enabled', () => {
    mocks.diagnosticsConfig.current = {
      enabled: true,
      progressIntervalMs: 15_000,
      progressChunkEvery: 128,
      includeResourceSnapshotOnError: true,
    };
    const request = createRelevantRequest();
    const cause = Object.assign(new Error('Body Timeout Error'), {
      name: 'BodyTimeoutError',
      code: 'UND_ERR_BODY_TIMEOUT',
    });
    const error = new TypeError('terminated', { cause });

    ensureUndiciDiagnosticsInstalled();
    publishUndici('undici:request:create', { request });
    publishUndici('undici:request:headers', {
      request,
      response: {
        statusCode: 200,
        headers: ['content-type', 'text/event-stream'],
      },
    });
    publishUndici('undici:request:bodyChunkReceived', {
      request,
      chunk: Buffer.from('data: hello\n\n'),
    });
    publishUndici('undici:request:error', { request, error });

    const warnLine = mocks.runLogger.warn.mock.calls[0]?.[0] as string;
    expect(warnLine).toContain('phase=error');
    expect(warnLine).toContain('requestId=client-request-1');
    expect(warnLine).toContain('traceId=0123456789abcdef0123456789abcdef');
    expect(warnLine).toMatch(/, rssMB=\d+/);
    expect(warnLine).toMatch(/, sysFreeMB=\d+/);
    expect(warnLine).toContain(
      'cause=BodyTimeoutError: Body Timeout Error (UND_ERR_BODY_TIMEOUT)',
    );
  });

  it('does not duplicate code-only errors in log messages', () => {
    mocks.diagnosticsConfig.current = {
      enabled: true,
      progressIntervalMs: 15_000,
      progressChunkEvery: 128,
      includeResourceSnapshotOnError: false,
    };
    const request = createRelevantRequest();

    ensureUndiciDiagnosticsInstalled();
    publishUndici('undici:request:create', { request });
    publishUndici('undici:request:error', {
      request,
      error: { code: 'UND_ERR_BODY_TIMEOUT' },
    });

    expect(mocks.runLogger.warn.mock.calls[0]?.[0]).toContain(
      'error=UND_ERR_BODY_TIMEOUT',
    );
    expect(mocks.runLogger.warn.mock.calls[0]?.[0]).not.toContain(
      'UND_ERR_BODY_TIMEOUT (UND_ERR_BODY_TIMEOUT)',
    );
  });
});

function publishUndici(channel: string, message: unknown): void {
  diagnosticsChannel.channel(channel).publish(message);
}

function createRelevantRequest(): Record<string, unknown> {
  return {
    method: 'POST',
    origin: 'https://openapi.example.com',
    path: '/model/v1/chat/completions',
    headers: [
      'traceparent',
      '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
      'x-request-id',
      'client-request-1',
    ],
  };
}
