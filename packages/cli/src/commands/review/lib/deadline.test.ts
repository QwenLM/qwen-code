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
  COMPOSE_FLOOR_ENV,
  DEFAULT_RESERVE_SECONDS,
  DEFAULT_ROUND_SECONDS,
  DEFAULT_COMPOSE_FLOOR_SECONDS,
  DEFAULT_TOOL_CONCURRENCY,
  TOOL_CONCURRENCY_ENV,
  budgetStopEntry,
  budgetStopEntryZh,
  clearBudgetStop,
  expectedAdmissionSeconds,
  expectedRoundSeconds,
  readBudgetStop,
  readRoundStamps,
  reverseAuditBudgetExhausted,
  reverseAuditBudgetMessage,
  ROUND_CAP_PHRASE,
  roundCapStopDisclosure,
  roundCapStopEntry,
  roundCapStopEntryZh,
  writeRoundCapStop,
  stampRound,
  verifyBudgetExhausted,
  verifyBudgetMessage,
  writeBudgetStop,
} from './deadline.js';
import { promptRecordDir } from './prompt-record.js';

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

describe('the pair admission price — a round launched beside an in-flight round pays for both', () => {
  // The convergence pair's second member is built seconds after the first's
  // stamp, so nothing has measured a round yet. Pricing it off that
  // seconds-old span committed the pair at one round's price for up to two
  // rounds' wall — these pin the wave-priced pair instead.
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function plan(): string {
    const dir = mkdtempSync(join(tmpdir(), 'deadline-pair-'));
    dirs.push(dir);
    const p = join(dir, 'plan.json');
    writeFileSync(p, '{}');
    backdatePlan(p);
    return p;
  }

  it('prices a round with no in-flight predecessor like expectedRoundSeconds', () => {
    const p = plan();
    expect(expectedAdmissionSeconds(p, 1, 6, {}, NOW_MS)).toBe(
      DEFAULT_ROUND_SECONDS,
    );
    stampRound(p, 1, NOW_MS - 2_400_000); // round 1 returned 40 min ago
    expect(expectedAdmissionSeconds(p, 2, 6, {}, NOW_MS)).toBe(
      expectedRoundSeconds(p, 2, NOW_MS),
    );
    expect(expectedAdmissionSeconds(p, 2, 6, {}, NOW_MS)).toBe(2400);
  });

  it('prices the pair at both members when the pool serializes them', () => {
    // Six chunks on the default 10-slot pool: one wave per round, two
    // waves for the pair — the seconds-old round-1 stamp has measured
    // nothing, so the price is 2x the round estimate, not the floor.
    const p = plan();
    stampRound(p, 1, NOW_MS - 30_000);
    expect(expectedAdmissionSeconds(p, 2, 6, {}, NOW_MS)).toBe(
      2 * DEFAULT_ROUND_SECONDS,
    );
  });

  it('prices the pair at one round when the pool holds both members at once', () => {
    // Three chunks on ten slots: both members fit in a single wave, and
    // the pair's wall is one round's — the 3A shape reads the same (width
    // 1 on any pool of two or more).
    const p = plan();
    stampRound(p, 1, NOW_MS - 30_000);
    expect(expectedAdmissionSeconds(p, 2, 3, {}, NOW_MS)).toBe(
      DEFAULT_ROUND_SECONDS,
    );
    expect(expectedAdmissionSeconds(p, 2, 1, {}, NOW_MS)).toBe(
      DEFAULT_ROUND_SECONDS,
    );
  });

  it('reads the pool from the tool-concurrency env, like the scheduler', () => {
    const p = plan();
    stampRound(p, 1, NOW_MS - 30_000);
    // A 12-slot pool holds all twelve auditors of a 6-chunk pair in one
    // wave.
    expect(
      expectedAdmissionSeconds(
        p,
        2,
        6,
        { [TOOL_CONCURRENCY_ENV]: '12' },
        NOW_MS,
      ),
    ).toBe(DEFAULT_ROUND_SECONDS);
    // A 3-slot pool runs a 6-chunk round in two waves and the pair in
    // four — two rounds' price again.
    expect(
      expectedAdmissionSeconds(
        p,
        2,
        6,
        { [TOOL_CONCURRENCY_ENV]: '3' },
        NOW_MS,
      ),
    ).toBe(2 * DEFAULT_ROUND_SECONDS);
    // Malformed falls back to the default pool, never to a wedge.
    expect(
      expectedAdmissionSeconds(
        p,
        2,
        6,
        { [TOOL_CONCURRENCY_ENV]: 'soon' },
        NOW_MS,
      ),
    ).toBe(
      Math.ceil(
        (DEFAULT_ROUND_SECONDS * Math.ceil(12 / DEFAULT_TOOL_CONCURRENCY)) /
          Math.ceil(6 / DEFAULT_TOOL_CONCURRENCY),
      ),
    );
  });

  it('keeps the reserve on top of the pair price at the refusal boundary', () => {
    const p = plan();
    stampRound(p, 1, NOW_MS - 30_000);
    const price = expectedAdmissionSeconds(p, 2, 6, {}, NOW_MS);
    expect(price).toBe(2 * DEFAULT_ROUND_SECONDS);
    const env = {
      [DEADLINE_ENV]: String(NOW_S + DEFAULT_RESERVE_SECONDS + price),
    };
    expect(reverseAuditBudgetExhausted(env, price, NOW_MS)).toBeNull();
    env[DEADLINE_ENV] = String(NOW_S + DEFAULT_RESERVE_SECONDS + price - 1);
    expect(reverseAuditBudgetExhausted(env, price, NOW_MS)).not.toBeNull();
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

  it('first refusal wins — a later cap write does not flip a same-run budget marker', () => {
    // The retry-after-refusal misbehavior class: the time gate refuses round
    // 3, the orchestrator asks for round 4 anyway, the cap gate fires first
    // (4 > 3) and — without the guard — overwrites the marker. compose-review
    // would then splice out the wrong relayed entry and post two contradictory
    // stop disclosures. First-write-wins keeps the marker the audit actually
    // stopped on.
    const p = stopPlan();
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
    writeRoundCapStop(p, 3, 4, NOW_MS);
    const stop = readBudgetStop(p);
    expect(stop?.cause).toBeUndefined(); // still the time-budget marker
    expect(stop?.entry).toBe(
      'reverse audit — stopped before round 3 by the review time budget',
    );
  });

  it('first refusal wins the other way — a later budget write does not flip a cap marker', () => {
    const p = stopPlan();
    writeRoundCapStop(p, 3, 4, NOW_MS);
    writeBudgetStop(
      p,
      {
        remainingSeconds: 900,
        reserveSeconds: 3600,
        expectedRoundSeconds: 1800,
      },
      5,
      NOW_MS,
    );
    const stop = readBudgetStop(p);
    expect(stop?.cause).toBe('round-cap');
    expect(stop?.cap).toBe(3);
  });

  it('clearBudgetStop removes a same-run marker — and never throws', () => {
    // The CONVERGED-exit tests in agent-prompt.test.ts pin the call SITE;
    // this pins the function itself, so a refactor that moves the clear out
    // of refuseConverged (or unlinks a different file) fails here directly,
    // not only through the loop-level tests.
    const p = stopPlan();
    writeRoundCapStop(p, 3, 4, NOW_MS);
    expect(readBudgetStop(p)?.cause).toBe('round-cap');
    clearBudgetStop(p);
    expect(readBudgetStop(p)).toBeNull();
    // A repeat clear (file already gone), a run with no record dir at all,
    // and an unlink that fails (record dir blocked by a regular file) are
    // all no-ops, not throws: the file is the thing to be rid of, and a
    // clear that cannot run still only leaves a cap on, never corrupts a
    // verdict.
    expect(() => clearBudgetStop(p)).not.toThrow();
    const fresh = stopPlan();
    expect(() => clearBudgetStop(fresh)).not.toThrow();
    writeFileSync(promptRecordDir(fresh), 'a file where the record dir goes');
    expect(() => clearBudgetStop(fresh)).not.toThrow();
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
    // The load-bearing tail rules — a reword that drops any of these
    // silently loosens the termination contract, so pin each.
    expect(msg).toContain('agent-prompt --role verify');
    expect(msg).toContain('never a hand-rolled agent');
    expect(msg).toContain('compose floor');
    expect(msg).toContain('Do NOT re-verify findings already');
    // The wait-bound and no-fresh-pass clauses the round-cap refusal's
    // tail carries (and SKILL.md's budget-stop bullet documents) — the
    // two refusals share one bounded-tail protocol, so both pin both.
    expect(msg).toContain('stop waiting on any verifier batch still out');
    expect(msg).toContain('invent a fresh re-verification pass');
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

describe('writeRoundCapStop — the round-cap marker', () => {
  it('round-trips through readBudgetStop with cause and cap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-stop-'));
    try {
      const plan = join(dir, 'plan.json');
      writeFileSync(plan, '{}');
      backdatePlan(plan);
      writeRoundCapStop(plan, 3, 4, NOW_MS);
      const stop = readBudgetStop(plan);
      expect(stop?.cause).toBe('round-cap');
      expect(stop?.cap).toBe(3);
      expect(stop?.entry).toBe(roundCapStopEntry(3));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a cap marker from before the plan capture is a previous run — the guard still writes', () => {
    // Mirror of the budget-stop fence test for the round-cap writer: run 1
    // stops at the cap and is killed before cleanup; run 2 re-captures the
    // plan and runs past the cap again. The first-refusal-wins guard must
    // read through the stale file via the run-epoch fence — a raw
    // existsSync check would make run 2's writeRoundCapStop a no-op, and
    // compose-review would neither cap the verdict nor print the stop
    // disclosure for an audit that stopped at the cap.
    const dir = mkdtempSync(join(tmpdir(), 'rc-stop-'));
    try {
      const plan = join(dir, 'plan.json');
      writeFileSync(plan, '{}');
      backdatePlan(plan);
      writeRoundCapStop(plan, 3, 4, PLAN_CAPTURED_MS - 28_800_000); // 8h before capture
      expect(readBudgetStop(plan)).toBeNull(); // fenced out as a previous run
      writeRoundCapStop(plan, 3, 4, NOW_MS);
      const stop = readBudgetStop(plan);
      expect(stop?.cause).toBe('round-cap');
      expect(stop?.cap).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('disclosure names the cap in both languages', () => {
    expect(roundCapStopDisclosure(3).reason).toContain(ROUND_CAP_PHRASE);
    expect(roundCapStopDisclosure(3).reason).toContain('of 3');
    expect(roundCapStopEntryZh(3)).toContain('3');
  });

  it('writes round as an explicit null when the caller passes undefined', () => {
    // The chunkless call site (agent-prompt.ts) passes `round: undefined`; the
    // `?? null` fallback must keep the key PRESENT with a null value, not let
    // JSON.stringify drop it — a consumer that distinguishes null from an
    // absent key would otherwise misread the marker.
    const dir = mkdtempSync(join(tmpdir(), 'rc-stop-'));
    try {
      const plan = join(dir, 'plan.json');
      writeFileSync(plan, '{}');
      backdatePlan(plan);
      writeRoundCapStop(plan, 3, undefined, NOW_MS);
      const stop = readBudgetStop(plan);
      expect(stop).not.toBeNull();
      expect(stop && 'round' in stop).toBe(true);
      expect(stop?.round).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('verifyBudgetExhausted — the compose floor the verifier answers to', () => {
  it('fails OPEN on a missing or malformed deadline — every local run', () => {
    expect(verifyBudgetExhausted({}, NOW_MS)).toBeNull();
    expect(verifyBudgetExhausted({ [DEADLINE_ENV]: '' }, NOW_MS)).toBeNull();
    // A malformed/non-positive deadline must leave the gate inert, not
    // refuse every verify build — the sibling RA gate pins the same branch.
    for (const bad of ['soon', 'NaN', '-5', '0']) {
      expect(verifyBudgetExhausted({ [DEADLINE_ENV]: bad }, NOW_MS)).toBeNull();
    }
  });

  it('reports a past deadline as negative remaining under the default floor', () => {
    const spent = verifyBudgetExhausted(
      { [DEADLINE_ENV]: String(NOW_S - 120) },
      NOW_MS,
    );
    expect(spent).not.toBeNull();
    expect(spent?.remainingSeconds).toBe(-120);
  });

  it('a negative floor override falls back to the default, never a silent zero', () => {
    const env = {
      [DEADLINE_ENV]: String(NOW_S + DEFAULT_COMPOSE_FLOOR_SECONDS - 60),
      [COMPOSE_FLOOR_ENV]: '-100',
    };
    const spent = verifyBudgetExhausted(env, NOW_MS);
    expect(spent?.composeFloorSeconds).toBe(DEFAULT_COMPOSE_FLOOR_SECONDS);
  });

  it('a blank or whitespace floor override falls back — only explicit 0 disables', () => {
    // If the missing/blank guard weakens, Number('') === 0 silently trips the
    // documented disable hatch instead of using the fallback. Pin that a
    // blank/whitespace value falls back to the default (gate active), while
    // an explicit '0' still disables.
    const under = {
      [DEADLINE_ENV]: String(NOW_S + DEFAULT_COMPOSE_FLOOR_SECONDS - 60),
    };
    for (const blank of ['', '   ']) {
      const spent = verifyBudgetExhausted(
        { ...under, [COMPOSE_FLOOR_ENV]: blank },
        NOW_MS,
      );
      expect(spent?.composeFloorSeconds).toBe(DEFAULT_COMPOSE_FLOOR_SECONDS);
    }
    expect(
      verifyBudgetExhausted({ ...under, [COMPOSE_FLOOR_ENV]: '0' }, NOW_MS),
    ).toBeNull();
  });

  it('admits a verify build while the compose floor still fits', () => {
    const env = {
      [DEADLINE_ENV]: String(NOW_S + DEFAULT_COMPOSE_FLOOR_SECONDS + 60),
    };
    expect(verifyBudgetExhausted(env, NOW_MS)).toBeNull();
  });

  it('REFUSES at exact cover — the floor is compose-only, with nothing to spare', () => {
    // Unlike the reverse-audit reserve (which admits at exact cover, carrying
    // its own margin), the compose floor is the bare time compose+submit
    // need: at exactly the floor, admitting a verifier and letting it do any
    // work crosses below it. Equality must refuse.
    const env = {
      [DEADLINE_ENV]: String(NOW_S + DEFAULT_COMPOSE_FLOOR_SECONDS),
    };
    const spent = verifyBudgetExhausted(env, NOW_MS);
    expect(spent).not.toBeNull();
    expect(spent?.remainingSeconds).toBe(DEFAULT_COMPOSE_FLOOR_SECONDS);
  });

  it('admits one second above the floor', () => {
    const env = {
      [DEADLINE_ENV]: String(NOW_S + DEFAULT_COMPOSE_FLOOR_SECONDS + 1),
    };
    expect(verifyBudgetExhausted(env, NOW_MS)).toBeNull();
  });

  it('refuses once remaining drops below the compose floor', () => {
    const env = {
      [DEADLINE_ENV]: String(NOW_S + DEFAULT_COMPOSE_FLOOR_SECONDS - 60),
    };
    const spent = verifyBudgetExhausted(env, NOW_MS);
    expect(spent).not.toBeNull();
    expect(spent?.composeFloorSeconds).toBe(DEFAULT_COMPOSE_FLOOR_SECONDS);
    expect(spent?.remainingSeconds).toBe(DEFAULT_COMPOSE_FLOOR_SECONDS - 60);
  });

  it('honors the env override, including 0 as the disable hatch', () => {
    const near = { [DEADLINE_ENV]: String(NOW_S + 300) };
    // Floor lowered to 60s: 300s remaining now clears it.
    expect(
      verifyBudgetExhausted({ ...near, [COMPOSE_FLOOR_ENV]: '60' }, NOW_MS),
    ).toBeNull();
    // Floor 0 disables the gate entirely — the escape hatch.
    expect(
      verifyBudgetExhausted({ ...near, [COMPOSE_FLOOR_ENV]: '0' }, NOW_MS),
    ).toBeNull();
    // And it disables it PAST the deadline too: remainingSeconds is negative
    // there, and a comparison-only check (negative >= 0 is false) would fire
    // the supposedly-disabled gate. Zero must mean off unconditionally.
    const pastDeadline = { [DEADLINE_ENV]: String(NOW_S - 300) };
    expect(
      verifyBudgetExhausted(
        { ...pastDeadline, [COMPOSE_FLOOR_ENV]: '0' },
        NOW_MS,
      ),
    ).toBeNull();
    // A garbled override falls back to the default, which 300s fails.
    expect(
      verifyBudgetExhausted(
        { ...near, [COMPOSE_FLOOR_ENV]: 'nonsense' },
        NOW_MS,
      ),
    ).not.toBeNull();
  });

  it('the floor is strictly below the reserve — the verifier stops after the RA gate', () => {
    // The reserve covers verification PLUS compose; the floor is compose
    // alone. If the floor ever met or exceeded the reserve, the verify gate
    // would fire before the reverse-audit gate and starve the very
    // verification the reserve exists to protect.
    expect(DEFAULT_COMPOSE_FLOOR_SECONDS).toBeLessThan(DEFAULT_RESERVE_SECONDS);
  });

  it('the refusal message says compose now and keeps unverified findings', () => {
    const spent = verifyBudgetExhausted(
      { [DEADLINE_ENV]: String(NOW_S + 300) },
      NOW_MS,
    );
    const msg = verifyBudgetMessage(spent!);
    expect(msg).toContain('VERIFY BUDGET:');
    expect(msg).toContain('compose');
    expect(msg).toContain('[unverified]');
    expect(msg).toContain('5 minute(s) remain');
    // Pin the FLOOR rendering, not just the remaining time: a field swap of
    // composeFloorSeconds→remainingSeconds would misstate the protected
    // floor to the orchestrator that decides whether to stop.
    expect(msg).toContain('20-minute floor');
    // The publication contract, stated as the invariant both readings agree
    // on (not the pre-existing posted-vs-terminal question this PR does not
    // relitigate): an unverified finding is never a confirmed blocker.
    expect(msg).toContain('never treats an unverified finding as a confirmed');
  });

  it('clamps a negative remaining to zero — a post-deadline verify call', () => {
    // Reachable: verifyBudgetExhausted returns non-null with negative
    // remaining past the deadline. Without the Math.max(0, …) clamp the line
    // would read "-2 minute(s) remain"; the sibling RA message pins the same.
    const msg = verifyBudgetMessage({
      remainingSeconds: -120,
      composeFloorSeconds: DEFAULT_COMPOSE_FLOOR_SECONDS,
    });
    expect(msg).toContain('0 minute(s) remain');
  });
});
