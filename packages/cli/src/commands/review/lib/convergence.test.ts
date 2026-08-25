/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  diagnoseConvergence,
  isFreshDraft,
  recommendationsFor,
  renderConvergenceDiagnosis,
  renderMechanismHealth,
  MAX_RENDERED_CLUSTERS,
  convergenceAssessment,
  convergenceAdvisory,
  LAND_WITH_RESIDUAL_RISK,
  type ConvergenceDiagnosis,
  type DraftedFinding,
  type ConvergenceFacts,
} from './convergence.js';
import { LEDGER_MAX_ROUND, type LedgerFinding } from './ledger.js';

const f = (id: string, file: string): LedgerFinding => ({
  id,
  sev: 'S',
  file,
  title: 't',
});

/** A fresh drafted finding, or — with an id — a re-post of an earlier one. */
const d = (file: string, carriedId?: string): DraftedFinding =>
  carriedId === undefined ? { file } : { file, carriedId };

describe('diagnoseConvergence — the trigger table', () => {
  it('says nothing when the loop looks healthy', () => {
    // Shrinking volume, no repeated file: the shape that must NOT produce a
    // paragraph. Null rather than an empty diagnosis, so a caller cannot
    // render a section that says nothing.
    expect(
      diagnoseConvergence({
        round: 4,
        posted: 2,
        prev: { posted: 7, findings: [f('R3-1', 'a.ts')] },
        drafts: [d('b.ts')],
        floor: 'o',
      }),
    ).toBeNull();
  });

  it('fires on a file that carried findings before and carries more now', () => {
    const r = diagnoseConvergence({
      round: 4,
      posted: 2,
      prev: {
        posted: 9,
        findings: [f('R2-1', 'a.ts'), f('R3-2', 'a.ts'), f('R3-3', 'z.ts')],
      },
      drafts: [d('a.ts'), d('a.ts'), d('new.ts')],
      floor: 'o',
    })!;
    expect(r.clusters).toEqual([
      { file: 'a.ts', priorRounds: [2, 3], thisRound: 2 },
    ]);
    // Recurrence alone is enough — the volume is falling here.
    expect(r.volumeNotShrinking).toBe(false);
  });

  it('reads the prior rounds off the carried ids, not off a count', () => {
    // The ids are the rounds the REPORT used, which is what makes the
    // rendered sentence checkable against the PR's own history.
    const r = diagnoseConvergence({
      round: 9,
      posted: 1,
      prev: {
        posted: 5,
        findings: [f('R2-1', 'a.ts'), f('R7-4', 'a.ts'), f('R5-9', 'a.ts')],
      },
      drafts: [d('a.ts')],
      floor: 'o',
    })!;
    expect(r.clusters[0].priorRounds).toEqual([2, 5, 7]);
  });

  it('ignores entries whose id is not one, and every non-path stand-in', () => {
    // A malformed side-file entry contributes no cluster rather than a
    // wrong one; `(body)` is where unanchorable Criticals live and
    // `(unknown)` is a comment that arrived without a path — neither is a
    // file anyone can cluster on, and neither may be NAMED as one in a
    // posted paragraph. Separated by the ledger's flag, which marks the
    // EXCEPTION: a real file spelled like a stand-in carries it, a stand-in
    // carries none — see the real-file test below.
    expect(
      diagnoseConvergence({
        round: 4,
        posted: 1,
        prev: {
          posted: 9,
          findings: [
            { id: 'nonsense', sev: 'C', file: 'a.ts', title: 't' },
            f('R2-1', '(body)'),
            f('R2-2', '(unknown)'),
          ],
        },
        drafts: [d('a.ts'), d('(body)'), d('(unknown)')],
        floor: 'o',
      }),
    ).toBeNull();
  });

  it('fires on volume that is not shrinking, from round 3', () => {
    const flat = diagnoseConvergence({
      round: 3,
      posted: 5,
      prev: { posted: 5, fresh: 1, findings: [] },
      drafts: [d('a.ts')],
      floor: 'o',
    })!;
    expect(flat.volumeNotShrinking).toBe(true);
    expect(flat.clusters).toEqual([]);

    const grew = diagnoseConvergence({
      round: 3,
      posted: 6,
      prev: { posted: 5, fresh: 1, findings: [] },
      drafts: [d('a.ts'), d('b.ts')],
      floor: 'o',
    })!;
    expect(grew.volumeNotShrinking).toBe(true);
  });

  it('stays silent on a loop that posted nothing — zero is where convergence lands', () => {
    // `0 >= 0` is arithmetically "not shrinking" and semantically the
    // opposite: a round that posted nothing is the observation the trend
    // exists to find, so narrating "the volume is not falling" there would
    // flag the settled state as the unsettled one.
    expect(
      diagnoseConvergence({
        round: 7,
        posted: 0,
        prev: { posted: 0, fresh: 0, findings: [] },
        drafts: [],
        floor: 'o',
      }),
    ).toBeNull();
    // And the round that lands on zero from above is the clearest possible
    // shrink.
    expect(
      diagnoseConvergence({
        round: 7,
        posted: 0,
        prev: { posted: 6, fresh: 6, findings: [] },
        drafts: [],
        floor: 'o',
      }),
    ).toBeNull();
  });

  it('will not measure a trend against a settled predecessor', () => {
    // `N >= 0` is true for every N, so a zero-posting predecessor would fire
    // the signal on the healthiest shape there is: fix everything, settle at
    // zero, push again, get new findings. Zero survives the whole
    // persistence chain by design, so this state is reachable.
    expect(
      diagnoseConvergence({
        round: 5,
        posted: 4,
        prev: { posted: 4, fresh: 0, findings: [] },
        drafts: [d('a.ts')],
        floor: 'o',
      }),
    ).toBeNull();
    // A genuine flat trend still fires.
    expect(
      diagnoseConvergence({
        round: 5,
        posted: 2,
        prev: { posted: 2, fresh: 1, findings: [] },
        drafts: [d('a.ts')],
        floor: 'o',
      }),
    ).not.toBeNull();
  });

  it('holds the volume signal until round 3 — one step is not a trend', () => {
    // The counts must SATISFY every other conjunct, or the round guard is
    // not what the assertion measures: one fresh draft against `prev.fresh: 5`
    // already fails `1 >= 5`, and the test passed with or without the gate.
    const shape = {
      posted: 9,
      prev: { posted: 5, fresh: 1, findings: [] },
      drafts: [d('a.ts')],
      floor: 'o' as const,
    };
    expect(diagnoseConvergence({ ...shape, round: 2 })).toBeNull();
    expect(diagnoseConvergence({ ...shape, round: 3 })).not.toBeNull();
  });

  it('cannot evaluate a trend it never recovered', () => {
    // Absence makes the signal unevaluable, never true: a predecessor that
    // recorded no counts is not a predecessor that posted nothing.
    expect(
      diagnoseConvergence({
        round: 6,
        posted: 9,
        prev: { findings: [] },
        drafts: [d('a.ts')],
        floor: 'o',
      }),
    ).toBeNull();
    // A total without a fresh count is the pre-field marker: the trend runs
    // on new findings, so it is unevaluable rather than measured on totals.
    expect(
      diagnoseConvergence({
        round: 6,
        posted: 9,
        prev: { posted: 4, findings: [] },
        drafts: [d('a.ts')],
        floor: 'o',
      }),
    ).toBeNull();
  });

  it('does not count a re-posted still-standing finding as activity', () => {
    // Step 6 re-posts every unfixed ledger Critical under its ORIGINAL id.
    // A single Critical nobody has fixed therefore arrives every round: read
    // as activity it fires the cluster ("1 more now" with no new finding
    // ever appearing) AND the flat-volume trend, forever — at the steady
    // state, which is the opposite of what both signals mean.
    expect(
      diagnoseConvergence({
        round: 3,
        posted: 1,
        prev: { posted: 1, findings: [f('R2-1', 'src/parser.ts')] },
        drafts: [d('src/parser.ts', 'R2-1')],
        floor: 'o',
      }),
    ).toBeNull();
  });

  it('treats a stray id that names no standing entry as a new finding', () => {
    // Step 6 teaches the model to lead a re-post with `R1-2: <the claim>`,
    // and models emit stray ids at the head of a claim line. Trusted on the
    // token alone, a genuinely new finding written that way vanishes from
    // both signals — out of its file's cluster and out of the activity
    // guard — and a round of real new work reads as the steady state.
    const r = diagnoseConvergence({
      round: 4,
      posted: 1,
      prev: {
        posted: 1,
        fresh: 1,
        complete: true,
        findings: [f('R2-1', 'src/a.ts')],
      },
      drafts: [d('src/a.ts', 'R2-99')],
      floor: 'o',
    })!;
    expect(r.clusters).toEqual([
      { file: 'src/a.ts', priorRounds: [2], thisRound: 1 },
    ]);
    expect(r.fresh).toBe(1);
  });

  it('will not call a re-post fresh over a list that may have shed it', () => {
    // The work list keeps the id when the list is shortened (continuity
    // wins), so reading the same comment as first-time work makes one marker
    // say two things — and posts "the rate of new findings is not falling"
    // every round on a loop doing no new work.
    const shed = diagnoseConvergence({
      round: 4,
      posted: 2,
      prev: { posted: 2, fresh: 2, findings: [], truncated: true },
      drafts: [d('src/a.ts', 'R3-7'), d('src/b.ts', 'R3-8')],
      floor: 'o',
    });
    expect(shed).toBeNull();
    // Over a list known WHOLE, the same ids are strays and count as new.
    const whole = diagnoseConvergence({
      round: 4,
      posted: 2,
      prev: { posted: 2, fresh: 2, complete: true, findings: [] },
      drafts: [d('src/a.ts', 'R3-7'), d('src/b.ts', 'R3-8')],
      floor: 'o',
    })!;
    expect(whole.fresh).toBe(2);
  });

  it('still clusters a genuinely new finding in a re-posted file', () => {
    // The exclusion is per-comment, not per-file: the file is still
    // regenerating work, and that is exactly what the signal is for.
    const r = diagnoseConvergence({
      round: 3,
      posted: 2,
      prev: { posted: 1, findings: [f('R2-1', 'src/parser.ts')] },
      drafts: [d('src/parser.ts', 'R2-1'), d('src/parser.ts')],
      floor: 'o',
    })!;
    expect(r.clusters).toEqual([
      { file: 'src/parser.ts', priorRounds: [2], thisRound: 1 },
    ]);
    // The volume fact stays the honest posted total, re-posts included.
    expect(r.posted).toBe(2);
  });

  it('treats an id this round would mint as fresh, not as carried', () => {
    // "Carried" means minted in an EARLIER round; the comparison is strict
    // so a same-round id cannot silently erase this round's own work. The id
    // is IN the work list, so the stray-id branch cannot be what decides it
    // — the final `minted >= round` comparison is.
    const r = diagnoseConvergence({
      round: 3,
      posted: 1,
      prev: {
        posted: 1,
        fresh: 1,
        findings: [f('R2-1', 'a.ts'), f('R3-1', 'a.ts')],
      },
      drafts: [d('a.ts', 'R3-1')],
      floor: 'o',
    })!;
    expect(r.clusters[0].thisRound).toBe(1);
    expect(r.fresh).toBe(1);
  });

  it('orders clusters by new work now, then by depth, then by path', () => {
    // This round's count leads: the prior-round depth measures the wrong
    // thing for the sentence it ranks — the previous ledger is a POSTING
    // set, so depth grows exactly where nothing is being fixed — and it is
    // the key a stranger can set with one marker full of legal ids.
    const r = diagnoseConvergence({
      round: 5,
      posted: 4,
      prev: {
        posted: 9,
        findings: [
          f('R2-1', 'persistent.ts'),
          f('R3-1', 'persistent.ts'),
          f('R4-1', 'busy.ts'),
          f('R4-2', 'quiet.ts'),
        ],
      },
      drafts: [d('persistent.ts'), d('busy.ts'), d('busy.ts'), d('quiet.ts')],
      floor: 'o',
    })!;
    expect(r.clusters.map((c) => c.file)).toEqual([
      'busy.ts',
      'persistent.ts',
      'quiet.ts',
    ]);
  });

  it('breaks path ties on code units, not on the runtime locale', () => {
    // `localeCompare` collates by locale: under en_US `é` sorts before `z`,
    // by code unit it sorts after (U+00E9 > U+007A). The clustered paths
    // belong to whatever repository is under review, and the CI bot's locale
    // need not match a maintainer's — so the tie-break must not consult one.
    const r = diagnoseConvergence({
      round: 5,
      posted: 2,
      prev: { posted: 9, findings: [f('R2-1', 'é.ts'), f('R2-2', 'z.ts')] },
      drafts: [d('é.ts'), d('z.ts')],
      floor: 'o',
    })!;
    expect(r.clusters.map((c) => c.file)).toEqual(['z.ts', 'é.ts']);
  });

  it('clusters a real file whose name matches a stand-in', () => {
    // The stand-ins are legal filenames — git permits `(body)` — so a reader
    // that excluded them BY VALUE dropped exactly that file from clustering
    // while claiming to drop a stand-in. The ledger's flag is what separates
    // them, and it marks the EXCEPTION — the real file carries it, the
    // stand-in carries none.
    const r = diagnoseConvergence({
      round: 4,
      posted: 1,
      prev: {
        posted: 9,
        findings: [{ id: 'R2-1', sev: 'S', file: '(body)', title: 't', k: 1 }],
      },
      drafts: [d('(body)')],
      floor: 'o',
    })!;
    expect(r.clusters).toEqual([
      { file: '(body)', priorRounds: [2], thisRound: 1 },
    ]);
  });

  it('fails toward "carried" where the id space collides at the cap', () => {
    // Consecutive rounds AT `LEDGER_MAX_ROUND` both stamp `R<cap>-*`, so a
    // re-post is indistinguishable from a fresh finding by its id. The two
    // errors do not cost the same: calling a re-post fresh narrates
    // divergence at the steady state every round forever, calling a fresh
    // finding carried costs one round of silence.
    expect(
      diagnoseConvergence({
        round: LEDGER_MAX_ROUND,
        posted: 1,
        prev: {
          posted: 1,
          findings: [f(`R${LEDGER_MAX_ROUND}-1`, 'src/p.ts')],
        },
        drafts: [d('src/p.ts', `R${LEDGER_MAX_ROUND}-1`)],
        floor: 'o',
      }),
    ).toBeNull();
    // Below the cap the ids still separate the two, so the strict rule holds.
    expect(
      diagnoseConvergence({
        round: 3,
        posted: 1,
        prev: { posted: 1, findings: [f('R2-1', 'src/p.ts')] },
        drafts: [d('src/p.ts', 'R3-1')],
        floor: 'o',
      }),
    ).not.toBeNull();
  });

  it('will not read a posture change as loop divergence', () => {
    // An operator who takes this module's own advice, sets a critical floor,
    // then restores it produces a volume jump that is a policy change, not a
    // loop. Firing there would advise re-tightening the floor just
    // deliberately loosened.
    expect(
      diagnoseConvergence({
        round: 8,
        posted: 5,
        prev: { posted: 1, fresh: 1, findings: [], floor: 'c' },
        drafts: [d('a.ts'), d('b.ts')],
        floor: 'o',
      }),
    ).toBeNull();
    // Same floor, same numbers: a real flat trend still fires.
    expect(
      diagnoseConvergence({
        round: 8,
        posted: 5,
        prev: { posted: 1, fresh: 1, findings: [], floor: 'o' },
        drafts: [d('a.ts'), d('b.ts')],
        floor: 'o',
      }),
    ).not.toBeNull();
    // A predecessor that recorded no floor is not one that differs — a
    // pre-field marker evaluates exactly as it did before.
    expect(
      diagnoseConvergence({
        round: 8,
        posted: 5,
        prev: { posted: 1, fresh: 1, findings: [] },
        drafts: [d('a.ts'), d('b.ts')],
        floor: 'o',
      }),
    ).not.toBeNull();
  });

  it('measures the trend on new findings, not on the round total', () => {
    // Step 6 re-posts every unfixed ledger Critical, so the re-post floor
    // only ever rises. A loop whose NEW findings collapsed 5 -> 1 still
    // posts more comments than the round before, and a trend on the totals
    // calls that convergence "not falling" — forever.
    const carried = Array.from({ length: 30 }, (_, i) =>
      d(`old${i}.ts`, `R2-${i + 1}`),
    );
    const standing = Array.from({ length: 30 }, (_, i) =>
      f(`R2-${i + 1}`, `old${i}.ts`),
    );
    expect(
      diagnoseConvergence({
        round: 4,
        posted: 31,
        prev: { posted: 30, fresh: 5, findings: standing },
        drafts: [...carried, d('new.ts')],
        floor: 'o',
      }),
    ).toBeNull();
  });

  it('holds the recurrence signal until round 3 — one step is not a trend', () => {
    // A round-1 finding fixed and one new finding landing in the same file
    // is the ordinary healthy re-review; on a single-file PR the "split it
    // into its own pull request" advice has no referent at all.
    expect(
      diagnoseConvergence({
        round: 2,
        posted: 1,
        prev: { posted: 3, fresh: 3, findings: [f('R1-1', 'src/foo.ts')] },
        drafts: [d('src/foo.ts')],
        floor: 'o',
      }),
    ).toBeNull();
  });

  it('ranks the file producing new work over the file with a backlog', () => {
    // `priorRounds` deepens only where nothing is being fixed: a fixed
    // finding is not re-posted and its round leaves the list, an unfixed one
    // keeps contributing its mint round forever. Ranked by depth, the
    // backlog file took the top slot and the advice explained it as "a
    // cluster that keeps producing siblings" — about a file where no fix
    // happened.
    const r = diagnoseConvergence({
      round: 6,
      posted: 6,
      prev: {
        posted: 6,
        fresh: 2,
        findings: [
          f('R1-1', 'src/never-fixed.ts'),
          f('R2-1', 'src/never-fixed.ts'),
          f('R3-1', 'src/never-fixed.ts'),
          f('R4-1', 'src/never-fixed.ts'),
          f('R5-1', 'src/regenerating.ts'),
        ],
      },
      drafts: [
        d('src/never-fixed.ts', 'R1-1'),
        d('src/never-fixed.ts'),
        d('src/regenerating.ts'),
        d('src/regenerating.ts'),
      ],
      floor: 'o',
    })!;
    expect(r.clusters.map((c) => c.file)).toEqual([
      'src/regenerating.ts',
      'src/never-fixed.ts',
    ]);
  });

  it('matches a truncated ledger entry by prefix, keeping the real path', () => {
    // The ledger caps `file` at 200 chars. Truncating the drafted side to
    // meet it does not prevent prefix collisions, it creates them — and it
    // would post a 200-char prefix as a path that exists in no repository.
    const deep = `src/${'nested/'.repeat(44)}leaf.ts`;
    const r = diagnoseConvergence({
      round: 4,
      posted: 1,
      prev: {
        posted: 9,
        fresh: 9,
        findings: [f('R2-1', deep.slice(0, 200))],
      },
      drafts: [d(deep)],
      floor: 'o',
    })!;
    expect(r.clusters[0].file).toBe(deep);
  });

  it('carries the evidence qualifiers through to the rendering', () => {
    const r = diagnoseConvergence({
      round: 4,
      posted: 1,
      prev: {
        posted: 9,
        findings: [f('R2-1', 'a.ts')],
        truncated: true,
        foreign: true,
      },
      drafts: [d('a.ts')],
      floor: 'o',
      criticalFloorKind: 'explicit',
    })!;
    expect(r.truncatedEvidence).toBe(true);
    expect(r.foreignEvidence).toBe(true);
    expect(r.criticalFloorKind).toBe('explicit');
  });

  it('carries the merged qualifier through, and drops the depth key with it', () => {
    // Two things ride on a foreign work list: the caveat the renderer picks,
    // and whether the ordering may consult a number a stranger set. Fifty
    // planted ids on one file still decide every `thisRound` tie, and ties
    // are the ordinary shape — one fresh finding per file.
    const planted = Array.from({ length: 50 }, (_, i) =>
      f(`R${i + 1}-1`, 'src/planted.ts'),
    );
    const r = diagnoseConvergence({
      round: 6,
      posted: 2,
      prev: {
        posted: 9,
        fresh: 9,
        foreign: true,
        merged: true,
        findings: [...planted, f('R5-1', 'src/genuine.ts')],
      },
      drafts: [d('src/planted.ts'), d('src/genuine.ts')],
      floor: 'o',
    })!;
    expect(r.mergedEvidence).toBe(true);
    // Tied on this round's count, the path decides — not the planted depth.
    expect(r.clusters.map((c) => c.file)).toEqual([
      'src/genuine.ts',
      'src/planted.ts',
    ]);
    // An OWN list still ranks by depth after the count.
    const own = diagnoseConvergence({
      round: 6,
      posted: 2,
      prev: {
        posted: 9,
        fresh: 9,
        findings: [...planted, f('R5-1', 'src/genuine.ts')],
      },
      drafts: [d('src/planted.ts'), d('src/genuine.ts')],
      floor: 'o',
    })!;
    expect(own.clusters[0].file).toBe('src/planted.ts');

    // And the drop is keyed on `foreign` ALONE — a purely foreign marker
    // adopted without a union is the ordinary shape when this account has
    // no surviving marker of its own.
    const foreignOnly = diagnoseConvergence({
      round: 6,
      posted: 2,
      prev: {
        posted: 9,
        fresh: 9,
        foreign: true,
        findings: [...planted, f('R5-1', 'src/genuine.ts')],
      },
      drafts: [d('src/planted.ts'), d('src/genuine.ts')],
      floor: 'o',
    })!;
    expect(foreignOnly.mergedEvidence).toBe(false);
    expect(foreignOnly.clusters.map((c) => c.file)).toEqual([
      'src/genuine.ts',
      'src/planted.ts',
    ]);
  });

  it('will not compare a recorded floor against one this round never named', () => {
    // The asymmetric cell the guard exists for: a predecessor that recorded
    // its posture against a round whose own posture is unknown. Unknown is
    // not "matches" and not "differs" — it makes the comparison unavailable,
    // which leaves the trend evaluated as it was before floors existed.
    const r = diagnoseConvergence({
      round: 8,
      posted: 5,
      prev: { posted: 1, fresh: 1, findings: [], floor: 'c' },
      drafts: [d('a.ts'), d('b.ts')],
    })!;
    expect(r.volumeNotShrinking).toBe(true);
  });

  it('defaults every qualifier to false rather than undefined', () => {
    const r = diagnoseConvergence({
      round: 4,
      posted: 1,
      prev: { posted: 9, findings: [f('R2-1', 'a.ts')] },
      drafts: [d('a.ts')],
      floor: 'o',
    })!;
    expect(r.truncatedEvidence).toBe(false);
    expect(r.foreignEvidence).toBe(false);
    expect(r.criticalFloorKind).toBeUndefined();
  });
});

describe('recommendationsFor — measurement to advice, no constants', () => {
  const base: ConvergenceDiagnosis = {
    round: 6,
    posted: 4,
    fresh: 2,
    prevPosted: 4,
    prevFresh: 2,
    clusters: [{ file: 'src/a.ts', priorRounds: [3, 5], thisRound: 2 }],
    volumeNotShrinking: true,
    truncatedEvidence: false,
    foreignEvidence: false,
    mergedEvidence: false,
  };

  it('matches each code to the fact it names, and names it', () => {
    const r = recommendationsFor(base);
    expect(r.map((x) => x.code)).toEqual([
      'root-cause-triage',
      'batch-fixes',
      'stem-surface',
    ]);
    // Every basis is a deterministic fact, not a judgement.
    expect(r[0].basis).toContain('src/a.ts');
    expect(r[1].basis).toContain('round 6 produced 2 first-time finding(s)');
    expect(r[2].basis).toContain('did not resolve to critical');
  });

  it('offers the floor rung only where a rung is left to take', () => {
    const atFloor = recommendationsFor({
      ...base,
      criticalFloorKind: 'explicit',
    });
    expect(atFloor.map((x) => x.code)).not.toContain('stem-surface');
    expect(atFloor.map((x) => x.code)).toContain('batch-fixes');
  });

  it('matches land-and-defer only on a round with no open blocker', () => {
    expect(
      recommendationsFor({ ...base, openCriticals: 0 }).map((x) => x.code),
    ).toContain('land-and-defer');
    expect(
      recommendationsFor({ ...base, openCriticals: 2 }).map((x) => x.code),
    ).not.toContain('land-and-defer');
    // Absent is not zero: an unrecorded count is not a count of none.
    expect(recommendationsFor(base).map((x) => x.code)).not.toContain(
      'land-and-defer',
    );
  });

  it('matches nothing a signal did not fire', () => {
    const volumeOnly = recommendationsFor({
      ...base,
      clusters: [],
    });
    expect(volumeOnly.map((x) => x.code)).not.toContain('root-cause-triage');
    const clusterOnly = recommendationsFor({
      ...base,
      volumeNotShrinking: false,
    });
    expect(clusterOnly.map((x) => x.code)).toEqual(['root-cause-triage']);
  });

  it('is what the paragraph renders, not a second list beside it', () => {
    // Derived rather than stored, so the codes a caller wires and the prose
    // a human reads cannot describe different rounds.
    const withLand = { ...base, openCriticals: 0 };
    const prose = renderConvergenceDiagnosis(withLand);
    expect(prose.en).toContain('shared root cause');
    expect(prose.en).toContain('Batching the remaining fixes');
    expect(prose.en).toContain('--severity-floor critical');
    expect(prose.en).toContain('No Critical finding is open on this round');
    expect(prose.zh).toContain('本轮没有未决的 Critical');
    // ...and the negative side: an open blocker means the ending is not
    // available, so the sentence must not render.
    const withBlocker = renderConvergenceDiagnosis({
      ...base,
      openCriticals: 2,
    });
    expect(withBlocker.en).not.toContain('No Critical finding is open');
    expect(withBlocker.zh).not.toContain('本轮没有未决的 Critical');
    // ...and the narrowed floor case drops exactly the rung it dropped.
    const atFloor = renderConvergenceDiagnosis({
      ...base,
      clusters: [],
      criticalFloorKind: 'explicit',
    });
    expect(atFloor.en).not.toContain('dropping this PR');
  });
});

describe('renderMechanismHealth — is the machinery working', () => {
  it('says nothing when nothing is wrong with it', () => {
    expect(
      renderMechanismHealth({
        postureNotEngaging: false,
        anchorChainBroken: false,
      }),
    ).toBeNull();
  });

  it('states a posture that is engaged in name and not in effect', () => {
    const r = renderMechanismHealth({
      postureNotEngaging: true,
      anchorChainBroken: false,
    })!;
    expect(r.en).toContain('engaged in name and not in effect');
    expect(r.zh).toContain('名义上生效、实际未生效');
    // Stated, never prescribed.
    expect(r.en).toContain('Stated, not acted on');
    expect(r.en).not.toMatch(/should |must |re-anchor/i);
  });

  it('states an anchor chain that has stopped', () => {
    const r = renderMechanismHealth({
      postureNotEngaging: false,
      anchorChainBroken: true,
    })!;
    expect(r.en).toContain('re-reads the whole diff');
    expect(r.zh).toContain('重读整个 diff');
    // The clause splits the shapes that fire it: a recovered round with no
    // anchor at all, one whose side file holds a GRAFTED anchor the running
    // identity cannot use, and one whose graft the running round's fetch
    // refused or resolved to the head. The split is load-bearing: before it,
    // the wording said the recovered round "had none either" — false beside
    // a side file that visibly holds the sha, and pointing away from the
    // actual cause (identity mismatch, or a deterministic refusal the graft
    // re-derives every round).
    expect(r.en).toContain(
      'none at all, one with no certifier, one certified by an identity other than',
    );
    expect(r.en).toContain(
      "or one this round's fetch refused or resolved to the head",
    );
    expect(r.en).not.toContain('had none either');
    expect(r.zh).toContain(
      '要么完全没有、要么没有认证者、要么由本轮运行身份之外的身份认证、要么被本轮的获取拒绝或解析为头提交',
    );
    // The termination condition is "an anchor again", not "a clean close":
    // the marker also withholds on a missing fetched sha and on a model
    // identity drift, both of which a cleanly-closed round can carry.
    expect(r.en).toContain("until a round's marker carries an anchor again");
    // Broad on purpose: the superseded wording drifted into two comments
    // as "until one closes cleanly", which an exact-string pin missed.
    expect(r.en).not.toMatch(/until (a round|one) closes cleanly/);
    expect(r.zh).toContain('直到某一轮的标记重新带上锚点');
    // The onset is hedged: a fail-closed round that leaves a COMPLETE work
    // list beside a strictly-earlier anchored own marker is grafted onto
    // one round later, so "the next review re-reads the whole diff" is
    // false there and the wording says so. The hedge carries the SAME
    // usability qualifier as the termination clause: a graft that landed
    // but the running round cannot use (certifier mismatch, fetch refusal,
    // resolved to the head) does NOT spare the re-read, and an onset
    // promising otherwise contradicts the disclosure on exactly that
    // shape — the one 'discloses a grafted anchor the running model
    // cannot use' pins with 're-reads the whole diff' still in the body.
    expect(r.en).toContain(
      'unless recovery grafts an earlier own anchor that the round running it can use onto the complete work list this round leaves behind',
    );
    expect(r.zh).toContain(
      '除非恢复流程把本轮能使用的更早自有锚点嫁接到本轮留下的完整工作清单上',
    );
    // The termination list names BOTH exits: a round whose own marker
    // carries an anchor again, and a USABLE graft — a grafted anchor whose
    // certifier mismatches the round running it (or whose fetch refuses it)
    // re-fires every round without ending the streak, so the exit is a
    // graft the running round can use, not any graft. Before the clause,
    // the disclosure predicted an endless re-read on exactly the large-PR
    // shapes the graft exists for.
    expect(r.en).toContain(
      'or a graft lands that the round running it can use',
    );
    expect(r.zh).toContain('或落地的嫁接能被运行该轮的评审使用');
    // The design once prescribed a re-anchor round here; the measurements
    // did not bear out its premise, so the shape is disclosed and nothing
    // is recommended.
    expect(r.en).not.toContain('raise');
  });

  it('states both when both hold', () => {
    const r = renderMechanismHealth({
      postureNotEngaging: true,
      anchorChainBroken: true,
    })!;
    expect(r.en).toContain('engaged in name');
    expect(r.en).toContain('re-reads the whole diff');
  });
});

describe('renderConvergenceDiagnosis — what the author reads', () => {
  const base: ConvergenceDiagnosis = {
    round: 6,
    posted: 4,
    fresh: 2,
    prevPosted: 4,
    prevFresh: 2,
    clusters: [{ file: 'src/a.ts', priorRounds: [3, 5], thisRound: 2 }],
    volumeNotShrinking: true,
    truncatedEvidence: false,
    foreignEvidence: false,
    mergedEvidence: false,
  };

  it('states the measured facts before the reading of them', () => {
    const r = renderConvergenceDiagnosis(base);
    expect(r.en).toContain(
      'round 6 posted 4 inline comment(s), 2 of them reported for the first time',
    );
    expect(r.en).toContain('the previous round posted 4');
    expect(r.en).toContain('`src/a.ts` (findings in rounds 3, 5; 2 more now)');
    expect(r.zh).toContain('第 6 轮发布了 4 条行内评论，其中 2 条是首次提出');
    expect(r.zh).toContain('第 3、5 轮已出过发现，本轮又有 2 条');
  });

  it('pluralises the prior-round list by how many rounds it names', () => {
    // The commonest recurrence shape by far is one prior round — flagged in
    // round N, re-flagged in N+1 — so the singular branch is the one most
    // readers see.
    const one = renderConvergenceDiagnosis({
      ...base,
      clusters: [{ file: 'src/a.ts', priorRounds: [4], thisRound: 1 }],
    });
    expect(one.en).toContain('`src/a.ts` (findings in round 4; 1 more now)');
    expect(one.en).not.toContain('in rounds 4;');
  });

  it('says the observation withheld nothing — scoped to the observation', () => {
    // The same body can carry a floor-enforcement note, a deferral list, or
    // a discarded-Suggestion count, all of them things withheld from this
    // round's posting surface. An absolute claim beside those is one the
    // body itself refutes; the claim this module can make is about its own
    // effect, which is none.
    const r = renderConvergenceDiagnosis(base);
    expect(r.en).toContain(
      'nothing was withheld from this review because of this observation',
    );
    expect(r.zh).toContain('未因此扣留任何内容');
  });

  it('advises at the process level, never on code structure', () => {
    const r = renderConvergenceDiagnosis(base);
    expect(r.en).toContain('shared root cause');
    expect(r.en).toContain('splitting an independent cluster');
    // The claim it must never make: how the code should be rewritten.
    expect(r.en).not.toMatch(/refactor|rewrite|extract .* class|redesign/i);
    // Same claim, same direction, other language — an en-only negative
    // catches en regressions only.
    expect(r.zh).toContain('根因');
    expect(r.zh).toContain('拆成单独的 PR');
    expect(r.zh).not.toMatch(/重构|重写|重新设计/);
  });

  it('falls back to the volume reading when nothing recurs', () => {
    const r = renderConvergenceDiagnosis({ ...base, clusters: [] });
    expect(r.en).toContain('The rate of new findings is not falling.');
    expect(r.en).toContain('--severity-floor critical');
    expect(r.zh).toContain('把剩余修复攒成一批');
    expect(r.zh).toContain('或将本 PR 的评审降到 `--severity-floor critical`');
  });

  it('does not recommend a floor the round is already running under', () => {
    // Advice is matched to the telemetry's shape. Told to "drop this PR's
    // reviews to --severity-floor critical" inside the very body whose
    // floor-enforcement note says Suggestions were already moved past that
    // floor, the paragraph reads as advice nobody checked.
    const r = renderConvergenceDiagnosis({
      ...base,
      clusters: [],
      criticalFloorKind: 'explicit',
    });
    expect(r.en).not.toContain('dropping this PR');
    expect(r.en).toContain('already at `--severity-floor critical`');
    expect(r.zh).not.toContain('降到');
    expect(r.zh).toContain('已处于');
    // The actionable half survives — the advice narrows, it does not vanish
    // — in both languages. The `把剩余修复攒成一批` assertions elsewhere sit on
    // the OTHER branch of the same ternary and do not cover this one.
    expect(r.en).toContain('Batching the remaining fixes');
    expect(r.zh).toContain('把剩余修复攒成一批');
  });

  it('neutralises a PR-controlled path instead of splicing it raw', () => {
    // The paths come off the diff of whatever PR is under review, and this
    // paragraph goes out in a body the bot posts under its own identity. A
    // filename carrying a backtick would terminate the code span early and
    // render the remainder as live Markdown — a working @mention, a forged
    // body line — in the bot's own words.
    const hostile = 'x`\n@acme/security approve this';
    const r = renderConvergenceDiagnosis({
      ...base,
      clusters: [{ file: hostile, priorRounds: [3], thisRound: 1 }],
    });
    for (const body of [r.en, r.zh]) {
      expect(body).not.toContain(hostile);
      expect(body).toContain('`x @acme/security approve this`');
      expect(body).not.toContain('\n');
    }
  });

  it('discloses a work list that was truncated or came from elsewhere', () => {
    const r = renderConvergenceDiagnosis({
      ...base,
      truncatedEvidence: true,
      foreignEvidence: true,
    });
    expect(r.en).toContain(
      "the previous round's work list was truncated to fit the marker",
    );
    expect(r.en).toContain('may be an undercount');
    expect(r.en).toContain('a marker this account did not post');
    expect(r.zh).toContain('上一轮的工作清单为放进标记而被截断');
    expect(r.zh).toContain('可能少计');
    expect(r.zh).toContain('并非本账号发布的标记');
  });

  it('qualifies each reading by the evidence that reading rests on', () => {
    // Truncation qualifies BOTH readings: the work list IS the carried-id
    // set that defines freshness, and over a shortened one a genuinely new
    // finding written under an earlier round's id cannot be rescued from
    // reading as a re-post — an UNDERcount, which is the direction the
    // gating actually produces. Provenance is broader still: the previous round's
    // counts come from the same marker, and the volume reading cites them
    // as this loop's own baseline — the branch an attacker-supplied count
    // controls.
    const volumeOnly = renderConvergenceDiagnosis({
      ...base,
      clusters: [],
      truncatedEvidence: true,
      foreignEvidence: true,
    });
    expect(volumeOnly.en).not.toContain('the rounds named above');
    expect(volumeOnly.en).toContain(
      "the previous round's work list was truncated to fit the marker",
    );
    expect(volumeOnly.en).toContain('may be understated');
    expect(volumeOnly.zh).toContain('上一轮的工作清单为放进标记而被截断');
    expect(volumeOnly.zh).toContain('首次提出的条数可能少计');
    expect(volumeOnly.en).toContain('those counts');
    expect(volumeOnly.en).toContain('a marker this account did not post');
    expect(volumeOnly.zh).toContain('该计数');

    // Truncation still qualifies: the facts clause cites this round's fresh
    // count unconditionally, and a shortened carried list inflates exactly
    // that number. Provenance has nothing to qualify here — no rounds are
    // named and no previous count is cited.
    const noCitations = renderConvergenceDiagnosis({
      round: 4,
      posted: 3,
      fresh: 3,
      clusters: [],
      volumeNotShrinking: false,
      truncatedEvidence: true,
      foreignEvidence: true,
      mergedEvidence: false,
    });
    expect(noCitations.en).toContain('may be understated');
    expect(noCitations.en).not.toContain('this account did not post');

    const nothingAtAll = renderConvergenceDiagnosis({
      round: 4,
      posted: 3,
      fresh: 3,
      clusters: [],
      volumeNotShrinking: false,
      truncatedEvidence: false,
      foreignEvidence: true,
      mergedEvidence: false,
    });
    expect(nothingAtAll.zh).not.toContain('证据说明');
  });

  it('names an auto-resolved floor as resolved, not as a flag nobody passed', () => {
    // `auto` is the DEFAULT configuration, and it fails open the moment
    // context becomes unavailable — so wording it as an explicit setting
    // both claims a flag that was never passed and overstates how firmly it
    // holds. The floor-enforcement note in the same body says "resolved".
    const r = renderConvergenceDiagnosis({
      ...base,
      clusters: [],
      criticalFloorKind: 'auto-resolved',
    });
    expect(r.en).toContain('already resolve to a critical posting floor');
    expect(r.en).not.toContain('--severity-floor critical');
    expect(r.zh).toContain('已解析为 critical 发布下限');
  });

  it('names a signal-engaged floor with the reason it engaged early', () => {
    // The trigger engages ahead of the round-6 schedule (#9903); an
    // "already at the floor" sentence that does not say WHY reads as an
    // unexplained posture change — the exact defect this wording exists
    // for. It must also hold back the floor rung, exactly as the
    // round-6 kind does: recommending a posture the round is already
    // running under.
    const r = renderConvergenceDiagnosis({
      ...base,
      clusters: [],
      criticalFloorKind: 'auto-signaled',
    });
    expect(r.en).toContain('already engage the critical posting floor');
    expect(r.en).toContain('resolved early');
    expect(r.en).not.toContain('--severity-floor critical');
    expect(r.zh).toContain('提前生效');
  });

  it('reports both readings when both signals fired', () => {
    // Discriminating on the clusters alone made the volume sentence — and
    // with it the whole floor recommendation — unreachable on the shape this
    // feature exists for: recurrence and a flat trend together.
    const r = renderConvergenceDiagnosis(base);
    expect(r.en).toContain('Findings keep coming back to the same files');
    expect(r.en).toContain('The rate of new findings is not falling.');
    expect(r.en).toContain('shared root cause');
    expect(r.en).toContain('--severity-floor critical');
    expect(r.zh).toContain('新发现的产出速度没有下降。');
    // Both halves of the zh advice, which no assertion reached: the cluster
    // reading and the batching clause the floor reading opens with.
    expect(r.zh).toContain('一个不断再生兄弟发现的簇');
    expect(r.zh).toContain('把剩余修复攒成一批');
  });

  it('says "some of" when the foreign list was merged over this account\'s own', () => {
    // The union restores this account's own certified entries under their
    // own ids, so an unqualified "may not be this account's own" overstates
    // by exactly the part the union protected.
    const r = renderConvergenceDiagnosis({
      ...base,
      foreignEvidence: true,
      mergedEvidence: true,
    });
    expect(r.en).toContain("merged over this account's own entries");
    expect(r.en).toContain('so some of those rounds');
    expect(r.zh).toContain('并与本账号自己的条目合并');
    expect(r.zh).toContain('中的部分可能不属于本账号');
  });

  it('states both previous-round numbers, not just the total', () => {
    // The previous-round clause is the only rendering of the baseline the
    // volume reading cites, and it has two numeric slots.
    const r = renderConvergenceDiagnosis({
      ...base,
      prevPosted: 9,
      prevFresh: 4,
    });
    expect(r.en).toContain('the previous round posted 9 (4 new)');
    expect(r.zh).toContain('上一轮发布了 9 条（其中 4 条首次提出）');
    // A predecessor with no fresh count renders the total alone.
    const older = renderConvergenceDiagnosis({
      ...base,
      prevPosted: 9,
      prevFresh: undefined,
    });
    expect(older.en).toContain('the previous round posted 9');
    expect(older.en).not.toContain('new)');
    expect(older.zh).toContain('上一轮发布了 9 条');
    expect(older.zh).not.toContain('首次提出）');
  });

  it('names both citations when the reading rests on both', () => {
    const r = renderConvergenceDiagnosis({ ...base, foreignEvidence: true });
    expect(r.en).toContain('those rounds and its counts');
    expect(r.zh).toContain('上述轮次与其计数');
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
      fresh: 3,
      clusters: base.clusters,
      volumeNotShrinking: false,
      truncatedEvidence: false,
      foreignEvidence: false,
      mergedEvidence: false,
    });
    expect(r.en).toContain('round 4 posted 3 inline comment(s)');
    expect(r.en).not.toContain('the previous round posted');
    expect(r.zh).not.toContain('上一轮发布了');
  });
});

describe('isFreshDraft — a carried id no longer answers on its own', () => {
  // Issue #9674. Two different things reach this function under a previous
  // round's id: a claim re-asserted (`still stands`) and a NEW defect wearing
  // the id of the entry whose fix produced it (`fix-induced`). Only the first
  // is a re-post.
  const carried = new Set(['R2-1']);

  it('reads a plain carried id as a re-post, as it always did', () => {
    expect(isFreshDraft({ file: 'a.ts', carriedId: 'R2-1' }, 4, carried)).toBe(
      false,
    );
  });

  it('reads a fix-induced carried id as first-time work', () => {
    expect(
      isFreshDraft(
        { file: 'a.ts', carriedId: 'R2-1', fixInduced: true },
        4,
        carried,
      ),
    ).toBe(true);
  });

  it('leaves a finding with no id fresh either way', () => {
    // The marking adds nothing where the id is absent — that comment is
    // already first-time by the id alone — and must not subtract either.
    expect(isFreshDraft({ file: 'a.ts' }, 4, carried)).toBe(true);
    expect(isFreshDraft({ file: 'a.ts', fixInduced: true }, 4, carried)).toBe(
      true,
    );
  });

  it('holds at the round cap, where a plain re-post still reads carried', () => {
    // The cap arm returns false for a carried id minted at or past the cap.
    // The marking has to reach its answer BEFORE that arm, or the one place
    // the counter stops advancing is the one place a fix-induced re-report
    // silently stops counting.
    expect(
      isFreshDraft(
        { file: 'a.ts', carriedId: `R${LEDGER_MAX_ROUND}-1` },
        LEDGER_MAX_ROUND,
        new Set([`R${LEDGER_MAX_ROUND}-1`]),
      ),
    ).toBe(false);
    expect(
      isFreshDraft(
        { file: 'a.ts', carriedId: `R${LEDGER_MAX_ROUND}-1`, fixInduced: true },
        LEDGER_MAX_ROUND,
        new Set([`R${LEDGER_MAX_ROUND}-1`]),
      ),
    ).toBe(true);
  });
});

// The persistently-critical signal is advisory telemetry: every input
// degrades OPEN, so the tests pin both the firing conjunction and each
// degraded arm individually — a false fire would tell an operator to land a
// loop that is still converging, and a missed fire is the silent status quo
// this module exists to end.

const FIRE: ConvergenceFacts = {
  prevHadCritical: true,
  thisCriticals: 2,
  fresh: 3,
  prevFresh: 3,
  floorEngaged: true,
  prevFloor: 'c',
  // The predecessor's work-list was Critical-only, which is what an engaged
  // floor leaves behind — the stamp above cannot say so on its own.
  prevPostedSuggestion: false,
  // Equal to `thisCriticals`, so the backlog veto abstains and every other
  // arm below is pinned on its own. A firing default whose backlog was
  // already shrinking would make each `toBeNull()` below pass for the
  // wrong reason.
  prevCriticals: 2,
  // A WHOLE predecessor list, so the two absence-derived readings above are
  // evidence and the advisory publishes them unqualified.
  prevTruncated: false,
};

describe('convergenceAssessment', () => {
  it('fires on the full conjunction — persistent Criticals, fresh rate not falling', () => {
    const a = convergenceAssessment(FIRE);
    expect(a).not.toBeNull();
    expect(a?.shape).toBe('persistently-critical');
    expect(a?.recommendation).toBe(LAND_WITH_RESIDUAL_RISK);
    expect(a?.criticals).toBe(2);
    expect(a?.fresh).toBe(3);
    expect(a?.prevFresh).toBe(3);
  });

  it('fires when the fresh rate is RISING — rising is not falling either', () => {
    expect(
      convergenceAssessment({ ...FIRE, fresh: 5, prevFresh: 3 }),
    ).not.toBeNull();
  });

  it('suppresses when the previous round was NOT recovered — undefined is not false', () => {
    // A second round introducing its first Critical must not read as
    // "persistent": there is no prior work-list to have carried one.
    expect(
      convergenceAssessment({ ...FIRE, prevHadCritical: undefined }),
    ).toBeNull();
  });

  it('suppresses when the previous work-list had no Critical', () => {
    // Criticals appeared only THIS round — being worked for the first time,
    // not persisted.
    expect(
      convergenceAssessment({ ...FIRE, prevHadCritical: false }),
    ).toBeNull();
  });

  it('suppresses when this round posts no Critical', () => {
    expect(convergenceAssessment({ ...FIRE, thisCriticals: 0 })).toBeNull();
  });

  it('suppresses when the severity floor is NOT engaged — its futility claim would be unprovable', () => {
    // The advisory asserts the floor "will not converge" the loop; before
    // the floor has run, the loop may still converge once it does, and a
    // guess is the false fire this module must never ship.
    expect(convergenceAssessment({ ...FIRE, floorEngaged: false })).toBeNull();
  });

  it('suppresses when floor engagement is UNKNOWN — absence degrades open', () => {
    expect(
      convergenceAssessment({ ...FIRE, floorEngaged: undefined }),
    ).toBeNull();
  });

  it('suppresses when either fresh count is missing — a gap says nothing', () => {
    // Reachable without tampering: a marker written before the fresh count
    // shipped records only the total, and there is no honest way to read a
    // trend off one end of a window.
    expect(convergenceAssessment({ ...FIRE, fresh: undefined })).toBeNull();
    expect(convergenceAssessment({ ...FIRE, prevFresh: undefined })).toBeNull();
  });

  it('suppresses when the fresh rate is FALLING — a converging loop', () => {
    // Criticals present but the new ones drying up: the loop is settling.
    // Measured on posting TOTALS this arm was unreachable — Step 6 re-posts
    // every standing Critical, so the total only ever rises and a loop
    // whose fresh findings fell 5 -> 4 still posted more comments than the
    // round before, firing `land-with-residual-risk` over a converging
    // loop.
    expect(
      convergenceAssessment({ ...FIRE, fresh: 1, prevFresh: 3 }),
    ).toBeNull();
  });

  it('suppresses when the standing backlog is SHRINKING — the fresh window is blind to it', () => {
    // The blind spot the fresh window alone leaves: a reviewer finding
    // nothing new for two rounds while the author clears blockers sits at
    // fresh 0 against fresh 0, which "not falling" reads as stuck. Only the
    // Critical count coming down says the loop is moving.
    expect(
      convergenceAssessment({
        ...FIRE,
        fresh: 0,
        prevFresh: 0,
        thisCriticals: 3,
        prevCriticals: 5,
      }),
    ).toBeNull();
  });

  it('abstains on the backlog when the previous count is unknown', () => {
    // A veto on positive evidence only. The work-list the count comes off
    // is the one the marker's byte budget may have shortened, and an
    // undercount can only hide shrinkage — never invent it — so an unknown
    // predecessor must not silence a loop that is genuinely stuck.
    expect(
      convergenceAssessment({ ...FIRE, prevCriticals: undefined }),
    ).not.toBeNull();
  });

  it('fires at zero fresh on both rounds — the purest form of the shape', () => {
    // Criticals standing round after round with nothing new found is not a
    // quiet loop, it is the shape itself, so this must fire — which is why
    // this signal does NOT carry the sibling diagnosis's `prev.fresh > 0`
    // requirement. That module is about a loop GENERATING work; this one is
    // about work that never clears. The backlog holding steady (not
    // shrinking) is what separates it from a backlog being worked down.
    expect(
      convergenceAssessment({
        prevHadCritical: true,
        thisCriticals: 3,
        fresh: 0,
        prevFresh: 0,
        floorEngaged: true,
        prevFloor: 'c',
        prevPostedSuggestion: false,
        prevCriticals: 3,
        prevTruncated: false,
      }),
    ).not.toBeNull();
  });
});

it('suppresses when the previous round posted under a DIFFERENT floor', () => {
  // The round the floor engages on compares a Critical-only window
  // against a predecessor that was still posting Suggestions. That
  // movement is the posture, not the loop — and "the severity floor will
  // not converge it" is not a claim one round of the floor can support.
  expect(convergenceAssessment({ ...FIRE, prevFloor: 'o' })).toBeNull();
});

it('suppresses when the predecessor still posted a Suggestion — the stamp lied', () => {
  // The recorded floor is the REPORTING reading, which folds an absent
  // `severityFloor` into `auto` and stamps `c` on any round >= 6 — even one
  // the strict enforcement backstop never touched, where Suggestions posted
  // normally. Paired against this round's enforcement reading, that stamp
  // let an un-enforced predecessor pass as an engaged one and the advisory
  // published "the severity floor will not converge it" against a window
  // whose far end still included Suggestions. A Suggestion in the
  // work-list is the fact the stamp cannot carry: enforcement moves drafted
  // Suggestions out of the posting set before the marker is built, so an
  // engaged round's list is Critical-only.
  expect(
    convergenceAssessment({ ...FIRE, prevPostedSuggestion: true }),
  ).toBeNull();
});

it('still evaluates when the predecessor work-list is unreadable', () => {
  // Unknown abstains, like every other fact read off that list — a marker
  // this round could not recover says nothing about what the floor did.
  expect(
    convergenceAssessment({ ...FIRE, prevPostedSuggestion: undefined }),
  ).not.toBeNull();
});

it('still evaluates when the previous floor was never recorded', () => {
  // Read like the sibling diagnosis in this module: a floor that was not
  // recorded is not a floor that DIFFERS. A marker written before the
  // field existed must evaluate exactly as it did before this conjunct,
  // or the advisory goes silent on every loop carrying an older marker.
  expect(
    convergenceAssessment({ ...FIRE, prevFloor: undefined }),
  ).not.toBeNull();
});

it('fires on a truncated predecessor, and says the reading came off one', () => {
  // The gate is deliberately NOT restored: a whole-list requirement would
  // silence the advisory on exactly the deep-work-list rounds it exists for,
  // which are the rounds the marker's byte budget shortens. What a shortened
  // list changes is what may be CLAIMED — "no Suggestion, so the floor was
  // enforcing" and "the backlog is not shrinking" are both read off absence,
  // and absence in a shortened list is not evidence.
  const a = convergenceAssessment({ ...FIRE, prevTruncated: true });
  expect(a).not.toBeNull();
  expect(a?.prevTruncated).toBe(true);
  const { en, zh } = convergenceAdvisory(a!);
  expect(en).toContain('truncated to fit the marker');
  expect(en).toContain('read off a list known to be incomplete');
  expect(zh).toContain('为适配 marker 被截断');
  // And a WHOLE list publishes the readings unqualified.
  const whole = convergenceAdvisory(convergenceAssessment(FIRE)!);
  expect(whole.en).not.toContain('truncated to fit the marker');
  expect(whole.zh).not.toContain('为适配 marker 被截断');
});

describe('convergenceAdvisory', () => {
  it('renders a RISING window in the right direction, in both languages', () => {
    // Every equal-count fixture reads the same number twice, so swapping
    // the two interpolations keeps them all green while inverting the trend
    // a maintainer reads when making the land decision. A rising window
    // (fresh 5, previous 3) fires and must read this-round-first.
    const a = convergenceAssessment({ ...FIRE, fresh: 5, prevFresh: 3 });
    expect(a).not.toBeNull();
    const { en, zh } = convergenceAdvisory(a!);
    expect(en).toContain('this round 5, previous 3');
    expect(zh).toContain('本轮 5');
    expect(zh).toContain('上一轮 3');
  });

  it('names the recommendation code and disclaims itself, in both languages', () => {
    const a = convergenceAssessment(FIRE);
    expect(a).not.toBeNull();
    const { en, zh } = convergenceAdvisory(a!);
    for (const text of [en, zh]) {
      expect(text).toContain(LAND_WITH_RESIDUAL_RISK);
      expect(text).toContain('persistently');
    }
    // Advisory-only contract: it must say it blocks nothing.
    expect(en).toContain('does not block');
    expect(zh).toContain('不阻断');
    // The scaffold names the three maintainer dimensions — in BOTH
    // languages. Pinned only in English, a zh scaffold that lost a column
    // shipped green, and the Chinese reader is the one who cannot fall back
    // to the other half of the paragraph.
    expect(en).toContain('attack surface');
    expect(en).toContain('attacker-dependency');
    expect(en).toContain('blast radius');
    expect(zh).toContain('攻击面');
    expect(zh).toContain('攻击者依赖性');
    expect(zh).toContain('影响范围');
    // The claim the recommendation rests on, positively, in both.
    expect(en).toContain('The severity floor will not converge it');
    expect(zh).toContain('severity floor 无法使其收敛');
    // Bounded by construction: the facts ride as numbers, never model
    // prose — and the zh Critical COUNT is its own interpolation slot, not
    // a repeat of the volume beside it. `FIRE` is deliberately asymmetric
    // (2 Criticals, volume 3/3) so a template reading the wrong slot shows.
    expect(en).toContain('2 Critical(s)');
    expect(en).toContain('this round 3, previous 3');
    expect(zh).toContain('本轮 2 条 Critical');
    expect(zh).toContain('本轮 3，上一轮 3');
    // The numbers are FIRST-TIME findings, and the sentence must say so —
    // reported as "the posting volume" they described a total the signal
    // does not measure, which is the false record this pipeline refuses.
    expect(en).toContain('the rate of first-time findings is not falling');
    expect(en).toContain('the standing Critical backlog is not shrinking');
    expect(en).not.toContain('posting volume');
    expect(zh).toContain('首次发现的速率没有下降');
    expect(zh).toContain('未决 Critical 积压没有减少');
    expect(zh).not.toContain('发布音量');
  });
});
