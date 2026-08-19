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
  type ConvergenceDiagnosis,
  type DraftedFinding,
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
    // posted paragraph. Recognised by the ledger's structural flag, never by
    // the sentinel text — see the real-file test below.
    expect(
      diagnoseConvergence({
        round: 4,
        posted: 1,
        prev: {
          posted: 9,
          findings: [
            { id: 'nonsense', sev: 'C', file: 'a.ts', title: 't' },
            { id: 'R2-1', sev: 'C', file: '(body)', title: 't', k: 'b' },
            { id: 'R2-2', sev: 'S', file: '(unknown)', title: 't', k: 'u' },
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
      prev: { posted: 5, findings: [] },
      drafts: [d('a.ts')],
      floor: 'o',
    })!;
    expect(flat.volumeNotShrinking).toBe(true);
    expect(flat.clusters).toEqual([]);

    const grew = diagnoseConvergence({
      round: 3,
      posted: 6,
      prev: { posted: 5, findings: [] },
      drafts: [d('a.ts')],
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
        prev: { posted: 0, findings: [] },
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
        prev: { posted: 6, findings: [] },
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
        prev: { posted: 0, findings: [] },
        drafts: [d('a.ts')],
        floor: 'o',
      }),
    ).toBeNull();
    // A genuine flat trend still fires.
    expect(
      diagnoseConvergence({
        round: 5,
        posted: 2,
        prev: { posted: 2, findings: [] },
        drafts: [d('a.ts')],
        floor: 'o',
      }),
    ).not.toBeNull();
  });

  it('holds the volume signal until round 3 — one step is not a trend', () => {
    expect(
      diagnoseConvergence({
        round: 2,
        posted: 9,
        prev: { posted: 5, findings: [] },
        drafts: [d('a.ts')],
        floor: 'o',
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
        prev: { findings: [] },
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
    // so a same-round id cannot silently erase this round's own work.
    const r = diagnoseConvergence({
      round: 3,
      posted: 1,
      prev: { posted: 1, findings: [f('R2-1', 'a.ts')] },
      drafts: [d('a.ts', 'R3-1')],
      floor: 'o',
    })!;
    expect(r.clusters[0].thisRound).toBe(1);
  });

  it('orders clusters by persistence, then by this round, then by path', () => {
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
      'persistent.ts',
      'busy.ts',
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
    // them, and a real file carries none.
    const r = diagnoseConvergence({
      round: 4,
      posted: 1,
      prev: { posted: 9, findings: [f('R2-1', '(body)')] },
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
        prev: { posted: 1, findings: [], floor: 'c' },
        drafts: [d('a.ts'), d('b.ts')],
        floor: 'o',
      }),
    ).toBeNull();
    // Same floor, same numbers: a real flat trend still fires.
    expect(
      diagnoseConvergence({
        round: 8,
        posted: 5,
        prev: { posted: 1, findings: [], floor: 'o' },
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
        prev: { posted: 1, findings: [] },
        drafts: [d('a.ts'), d('b.ts')],
        floor: 'o',
      }),
    ).not.toBeNull();
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

describe('renderConvergenceDiagnosis — what the author reads', () => {
  const base: ConvergenceDiagnosis = {
    round: 6,
    posted: 4,
    prevPosted: 4,
    clusters: [{ file: 'src/a.ts', priorRounds: [3, 5], thisRound: 2 }],
    volumeNotShrinking: true,
    truncatedEvidence: false,
    foreignEvidence: false,
  };

  it('states the measured facts before the reading of them', () => {
    const r = renderConvergenceDiagnosis(base);
    expect(r.en).toContain('round 6 posted 4 inline comment(s)');
    expect(r.en).toContain('the previous round posted 4');
    expect(r.en).toContain('`src/a.ts` (findings in rounds 3, 5, 2 more now)');
    expect(r.zh).toContain('第 6 轮发布了 4 条行内评论');
    expect(r.zh).toContain('第 3、5 轮已出过发现');
  });

  it('pluralises the prior-round list by how many rounds it names', () => {
    // The commonest recurrence shape by far is one prior round — flagged in
    // round N, re-flagged in N+1 — so the singular branch is the one most
    // readers see.
    const one = renderConvergenceDiagnosis({
      ...base,
      clusters: [{ file: 'src/a.ts', priorRounds: [4], thisRound: 1 }],
    });
    expect(one.en).toContain('`src/a.ts` (findings in round 4, 1 more now)');
    expect(one.en).not.toContain('in rounds 4,');
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
  });

  it('falls back to the volume reading when nothing recurs', () => {
    const r = renderConvergenceDiagnosis({ ...base, clusters: [] });
    expect(r.en).toContain('posting volume is not falling');
    expect(r.en).toContain('--severity-floor critical');
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
    // The actionable half survives — the advice narrows, it does not vanish.
    expect(r.en).toContain('Batching the remaining fixes');
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
    expect(r.en).toContain('may be an undercount');
    expect(r.en).toContain('a marker this account did not post');
    expect(r.zh).toContain('可能少计');
    expect(r.zh).toContain('并非本账号发布的标记');
  });

  it('qualifies each reading by the evidence that reading rests on', () => {
    // Truncation affects the WORK LIST only, so it says nothing about a
    // volume-only reading. Provenance is broader: the previous round's
    // volume comes from the same marker, and the volume-only branch cites
    // that number as this loop's own baseline — which is exactly the branch
    // an attacker-supplied `posted` controls.
    const volumeOnly = renderConvergenceDiagnosis({
      ...base,
      clusters: [],
      truncatedEvidence: true,
      foreignEvidence: true,
    });
    expect(volumeOnly.en).not.toContain('undercount');
    expect(volumeOnly.en).toContain('that volume');
    expect(volumeOnly.en).toContain('a marker this account did not post');
    expect(volumeOnly.zh).toContain('该发布量');

    // With no previous volume recovered and no cluster evidence in play,
    // there is nothing for provenance to qualify.
    const nothingCited = renderConvergenceDiagnosis({
      round: 4,
      posted: 3,
      clusters: [],
      volumeNotShrinking: false,
      truncatedEvidence: true,
      foreignEvidence: true,
    });
    expect(nothingCited.zh).not.toContain('证据说明');
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
      truncatedEvidence: false,
      foreignEvidence: false,
    });
    expect(r.en).toContain('round 4 posted 3 inline comment(s)');
    expect(r.en).not.toContain('the previous round posted');
    expect(r.zh).not.toContain('上一轮发布了');
  });
});
