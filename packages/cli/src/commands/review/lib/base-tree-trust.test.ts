/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The trust store is the whole of the fence — the in-tree markers are gone —
// so if the record could be forged from the mount, adopted across runs, or
// rotated away by a metadata touch, every base-tree test that exercises the
// fence would still pass while the property they exist for is gone.
//
// The lease fixtures are written by the REAL `createReviewWorktreeLease`
// rather than by hand. The identity these two modules agree on is the thing
// under test, and a hand-written lease pins this module against a fiction of
// the other one — which is exactly how the mtime-based identity survived: the
// hand-built fixture used an integer millisecond, and the sub-millisecond
// drift that broke the real thing could not occur in it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  lstatSync,
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
  dropBuiltTree,
  establishTrust,
  recordBuiltTree,
  runIdentity,
} from './base-tree-trust.js';
import {
  createReviewWorktreeLease,
  recordReviewWorktreeLeaseMergeBase,
} from '../../../services/review-worktree-lease.js';

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

  /**
   * The lease fetch-pr holds for the whole review — outside the mount,
   * written by the REAL acquisition so the identity under test is the one
   * production mints.
   */
  const acquireLease = (promptId = 'p', target = 'pr-1'): void => {
    createReviewWorktreeLease({
      sessionId: 's',
      promptId,
      target,
      repositoryRoot: repo,
      worktreePath: join(repo, '.qwen', 'tmp', `review-${target}`),
      branch: `qwen-review/${target}`,
    });
  };
  const leaseFileFor = (target = 'pr-1'): string =>
    join(repo, '.qwen', 'review-leases', `qwen-review-lease-${target}.json`);
  const leaseIdentity = (target = 'pr-1'): number =>
    JSON.parse(readFileSync(leaseFileFor(target), 'utf8')).identity as number;

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
    // Against the mounted directory itself, not a bare `tmp` segment: the
    // fixture repository is created under `tmpdir()`, which on Linux IS
    // `/tmp`, so a segment test rejects the whole fixture. The `+ sep` keeps
    // a sibling named `.qwen/tmp-foo` from satisfying `startsWith`.
    expect(p.startsWith(join(repo, '.qwen', 'tmp') + sep)).toBe(false);
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

  it('refuses a worktree outside the <root>/.qwen/tmp/<name> geometry', () => {
    // A hand-passed `--worktree /tmp/wt` walks two directories up from it and
    // would otherwise key the trust file THERE — outside the repository,
    // where nothing ever sweeps it. The refusal names the geometry it
    // wanted, so an operator who passed a hand-built path is told what is
    // wrong with it.
    //
    // (The pair of `existsSync` assertions that used to sit here could not
    // fail: `baseTreeTrustPath` performs no filesystem writes at all, so
    // "creates nothing for it" held for every possible implementation.)
    const orphan = join(repo, 'wt');
    mkdirSync(orphan, { recursive: true });
    expect(() => baseTreeTrustPath(orphan, plan)).toThrow(
      /not shaped like <root>\/\.qwen\/tmp\/<name>/,
    );
  });

  it('reads the identity the lease module MINTED, where it re-rooted it (nested geometry)', () => {
    // The run identity is the lease's `identity` FIELD, and these two modules
    // agree only if they also agree on WHERE the lease lives: `leaseDirectory`
    // re-roots to the outermost enclosing repository, and `runIdentity` must
    // read exactly there. Driven through the real writer, so the value
    // compared is the one production mints rather than a fixture's guess.
    const innerRepo = join(repo, '.qwen', 'tmp', 'review-pr-9');
    const innerWt = join(innerRepo, '.qwen', 'tmp', 'review-pr-1');
    mkdirSync(innerWt, { recursive: true });
    createReviewWorktreeLease({
      sessionId: 's',
      promptId: 'p',
      target: 'pr-1',
      repositoryRoot: innerRepo,
      worktreePath: innerWt,
      branch: 'qwen-review/pr-1',
    });
    // The re-root: written beside the OUTERMOST repository's leases, not the
    // inner one's — the control that makes the read below meaningful.
    expect(existsSync(leaseFileFor())).toBe(true);
    expect(
      existsSync(
        join(
          innerRepo,
          '.qwen',
          'review-leases',
          'qwen-review-lease-pr-1.json',
        ),
      ),
    ).toBe(false);
    expect(runIdentity(innerWt).identity).toBe(leaseIdentity());
  });

  it('refuses — never falls back to the mount — when no lease names this worktree', () => {
    // The earlier cut degraded to the PLAN's own mtime on any miss, which put
    // the identity back inside the directory the sandbox mounts read-write:
    // one `utimes` of the plan rotated the run's trust state and swept a tree
    // a sibling was mid-A/B in. It also let two callers of ONE trust file hold
    // two different identities and rotate each other's records away. A caller
    // that cannot produce a host-side identity gets an error.
    expect(() => runIdentity(worktree)).toThrow(/could not be read/);

    // A lease for a DIFFERENT target is not this run's either.
    acquireLease('p', 'pr-2');
    expect(() => runIdentity(worktree)).toThrow(/could not be read/);

    // Nor is one that names another worktree.
    createReviewWorktreeLease({
      sessionId: 's',
      promptId: 'p',
      target: 'pr-1',
      repositoryRoot: repo,
      worktreePath: join(repo, '.qwen', 'tmp', 'review-pr-1-elsewhere'),
      branch: 'qwen-review/pr-1',
    });
    expect(() => runIdentity(worktree)).toThrow(/does not name/);
  });

  it('refuses a lease from an older build that carries no identity', () => {
    // The field is optional in the type because a lease written before it
    // existed has none. Substituting a mount-derived value there is the very
    // thing the refusal exists to prevent, so the answer is an error and the
    // next capture rewrites the lease with one.
    mkdirSync(join(repo, '.qwen', 'review-leases'), { recursive: true });
    writeFileSync(
      leaseFileFor(),
      JSON.stringify({
        sessionId: 's',
        promptId: 'p',
        target: 'pr-1',
        repositoryRoot: repo,
        worktreePath: worktree,
        branch: 'qwen-review/pr-1',
      }),
    );
    expect(() => runIdentity(worktree)).toThrow(/carries no run identity/);
  });

  it('refuses a worktree whose name is not a review worktree', () => {
    // `trustRootFor`'s nested branch returns a path for any spelling that
    // carries the marker, so the geometry check there does not cover a
    // scratch tree sitting beside the review worktree. This does: no lease
    // names it, and an identity minted from anywhere else is a shared key.
    const scratch = join(repo, '.qwen', 'tmp', 'scratch-x');
    mkdirSync(scratch, { recursive: true });
    acquireLease();
    expect(() => runIdentity(scratch)).toThrow(/not a review worktree/);
  });

  it('establishes once per run identity and hands every later asker the same state', () => {
    // The `wx`-then-adopt shape: two shards asking together agree on one
    // file, one pin, one generation.
    acquireLease();
    const p = baseTreeTrustPath(worktree, plan);
    const identity = runIdentity(worktree).identity;
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
    acquireLease();
    const p = baseTreeTrustPath(worktree, plan);
    const identity = runIdentity(worktree).identity;
    establishTrust(p, identity, SHA_A);
    const moved = establishTrust(p, identity, SHA_B);
    expect(moved.established).toBe('adopted');
    expect(moved.conflict).toBe(true);
    expect(JSON.parse(readFileSync(p, 'utf8')).baseSha).toBe(SHA_A);
  });

  it('carries the merge base the capture recorded HOST-SIDE, and rotates when it moves', () => {
    // The pin alone cannot cover the window before the run's first ask: the
    // containerized build/test phase holds the plan read-write and runs
    // BEFORE any base-tree ask exists, so the first reading it authenticates
    // is already the mount's choice. The capture records what it resolved
    // beside the lease, and a MOVED merge base mints a new identity — the
    // rotation a genuine rebase is entitled to, which the mtime-frozen
    // identity could not produce.
    acquireLease();
    expect(runIdentity(worktree).mergeBaseSha).toBeUndefined();

    recordReviewWorktreeLeaseMergeBase(repo, 'pr-1', SHA_A);
    const first = runIdentity(worktree);
    expect(first.mergeBaseSha).toBe(SHA_A);
    // Recording the base this capture resolved does NOT rotate: there was
    // nothing to disagree with, and rotating here would drop a standing
    // tree on the ordinary path.
    expect(first.identity).toBe(leaseIdentity());

    // A same-session re-capture at the SAME base leaves the identity alone,
    // so the standing base tree is still reused.
    acquireLease('prompt-b');
    recordReviewWorktreeLeaseMergeBase(repo, 'pr-1', SHA_A);
    expect(runIdentity(worktree).identity).toBe(first.identity);

    // A re-capture at a MOVED base rotates.
    recordReviewWorktreeLeaseMergeBase(repo, 'pr-1', SHA_B);
    const moved = runIdentity(worktree);
    expect(moved.mergeBaseSha).toBe(SHA_B);
    expect(moved.identity).not.toBe(first.identity);
  });

  it('takes the plan entirely out of the identity — no touch of any kind rotates', () => {
    // Every stamp on the plan is the reviewed code's to set: it lives in the
    // directory the sandbox mounts read-write. The earlier identity read the
    // plan's mtime whenever the lease was missing, so a `utimes` was the
    // whole attack. Backdate, forward-date and rewrite the content: the run
    // is the lease's, and none of it moves.
    acquireLease();
    const p = baseTreeTrustPath(worktree, plan);
    const identity = runIdentity(worktree).identity;
    const first = establishTrust(p, identity, SHA_A);
    const tree = `${worktree}-base`;
    recordBuiltTree(p, identity, tree, {
      baseSha: SHA_A,
      state: 'ok',
      untracked: {},
    });

    for (const at of [
      new Date(Date.now() - 3_600_000),
      new Date(Date.now() + 86_400_000),
    ]) {
      writeFileSync(plan, '{"rewritten":true}');
      utimesSync(plan, at, at);
      const again = establishTrust(p, runIdentity(worktree).identity, SHA_A);
      expect(again.established).toBe('adopted');
      expect(again.nonce).toBe(first.nonce);
    }
    expect(builtTreeRecord(p, tree)).not.toBeNull();
  });

  it('survives repeated same-session re-acquisitions without drifting the identity', () => {
    // The mtime carrier failed exactly here: `utimesSync` restores a
    // fractional mtime with a sub-millisecond floor, so the SECOND refresh of
    // a run drifted past the store's tolerance, rotated the run's state and
    // swept the base tree a sibling shard was mid-A/B in. One refresh could
    // not see it, which is why this loops.
    acquireLease();
    const p = baseTreeTrustPath(worktree, plan);
    const identity = runIdentity(worktree).identity;
    const first = establishTrust(p, identity, SHA_A);
    const tree = `${worktree}-base`;
    recordBuiltTree(p, identity, tree, {
      baseSha: SHA_A,
      state: 'ok',
      untracked: {},
    });
    for (let i = 0; i < 8; i++) {
      acquireLease(`prompt-${i}`);
      const state = establishTrust(p, runIdentity(worktree).identity, SHA_A);
      expect(state.established).toBe('adopted');
      expect(state.nonce).toBe(first.nonce);
    }
    expect(builtTreeRecord(p, tree)).not.toBeNull();
  });

  it('rotates — dropping the records — when the identity moves on', () => {
    // One file per plan path is what makes this safe: a later run cannot land
    // on an earlier run's sibling file (there is none); it only disagrees
    // with THIS file's minted identity, and rotation destroys rather than
    // adopts.
    acquireLease();
    const p = baseTreeTrustPath(worktree, plan);
    const identity = runIdentity(worktree).identity;
    const first = establishTrust(p, identity, SHA_A);
    const tree = `${worktree}-base`;
    recordBuiltTree(p, identity, tree, {
      baseSha: SHA_A,
      state: 'ok',
      untracked: {},
    });
    expect(builtTreeRecord(p, tree)).not.toBeNull();

    // The next capture resolves a moved merge base — a genuine rebase.
    recordReviewWorktreeLeaseMergeBase(repo, 'pr-1', SHA_A);
    recordReviewWorktreeLeaseMergeBase(repo, 'pr-1', SHA_B);
    const rotated = establishTrust(p, runIdentity(worktree).identity, SHA_B);
    expect(rotated.established).toBe('rotated');
    expect(rotated.nonce).not.toBe(first.nonce);
    // `conflict: false` is the half that makes the rotation USABLE: the arm
    // re-pins at the new base, so the caller proceeds. Reporting a conflict
    // here instead would decline the very rebase this path exists to let
    // through, and nothing pinned it.
    expect(rotated.conflict).toBe(false);
    expect(JSON.parse(readFileSync(p, 'utf8')).baseSha).toBe(SHA_B);
    expect(builtTreeRecord(p, tree)).toBeNull();
  });

  it("mints a fresh identity on the HEAL arm rather than adopting the standing file's", () => {
    // The heal arm rewrites a lease that did NOT parse, so the standing
    // file's owner, session and target were never verified. The mtime
    // carrier donated that file's timestamp to this run, which made an
    // unrelated earlier run's trust state ADOPTED instead of rotated. A
    // fresh mint rotates — the direction that loses a base tree rather than
    // trusting one.
    acquireLease();
    const before = leaseIdentity();
    writeFileSync(leaseFileFor(), '{ this is not json');
    acquireLease('prompt-after-tear');
    expect(leaseIdentity()).not.toBe(before);
  });

  it('compares the identity EXACTLY — two mints one apart are two runs', () => {
    // The comparison carried a 1 ms tolerance while the identity was a
    // file's mtime, because `utimesSync` restores one a unit-in-the-last-
    // place off. The identity is a minted token now, and a tolerance over a
    // minted value is actively wrong: two captures whose tokens differ by
    // one would read as the SAME run and adopt each other's pinned base and
    // recorded trees.
    acquireLease();
    const p = baseTreeTrustPath(worktree, plan);
    const identity = runIdentity(worktree).identity;
    const first = establishTrust(p, identity, SHA_A);
    const tree = `${worktree}-base`;
    recordBuiltTree(p, identity, tree, {
      baseSha: SHA_A,
      state: 'ok',
      untracked: {},
    });

    const neighbour = establishTrust(p, identity + 1, SHA_A);
    expect(neighbour.established).toBe('rotated');
    expect(neighbour.nonce).not.toBe(first.nonce);
    expect(builtTreeRecord(p, tree)).toBeNull();
  });

  it('keeps a file whose nonce is missing — the nonce decides nothing', () => {
    // Nothing in production reads the nonce; it is a per-generation marker
    // for a human and for the tests. Treating a missing or empty one as a
    // torn file made its only live effect the destruction of the records of
    // a file whose identity and pin were both intact.
    acquireLease();
    const p = baseTreeTrustPath(worktree, plan);
    const identity = runIdentity(worktree).identity;
    establishTrust(p, identity, SHA_A);
    const tree = `${worktree}-base`;
    recordBuiltTree(p, identity, tree, {
      baseSha: SHA_A,
      state: 'ok',
      untracked: { 'dist/cli.js': { size: 3, ctimeMs: 4 } },
    });

    const stored = JSON.parse(readFileSync(p, 'utf8'));
    delete stored.nonce;
    writeFileSync(p, `${JSON.stringify(stored)}\n`);

    const again = establishTrust(p, identity, SHA_A);
    expect(again.established).toBe('adopted'); // not healed, not rotated
    expect(again.nonce).toMatch(/^[0-9a-f]{32}$/); // one is supplied
    expect(builtTreeRecord(p, tree)?.untracked).toEqual({
      'dist/cli.js': { size: 3, ctimeMs: 4 },
    });
  });

  it('never OPENS a non-regular file at either host-side path', () => {
    // `readFileSync` on a FIFO blocks inside `open(2)` with no timeout, so
    // no `catch` below it can ever run and the shard hangs with no output.
    // A directory at the name stands in for it here — same `isFile()` answer,
    // no `mkfifo` needed, and it is the shape these paths actually meet
    // (a wedge left by a crashed run).
    acquireLease();
    const p = baseTreeTrustPath(worktree, plan);
    const identity = runIdentity(worktree).identity;
    establishTrust(p, identity, SHA_A);

    rmSync(p, { force: true });
    mkdirSync(p, { recursive: true });
    // A file that cannot be read is no file — and the wedge is CLEARED, so
    // the run re-establishes rather than failing every later write with
    // EISDIR on the rename, which is what a directory at this name used to
    // do to every ask for the rest of the review. It lands as `healed`: the
    // `wx` create answers EEXIST for a directory, the read loop clears it
    // and then finds nothing, and a generation with no records is the honest
    // outcome.
    const healed = establishTrust(p, identity, SHA_A);
    expect(healed.established).toBe('healed');
    expect(lstatSync(p).isFile()).toBe(true);

    // And the lease read refuses rather than opening.
    rmSync(leaseFileFor(), { recursive: true, force: true });
    mkdirSync(leaseFileFor(), { recursive: true });
    expect(() => runIdentity(worktree)).toThrow(/not a regular file/);
    // ...and it does NOT delete it: the lease is the other module's state,
    // and its own acquisition clears its own wedge. Refusing is the
    // fail-closed half, which is this module's whole job here.
    expect(existsSync(leaseFileFor())).toBe(true);
    // The lease module's acquisition is what repairs it.
    acquireLease('prompt-repair');
    expect(lstatSync(leaseFileFor()).isFile()).toBe(true);
    expect(runIdentity(worktree).identity).toBe(leaseIdentity());
  });

  it('heals a torn file a crashed writer left instead of wedging the run', () => {
    const p = baseTreeTrustPath(worktree, plan);
    acquireLease();
    const identity = runIdentity(worktree).identity;
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, ''); // open()ed, never written: the crash window
    const state = establishTrust(p, identity, SHA_A);
    expect(state.established).toBe('healed');
    expect(state.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.parse(readFileSync(p, 'utf8')).nonce).toBe(state.nonce);
  }, 10_000);

  it('records what a build left, per tree, preserving the rest of the file', () => {
    const p = baseTreeTrustPath(worktree, plan);
    acquireLease();
    const identity = runIdentity(worktree).identity;
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

  it("REPLACES a tree's record rather than merging into it", () => {
    // The replace semantics are what lets a rebuild's record supersede the
    // previous generation's rather than leaving a union of two inventories —
    // a union would match neither tree and decline forever. Nothing pinned
    // it, so a merge would have passed every existing case.
    acquireLease();
    const p = baseTreeTrustPath(worktree, plan);
    const identity = runIdentity(worktree).identity;
    establishTrust(p, identity, SHA_A);
    const tree = `${worktree}-base`;
    recordBuiltTree(p, identity, tree, {
      baseSha: SHA_A,
      state: 'ok',
      untracked: { 'gen1.js': { size: 1, ctimeMs: 1 } },
    });
    recordBuiltTree(p, identity, tree, {
      baseSha: SHA_A,
      state: 'ok',
      untracked: { 'gen2.js': { size: 2, ctimeMs: 2 } },
    });
    expect(builtTreeRecord(p, tree)?.untracked).toEqual({
      'gen2.js': { size: 2, ctimeMs: 2 },
    });
  });

  it("drops a tree's record, and only that tree's", () => {
    // `trees` is keyed by PATH and the base tree's path is fixed for the
    // review, so a record that outlives the sweep of the tree it describes
    // goes on certifying whatever is created there next — concretely, a
    // rebuild the whole-call budget cut short writes no new record and the
    // previous generation's `state:'ok'` entry answers for a tree that was
    // never built.
    acquireLease();
    const p = baseTreeTrustPath(worktree, plan);
    const identity = runIdentity(worktree).identity;
    const { nonce } = establishTrust(p, identity, SHA_A);
    const tree = `${worktree}-base`;
    const sibling = `${worktree}-probe`;
    for (const t of [tree, sibling]) {
      recordBuiltTree(p, identity, t, {
        baseSha: SHA_A,
        state: 'ok',
        untracked: {},
      });
    }

    dropBuiltTree(p, identity, tree);
    expect(builtTreeRecord(p, tree)).toBeNull();
    expect(builtTreeRecord(p, sibling)).not.toBeNull();
    // The generation is untouched: dropping one tree is not a rotation.
    expect(JSON.parse(readFileSync(p, 'utf8')).nonce).toBe(nonce);

    // An identity that is not this file's drops nothing — the same boundary
    // `recordBuiltTree` keeps.
    dropBuiltTree(p, identity + 60_000, sibling);
    expect(builtTreeRecord(p, sibling)).not.toBeNull();
  });

  it('records nothing across a missing file, an identity boundary, or a re-pinned base', () => {
    // No readable file → nothing to write into (a write could clobber state a
    // concurrent shard just established). A rotated-away identity or a
    // disagreeing base → the record belongs to a generation that is not this
    // file's, and writing it would certify across the boundary.
    const p = baseTreeTrustPath(worktree, plan);
    acquireLease();
    const identity = runIdentity(worktree).identity;
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
