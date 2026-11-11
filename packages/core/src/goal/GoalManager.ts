/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Core state manager for the Goal system.
 *
 * GoalManager owns the in-memory Goal state, orchestrates creation / update /
 * deletion, tracks elapsed wall-clock time, and auto-transitions to
 * `TurnLimited` when interaction turns exceed the configured maxTurns.
 */

import {
  type Goal,
  type GoalSetParams,
  GoalStatus,
  hasReachedGoalTurnLimit,
  isUnlimitedGoalTurns,
  validateObjective,
  validateMaxTurns,
  validateCreditsBudget,
  generateGoalId,
} from './types.js';
import type { GoalStorage } from './GoalStorage.js';
import { coreEvents } from '../utils/events.js';
import {
  renderContinuationTemplate,
  renderTurnLimitTemplate,
  renderSparseContinuationTemplate,
  renderWrapUpTemplate,
  selectContinuationKind,
  type ContinuationPromptKind,
} from './template-renderer.js';
import { AsyncMutex } from './mutex.js';
import { snapshotCustomContext } from '../utils/sessionIdContext.js';


export interface GoalClearOptions {
  reason?: 'completed' | 'user';
}

/**
 * Default safety ceiling for bounded goal-loop iterations.
 *
 * Every goal carries an explicit `maxTurns`: when the caller does not supply
 * one, DEFAULT_GOAL_MAX_TURNS is written into the goal at creation time so the
 * limit is always visible to the model (GetGoal / goal context) and to the
 * user (/goal status). Callers may explicitly choose `-1`, in which
 * case turn count never triggers an automatic pause; other terminal states
 * and resource limits continue to apply.
 */
export const DEFAULT_GOAL_MAX_TURNS = 100;

function normalizeCreditsBudget(
  value: number | null | undefined,
): number | undefined {
  return value === null ? undefined : value;
}

export class GoalManager {
  private currentGoal: Goal | null = null;
  private goalMaxTurns = DEFAULT_GOAL_MAX_TURNS;
  private goalStartTime: number | null = null;
  private storage: GoalStorage;

  private continuationLock = new AsyncMutex();
  private continuationTurnId: string | null = null;

  // Wall clock accounting
  private wallClockLastAccountedAt: number = Date.now();
  private wallClockActiveGoalId: string | null = null;

  /** The session that owns this manager instance. */
  readonly sessionId: string;

  /**
   * Sync plan-mode active state into the persisted goal so that
   * `/goal resume` can restore plan after a process restart.
   */
  syncPlanState(active: boolean): void {
    if (!this.currentGoal) return;
    if (this.currentGoal.planWasActive === active) return;
    this.currentGoal.planWasActive = active;
    this.storage.save(this.currentGoal);
  }

  constructor(storage: GoalStorage, sessionId: string) {
    this.storage = storage;
    this.sessionId = sessionId;
    // Restore this session's persisted goal (if any). Goals are
    // session-scoped, so whatever is in this file belongs to us — a goal left
    // Active by a crashed process is picked up again on `--resume`.
    this.currentGoal = this.storage.load();
  }

  setGoalMaxTurns(maxTurns: number | null): number {
    const next = maxTurns ?? DEFAULT_GOAL_MAX_TURNS;
    validateMaxTurns(next);
    this.goalMaxTurns = next;
    return this.goalMaxTurns;
  }

  /**
   * Re-read the persisted goal from disk so out-of-band changes (external
   * cleanup, another process resuming this session) become visible to this
   * process. Wall-clock accounting is preserved while the same goal remains
   * active.
   */
  refresh(): void {
    const persisted = this.storage.load({ fresh: true });
    const sameGoal =
      persisted !== null && persisted.id === this.currentGoal?.id;
    this.currentGoal = persisted;
    if (!sameGoal || persisted?.status !== GoalStatus.Active) {
      this.goalStartTime = null;
    }
    if (!sameGoal) {
      this.clearWallClockActiveGoal();
    }
  }

  /**
   * Create or update the current goal.
   *
   * Replacement vs. incremental update rules:
   *   - If a goal already exists **and** the caller supplies a new objective
   *     that differs from the existing one → full replacement (stats reset).
   *   - If the objective is identical or omitted → incremental update (stats
   *     preserved, only status / maxTurns / updatedAt change).
   *   - If no goal exists the caller **must** supply an objective.
   */
  setGoal(params: GoalSetParams): Goal {
    this.refresh();
    const previousGoal = this.currentGoal ? { ...this.currentGoal } : null;

    // ── Validation ──────────────────────────────────────────────────────
    if (params.objective !== undefined) {
      validateObjective(params.objective);
    }
    if (params.maxTurns !== undefined) {
      validateMaxTurns(params.maxTurns);
    }
    if (params.creditsBudget !== undefined && params.creditsBudget !== null) {
      validateCreditsBudget(params.creditsBudget);
    }

    const now = Date.now();

    if (this.currentGoal) {
      const isNewObjective =
        params.objective !== undefined &&
        params.objective !== this.currentGoal.objective;

      if (isNewObjective) {
        // Full replacement – reset statistics.
        this.currentGoal = {
          id: generateGoalId(),
          objective: params.objective!,
          status: params.status ?? GoalStatus.Active,
          maxTurns: params.maxTurns ?? this.goalMaxTurns,
          turnsUsed: 0,
          timeUsedSeconds: 0,
          creditsBudget:
            normalizeCreditsBudget(params.creditsBudget),
          creditsUsed: 0,
          createdAt: now,
          updatedAt: now,
          ...(params.customContext !== undefined ||
          previousGoal?.customContext !== undefined
            ? {
                customContext: snapshotCustomContext(
                  params.customContext ?? previousGoal?.customContext,
                ),
              }
            : {}),
        };
      } else {
        // Incremental update – preserve accumulated stats.
        if (params.customContext !== undefined) {
          this.currentGoal.customContext = snapshotCustomContext(
            params.customContext,
          );
        }
        if (params.status !== undefined) {
          this.currentGoal.status = params.status;
        }
        if (params.maxTurns !== undefined) {
          this.currentGoal.maxTurns = params.maxTurns;
        }
        if (params.creditsBudget !== undefined) {
          // null explicitly clears the budget; omitted leaves it unchanged.
          this.currentGoal.creditsBudget =
            normalizeCreditsBudget(params.creditsBudget);
        }
        this.currentGoal.updatedAt = now;
      }
    } else {
      // No existing goal – objective is mandatory.
      if (params.objective === undefined) {
        throw new Error('An objective is required when creating a new goal.');
      }
      this.currentGoal = {
        id: generateGoalId(),
        objective: params.objective,
        status: params.status ?? GoalStatus.Active,
        maxTurns: params.maxTurns ?? this.goalMaxTurns,
        turnsUsed: 0,
        timeUsedSeconds: 0,
        creditsBudget:
          normalizeCreditsBudget(params.creditsBudget),
        creditsUsed: 0,
        createdAt: now,
        updatedAt: now,
        ...(params.customContext !== undefined
          ? { customContext: snapshotCustomContext(params.customContext) }
          : {}),
      };
    }

    // ── Persist ─────────────────────────────────────────────────────────
    this.storage.save(this.currentGoal);

    // ── Time tracking ───────────────────────────────────────────────────
    if (this.currentGoal.status === GoalStatus.Active) {
      this.goalStartTime = this.goalStartTime ?? now;
      this.markWallClockActiveGoal(this.currentGoal.id);
    } else {
      this.updateTimeUsed();
      this.goalStartTime = null;
    }

    // ── Emit event ──────────────────────────────────────────────────────
    coreEvents.emitGoalUpdated({
      sessionId: this.sessionId,
      goal: {
        id: this.currentGoal.id,
        objective: this.currentGoal.objective,
        status: this.currentGoal.status,
        turnsUsed: this.currentGoal.turnsUsed,
        maxTurns: this.currentGoal.maxTurns,
        timeUsedSeconds: this.currentGoal.timeUsedSeconds,
      },
    });

    return this.currentGoal;
  }

  /**
   * Returns the current goal with real-time `timeUsedSeconds`.
   */
  /**
   * Whether a goal is currently active (status === Active) AND owned by this
   * session.
   *
   * Used by UI and tool-schema refresh paths that need to know whether the
   * autonomous goal loop is currently running.
   */
  get isGoalActive(): boolean {
    return this.currentGoal?.status === GoalStatus.Active;
  }

  /**
   * Status to surface in the UI goal badge.
   *
   * An Active or Paused goal owned by this session stays visible until it is
   * cleared or completed. Completed goals and goals owned by other sessions
   * surface nothing.
   */
  getBadgeStatus(): GoalStatus | null {
    if (!this.currentGoal) return null;
    if (this.currentGoal.status === GoalStatus.Complete) return null;
    return this.currentGoal.status;
  }

  /**
   * Halt the goal loop because the agent reported an impasse. Accepted
   * directly (the three-turn rule is a prompt convention, not runtime
   * counting). Only an active goal can be blocked; reviving is the user's job.
   */
  async markBlocked(): Promise<boolean> {
    const releaseLock = await this.acquireContinuationLock();
    try {
      this.refresh();
      if (!this.currentGoal || this.currentGoal.status !== GoalStatus.Active) {
        return false;
      }

      this.updateTimeUsed();
      this.currentGoal.status = GoalStatus.Blocked;
      this.currentGoal.updatedAt = Date.now();
      this.storage.save(this.currentGoal);

      this.clearWallClockActiveGoal();
      this.goalStartTime = null;

      coreEvents.emitGoalUpdated({
        sessionId: this.sessionId,
        goal: {
          id: this.currentGoal.id,
          objective: this.currentGoal.objective,
          status: this.currentGoal.status,
          turnsUsed: this.currentGoal.turnsUsed,
          maxTurns: this.currentGoal.maxTurns,
          timeUsedSeconds: this.currentGoal.timeUsedSeconds,
        },
        reason: 'blocked',
      });



      return true;
    } finally {
      releaseLock();
    }
  }

  getGoal(): Goal | null {
    if (this.currentGoal && this.goalStartTime) {
      return {
        ...this.currentGoal,
        timeUsedSeconds:
          this.currentGoal.timeUsedSeconds +
          Math.floor((Date.now() - this.goalStartTime) / 1000),
      };
    }
    return this.currentGoal;
  }

  /**
   * Removes the current goal entirely and wipes the persisted file.
   *
   * @param options.reason - Why the goal was cleared ('completed' | 'user').
   * @returns `true` if a goal was cleared, `false` if there was nothing to clear.
   */
  clearGoal(options?: GoalClearOptions): boolean {
    this.refresh();
    if (!this.currentGoal) return false;
    this.updateTimeUsed();
    const clearedGoal = { ...this.currentGoal };
    this.currentGoal = null;
    this.goalStartTime = null;
    this.clearWallClockActiveGoal();
    this.continuationTurnId = null;
    this.storage.delete();

    coreEvents.emitGoalCleared({
      sessionId: this.sessionId,
      goalId: clearedGoal.id,
      timestamp: Date.now(),
      reason: options?.reason,
    });

    return true;
  }

  /**
   * Record one interaction turn against the active goal.
   * Only the owner session accumulates turns.
   */
  recordTurn(): void {
    this.refresh();
    if (!this.currentGoal) return;
    if (this.currentGoal.status !== GoalStatus.Active) return;

    this.currentGoal.turnsUsed += 1;
    this.currentGoal.updatedAt = Date.now();
    this.storage.save(this.currentGoal);

    // 每轮发布更新，宿主才能实时刷新已用轮次。
    // 用 getGoal() 携带实时用时，避免端上计时回退。
    const goal = this.getGoal();
    if (!goal) return;
    coreEvents.emitGoalUpdated({
      sessionId: this.sessionId,
      goal: {
        id: goal.id,
        objective: goal.objective,
        status: goal.status,
        turnsUsed: goal.turnsUsed,
        maxTurns: goal.maxTurns,
        timeUsedSeconds: goal.timeUsedSeconds,
      },
    });
  }

  /**
   * Returns `true` when the current goal has reached or exceeded its turn limit.
   * This is advisory only — it does not change the goal status.
   */
  isOverTurnLimit(): boolean {
    if (!this.currentGoal?.maxTurns) return false;
    return hasReachedGoalTurnLimit(
      this.currentGoal.turnsUsed,
      this.currentGoal.maxTurns,
    );
  }

  /**
   * The always-on hard iteration ceiling for the current goal.
   *
   * New goals always persist an explicit `maxTurns` (default
   * DEFAULT_GOAL_MAX_TURNS); the fallback below only covers legacy on-disk
   * goals created before the default was introduced.
   */
  hardTurnLimit(): number {
    return this.currentGoal?.maxTurns ?? DEFAULT_GOAL_MAX_TURNS;
  }

  /**
   * Returns `true` once the goal has crossed its hard ceiling. Unlike
   * `isOverTurnLimit()` this is NOT advisory: the stop hook uses it to
   * force-pause the goal and allow the agent to stop.
   */
  isOverHardTurnLimit(): boolean {
    if (!this.currentGoal) return false;
    return hasReachedGoalTurnLimit(
      this.currentGoal.turnsUsed,
      this.hardTurnLimit(),
    );
  }

  // ── Prompt rendering ───────────────────────────────────────────────────

  /**
   * Render the continuation prompt (continuation template).
   * Used to inject into the model when auto-continuing after a turn.
   */
  renderContinuationPrompt(): string | null {
    if (!this.currentGoal) return null;
    const goal = this.getGoal()!;
    return renderContinuationTemplate(goal);
  }

  /**
   * Render the turn-limit prompt.
   */
  renderTurnLimitPrompt(): string | null {
    if (!this.currentGoal) return null;
    const goal = this.getGoal()!;
    return renderTurnLimitTemplate(goal);
  }

  /**
   * Render the prompt for the current continuation turn, picking the cadence
   * (full / sparse / wrap-up / turn-limit) from the goal's turn budget.
   *
   * This is what the Stop hook injects. Sending the full instruction block on
   * every turn would accumulate thousands of near-duplicate tokens over a long
   * loop, so only the first turn and a periodic refresher carry it.
   */
  renderTurnPrompt(): { kind: ContinuationPromptKind; text: string } | null {
    if (!this.currentGoal) return null;
    const goal = this.getGoal()!;
    const kind = selectContinuationKind(goal);
    switch (kind) {
      case 'turn_limit':
        return { kind, text: renderTurnLimitTemplate(goal) };
      case 'wrap_up':
        return { kind, text: renderWrapUpTemplate(goal) };
      case 'full':
        return { kind, text: renderContinuationTemplate(goal) };
      case 'sparse':
        return { kind, text: renderSparseContinuationTemplate(goal) };
      default: {
        const exhaustive: never = kind;
        return exhaustive;
      }
    }
  }

  // ── Continuation Turn ID ────────────────────────────────────────────────

  markContinuationTurnStarted(turnId: string): void {
    this.continuationTurnId = turnId;
  }

  takeContinuationTurn(turnId: string): boolean {
    if (this.continuationTurnId === turnId) {
      this.continuationTurnId = null;
      return true;
    }
    return false;
  }

  // ── Finish Goal Turn ────────────────────────────────────────────────────

  finishGoalTurn(turnId: string, _turnCompleted: boolean): void {
    this.takeContinuationTurn(turnId);
  }

  // ── Continuation Lock ──────────────────────────────────────────────────

  async acquireContinuationLock(): Promise<() => void> {
    return this.continuationLock.acquire();
  }

  // ── Wall Clock Accounting ──────────────────────────────────────────────

  wallClockDeltaSeconds(): number {
    return Math.floor((Date.now() - this.wallClockLastAccountedAt) / 1000);
  }

  markWallClockAccounted(): void {
    this.wallClockLastAccountedAt = Date.now();
  }

  markWallClockActiveGoal(goalId: string): void {
    this.wallClockActiveGoalId = goalId;
    this.wallClockLastAccountedAt = Date.now();
  }

  clearWallClockActiveGoal(): void {
    this.wallClockActiveGoalId = null;
  }

  getWallClockActiveGoalId(): string | null {
    return this.wallClockActiveGoalId;
  }

  // ── Pause / Resume ─────────────────────────────────────────────────────

  async pauseForInterrupt(): Promise<boolean> {
    const releaseLock = await this.acquireContinuationLock();
    try {
      this.refresh();
      if (!this.currentGoal || this.currentGoal.status !== GoalStatus.Active) {
        return false;
      }

      // Wall clock accounting
      const timeDelta = this.wallClockDeltaSeconds();
      if (timeDelta > 0) {
        this.currentGoal.timeUsedSeconds += timeDelta;
      }

      this.currentGoal.status = GoalStatus.Paused;
      this.currentGoal.updatedAt = Date.now();
      this.storage.save(this.currentGoal);

      this.clearWallClockActiveGoal();
      this.goalStartTime = null;

      coreEvents.emitGoalUpdated({
        sessionId: this.sessionId,
        goal: {
          id: this.currentGoal.id,
          objective: this.currentGoal.objective,
          status: this.currentGoal.status,
          turnsUsed: this.currentGoal.turnsUsed,
          maxTurns: this.currentGoal.maxTurns,
          timeUsedSeconds: this.currentGoal.timeUsedSeconds,
        },
      });



      return true;
    } finally {
      releaseLock();
    }
  }

  /**
   * Force-pause the goal because it crossed the hard iteration ceiling.
   *
   * Safety circuit breaker for the goal loop: unlike `pauseForInterrupt()`
   * (a user action), this is triggered by the stop hook to stop an
   * indefinitely-spinning goal. It transitions Active → Paused, persists, and
   * emits GoalUpdated so the badge reflects the paused state. The user can
   * `/goal resume` to deliberately continue.
   *
   * @returns `true` if the goal was force-paused, `false` if there was no
   *   owned active goal to pause.
   */
  async pauseForSafetyLimit(): Promise<boolean> {
    const releaseLock = await this.acquireContinuationLock();
    try {
      this.refresh();
      if (!this.currentGoal || this.currentGoal.status !== GoalStatus.Active) {
        return false;
      }

      const timeDelta = this.wallClockDeltaSeconds();
      if (timeDelta > 0) {
        this.currentGoal.timeUsedSeconds += timeDelta;
      }

      this.currentGoal.status = GoalStatus.Paused;
      this.currentGoal.updatedAt = Date.now();
      this.storage.save(this.currentGoal);

      this.clearWallClockActiveGoal();
      this.goalStartTime = null;

      coreEvents.emitGoalUpdated({
        sessionId: this.sessionId,
        goal: {
          id: this.currentGoal.id,
          objective: this.currentGoal.objective,
          status: this.currentGoal.status,
          turnsUsed: this.currentGoal.turnsUsed,
          maxTurns: this.currentGoal.maxTurns,
          timeUsedSeconds: this.currentGoal.timeUsedSeconds,
        },
        reason: 'safety-limit',
      });



      return true;
    } finally {
      releaseLock();
    }
  }

  /** 仅预算耗尽时按当前配置补充轮次，保留累计用量。 */
  private grantFreshTurnBudget(): boolean {
    if (!this.currentGoal || !this.isOverHardTurnLimit()) return false;
    this.currentGoal.maxTurns = isUnlimitedGoalTurns(this.goalMaxTurns)
      ? this.goalMaxTurns
      : this.currentGoal.turnsUsed + this.goalMaxTurns;
    return true;
  }

  /**
   * Reactivate a Paused goal.
   *
   * A Blocked goal is also accepted: the UpdateGoal "blocked" contract tells
   * the user to revive the goal with `/goal resume`, so the user-initiated
   * resume must be able to un-block it. Only this user-facing path accepts
   * Blocked; the agent cannot revive a blocked goal on its own.
   *
   * 用户显式恢复且轮次已耗尽时，按当前 goalMaxTurns 配置续额。
   * 模型侧 UpdateGoal 不得申请续额，避免绕过轮次上限。
   */
  async activateAfterResume(options?: {
    grantFreshBudget?: boolean;
  }): Promise<boolean> {
    const releaseLock = await this.acquireContinuationLock();
    try {
      this.refresh();
      if (!this.currentGoal) {
        this.clearWallClockActiveGoal();
        return false;
      }

      const previousStatus = this.currentGoal.status;
      if (
        previousStatus !== GoalStatus.Paused &&
        previousStatus !== GoalStatus.Blocked
      ) {
        if (previousStatus === GoalStatus.Active) {
          this.markWallClockActiveGoal(this.currentGoal.id);
        } else {
          this.clearWallClockActiveGoal();
        }
        return false;
      }

      this.currentGoal.status = GoalStatus.Active;
        options?.grantFreshBudget === true && this.grantFreshTurnBudget();
      this.currentGoal.updatedAt = Date.now();
      this.goalStartTime = Date.now();
      this.storage.save(this.currentGoal);

      this.markWallClockActiveGoal(this.currentGoal.id);

      coreEvents.emitGoalUpdated({
        sessionId: this.sessionId,
        goal: {
          id: this.currentGoal.id,
          objective: this.currentGoal.objective,
          status: this.currentGoal.status,
          turnsUsed: this.currentGoal.turnsUsed,
          maxTurns: this.currentGoal.maxTurns,
          timeUsedSeconds: this.currentGoal.timeUsedSeconds,
        },
      });



      return true;
    } finally {
      releaseLock();
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  private updateTimeUsed(): void {
    if (this.currentGoal && this.goalStartTime) {
      this.currentGoal.timeUsedSeconds += Math.floor(
        (Date.now() - this.goalStartTime) / 1000,
      );
    }
  }
}
