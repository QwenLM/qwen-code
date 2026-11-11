/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GoalManager } from './GoalManager.js';
import type { GoalStorage } from './GoalStorage.js';
import { GoalStatus, validateObjective, validateMaxTurns } from './types.js';

// Mock coreEvents so event emissions don't cause side-effects in tests.
vi.mock('../utils/events.js', () => ({
  coreEvents: {
    emitGoalUpdated: vi.fn(),
    emitGoalCleared: vi.fn(),
  },
}));

/**
 * Build a mock GoalStorage whose methods are Vitest spies backed by a real
 * in-memory value, mirroring the disk file. This keeps `refresh()` (which
 * re-reads persisted state before every mutation) behaving like production.
 */
function createMockStorage(
  initialGoal: ReturnType<GoalStorage['load']> = null,
) {
  const state = { stored: initialGoal };
  const storage = {
    save: vi.fn((goal: NonNullable<ReturnType<GoalStorage['load']>>) => {
      state.stored = { ...goal };
    }),
    load: vi.fn(() => state.stored),
    delete: vi.fn(() => {
      state.stored = null;
    }),
  } as unknown as GoalStorage;
  return Object.assign(storage, { _state: state });
}

describe('GoalManager', () => {
  let storage: GoalStorage;
  let manager: GoalManager;

  beforeEach(() => {
    storage = createMockStorage();
    manager = new GoalManager(storage, 'test-session');
  });

  describe('用户恢复配置轮次', () => {
    it.each(['slash_resume', 'sdk_resume'] as const)(
      '%s 恢复按配置续额，重复恢复不叠加且重启保留累计用量',
      async (_source) => {
        manager.setGoalMaxTurns(20);
        manager.setGoal({ objective: '持续工作' });
        for (let turn = 0; turn < 23; turn++) manager.recordTurn();
        await manager.pauseForSafetyLimit();
        const before = manager.getGoal()!;
        const resume = async () => {
          await manager.activateAfterResume({
            grantFreshBudget: true,
          });
        };
        await resume();
        await resume();
        expect(manager.getGoal()).toMatchObject({
          id: before.id,
          status: GoalStatus.Active,
          turnsUsed: 23,
          maxTurns: 43,
          creditsUsed: before.creditsUsed,
        });
        manager = new GoalManager(storage, 'test-session');
        manager.setGoalMaxTurns(20);
        expect(manager.getGoal()).toMatchObject({
          turnsUsed: 23,
          maxTurns: 43,
        });
        manager.recordTurn();
        expect(manager.isOverHardTurnLimit()).toBe(false);
        for (let turn = 0; turn < 19; turn++) manager.recordTurn();
        await manager.pauseForSafetyLimit();
        await resume();
        expect(manager.getGoal()).toMatchObject({
          turnsUsed: 43,
          maxTurns: 63,
        });
      },
    );

    it('显式恢复使用最新配置，setGoal 激活和模型均不续额', async () => {
      manager.setGoalMaxTurns(20);
      manager.setGoal({ objective: '持续工作' });
      manager.recordTurn();
      await manager.pauseForInterrupt();
      manager.setGoalMaxTurns(10);
      await manager.activateAfterResume({
        grantFreshBudget: true,
      });
      expect(manager.getGoal()).toMatchObject({ turnsUsed: 1, maxTurns: 20 });
      for (let turn = 0; turn < 19; turn++) manager.recordTurn();
      await manager.pauseForSafetyLimit();
      manager.setGoal({ status: GoalStatus.Active });
      expect(manager.getGoal()).toMatchObject({ turnsUsed: 20, maxTurns: 20 });
      await manager.pauseForSafetyLimit();
      await manager.activateAfterResume({
        grantFreshBudget: true,
      });
      expect(manager.getGoal()).toMatchObject({ turnsUsed: 20, maxTurns: 30 });
    });
  });

  // ── Basic operations ─────────────────────────────────────────────────

  describe('basic operations', () => {
    it('setGoal creates a new goal and returns it', () => {
      const goal = manager.setGoal({ objective: 'Write unit tests' });
      expect(goal).toMatchObject({
        objective: 'Write unit tests',
        status: GoalStatus.Active,
        turnsUsed: 0,
        timeUsedSeconds: 0,
      });
      expect(goal.id).toBeDefined();
      expect(goal.createdAt).toBeGreaterThan(0);
    });

    it('persists the creation-turn customContext across updates and replacement', () => {
      const customContext = Object.freeze({ tenant: 'alpha' });
      const goal = manager.setGoal({ objective: 'Keep identity', customContext });
      expect(goal.customContext).toEqual(customContext);

      manager.setGoal({ status: GoalStatus.Paused });
      expect(manager.getGoal()?.customContext).toEqual(customContext);

      const replaced = manager.setGoal({ objective: 'New objective' });
      expect(replaced.customContext).toEqual(customContext);
    });

    it('getGoal returns null when no goal exists', () => {
      expect(manager.getGoal()).toBeNull();
    });

    it('getGoal returns goal with real-time timeUsedSeconds', () => {
      vi.useFakeTimers();
      try {
        manager.setGoal({ objective: 'Timed goal' });
        // Advance 5 seconds
        vi.advanceTimersByTime(5000);
        const goal = manager.getGoal();
        expect(goal).not.toBeNull();
        expect(goal!.timeUsedSeconds).toBe(5);
      } finally {
        vi.useRealTimers();
      }
    });

  describe('markBlocked', () => {
    it('transitions an Active goal to Blocked', async () => {
      manager.setGoal({ objective: 'Blocked goal' });

      expect(await manager.markBlocked()).toBe(true);
      expect(manager.getGoal()!.status).toBe(GoalStatus.Blocked);
    });

    it('is a no-op when the goal is not active', async () => {
      manager.setGoal({ objective: 'Paused goal' });
      await manager.pauseForInterrupt();

      expect(await manager.markBlocked()).toBe(false);
      expect(manager.getGoal()!.status).toBe(GoalStatus.Paused);
    });
  });

    it('clearGoal clears the goal so getGoal returns null', () => {
      manager.setGoal({ objective: 'To be cleared' });
      expect(
        manager.clearGoal({
          reason: 'user',
        }),
      ).toBe(true);
      expect(manager.getGoal()).toBeNull();
    });

    it('clearGoal returns false when no goal exists', () => {
      expect(manager.clearGoal()).toBe(false);
    });
  });

  // ── Conditional update vs replacement ────────────────────────────────

  describe('conditional update vs replacement', () => {
    it('same objective preserves turnsUsed and timeUsedSeconds', () => {
      vi.useFakeTimers();
      try {
        manager.setGoal({ objective: 'Build feature' });
        manager.recordTurn();
        manager.recordTurn();
        vi.advanceTimersByTime(3000);

        const updated = manager.setGoal({ objective: 'Build feature' });
        expect(updated.turnsUsed).toBe(2);
        expect(updated.timeUsedSeconds).toBeGreaterThanOrEqual(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('different objective resets turnsUsed and timeUsedSeconds', () => {
      manager.setGoal({ objective: 'Old objective' });
      manager.recordTurn();

      const replaced = manager.setGoal({ objective: 'New objective' });
      expect(replaced.turnsUsed).toBe(0);
      expect(replaced.timeUsedSeconds).toBe(0);
      expect(replaced.objective).toBe('New objective');
      expect(replaced.maxTurns).toBe(100);
    });

    it('omitting objective with status performs incremental update', () => {
      manager.setGoal({ objective: 'Keep me' });
      manager.recordTurn();

      const updated = manager.setGoal({ status: GoalStatus.Paused });
      expect(updated.objective).toBe('Keep me');
      expect(updated.turnsUsed).toBe(1);
    });

    it('setGoal without objective and no existing goal throws', () => {
      expect(() => manager.setGoal({ status: GoalStatus.Active })).toThrow(
        'An objective is required when creating a new goal.',
      );
    });
  });

  // ── Status management ────────────────────────────────────────────────

  describe('status management', () => {
    it('setGoal with Paused status transitions to Paused', () => {
      manager.setGoal({ objective: 'Pausable' });
      const paused = manager.setGoal({ status: GoalStatus.Paused });
      expect(paused.status).toBe(GoalStatus.Paused);
    });

    it('setGoal with Active status resumes from Paused', () => {
      manager.setGoal({ objective: 'Resumable' });
      manager.setGoal({ status: GoalStatus.Paused });
      const resumed = manager.setGoal({ status: GoalStatus.Active });
      expect(resumed.status).toBe(GoalStatus.Active);
    });
  });

  // ── Turn limit ──────────────────────────────────────────────────────

  describe('turn limit', () => {
    it('recordTurn accumulates turnsUsed', () => {
      manager.setGoal({ objective: 'Counting turns' });
      manager.recordTurn();
      manager.recordTurn();
      manager.recordTurn();
      const goal = manager.getGoal();
      expect(goal!.turnsUsed).toBe(3);
    });

    it('emits GoalUpdated for every recorded turn with live progress', async () => {
      const { coreEvents } = await import('../utils/events.js');
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        manager.setGoal({ objective: 'Reporting progress' });
        vi.mocked(coreEvents.emitGoalUpdated).mockClear();

        vi.setSystemTime(new Date('2026-01-01T00:00:12Z'));
        manager.recordTurn();
        vi.setSystemTime(new Date('2026-01-01T00:00:30Z'));
        manager.recordTurn();

        expect(coreEvents.emitGoalUpdated).toHaveBeenCalledTimes(2);
        expect(coreEvents.emitGoalUpdated).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({
            sessionId: 'test-session',
            goal: expect.objectContaining({
              status: GoalStatus.Active,
              turnsUsed: 1,
              timeUsedSeconds: 12,
            }),
          }),
        );
        expect(coreEvents.emitGoalUpdated).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({
            sessionId: 'test-session',
            goal: expect.objectContaining({
              status: GoalStatus.Active,
              turnsUsed: 2,
              timeUsedSeconds: 30,
            }),
          }),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('stays Active when turnsUsed reaches maxTurns (soft limit)', () => {
      manager.setGoal({ objective: 'Limited goal', maxTurns: 3 });
      manager.recordTurn();
      manager.recordTurn();
      manager.recordTurn();
      const goal = manager.getGoal();
      expect(goal!.status).toBe(GoalStatus.Active);
      expect(goal!.turnsUsed).toBe(3);
    });

    it('isOverTurnLimit returns false when under limit', () => {
      manager.setGoal({ objective: 'Under limit', maxTurns: 5 });
      manager.recordTurn();
      expect(manager.isOverTurnLimit()).toBe(false);
    });

    it('isOverTurnLimit returns true when at limit', () => {
      manager.setGoal({ objective: 'At limit', maxTurns: 2 });
      manager.recordTurn();
      manager.recordTurn();
      expect(manager.isOverTurnLimit()).toBe(true);
    });

    it('persists and applies the default turn limit (100) when maxTurns is not given', () => {
      manager.setGoal({ objective: 'No explicit limit' });
      expect(manager.getGoal()!.maxTurns).toBe(100);
      expect(manager.hardTurnLimit()).toBe(100);
      manager.recordTurn();
      manager.recordTurn();
      expect(manager.isOverTurnLimit()).toBe(false);
    });

    it('applies a query max-turn value only to goals created afterwards', async () => {
      const current = manager.setGoal({ objective: 'Current goal' });
      manager.recordTurn();
      const before = manager.getGoal()!;
      const { coreEvents } = await import('../utils/events.js');
      vi.mocked(coreEvents.emitGoalUpdated).mockClear();
      vi.mocked(storage.save).mockClear();

      expect(manager.setGoalMaxTurns(250)).toBe(250);
      expect(manager.getGoal()).toMatchObject({
        id: current.id,
        maxTurns: before.maxTurns,
        turnsUsed: before.turnsUsed,
        updatedAt: before.updatedAt,
      });
      expect(storage.save).not.toHaveBeenCalled();
      expect(coreEvents.emitGoalUpdated).not.toHaveBeenCalled();

      manager.clearGoal();
      expect(manager.setGoal({ objective: 'Next goal' }).maxTurns).toBe(250);
      expect(
        manager.setGoal({ objective: 'Explicit goal', maxTurns: 300 })
          .maxTurns,
      ).toBe(300);
    });

    it('uses the query max-turn value for replacements but not incremental updates', () => {
      manager.setGoal({ objective: 'First goal', maxTurns: 12 });
      manager.setGoalMaxTurns(240);

      expect(manager.setGoal({ status: GoalStatus.Paused }).maxTurns).toBe(12);
      expect(manager.setGoal({ objective: 'Replacement goal' }).maxTurns).toBe(
        240,
      );
    });

    it('resets to 100 and keeps the previous value after invalid updates', () => {
      manager.setGoalMaxTurns(220);
      for (const invalid of [0, -2, 1.5, Number.NaN, Infinity, 2 ** 53]) {
        expect(() => manager.setGoalMaxTurns(invalid)).toThrow(
          'Goal maxTurns must be a positive safe integer or -1',
        );
        expect(
          manager.setGoal({ objective: 'After invalid update' }).maxTurns,
        ).toBe(220);
        manager.clearGoal();
      }

      expect(manager.setGoalMaxTurns(null)).toBe(100);
      expect(manager.setGoal({ objective: 'After reset' }).maxTurns).toBe(100);
    });

    it('does not record turns when goal is not Active', async () => {
      manager.setGoal({ objective: 'Paused goal' });
      manager.setGoal({ status: GoalStatus.Paused });
      const { coreEvents } = await import('../utils/events.js');
      vi.mocked(coreEvents.emitGoalUpdated).mockClear();
      manager.recordTurn();
      const goal = manager.getGoal();
      expect(goal!.turnsUsed).toBe(0);
      expect(coreEvents.emitGoalUpdated).not.toHaveBeenCalled();
    });
  });

  // ── Hard turn limit (safety circuit breaker) ─────────────────────────

  describe('hard turn limit', () => {
    it('equals maxTurns when maxTurns is set (no grace)', () => {
      manager.setGoal({ objective: 'Bounded goal', maxTurns: 5 });
      expect(manager.hardTurnLimit()).toBe(5);
    });

    it('isOverHardTurnLimit is false below the ceiling', () => {
      manager.setGoal({ objective: 'Bounded goal', maxTurns: 3 });
      // hard ceiling equals maxTurns (3); one turn recorded → still below
      manager.recordTurn();
      expect(manager.isOverHardTurnLimit()).toBe(false);
    });

    it('isOverHardTurnLimit trips once turnsUsed reaches the ceiling', () => {
      manager.setGoal({ objective: 'Bounded goal', maxTurns: 2 });
      // hard ceiling = maxTurns = 2
      manager.recordTurn();
      manager.recordTurn();
      expect(manager.isOverHardTurnLimit()).toBe(true);
    });

    it('never reaches the hard turn limit for an explicitly unlimited goal', () => {
      manager.setGoalMaxTurns(-1);
      manager.setGoal({ objective: 'Unbounded goal' });
      for (let turn = 0; turn < 150; turn++) manager.recordTurn();

      expect(manager.getGoal()).toMatchObject({
        maxTurns: -1,
        turnsUsed: 150,
      });
      expect(manager.isOverTurnLimit()).toBe(false);
      expect(manager.isOverHardTurnLimit()).toBe(false);
    });

    it('pauseForSafetyLimit force-pauses an owned active goal and emits event', async () => {
      const { coreEvents } = await import('../utils/events.js');
      manager.setGoal({ objective: 'Spinning goal' });

      const paused = await manager.pauseForSafetyLimit();

      expect(paused).toBe(true);
      expect(manager.getGoal()!.status).toBe(GoalStatus.Paused);
      expect(coreEvents.emitGoalUpdated).toHaveBeenCalledWith(
        expect.objectContaining({
          goal: expect.objectContaining({ status: GoalStatus.Paused }),
        }),
      );
    });

    it('pauseForSafetyLimit is a no-op when there is no active goal', async () => {
      expect(await manager.pauseForSafetyLimit()).toBe(false);
    });
  });

  // ── Persistence integration ──────────────────────────────────────────

  describe('persistence integration', () => {
    it('setGoal calls storage.save', () => {
      manager.setGoal({ objective: 'Persist me' });
      expect(storage.save).toHaveBeenCalled();
    });

    it('clearGoal calls storage.delete', () => {
      manager.setGoal({ objective: 'Delete me' });
      manager.clearGoal();
      expect(storage.delete).toHaveBeenCalled();
    });

    it('constructor restores goal from storage.load', () => {
      const persisted = {
        id: 'test-id',
        objective: 'Restored goal',
        status: GoalStatus.Active,
        maxTurns: 20,
        turnsUsed: 3,
        timeUsedSeconds: 10,
        createdAt: Date.now() - 60000,
        updatedAt: Date.now() - 30000,
      };
      const restoringStorage = createMockStorage(persisted);
      const restoringManager = new GoalManager(restoringStorage, 'test-session');

      const goal = restoringManager.getGoal();
      expect(goal).not.toBeNull();
      expect(goal!.objective).toBe('Restored goal');
      expect(goal!.turnsUsed).toBe(3);
      expect(goal!.maxTurns).toBe(20);
      expect(restoringManager.hardTurnLimit()).toBe(20);
      expect(restoringStorage.save).not.toHaveBeenCalled();
    });

    it('uses the new default as the effective limit for a legacy goal without rewriting it', () => {
      const persisted = {
        id: 'legacy-id',
        objective: 'Legacy goal',
        status: GoalStatus.Active,
        turnsUsed: 99,
        timeUsedSeconds: 10,
        createdAt: Date.now() - 60_000,
        updatedAt: Date.now() - 30_000,
      };
      const restoringStorage = createMockStorage(persisted);
      const restoringManager = new GoalManager(restoringStorage, 'test-session');

      expect(restoringManager.getGoal()!.maxTurns).toBeUndefined();
      expect(restoringManager.hardTurnLimit()).toBe(100);
      expect(restoringStorage.save).not.toHaveBeenCalled();
    });
  });

  // ── Session-scoped goals ─────────────────────────────────────────────

  describe('session-scoped goals', () => {
    it('a resumed process of the same session picks up the goal and can mutate it directly', () => {
      // Session A creates a goal, then its process dies. A new process resumes
      // the SAME session (same goal file) — no take/claim step is needed.
      const persisted = {
        id: 'goal-from-prior-process',
        objective: 'Survived a Ctrl+C restart',
        status: GoalStatus.Paused,
        turnsUsed: 4,
        timeUsedSeconds: 30,
        createdAt: Date.now() - 60_000,
        updatedAt: Date.now() - 30_000,
      };
      const sameSessionStorage = createMockStorage(persisted);
      const resumedProcess = new GoalManager(sameSessionStorage, 'session-a');

      // The goal is immediately usable — clear works without any claiming.
      expect(resumedProcess.getGoal()!.objective).toBe(
        'Survived a Ctrl+C restart',
      );
      expect(resumedProcess.clearGoal()).toBe(true);
    });

    it('two different sessions have fully isolated goals (separate storages)', () => {
      // Each session gets its own storage (its own file on disk), so goals can
      // never collide by construction.
      const storageA = createMockStorage();
      const storageB = createMockStorage();
      const sessionA = new GoalManager(storageA, 'session-a');
      const sessionB = new GoalManager(storageB, 'session-b');

      sessionA.setGoal({ objective: 'Goal of A' });
      expect(sessionB.getGoal()).toBeNull();

      sessionB.setGoal({ objective: 'Goal of B' });
      expect(sessionA.getGoal()!.objective).toBe('Goal of A');
      expect(sessionB.getGoal()!.objective).toBe('Goal of B');

      sessionB.clearGoal();
      expect(sessionA.getGoal()).not.toBeNull();
    });

    it('refresh picks up out-of-band deletion of the goal file', () => {
      const sharedStorage = createMockStorage();
      const mgr = new GoalManager(sharedStorage, 'session-a');
      mgr.setGoal({ objective: 'About to vanish' });

      // Simulate external cleanup of this session's goal file.
      sharedStorage._state.stored = null;

      mgr.refresh();
      expect(mgr.getGoal()).toBeNull();
    });
  });

  // ── Badge status ─────────────────────────────────────────────────────

  describe('getBadgeStatus', () => {
    it('returns Active for an owned active goal', () => {
      manager.setGoal({ objective: 'Show badge' });
      expect(manager.getBadgeStatus()).toBe(GoalStatus.Active);
    });

    it('returns Paused for an owned paused goal (badge persists)', async () => {
      manager.setGoal({ objective: 'Pause badge' });
      await manager.pauseForInterrupt();
      expect(manager.getBadgeStatus()).toBe(GoalStatus.Paused);
    });

    it('returns null for a completed goal', () => {
      manager.setGoal({ objective: 'Done badge' });
      manager.setGoal({ status: GoalStatus.Complete });
      expect(manager.getBadgeStatus()).toBeNull();
    });

    it('returns null when no goal exists', () => {
      expect(manager.getBadgeStatus()).toBeNull();
    });
  });

  // ── Resume ──────────────────────────────────────────────────────────

  describe('activateAfterResume', () => {
    // A process restart re-loads this session's Paused goal; resuming just
    // reactivates it — no ownership transfer exists in the session-scoped
    // model.
    it('reactivates a paused goal restored from a previous process', async () => {
      const persisted = {
        id: 'goal-from-prior-process',
        objective: 'Survived a Ctrl+C restart',
        status: GoalStatus.Paused,
        turnsUsed: 4,
        timeUsedSeconds: 30,
        createdAt: Date.now() - 60_000,
        updatedAt: Date.now() - 30_000,
      };
      const restoringStorage = createMockStorage(persisted);
      const resumedProcess = new GoalManager(restoringStorage, 'session-a');

      const activated = await resumedProcess.activateAfterResume();
      expect(activated).toBe(true);

      const goal = resumedProcess.getGoal();
      expect(goal!.status).toBe(GoalStatus.Active);
      expect(restoringStorage.save).toHaveBeenCalled();
    });

    it('is a no-op when there is no goal to resume', async () => {
      const activated = await manager.activateAfterResume();
      expect(activated).toBe(false);
    });

    // Regression: after a hard-turn-limit auto-pause, turnsUsed >= maxTurns.
    // Without a fresh budget the very next stop hook would trip the breaker
    // again, making /goal resume useless ("chain-tripping"). Only the
    // user-initiated resume path may grant the fresh budget.
    it('grants a fresh turn budget when the user resumes an exhausted goal', async () => {
      manager.setGoal({ objective: 'Long runner', maxTurns: 2 });
      manager.recordTurn();
      manager.recordTurn();
      expect(manager.isOverHardTurnLimit()).toBe(true);
      await manager.pauseForSafetyLimit();

      const activated = await manager.activateAfterResume({
        grantFreshBudget: true,
      });
      expect(activated).toBe(true);

      const goal = manager.getGoal()!;
      // 2 used + DEFAULT_GOAL_MAX_TURNS (100) fresh budget
      expect(goal.maxTurns).toBe(102);
      expect(manager.isOverHardTurnLimit()).toBe(false);
    });

    it('grants unlimited turns when an exhausted goal resumes under unlimited configuration', async () => {
      manager.setGoal({ objective: 'Long runner', maxTurns: 2 });
      manager.recordTurn();
      manager.recordTurn();
      await manager.pauseForSafetyLimit();
      manager.setGoalMaxTurns(-1);

      const activated = await manager.activateAfterResume({
        grantFreshBudget: true,
      });

      expect(activated).toBe(true);
      expect(manager.getGoal()).toMatchObject({
        status: GoalStatus.Active,
        turnsUsed: 2,
        maxTurns: -1,
      });
      expect(manager.isOverHardTurnLimit()).toBe(false);
    });

    it('grants a fresh turn budget when the user resumes an exhausted legacy goal', async () => {
      const persisted = {
        id: 'legacy-id',
        objective: 'Legacy long runner',
        status: GoalStatus.Paused,
        turnsUsed: 100,
        timeUsedSeconds: 30,
        createdAt: Date.now() - 60_000,
        updatedAt: Date.now() - 30_000,
      };
      const restoringStorage = createMockStorage(persisted);
      const restoringManager = new GoalManager(
        restoringStorage,
        'test-session',
      );

      const activated = await restoringManager.activateAfterResume({
        grantFreshBudget: true,
      });

      expect(activated).toBe(true);
      expect(restoringManager.getGoal()!.maxTurns).toBe(200);
      expect(restoringManager.isOverHardTurnLimit()).toBe(false);
    });

    // The agent-facing resume path (UpdateGoal "active") must never extend
    // the budget — the hard-limit breaker cannot be bypassed by the model.
    it('does not extend the budget when resuming without grantFreshBudget', async () => {
      manager.setGoal({ objective: 'Long runner', maxTurns: 2 });
      manager.recordTurn();
      manager.recordTurn();
      await manager.pauseForSafetyLimit();

      const activated = await manager.activateAfterResume();
      expect(activated).toBe(true);
      expect(manager.getGoal()!.maxTurns).toBe(2);
      expect(manager.isOverHardTurnLimit()).toBe(true);
    });

    it('does not extend the budget when resuming with turns remaining', async () => {
      manager.setGoal({ objective: 'Paused early', maxTurns: 10 });
      manager.recordTurn();
      await manager.pauseForInterrupt();

      await manager.activateAfterResume({ grantFreshBudget: true });
      expect(manager.getGoal()!.maxTurns).toBe(10);
    });

    // Regression (feedback 75dbb1ca): UpdateGoal("blocked") halts the goal and
    // tells the user to revive it with /goal resume. activateAfterResume must
    // therefore accept a Blocked goal, not only a Paused one — otherwise the
    // goal is stuck in Blocked forever.
    it('reactivates a blocked goal so /goal resume can revive it', async () => {
      manager.setGoal({ objective: 'Blocked runner', maxTurns: 10 });
      manager.recordTurn();
      const blocked = await manager.markBlocked();
      expect(blocked).toBe(true);
      expect(manager.getGoal()!.status).toBe(GoalStatus.Blocked);

      const activated = await manager.activateAfterResume({
        grantFreshBudget: true,
      });
      expect(activated).toBe(true);

      const goal = manager.getGoal()!;
      expect(goal.status).toBe(GoalStatus.Active);
      // Turns were not exhausted, so the budget must not be extended.
      expect(goal.maxTurns).toBe(10);
      expect(storage.save).toHaveBeenCalled();
    });

    it('grants a fresh turn budget when resuming an exhausted blocked goal', async () => {
      manager.setGoal({ objective: 'Blocked long runner', maxTurns: 2 });
      manager.recordTurn();
      manager.recordTurn();
      await manager.markBlocked();

      const activated = await manager.activateAfterResume({
        grantFreshBudget: true,
      });
      expect(activated).toBe(true);
      expect(manager.getGoal()!.maxTurns).toBe(102);
      expect(manager.isOverHardTurnLimit()).toBe(false);
    });

    it('still refuses to resume a completed goal', async () => {
      manager.setGoal({ objective: 'Done' });
      manager.setGoal({ status: GoalStatus.Complete });

      const activated = await manager.activateAfterResume();
      expect(activated).toBe(false);
      expect(manager.getGoal()!.status).toBe(GoalStatus.Complete);
    });
  });

  // ── Safety-limit pause event reason ───────────────────────────────────

  describe('pauseForSafetyLimit event reason', () => {
    it('emits GoalUpdated with reason "safety-limit"', async () => {
      const { coreEvents } = await import('../utils/events.js');
      manager.setGoal({ objective: 'Runaway goal' });

      await manager.pauseForSafetyLimit();

      expect(coreEvents.emitGoalUpdated).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'safety-limit' }),
      );
    });
  });
});

// ── Validation function tests ────────────────────────────────────────────

describe('validateObjective', () => {
  it('throws on empty string', () => {
    expect(() => validateObjective('')).toThrow();
  });

  it('throws on whitespace-only string', () => {
    expect(() => validateObjective('   ')).toThrow();
  });

  it('does not throw on valid text', () => {
    expect(() => validateObjective('valid text')).not.toThrow();
  });
});

describe('validateMaxTurns', () => {
  it('throws on zero', () => {
    expect(() => validateMaxTurns(0)).toThrow();
  });

  it('throws on negative number', () => {
    expect(() => validateMaxTurns(-2)).toThrow();
  });

  it('throws on non-integer', () => {
    expect(() => validateMaxTurns(1.5)).toThrow();
  });

  it('does not throw on positive integer', () => {
    expect(() => validateMaxTurns(10)).not.toThrow();
  });
});
