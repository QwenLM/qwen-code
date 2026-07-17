/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal, canonicalHash } from './journal.js';

async function tmpRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'wf-journal-'));
}

describe('canonicalHash', () => {
  it('is stable across key order', () => {
    expect(canonicalHash({ a: 1, b: 2 })).toBe(canonicalHash({ b: 2, a: 1 }));
    expect(canonicalHash({ a: 1 })).not.toBe(canonicalHash({ a: 2 }));
  });
});

describe('Journal', () => {
  it('assigns seq synchronously and persists records + run.json', async () => {
    const root = await tmpRoot();
    const dir = join(root, 'run-1');
    const j = await Journal.open(dir, {
      meta: { name: 'x' },
      scriptHash: 'h',
      args: null,
    });
    expect(j.nextSeq()).toBe(0);
    expect(j.nextSeq()).toBe(1);
    await j.append({
      seq: 0,
      kind: 'agent',
      promptHash: 'p0',
      optsHash: 'o0',
      result: { kind: 'text', text: 'a' },
      tokens: 5,
    });
    await j.setStatus('completed', 5);
    const run = JSON.parse(await readFile(join(dir, 'run.json'), 'utf8'));
    expect(run.status).toBe('completed');
    expect(run.scriptHash).toBe('h');
    const jl = await readFile(join(dir, 'journal.jsonl'), 'utf8');
    expect(jl.trim().split('\n')).toHaveLength(1);
  });

  it('replays the matching prefix and latches divergence', async () => {
    const root = await tmpRoot();
    const dir1 = join(root, 'run-1');
    const j1 = await Journal.open(dir1, {
      meta: {},
      scriptHash: 'h',
      args: null,
    });
    for (let seq = 0; seq < 3; seq++) {
      expect(j1.nextSeq()).toBe(seq);
      await j1.append({
        seq,
        kind: 'agent',
        promptHash: `p${seq}`,
        optsHash: 'o',
        result: { kind: 'text', text: `r${seq}` },
        tokens: 1,
      });
    }
    await j1.setStatus('completed', 3);

    // Resume: first two match, third diverges (different prompt), latch holds.
    const dir2 = join(root, 'run-2');
    const j2 = await Journal.open(dir2, {
      meta: {},
      scriptHash: 'h',
      args: null,
      resumeDir: dir1,
    });
    expect(j2.lookup(j2.nextSeq(), 'agent', 'p0', 'o')?.result).toEqual({
      kind: 'text',
      text: 'r0',
    });
    expect(j2.lookup(j2.nextSeq(), 'agent', 'p1', 'o')?.result).toEqual({
      kind: 'text',
      text: 'r1',
    });
    // Divergence at seq 2.
    expect(j2.lookup(j2.nextSeq(), 'agent', 'CHANGED', 'o')).toBeUndefined();
    // Even a later coincidental match returns undefined (latch).
    expect(j2.lookup(j2.nextSeq(), 'agent', 'p3', 'o')).toBeUndefined();
  });

  it('latches divergence so a genuinely-matching later lookup is still blocked', async () => {
    // This is a REAL latch test: run 1 journals seqs 0,1,2. In run 2, we
    // diverge at seq 0 (mismatched hashes), then look up seq 1 with hashes
    // that DO match the original journaled record. A latch-less
    // implementation (one that only checks per-seq hash equality without
    // ever consulting a "diverged" flag) would incorrectly return the
    // cached record for seq 1, since seq 1's hashes genuinely match.
    const root = await tmpRoot();
    const dir1 = join(root, 'run-1');
    const j1 = await Journal.open(dir1, {
      meta: {},
      scriptHash: 'h',
      args: null,
    });
    for (let seq = 0; seq < 3; seq++) {
      expect(j1.nextSeq()).toBe(seq);
      await j1.append({
        seq,
        kind: 'agent',
        promptHash: `p${seq}`,
        optsHash: 'o',
        result: { kind: 'text', text: `r${seq}` },
        tokens: 1,
      });
    }
    await j1.setStatus('completed', 3);

    const dir2 = join(root, 'run-2');
    const j2 = await Journal.open(dir2, {
      meta: {},
      scriptHash: 'h',
      args: null,
      resumeDir: dir1,
    });
    // Diverge immediately at seq 0: hashes do NOT match the journaled p0/o.
    expect(j2.lookup(j2.nextSeq(), 'agent', 'DIFFERENT', 'o')).toBeUndefined();
    // seq 1's hashes genuinely match what run 1 journaled ('p1', 'o'), but
    // the latch from the seq-0 divergence must still block it.
    expect(j2.lookup(j2.nextSeq(), 'agent', 'p1', 'o')).toBeUndefined();
  });

  it('recovers a valid prefix when the journal file has a torn final line', async () => {
    // Simulates a mid-write crash: a valid prefix of complete JSONL records
    // followed by a truncated/torn final line. Resume should still cache
    // and serve every complete record before the tear.
    const root = await tmpRoot();
    const dir1 = join(root, 'run-1');
    const j1 = await Journal.open(dir1, {
      meta: {},
      scriptHash: 'h',
      args: null,
    });
    for (let seq = 0; seq < 2; seq++) {
      expect(j1.nextSeq()).toBe(seq);
      await j1.append({
        seq,
        kind: 'agent',
        promptHash: `p${seq}`,
        optsHash: 'o',
        result: { kind: 'text', text: `r${seq}` },
        tokens: 1,
      });
    }
    // Simulate a crash mid-write: append a torn (truncated, non-JSON) final
    // line with no trailing newline.
    await appendFile(
      join(dir1, 'journal.jsonl'),
      '{"seq":2,"kind":"agent","promptHash":"p2","optsH',
    );

    const dir2 = join(root, 'run-2');
    const j2 = await Journal.open(dir2, {
      meta: {},
      scriptHash: 'h',
      args: null,
      resumeDir: dir1,
    });
    // Both records preceding the tear were parsed and cached before the
    // torn line threw, so they're still replayable.
    expect(j2.lookup(j2.nextSeq(), 'agent', 'p0', 'o')?.result).toEqual({
      kind: 'text',
      text: 'r0',
    });
    expect(j2.lookup(j2.nextSeq(), 'agent', 'p1', 'o')?.result).toEqual({
      kind: 'text',
      text: 'r1',
    });
  });
});
