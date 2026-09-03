/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The one property that matters here is precedence: the candidate's anchor
// fields must win every key collision, because the ledger half is
// model-written and a mis-copied anchor is exactly the defect that moved this
// merge out of prose. The rest is boundary manners: refuse loudly on inputs
// that would write a cache no next round could trust.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  symlinkSync,
  lstatSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { stdoutLines } = vi.hoisted(() => ({ stdoutLines: [] as string[] }));
vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: vi.fn((line: string) => {
    stdoutLines.push(line);
  }),
  writeStderrLine: vi.fn(),
  writeStderrLineSafe: vi.fn(),
}));

import { cacheCommitCommand } from './cache-commit.js';

let dir: string;

beforeEach(() => {
  stdoutLines.length = 0;
  // `realpathSync`, like every sibling fixture here: the handler refuses to
  // write through a symlinked parent (`assertUnredirectedParent`), and
  // `tmpdir()` IS a symlink on macOS (`/var/folders/…` →
  // `/private/var/folders/…`). Without the wrap every success-path test here
  // fails on a developer's Mac while CI stays green on its real-path TMPDIR.
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'cache-commit-')));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(argv: Record<string, unknown>): void {
  (cacheCommitCommand.handler as (argv: unknown) => void)(argv);
}

function seed(candidate: unknown, ledger: unknown): Record<string, string> {
  const candidatePath = join(dir, 'candidate.json');
  const ledgerPath = join(dir, 'ledger.json');
  // Every real candidate carries the identity that certified the round — both
  // captures record it — so a fixture that omits it is testing something else
  // and gets the default. A test about the field itself passes its own (or
  // `null` to leave it out).
  const withModel =
    candidate !== null &&
    typeof candidate === 'object' &&
    !('lastModelId' in candidate)
      ? { ...candidate, lastModelId: 'candidate-model@aaaaaaaa' }
      : candidate;
  writeFileSync(candidatePath, JSON.stringify(withModel));
  writeFileSync(ledgerPath, JSON.stringify(ledger));
  return {
    candidate: candidatePath,
    ledger: ledgerPath,
    out: join(dir, 'cache/pr-7.json'),
  };
}

describe('cache-commit', () => {
  it('merges candidate + ledger, candidate winning every collision', () => {
    const argv = seed(
      {
        v: 1,
        target: 'pr-7',
        lastCommitSha: 'real-sha',
        lastModelId: 'm1',
        fileVerdicts: { 'a.ts': { base: 'b', head: 'h' } },
      },
      {
        // The bare token an orchestrator could type. The candidate's
        // provider-qualified one must win it, like every other anchor field.
        lastModelId: 'bare-name',
        round: 2,
        verdict: 'Approve',
        findings: [],
        findingsCount: 0,
        lastCommitSha: 'forged-sha', // the collision that must lose
      },
    );
    run(argv);
    const cache = JSON.parse(readFileSync(argv['out'], 'utf8')) as Record<
      string,
      unknown
    >;
    expect(cache['lastCommitSha']).toBe('real-sha');
    // The candidate's, not the bare token the ledger carried.
    expect(cache['lastModelId']).toBe('m1');
    expect(cache['round']).toBe(2);
    expect(cache['fileVerdicts']).toEqual({ 'a.ts': { base: 'b', head: 'h' } });
    expect(typeof cache['lastReviewDate']).toBe('string');
  });

  it('carries `source` across the promotion, so a file review keeps its anchor', () => {
    // `safeTarget` is not injective, so the next round's anchor gate compares
    // the SOURCE path rather than the token — and this allowlist is what
    // decides whether it survives. Dropped, every file-path review lost its
    // anchor permanently: the promoted cache carried no `source`, the gate
    // refused it as "an unrecorded path", and every later round degraded to a
    // full review. The hand-merge this command replaced spread the whole
    // candidate, so the mechanical allowlist is precisely what lost it.
    const argv = seed(
      {
        v: 1,
        target: 'src_foo.ts',
        source: 'src/foo.ts',
        headSha: 'h',
        files: {},
        stateId: 's',
      },
      { round: 1, verdict: 'Comment', findings: [] },
    );
    argv['out'] = join(dir, 'cache/src_foo.ts.json');
    run(argv);
    const cache = JSON.parse(readFileSync(argv['out'], 'utf8')) as Record<
      string,
      unknown
    >;
    expect(cache['source']).toBe('src/foo.ts');
  });

  it('refuses the whole class — C1, Cf and the line separators', () => {
    // The intake sweep and `inertText` share one class now, because two
    // sweeps of the same idea drifted twice: a value that passes here is
    // persisted raw at a deterministic in-repo path AND printed back through
    // that escaper on a refusal, so a gap in either is a forged line.
    for (const bad of ['\u2028', '\u202e', '\u200b']) {
      const argv = seed(
        { v: 1, target: 'pr-7', lastModelId: `m${bad}x` },
        { round: 1 },
      );
      expect(() => run(argv)).toThrow(/carries control/);
      expect(existsSync(argv['out'])).toBe(false);
    }
  });

  it('refuses C1 control characters, not just C0 and DEL', () => {
    // The cache sits at a deterministic in-repo path this command's own
    // threat model calls tamperable, and the next round prints these values
    // on a refusal through escapers that share a C0-only blind spot — so
    // U+009B (8-bit CSI) reaches the operator's terminal intact.
    const argv = seed(
      { v: 1, target: 'pr-7', lastModelId: 'm\u009b[31m' },
      { round: 1 },
    );
    expect(() => run(argv)).toThrow(/carries control/);
    expect(existsSync(argv['out'])).toBe(false);
  });

  it('refuses a CANDIDATE without lastModelId — the capture records who certified', () => {
    // Not the ledger: a ledger value is one the orchestrator typed, and the
    // only token it can type is the bare `{{model}}`, which two providers
    // exposing one model name share.
    const argv = seed({ v: 1, target: 'pr-7', lastModelId: '' }, { round: 1 });
    expect(() => run(argv)).toThrow(/lastModelId/);
    expect(existsSync(argv['out'])).toBe(false);
  });

  it('refuses unreadable or non-object inputs by name', () => {
    const argv = seed({ v: 1 }, { lastModelId: 'm' });
    writeFileSync(argv['candidate'], '[1,2]');
    expect(() => run(argv)).toThrow(/not a JSON object/);
    expect(() =>
      run({ ...argv, candidate: join(dir, 'missing.json') }),
    ).toThrow(/cannot read the cache candidate/);
  });

  it('works for a LOCAL candidate too — the merge is shape-agnostic', () => {
    const argv = seed(
      {
        v: 1,
        target: 'local',
        headSha: 'h',
        files: { 'a.ts': 'x' },
        stateId: 's',
      },
      { round: 1, verdict: 'Comment', findings: [] },
    );
    argv['out'] = join(dir, 'cache/local.json');
    run(argv);
    const cache = JSON.parse(readFileSync(argv['out'], 'utf8')) as Record<
      string,
      unknown
    >;
    expect(cache['stateId']).toBe('s');
    expect(cache['lastModelId']).toBe('candidate-model@aaaaaaaa');
  });

  it('refuses a candidate whose target does not match --out', () => {
    // pr-7's candidate committed to pr-8.json erases pr-8's ledger under
    // pr-7's anchor.
    const argv = seed(
      { v: 1, target: 'pr-7' },
      { lastModelId: 'm1', round: 1 },
    );
    expect(() => run({ ...argv, out: join(dir, 'cache/pr-8.json') })).toThrow(
      /refusing to promote across targets/,
    );
  });

  it('a candidate cannot smuggle ledger-owned fields, and a ledger cannot backdate the stamp', () => {
    const argv = seed(
      {
        v: 1,
        target: 'pr-7',
        lastCommitSha: 'real-sha',
        // Tampered candidate keys OUTSIDE the anchor allowlist: must be
        // ignored, or a wrong candidate erases unresolved review state.
        round: 99,
        verdict: 'Approve',
        findings: [],
        lastModelId: 'candidate-model@aaaaaaaa',
      },
      {
        lastModelId: 'm1',
        round: 2,
        verdict: 'Request changes',
        findings: [{ id: 'R1-1' }],
        lastReviewDate: '1999-01-01T00:00:00Z', // must not survive
      },
    );
    run(argv);
    const cache = JSON.parse(readFileSync(argv['out'], 'utf8')) as Record<
      string,
      unknown
    >;
    expect(cache['round']).toBe(2);
    expect(cache['verdict']).toBe('Request changes');
    expect(cache['findings']).toEqual([{ id: 'R1-1' }]);
    expect(cache['lastModelId']).toBe('candidate-model@aaaaaaaa');
    expect(cache['lastCommitSha']).toBe('real-sha');
    expect(cache['lastReviewDate']).not.toBe('1999-01-01T00:00:00Z');
  });

  it('an allowlist key present only in the LEDGER is scrubbed from the merge', () => {
    // The delete branch: a ledger smuggling `fileVerdicts` (an anchor field
    // the candidate does not carry) must not have it survive into the cache.
    const argv = seed(
      { v: 1, target: 'pr-7' },
      {
        lastModelId: 'm1',
        round: 1,
        fileVerdicts: { 'a.ts': { base: 'x', head: 'y' } },
      },
    );
    run(argv);
    const cache = JSON.parse(readFileSync(argv['out'], 'utf8')) as Record<
      string,
      unknown
    >;
    expect('fileVerdicts' in cache).toBe(false);
  });

  it('every candidate-owned anchor field survives the merge intact', () => {
    const argv = seed(
      {
        v: 1,
        target: 'local',
        headSha: 'h1',
        files: { 'a.ts': '100644:x' },
        stateId: 's1',
      },
      { lastModelId: 'm1', round: 3, verdict: 'Approve', findings: [] },
    );
    argv['out'] = join(dir, 'cache/local.json');
    run(argv);
    const cache = JSON.parse(readFileSync(argv['out'], 'utf8')) as Record<
      string,
      unknown
    >;
    expect(cache['v']).toBe(1);
    expect(cache['target']).toBe('local');
    expect(cache['headSha']).toBe('h1');
    expect(cache['files']).toEqual({ 'a.ts': '100644:x' });
    expect(cache['stateId']).toBe('s1');
  });

  it('a slashed target names the flattened-token contract in its refusal', () => {
    const argv = seed({ v: 1, target: 'src/foo.ts' }, { lastModelId: 'm1' });
    expect(() =>
      run({ ...argv, out: join(dir, 'cache/src_foo.ts.json') }),
    ).toThrow(/FLATTENED repo-relative path/);
  });

  it('refuses control characters in the candidate\u2019s model id and its scalar anchor fields', () => {
    // The command's stated posture: refuse at the writing end, where a human
    // is present, rather than escaping at every reader. Policing one field of
    // a tampered candidate is policing none — the next round hands
    // lastCommitSha to git as an argument.
    const esc = String.fromCharCode(0x1b);
    const bad1 = seed({ v: 1, target: 'pr-7', lastModelId: `m${esc}[31m` }, {});
    expect(() => run(bad1)).toThrow(/lastModelId. carries control/);
    expect(existsSync(bad1['out'])).toBe(false);
    const bad2 = seed(
      { v: 1, target: 'pr-7', lastCommitSha: `abc${esc}[2J` },
      {},
    );
    expect(() => run(bad2)).toThrow(/lastCommitSha. carries control/);
    expect(existsSync(bad2['out'])).toBe(false);
  });

  it('every refusal leaves NO cache file behind', () => {
    const argv = seed({ v: 1, target: 'pr-7' }, { lastModelId: 'm1' });
    expect(() => run({ ...argv, out: join(dir, 'cache/pr-8.json') })).toThrow();
    expect(existsSync(join(dir, 'cache/pr-8.json'))).toBe(false);
  });

  it('preserves an explicitly-null candidate field (unborn HEAD)', () => {
    const argv = seed(
      { v: 1, target: 'local', headSha: null, files: {}, stateId: 's' },
      { lastModelId: 'm1' },
    );
    argv['out'] = join(dir, 'cache/local.json');
    run(argv);
    const cache = JSON.parse(readFileSync(argv['out'], 'utf8')) as Record<
      string,
      unknown
    >;
    expect('headSha' in cache).toBe(true);
    expect(cache['headSha']).toBeNull();
  });

  it('carries mergeBaseSha and map-valued anchor fields through the merge', () => {
    const argv = seed(
      {
        v: 1,
        target: 'pr-7',
        lastCommitSha: 'head-sha',
        mergeBaseSha: 'base-sha',
        fileVerdicts: { 'a.ts': { base: '100644 b', head: '100644 h' } },
      },
      { lastModelId: 'm1', round: 1 },
    );
    run(argv);
    const cache = JSON.parse(readFileSync(argv['out'], 'utf8')) as Record<
      string,
      unknown
    >;
    expect(cache['mergeBaseSha']).toBe('base-sha');
    expect(cache['fileVerdicts']).toEqual({
      'a.ts': { base: '100644 b', head: '100644 h' },
    });
  });

  it.skipIf(process.platform === 'win32')(
    'replaces a planted symlink instead of writing through it',
    () => {
      // The cache path is deterministic and inside the repo: a contributor
      // branch can commit a symlink there, and a maintainer's review would
      // otherwise clobber the link's target with merged-cache JSON.
      const victim = join(dir, 'victim.txt');
      writeFileSync(victim, 'ORIGINAL');
      const argv = seed({ v: 1, target: 'pr-7' }, { lastModelId: 'm1' });
      mkdirSync(join(dir, 'cache'), { recursive: true });
      symlinkSync(victim, argv['out']);
      run(argv);
      expect(readFileSync(victim, 'utf8')).toBe('ORIGINAL');
      expect(lstatSync(argv['out']).isSymbolicLink()).toBe(false);
      expect(
        JSON.parse(readFileSync(argv['out'], 'utf8')) as Record<
          string,
          unknown
        >,
      ).toMatchObject({ target: 'pr-7' });
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses when a symlink sits at the cache DIRECTORY, not just the file',
    () => {
      // `noFollow` guards the final element only; planting the link one
      // layer up needs no guess at the file name (`local.json` is fixed)
      // and lands the merged cache in the attacker's directory.
      const elsewhere = join(dir, 'elsewhere');
      mkdirSync(elsewhere, { recursive: true });
      symlinkSync(elsewhere, join(dir, 'cache'));
      const argv = seed({ v: 1, target: 'pr-7' }, { lastModelId: 'm1' });
      expect(() => run(argv)).toThrow(/resolves to .* Refusing/s);
      expect(existsSync(join(elsewhere, 'pr-7.json'))).toBe(false);
    },
  );

  it('refuses an EMPTY lastModelId, not just a missing one', () => {
    const argv = seed({ v: 1, target: 'pr-7', lastModelId: '' }, {});
    expect(() => run(argv)).toThrow(/lastModelId/);
    expect(existsSync(argv['out'])).toBe(false);
  });

  it('carries a candidate field nobody enumerated — the recurring bug', () => {
    // Three fields were forgotten from the old allowlist in three rounds —
    // `lastModelId`, `source`, `untracked` — each silently: the promoted
    // cache simply lacked it, the gate that read it saw `undefined` and fell
    // open. The rule is inverted now, so a field the capture invents travels
    // without anyone editing this command.
    const argv = seed(
      {
        v: 1,
        target: 'pr-7',
        lastModelId: 'm@1',
        untracked: true,
        somethingNewNobodyListed: 'x',
      },
      { round: 1 },
    );
    run(argv);
    const cache = JSON.parse(readFileSync(argv['out'], 'utf8')) as Record<
      string,
      unknown
    >;
    expect(cache['untracked']).toBe(true);
    expect(cache['somethingNewNobodyListed']).toBe('x');
  });

  it('drops a ledger key outside the contract, anchor-shaped or not', () => {
    // The ledger contributes only the names it owns. An anchor name this
    // candidate does not carry is neither a ledger field nor a candidate key,
    // so spreading the ledger whole would have let it write anchor state.
    const argv = seed(
      { v: 1, target: 'pr-7', lastModelId: 'm@1' },
      { round: 1, fileVerdicts: { 'a.ts': { base: 'x', head: 'y' } }, junk: 1 },
    );
    run(argv);
    const cache = JSON.parse(readFileSync(argv['out'], 'utf8')) as Record<
      string,
      unknown
    >;
    expect('fileVerdicts' in cache).toBe(false);
    expect('junk' in cache).toBe(false);
    expect(cache['round']).toBe(1);
  });

  it('sweeps the verdicts map — keys and nested values — not just top-level scalars', () => {
    // The map's keys are file paths, and git permits almost any byte in one;
    // a tampered candidate at the deterministic in-repo path is the threat
    // the sweep exists for, and its map is where the strings are.
    const csi = '\u009b';
    const byKey = seed(
      {
        v: 1,
        target: 'pr-7',
        fileVerdicts: { [`a${csi}.ts`]: { base: 'b', head: 'h' } },
      },
      { round: 1 },
    );
    expect(() => run(byKey)).toThrow(/carries control/);
    expect(existsSync(byKey['out'])).toBe(false);
    const byValue = seed(
      {
        v: 1,
        target: 'pr-7',
        fileVerdicts: { 'a.ts': { base: `b${csi}`, head: 'h' } },
      },
      { round: 1 },
    );
    expect(() => run(byValue)).toThrow(/carries control/);
    expect(existsSync(byValue['out'])).toBe(false);
  });

  it('sweeps the LEDGER strings that survive the merge', () => {
    // The ledger half is model prose, persisted at the same path and read
    // back by the same readers; the sweep runs over what is persisted, so it
    // cannot be scoped to one side by accident.
    const verdict = seed(
      { v: 1, target: 'pr-7' },
      { round: 1, verdict: 'Approve\u2028Committed', findings: [] },
    );
    expect(() => run(verdict)).toThrow(/carries control/);
    expect(existsSync(verdict['out'])).toBe(false);
    const nested = seed(
      { v: 1, target: 'pr-7' },
      { round: 1, findings: [{ id: 'R1-1', title: 'x\u202ey' }] },
    );
    expect(() => run(nested)).toThrow(/cache\.findings\[0\]\.title/);
    expect(existsSync(nested['out'])).toBe(false);
  });

  it('a control-charactered KEY is refused, and the refusal does not echo the raw byte', () => {
    const esc = String.fromCharCode(0x1b);
    const argv = seed(
      { v: 1, target: 'pr-7', [`evil${esc}key`]: 'clean' },
      { round: 1 },
    );
    let message = '';
    try {
      run(argv);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/carries control/);
    expect(message).not.toContain(esc);
    expect(existsSync(argv['out'])).toBe(false);
  });

  it('prints the --out path inert on the success line', () => {
    // The one print site in a file that escapes every other untrusted
    // string: the path comes off the plan an orchestrator is told to use.
    const argv = seed({ v: 1, target: 'pr-7' }, { round: 1 });
    argv['out'] = join(dir, 'ca\u009bhe', 'pr-7.json');
    run(argv);
    const line = stdoutLines.find((l) =>
      l.startsWith('Committed review cache'),
    );
    expect(line).toBeDefined();
    expect(line).not.toContain('\u009b');
    expect(existsSync(argv['out'])).toBe(true);
  });

  it('refuses a candidate with NO lastModelId key at all — not only an empty one', () => {
    // `seed()` injects a default into every keyless fixture, so this one
    // writes the file itself: a hand-edited candidate, or one from a capture
    // that predates the field, must be refused rather than promoted with
    // the merge deleting the identity.
    const argv = seed({ v: 1, target: 'pr-7' }, { round: 1 });
    writeFileSync(argv['candidate'], JSON.stringify({ v: 1, target: 'pr-7' }));
    expect(() => run(argv)).toThrow(/lastModelId/);
    expect(existsSync(argv['out'])).toBe(false);
  });

  it('reads the model off the CANDIDATE, never the ledger', () => {
    // A weak candidate beside a ledger that carries the field: the bare
    // token an orchestrator could type must not stand in for the identity
    // the capture failed to record.
    const argv = seed(
      { v: 1, target: 'pr-7', lastModelId: '' },
      { lastModelId: 'm1', round: 1 },
    );
    expect(() => run(argv)).toThrow(/lastModelId/);
    expect(existsSync(argv['out'])).toBe(false);
  });

  it('refuses a JSON null or primitive on either side by name', () => {
    for (const raw of ['null', '42', '"str"']) {
      const candidate = seed({ v: 1, target: 'pr-7' }, { round: 1 });
      writeFileSync(candidate['candidate'], raw);
      expect(() => run(candidate)).toThrow(/not a JSON object/);
      const ledger = seed({ v: 1, target: 'pr-7' }, { round: 1 });
      writeFileSync(ledger['ledger'], raw);
      expect(() => run(ledger)).toThrow(/not a JSON object/);
    }
  });

  it('refuses to promote a file candidate into another source path\u2019s cache', () => {
    // `src/foo.ts` and `src_foo.ts` flatten to one token; the digest in the
    // file-form name is the only thing that tells the two caches apart.
    const argv = seed(
      {
        v: 1,
        target: 'src_foo.ts',
        source: 'src/foo.ts',
        headSha: 'h',
        files: {},
        stateId: 's',
      },
      { round: 1 },
    );
    argv['out'] = join(dir, 'cache/file-src_foo.ts-00000000.json');
    expect(() => run(argv)).toThrow(/different source path/);
    expect(existsSync(argv['out'])).toBe(false);
  });
});
