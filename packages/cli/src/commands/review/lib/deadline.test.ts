/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  it('measures the NEWEST previous round when several are on file', () => {
    const p = plan();
    stampRound(p, 1, NOW_MS - 3_000_000); // round 1 admitted 50 min ago
    stampRound(p, 2, NOW_MS - 1_200_000); // round 2 admitted 20 min ago
    // Scanning oldest-first would report 3000; the loop's cost trend is the
    // newest admission's.
    expect(expectedRoundSeconds(p, 3, NOW_MS)).toBe(1200);
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

  it('stamps once per round, whatever the rebuild count', () => {
    const p = plan();
    stampRound(p, 1, NOW_MS - 100);
    stampRound(p, 1, NOW_MS);
    expect(readRoundStamps(p)).toHaveLength(1);
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

  it('round-trips, entry text and all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deadline-stop-'));
    dirs.push(dir);
    const p = join(dir, 'plan.json');
    writeFileSync(p, '{}');
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
    expect(readBudgetStop(join(dir, 'other.json'))).toBeNull();
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
    expect(workflow).toContain(`export ${DEADLINE_ENV}`);
    expect(workflow).toContain(`export ${RESERVE_ENV}`);
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
