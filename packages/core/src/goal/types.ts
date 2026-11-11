/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Type definitions and validation helpers for the Goal system.
 *
 * A Goal represents a high-level user objective that the agent works toward.
 * Goals track interaction turns, elapsed time, and lifecycle status.
 */

/** Lifecycle status of a Goal. */
export enum GoalStatus {
  Active = 'active',
  Paused = 'paused',
  /** The agent reported being stuck; auto-continuation is halted. */
  Blocked = 'blocked',
  /** The account ran out of quota/credits mid-goal. */
  UsageLimited = 'usage_limited',
  /** The goal's credits budget was exhausted. Terminal. */
  BudgetLimited = 'budget_limited',
  Complete = 'complete',
}

/** Explicit sentinel for a Goal whose interaction turns are not capped. */
export const UNLIMITED_GOAL_TURNS = -1;

/** A persistent Goal record. */
export interface Goal {
  /** Unique identifier (timestamp + random suffix). */
  id: string;
  /** Human-readable objective description. */
  objective: string;
  /** Current lifecycle status. */
  status: GoalStatus;
  /** Optional upper bound on interaction turns. -1 explicitly means unlimited. */
  maxTurns?: number;
  /** Number of interaction turns used so far. */
  turnsUsed: number;
  /** Wall-clock time spent on this goal (seconds). */
  timeUsedSeconds: number;
  /** Creation timestamp in milliseconds since epoch. */
  createdAt: number;
  /** Last-updated timestamp in milliseconds since epoch. */
  updatedAt: number;
  /** Whether plan mode was active when the goal was last persisted. */
  planWasActive?: boolean;
  /** Optional credits budget for this goal (opt-in via SDK credits_budget). */
  creditsBudget?: number;
  /** Credits consumed by this goal so far (absent on legacy goal files). */
  creditsUsed?: number;
  /**
   * Opaque per-turn identity captured when the goal was created. Goal kickoff
   * turns inherit it so a goal that outlives its originating turn keeps the
   * same inference identity.
   */
  customContext?: Readonly<Record<string, string>>;
}

/** Parameters accepted when creating or updating a Goal. */
export interface GoalSetParams {
  /** New objective text. */
  objective?: string;
  /** New status value. */
  status?: GoalStatus;
  /** Maximum interaction turns (positive integer or -1 for unlimited). */
  maxTurns?: number;
  /**
   * Credits budget for this goal. A positive number sets/updates the budget;
   * explicit `null` clears it; omitted leaves it unchanged.
   */
  creditsBudget?: number | null;
  /** Per-turn identity snapshot to carry into goal kickoff turns. */
  customContext?: Readonly<Record<string, string>>;
}

/**
 * Validate that an objective string is non-empty after trimming.
 *
 * @throws {Error} If the objective is empty or whitespace-only.
 */
export function validateObjective(objective: string): void {
  if (!objective || objective.trim().length === 0) {
    throw new Error('Goal objective must be a non-empty string.');
  }
}

/**
 * Validate that maxTurns is a positive safe integer or -1 for unlimited.
 *
 * @throws {Error} If maxTurns is neither a positive safe integer nor -1.
 */
export function validateMaxTurns(maxTurns: number): void {
  if (maxTurns === UNLIMITED_GOAL_TURNS) return;
  if (!Number.isSafeInteger(maxTurns) || maxTurns <= 0) {
    throw new Error(
      `Goal maxTurns must be a positive safe integer or -1, received ${maxTurns}.`,
    );
  }
}

/** Whether a turn limit explicitly disables the turn-count ceiling. */
export function isUnlimitedGoalTurns(maxTurns: number): boolean {
  return maxTurns === UNLIMITED_GOAL_TURNS;
}

/** Whether the supplied usage has exhausted a bounded turn limit. */
export function hasReachedGoalTurnLimit(
  turnsUsed: number,
  maxTurns: number,
): boolean {
  return !isUnlimitedGoalTurns(maxTurns) && turnsUsed >= maxTurns;
}

/**
 * Validate that creditsBudget is a positive finite number.
 *
 * @throws {Error} If creditsBudget is not a positive finite number.
 */
export function validateCreditsBudget(creditsBudget: number): void {
  if (!Number.isFinite(creditsBudget) || creditsBudget <= 0) {
    throw new Error(
      `Goal creditsBudget must be a positive number, received ${creditsBudget}.`,
    );
  }
}

/**
 * Generate a unique Goal ID composed of the current timestamp and a random
 * hexadecimal suffix to avoid collisions.
 */
export function generateGoalId(): string {
  const timestamp = Date.now();
  const suffix = Math.random().toString(16).slice(2, 8);
  return `${timestamp}-${suffix}`;
}
