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

/** A code-review platform. */
export type PlatformKind = 'github' | 'aone';

/** Repository coordinates on a host. `host` is lowercased, port allowed. */
export interface RepoIdentity {
  host: string;
  owner: string;
  repo: string;
  /**
   * The FULL path (`group/subgroup/project`) — the owner/repo collapse to
   * the last two segments is non-injective on nested-group platforms, so
   * identity gates compare full paths when both sides carry one.
   */
  groupPath: string;
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
 * One comment on a review target, normalized across platforms. `path`
 * present marks an inline (diff-anchored) comment; its absence marks a
 * thread-level comment on the target itself (GitHub issue comment / Aone
 * global note). `parentId` links replies into threads (GitHub
 * `in_reply_to_id` / Aone `parentNoteId`).
 */
export interface ReviewContextComment {
  id: number;
  /** The author's login/account; '' when the platform gives none. */
  author: string;
  body: string;
  /** ISO timestamp; '' when the platform gives none. */
  createdAt: string;
  path?: string;
  line?: number;
  parentId?: number;
}

/**
 * One review-level verdict (GitHub's review object). Platforms without the
 * concept (Aone) report none — approvals there surface only through the
 * merge-status checks.
 */
export interface ReviewContextVerdict {
  id: number;
  author: string;
  body: string;
  /** APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING | … */
  state: string;
  submittedAt: string;
  /** The head commit the verdict was submitted against, when the platform
   *  records one (GitHub `commit_id`). */
  commitId?: string;
}

/**
 * Everything `pr-context` reads about a review target, normalized: metadata,
 * the comment channels, the platform's verdicts, and the bodies that carry
 * this pipeline's machine-ledger markers (GitHub: the verdict bodies; Aone:
 * the thread-level comments, where the posted summaries land).
 */
export interface ReviewContext {
  title: string;
  body: string;
  authorLogin: string;
  state: string;
  baseRefName: string;
  /** Branch name on GitHub. Aone: `sourceBranch` — a bare SHA under
   *  AGit-Flow, rendered as `base ← <sha>`. */
  headRefName: string;
  headRefOid: string;
  /** Absent where the platform reports no diff stats (Aone). */
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  comments: ReviewContextComment[];
  verdicts: ReviewContextVerdict[];
  ledgerCarriers: ReviewContextVerdict[];
}

/**
 * The metadata fetch-pr records when it pulls a PR's head into the review
 * worktree. GitHub reports diff stats; Aone does not, so those are optional
 * and computed locally from the fetched diff when absent.
 */
export interface FetchMeta {
  /** The head SHA. */
  headRefOid: string;
  /**
   * The head's branch name, when the platform has one (GitHub). AGit-Flow
   * platforms have none (the head is a bare SHA), so this is optional.
   */
  headRefName?: string;
  /** The base branch/ref to merge-base against (baseRefName / targetBranch). */
  baseRefName: string;
  /** True when the head lives in a different repository than the base. */
  isCrossRepository: boolean;
  /** The description, fetched to detect the author's language. */
  body?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
}

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

  /**
   * The git refspec SOURCE whose head is the PR head (fetch-pr fetches it
   * into the review branch). GitHub: `pull/<n>/head`; Aone:
   * `refs/merge-requests/<global-id>/head`.
   */
  fetchHeadRefSpec(prNumber: number): string;

  /** The metadata fetch-pr records when it pulls the PR head. */
  getFetchMeta(prNumber: number, ownerRepo: string): FetchMeta;

  /**
   * The normalized context `pr-context` renders: metadata, comments,
   * verdicts, and the ledger carriers. The identity fail-closed policy
   * stays in pr-context; this is a pure read.
   */
  getReviewContext(prNumber: number, ownerRepo: string): ReviewContext;

  /**
   * The authenticated account ('' on the empty-output shape; throws on a
   * lookup failure). pr-context calls it only when comments exist, and
   * applies its own fail-closed semantics to the answer.
   */
  getCurrentUser(): string;

  /**
   * The canonical web URL of the PR/MR. GitHub COMPOSES it — the URL
   * grammar is deterministic, no API call; `submit` fills a receipt that
   * carries no `html_url` through it. Aone is reader-backed — the
   * platform's own `detailUrl`, never ASSEMBLED: the owner/repo collapse
   * to the last two segments is non-injective on nested-group platforms
   * and an assembled link could name a different repo. Aone's `submit`
   * does not re-query through it: the pre-write drift-gate read already
   * carries the same stable field, so a second fetch cannot add a link —
   * when that receipt comes up empty, the skill relays the target's
   * coordinates. `''` when the platform cannot serve one — and for
   * GitHub when the routing host is not knowable, since a composed link
   * there could name a host the write did not take.
   */
  composeUrl(prNumber: number, ownerRepo: string): string;
}
