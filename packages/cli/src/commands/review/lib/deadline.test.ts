/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

// The real fs, wrapped so the claim-write fault below is injectable
// under ANY uid: a permission-based stimulus does not fault for root
// (root ignores 0o555 mode bits), and ESM namespace objects are not
// configurable for vi.spyOn — the wrapper keeps every other export the
// real function (#9272).
const fsFault = vi.hoisted(() => ({ failClaimWrite: false }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const mock = {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (fsFault.failClaimWrite) {
        const err = new Error('EACCES') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return actual.writeFileSync(...args);
    },
  };
  return { ...mock, default: mock };
});
import {
  existsSync,
  mkdirSync,
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
  DEFAULT_DEADLINE_SECONDS,
  budgetStopEntry,
  captureDeadline,
  hasReviewDeadline,
  minimumDeadlineSeconds,
  parseDeadlineOption,
  planReserveSeconds,
  resolveReviewDeadline,
  budgetStopEntryZh,
  claimRetirementDegradeNote,
  clearBudgetStop,
  clearRoundStamps,
  expectedAdmissionSeconds,
  expectedRoundSeconds,
  readBudgetStop,
  readBudgetStopUnfenced,
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
import { appendRunSession } from './run-ledger.js';

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
  it('stays silent when no deadline resolves — no env, and no plan to read a wall from', () => {
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

  it('claimRetirementDegradeNote claims once per round, per run (#9272)', () => {
    // The per-chunk builds of a round are separate CLI processes, so the
    // claim lives on disk beside the stamps: first claim prints, later
    // builds of the same round stay silent, a different round speaks, and
    // a NEW run (the plan re-captured at the same path) re-arms the note —
    // the retry's channel must not be silenced by the killed run's claim.
    const p = plan();
    expect(claimRetirementDegradeNote(p, 3)).toBe(true);
    expect(claimRetirementDegradeNote(p, 3)).toBe(false);
    expect(claimRetirementDegradeNote(p, 4)).toBe(true);
    const later = new Date(Date.now() + 3_600_000);
    utimesSync(p, later, later);
    expect(claimRetirementDegradeNote(p, 3)).toBe(true);
  });

  it('claimRetirementDegradeNote fences on the STRICT plan mtime — a claim seconds before a re-capture is stale (#9272)', () => {
    // The slack-adjusted epoch would re-admit the dead run's claim here:
    // the claim lands, the retry re-captures the plan one second later,
    // and the retried run's NOTE must still print.
    const p = plan();
    expect(claimRetirementDegradeNote(p, 3)).toBe(true);
    const oneSecondLater = new Date(Date.now() + 1_000);
    utimesSync(p, oneSecondLater, oneSecondLater);
    expect(claimRetirementDegradeNote(p, 3)).toBe(true);
  });

  it('claimRetirementDegradeNote fails OPEN when the record dir is uncreatable — silence is the only wrong answer (#9272)', () => {
    // The record path exists as a REGULAR FILE: the recursive mkdir
    // throws EEXIST — which is not a claim — and the note must still
    // print, or a dead record path swallows the degrade NOTE on every
    // round. Filesystem shape faults for every uid; a permission-based
    // stimulus (chmod 0o555) does not fault at all for a uid-0 run,
    // where root ignores the mode bits and the test passes through the
    // success path (#9272).
    const p = plan();
    writeFileSync(promptRecordDir(p), 'a file where the record dir goes');
    expect(claimRetirementDegradeNote(p, 3)).toBe(true);
  });

  it('claimRetirementDegradeNote fails OPEN when the claim write faults — for any uid (#9272)', () => {
    // The `wx` create's catch must read ONLY EEXIST as "claimed": an
    // EACCES fault on the write reports printable, or the degrade NOTE
    // is swallowed exactly when the filesystem is the thing that's
    // broken. The stimulus is an injected throw, not permission bits —
    // under uid 0 root ignores a 0o555 dir and the write succeeds,
    // leaving the catch branch this test exists to pin unexercised. The
    // claim file's ABSENCE proves the fault actually ran, so this
    // cannot pass vacuously through the success path.
    const p = plan();
    const claim = join(
      promptRecordDir(p),
      'retirement-degrade-note-round-3.json',
    );
    fsFault.failClaimWrite = true;
    try {
      expect(claimRetirementDegradeNote(p, 3)).toBe(true);
      expect(existsSync(claim)).toBe(false);
    } finally {
      fsFault.failClaimWrite = false;
    }
  });

  it('claimRetirementDegradeNote reclaims a non-file occupant and a stale claim (#9272)', () => {
    // The fence keys on SHAPE and the claim's own `atMs` vs the plan
    // epoch, not the occupant's mtime — filesystem mtimes are not
    // reliable across runners (#9272 CI). A directory at the claim path
    // is never a claim and is removed so the claim lands; a readable
    // claim older than the epoch belongs to the killed run and is
    // reclaimed. Both land a real claim, so the dedup then holds.
    const p = plan();
    const dir = promptRecordDir(p);
    mkdirSync(dir, { recursive: true });
    // A directory occupant is removed and the claim lands.
    mkdirSync(join(dir, 'retirement-degrade-note-round-3.json'));
    expect(claimRetirementDegradeNote(p, 3)).toBe(true);
    expect(claimRetirementDegradeNote(p, 3)).toBe(false);
    // A stale claim FILE (atMs older than the plan epoch) is reclaimed.
    writeFileSync(
      join(dir, 'retirement-degrade-note-round-4.json'),
      JSON.stringify({ round: 4, atMs: 1 }),
    );
    expect(claimRetirementDegradeNote(p, 4)).toBe(true);
    expect(claimRetirementDegradeNote(p, 4)).toBe(false);
    // A corrupt claim FILE is not a claim either — reclaimed, not
    // EEXIST-silenced (#9272 torn-write).
    writeFileSync(join(dir, 'retirement-degrade-note-round-5.json'), '{');
    expect(claimRetirementDegradeNote(p, 5)).toBe(true);
    expect(claimRetirementDegradeNote(p, 5)).toBe(false);
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
        { QWEN_CODE_MAX_TOOL_CONCURRENCY: '12' },
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
        { QWEN_CODE_MAX_TOOL_CONCURRENCY: '3' },
        NOW_MS,
      ),
    ).toBe(2 * DEFAULT_ROUND_SECONDS);
    // Malformed falls back to the default pool, never to a wedge.
    expect(
      expectedAdmissionSeconds(
        p,
        2,
        6,
        { QWEN_CODE_MAX_TOOL_CONCURRENCY: 'soon' },
        NOW_MS,
      ),
    ).toBe(2 * DEFAULT_ROUND_SECONDS);
  });

  it('prices the workflow override before the tool pool, including one slot', () => {
    const p = plan();
    stampRound(p, 1, NOW_MS - 30_000);
    for (const [pool, expected] of [
      ['1', 2],
      ['12', 1],
    ] as const) {
      expect(
        expectedAdmissionSeconds(
          p,
          2,
          6,
          {
            QWEN_CODE_MAX_WORKFLOW_CONCURRENCY: pool,
            QWEN_CODE_MAX_TOOL_CONCURRENCY: '10',
          },
          NOW_MS,
        ),
      ).toBe(expected * DEFAULT_ROUND_SECONDS);
    }
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

  it('clearBudgetStop keeps a previous run\u2019s marker — convergence clears only its own (#9206)', () => {
    // Run 1 stops at the cap and is killed before Step 9; its marker is
    // what the NEXT cleanup keys retention on. Run 2 re-captures the plan
    // and CONVERGES: refuseConverged's clear must unlink only run 2's own
    // marker — an unconditional rmSync removed run 1's, and the next
    // sweep took the certification history with it.
    const p = stopPlan();
    writeRoundCapStop(p, 5, 6, PLAN_CAPTURED_MS - 28_800_000); // run 1's stop
    clearBudgetStop(p);
    // Still on disk — retention's unfenced read still sees it, while the
    // fenced reader this run's verdict reads through still does not.
    expect(readBudgetStopUnfenced(p)?.cause).toBe('round-cap');
    expect(readBudgetStop(p)).toBeNull();
    // And this run's own marker still clears.
    writeRoundCapStop(p, 5, 6, NOW_MS);
    clearBudgetStop(p);
    expect(readBudgetStopUnfenced(p)).toBeNull();
  });

  it('readBudgetStopUnfenced reads a valid marker from ANY run — and nothing else', () => {
    const p = stopPlan();
    expect(readBudgetStopUnfenced(p)).toBeNull();
    writeRoundCapStop(p, 5, 6, PLAN_CAPTURED_MS - 28_800_000);
    // The fenced reader drops it as a previous run; the unfenced one —
    // retention's eye — still sees it, shape and all.
    expect(readBudgetStop(p)).toBeNull();
    expect(readBudgetStopUnfenced(p)?.cause).toBe('round-cap');
    // "Nothing else" includes the shape gate (#9259 — it was pinned only
    // by absence): an object without a string `entry` or a numeric
    // `atMs` cannot prove it is a stop marker and reads as none.
    const stopFile = join(promptRecordDir(p), 'budget-stop.json');
    writeFileSync(stopFile, JSON.stringify({ cause: 'round-cap', entry: 'x' }));
    expect(readBudgetStopUnfenced(p)).toBeNull();
    writeFileSync(stopFile, JSON.stringify({ cause: 'round-cap', atMs: 42 }));
    expect(readBudgetStopUnfenced(p)).toBeNull();
    writeFileSync(stopFile, 'not json');
    expect(readBudgetStopUnfenced(p)).toBeNull();
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
  it('fails OPEN on a missing or malformed deadline — nothing resolves without a plan', () => {
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

describe('clearRoundStamps — the resume hygiene', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function plan(): string {
    const dir = mkdtempSync(join(tmpdir(), 'deadline-clear-'));
    dirs.push(dir);
    const p = join(dir, 'plan.json');
    writeFileSync(p, '{}');
    backdatePlan(p);
    return p;
  }

  it('removes the stamps so the gate falls back to its constant', () => {
    const p = plan();
    stampRound(p, 1, NOW_MS - 2_400_000);
    expect(expectedRoundSeconds(p, 2, NOW_MS)).toBe(2400);
    clearRoundStamps(p);
    expect(expectedRoundSeconds(p, 2, NOW_MS)).toBe(DEFAULT_ROUND_SECONDS);
  });

  it('is silent when there is nothing to remove', () => {
    expect(() => clearRoundStamps(plan())).not.toThrow();
  });
});

describe('parseDeadlineOption — the flag grammar', () => {
  it('reads an absent flag as the default — and a BLANK one as a usage error', () => {
    // `--deadline "$UNSET"` in a script must not quietly take the default it
    // was trying to override.
    expect(parseDeadlineOption(undefined)).toBe('default');
    expect(() => parseDeadlineOption('')).toThrow(TypeError);
    expect(() => parseDeadlineOption('   ')).toThrow(TypeError);
  });

  it('reads `none` in any case as no wall', () => {
    expect(parseDeadlineOption('none')).toBe('none');
    expect(parseDeadlineOption(' NONE ')).toBe('none');
  });

  it('reads whole positive minutes as seconds', () => {
    expect(parseDeadlineOption('91')).toEqual({ seconds: 5460 });
    expect(parseDeadlineOption(' 120 ')).toEqual({ seconds: 7200 });
  });

  it('refuses anything else as a USAGE error — a TypeError, the class the handlers give their argument errors', () => {
    // `0` and negatives would resolve to a wall already in the past and
    // refuse round 1 of every run; fractions and units would silently read
    // as something the caller did not type. All four are the caller's typo.
    // plan-diff maps a TypeError to exit 2; fetch-pr and capture-local
    // surface it the way they surface their other argument errors.
    for (const bad of ['0', '-5', '1.5', '90m', 'soon', '1e3', 'none ish']) {
      expect(() => parseDeadlineOption(bad)).toThrow(TypeError);
      expect(() => parseDeadlineOption(bad)).toThrow(
        /--deadline must be a whole number of minutes or `none`/,
      );
    }
  });

  it('refuses a non-string (`--no-deadline` arrives as false) and an unsafe integer', () => {
    // A 310-digit run of nines parses to Infinity, which JSON writes as
    // `null` — no wall — after the capture already priced the tier as
    // explicitly clocked. Safe integers only, and the usage message, not a
    // `.trim is not a function` crash, for the boolean yargs hands over.
    for (const bad of [false, true, 90, null, {}, '9'.repeat(310)]) {
      expect(() => parseDeadlineOption(bad)).toThrow(
        /--deadline must be a whole number of minutes or `none`/,
      );
    }
    expect(() => parseDeadlineOption('9007199254740992')).toThrow(TypeError);
    expect(parseDeadlineOption('9007199254740991')).toEqual({
      seconds: 9007199254740991 * 60,
    });
  });

  it('refuses a wall that cannot hold a convergence — up front, strictly, and the same in every shell', () => {
    // Two rounds at the estimate plus the reserve the wall implies: at the
    // 1200s floor that is 6000s, so a 90-minute wall (reserve 1800 → 5400)
    // is exactly the floor and is refused — the wall is spent from capture,
    // so equality never admits — while 91 minutes clears it. Priced from the
    // default reserve rule: the shell's overrides do not move the ruling.
    expect(minimumDeadlineSeconds(5400)).toBe(5400);
    expect(() => parseDeadlineOption('90')).toThrow(
      /--deadline 90 cannot hold a convergence: .*MORE than 90 minutes/,
    );
    expect(parseDeadlineOption('91')).toEqual({ seconds: 5460 });
    expect(() => parseDeadlineOption('50')).toThrow(TypeError);
    expect(() => parseDeadlineOption('1')).toThrow(TypeError);
    // `none` and the default are never too short: there is nothing to check.
    expect(parseDeadlineOption('none')).toBe('none');
    expect(parseDeadlineOption(undefined)).toBe('default');
  });
});

describe('captureDeadline — what a capture records, and whether the clock is explicit', () => {
  const SMALL = { srcDiffLines: 100, diffLines: 100 };
  const LARGE = { srcDiffLines: 900, diffLines: 900 };
  const HUGE = { srcDiffLines: 5000, diffLines: 5000 };

  it('records the tier default, and the default is never explicit', () => {
    expect(captureDeadline({}, undefined, SMALL)).toEqual({
      fields: {
        deadlineSeconds: DEFAULT_DEADLINE_SECONDS.small,
        deadlineSource: 'default',
      },
      explicit: false,
    });
    expect(captureDeadline({}, undefined, LARGE).fields).toEqual({
      deadlineSeconds: DEFAULT_DEADLINE_SECONDS.large,
      deadlineSource: 'default',
    });
    expect(captureDeadline({}, undefined, HUGE).fields).toEqual({
      deadlineSeconds: DEFAULT_DEADLINE_SECONDS.huge,
      deadlineSource: 'default',
    });
    // The unsized fallback reads the large tier, like the round cap does.
    expect(captureDeadline({}, undefined, {}).fields).toEqual({
      deadlineSeconds: DEFAULT_DEADLINE_SECONDS.large,
      deadlineSource: 'default',
    });
  });

  it('the defaults are whole hours, ordered by tier, and above the CI budgets they were measured against', () => {
    // 8h / 12h / 16h: liveness bounds sized above a healthy run at the
    // cap (see the constant's comment for the measurements). Pin the shape
    // so a "tighten to save cost" edit has to argue with this test.
    expect(DEFAULT_DEADLINE_SECONDS).toEqual({
      small: 8 * 3600,
      large: 12 * 3600,
      huge: 16 * 3600,
    });
  });

  it('records the flag, and the flag IS explicit — with or without an env clock', () => {
    expect(captureDeadline({}, '120', HUGE)).toEqual({
      fields: { deadlineSeconds: 7200, deadlineSource: 'flag' },
      explicit: true,
    });
    expect(captureDeadline({ [DEADLINE_ENV]: 'soon' }, '120', HUGE)).toEqual({
      fields: { deadlineSeconds: 7200, deadlineSource: 'flag' },
      explicit: true,
    });
  });

  it('`none` records nothing; explicit then answers for the environment alone', () => {
    expect(captureDeadline({}, 'none', HUGE)).toEqual({
      fields: {},
      explicit: false,
    });
    expect(
      captureDeadline({ [DEADLINE_ENV]: String(NOW_S + 7200) }, 'none', HUGE),
    ).toEqual({ fields: {}, explicit: true });
  });

  it('an environment clock makes the default capture explicit; a malformed one does not', () => {
    expect(
      captureDeadline(
        { [DEADLINE_ENV]: String(NOW_S + 7200) },
        undefined,
        HUGE,
      ),
    ).toEqual({
      // The default wall is STILL written under an env clock: the env wins
      // at read time, but a plan that outlives its environment (a resume in
      // a shell that no longer exports it) needs a bound to fall back on —
      // and it is the default, so it never flips the huge tier.
      fields: {
        deadlineSeconds: DEFAULT_DEADLINE_SECONDS.huge,
        deadlineSource: 'default',
      },
      explicit: true,
    });
    for (const bad of ['', '  ', 'soon', '0', '-5', 'NaN']) {
      expect(
        captureDeadline({ [DEADLINE_ENV]: bad }, undefined, HUGE).explicit,
      ).toBe(false);
    }
    // …and a blank FLAG is the caller's error, never a silent default.
    expect(() => captureDeadline({}, '', HUGE)).toThrow(TypeError);
  });

  it('a malformed or too-short flag throws — the capture must not record a wall it cannot honour', () => {
    expect(() => captureDeadline({}, 'soon', HUGE)).toThrow(TypeError);
    expect(() => captureDeadline({}, '10', HUGE)).toThrow(
      /cannot hold a convergence/,
    );
  });
});

describe('planReserveSeconds — the tail a plan-recorded wall keeps', () => {
  it('is a third of the wall, floored at the compose floor and capped like the workflow', () => {
    // The workflow floors at 600; a plan wall floors AT the compose floor so
    // the verifier's floor never exceeds the reserve (equal at the floor —
    // the ordering test below pins that the round gate still fires first).
    expect(planReserveSeconds(30 * 60)).toBe(DEFAULT_COMPOSE_FLOOR_SECONDS); // 600 of 1800 → floored
    expect(planReserveSeconds(60 * 60)).toBe(DEFAULT_COMPOSE_FLOOR_SECONDS); // exactly the floor
    expect(planReserveSeconds(90 * 60)).toBe(1800);
    expect(planReserveSeconds(4 * 3600)).toBe(4800); // exactly the cap
    expect(planReserveSeconds(16 * 3600)).toBe(DEFAULT_RESERVE_SECONDS);
    expect(planReserveSeconds(1)).toBe(DEFAULT_COMPOSE_FLOOR_SECONDS);
  });
});

describe('resolveReviewDeadline — env, else the plan’s wall from the attempt start, else nothing', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A plan file dated `atMs`, carrying `fields` beside a small size. */
  function planAt(
    fields: Record<string, unknown>,
    atMs: number = PLAN_CAPTURED_MS,
  ): string {
    const dir = mkdtempSync(join(tmpdir(), 'deadline-plan-'));
    dirs.push(dir);
    const p = join(dir, 'plan.json');
    writeFileSync(
      p,
      JSON.stringify({ srcDiffLines: 100, diffLines: 100, ...fields }),
    );
    backdatePlan(p, atMs);
    return p;
  }

  it('the environment wins, explicit, whatever the plan says', () => {
    const p = planAt({ deadlineSeconds: 3600, deadlineSource: 'flag' });
    expect(
      resolveReviewDeadline({ [DEADLINE_ENV]: String(NOW_S + 99) }, p),
    ).toEqual({ epochSeconds: NOW_S + 99 });
    // …and "has a deadline" is answered by the reader that owns it.
    expect(hasReviewDeadline({ [DEADLINE_ENV]: String(NOW_S + 99) }, p)).toBe(
      true,
    );
  });

  it('a default wall resolves from the plan’s mtime and is NOT explicit', () => {
    const p = planAt({ deadlineSeconds: 28_800, deadlineSource: 'default' });
    expect(resolveReviewDeadline({}, p)).toEqual({
      epochSeconds: PLAN_CAPTURED_MS / 1000 + 28_800,
      deadlineSeconds: 28_800,
    });
    expect(hasReviewDeadline({}, p)).toBe(false);
  });

  it('a flag wall resolves the same way and IS explicit', () => {
    const p = planAt({ deadlineSeconds: 5400, deadlineSource: 'flag' });
    expect(resolveReviewDeadline({}, p)).toEqual({
      epochSeconds: PLAN_CAPTURED_MS / 1000 + 5400,
      deadlineSeconds: 5400,
    });
    expect(hasReviewDeadline({}, p)).toBe(true);
    // A malformed env clock does not mask the plan's flag.
    expect(hasReviewDeadline({ [DEADLINE_ENV]: 'soon' }, p)).toBe(true);
  });

  it('a plan with no wall (`--deadline none`, or a plan older than the field) resolves to nothing', () => {
    const p = planAt({});
    expect(resolveReviewDeadline({}, p)).toBeNull();
    expect(hasReviewDeadline({}, p)).toBe(false);
    // …and with no plan at all, only the env can answer.
    expect(resolveReviewDeadline({})).toBeNull();
    expect(hasReviewDeadline({})).toBe(false);
  });

  it('fails OPEN on a malformed plan field, and reads an unknown source as the default', () => {
    for (const bad of ['3600', 0, -5, null, true]) {
      const p = planAt({ deadlineSeconds: bad, deadlineSource: 'flag' });
      expect(resolveReviewDeadline({}, p)).toBeNull();
      expect(hasReviewDeadline({}, p)).toBe(false);
    }
    // A non-finite value can only arrive through a parsed object (JSON has
    // no spelling for it); it fails open the same way.
    const anyPlan = planAt({});
    for (const bad of [Number.POSITIVE_INFINITY, Number.NaN]) {
      const parsed = { deadlineSeconds: bad, deadlineSource: 'flag' };
      expect(resolveReviewDeadline({}, anyPlan, parsed)).toBeNull();
      expect(hasReviewDeadline({}, anyPlan, parsed)).toBe(false);
    }
    // A source the reader does not know is the SAFE reading: a wall that
    // does not flip the huge tier.
    const odd = planAt({ deadlineSeconds: 3600, deadlineSource: 'operator' });
    expect(resolveReviewDeadline({}, odd)?.deadlineSeconds).toBe(3600);
    expect(hasReviewDeadline({}, odd)).toBe(false);
  });

  it('fails OPEN when the plan is unreadable or not an object', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deadline-plan-'));
    dirs.push(dir);
    expect(resolveReviewDeadline({}, join(dir, 'missing.json'))).toBeNull();
    const list = join(dir, 'list.json');
    writeFileSync(list, '[3600]');
    expect(resolveReviewDeadline({}, list)).toBeNull();
    const text = join(dir, 'text.json');
    writeFileSync(text, '"3600"');
    expect(resolveReviewDeadline({}, text)).toBeNull();
    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{"deadlineSeconds": 36');
    expect(resolveReviewDeadline({}, broken)).toBeNull();
  });

  it('reads a parsed plan object when given one, but still needs the path for the start', () => {
    const p = planAt({});
    const parsed = { deadlineSeconds: 3600, deadlineSource: 'default' };
    // The path's mtime is the start; the object is the wall.
    expect(resolveReviewDeadline({}, p, parsed)?.epochSeconds).toBe(
      PLAN_CAPTURED_MS / 1000 + 3600,
    );
    // Whether the clock is explicit needs no start at all.
    expect(
      hasReviewDeadline({}, undefined, { ...parsed, deadlineSource: 'flag' }),
    ).toBe(true);
    expect(hasReviewDeadline({}, undefined, parsed)).toBe(false);
    // But an epoch cannot be derived from an object alone.
    expect(resolveReviewDeadline({}, undefined, parsed)).toBeNull();
  });

  it('a `--resume` from a NEW session renews the wall from that session’s ledger entry', () => {
    // The plan is never rewritten on resume, so its mtime is attempt 1's
    // start forever. The run-session ledger records each session's start;
    // the resolver reads the CURRENT session's entry first.
    const p = planAt({ deadlineSeconds: 3600, deadlineSource: 'default' });
    const first = { QWEN_CODE_SESSION_ID: 'sess-one' };
    const second = { QWEN_CODE_SESSION_ID: 'sess-two' };
    // Attempt 1's ledger entry lands a few seconds after the plan's mtime,
    // so an answer equal to the mtime would prove the fallback, not the read.
    const firstAtMs = PLAN_CAPTURED_MS + 5000;
    appendRunSession(p, first, firstAtMs);
    const resumedAtMs = PLAN_CAPTURED_MS + 5 * 3600 * 1000;
    appendRunSession(p, second, resumedAtMs);
    expect(resolveReviewDeadline(first, p)?.epochSeconds).toBe(
      firstAtMs / 1000 + 3600,
    );
    expect(resolveReviewDeadline(second, p)?.epochSeconds).toBe(
      resumedAtMs / 1000 + 3600,
    );
    // A session the ledger never saw falls back to the plan's mtime.
    expect(
      resolveReviewDeadline({ QWEN_CODE_SESSION_ID: 'sess-3' }, p)
        ?.epochSeconds,
    ).toBe(PLAN_CAPTURED_MS / 1000 + 3600);
    // …and so does a run with no session id at all.
    expect(resolveReviewDeadline({}, p)?.epochSeconds).toBe(
      PLAN_CAPTURED_MS / 1000 + 3600,
    );
  });
});

describe('the gates read a plan-recorded wall, with the reserve the wall implies', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  /** A plan captured `PLAN_CAPTURED_MS` ago whose wall ends `remaining`
   * seconds after `NOW_MS`. */
  function planWithRemaining(
    remaining: number,
    source: 'flag' | 'default' = 'default',
  ): { path: string; wallSeconds: number } {
    const dir = mkdtempSync(join(tmpdir(), 'deadline-gate-'));
    dirs.push(dir);
    const p = join(dir, 'plan.json');
    const wallSeconds = (NOW_MS - PLAN_CAPTURED_MS) / 1000 + remaining;
    writeFileSync(
      p,
      JSON.stringify({ deadlineSeconds: wallSeconds, deadlineSource: source }),
    );
    backdatePlan(p);
    return { path: p, wallSeconds };
  }

  it('reverse-audit: admits while round-plus-reserve fits the plan’s wall, refuses below it', () => {
    // A long wall keeps the capped 4800 reserve, so the boundary is the same
    // one the env path pins — reached through the plan instead.
    const fits = planWithRemaining(REQUIRED);
    expect(planReserveSeconds(fits.wallSeconds)).toBe(DEFAULT_RESERVE_SECONDS);
    expect(
      reverseAuditBudgetExhausted({}, DEFAULT_ROUND_SECONDS, NOW_MS, fits.path),
    ).toBeNull();
    const short = planWithRemaining(REQUIRED - 1);
    expect(
      reverseAuditBudgetExhausted(
        {},
        DEFAULT_ROUND_SECONDS,
        NOW_MS,
        short.path,
      ),
    ).toEqual({
      remainingSeconds: REQUIRED - 1,
      reserveSeconds: DEFAULT_RESERVE_SECONDS,
      expectedRoundSeconds: DEFAULT_ROUND_SECONDS,
    });
  });

  it('reverse-audit: a short `--deadline` scales its reserve down instead of spending the wall on it', () => {
    // A real `--deadline 120` (7200s, the shortest band above the floor)
    // captured an hour ago: its reserve is a third of the wall, 2400 — not
    // the flat 4800 the CI path assumes for a six-hour attempt.
    const dir = mkdtempSync(join(tmpdir(), 'deadline-gate-'));
    dirs.push(dir);
    const path = join(dir, 'plan.json');
    const wallSeconds = 7200;
    writeFileSync(
      path,
      JSON.stringify({ deadlineSeconds: wallSeconds, deadlineSource: 'flag' }),
    );
    backdatePlan(path, NOW_MS - 3600 * 1000);
    const reserve = planReserveSeconds(wallSeconds);
    expect(reserve).toBe(2400);
    expect(reserve).toBeLessThan(DEFAULT_RESERVE_SECONDS);
    const spent = reverseAuditBudgetExhausted(
      {},
      DEFAULT_ROUND_SECONDS,
      NOW_MS,
      path,
    );
    expect(spent).toEqual({
      remainingSeconds: 3600,
      reserveSeconds: reserve,
      expectedRoundSeconds: DEFAULT_ROUND_SECONDS,
    });
    // The env reserve override still wins over the plan-implied one.
    expect(
      reverseAuditBudgetExhausted(
        { [RESERVE_ENV]: '0' },
        DEFAULT_ROUND_SECONDS,
        NOW_MS,
        path,
      ),
    ).toBeNull();
    expect(
      reverseAuditBudgetExhausted(
        { [RESERVE_ENV]: '3000' },
        DEFAULT_ROUND_SECONDS,
        NOW_MS,
        path,
      )?.reserveSeconds,
    ).toBe(3000);
  });

  it('reverse-audit: the reserve floors at the EFFECTIVE compose floor, so the round gate refuses whenever the verify gate would', () => {
    // An operator raising the compose floor to an hour for a security
    // review: a wall whose third is below it must still keep the floor
    // inside its reserve, or round 2 would be admitted while every verify
    // build was refused. A disabled or lowered floor never shrinks it.
    const raised = { [COMPOSE_FLOOR_ENV]: '3600' };
    expect(planReserveSeconds(5400, raised)).toBe(3600);
    expect(planReserveSeconds(5400, { [COMPOSE_FLOOR_ENV]: '0' })).toBe(1800);
    expect(planReserveSeconds(5400, { [COMPOSE_FLOOR_ENV]: '300' })).toBe(1800);
    expect(planReserveSeconds(5400)).toBe(1800);
    const dir = mkdtempSync(join(tmpdir(), 'deadline-gate-'));
    dirs.push(dir);
    const path = join(dir, 'plan.json');
    writeFileSync(
      path,
      JSON.stringify({ deadlineSeconds: 5400, deadlineSource: 'flag' }),
    );
    // 3,601s remain: the verify gate admits (above its 3,600 floor) and
    // the round gate must refuse (3,601 < 3,600 + 1,800).
    backdatePlan(path, NOW_MS - (5400 - 3601) * 1000);
    expect(verifyBudgetExhausted(raised, NOW_MS, path)).toBeNull();
    expect(
      reverseAuditBudgetExhausted(raised, DEFAULT_ROUND_SECONDS, NOW_MS, path),
    ).toEqual({
      remainingSeconds: 3601,
      reserveSeconds: 3600,
      expectedRoundSeconds: DEFAULT_ROUND_SECONDS,
    });
    // At 3,600s the verify gate refuses too — never the other way round.
    backdatePlan(path, NOW_MS - (5400 - 3600) * 1000);
    expect(verifyBudgetExhausted(raised, NOW_MS, path)).not.toBeNull();
    expect(
      reverseAuditBudgetExhausted(raised, DEFAULT_ROUND_SECONDS, NOW_MS, path),
    ).not.toBeNull();
  });

  it('reverse-audit: the env clock, when present, is the one enforced — with the env reserve', () => {
    const { path } = planWithRemaining(10 * 3600);
    const spent = reverseAuditBudgetExhausted(
      { [DEADLINE_ENV]: String(NOW_S + 60) },
      DEFAULT_ROUND_SECONDS,
      NOW_MS,
      path,
    );
    expect(spent).toEqual({
      remainingSeconds: 60,
      reserveSeconds: DEFAULT_RESERVE_SECONDS,
      expectedRoundSeconds: DEFAULT_ROUND_SECONDS,
    });
  });

  it('a floored plan wall still trips the round gate before the verify gate', () => {
    // At the floor the reserve EQUALS the compose floor. The ordering the
    // verifier's gate rests on survives because the round gate prices the
    // round on top: with remaining just above the floor, round admission is
    // refused while a verify build is still admitted.
    // A 50-minute wall (the shortest a flag may record) captured so that
    // floor + 1 seconds remain.
    const dir = mkdtempSync(join(tmpdir(), 'deadline-gate-'));
    dirs.push(dir);
    const path = join(dir, 'plan.json');
    const wallSeconds = 3000;
    expect(planReserveSeconds(wallSeconds)).toBe(DEFAULT_COMPOSE_FLOOR_SECONDS);
    writeFileSync(
      path,
      JSON.stringify({ deadlineSeconds: wallSeconds, deadlineSource: 'flag' }),
    );
    backdatePlan(
      path,
      NOW_MS - (wallSeconds - (DEFAULT_COMPOSE_FLOOR_SECONDS + 1)) * 1000,
    );
    expect(
      reverseAuditBudgetExhausted({}, DEFAULT_ROUND_SECONDS, NOW_MS, path),
    ).toEqual({
      remainingSeconds: DEFAULT_COMPOSE_FLOOR_SECONDS + 1,
      reserveSeconds: DEFAULT_COMPOSE_FLOOR_SECONDS,
      expectedRoundSeconds: DEFAULT_ROUND_SECONDS,
    });
    expect(verifyBudgetExhausted({}, NOW_MS, path)).toBeNull();
  });

  it('reverse-audit: a sub-millisecond mtime does not shave a second off the wall', () => {
    // `mtimeMs` is a float rendering of a nanosecond stamp: a plan written
    // a few hundred microseconds before the intended instant would, unrounded,
    // floor the remaining time one second short exactly at cover. The start
    // is read in whole milliseconds.
    const dir = mkdtempSync(join(tmpdir(), 'deadline-gate-'));
    dirs.push(dir);
    const p = join(dir, 'plan.json');
    const wallSeconds = (NOW_MS - PLAN_CAPTURED_MS) / 1000 + REQUIRED;
    writeFileSync(
      p,
      JSON.stringify({
        deadlineSeconds: wallSeconds,
        deadlineSource: 'default',
      }),
    );
    backdatePlan(p, PLAN_CAPTURED_MS - 0.4);
    expect(
      reverseAuditBudgetExhausted({}, DEFAULT_ROUND_SECONDS, NOW_MS, p),
    ).toBeNull();
  });

  it('reverse-audit: a plan with no wall leaves the gate inert', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deadline-gate-'));
    dirs.push(dir);
    const p = join(dir, 'plan.json');
    writeFileSync(p, JSON.stringify({ srcDiffLines: 9000 }));
    expect(
      reverseAuditBudgetExhausted({}, DEFAULT_ROUND_SECONDS, NOW_MS, p),
    ).toBeNull();
    expect(verifyBudgetExhausted({}, NOW_MS, p)).toBeNull();
  });

  it('verify: the compose floor is read against the plan’s wall too', () => {
    const above = planWithRemaining(DEFAULT_COMPOSE_FLOOR_SECONDS + 1);
    expect(verifyBudgetExhausted({}, NOW_MS, above.path)).toBeNull();
    const at = planWithRemaining(DEFAULT_COMPOSE_FLOOR_SECONDS);
    expect(verifyBudgetExhausted({}, NOW_MS, at.path)).toEqual({
      remainingSeconds: DEFAULT_COMPOSE_FLOOR_SECONDS,
      composeFloorSeconds: DEFAULT_COMPOSE_FLOOR_SECONDS,
    });
    // Past the wall the remaining reads negative, as it does on the env path.
    const past = planWithRemaining(-30);
    expect(verifyBudgetExhausted({}, NOW_MS, past.path)?.remainingSeconds).toBe(
      -30,
    );
  });
});
