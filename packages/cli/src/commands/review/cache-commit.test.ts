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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  symlinkSync,
  lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheCommitCommand } from './cache-commit.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cache-commit-'));
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
  writeFileSync(candidatePath, JSON.stringify(candidate));
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
        fileVerdicts: { 'a.ts': { base: 'b', head: 'h' } },
      },
      {
        lastModelId: 'm1',
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
    expect(cache['lastModelId']).toBe('m1');
    expect(cache['round']).toBe(2);
    expect(cache['fileVerdicts']).toEqual({ 'a.ts': { base: 'b', head: 'h' } });
    expect(typeof cache['lastReviewDate']).toBe('string');
  });

  it('refuses a ledger without lastModelId — the same-model contract needs one', () => {
    const argv = seed({ v: 1, target: 'pr-7' }, { round: 1 });
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
      { lastModelId: 'm1', round: 1, verdict: 'Comment', findings: [] },
    );
    argv['out'] = join(dir, 'cache/local.json');
    run(argv);
    const cache = JSON.parse(readFileSync(argv['out'], 'utf8')) as Record<
      string,
      unknown
    >;
    expect(cache['stateId']).toBe('s');
    expect(cache['lastModelId']).toBe('m1');
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
        lastModelId: 'candidate-model',
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
    expect(cache['lastModelId']).toBe('m1');
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

  it('refuses control characters in the ledger model AND in any candidate anchor field', () => {
    // The command's stated posture: refuse at the writing end, where a human
    // is present, rather than escaping at every reader. Policing one field of
    // a tampered candidate is policing none — the next round hands
    // lastCommitSha to git as an argument.
    const esc = String.fromCharCode(0x1b);
    const bad1 = seed({ v: 1, target: 'pr-7' }, { lastModelId: `m${esc}[31m` });
    expect(() => run(bad1)).toThrow(/lastModelId. carries control/);
    expect(existsSync(bad1['out'])).toBe(false);
    const bad2 = seed(
      { v: 1, target: 'pr-7', lastCommitSha: `abc${esc}[2J` },
      { lastModelId: 'm1' },
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
    const argv = seed({ v: 1, target: 'pr-7' }, { lastModelId: '' });
    expect(() => run(argv)).toThrow(/lastModelId/);
  });
});
