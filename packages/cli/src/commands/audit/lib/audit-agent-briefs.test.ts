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
  rosterForEffort,
  type FilesPlan,
} from './files-plan.js';

let dir: string;
let plan: FilesPlan;

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
      const prompt = buildAuditPrompt(role, plan);
      expect(prompt.startsWith(UNTRUSTED_DATA_PREAMBLE)).toBe(true);
    }
  });

  it('assembles context, role brief, and the shared disciplines', () => {
    const prompt = buildAuditPrompt('1a', plan);
    expect(prompt).toContain(dir);
    expect(prompt).toContain('src/a.ts (10 lines)');
    expect(prompt).toContain('src/a.test.ts');
    expect(prompt).toContain('Agent 1a');
    expect(prompt).toContain('Failure scenario');
    expect(prompt).toContain('Silence is better than noise');
  });

  it('every brief carries the return contract (the whiff check)', () => {
    for (const role of rosterForEffort('medium')) {
      expect(buildAuditPrompt(role, plan)).toContain('RETURN CONTRACT');
    }
  });

  it('carries the anchor requirement in the finding format', () => {
    expect(buildAuditPrompt('2', plan)).toContain('- Anchor:');
  });

  it("1c's brief carries the N=10 deep-read quota and registration", () => {
    const prompt = buildAuditPrompt('1c', plan);
    expect(prompt).toContain(
      'deep-read at most 10 callers per exported symbol',
    );
    expect(prompt).toContain('REGISTERED');
  });

  it('adds the event-coverage addendum to 1c only when the plan detected an event module', () => {
    expect(buildAuditPrompt('1c', plan)).not.toContain('EVENT-COVERAGE WALK');
    const eventPlan: FilesPlan = {
      ...plan,
      eventModule: { detected: true, callSites: 12, files: 3 },
    };
    const prompt = buildAuditPrompt('1c', eventPlan);
    expect(prompt).toContain('EVENT-COVERAGE WALK');
    expect(prompt).toContain('at most 10 call sites per event');
    expect(prompt).toContain('early-return, error, and abort paths');
    // Other roles never get it.
    expect(buildAuditPrompt('2', eventPlan)).not.toContain(
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
    expect(buildAuditPrompt('5', noTests)).toContain(
      'No test files under the audited path',
    );
  });

  it('lists uncoverable files as never-walked', () => {
    writeFileSync(join(dir, 'src', 'logo.png'), 'not-a-png');
    const withBinary = buildFilesPlan(
      dir,
      dir,
      'medium',
      collectAuditFiles(dir),
    );
    const prompt = buildAuditPrompt('1a', withBinary);
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
  });

  it('walks all five surviving angles above the floor, A+C below it', () => {
    const lowPlan = buildFilesPlan(dir, dir, 'low', collectAuditFiles(dir));
    const prompt = buildLowReaderPrompt(lowPlan);
    // 32 subject lines < 60 → the floor applies.
    expect(lowPlan.lowTier?.angleFloorApplied).toBe(true);
    expect(prompt).toContain('A — line-by-line');
    expect(prompt).toContain('C — language pitfalls');
    expect(prompt).not.toContain('D — wrapper');
    expect(prompt).not.toContain('B —');
    expect(prompt).toContain('angle floor');
  });

  it('names a found-but-unexamined test corpus', () => {
    const lowPlan = buildFilesPlan(dir, dir, 'low', collectAuditFiles(dir));
    expect(buildLowReaderPrompt(lowPlan)).toContain(
      'NOT examined at this tier',
    );
  });

  it('refuses a non-low plan', () => {
    expect(() => buildLowReaderPrompt(plan)).toThrow(/not a low-tier plan/);
  });
});

describe('AUDIT_BRIEFS', () => {
  it('covers exactly the roster roles — no 1b, no invariant roles', () => {
    expect(Object.keys(AUDIT_BRIEFS).sort()).toEqual(
      ['1a', '1c', '2', '3a', '3b', '3c', '4', '5', '6a', '6b', '6c'].sort(),
    );
  });
});
