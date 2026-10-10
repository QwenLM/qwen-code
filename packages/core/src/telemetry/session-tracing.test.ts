/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  context as otelContext,
  createContextKey,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  type Span,
} from '@opentelemetry/api';

const mockState = vi.hoisted(() => ({
  sdkInitialized: true,
  // Toggles to force span.setAttributes/setStatus to throw — exercises the
  // try/catch hardening in end*Span helpers (span.end() must still run).
  throwOnSetAttributes: false,
  throwOnSetStatus: false,
  throwOnStartSpan: false,
  // When set, `context.active()` returns a context that carries this fake
  // span and `trace.getSpan()` reports it. Lets tests exercise the
  // active-OTel-span fallback in resolveParentContext (#4212).
  activeOtelSpan: undefined as unknown,
  activeOtelContext: undefined as unknown,
}));

const mockMetrics = vi.hoisted(() => ({
  recordApiRequestBreakdown: vi.fn(),
}));

vi.mock('./sdk.js', () => ({
  isTelemetrySdkInitialized: () => mockState.sdkInitialized,
}));

vi.mock('./metrics.js', () => ({
  recordApiRequestBreakdown: mockMetrics.recordApiRequestBreakdown,
  ApiRequestPhase: {
    REQUEST_PREPARATION: 'request_preparation',
    NETWORK_LATENCY: 'network_latency',
    RESPONSE_PROCESSING: 'response_processing',
    TOKEN_PROCESSING: 'token_processing',
  },
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

  function createMockContext(
    properties: Record<string, unknown> = {},
    values: Map<unknown, unknown> = new Map(),
    inheritedContext?: { getValue: (key: unknown) => unknown },
  ) {
    const mockContext = {
      ...properties,
      getValue: (key: unknown) =>
        values.has(key) ? values.get(key) : inheritedContext?.getValue(key),
      setValue: (key: unknown, value: unknown) => {
        const nextValues = new Map(values);
        nextValues.set(key, value);
        return createMockContext(properties, nextValues, inheritedContext);
      },
      deleteValue: (key: unknown) => {
        const nextValues = new Map(values);
        nextValues.delete(key);
        return createMockContext(properties, nextValues, inheritedContext);
      },
    };
    Object.defineProperty(mockContext, '__contextValues', { value: values });
    return mockContext;
  }

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
    ) => {
      if (mockState.throwOnStartSpan) {
        throw new Error('startSpan failed');
      }
      return createMockSpan(name, opts, parentCtx);
    },
  };

  return {
    ...actual,
    SpanKind: actual.SpanKind,
    SpanStatusCode: actual.SpanStatusCode,
    trace: {
      getTracer: () => mockTracer,
      setSpan: (ctx: unknown, _span: unknown) =>
        createMockContext(
          {
            ...(ctx as object),
            __parentSpan: _span,
          },
          typeof ctx === 'object' && ctx !== null && '__contextValues' in ctx
            ? ((ctx as { __contextValues: Map<unknown, unknown> })
                .__contextValues as Map<unknown, unknown>)
            : new Map(),
          typeof ctx === 'object' &&
            ctx !== null &&
            'getValue' in ctx &&
            typeof ctx.getValue === 'function'
            ? (ctx as { getValue: (key: unknown) => unknown })
            : undefined,
        ),
      getSpan: (ctx: unknown) =>
        typeof ctx === 'object' && ctx !== null
          ? '__parentSpan' in ctx
            ? (ctx as { __parentSpan: unknown }).__parentSpan
            : '__activeSpan' in ctx
              ? (ctx as { __activeSpan: unknown }).__activeSpan
              : undefined
          : undefined,
      wrapSpanContext: actual.trace.wrapSpanContext,
    },
    context: {
      active: () => {
        if (mockState.activeOtelContext) return mockState.activeOtelContext;
        return mockState.activeOtelSpan
          ? createMockContext({ __activeSpan: mockState.activeOtelSpan })
          : createMockContext();
      },
      with: <T>(_ctx: unknown, fn: () => T): T => fn(),
    },
  };
});

import type { Config } from '../config/config.js';
import {
  startInteractionSpan,
  endInteractionSpan,
  endAllInteractionSpans,
  withInteractionSpan,
  startLLMRequestSpan,
  startLLMRequestSpanWithContext,
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
  recordInteractionActivity,
  clearSessionTracingForTesting,
  runTTLSweepForTesting,
  truncateSpanError,
  type EndToolExecutionSpanMetadata,
  type LLMRequestMetadata,
  type StartHookSpanOptions,
  type StartInteractionOptions,
  type StartSubagentSpanOptions,
} from './session-tracing.js';
import {
  getSessionIdFromContext,
  setSessionContext,
  setSessionIdOnContext,
} from './session-context.js';
import {
  configureContextUsageAttributeLengthLimit,
  CONTEXT_USAGE_ATTRIBUTE,
  type ContextUsageV1,
} from './context-usage.js';
import { sessionIdContext } from '../utils/sessionIdContext.js';

function createMockConfig(
  overrides: Partial<{
    sessionId: string;
    approvalMode: string;
    userId: string;
    jsonSchema: Record<string, unknown>;
  }> = {},
): Config {
  return {
    getSessionId: () => overrides.sessionId ?? 'test-session-id',
    getApprovalMode: () => overrides.approvalMode ?? 'suggest',
    getTelemetryUserId: () => overrides.userId,
    getJsonSchema: () => overrides.jsonSchema,
  } as unknown as Config;
}

const MIN = 60 * 1000;

type InteractionOverrides = Partial<Omit<StartInteractionOptions, 'promptId'>> &
  Parameters<typeof createMockConfig>[0];

/** startInteractionSpan (model 'm', messageType 'userQuery') on a mock config. */
function startInteraction(
  promptId: string,
  {
    model = 'm',
    messageType = 'userQuery',
    ...configOverrides
  }: InteractionOverrides = {},
): void {
  startInteractionSpan(createMockConfig(configOverrides), {
    promptId,
    model,
    messageType,
  });
}

/** The first span named `qwen-code.<suffix>`. */
const rec = (suffix: string) =>
  mockSpans.find((s) => s.name === `qwen-code.${suffix}`);

/** Attribute `key` of the first span named `qwen-code.<suffix>`. */
const attrOf = (suffix: string, key: string) => rec(suffix)?.attributes[key];

/** The first span whose attribute `key` equals `value`. */
const byAttr = (key: string, value: unknown) =>
  mockSpans.find((s) => s.attributes[key] === value);

/** The span the mock `trace.setSpan` tagged onto a record's parent context. */
const parentOf = (record: MockSpanRecord | undefined) =>
  (record?.parentContext as { __parentSpan?: unknown } | undefined)
    ?.__parentSpan;

/** startToolSpan attributed to `promptId` (no description). */
const toolForPrompt = (
  promptId: string,
  name: string,
  attrs?: Parameters<typeof startToolSpan>[1],
) => startToolSpan(name, attrs, undefined, promptId);

/** Runs a TTL sweep `minutes` after now. */
const sweepAfter = (minutes: number) =>
  runTTLSweepForTesting(Date.now() + minutes * MIN);

/** Starts and ends one LLM request span; returns its record. */
function runLLM(
  meta?: LLMRequestMetadata,
  model = 'm',
  promptId = 'p',
): MockSpanRecord {
  endLLMRequestSpan(startLLMRequestSpan(model, promptId), meta);
  return mockSpans.at(-1)!;
}

/** One `toEqual` per key; an `undefined` value asserts the key is unset. */
function expectAttrs(
  attrs: Record<string, unknown>,
  expected: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(expected)) {
    expect(attrs[key]).toEqual(value);
  }
}

/** First status is ERROR with `message`; `errorType` also checks error.type. */
function expectErrorStatus(
  record: MockSpanRecord | undefined,
  message: string,
  errorType?: string,
): void {
  expect(record?.statuses[0]?.code).toBe(SpanStatusCode.ERROR);
  expect(record?.statuses[0]?.message).toBe(message);
  if (errorType !== undefined) {
    expect(record?.attributes['error.type']).toBe(errorType);
  }
}

describe('session-tracing', () => {
  beforeEach(() => {
    clearSessionTracingForTesting();
    setSessionContext(undefined);
    mockSpans.length = 0;
    mockState.sdkInitialized = true;
    mockState.throwOnSetAttributes = false;
    mockState.throwOnSetStatus = false;
    mockState.throwOnStartSpan = false;
    mockState.activeOtelSpan = undefined;
    mockState.activeOtelContext = undefined;
  });

  afterEach(() => {
    configureContextUsageAttributeLengthLimit(undefined);
    vi.restoreAllMocks();
  });

  describe('interaction spans', () => {
    it('starts and ends a main agent interaction with UNSET status', () => {
      startInteraction('prompt-1', { userId: 'user-1', model: 'test-model' });

      expect(mockSpans).toHaveLength(1);
      const record = mockSpans[0]!;
      expect(record.name).toBe('qwen-code.interaction');
      expectAttrs(record.attributes, {
        'session.id': 'test-session-id',
        'gen_ai.user.id': 'user-1',
        'qwen-code.prompt_id': 'prompt-1',
        'qwen-code.model': 'test-model',
        'gen_ai.request.model': undefined,
        'gen_ai.provider.name': undefined,
        'gen_ai.agent.id': undefined,
        'gen_ai.agent.version': undefined,
        'gen_ai.agent.description': undefined,
      });
      expect(record.attributes).toMatchObject({
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.agent.name': 'qwen-code',
        'gen_ai.conversation.id': 'test-session-id',
      });

      endInteractionSpan('ok');

      expect(record.ended).toBe(true);
      expect(record.statuses).toHaveLength(0);
    });

    it('defaults to ROOT_CONTEXT when no parentContext is provided', async () => {
      await withInteractionSpan(
        createMockConfig({ sessionId: 's' }),
        { promptId: 'p', model: 'm', messageType: 'cron' },
        async () => {},
      );

      expect(rec('interaction')?.parentContext).toBe(ROOT_CONTEXT);
    });

    it('runs scoped interaction spans without mutating the global interaction context', async () => {
      const contextWithSpy = vi.spyOn(otelContext, 'with');
      const config = createMockConfig({
        sessionId: 'scoped-session',
        userId: 'scoped-user',
        jsonSchema: { type: 'object' },
      });
      const parentContext = ROOT_CONTEXT.setValue(
        createContextKey('daemon-parent'),
        'daemon',
      );
      const result = await withInteractionSpan(
        config,
        {
          promptId: 'prompt-scoped',
          model: 'test-model',
          messageType: 'acp_prompt',
          parentContext,
        },
        async () => 'done',
      );

      expect(result).toBe('done');
      expect(mockSpans).toHaveLength(1);
      const record = mockSpans[0]!;
      expect(record.name).toBe('qwen-code.interaction');
      expect(record.parentContext).toBe(parentContext);
      expectAttrs(record.attributes, {
        'session.id': 'scoped-session',
        'gen_ai.user.id': 'scoped-user',
        'qwen-code.message_type': 'acp_prompt',
      });
      expect(record.attributes).toMatchObject({
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.agent.name': 'qwen-code',
        'gen_ai.conversation.id': 'scoped-session',
        'gen_ai.output.type': 'json',
      });
      expect(record.ended).toBe(true);
      expect(record.statuses).toHaveLength(0);
      expect(getSessionIdFromContext(contextWithSpy.mock.calls[0]![0])).toBe(
        'scoped-session',
      );
    });

    it('marks the interaction span ERROR when getResultStatus returns "error"', async () => {
      await withInteractionSpan(
        createMockConfig(),
        { promptId: 'p-cron-err', model: 'm', messageType: 'cron' },
        async () => 'done',
        () => 'error',
      );

      const span = rec('interaction');
      expect(span?.attributes['qwen-code.turn_status']).toBe('error');
      expect(span?.statuses.at(-1)?.code).toBe(SpanStatusCode.ERROR);
      expect(span?.attributes['error.type']).toBe('interaction_error');
    });

    it('keeps a thrown error message instead of the generic error-status message', async () => {
      await expect(
        withInteractionSpan(
          createMockConfig(),
          { promptId: 'p-throw', model: 'm', messageType: 'cron' },
          async () => {
            throw new Error('boom from fn');
          },
        ),
      ).rejects.toThrow('boom from fn');

      const span = rec('interaction');
      expect(span?.statuses.at(-1)?.code).toBe(SpanStatusCode.ERROR);
      expect(span?.statuses.at(-1)?.message).toBe('boom from fn');
      expect(span?.attributes['error.type']).toBe('Error');
    });

    it('ends interaction span with error status', () => {
      startInteraction('prompt-2');
      endInteractionSpan('error', {
        errorMessage: 'something went wrong',
        errorType: 'api_error',
      });

      expectErrorStatus(mockSpans[0], 'something went wrong', 'api_error');
    });

    it('ends a cancelled interaction with UNSET status', () => {
      startInteraction('prompt-3');
      endInteractionSpan('cancelled');

      expect(mockSpans[0]!.statuses).toHaveLength(0);
    });

    it('is idempotent — ending twice does not double-end', () => {
      startInteraction('prompt-4');
      endInteractionSpan('ok');
      endInteractionSpan('error');

      expect(mockSpans[0]!.statuses).toHaveLength(0);
    });

    it('no-ops when SDK is not initialized', () => {
      mockState.sdkInitialized = false;
      startInteraction('prompt-5');

      expect(mockSpans).toHaveLength(0);
      endInteractionSpan('ok'); // must be safe to call
    });

    it('increments interaction sequence', () => {
      startInteraction('prompt-a');
      endInteractionSpan('ok');
      startInteraction('prompt-b');

      expect(mockSpans[1]!.attributes['interaction.sequence']).toBe(2);
    });

    it('records duration_ms and turn_status on end', () => {
      startInteraction('prompt-dur');
      endInteractionSpan('ok');

      const setAttrs = mockSpans[0]!.setAttributesCalls[0]!;
      expect(setAttrs).toHaveProperty('interaction.duration_ms');
      expect(setAttrs['qwen-code.turn_status']).toBe('ok');
    });

    it('sets json output type only when a JSON schema is configured', () => {
      startInteraction('plain-json-output');
      expect(mockSpans[0]!.attributes['gen_ai.output.type']).toBeUndefined();
      endInteractionSpan('ok', { promptId: 'plain-json-output' });

      startInteraction('schema-output', { jsonSchema: { type: 'object' } });
      expect(mockSpans[1]!.attributes['gen_ai.output.type']).toBe('json');
    });

    it.each(['cron', 'notification', 'teammate', 'goal'])(
      'does not assign the session JSON contract to %s interactions',
      (messageType) => {
        startInteraction(`automatic-${messageType}`, {
          jsonSchema: { type: 'object' },
          messageType,
        });

        expect(
          mockSpans.at(-1)!.attributes['gen_ai.output.type'],
        ).toBeUndefined();
        endInteractionSpan('ok', { promptId: `automatic-${messageType}` });
      },
    );

    it('isolates concurrent prompts and ends only the requested interaction', () => {
      startInteraction('prompt-a');
      startInteraction('prompt-b', { messageType: 'notification' });

      expect(getActiveInteractionSpan('prompt-a')).toBe(mockSpans[0]);
      expect(getActiveInteractionSpan('prompt-b')).toBe(mockSpans[1]);
      endInteractionSpan('ok', { promptId: 'prompt-a' });

      expect(mockSpans[0]!.ended).toBe(true);
      expect(mockSpans[1]!.ended).toBe(false);
      expect(getActiveInteractionSpan('prompt-a')).toBeUndefined();
      expect(getActiveInteractionSpan('prompt-b')).toBe(mockSpans[1]);
    });

    it('keeps a mismatched prompt standalone inside an ACP interaction context', async () => {
      await withInteractionSpan(
        createMockConfig(),
        { promptId: 'owner-prompt', model: 'm', messageType: 'acp_prompt' },
        async () => {
          mockState.activeOtelSpan = mockSpans[0];
          const llm = startLLMRequestSpan('m', 'wrong-prompt');
          const tool = toolForPrompt('wrong-prompt', 'ReadFile');

          expect(rec('llm_request')?.parentContext).toBe(ROOT_CONTEXT);
          expect(attrOf('llm_request', 'llm_request.context')).toBe(
            'standalone',
          );
          expect(rec('tool')?.parentContext).toBe(ROOT_CONTEXT);
          expect(attrOf('tool', 'gen_ai.agent.name')).toBeUndefined();

          endLLMRequestSpan(llm, { success: true });
          endToolSpan(tool, { success: true });
        },
      );
    });

    it('does not silently overwrite an unfinished interaction with the same prompt id', () => {
      startInteraction('same-prompt');
      startInteraction('same-prompt', { messageType: 'retry' });

      expect(mockSpans[0]!.ended).toBe(true);
      expect(mockSpans[0]!.attributes['qwen-code.turn_status']).toBe(
        'cancelled',
      );
      expect(getActiveInteractionSpan('same-prompt')).toBe(mockSpans[1]);
    });

    it('ends every registered interaction during shutdown', () => {
      startInteraction('p1');
      startInteraction('p2', { messageType: 'notification' });

      endAllInteractionSpans();

      expect(mockSpans.every((span) => span.ended)).toBe(true);
      expect(getActiveInteractionSpan('p1')).toBeUndefined();
      expect(getActiveInteractionSpan('p2')).toBeUndefined();
    });
  });

  describe('interaction span — per-prompt traceId', () => {
    it('uses ROOT_CONTEXT as parent (each interaction is a trace root)', () => {
      setSessionContext(undefined, 'test-session');
      startInteraction('p', { sessionId: 'test-session' });

      expect(rec('interaction')?.parentContext).toBe(ROOT_CONTEXT);
    });

    it('ignores active OTel span — interaction always starts a new trace', () => {
      mockState.activeOtelSpan = { name: 'unrelated-wrapper-span' };
      startInteraction('p', { sessionId: 'test-session' });

      expect(rec('interaction')?.parentContext).toBe(ROOT_CONTEXT);
    });

    it('still stamps session.id attribute for cross-prompt correlation', () => {
      startInteraction('p', { sessionId: 'my-session' });

      expect(attrOf('interaction', 'session.id')).toBe('my-session');
    });
  });

  describe('LLM request spans', () => {
    const contextUsage: ContextUsageV1 = {
      version: 1,
      window_size_tokens: 100,
      breakdown: {
        system_prompt_tokens: 1,
        builtin_tools_tokens: 1,
        mcp_tools_tokens: 1,
        memory_files_tokens: 1,
        skills_tokens: 1,
        messages_tokens: 10,
      },
      compaction_reserve_tokens: 20,
      estimated: true,
    };
    const usageOf = (record: MockSpanRecord) =>
      JSON.parse(
        String(record.attributes[CONTEXT_USAGE_ATTRIBUTE]),
      ) as ContextUsageV1;

    it('preserves the no-op span context when telemetry is disabled', () => {
      mockState.sdkInitialized = false;

      const { span, context } = startLLMRequestSpanWithContext('m', 'p', {
        sessionId: 'owner-session',
      });

      expect(trace.getSpan(context)).toBe(span);
    });

    it('writes the initial context snapshot and normalizes it at span end', () => {
      const { span } = startLLMRequestSpanWithContext('m', 'p', {
        contextUsage,
      });
      const record = mockSpans[0]!;

      expect(usageOf(record)).toEqual(contextUsage);

      endLLMRequestSpan(span, { success: true, inputTokens: 3 });

      const normalized = usageOf(record);
      expect(record.attributes['gen_ai.usage.input_tokens']).toBe(3);
      expect(normalized.breakdown).toEqual({
        system_prompt_tokens: 1,
        builtin_tools_tokens: 1,
        mcp_tools_tokens: 1,
        memory_files_tokens: 0,
        skills_tokens: 0,
        messages_tokens: 0,
      });
      expect(normalized.available_before_compaction_tokens).toBe(77);
    });

    it('omits a request-start snapshot above the effective OTel limit', () => {
      configureContextUsageAttributeLengthLimit(1);

      const { span } = startLLMRequestSpanWithContext('m', 'p', {
        contextUsage,
      });
      endLLMRequestSpan(span, { success: true, inputTokens: 3 });

      expect(mockSpans[0]!.attributes).not.toHaveProperty(
        CONTEXT_USAGE_ATTRIBUTE,
      );
    });

    it('omits the start value when a normalized value could exceed the limit', () => {
      configureContextUsageAttributeLengthLimit(
        JSON.stringify(contextUsage).length,
      );

      const { span } = startLLMRequestSpanWithContext('m', 'p', {
        contextUsage,
      });
      const record = mockSpans[0]!;
      expect(record.attributes).not.toHaveProperty(CONTEXT_USAGE_ATTRIBUTE);

      endLLMRequestSpan(span, { success: true, inputTokens: 3 });

      expect(record.attributes).not.toHaveProperty(CONTEXT_USAGE_ATTRIBUTE);
    });

    it('owns the request-start snapshot across caller mutations', () => {
      const mutableContextUsage = structuredClone(contextUsage);
      const { span } = startLLMRequestSpanWithContext('m', 'p', {
        contextUsage: mutableContextUsage,
      });

      mutableContextUsage.window_size_tokens = 1_000;
      mutableContextUsage.breakdown.system_prompt_tokens = 50;
      endLLMRequestSpan(span, { success: true, inputTokens: 10 });

      const normalized = usageOf(mockSpans[0]!);
      expect(normalized.window_size_tokens).toBe(100);
      expect(normalized.breakdown.system_prompt_tokens).toBe(1);
      expect(normalized.available_before_compaction_tokens).toBe(70);
    });

    it('keeps the request-start context snapshot on TTL cleanup', () => {
      startLLMRequestSpanWithContext('m', 'p', { contextUsage });
      const record = mockSpans[0]!;
      const initial = record.attributes[CONTEXT_USAGE_ATTRIBUTE];

      sweepAfter(31);

      expect(record.ended).toBe(true);
      expect(record.attributes[CONTEXT_USAGE_ATTRIBUTE]).toBe(initial);
    });

    it('creates and ends an LLM request span', () => {
      const span = startLLMRequestSpan('test-model', 'prompt-llm');

      expect(mockSpans).toHaveLength(1);
      const record = mockSpans[0]!;
      expect(record.name).toBe('qwen-code.llm_request');
      expectAttrs(record.attributes, {
        'gen_ai.request.model': 'test-model',
        'qwen-code.model': undefined,
      });

      endLLMRequestSpan(span, {
        success: true,
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 500,
      });

      expect(record.ended).toBe(true);
      expect(record.statuses).toHaveLength(0);
    });

    it('records error status on failure', () => {
      const record = runLLM({ success: false, error: 'rate limited' });
      expectErrorStatus(record, 'rate limited');
    });

    it('keeps a cancelled LLM request UNSET without error.type', () => {
      const record = runLLM({
        success: false,
        cancelled: true,
        error: 'API call aborted',
        errorType: 'AbortError',
      });

      expect(record.statuses).toHaveLength(0);
      expectAttrs(record.attributes, {
        success: false,
        error: 'API call aborted',
        'error.type': undefined,
      });
    });

    it('parents under interaction span when one is active', () => {
      startInteraction('p');
      const llm = runLLM({ success: true });
      endInteractionSpan('ok');

      expect(llm.parentContext).toBeDefined();
      expect(llm.attributes['llm_request.context']).toBe('interaction');
    });

    it('marks standalone when no interaction is active', () => {
      const llm = runLLM({ success: true });
      expect(llm.attributes['llm_request.context']).toBe('standalone');
    });

    it('uses the owning config identity instead of a stale global session', () => {
      setSessionContext(undefined, 'bootstrap-session');

      const { span, context } = startLLMRequestSpanWithContext('m', 'p', {
        sessionId: 'owner-session',
        userId: 'owner-user',
      });

      expect(mockSpans[0]!.attributes).toMatchObject({
        'session.id': 'owner-session',
        'gen_ai.conversation.id': 'owner-session',
        'gen_ai.user.id': 'owner-user',
      });
      expect(getSessionIdFromContext(context)).toBe('owner-session');
      endLLMRequestSpan(span, { success: true });
    });

    it('keeps the logical parent identity ahead of an explicit owner', () => {
      startInteraction('p', {
        sessionId: 'parent-session',
        userId: 'parent-user',
      });

      const { span, context } = startLLMRequestSpanWithContext('m', 'p', {
        sessionId: 'different-owner',
        userId: 'different-user',
      });

      expectAttrs(rec('llm_request')!.attributes, {
        'session.id': 'parent-session',
        'gen_ai.conversation.id': 'parent-session',
        'gen_ai.user.id': 'parent-user',
      });
      expect(getSessionIdFromContext(context)).toBe('parent-session');
      endLLMRequestSpan(span, { success: true });
      endInteractionSpan('ok');
    });

    it('keeps the logical tool identity ahead of an explicit owner', () => {
      const contextWithSpy = vi.spyOn(otelContext, 'with');
      startInteraction('p', {
        sessionId: 'parent-session',
        userId: 'parent-user',
      });
      const toolSpan = startToolSpan('agent');

      runInToolSpanContext(toolSpan, () => {
        const { span, context } = startLLMRequestSpanWithContext('m', 'p', {
          sessionId: 'different-owner',
          userId: 'different-user',
        });
        const record = rec('llm_request');
        expect(record?.attributes['session.id']).toBe('parent-session');
        expect(record?.attributes['gen_ai.user.id']).toBe('parent-user');
        expect(trace.getSpan(record?.parentContext as never)).toBe(toolSpan);
        expect(getSessionIdFromContext(context)).toBe('parent-session');
        endLLMRequestSpan(span, { success: true });
      });

      endToolSpan(toolSpan, { success: true });
      endInteractionSpan('ok');
      expect(getSessionIdFromContext(contextWithSpy.mock.calls[0]![0])).toBe(
        'parent-session',
      );
    });

    it('uses the per-request session context before the global fallback', () => {
      setSessionContext(undefined, 'bootstrap-session');

      const span = sessionIdContext.run('request-session', () =>
        startLLMRequestSpan('m', 'p'),
      );

      expect(mockSpans[0]!.attributes['session.id']).toBe('request-session');
      endLLMRequestSpan(span, { success: true });
    });

    it('uses the scoped OTel session before per-request and global fallbacks', () => {
      setSessionContext(undefined, 'bootstrap-session');
      mockState.activeOtelContext = setSessionIdOnContext(
        ROOT_CONTEXT,
        'otel-session',
      );

      const span = sessionIdContext.run('request-session', () =>
        startLLMRequestSpan('m', 'p'),
      );

      expect(mockSpans[0]!.attributes['session.id']).toBe('otel-session');
      endLLMRequestSpan(span, { success: true });
    });

    it('keeps standalone owner contexts isolated', async () => {
      setSessionContext(undefined, 'bootstrap-session');

      const sessionIds = ['session-A', 'session-B'];
      const started = await Promise.all(
        sessionIds.map(async (sessionId) =>
          startLLMRequestSpanWithContext('m', `prompt-${sessionId}`, {
            sessionId,
          }),
        ),
      );

      for (const [index, sessionId] of sessionIds.entries()) {
        const record = byAttr('qwen-code.prompt_id', `prompt-${sessionId}`);
        expect(record?.attributes['session.id']).toBe(sessionId);
        expect(record?.attributes['gen_ai.conversation.id']).toBe(sessionId);
        expect(getSessionIdFromContext(started[index]!.context)).toBe(
          sessionId,
        );
      }
      for (const { span } of started) {
        endLLMRequestSpan(span, { success: true });
      }
    });

    it('LLM request span re-parents to active OTel span when no interaction is set (#4212)', () => {
      // A side-query LLM call inside another OTel span (e.g. HTTP-instrumented,
      // in a subagent path) must attach to it, not skip back to the session
      // root, or the trace tree flattens.
      const fakeActive = { kind: 'fake-active-span' };
      mockState.activeOtelSpan = fakeActive;

      const llm = runLLM({ success: true });

      expect(llm.parentContext).toMatchObject({ __activeSpan: fakeActive });
      // Still standalone: the OTel parent comes from instrumentation, not
      // from interactionContext.
      expect(llm.attributes['llm_request.context']).toBe('standalone');
    });

    it('treats missing metadata as UNSET status', () => {
      const record = runLLM();

      expect(record.ended).toBe(true);
      expect(record.statuses).toHaveLength(0);
    });

    it('returns NOOP span when SDK is not initialized', () => {
      mockState.sdkInitialized = false;
      const span = startLLMRequestSpan('m', 'p');
      expect(span.spanContext().traceId).toBe('0'.repeat(32));
      expect(span.spanContext().spanId).toBe('0'.repeat(16));

      endLLMRequestSpan(span, { success: true }); // must be safe on a NOOP span
    });
  });

  describe('LLM request spans — GenAI attributes and timing decomposition', () => {
    it('uses only gen_ai.request.model on LLM spans', () => {
      expectAttrs(runLLM({ success: true }, 'test-model').attributes, {
        'gen_ai.request.model': 'test-model',
        'qwen-code.model': undefined,
      });
    });

    it('writes operation, provider, conversation, and output type at span creation', () => {
      setSessionContext({} as never, 'conversation-1');
      const span = startLLMRequestSpan('test-model', 'p', {
        operationName: 'generate_content',
        providerName: 'gcp.gemini',
        outputType: 'json',
      });
      endLLMRequestSpan(span, { success: true });

      expect(mockSpans[0]!.attributes).toMatchObject({
        'session.id': 'conversation-1',
        'gen_ai.conversation.id': 'conversation-1',
        'gen_ai.operation.name': 'generate_content',
        'gen_ai.provider.name': 'gcp.gemini',
        'gen_ai.output.type': 'json',
      });
    });

    it('emits only standard input and output token attributes', () => {
      const llm = runLLM({ success: true, inputTokens: 100, outputTokens: 50 });
      expectAttrs(llm.attributes, {
        'gen_ai.usage.input_tokens': 100,
        'gen_ai.usage.output_tokens': 50,
        input_tokens: undefined,
        output_tokens: undefined,
      });
    });

    it('emits standard cache-read tokens only when the provider reported them', () => {
      const llm = runLLM({
        success: true,
        inputTokens: 100,
        cachedInputTokens: 40,
        cachedInputTokensReported: true,
      });
      expectAttrs(llm.attributes, {
        'gen_ai.usage.cache_read.input_tokens': 40,
        cached_input_tokens: undefined,
        'gen_ai.usage.cached_tokens': undefined,
      });
    });

    it('omits cache-read tokens when the provider did not report them', () => {
      expectAttrs(runLLM({ success: true, inputTokens: 100 }).attributes, {
        cached_input_tokens: undefined,
        'gen_ai.usage.cached_tokens': undefined,
        'gen_ai.usage.cache_read.input_tokens': undefined,
      });
    });

    it('emits an explicit standard cache-read zero', () => {
      // A reported 0 is an explicit cache miss, distinct from undefined
      // ("we don't know").
      const llm = runLLM({
        success: true,
        inputTokens: 100,
        cachedInputTokens: 0,
        cachedInputTokensReported: true,
      });
      expectAttrs(llm.attributes, {
        'gen_ai.usage.cache_read.input_tokens': 0,
        cached_input_tokens: undefined,
        'gen_ai.usage.cached_tokens': undefined,
      });
    });

    it('keeps private ttft_ms and derives sampling_ms without the incompatible GenAI alias', () => {
      const llm = runLLM({ success: true, ttftMs: 234, durationMs: 1000 });
      expectAttrs(llm.attributes, {
        ttft_ms: 234,
        sampling_ms: 766,
        'gen_ai.server.time_to_first_token': undefined,
      });
    });

    it('omits invalid token counts', () => {
      const llm = runLLM({ success: true, inputTokens: -1, outputTokens: 1.5 });
      expectAttrs(llm.attributes, {
        'gen_ai.usage.input_tokens': undefined,
        'gen_ai.usage.output_tokens': undefined,
        input_tokens: undefined,
        output_tokens: undefined,
      });
    });

    it('retains explicit zero and cache-creation counts in standard usage', () => {
      const llm = runLLM({
        success: true,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
      });
      expect(llm.attributes).toMatchObject({
        'gen_ai.usage.input_tokens': 0,
        'gen_ai.usage.output_tokens': 0,
        'gen_ai.usage.cache_creation.input_tokens': 0,
      });
    });

    it('endLLMRequestSpan omits ttft_ms when undefined (non-streaming or aborted before first chunk)', () => {
      expectAttrs(runLLM({ success: true, durationMs: 500 }).attributes, {
        ttft_ms: undefined,
        'gen_ai.server.time_to_first_token': undefined,
        sampling_ms: undefined,
        output_tokens_per_second: undefined,
      });
    });

    it('endLLMRequestSpan derives sampling_ms when ttftMs is set (no requestSetup)', () => {
      const llm = runLLM({ success: true, ttftMs: 200, durationMs: 1000 });
      // duration - ttft; setup is NOT subtracted because duration_ms only
      // covers ttft + sampling, never the setup phase before the span (see
      // the Phase 4b formula fix).
      expect(llm.attributes['sampling_ms']).toBe(800);
    });

    it('endLLMRequestSpan does NOT subtract requestSetupMs from sampling_ms (Phase 4b bug fix)', () => {
      // Phase 4a's `duration - ttft - setup` double-counted setup: the span
      // starts after setup. Phase 4b fills requestSetupMs with cumulative
      // retry overhead, so the old formula would clamp sampling_ms to 0 on
      // every retried request and wipe output-throughput data.
      const llm = runLLM({
        success: true,
        ttftMs: 200,
        requestSetupMs: 300, // would yield 500 under old formula; we want 800
        durationMs: 1000,
      });

      expect(llm.attributes['sampling_ms']).toBe(800);
      // request_setup_ms stays its own attribute, so retry overhead and
      // sampling time are visible independently.
      expect(llm.attributes['request_setup_ms']).toBe(300);
    });

    it('endLLMRequestSpan clamps sampling_ms to 0 when ttft exceeds duration (clock skew)', () => {
      const llm = runLLM({ success: true, ttftMs: 1500, durationMs: 1000 });
      // Math.max(0, 1000 - 1500): only when ttft > duration, i.e. clock
      // drift or a measurement bug.
      expect(llm.attributes['sampling_ms']).toBe(0);
    });

    it('endLLMRequestSpan derives output_tokens_per_second from sampling_ms + outputTokens', () => {
      const llm = runLLM({
        success: true,
        ttftMs: 200,
        durationMs: 1200,
        outputTokens: 500,
      });
      // sampling_ms = 1000ms = 1s; otps = 500 / 1.0 = 500
      expectAttrs(llm.attributes, {
        sampling_ms: 1000,
        output_tokens_per_second: 500,
      });
    });

    it('endLLMRequestSpan rounds output_tokens_per_second to 2 decimals', () => {
      const llm = runLLM({
        success: true,
        ttftMs: 200,
        durationMs: 1325, // sampling_ms = 1125
        outputTokens: 100, // otps = 100 / 1.125 = 88.888…
      });
      expect(llm.attributes['output_tokens_per_second']).toBe(88.89);
    });

    it('endLLMRequestSpan omits output_tokens_per_second when sampling_ms == 0', () => {
      const llm = runLLM({
        success: true,
        ttftMs: 1000,
        durationMs: 1000,
        outputTokens: 50,
      });
      // sampling_ms = 0 → otps would be Infinity, must be omitted
      expectAttrs(llm.attributes, {
        sampling_ms: 0,
        output_tokens_per_second: undefined,
      });
    });

    it('endLLMRequestSpan omits output_tokens_per_second when outputTokens missing', () => {
      const llm = runLLM({ success: true, ttftMs: 200, durationMs: 1000 });
      expect(llm.attributes['output_tokens_per_second']).toBeUndefined();
    });

    it('endLLMRequestSpan writes Phase 4b retry placeholders when caller provides them', () => {
      const llm = runLLM({
        success: true,
        attempt: 3,
        requestSetupMs: 4500,
        retryTotalDelayMs: 4200,
        durationMs: 5000,
      });
      expectAttrs(llm.attributes, {
        attempt: 3,
        request_setup_ms: 4500,
        retry_total_delay_ms: 4200,
      });
    });

    it('endLLMRequestSpan omits Phase 4b fields when caller does not provide them (Phase 4a default)', () => {
      expectAttrs(runLLM({ success: true, durationMs: 500 }).attributes, {
        attempt: undefined,
        request_setup_ms: undefined,
        retry_total_delay_ms: undefined,
      });
    });
  });

  describe('LLM request spans — response metadata & error enrichment', () => {
    it('uses only gen_ai.response.id on LLM spans', () => {
      const llm = runLLM({ success: true, responseId: 'chatcmpl-abc123' });
      expectAttrs(llm.attributes, {
        'gen_ai.response.id': 'chatcmpl-abc123',
        response_id: undefined,
      });
    });

    it('omits response identifiers when undefined', () => {
      expectAttrs(runLLM({ success: true }).attributes, {
        response_id: undefined,
        'gen_ai.response.id': undefined,
      });
    });

    it('endLLMRequestSpan dual-emits finish_reason / gen_ai.response.finish_reasons (string vs array)', () => {
      const llm = runLLM({ success: true, finishReason: 'STOP' });
      expectAttrs(llm.attributes, {
        finish_reason: 'STOP',
        'gen_ai.response.finish_reasons': ['STOP'],
      });
    });

    it('emits actual response model and all ordered finish reasons', () => {
      const llm = runLLM(
        {
          success: true,
          responseModel: 'provider-model',
          finishReasons: ['STOP', 'MAX_TOKENS'],
        },
        'request-model',
      );
      expectAttrs(llm.attributes, {
        'gen_ai.response.model': 'provider-model',
        finish_reason: 'STOP',
        'gen_ai.response.finish_reasons': ['STOP', 'MAX_TOKENS'],
      });
    });

    it('endLLMRequestSpan omits finish_reason when undefined', () => {
      expectAttrs(runLLM({ success: true }).attributes, {
        finish_reason: undefined,
        'gen_ai.response.finish_reasons': undefined,
      });
    });

    it('keeps private thoughts_token_count without the invalid reasoning alias', () => {
      const llm = runLLM({ success: true, thoughtsTokenCount: 42 });
      expectAttrs(llm.attributes, {
        thoughts_token_count: 42,
        'gen_ai.usage.reasoning_tokens': undefined,
      });
    });

    it('endLLMRequestSpan emits thoughts_token_count === 0 (no reasoning is meaningful info, not undefined)', () => {
      const llm = runLLM({ success: true, thoughtsTokenCount: 0 });
      expectAttrs(llm.attributes, {
        thoughts_token_count: 0,
        'gen_ai.usage.reasoning_tokens': undefined,
      });
    });

    it('endLLMRequestSpan omits thoughts_token_count when undefined', () => {
      expectAttrs(runLLM({ success: true }).attributes, {
        thoughts_token_count: undefined,
        'gen_ai.usage.reasoning_tokens': undefined,
      });
    });

    it('endLLMRequestSpan emits subagent_name when present', () => {
      const llm = runLLM({ success: true, subagentName: 'Explore-abc123' });
      expect(llm.attributes['subagent_name']).toBe('Explore-abc123');
    });

    it('endLLMRequestSpan omits subagent_name when undefined', () => {
      const llm = runLLM({ success: true });
      expect(llm.attributes['subagent_name']).toBeUndefined();
    });

    it('endLLMRequestSpan emits error_type and error.type on error spans', () => {
      const llm = runLLM({
        success: false,
        error: 'API call failed',
        errorType: 'RateLimitError',
        errorStatusCode: 429,
      });
      expectAttrs(llm.attributes, {
        error_type: 'RateLimitError',
        'error.type': 'RateLimitError',
        error_status_code: 429,
      });
    });

    it('endLLMRequestSpan supplies a default error.type for unclassified failures', () => {
      const llm = runLLM({ success: false, error: 'failed' });
      expect(llm.attributes['error.type']).toBe('llm_error');
      expect(llm.statuses[0]?.code).toBe(SpanStatusCode.ERROR);
    });

    it('endLLMRequestSpan omits error_type/error_status_code on success spans', () => {
      expectAttrs(runLLM({ success: true }).attributes, {
        error_type: undefined,
        'error.type': undefined,
        error_status_code: undefined,
      });
    });

    it('endLLMRequestSpan emits all new attributes together', () => {
      const llm = runLLM({
        success: true,
        inputTokens: 500,
        outputTokens: 100,
        responseId: 'resp-xyz',
        finishReason: 'MAX_TOKENS',
        thoughtsTokenCount: 30,
        subagentName: 'code-reviewer',
      });
      expectAttrs(llm.attributes, {
        'gen_ai.response.id': 'resp-xyz',
        response_id: undefined,
        finish_reason: 'MAX_TOKENS',
        'gen_ai.response.finish_reasons': ['MAX_TOKENS'],
        thoughts_token_count: 30,
        'gen_ai.usage.reasoning_tokens': undefined,
        subagent_name: 'code-reviewer',
        'gen_ai.usage.input_tokens': 500,
        'gen_ai.usage.output_tokens': 100,
        input_tokens: undefined,
        output_tokens: undefined,
      });
    });
  });

  describe('LLM request spans — Phase 4c (recordApiRequestBreakdown wiring)', () => {
    const breakdown = mockMetrics.recordApiRequestBreakdown;
    const expectPhase = (config: Config, ms: number, phase: string) =>
      expect(breakdown).toHaveBeenCalledWith(config, ms, {
        model: 'test-model',
        phase,
      });
    const timing = { durationMs: 1000, ttftMs: 200, requestSetupMs: 50 };

    beforeEach(() => {
      breakdown.mockClear();
    });

    it('records all 3 phases when config + ttftMs + requestSetupMs are present', () => {
      const config = createMockConfig();
      runLLM({ success: true, ...timing, config }, 'test-model');

      expect(breakdown).toHaveBeenCalledTimes(3);
      expectPhase(config, 50, 'request_preparation');
      expectPhase(config, 200, 'network_latency');
      expectPhase(config, 800, 'response_processing');
    });

    it('skips metric recording when config is absent', () => {
      runLLM({ success: true, ...timing }, 'test-model');
      expect(breakdown).not.toHaveBeenCalled();
    });

    it('skips metric recording when request failed (success=false)', () => {
      runLLM({ success: false, ...timing, config: createMockConfig() });
      expect(breakdown).not.toHaveBeenCalled();
    });

    it('records only REQUEST_PREPARATION when ttftMs is absent', () => {
      const config = createMockConfig();
      runLLM(
        { success: true, durationMs: 1000, requestSetupMs: 50, config },
        'test-model',
      );

      expect(breakdown).toHaveBeenCalledTimes(1);
      expectPhase(config, 50, 'request_preparation');
    });

    it('skips RESPONSE_PROCESSING when samplingMs is 0 (ttftMs == duration)', () => {
      const config = createMockConfig();
      runLLM({ success: true, durationMs: 500, ttftMs: 500, config });

      const phases = breakdown.mock.calls.map(
        (c: unknown[]) => (c[2] as { phase: string }).phase,
      );
      expect(phases).toContain('network_latency');
      expect(phases).not.toContain('response_processing');
    });

    it('idempotency — second endLLMRequestSpan call does not record again', () => {
      const span = startLLMRequestSpan('test-model', 'p');
      const metadata = { success: true, ...timing, config: createMockConfig() };
      endLLMRequestSpan(span, metadata);
      endLLMRequestSpan(span, metadata);

      // Only first call records (3 phases), second is short-circuited.
      expect(breakdown).toHaveBeenCalledTimes(3);
    });
  });

  describe('tool spans', () => {
    it('returns a NOOP span when telemetry start fails', () => {
      mockState.throwOnStartSpan = true;
      const span = startToolSpan('ReadFile');

      expect(span.spanContext().traceId).toBe('0'.repeat(32));
      expect(mockSpans).toHaveLength(0);
    });

    it('creates and ends a tool span', () => {
      const span = startToolSpan('ReadFile', { 'tool.call_id': 'call-1' });

      expect(mockSpans).toHaveLength(1);
      const record = mockSpans[0]!;
      expect(record.name).toBe('qwen-code.tool');
      expect(record.attributes['tool.call_id']).toBe('call-1');
      expect(record.attributes).toMatchObject({
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.tool.name': 'ReadFile',
        'gen_ai.tool.type': 'function',
      });
      expect(record.attributes['tool.name']).toBeUndefined();

      endToolSpan(span, { success: true });

      expect(record.ended).toBe(true);
      expect(record.statuses).toHaveLength(0);
    });

    it('inherits the main agent name from its exact prompt parent', () => {
      startInteraction('main-prompt');
      const span = toolForPrompt('main-prompt', 'ReadFile');

      expect(attrOf('tool', 'gen_ai.agent.name')).toBe('qwen-code');
      endToolSpan(span, { success: true });
    });

    it('inherits a subagent name from the actual subagent parent', async () => {
      const subagent = startSubagentSpan({
        agentId: 'explore-1',
        subagentName: 'Explore',
        invocationKind: 'foreground',
        isBuiltIn: true,
        depth: 0,
        sessionId: 'session',
      });

      await runInSubagentSpanContext(subagent, async () => {
        const span = toolForPrompt('p', 'ReadFile');
        expect(attrOf('tool', 'gen_ai.agent.name')).toBe('Explore');
        endToolSpan(span, { success: true });
      });
      endSubagentSpan(subagent, { status: 'completed' });
    });

    it('omits the agent name for a standalone tool', () => {
      const span = toolForPrompt('unknown', 'ReadFile', {
        'gen_ai.agent.name': 'spoofed',
      });

      expect(mockSpans[0]!.attributes['gen_ai.agent.name']).toBeUndefined();
      endToolSpan(span, { success: true });
    });

    it('records and surrogate-safely bounds static tool descriptions', () => {
      startToolSpan('Read', undefined, 'a'.repeat(4096));
      expect(mockSpans[0]!.attributes['gen_ai.tool.description']).toHaveLength(
        4096,
      );

      startToolSpan('Write', undefined, `${'a'.repeat(4095)}😀`);
      expect(mockSpans[1]!.attributes['gen_ai.tool.description']).toBe(
        `${'a'.repeat(4095)}…[truncated]`,
      );
    });

    it('omits an empty tool description', () => {
      startToolSpan('Read', undefined, '');
      expect(attrOf('tool', 'gen_ai.tool.description')).toBeUndefined();
    });

    it('records error on tool failure', () => {
      endToolSpan(startToolSpan('Bash'), {
        success: false,
        error: 'command failed',
      });

      expectErrorStatus(mockSpans[0], 'command failed', 'tool_error');
    });

    it('records cancellation without marking the tool span as an error', () => {
      endToolSpan(startToolSpan('Bash'), { success: false, cancelled: true });

      expect(mockSpans[0]!.attributes).toMatchObject({
        success: false,
        'tool.failure_kind': 'cancelled',
      });
      expect(mockSpans[0]!.statuses).toHaveLength(0);
    });

    it('does not set status when no metadata is passed', () => {
      endToolSpan(startToolSpan('Read'));
      expect(mockSpans[0]!.statuses).toHaveLength(0);
    });

    it('tool span re-parents to active OTel span when no interaction is set (#4212)', () => {
      const fakeActive = { kind: 'fake-active-span' };
      mockState.activeOtelSpan = fakeActive;

      endToolSpan(startToolSpan('Bash'), { success: true });

      expect(rec('tool')?.parentContext).toMatchObject({
        __activeSpan: fakeActive,
      });
    });

    it('concurrent tool spans are isolated', () => {
      startInteraction('p');
      const span1 = startToolSpan('Read', { 'tool.call_id': 'c1' });
      const span2 = startToolSpan('Bash', { 'tool.call_id': 'c2' });

      // End span2 first (out of order)
      endToolSpan(span2, { success: true });
      endToolSpan(span1, { success: false, error: 'timeout' });

      const toolSpans = mockSpans.filter((s) => s.name === 'qwen-code.tool');
      expect(toolSpans).toHaveLength(2);
      expect(byAttr('gen_ai.tool.name', 'Bash')?.statuses).toHaveLength(0);
      expectErrorStatus(byAttr('gen_ai.tool.name', 'Read'), 'timeout');
    });
  });

  describe('session.id derives from the owning session, not the process-global (#4602 review)', () => {
    /**
     * Daemon scenario: telemetry init left the process-global pointing at
     * session B, but the active interaction belongs to session A.
     */
    function startSessionAUnderStaleGlobal(): void {
      setSessionContext(undefined, 'session-B-global');
      startInteraction('p-a', {
        sessionId: 'session-A',
        messageType: 'acp_prompt',
      });
    }

    it('keeps a nested tool on its logical tool session', () => {
      setSessionContext(undefined, 'bootstrap-session');
      const outerTool = sessionIdContext.run('tool-session', () =>
        startToolSpan('outer'),
      );

      runInToolSpanContext(outerTool, () => {
        const nestedTool = startToolSpan('nested');
        const nestedRecord = byAttr('gen_ai.tool.name', 'nested');
        expect(nestedRecord?.attributes['session.id']).toBe('tool-session');
        expect(trace.getSpan(nestedRecord?.parentContext as never)).toBe(
          outerTool,
        );
        endToolSpan(nestedTool, { success: true });
      });

      endToolSpan(outerTool, { success: true });
    });

    it('stamps a tool span with the interaction session.id even when the process-global belongs to another session', () => {
      startSessionAUnderStaleGlobal();
      endToolSpan(startToolSpan('Bash', { 'tool.call_id': 'c1' }), {
        success: true,
      });

      expect(attrOf('tool', 'session.id')).toBe('session-A');
    });

    it('stamps an llm_request span with the interaction session.id, not the global', () => {
      startSessionAUnderStaleGlobal();
      endLLMRequestSpan(startLLMRequestSpan('m', 'p-a'), { success: true });

      expect(attrOf('llm_request', 'session.id')).toBe('session-A');
    });

    it('stamps a tool.execution span with the owning session id via the tool span context', () => {
      startSessionAUnderStaleGlobal();
      const toolSpan = startToolSpan('Bash', { 'tool.call_id': 'c1' });
      const execSpan = runInToolSpanContext(toolSpan, startToolExecutionSpan);
      endToolExecutionSpan(execSpan, { success: true });
      endToolSpan(toolSpan, { success: true });

      expect(attrOf('tool.execution', 'session.id')).toBe('session-A');
    });

    it('stamps a blocked-on-user span with the owning session id via the tool parent', () => {
      startSessionAUnderStaleGlobal();
      const toolSpan = startToolSpan('Bash', { 'tool.call_id': 'c1' });
      const blockedSpan = startToolBlockedOnUserSpan(toolSpan, {
        call_id: 'c1',
      });
      endToolBlockedOnUserSpan(blockedSpan, { decision: 'proceed_once' });
      endToolSpan(toolSpan, { success: true });

      expect(attrOf('tool.blocked_on_user', 'session.id')).toBe('session-A');
    });

    it('stamps a hook span with the owning session id via the logical parent', () => {
      startSessionAUnderStaleGlobal();
      const toolSpan = startToolSpan('Bash', { 'tool.call_id': 'c1' });
      const hookSpan = runInToolSpanContext(toolSpan, () =>
        startHookSpan({
          hookEvent: 'PreToolUse',
          toolName: 'Bash',
          toolUseId: 'use-1',
        }),
      );
      endHookSpan(hookSpan, { success: true, shouldProceed: true });
      endToolSpan(toolSpan, { success: true });

      expect(attrOf('hook', 'session.id')).toBe('session-A');
    });

    it('isolates concurrent sessions: each tool span carries its own session id', async () => {
      // Two interactions for two different sessions while the global is stale.
      setSessionContext(undefined, 'stale-global');

      for (const [sessionId, promptId, tool, callId] of [
        ['session-A', 'pa', 'Read', 'a1'],
        ['session-B', 'pb', 'Write', 'b1'],
      ] as const) {
        await withInteractionSpan(
          createMockConfig({ sessionId }),
          { promptId, model: 'm', messageType: 'acp_prompt' },
          async () => {
            endToolSpan(startToolSpan(tool, { 'tool.call_id': callId }), {
              success: true,
            });
          },
        );
      }

      const readSpan = byAttr('gen_ai.tool.name', 'Read');
      const writeSpan = byAttr('gen_ai.tool.name', 'Write');
      expect(readSpan?.attributes['session.id']).toBe('session-A');
      expect(writeSpan?.attributes['session.id']).toBe('session-B');
    });

    it('falls back to the process-global session id for standalone spans (single-session CLI path)', () => {
      // No interaction context — single-session CLI: the global is correct.
      setSessionContext(undefined, 'cli-session');
      endToolSpan(startToolSpan('Bash', { 'tool.call_id': 'c1' }), {
        success: true,
      });

      expect(attrOf('tool', 'session.id')).toBe('cli-session');
    });
  });

  describe('gen_ai.user.id propagation', () => {
    it('propagates from an interaction to LLM and tool spans', () => {
      startInteraction('p-a', { sessionId: 'session-A', userId: 'user-A' });

      const llmSpan = startLLMRequestSpan('m', 'p-a');
      const toolSpan = startToolSpan('Read', { 'tool.call_id': 'call-1' });

      expect(attrOf('llm_request', 'gen_ai.user.id')).toBe('user-A');
      expect(attrOf('tool', 'gen_ai.user.id')).toBe('user-A');

      endLLMRequestSpan(llmSpan, { success: true });
      endToolSpan(toolSpan, { success: true });
      endInteractionSpan('ok');
    });

    it('does not let tool attributes override the interaction user ID', () => {
      startInteraction('p', { userId: 'canonical-user' });

      const toolSpan = startToolSpan('Read', {
        'gen_ai.user.id': 'spoofed-user',
      });

      expect(attrOf('tool', 'gen_ai.user.id')).toBe('canonical-user');
      endToolSpan(toolSpan, { success: true });
      endInteractionSpan('ok');
    });

    it('omits the user ID from standalone LLM and tool spans', () => {
      const llmSpan = startLLMRequestSpan('m', 'p');
      const toolSpan = startToolSpan('Read');

      for (const record of mockSpans) {
        expect(record.attributes).not.toHaveProperty('gen_ai.user.id');
      }

      endLLMRequestSpan(llmSpan, { success: true });
      endToolSpan(toolSpan, { success: true });
    });

    it('propagates across tool-result turns by prompt ID without changing span parenting', () => {
      startInteraction('continuation-prompt', { userId: 'continuation-user' });
      endInteractionSpan('ok');

      const llmSpan = startLLMRequestSpan('m', 'continuation-prompt');
      const toolSpan = toolForPrompt('continuation-prompt', 'Read', {
        'tool.call_id': 'call-2',
      });

      const llmRecord = rec('llm_request');
      const toolRecord = rec('tool');
      expect(llmRecord?.attributes['gen_ai.user.id']).toBe('continuation-user');
      expect(toolRecord?.attributes['gen_ai.user.id']).toBe(
        'continuation-user',
      );
      expect(llmRecord?.parentContext).not.toHaveProperty('__parentSpan');
      expect(toolRecord?.parentContext).not.toHaveProperty('__parentSpan');

      endLLMRequestSpan(llmSpan, { success: true });
      endToolSpan(toolSpan, { success: true });
    });

    it('expires prompt identity with the existing span TTL', () => {
      startInteraction('expired-prompt', { userId: 'expired-user' });
      endInteractionSpan('ok');
      sweepAfter(31);

      const llmSpan = startLLMRequestSpan('m', 'expired-prompt');
      expect(rec('llm_request')?.attributes).not.toHaveProperty(
        'gen_ai.user.id',
      );
      endLLMRequestSpan(llmSpan, { success: true });
    });

    it('retains identity for one TTL after a long interaction ends', () => {
      const startedAt = Date.now();
      const now = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
      startInteraction('long-lived-prompt', { userId: 'long-lived-user' });
      const owner = getActiveInteractionSpan('long-lived-prompt')!;

      now.mockReturnValue(startedAt + 29 * MIN);
      expect(recordInteractionActivity('long-lived-prompt', owner)).toBe(true);
      runTTLSweepForTesting(startedAt + 31 * MIN);
      now.mockReturnValue(startedAt + 35 * MIN);
      endInteractionSpan('ok', { promptId: 'long-lived-prompt' });

      runTTLSweepForTesting(startedAt + 64 * MIN);
      now.mockReturnValue(startedAt + 64 * MIN);
      const retainedSpan = startLLMRequestSpan('m', 'long-lived-prompt');
      expect(mockSpans.at(-1)!.attributes['gen_ai.user.id']).toBe(
        'long-lived-user',
      );
      endLLMRequestSpan(retainedSpan, { success: true });

      runTTLSweepForTesting(startedAt + 66 * MIN);
      now.mockReturnValue(startedAt + 66 * MIN);
      const expiredSpan = startLLMRequestSpan('m', 'long-lived-prompt');
      expect(mockSpans.at(-1)!.attributes).not.toHaveProperty('gen_ai.user.id');
      endLLMRequestSpan(expiredSpan, { success: true });
    });

    it('keeps the creation-time user ID across failures and repeated endings', () => {
      startInteraction('failure-prompt', { userId: 'stable-user' });
      const llmSpan = startLLMRequestSpan('m', 'failure-prompt');
      const toolSpan = startToolSpan('Read');

      endLLMRequestSpan(llmSpan, { success: false, error: 'failed' });
      endLLMRequestSpan(llmSpan, { success: true });
      endToolSpan(toolSpan, { success: false, error: 'failed' });
      endToolSpan(toolSpan, { success: true });
      endInteractionSpan('cancelled');
      endInteractionSpan('ok');

      for (const record of mockSpans) {
        expect(record.attributes['gen_ai.user.id']).toBe('stable-user');
      }
    });

    it('isolates user IDs across concurrent scoped interactions', async () => {
      await Promise.all(
        (
          [
            ['session-A', 'user-A', 'pa', 'Read'],
            ['session-B', 'user-B', 'pb', 'Write'],
          ] as const
        ).map(([sessionId, userId, promptId, tool]) =>
          withInteractionSpan(
            createMockConfig({ sessionId, userId }),
            { promptId, model: 'm', messageType: 'acp_prompt' },
            async () => {
              await Promise.resolve();
              endToolSpan(startToolSpan(tool), { success: true });
            },
          ),
        ),
      );

      const readSpan = byAttr('gen_ai.tool.name', 'Read');
      const writeSpan = byAttr('gen_ai.tool.name', 'Write');
      expect(readSpan?.attributes['gen_ai.user.id']).toBe('user-A');
      expect(writeSpan?.attributes['gen_ai.user.id']).toBe('user-B');
    });
  });

  describe('tool execution sub-spans', () => {
    /** Starts and ends a standalone execution span; returns its record. */
    function runExec(meta: EndToolExecutionSpanMetadata) {
      endToolExecutionSpan(startToolExecutionSpan(), meta);
      return rec('tool.execution');
    }

    it('returns a NOOP span when execution telemetry start fails', () => {
      mockState.throwOnStartSpan = true;
      const span = startToolExecutionSpan({
        toolName: 'Bash',
        callId: 'call-1',
      });

      expect(span.spanContext().traceId).toBe('0'.repeat(32));
      expect(mockSpans).toHaveLength(0);
    });

    it('creates a tool execution span as child of tool span via runInToolSpanContext', () => {
      const toolSpan = startToolSpan('Bash');
      const execSpan = runInToolSpanContext(toolSpan, startToolExecutionSpan);

      expect(mockSpans).toHaveLength(2);
      expect(mockSpans[1]!.name).toBe('qwen-code.tool.execution');
      expect(mockSpans[1]!.parentContext).toBeDefined();

      endToolExecutionSpan(execSpan, { success: true });
      endToolSpan(toolSpan, { success: true });

      expect(mockSpans[1]!.ended).toBe(true);
    });

    it('records optional tool identity on execution spans', () => {
      const execSpan = startToolExecutionSpan({
        toolName: 'Bash',
        callId: 'call-1',
      });

      expect(attrOf('tool.execution', 'gen_ai.tool.name')).toBe('Bash');
      expect(attrOf('tool.execution', 'tool.call_id')).toBe('call-1');

      endToolExecutionSpan(execSpan, { success: true });
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

      expect(runExec({ success: true })?.parentContext).toMatchObject({
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
      const record = runExec({
        success: false,
        error: 'Tool execution cancelled by user',
        cancelled: true,
        errorType: 'AbortError',
      });

      expect(record?.ended).toBe(true);
      // No setStatus, matching setToolSpanCancelled on the parent tool span:
      // ERROR here would make error-filtering trace backends false-positive
      // on user cancellations. Attributes still record the reason.
      expect(record?.statuses).toHaveLength(0);
      expectAttrs(record!.attributes, {
        success: false,
        error: 'Tool execution cancelled by user',
        error_type: 'AbortError',
        'error.type': undefined,
      });
    });

    it('cancelled: false (default) still maps success: false to ERROR status', () => {
      const record = runExec({
        success: false,
        error: 'Tool execution failed',
      });

      expect(record?.statuses).toHaveLength(1);
      expectErrorStatus(
        record,
        'Tool execution failed',
        'tool_execution_error',
      );
    });

    it('records canonical execution outcome and structured error type', () => {
      const record = runExec({
        success: false,
        error: 'Tool execution failed',
        executionStatus: 'error',
        errorType: 'execution_failed',
      });

      expectAttrs(record!.attributes, {
        execution_status: 'error',
        error_type: 'execution_failed',
        'error.type': 'execution_failed',
      });
      expect(record?.statuses[0]!.code).toBe(SpanStatusCode.ERROR);
    });

    it('uses execution_status to keep cancellation UNSET', () => {
      const record = runExec({ success: false, executionStatus: 'cancelled' });

      expect(record?.attributes['execution_status']).toBe('cancelled');
      expect(record?.statuses).toHaveLength(0);
    });
  });

  describe('blocked_on_user spans (#3731 Phase 2)', () => {
    it('parents the blocked span under the explicitly-passed tool span', () => {
      const toolSpan = startToolSpan('Bash', { 'tool.call_id': 'c1' });
      const blockedSpan = startToolBlockedOnUserSpan(toolSpan, {
        tool_name: 'Bash',
        call_id: 'c1',
      });

      const blockedRecord = rec('tool.blocked_on_user');
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
      const blockedSpan = startToolBlockedOnUserSpan(startToolSpan('Bash'));
      endToolBlockedOnUserSpan(blockedSpan, {
        decision: 'cancel',
        source: 'cli',
      });

      const blockedRecord = rec('tool.blocked_on_user');
      expect(blockedRecord?.ended).toBe(true);
      expect(blockedRecord?.attributes['decision']).toBe('cancel');
      expect(blockedRecord?.attributes['source']).toBe('cli');
      // Waiting on the user is neither OK nor ERROR — status stays UNSET.
      expect(blockedRecord?.statuses).toHaveLength(0);
    });

    it('is idempotent — second end is a no-op', () => {
      const blockedSpan = startToolBlockedOnUserSpan(startToolSpan('Bash'));
      endToolBlockedOnUserSpan(blockedSpan, { decision: 'proceed_once' });
      endToolBlockedOnUserSpan(blockedSpan, { decision: 'cancel' });

      // The second end must NOT overwrite decision recorded by the first.
      expect(attrOf('tool.blocked_on_user', 'decision')).toBe('proceed_once');
    });

    it('returns NOOP span when SDK is not initialized', () => {
      mockState.sdkInitialized = false;
      const blockedSpan = startToolBlockedOnUserSpan(startToolSpan('Bash'));
      expect(blockedSpan.spanContext().traceId).toBe('0'.repeat(32));

      // End on NOOP span must not throw.
      endToolBlockedOnUserSpan(blockedSpan, { decision: 'cancel' });
    });

    it('handles concurrent blocked spans without findLast confusion', () => {
      // Regression for the claude-code findLast-by-type bug: with two
      // concurrent tools, ending the second blocked span must NOT close the
      // first.
      const toolA = startToolSpan('Bash', { 'tool.call_id': 'a' });
      const toolB = startToolSpan('Read', { 'tool.call_id': 'b' });
      const blockedA = startToolBlockedOnUserSpan(toolA, { call_id: 'a' });
      const blockedB = startToolBlockedOnUserSpan(toolB, { call_id: 'b' });

      endToolBlockedOnUserSpan(blockedB, { decision: 'cancel' });

      const blockedRecord = (callId: string) =>
        mockSpans.find(
          (s) =>
            s.name === 'qwen-code.tool.blocked_on_user' &&
            s.attributes['tool.call_id'] === callId,
        );
      const recordA = blockedRecord('a');
      const recordB = blockedRecord('b');
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
      // An already-ended tool span must still yield a span (correlated via
      // the standard fallback chain) instead of crashing.
      const toolSpan = startToolSpan('Bash');
      endToolSpan(toolSpan, { success: true });

      const blockedSpan = startToolBlockedOnUserSpan(toolSpan);
      expect(rec('tool.blocked_on_user')).toBeDefined();

      endToolBlockedOnUserSpan(blockedSpan, { decision: 'proceed_once' });
    });
  });

  describe('hook spans (#3731 Phase 2)', () => {
    /** Starts a Bash tool span and a hook span inside its tool context. */
    function startBashHook(opts: Omit<StartHookSpanOptions, 'toolName'>) {
      const toolSpan = startToolSpan('Bash');
      const hookSpan = runInToolSpanContext(toolSpan, () =>
        startHookSpan({ toolName: 'Bash', ...opts }),
      );
      return { toolSpan, hookSpan };
    }

    it('parents under the active tool span when called inside runInToolSpanContext', () => {
      const { toolSpan, hookSpan } = startBashHook({
        hookEvent: 'PreToolUse',
        toolUseId: 'use-1',
      });

      const hookRecord = rec('hook');
      expect(hookRecord).toBeDefined();
      expect(hookRecord?.parentContext).toBeDefined();
      expectAttrs(hookRecord!.attributes, {
        hook_event: 'PreToolUse',
        'tool.name': 'Bash',
        'tool.use_id': 'use-1',
      });

      endHookSpan(hookSpan, { success: true, shouldProceed: true });
      endToolSpan(toolSpan, { success: true });
    });

    it('records shouldProceed/blockType when PreToolUse blocks', () => {
      const { toolSpan, hookSpan } = startBashHook({ hookEvent: 'PreToolUse' });
      endHookSpan(hookSpan, {
        success: true,
        shouldProceed: false,
        blockType: 'denied',
      });

      const hookRecord = rec('hook');
      expect(hookRecord?.attributes['should_proceed']).toBe(false);
      expect(hookRecord?.attributes['block_type']).toBe('denied');
      // Blocking is intentional, not an error — status must stay UNSET.
      expect(hookRecord?.statuses).toHaveLength(0);

      endToolSpan(toolSpan, { success: false, error: 'denied' });
    });

    it('records shouldStop/hasAdditionalContext on PostToolUse', () => {
      const { toolSpan, hookSpan } = startBashHook({
        hookEvent: 'PostToolUse',
      });
      endHookSpan(hookSpan, {
        success: true,
        shouldStop: true,
        hasAdditionalContext: true,
      });

      const hookRecord = rec('hook');
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

      const hookRecord = rec('hook');
      expectAttrs(hookRecord!.attributes, {
        hook_event: 'PostToolBatch',
        should_stop: true,
        has_additional_context: true,
        post_batch_stop: true,
        post_batch_stop_reason: 'policy halt',
      });
      expect(hookRecord?.statuses).toHaveLength(0);
    });

    it('marks status ERROR only when the hook itself threw', () => {
      const { toolSpan, hookSpan } = startBashHook({
        hookEvent: 'PostToolUseFailure',
        isInterrupt: true,
      });
      endHookSpan(hookSpan, { success: false, error: 'hook crashed' });

      expectErrorStatus(rec('hook'), 'hook crashed', 'hook_error');
      expect(attrOf('hook', 'is_interrupt')).toBe(true);

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
      const insideSpan = runInToolSpanContext(toolSpan, startToolExecutionSpan);
      const outsideSpan = startToolExecutionSpan();

      const hasToolParent = (s: MockSpanRecord) =>
        Boolean((s.parentContext as Record<string, unknown>)?.['__parentSpan']);
      const execRecords = mockSpans.filter(
        (s) => s.name === 'qwen-code.tool.execution',
      );
      // Inside the context: parented under the tool span.
      expect(execRecords.find(hasToolParent)).toBeDefined();
      // Outside: no tool parent.
      expect(execRecords).toHaveLength(2);
      expect(execRecords.find((s) => !hasToolParent(s))).toBeDefined();

      endToolExecutionSpan(insideSpan, { success: true });
      endToolExecutionSpan(outsideSpan, { success: true });
      endToolSpan(toolSpan, { success: true });
    });

    it('endToolSpan without metadata preserves pre-set status', () => {
      const toolSpan = startToolSpan('Bash');
      // Simulate setToolSpanFailure calling setStatus directly
      toolSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: 'hook blocked',
      });

      endToolSpan(toolSpan);

      // endToolSpan should NOT have added another status
      const toolRecord = rec('tool');
      expect(toolRecord!.statuses).toHaveLength(1);
      expect(toolRecord!.statuses[0]!.code).toBe(SpanStatusCode.ERROR);
    });
  });

  describe('getActiveInteractionSpan', () => {
    it('returns the span when an interaction is active', () => {
      startInteraction('p-active');

      const span = getActiveInteractionSpan();
      expect(span).toBeDefined();
      expect(span).toBe(mockSpans[0]);
    });

    it('returns undefined after endInteractionSpan', () => {
      startInteraction('p-end');
      endInteractionSpan('ok');

      expect(getActiveInteractionSpan()).toBeUndefined();
    });

    it('resolves an interaction exactly by prompt id', async () => {
      startInteraction('p-fallback');
      await new Promise<void>((resolve) => setImmediate(resolve));

      const span = getActiveInteractionSpan('p-fallback');
      expect(span).toBeDefined();
      expect(span).toBe(mockSpans[0]);
      expect(getActiveInteractionSpan('another-prompt')).toBeUndefined();
    });

    it('returns undefined when no interaction has ever started', () => {
      expect(getActiveInteractionSpan()).toBeUndefined();
    });
  });

  describe('clearSessionTracingForTesting', () => {
    it('resets state so new interactions start fresh', () => {
      startInteraction('p');

      clearSessionTracingForTesting();
      mockSpans.length = 0;

      startInteraction('p2');

      expect(mockSpans[0]!.attributes['interaction.sequence']).toBe(1);
    });
  });

  describe('OTel error resilience — span.end() must run on attribute/status failure', () => {
    it('endLLMRequestSpan: end() runs and activeSpans is cleared when setStatus throws', () => {
      const span = startLLMRequestSpan('test-model', 'prompt-x');
      const record = rec('llm_request')!;

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

      mockState.throwOnSetAttributes = true;
      endLLMRequestSpan(span, { success: true });

      expect(rec('llm_request')!.ended).toBe(true);
    });

    it('endToolSpan: end() runs when setStatus throws', () => {
      const span = startToolSpan('Bash');

      mockState.throwOnSetStatus = true;
      endToolSpan(span, { success: true });

      expect(rec('tool')!.ended).toBe(true);
    });

    it('endToolExecutionSpan: end() runs when setAttributes throws', () => {
      const toolSpan = startToolSpan('Bash');
      const execSpan = runInToolSpanContext(toolSpan, startToolExecutionSpan);

      mockState.throwOnSetAttributes = true;
      endToolExecutionSpan(execSpan, { success: true });

      expect(rec('tool.execution')!.ended).toBe(true);

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
      const record = rec('subagent')!;

      mockState.throwOnSetAttributes = true;
      endSubagentSpan(span, { status: 'completed' });

      // The attribute write threw, but the span must still end so the WeakRef
      // registry doesn't leak it (mirrors the LLM/tool cases; #4410 review).
      expect(record.ended).toBe(true);

      // No leak: spanCtx left activeSpans, so a second call short-circuits
      // and records no recovery status.
      mockState.throwOnSetAttributes = false;
      endSubagentSpan(span, { status: 'completed' });
      expect(record.statuses).toHaveLength(0);
    });
  });

  describe('TTL safety net (#4321 review)', () => {
    it('expires interactions after inactivity instead of absolute lifetime', () => {
      const startedAt = Date.now();
      const now = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
      startInteraction('active-interaction');
      const owner = getActiveInteractionSpan('active-interaction')!;

      now.mockReturnValue(startedAt + 11 * MIN);
      runLLM({ success: true }, 'm', 'active-interaction');
      runTTLSweepForTesting(startedAt + 31 * MIN);
      expect(getActiveInteractionSpan('active-interaction')).toBe(owner);

      now.mockReturnValue(startedAt + 29 * MIN);
      const toolSpan = toolForPrompt('active-interaction', 'Read');
      now.mockReturnValue(startedAt + 58 * MIN);
      endToolSpan(toolSpan, { success: true });
      runTTLSweepForTesting(startedAt + 60 * MIN);
      expect(getActiveInteractionSpan('active-interaction')).toBe(owner);
      expect(mockSpans[0]!.ended).toBe(false);

      now.mockReturnValue(startedAt + 60 * MIN);
      const record = mockSpans[0]!;
      record.attributes['gen_ai.output.messages'] = 'final output';
      endInteractionSpan('ok', { promptId: 'active-interaction' });
      expect(getActiveInteractionSpan('active-interaction')).toBeUndefined();
      expect(record.ended).toBe(true);
      expectAttrs(record.attributes, {
        'interaction.duration_ms': 60 * MIN,
        'qwen-code.turn_status': 'ok',
        'gen_ai.output.messages': 'final output',
      });
    });

    it('expires an interaction after 30 minutes without activity', () => {
      const startedAt = Date.now();
      startInteraction('idle-interaction');

      runTTLSweepForTesting(startedAt + 31 * MIN);

      expect(getActiveInteractionSpan('idle-interaction')).toBeUndefined();
      expect(mockSpans[0]!.ended).toBe(true);
      expect(mockSpans[0]!.attributes['qwen-code.span.ttl_expired']).toBe(true);
    });

    it('does not let an old child refresh a replacement interaction', () => {
      const startedAt = Date.now();
      const now = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
      startInteraction('child-replacement');
      now.mockReturnValue(startedAt + 4 * MIN);
      const oldChild = startLLMRequestSpan('m', 'child-replacement');

      now.mockReturnValue(startedAt + 5 * MIN);
      startInteraction('child-replacement', { messageType: 'retry' });
      now.mockReturnValue(startedAt + 34 * MIN);
      endLLMRequestSpan(oldChild, { success: true });

      runTTLSweepForTesting(startedAt + 36 * MIN);
      expect(getActiveInteractionSpan('child-replacement')).toBeUndefined();
      expect(mockSpans[2]!.ended).toBe(true);
    });

    it('does not let a replaced owner refresh the current interaction', () => {
      const startedAt = Date.now();
      const now = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
      startInteraction('replaced-interaction');
      const oldOwner = getActiveInteractionSpan('replaced-interaction')!;

      now.mockReturnValue(startedAt + 5 * MIN);
      startInteraction('replaced-interaction', { messageType: 'retry' });
      const currentOwner = getActiveInteractionSpan('replaced-interaction')!;
      now.mockReturnValue(startedAt + 34 * MIN);
      expect(recordInteractionActivity('replaced-interaction', oldOwner)).toBe(
        false,
      );

      runTTLSweepForTesting(startedAt + 36 * MIN);
      expect(getActiveInteractionSpan('replaced-interaction')).toBeUndefined();
      expect(currentOwner).not.toBe(oldOwner);
      expect(mockSpans[1]!.ended).toBe(true);
    });
    it('marks stale spans with ttl_expired + duration_ms before ending them', () => {
      const toolSpan = startToolSpan('staleTool');
      const record = rec('tool')!;

      sweepAfter(31); // past the 30-min TTL

      expect(record.ended).toBe(true);
      // Without the sentinel attrs, operators couldn't tell a TTL-aborted
      // span from a deliberately-ended span that lost attribution.
      expect(record.attributes['qwen-code.span.ttl_expired']).toBe(true);
      expect(
        record.attributes['qwen-code.span.duration_ms'] as number,
      ).toBeGreaterThanOrEqual(31 * MIN - 1000);

      // endToolSpan after the TTL fired must be a safe no-op.
      endToolSpan(toolSpan, { success: false });
    });

    it('does not mark spans that were ended before TTL expiry', () => {
      // The sweep must not retroactively stamp ttl_expired on an ended span.
      endToolSpan(startToolSpan('liveTool'), { success: true });
      sweepAfter(31);

      expect(attrOf('tool', 'qwen-code.span.ttl_expired')).toBeUndefined();
    });

    it('stamps decision=aborted/source=system on TTL-expired blocked_on_user spans', () => {
      // sweepStaleSpans tags the canonical taxonomy so dashboards filtering
      // by `decision: 'aborted'` count walk-aways alongside explicit aborts.
      const toolSpan = startToolSpan('blockedStaleParent');
      const blockedSpan = startToolBlockedOnUserSpan(toolSpan, {
        tool_name: 'blockedStaleParent',
      });
      const blockedRecord = rec('tool.blocked_on_user')!;

      sweepAfter(31);

      expect(blockedRecord.ended).toBe(true);
      expectAttrs(blockedRecord.attributes, {
        'qwen-code.span.ttl_expired': true,
        decision: 'aborted',
        source: 'system',
      });

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

    it('redacts credentials and strips control sequences', () => {
      expect(
        truncateSpanError(
          '\u001b[31mfailed via https://user:secret@example.com\u0007',
        ),
      ).toBe('failed via https://***REDACTED***@example.com');
    });

    it('truncates strings over 1024 chars and appends a sentinel suffix', () => {
      const oversized = 'a'.repeat(2000);
      const truncated = truncateSpanError(oversized);
      expect(truncated.length).toBeLessThan(oversized.length);
      expect(truncated.endsWith('…[truncated]')).toBe(true);
      expect(truncated.startsWith('a'.repeat(1024))).toBe(true);
    });

    it('does not double-suffix already-truncated input', () => {
      // The sentinel is only appended above the cap; production sites never
      // re-truncate a suffixed string, but check the boundary anyway.
      const exactlyAtCap = 'b'.repeat(1024);
      expect(truncateSpanError(exactlyAtCap)).toBe(exactlyAtCap);
    });

    it('backs up one code unit when the cut would split a surrogate pair (#4321)', () => {
      // OTLP/gRPC collectors reject batches with invalid UTF-8, so a cap
      // landing inside a surrogate pair must back up one code unit rather
      // than emit a lone high surrogate. 🚀 (U+1F680) is [0xD83D, 0xDE80];
      // 1023 'a's put its high surrogate at index 1023, the low one at 1024.
      const oversized = 'a'.repeat(1023) + '🚀' + 'b'.repeat(100);
      const truncated = truncateSpanError(oversized);
      // Must not END with a lone high surrogate ([0xD800, 0xDBFF]).
      const lastBeforeSentinel = truncated.slice(0, -'…[truncated]'.length);
      const lastCharCode = lastBeforeSentinel.charCodeAt(
        lastBeforeSentinel.length - 1,
      );
      expect(lastCharCode).not.toBeGreaterThanOrEqual(0xd800);
      // No orphan high surrogates anywhere. Checked by regex because
      // `Buffer.from(s, 'utf16le')` doesn't validate pairs (#4321 review-9).
      expect(truncated).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    });
  });

  describe('subagent spans (#3731 Phase 3)', () => {
    const baseOpts = {
      agentId: 'Explore-abc123',
      subagentName: 'Explore',
      agentDescription: 'Search and inspect the workspace',
      isBuiltIn: true,
      depth: 0,
      sessionId: 'session-uuid',
    } as const;
    const startSub = (
      invocationKind: StartSubagentSpanOptions['invocationKind'],
      extra: Partial<StartSubagentSpanOptions> = {},
    ) => startSubagentSpan({ ...baseOpts, invocationKind, ...extra });

    it('keeps the logical parent session ahead of the explicit owner', () => {
      startInteraction('p', { sessionId: 'parent-session' });

      const span = startSub('foreground', { sessionId: 'different-owner' });
      expect(attrOf('subagent', 'session.id')).toBe('parent-session');
      expect(attrOf('subagent', 'gen_ai.conversation.id')).toBe(
        'parent-session',
      );

      endSubagentSpan(span, { status: 'completed' });
      endInteractionSpan('ok');
    });

    it('foreground invocation creates a child span (no root flag, no links)', () => {
      const span = startSub('foreground');
      const record = rec('subagent');

      expect(record).toBeDefined();
      expect(record!.root).toBeUndefined();
      expect(record!.links).toBeUndefined();
      expectAttrs(record!.attributes, {
        'gen_ai.agent.id': undefined,
        'gen_ai.agent.name': 'Explore',
        'gen_ai.agent.description': 'Search and inspect the workspace',
        'qwen-code.subagent.id': 'Explore-abc123',
        'qwen-code.subagent.name': 'Explore',
        // Required spec attrs.
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.provider.name': undefined,
        'gen_ai.conversation.id': 'session-uuid',
        'session.id': 'session-uuid',
        // Vendor concept attrs.
        'qwen-code.subagent.invocation_kind': 'foreground',
        'qwen-code.subagent.is_built_in': true,
        'qwen-code.subagent.depth': 0,
      });

      endSubagentSpan(span, { status: 'completed' });
    });

    it('truncates agent descriptions without splitting surrogate pairs', () => {
      const span = startSub('foreground', {
        agentDescription: `${'a'.repeat(1023)}😀tail`,
      });
      const description = attrOf('subagent', 'gen_ai.agent.description');

      expect(description).toBe(`${'a'.repeat(1023)}…[truncated]`);
      expect(description).not.toContain('\ud83d');
      endSubagentSpan(span, { status: 'completed' });
    });

    it('fork invocation creates a linked-root span (root: true + Link to invoker)', () => {
      const fakeInvokerSpanContext = {
        spanId: 'invoker-span-id1',
        traceId: 'invoker-trace-id-00000000000000',
        traceFlags: 1,
      };

      const span = startSub('fork', {
        invokerSpanContext:
          fakeInvokerSpanContext as unknown as import('@opentelemetry/api').SpanContext,
      });
      const record = rec('subagent');

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
      const span = startSub('background');
      const record = rec('subagent');
      expect(record!.root).toBe(true);
      // No links because invokerSpanContext was omitted — still root.
      expect(record!.attributes['qwen-code.subagent.invocation_kind']).toBe(
        'background',
      );
      endSubagentSpan(span, { status: 'completed' });
    });

    it.each(['foreground', 'fork', 'background'] as const)(
      '%s invocation and its children inherit the interaction user ID',
      async (invocationKind) => {
        startInteraction('p', { userId: 'agent-user' });
        const span = startSub(invocationKind);
        expect(attrOf('subagent', 'gen_ai.user.id')).toBe('agent-user');

        await runInSubagentSpanContext(span, async () => {
          const llmSpan = startLLMRequestSpan('m', 'subagent-p');
          const toolSpan = startToolSpan('Read');
          const childSpans = mockSpans.filter(
            (candidate) =>
              candidate.name === 'qwen-code.llm_request' ||
              candidate.name === 'qwen-code.tool',
          );
          expect(childSpans).toHaveLength(2);
          for (const child of childSpans) {
            expect(child.attributes['gen_ai.user.id']).toBe('agent-user');
          }
          endLLMRequestSpan(llmSpan, { success: true });
          endToolSpan(toolSpan, { success: true });
        });

        endSubagentSpan(span, { status: 'completed' });
        endInteractionSpan('ok');
      },
    );

    it('inherits the user ID from an Agent tool on a continuation turn', async () => {
      startInteraction('agent-tool-prompt', { userId: 'agent-tool-user' });
      endInteractionSpan('ok');
      const toolSpan = toolForPrompt('agent-tool-prompt', 'agent');

      await runInToolSpanContext(toolSpan, async () => {
        const agentSpan = startSub('background');
        expect(attrOf('subagent', 'gen_ai.user.id')).toBe('agent-tool-user');
        endSubagentSpan(agentSpan, { status: 'completed' });
      });

      endToolSpan(toolSpan, { success: true });
    });

    it('captures optional attrs: parentAgentId, invokingRequestId, modelOverride', () => {
      const span = startSub('foreground', {
        parentAgentId: 'parent-agent-456',
        invokingRequestId: 'req-789',
        modelOverride: 'qwen-coder-7b',
        depth: 2,
      });
      expectAttrs(rec('subagent')!.attributes, {
        'qwen-code.subagent.parent_agent_id': 'parent-agent-456',
        'qwen-code.subagent.invoking_request_id': 'req-789',
        'gen_ai.request.model': 'qwen-coder-7b',
        'qwen-code.subagent.depth': 2,
      });
      endSubagentSpan(span, { status: 'completed' });
    });

    it('endSubagentSpan: completed → SpanStatus UNSET + duration recorded', () => {
      endSubagentSpan(startSub('foreground'), { status: 'completed' });

      const record = rec('subagent')!;
      expect(record.ended).toBe(true);
      expect(record.statuses).toHaveLength(0);
      expect(record.attributes['qwen-code.subagent.status']).toBe('completed');
      expect(
        record.attributes['qwen-code.subagent.duration_ms'] as number,
      ).toBeGreaterThanOrEqual(0);
    });

    it('endSubagentSpan: failed → SpanStatus ERROR + exception.message + error.type', () => {
      endSubagentSpan(startSub('foreground'), {
        status: 'failed',
        error: 'something broke',
        errorType: 'TypeError',
      });

      const record = rec('subagent')!;
      expectErrorStatus(record, 'something broke', 'TypeError');
      expect(record.attributes['exception.message']).toBe('something broke');
      expect(record.attributes['qwen-code.subagent.status']).toBe('failed');
    });

    it('endSubagentSpan: failed without explicit error → generic "subagent failed" SpanStatus message', () => {
      // Covers the ERROR-branch fallback `metadata.error ?
      // truncateSpanError(metadata.error) : 'subagent failed'`, which every
      // other failure test skips by passing an explicit error.
      // wenshao @ #4410 DeepSeek 3293036600.
      endSubagentSpan(startSub('foreground'), { status: 'failed' });

      const record = rec('subagent')!;
      expectErrorStatus(record, 'subagent failed', 'subagent_error');
      expect(record.attributes['exception.message']).toBeUndefined();
    });

    it.each(['cancelled', 'aborted'] as const)(
      'endSubagentSpan: %s → SpanStatus UNSET (Phase 2 cancellation convention)',
      (status) => {
        endSubagentSpan(startSub('foreground'), {
          status,
          error: 'abort detail',
          errorType: 'AbortError',
        });
        const record = rec('subagent')!;
        // No SpanStatus calls means UNSET stays UNSET.
        expect(record.statuses).toHaveLength(0);
        expectAttrs(record.attributes, {
          'qwen-code.subagent.status': status,
          'exception.message': undefined,
          'error.type': undefined,
        });
      },
    );

    it('endSubagentSpan is idempotent (second call is a no-op)', () => {
      const span = startSub('foreground');
      endSubagentSpan(span, { status: 'completed' });
      endSubagentSpan(span, { status: 'failed', error: 'should not record' });

      const record = rec('subagent')!;
      // Only the first end ran — status is still UNSET, not ERROR.
      expect(record.statuses).toHaveLength(0);
      expect(record.attributes['qwen-code.subagent.status']).toBe('completed');
    });

    it('runInSubagentSpanContext wraps fn in context.with', async () => {
      const contextWithSpy = vi.spyOn(otelContext, 'with');
      const span = startSub('foreground');
      const result = await runInSubagentSpanContext(span, async () => 42);
      expect(result).toBe(42);
      expect(getSessionIdFromContext(contextWithSpy.mock.calls[0]![0])).toBe(
        'session-uuid',
      );
      endSubagentSpan(span, { status: 'completed' });
    });

    it('returns NOOP_SPAN when SDK is uninitialized', () => {
      mockState.sdkInitialized = false;
      const span = startSub('foreground');
      // NOOP_SPAN has all-zero traceId/spanId per OTel convention.
      expect(span.spanContext().traceId).toBe('0'.repeat(32));
      // NOOP returns before tracer.startSpan, so no record exists.
      expect(rec('subagent')).toBeUndefined();
      // endSubagentSpan on NOOP_SPAN is a safe no-op.
      endSubagentSpan(span, { status: 'completed' });
    });

    it('error message is truncated via truncateSpanError', () => {
      const oversized = 'a'.repeat(2000);
      endSubagentSpan(startSub('foreground'), {
        status: 'failed',
        error: oversized,
      });

      const recorded = attrOf('subagent', 'exception.message') as string;
      expect(recorded.length).toBeLessThan(oversized.length);
      expect(recorded.endsWith('…[truncated]')).toBe(true);
    });

    it('TTL: fork subagent at 30 min stays alive (4h window)', () => {
      startSub('fork');
      const record = rec('subagent')!;

      sweepAfter(31); // past the default TTL, well within fork's 4h
      expect(record.ended).toBe(false);

      sweepAfter(4 * 60 + 1); // past fork's 4h TTL
      expect(record.ended).toBe(true);
      expectAttrs(record.attributes, {
        'qwen-code.span.ttl_expired': true,
        'qwen-code.subagent.status': 'aborted',
        'qwen-code.subagent.terminate_reason': 'ttl_swept',
      });
      // The sweep also stamps the subagent-namespaced duration_ms so
      // dashboards querying that namespace include swept spans.
      // wenshao @ #4410 DeepSeek 3292560017.
      expect(
        record.attributes['qwen-code.subagent.duration_ms'] as number,
      ).toBeGreaterThan(0);
    });

    it('TTL: background subagent at 30 min stays alive (4h window)', () => {
      // Mirror of the fork test: catches trimming `'background'` out of
      // LONG_TTL_SUBAGENT_KINDS. wenshao @ #4410 DeepSeek 3291876056.
      startSub('background');
      const record = rec('subagent')!;

      sweepAfter(31);
      expect(record.ended).toBe(false);

      sweepAfter(4 * 60 + 1);
      expect(record.ended).toBe(true);
      expectAttrs(record.attributes, {
        'qwen-code.subagent.status': 'aborted',
        'qwen-code.subagent.terminate_reason': 'ttl_swept',
      });
    });

    it('TTL: foreground subagent at 31 min IS swept (default 30 min TTL)', () => {
      const span = startSub('foreground');
      const record = rec('subagent')!;

      sweepAfter(31);
      expect(record.ended).toBe(true);
      expect(record.attributes['qwen-code.span.ttl_expired']).toBe(true);

      // Defensive: endSubagentSpan after TTL is a no-op (already ended).
      endSubagentSpan(span, { status: 'completed' });
    });

    describe('child span parenting (#4410 DeepSeek 3290820352)', () => {
      // Regression: a foreground subagent's child LLM/tool/hook spans
      // parented to the OUTER interaction span, because resolveParentContext
      // preferred `interactionContext.getStore()` over the active OTel span.
      // The fix adds a `subagentContext` ALS that child startXSpan calls
      // check before falling back to interactionContext.

      /** Starts the interaction and a foreground subagent span. */
      function startForegroundSubagent() {
        startInteraction('prompt-1');
        const span = startSub('foreground');
        return { span, record: rec('subagent')! };
      }

      function endAll(...subagentSpans: Span[]): void {
        for (const span of subagentSpans) {
          endSubagentSpan(span, { status: 'completed' });
        }
        endInteractionSpan('ok');
      }

      it('startLLMRequestSpan inside runInSubagentSpanContext parents under the subagent span', async () => {
        const subagent = startForegroundSubagent();

        await runInSubagentSpanContext(subagent.span, async () => {
          startLLMRequestSpan('qwen3-coder-plus', 'prompt-1');
        });

        const llmRecord = rec('llm_request');
        expect(llmRecord).toBeDefined();
        const parentSpan = parentOf(llmRecord);
        expect(parentSpan).toBeDefined();
        // Must parent to the subagent span, NOT the interaction span.
        expect(parentSpan).toBe(subagent.record);
        // `llm_request.context` tri-state: subagent-parented calls MUST stamp
        // 'subagent' (not 'interaction') so dashboards classify them.
        // wenshao @ #4410 DeepSeek 3293036596.
        expect(llmRecord!.attributes['llm_request.context']).toBe('subagent');
        endAll(subagent.span);
      });

      it('startToolSpan inside runInSubagentSpanContext parents under the subagent span', async () => {
        const subagent = startForegroundSubagent();

        await runInSubagentSpanContext(subagent.span, async () => {
          startToolSpan('read_file');
        });

        expect(rec('tool')).toBeDefined();
        expect(parentOf(rec('tool'))).toBe(subagent.record);
        endAll(subagent.span);
      });

      it('startHookSpan inside runInSubagentSpanContext (no inner tool) parents under the subagent span', async () => {
        // Regression: startHookSpan reads tool > subagent > interaction, and
        // the AGENT tool's own toolContext leaked into the subagent body,
        // mis-parenting SubagentStart/Stop hooks. runInSubagentSpanContext
        // now clears toolContext for the body's duration.
        // wenshao @ #4410 DeepSeek 3291876051 / 3291876055.
        const subagent = startForegroundSubagent();

        await runInSubagentSpanContext(subagent.span, async () => {
          startHookSpan({ hookEvent: 'PreToolUse', toolName: 'read_file' });
        });

        expect(rec('hook')).toBeDefined();
        expect(parentOf(rec('hook'))).toBe(subagent.record);
        endAll(subagent.span);
      });

      it('startHookSpan OUTSIDE runInSubagentSpanContext but inside a tool context parents under the tool span (documented bg SubagentStart asymmetry)', async () => {
        // Locks in the documented bg-vs-fg SubagentStart asymmetry (design
        // doc Edge Cases table): the background path fires SubagentStart
        // BEFORE wrapping in runInSubagentSpanContext, so the hook sees the
        // outer AGENT tool's toolContext and parents to the tool span, not
        // the subagent, even though the subagent span is in activeSpans. A
        // refactor that changes this (or the deferred fix) trips this test.
        // wenshao @ #4410 DeepSeek 3293174101.
        startInteraction('prompt-1');
        const agentToolSpan = startToolSpan('agent'); // the outer AGENT tool
        const agentToolRecord = rec('tool')!;
        // Deliberately no runInSubagentSpanContext, as on the bg path.
        const subagentSpan = startSub('background');

        await runInToolSpanContext(agentToolSpan, async () => {
          startHookSpan({ hookEvent: 'PreToolUse', toolName: 'subagent' });
        });

        expect(rec('hook')).toBeDefined();
        expect(parentOf(rec('hook'))).toBe(agentToolRecord);
        endSubagentSpan(subagentSpan, { status: 'completed' });
        endToolSpan(agentToolSpan);
        endInteractionSpan('ok');
      });

      it('nested subagent: innermost subagent shadows outer for child parenting', async () => {
        startInteraction('prompt-1');
        const outerSubagent = startSub('foreground', {
          agentId: 'outer',
          subagentName: 'outer-agent',
        });
        const innerSubagent = startSub('foreground', {
          agentId: 'inner',
          subagentName: 'inner-agent',
        });
        const innerRecord = byAttr('qwen-code.subagent.id', 'inner');

        await runInSubagentSpanContext(outerSubagent, async () => {
          await runInSubagentSpanContext(innerSubagent, async () => {
            startLLMRequestSpan('qwen3-coder-plus', 'prompt-1');
          });
        });

        expect(parentOf(rec('llm_request'))).toBe(innerRecord);
        endAll(innerSubagent, outerSubagent);
      });

      it('after runInSubagentSpanContext exits, child spans go back to interactionContext', async () => {
        const subagent = startForegroundSubagent();
        const interactionRecord = rec('interaction');

        await runInSubagentSpanContext(subagent.span, async () => {});
        // Now outside the subagent ALS frame.
        startLLMRequestSpan('qwen3-coder-plus', 'prompt-1');

        // Parented under interaction span, NOT subagent (ALS frame exited).
        expect(parentOf(rec('llm_request'))).toBe(interactionRecord);
        endAll(subagent.span);
      });
    });
  });
});
