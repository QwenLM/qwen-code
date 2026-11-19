/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HOSTED_IDLE_SUSPEND_MS,
  admitSuspensionWork,
  armIdleSuspension,
  beginSuspensionClose,
  clearSuspension,
  createSuspension,
  disarmIdleSuspension,
  escalateSuspension,
  idleSuspensionDelay,
  markSuspensionTeardown,
  recordSuspensionActivity,
  releaseSuspensionWork,
  revertSuspension,
  runSuspensionAttempt,
  suspensionReconcileMs,
  suspensionRefusalCode,
  type SuspensionAttemptDeps,
} from './hosted-session-suspension.js';

describe('suspension reconciliation bound', () => {
  it('exceeds the lease plus the Store request timeout at every lease', () => {
    // The lease is client-supplied up to MAX_LEASE_MILLIS (300s). A bound
    // tuned for the 60s default would clear the gate under a live lease.
    for (const lease of [60_000, 120_000, 300_000]) {
      expect(suspensionReconcileMs(lease)).toBeGreaterThan(lease + 30_000);
    }
    // The 60s default lease is the candidate the design names (100s).
    expect(suspensionReconcileMs(60_000)).toBe(100_000);
    expect(suspensionReconcileMs(300_000)).toBeGreaterThan(
      suspensionReconcileMs(60_000),
    );
  });
});

describe('suspension gate', () => {
  it('answers closing while converging and teardown_blocked at the cap', () => {
    const suspension = createSuspension(0);
    expect(suspensionRefusalCode(suspension)).toBeUndefined();
    beginSuspensionClose(suspension);
    expect(suspensionRefusalCode(suspension)).toBe('hosted_session_closing');
    escalateSuspension(suspension);
    expect(suspensionRefusalCode(suspension)).toBe(
      'hosted_session_teardown_blocked',
    );
  });

  it('admits work only while open and counts it until release', () => {
    const suspension = createSuspension(0);
    expect(admitSuspensionWork(suspension)).toBe(true);
    expect(admitSuspensionWork(suspension)).toBe(true);
    expect(suspension.admittedWork).toBe(2);
    beginSuspensionClose(suspension);
    expect(admitSuspensionWork(suspension)).toBe(false);
    expect(suspension.admittedWork).toBe(2);
    releaseSuspensionWork(suspension);
    releaseSuspensionWork(suspension);
    releaseSuspensionWork(suspension);
    expect(suspension.admittedWork).toBe(0);
  });

  it('reverts only before the first teardown call', () => {
    const suspension = createSuspension(0);
    beginSuspensionClose(suspension);
    expect(revertSuspension(suspension, 50)).toBe(true);
    expect(suspension.gate).toBe('open');
    expect(suspension.lastActivity).toBe(50);
    beginSuspensionClose(suspension);
    markSuspensionTeardown(suspension);
    expect(revertSuspension(suspension, 60)).toBe(false);
    expect(suspension.gate).toBe('closing');
    expect(suspension.teardownStarted).toBe(true);
  });

  it('clears the gate only through the confirmed-complete path', () => {
    const suspension = createSuspension(0);
    beginSuspensionClose(suspension);
    markSuspensionTeardown(suspension);
    suspension.teardownAttempts = 3;
    clearSuspension(suspension);
    expect(suspension.gate).toBe('open');
    expect(suspension.teardownStarted).toBe(false);
    expect(suspension.teardownAttempts).toBe(0);
  });
});

describe('idle timer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires after the idle period with at most 10% jitter', () => {
    const suspension = createSuspension(0);
    let fired = 0;
    armIdleSuspension(suspension, {
      idleMs: HOSTED_IDLE_SUSPEND_MS,
      onTimeout: () => {
        fired += 1;
      },
      random: () => 1,
    });
    vi.advanceTimersByTime(HOSTED_IDLE_SUSPEND_MS - 1);
    expect(fired).toBe(0);
    vi.advanceTimersByTime(HOSTED_IDLE_SUSPEND_MS * 0.1 + 1);
    expect(fired).toBe(1);
  });

  it('keeps the jitter within the fraction for any draw', () => {
    for (const draw of [0, 0.5, 1]) {
      const delay = idleSuspensionDelay(1000, () => draw);
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(1100);
    }
  });

  it('rearming resets the period and disarming cancels it', () => {
    const suspension = createSuspension(0);
    let fired = 0;
    const options = {
      idleMs: 1000,
      onTimeout: () => {
        fired += 1;
      },
      random: () => 0,
    };
    armIdleSuspension(suspension, options);
    vi.advanceTimersByTime(900);
    recordSuspensionActivity(suspension, 900);
    armIdleSuspension(suspension, options);
    vi.advanceTimersByTime(900);
    expect(fired).toBe(0);
    vi.advanceTimersByTime(100);
    expect(fired).toBe(1);
    armIdleSuspension(suspension, options);
    disarmIdleSuspension(suspension);
    vi.advanceTimersByTime(2000);
    expect(fired).toBe(1);
  });

  it('does not arm a gated session', () => {
    const suspension = createSuspension(0);
    beginSuspensionClose(suspension);
    let fired = 0;
    armIdleSuspension(suspension, {
      idleMs: 1000,
      onTimeout: () => {
        fired += 1;
      },
    });
    vi.advanceTimersByTime(2000);
    expect(fired).toBe(0);
    expect(suspension.idleTimer).toBeUndefined();
  });
});

describe('suspension attempt driver', () => {
  function harness(overrides: Partial<SuspensionAttemptDeps> = {}) {
    const suspension = createSuspension(0);
    let clock = 0;
    const calls: string[] = [];
    const deps: SuspensionAttemptDeps = {
      pendingInputs: async () => false,
      markClosing: (attemptStart) => {
        calls.push(`markClosing:${attemptStart}`);
        return beginSuspensionClose(suspension);
      },
      liveWork: () => false,
      teardown: async () => {
        calls.push('teardown');
      },
      removeResident: () => {
        calls.push('removeResident');
      },
      rearm: () => {
        calls.push('rearm');
      },
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      waitMs: 1000,
      retryCap: 3,
      random: () => 0,
      ...overrides,
    };
    return { suspension, deps, calls };
  }

  it('suspends an idle session and clears the gate for a cold open', async () => {
    const { suspension, deps, calls } = harness();
    const outcome = await runSuspensionAttempt(suspension, deps);
    expect(outcome).toBe('suspended');
    expect(calls).toEqual(['markClosing:0', 'teardown', 'removeResident']);
    expect(suspension.gate).toBe('open');
    expect(suspension.teardownStarted).toBe(false);
  });

  it('keeps serving when pending inputs exist, without gating', async () => {
    const { suspension, deps, calls } = harness({
      pendingInputs: async () => true,
    });
    const outcome = await runSuspensionAttempt(suspension, deps);
    expect(outcome).toBe('reverted');
    expect(suspension.gate).toBe('open');
    expect(calls).toEqual(['rearm']);
  });

  it('keeps serving when the synchronous mark refuses', async () => {
    const { suspension, deps, calls } = harness({
      markClosing: () => false,
    });
    const outcome = await runSuspensionAttempt(suspension, deps);
    expect(outcome).toBe('reverted');
    expect(suspension.gate).toBe('open');
    expect(calls).toEqual(['rearm']);
  });

  it('waits for admitted work to finish on its own clock', async () => {
    const { suspension, deps, calls } = harness();
    admitSuspensionWork(suspension);
    let polls = 0;
    const outcome = await runSuspensionAttempt(suspension, {
      ...deps,
      sleep: async (ms) => {
        polls += 1;
        if (polls === 2) releaseSuspensionWork(suspension);
        await deps.sleep!(ms);
      },
    });
    expect(outcome).toBe('suspended');
    expect(calls).toContain('teardown');
  });

  it('reverts when admitted work outlasts the bounded wait', async () => {
    const { suspension, deps, calls } = harness();
    admitSuspensionWork(suspension);
    const outcome = await runSuspensionAttempt(suspension, deps);
    expect(outcome).toBe('reverted');
    expect(suspension.gate).toBe('open');
    expect(suspension.teardownStarted).toBe(false);
    expect(calls).toEqual(['markClosing:0', 'rearm']);
    expect(suspension.lastActivity).toBeGreaterThan(0);
  });

  it('reverts when live work appears during the wait', async () => {
    let live = false;
    const { suspension, deps } = harness({ liveWork: () => live });
    admitSuspensionWork(suspension);
    const outcome = await runSuspensionAttempt(suspension, {
      ...deps,
      sleep: async (ms) => {
        releaseSuspensionWork(suspension);
        live = true;
        await deps.sleep!(ms);
      },
    });
    expect(outcome).toBe('reverted');
    expect(suspension.gate).toBe('open');
  });

  it('reverts when inputs commit during the wait', async () => {
    let pending = false;
    const { suspension, deps } = harness({
      pendingInputs: async () => pending,
    });
    admitSuspensionWork(suspension);
    const outcome = await runSuspensionAttempt(suspension, {
      ...deps,
      sleep: async (ms) => {
        releaseSuspensionWork(suspension);
        pending = true;
        await deps.sleep!(ms);
      },
    });
    expect(outcome).toBe('reverted');
    expect(suspension.gate).toBe('open');
    expect(suspension.teardownStarted).toBe(false);
  });

  it('reverts and rethrows when an eligibility dep fails before the mark', async () => {
    const { suspension, deps, calls } = harness({
      pendingInputs: async () => {
        throw new Error('store gone');
      },
    });
    await expect(runSuspensionAttempt(suspension, deps)).rejects.toThrow(
      'store gone',
    );
    expect(suspension.gate).toBe('open');
    expect(calls).toEqual(['rearm']);
  });

  it('reverts the closing mark when a dep fails after it', async () => {
    let probes = 0;
    const { suspension, deps, calls } = harness({
      pendingInputs: async () => {
        probes += 1;
        if (probes === 2) throw new Error('store gone');
        return false;
      },
    });
    await expect(runSuspensionAttempt(suspension, deps)).rejects.toThrow(
      'store gone',
    );
    expect(suspension.gate).toBe('open');
    expect(suspension.teardownStarted).toBe(false);
    expect(calls).toEqual(['markClosing:0', 'rearm']);
  });

  it('reverts when the live-work recheck throws', async () => {
    const { suspension, deps, calls } = harness({
      liveWork: () => {
        throw new Error('authority gone');
      },
    });
    await expect(runSuspensionAttempt(suspension, deps)).rejects.toThrow(
      'authority gone',
    );
    expect(suspension.gate).toBe('open');
    expect(suspension.teardownStarted).toBe(false);
    expect(calls).toEqual(['markClosing:0', 'rearm']);
  });

  it('retries the same teardown and suspends when it lands', async () => {
    let attempts = 0;
    const { suspension, deps, calls } = harness({
      teardown: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('seal timeout');
      },
    });
    const outcome = await runSuspensionAttempt(suspension, deps);
    expect(outcome).toBe('suspended');
    expect(attempts).toBe(2);
    expect(suspension.teardownAttempts).toBe(0);
    expect(calls.filter((call) => call === 'removeResident')).toHaveLength(1);
  });

  it('escalates to operator recovery at the cap and keeps the gate', async () => {
    let attempts = 0;
    const { suspension, deps, calls } = harness({
      teardown: async () => {
        attempts += 1;
        throw new Error('seal timeout');
      },
    });
    const outcome = await runSuspensionAttempt(suspension, deps);
    expect(outcome).toBe('blocked');
    expect(suspension.gate).toBe('blocked');
    expect(suspensionRefusalCode(suspension)).toBe(
      'hosted_session_teardown_blocked',
    );
    expect(suspension.teardownAttempts).toBe(3);
    expect(attempts).toBe(3);
    // The resident is dropped but the gate registry entry survives it.
    expect(calls.filter((call) => call === 'removeResident')).toHaveLength(1);
  });

  it('never reverts past the first teardown call', async () => {
    // Observe inside the callback and assert after the attempt: an
    // assertion thrown inside teardown is swallowed by the retry loop,
    // which would let the guard's removal pass unnoticed.
    const observations: Array<{ started: boolean; reverted: boolean }> = [];
    const { suspension, deps } = harness({
      teardown: async () => {
        observations.push({
          started: suspension.teardownStarted,
          reverted: revertSuspension(suspension, 99),
        });
      },
    });
    const outcome = await runSuspensionAttempt(suspension, deps);
    expect(outcome).toBe('suspended');
    expect(observations).toEqual([{ started: true, reverted: false }]);
  });

  it('leaves a concurrent attempt alone', async () => {
    const { suspension, deps, calls } = harness();
    beginSuspensionClose(suspension);
    const outcome = await runSuspensionAttempt(suspension, deps);
    expect(outcome).toBe('reverted');
    expect(calls).toEqual([]);
    expect(suspension.gate).toBe('closing');
  });
});
