/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUDGET_STOP_PHRASE,
  DEADLINE_ENV,
  RESERVE_ENV,
  DEFAULT_RESERVE_SECONDS,
  DEFAULT_ROUND_SECONDS,
  budgetStopEntry,
  budgetStopEntryZh,
  expectedRoundSeconds,
  readBudgetStop,
  readRoundStamps,
  reverseAuditBudgetExhausted,
  reverseAuditBudgetMessage,
  stampRound,
  writeBudgetStop,
} from './deadline.js';

const NOW_MS = 1_754_000_000_000;
const NOW_S = NOW_MS / 1000;
const REQUIRED = DEFAULT_RESERVE_SECONDS + DEFAULT_ROUND_SECONDS;

/** This test run's plan-capture instant: stamps and markers are fenced by
 * the plan's mtime (a rerun rewrites the plan), and the fixture clock here
 * is `NOW_MS`, not the wall clock — so the plan must be dated before the
 * records the tests write against it. */
const PLAN_CAPTURED_MS = NOW_MS - 10_000_000;

function backdatePlan(p: string, atMs: number = PLAN_CAPTURED_MS): void {
  utimesSync(p, atMs / 1000, atMs / 1000);
}

describe('reverseAuditBudgetExhausted — the round must fit, and its tail', () => {
  it('stays silent when no deadline is set — every local run', () => {
    expect(
      reverseAuditBudgetExhausted({}, DEFAULT_ROUND_SECONDS, NOW_MS),
    ).toBeNull();
    expect(
      reverseAuditBudgetExhausted(
        { [DEADLINE_ENV]: '' },
        DEFAULT_ROUND_SECONDS,
        NOW_MS,
      ),
    ).toBeNull();
  });

  it('admits a round while round-plus-reserve still fits', () => {
    const env = { [DEADLINE_ENV]: String(NOW_S + REQUIRED + 60) };
    expect(
      reverseAuditBudgetExhausted(env, DEFAULT_ROUND_SECONDS, NOW_MS),
    ).toBeNull();
  });

  it('admits at EXACT cover — remaining equal to reserve plus round cost', () => {
    // The `>=` is the documented rule: exact cover admits. Pin the boundary
    // so a future "safety margin" edit cannot silently end the loop one
    // round early whenever remaining lands exactly on it.
    const env = { [DEADLINE_ENV]: String(NOW_S + REQUIRED) };
    expect(
      reverseAuditBudgetExhausted(env, DEFAULT_ROUND_SECONDS, NOW_MS),
    ).toBeNull();
  });

  it('refuses a round the reserve alone would have admitted', () => {
    // The review's table: a round admitted at reserve + ε runs 28-53 minutes
    // and leaves the tail nothing. The gate must count the round itself.
    const env = {
      [DEADLINE_ENV]: String(NOW_S + DEFAULT_RESERVE_SECONDS + 300),
    };
    const spent = reverseAuditBudgetExhausted(
      env,
      DEFAULT_ROUND_SECONDS,
      NOW_MS,
    );
    expect(spent).toEqual({
      remainingSeconds: DEFAULT_RESERVE_SECONDS + 300,
      reserveSeconds: DEFAULT_RESERVE_SECONDS,
      expectedRoundSeconds: DEFAULT_ROUND_SECONDS,
    });
  });

  it('honours a reserve override, in both directions', () => {
    const env = {
      [DEADLINE_ENV]: String(NOW_S + 600 + DEFAULT_ROUND_SECONDS + 60),
      [RESERVE_ENV]: '600',
    };
    expect(
      reverseAuditBudgetExhausted(env, DEFAULT_ROUND_SECONDS, NOW_MS),
    ).toBeNull();
    env[RESERVE_ENV] = '1200';
    expect(
      reverseAuditBudgetExhausted(env, DEFAULT_ROUND_SECONDS, NOW_MS),
    ).not.toBeNull();
  });

  it('honours the reserve-0 escape hatch — only the round itself must fit', () => {
    // `r >= 0` (not `> 0`) is the documented escape hatch: reserve 0 keeps
    // only the refusal of a round that cannot finish before the deadline.
    // An edit to `> 0` would silently fall back to the 4800s default and
    // refuse the next round a full hour before the operator's deadline.
    const env = {
      [DEADLINE_ENV]: String(NOW_S + DEFAULT_ROUND_SECONDS + 60),
      [RESERVE_ENV]: '0',
    };
    expect(
      reverseAuditBudgetExhausted(env, DEFAULT_ROUND_SECONDS, NOW_MS),
    ).toBeNull();
    env[DEADLINE_ENV] = String(NOW_S + DEFAULT_ROUND_SECONDS - 60);
    const spent = reverseAuditBudgetExhausted(
      env,
      DEFAULT_ROUND_SECONDS,
      NOW_MS,
    );
    expect(spent?.reserveSeconds).toBe(0);
  });

  it('fails OPEN on a malformed deadline — the outer kill still bounds the run', () => {
    for (const bad of ['soon', 'NaN', '-5', '0']) {
      expect(
        reverseAuditBudgetExhausted(
          { [DEADLINE_ENV]: bad },
          DEFAULT_ROUND_SECONDS,
          NOW_MS,
        ),
      ).toBeNull();
    }
  });

  it('ignores a malformed reserve and keeps the default', () => {
    const env = {
      [DEADLINE_ENV]: String(NOW_S + REQUIRED - 1),
      [RESERVE_ENV]: 'an hour',
    };
    const spent = reverseAuditBudgetExhausted(
      env,
      DEFAULT_ROUND_SECONDS,
      NOW_MS,
    );
    expect(spent?.reserveSeconds).toBe(DEFAULT_RESERVE_SECONDS);
  });

  it('reports a past deadline as negative remaining, not a crash', () => {
    const env = { [DEADLINE_ENV]: String(NOW_S - 120) };
    const spent = reverseAuditBudgetExhausted(
      env,
      DEFAULT_ROUND_SECONDS,
      NOW_MS,
    );
    expect(spent?.remainingSeconds).toBe(-120);
  });
});

describe('the round-cost estimate — measured when it can be', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function plan(): string {
    const dir = mkdtempSync(join(tmpdir(), 'deadline-'));
    dirs.push(dir);
    const p = join(dir, 'plan.json');
    writeFileSync(p, '{}');
    backdatePlan(p);
    return p;
  }

  it('falls back to the constant when nothing has been measured', () => {
    expect(expectedRoundSeconds(plan(), 1, NOW_MS)).toBe(DEFAULT_ROUND_SECONDS);
  });

  it('uses the previous round, admission to admission', () => {
    const p = plan();
    stampRound(p, 1, NOW_MS - 2_400_000); // round 1 admitted 40 min ago
    expect(expectedRoundSeconds(p, 2, NOW_MS)).toBe(2400);
  });

  it('prices from the COSTLIEST measured round, not the newest', () => {
    const p = plan();
    stampRound(p, 1, NOW_MS - 3_000_000); // round 1 admitted 50 min ago
    stampRound(p, 2, NOW_MS - 1_200_000); // round 2 admitted 20 min ago
    // Round 1's span (admission to admission) is 30 minutes; round 2's
    // still-open span is 20. The reserve is the terminal round's only
    // cover, so the gate holds the worst case the run has proved — a
    // repair relaunch makes one round the expensive one, and a newest-only
    // estimate nets it away the round after it lands.
    expect(expectedRoundSeconds(p, 3, NOW_MS)).toBe(1800);
  });

  it('the costliest span can be a MIDDLE round', () => {
    const p = plan();
    stampRound(p, 1, NOW_MS - 4_000_000);
    stampRound(p, 2, NOW_MS - 2_000_000); // round 1's span: 33 min
    stampRound(p, 3, NOW_MS - 1_500_000); // round 2's span: 8 min
    // Round 3's open span is 25 min; the max is round 1's 33-minute span —
    // neither the first nor the newest span measured from `now` alone.
    expect(expectedRoundSeconds(p, 4, NOW_MS)).toBe(2000);
  });

  it('ignores a stamp of the SAME round — a rebuild is not a round', () => {
    const p = plan();
    stampRound(p, 1, NOW_MS - 2_400_000);
    stampRound(p, 2, NOW_MS - 60_000); // round 2 admitted a minute ago
    // Rebuilding round 2 must not read its own stamp as "rounds cost 60s";
    // it reaches past it to round 1's.
    expect(expectedRoundSeconds(p, 2, NOW_MS)).toBe(2400);
  });

  it('floors a suspiciously quick observation', () => {
    const p = plan();
    stampRound(p, 1, NOW_MS - 30_000);
    expect(expectedRoundSeconds(p, 2, NOW_MS)).toBe(600);
  });

  it('stamps once per round, and the FIRST admission is the one that survives', () => {
    // First-wins is the load-bearing half: "refresh the stamp on rebuild"
    // (last-wins) also leaves one stamp, but a chunk rebuild late in a round
    // would then collapse the next round's estimate to the 600s floor and
    // the gate would admit a terminal round on headroom it does not have.
    const p = plan();
    stampRound(p, 1, NOW_MS - 100);
    stampRound(p, 1, NOW_MS);
    expect(readRoundStamps(p)).toEqual([{ round: 1, atMs: NOW_MS - 100 }]);
  });

  it('ignores stamps older than the plan — a previous run of the same PR', () => {
    // The stamps key on the per-PR-stable plan path, and a run killed by the
    // outer deadline never reaches cleanup — but every run rewrites the plan
    // at its Step 1 capture, so the plan's mtime fences the runs apart.
    // Without the fence, an hours-old stamp reads as an hours-long round and
    // refuses round 1 of a fresh budget.
    const p = plan();
    stampRound(p, 1, PLAN_CAPTURED_MS - 28_800_000); // 8h before this capture
    stampRound(p, 2, PLAN_CAPTURED_MS - 27_000_000);
    expect(readRoundStamps(p)).toEqual([]);
    expect(expectedRoundSeconds(p, 1, NOW_MS)).toBe(DEFAULT_ROUND_SECONDS);
    // A stamp from THIS run still measures, with the stale ones alongside.
    stampRound(p, 1, NOW_MS - 2_400_000);
    expect(readRoundStamps(p)).toEqual([
      { round: 1, atMs: NOW_MS - 2_400_000 },
    ]);
    expect(expectedRoundSeconds(p, 2, NOW_MS)).toBe(2400);
  });

  it('persists a round-less stamp as null, outside the one-per-round guard', () => {
    // The guard dedups by round LABEL; an unlabeled stamp has none to dedup
    // by, so it persists — pinned here because `agent-prompt` rejects a
    // round-less reverse-audit call and nothing else exercises the shape.
    const p = plan();
    stampRound(p, undefined, NOW_MS - 100);
    stampRound(p, undefined, NOW_MS);
    expect(readRoundStamps(p)).toEqual([
      { round: null, atMs: NOW_MS - 100 },
      { round: null, atMs: NOW_MS },
    ]);
  });
});

describe('the budget-stop marker — the deterministic half of the disclosure', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function stopPlan(): string {
    const dir = mkdtempSync(join(tmpdir(), 'deadline-stop-'));
    dirs.push(dir);
    const p = join(dir, 'plan.json');
    writeFileSync(p, '{}');
    backdatePlan(p);
    return p;
  }

  it('round-trips, entry text and all', () => {
    const p = stopPlan();
    writeBudgetStop(
      p,
      {
        remainingSeconds: 900,
        reserveSeconds: 3600,
        expectedRoundSeconds: 1800,
      },
      4,
      NOW_MS,
    );
    const stop = readBudgetStop(p);
    expect(stop?.entry).toBe(
      'reverse audit — stopped before round 4 by the review time budget',
    );
    expect(stop?.entryZh).toBe('反向审计——评审时间预算不足，未能开始第 4 轮');
    expect(stop?.round).toBe(4);
    expect(readBudgetStop(join(dirname(p), 'other.json'))).toBeNull();
  });

  it('a marker from before the plan capture is a previous run — read as none', () => {
    // Run 1 refuses a round, writes the marker, and is killed before Step 9
    // cleanup; run 2 rewrites the plan, admits every round, and never trips
    // the gate. Its verdict must not be capped by a stop that did not happen
    // in it.
    const p = stopPlan();
    writeBudgetStop(
      p,
      {
        remainingSeconds: 900,
        reserveSeconds: 3600,
        expectedRoundSeconds: 1800,
      },
      3,
      PLAN_CAPTURED_MS - 28_800_000, // 8h before this run's capture
    );
    expect(readBudgetStop(p)).toBeNull();
    // A marker written by THIS run replaces it and reads back.
    writeBudgetStop(
      p,
      {
        remainingSeconds: 900,
        reserveSeconds: 3600,
        expectedRoundSeconds: 1800,
      },
      3,
      NOW_MS,
    );
    expect(readBudgetStop(p)?.round).toBe(3);
  });

  it('the dedup phrase travels with the entry it identifies', () => {
    // compose-review dedups the orchestrator's relayed copy by this phrase;
    // a reword of the entry that left the phrase behind would post the
    // disclosure twice.
    expect(budgetStopEntry(2)).toContain(BUDGET_STOP_PHRASE);
    expect(budgetStopEntry(undefined)).toContain(BUDGET_STOP_PHRASE);
  });

  it('the zh entry pairs the en one, for a numbered round and without', () => {
    expect(budgetStopEntryZh(4)).toBe(
      '反向审计——评审时间预算不足，未能开始第 4 轮',
    );
    expect(budgetStopEntryZh(undefined)).toBe(
      '反向审计——评审时间预算不足，未能开始下一轮',
    );
  });
});

describe('the CI wiring contract', () => {
  it('the workflow exports the exact env names the gate reads', () => {
    // Renaming either side compiles, lints, and leaves every test green —
    // the CLI just never sees a deadline, every round is admitted, and the
    // outer kill returns. Pin the two halves of the contract together.
    const workflow = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        '..',
        '..',
        '..',
        '..',
        '.github',
        'workflows',
        'qwen-code-pr-review.yml',
      ),
      'utf8',
    );
    // Whole line, not substring: `toContain('export QWEN_REVIEW_DEADLINE_EPOCH')`
    // stayed green when the variable was renamed to any superstring
    // (`..._EPOCH_SECONDS` is the natural drift beside `..._RESERVE_SECONDS`)
    // and when the export was commented out — both leave the CLI deadline-less
    // and the gate failing open on every round.
    expect(workflow).toMatch(new RegExp(`^\\s*export ${DEADLINE_ENV}$`, 'm'));
    expect(workflow).toMatch(new RegExp(`^\\s*export ${RESERVE_ENV}$`, 'm'));
    // The units are part of the contract: a milliseconds deadline admits every
    // round forever (remaining ≈ 1.7e12); minutes instead of seconds refuses
    // round 1 on every budgeted run. Pin the arithmetic that fixes both to
    // whole seconds of epoch / of reserve.
    expect(workflow).toContain(
      `${DEADLINE_ENV}="$(( $(date +%s) + attempt_timeout ))"`,
    );
    expect(workflow).toContain(`${RESERVE_ENV}="$(( attempt_timeout / 3 ))"`);
    // The workflow's reserve cap documents itself as mirroring
    // DEFAULT_RESERVE_SECONDS ("keep the two in sync") — enforce the mirror,
    // so a one-sided bump diverges a test instead of the CI tail.
    expect(workflow).toContain(`-gt ${DEFAULT_RESERVE_SECONDS}`);
  });
});

describe('reverseAuditBudgetMessage', () => {
  it('names the round, both costs, and the exact disclosure entry', () => {
    const msg = reverseAuditBudgetMessage(
      {
        remainingSeconds: 1500,
        reserveSeconds: 3600,
        expectedRoundSeconds: 1800,
      },
      3,
    );
    expect(msg).toContain('BUDGET:');
    expect(msg).toContain('25 minute(s) remain');
    expect(msg).toContain('~30-minute round');
    expect(msg).toContain('60-minute reserve');
    expect(msg).toContain(`\`${budgetStopEntry(3)}\``);
    expect(msg).toContain('budget-stop marker');
    expect(msg).toContain('proceed to Step 6');
    expect(msg).toContain('do not relaunch auditors');
  });

  it('says "the next round" when no round number was passed', () => {
    const msg = reverseAuditBudgetMessage(
      {
        remainingSeconds: -30,
        reserveSeconds: 3600,
        expectedRoundSeconds: 1800,
      },
      undefined,
    );
    expect(msg).toContain('0 minute(s) remain');
    expect(msg).toContain('stopped before the next round');
  });
});
