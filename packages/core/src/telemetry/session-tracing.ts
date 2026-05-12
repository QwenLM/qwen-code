/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import {
  context as otelContext,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
} from '@opentelemetry/api';
import type { Config } from '../config/config.js';
import {
  SERVICE_NAME,
  SPAN_INTERACTION,
  SPAN_LLM_REQUEST,
  SPAN_TOOL,
  SPAN_TOOL_EXECUTION,
} from './constants.js';
import { isTelemetrySdkInitialized } from './sdk.js';

type InteractionStatus = 'ok' | 'error' | 'cancelled';

export interface StartInteractionOptions {
  promptId: string;
  model: string;
  messageType: string;
}

export interface EndInteractionOptions {
  errorMessage?: string;
}

export interface LLMRequestMetadata {
  inputTokens?: number;
  outputTokens?: number;
  success: boolean;
  durationMs?: number;
  error?: string;
}

export interface ToolSpanMetadata {
  success?: boolean;
  error?: string;
}

interface SpanContext {
  span: Span;
  startTime: number;
  attributes: Record<string, string | number | boolean>;
  ended?: boolean;
  type: 'interaction' | 'llm_request' | 'tool' | 'tool.execution';
}

const NOOP_SPAN = trace.wrapSpanContext({
  traceId: '0'.repeat(32),
  spanId: '0'.repeat(16),
  traceFlags: 0,
});

const interactionContext = new AsyncLocalStorage<SpanContext | undefined>();

const activeSpans = new Map<string, WeakRef<SpanContext>>();
const strongSpans = new Map<string, SpanContext>();

let interactionSequence = 0;
let lastInteractionCtx: SpanContext | undefined;
let cleanupIntervalStarted = false;
const SPAN_TTL_MS = 30 * 60 * 1000;

function ensureCleanupInterval(): void {
  if (cleanupIntervalStarted) return;
  cleanupIntervalStarted = true;
  const interval = setInterval(() => {
    const cutoff = Date.now() - SPAN_TTL_MS;
    for (const [spanId, weakRef] of activeSpans) {
      const ctx = weakRef.deref();
      if (ctx === undefined) {
        activeSpans.delete(spanId);
        strongSpans.delete(spanId);
      } else if (ctx.startTime < cutoff) {
        if (!ctx.ended) {
          ctx.ended = true;
          ctx.span.end();
        }
        activeSpans.delete(spanId);
        strongSpans.delete(spanId);
      }
    }
  }, 60_000);
  if (typeof interval.unref === 'function') {
    interval.unref();
  }
}

function getSpanId(span: Span): string {
  return span.spanContext().spanId || '';
}

function getTracer() {
  return trace.getTracer(SERVICE_NAME, '1.0.0');
}

// --- Interaction Spans ---

export function startInteractionSpan(
  config: Config,
  options: StartInteractionOptions,
): void {
  if (!isTelemetrySdkInitialized()) return;

  ensureCleanupInterval();
  interactionSequence++;

  const attributes: Attributes = {
    'session.id': config.getSessionId(),
    'qwen-code.prompt_id': options.promptId,
    'qwen-code.message_type': options.messageType,
    'qwen-code.model': options.model,
    'qwen-code.approval_mode': config.getApprovalMode(),
    'interaction.sequence': interactionSequence,
  };

  const span = getTracer().startSpan(SPAN_INTERACTION, {
    kind: SpanKind.INTERNAL,
    attributes,
  });

  const spanId = getSpanId(span);
  const spanContextObj: SpanContext = {
    span,
    startTime: Date.now(),
    attributes: attributes as Record<string, string | number | boolean>,
    type: 'interaction',
  };
  activeSpans.set(spanId, new WeakRef(spanContextObj));
  strongSpans.set(spanId, spanContextObj);
  lastInteractionCtx = spanContextObj;
  interactionContext.enterWith(spanContextObj);
}

export function endInteractionSpan(
  status: InteractionStatus,
  metadata?: EndInteractionOptions,
): void {
  const spanCtx = interactionContext.getStore() ?? lastInteractionCtx;
  if (!spanCtx || spanCtx.ended) return;

  spanCtx.ended = true;
  lastInteractionCtx = undefined;

  const duration = Date.now() - spanCtx.startTime;
  spanCtx.span.setAttributes({
    'interaction.duration_ms': duration,
    'qwen-code.turn_status': status,
  });

  if (status === 'error') {
    spanCtx.span.setStatus({
      code: SpanStatusCode.ERROR,
      message: metadata?.errorMessage ?? 'unknown error',
    });
  } else {
    spanCtx.span.setStatus({ code: SpanStatusCode.OK });
  }

  spanCtx.span.end();
  const spanId = getSpanId(spanCtx.span);
  activeSpans.delete(spanId);
  strongSpans.delete(spanId);
  interactionContext.enterWith(undefined);
}

// --- LLM Request Spans ---

export function startLLMRequestSpan(model: string, promptId: string): Span {
  if (!isTelemetrySdkInitialized()) {
    return NOOP_SPAN;
  }

  const parentCtx = interactionContext.getStore();
  const ctx = parentCtx
    ? trace.setSpan(otelContext.active(), parentCtx.span)
    : otelContext.active();

  const attributes: Attributes = {
    'qwen-code.model': model,
    'qwen-code.prompt_id': promptId,
    'llm_request.context': parentCtx ? 'interaction' : 'standalone',
  };

  const span = getTracer().startSpan(
    SPAN_LLM_REQUEST,
    { kind: SpanKind.INTERNAL, attributes },
    ctx,
  );

  const spanId = getSpanId(span);
  const spanContextObj: SpanContext = {
    span,
    startTime: Date.now(),
    attributes: attributes as Record<string, string | number | boolean>,
    type: 'llm_request',
  };
  activeSpans.set(spanId, new WeakRef(spanContextObj));
  strongSpans.set(spanId, spanContextObj);

  return span;
}

export function endLLMRequestSpan(
  span: Span,
  metadata?: LLMRequestMetadata,
): void {
  const spanId = getSpanId(span);
  const spanCtx = activeSpans.get(spanId)?.deref();
  if (!spanCtx || spanCtx.ended) return;

  spanCtx.ended = true;

  const duration = metadata?.durationMs ?? Date.now() - spanCtx.startTime;
  const endAttributes: Attributes = { duration_ms: duration };

  if (metadata) {
    if (metadata.inputTokens !== undefined)
      endAttributes['input_tokens'] = metadata.inputTokens;
    if (metadata.outputTokens !== undefined)
      endAttributes['output_tokens'] = metadata.outputTokens;
    endAttributes['success'] = metadata.success;
    if (metadata.error !== undefined) endAttributes['error'] = metadata.error;
  }

  span.setAttributes(endAttributes);

  if (metadata === undefined || metadata.success) {
    span.setStatus({ code: SpanStatusCode.OK });
  } else {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: metadata.error ?? 'unknown error',
    });
  }

  span.end();
  activeSpans.delete(spanId);
  strongSpans.delete(spanId);
}

// --- Tool Spans ---

export function startToolSpan(
  toolName: string,
  attrs?: Record<string, string | number | boolean>,
): Span {
  if (!isTelemetrySdkInitialized()) {
    return NOOP_SPAN;
  }

  const parentCtx = interactionContext.getStore();
  const ctx = parentCtx
    ? trace.setSpan(otelContext.active(), parentCtx.span)
    : otelContext.active();

  const attributes: Attributes = {
    'tool.name': toolName,
    ...attrs,
  };

  const span = getTracer().startSpan(
    SPAN_TOOL,
    { kind: SpanKind.INTERNAL, attributes },
    ctx,
  );

  const spanId = getSpanId(span);
  const spanContextObj: SpanContext = {
    span,
    startTime: Date.now(),
    attributes: attributes as Record<string, string | number | boolean>,
    type: 'tool',
  };
  activeSpans.set(spanId, new WeakRef(spanContextObj));
  strongSpans.set(spanId, spanContextObj);

  return span;
}

export function endToolSpan(span: Span, metadata?: ToolSpanMetadata): void {
  const spanId = getSpanId(span);
  const spanCtx = activeSpans.get(spanId)?.deref();
  if (!spanCtx || spanCtx.ended) return;

  spanCtx.ended = true;

  const duration = Date.now() - spanCtx.startTime;
  const endAttributes: Attributes = { duration_ms: duration };

  if (metadata) {
    if (metadata.success !== undefined)
      endAttributes['success'] = metadata.success;
    if (metadata.error !== undefined) endAttributes['error'] = metadata.error;
  }

  spanCtx.span.setAttributes(endAttributes);

  if (metadata?.success !== false) {
    spanCtx.span.setStatus({ code: SpanStatusCode.OK });
  } else {
    spanCtx.span.setStatus({
      code: SpanStatusCode.ERROR,
      message: metadata?.error ?? 'tool error',
    });
  }

  spanCtx.span.end();
  activeSpans.delete(spanId);
  strongSpans.delete(spanId);
}

// --- Tool Execution Sub-Spans ---

export function startToolExecutionSpan(parentToolSpan: Span): Span {
  if (!isTelemetrySdkInitialized()) {
    return NOOP_SPAN;
  }

  const ctx = trace.setSpan(otelContext.active(), parentToolSpan);

  const span = getTracer().startSpan(
    SPAN_TOOL_EXECUTION,
    { kind: SpanKind.INTERNAL },
    ctx,
  );

  const spanId = getSpanId(span);
  const spanContextObj: SpanContext = {
    span,
    startTime: Date.now(),
    attributes: {},
    type: 'tool.execution',
  };
  activeSpans.set(spanId, new WeakRef(spanContextObj));
  strongSpans.set(spanId, spanContextObj);

  return span;
}

export function endToolExecutionSpan(
  span: Span,
  metadata?: {
    success?: boolean;
    error?: string;
  },
): void {
  const spanId = getSpanId(span);
  const spanCtx = activeSpans.get(spanId)?.deref();
  if (!spanCtx || spanCtx.ended) return;

  spanCtx.ended = true;

  const duration = Date.now() - spanCtx.startTime;
  const endAttributes: Attributes = { duration_ms: duration };

  if (metadata) {
    if (metadata.success !== undefined)
      endAttributes['success'] = metadata.success;
    if (metadata.error !== undefined) endAttributes['error'] = metadata.error;
  }

  spanCtx.span.setAttributes(endAttributes);

  if (metadata?.success !== false) {
    spanCtx.span.setStatus({ code: SpanStatusCode.OK });
  } else {
    spanCtx.span.setStatus({
      code: SpanStatusCode.ERROR,
      message: metadata?.error ?? 'tool execution error',
    });
  }

  spanCtx.span.end();
  activeSpans.delete(spanId);
  strongSpans.delete(spanId);
}

// --- Testing Utilities ---

export function clearSessionTracingForTesting(): void {
  activeSpans.clear();
  strongSpans.clear();
  interactionContext.enterWith(undefined);
  interactionSequence = 0;
  lastInteractionCtx = undefined;
}
