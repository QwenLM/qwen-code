/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// GitHub provider for the review-platform read interface. Every call is a
// `gh` invocation through lib/gh.ts (retry, pagination, GH_HOST routing) —
// this module owns the GitHub API *shapes* so the subcommands and the skill
// prose never name an endpoint.

import {
  currentUser,
  ensureAuthenticated,
  getGhHost,
  gh,
  ghApi,
  ghApiAll,
  ghRaw,
  isOwnerRepo,
  normalizeGhHostForUrl,
  resolveGhHost,
} from '../gh.js';
import type {
  ClosingIssueRef,
  CommentKind,
  FetchMeta,
  IssueComment,
  LinkedIssue,
  PrMeta,
  RepoIdentity,
  ReviewContext,
  ReviewContextComment,
  ReviewContextVerdict,
  ReviewPlatformReader,
} from './types.js';

function checkOwnerRepo(ownerRepo: string): void {
  if (!isOwnerRepo(ownerRepo)) {
    throw new TypeError(
      `expected owner/repo, got ${JSON.stringify(ownerRepo)}`,
    );
  }
}

function ghJson<T>(...args: string[]): T {
  return JSON.parse(gh(...args)) as T;
}

/** Shape of `gh repo view --json owner,name,url,parent` (fields we read). */
interface GhRepoView {
  owner: { login: string };
  name: string;
  url: string;
  /** Present only when the resolved repo is a fork; carries id/name/owner —
   *  NO `url` (gh does not emit one there), so never read `parent.url`. */
  parent?: {
    owner: { login: string };
    name: string;
  };
}

/** Shape of `gh pr view --json headRefOid,url`. */
interface GhPrMetaView {
  headRefOid: string;
  url: string;
}

/** Shape of one `closingIssuesReferences` entry. */
interface GhClosingIssueRef {
  number: number;
  repository?: {
    name: string;
    owner?: { login: string };
  };
}

/** Shape of `gh issue view --json title,body,comments` (fields we read). */
interface GhIssueView {
  title?: string;
  body?: string;
  comments?: Array<{
    author?: { login?: string };
    body?: string;
    createdAt?: string;
  }>;
}

/** One entry of `pulls/<n>/comments` or `issues/<n>/comments` (REST). */
interface GhComment {
  id: number;
  user?: { login?: string };
  body?: string;
  created_at?: string;
  /** Inline-only fields (issue comments never carry them). */
  path?: string;
  line?: number;
  in_reply_to_id?: number | null;
}

/** One entry of `pulls/<n>/reviews` (REST). */
interface GhReview {
  id: number;
  user?: { login?: string };
  body?: string;
  state?: string;
  submitted_at?: string;
  commit_id?: string;
}

/**
 * The host a `gh repo view` URL points at: scheme stripped, authority kept
 * (an explicit port survives — it is part of the host the matcher compares).
 */
function hostOfRepoUrl(url: string): string {
  return url
    .replace(/^[a-z]+:\/\//i, '')
    .split('/')[0]
    .toLowerCase();
}

export const githubReader: ReviewPlatformReader = {
  kind: 'github',

  ensureAuthenticated,

  resolveRepo(): RepoIdentity {
    // `gh repo view` resolves through gh's default-repo. That preference is a
    // remote literally NAMED `upstream` when one exists — it is NOT an API
    // fork check: an origin-only fork clone (no `upstream` remote) resolves
    // to the FORK, where the PR does not live, and a same-numbered PR there
    // would hand the review the wrong head SHA. Fetch `parent` and prefer it
    // when the resolved repo is a fork, so a bare PR number always targets
    // the repo that actually hosts PRs (the measured "guessed fork repo"
    // incident the deleted prose recorded).
    const view = ghJson<GhRepoView>(
      'repo',
      'view',
      '--json',
      'owner,name,url,parent',
    );
    const target = view.parent ?? view;
    return {
      // A fork and its parent share one host, and `parent` carries no `url` —
      // so the host comes from the resolved repo's own url, always.
      host: hostOfRepoUrl(view.url),
      owner: target.owner.login,
      repo: target.name,
      // GitHub repos are always exactly two segments.
      groupPath: `${target.owner.login}/${target.name}`.toLowerCase(),
    };
  },

  getPrMeta(prNumber: number, ownerRepo: string): PrMeta {
    checkOwnerRepo(ownerRepo);
    const view = ghJson<GhPrMetaView>(
      'pr',
      'view',
      String(prNumber),
      '--repo',
      ownerRepo,
      '--json',
      'headRefOid,url',
    );
    return { number: prNumber, headSha: view.headRefOid, webUrl: view.url };
  },

  getClosingIssues(prNumber: number, ownerRepo: string): ClosingIssueRef[] {
    checkOwnerRepo(ownerRepo);
    let view: { closingIssuesReferences?: GhClosingIssueRef[] };
    try {
      view = ghJson<{
        closingIssuesReferences?: GhClosingIssueRef[];
      }>(
        'pr',
        'view',
        String(prNumber),
        '--repo',
        ownerRepo,
        '--json',
        'closingIssuesReferences',
      );
    } catch (err) {
      // `closingIssuesReferences` is a --json field only since gh v2.72.0
      // (cli/cli#10544); older gh answers "Unknown JSON field" with no hint
      // that the remedy is an upgrade.
      if (/Unknown JSON field/.test((err as Error).message)) {
        throw new Error(
          'gh >= 2.72.0 is required for closing-issue references ' +
            '(Unknown JSON field: "closingIssuesReferences") — upgrade gh.',
        );
      }
      throw err;
    }
    return (view.closingIssuesReferences ?? []).map((ref) => ({
      number: ref.number,
      // A PR can close an issue in a DIFFERENT repo — take the repository
      // each reference carries; only a malformed payload falls back to the
      // PR's own repo.
      ownerRepo: ref.repository?.owner?.login
        ? `${ref.repository.owner.login}/${ref.repository.name}`
        : ownerRepo,
    }));
  },

  getIssue(issueNumber: number, ownerRepo: string): LinkedIssue {
    checkOwnerRepo(ownerRepo);
    const view = ghJson<GhIssueView>(
      'issue',
      'view',
      String(issueNumber),
      '--repo',
      ownerRepo,
      '--json',
      'title,body,comments',
    );
    const comments: IssueComment[] = (view.comments ?? []).map((c) => ({
      author: c.author?.login ?? '',
      body: c.body ?? '',
      createdAt: c.createdAt ?? '',
    }));
    return {
      number: issueNumber,
      ownerRepo,
      title: view.title ?? '',
      body: view.body ?? '',
      comments,
    };
  },

  fetchDiff(prNumber: number, ownerRepo: string): string {
    checkOwnerRepo(ownerRepo);
    // ghRaw: a diff's edges are content — a trailing whitespace-only context
    // line is part of the last hunk, and trimming it silently alters what the
    // chunk agents review.
    return ghRaw('pr', 'diff', String(prNumber), '--repo', ownerRepo);
  },

  getCommentBody(
    kind: CommentKind,
    id: number,
    ownerRepo: string,
    prNumber?: number,
  ): string {
    checkOwnerRepo(ownerRepo);
    let path: string;
    if (kind === 'review') {
      if (prNumber === undefined) {
        throw new TypeError('review comment bodies are addressed per-PR');
      }
      path = `repos/${ownerRepo}/pulls/${prNumber}/reviews/${id}`;
    } else if (kind === 'inline') {
      path = `repos/${ownerRepo}/pulls/comments/${id}`;
    } else {
      path = `repos/${ownerRepo}/issues/comments/${id}`;
    }
    // Fetch the JSON object and read `.body` — do NOT `--jq '.body // ""'`,
    // which prints the body plus a trailing newline: a body not ending in one
    // gains a byte, and an empty body becomes "\n" (witnessed). gh's JSON
    // output parses exactly (string content is escape-encoded, so the
    // transport's trim/CRLF-normalise never touches the body bytes).
    const obj = ghApi(path) as { body?: unknown } | null;
    return typeof obj?.body === 'string' ? obj.body : '';
  },

  fetchHeadRefSpec(prNumber: number): string {
    return `pull/${prNumber}/head`;
  },

  getFetchMeta(prNumber: number, ownerRepo: string): FetchMeta {
    checkOwnerRepo(ownerRepo);
    const view = ghJson<{
      headRefName: string;
      headRefOid: string;
      baseRefName: string;
      additions: number;
      deletions: number;
      changedFiles: number;
      isCrossRepository: boolean;
      body?: string;
    }>(
      'pr',
      'view',
      String(prNumber),
      '--repo',
      ownerRepo,
      '--json',
      'headRefName,headRefOid,baseRefName,additions,deletions,changedFiles,isCrossRepository,body',
    );
    return {
      headRefOid: view.headRefOid,
      headRefName: view.headRefName,
      baseRefName: view.baseRefName,
      isCrossRepository: view.isCrossRepository,
      body: view.body,
      additions: view.additions,
      deletions: view.deletions,
      changedFiles: view.changedFiles,
    };
  },

  getReviewContext(prNumber: number, ownerRepo: string): ReviewContext {
    checkOwnerRepo(ownerRepo);
    const [owner, repo] = ownerRepo.split('/');
    const view = ghJson<{
      title: string;
      body: string | null;
      author: { login: string } | null;
      baseRefName: string;
      headRefName: string;
      headRefOid: string;
      additions: number;
      deletions: number;
      changedFiles: number;
      state: string;
    }>(
      'pr',
      'view',
      String(prNumber),
      '--repo',
      ownerRepo,
      '--json',
      'title,body,author,baseRefName,headRefName,headRefOid,additions,deletions,changedFiles,state',
    );
    // Paginate — busy PRs routinely cross the default 30-per-page limit on
    // each of these endpoints, and the latest entries (which carry the most
    // recent reviewer summaries / replies) end up on later pages we'd
    // otherwise miss.
    const inline = ghApiAll(
      `repos/${owner}/${repo}/pulls/${prNumber}/comments`,
    ) as GhComment[];
    const issue = ghApiAll(
      `repos/${owner}/${repo}/issues/${prNumber}/comments`,
    ) as GhComment[];
    const reviews = ghApiAll(
      `repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
    ) as GhReview[];
    const comments: ReviewContextComment[] = [...inline, ...issue].map((c) => ({
      id: c.id,
      author: c.user?.login ?? '',
      body: c.body ?? '',
      createdAt: c.created_at ?? '',
      ...(c.path !== undefined ? { path: c.path } : {}),
      ...(c.line !== undefined ? { line: c.line } : {}),
      ...(c.in_reply_to_id !== undefined && c.in_reply_to_id !== null
        ? { parentId: c.in_reply_to_id }
        : {}),
    }));
    const verdicts: ReviewContextVerdict[] = reviews.map((r) => ({
      id: r.id,
      author: r.user?.login ?? '',
      body: r.body ?? '',
      state: r.state ?? '',
      submittedAt: r.submitted_at ?? '',
      ...(typeof r.commit_id === 'string' ? { commitId: r.commit_id } : {}),
    }));
    return {
      title: view.title,
      body: view.body ?? '',
      authorLogin: view.author?.login ?? '',
      state: view.state,
      baseRefName: view.baseRefName,
      headRefName: view.headRefName,
      headRefOid: view.headRefOid,
      additions: view.additions,
      deletions: view.deletions,
      changedFiles: view.changedFiles,
      comments,
      verdicts,
      // GitHub's ledger markers ride in the review bodies.
      ledgerCarriers: verdicts,
    };
  },

  getCurrentUser(): string {
    return currentUser();
  },

  composeUrl(prNumber: number, ownerRepo: string): string {
    checkOwnerRepo(ownerRepo);
    // The PR-page grammar is deterministic — no API call. The host is the
    // one gh calls are currently routed at (a subcommand's setGhHost), else
    // the operator-exported GH_HOST a gh child would inherit — the routing
    // this codebase applies, so the composed link lands where the review
    // ran. When NEITHER names a host, fail CLOSED with '': gh's own third
    // fallback is hosts.yml's authenticated default (a single recorded host
    // wins — go-gh's defaultHost), which this process cannot see, so
    // composing github.com there affirms a host the write may not have
    // taken — the link can resolve to a real, unrelated PR of a
    // same-named github.com repo while the review sits on a GHE host. ''
    // leaves the receipt linkless — submit's truthy checks drop the url,
    // and the skill relays the target's coordinates instead. The spelling
    // rides the shared PR-page helper — the SAME normalization
    // compose-review's comment anchors apply, so one run cannot print two
    // textual spellings of the same page (`--host GHE.Corp:443` lands on
    // `https://ghe.corp/…` in both).
    const routed = getGhHost() ?? resolveGhHost(undefined);
    if (!routed) return '';
    const host = normalizeGhHostForUrl(routed);
    return `https://${host}/${ownerRepo}/pull/${prNumber}`;
  },
};
