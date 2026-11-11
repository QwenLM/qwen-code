/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The circuit breaker behind Auto mode.
 *
 * Auto mode answers its own prompts, so a refused call produces no dialog;
 * without a counter the model can retry it until the turn budget is gone.
 * Two counters catch the two shapes: a tight retry loop (`maxConsecutive`)
 * and a session refused constantly (`maxTotal`).
 *
 * Session-scoped and mutable: it is a fact about what happened, not a rule.
 * The module supplies the factory and arithmetic; `AutoClassifier` owns which
 * tracker belongs to which session/agent.
 */

export interface DenialLimits {
  /** Consecutive denials before tripping. A single allow resets the count. */
  readonly maxConsecutive: number;
  /** Denials in the whole session before tripping. Never resets. */
  readonly maxTotal: number;
}

export interface DenialCounters {
  consecutiveDenials: number;
  totalDenials: number;
}

export type CircuitBreakerResult =
  | { tripped: false }
  | {
      tripped: true;
      reason: 'maxConsecutive' | 'maxTotal';
      message: string;
    };

export interface DenialTracker {
  recordDenial(): void;
  /** Resets the consecutive count. The session total stands. */
  recordAllow(): void;
  checkCircuitBreaker(): CircuitBreakerResult;
  getCounters(): Readonly<DenialCounters>;
  reset(): void;
}

export const DEFAULT_DENIAL_LIMITS: Readonly<DenialLimits> = {
  maxConsecutive: 3,
  maxTotal: 20,
} as const;

export function createDenialTracker(
  limits: DenialLimits = DEFAULT_DENIAL_LIMITS,
): DenialTracker {
  const counters: DenialCounters = {
    consecutiveDenials: 0,
    totalDenials: 0,
  };

  return {
    recordDenial(): void {
      counters.consecutiveDenials++;
      counters.totalDenials++;
    },

    recordAllow(): void {
      counters.consecutiveDenials = 0;
    },

    checkCircuitBreaker(): CircuitBreakerResult {
      if (counters.consecutiveDenials >= limits.maxConsecutive) {
        return {
          tripped: true,
          reason: 'maxConsecutive',
          message:
            `${counters.consecutiveDenials} consecutive tool calls were denied. ` +
            `The agent may be stuck in a loop. Consider changing the permission ` +
            `mode or adding allow rules for the tools being used.`,
        };
      }

      if (counters.totalDenials >= limits.maxTotal) {
        return {
          tripped: true,
          reason: 'maxTotal',
          message:
            `${counters.totalDenials} total tool calls have been denied in this session. ` +
            `This exceeds the maximum of ${limits.maxTotal}. Consider reviewing ` +
            `your permission configuration.`,
        };
      }

      return { tripped: false };
    },

    getCounters(): Readonly<DenialCounters> {
      return { ...counters };
    },

    reset(): void {
      counters.consecutiveDenials = 0;
      counters.totalDenials = 0;
    },
  };
}
