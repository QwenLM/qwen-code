/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { createDebugLogger } from '../utils/debugLogger.js';

export interface ToolInvocationGuardContext {
  callId: string;
  toolName: string;
  args: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
}

export type ToolInvocationGuardDecision =
  | { allowed: true }
  | {
      allowed: false;
      /** User-visible denial reason. It must not contain secrets. */
      reason?: string;
    };

export type ToolInvocationGuard = (
  context: ToolInvocationGuardContext,
) => ToolInvocationGuardDecision | Promise<ToolInvocationGuardDecision>;

export type EvaluatedToolInvocationGuardDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

const debugLogger = createDebugLogger('TOOL_INVOCATION_GUARD');

const DENIED_MESSAGE = 'Tool invocation denied by host policy';
const FAILED_MESSAGE = 'Tool invocation guard failed';

export async function evaluateToolInvocationGuard(
  guard: ToolInvocationGuard,
  context: ToolInvocationGuardContext,
): Promise<EvaluatedToolInvocationGuardDecision> {
  if (context.signal.aborted) {
    return { allowed: false, reason: FAILED_MESSAGE };
  }

  try {
    const decision = await guard({
      ...context,
      args: structuredClone(context.args),
    });
    if (context.signal.aborted) {
      return { allowed: false, reason: FAILED_MESSAGE };
    }
    if (decision?.allowed === true) {
      return { allowed: true };
    }
    if (decision?.allowed === false) {
      return {
        allowed: false,
        reason:
          typeof decision.reason === 'string' && decision.reason.trim()
            ? decision.reason
            : DENIED_MESSAGE,
      };
    }
    debugLogger.debug(
      'Tool invocation guard returned an unrecognized decision; failing closed',
      decision,
    );
  } catch (error) {
    // A configured guard is an enforcement boundary. Provider and cloning
    // failures must deny the call instead of falling back to execution.
    debugLogger.debug('Tool invocation guard evaluation failed', error);
  }

  return { allowed: false, reason: FAILED_MESSAGE };
}
