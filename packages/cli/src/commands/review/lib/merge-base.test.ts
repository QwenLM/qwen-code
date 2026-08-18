/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { resolveMergeBase, type GitProbe } from './merge-base.js';

/** A git that only knows the refs and merge-bases it is told about. */
function fakeGit(opts: {
  fetchOk?: boolean;
  refs?: string[];
  bases?: Record<string, string>;
  /**
   * Probes that could not ANSWER, keyed like `bases`. Exit 1 is the answer
   * "no common ancestor"; anything else — 128, or no status from a kill —
   * says nothing about the histories, and the two lead to opposite recovery
   * flows.
   */
  unanswerable?: string[];
  /**
   * Probes KILLED outright, keyed like `bases` — the 120s timeout shape,
   * which yields no status at all (`status: null`), not 128.
   */
  killed?: string[];
}): GitProbe & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetch(remote, ref) {
      calls.push(`fetch ${remote} ${ref}`);
      return opts.fetchOk ?? true;
    },
    refExists(ref) {
      calls.push(`refExists ${ref}`);
      return (opts.refs ?? []).includes(ref);
    },
    mergeBase(a, b) {
      calls.push(`mergeBase ${a} ${b}`);
      const key = `${a}..${b}`;
      const sha = opts.bases?.[key] ?? null;
      if (sha) return { sha, status: 0 };
      if ((opts.killed ?? []).includes(key)) return { sha: null, status: null };
      return {
        sha: null,
        status: (opts.unanswerable ?? []).includes(key) ? 128 : 1,
      };
    },
  };
}

describe('resolveMergeBase', () => {
  it('prefers the remote-tracking ref, which is all a CI checkout has', () => {
    const git = fakeGit({
      refs: ['refs/remotes/origin/main', 'origin/main', 'main'],
      bases: { 'refs/remotes/origin/main..pr-head': 'aaa111' },
    });
    const r = resolveMergeBase('origin', 'main', 'pr-head', git);
    expect(r).toEqual({
      sha: 'aaa111',
      baseFetchFailed: false,
      probeUnavailable: false,
    });
    // It never had to consult the local branch.
    expect(git.calls).not.toContain('mergeBase main pr-head');
  });

  it('falls back to the local base branch when there is no tracking ref', () => {
    const git = fakeGit({
      refs: ['main'],
      bases: { 'main..pr-head': 'bbb222' },
    });
    expect(resolveMergeBase('origin', 'main', 'pr-head', git).sha).toBe(
      'bbb222',
    );
  });

  it('falls through when the tracking ref exists but has no merge-base', () => {
    // An unrelated history on the remote ref: keep looking rather than give up.
    const git = fakeGit({
      refs: ['refs/remotes/origin/main', 'origin/main', 'main'],
      bases: { 'main..pr-head': 'ccc333' },
    });
    expect(resolveMergeBase('origin', 'main', 'pr-head', git).sha).toBe(
      'ccc333',
    );
  });

  it('reports a failed fetch while still resolving from the stale local ref', () => {
    // The dangerous case: the base was force-pushed, the fetch failed, and the
    // merge-base now points at the old tip. The report must say so, or the
    // review silently examines a diff nobody wrote.
    const git = fakeGit({
      fetchOk: false,
      refs: ['refs/remotes/origin/main'],
      bases: { 'refs/remotes/origin/main..pr-head': 'stale1' },
    });
    expect(resolveMergeBase('origin', 'main', 'pr-head', git)).toEqual({
      sha: 'stale1',
      baseFetchFailed: true,
      probeUnavailable: false,
    });
  });

  it('separates "no common ancestor" from a probe that could not answer', () => {
    // `gitOpt` collapsed every failure to a null sha, so a 128 or a kill —
    // the 120s timeout a large long-lived PR under CI load reaches — was
    // indistinguishable from git's definitive exit-1 "these histories share
    // nothing". The caller keys the RETRY class on the difference: a probe
    // that could not answer is infrastructure, and a re-run repeats exactly
    // the component that failed.
    const definitive = resolveMergeBase(
      'origin',
      'main',
      'pr-head',
      fakeGit({ refs: ['refs/remotes/origin/main'] }),
    );
    expect(definitive).toEqual({
      sha: null,
      baseFetchFailed: false,
      probeUnavailable: false,
    });

    const unanswerable = resolveMergeBase(
      'origin',
      'main',
      'pr-head',
      fakeGit({
        refs: ['refs/remotes/origin/main'],
        unanswerable: ['refs/remotes/origin/main..pr-head'],
      }),
    );
    expect(unanswerable).toEqual({
      sha: null,
      baseFetchFailed: false,
      probeUnavailable: true,
    });
  });

  it('a KILLED probe — no status at all — is unanswerable like an exit 128', () => {
    // The 120s merge-base timeout ends in a kill, and a kill yields
    // `status: null`, NOT 128 — `gitProbe`'s doc in lib/git.ts says so.
    // Keying the split on `status === 128` (or collapsing a kill to the
    // definitive exit 1 on the producer seam) would classify exactly the
    // motivating shape as "no common ancestor", filing a transient under a
    // reason the recovery flow never retries.
    const sole = resolveMergeBase(
      'origin',
      'main',
      'pr-head',
      fakeGit({
        refs: ['refs/remotes/origin/main'],
        killed: ['refs/remotes/origin/main..pr-head'],
      }),
    );
    expect(sole).toEqual({
      sha: null,
      baseFetchFailed: false,
      probeUnavailable: true,
    });

    // …and it taints the resolution even when the local fallback answers a
    // definitive exit 1: one unanswerable probe means determinism was never
    // established, whatever the other candidate says.
    const tainted = resolveMergeBase(
      'origin',
      'main',
      'pr-head',
      fakeGit({
        refs: ['refs/remotes/origin/main', 'main'],
        killed: ['refs/remotes/origin/main..pr-head'],
      }),
    );
    expect(tainted.sha).toBeNull();
    expect(tainted.probeUnavailable).toBe(true);
  });

  it('an unanswerable probe on ONE candidate taints the whole resolution', () => {
    // The tracking ref cannot answer and the local fallback says "no common
    // ancestor". Reporting that as the definitive shape would file a
    // transient failure under a reason the recovery flow never retries — the
    // round has not established determinism, it has only heard one answer.
    const r = resolveMergeBase(
      'origin',
      'main',
      'pr-head',
      fakeGit({
        refs: ['refs/remotes/origin/main', 'main'],
        unanswerable: ['refs/remotes/origin/main..pr-head'],
      }),
    );
    expect(r.sha).toBeNull();
    expect(r.probeUnavailable).toBe(true);
  });

  it('a SUCCESSFUL fallback resolution sheds the probe taint', () => {
    // The tracking-ref probe is killed and the local fallback ANSWERS: a
    // resolved base IS the deterministic shape — the clamp ran against a
    // real sha — so a later full-range capture failure is filed as
    // `capture-failed`, not `base-untrusted`. The consumer tests the taint
    // flag before `mergeBaseSha === null`, so stickiness riding into a
    // success misnames the cause in the one field whose contract is "every
    // reason names a CAUSE". Stickiness serves the no-ancestor question —
    // no candidate answered — never a successful resolution.
    const r = resolveMergeBase(
      'origin',
      'main',
      'pr-head',
      fakeGit({
        refs: ['refs/remotes/origin/main', 'main'],
        bases: { 'main..pr-head': 'ddd444' },
        killed: ['refs/remotes/origin/main..pr-head'],
      }),
    );
    expect(r).toEqual({
      sha: 'ddd444',
      baseFetchFailed: false,
      probeUnavailable: false,
    });
  });

  it('returns null when no candidate ref resolves', () => {
    const git = fakeGit({ refs: [] });
    expect(resolveMergeBase('origin', 'main', 'pr-head', git)).toEqual({
      sha: null,
      baseFetchFailed: false,
      probeUnavailable: false,
    });
  });

  it('returns null when a ref resolves but shares no history', () => {
    const git = fakeGit({
      refs: ['refs/remotes/origin/main', 'origin/main', 'main'],
    });
    expect(resolveMergeBase('origin', 'main', 'pr-head', git).sha).toBeNull();
  });

  it('fetches the base branch before probing any ref', () => {
    const git = fakeGit({ refs: ['refs/remotes/upstream/develop'], bases: {} });
    resolveMergeBase('upstream', 'develop', 'head', git);
    expect(git.calls[0]).toBe('fetch upstream develop');
    expect(git.calls[1]).toBe('refExists refs/remotes/upstream/develop');
  });

  it('never merge-bases through an origin/<name> shadow tag', () => {
    // A tag literally named `origin/main` — a pushable, server-controlled
    // refname a plain clone auto-carries — resolves FIRST for the
    // unqualified name (refs/tags before refs/remotes). The qualified
    // candidate must win so the base is the tracking ref, not the shadow.
    const git = fakeGit({
      refs: ['origin/main', 'refs/remotes/origin/main'],
      bases: {
        'origin/main..pr-head': 'shadow-tag-base',
        'refs/remotes/origin/main..pr-head': 'true-base',
      },
    });
    expect(resolveMergeBase('origin', 'main', 'pr-head', git).sha).toBe(
      'true-base',
    );
    expect(git.calls).not.toContain('mergeBase origin/main pr-head');
  });
});
