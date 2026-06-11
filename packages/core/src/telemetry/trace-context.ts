/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { trace, isSpanContextValid, INVALID_TRACEID } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';
import { getSessionContext } from './session-context.js';

export const ZERO_TRACE_ID = INVALID_TRACEID;

export interface TraceContext {
  traceId: string;
  spanId: string;
  traceFlags: number;
}

function extractTraceContext(span: Span | undefined): TraceContext | null {
  const ctx = span?.spanContext();
  if (ctx && isSpanContextValid(ctx)) {
    return {
      traceId: ctx.traceId,
      spanId: ctx.spanId,
      traceFlags: ctx.traceFlags,
    };
  }
  return null;
}

export function getActiveSpanTraceContext(): TraceContext | null {
  try {
    return extractTraceContext(trace.getActiveSpan());
  } catch {
    return null;
  }
}

export function getSessionRootTraceContext(): TraceContext | null {
  try {
    const sessionCtx = getSessionContext();
    return extractTraceContext(
      sessionCtx ? trace.getSpan(sessionCtx) : undefined,
    );
  } catch {
    return null;
  }
}

export function getTraceContext(): TraceContext | null {
  return getActiveSpanTraceContext() ?? getSessionRootTraceContext();
}

export function formatTraceparent(ctx: TraceContext): string {
  const flags = (ctx.traceFlags & 0xff).toString(16).padStart(2, '0');
  return `00-${ctx.traceId}-${ctx.spanId}-${flags}`;
}

let shellTracePropagationEnabled = false;

export function setShellTracePropagation(enabled: boolean): void {
  shellTracePropagationEnabled = enabled;
}

export function isShellTracePropagationEnabled(): boolean {
  return shellTracePropagationEnabled;
}
