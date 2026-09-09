/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The trust store is the fence's load-bearing half: the in-tree markers are
// informational now, so if the record could be forged from the mount, adopted
// across runs, or rotated away by a metadata touch, every base-tree test that
// exercises the fence would still pass while the property they exist for is
// gone.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import {
  baseTreeTrustPath,
  builtTreeRecord,
  establishTrust,
  recordBuiltTree,
  runIdentityMs,
} from './base-tree-trust.js';

describe('base-tree trust store', () => {
  let repo: string;
  let worktree: string;
  let plan: string;
  const SHA_A = 'a'.repeat(40);
  const SHA_B = 'b'.repeat(40);

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'qwen-base-tree-trust-'));
    worktree = join(repo, '.qwen', 'tmp', 'review-pr-1');
    mkdirSync(worktree, { recursive: true });
    // Production geometry: the plan lives INSIDE the mounted tmp dir.
    plan = join(repo, '.qwen', 'tmp', 'qwen-review-pr-1-fetch.json');
    writeFileSync(plan, '{}');
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  /** The lease fetch-pr holds for the whole review — outside the mount. */
  const writeLease = (): void => {
    const dir = join(repo, '.qwen', 'review-leases');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'qwen-review-lease-pr-1.json'),
      JSON.stringify({
        sessionId: 's',
        promptId: 'p',
        target: 'pr-1',
        repositoryRoot: repo,
        worktreePath: worktree,
        branch: 'qwen-review/pr-1',
      }),
    );
  };

  it('keys the trust file under the OUTERMOST repository in the nested geometry', () => {
    // A review launched from inside another review's worktree: the inner
    // review's own `.qwen` sits inside the OUTER review's read-write mount,
    // and a trust file there is the outer reviewed code's to read and
    // forge. The root is the outermost enclosing repository's — the same
    // path the lease module re-roots to — derived lexically, so no planted
    // pointer or link gets a say.
    const innerWt = join(
      repo,
      '.qwen',
      'tmp',
      'review-pr-9',
      '.qwen',
      'tmp',
      'review-pr-1',
    );
    mkdirSync(innerWt, { recursive: true });
    const p = baseTreeTrustPath(innerWt, plan);
    expect(p.startsWith(join(repo, '.qwen', 'review-leases') + sep)).toBe(true);
    expect(p).not.toContain(`${sep}tmp${sep}`);
  });

  it('finds the lease where the lease module re-rooted it in the nested geometry', () => {
    // The lease identity is the run identity only if the two modules agree
    // on WHERE the lease lives: `leaseDirectory` re-roots to the outermost
    // enclosing repository, and `runIdentityMs` must read exactly there.
    const innerWt = join(
      repo,
      '.qwen',
      'tmp',
      'review-pr-9',
      '.qwen',
      'tmp',
      'review-pr-1',
    );
    mkdirSync(innerWt, { recursive: true });
    const dir = join(repo, '.qwen', 'review-leases');
    mkdirSync(dir, { recursive: true });
    const leasePath = join(dir, 'qwen-review-lease-pr-1.json');
    writeFileSync(
      leasePath,
      JSON.stringify({
        sessionId: 's',
        promptId: 'p',
        target: 'pr-1',
        repositoryRoot: repo,
        worktreePath: resolve(innerWt),
        branch: 'qwen-review/pr-1',
      }),
    );
    expect(runIdentityMs(innerWt, plan)).toBe(statSync(leasePath).mtimeMs);
  });

  it('lives beside the leases — outside the mounted tmp dir — one file per plan', () => {
    const p = baseTreeTrustPath(worktree, plan);
    expect(p.startsWith(join(repo, '.qwen', 'review-leases') + sep)).toBe(true);
    expect(p.startsWith(join(repo, '.qwen', 'tmp') + sep)).toBe(false);
    // The name is the plan's PATH, never its stamps: a re-captured plan
    // rotates the file's CONTENT in place, so there is no earlier run's
    // sibling file left for a pinned timestamp to land on.
    expect(baseTreeTrustPath(worktree, plan)).toBe(p);
    const later = new Date(Date.now() + 60_000);
    utimesSync(plan, later, later);
    expect(baseTreeTrustPath(worktree, plan)).toBe(p);
  });

  it('refuses a worktree outside the <root>/.qwen/tmp/<name> geometry — and creates nothing for it', () => {
    // A hand-passed `--worktree /tmp/wt` walks two directories up from it and
    // would otherwise create the trust directory THERE — outside the
    // repository, where nothing ever sweeps it, before any gate has run.
    const orphan = join(repo, 'wt');
    mkdirSync(orphan);
    expect(() => baseTreeTrustPath(orphan, plan)).toThrow(/not shaped like/);
    expect(existsSync(join(repo, 'review-leases'))).toBe(false);
    expect(existsSync(join(repo, '.qwen', 'review-leases'))).toBe(false);
  });

  it('establishes once per run identity and hands every later asker the same state', () => {
    // The `wx`-then-adopt shape: two shards asking together agree on one
    // file, one pin, one generation.
    const p = baseTreeTrustPath(worktree, plan);
    const identity = runIdentityMs(worktree, plan);
    const first = establishTrust(p, identity, SHA_A);
    expect(first.established).toBe('created');
    const second = establishTrust(p, identity, SHA_A);
    expect(second.established).toBe('adopted');
    expect(second.nonce).toBe(first.nonce);
    expect(second.conflict).toBe(false);
  });

  it('pins the base the run first established with', () => {
    // The plan lives inside the mount, so a mid-run rewrite of mergeBaseSha
    // is how the reviewed code would choose the base every later A/B
    // certifies. The pin answers conflict; it never silently re-pins.
    const p = baseTreeTrustPath(worktree, plan);
    const identity = runIdentityMs(worktree, plan);
    establishTrust(p, identity, SHA_A);
    const moved = establishTrust(p, identity, SHA_B);
    expect(moved.established).toBe('adopted');
    expect(moved.conflict).toBe(true);
    expect(JSON.parse(readFileSync(p, 'utf8')).baseSha).toBe(SHA_A);
  });

  it('does NOT rotate when the plan is chmodded with its mtime unmoved', () => {
    // `chmod` moves ctime, not mtime — an identity that reads ctime forks the
    // run's shards across two states on a bare metadata touch (and the
    // pipeline's own epoch-preserving enrichment rewrites content while
    // restoring mtime). The mtime is the identity; the touch is a no-op.
    const p = baseTreeTrustPath(worktree, plan);
    const mtimeBefore = statSync(plan).mtimeMs;
    const ctimeBefore = statSync(plan).ctimeMs;
    const first = establishTrust(p, runIdentityMs(worktree, plan), SHA_A);
    // The kernel's coarse timestamp tick can swallow a chmod landing in the
    // same tick as the fixture's write, so chmod until the ctime OBSERVABLY
    // moves — without that control a green run may simply have seen no touch.
    // The mode alternates so no filesystem can skip a same-mode chmod.
    const deadline = Date.now() + 10_000;
    let mode = 0o400;
    while (statSync(plan).ctimeMs === ctimeBefore) {
      if (Date.now() >= deadline) {
        throw new Error(
          'the filesystem never moved ctime across 10 s of chmods — ' +
            'the touch discrimination this test pins is unobservable here',
        );
      }
      chmodSync(plan, mode);
      mode = mode === 0o400 ? 0o600 : 0o400;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    expect(statSync(plan).mtimeMs).toBe(mtimeBefore); // the control
    const second = establishTrust(p, runIdentityMs(worktree, plan), SHA_A);
    expect(second.established).toBe('adopted');
    expect(second.nonce).toBe(first.nonce);
  }, 15_000);

  it('rotates — dropping the records — when the plan is backdated to another value', () => {
    // One file per plan path is what makes this safe: a backdated mtime
    // cannot land this run on an earlier run's sibling file (there is none);
    // it only disagrees with THIS file's minted identity, and rotation
    // destroys rather than adopts.
    const p = baseTreeTrustPath(worktree, plan);
    const identity = runIdentityMs(worktree, plan);
    const first = establishTrust(p, identity, SHA_A);
    const tree = `${worktree}-base`;
    recordBuiltTree(p, identity, tree, {
      baseSha: SHA_A,
      state: 'ok',
      untracked: {},
    });
    expect(builtTreeRecord(p, tree)).not.toBeNull();
    const earlier = new Date(Date.now() - 3_600_000);
    utimesSync(plan, earlier, earlier);
    const rotated = establishTrust(p, runIdentityMs(worktree, plan), SHA_A);
    expect(rotated.established).toBe('rotated');
    expect(rotated.nonce).not.toBe(first.nonce);
    expect(builtTreeRecord(p, tree)).toBeNull();
  });

  it('never adopts across a re-acquisition, whatever the plan stamps say', () => {
    // The pin-the-timestamp attack: reviewed code forward-dates the plan; the
    // next run re-captures (a fresh lease acquisition, a fresh plan) and the
    // pin is re-applied before any shard asks. The plan's stamps are out of
    // the run identity — the lease is host-side — so the run rotates on the
    // LEASE's movement and nothing the pin shaped survives to be adopted.
    writeLease();
    const p = baseTreeTrustPath(worktree, plan);
    const tree = `${worktree}-base`;
    const leaseFile = join(
      repo,
      '.qwen',
      'review-leases',
      'qwen-review-lease-pr-1.json',
    );
    const leaseEpoch = new Date(Date.now() - 60_000);
    utimesSync(leaseFile, leaseEpoch, leaseEpoch);
    const future = new Date(Date.now() + 86_400_000);
    utimesSync(plan, future, future);
    const first = establishTrust(p, runIdentityMs(worktree, plan), SHA_A);
    recordBuiltTree(p, runIdentityMs(worktree, plan), tree, {
      baseSha: SHA_A,
      state: 'ok',
      untracked: {},
    });
    expect(builtTreeRecord(p, tree)).not.toBeNull();

    // The next run: fetch-pr re-acquires the lease (rewriting it) and
    // re-captures the plan; the reviewed code re-pins the same forward value.
    writeLease();
    const leaseNext = new Date(Date.now());
    utimesSync(leaseFile, leaseNext, leaseNext);
    writeFileSync(plan, '{}');
    utimesSync(plan, future, future);
    const second = establishTrust(p, runIdentityMs(worktree, plan), SHA_A);
    expect(second.established).toBe('rotated');
    expect(second.nonce).not.toBe(first.nonce);
    expect(builtTreeRecord(p, tree)).toBeNull();
  });

  it('keys the run on the worktree lease when one is held — a plan touch rotates nothing', () => {
    // fetch-pr holds the lease for the whole review, outside the mount, so
    // the plan's stamps leave the identity: a mid-run `utimes` by the
    // reviewed code can neither fork the run's shards nor orphan the tree a
    // sibling is mid-A/B in.
    writeLease();
    const p = baseTreeTrustPath(worktree, plan);
    const first = establishTrust(p, runIdentityMs(worktree, plan), SHA_A);
    const later = new Date(Date.now() + 60_000);
    utimesSync(plan, later, later);
    const second = establishTrust(p, runIdentityMs(worktree, plan), SHA_A);
    expect(second.established).toBe('adopted');
    expect(second.nonce).toBe(first.nonce);

    // The control, same plan and no matching lease (a different review
    // target): the plan's mtime is the fallback identity, and the touch is
    // indistinguishable from a re-capture there — rotation is the fallback's
    // honest answer.
    const other = join(repo, '.qwen', 'tmp', 'review-pr-2');
    mkdirSync(other, { recursive: true });
    const p2 = baseTreeTrustPath(other, plan);
    const first2 = establishTrust(p2, runIdentityMs(other, plan), SHA_A);
    const later2 = new Date(Date.now() + 120_000);
    utimesSync(plan, later2, later2);
    const second2 = establishTrust(p2, runIdentityMs(other, plan), SHA_A);
    expect(second2.established).toBe('rotated');
    expect(second2.nonce).not.toBe(first2.nonce);
  });

  it('heals a torn file a crashed writer left instead of wedging the run', () => {
    const p = baseTreeTrustPath(worktree, plan);
    const identity = runIdentityMs(worktree, plan);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, ''); // open()ed, never written: the crash window
    const state = establishTrust(p, identity, SHA_A);
    expect(state.established).toBe('healed');
    expect(state.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.parse(readFileSync(p, 'utf8')).nonce).toBe(state.nonce);
  }, 10_000);

  it('records what a build left, per tree, preserving the rest of the file', () => {
    const p = baseTreeTrustPath(worktree, plan);
    const identity = runIdentityMs(worktree, plan);
    const { nonce } = establishTrust(p, identity, SHA_A);
    const tree = `${worktree}-base`;
    expect(builtTreeRecord(p, tree)).toBeNull();

    const inventory = { 'dist/cli.js': { size: 10, ctimeMs: 1234 } };
    recordBuiltTree(p, identity, tree, {
      baseSha: SHA_A,
      state: 'ok',
      untracked: inventory,
    });
    expect(builtTreeRecord(p, tree)).toEqual({
      baseSha: SHA_A,
      state: 'ok',
      untracked: inventory,
    });
    expect(JSON.parse(readFileSync(p, 'utf8')).nonce).toBe(nonce);

    // A second record for another tree keeps the first, and a failed record
    // lands — the settled answer the fence re-serves without re-paying.
    recordBuiltTree(p, identity, `${tree}-2`, {
      baseSha: SHA_A,
      state: 'failed',
      untracked: {},
    });
    expect(builtTreeRecord(p, tree)?.state).toBe('ok');
    expect(builtTreeRecord(p, `${tree}-2`)?.state).toBe('failed');
  });

  it('records nothing across a missing file, an identity boundary, or a re-pinned base', () => {
    // No readable file → nothing to write into (a write could clobber state a
    // concurrent shard just established). A rotated-away identity or a
    // disagreeing base → the record belongs to a generation that is not this
    // file's, and writing it would certify across the boundary.
    const p = baseTreeTrustPath(worktree, plan);
    const identity = runIdentityMs(worktree, plan);
    const tree = `${worktree}-base`;
    recordBuiltTree(p, identity, tree, {
      baseSha: SHA_A,
      state: 'ok',
      untracked: {},
    });
    expect(existsSync(p)).toBe(false);

    establishTrust(p, identity, SHA_A);
    recordBuiltTree(p, identity + 60_000, tree, {
      baseSha: SHA_A,
      state: 'ok',
      untracked: {},
    });
    expect(builtTreeRecord(p, tree)).toBeNull();
    recordBuiltTree(p, identity, tree, {
      baseSha: SHA_B,
      state: 'ok',
      untracked: {},
    });
    expect(builtTreeRecord(p, tree)).toBeNull();
  });
});
