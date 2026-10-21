/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The TOCTOU withhold branch, in isolation: when the re-capture after hashing
// returns different bytes, the candidate must NOT be written and the refusal
// must be said out loud — the one uncertainty in the anchor module that used
// to fail open. The capture layer is mocked with a stateful fake so the two
// captures can disagree deterministically; everything downstream is real.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stderrLines: string[] = [];
/** What the handler's `catch` printed — the refusal line of a failed round. */
const handlerErrors: string[] = [];
/** Runs on every stderr line — a seam to act mid-run, after a given line. */
let onStderr: ((line: string) => void) | undefined;
vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: vi.fn(),
  writeStderrLine: vi.fn((line: string) => {
    stderrLines.push(line);
    onStderr?.(line);
  }),
  writeStderrLineSafe: vi.fn((line: string) => {
    handlerErrors.push(line);
  }),
}));

/** When set, the candidate's atomic write fails — a full disk, a refusal. */
let failCandidateWrite = false;
vi.mock(
  '@qwen-code/qwen-code-core/utils/atomicFileWrite.js',
  async (importOriginal) => {
    const real =
      await importOriginal<
        typeof import('@qwen-code/qwen-code-core/utils/atomicFileWrite.js')
      >();
    return {
      ...real,
      atomicWriteFileSync: vi.fn(
        (...args: Parameters<typeof real.atomicWriteFileSync>) => {
          if (failCandidateWrite && String(args[0]).includes('candidate')) {
            throw new Error('ENOSPC: no space left on device');
          }
          return real.atomicWriteFileSync(...args);
        },
      ),
    };
  },
);

const captures: Array<{ diff: Buffer }> = [];
/**
 * Successive `hashWorktreeFiles` answers, when a test needs the passes to
 * disagree. Empty means "use the real one" — every other test in this file
 * hashes for real. A list shorter than the number of passes REPEATS its last
 * entry, which reads as "the tree stopped moving": a fixture says what it is
 * about and the guard's extra samples see a settled tree.
 */
const hashPasses: Array<Record<string, string>> = [];
vi.mock('./lib/local-anchor.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./lib/local-anchor.js')>();
  return {
    ...real,
    hashWorktreeFiles: (...args: Parameters<typeof real.hashWorktreeFiles>) =>
      hashPasses.length > 0
        ? ((hashPasses.length > 1
            ? hashPasses.shift()
            : hashPasses[0]) as Record<string, string>)
        : real.hashWorktreeFiles(...args),
  };
});
vi.mock('./lib/local-diff.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./lib/local-diff.js')>();
  return {
    ...real,
    captureLocalDiff: vi.fn(() => {
      const next = captures.length > 1 ? captures.shift() : captures[0];
      if (!next) throw new Error('fixture exhausted');
      return {
        diff: next.diff,
        untracked: [],
        skipped: [],
        unbornHead: false,
        repoRoot: repo,
      };
    }),
  };
});

import { cacheCommitCommand } from './cache-commit.js';
import { captureLocalCommand } from './capture-local.js';
import {
  isLedgerOnlyCandidate,
  isolateHostGitConfig,
} from './lib/test-utils.js';

let repo: string;
let cwd: string;
let gitIsolation: ReturnType<typeof isolateHostGitConfig>;

let savedIdentity: string | undefined;

beforeEach(() => {
  // A candidate anchors only under a published identity, so the fixtures
  // publish one.
  failCandidateWrite = false;
  onStderr = undefined;
  savedIdentity = process.env['QWEN_CODE_MODEL_IDENTITY'];
  process.env['QWEN_CODE_MODEL_IDENTITY'] = 'fixture-model@1a2b3c4d';
  stderrLines.length = 0;
  handlerErrors.length = 0;
  captures.length = 0;
  hashPasses.length = 0;
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'review-toctou-')));
  cwd = process.cwd();
  process.chdir(repo);
  gitIsolation = isolateHostGitConfig();
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '--template=', '.');
  git('config', 'user.email', 'a@b');
  git('config', 'user.name', 'a');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-q', '--no-verify', '-m', 'base');
});

afterEach(() => {
  if (savedIdentity === undefined)
    delete process.env['QWEN_CODE_MODEL_IDENTITY'];
  else process.env['QWEN_CODE_MODEL_IDENTITY'] = savedIdentity;
  process.chdir(cwd);
  rmSync(repo, { recursive: true, force: true });
  gitIsolation.dispose();
  process.exitCode = undefined;
});

const DIFF_A = Buffer.from(
  'diff --git a/a.ts b/a.ts\nindex 000..111 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-export const a = 1;\n+export const a = 2;\n',
  'utf8',
);

function run(extra: Record<string, unknown> = {}): void {
  (captureLocalCommand.handler as (argv: unknown) => void)({
    out: join(repo, 'plan.json'),
    target: 'local',
    untracked: true,
    ...extra,
  });
}

/** Read the plan report `run()` just wrote. */
function report(): { incremental?: unknown; diffPath: string } {
  return JSON.parse(readFileSync(join(repo, 'plan.json'), 'utf8')) as {
    incremental?: unknown;
    diffPath: string;
  };
}

describe('capture-local — TOCTOU anchor withholding', () => {
  it('a tree that moved between capture and hash writes no anchor, out loud', () => {
    captures.push(
      { diff: DIFF_A },
      { diff: Buffer.from('changed mid-hash\n') },
    );
    run();
    expect(
      isLedgerOnlyCandidate(
        join(repo, '.qwen/tmp/qwen-review-local-cache-candidate.json'),
      ),
    ).toBe(true);
    expect(stderrLines.join('\n')).toContain(
      'working tree changed while the capture was being hashed',
    );
  });

  it('a withhold REPLACES an earlier anchored candidate left at the stable path', () => {
    // The candidate path is stable per target: round A's candidate still
    // sits there when round B withholds, and round B's plan publishes
    // `cacheCandidatePath` — so Step 8 would promote round A's anchor merged
    // with round B's ledger. The ledger-only candidate must REPLACE it.
    captures.push({ diff: DIFF_A }, { diff: Buffer.from(DIFF_A) });
    run();
    expect(
      existsSync(
        join(repo, '.qwen/tmp/qwen-review-local-cache-candidate.json'),
      ),
    ).toBe(true);
    expect(
      isLedgerOnlyCandidate(
        join(repo, '.qwen/tmp/qwen-review-local-cache-candidate.json'),
      ),
    ).toBe(false);

    // Round B: the tree moves under the hash pass — the withhold path.
    captures.push(
      { diff: DIFF_A },
      { diff: Buffer.from('changed mid-hash\n') },
    );
    run();
    expect(
      isLedgerOnlyCandidate(
        join(repo, '.qwen/tmp/qwen-review-local-cache-candidate.json'),
      ),
    ).toBe(true);
  });

  it('a moved tree refuses THIS round\u2019s scoping too, not just the candidate', () => {
    // Withholding only the candidate protects the NEXT round and leaves this
    // one wrong: the scoping compares the very hashes the guard just proved
    // may not describe the capture under review. A file edited during the
    // hash pass and reverted before it is hashed reads as unchanged,
    // `changedSince` reports nothing, and its diff section is sliced out —
    // the round then says "nothing to re-review" over a capture no agent
    // read. Promote a real candidate first, so the anchor is otherwise
    // valid and the refusal can only come from the guard.
    captures.push({ diff: DIFF_A }, { diff: Buffer.from(DIFF_A) });
    run({ model: 'model-a' });
    const cachePath = join(repo, 'cache.json');
    const promoted = JSON.parse(
      readFileSync(
        join(repo, '.qwen/tmp/qwen-review-local-cache-candidate.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    writeFileSync(
      cachePath,
      JSON.stringify({ ...promoted, lastModelId: 'model-a' }),
    );

    // Round 2: same anchor, but the tree moves under the hash pass.
    stderrLines.length = 0;
    captures.push(
      { diff: DIFF_A },
      { diff: Buffer.from('changed mid-hash\n') },
    );
    run({ model: 'model-a', cache: cachePath });

    expect(report().incremental).toBeUndefined();
    expect(stderrLines.join('\n')).toContain(
      'Incremental anchor not used — the working tree changed while the ' +
        'capture was being hashed',
    );
    // The full capture is what the plan reviews.
    expect(readFileSync(report().diffPath).equals(DIFF_A)).toBe(true);
  });

  it('does not call a MOVED tree clean, even with an empty capture', () => {
    // The two stops contradicted each other. A review starting on an empty
    // tree, with an autosave landing inside the capture window, withholds the
    // candidate and refuses the anchor — and then wrote `clean-tree` anyway,
    // because capture 0's diff is empty. stderr printed both lines back to
    // back, the round stopped on the second, and the just-written change went
    // unreviewed while the run was recorded as clean.
    captures.push(
      { diff: Buffer.from('') },
      { diff: DIFF_A },
      { diff: DIFF_A },
    );
    run();
    const plan = JSON.parse(
      readFileSync(join(repo, 'plan.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(plan['nothingToReview']).toBeUndefined();
    const err = stderrLines.join('\n');
    expect(err).toContain(
      'working tree changed while the capture was being hashed',
    );
    // …and the PROSE must not contradict it either. The orchestrator branches
    // on these sentences, and the round printed "the working tree is clean"
    // right after the line above until this was gated too.
    expect(err).not.toContain('the working tree is clean');
    expect(err).toContain('this is NOT a clean tree');
  });

  it('catches a PHASE-ALIGNED write the pairwise guard let through', () => {
    // Two samples of each kind, compared pairwise, never tied a capture to
    // the hashes recorded beside it. Three timed writes defeat it: X→Y
    // before the hash pass, Y→X before the re-capture, X→Y after it. The two
    // captures agree (X, X) and the two hash passes agree (Y, Y), so
    // `treeHeldStill` is true — and the candidate certifies Y's identity for
    // a round that reviewed X. Promoted, the next round compares cache Y
    // against tree Y, finds no delta and says "No changes" over bytes no
    // round ever read.
    //
    // Interleaving a third sample of each kind means the write pattern has
    // to keep alternating; this one stops, and the third hash pass reads
    // what the captures did.
    captures.push(
      { diff: DIFF_A },
      { diff: Buffer.from(DIFF_A) },
      { diff: Buffer.from(DIFF_A) },
    );
    hashPasses.push(
      { 'a.ts': '100644:oid-Y' },
      { 'a.ts': '100644:oid-Y' },
      { 'a.ts': '100644:oid-X' },
    );
    run();
    expect(
      isLedgerOnlyCandidate(
        join(repo, '.qwen/tmp/qwen-review-local-cache-candidate.json'),
      ),
    ).toBe(true);
    expect(stderrLines.join('\n')).toContain(
      'working tree changed while the capture was being hashed',
    );
  });

  it('catches a same-bytes revert that STRADDLES the hash pass', () => {
    // The hash pass sits BETWEEN the two diff snapshots, so a write that
    // straddles it is invisible to the diffs alone: capture B0 → autosave
    // writes B1 → the hashes read B1 → undo restores B0 → the re-capture
    // reads B0. Both diffs agree and the candidate certifies B1's identity
    // for a round that reviewed B0.
    //
    // The note here used to call that shape harmless and a
    // different-bytes revert the uncatchable one — backwards: a
    // different-bytes revert moves the endpoints and IS caught by the
    // diffs. Re-hashing after the re-capture is what sees this one.
    captures.push({ diff: DIFF_A }, { diff: Buffer.from(DIFF_A) });
    // The two diffs AGREE — that is the point. What disagrees is the pair of
    // hash passes that bracket the re-capture: the first read B1, the second
    // reads B0.
    hashPasses.push({ 'a.ts': '100644:oid-B1' }, { 'a.ts': '100644:oid-B0' });
    run();
    expect(
      isLedgerOnlyCandidate(
        join(repo, '.qwen/tmp/qwen-review-local-cache-candidate.json'),
      ),
    ).toBe(true);
    expect(stderrLines.join('\n')).toContain(
      'working tree changed while the capture was being hashed',
    );
  });

  it('a tree that held still writes the candidate and no warning', () => {
    captures.push({ diff: DIFF_A }, { diff: Buffer.from(DIFF_A) });
    run();
    expect(
      existsSync(
        join(repo, '.qwen/tmp/qwen-review-local-cache-candidate.json'),
      ),
    ).toBe(true);
    expect(
      isLedgerOnlyCandidate(
        join(repo, '.qwen/tmp/qwen-review-local-cache-candidate.json'),
      ),
    ).toBe(false);
    expect(stderrLines.join('\n')).not.toContain('findings ledger only');
  });
});

describe('capture-local — the unanchored candidate is announced with its own state id', () => {
  it('publishes the ledger-only candidate and replaces a stale file (#12657)', () => {
    // A local round's ledger has no other home, so the plan announces the
    // candidate — but it must be THIS round's ledger-only one, never an
    // earlier round's anchor left at the stable path, and its state id must
    // sit outside the anchored namespace so a concurrent anchored round's
    // file can never pass `--state-id` for it.
    const stale = join(
      repo,
      '.qwen/tmp/qwen-review-local-cache-candidate.json',
    );
    // PLANT an earlier round's candidate: without it the removal assertion
    // passes even when the removal itself is deleted.
    mkdirSync(join(repo, '.qwen/tmp'), { recursive: true });
    writeFileSync(
      stale,
      JSON.stringify({ v: 1, target: 'local', stale: true }),
    );
    captures.push({ diff: DIFF_A }, { diff: Buffer.from('moved mid-hash\n') });
    run();
    const plan = JSON.parse(
      readFileSync(join(repo, 'plan.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(plan['cacheCandidatePath']).toBeTruthy();
    expect(isLedgerOnlyCandidate(stale)).toBe(true);
    expect(String(plan['cacheCandidateStateId'])).toMatch(/^ledger-/);
    expect(
      (JSON.parse(readFileSync(stale, 'utf8')) as Record<string, unknown>)[
        'ledgerOnly'
      ],
    ).toBe('the working tree changed while the capture was being hashed');
    expect(
      (JSON.parse(readFileSync(stale, 'utf8')) as Record<string, unknown>)[
        'stateId'
      ],
    ).toBe(plan['cacheCandidateStateId']);
  });

  it.skipIf(process.platform === 'win32')(
    'a symlinked `.qwen/tmp` is refused before the withhold branch can remove through it',
    () => {
      // The removal side of the redirected-scratch-directory threat: a link
      // to a directory holding the deterministic candidate name, and a
      // withhold that would have deleted the VICTIM file. The round is
      // refused at the directory, before the capture — so the victim is
      // intact, no plan is written, and the removal guard below the write
      // is the second line, not the first.
      const victim = realpathSync(mkdtempSync(join(tmpdir(), 'victim-')));
      const planted = join(victim, 'qwen-review-local-cache-candidate.json');
      writeFileSync(planted, 'ORIGINAL');
      mkdirSync(join(repo, '.qwen'), { recursive: true });
      symlinkSync(victim, join(repo, '.qwen/tmp'));
      try {
        captures.push(
          { diff: DIFF_A },
          { diff: Buffer.from('moved mid-hash\n') },
        );
        // The handler reports a refusal rather than throwing it: one line,
        // exit 1 — a runtime refusal, not the usage class.
        expect(() => run()).not.toThrow();
        expect(process.exitCode).toBe(1);
        expect(handlerErrors.join('\n')).toMatch(
          /^capture-local: .*tmp is a symbolic link/s,
        );
        expect(readFileSync(planted, 'utf8')).toBe('ORIGINAL');
        expect(existsSync(join(repo, 'plan.json'))).toBe(false);
      } finally {
        rmSync(victim, { recursive: true, force: true });
      }
    },
  );

  it('announces the path when the candidate IS written', () => {
    captures.push({ diff: DIFF_A }, { diff: Buffer.from(DIFF_A) });
    run();
    const plan = JSON.parse(
      readFileSync(join(repo, 'plan.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(plan['cacheCandidatePath']).toContain('cache-candidate.json');
  });
});

describe('capture-local — the ledger-only candidate at its edges (#12657)', () => {
  const CANDIDATE = () =>
    join(repo, '.qwen/tmp/qwen-review-local-cache-candidate.json');
  const plan = () =>
    JSON.parse(readFileSync(join(repo, 'plan.json'), 'utf8')) as Record<
      string,
      unknown
    >;

  it('binds anchored and ledger-only rounds apart, in both directions', () => {
    // Same content, two rounds racing on the stable path: neither's plan may
    // promote the other's file, or an anchor rides a ledger nobody paired it
    // with (or a ledger-only round's verdict rides a foreign anchor).
    captures.push({ diff: DIFF_A }, { diff: Buffer.from(DIFF_A) });
    run();
    const anchoredId = String(plan()['cacheCandidateStateId']);
    const anchoredFile = readFileSync(CANDIDATE(), 'utf8');
    captures.push({ diff: DIFF_A }, { diff: Buffer.from('moved mid-hash\n') });
    run();
    const ledgerId = String(plan()['cacheCandidateStateId']);
    expect(ledgerId).toBe(`ledger-${anchoredId}`);

    const ledger = join(repo, '.qwen/tmp/ledger.json');
    writeFileSync(ledger, JSON.stringify({ round: 1, findings: [] }));
    const promote = (stateId: string) =>
      (cacheCommitCommand.handler as (argv: unknown) => void)({
        candidate: CANDIDATE(),
        ledger,
        out: join(repo, '.qwen/review-cache/local.json'),
        stateId,
      });
    // The ledger-only file is on disk: the anchored round's id is refused.
    expect(() => promote(anchoredId)).toThrow(/stateId/);
    // The anchored file is back: the ledger-only round's id is refused.
    writeFileSync(CANDIDATE(), anchoredFile);
    expect(() => promote(ledgerId)).toThrow(/stateId/);
  });

  it('publishes no path for a ledger-only round with no chunks', () => {
    // SKILL.md's 0-chunk WARNING shapes end without a verdict. Published,
    // the path would let a Step 8 that ran anyway overwrite the previous
    // round's open Criticals with an empty ledger.
    captures.push({ diff: Buffer.alloc(0) }, { diff: Buffer.from(DIFF_A) });
    run();
    const p = plan();
    expect(p['chunks']).toEqual([]);
    expect('cacheCandidatePath' in p).toBe(false);
    expect('cacheCandidateStateId' in p).toBe(false);
    // …and the stable path holds nothing, said out loud.
    expect(existsSync(CANDIDATE())).toBe(false);
    expect(stderrLines.join('\n')).toContain(
      'the ledger-only cache candidate is not published',
    );
  });

  it('leaves a concurrent round\u2019s candidate alone when withdrawing its own', () => {
    // The withdrawal runs after the scoping work, so a same-target round can
    // write its own candidate at the stable path in between. Written right
    // after this round's reason line — between our write and our removal.
    const foreign = JSON.stringify({ v: 1, stateId: 'someone-else' });
    // Once: the 0-chunk WARNING later repeats the phrase, AFTER the
    // withdrawal, and a second write there would restore what a wrong
    // removal deleted.
    let planted = false;
    onStderr = (line) => {
      if (!planted && line.includes('working tree changed')) {
        planted = true;
        writeFileSync(CANDIDATE(), foreign);
      }
    };
    captures.push({ diff: Buffer.alloc(0) }, { diff: Buffer.from(DIFF_A) });
    run();
    expect('cacheCandidatePath' in plan()).toBe(false);
    expect(readFileSync(CANDIDATE(), 'utf8')).toBe(foreign);
  });

  it('a failed write publishes nothing, removes the stale file, and says the ledger is lost', () => {
    mkdirSync(join(repo, '.qwen/tmp'), { recursive: true });
    writeFileSync(CANDIDATE(), JSON.stringify({ v: 1, stale: true }));
    failCandidateWrite = true;
    captures.push({ diff: DIFF_A }, { diff: Buffer.from('moved mid-hash\n') });
    run();
    expect('cacheCandidatePath' in plan()).toBe(false);
    expect(existsSync(CANDIDATE())).toBe(false);
    const err = stderrLines.join('\n');
    expect(err).toContain('findings ledger will not persist');
    expect(err).not.toContain('findings ledger only, no anchor');
  });
});
