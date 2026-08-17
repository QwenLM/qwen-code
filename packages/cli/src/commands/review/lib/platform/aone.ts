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
import { hostsEquivalent } from '../remote-match.js';
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
  // Clean (order matters): strip any userinfo FIRST — it may itself contain
  // `?` or `#` (`https://user:pa?ss@host/…`), and a query-first strip would
  // truncate it mid-credential, making a parseable origin unparseable (and
  // leaking the prefix through the refusal message). The userinfo
  // consumption is GREEDY — up to the LAST `@` of the authority: token-
  // bearing CI origins arrive with several `@` (`user:S1@S2@host`) or with
  // `:` AND `/` inside the secret, and a single-chunk match would leave the
  // residue to fold into the parsed host or echo unredacted into the
  // refusal message. The URL form bounds the authority at the first `/`
  // (userinfo cannot contain one); the scp form admits only a strip that
  // leaves a `host:` shape behind (see the chain below). An `@` that
  // survives into the host or a path segment fails closed in `take` rather
  // than guessing. Then the query string / fragment: query-string
  // credentials (`?private_token=…`, a real CI pattern) would otherwise
  // become part of the repo coordinate and echo unredacted into meta's
  // stdout and the refusal messages. `[\s\S]*` (not `.`) eats newlines too:
  // git stores and re-emits newline-bearing remote URLs, and a plain `.*$`
  // stops at the first `\n`, letting `?private_token=SECRET\n` survive the
  // strip and leak through the refusal message. Finally trailing slashes
  // before `.git`, so two or more trailing slashes after `.git`
  // (`…/p.git//`) cannot defeat the suffix strip. Git accepts all of these
  // shapes.
  const cleaned = url
    .trim()
    .replace(/\/\/[^/]*@/, '//')
    // scp form: consume up to the LAST `@` of the authority — the token may
    // itself contain `:` and `/`, so neither `[^@/]+` nor `[^/]+` can bound
    // it. The lookahead admits only a stripping that leaves a `host:` shape
    // behind (`[^:@/]+:`); when the only `@` sits in the PATH of a
    // userinfo-less origin (`host:path@x`), nothing is stripped and the
    // `@` residue fails closed in `take` instead of guessing.
    .replace(/^(?:.*@)(?=[^:@/]+:)/, '')
    .replace(/[?#][\s\S]*$/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
  const take = (host: string, path: string): RepoIdentity | null => {
    // Defense in depth: if any `@` survived the userinfo consumption into
    // the host or a path segment, fail closed — a credential residue must
    // never become part of a parsed coordinate (it would echo through
    // meta's stdout and the HOSTNAME_RE refusal).
    const parts = path.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    if (host.includes('@') || parts.some((p) => p.includes('@'))) {
      return null;
    }
    return {
      host: host.toLowerCase(),
      owner: parts[parts.length - 2],
      repo: parts[parts.length - 1],
    };
  };
  // URL form first: scheme://[user@]host[:port]/group[/subgroup]/project.
  // The port is matched explicitly and discarded — without `(?::\d+)?` the
  // host capture stops at the port colon and the port number folds into the
  // path segments (`https://h:8443/solo` would parse as owner `8443`).
  let m = /^[a-z+]+:\/\/(?:[^@/]+@)?([^:/]+)(?::\d+)?[:/](.+)$/i.exec(cleaned);
  if (m) return take(m[1], m[2]);
  // scp-like: [user@]host:group[/subgroup]/project. `(?!\/\/)` keeps a
  // scheme URL out of this branch; user@ is optional.
  m = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/.exec(cleaned);
  if (m) return take(m[1], m[2]);
  return null;
}

/** Redact a URL before putting it in a message — the raw secret must not
 *  reach stderr/logs/the transcript. ORDER MATTERS: the userinfo
 *  substitutions run BEFORE the query/fragment strip — a userinfo that
 *  itself contains `?` or `#` (`https://user:pa?ss@host/…`, which git
 *  stores and re-emits fine) would otherwise be truncated mid-credential,
 *  leaving no `@` for either regex, and the username + secret prefix would
 *  reach the message. The userinfo consumption is GREEDY — up to the last
 *  `@` of the authority (parseRemoteUrl's cleaning comment names why:
 *  multi-`@` and `:`/`/`-bearing token userinfo must be consumed whole, or
 *  the residue reaches the message in cleartext). Covers both the URL form
 *  (`//user:token@`) and the scp form (`user:token@host:…`, common for
 *  `insteadOf`/token-bearing origins), AND the query/fragment channel:
 *  `?private_token=…` origins carry no `@`, so a userinfo-only redaction
 *  would echo them. */
function redactUrl(url: string): string {
  return url
    .replace(/\/\/[^/]*@/, '//<redacted>@')
    .replace(/^(?:.*@)(?=[^:@/]+:)/, '<redacted>@')
    .replace(/[?#][\s\S]*$/, '');
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

/** The MR-head refspec, stated ONCE for the provider: `fetchDiff` fetches
 *  it for the diff evidence and `fetchHeadRefSpec` hands it to fetch-pr for
 *  the worktree checkout — two copies would silently disagree if the Aone
 *  ref namespace ever changed. */
function mrHeadRefSpec(prNumber: number): string {
  return `refs/merge-requests/${prNumber}/head`;
}

/**
 * Allowlist shape for a server-controlled branch name reaching git's argv:
 * a plain branch name and nothing else — no option spellings, no refspec
 * shapes (`+`, `:`), no rev-parse metasyntax (`^`, `~`, `@{`), no ranges
 * (`..`), and never the reserved word `HEAD` (fetch serves it silently and
 * merge-base resolves it through the stale clone-time symref). Fail closed:
 * an unusual-but-legal name is refused with a clear metadata-stage error
 * rather than guessed at inside a git invocation. fetch-pr's baseRefName
 * guard carries the twin of this check.
 */
function isPlainBranchName(name: string): boolean {
  return (
    name !== 'HEAD' &&
    !name.includes('..') &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)
  );
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
      // execFileSync failure messages BEGIN with the fixed preamble
      // "Command failed: git remote get-url origin"; git's actual error is
      // the first NON-empty line after it (same pitfall aone-client
      // documents). `.split('\n')[0]` would render only the preamble.
      const cause =
        (err as Error).message
          .split('\n')
          .slice(1)
          .map((l) => l.trim())
          .find(Boolean) ?? '';
      throw new Error(
        `cannot resolve the repository: no \`origin\` remote` +
          (cause ? ` (${cause})` : ''),
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
    // The comparison carries the origin's HOST too — owner/repo equality
    // alone lets a same-named repo on a DIFFERENT platform pass the guard
    // and serve the ref-fetch; an Aone target's clone must sit on the Aone
    // host family (the web/git alias pair counts as one, per remote-match).
    if (
      originIdentity === null ||
      !hostsEquivalent(originIdentity.host, 'gitlab.alibaba-inc.com') ||
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
    // The target branch is SERVER-controlled metadata reaching git's argv.
    // Validate ALLOWLIST-style — accept only a plain branch name — because
    // a denylist of hostile spellings cannot enumerate the channels, and
    // each admitted one has a distinct wrong outcome:
    //  - dash-leading parses as an option: `git fetch origin
    //    --upload-pack=<payload>` executes the attacker-named program on
    //    the remote host with the reviewer's credentials (creatable by
    //    full-refname push);
    //  - leading `+` parses as a FORCE refspec after `--` — `+master`
    //    silently fetches the wrong head (stale evidence, no WARNING);
    //  - a colon parses as `src:dst` refspec — force-moving the
    //    just-fetched throwaway ref or a reviewer-local branch;
    //  - `HEAD` makes `git fetch origin -- HEAD` exit 0 SILENTLY and
    //    merge-base resolves through the stale clone-time symref
    //    (wrong-base diff, zero disclosure);
    //  - rev-parse metasyntax (`master^`, `~1`, `@{…}`) rev-parses to a
    //    WRONG base under a WARNING that misdescribes the state;
    //  - the empty string degrades the run to a garbled diff-less
    //    fallback instead of this clean metadata-stage refusal.
    // The character class is git's branch-name shape (no `..`, no leading
    // dot); `HEAD` is reserved. The `--` below also ends option parsing
    // for whatever reaches the fetch.
    if (!isPlainBranchName(target)) {
      throw new Error(
        `refusing target branch ${JSON.stringify(target)} from the MR ` +
          `metadata — not a plain branch name`,
      );
    }
    // The throwaway ref is suffixed with the pid: two concurrent fetchDiff
    // runs for the same MR in one clone (two /review sessions; a review
    // worktree shares refs/heads with the main clone) would otherwise
    // share the name — session A's finally-delete kills session B between
    // fetch and diff (`unknown revision` mid-review), and a pre-existing
    // local branch of the reserved name is force-moved by the `+` fetch,
    // then deleted, reflog and all (fsck dangling-commit recovery only).
    const ref = `__qwen-review-diff-${prNumber}-${process.pid}`;
    try {
      // Force-fetch (`+`): a stale throwaway ref left by an interrupted
      // earlier run would otherwise make this fetch fail whenever the MR head
      // was rewritten — the normal AGit-Flow iteration shape.
      git('fetch', 'origin', `+${mrHeadRefSpec(prNumber)}:${ref}`);
      // Fetch the target branch so the merge-base is current. If the fetch
      // fails (transient network, expired credential), DISCLOSE it: merge-base
      // then resolves against a possibly-stale local ref, and the diff may
      // carry every commit merged into the target since the clone. Mirrors
      // fetch-pr's `baseFetchFailed` → WARNING.
      try {
        git('fetch', 'origin', '--', target);
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
        // against its first parent (single-commit AGit-Flow CRs). DISCLOSE:
        // a multi-commit MR then gets only its LAST commit served as the
        // complete diff, and the target-fetch WARNING above (if it fired)
        // reads as though a merge-base were still resolved — it was not.
        // fetch-pr's GitHub path is loud about this same class
        // (`baseFetchFailed` → WARNING); silence here would let the skill
        // review and post findings over a fragment of the change.
        process.stderr.write(
          `WARNING: no merge-base with origin/${target} — diffing the head ` +
            `against its first parent; a multi-commit MR's diff may be ` +
            `incomplete.\n`,
        );
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
    return mrHeadRefSpec(prNumber);
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
