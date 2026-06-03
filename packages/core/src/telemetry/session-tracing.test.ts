/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SpanStatusCode, type Context } from '@opentelemetry/api';

const mockState = vi.hoisted(() => ({
  sdkInitialized: true,
  // Toggles to force span.setAttributes/setStatus to throw — exercises the
  // try/catch hardening in end*Span helpers (span.end() must still run).
  throwOnSetAttributes: false,
  throwOnSetStatus: false,
  // When set, `context.active()` returns a context that carries this fake
  // span and `trace.getSpan()` reports it. Lets tests exercise the
  // active-OTel-span fallback in resolveParentContext (#4212).
  activeOtelSpan: undefined as unknown,
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
        if (mockState.throwOnSetAttributes) {
          throw new Error('setAttributes failed');
        }
        record.setAttributesCalls.push(attrs);
        Object.assign(record.attributes, attrs);
      },
      setStatus: (status: { code: number; message?: string }) => {
        if (mockState.throwOnSetStatus) {
          throw new Error('setStatus failed');
        }
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
      getSpan: (ctx: unknown) =>
        typeof ctx === 'object' && ctx !== null && '__activeSpan' in ctx
          ? (ctx as { __activeSpan: unknown }).__activeSpan
          : undefined,
      wrapSpanContext: actual.trace.wrapSpanContext,
    },
    context: {
      active: () =>
        mockState.activeOtelSpan
          ? { __activeSpan: mockState.activeOtelSpan }
          : {},
      with: <T>(_ctx: unknown, fn: () => T): T => fn(),
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
  runInToolSpanContext,
  startToolExecutionSpan,
  endToolExecutionSpan,
  startToolBlockedOnUserSpan,
  endToolBlockedOnUserSpan,
  startHookSpan,
  endHookSpan,
  getActiveInteractionSpan,
  clearSessionTracingForTesting,
  runTTLSweepForTesting,
  truncateSpanError,
} from './session-tracing.js';
import { setSessionContext } from './session-context.js';

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
    mockState.throwOnSetAttributes = false;
    mockState.throwOnSetStatus = false;
    mockState.activeOtelSpan = undefined;
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

  describe('interaction span — trace context (#4486)', () => {
    it('attaches to the session root context returned by getSessionContext', () => {
      const fakeRoot = { __sessionRoot: true } as unknown as Context;
      setSessionContext(fakeRoot, 'test-session');

      startInteractionSpan(createMockConfig({ sessionId: 'test-session' }), {
        promptId: 'p',
        model: 'm',
        messageType: 'userQuery',
      });

      const span = mockSpans.find((s) => s.name === 'qwen-code.interaction');
      expect(span?.parentContext).toBe(fakeRoot);
    });

    it('anchors at session root even when an unrelated OTel span is active', () => {
      const fakeRoot = { __sessionRoot: true } as unknown as Context;
      setSessionContext(fakeRoot, 'test-session');
      mockState.activeOtelSpan = { name: 'unrelated-wrapper-span' };

      startInteractionSpan(createMockConfig({ sessionId: 'test-session' }), {
        promptId: 'p',
        model: 'm',
        messageType: 'userQuery',
      });

      const span = mockSpans.find((s) => s.name === 'qwen-code.interaction');
      expect(span?.parentContext).toBe(fakeRoot);
    });

    it('falls back to otelContext.active() when no session context is set', () => {
      // Intentionally NOT calling setSessionContext — exercises the fallback.
      const fakeActive = { kind: 'fake-active-span' };
      mockState.activeOtelSpan = fakeActive;

      startInteractionSpan(createMockConfig({ sessionId: 'test-session' }), {
        promptId: 'p',
        model: 'm',
        messageType: 'userQuery',
      });

      const span = mockSpans.find((s) => s.name === 'qwen-code.interaction');
      expect(span?.parentContext).toMatchObject({ __activeSpan: fakeActive });
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

    it('LLM request span re-parents to active OTel span when no interaction is set (#4212)', () => {
      // Models a side-query LLM call running inside another OTel span (e.g.
      // an HTTP-instrumented span in a subagent path) — the new span must
      // attach to the active span instead of skipping back to session root,
      // otherwise the trace tree flattens.
      const fakeActive = { kind: 'fake-active-span' };
      mockState.activeOtelSpan = fakeActive;

      const span = startLLMRequestSpan('m', 'p');
      endLLMRequestSpan(span, { success: true });

      const llmSpan = mockSpans.find((s) => s.name === 'qwen-code.llm_request');
      expect(llmSpan?.parentContext).toMatchObject({
        __activeSpan: fakeActive,
      });
      // Without an explicit parent we still mark the call as standalone —
      // the OTel parent comes from instrumentation, not from interactionContext.
      expect(llmSpan?.attributes['llm_request.context']).toBe('standalone');
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

  describe('LLM request spans — Phase 4a (timing decomposition + GenAI dual-emit)', () => {
    it('startLLMRequestSpan dual-emits gen_ai.request.model alongside qwen-code.model', () => {
      const span = startLLMRequestSpan('test-model', 'p');
      endLLMRequestSpan(span, { success: true });

      const attrs = mockSpans[0]!.attributes;
      expect(attrs['qwen-code.model']).toBe('test-model');
      expect(attrs['gen_ai.request.model']).toBe('test-model');
    });

    it('endLLMRequestSpan dual-emits gen_ai.usage.input_tokens / output_tokens', () => {
      const span = startLLMRequestSpan('m', 'p');
      endLLMRequestSpan(span, {
        success: true,
        inputTokens: 100,
        outputTokens: 50,
      });

      const attrs = mockSpans[0]!.attributes;
      expect(attrs['input_tokens']).toBe(100);
      expect(attrs['gen_ai.usage.input_tokens']).toBe(100);
      expect(attrs['output_tokens']).toBe(50);
      expect(attrs['gen_ai.usage.output_tokens']).toBe(50);
    });

    it('endLLMRequestSpan dual-emits gen_ai.usage.cached_tokens when present', () => {
      const span = startLLMRequestSpan('m', 'p');
      endLLMRequestSpan(span, {
        success: true,
        inputTokens: 100,
        cachedInputTokens: 40,
      });

      const attrs = mockSpans[0]!.attributes;
      expect(attrs['cached_input_tokens']).toBe(40);
      expect(attrs['gen_ai.usage.cached_tokens']).toBe(40);
    });

    it('endLLMRequestSpan omits cached_input_tokens when undefined', () => {
      const span = startLLMRequestSpan('m', 'p');
      endLLMRequestSpan(span, { success: true, inputTokens: 100 });

      const attrs = mockSpans[0]!.attributes;
      expect(attrs['cached_input_tokens']).toBeUndefined();
      expect(attrs['gen_ai.usage.cached_tokens']).toBeUndefined();
    });

    it('endLLMRequestSpan emits cached_input_tokens === 0 (cache miss is meaningful info, not undefined)', () => {
      // Providers that report 0 cached tokens are signaling an explicit cache
      // miss. Distinct from undefined ("we don't know"). Both attribute names
      // must propagate the literal 0.
      const span = startLLMRequestSpan('m', 'p');
      endLLMRequestSpan(span, {
        success: true,
        inputTokens: 100,
        cachedInputTokens: 0,
      });

      const attrs = mockSpans[0]!.attributes;
      expect(attrs['cached_input_tokens']).toBe(0);
      expect(attrs['gen_ai.usage.cached_tokens']).toBe(0);
    });

    it('endLLMRequestSpan writes ttft_ms and dual-emits gen_ai.server.time_to_first_token (in seconds)', () => {
      const span = startLLMRequestSpan('m', 'p');
      endLLMRequestSpan(span, {
        success: true,
        ttftMs: 234,
        durationMs: 1000,
      });

      const attrs = mockSpans[0]!.attributes;
      expect(attrs['ttft_ms']).toBe(234);
      // Spec uses seconds as double — 234ms → 0.234s
      expect(attrs['gen_ai.server.time_to_first_token']).toBeCloseTo(0.234, 6);
    });

    it('endLLMRequestSpan omits ttft_ms when undefined (non-streaming or aborted before first chunk)', () => {
      const span = startLLMRequestSpan('m', 'p');
      endLLMRequestSpan(span, { success: true, durationMs: 500 });

      const attrs = mockSpans[0]!.attributes;
      expect(attrs['ttft_ms']).toBeUndefined();
      expect(attrs['gen_ai.server.time_to_first_token']).toBeUndefined();
      expect(attrs['sampling_ms']).toBeUndefined();
      expect(attrs['output_tokens_per_second']).toBeUndefined();
    });

    it('endLLMRequestSpan derives sampling_ms when ttftMs is set (no requestSetup)', () => {
      const span = startLLMRequestSpan('m', 'p');
      endLLMRequestSpan(span, {
        success: true,
        ttftMs: 200,
        durationMs: 1000,
      });

      // sampling_ms = duration - ttft - (requestSetup ?? 0) = 1000 - 200 - 0
      expect(mockSpans[0]!.attributes['sampling_ms']).toBe(800);
    });

    it('endLLMRequestSpan derives sampling_ms accounting for requestSetupMs (Phase 4b populates this)', () => {
      const span = startLLMRequestSpan('m', 'p');
      endLLMRequestSpan(span, {
        success: true,
        ttftMs: 200,
        requestSetupMs: 300,
        durationMs: 1000,
      });

      // sampling_ms = 1000 - 200 - 300
      expect(mockSpans[0]!.attributes['sampling_ms']).toBe(500);
    });

    it('endLLMRequestSpan clamps sampling_ms to 0 when ttft + setup exceed duration (clock skew)', () => {
      const span = startLLMRequestSpan('m', 'p');
      endLLMRequestSpan(span, {
        success: true,
        ttftMs: 800,
        requestSetupMs: 500,
        durationMs: 1000,
      });

      // Math.max(0, 1000 - 800 - 500) = 0
      expect(mockSpans[0]!.attributes['sampling_ms']).toBe(0);
    });

    it('endLLMRequestSpan derives output_tokens_per_second from sampling_ms + outputTokens', () => {
      const span = startLLMRequestSpan('m', 'p');
      endLLMRequestSpan(span, {
        success: true,
        ttftMs: 200,
        durationMs: 1200,
        outputTokens: 500,
      });

      // sampling_ms = 1000ms = 1s; otps = 500 / 1.0 = 500
      expect(mockSpans[0]!.attributes['sampling_ms']).toBe(1000);
      expect(mockSpans[0]!.attributes['output_tokens_per_second']).toBe(500);
    });

    it('endLLMRequestSpan rounds output_tokens_per_second to 2 decimals', () => {
      const span = startLLMRequestSpan('m', 'p');
      endLLMRequestSpan(span, {
        success: true,
        ttftMs: 200,
        durationMs: 1325, // sampling_ms = 1125
        outputTokens: 100, // otps = 100 / 1.125 = 88.888…
      });

      expect(mockSpans[0]!.attributes['output_tokens_per_second']).toBe(88.89);
    });

    it('endLLMRequestSpan omits output_tokens_per_second when sampling_ms == 0', () => {
      const span = startLLMRequestSpan('m', 'p');
      endLLMRequestSpan(span, {
        success: true,
        ttftMs: 1000,
        durationMs: 1000,
        outputTokens: 50,
      });

      // sampling_ms = 0 → otps would be Infinity, must be omitted
      expect(mockSpans[0]!.attributes['sampling_ms']).toBe(0);
      expect(
        mockSpans[0]!.attributes['output_tokens_per_second'],
      ).toBeUndefined();
    });

    it('endLLMRequestSpan omits output_tokens_per_second when outputTokens missing', () => {
      const span = startLLMRequestSpan('m', 'p');
      endLLMRequestSpan(span, {
        success: true,
        ttftMs: 200,
        durationMs: 1000,
      });

      expect(
        mockSpans[0]!.attributes['output_tokens_per_second'],
      ).toBeUndefined();
    });

    it('endLLMRequestSpan writes Phase 4b retry placeholders when caller provides them', () => {
      const span = startLLMRequestSpan('m', 'p');
      endLLMRequestSpan(span, {
        success: true,
        attempt: 3,
        requestSetupMs: 4500,
        retryTotalDelayMs: 4200,
        durationMs: 5000,
      });

      const attrs = mockSpans[0]!.attributes;
      expect(attrs['attempt']).toBe(3);
      expect(attrs['request_setup_ms']).toBe(4500);
      expect(attrs['retry_total_delay_ms']).toBe(4200);
    });

    it('endLLMRequestSpan omits Phase 4b fields when caller does not provide them (Phase 4a default)', () => {
      const span = startLLMRequestSpan('m', 'p');
      endLLMRequestSpan(span, { success: true, durationMs: 500 });

      const attrs = mockSpans[0]!.attributes;
      expect(attrs['attempt']).toBeUndefined();
      expect(attrs['request_setup_ms']).toBeUndefined();
      expect(attrs['retry_total_delay_ms']).toBeUndefined();
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

    it('does not set status when no metadata is passed', () => {
      const span = startToolSpan('Read');
      endToolSpan(span);

      expect(mockSpans[0]!.statuses).toHaveLength(0);
    });

    it('tool span re-parents to active OTel span when no interaction is set (#4212)', () => {
      const fakeActive = { kind: 'fake-active-span' };
      mockState.activeOtelSpan = fakeActive;

      const span = startToolSpan('Bash');
      endToolSpan(span, { success: true });

      const toolSpan = mockSpans.find((s) => s.name === 'qwen-code.tool');
      expect(toolSpan?.parentContext).toMatchObject({
        __activeSpan: fakeActive,
      });
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
    it('creates a tool execution span as child of tool span via runInToolSpanContext', () => {
      const toolSpan = startToolSpan('Bash');

      let execSpan!: ReturnType<typeof startToolExecutionSpan>;
      runInToolSpanContext(toolSpan, () => {
        execSpan = startToolExecutionSpan();
      });

      expect(mockSpans).toHaveLength(2);
      expect(mockSpans[1]!.name).toBe('qwen-code.tool.execution');
      expect(mockSpans[1]!.parentContext).toBeDefined();

      endToolExecutionSpan(execSpan, { success: true });
      endToolSpan(toolSpan, { success: true });

      expect(mockSpans[1]!.ended).toBe(true);
    });

    it('returns NOOP span when SDK is not initialized', () => {
      mockState.sdkInitialized = false;
      startToolSpan('Bash');
      const execSpan = startToolExecutionSpan();

      expect(execSpan.spanContext().traceId).toBe('0'.repeat(32));
    });

    it('tool execution span re-parents to active OTel span when no toolContext is set (#4212)', () => {
      const fakeActive = { kind: 'fake-active-span' };
      mockState.activeOtelSpan = fakeActive;

      const execSpan = startToolExecutionSpan();
      endToolExecutionSpan(execSpan, { success: true });

      const span = mockSpans.find((s) => s.name === 'qwen-code.tool.execution');
      expect(span?.parentContext).toMatchObject({
        __activeSpan: fakeActive,
      });
    });

    it('falls back gracefully when no tool span is active', () => {
      const execSpan = startToolExecutionSpan();

      expect(mockSpans).toHaveLength(1);
      expect(mockSpans[0]!.name).toBe('qwen-code.tool.execution');

      endToolExecutionSpan(execSpan, { success: true });
      expect(mockSpans[0]!.ended).toBe(true);
    });

    it('cancelled: true keeps status UNSET while still recording attributes (#4302)', () => {
      const execSpan = startToolExecutionSpan();
      endToolExecutionSpan(execSpan, {
        success: false,
        error: 'Tool execution cancelled by user',
        cancelled: true,
      });

      const record = mockSpans.find(
        (s) => s.name === 'qwen-code.tool.execution',
      );
      expect(record?.ended).toBe(true);
      // No setStatus call — status stays UNSET, matching setToolSpanCancelled
      // on the parent tool span. Without this, success: false would set ERROR
      // and trace backends filtering for errors would false-positive on
      // user cancellations.
      expect(record?.statuses).toHaveLength(0);
      // Attributes still record the cancellation reason.
      expect(record?.attributes['success']).toBe(false);
      expect(record?.attributes['error']).toBe(
        'Tool execution cancelled by user',
      );
    });

    it('cancelled: false (default) still maps success: false to ERROR status', () => {
      const execSpan = startToolExecutionSpan();
      endToolExecutionSpan(execSpan, {
        success: false,
        error: 'Tool execution failed',
      });

      const record = mockSpans.find(
        (s) => s.name === 'qwen-code.tool.execution',
      );
      expect(record?.statuses).toHaveLength(1);
      expect(record?.statuses[0]!.code).toBe(SpanStatusCode.ERROR);
      expect(record?.statuses[0]!.message).toBe('Tool execution failed');
    });
  });

  describe('blocked_on_user spans (#3731 Phase 2)', () => {
    it('parents the blocked span under the explicitly-passed tool span', () => {
      const toolSpan = startToolSpan('Bash', { 'tool.call_id': 'c1' });
      const blockedSpan = startToolBlockedOnUserSpan(toolSpan, {
        tool_name: 'Bash',
        call_id: 'c1',
      });

      const blockedRecord = mockSpans.find(
        (s) => s.name === 'qwen-code.tool.blocked_on_user',
      );
      expect(blockedRecord).toBeDefined();
      // Parent context carries the tool span via setSpan()'s __parentSpan tag.
      expect(blockedRecord?.parentContext).toMatchObject({
        __parentSpan: toolSpan,
      });
      expect(blockedRecord?.attributes['tool.name']).toBe('Bash');
      expect(blockedRecord?.attributes['tool.call_id']).toBe('c1');

      endToolBlockedOnUserSpan(blockedSpan, {
        decision: 'proceed_once',
        source: 'cli',
      });
      endToolSpan(toolSpan, { success: true });
    });

    it('records decision/source attributes on end and leaves status UNSET', () => {
      const toolSpan = startToolSpan('Bash');
      const blockedSpan = startToolBlockedOnUserSpan(toolSpan);
      endToolBlockedOnUserSpan(blockedSpan, {
        decision: 'cancel',
        source: 'cli',
      });

      const blockedRecord = mockSpans.find(
        (s) => s.name === 'qwen-code.tool.blocked_on_user',
      );
      expect(blockedRecord?.ended).toBe(true);
      expect(blockedRecord?.attributes['decision']).toBe('cancel');
      expect(blockedRecord?.attributes['source']).toBe('cli');
      // Waiting on the user is neither OK nor ERROR — status stays UNSET.
      expect(blockedRecord?.statuses).toHaveLength(0);
    });

    it('is idempotent — second end is a no-op', () => {
      const toolSpan = startToolSpan('Bash');
      const blockedSpan = startToolBlockedOnUserSpan(toolSpan);
      endToolBlockedOnUserSpan(blockedSpan, { decision: 'proceed_once' });
      endToolBlockedOnUserSpan(blockedSpan, { decision: 'cancel' });

      const blockedRecord = mockSpans.find(
        (s) => s.name === 'qwen-code.tool.blocked_on_user',
      );
      // The second end must NOT overwrite decision recorded by the first.
      expect(blockedRecord?.attributes['decision']).toBe('proceed_once');
    });

    it('returns NOOP span when SDK is not initialized', () => {
      mockState.sdkInitialized = false;
      const toolSpan = startToolSpan('Bash');
      const blockedSpan = startToolBlockedOnUserSpan(toolSpan);
      expect(blockedSpan.spanContext().traceId).toBe('0'.repeat(32));

      // End on NOOP span must not throw.
      endToolBlockedOnUserSpan(blockedSpan, { decision: 'cancel' });
    });

    it('handles concurrent blocked spans without findLast confusion', () => {
      // Regression test for the claude-code findLast-by-type bug.
      // Two concurrent tools each have their own blocked span; ending the
      // second one first must NOT close the first.
      const toolA = startToolSpan('Bash', { 'tool.call_id': 'a' });
      const toolB = startToolSpan('Read', { 'tool.call_id': 'b' });
      const blockedA = startToolBlockedOnUserSpan(toolA, { call_id: 'a' });
      const blockedB = startToolBlockedOnUserSpan(toolB, { call_id: 'b' });

      endToolBlockedOnUserSpan(blockedB, { decision: 'cancel' });

      const recordA = mockSpans.find(
        (s) =>
          s.name === 'qwen-code.tool.blocked_on_user' &&
          s.attributes['tool.call_id'] === 'a',
      );
      const recordB = mockSpans.find(
        (s) =>
          s.name === 'qwen-code.tool.blocked_on_user' &&
          s.attributes['tool.call_id'] === 'b',
      );
      // Only B is ended; A still active.
      expect(recordB?.ended).toBe(true);
      expect(recordA?.ended).toBeFalsy();

      endToolBlockedOnUserSpan(blockedA, { decision: 'proceed_once' });
      expect(recordA?.attributes['decision']).toBe('proceed_once');
      expect(recordB?.attributes['decision']).toBe('cancel');

      endToolSpan(toolA, { success: true });
      endToolSpan(toolB, { success: false, error: 'cancelled' });
    });

    it('falls back to resolveParentContext when the tool span was already ended', () => {
      const toolSpan = startToolSpan('Bash');
      // Simulate someone passing an already-ended tool span — the helper
      // should still produce a span (correlated via the standard fallback
      // chain) instead of crashing.
      endToolSpan(toolSpan, { success: true });

      const blockedSpan = startToolBlockedOnUserSpan(toolSpan);
      expect(
        mockSpans.find((s) => s.name === 'qwen-code.tool.blocked_on_user'),
      ).toBeDefined();

      endToolBlockedOnUserSpan(blockedSpan, { decision: 'proceed_once' });
    });
  });

  describe('hook spans (#3731 Phase 2)', () => {
    it('parents under the active tool span when called inside runInToolSpanContext', () => {
      const toolSpan = startToolSpan('Bash');

      let hookSpan!: ReturnType<typeof startHookSpan>;
      runInToolSpanContext(toolSpan, () => {
        hookSpan = startHookSpan({
          hookEvent: 'PreToolUse',
          toolName: 'Bash',
          toolUseId: 'use-1',
        });
      });

      const hookRecord = mockSpans.find((s) => s.name === 'qwen-code.hook');
      expect(hookRecord).toBeDefined();
      expect(hookRecord?.parentContext).toBeDefined();
      expect(hookRecord?.attributes['hook_event']).toBe('PreToolUse');
      expect(hookRecord?.attributes['tool.name']).toBe('Bash');
      expect(hookRecord?.attributes['tool.use_id']).toBe('use-1');

      endHookSpan(hookSpan, { success: true, shouldProceed: true });
      endToolSpan(toolSpan, { success: true });
    });

    it('records shouldProceed/blockType when PreToolUse blocks', () => {
      const toolSpan = startToolSpan('Bash');
      let hookSpan!: ReturnType<typeof startHookSpan>;
      runInToolSpanContext(toolSpan, () => {
        hookSpan = startHookSpan({
          hookEvent: 'PreToolUse',
          toolName: 'Bash',
        });
      });
      endHookSpan(hookSpan, {
        success: true,
        shouldProceed: false,
        blockType: 'denied',
      });

      const hookRecord = mockSpans.find((s) => s.name === 'qwen-code.hook');
      expect(hookRecord?.attributes['should_proceed']).toBe(false);
      expect(hookRecord?.attributes['block_type']).toBe('denied');
      // Blocking is intentional, not an error — status must stay UNSET.
      expect(hookRecord?.statuses).toHaveLength(0);

      endToolSpan(toolSpan, { success: false, error: 'denied' });
    });

    it('records shouldStop/hasAdditionalContext on PostToolUse', () => {
      const toolSpan = startToolSpan('Bash');
      let hookSpan!: ReturnType<typeof startHookSpan>;
      runInToolSpanContext(toolSpan, () => {
        hookSpan = startHookSpan({
          hookEvent: 'PostToolUse',
          toolName: 'Bash',
        });
      });
      endHookSpan(hookSpan, {
        success: true,
        shouldStop: true,
        hasAdditionalContext: true,
      });

      const hookRecord = mockSpans.find((s) => s.name === 'qwen-code.hook');
      expect(hookRecord?.attributes['should_stop']).toBe(true);
      expect(hookRecord?.attributes['has_additional_context']).toBe(true);
      expect(hookRecord?.statuses).toHaveLength(0);

      endToolSpan(toolSpan, { success: true });
    });

    it('records shouldStop/hasAdditionalContext on PostToolBatch', () => {
      const hookSpan = startHookSpan({
        hookEvent: 'PostToolBatch',
        toolName: 'batch',
      });
      endHookSpan(hookSpan, {
        success: true,
        shouldStop: true,
        hasAdditionalContext: true,
        postBatchStop: true,
        postBatchStopReason: 'policy halt',
      });

      const hookRecord = mockSpans.find((s) => s.name === 'qwen-code.hook');
      expect(hookRecord?.attributes['hook_event']).toBe('PostToolBatch');
      expect(hookRecord?.attributes['should_stop']).toBe(true);
      expect(hookRecord?.attributes['has_additional_context']).toBe(true);
      expect(hookRecord?.attributes['post_batch_stop']).toBe(true);
      expect(hookRecord?.attributes['post_batch_stop_reason']).toBe(
        'policy halt',
      );
      expect(hookRecord?.statuses).toHaveLength(0);
    });

    it('marks status ERROR only when the hook itself threw', () => {
      const toolSpan = startToolSpan('Bash');
      let hookSpan!: ReturnType<typeof startHookSpan>;
      runInToolSpanContext(toolSpan, () => {
        hookSpan = startHookSpan({
          hookEvent: 'PostToolUseFailure',
          toolName: 'Bash',
          isInterrupt: true,
        });
      });
      endHookSpan(hookSpan, { success: false, error: 'hook crashed' });

      const hookRecord = mockSpans.find((s) => s.name === 'qwen-code.hook');
      expect(hookRecord?.statuses[0]?.code).toBe(SpanStatusCode.ERROR);
      expect(hookRecord?.statuses[0]?.message).toBe('hook crashed');
      expect(hookRecord?.attributes['is_interrupt']).toBe(true);

      endToolSpan(toolSpan, { success: false, error: 'cancelled' });
    });

    it('returns NOOP span when SDK is not initialized', () => {
      mockState.sdkInitialized = false;
      const hookSpan = startHookSpan({
        hookEvent: 'PreToolUse',
        toolName: 'Bash',
      });
      expect(hookSpan.spanContext().traceId).toBe('0'.repeat(32));
      endHookSpan(hookSpan, { success: true });
    });
  });

  describe('toolContext ALS lifecycle', () => {
    it('runInToolSpanContext scopes toolContext via run(), not enterWith', () => {
      const toolSpan = startToolSpan('Bash');

      let execSpanInsideContext: ReturnType<typeof startToolExecutionSpan>;

      runInToolSpanContext(toolSpan, () => {
        execSpanInsideContext = startToolExecutionSpan();
      });
      const execSpanOutsideContext = startToolExecutionSpan();

      // Inside context: should have parent
      const insideRecord = mockSpans.find(
        (s) =>
          s.name === 'qwen-code.tool.execution' &&
          (s.parentContext as Record<string, unknown>)?.['__parentSpan'],
      );
      expect(insideRecord).toBeDefined();

      // Outside context: should NOT have tool parent
      const outsideRecord = mockSpans.filter(
        (s) => s.name === 'qwen-code.tool.execution',
      );
      expect(outsideRecord).toHaveLength(2);
      const noParent = outsideRecord.find(
        (s) => !(s.parentContext as Record<string, unknown>)?.['__parentSpan'],
      );
      expect(noParent).toBeDefined();

      endToolExecutionSpan(execSpanInsideContext!, { success: true });
      endToolExecutionSpan(execSpanOutsideContext!, { success: true });
      endToolSpan(toolSpan, { success: true });
    });

    it('endToolSpan without metadata preserves pre-set status', () => {
      const toolSpan = startToolSpan('Bash');
      // Simulate setToolSpanFailure calling setStatus directly
      (
        toolSpan as unknown as MockSpanRecord & {
          setStatus: (s: { code: number; message?: string }) => void;
        }
      ).setStatus({ code: SpanStatusCode.ERROR, message: 'hook blocked' });

      endToolSpan(toolSpan);

      // endToolSpan should NOT have added another status
      const toolRecord = mockSpans.find((s) => s.name === 'qwen-code.tool');
      expect(toolRecord!.statuses).toHaveLength(1);
      expect(toolRecord!.statuses[0]!.code).toBe(SpanStatusCode.ERROR);
    });
  });

  describe('getActiveInteractionSpan', () => {
    it('returns the span when an interaction is active', () => {
      const config = createMockConfig();
      startInteractionSpan(config, {
        promptId: 'p-active',
        model: 'm',
        messageType: 'userQuery',
      });

      const span = getActiveInteractionSpan();
      expect(span).toBeDefined();
      expect(span).toBe(mockSpans[0]);
    });

    it('returns undefined after endInteractionSpan', () => {
      const config = createMockConfig();
      startInteractionSpan(config, {
        promptId: 'p-end',
        model: 'm',
        messageType: 'userQuery',
      });
      endInteractionSpan('ok');

      expect(getActiveInteractionSpan()).toBeUndefined();
    });

    it('falls back to lastInteractionCtx outside the AsyncLocalStorage context', async () => {
      const config = createMockConfig();
      startInteractionSpan(config, {
        promptId: 'p-fallback',
        model: 'm',
        messageType: 'userQuery',
      });
      // Yield via setImmediate to schedule the continuation on a separate
      // async resource — best-effort attempt to leave the ALS scope so
      // getActiveInteractionSpan must rely on lastInteractionCtx.
      await new Promise<void>((resolve) => setImmediate(resolve));

      const span = getActiveInteractionSpan();
      expect(span).toBeDefined();
      expect(span).toBe(mockSpans[0]);
    });

    it('returns undefined when no interaction has ever started', () => {
      expect(getActiveInteractionSpan()).toBeUndefined();
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

  describe('OTel error resilience — span.end() must run on attribute/status failure', () => {
    it('endLLMRequestSpan: end() runs and activeSpans is cleared when setStatus throws', () => {
      const span = startLLMRequestSpan('test-model', 'prompt-x');
      const record = mockSpans.find((s) => s.name === 'qwen-code.llm_request')!;

      mockState.throwOnSetStatus = true;
      endLLMRequestSpan(span, { success: true });

      expect(record.ended).toBe(true);
      // Idempotency: a second call must short-circuit (spanCtx removed from activeSpans).
      mockState.throwOnSetStatus = false;
      endLLMRequestSpan(span, { success: true });
      expect(record.statuses).toHaveLength(0); // no recovery status added
    });

    it('endLLMRequestSpan: end() runs when setAttributes throws', () => {
      const span = startLLMRequestSpan('test-model', 'prompt-x');
      const record = mockSpans.find((s) => s.name === 'qwen-code.llm_request')!;

      mockState.throwOnSetAttributes = true;
      endLLMRequestSpan(span, { success: true });

      expect(record.ended).toBe(true);
    });

    it('endToolSpan: end() runs when setStatus throws', () => {
      const span = startToolSpan('Bash');
      const record = mockSpans.find((s) => s.name === 'qwen-code.tool')!;

      mockState.throwOnSetStatus = true;
      endToolSpan(span, { success: true });

      expect(record.ended).toBe(true);
    });

    it('endToolExecutionSpan: end() runs when setAttributes throws', () => {
      const toolSpan = startToolSpan('Bash');
      let execSpan!: ReturnType<typeof startToolExecutionSpan>;
      runInToolSpanContext(toolSpan, () => {
        execSpan = startToolExecutionSpan();
      });
      const execRecord = mockSpans.find(
        (s) => s.name === 'qwen-code.tool.execution',
      )!;

      mockState.throwOnSetAttributes = true;
      endToolExecutionSpan(execSpan, { success: true });

      expect(execRecord.ended).toBe(true);

      mockState.throwOnSetAttributes = false;
      endToolSpan(toolSpan, { success: true });
    });
  });

  describe('TTL safety net (#4321 review)', () => {
    it('marks stale spans with ttl_expired + duration_ms before ending them', () => {
      const toolSpan = startToolSpan('staleTool');
      const record = mockSpans.find((s) => s.name === 'qwen-code.tool')!;

      // 31 minutes after the span started — past the 30-min TTL.
      const staleNow = Date.now() + 31 * 60 * 1000;
      runTTLSweepForTesting(staleNow);

      expect(record.ended).toBe(true);
      // Without the sentinel attrs, operators couldn't tell a TTL-aborted
      // span from a deliberately-ended span that lost attribution.
      expect(record.attributes['qwen-code.span.ttl_expired']).toBe(true);
      expect(
        record.attributes['qwen-code.span.duration_ms'] as number,
      ).toBeGreaterThanOrEqual(31 * 60 * 1000 - 1000);

      // Calling endToolSpan after the TTL fires must still be safe — span
      // already ended, attempt is a no-op.
      endToolSpan(toolSpan, { success: false });
    });

    it('does not mark spans that were ended before TTL expiry', () => {
      const toolSpan = startToolSpan('liveTool');
      const record = mockSpans.find((s) => s.name === 'qwen-code.tool')!;

      // End normally, then run a sweep. The span is already ended → the
      // sweep must not retroactively stamp ttl_expired on it.
      endToolSpan(toolSpan, { success: true });
      runTTLSweepForTesting(Date.now() + 31 * 60 * 1000);

      expect(record.attributes['qwen-code.span.ttl_expired']).toBeUndefined();
    });

    it('stamps decision=aborted/source=system on TTL-expired blocked_on_user spans', () => {
      // The blocked-span branch in sweepStaleSpans tags the canonical
      // taxonomy so dashboards filtering by `decision: 'aborted'` count
      // walk-aways alongside explicit user aborts.
      const toolSpan = startToolSpan('blockedStaleParent');
      const blockedSpan = startToolBlockedOnUserSpan(toolSpan, {
        tool_name: 'blockedStaleParent',
      });
      const blockedRecord = mockSpans.find(
        (s) => s.name === 'qwen-code.tool.blocked_on_user',
      )!;

      runTTLSweepForTesting(Date.now() + 31 * 60 * 1000);

      expect(blockedRecord.ended).toBe(true);
      expect(blockedRecord.attributes['qwen-code.span.ttl_expired']).toBe(true);
      expect(blockedRecord.attributes['decision']).toBe('aborted');
      expect(blockedRecord.attributes['source']).toBe('system');

      // Cleanup the still-active tool span.
      endToolBlockedOnUserSpan(blockedSpan);
      endToolSpan(toolSpan, { success: false });
    });
  });

  describe('truncateSpanError (#4321 review)', () => {
    it('returns short strings unchanged', () => {
      expect(truncateSpanError('short message')).toBe('short message');
      expect(truncateSpanError('')).toBe('');
    });

    it('truncates strings over 1024 chars and appends a sentinel suffix', () => {
      const oversized = 'a'.repeat(2000);
      const truncated = truncateSpanError(oversized);
      expect(truncated.length).toBeLessThan(oversized.length);
      expect(truncated.endsWith('…[truncated]')).toBe(true);
      expect(truncated.startsWith('a'.repeat(1024))).toBe(true);
    });

    it('does not double-suffix already-truncated input', () => {
      // Hard guarantee: the sentinel is only appended when the input
      // exceeds the cap. A short string with the suffix already present
      // would NOT pass back through truncate at production sites — but
      // sanity-check the boundary anyway.
      const exactlyAtCap = 'b'.repeat(1024);
      expect(truncateSpanError(exactlyAtCap)).toBe(exactlyAtCap);
    });

    it('backs up one code unit when the cut would split a surrogate pair (#4321)', () => {
      // OTLP/gRPC collectors reject batches with invalid UTF-8. If the
      // 1024-char cap lands between the high + low surrogate of an
      // emoji or rare CJK character, truncateSpanError must back up one
      // code unit so we never emit a lone high surrogate.
      // 🚀 is U+1F680, encoded as the surrogate pair [0xD83D, 0xDE80].
      // Put it so the high surrogate is at char index 1023 (last byte
      // BEFORE the cap), low surrogate at 1024 (first byte AFTER the
      // cap): pad with 1023 'a's, then the rocket, then enough filler
      // to push above the cap.
      const oversized = 'a'.repeat(1023) + '🚀' + 'b'.repeat(100);
      const truncated = truncateSpanError(oversized);
      // The truncated string must not END with a lone high surrogate
      // (code point in [0xD800, 0xDBFF]). The implementation backs up
      // one code unit when needed.
      const lastBeforeSentinel = truncated.slice(0, -'…[truncated]'.length);
      const lastCharCode = lastBeforeSentinel.charCodeAt(
        lastBeforeSentinel.length - 1,
      );
      expect(lastCharCode).not.toBeGreaterThanOrEqual(0xd800);
      // Validate there are no orphan high surrogates anywhere in the
      // string — `Buffer.from(s, 'utf16le')` doesn't validate
      // surrogate pairs (#4321 review-9), so test the property
      // directly with a regex that matches a high surrogate NOT
      // followed by a low surrogate.
      expect(truncated).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    });
  });
});
