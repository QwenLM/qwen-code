/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContextKey, type Context } from '@opentelemetry/api';

const sessionIdContextKey = createContextKey('qwen-code.telemetry.session-id');

let sessionRootContext: Context | undefined;
let currentSessionId: string | undefined;

export function setSessionContext(
  ctx: Context | undefined,
  sessionId?: string,
): void {
  sessionRootContext = ctx;
  currentSessionId = sessionId;
}

export function getSessionContext(): Context | undefined {
  return sessionRootContext;
}

/**
 * Returns the most recent session ID passed to setSessionContext.
 * This remains the final compatibility fallback for single-session telemetry
 * paths that have no explicit owner or scoped context.
 */
export function getCurrentSessionId(): string | undefined {
  return currentSessionId;
}

export function setSessionIdOnContext(
  ctx: Context,
  sessionId: string | undefined,
): Context {
  if (!sessionId) return ctx;
  return ctx.setValue(sessionIdContextKey, sessionId);
}

export function getSessionIdFromContext(ctx: Context): string | undefined {
  const sessionId = ctx.getValue(sessionIdContextKey);
  return typeof sessionId === 'string' && sessionId ? sessionId : undefined;
}
