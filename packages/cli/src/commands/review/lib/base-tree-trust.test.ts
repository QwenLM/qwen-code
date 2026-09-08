/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The trust store is the fence's load-bearing half: if the nonce could be
// read or refreshed from inside the mount, or the recorded untracked set
// could be lost or rewritten, every base-tree test that exercises the fence
// would still pass while the property they exist for is gone.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import {
  baseTreeTrustPath,
  builtTreeRecord,
  recordBuiltTree,
  runNonce,
} from './base-tree-trust.js';

describe('base-tree trust store', () => {
  let repo: string;
  let worktree: string;
  let plan: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'qwen-base-tree-trust-'));
    worktree = join(repo, '.qwen', 'tmp', 'review-pr-1');
    mkdirSync(worktree, { recursive: true });
    // Production geometry: the plan lives INSIDE the mounted tmp dir.
    plan = join(repo, '.qwen', 'tmp', 'qwen-review-pr-1-fetch.json');
    writeFileSync(plan, '{}');
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('lives beside the leases — outside the mounted tmp dir — keyed by plan identity', () => {
    const p = baseTreeTrustPath(worktree, plan);
    expect(p.startsWith(join(repo, '.qwen', 'review-leases') + sep)).toBe(true);
    expect(p.startsWith(join(repo, '.qwen', 'tmp') + sep)).toBe(false);
    // Same plan, same identity: stable within a run.
    expect(baseTreeTrustPath(worktree, plan)).toBe(p);
    // A re-captured plan — a new run — keys a new file.
    const later = new Date(Date.now() + 60_000);
    utimesSync(plan, later, later);
    expect(baseTreeTrustPath(worktree, plan)).not.toBe(p);
  });

  it('creates the run secret once and hands every later asker the same one', () => {
    const p = baseTreeTrustPath(worktree, plan);
    const first = runNonce(p);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(runNonce(p)).toBe(first);
    // A different run (a re-captured plan) gets a different secret.
    const later = new Date(Date.now() + 60_000);
    utimesSync(plan, later, later);
    expect(runNonce(baseTreeTrustPath(worktree, plan))).not.toBe(first);
  });

  it('heals a torn file a crashed writer left instead of wedging the run', () => {
    const p = baseTreeTrustPath(worktree, plan);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, ''); // open()ed, never written: the crash window
    const nonce = runNonce(p);
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.parse(readFileSync(p, 'utf8')).nonce).toBe(nonce);
  }, 10_000);

  it('records the untracked set per tree and preserves the nonce across records', () => {
    const p = baseTreeTrustPath(worktree, plan);
    const nonce = runNonce(p);
    const tree = `${worktree}-base`;
    expect(builtTreeRecord(p, tree)).toBeNull();

    recordBuiltTree(p, tree, 'a'.repeat(40), ['.qwen-review-base-ok', 'dist/']);
    expect(builtTreeRecord(p, tree)).toEqual({
      baseSha: 'a'.repeat(40),
      untracked: ['.qwen-review-base-ok', 'dist/'],
    });
    expect(JSON.parse(readFileSync(p, 'utf8')).nonce).toBe(nonce);

    // A second record for another tree keeps the first.
    recordBuiltTree(p, `${tree}-2`, 'b'.repeat(40), []);
    expect(builtTreeRecord(p, tree)?.baseSha).toBe('a'.repeat(40));
    expect(builtTreeRecord(p, `${tree}-2`)?.baseSha).toBe('b'.repeat(40));
  });

  it('records nothing when the trust file is unreadable — never clobbers the nonce', () => {
    const p = baseTreeTrustPath(worktree, plan);
    recordBuiltTree(p, `${worktree}-base`, 'a'.repeat(40), []);
    expect(existsSync(p)).toBe(false);
    expect(builtTreeRecord(p, `${worktree}-base`)).toBeNull();
  });
});
