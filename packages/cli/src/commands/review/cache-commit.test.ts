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

  it('refuses an EMPTY lastModelId, not just a missing one', () => {
    const argv = seed({ v: 1, target: 'pr-7' }, { lastModelId: '' });
    expect(() => run(argv)).toThrow(/lastModelId/);
  });
});
