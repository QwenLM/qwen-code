/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The pure halves of the local anchor. The cache is model-written prose-gated
// JSON, so `readLocalCache` is an untrusted-input boundary (malformed → null,
// never a throw and never a skip), and the byte slicer is pinned against the
// re-encode hazard: it must reproduce the exact bytes of the sections it keeps.

import { describe, it, expect } from 'vitest';
import {
  ABSENT,
  changedSince,
  readLocalCache,
  sliceDiffByLines,
  stateIdOf,
} from './local-anchor.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('stateIdOf', () => {
  it('is order-independent over files and sensitive to every field', () => {
    const a = stateIdOf('head1', { 'a.ts': 'h1', 'b.ts': 'h2' });
    expect(stateIdOf('head1', { 'b.ts': 'h2', 'a.ts': 'h1' })).toBe(a);
    expect(stateIdOf('head2', { 'a.ts': 'h1', 'b.ts': 'h2' })).not.toBe(a);
    expect(stateIdOf('head1', { 'a.ts': 'hX', 'b.ts': 'h2' })).not.toBe(a);
    expect(stateIdOf(null, { 'a.ts': 'h1', 'b.ts': 'h2' })).not.toBe(a);
  });

  it('field separators prevent adjacency collisions', () => {
    expect(stateIdOf('h', { ab: 'c' })).not.toBe(stateIdOf('h', { a: 'bc' }));
  });
});

describe('changedSince', () => {
  it('reports modified, added, and removed paths — nothing else', () => {
    const changed = changedSince(
      { 'same.ts': 'h1', 'mod.ts': 'h2', 'gone.ts': 'h3' },
      { 'same.ts': 'h1', 'mod.ts': 'hX', 'new.ts': 'h4' },
    );
    expect(changed.sort()).toEqual(['gone.ts', 'mod.ts', 'new.ts']);
  });

  it('a deletion recorded as absent matches an absent deletion', () => {
    expect(changedSince({ 'del.ts': ABSENT }, { 'del.ts': ABSENT })).toEqual(
      [],
    );
  });
});

describe('readLocalCache', () => {
  const write = (content: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'local-anchor-'));
    const p = join(dir, 'cache.json');
    writeFileSync(p, content);
    return p;
  };

  it('round-trips a valid cache, optional lastModelId included', () => {
    const cache = {
      v: 1,
      target: 'local',
      headSha: 'abc',
      files: { 'a.ts': 'h1' },
      stateId: 's1',
      lastModelId: 'm1',
      round: 2, // model-written extras must not fail validation
    };
    const p = write(JSON.stringify(cache));
    const parsed = readLocalCache(p)!;
    expect(parsed.files).toEqual({ 'a.ts': 'h1' });
    expect(parsed.lastModelId).toBe('m1');
    expect(parsed.headSha).toBe('abc');
    rmSync(join(p, '..'), { recursive: true, force: true });
  });

  it('null on every malformation — absent file, bad JSON, wrong shapes', () => {
    expect(readLocalCache('/no/such/file.json')).toBeNull();
    for (const bad of [
      'not json',
      JSON.stringify({
        v: 2,
        target: 't',
        headSha: null,
        files: {},
        stateId: 's',
      }),
      JSON.stringify({ v: 1, headSha: null, files: {}, stateId: 's' }),
      JSON.stringify({
        v: 1,
        target: 't',
        headSha: 5,
        files: {},
        stateId: 's',
      }),
      JSON.stringify({
        v: 1,
        target: 't',
        headSha: null,
        files: { a: 5 },
        stateId: 's',
      }),
      JSON.stringify({
        v: 1,
        target: 't',
        headSha: null,
        files: null,
        stateId: 's',
      }),
    ]) {
      const p = write(bad);
      expect(readLocalCache(p)).toBeNull();
      rmSync(join(p, '..'), { recursive: true, force: true });
    }
  });
});

describe('sliceDiffByLines', () => {
  it('keeps exact bytes of the kept ranges, in line order', () => {
    const diff = Buffer.from('l1\nl2\nl3\nl4\nl5\n', 'utf8');
    const out = sliceDiffByLines(diff, [
      { startLine: 4, endLine: 5 },
      { startLine: 1, endLine: 2 },
    ]);
    expect(out.toString('utf8')).toBe('l1\nl2\nl4\nl5\n');
  });

  it('does not re-encode: non-UTF-8 bytes survive verbatim', () => {
    // 0x80 alone is invalid UTF-8; a decode/re-encode would replace it.
    const diff = Buffer.concat([
      Buffer.from('keep '),
      Buffer.from([0x80, 0x81]),
      Buffer.from('\ndrop\n'),
    ]);
    const out = sliceDiffByLines(diff, [{ startLine: 1, endLine: 1 }]);
    expect([...out.subarray(5, 7)]).toEqual([0x80, 0x81]);
    expect(out.toString('latin1')).not.toContain('drop');
  });

  it('a range past the last line clamps to the buffer end', () => {
    const diff = Buffer.from('a\nb', 'utf8'); // no trailing newline
    expect(
      sliceDiffByLines(diff, [{ startLine: 2, endLine: 9 }]).toString('utf8'),
    ).toBe('b');
  });
});
