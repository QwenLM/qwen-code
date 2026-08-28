/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The pre-verify carried-ledger dedup is only worth having if it is safe to
// be wrong in exactly one direction: a candidate it KEEPS merely rides to
// verification and the posting layer's duplicate drop remains the backstop,
// while a candidate it DROPS is out of the round with nothing downstream to
// recover it. So these tests pin the conservative side of every rule — the
// severity guard, the anchor window, the similarity bars, the stand-in
// exclusion, the low-confidence exclusion — as hard as the drops themselves.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ledgerDedupFacts,
  ledgerDedupReportName,
  runDedupCandidates,
  validateCandidates,
  type DedupCandidate,
} from './dedup-candidates.js';

let root: string;
let planDir: string;
let reviewsDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dedup-candidates-'));
  planDir = join(root, 'tmp');
  reviewsDir = join(root, 'reviews');
  mkdirSync(planDir, { recursive: true });
  mkdirSync(reviewsDir, { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const PR = 8255;

function writeDiff(content = 'diff --git a/x b/x\n@@ -0,0 +1 @@\n+added\n'): {
  path: string;
  hash: string;
} {
  const p = join(planDir, 'pr.diff');
  writeFileSync(p, content);
  return {
    path: p,
    hash: createHash('sha256').update(readFileSync(p)).digest('hex'),
  };
}

function writePlan(over: Record<string, unknown> = {}): string {
  const p = join(planDir, 'plan.json');
  writeFileSync(
    p,
    JSON.stringify({
      prNumber: PR,
      diffPathAbsolute: writeDiff().path,
      ...over,
    }),
  );
  return p;
}

function writeLedger(
  findings: Array<Record<string, unknown>>,
  round = 3,
): void {
  writeFileSync(
    join(planDir, `qwen-review-pr-${PR}-prev-ledger.json`),
    JSON.stringify({ v: 1, round, findings }),
  );
}

function writeArtifact(
  findings: Array<Record<string, unknown>>,
  name = `2026-08-25-101010-pr-${PR}.json`,
  round?: number,
): void {
  // save-artifact persists the composed body verbatim, and compose-review
  // stamps the ledger marker into it — the marker is the only carrier of
  // the saving round the deferral fence keys on.
  writeFileSync(
    join(reviewsDir, name),
    JSON.stringify({
      schemaVersion: 1,
      findings,
      ...(round !== undefined
        ? {
            verdict: {
              body:
                'review body\n\n' +
                `<!-- qwen-review-ledger {"v":1,"round":${round},"findings":[]} -->`,
            },
          }
        : {}),
    }),
  );
}

function writeCandidates(entries: unknown): string {
  const p = join(planDir, 'candidates.json');
  writeFileSync(p, JSON.stringify(entries));
  return p;
}

const TITLE = 'precheck-pr workflow does not pin the action version';
const entry = (over: Record<string, unknown> = {}) => ({
  id: 'R1-2',
  sev: 'S',
  file: 'src/a.ts',
  line: 40,
  title: TITLE,
  ...over,
});
const candidate = (over: Record<string, unknown> = {}): DedupCandidate => ({
  file: 'src/a.ts',
  line: 42,
  title: TITLE,
  severity: 'Suggestion',
  ...over,
});

function run(candidates: unknown, planOver: Record<string, unknown> = {}) {
  // Fresh-report semantics: the command deliberately accumulates onto a
  // same-diff report (pinned in its own describe below), so tests that call
  // this twice with opposing expectations start each call clean.
  rmSync(join(planDir, ledgerDedupReportName(PR)), { force: true });
  return runDedupCandidates({
    plan: writePlan(planOver),
    candidates: writeCandidates(candidates),
  });
}

describe('validateCandidates — the typed channel refuses shapeless entries', () => {
  it('refuses a non-array and names the shape', () => {
    expect(() => validateCandidates({})).toThrow(/JSON array/);
  });

  it('refuses a missing file, title, severity or a bad line, by index', () => {
    expect(() =>
      validateCandidates([{ title: 't', severity: 'Critical' }]),
    ).toThrow(/candidates\[0\] needs a non-empty string file/);
    expect(() =>
      validateCandidates([candidate(), { file: 'a', severity: 'Critical' }]),
    ).toThrow(/candidates\[1\] needs a non-empty string title/);
    expect(() =>
      validateCandidates([{ file: 'a', title: 't', severity: 'blocker' }]),
    ).toThrow(/candidates\[0\]\.severity/);
    expect(() => validateCandidates([candidate({ line: 1.5 })])).toThrow(
      /candidates\[0\]\.line/,
    );
    expect(() => validateCandidates([null])).toThrow(
      /candidates\[0\] must be an object/,
    );
  });

  it('passes extra fields through untouched — the kept list must stay shard-sufficient', () => {
    const cands = validateCandidates([
      candidate({ failureScenario: 'x → y', source: '[review]' }),
    ]);
    expect(cands[0]['failureScenario']).toBe('x → y');
  });
});

describe('runDedupCandidates — matching against the posted work list', () => {
  it('drops a candidate restating a ledger entry (same file, near line, same claim)', () => {
    writeLedger([entry()]);
    const r = run([candidate(), candidate({ file: 'src/other.ts' })]);
    expect(r.droppedCount).toBe(1);
    expect(r.dropped[0]).toMatchObject({
      matchedId: 'R1-2',
      via: 'posted',
      file: 'src/a.ts',
    });
    expect(r.kept).toHaveLength(1);
    expect(r.kept[0].file).toBe('src/other.ts');
    expect(r.sources.ledger).toEqual({ round: 3, findings: 1 });
  });

  it('keeps a candidate whose anchor sits outside the line window', () => {
    writeLedger([entry({ line: 40 })]);
    const r = run([candidate({ line: 46 })]);
    expect(r.droppedCount).toBe(0);
  });

  it('keeps a candidate whose claim only loosely overlaps', () => {
    writeLedger([
      entry({ title: 'race between fetch and cache invalidation' }),
    ]);
    const r = run([candidate()]);
    expect(r.droppedCount).toBe(0);
  });

  it('a one-token overlap is coincidence, never a match', () => {
    writeLedger([entry({ title: 'version bump' })]);
    const r = run([candidate({ title: 'version string parsed wrong' })]);
    expect(r.droppedCount).toBe(0);
  });

  it('the similarity bar tightens when either side has no line', () => {
    // Jaccard 6/10 = 0.6: enough beside a near anchor, not enough without one.
    const A = 'alpha beta gamma delta epsilon zeta eta theta';
    const B = 'alpha beta gamma delta epsilon zeta iota kappa';
    writeLedger([entry({ title: A, line: 40 })]);
    expect(run([candidate({ title: B, line: 42 })]).droppedCount).toBe(1);
    // The symmetric cell: a lineless candidate against a lined entry takes
    // the lineless bar too — the anchored window cannot compare one side.
    expect(run([candidate({ title: B, line: undefined })]).droppedCount).toBe(
      0,
    );
    writeLedger([entry({ title: A, line: undefined })]);
    expect(run([candidate({ title: B, line: 42 })]).droppedCount).toBe(0);
  });

  it('never drops a Critical candidate against a non-Critical entry', () => {
    writeLedger([entry({ sev: 'S' })]);
    expect(run([candidate({ severity: 'Critical' })]).droppedCount).toBe(0);
    writeLedger([entry({ sev: 'C' })]);
    expect(run([candidate({ severity: 'Critical' })]).droppedCount).toBe(1);
  });

  it('a Suggestion candidate drops against a Critical entry', () => {
    writeLedger([entry({ sev: 'C' })]);
    expect(run([candidate()]).droppedCount).toBe(1);
  });

  it('a stand-in path names no file unless the k flag says it is one', () => {
    writeLedger([entry({ file: '(body)' })]);
    expect(run([candidate({ file: '(body)' })]).droppedCount).toBe(0);
    writeLedger([entry({ file: '(body)', k: 1 })]);
    expect(run([candidate({ file: '(body)' })]).droppedCount).toBe(1);
  });

  it('keeps everything on a plan without a PR, and says which sources were skipped', () => {
    writeLedger([entry()]);
    const r = run([candidate()], { prNumber: undefined });
    expect(r.droppedCount).toBe(0);
    expect(r.sources).toEqual({ ledger: null, artifact: null });
    expect(r.note).toContain('posted-finding dedup skipped');
  });

  it('keeps everything on round 1 — no side file, no artifact', () => {
    const r = run([candidate()]);
    expect(r.droppedCount).toBe(0);
    expect(r.kept).toHaveLength(1);
  });
});

describe('runDedupCandidates — the deferral half reads the findings artifact', () => {
  beforeEach(() => {
    // The round fence (pinned in its own describe below) admits only an
    // artifact from the side file's own round: give every case here a
    // matching pair, so the entry-level guards stay what is under test.
    writeLedger([], 3);
  });

  const deferred = (over: Record<string, unknown> = {}) => ({
    id: 'D2-1',
    severity: 'Suggestion',
    confidence: 'high',
    summary: TITLE,
    shortSummary: 'precheck-pr: unpinned action',
    locations: [{ file: 'src/a.ts', line: 40 }],
    ...over,
  });

  it('drops a candidate restating a deferral, and cites the D id', () => {
    writeArtifact([deferred()], undefined, 3);
    const r = run([candidate()]);
    expect(r.droppedCount).toBe(1);
    expect(r.dropped[0]).toMatchObject({ matchedId: 'D2-1', via: 'deferred' });
    expect(r.sources.artifact).toMatchObject({ deferred: 1 });
  });

  it('artifact R entries never participate — posted matching is the side file alone', () => {
    writeArtifact([deferred({ id: 'R2-1' })], undefined, 3);
    expect(run([candidate()]).droppedCount).toBe(0);
  });

  it('reads the NEWEST artifact for the PR', () => {
    writeArtifact([deferred()], `2026-08-20-090909-pr-${PR}.json`, 3);
    writeArtifact([], `2026-08-25-101010-pr-${PR}.json`, 3);
    const r = run([candidate()]);
    expect(r.droppedCount).toBe(0);
    expect(r.sources.artifact).toMatchObject({
      name: `2026-08-25-101010-pr-${PR}.json`,
    });
  });

  it('ignores another PR’s artifacts and derived files with longer names', () => {
    writeArtifact([deferred()], `2026-08-25-101010-pr-999.json`);
    writeArtifact([deferred()], `2026-08-25-101010-pr-${PR}-cost-ledger.json`);
    expect(run([candidate()]).sources.artifact).toBeNull();
  });

  it('a malformed artifact contributes nothing', () => {
    writeFileSync(join(reviewsDir, `2026-08-25-101010-pr-${PR}.json`), '{oops');
    expect(run([candidate()]).sources.artifact).toBeNull();
  });

  it('a low-confidence deferral never absorbs a candidate', () => {
    // Terminal-only: it is on no ledger, on no standing deferral record,
    // and Step 6 never rules on it — a match would simply vanish, the
    // unrecoverable direction the module header names.
    writeArtifact([deferred({ confidence: 'low' })], undefined, 3);
    expect(run([candidate()]).droppedCount).toBe(0);
    // The control: the identical entry at high confidence still drops.
    writeArtifact([deferred({ confidence: 'high' })], undefined, 3);
    expect(run([candidate()]).droppedCount).toBe(1);
  });

  it('a deferral the fix run closed never absorbs a re-derivation', () => {
    // `fixed` and `no_change_needed` both take the claim off the plate
    // (findings.ts: one applied, one retracted), so the entry is no longer
    // standing — matching it would lose a regression or a revival.
    writeArtifact([deferred({ outcome: 'fixed' })], undefined, 3);
    expect(run([candidate()]).droppedCount).toBe(0);
    writeArtifact([deferred({ outcome: 'no_change_needed' })], undefined, 3);
    expect(run([candidate()]).droppedCount).toBe(0);
  });

  it('a skipped or outcome-less deferral stays standing and still absorbs', () => {
    writeArtifact([deferred({ outcome: 'skipped' })], undefined, 3);
    expect(run([candidate()]).droppedCount).toBe(1);
    writeArtifact([deferred()], undefined, 3);
    expect(run([candidate()]).droppedCount).toBe(1);
  });

  it('a stand-in location names no file — a pathless deferral never absorbs', () => {
    // The artifact carries no `k` disambiguator, so the posted carrier's
    // `k !== 1` stand-in exclusion is unconditional here: path equality over
    // `(body)` is vacuous, and a standing pathless deferral would absorb
    // every genuinely new pathless candidate before any stage ruled on it.
    writeArtifact(
      [deferred({ locations: [{ file: '(body)' }] })],
      undefined,
      3,
    );
    expect(run([candidate({ file: '(body)' })]).droppedCount).toBe(0);
    writeArtifact(
      [deferred({ locations: [{ file: '(unknown)' }] })],
      undefined,
      3,
    );
    expect(run([candidate({ file: '(unknown)' })]).droppedCount).toBe(0);
    // Control: the same entry still absorbs through a real location.
    writeArtifact([deferred()], undefined, 3);
    expect(run([candidate()]).droppedCount).toBe(1);
  });
});

describe('runDedupCandidates — the deferral half is fenced to the side file’s round', () => {
  // Rounds alternate machines by design — the side file exists precisely
  // for that shape — so the newest local artifact can be OLDER than the
  // recovered work list. A deferral another machine's round closed
  // (`fixed` / `no_change_needed`) still reads as standing in the stale
  // copy, and dropping a re-derived candidate against it would lose the
  // claim on every carrier at once. The artifact's outcomes are only as
  // fresh as the round that saved it, so the half runs only when the
  // artifact IS that round's; every other state skips it — the module's
  // declared conservative direction.
  const deferredD31 = (over: Record<string, unknown> = {}) => ({
    id: 'D3-1',
    severity: 'Suggestion',
    confidence: 'high',
    outcome: 'skipped',
    summary: TITLE,
    shortSummary: 'precheck-pr: unpinned action',
    locations: [{ file: 'src/a.ts', line: 40 }],
    ...over,
  });
  const NAME = `2026-08-25-101010-pr-${PR}.json`;

  it('a stale artifact behind the side file’s round is fenced out', () => {
    writeLedger([], 5);
    writeArtifact([deferredD31()], NAME, 3);
    const r = run([candidate()]);
    expect(r.droppedCount).toBe(0);
    expect(r.sources.artifact).toBeNull();
    expect(r.note).toContain('deferral dedup skipped');
  });

  it('a gap of exactly one round is fenced too', () => {
    // The interleaving the fence exists for: round N saves the artifact
    // here, round N+1 closes the deferral elsewhere, round N+2 is back
    // here — the gap is exactly 1, so a gap fence misses it.
    writeLedger([], 4);
    writeArtifact([deferredD31()], NAME, 3);
    expect(run([candidate()]).droppedCount).toBe(0);
  });

  it('a same-round artifact still absorbs — the machine the side file came from', () => {
    writeLedger([], 5);
    writeArtifact([deferredD31()], NAME, 5);
    const r = run([candidate()]);
    expect(r.droppedCount).toBe(1);
    expect(r.dropped[0]).toMatchObject({ matchedId: 'D3-1', via: 'deferred' });
  });

  it('an artifact whose round is unrecoverable is fenced out', () => {
    writeLedger([], 5);
    writeArtifact([deferredD31()], NAME); // no marker in the body
    expect(run([candidate()]).droppedCount).toBe(0);
    expect(run([candidate()]).sources.artifact).toBeNull();
  });

  it('no recovered side file, no round to fence against — skipped', () => {
    writeArtifact([deferredD31()], NAME, 5);
    expect(run([candidate()]).droppedCount).toBe(0);
    expect(run([candidate()]).sources.artifact).toBeNull();
  });
});

describe('runDedupCandidates — the report on disk', () => {
  it('binds the report to the plan diff and writes it beside the plan', () => {
    writeLedger([entry()]);
    const plan = writePlan();
    const diffHash = createHash('sha256')
      .update(readFileSync(join(planDir, 'pr.diff')))
      .digest('hex');
    runDedupCandidates({ plan, candidates: writeCandidates([candidate()]) });
    const report = JSON.parse(
      readFileSync(join(planDir, ledgerDedupReportName(PR)), 'utf8'),
    );
    expect(report.v).toBe(1);
    expect(report.diffHash).toBe(diffHash);
    expect(report.droppedCount).toBe(1);
  });

  it('a repeat invocation on the same diff accumulates its drops', () => {
    writeLedger([entry(), entry({ id: 'R1-3', file: 'src/b.ts' })]);
    const plan = writePlan();
    runDedupCandidates({ plan, candidates: writeCandidates([candidate()]) });
    const r2 = runDedupCandidates({
      plan,
      candidates: writeCandidates([
        candidate({ file: 'src/b.ts' }),
        candidate({ file: 'src/new.ts' }),
      ]),
    });
    expect(r2.droppedCount).toBe(2);
    expect(r2.dropped.map((d) => d.matchedId)).toEqual(['R1-2', 'R1-3']);
    // kept is THIS invocation's — earlier batches are already sharded.
    expect(r2.kept).toHaveLength(1);
    expect(r2.kept[0].file).toBe('src/new.ts');
  });

  it('a merged leftover citing an entry no longer carried falls out', () => {
    // Run A dropped a candidate against D3-1, wrote the report, and died
    // before cleanup; Step 6 closed D3-1 (`no_change_needed`) into the
    // artifact; run B restarts on the unchanged diff with the closed
    // entry excluded from the carried set. The same-hash merge must
    // re-validate the leftover against the carriers THIS invocation
    // loaded, or the posted body discloses a set-aside against a
    // deferral the previous round closed.
    writeLedger([entry()], 5);
    writeArtifact(
      [
        {
          id: 'D3-1',
          severity: 'Suggestion',
          confidence: 'high',
          outcome: 'no_change_needed',
          summary: TITLE,
          shortSummary: 'precheck-pr: unpinned action',
          locations: [{ file: 'src/a.ts', line: 40 }],
        },
      ],
      `2026-08-25-101010-pr-${PR}.json`,
      5,
    );
    const plan = writePlan();
    const diffHash = createHash('sha256')
      .update(readFileSync(join(planDir, 'pr.diff')))
      .digest('hex');
    writeFileSync(
      join(planDir, ledgerDedupReportName(PR)),
      JSON.stringify({
        v: 1,
        diffHash,
        dropped: [
          {
            file: 'src/z.ts',
            line: 7,
            title: 'leftover claim from the killed run',
            severity: 'Suggestion',
            matchedId: 'D3-1',
            matchedTitle: 'precheck-pr: unpinned action',
            via: 'deferred',
          },
        ],
      }),
    );
    const r = runDedupCandidates({
      plan,
      candidates: writeCandidates([candidate()]),
    });
    expect(r.dropped.map((d) => d.matchedId)).toEqual(['R1-2']);
  });

  it('a repeated invocation over overlapping candidates counts each drop once', () => {
    // The orchestrator retries a lost tool result with the same candidates
    // file, and a Step 5 reporting round re-runs before rewriting it: the
    // merge must identity-dedupe, or the posted disclosure double-counts.
    writeLedger([entry()]);
    const plan = writePlan();
    runDedupCandidates({ plan, candidates: writeCandidates([candidate()]) });
    const r2 = runDedupCandidates({
      plan,
      candidates: writeCandidates([candidate()]),
    });
    expect(r2.droppedCount).toBe(1);
    expect(r2.dropped.map((d) => d.matchedId)).toEqual(['R1-2']);
  });

  it('two differently-worded drops of one anchor stay two in the report', () => {
    // The everyday shape: two finders re-derive the same carried defect at
    // the same anchor with different wording above the bar — the identity
    // filter keys on the title, so both drops survive.
    writeLedger([entry()]);
    const plan = writePlan();
    const r = runDedupCandidates({
      plan,
      candidates: writeCandidates([
        candidate(),
        candidate({
          title: 'precheck workflow does not pin action version sha',
        }),
      ]),
    });
    expect(r.droppedCount).toBe(2);
    expect(r.dropped.map((d) => d.title)).toEqual([
      TITLE,
      'precheck workflow does not pin action version sha',
    ]);
  });

  it('a report bound to another diff is replaced whole, never merged', () => {
    writeLedger([entry()]);
    const plan = writePlan();
    runDedupCandidates({ plan, candidates: writeCandidates([candidate()]) });
    writeDiff('diff --git a/y b/y\n@@ -0,0 +1 @@\n+other\n');
    // A DISTINCT identity (line 43, still within the anchor window): the
    // identity filter must not be able to collapse a cross-diff merge back
    // to this run's count.
    const r2 = runDedupCandidates({
      plan,
      candidates: writeCandidates([candidate({ line: 43 })]),
    });
    expect(r2.droppedCount).toBe(1);
  });

  it('a poisoned same-diff report fails open — replaced, never crash-propagated', () => {
    // The report sits beside the plan, another account's writable surface:
    // a same-hash file whose `dropped` holds a hole or a shapeless entry
    // must not brick the dedup for every same-diff retry of the round, nor
    // merge a phantom set-aside into the disclosure — the module's own
    // contract is optimization, not a gate.
    writeLedger([entry()]);
    const plan = writePlan();
    const diffHash = createHash('sha256')
      .update(readFileSync(join(planDir, 'pr.diff')))
      .digest('hex');
    for (const poisoned of [
      [null],
      [{}],
      [{ matchedId: 'R9-9' }],
      [{ file: 'src/a.ts', title: TITLE, matchedId: 'not-an-id' }],
    ]) {
      writeFileSync(
        join(planDir, ledgerDedupReportName(PR)),
        JSON.stringify({ v: 1, diffHash, dropped: poisoned }),
      );
      const r = runDedupCandidates({
        plan,
        candidates: writeCandidates([candidate()]),
      });
      expect(r.droppedCount).toBe(1);
      expect(r.dropped).toHaveLength(1);
      expect(r.dropped[0].matchedId).toBe('R1-2');
    }
  });

  it('keeps every candidate when the diff cannot be hashed — the drop could not be disclosed', () => {
    // `ledgerDedupFacts` reads only a report hash-bound to this round's
    // diff, so an unhashable diff would set candidates aside with no
    // disclosure ever rendering — the script-lint gate this module
    // imitates fails closed on the same absent hash; the dedup fails open.
    writeLedger([entry()]);
    const absent = run([candidate()], {
      diffPathAbsolute: join(planDir, 'absent.diff'),
    });
    expect(absent.droppedCount).toBe(0);
    expect(absent.kept).toHaveLength(1);
    expect(absent.note).toContain('could not be hashed');
    // fetch-pr's documented partition-failure fallback writes the field null.
    const nullDiff = run([candidate()], { diffPathAbsolute: null });
    expect(nullDiff.droppedCount).toBe(0);
    expect(nullDiff.kept).toHaveLength(1);
  });

  it('refuses an unreadable plan or candidates file with a clean message', () => {
    expect(() =>
      runDedupCandidates({
        plan: join(planDir, 'absent.json'),
        candidates: writeCandidates([]),
      }),
    ).toThrow(/cannot read the plan/);
    expect(() =>
      runDedupCandidates({
        plan: writePlan(),
        candidates: join(planDir, 'absent.json'),
      }),
    ).toThrow(/cannot read the candidates/);
  });
});

describe('ledgerDedupFacts — the disclosure’s read side', () => {
  function freshReport(): string {
    writeLedger([
      entry(),
      entry({ id: 'R1-3', file: 'src/b.ts' }),
      entry({ id: 'R1-4', file: 'src/c.ts' }),
    ]);
    const plan = writePlan();
    runDedupCandidates({
      plan,
      candidates: writeCandidates([
        candidate({ file: 'src/b.ts' }),
        candidate(),
        candidate({ line: 41 }),
      ]),
    });
    return plan;
  }

  it('returns the count and ids, aggregated in first-appearance order', () => {
    const plan = freshReport();
    expect(ledgerDedupFacts(plan)).toEqual({
      droppedCount: 3,
      ids: [
        { id: 'R1-3', n: 1 },
        { id: 'R1-2', n: 2 },
      ],
    });
  });

  it('skips a dropped entry whose matched id fails both shapes', () => {
    const plan = freshReport();
    const path = join(planDir, ledgerDedupReportName(PR));
    const report = JSON.parse(readFileSync(path, 'utf8'));
    report.dropped.push({ ...report.dropped[0], matchedId: 'not-an-id' });
    writeFileSync(path, JSON.stringify(report));
    const facts = ledgerDedupFacts(plan);
    expect(facts.droppedCount).toBe(4);
    expect(facts.ids.map((e) => e.id)).toEqual(['R1-3', 'R1-2']);
  });

  it('renders nothing off a stale report — the diff moved on', () => {
    const plan = freshReport();
    writeDiff('diff --git a/y b/y\n@@ -0,0 +1 @@\n+other\n');
    expect(ledgerDedupFacts(plan)).toEqual({ droppedCount: 0, ids: [] });
  });

  it('renders nothing when no report exists', () => {
    const plan = writePlan();
    expect(ledgerDedupFacts(plan)).toEqual({ droppedCount: 0, ids: [] });
  });
});
