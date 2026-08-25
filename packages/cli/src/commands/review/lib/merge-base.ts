/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Resolving the left side of the review diff. Extracted from `fetch-pr` and
// given an injected git surface, because getting this wrong is invisible: a
// stale base ref produces a structurally complete report describing the wrong
// diff, and the review then examines code nobody changed.

/** The three git operations resolving a merge-base needs. */
export interface GitProbe {
  /** Update the remote-tracking ref. False when the fetch failed. */
  fetch(remote: string, ref: string): boolean;
  /** Does this ref resolve locally? */
  refExists(ref: string): boolean;
  /**
   * Merge-base of two refs, or null when there is none. An implementation
   * may THROW when the git surface cannot answer — distinct from answering
   * "none" — and the throw propagates to the caller.
   */
  mergeBase(a: string, b: string): string | null;
}

export interface MergeBaseResult {
  /** The diff's left side. Null when no candidate ref resolved. */
  sha: string | null;
  /**
   * True when the base branch could not be fetched.
   *
   * Not fatal — a local tracking ref may still exist — but it may be stale. If
   * the base branch was force-pushed, `merge-base` resolves against the old tip
   * and the review silently examines the wrong diff. The caller says so.
   */
  baseFetchFailed: boolean;
}

/**
 * Resolve the merge-base of a PR head and its base branch.
 *
 * The remote-tracking ref is preferred because a CI checkout has no local
 * base branch; the local ref is the fallback for a developer who has one
 * but is offline. Null means neither resolved, and the caller degrades to
 * a diff-less report rather than failing the whole review.
 *
 * The tracking-ref candidate is FULLY QUALIFIED (`refs/remotes/…`): git
 * resolves an unqualified `origin/<name>` in `refs/tags` and `refs/heads`
 * BEFORE `refs/remotes`, so a tag or branch literally named
 * `origin/<baseRefName>` — a pushable, SERVER-CONTROLLED refname a plain
 * clone auto-carries — would shadow the just-fetched tracking ref and
 * silently move the base.
 */
export function resolveMergeBase(
  remote: string,
  baseRefName: string,
  headRef: string,
  git: GitProbe,
): MergeBaseResult {
  const baseFetchFailed = !git.fetch(remote, baseRefName);
  for (const candidate of [
    `refs/remotes/${remote}/${baseRefName}`,
    baseRefName,
  ]) {
    if (!git.refExists(candidate)) continue;
    const mb = git.mergeBase(candidate, headRef);
    if (mb) return { sha: mb, baseFetchFailed };
  }
  return { sha: null, baseFetchFailed };
}
