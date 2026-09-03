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
vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: vi.fn(),
  writeStderrLine: vi.fn((line: string) => {
    stderrLines.push(line);
  }),
  writeStderrLineSafe: vi.fn(),
}));

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

import { captureLocalCommand } from './capture-local.js';
import { isolateHostGitConfig } from './lib/test-utils.js';

let repo: string;
let cwd: string;
let gitIsolation: ReturnType<typeof isolateHostGitConfig>;

beforeEach(() => {
  stderrLines.length = 0;
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
  process.chdir(cwd);
  rmSync(repo, { recursive: true, force: true });
  gitIsolation.dispose();
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

describe('capture-local — TOCTOU candidate withholding', () => {
  it('a tree that moved between capture and hash withholds the candidate, out loud', () => {
    captures.push(
      { diff: DIFF_A },
      { diff: Buffer.from('changed mid-hash\n') },
    );
    run();
    expect(
      existsSync(
        join(repo, '.qwen/tmp/qwen-review-local-cache-candidate.json'),
      ),
    ).toBe(false);
    expect(stderrLines.join('\n')).toContain(
      'working tree changed while the capture was being hashed',
    );
  });

  it('a withhold REMOVES an earlier candidate left at the stable path', () => {
    // The candidate path is stable per target: round A's candidate still
    // sits there when round B withholds, and round B's plan still publishes
    // `cacheCandidatePath` — so Step 8 read the stale file and promoted
    // round A's anchor merged with round B's ledger. The withhold must
    // leave the published path actually ABSENT.
    captures.push({ diff: DIFF_A }, { diff: Buffer.from(DIFF_A) });
    run();
    expect(
      existsSync(
        join(repo, '.qwen/tmp/qwen-review-local-cache-candidate.json'),
      ),
    ).toBe(true);

    // Round B: the tree moves under the hash pass — the withhold path.
    captures.push(
      { diff: DIFF_A },
      { diff: Buffer.from('changed mid-hash\n') },
    );
    run();
    expect(
      existsSync(
        join(repo, '.qwen/tmp/qwen-review-local-cache-candidate.json'),
      ),
    ).toBe(false);
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
      existsSync(
        join(repo, '.qwen/tmp/qwen-review-local-cache-candidate.json'),
      ),
    ).toBe(false);
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
      existsSync(
        join(repo, '.qwen/tmp/qwen-review-local-cache-candidate.json'),
      ),
    ).toBe(false);
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
    expect(stderrLines.join('\n')).not.toContain('candidate is withheld');
  });
});

describe('capture-local — the withheld candidate is not announced', () => {
  it('omits cacheCandidatePath from the plan and removes a stale file', () => {
    // Step 8 branches on the field's presence; announcing a path to a file
    // this run deliberately withheld sends it promoting an earlier round's
    // candidate.
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
    expect('cacheCandidatePath' in plan).toBe(false);
    expect(existsSync(stale)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'a withhold does not delete through a symlinked `.qwen/tmp`',
    () => {
      // The removal side of the same guarded threat: a contributor branch
      // commits `.qwen/tmp` as a link to a directory holding the
      // deterministic candidate name, and the withhold branch's cleanup
      // would otherwise delete the VICTIM file while stderr reported only
      // the anchor cost. The guard must fail toward field-absence — the
      // load-bearing half — never toward a round-crashing throw.
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
        run();
        const plan = JSON.parse(
          readFileSync(join(repo, 'plan.json'), 'utf8'),
        ) as Record<string, unknown>;
        expect('cacheCandidatePath' in plan).toBe(false);
        expect(readFileSync(planted, 'utf8')).toBe('ORIGINAL');
        expect(stderrLines.join('\n')).toContain('candidate is withheld');
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
