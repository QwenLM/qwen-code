/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Review-platform abstraction: the operations the /review skill needs from a
// code-review host, with the host's API shape kept behind the boundary.
//
// Introduced with a single provider (GitHub) together with its first real
// consumers — the meta / issue-context / fetch-diff / comment-body
// subcommands, which absorb the `gh` commands that used to live in the
// skill's prompt prose. The boundary exists so a second provider (Aone Code)
// lands without the skill prose or these subcommands changing; see
// docs/design/2026-08-13-review-platform-provider-abstraction.md.

/** A code-review platform. Only 'github' has a provider today. */
export type PlatformKind = 'github';

/** Repository coordinates on a host. `host` is lowercased, port allowed. */
export interface RepoIdentity {
  host: string;
  owner: string;
  repo: string;
}

/** A pull request's live identity facts. */
export interface PrMeta {
  number: number;
  headSha: string;
  webUrl: string;
}

/** A closing-issue reference: discovery metadata, not the issue itself. */
export interface ClosingIssueRef {
  number: number;
  /** The issue's own repo — a PR can close an issue in another repository. */
  ownerRepo: string;
}

export interface IssueComment {
  author: string;
  body: string;
  createdAt: string;
}

/** A fetched issue: the evidence Agent 0 judges the fix against. */
export interface LinkedIssue {
  number: number;
  ownerRepo: string;
  title: string;
  body: string;
  comments: IssueComment[];
}

/** Which comment collection an id belongs to (shapes differ per platform). */
export const COMMENT_KINDS = ['review', 'inline', 'issue'] as const;
export type CommentKind = (typeof COMMENT_KINDS)[number];

/**
 * The read side of a review platform. Write operations (submit, audit) join
 * with the first provider that has them — keeping this interface to what is
 * consumed today is what keeps it honest.
 */
export interface ReviewPlatformReader {
  readonly kind: PlatformKind;

  /** Fail fast with an actionable message when the transport has no auth. */
  ensureAuthenticated(): void;

  /**
   * The repository the current directory resolves to — the derivation that
   * used to be a prose `gh repo view` in the skill (a fork clone resolves to
   * its upstream, where the PR lives).
   */
  resolveRepo(): RepoIdentity;

  /** Live PR facts: head SHA (drift checks) and the canonical web URL. */
  getPrMeta(prNumber: number, ownerRepo: string): PrMeta;

  /**
   * Strong closing-issue metadata for a PR. A discovery hint, not proof the
   * author linked the right issue — relevance judgment stays in Agent 0.
   */
  getClosingIssues(prNumber: number, ownerRepo: string): ClosingIssueRef[];

  /** One issue with its body and full comment thread. */
  getIssue(issueNumber: number, ownerRepo: string): LinkedIssue;

  /** The PR's full unified diff. */
  fetchDiff(prNumber: number, ownerRepo: string): string;

  /**
   * One comment's body — the fetch a pr-context truncation note names.
   * `review` bodies are addressed per-PR and need `prNumber`.
   */
  getCommentBody(
    kind: CommentKind,
    id: number,
    ownerRepo: string,
    prNumber?: number,
  ): string;
}
