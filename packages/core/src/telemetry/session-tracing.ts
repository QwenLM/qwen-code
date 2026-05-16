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
import { getSessionContext } from './session-context.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('SESSION_TRACING');

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
  type:
    | 'interaction'
    | 'llm_request'
    | 'tool'
    | 'tool.execution'
    | 'tool.blocked_on_user'
    | 'hook';
}

const NOOP_SPAN = trace.wrapSpanContext({
  traceId: '0'.repeat(32),
  spanId: '0'.repeat(16),
  traceFlags: 0,
});

const interactionContext = new AsyncLocalStorage<SpanContext | undefined>();
const toolContext = new AsyncLocalStorage<SpanContext | undefined>();

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
  // Fall back to session root context (deterministic traceId from sessionId)
  // for side-query LLM calls (auto-title, recap, etc.) that run outside an
  // interaction. Without this, those spans start a fresh trace and lose
  // correlation with the session.
  const ctx = parentCtx
    ? trace.setSpan(otelContext.active(), parentCtx.span)
    : (getSessionContext() ?? otelContext.active());

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

  // Use spanCtx.span for mutations to stay consistent with endToolSpan/
  // endToolExecutionSpan. (It's the same object as the passed `span`
  // since we just looked it up by spanId — but matching the lookup
  // pattern across helpers prevents subtle drift if the lookup ever
  // gains caching/normalization.)
  try {
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

    spanCtx.span.setAttributes(endAttributes);

    if (metadata === undefined || metadata.success) {
      spanCtx.span.setStatus({ code: SpanStatusCode.OK });
    } else {
      spanCtx.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: metadata.error ?? 'unknown error',
      });
    }
  } catch (error) {
    debugLogger.warn(
      `Failed to update LLM request span attributes/status: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // span.end() must run even if attribute/status updates threw,
  // otherwise the span leaks (never exported, never cleared from activeSpans).
  try {
    spanCtx.span.end();
  } catch (error) {
    debugLogger.warn(
      `Failed to end LLM request span: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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
  // Same session-root fallback as startLLMRequestSpan.
  const ctx = parentCtx
    ? trace.setSpan(otelContext.active(), parentCtx.span)
    : (getSessionContext() ?? otelContext.active());

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

/**
 * Runs a callback within the tool span's AsyncLocalStorage context AND
 * OpenTelemetry context. Use this instead of enterWith() to scope the
 * context to a single async call tree — safe for concurrent tool calls.
 *
 * Setting the OTel context ensures any nested OTel spans/logs emitted
 * during the callback (HTTP instrumentation, hooks, log-bridge spans)
 * inherit the tool span as parent.
 */
export function runInToolSpanContext<T>(span: Span, fn: () => T): T {
  const spanId = getSpanId(span);
  const spanCtx = activeSpans.get(spanId)?.deref();
  if (!spanCtx) return fn();
  const otelCtxWithSpan = trace.setSpan(otelContext.active(), span);
  return toolContext.run(spanCtx, () => otelContext.with(otelCtxWithSpan, fn));
}

/**
 * When metadata is omitted, span status is NOT set — callers on failure paths
 * must pre-set status via setToolSpanFailure/setToolSpanCancelled before calling
 * this. This asymmetry with endLLMRequestSpan (which defaults to OK) is intentional:
 * tool spans have multiple failure modes that set status before endToolSpan runs.
 */
export function endToolSpan(span: Span, metadata?: ToolSpanMetadata): void {
  const spanId = getSpanId(span);
  const spanCtx = activeSpans.get(spanId)?.deref();
  if (!spanCtx || spanCtx.ended) return;

  spanCtx.ended = true;

  try {
    const duration = Date.now() - spanCtx.startTime;
    const endAttributes: Attributes = { duration_ms: duration };

    if (metadata) {
      if (metadata.success !== undefined)
        endAttributes['success'] = metadata.success;
      if (metadata.error !== undefined) endAttributes['error'] = metadata.error;
    }

    spanCtx.span.setAttributes(endAttributes);

    if (metadata) {
      if (metadata.success !== false) {
        spanCtx.span.setStatus({ code: SpanStatusCode.OK });
      } else {
        spanCtx.span.setStatus({
          code: SpanStatusCode.ERROR,
          message: metadata.error ?? 'tool error',
        });
      }
    }
  } catch (error) {
    debugLogger.warn(
      `Failed to update tool span attributes/status: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // span.end() must run even if attribute/status updates threw.
  try {
    spanCtx.span.end();
  } catch (error) {
    debugLogger.warn(
      `Failed to end tool span: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  activeSpans.delete(spanId);
  strongSpans.delete(spanId);
}

// --- Tool Execution Sub-Spans ---

export function startToolExecutionSpan(): Span {
  if (!isTelemetrySdkInitialized()) {
    return NOOP_SPAN;
  }

  const parentCtx = toolContext.getStore();
  if (!parentCtx) {
    debugLogger.warn(
      'startToolExecutionSpan called outside runInToolSpanContext — span will not be parented to tool span',
    );
  }
  const ctx = parentCtx
    ? trace.setSpan(otelContext.active(), parentCtx.span)
    : (getSessionContext() ?? otelContext.active());

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

  try {
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
  } catch (error) {
    debugLogger.warn(
      `Failed to update tool execution span attributes/status: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // span.end() must run even if attribute/status updates threw.
  try {
    spanCtx.span.end();
  } catch (error) {
    debugLogger.warn(
      `Failed to end tool execution span: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  activeSpans.delete(spanId);
  strongSpans.delete(spanId);
}

// --- Testing Utilities ---

export function clearSessionTracingForTesting(): void {
  activeSpans.clear();
  strongSpans.clear();
  interactionContext.enterWith(undefined);
  toolContext.enterWith(undefined);
  interactionSequence = 0;
  lastInteractionCtx = undefined;
}
