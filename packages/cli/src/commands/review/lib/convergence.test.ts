/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  diagnoseConvergence,
  renderConvergenceDiagnosis,
  MAX_RENDERED_CLUSTERS,
} from './convergence.js';
import type { LedgerFinding } from './ledger.js';

const f = (id: string, file: string): LedgerFinding => ({
  id,
  sev: 'S',
  file,
  title: 't',
});

describe('diagnoseConvergence — the trigger table', () => {
  it('says nothing when the loop looks healthy', () => {
    // Shrinking volume, no repeated file: the shape that must NOT produce a
    // paragraph. Null rather than an empty diagnosis, so a caller cannot
    // render a section that says nothing.
    expect(
      diagnoseConvergence({
        round: 4,
        posted: 2,
        prevPosted: 7,
        prevFindings: [f('R3-1', 'a.ts')],
        draftedPaths: ['b.ts'],
      }),
    ).toBeNull();
  });

  it('fires on a file that carried findings before and carries more now', () => {
    const d = diagnoseConvergence({
      round: 4,
      posted: 2,
      prevPosted: 9,
      prevFindings: [f('R2-1', 'a.ts'), f('R3-2', 'a.ts'), f('R3-3', 'z.ts')],
      draftedPaths: ['a.ts', 'a.ts', 'new.ts'],
    })!;
    expect(d.clusters).toEqual([
      { file: 'a.ts', priorRounds: [2, 3], thisRound: 2 },
    ]);
    // Recurrence alone is enough — the volume is falling here.
    expect(d.volumeNotShrinking).toBe(false);
  });

  it('reads the prior rounds off the carried ids, not off a count', () => {
    // The ids are the rounds the REPORT used, which is what makes the
    // rendered sentence checkable against the PR's own history.
    const d = diagnoseConvergence({
      round: 9,
      posted: 1,
      prevPosted: 5,
      prevFindings: [f('R2-1', 'a.ts'), f('R7-4', 'a.ts'), f('R5-9', 'a.ts')],
      draftedPaths: ['a.ts'],
    })!;
    expect(d.clusters[0].priorRounds).toEqual([2, 5, 7]);
  });

  it('ignores entries whose id is not one, and the body-only pseudo-path', () => {
    // A malformed side-file entry contributes no cluster rather than a
    // wrong one; `(body)` is where unanchorable Criticals live and is not a
    // file anyone can cluster on.
    expect(
      diagnoseConvergence({
        round: 4,
        posted: 1,
        prevPosted: 9,
        prevFindings: [
          { id: 'nonsense', sev: 'C', file: 'a.ts', title: 't' },
          f('R2-1', '(body)'),
        ],
        draftedPaths: ['a.ts', '(body)'],
      }),
    ).toBeNull();
  });

  it('fires on volume that is not shrinking, from round 3', () => {
    const flat = diagnoseConvergence({
      round: 3,
      posted: 5,
      prevPosted: 5,
      prevFindings: [],
      draftedPaths: [],
    })!;
    expect(flat.volumeNotShrinking).toBe(true);
    expect(flat.clusters).toEqual([]);

    const grew = diagnoseConvergence({
      round: 3,
      posted: 6,
      prevPosted: 5,
      prevFindings: [],
      draftedPaths: [],
    })!;
    expect(grew.volumeNotShrinking).toBe(true);
  });

  it('holds the volume signal until round 3 — one step is not a trend', () => {
    expect(
      diagnoseConvergence({
        round: 2,
        posted: 9,
        prevPosted: 5,
        prevFindings: [],
        draftedPaths: [],
      }),
    ).toBeNull();
  });

  it('cannot evaluate a volume it never recovered', () => {
    // Absence makes the signal unevaluable, never true: a predecessor that
    // recorded no volume is not a predecessor that posted nothing.
    expect(
      diagnoseConvergence({
        round: 6,
        posted: 9,
        prevFindings: [],
        draftedPaths: [],
      }),
    ).toBeNull();
  });

  it('orders clusters by persistence, then by this round, then by path', () => {
    const d = diagnoseConvergence({
      round: 5,
      posted: 4,
      prevPosted: 9,
      prevFindings: [
        f('R2-1', 'persistent.ts'),
        f('R3-1', 'persistent.ts'),
        f('R4-1', 'busy.ts'),
        f('R4-2', 'quiet.ts'),
      ],
      draftedPaths: ['persistent.ts', 'busy.ts', 'busy.ts', 'quiet.ts'],
    })!;
    expect(d.clusters.map((c) => c.file)).toEqual([
      'persistent.ts',
      'busy.ts',
      'quiet.ts',
    ]);
  });
});

describe('renderConvergenceDiagnosis — what the author reads', () => {
  const base = {
    round: 6,
    posted: 4,
    prevPosted: 4,
    clusters: [{ file: 'src/a.ts', priorRounds: [3, 5], thisRound: 2 }],
    volumeNotShrinking: true,
  };

  it('states the measured facts before the reading of them', () => {
    const r = renderConvergenceDiagnosis(base);
    expect(r.en).toContain('round 6 posted 4 inline comment(s)');
    expect(r.en).toContain('the previous round posted 4');
    expect(r.en).toContain('`src/a.ts` (findings in rounds 3, 5, 2 more now)');
    expect(r.zh).toContain('第 6 轮发布了 4 条行内评论');
    expect(r.zh).toContain('第 3、5 轮已出过发现');
  });

  it('says it withheld nothing — the observation decides nothing', () => {
    const r = renderConvergenceDiagnosis(base);
    expect(r.en).toContain('nothing was withheld');
    expect(r.zh).toContain('未因此扣留任何内容');
  });

  it('advises at the process level, never on code structure', () => {
    const r = renderConvergenceDiagnosis(base);
    expect(r.en).toContain('shared root cause');
    expect(r.en).toContain('splitting an independent cluster');
    // The claim it must never make: how the code should be rewritten.
    expect(r.en).not.toMatch(/refactor|rewrite|extract .* class|redesign/i);
  });

  it('falls back to the volume reading when nothing recurs', () => {
    const r = renderConvergenceDiagnosis({
      ...base,
      clusters: [],
    });
    expect(r.en).toContain('posting volume is not falling');
    expect(r.en).toContain('--severity-floor critical');
  });

  it('summarises the tail instead of listing every cluster', () => {
    const many = Array.from({ length: MAX_RENDERED_CLUSTERS + 2 }, (_, i) => ({
      file: `f${i}.ts`,
      priorRounds: [2],
      thisRound: 1,
    }));
    const r = renderConvergenceDiagnosis({ ...base, clusters: many });
    expect(r.en).toContain('and 2 more file(s)');
    expect(r.en).not.toContain(`f${MAX_RENDERED_CLUSTERS}.ts`);
    expect(r.zh).toContain('另有 2 个文件');
  });

  it('omits the previous round when none was recovered', () => {
    const r = renderConvergenceDiagnosis({
      round: 4,
      posted: 3,
      clusters: base.clusters,
      volumeNotShrinking: false,
    });
    expect(r.en).toContain('round 4 posted 3 inline comment(s)');
    expect(r.en).not.toContain('the previous round posted');
    expect(r.zh).not.toContain('上一轮发布了');
  });
});
