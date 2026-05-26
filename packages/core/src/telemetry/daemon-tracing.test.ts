/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { trace } from '@opentelemetry/api';
import {
  DAEMON_TRACEPARENT_META_KEY,
  DAEMON_TRACESTATE_META_KEY,
  extractDaemonTraceContext,
  hashDaemonWorkspace,
  injectDaemonTraceContext,
} from './daemon-tracing.js';

describe('daemon-tracing', () => {
  it('extracts daemon trace context from reserved prompt metadata keys', () => {
    const traceId = '1'.repeat(32);
    const spanId = '2'.repeat(16);
    const extracted = extractDaemonTraceContext({
      _meta: {
        [DAEMON_TRACEPARENT_META_KEY]: `00-${traceId}-${spanId}-01`,
        [DAEMON_TRACESTATE_META_KEY]: 'vendor=value',
      },
    });

    expect(extracted).toBeDefined();
    expect(trace.getSpanContext(extracted!)?.traceId).toBe(traceId);
    expect(trace.getSpanContext(extracted!)?.spanId).toBe(spanId);
  });

  it('strips reserved metadata when no active daemon span exists', () => {
    const injected = injectDaemonTraceContext({
      prompt: [],
      _meta: {
        keep: true,
        [DAEMON_TRACEPARENT_META_KEY]: 'client-spoof',
      },
    });

    const meta = injected._meta as Record<string, unknown>;
    expect(meta['keep']).toBe(true);
    expect(meta[DAEMON_TRACEPARENT_META_KEY]).toBeUndefined();
    expect(meta[DAEMON_TRACESTATE_META_KEY]).toBeUndefined();
    expect(extractDaemonTraceContext(injected)).toBeUndefined();
  });

  it('hashes workspace paths without exposing the raw path', () => {
    const hash = hashDaemonWorkspace('/tmp/project');

    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(hash).not.toContain('project');
  });
});
