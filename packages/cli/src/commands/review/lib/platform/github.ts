/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// GitHub provider for the review-platform read interface. Every call is a
// `gh` invocation through lib/gh.ts (retry, pagination, GH_HOST routing) —
// this module owns the GitHub API *shapes* so the subcommands and the skill
// prose never name an endpoint.

import { ensureAuthenticated, gh, isOwnerRepo } from '../gh.js';
import type {
  ClosingIssueRef,
  CommentKind,
  IssueComment,
  LinkedIssue,
  PrMeta,
  RepoIdentity,
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

/** Shape of `gh repo view --json owner,name,url` (fields we read). */
interface GhRepoView {
  owner: { login: string };
  name: string;
  url: string;
}

/** Shape of `gh pr view --json headRefOid,url`. */
interface GhPrMetaView {
  headRefOid: string;
  url: string;
}

/** Shape of one `closingIssuesReferences` entry. */
interface GhClosingIssueRef {
  number: number;
  title?: string;
  url?: string;
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
    // `gh repo view` resolves through gh's default-repo — in a fork clone the
    // UPSTREAM, where the PR actually lives. That is the resolution the bare
    // PR-number flow wants; do not substitute the origin remote.
    const view = ghJson<GhRepoView>('repo', 'view', '--json', 'owner,name,url');
    return {
      host: hostOfRepoUrl(view.url),
      owner: view.owner.login,
      repo: view.name,
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
    const view = ghJson<{
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
    return (view.closingIssuesReferences ?? []).map((ref) => ({
      number: ref.number,
      title: ref.title ?? '',
      url: ref.url ?? '',
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
    return gh('pr', 'diff', String(prNumber), '--repo', ownerRepo);
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
    // Not ghApi: `--jq` emits the body as RAW text (markdown), which
    // JSON.parse would choke on — measured on the first E2E pass. `.body
    // // ""` because a null body would otherwise print the literal "null".
    return gh('api', path, '--jq', '.body // ""');
  },
};
