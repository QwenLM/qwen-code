/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Aone Code provider for the review-platform read interface. Every platform
// call is an `a1` invocation through aone-client.ts; git-local work (the
// diff) reuses lib/git.ts. This module owns the Aone API *shapes* so the
// subcommands and the skill prose never name an endpoint. See
// docs/design/2026-08-15-review-aone-provider.md.

import { git } from '../git.js';
import { isOwnerRepo } from '../gh.js';
import { a1Json, ensureAoneAuthenticated } from './aone-client.js';
import type {
  ClosingIssueRef,
  CommentKind,
  FetchMeta,
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

/** Shape of `a1 repo mr view <id>` (the fields we read). */
interface AoneMrView {
  mergeRequest?: {
    sourceBranch?: string;
    targetBranch?: string;
    detailUrl?: string;
    title?: string;
    description?: string;
    author?: { username?: string };
    state?: string;
  };
}

/** Shape of one `a1 repo mr workitem list` entry. */
interface AoneWorkitemRef {
  id: number;
  subject?: string;
  link?: string;
}

/** Shape of `a1 project workitem get <id>` (best-effort fields). */
interface AoneWorkitem {
  id?: number;
  subject?: string;
  title?: string;
  description?: string;
  body?: string;
  comments?: Array<{
    author?: { name?: string; username?: string } | string;
    body?: string;
    content?: string;
    createdAt?: string;
    created_at?: string;
  }>;
}

/**
 * Parse the clone's origin URL into host + group/project. Handles
 * `git@host:group/project.git`, `https://host/group/project(.git)`, and
 * `ssh://git@host/group/project.git`.
 */
export function parseRemoteUrl(url: string): RepoIdentity | null {
  const cleaned = url.trim().replace(/\.git$/, '');
  // scp-like: git@host:group/project
  let m = /^[^@/]+@([^:/]+):(.+)$/.exec(cleaned);
  if (m) {
    const parts = m[2].split('/');
    if (parts.length >= 2) {
      return {
        host: m[1].toLowerCase(),
        owner: parts[parts.length - 2],
        repo: parts[parts.length - 1],
      };
    }
  }
  // URL form: scheme://[user@]host/group/project
  m = /^[a-z+]+:\/\/(?:[^@/]+@)?([^:/]+)[:/](.+)$/.exec(cleaned);
  if (m) {
    const parts = m[2].split('/').filter(Boolean);
    if (parts.length >= 2) {
      return {
        host: m[1].toLowerCase(),
        owner: parts[parts.length - 2],
        repo: parts[parts.length - 1],
      };
    }
  }
  return null;
}

function mrView(
  prNumber: number,
  ownerRepo: string,
): NonNullable<AoneMrView['mergeRequest']> {
  const view = a1Json<AoneMrView>(
    'repo',
    'mr',
    'view',
    String(prNumber),
    '--repo',
    ownerRepo,
  );
  if (!view.mergeRequest) {
    throw new Error(
      `a1 returned no mergeRequest for #${prNumber} of ${ownerRepo}`,
    );
  }
  return view.mergeRequest;
}

export const aoneReader: ReviewPlatformReader = {
  kind: 'aone',

  ensureAuthenticated: ensureAoneAuthenticated,

  resolveRepo(): RepoIdentity {
    // Aone has no `repo view` default-repo resolution like gh — the identity
    // comes from the clone's own origin remote. There is no fork-parent hop:
    // the reviewer clones the repo the CR lives in.
    let url: string;
    try {
      url = git('remote', 'get-url', 'origin').trim();
    } catch (err) {
      throw new Error(
        `cannot resolve the repository: no \`origin\` remote ` +
          `(${(err as Error).message.split('\n')[0]})`,
      );
    }
    const identity = parseRemoteUrl(url);
    if (!identity) {
      throw new Error(
        `cannot parse the origin remote ${JSON.stringify(url)} into group/project`,
      );
    }
    return identity;
  },

  getPrMeta(prNumber: number, ownerRepo: string): PrMeta {
    checkOwnerRepo(ownerRepo);
    const view = mrView(prNumber, ownerRepo);
    return {
      number: prNumber,
      headSha: view.sourceBranch ?? '',
      webUrl: view.detailUrl ?? '',
    };
  },

  getClosingIssues(prNumber: number, ownerRepo: string): ClosingIssueRef[] {
    checkOwnerRepo(ownerRepo);
    // Aone links Aone workitems, not repo issues. There is no cross-repo
    // notion, so every reference carries the PR's own repo coordinate.
    const items = a1Json<AoneWorkitemRef[]>(
      'repo',
      'mr',
      'workitem',
      'list',
      '--mr',
      String(prNumber),
      '--repo',
      ownerRepo,
    );
    return (items ?? []).map((item) => ({
      number: item.id,
      ownerRepo,
    }));
  },

  getIssue(issueNumber: number, ownerRepo: string): LinkedIssue {
    checkOwnerRepo(ownerRepo);
    const item = a1Json<AoneWorkitem>(
      'project',
      'workitem',
      'get',
      String(issueNumber),
    );
    const comments: IssueComment[] = (item.comments ?? []).map((c) => ({
      author:
        (typeof c.author === 'string'
          ? c.author
          : (c.author?.name ?? c.author?.username)) ?? '',
      body: c.body ?? c.content ?? '',
      createdAt: c.createdAt ?? c.created_at ?? '',
    }));
    return {
      number: issueNumber,
      ownerRepo,
      title: item.subject ?? item.title ?? '',
      body: item.description ?? item.body ?? '',
      comments,
    };
  },

  fetchDiff(prNumber: number, ownerRepo: string): string {
    checkOwnerRepo(ownerRepo);
    // Aone has no `gh pr diff`; the diff is git-local. Fetch the MR head into
    // a throwaway ref, merge-base it against the target branch, and diff.
    const view = mrView(prNumber, ownerRepo);
    const target = view.targetBranch ?? 'master';
    const ref = `__qwen-review-diff-${prNumber}`;
    try {
      git('fetch', 'origin', `refs/merge-requests/${prNumber}/head:${ref}`);
      let base: string;
      try {
        base = git('merge-base', `origin/${target}`, ref);
      } catch {
        // Target branch not fetchable locally — fall back to diffing the head
        // against its first parent (single-commit AGit-Flow CRs).
        base = `${ref}~1`;
      }
      return git('diff', `${base}..${ref}`);
    } finally {
      try {
        git('branch', '-D', ref);
      } catch {
        // The ref may not exist if the fetch failed; nothing to clean.
      }
    }
  },

  getCommentBody(
    kind: CommentKind,
    id: number,
    ownerRepo: string,
    prNumber?: number,
  ): string {
    checkOwnerRepo(ownerRepo);
    if (prNumber === undefined) {
      throw new TypeError('aone comment bodies are addressed per-MR');
    }
    // Aone has one flat comment collection per MR; the text is in `note`.
    const comments = a1Json<
      Array<{ id: number; note?: string; body?: string }>
    >(
      'repo',
      'mr',
      'comment',
      'list',
      '--mr',
      String(prNumber),
      '--repo',
      ownerRepo,
    );
    const found = (comments ?? []).find((c) => c.id === id);
    return found?.note ?? found?.body ?? '';
  },

  fetchHeadRefSpec(prNumber: number): string {
    return `refs/merge-requests/${prNumber}/head`;
  },

  getFetchMeta(prNumber: number, ownerRepo: string): FetchMeta {
    checkOwnerRepo(ownerRepo);
    const view = mrView(prNumber, ownerRepo);
    return {
      headRefOid: view.sourceBranch ?? '',
      baseRefName: view.targetBranch ?? 'master',
      // The reviewer clones the repo the CR lives in — never cross-repo.
      isCrossRepository: false,
      body: view.description,
      // Aone does not report diff stats; fetch-pr computes them locally.
    };
  },
};
