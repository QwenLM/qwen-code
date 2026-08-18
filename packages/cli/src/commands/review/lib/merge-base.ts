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
   * Merge-base of two refs.
   *
   * `status` is what separates "these histories share no ancestor" from "the
   * probe could not answer": git exits 1 for the first, and 128 — or nothing
   * at all, on a kill or a spawn failure — for the second. Collapsing both to
   * a null sha is how a transient failure came to be reported as a
   * deterministic refusal the recovery flow then refused to retry.
   */
  mergeBase(a: string, b: string): { sha: string | null; status: number | null };
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
  /**
   * True when a candidate ref resolved but the merge-base probe itself could
   * not answer — an exit above 1, or a kill (the 120s timeout a large
   * long-lived PR under CI load reaches). Distinct from `sha: null` with this
   * false, which is the definitive shape: the probe ran and the histories
   * genuinely share no ancestor, which a re-run reproduces exactly.
   *
   * The caller keys the RETRY class on it: a probe that could not answer is
   * infrastructure, and the component that failed is one a re-run repeats.
   */
  probeUnavailable: boolean;
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
  // Sticky across candidates: the tracking ref may fail to probe while the
  // local fallback answers a definitive "no ancestor", and a round that saw
  // one unanswerable probe has not established the deterministic shape.
  let probeUnavailable = false;
  for (const candidate of [
    `refs/remotes/${remote}/${baseRefName}`,
    baseRefName,
  ]) {
    if (!git.refExists(candidate)) continue;
    const mb = git.mergeBase(candidate, headRef);
    if (mb.sha) return { sha: mb.sha, baseFetchFailed, probeUnavailable };
    // Exit 1 is the answer "no common ancestor". Anything else — 128, or no
    // status at all from a kill or a spawn failure — is the probe failing to
    // answer, which says nothing about the histories.
    if (mb.status !== 1) probeUnavailable = true;
  }
  return { sha: null, baseFetchFailed, probeUnavailable };
}
