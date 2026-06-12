/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ROOT_CONTEXT, SpanStatusCode } from '@opentelemetry/api';

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
  /** True iff `startSpan` was called with `{ root: true }` (linked-root path). */
  root?: boolean;
  /** Span links captured from the `startSpan` opts. */
  links?: Array<{
    context: { spanId: string; traceId: string };
    attributes?: Record<string, unknown>;
  }>;
}

const mockSpans: MockSpanRecord[] = [];

vi.mock('@opentelemetry/api', async () => {
  const actual =
    await vi.importActual<typeof import('@opentelemetry/api')>(
      '@opentelemetry/api',
    );

  function createMockSpan(
    name: string,
    opts?: {
      kind?: number;
      attributes?: Record<string, unknown>;
      root?: boolean;
      links?: Array<{
        context: { spanId: string; traceId: string };
        attributes?: Record<string, unknown>;
      }>;
    },
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
      root: opts?.root,
      links: opts?.links,
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
  withInteractionSpan,
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
  startSubagentSpan,
  endSubagentSpan,
  runInSubagentSpanContext,
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

    it('defaults to ROOT_CONTEXT when no parentContext is provided', async () => {
      await withInteractionSpan(
        createMockConfig({ sessionId: 's' }),
        { promptId: 'p', model: 'm', messageType: 'cron' },
        async () => {},
      );

      const span = mockSpans.find((s) => s.name === 'qwen-code.interaction');
      expect(span?.parentContext).toBe(ROOT_CONTEXT);
    });

    it('runs scoped interaction spans without mutating the global interaction context', async () => {
      const config = createMockConfig({ sessionId: 'scoped-session' });
      const result = await withInteractionSpan(
        config,
        {
          promptId: 'prompt-scoped',
          model: 'test-model',
          messageType: 'acp_prompt',
          parentContext: { parent: 'daemon' } as never,
        },
        async () => 'done',
      );

      expect(result).toBe('done');
      expect(mockSpans).toHaveLength(1);
      expect(mockSpans[0]!.name).toBe('qwen-code.interaction');
      expect(mockSpans[0]!.parentContext).toEqual({ parent: 'daemon' });
      expect(mockSpans[0]!.attributes['session.id']).toBe('scoped-session');
      expect(mockSpans[0]!.attributes['qwen-code.message_type']).toBe(
        'acp_prompt',
      );
      expect(mockSpans[0]!.ended).toBe(true);
      expect(mockSpans[0]!.statuses.at(-1)?.code).toBe(SpanStatusCode.OK);
    });

    it('marks the interaction span ERROR when getResultStatus returns "error"', async () => {
      const config = createMockConfig();
      await withInteractionSpan(
        config,
        { promptId: 'p-cron-err', model: 'm', messageType: 'cron' },
        async () => 'done',
        () => 'error',
      );

      const span = mockSpans.find((s) => s.name === 'qwen-code.interaction');
      expect(span?.attributes['qwen-code.turn_status']).toBe('error');
      expect(span?.statuses.at(-1)?.code).toBe(SpanStatusCode.ERROR);
    });

    it('keeps a thrown error message instead of the generic error-status message', async () => {
      const config = createMockConfig();
      await expect(
        withInteractionSpan(
          config,
          { promptId: 'p-throw', model: 'm', messageType: 'cron' },
          async () => {
            throw new Error('boom from fn');
          },
        ),
      ).rejects.toThrow('boom from fn');

      const span = mockSpans.find((s) => s.name === 'qwen-code.interaction');
      expect(span?.statuses.at(-1)?.code).toBe(SpanStatusCode.ERROR);
      expect(span?.statuses.at(-1)?.message).toBe('boom from fn');
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

  describe('interaction span — per-prompt traceId', () => {
    it('uses ROOT_CONTEXT as parent (each interaction is a trace root)', () => {
      setSessionContext(undefined, 'test-session');

      startInteractionSpan(createMockConfig({ sessionId: 'test-session' }), {
        promptId: 'p',
        model: 'm',
        messageType: 'userQuery',
      });

      const span = mockSpans.find((s) => s.name === 'qwen-code.interaction');
      expect(span?.parentContext).toBe(ROOT_CONTEXT);
    });

    it('ignores active OTel span — interaction always starts a new trace', () => {
      mockState.activeOtelSpan = { name: 'unrelated-wrapper-span' };

      startInteractionSpan(createMockConfig({ sessionId: 'test-session' }), {
        promptId: 'p',
        model: 'm',
        messageType: 'userQuery',
      });

      const span = mockSpans.find((s) => s.name === 'qwen-code.interaction');
      expect(span?.parentContext).toBe(ROOT_CONTEXT);
    });

    it('still stamps session.id attribute for cross-prompt correlation', () => {
      startInteractionSpan(createMockConfig({ sessionId: 'my-session' }), {
        promptId: 'p',
        model: 'm',
        messageType: 'userQuery',
      });

      const span = mockSpans.find((s) => s.name === 'qwen-code.interaction');
      expect(span?.attributes['session.id']).toBe('my-session');
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

      // sampling_ms = duration - ttft = 1000 - 200 (setup is NOT subtracted —
      // duration_ms only covers ttft + sampling, never the setup phase that
      // precedes the span. See Phase 4b commit fixing the formula bug.)
      expect(mockSpans[0]!.attributes['sampling_ms']).toBe(800);
    });

    it('endLLMRequestSpan does NOT subtract requestSetupMs from sampling_ms (Phase 4b bug fix)', () => {
      // Phase 4a's formula `duration - ttft - setup` double-counted setup
      // because duration_ms ALREADY excludes setup (span starts after setup).
      // Phase 4b populates requestSetupMs with cumulative retry overhead —
      // if the formula still subtracted setup, sampling_ms would clamp to 0
      // for every retried request, wiping output-throughput data.
      const span = startLLMRequestSpan('m', 'p');
      endLLMRequestSpan(span, {
        success: true,
        ttftMs: 200,
        requestSetupMs: 300, // would yield 500 under old formula; we want 800
        durationMs: 1000,
      });

      expect(mockSpans[0]!.attributes['sampling_ms']).toBe(800);
      // request_setup_ms is still emitted as its own attribute — operators can
      // see the retry overhead AND the sampling time independently.
      expect(mockSpans[0]!.attributes['request_setup_ms']).toBe(300);
    });

    it('endLLMRequestSpan clamps sampling_ms to 0 when ttft exceeds duration (clock skew)', () => {
      const span = startLLMRequestSpan('m', 'p');
      endLLMRequestSpan(span, {
        success: true,
        ttftMs: 1500,
        durationMs: 1000,
      });

      // Math.max(0, 1000 - 1500) = 0 — only triggers when ttft > duration,
      // which in practice means clock drift or a measurement bug.
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

  describe('LLM request spans — response metadata & error enrichment', () => {
    it('endLLMRequestSpan dual-emits response_id / gen_ai.response.id', () => {
      const span = startLLMRequestSpan('m', 'p');
      endLLMRequestSpan(span, {
        success: true,
        responseId: 'chatcmpl-abc123',
      });

      const attrs = mockSpans[0]!.attributes;
      expect(attrs['response_id']).toBe('chatcmpl-abc123');
      expect(attrs['gen_ai.response.id']).toBe('chatcmpl-abc123');
    });

    it('endLLMRequestSpan omits response_id when undefined', () => {
      const span = startLLMRequestSpan('m', 'p');
      endLLMRequestSpan(span, { success: true });

      const attrs = mockSpans[0]!.attributes;
      expect(attrs['response_id']).toBeUndefined();
      expect(attrs['gen_ai.response.id']).toBeUndefined();
    });

    it('endLLMRequestSpan dual-emits finish_reason / gen_ai.response.finish_reasons (string vs array)', () => {
      const span = startLLMRequestSpan('m', 'p');
      endLLMRequestSpan(span, {
        success: true,
        finishReason: 'STOP',
      });

      const attrs = mockSpans[0]!.attributes;
      expect(attrs['finish_reason']).toBe('STOP');
      expect(attrs['gen_ai.response.finish_reasons']).toEqual(['STOP']);
    });

    it('endLLMRequestSpan omits finish_reason when undefined', () => {
      const span = startLLMRequestSpan('m', 'p');
      endLLMRequestSpan(span, { success: true });

      const attrs = mockSpans[0]!.attributes;
      expect(attrs['finish_reason']).toBeUndefined();
      expect(attrs['gen_ai.response.finish_reasons']).toBeUndefined();
    });

    it('endLLMRequestSpan dual-emits thoughts_token_count / gen_ai.usage.reasoning_tokens', () => {
      const span = startLLMRequestSpan('m', 'p');
      endLLMRequestSpan(span, {
        success: true,
        thoughtsTokenCount: 42,
      });

      const attrs = mockSpans[0]!.attributes;
      expect(attrs['thoughts_token_count']).toBe(42);
      expect(attrs['gen_ai.usage.reasoning_tokens']).toBe(42);
    });

    it('endLLMRequestSpan emits thoughts_token_count === 0 (no reasoning is meaningful info, not undefined)', () => {
      const span = startLLMRequestSpan('m', 'p');
      endLLMRequestSpan(span, {
        success: true,
        thoughtsTokenCount: 0,
      });

      const attrs = mockSpans[0]!.attributes;
      expect(attrs['thoughts_token_count']).toBe(0);
      expect(attrs['gen_ai.usage.reasoning_tokens']).toBe(0);
    });

    it('endLLMRequestSpan omits thoughts_token_count when undefined', () => {
      const span = startLLMRequestSpan('m', 'p');
      endLLMRequestSpan(span, { success: true });

      const attrs = mockSpans[0]!.attributes;
      expect(attrs['thoughts_token_count']).toBeUndefined();
      expect(attrs['gen_ai.usage.reasoning_tokens']).toBeUndefined();
    });

    it('endLLMRequestSpan emits subagent_name when present', () => {
      const span = startLLMRequestSpan('m', 'p');
      endLLMRequestSpan(span, {
        success: true,
        subagentName: 'Explore-abc123',
      });

      const attrs = mockSpans[0]!.attributes;
      expect(attrs['subagent_name']).toBe('Explore-abc123');
    });

    it('endLLMRequestSpan omits subagent_name when undefined', () => {
      const span = startLLMRequestSpan('m', 'p');
      endLLMRequestSpan(span, { success: true });

      expect(mockSpans[0]!.attributes['subagent_name']).toBeUndefined();
    });

    it('endLLMRequestSpan emits error_type and error.type on error spans', () => {
      const span = startLLMRequestSpan('m', 'p');
      endLLMRequestSpan(span, {
        success: false,
        error: 'API call failed',
        errorType: 'RateLimitError',
        errorStatusCode: 429,
      });

      const attrs = mockSpans[0]!.attributes;
      expect(attrs['error_type']).toBe('RateLimitError');
      expect(attrs['error.type']).toBe('RateLimitError');
      expect(attrs['error_status_code']).toBe(429);
    });

    it('endLLMRequestSpan omits error_type/error_status_code on success spans', () => {
      const span = startLLMRequestSpan('m', 'p');
      endLLMRequestSpan(span, { success: true });

      const attrs = mockSpans[0]!.attributes;
      expect(attrs['error_type']).toBeUndefined();
      expect(attrs['error.type']).toBeUndefined();
      expect(attrs['error_status_code']).toBeUndefined();
    });

    it('endLLMRequestSpan emits all new attributes together', () => {
      const span = startLLMRequestSpan('m', 'p');
      endLLMRequestSpan(span, {
        success: true,
        inputTokens: 500,
        outputTokens: 100,
        responseId: 'resp-xyz',
        finishReason: 'MAX_TOKENS',
        thoughtsTokenCount: 30,
        subagentName: 'code-reviewer',
      });

      const attrs = mockSpans[0]!.attributes;
      expect(attrs['response_id']).toBe('resp-xyz');
      expect(attrs['gen_ai.response.id']).toBe('resp-xyz');
      expect(attrs['finish_reason']).toBe('MAX_TOKENS');
      expect(attrs['gen_ai.response.finish_reasons']).toEqual(['MAX_TOKENS']);
      expect(attrs['thoughts_token_count']).toBe(30);
      expect(attrs['gen_ai.usage.reasoning_tokens']).toBe(30);
      expect(attrs['subagent_name']).toBe('code-reviewer');
      expect(attrs['input_tokens']).toBe(500);
      expect(attrs['output_tokens']).toBe(100);
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

  describe('session.id derives from the owning session, not the process-global (#4602 review)', () => {
    it('stamps a tool span with the interaction session.id even when the process-global belongs to another session', () => {
      // Daemon scenario: telemetry init left the process-global pointing at
      // session B, but the active interaction belongs to session A.
      setSessionContext(undefined, 'session-B-global');
      startInteractionSpan(createMockConfig({ sessionId: 'session-A' }), {
        promptId: 'p-a',
        model: 'm',
        messageType: 'acp_prompt',
      });

      const span = startToolSpan('Bash', { 'tool.call_id': 'c1' });
      endToolSpan(span, { success: true });

      const toolSpan = mockSpans.find((s) => s.name === 'qwen-code.tool');
      expect(toolSpan?.attributes['session.id']).toBe('session-A');
    });

    it('stamps an llm_request span with the interaction session.id, not the global', () => {
      setSessionContext(undefined, 'session-B-global');
      startInteractionSpan(createMockConfig({ sessionId: 'session-A' }), {
        promptId: 'p-a',
        model: 'm',
        messageType: 'acp_prompt',
      });

      const span = startLLMRequestSpan('m', 'p-a');
      endLLMRequestSpan(span, { success: true });

      const llmSpan = mockSpans.find((s) => s.name === 'qwen-code.llm_request');
      expect(llmSpan?.attributes['session.id']).toBe('session-A');
    });

    it('stamps a tool.execution span with the owning session id via the tool span context', () => {
      setSessionContext(undefined, 'session-B-global');
      startInteractionSpan(createMockConfig({ sessionId: 'session-A' }), {
        promptId: 'p-a',
        model: 'm',
        messageType: 'acp_prompt',
      });

      const toolSpan = startToolSpan('Bash', { 'tool.call_id': 'c1' });
      let execSpan!: ReturnType<typeof startToolExecutionSpan>;
      runInToolSpanContext(toolSpan, () => {
        execSpan = startToolExecutionSpan();
      });
      endToolExecutionSpan(execSpan, { success: true });
      endToolSpan(toolSpan, { success: true });

      const exec = mockSpans.find((s) => s.name === 'qwen-code.tool.execution');
      expect(exec?.attributes['session.id']).toBe('session-A');
    });

    it('isolates concurrent sessions: each tool span carries its own session id', async () => {
      // Two interactions for two different sessions while the global is stale.
      setSessionContext(undefined, 'stale-global');

      await withInteractionSpan(
        createMockConfig({ sessionId: 'session-A' }),
        { promptId: 'pa', model: 'm', messageType: 'acp_prompt' },
        async () => {
          endToolSpan(startToolSpan('Read', { 'tool.call_id': 'a1' }), {
            success: true,
          });
        },
      );
      await withInteractionSpan(
        createMockConfig({ sessionId: 'session-B' }),
        { promptId: 'pb', model: 'm', messageType: 'acp_prompt' },
        async () => {
          endToolSpan(startToolSpan('Write', { 'tool.call_id': 'b1' }), {
            success: true,
          });
        },
      );

      const readSpan = mockSpans.find(
        (s) => s.attributes['tool.name'] === 'Read',
      );
      const writeSpan = mockSpans.find(
        (s) => s.attributes['tool.name'] === 'Write',
      );
      expect(readSpan?.attributes['session.id']).toBe('session-A');
      expect(writeSpan?.attributes['session.id']).toBe('session-B');
    });

    it('falls back to the process-global session id for standalone spans (single-session CLI path)', () => {
      // No interaction context — single-session CLI: the global is correct.
      setSessionContext(undefined, 'cli-session');
      const span = startToolSpan('Bash', { 'tool.call_id': 'c1' });
      endToolSpan(span, { success: true });

      const toolSpan = mockSpans.find((s) => s.name === 'qwen-code.tool');
      expect(toolSpan?.attributes['session.id']).toBe('cli-session');
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

    it('endSubagentSpan: end() runs and activeSpans is cleared when setAttributes throws', () => {
      const span = startSubagentSpan({
        agentId: 'Explore-err',
        subagentName: 'Explore',
        invocationKind: 'foreground',
        isBuiltIn: true,
        depth: 0,
        sessionId: 'session-uuid',
      });
      const record = mockSpans.find((s) => s.name === 'qwen-code.subagent')!;

      mockState.throwOnSetAttributes = true;
      endSubagentSpan(span, { status: 'completed' });

      // The attribute write threw, but the span must still be ended so the
      // WeakRef registry doesn't leak it. Mirrors the endLLMRequestSpan /
      // endToolSpan resilience tests. #4410 review.
      expect(record.ended).toBe(true);

      // No leak: spanCtx was removed from activeSpans, so a second call
      // short-circuits and records no recovery status.
      mockState.throwOnSetAttributes = false;
      endSubagentSpan(span, { status: 'completed' });
      expect(record.statuses).toHaveLength(0);
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

  describe('subagent spans (#3731 Phase 3)', () => {
    const baseOpts = {
      agentId: 'Explore-abc123',
      subagentName: 'Explore',
      isBuiltIn: true,
      depth: 0,
      sessionId: 'session-uuid',
    } as const;

    it('foreground invocation creates a child span (no root flag, no links)', () => {
      const span = startSubagentSpan({
        ...baseOpts,
        invocationKind: 'foreground',
      });
      const record = mockSpans.find((s) => s.name === 'qwen-code.subagent');

      expect(record).toBeDefined();
      expect(record!.root).toBeUndefined();
      expect(record!.links).toBeUndefined();
      // Dual-emit: spec + vendor keys for id and name.
      expect(record!.attributes['gen_ai.agent.id']).toBe('Explore-abc123');
      expect(record!.attributes['gen_ai.agent.name']).toBe('Explore');
      expect(record!.attributes['qwen-code.subagent.id']).toBe(
        'Explore-abc123',
      );
      expect(record!.attributes['qwen-code.subagent.name']).toBe('Explore');
      // Required spec attrs.
      expect(record!.attributes['gen_ai.operation.name']).toBe('invoke_agent');
      expect(record!.attributes['gen_ai.provider.name']).toBe('qwen-code');
      expect(record!.attributes['gen_ai.conversation.id']).toBe('session-uuid');
      // Vendor concept attrs.
      expect(record!.attributes['qwen-code.subagent.invocation_kind']).toBe(
        'foreground',
      );
      expect(record!.attributes['qwen-code.subagent.is_built_in']).toBe(true);
      expect(record!.attributes['qwen-code.subagent.depth']).toBe(0);

      endSubagentSpan(span, { status: 'completed' });
    });

    it('fork invocation creates a linked-root span (root: true + Link to invoker)', () => {
      const fakeInvokerSpanContext = {
        spanId: 'invoker-span-id1',
        traceId: 'invoker-trace-id-00000000000000',
        traceFlags: 1,
      };

      const span = startSubagentSpan({
        ...baseOpts,
        invocationKind: 'fork',
        invokerSpanContext:
          fakeInvokerSpanContext as unknown as import('@opentelemetry/api').SpanContext,
      });
      const record = mockSpans.find((s) => s.name === 'qwen-code.subagent');

      expect(record!.root).toBe(true);
      expect(record!.links).toBeDefined();
      expect(record!.links).toHaveLength(1);
      expect(record!.links![0].context.spanId).toBe('invoker-span-id1');
      expect(record!.links![0].attributes?.['qwen-code.link.kind']).toBe(
        'invoker',
      );
      expect(record!.attributes['qwen-code.subagent.invocation_kind']).toBe(
        'fork',
      );

      endSubagentSpan(span, { status: 'completed' });
    });

    it('background invocation is also linked-root', () => {
      const span = startSubagentSpan({
        ...baseOpts,
        invocationKind: 'background',
      });
      const record = mockSpans.find((s) => s.name === 'qwen-code.subagent');
      expect(record!.root).toBe(true);
      // No links because invokerSpanContext was omitted — still root.
      expect(record!.attributes['qwen-code.subagent.invocation_kind']).toBe(
        'background',
      );
      endSubagentSpan(span, { status: 'completed' });
    });

    it('captures optional attrs: parentAgentId, invokingRequestId, modelOverride', () => {
      const span = startSubagentSpan({
        ...baseOpts,
        invocationKind: 'foreground',
        parentAgentId: 'parent-agent-456',
        invokingRequestId: 'req-789',
        modelOverride: 'qwen-coder-7b',
        depth: 2,
      });
      const record = mockSpans.find((s) => s.name === 'qwen-code.subagent')!;
      expect(record.attributes['qwen-code.subagent.parent_agent_id']).toBe(
        'parent-agent-456',
      );
      expect(record.attributes['qwen-code.subagent.invoking_request_id']).toBe(
        'req-789',
      );
      expect(record.attributes['gen_ai.request.model']).toBe('qwen-coder-7b');
      expect(record.attributes['qwen-code.subagent.depth']).toBe(2);
      endSubagentSpan(span, { status: 'completed' });
    });

    it('endSubagentSpan: completed → SpanStatus OK + duration recorded', () => {
      const span = startSubagentSpan({
        ...baseOpts,
        invocationKind: 'foreground',
      });
      endSubagentSpan(span, { status: 'completed' });

      const record = mockSpans.find((s) => s.name === 'qwen-code.subagent')!;
      expect(record.ended).toBe(true);
      expect(record.statuses).toContainEqual({ code: SpanStatusCode.OK });
      expect(record.attributes['qwen-code.subagent.status']).toBe('completed');
      expect(
        record.attributes['qwen-code.subagent.duration_ms'] as number,
      ).toBeGreaterThanOrEqual(0);
    });

    it('endSubagentSpan: failed → SpanStatus ERROR + exception.message + error.type', () => {
      const span = startSubagentSpan({
        ...baseOpts,
        invocationKind: 'foreground',
      });
      endSubagentSpan(span, {
        status: 'failed',
        error: 'something broke',
        errorType: 'TypeError',
      });

      const record = mockSpans.find((s) => s.name === 'qwen-code.subagent')!;
      expect(record.statuses[0].code).toBe(SpanStatusCode.ERROR);
      expect(record.statuses[0].message).toBe('something broke');
      expect(record.attributes['exception.message']).toBe('something broke');
      expect(record.attributes['error.type']).toBe('TypeError');
      expect(record.attributes['qwen-code.subagent.status']).toBe('failed');
    });

    it('endSubagentSpan: failed without explicit error → generic "subagent failed" SpanStatus message', () => {
      // Coverage for the fallback in endSubagentSpan's ERROR branch:
      // `metadata.error ? truncateSpanError(metadata.error) : 'subagent failed'`.
      // Every prior failure test passes an explicit error; this verifies
      // the generic fallback so a regression that drops it would be
      // caught. wenshao @ #4410 DeepSeek 3293036600.
      const span = startSubagentSpan({
        ...baseOpts,
        invocationKind: 'foreground',
      });
      endSubagentSpan(span, { status: 'failed' });

      const record = mockSpans.find((s) => s.name === 'qwen-code.subagent')!;
      expect(record.statuses[0].code).toBe(SpanStatusCode.ERROR);
      expect(record.statuses[0].message).toBe('subagent failed');
      expect(record.attributes['exception.message']).toBeUndefined();
      expect(record.attributes['error.type']).toBeUndefined();
    });

    it.each(['cancelled', 'aborted'] as const)(
      'endSubagentSpan: %s → SpanStatus UNSET (Phase 2 cancellation convention)',
      (status) => {
        const span = startSubagentSpan({
          ...baseOpts,
          invocationKind: 'foreground',
        });
        endSubagentSpan(span, { status });
        const record = mockSpans.find((s) => s.name === 'qwen-code.subagent')!;
        // No SpanStatus calls means UNSET stays UNSET.
        expect(record.statuses).toHaveLength(0);
        expect(record.attributes['qwen-code.subagent.status']).toBe(status);
      },
    );

    it('endSubagentSpan is idempotent (second call is a no-op)', () => {
      const span = startSubagentSpan({
        ...baseOpts,
        invocationKind: 'foreground',
      });
      endSubagentSpan(span, { status: 'completed' });
      endSubagentSpan(span, { status: 'failed', error: 'should not record' });

      const record = mockSpans.find((s) => s.name === 'qwen-code.subagent')!;
      // Only the first end ran — status is still OK, not ERROR.
      expect(record.statuses).toEqual([{ code: SpanStatusCode.OK }]);
      expect(record.attributes['qwen-code.subagent.status']).toBe('completed');
    });

    it('runInSubagentSpanContext wraps fn in context.with', async () => {
      // Our mocked context.with just runs fn (line 119). The behavioral
      // assertion is "fn was called and its result returned"; the parent-
      // context behavior is covered by the integration test in
      // agent.test.ts where real OTel context propagation matters.
      const span = startSubagentSpan({
        ...baseOpts,
        invocationKind: 'foreground',
      });
      const result = await runInSubagentSpanContext(span, async () => 42);
      expect(result).toBe(42);
      endSubagentSpan(span, { status: 'completed' });
    });

    it('returns NOOP_SPAN when SDK is uninitialized', () => {
      mockState.sdkInitialized = false;
      const span = startSubagentSpan({
        ...baseOpts,
        invocationKind: 'foreground',
      });
      // NOOP_SPAN has all-zero traceId/spanId per OTel convention.
      expect(span.spanContext().traceId).toBe('0'.repeat(32));
      // No mockSpans entry was created (NOOP returns before tracer.startSpan).
      expect(
        mockSpans.find((s) => s.name === 'qwen-code.subagent'),
      ).toBeUndefined();
      // endSubagentSpan on NOOP_SPAN is a safe no-op.
      endSubagentSpan(span, { status: 'completed' });
    });

    it('error message is truncated via truncateSpanError', () => {
      const span = startSubagentSpan({
        ...baseOpts,
        invocationKind: 'foreground',
      });
      const oversized = 'a'.repeat(2000);
      endSubagentSpan(span, { status: 'failed', error: oversized });

      const record = mockSpans.find((s) => s.name === 'qwen-code.subagent')!;
      const recorded = record.attributes['exception.message'] as string;
      expect(recorded.length).toBeLessThan(oversized.length);
      expect(recorded.endsWith('…[truncated]')).toBe(true);
    });

    it('TTL: fork subagent at 30 min stays alive (4h window)', () => {
      startSubagentSpan({ ...baseOpts, invocationKind: 'fork' });
      const record = mockSpans.find((s) => s.name === 'qwen-code.subagent')!;

      // 31 min — past default TTL, well within fork's 4h.
      runTTLSweepForTesting(Date.now() + 31 * 60 * 1000);
      expect(record.ended).toBe(false);

      // 4h + 1 min — past fork's 4h TTL.
      runTTLSweepForTesting(Date.now() + (4 * 60 + 1) * 60 * 1000);
      expect(record.ended).toBe(true);
      expect(record.attributes['qwen-code.span.ttl_expired']).toBe(true);
      expect(record.attributes['qwen-code.subagent.status']).toBe('aborted');
      expect(record.attributes['qwen-code.subagent.terminate_reason']).toBe(
        'ttl_swept',
      );
      // TTL sweep stamps the subagent-namespaced duration_ms key so
      // dashboards querying that namespace include swept spans (the
      // generic qwen-code.span.duration_ms is asserted above).
      // wenshao @ #4410 DeepSeek 3292560017.
      expect(
        record.attributes['qwen-code.subagent.duration_ms'] as number,
      ).toBeGreaterThan(0);
    });

    it('TTL: background subagent at 30 min stays alive (4h window)', () => {
      // Mirror of the fork test — wenshao @ #4410 DeepSeek 3291876056.
      // Catches the regression where someone trims
      // LONG_TTL_SUBAGENT_KINDS and drops `'background'` silently.
      startSubagentSpan({ ...baseOpts, invocationKind: 'background' });
      const record = mockSpans.find((s) => s.name === 'qwen-code.subagent')!;

      runTTLSweepForTesting(Date.now() + 31 * 60 * 1000);
      expect(record.ended).toBe(false);

      runTTLSweepForTesting(Date.now() + (4 * 60 + 1) * 60 * 1000);
      expect(record.ended).toBe(true);
      expect(record.attributes['qwen-code.subagent.status']).toBe('aborted');
      expect(record.attributes['qwen-code.subagent.terminate_reason']).toBe(
        'ttl_swept',
      );
    });

    it('TTL: foreground subagent at 31 min IS swept (default 30 min TTL)', () => {
      const span = startSubagentSpan({
        ...baseOpts,
        invocationKind: 'foreground',
      });
      const record = mockSpans.find((s) => s.name === 'qwen-code.subagent')!;

      runTTLSweepForTesting(Date.now() + 31 * 60 * 1000);
      expect(record.ended).toBe(true);
      expect(record.attributes['qwen-code.span.ttl_expired']).toBe(true);

      // Defensive: endSubagentSpan after TTL is a no-op (already ended).
      endSubagentSpan(span, { status: 'completed' });
    });

    describe('child span parenting (#4410 DeepSeek 3290820352)', () => {
      // Regression: foreground subagent's child LLM/tool/hook spans were
      // parenting to the OUTER interaction span instead of the subagent
      // span because `resolveParentContext` always prefers
      // `interactionContext.getStore()` over the active OTel span. The
      // fix introduces `subagentContext` ALS, which child startXSpan
      // calls now check before falling back to interactionContext.
      it('startLLMRequestSpan inside runInSubagentSpanContext parents under the subagent span', async () => {
        const config = createMockConfig();
        startInteractionSpan(config, {
          messageType: 'userQuery',
          promptId: 'prompt-1',
          model: 'test-model',
        });
        const subagentSpan = startSubagentSpan({
          ...baseOpts,
          invocationKind: 'foreground',
        });
        const subagentRecord = mockSpans.find(
          (s) => s.name === 'qwen-code.subagent',
        )!;

        await runInSubagentSpanContext(subagentSpan, async () => {
          startLLMRequestSpan('qwen3-coder-plus', 'prompt-1');
        });

        const llmRecord = mockSpans.find(
          (s) => s.name === 'qwen-code.llm_request',
        );
        expect(llmRecord).toBeDefined();
        // mock trace.setSpan stamps __parentSpan onto the context object.
        const parentSpan = (
          llmRecord!.parentContext as { __parentSpan?: unknown } | undefined
        )?.__parentSpan;
        expect(parentSpan).toBeDefined();
        // The LLM span MUST parent to the subagent span, NOT the
        // interaction span.
        expect(parentSpan).toBe(subagentRecord);
        // Regression guard for the `llm_request.context` tri-state:
        // subagent-parented LLM calls MUST stamp 'subagent' (not
        // 'interaction') so dashboards classify them correctly.
        // wenshao @ #4410 DeepSeek 3293036596.
        expect(llmRecord!.attributes['llm_request.context']).toBe('subagent');
        endSubagentSpan(subagentSpan, { status: 'completed' });
        endInteractionSpan('ok');
      });

      it('startToolSpan inside runInSubagentSpanContext parents under the subagent span', async () => {
        const config = createMockConfig();
        startInteractionSpan(config, {
          messageType: 'userQuery',
          promptId: 'prompt-1',
          model: 'test-model',
        });
        const subagentSpan = startSubagentSpan({
          ...baseOpts,
          invocationKind: 'foreground',
        });
        const subagentRecord = mockSpans.find(
          (s) => s.name === 'qwen-code.subagent',
        )!;

        await runInSubagentSpanContext(subagentSpan, async () => {
          startToolSpan('read_file');
        });

        const toolRecord = mockSpans.find((s) => s.name === 'qwen-code.tool');
        expect(toolRecord).toBeDefined();
        const parentSpan = (
          toolRecord!.parentContext as { __parentSpan?: unknown } | undefined
        )?.__parentSpan;
        expect(parentSpan).toBe(subagentRecord);
        endSubagentSpan(subagentSpan, { status: 'completed' });
        endInteractionSpan('ok');
      });

      it('startHookSpan inside runInSubagentSpanContext (no inner tool) parents under the subagent span', async () => {
        // Regression: startHookSpan reads tool > subagent > interaction.
        // The AGENT tool's own toolContext was leaking into the subagent
        // body and mis-parenting SubagentStart/Stop hooks. Fix at
        // runInSubagentSpanContext clears toolContext for the body's
        // duration. wenshao @ #4410 DeepSeek 3291876051 / 3291876055.
        const config = createMockConfig();
        startInteractionSpan(config, {
          messageType: 'userQuery',
          promptId: 'prompt-1',
          model: 'test-model',
        });
        const subagentSpan = startSubagentSpan({
          ...baseOpts,
          invocationKind: 'foreground',
        });
        const subagentRecord = mockSpans.find(
          (s) => s.name === 'qwen-code.subagent',
        )!;

        await runInSubagentSpanContext(subagentSpan, async () => {
          startHookSpan({
            hookEvent: 'PreToolUse',
            toolName: 'read_file',
          });
        });

        const hookRecord = mockSpans.find((s) => s.name === 'qwen-code.hook');
        expect(hookRecord).toBeDefined();
        const parentSpan = (
          hookRecord!.parentContext as { __parentSpan?: unknown } | undefined
        )?.__parentSpan;
        expect(parentSpan).toBe(subagentRecord);
        endSubagentSpan(subagentSpan, { status: 'completed' });
        endInteractionSpan('ok');
      });

      it('startHookSpan OUTSIDE runInSubagentSpanContext but inside a tool context parents under the tool span (documented bg SubagentStart asymmetry)', async () => {
        // Regression guard for the documented bg-vs-fg SubagentStart
        // parenting asymmetry (see design doc Edge Cases table). The
        // background path fires SubagentStart BEFORE wrapping in
        // runInSubagentSpanContext, so it sees the outer AGENT tool's
        // toolContext and parents to the tool span — not the subagent.
        // If a future refactor changes this (or implements the deferred
        // fix), this test trips. wenshao @ #4410 DeepSeek 3293174101.
        const config = createMockConfig();
        startInteractionSpan(config, {
          messageType: 'userQuery',
          promptId: 'prompt-1',
          model: 'test-model',
        });
        // Simulate the outer AGENT tool context active.
        const agentToolSpan = startToolSpan('agent');
        const agentToolRecord = mockSpans.find(
          (s) => s.name === 'qwen-code.tool',
        )!;
        // Open a subagent span as if a bg invocation will eventually
        // wrap its body. Note we do NOT call runInSubagentSpanContext —
        // mirroring the bg path where SubagentStart fires BEFORE the
        // wrapper.
        const subagentSpan = startSubagentSpan({
          ...baseOpts,
          invocationKind: 'background',
        });

        await runInToolSpanContext(agentToolSpan, async () => {
          // Hook fires here, inside the AGENT tool's toolContext but
          // OUTSIDE runInSubagentSpanContext.
          startHookSpan({
            hookEvent: 'PreToolUse',
            toolName: 'subagent',
          });
        });

        const hookRecord = mockSpans.find((s) => s.name === 'qwen-code.hook');
        expect(hookRecord).toBeDefined();
        const parentSpan = (
          hookRecord!.parentContext as { __parentSpan?: unknown } | undefined
        )?.__parentSpan;
        // Locks in the asymmetry: parent is the AGENT tool, NOT the
        // subagent span (even though the subagent span exists in
        // activeSpans). Documented in design doc Edge Cases.
        expect(parentSpan).toBe(agentToolRecord);
        endSubagentSpan(subagentSpan, { status: 'completed' });
        endToolSpan(agentToolSpan);
        endInteractionSpan('ok');
      });

      it('nested subagent: innermost subagent shadows outer for child parenting', async () => {
        const config = createMockConfig();
        startInteractionSpan(config, {
          messageType: 'userQuery',
          promptId: 'prompt-1',
          model: 'test-model',
        });
        const outerSubagent = startSubagentSpan({
          ...baseOpts,
          agentId: 'outer',
          subagentName: 'outer-agent',
          invocationKind: 'foreground',
        });
        const innerSubagent = startSubagentSpan({
          ...baseOpts,
          agentId: 'inner',
          subagentName: 'inner-agent',
          invocationKind: 'foreground',
        });
        const innerRecord = mockSpans.find(
          (s) =>
            s.name === 'qwen-code.subagent' &&
            s.attributes['qwen-code.subagent.id'] === 'inner',
        )!;

        await runInSubagentSpanContext(outerSubagent, async () => {
          await runInSubagentSpanContext(innerSubagent, async () => {
            startLLMRequestSpan('qwen3-coder-plus', 'prompt-1');
          });
        });

        const llmRecord = mockSpans.find(
          (s) => s.name === 'qwen-code.llm_request',
        );
        const parentSpan = (
          llmRecord!.parentContext as { __parentSpan?: unknown } | undefined
        )?.__parentSpan;
        expect(parentSpan).toBe(innerRecord);
        endSubagentSpan(innerSubagent, { status: 'completed' });
        endSubagentSpan(outerSubagent, { status: 'completed' });
        endInteractionSpan('ok');
      });

      it('after runInSubagentSpanContext exits, child spans go back to interactionContext', async () => {
        const config = createMockConfig();
        startInteractionSpan(config, {
          messageType: 'userQuery',
          promptId: 'prompt-1',
          model: 'test-model',
        });
        const interactionRecord = mockSpans.find(
          (s) => s.name === 'qwen-code.interaction',
        )!;
        const subagentSpan = startSubagentSpan({
          ...baseOpts,
          invocationKind: 'foreground',
        });

        await runInSubagentSpanContext(subagentSpan, async () => {});
        // Now outside the subagent ALS frame.
        startLLMRequestSpan('qwen3-coder-plus', 'prompt-1');

        const llmRecord = mockSpans.find(
          (s) => s.name === 'qwen-code.llm_request',
        );
        const parentSpan = (
          llmRecord!.parentContext as { __parentSpan?: unknown } | undefined
        )?.__parentSpan;
        // Parented under interaction span, NOT subagent (ALS frame exited).
        expect(parentSpan).toBe(interactionRecord);
        endSubagentSpan(subagentSpan, { status: 'completed' });
        endInteractionSpan('ok');
      });
    });
  });
});
