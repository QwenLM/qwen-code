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
      return opts.bases?.[`${a}..${b}`] ?? null;
    },
  };
}

describe('resolveMergeBase', () => {
  it('prefers the remote-tracking ref, which is all a CI checkout has', () => {
    const git = fakeGit({
      refs: ['origin/main', 'main'],
      bases: { 'origin/main..pr-head': 'aaa111' },
    });
    const r = resolveMergeBase('origin', 'main', 'pr-head', git);
    expect(r).toEqual({ sha: 'aaa111', baseFetchFailed: false });
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
      refs: ['origin/main', 'main'],
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
      refs: ['origin/main'],
      bases: { 'origin/main..pr-head': 'stale1' },
    });
    expect(resolveMergeBase('origin', 'main', 'pr-head', git)).toEqual({
      sha: 'stale1',
      baseFetchFailed: true,
    });
  });

  it('returns null when no candidate ref resolves', () => {
    const git = fakeGit({ refs: [] });
    expect(resolveMergeBase('origin', 'main', 'pr-head', git)).toEqual({
      sha: null,
      baseFetchFailed: false,
    });
  });

  it('returns null when a ref resolves but shares no history', () => {
    const git = fakeGit({ refs: ['origin/main', 'main'] });
    expect(resolveMergeBase('origin', 'main', 'pr-head', git).sha).toBeNull();
  });

  it('fetches the base branch before probing any ref', () => {
    const git = fakeGit({ refs: ['origin/main'], bases: {} });
    resolveMergeBase('upstream', 'develop', 'head', git);
    expect(git.calls[0]).toBe('fetch upstream develop');
    expect(git.calls[1]).toBe('refExists upstream/develop');
  });
});
