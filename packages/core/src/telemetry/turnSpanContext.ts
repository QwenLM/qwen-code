/**
 * Per-turn root span with OTel context propagation.
 *
 * Manages the lifecycle of the active turn span so that all child spans
 * (LLM calls, tool calls, subagents) within a single user turn are nested
 * under one root span.  Works transparently when telemetry is not
 * initialized — the OTel no-op tracer handles that case.
 */

import {
  trace,
  context,
  type Context,
  type Span,
  SpanKind,
  SpanStatusCode,
} from '@opentelemetry/api';

const tracer = trace.getTracer('proto.turn', '1.0.0');

// Module-level state: the active turn span and its OTel context
let activeTurnSpan: Span | undefined;
let activeTurnContext: Context | undefined;

/**
 * Start a new turn root span. Call at the beginning of each user prompt.
 * Returns the OTel Context with the span set as active — pass this to
 * context.with() to make child spans nest under it.
 */
export function startTurnSpan(sessionId: string, turnId: string): Context {
  // End any previous turn span that wasn't closed
  endTurnSpan();

  const span = tracer.startSpan('turn', {
    kind: SpanKind.SERVER,
    attributes: {
      'session.id': sessionId,
      'turn.id': turnId,
      'langfuse.session.id': sessionId, // Langfuse groups by this
    },
  });

  activeTurnSpan = span;
  activeTurnContext = trace.setSpan(context.active(), span);
  return activeTurnContext;
}

/**
 * End the active turn span. Call when the turn completes (or errors).
 */
export function endTurnSpan(status?: 'ok' | 'error'): void {
  if (!activeTurnSpan) return;
  if (status === 'error') {
    activeTurnSpan.setStatus({ code: SpanStatusCode.ERROR });
  } else if (status === 'ok') {
    activeTurnSpan.setStatus({ code: SpanStatusCode.OK });
  }
  activeTurnSpan.end();
  activeTurnSpan = undefined;
  activeTurnContext = undefined;
}

/**
 * Get the active turn OTel context (for passing to context.with()).
 * Returns undefined if no turn is active.
 */
export function getActiveTurnContext(): Context | undefined {
  return activeTurnContext;
}

/**
 * Get the active turn span (for adding attributes mid-turn).
 */
export function getActiveTurnSpan(): Span | undefined {
  return activeTurnSpan;
}
