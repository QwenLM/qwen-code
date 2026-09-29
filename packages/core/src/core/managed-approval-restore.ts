/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, FunctionCall } from '@google/genai';

export interface RestorableManagedApproval {
  readonly functionCalls: FunctionCall[];
}

/**
 * Trailing unanswered tool call that matches a still-requested Managed
 * approval. Mixed dangling ids in the last model turn are not restorable:
 * only the original waited call may be re-hung.
 */
export function findRestorableManagedApproval(
  last: Content | undefined,
  requestId: string,
): RestorableManagedApproval | undefined {
  if (last?.role !== 'model' || requestId.length === 0) return undefined;
  const functionCalls: FunctionCall[] = [];
  for (const part of last.parts ?? []) {
    const fc = part.functionCall;
    if (!fc?.id) continue;
    if (fc.id !== requestId) return undefined;
    functionCalls.push(fc);
  }
  if (functionCalls.length === 0) return undefined;
  return { functionCalls };
}

export function restorableManagedApprovalCallIds(
  last: Content | undefined,
  requestId: string,
): Set<string> | undefined {
  const restorable = findRestorableManagedApproval(last, requestId);
  if (!restorable) return undefined;
  return new Set(
    restorable.functionCalls
      .map((call) => call.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  );
}
