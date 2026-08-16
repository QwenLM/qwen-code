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

import { git, gitRaw } from '../git.js';
import { isOwnerRepo } from '../gh.js';
import { PINNED_DIFF_CONFIG, PINNED_DIFF_FLAGS } from '../diff-flags.js';
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
 * Parse the clone's origin URL into host + group/project. Handles the URL
 * form (`https://[user@]host/group[/subgroup]/project(.git)`), the scp-like
 * form (`[user@]host:group[/subgroup]/project` — user@ optional for
 * ssh-config/`insteadOf` setups), and nested groups (collapsed to the last
 * two segments, mirroring remote-match). The URL form is tried first so the
 * scheme is never swallowed by the scp branch.
 */
export function parseRemoteUrl(url: string): RepoIdentity | null {
  // Strip an optional `.git` suffix AND any trailing slash (`…/project.git/`
  // — a pasted browser URL keeps the slash and git accepts it; without this
  // the repo coordinate becomes `project.git`).
  const cleaned = url
    .trim()
    .replace(/\.git\/?$/, '')
    .replace(/\/+$/, '');
  const take = (host: string, path: string): RepoIdentity | null => {
    const parts = path.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    return {
      host: host.toLowerCase(),
      owner: parts[parts.length - 2],
      repo: parts[parts.length - 1],
    };
  };
  // URL form first: scheme://[user@]host/group[/subgroup]/project
  let m = /^[a-z+]+:\/\/(?:[^@/]+@)?([^:/]+)[:/](.+)$/i.exec(cleaned);
  if (m) return take(m[1], m[2]);
  // scp-like: [user@]host:group[/subgroup]/project. `(?!\/\/)` keeps a
  // scheme URL out of this branch; user@ is optional.
  m = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/.exec(cleaned);
  if (m) return take(m[1], m[2]);
  return null;
}

/** Redact a userinfo prefix before putting a URL in a message. Covers both
 *  the URL form (`//user:token@`) and the scp form (`user:token@host:…`,
 *  common for `insteadOf`/token-bearing origins) — the raw secret must not
 *  reach stderr/logs/the transcript. */
function redactUrl(url: string): string {
  return url
    .replace(/\/\/[^@/]+@/, '//<redacted>@')
    .replace(/^[^@/]+@/, '<redacted>@');
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
      // Redact a `user:token@` prefix — token-bearing origins are common in
      // CI and the raw URL must not reach stderr/logs/the transcript.
      throw new Error(
        `cannot parse the origin remote ${JSON.stringify(redactUrl(url))} into group/project`,
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
    // Aone has no `gh pr diff`; the diff is git-local and fetched from
    // `origin`. Verify origin IS the repo the seam was called with — the
    // GitHub path's `gh pr diff <n> --repo <o/r>` provided that scoping; a
    // lightweight run from a DIFFERENT Aone clone would otherwise fetch the
    // ref from the wrong repository (ref-not-found, or a wrong MR's diff
    // written as evidence if the global id happens to exist there).
    let originUrl: string | undefined;
    try {
      originUrl = git('remote', 'get-url', 'origin').trim();
    } catch {
      originUrl = undefined;
    }
    const originIdentity = originUrl ? parseRemoteUrl(originUrl) : null;
    if (
      originIdentity === null ||
      `${originIdentity.owner}/${originIdentity.repo}` !== ownerRepo
    ) {
      throw new Error(
        `the cwd clone is ${
          originIdentity
            ? `${originIdentity.host}/${originIdentity.owner}/${originIdentity.repo}`
            : 'not a readable git clone'
        }, not ${ownerRepo} — run from inside a clone of the target repo`,
      );
    }
    // Aone has no `gh pr diff`; the diff is git-local. Fetch the MR head into
    // a throwaway ref, merge-base it against the target branch, and diff.
    const view = mrView(prNumber, ownerRepo);
    const target = view.targetBranch ?? 'master';
    const ref = `__qwen-review-diff-${prNumber}`;
    try {
      // Force-fetch (`+`): a stale throwaway ref left by an interrupted
      // earlier run would otherwise make this fetch fail whenever the MR head
      // was rewritten — the normal AGit-Flow iteration shape.
      git('fetch', 'origin', `+refs/merge-requests/${prNumber}/head:${ref}`);
      // Fetch the target branch so the merge-base is current. If the fetch
      // fails (transient network, expired credential), DISCLOSE it: merge-base
      // then resolves against a possibly-stale local ref, and the diff may
      // carry every commit merged into the target since the clone. Mirrors
      // fetch-pr's `baseFetchFailed` → WARNING.
      try {
        git('fetch', 'origin', target);
      } catch {
        process.stderr.write(
          `WARNING: could not fetch origin/${target} — the merge-base is ` +
            `resolved from a possibly stale local ref, so the diff may not be ` +
            `the one under review.\n`,
        );
      }
      let base: string;
      try {
        base = git('merge-base', `origin/${target}`, ref);
      } catch {
        // Target branch not present locally — fall back to diffing the head
        // against its first parent (single-commit AGit-Flow CRs).
        base = `${ref}~1`;
      }
      // gitRaw, not git(): git() has no maxBuffer (1 MiB default → ENOBUFS on
      // a routine monorepo diff), rewrites \r\n→\n (altering every CRLF-file
      // hunk), and decodes utf8 while fetch-diff writes latin1 (dropping CJK
      // bytes). gitRaw is 512 MiB, no CRLF rewrite; latin1 matches the write.
      // Spread the pinned diff config/flags (as fetch-pr/local-diff do): an
      // un-pinned `color.diff=always` makes every `diff --git` line
      // unrecognisable and computeDiffStats returns zeros.
      return gitRaw(
        ...PINNED_DIFF_CONFIG,
        'diff',
        ...PINNED_DIFF_FLAGS,
        `${base}..${ref}`,
      ).toString('latin1');
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
      throw new TypeError(
        'aone comment bodies are addressed per-MR — pass `--pr <mr id>`',
      );
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
    // Throw on a miss — returning '' would be indistinguishable from a
    // genuinely-empty body, and the orchestrator would proceed on corrupted
    // evidence (the GitHub provider 404s on a bad id; keep the seam aligned).
    if (!found) {
      throw new Error(
        `comment ${id} not found in MR ${prNumber} of ${ownerRepo}`,
      );
    }
    return found.note ?? found.body ?? '';
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
