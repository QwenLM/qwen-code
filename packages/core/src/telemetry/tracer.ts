/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  trace,
  context,
  type Span,
  type Context,
  SpanStatusCode,
  TraceFlags,
} from '@opentelemetry/api';
import { SERVICE_NAME } from './constants.js';
import { deriveTraceId, randomSpanId } from './trace-id-utils.js';
import { getSessionContext } from './session-context.js';

const tracer = trace.getTracer(SERVICE_NAME);

function getParentContext(): Context {
  const active = context.active();
  if (trace.getSpan(active)) {
    return active;
  }
  return getSessionContext() ?? active;
}

/**
 * Wraps a Span to track whether setStatus has been called by the callback.
 * This prevents withSpan from overwriting an ERROR status that the caller
 * has already set on handled-failure paths (e.g. tool hook denial).
 */
function wrapSpanWithStatusTracking(span: Span): {
  wrappedSpan: Span;
  wasStatusSet: () => boolean;
} {
  let statusSet = false;
  const originalSetStatus = span.setStatus.bind(span);
  span.setStatus = (...args: Parameters<Span['setStatus']>) => {
    statusSet = true;
    return originalSetStatus(...args);
  };
  return { wrappedSpan: span, wasStatusSet: () => statusSet };
}

/**
 * Run an async function within a new OTel span.
 * The span inherits the session root traceId when no parent span is active.
 * When the OTel SDK is not initialized, the tracer is a noop.
 *
 * If the callback sets a status explicitly (e.g. ERROR on a handled failure),
 * withSpan will not overwrite it. Only when no status has been set and the
 * callback resolves without throwing will the span be marked OK.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const parentCtx = getParentContext();
  return tracer.startActiveSpan(
    name,
    { attributes },
    parentCtx,
    async (span) => {
      const { wrappedSpan, wasStatusSet } = wrapSpanWithStatusTracking(span);
      try {
        const result = await fn(wrappedSpan);
        if (!wasStatusSet()) {
          span.setStatus({ code: SpanStatusCode.OK });
        }
        return result;
      } catch (error) {
        if (!wasStatusSet()) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * Start a span manually, returning the span and a function to run code
 * within that span's context. Unlike withSpan, the caller is responsible
 * for ending the span (e.g. in a finally block of an async generator).
 */
export function startSpanWithContext(
  name: string,
  attributes: Record<string, string | number | boolean>,
): {
  span: Span;
  runInContext: <T>(fn: () => T) => T;
} {
  const parentCtx = getParentContext();
  const span = tracer.startSpan(name, { attributes }, parentCtx);
  const spanCtx = trace.setSpan(parentCtx, span);
  return {
    span,
    runInContext: <T>(fn: () => T) => context.with(spanCtx, fn),
  };
}

/**
 * Create a root context with a deterministic traceId derived from sessionId.
 * All spans created within this context will share the same traceId,
 * consistent with LogToSpanProcessor.
 */
export function createSessionRootContext(sessionId: string): Context {
  const traceId = deriveTraceId(sessionId);
  const spanId = randomSpanId();
  const rootSpan = trace.wrapSpanContext({
    traceId,
    spanId,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: false,
  });
  return trace.setSpan(context.active(), rootSpan);
}
