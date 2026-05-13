/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import {
  HookEventName,
  type FunctionHookCallback,
  type HookInput,
  type StopInput,
} from '../hooks/types.js';
import {
  clearActiveGoal,
  clearGoalTerminalObserver,
  getActiveGoal,
  notifyGoalTerminal,
  recordGoalIteration,
  setActiveGoal,
  type ActiveGoal,
} from './activeGoalStore.js';
import { judgeGoal } from './goalJudge.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('GOAL_HOOK');

/**
 * Maximum number of /goal continuation iterations before we force-clear the
 * goal. This guards against pathological cases where the judge keeps saying
 * "not met" but the assistant cannot make progress, which would otherwise burn
 * tokens silently. The user can re-set the goal manually if they need more.
 */
export const MAX_GOAL_ITERATIONS = 50;

/**
 * Default budget (seconds) for a single goal-judge LLM call. Mirrors Claude
 * Code 2.1.140's prompt-hook default of 30s (see `cRK` in the binary, which
 * reads `H.timeout ? H.timeout * 1000 : 30000`).
 *
 * Why this matters in qwen-code specifically: the `FunctionHookRunner` default
 * is 5s, and a real-world session log showed the judge call against a 5K-token
 * context taking ~9.9s — well past 5s but comfortably under 30s. Without
 * passing this through, the hook is killed mid-flight, no `continue:false` is
 * emitted, and the `/goal` loop silently dies after the second turn.
 */
export const GOAL_HOOK_TIMEOUT_SECONDS = 30;
export const GOAL_HOOK_TIMEOUT_MS = GOAL_HOOK_TIMEOUT_SECONDS * 1000;

const GOAL_ABORTED_REASON =
  'Goal max iterations reached; cleared. Re-set with `/goal <condition>` if you still need it.';

/**
 * Builds the Function hook callback that, on every Stop event, asks a fast
 * model whether the goal condition holds.
 *
 * Returning `{continue: true}` lets the turn end normally. Returning
 * `{continue: false, stopReason}` causes `client.ts` to feed `stopReason` back
 * as the next user prompt, looping the agent toward the goal.
 */
export function createGoalStopHookCallback(args: {
  config: Config;
  sessionId: string;
  condition: string;
}): FunctionHookCallback {
  const { config, sessionId, condition } = args;
  return async (input: HookInput, context) => {
    const stopInput = input as StopInput;
    const lastAssistantText = stopInput.last_assistant_message ?? '';

    const current = getActiveGoal(sessionId);
    if (!current || current.condition !== condition) {
      // The goal was cleared (or replaced) between turns. Let the model stop.
      return { continue: true };
    }

    if (current.iterations >= MAX_GOAL_ITERATIONS) {
      debugLogger.debug(
        `Goal exceeded MAX_GOAL_ITERATIONS=${MAX_GOAL_ITERATIONS}; clearing.`,
      );
      const aborted = current;
      clearActiveGoal(sessionId);
      notifyGoalTerminal(sessionId, {
        kind: 'aborted',
        condition: aborted.condition,
        iterations: aborted.iterations,
        durationMs: Date.now() - aborted.setAt,
        lastReason: aborted.lastReason,
        systemMessage: GOAL_ABORTED_REASON,
      });
      clearGoalTerminalObserver(sessionId);
      return {
        continue: true,
        systemMessage: GOAL_ABORTED_REASON,
      };
    }

    const signal = context?.signal ?? new AbortController().signal;
    const verdict = await judgeGoal(config, {
      condition,
      lastAssistantText,
      signal,
    });

    if (verdict.ok) {
      const achieved = current;
      clearActiveGoal(sessionId);
      notifyGoalTerminal(sessionId, {
        kind: 'achieved',
        condition: achieved.condition,
        iterations: achieved.iterations,
        durationMs: Date.now() - achieved.setAt,
        lastReason: verdict.reason,
      });
      clearGoalTerminalObserver(sessionId);
      return { continue: true };
    }

    recordGoalIteration(sessionId, verdict.reason);
    // {decision:'block', reason} is the spec-aligned shape for Stop-hook
    // continuation: `client.ts:1342-1344` accepts either `isBlockingDecision()`
    // (decision === 'block'/'deny') or `shouldStopExecution()` (continue ===
    // false), but the block-decision form documents intent more clearly —
    // "this hook is intentionally preventing the turn from stopping, not
    // signalling an error".
    return { decision: 'block', reason: verdict.reason };
  };
}

/**
 * Removes any existing /goal hook for the session (idempotent) and the
 * accompanying store entry. Returns the cleared goal, if there was one.
 *
 * Safe to call when no goal is set.
 */
export function unregisterGoalHook(
  config: Config,
  sessionId: string,
): ActiveGoal | undefined {
  const cleared = clearActiveGoal(sessionId);
  clearGoalTerminalObserver(sessionId);
  if (!cleared) return undefined;
  const system = config.getHookSystem();
  if (system) {
    try {
      system.removeFunctionHook(sessionId, HookEventName.Stop, cleared.hookId);
    } catch (err) {
      debugLogger.debug(
        `Failed to remove goal hook ${cleared.hookId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return cleared;
}

/**
 * Registers (or replaces) the /goal Stop hook for this session, primes the
 * activeGoal store, and returns the freshly stored goal. Throws when the
 * hook system is not available — callers gate on `Config.getHookSystem()`
 * before invoking.
 */
export function registerGoalHook(args: {
  config: Config;
  sessionId: string;
  condition: string;
  tokensAtStart: number;
}): ActiveGoal {
  const { config, sessionId, condition, tokensAtStart } = args;
  const system = config.getHookSystem();
  if (!system) {
    throw new Error('Hook system is not initialized; cannot register /goal');
  }

  // Drop any previous goal cleanly before adding the new one.
  unregisterGoalHook(config, sessionId);

  const callback = createGoalStopHookCallback({ config, sessionId, condition });
  const hookId = system.addFunctionHook(
    sessionId,
    HookEventName.Stop,
    '',
    callback,
    'Goal evaluator failed',
    {
      name: 'goal-stop-hook',
      description: `Continue until: ${condition}`,
      statusMessage: 'Checking goal…',
      timeout: GOAL_HOOK_TIMEOUT_MS,
    },
  );

  const goal: ActiveGoal = {
    condition,
    iterations: 0,
    setAt: Date.now(),
    tokensAtStart,
    hookId,
  };
  setActiveGoal(sessionId, goal);
  return goal;
}
