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
  SPAN_SUBAGENT,
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
   * Time from generateContent/generateContentStream entry to the start of the
   * successful attempt (ms). Includes all failed retries + backoff sleeps.
   * Populated by the retry layer in Phase 4b; undefined in Phase 4a.
   */
  requestSetupMs?: number;
  /**
   * Final attempt number (1-based). 1 = no retries. Populated by the retry
   * layer in Phase 4b; undefined in Phase 4a.
   */
  attempt?: number;
  /**
   * Sum of all backoff delays before the successful attempt (ms). 0 if no
   * retries occurred. Populated by the retry layer in Phase 4b; undefined
   * in Phase 4a.
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
    | 'tool.blocked_on_user'
    | 'hook'
    // Phase 3: single subagent invocation. Hosts the LLM/tool/hook subtree
    // emitted by the subagent so concurrent subagents don't interleave
    // (#3731 Phase 3; see docs/design/telemetry-subagent-spans-design.md).
    | 'subagent';
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
/**
 * ALS for the active `qwen-code.subagent` span. Child LLM/tool/hook spans
 * created inside a subagent body read this BEFORE interactionContext so
 * they parent under the subagent (not the outer interaction). Without
 * this, foreground subagent spans are empty shells: `resolveParentContext`
 * picks `interactionContext.getStore()` whenever it is non-null — which is
 * always true during foreground execution — and re-parents every child
 * span back to the interaction, bypassing the subagent span entirely.
 * Review wenshao @ #4410.
 */
const subagentContext = new AsyncLocalStorage<SpanContext | undefined>();

const activeSpans = new Map<string, WeakRef<SpanContext>>();
const strongSpans = new Map<string, SpanContext>();

let interactionSequence = 0;
let lastInteractionCtx: SpanContext | undefined;
let cleanupIntervalStarted = false;
const SPAN_TTL_MS_DEFAULT = 30 * 60 * 1000; //   30 min — user walk-away
const SPAN_TTL_MS_LONG = 4 * 60 * 60 * 1000; //   4 h  — long fire-and-forget subagent

/**
 * Invocation kinds that legitimately run for hours and need the long TTL.
 * New kinds added to `SubagentInvocationKind` silently fall through to
 * the 30-min default (Set.has() returns false) — widen this Set only
 * after confirming the new kind legitimately needs 4h+ TTL.
 */
const LONG_TTL_SUBAGENT_KINDS = new Set<SubagentInvocationKind>([
  'fork',
  'background',
]);

/**
 * TTL per span type. Default is 30 min — picked for `tool.blocked_on_user`
 * (user think-time). Subagent fork/background invocations can legitimately
 * run hours (large analysis, slow builds, deep research), so they need a
 * wider safety-net window (#3731 Phase 3). Foreground subagents stay at
 * the default TTL — those are bound to the user-facing request and should
 * never legitimately exceed the default window.
 *
 * KNOWN LIMITATION (deferred): only the subagent span itself gets the long
 * TTL. Child LLM/tool/hook spans emitted inside a 2-hour background agent
 * still use the 30-min default, so the trace can show a gap (early child
 * spans swept at 30 min, later child spans present). Fixing this needs
 * either ALS propagation of the "long TTL bucket" into resolveParentContext
 * or a TTL-inheritance walk at sweep time — both warrant a follow-up PR.
 * See wenshao @ #4410 review.
 */
function ttlFor(ctx: SpanContext): number {
  if (ctx.type === 'subagent') {
    const kind = ctx.attributes['qwen-code.subagent.invocation_kind'];
    if (
      typeof kind === 'string' &&
      LONG_TTL_SUBAGENT_KINDS.has(kind as SubagentInvocationKind)
    ) {
      return SPAN_TTL_MS_LONG;
    }
  }
  return SPAN_TTL_MS_DEFAULT;
}

function sweepStaleSpans(now: number): void {
  for (const [spanId, weakRef] of activeSpans) {
    const ctx = weakRef.deref();
    if (ctx === undefined) {
      activeSpans.delete(spanId);
      strongSpans.delete(spanId);
      continue;
    }
    if (now - ctx.startTime < ttlFor(ctx)) continue;

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
      // (#4321 review-3 wenshao Suggestion). Type-specific stamps:
      //  - blocked_on_user: canonical decision/source so dashboards
      //    counting `decision: 'aborted'` cover walk-aways.
      //  - subagent: status='aborted' + terminate_reason='ttl_swept'
      //    so subagent dashboards see ttl-victims as distinct from
      //    user-cancelled / failed (#3731 Phase 3).
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
          ...(ctx.type === 'subagent'
            ? {
                'qwen-code.subagent.status': 'aborted',
                'qwen-code.subagent.terminate_reason': 'ttl_swept',
                // Mirror the subagent-specific duration_ms key that
                // endSubagentSpan stamps so dashboards querying that
                // namespace see TTL-swept spans too (they currently
                // only get the generic qwen-code.span.duration_ms
                // above). wenshao @ #4410.
                'qwen-code.subagent.duration_ms': ageMs,
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
  if (!spanCtx) return;
  if (spanCtx.ended) {
    debugLogger.debug(
      `endInteractionSpan: span ${getSpanId(spanCtx.span)} already ended (possible TTL sweep race)`,
    );
    return;
  }

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

  // Prefer subagentContext over interactionContext so LLM spans inside a
  // foreground subagent nest under the subagent span instead of escaping
  // back to the outer interaction. wenshao @ #4410.
  const parentCtx = subagentContext.getStore() ?? interactionContext.getStore();
  // resolveParentContext() also re-parents to the active OTel span when
  // present, so a side-query LLM call nested inside a tool span still
  // attaches to the tool span instead of skipping back to the session root.
  const ctx = resolveParentContext(parentCtx);

  // Tri-state so subagent-parented LLM calls don't get mis-classified as
  // "interaction" in dashboards. wenshao @ #4410.
  const attributes: Attributes = {
    'qwen-code.model': model,
    'qwen-code.prompt_id': promptId,
    'llm_request.context': subagentContext.getStore()
      ? 'subagent'
      : interactionContext.getStore()
        ? 'interaction'
        : 'standalone',
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
  if (!spanCtx) return;
  if (spanCtx.ended) {
    debugLogger.debug(
      `endLLMRequestSpan: span ${spanId} already ended (possible TTL sweep race)`,
    );
    return;
  }

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
      // (== output generation time, excluding setup + first-token delay).
      // Computable only when ttftMs is set. requestSetupMs defaults to 0
      // when undefined (no retries) — this gives the correct sampling
      // duration in both Phase 4a (no retry data) and Phase 4b (with).
      if (metadata.ttftMs !== undefined) {
        const samplingMs = Math.max(
          0,
          duration - metadata.ttftMs - (metadata.requestSetupMs ?? 0),
        );
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

  // Prefer subagentContext over interactionContext (see startLLMRequestSpan
  // for rationale; wenshao @ #4410).
  const parentCtx = subagentContext.getStore() ?? interactionContext.getStore();
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
  if (!spanCtx) return;
  if (spanCtx.ended) {
    debugLogger.debug(
      `endToolSpan: span ${spanId} already ended (possible TTL sweep race)`,
    );
    return;
  }

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
  if (!spanCtx) return;
  if (spanCtx.ended) {
    debugLogger.debug(
      `endToolExecutionSpan: span ${spanId} already ended (possible TTL sweep race)`,
    );
    return;
  }

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
  if (!spanCtx) return;
  if (spanCtx.ended) {
    debugLogger.debug(
      `endToolBlockedOnUserSpan: span ${spanId} already ended (possible TTL sweep race)`,
    );
    return;
  }

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

export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure';

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
  // correlated with the session). subagentContext sits between tool and
  // interaction so hooks fired inside a subagent but outside any tool
  // still nest under the subagent. wenshao @ #4410.
  const parentCtx =
    toolContext.getStore() ??
    subagentContext.getStore() ??
    interactionContext.getStore() ??
    undefined;
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
  if (!spanCtx) return;
  if (spanCtx.ended) {
    debugLogger.debug(
      `endHookSpan: span ${spanId} already ended (possible TTL sweep race)`,
    );
    return;
  }

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

// --- Subagent Spans (#3731 Phase 3) ---

export type SubagentInvocationKind = 'foreground' | 'fork' | 'background';

export type SubagentStatus = 'completed' | 'failed' | 'cancelled' | 'aborted';

export interface StartSubagentSpanOptions {
  /** Unique identifier for this subagent invocation (e.g. `Explore-abc123`). */
  agentId: string;
  /** Human-readable subagent type (e.g. `Explore`, `code-reviewer`, `fork`). */
  subagentName: string;
  invocationKind: SubagentInvocationKind;
  isBuiltIn: boolean;
  /** Parent agent's id, when this subagent is nested inside another. */
  parentAgentId?: string;
  /** 0 for top-level subagent, +1 per nesting. */
  depth: number;
  /** Parent's request id (for cross-trace correlation with parent prompt). */
  invokingRequestId?: string;
  /** Session id — set as both `gen_ai.conversation.id` and vendor key. */
  sessionId: string;
  /** Model override, if this subagent runs on a different model than parent. */
  modelOverride?: string;
  /**
   * For `fork` / `background` invocations: span context of the invoking
   * span (the parent AGENT tool span). Used as the `Link` source so the
   * new-traceId root can be navigated back to the invoker. Ignored for
   * `foreground` (inherits via context.active()).
   */
  invokerSpanContext?: import('@opentelemetry/api').SpanContext;
}

export interface SubagentSpanMetadata {
  status: SubagentStatus;
  /** Free-form reason (e.g. `task_complete`, `max_iterations`, `user_abort`, `ttl_swept`). */
  terminateReason?: string;
  /** Whether the subagent produced any result text. Bounded boolean (no payload). */
  resultSummaryPresent?: boolean;
  /** Truncated via {@link truncateSpanError} before write. */
  error?: string;
  /** Error class name (e.g. `Error`, `AbortError`). */
  errorType?: string;
}

/**
 * Open a subagent span.
 *
 * - `foreground` invocations become children of the currently-active span
 *   (typically the AGENT tool span), inheriting its traceId.
 * - `fork` / `background` invocations become linked-root spans — new traceId,
 *   with an OTel {@link Link} pointing at `invokerSpanContext`. The OTel
 *   spec explicitly recommends Link for "long running asynchronous data
 *   processing operation that was initiated by [a] fast incoming request"
 *   (`https://opentelemetry.io/docs/specs/otel/overview/#links-between-spans`).
 *   Fire-and-forget subagents run for minutes-to-hours and would otherwise
 *   inflate the parent trace's duration / span count beyond several
 *   backends' caps (e.g. LangSmith's 25k-run cap per trace).
 *
 * Dual-emits the OTel GenAI spec attrs (`gen_ai.agent.id`, `gen_ai.agent.name`,
 * `gen_ai.conversation.id`) alongside vendor `qwen-code.subagent.*` keys.
 * Spec is in Development status — dual-emit lets dashboards transition once
 * the spec stabilises; drop the vendor key in a follow-up.
 */
export function startSubagentSpan(opts: StartSubagentSpanOptions): Span {
  if (!isTelemetrySdkInitialized()) return NOOP_SPAN;

  ensureCleanupInterval();

  const attributes: Attributes = {
    // Spec-aligned (OTel GenAI Agent Spans, Development status).
    'gen_ai.operation.name': 'invoke_agent',
    'gen_ai.provider.name': SERVICE_NAME,
    'gen_ai.agent.id': opts.agentId,
    'gen_ai.agent.name': opts.subagentName,
    'gen_ai.conversation.id': opts.sessionId,

    // Vendor (qwen-code-specific). Dual-emit id/name so dashboards already
    // querying spec keys still work.
    'qwen-code.subagent.id': opts.agentId,
    'qwen-code.subagent.name': opts.subagentName,
    'qwen-code.subagent.invocation_kind': opts.invocationKind,
    'qwen-code.subagent.is_built_in': opts.isBuiltIn,
    'qwen-code.subagent.depth': opts.depth,
  };

  if (opts.modelOverride !== undefined) {
    attributes['gen_ai.request.model'] = opts.modelOverride;
  }
  if (opts.parentAgentId !== undefined) {
    attributes['qwen-code.subagent.parent_agent_id'] = opts.parentAgentId;
  }
  if (opts.invokingRequestId !== undefined) {
    attributes['qwen-code.subagent.invoking_request_id'] =
      opts.invokingRequestId;
  }

  const tracer = getTracer();

  let span: Span;
  if (opts.invocationKind === 'foreground') {
    // Child of current active span — caller's tool span via context.active().
    span = tracer.startSpan(SPAN_SUBAGENT, {
      kind: SpanKind.INTERNAL,
      attributes,
    });
  } else {
    // fork / background: linked root span. `root: true` forces a new traceId
    // ignoring any active context; Link points back to the invoker so
    // operators can navigate cross-trace.
    span = tracer.startSpan(SPAN_SUBAGENT, {
      kind: SpanKind.INTERNAL,
      attributes,
      root: true,
      links: opts.invokerSpanContext
        ? [
            {
              context: opts.invokerSpanContext,
              attributes: { 'qwen-code.link.kind': 'invoker' },
            },
          ]
        : undefined,
    });
  }

  const spanId = getSpanId(span);
  const spanContextObj: SpanContext = {
    span,
    startTime: Date.now(),
    attributes: attributes as Record<string, string | number | boolean>,
    type: 'subagent',
  };
  activeSpans.set(spanId, new WeakRef(spanContextObj));
  strongSpans.set(spanId, spanContextObj);
  return span;
}

/**
 * Run `fn` with `span` set as the active OTel span. Child LLM / tool /
 * hook spans created inside `fn` will see `span` as parent via
 * `context.active()` and inherit its traceId. Required for fork /
 * background paths so child spans don't escape into the ambient context
 * after the caller's AgentTool.execute has already returned.
 *
 * **Side effects (intentional, callers should be aware):**
 *
 *  - Enters `subagentContext` ALS for the body's duration so
 *    `startLLMRequestSpan` / `startToolSpan` / `startHookSpan` prefer
 *    this subagent over the outer interaction as the parent.
 *  - **Clears `toolContext`** for the body's duration. Any code that
 *    reads `toolContext` inside the subagent body BEFORE the first
 *    inner tool call will see `undefined`. The subagent's own inner
 *    tools re-set `toolContext` via `runInToolSpanContext`, so
 *    inner-tool parenting remains correct. This is required so hooks
 *    fired inside a subagent body (e.g. SubagentStart) don't
 *    incorrectly parent under the outer AGENT tool span (#4410
 *).
 *
 * Mirrors opencode's `withRunSpan` pattern.
 */
export function runInSubagentSpanContext<T>(
  span: Span,
  fn: () => Promise<T>,
): Promise<T> {
  // Skip the context wrapping when telemetry is off / span is untracked
  // (startSubagentSpan returns NOOP_SPAN, which is never added to
  // activeSpans). Mirrors runInToolSpanContext's pattern — avoids paying
  // an AsyncLocalStorage.run() per invocation just to wrap a noop span.
  // Review wenshao @ #4410.
  const spanId = getSpanId(span);
  const spanCtx = activeSpans.get(spanId)?.deref();
  if (!spanCtx) return fn();
  // Enter subagentContext so child startLLMRequestSpan/startToolSpan/
  // startHookSpan calls inside the body parent under this subagent
  // instead of escaping back to the outer interactionContext.
  // wenshao @ #4410.
  //
  // Also clear `toolContext` for the body's duration. `startHookSpan`'s
  // parent priority is `tool > subagent > interaction`, and the AGENT
  // tool's own toolContext is still in scope here — without clearing it,
  // hooks fired inside the subagent body (e.g. SubagentStart, before any
  // inner tool call) would parent to the outer AGENT tool span instead
  // of the subagent. The subagent's own inner tools will re-set
  // toolContext via runInToolSpanContext, so inner-tool parenting stays
  // correct. wenshao @ #4410.
  const otelCtxWithSpan = trace.setSpan(otelContext.active(), span);
  return subagentContext.run(spanCtx, () =>
    toolContext.run(undefined, () => otelContext.with(otelCtxWithSpan, fn)),
  );
}

/**
 * Finalize a subagent span. Status mapping:
 *  - `completed` → SpanStatus OK
 *  - `failed`    → SpanStatus ERROR, sets `exception.message` + `error.type`
 *  - `cancelled` / `aborted` → SpanStatus UNSET (matches Phase 2 cancellation)
 *
 * Idempotent: second call on the same span is a no-op.
 */
export function endSubagentSpan(
  span: Span,
  metadata: SubagentSpanMetadata,
): void {
  const spanId = getSpanId(span);
  const spanCtx = activeSpans.get(spanId)?.deref();
  // Surface the silent-skip case so a TTL-sweep race that loses the real
  // terminal state is observable in production. Without this, a fork that
  // legitimately finishes a few seconds past 4h has its `'completed'`
  // outcome silently overwritten by the sweep's `'aborted'/'ttl_swept'`
  // stamp with no log trail. Review wenshao @ #4410.
  //
  // Gate on `isTelemetrySdkInitialized()` so the warn doesn't fire on
  // every subagent invocation when telemetry is OFF: in that case
  // `startSubagentSpan` returns NOOP_SPAN which was never registered in
  // `activeSpans`, so `!spanCtx` is the normal teardown — not a race.
  // Review wenshao @ #4410 + own silent-failure
  // hunter follow-up.
  if (!spanCtx) {
    if (isTelemetrySdkInitialized()) {
      debugLogger.warn(
        `endSubagentSpan: span ${spanId} not found in activeSpans (already swept?) — intended status=${metadata.status}, reason=${metadata.terminateReason ?? 'none'}`,
      );
    }
    return;
  }
  if (spanCtx.ended) {
    debugLogger.warn(
      `endSubagentSpan: span ${spanId} already ended — intended status=${metadata.status}, reason=${metadata.terminateReason ?? 'none'} (possible TTL sweep race)`,
    );
    return;
  }

  spanCtx.ended = true;

  try {
    const duration = Date.now() - spanCtx.startTime;
    const endAttributes: Attributes = {
      'qwen-code.subagent.duration_ms': duration,
      'qwen-code.subagent.status': metadata.status,
    };
    if (metadata.terminateReason !== undefined) {
      endAttributes['qwen-code.subagent.terminate_reason'] =
        metadata.terminateReason;
    }
    if (metadata.resultSummaryPresent !== undefined) {
      endAttributes['qwen-code.subagent.result_summary_present'] =
        metadata.resultSummaryPresent;
    }
    if (metadata.error !== undefined) {
      const truncated = truncateSpanError(metadata.error);
      endAttributes['exception.message'] = truncated;
    }
    if (metadata.errorType !== undefined) {
      endAttributes['error.type'] = metadata.errorType;
    }

    spanCtx.span.setAttributes(endAttributes);

    if (metadata.status === 'completed') {
      spanCtx.span.setStatus({ code: SpanStatusCode.OK });
    } else if (metadata.status === 'failed') {
      spanCtx.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: metadata.error
          ? truncateSpanError(metadata.error)
          : 'subagent failed',
      });
    }
    // cancelled / aborted → leave SpanStatus UNSET (Phase 2 convention).
  } catch (error) {
    debugLogger.warn(
      `Failed to update subagent span attributes/status: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    spanCtx.span.end();
  } catch (error) {
    debugLogger.warn(
      `Failed to end subagent span: ${error instanceof Error ? error.message : String(error)}`,
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
  // subagentContext is checked BEFORE interactionContext in startXSpan, so
  // a leaked subagent ALS frame would silently re-parent every subsequent
  // test's spans. wenshao @ #4410.
  subagentContext.enterWith(undefined);
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
