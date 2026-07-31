/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Context } from '@opentelemetry/api';

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
 * Used by LogToSpanProcessor as a fallback to derive the correct traceId
 * when a log record has no session.id attribute (e.g. after /clear or /resume).
 */
export function getCurrentSessionId(): string | undefined {
  return currentSessionId;
}
