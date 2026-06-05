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
  type Context,
  type Span,
} from '@opentelemetry/api';
import type { Config } from '../config/config.js';
import {
  SERVICE_NAME,
  SPAN_HOOK,
  SPAN_INTERACTION,
  SPAN_LLM_REQUEST,
  SPAN_TOOL,
  SPAN_TOOL_BLOCKED_ON_USER,
  SPAN_TOOL_EXECUTION,
} from './constants.js';
import { clearDetailedSpanState } from './detailed-span-attributes.js';
import { isTelemetrySdkInitialized } from './sdk.js';
import { getSessionContext, setSessionContext } from './session-context.js';
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
  /**
   * Tokens served from the provider's prompt cache (Anthropic
   * cache_read_input_tokens, OpenAI prompt_tokens_details.cached_tokens, etc).
   * Normalized to GenerateContentResponseUsageMetadata.cachedContentTokenCount
   * by each provider generator before reaching LoggingContentGenerator.
   */
  cachedInputTokens?: number;
  success: boolean;
  durationMs?: number;
  error?: string;
  /**
   * Time from the successful attempt's request dispatch to the first stream
   * chunk containing user-visible content (text / functionCall / inlineData /
   * executableCode / thought). Undefined for non-streaming requests, requests
   * aborted before the first user-visible chunk, and any path that does not
   * pass through LoggingContentGenerator's stream wrapper.
   *
   * Semantics: diverges from claude-code's ttftMs (which fires on
   * Anthropic's message_start metadata event). Matches the "time to first
   * actual token" intent of the industry-standard TTFT name.
   * See docs/design/telemetry-llm-request-timing-design.md (D1).
   */
  ttftMs?: number;
  /**
   * Time from `retryWithBackoff` entry to THIS attempt's start (ms). On a
   * successful-attempt span this doubles as the total retry overhead before
   * success. On a failed-attempt span this is the cumulative time elapsed in
   * the retry budget at the moment this attempt fired (= attempts 1..N-1's
   * durations + their backoff sleeps).
   *
   * Undefined when no retry context exists (direct calls bypassing
   * retryWithBackoff: warmup, side-queries, etc.). Populated by the retry
   * layer in Phase 4b via AsyncLocalStorage (`retryContext`).
   */
  requestSetupMs?: number;
  /**
   * 1-based monotonic attempt counter, populated by LoggingContentGenerator
   * from `retryContext.getStore()`. Defaults to 1 when no retry context is
   * present so dashboards filtering `WHERE attempt=1` include direct/warmup
   * calls. Populated by Phase 4b retry layer for attempt >= 2.
   */
  attempt?: number;
  /**
   * Sum of all backoff delays BEFORE this attempt started (ms). 0 for attempt 1.
   * Undefined when no retry context exists. Populated by Phase 4b retry layer.
   */
  retryTotalDelayMs?: number;
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
    // Phase 2 forward-declarations (no start*/end* helpers wired yet —
    // see docs/design/workflow-tracing-gaps.md). Listed here so Phase 2
    // can add helpers without touching this type.
    | 'tool.blocked_on_user'
    | 'hook';
}

/**
 * Resolve the parent OTel Context for a new span.
 *
 * Priority:
 *  1. Explicit parent (from `interactionContext` / `toolContext` ALS) — keeps
 *     the LLM/tool/exec span attached to its logical owner.
 *  2. Currently-active OTel span — preserves the trace tree when an
 *     LLM or tool call is nested inside another span (e.g. subagent inside a
 *     tool, or any nested-tool path) but the ALS parent has already exited.
 *     Without this, the new span re-parents to the synthetic session root and
 *     the trace flattens.
 *  3. Synthetic session-root context — keeps side-query spans (auto-title,
 *     recap, etc.) correlated with the session even when they run outside
 *     any interaction.
 *  4. Active context as a no-op fallback.
 *
 * Mirrors `tracer.ts:getParentContext()` (#4126 review follow-up, #4212).
 *
 * SYNC: keep parent-resolution logic in step with getParentContext() in
 * telemetry/tracer.ts — drift here re-introduces the trace-tree flattening
 * issue #4212 set out to fix (#4302 review).
 */
function resolveParentContext(parent: SpanContext | undefined): Context {
  if (parent) {
    return trace.setSpan(otelContext.active(), parent.span);
  }
  const active = otelContext.active();
  if (trace.getSpan(active)) {
    return active;
  }
  return getSessionContext() ?? active;
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

function sweepStaleSpans(now: number): void {
  const cutoff = now - SPAN_TTL_MS;
  for (const [spanId, weakRef] of activeSpans) {
    const ctx = weakRef.deref();
    if (ctx === undefined) {
      activeSpans.delete(spanId);
      strongSpans.delete(spanId);
    } else if (ctx.startTime < cutoff) {
      if (!ctx.ended) {
        ctx.ended = true;
        // Mark the span so backends can distinguish "abandoned and
        // garbage-collected by the TTL safety net" from "deliberately
        // ended without setting status / attrs" (#4321 review).
        const ageMs = now - ctx.startTime;
        const toolName = ctx.attributes['tool.name'];
        const callId = ctx.attributes['tool.call_id'];
        // setAttributes and span.end() are wrapped separately so a
        // setAttributes throw can't prevent the span from being ended
        // (#4321 review-3 wenshao Suggestion). For blocked_on_user
        // spans, also stamp the canonical decision/source taxonomy so
        // dashboards filtering by `decision: 'aborted'` count
        // walk-aways consistently with explicit user aborts.
        try {
          ctx.span.setAttributes({
            'qwen-code.span.ttl_expired': true,
            'qwen-code.span.duration_ms': ageMs,
            ...(ctx.type === 'tool.blocked_on_user'
              ? {
                  decision: 'aborted',
                  source: 'system',
                }
              : {}),
          });
        } catch (error) {
          // OTel errors must not prevent span.end() from running, but
          // they're worth surfacing — dropping the sentinel attrs makes
          // a TTL-aborted span look identical to a deliberately-UNSET
          // one in dashboards (#4321 review-7 silent-failure-hunter).
          debugLogger.warn(
            `Failed to stamp TTL attrs on stale span ${spanId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        // Include tool name + call_id so the log is actionable in
        // production without a trace-backend lookup (review-3).
        const ctxLabel =
          toolName && callId
            ? `${ctx.type} (tool.name=${toolName}, tool.call_id=${callId})`
            : ctx.type;
        debugLogger.warn(
          `Stale ${ctxLabel} span ended by TTL safety net (age=${ageMs}ms, spanId=${spanId})`,
        );
        try {
          ctx.span.end();
        } catch (error) {
          debugLogger.warn(
            `Failed to end stale span ${spanId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      activeSpans.delete(spanId);
      strongSpans.delete(spanId);
    }
  }
}

function ensureCleanupInterval(): void {
  if (cleanupIntervalStarted) return;
  cleanupIntervalStarted = true;
  const interval = setInterval(() => sweepStaleSpans(Date.now()), 60_000);
  if (typeof interval.unref === 'function') {
    interval.unref();
  }
}

function getSpanId(span: Span): string {
  return span.spanContext().spanId || '';
}

const SPAN_ERROR_MAX_CHARS = 1024;

/**
 * Bound the size of error strings written to span attributes / status
 * messages. Hook server responses, raw exception stacks, or malicious
 * inputs can be unbounded; some OTel backends drop the entire span when
 * any field exceeds their limit (#4321 review-3 wenshao Critical).
 *
 * Truncates by UTF-16 code units (`String.length`/`String.slice`), not
 * bytes — for ASCII-heavy text this approximates a 1KB byte limit, but
 * CJK/emoji-heavy errors can land in the ~2-3KB range after UTF-8
 * encoding. That's still well under all major OTel backends'
 * per-attribute limits (Jaeger ~64KB, Honeycomb ~64KB, OTLP default
 * ~32KB), so we keep the simpler char-count bound rather than paying
 * the encoder cost on every endXSpan (review-4 follow-up).
 */
export function truncateSpanError(s: string): string {
  if (s.length <= SPAN_ERROR_MAX_CHARS) return s;
  // Back up one code unit if the cut lands on a high surrogate so we
  // don't emit a lone surrogate followed by the sentinel — strict
  // OTLP/gRPC collectors reject span batches with invalid UTF-8
  // (a lone high surrogate encodes to an invalid byte sequence)
  // (#4321 review-8 wenshao Suggestion).
  let end = SPAN_ERROR_MAX_CHARS;
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return s.slice(0, end) + '…[truncated]';
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

  // Pin to session root directly — resolveParentContext() would prefer
  // any active OTel span, but interaction is a turn boundary (#4486).
  const sessionCtx = getSessionContext() ?? otelContext.active();
  const span = getTracer().startSpan(
    SPAN_INTERACTION,
    { kind: SpanKind.INTERNAL, attributes },
    sessionCtx,
  );

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
  // resolveParentContext() also re-parents to the active OTel span when
  // present, so a side-query LLM call nested inside a tool span still
  // attaches to the tool span instead of skipping back to the session root.
  const ctx = resolveParentContext(parentCtx);

  const attributes: Attributes = {
    'qwen-code.model': model,
    'qwen-code.prompt_id': promptId,
    'llm_request.context': parentCtx ? 'interaction' : 'standalone',
    // Dual-emit OTel GenAI semantic convention (Stable). Private name
    // (qwen-code.model) remains authoritative; gen_ai.* is a compat layer
    // for spec-aware backends. See docs/design/telemetry-llm-request-timing-design.md (D8).
    'gen_ai.request.model': model,
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
      if (metadata.inputTokens !== undefined) {
        endAttributes['input_tokens'] = metadata.inputTokens;
        // Dual-emit OTel GenAI semconv (Stable). Private name stays authoritative.
        endAttributes['gen_ai.usage.input_tokens'] = metadata.inputTokens;
      }
      if (metadata.outputTokens !== undefined) {
        endAttributes['output_tokens'] = metadata.outputTokens;
        endAttributes['gen_ai.usage.output_tokens'] = metadata.outputTokens;
      }
      if (metadata.cachedInputTokens !== undefined) {
        endAttributes['cached_input_tokens'] = metadata.cachedInputTokens;
        // Dual-emit OTel GenAI semconv (Experimental — may rename before Stable).
        endAttributes['gen_ai.usage.cached_tokens'] =
          metadata.cachedInputTokens;
      }
      if (metadata.ttftMs !== undefined) {
        endAttributes['ttft_ms'] = metadata.ttftMs;
        // Dual-emit OTel GenAI semconv (Experimental). Spec unit is seconds-as-double.
        endAttributes['gen_ai.server.time_to_first_token'] =
          metadata.ttftMs / 1000;
      }
      if (metadata.requestSetupMs !== undefined) {
        endAttributes['request_setup_ms'] = metadata.requestSetupMs;
      }
      if (metadata.attempt !== undefined) {
        endAttributes['attempt'] = metadata.attempt;
      }
      if (metadata.retryTotalDelayMs !== undefined) {
        endAttributes['retry_total_delay_ms'] = metadata.retryTotalDelayMs;
      }
      // Derived: sampling_ms = time from first user-visible chunk to end
      // (== output generation time for THIS attempt).
      //
      // NOTE on Phase 4a bug fix: previous formula `duration - ttft - setup`
      // double-counted the setup time. `duration_ms` is computed as
      // `Date.now() - spanCtx.startTime`, and startTime is captured when
      // `startLLMRequestSpan` runs — which is AFTER `requestSetupMs` worth of
      // overhead has already passed. So the span's `duration_ms` only covers
      // `ttft + sampling`, never the preceding setup. Subtracting `setup` again
      // is wrong. In Phase 4a, `requestSetupMs` was always undefined so the
      // bug was masked (0 subtraction). Phase 4b populates `requestSetupMs`
      // with cumulative retry overhead, which would have clamped sampling_ms
      // to 0 for every retried request — wiping out output-throughput data
      // exactly when operators need it most. Fixed here.
      if (metadata.ttftMs !== undefined) {
        const samplingMs = Math.max(0, duration - metadata.ttftMs);
        endAttributes['sampling_ms'] = samplingMs;
        // Derived: output tokens per second during sampling. Undefined when
        // sampling_ms is 0 (avoid divide-by-zero) or when outputTokens missing.
        if (samplingMs > 0 && metadata.outputTokens !== undefined) {
          endAttributes['output_tokens_per_second'] =
            Math.round((metadata.outputTokens / (samplingMs / 1000)) * 100) /
            100;
        }
      }
      endAttributes['success'] = metadata.success;
      if (metadata.error !== undefined)
        endAttributes['error'] = truncateSpanError(metadata.error);
    }

    spanCtx.span.setAttributes(endAttributes);

    if (metadata === undefined || metadata.success) {
      spanCtx.span.setStatus({ code: SpanStatusCode.OK });
    } else {
      spanCtx.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: metadata.error
          ? truncateSpanError(metadata.error)
          : 'unknown error',
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
  // Same fallback as startLLMRequestSpan: prefer active OTel span for
  // tools-inside-tools cases before falling back to the session root.
  const ctx = resolveParentContext(parentCtx);

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
      if (metadata.error !== undefined)
        endAttributes['error'] = truncateSpanError(metadata.error);
    }

    spanCtx.span.setAttributes(endAttributes);

    if (metadata) {
      if (metadata.success !== false) {
        spanCtx.span.setStatus({ code: SpanStatusCode.OK });
      } else {
        spanCtx.span.setStatus({
          code: SpanStatusCode.ERROR,
          message: metadata.error
            ? truncateSpanError(metadata.error)
            : 'tool error',
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
  // Without an explicit toolContext parent we still try the active OTel span
  // (some tool execution paths run inside a withSpan() block from another
  // subsystem) before falling back to the session root.
  const ctx = resolveParentContext(parentCtx);

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
    /**
     * Mark the execution as user-cancelled: success/error attributes are
     * still recorded but status stays UNSET, mirroring setToolSpanCancelled
     * on the parent tool span. Without this, success: false unconditionally
     * sets ERROR and trace backends filtering for errors false-positive on
     * user cancels (#4302 review).
     */
    cancelled?: boolean;
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
      if (metadata.error !== undefined)
        endAttributes['error'] = truncateSpanError(metadata.error);
    }

    spanCtx.span.setAttributes(endAttributes);

    // No-metadata-no-status: matches endToolSpan. Callers that pre-set
    // status (e.g. via setToolSpanCancelled) and then call this without
    // metadata get their pre-set status preserved. Cancellation also
    // preserves UNSET so the child agrees with the cancelled parent.
    if (metadata && !metadata.cancelled) {
      if (metadata.success !== false) {
        spanCtx.span.setStatus({ code: SpanStatusCode.OK });
      } else {
        spanCtx.span.setStatus({
          code: SpanStatusCode.ERROR,
          message: metadata.error
            ? truncateSpanError(metadata.error)
            : 'tool execution error',
        });
      }
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

// --- Tool Blocked-on-User Spans ---

export type ToolBlockedDecision =
  | 'proceed_once'
  | 'proceed_always'
  | 'cancel'
  | 'aborted'
  | 'auto_approved'
  // System-error close — distinct from user 'cancel' so dashboards counting
  // user cancels don't double-count thrown exceptions in the approval path.
  | 'error';

export type ToolBlockedSource = 'cli' | 'ide' | 'hook' | 'auto' | 'system';

/**
 * Brackets the time a tool spends in `awaiting_approval` waiting on the user.
 *
 * The parent is passed explicitly because this span starts BEFORE the tool
 * body's `runInToolSpanContext` block — so `toolContext.getStore()` is empty.
 * Passing the span object also avoids the `findLast`-by-type concurrency bug
 * (claude-code's sessionTracing has it; we deliberately don't).
 */
export function startToolBlockedOnUserSpan(
  toolSpan: Span,
  attrs?: { tool_name?: string; call_id?: string },
): Span {
  if (!isTelemetrySdkInitialized()) {
    return NOOP_SPAN;
  }
  // Idempotent — kick off the 30-min TTL cleanup in case this span is
  // started in a code path where no interaction span has been created
  // yet (sub-agent tool calls, side queries, future patterns).
  ensureCleanupInterval();

  const parentSpanId = getSpanId(toolSpan);
  const parentSpanCtx = activeSpans.get(parentSpanId)?.deref();
  // If the tool span was already ended (defensive — shouldn't happen on the
  // happy path), fall back to the standard parent-resolution chain so we
  // still produce a span correlated with the session.
  if (!parentSpanCtx) {
    debugLogger.debug(
      'startToolBlockedOnUserSpan: tool span not in activeSpans (already ended?) — using resolveParentContext fallback',
    );
  }
  const ctx = parentSpanCtx
    ? trace.setSpan(otelContext.active(), parentSpanCtx.span)
    : resolveParentContext(undefined);

  const attributes: Attributes = {};
  if (attrs?.tool_name !== undefined) attributes['tool.name'] = attrs.tool_name;
  if (attrs?.call_id !== undefined) attributes['tool.call_id'] = attrs.call_id;

  const span = getTracer().startSpan(
    SPAN_TOOL_BLOCKED_ON_USER,
    { kind: SpanKind.INTERNAL, attributes },
    ctx,
  );

  const spanId = getSpanId(span);
  const spanContextObj: SpanContext = {
    span,
    startTime: Date.now(),
    attributes: attributes as Record<string, string | number | boolean>,
    type: 'tool.blocked_on_user',
  };
  activeSpans.set(spanId, new WeakRef(spanContextObj));
  strongSpans.set(spanId, spanContextObj);

  return span;
}

/**
 * Status stays UNSET — waiting on the user is neither OK nor ERROR.
 * The decision/source attributes are the canonical signal.
 */
export function endToolBlockedOnUserSpan(
  span: Span,
  metadata?: {
    decision?: ToolBlockedDecision;
    source?: ToolBlockedSource;
  },
): void {
  const spanId = getSpanId(span);
  const spanCtx = activeSpans.get(spanId)?.deref();
  if (!spanCtx || spanCtx.ended) return;

  spanCtx.ended = true;

  try {
    const duration = Date.now() - spanCtx.startTime;
    const endAttributes: Attributes = { duration_ms: duration };
    if (metadata?.decision !== undefined)
      endAttributes['decision'] = metadata.decision;
    if (metadata?.source !== undefined)
      endAttributes['source'] = metadata.source;
    spanCtx.span.setAttributes(endAttributes);
  } catch (error) {
    debugLogger.warn(
      `Failed to update blocked_on_user span attributes: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    spanCtx.span.end();
  } catch (error) {
    debugLogger.warn(
      `Failed to end blocked_on_user span: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  activeSpans.delete(spanId);
  strongSpans.delete(spanId);
}

// --- Hook Spans ---

export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'PostToolBatch';

export interface StartHookSpanOptions {
  hookEvent: HookEvent;
  toolName: string;
  toolUseId?: string;
  /** PostToolUseFailure only: true when the failure is a user interrupt. */
  isInterrupt?: boolean;
}

export interface HookSpanMetadata {
  /** Whether the hook fire site completed without throwing. */
  success?: boolean;
  /** PreToolUse: false means the hook blocked tool execution. */
  shouldProceed?: boolean;
  /** PostToolUse: true means the hook stopped further processing. */
  shouldStop?: boolean;
  /** Discriminator for blocking decision when applicable. */
  blockType?: 'denied' | 'ask' | 'stop';
  hasAdditionalContext?: boolean;
  /** PostToolBatch only: true when the batch hook stopped before the next turn. */
  postBatchStop?: boolean;
  /** PostToolBatch only: reason attached to a stop decision. */
  postBatchStopReason?: string;
  /** Hook threw — span ends as ERROR with this message. */
  error?: string;
}

export function startHookSpan(opts: StartHookSpanOptions): Span {
  if (!isTelemetrySdkInitialized()) {
    return NOOP_SPAN;
  }
  // Same defensive cleanup-interval kick as startToolBlockedOnUserSpan —
  // hook spans may run before any interaction span has been created.
  ensureCleanupInterval();

  // Hooks fire from inside `runInToolSpanContext` so toolContext is the
  // natural parent. resolveParentContext also covers the rare case where a
  // hook span is started outside any tool (defensive — keeps the trace tree
  // correlated with the session).
  const parentCtx =
    toolContext.getStore() ?? interactionContext.getStore() ?? undefined;
  const ctx = resolveParentContext(parentCtx);

  const attributes: Attributes = {
    hook_event: opts.hookEvent,
    'tool.name': opts.toolName,
  };
  if (opts.toolUseId !== undefined) attributes['tool.use_id'] = opts.toolUseId;
  if (opts.isInterrupt !== undefined)
    attributes['is_interrupt'] = opts.isInterrupt;

  const span = getTracer().startSpan(
    SPAN_HOOK,
    { kind: SpanKind.INTERNAL, attributes },
    ctx,
  );

  const spanId = getSpanId(span);
  const spanContextObj: SpanContext = {
    span,
    startTime: Date.now(),
    attributes: attributes as Record<string, string | number | boolean>,
    type: 'hook',
  };
  activeSpans.set(spanId, new WeakRef(spanContextObj));
  strongSpans.set(spanId, spanContextObj);

  return span;
}

/**
 * Status: UNSET on normal flow (including blocking decisions like
 * shouldProceed: false or shouldStop: true — those are intentional, not
 * errors). Only an actual hook-side throw (caught by the safelyFire wrapper
 * or rethrown) maps to ERROR via the `error` metadata field.
 */
export function endHookSpan(span: Span, metadata?: HookSpanMetadata): void {
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
      if (metadata.shouldProceed !== undefined)
        endAttributes['should_proceed'] = metadata.shouldProceed;
      if (metadata.shouldStop !== undefined)
        endAttributes['should_stop'] = metadata.shouldStop;
      if (metadata.blockType !== undefined)
        endAttributes['block_type'] = metadata.blockType;
      if (metadata.hasAdditionalContext !== undefined)
        endAttributes['has_additional_context'] = metadata.hasAdditionalContext;
      if (metadata.postBatchStop !== undefined)
        endAttributes['post_batch_stop'] = metadata.postBatchStop;
      if (metadata.postBatchStopReason !== undefined)
        endAttributes['post_batch_stop_reason'] = truncateSpanError(
          metadata.postBatchStopReason,
        );
      if (metadata.error !== undefined)
        endAttributes['error'] = truncateSpanError(metadata.error);
    }

    spanCtx.span.setAttributes(endAttributes);

    if (metadata?.error !== undefined) {
      spanCtx.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: truncateSpanError(metadata.error),
      });
    }
  } catch (error) {
    debugLogger.warn(
      `Failed to update hook span attributes/status: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    spanCtx.span.end();
  } catch (error) {
    debugLogger.warn(
      `Failed to end hook span: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  activeSpans.delete(spanId);
  strongSpans.delete(spanId);
}

// --- Interaction Span Attribute Access ---

export function getActiveInteractionSpan(): Span | undefined {
  const ctx = interactionContext.getStore() ?? lastInteractionCtx;
  if (!ctx || ctx.ended) return undefined;
  return ctx.span;
}

// --- Testing Utilities ---

export function clearSessionTracingForTesting(): void {
  activeSpans.clear();
  strongSpans.clear();
  interactionContext.enterWith(undefined);
  toolContext.enterWith(undefined);
  interactionSequence = 0;
  lastInteractionCtx = undefined;
  clearDetailedSpanState();
  // Reach into session-context module to prevent cross-test leakage (#4486).
  setSessionContext(undefined);
}

/**
 * Test-only: invoke the TTL sweep with a synthetic `now`. Lets tests
 * exercise the stale-span path without waiting 30 minutes or stubbing
 * setInterval globally.
 */
export function runTTLSweepForTesting(now: number): void {
  sweepStaleSpans(now);
}
