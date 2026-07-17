/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
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
});
