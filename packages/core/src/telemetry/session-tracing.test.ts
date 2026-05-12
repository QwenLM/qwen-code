/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SpanStatusCode } from '@opentelemetry/api';

const mockState = vi.hoisted(() => ({
  sdkInitialized: true,
}));

vi.mock('./sdk.js', () => ({
  isTelemetrySdkInitialized: () => mockState.sdkInitialized,
}));

interface MockSpanRecord {
  name: string;
  kind: number;
  attributes: Record<string, unknown>;
  setAttributesCalls: Array<Record<string, unknown>>;
  statuses: Array<{ code: number; message?: string }>;
  ended: boolean;
  parentContext?: unknown;
}

const mockSpans: MockSpanRecord[] = [];

vi.mock('@opentelemetry/api', async () => {
  const actual =
    await vi.importActual<typeof import('@opentelemetry/api')>(
      '@opentelemetry/api',
    );

  function createMockSpan(
    name: string,
    opts?: { kind?: number; attributes?: Record<string, unknown> },
    parentCtx?: unknown,
  ): MockSpanRecord & {
    spanContext: () => { spanId: string; traceId: string; traceFlags: number };
    setAttributes: (attrs: Record<string, unknown>) => void;
    setStatus: (status: { code: number; message?: string }) => void;
    end: () => void;
  } {
    const record: MockSpanRecord = {
      name,
      kind: opts?.kind ?? 0,
      attributes: { ...(opts?.attributes ?? {}) },
      setAttributesCalls: [],
      statuses: [],
      ended: false,
      parentContext: parentCtx,
    };
    mockSpans.push(record);
    const spanId = Math.random().toString(16).slice(2, 18).padEnd(16, '0');
    return Object.assign(record, {
      spanContext: () => ({
        spanId,
        traceId: '0'.repeat(32),
        traceFlags: 0,
      }),
      setAttributes: (attrs: Record<string, unknown>) => {
        record.setAttributesCalls.push(attrs);
        Object.assign(record.attributes, attrs);
      },
      setStatus: (status: { code: number; message?: string }) => {
        record.statuses.push(status);
      },
      end: () => {
        record.ended = true;
      },
    });
  }

  const mockTracer = {
    startSpan: (
      name: string,
      opts?: { kind?: number; attributes?: Record<string, unknown> },
      parentCtx?: unknown,
    ) => createMockSpan(name, opts, parentCtx),
  };

  return {
    ...actual,
    SpanKind: actual.SpanKind,
    SpanStatusCode: actual.SpanStatusCode,
    trace: {
      getTracer: () => mockTracer,
      setSpan: (ctx: unknown, _span: unknown) => ({
        ...(ctx as object),
        __parentSpan: _span,
      }),
      wrapSpanContext: actual.trace.wrapSpanContext,
    },
    context: {
      active: () => ({}),
    },
  };
});

import type { Config } from '../config/config.js';
import {
  startInteractionSpan,
  endInteractionSpan,
  startLLMRequestSpan,
  endLLMRequestSpan,
  startToolSpan,
  endToolSpan,
  startToolExecutionSpan,
  endToolExecutionSpan,
  clearSessionTracingForTesting,
} from './session-tracing.js';

function createMockConfig(
  overrides: Partial<{
    sessionId: string;
    approvalMode: string;
  }> = {},
): Config {
  return {
    getSessionId: () => overrides.sessionId ?? 'test-session-id',
    getApprovalMode: () => overrides.approvalMode ?? 'suggest',
  } as unknown as Config;
}

describe('session-tracing', () => {
  beforeEach(() => {
    clearSessionTracingForTesting();
    mockSpans.length = 0;
    mockState.sdkInitialized = true;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('interaction spans', () => {
    it('starts and ends an interaction span with ok status', () => {
      const config = createMockConfig();
      startInteractionSpan(config, {
        promptId: 'prompt-1',
        model: 'test-model',
        messageType: 'userQuery',
      });

      expect(mockSpans).toHaveLength(1);
      expect(mockSpans[0]!.name).toBe('qwen-code.interaction');
      expect(mockSpans[0]!.attributes['session.id']).toBe('test-session-id');
      expect(mockSpans[0]!.attributes['qwen-code.prompt_id']).toBe('prompt-1');
      expect(mockSpans[0]!.attributes['qwen-code.model']).toBe('test-model');

      endInteractionSpan('ok');

      expect(mockSpans[0]!.ended).toBe(true);
      expect(mockSpans[0]!.statuses).toHaveLength(1);
      expect(mockSpans[0]!.statuses[0]!.code).toBe(SpanStatusCode.OK);
    });

    it('ends interaction span with error status', () => {
      const config = createMockConfig();
      startInteractionSpan(config, {
        promptId: 'prompt-2',
        model: 'test-model',
        messageType: 'userQuery',
      });

      endInteractionSpan('error', { errorMessage: 'something went wrong' });

      expect(mockSpans[0]!.statuses[0]!.code).toBe(SpanStatusCode.ERROR);
      expect(mockSpans[0]!.statuses[0]!.message).toBe('something went wrong');
    });

    it('ends interaction span with cancelled status as OK', () => {
      const config = createMockConfig();
      startInteractionSpan(config, {
        promptId: 'prompt-3',
        model: 'test-model',
        messageType: 'userQuery',
      });

      endInteractionSpan('cancelled');

      expect(mockSpans[0]!.statuses[0]!.code).toBe(SpanStatusCode.OK);
    });

    it('is idempotent — ending twice does not double-end', () => {
      const config = createMockConfig();
      startInteractionSpan(config, {
        promptId: 'prompt-4',
        model: 'test-model',
        messageType: 'userQuery',
      });

      endInteractionSpan('ok');
      endInteractionSpan('error');

      expect(mockSpans[0]!.statuses).toHaveLength(1);
    });

    it('no-ops when SDK is not initialized', () => {
      mockState.sdkInitialized = false;
      const config = createMockConfig();
      startInteractionSpan(config, {
        promptId: 'prompt-5',
        model: 'test-model',
        messageType: 'userQuery',
      });

      expect(mockSpans).toHaveLength(0);

      // endInteractionSpan should be safe to call
      endInteractionSpan('ok');
    });

    it('increments interaction sequence', () => {
      const config = createMockConfig();
      startInteractionSpan(config, {
        promptId: 'prompt-a',
        model: 'test-model',
        messageType: 'userQuery',
      });
      endInteractionSpan('ok');

      startInteractionSpan(config, {
        promptId: 'prompt-b',
        model: 'test-model',
        messageType: 'userQuery',
      });

      expect(mockSpans[1]!.attributes['interaction.sequence']).toBe(2);
    });

    it('records duration_ms and turn_status on end', () => {
      const config = createMockConfig();
      startInteractionSpan(config, {
        promptId: 'prompt-dur',
        model: 'test-model',
        messageType: 'userQuery',
      });

      endInteractionSpan('ok');

      const setAttrs = mockSpans[0]!.setAttributesCalls[0]!;
      expect(setAttrs).toHaveProperty('interaction.duration_ms');
      expect(setAttrs['qwen-code.turn_status']).toBe('ok');
    });
  });

  describe('LLM request spans', () => {
    it('creates and ends an LLM request span', () => {
      const span = startLLMRequestSpan('test-model', 'prompt-llm');

      expect(mockSpans).toHaveLength(1);
      expect(mockSpans[0]!.name).toBe('qwen-code.llm_request');
      expect(mockSpans[0]!.attributes['qwen-code.model']).toBe('test-model');

      endLLMRequestSpan(span, {
        success: true,
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 500,
      });

      expect(mockSpans[0]!.ended).toBe(true);
      expect(mockSpans[0]!.statuses[0]!.code).toBe(SpanStatusCode.OK);
    });

    it('records error status on failure', () => {
      const span = startLLMRequestSpan('test-model', 'prompt-err');

      endLLMRequestSpan(span, {
        success: false,
        error: 'rate limited',
      });

      expect(mockSpans[0]!.statuses[0]!.code).toBe(SpanStatusCode.ERROR);
      expect(mockSpans[0]!.statuses[0]!.message).toBe('rate limited');
    });

    it('parents under interaction span when one is active', () => {
      const config = createMockConfig();
      startInteractionSpan(config, {
        promptId: 'p',
        model: 'm',
        messageType: 'userQuery',
      });

      const span = startLLMRequestSpan('m', 'p');
      endLLMRequestSpan(span, { success: true });
      endInteractionSpan('ok');

      // The LLM span should have a parent context
      const llmSpan = mockSpans.find((s) => s.name === 'qwen-code.llm_request');
      expect(llmSpan?.parentContext).toBeDefined();
      expect(llmSpan?.attributes['llm_request.context']).toBe('interaction');
    });

    it('marks standalone when no interaction is active', () => {
      const span = startLLMRequestSpan('m', 'p');
      endLLMRequestSpan(span, { success: true });

      expect(mockSpans[0]!.attributes['llm_request.context']).toBe(
        'standalone',
      );
    });

    it('treats missing metadata as OK status', () => {
      const span = startLLMRequestSpan('test-model', 'prompt-no-meta');

      endLLMRequestSpan(span);

      expect(mockSpans[0]!.ended).toBe(true);
      expect(mockSpans[0]!.statuses[0]!.code).toBe(SpanStatusCode.OK);
    });

    it('returns NOOP span when SDK is not initialized', () => {
      mockState.sdkInitialized = false;
      const span = startLLMRequestSpan('m', 'p');
      expect(span.spanContext().traceId).toBe('0'.repeat(32));
      expect(span.spanContext().spanId).toBe('0'.repeat(16));

      // endLLMRequestSpan with noop should be safe
      endLLMRequestSpan(span, { success: true });
    });
  });

  describe('tool spans', () => {
    it('creates and ends a tool span', () => {
      const span = startToolSpan('ReadFile', { 'tool.call_id': 'call-1' });

      expect(mockSpans).toHaveLength(1);
      expect(mockSpans[0]!.name).toBe('qwen-code.tool');
      expect(mockSpans[0]!.attributes['tool.name']).toBe('ReadFile');
      expect(mockSpans[0]!.attributes['tool.call_id']).toBe('call-1');

      endToolSpan(span, { success: true });

      expect(mockSpans[0]!.ended).toBe(true);
      expect(mockSpans[0]!.statuses[0]!.code).toBe(SpanStatusCode.OK);
    });

    it('records error on tool failure', () => {
      const span = startToolSpan('Bash');
      endToolSpan(span, { success: false, error: 'command failed' });

      expect(mockSpans[0]!.statuses[0]!.code).toBe(SpanStatusCode.ERROR);
      expect(mockSpans[0]!.statuses[0]!.message).toBe('command failed');
    });

    it('defaults to OK when success is undefined', () => {
      const span = startToolSpan('Read');
      endToolSpan(span);

      expect(mockSpans[0]!.statuses[0]!.code).toBe(SpanStatusCode.OK);
    });

    it('concurrent tool spans are isolated', () => {
      const config = createMockConfig();
      startInteractionSpan(config, {
        promptId: 'p',
        model: 'm',
        messageType: 'userQuery',
      });

      const span1 = startToolSpan('Read', { 'tool.call_id': 'c1' });
      const span2 = startToolSpan('Bash', { 'tool.call_id': 'c2' });

      // End span2 first (out of order)
      endToolSpan(span2, { success: true });
      endToolSpan(span1, { success: false, error: 'timeout' });

      // Find tool spans
      const toolSpans = mockSpans.filter((s) => s.name === 'qwen-code.tool');
      expect(toolSpans).toHaveLength(2);

      const readSpan = toolSpans.find(
        (s) => s.attributes['tool.name'] === 'Read',
      );
      const bashSpan = toolSpans.find(
        (s) => s.attributes['tool.name'] === 'Bash',
      );

      expect(bashSpan?.statuses[0]?.code).toBe(SpanStatusCode.OK);
      expect(readSpan?.statuses[0]?.code).toBe(SpanStatusCode.ERROR);
      expect(readSpan?.statuses[0]?.message).toBe('timeout');
    });
  });

  describe('tool execution sub-spans', () => {
    it('creates a tool execution span as child of tool span', () => {
      const toolSpan = startToolSpan('Bash');
      const execSpan = startToolExecutionSpan(toolSpan);

      expect(mockSpans).toHaveLength(2);
      expect(mockSpans[1]!.name).toBe('qwen-code.tool.execution');

      endToolExecutionSpan(execSpan, { success: true });
      endToolSpan(toolSpan, { success: true });

      expect(mockSpans[1]!.ended).toBe(true);
    });

    it('returns NOOP span when SDK is not initialized', () => {
      mockState.sdkInitialized = false;
      const toolSpan = startToolSpan('Bash');
      const execSpan = startToolExecutionSpan(toolSpan);

      expect(execSpan.spanContext().traceId).toBe('0'.repeat(32));
    });
  });

  describe('clearSessionTracingForTesting', () => {
    it('resets state so new interactions start fresh', () => {
      const config = createMockConfig();
      startInteractionSpan(config, {
        promptId: 'p',
        model: 'm',
        messageType: 'userQuery',
      });

      clearSessionTracingForTesting();
      mockSpans.length = 0;

      startInteractionSpan(config, {
        promptId: 'p2',
        model: 'm',
        messageType: 'userQuery',
      });

      // Sequence should be reset to 1
      expect(mockSpans[0]!.attributes['interaction.sequence']).toBe(1);
    });
  });
});
