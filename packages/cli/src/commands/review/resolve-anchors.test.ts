/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAnchorsCommand, validateRequests } from './resolve-anchors.js';

const ok = { id: 'f1', path: 'src/a.ts', anchor: 'const x = 1;' };

describe('validateRequests', () => {
  it('accepts a well-formed batch and keeps an optional claimed line', () => {
    expect(validateRequests([ok, { ...ok, id: 'f2', line: 7 }])).toEqual([
      { id: 'f1', path: 'src/a.ts', anchor: 'const x = 1;' },
      { id: 'f2', path: 'src/a.ts', anchor: 'const x = 1;', line: 7 },
    ]);
  });

  it('rejects duplicate ids rather than resolving them into a wrong answer', () => {
    // The report splits into `resolved` and `unmatched`, so the caller cannot
    // re-join by position — it joins by id. Two findings sharing an id means one
    // of them gets the other's line, and a comment lands on code it is not
    // about. That failure is silent and looks exactly like success, so the
    // duplicate is refused at the door.
    expect(() => validateRequests([ok, { ...ok, anchor: 'other();' }])).toThrow(
      /Duplicate finding id\(s\): f1/,
    );
  });

  it('rejects a missing or empty anchor', () => {
    expect(() => validateRequests([{ id: 'f1', path: 'src/a.ts' }])).toThrow(
      /"anchor"/,
    );
    expect(() => validateRequests([{ ...ok, anchor: '' }])).toThrow(/"anchor"/);
  });

  it.each(['42', -1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an invalid claimed line %s',
    (line) => {
      // The same rule the `findings` validator applies: the two validators in
      // one pipeline must agree, so an entry that passes here cannot hard-fail
      // there.
      expect(() => validateRequests([{ ...ok, line }])).toThrow(
        /invalid "line"/,
      );
    },
  );

  it('names the offending index for a null element instead of crashing', () => {
    // `typeof null === 'object'`, so indexing it threw a bare TypeError that said
    // nothing about which entry was wrong — while every other malformed input got
    // a message naming the index and the field.
    expect(() => validateRequests([ok, null])).toThrow(/index 1 is null/);
    expect(() => validateRequests([['a']])).toThrow(/not an object/);
  });

  it('rejects input that is not an array', () => {
    expect(() => validateRequests({ id: 'f1' })).toThrow(/JSON array/);
  });
});

// The matching library is unit-tested to death, and none of it reaches Step 7
// unless this command's JSON boundary — validation, the resolved/unmatched
// partition, the stats, the serialized shape — holds. A regression there breaks
// posting while every `anchors.ts` test stays green.
describe('resolve-anchors (command boundary)', () => {
  let dir: string;
  const DIFF = [
    'diff --git a/src/pay.ts b/src/pay.ts',
    '--- a/src/pay.ts',
    '+++ b/src/pay.ts',
    '@@ -10,1 +10,4 @@',
    ' function pay(amt) {',
    '+  if (amt < 0) return;',
    '+  charge(amt);',
    '+  log("alpha bravo charlie delta echo foxtrot golf hotel india juliet");',
    '',
  ].join('\n');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'resolve-anchors-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Drive the real yargs handler, as `qwen review resolve-anchors` does. */
  function run(findings: unknown): Record<string, unknown> {
    const diff = join(dir, 'diff.txt');
    const input = join(dir, 'in.json');
    const out = join(dir, 'out.json');
    writeFileSync(diff, DIFF);
    writeFileSync(input, JSON.stringify(findings));
    (resolveAnchorsCommand.handler as (a: unknown) => void)({
      diff,
      input,
      out,
    });
    return JSON.parse(readFileSync(out, 'utf8'));
  }

  /** Drive the real handler and return the report plus everything on stderr. */
  function runWithStderr(findings: unknown): {
    report: Record<string, unknown>;
    stderr: string;
  } {
    let stderr = '';
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        stderr +=
          typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
        return true;
      });
    try {
      return { report: run(findings), stderr };
    } finally {
      spy.mockRestore();
    }
  }

  it('partitions resolved and unmatched, and reports honest stats', () => {
    const { report: raw, stderr } = runWithStderr([
      // resolves, and corrects a miscounted line
      { id: 'a', path: 'src/pay.ts', anchor: '  charge(amt);', line: 99 },
      // multi-line, counted correctly
      {
        id: 'b',
        path: 'src/pay.ts',
        anchor: '  if (amt < 0) return;\n  charge(amt);',
        line: 11,
      },
      // the file is not in the diff at all
      { id: 'c', path: 'src/ghost.ts', anchor: 'nope();' },
      // a mid-line fragment of the long added line — the substring tier
      { id: 'd', path: 'src/pay.ts', anchor: 'golf hotel india' },
    ]);
    const report = raw as {
      resolved: Array<Record<string, unknown>>;
      unmatched: Array<Record<string, unknown>>;
      stats: Record<string, number>;
    };

    expect(report.resolved.map((r) => r['id'])).toEqual(['a', 'b', 'd']);
    expect(report.resolved[0]).toMatchObject({
      line: 12,
      claimedLine: 99,
      drift: 87,
    });
    expect(report.resolved[1]).toMatchObject({ startLine: 11, line: 12 });
    expect(report.resolved[2]).toMatchObject({
      line: 13,
      tier: 'substring-added',
    });
    expect(report.unmatched.map((r) => r['id'])).toEqual(['c']);
    expect(report.stats).toMatchObject({
      total: 4,
      resolved: 3,
      unmatched: 1,
      drifted: 1,
      substring: 1,
    });
    // The signal Step 7 reads to give fragment anchors a second look.
    expect(stderr).toContain('1 matched inside a longer hunk line');
  });

  it('fails loudly on malformed input rather than resolving part of it', () => {
    expect(() => run([{ id: 'a', path: 'src/pay.ts' }])).toThrow(/"anchor"/);
  });

  it('creates the output directory the caller chose', () => {
    // `mkdirSync` created `.qwen/tmp` — our directory — and then wrote to the
    // caller's, which may be somewhere else entirely. `--out reports/x.json` is
    // a legal request and it answered with ENOENT. The sibling `compose-review`
    // had it right all along; this one did not copy it.
    const diff = join(dir, 'diff.txt');
    const input = join(dir, 'in.json');
    const out = join(dir, 'nested', 'deeper', 'anchors.json');
    writeFileSync(diff, DIFF);
    writeFileSync(input, JSON.stringify([]));

    (resolveAnchorsCommand.handler as (a: unknown) => void)({
      diff,
      input,
      out,
    });

    expect(JSON.parse(readFileSync(out, 'utf8')).stats.total).toBe(0);
  });

  it('routes each finding to its own file in a multi-file diff', () => {
    // The batch is keyed by path, and every earlier test used a one-file diff —
    // so the routing itself (`byPath.get`) was never exercised against a second
    // real file. A bug that leaked lines across files would have passed.
    const twoFiles = [
      DIFF.trimEnd(),
      'diff --git a/src/other.ts b/src/other.ts',
      '--- a/src/other.ts',
      '+++ b/src/other.ts',
      '@@ -100,0 +100,2 @@',
      '+  const other = 1;',
      '+  useOther(other);',
      '',
    ].join('\n');
    const diff = join(dir, 'two.txt');
    const input = join(dir, 'in.json');
    const out = join(dir, 'out.json');
    writeFileSync(diff, twoFiles);
    writeFileSync(
      input,
      JSON.stringify([
        { id: 'a', path: 'src/pay.ts', anchor: '  charge(amt);' },
        { id: 'b', path: 'src/other.ts', anchor: '  useOther(other);' },
      ]),
    );

    (resolveAnchorsCommand.handler as (a: unknown) => void)({
      diff,
      input,
      out,
    });
    const report = JSON.parse(readFileSync(out, 'utf8'));

    // `pay.ts` line 12 and `other.ts` line 101 — neither file's numbering may
    // bleed into the other's.
    expect(
      report.resolved.map((r: { id: string; line: number }) => [r.id, r.line]),
    ).toEqual([
      ['a', 12],
      ['b', 101],
    ]);
    expect(report.unmatched).toEqual([]);
  });

  it('fails on a diff path that does not exist', () => {
    const input = join(dir, 'in.json');
    writeFileSync(input, '[]');
    expect(() =>
      (resolveAnchorsCommand.handler as (a: unknown) => void)({
        diff: join(dir, 'no-such.txt'),
        input,
        out: join(dir, 'out.json'),
      }),
    ).toThrow(/Cannot read diff file/);
  });
});
