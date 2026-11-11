/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Session-level permission diagnostics: the permission.requested /
 * permission.resolved / permission.failed events the session log carries.
 *
 * Restored after the cutover deleted the legacy module. The events keep the
 * old schema; only the decision they describe changed shape — the component's
 * PermissionDecision replaces the legacy behavior/decisionReason pair.
 */

import type { PermissionDecision } from './manager/decision/index.js';
import {
  emitPermissionRequested,
  emitPermissionResolved,
  emitPermissionFailed,
} from '../utils/diagnosticInterceptors.js';
import { normalizeDiagnosticValue } from '../utils/sessionLogger.js';
import type { ToolPermissionReason } from '../tools/tool-checkers/checker-reasons.js';

export interface PermissionDiagnosticContext {
  sessionId?: string;
  promptId?: string;
  toolCallId?: string;
  toolName: string;
  input: Record<string, unknown>;
}

/** Where the settlement came from, for the `source` column. */
export type PermissionDecisionSource =
  | 'policy'
  | 'user'
  | 'hook'
  | 'recheck'
  | 'abort'
  | 'system';

export function logPermissionRequested(
  context: PermissionDiagnosticContext | undefined,
  askMessage: string | undefined,
  suggestionCount: number | undefined,
  suggestions?: unknown,
): void {
  if (!context) {
    return;
  }
  emitPermissionRequested({
    sessionId: context.sessionId,
    turnId: context.promptId,
    toolCallId: context.toolCallId,
    toolName: context.toolName,
    input: context.input,
    askMessage,
    suggestionCount,
    suggestions,
  });
}

export function logPermissionResolved(params: {
  context: PermissionDiagnosticContext | undefined;
  source: PermissionDecisionSource;
  decision: PermissionDecision<ToolPermissionReason>;
  /** Who answered the prompt, when one was shown (ask facts winnerParty). */
  outcome?: string;
  updatedInput?: Record<string, unknown>;
  durationMs?: number;
}): void {
  const { context, decision } = params;
  if (!context) {
    return;
  }
  const reason = decision.reason;
  emitPermissionResolved({
    sessionId: context.sessionId,
    turnId: context.promptId,
    toolCallId: context.toolCallId,
    toolName: context.toolName,
    source: params.source,
    allowed: decision.kind === 'allow',
    outcome: params.outcome,
    reason: reason?.message,
    decisionBehavior: decision.kind,
    decisionReason: reason
      ? {
          message: reason.message,
          attribution: normalizeDiagnosticValue(reason.attribution),
          decisionPoint: reason.decisionPoint,
        }
      : undefined,
    updatedInput: params.updatedInput,
    permissionUpdateCount: 0,
    durationMs: params.durationMs,
  });
}

export function logPermissionFailed(params: {
  context: PermissionDiagnosticContext | undefined;
  source: PermissionDecisionSource;
  error: unknown;
  durationMs?: number;
}): void {
  const { context } = params;
  if (!context) {
    return;
  }
  emitPermissionFailed({
    sessionId: context.sessionId,
    turnId: context.promptId,
    toolCallId: context.toolCallId,
    toolName: context.toolName,
    source: params.source,
    error: params.error,
    durationMs: params.durationMs,
  });
}
