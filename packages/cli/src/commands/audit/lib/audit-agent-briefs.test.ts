/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  AUDIT_BRIEFS,
  buildAuditPrompt,
  buildLowReaderPrompt,
  UNTRUSTED_DATA_PREAMBLE,
} from './audit-agent-briefs.js';
import {
  buildFilesPlan,
  collectAuditFiles,
  LOW_ANGLE_FLOOR_LINES,
  rosterForEffort,
  type FilesPlan,
} from './files-plan.js';

let dir: string;
let plan: FilesPlan;

function highPlan(): FilesPlan {
  return buildFilesPlan(dir, dir, 'high', collectAuditFiles(dir));
}

beforeEach(() => {
  dir = join(
    tmpdir(),
    `audit-briefs-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'const a = 1;\n'.repeat(10));
  writeFileSync(join(dir, 'src', 'b.ts'), 'const b = 2;\n'.repeat(20));
  writeFileSync(join(dir, 'src', 'a.test.ts'), 'x'.repeat(100));
  plan = buildFilesPlan(dir, dir, 'medium', collectAuditFiles(dir));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('buildAuditPrompt', () => {
  it('every roster brief opens with the untrusted-data preamble', () => {
    for (const role of rosterForEffort('high')) {
      const prompt = buildAuditPrompt(role, plan, true);
      expect(prompt.startsWith(UNTRUSTED_DATA_PREAMBLE)).toBe(true);
    }
  });

  it('assembles context, role brief, and the shared disciplines', () => {
    const prompt = buildAuditPrompt('1a', plan, true);
    expect(prompt).toContain(dir);
    expect(prompt).toContain('src/a.ts (10 lines)');
    expect(prompt).toContain('src/a.test.ts');
    expect(prompt).toContain('Agent 1a');
    expect(prompt).toContain('Failure scenario');
    expect(prompt).toContain('Silence is better than noise');
  });

  it('every brief carries the return contract (the whiff check)', () => {
    for (const role of rosterForEffort('medium')) {
      expect(buildAuditPrompt(role, plan, true)).toContain('RETURN CONTRACT');
    }
  });

  it('carries the anchor requirement in the finding format', () => {
    expect(buildAuditPrompt('2', plan, true)).toContain('- Anchor:');
  });

  it("1c's brief carries the N=10 deep-read quota and registration", () => {
    const prompt = buildAuditPrompt('1c', plan, true);
    expect(prompt).toContain(
      'deep-read at most 10 callers per exported symbol',
    );
    expect(prompt).toContain('REGISTERED');
  });

  it('adds the event-coverage addendum to 1c only when the plan detected an event module', () => {
    expect(buildAuditPrompt('1c', plan, true)).not.toContain(
      'EVENT-COVERAGE WALK',
    );
    const eventPlan: FilesPlan = {
      ...plan,
      eventModule: { detected: true, callSites: 12, files: 3 },
    };
    const prompt = buildAuditPrompt('1c', eventPlan, true);
    expect(prompt).toContain('EVENT-COVERAGE WALK');
    expect(prompt).toContain('at most 10 call sites per event');
    expect(prompt).toContain('early-return, error, and abort paths');
    // Other roles never get it.
    expect(buildAuditPrompt('2', eventPlan, true)).not.toContain(
      'EVENT-COVERAGE WALK',
    );
  });

  it('survives a stale plan missing eventModule (no orphaned roles)', () => {
    const stale: FilesPlan = { ...plan, eventModule: undefined as never };
    expect(() => buildAuditPrompt('1c', stale, true)).not.toThrow();
    expect(buildAuditPrompt('1c', stale, true)).not.toContain(
      'EVENT-COVERAGE WALK',
    );
  });

  it('tells Agent 5 when the corpus is empty instead of a bare "no tests"', () => {
    const noTests = buildFilesPlan(
      dir,
      dir,
      'medium',
      (() => {
        const c = collectAuditFiles(dir);
        return { ...c, testCorpus: [] };
      })(),
    );
    expect(buildAuditPrompt('5', noTests, true)).toContain(
      'No test files under the audited path',
    );
    // The skip note is role-5's alone; the other ten agents never walk tests.
    expect(buildAuditPrompt('1a', noTests, true)).not.toContain(
      'No test files under the audited path',
    );
  });

  it('conditions the probe discipline on the Step-2 consent', () => {
    const optedIn = buildAuditPrompt('1a', plan, true);
    expect(optedIn).toContain('prefer a runnable probe');
    expect(optedIn).toContain('.qwen-audit-scratch-');
    const declined = buildAuditPrompt('1a', plan, false);
    expect(declined).not.toContain('prefer a runnable probe');
    expect(declined).not.toContain('A probe runs only against a scratch copy');
    expect(declined).toContain('Execution is NOT opted in');
    // 6a's break mandate carries no unconditional probe preference either.
    expect(buildAuditPrompt('6a', highPlan(), false)).not.toContain(
      'prefer a runnable probe',
    );
  });

  it('labels the corpus by role: subject for Agent 5, evidence for the rest', () => {
    expect(buildAuditPrompt('5', plan, true)).toContain(
      'Test corpus (your subject this audit)',
    );
    expect(buildAuditPrompt('1a', plan, true)).toContain(
      'Test corpus (evidence, not subjects)',
    );
    expect(buildAuditPrompt('5', plan, true)).toContain(
      'the test corpus is the subject',
    );
    expect(buildAuditPrompt('1a', plan, true)).toContain(
      'evidence about intent, not subjects',
    );
  });

  it('pairs the subject count with the walked line total, not the gate arm', () => {
    writeFileSync(join(dir, 'fixture.bin'), 'x\nx\nx\n');
    const withBinary = buildFilesPlan(
      dir,
      dir,
      'medium',
      collectAuditFiles(dir),
    );
    // fixture.bin's lines ride in subjectLines (the gate arm) but not in the
    // enumerated set the CONTEXT sentence names.
    expect(buildAuditPrompt('1a', withBinary, true)).toContain(
      '(2 subject files, 30 subject lines)',
    );
  });

  it('names a corpus whose every file is uncoverable distinctly', () => {
    const c = collectAuditFiles(dir);
    c.testCorpus = [];
    c.uncoverable.push({
      path: 'src/gone.test.ts',
      kind: 'test',
      reason: 'non-text',
      lines: 3,
    });
    const p = buildFilesPlan(dir, dir, 'medium', c);
    const prompt = buildAuditPrompt('5', p, true);
    expect(prompt).toContain(
      'Every test file under the audited path is uncoverable',
    );
    expect(prompt).toContain('src/gone.test.ts: non-text');
    expect(prompt).not.toContain('No test files under the audited path');
  });

  it('lists uncoverable files as never-walked', () => {
    writeFileSync(join(dir, 'src', 'logo.png'), 'not-a-png');
    const withBinary = buildFilesPlan(
      dir,
      dir,
      'medium',
      collectAuditFiles(dir),
    );
    const prompt = buildAuditPrompt('1a', withBinary, true);
    expect(prompt).toContain('src/logo.png (non-text)');
    expect(prompt).toContain('never walked');
  });
});

describe('buildLowReaderPrompt', () => {
  it('opens with the preamble and is capped, unverified triage', () => {
    const lowPlan = buildFilesPlan(dir, dir, 'low', collectAuditFiles(dir));
    const prompt = buildLowReaderPrompt(lowPlan);
    expect(prompt.startsWith(UNTRUSTED_DATA_PREAMBLE)).toBe(true);
    expect(prompt).toContain('UNVERIFIED');
    expect(prompt).toContain('capped at 10');
    expect(prompt).toContain('RETURN CONTRACT');
    // The finding-format block the write-time parser requires, and the
    // subject enumeration the reader walks.
    expect(prompt).toContain('### [Critical|Suggestion]');
    expect(prompt).toContain('- Anchor:');
    expect(prompt).toContain('src/a.ts (10 lines)');
    expect(prompt).toContain(dir);
  });

  it('walks A+C below the angle floor', () => {
    const lowPlan = buildFilesPlan(dir, dir, 'low', collectAuditFiles(dir));
    const prompt = buildLowReaderPrompt(lowPlan);
    // 31 subject lines < 60 → the floor applies.
    expect(lowPlan.lowTier?.angleFloorApplied).toBe(true);
    expect(prompt).toContain('A — line-by-line');
    expect(prompt).toContain('C — language pitfalls');
    expect(prompt).not.toContain('D — wrapper');
    expect(prompt).not.toContain('B —');
    expect(prompt).toContain('angle floor');
  });

  it('unlocks all five surviving angles above the floor', () => {
    const c = collectAuditFiles(dir);
    c.subjects = [
      {
        path: 'src/big.ts',
        kind: 'source',
        lines: LOW_ANGLE_FLOOR_LINES,
        chars: 0,
      },
    ];
    const lowPlan = buildFilesPlan(dir, dir, 'low', c);
    expect(lowPlan.lowTier?.angleFloorApplied).toBe(false);
    const prompt = buildLowReaderPrompt(lowPlan);
    expect(prompt).toContain('A — line-by-line');
    expect(prompt).toContain('C — language pitfalls');
    expect(prompt).toContain('D — wrapper');
    expect(prompt).toContain('E — reuse');
    expect(prompt).toContain('F — sibling');
    expect(prompt).not.toContain('angle floor');
  });

  it('carries the sweep directive above the sweep floor only', () => {
    const lowPlan = buildFilesPlan(dir, dir, 'low', collectAuditFiles(dir));
    expect(buildLowReaderPrompt(lowPlan)).toContain('Then one sweep');
    const c = collectAuditFiles(dir);
    c.subjects = [{ path: 'src/a.ts', kind: 'source', lines: 10, chars: 0 }];
    const tiny = buildFilesPlan(dir, dir, 'low', c);
    expect(tiny.lowTier?.sweep).toBe(false);
    expect(buildLowReaderPrompt(tiny)).not.toContain('Then one sweep');
  });

  it('names a found-but-unexamined test corpus', () => {
    const lowPlan = buildFilesPlan(dir, dir, 'low', collectAuditFiles(dir));
    expect(buildLowReaderPrompt(lowPlan)).toContain(
      'NOT examined at this tier',
    );
  });

  it('does not claim a corpus when the plan has none', () => {
    const c = collectAuditFiles(dir);
    c.testCorpus = [];
    const lowPlan = buildFilesPlan(dir, dir, 'low', c);
    expect(buildLowReaderPrompt(lowPlan)).not.toContain(
      'NOT examined at this tier',
    );
  });

  it('lists uncoverable files as never-walked at low too', () => {
    writeFileSync(join(dir, 'logo.png'), 'not-a-png');
    const lowPlan = buildFilesPlan(dir, dir, 'low', collectAuditFiles(dir));
    const prompt = buildLowReaderPrompt(lowPlan);
    expect(prompt).toContain(
      'Uncoverable (enumerated, never walked — do not open them)',
    );
    expect(prompt).toContain('logo.png (non-text)');
  });

  it('refuses a stale plan carrying an unknown low angle', () => {
    const lowPlan = buildFilesPlan(dir, dir, 'low', collectAuditFiles(dir));
    const stale: FilesPlan = {
      ...lowPlan,
      lowTier: { ...lowPlan.lowTier!, angles: ['A', 'bogus'] },
    };
    expect(() => buildLowReaderPrompt(stale)).toThrow(/unknown angle/);
  });

  it('refuses a non-low plan', () => {
    expect(() => buildLowReaderPrompt(plan)).toThrow(/not a low-tier plan/);
  });

  it('refuses a stale plan with an empty or malformed lowTier', () => {
    const lowPlan = buildFilesPlan(dir, dir, 'low', collectAuditFiles(dir));
    // An empty angle list would render "per angle" with no angles attached.
    const empty: FilesPlan = {
      ...lowPlan,
      lowTier: { ...lowPlan.lowTier!, angles: [] },
    };
    expect(() => buildLowReaderPrompt(empty)).toThrow(/no angles/);
    // A hand-edited plan can carry anything — validate presence and types.
    const missingCap = JSON.parse(JSON.stringify(lowPlan)) as FilesPlan;
    delete (missingCap.lowTier as { findingCap?: number }).findingCap;
    expect(() => buildLowReaderPrompt(missingCap)).toThrow(/malformed lowTier/);
  });

  it('refuses a floor claim paired with angles beyond A and C', () => {
    const lowPlan = buildFilesPlan(dir, dir, 'low', collectAuditFiles(dir));
    const inconsistent: FilesPlan = {
      ...lowPlan,
      lowTier: {
        ...lowPlan.lowTier!,
        angleFloorApplied: true,
        angles: ['A', 'C', 'D'],
      },
    };
    expect(() => buildLowReaderPrompt(inconsistent)).toThrow(/angle floor/);
  });

  it('refuses a floor claim that drops one of the two floor angles', () => {
    // The floor shrinks to EXACTLY A and C: a plan claiming it while
    // carrying only A walks less than the floor promises.
    const lowPlan = buildFilesPlan(dir, dir, 'low', collectAuditFiles(dir));
    const short: FilesPlan = {
      ...lowPlan,
      lowTier: {
        ...lowPlan.lowTier!,
        angleFloorApplied: true,
        angles: ['A'],
      },
    };
    expect(() => buildLowReaderPrompt(short)).toThrow(/angle floor/);
  });

  it('refuses a reduced angle set without the floor claim', () => {
    // Mirror of the floor-claim check: a stale plan carrying the reduced
    // A+C set WITHOUT the claim walks fewer angles than the module's size
    // commissions — the mismatch misreports coverage both ways.
    const lowPlan = buildFilesPlan(dir, dir, 'low', collectAuditFiles(dir));
    const reduced: FilesPlan = {
      ...lowPlan,
      lowTier: {
        ...lowPlan.lowTier!,
        angleFloorApplied: false,
        angles: ['A', 'C'],
      },
    };
    expect(() => buildLowReaderPrompt(reduced)).toThrow(/reduced angle set/);
  });

  it('refuses an angle-floor claim that disagrees with the walked lines', () => {
    // The fixture walks 30 subject lines (< the 60-line floor), so the
    // real plan claims the floor; flipping the claim alone must refuse.
    const lowPlan = buildFilesPlan(dir, dir, 'low', collectAuditFiles(dir));
    expect(lowPlan.lowTier?.angleFloorApplied).toBe(true);
    const stale: FilesPlan = {
      ...lowPlan,
      lowTier: {
        ...lowPlan.lowTier!,
        angleFloorApplied: false,
        angles: ['A', 'C', 'D', 'E', 'F'],
      },
    };
    expect(() => buildLowReaderPrompt(stale)).toThrow(
      /angle-floor claim disagrees/,
    );
  });

  it('refuses a sweep claim that disagrees with the walked lines', () => {
    // The fixture walks 30 subject lines (>= the 25-line sweep floor), so
    // the real plan claims the sweep; flipping the claim alone must refuse.
    const lowPlan = buildFilesPlan(dir, dir, 'low', collectAuditFiles(dir));
    expect(lowPlan.lowTier?.sweep).toBe(true);
    const stale: FilesPlan = {
      ...lowPlan,
      lowTier: { ...lowPlan.lowTier!, sweep: false },
    };
    expect(() => buildLowReaderPrompt(stale)).toThrow(/sweep claim disagrees/);
  });

  it('refuses a stale plan carrying duplicate angles', () => {
    // A duplicated angle renders twice in the prompt while the receipt
    // claims one walk per angle.
    const lowPlan = buildFilesPlan(dir, dir, 'low', collectAuditFiles(dir));
    const dup: FilesPlan = {
      ...lowPlan,
      lowTier: {
        ...lowPlan.lowTier!,
        angleFloorApplied: false,
        angles: ['A', 'A', 'C'],
      },
    };
    expect(() => buildLowReaderPrompt(dup)).toThrow(/duplicate angles/);
  });

  it('refuses a findingCap that is not a positive integer', () => {
    const lowPlan = buildFilesPlan(dir, dir, 'low', collectAuditFiles(dir));
    for (const cap of [0, -3, 1.5]) {
      const bad: FilesPlan = {
        ...lowPlan,
        lowTier: { ...lowPlan.lowTier!, findingCap: cap },
      };
      expect(() => buildLowReaderPrompt(bad)).toThrow(/positive integer/);
    }
  });

  it('the floor note records the shrink via the per-angle receipt, not a nonexistent header field', () => {
    const lowPlan = buildFilesPlan(dir, dir, 'low', collectAuditFiles(dir));
    const prompt = buildLowReaderPrompt(lowPlan);
    expect(prompt).toContain('per-angle return lines record');
    expect(prompt).not.toContain('the report header discloses the shrink');
  });

  it('reuses the shared severity heuristic, anti-inflation clause included', () => {
    const lowPlan = buildFilesPlan(dir, dir, 'low', collectAuditFiles(dir));
    expect(buildLowReaderPrompt(lowPlan)).toContain(
      'Legacy code is full of backstops',
    );
  });
});

describe('AUDIT_BRIEFS', () => {
  it('covers exactly the roster roles — no 1b, no invariant roles', () => {
    expect(Object.keys(AUDIT_BRIEFS).sort()).toEqual(
      ['1a', '1c', '2', '3a', '3b', '3c', '4', '5', '6a', '6b', '6c'].sort(),
    );
  });
});
