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
import { INERT_GIT_ARGS, localFilterRefusal } from '../worktree.js';
import { isOwnerRepo } from '../gh.js';
import { PINNED_DIFF_CONFIG, PINNED_DIFF_FLAGS } from '../diff-flags.js';
import { isAoneHostFamily } from '../remote-match.js';
import {
  a1Json,
  a1JsonOnce,
  a1Once,
  ensureAoneAuthenticated,
  execErrorCause,
} from './aone-client.js';
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

/** Shape of `a1 repo mr view <id>` (the fields we read). */
interface AoneMrView {
  mergeRequest?: {
    sourceBranch?: string;
    targetBranch?: string;
    detailUrl?: string;
    title?: string;
    description?: string;
    author?: unknown;
    state?: string;
  };
}

/** Shape of one `a1 repo mr workitem list` entry. */
interface AoneWorkitemRef {
  id: number;
  subject?: string;
  link?: string;
}

/**
 * Shape of one `a1 repo mr comment list` entry (the fields we read).
 * `path` present marks an inline (diff-anchored) comment; its absence marks
 * a thread-level comment on the MR itself — the channel the posted review
 * summaries ride on, and therefore where this pipeline's ledger markers
 * live.
 */
interface AoneComment {
  id: number;
  note?: string;
  body?: string;
  author?: unknown;
  createdAt?: string;
  created_at?: string;
  path?: string;
  line?: number;
  parentNoteId?: number | null;
  /** Draft comments are unposted — neither discussion nor a prior round. */
  isDraft?: boolean;
}

/** The author field tolerates the shapes a1 has shipped: a bare string or
 *  an object carrying the account under one of several keys. The first
 *  present non-empty one wins; `account` leads because that is the spelling
 *  `a1 auth whoami` answers in — the identity the own/foreign split
 *  compares against. */
function aoneCommentAuthor(author: unknown): string {
  if (typeof author === 'string') return author;
  if (author !== null && typeof author === 'object') {
    const o = author as Record<string, unknown>;
    for (const key of ['account', 'username', 'login', 'name']) {
      const v = o[key];
      if (typeof v === 'string' && v !== '') return v;
    }
  }
  return '';
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
  const trimmed = url.trim();
  const schemeForm = /^[a-z+]+:\/\//i.test(trimmed);
  // Clean, per form:
  //  - URL form: the AUTHORITY is the span between `//` and the first `/`.
  //    Userinfo is consumed WHOLE within it — up to the authority's last
  //    `@` — so multi-`@` tokens (`user:S1@S2@host`) and `?`/`#` inside
  //    the secret (`https://user:pa?ss@host/…`) survive; a query strip run
  //    first would truncate the secret mid-credential. The query/fragment
  //    strip runs on the PATH portion only — an `@` inside a query or
  //    fragment value is the credential's own character, and letting it
  //    drive either strip fabricates coordinates from the query tail. A
  //    `/`-bearing secret puts the `@` in PATH territory (the authority
  //    ends at the first `/`): nothing is stripped, and the residue fails
  //    closed in `take` — it must never fold into a fabricated host.
  //  - scp form: parsed with GIT'S OWN grammar — hostinfo ends at the
  //    FIRST `:`, and userinfo is `user@` where the user carries neither
  //    `:` nor `/` (probed via GIT_TRACE: `git ls-remote
  //    'ci-user:/tok@host:g/p.git'` connects to host `ci-user`). A
  //    token-bearing origin (`oauth2:SECRET@host:…`) therefore has host
  //    `oauth2` in git too — the parser must agree, and the `@` residue
  //    fails closed in `take`. The earlier last-`@` consumption diverged
  //    from git and let the same-repo guard pass while git fetched from a
  //    DIFFERENT server than the parsed identity named. No userinfo
  //    cleaning here — the parse regex owns it.
  // The query string / fragment is then stripped on both forms: query-
  // string credentials (`?private_token=…`, a real CI pattern) would
  // otherwise become part of the repo coordinate; `[\s\S]*` eats newlines.
  // Finally trailing slashes before `.git`, so `…/p.git//` cannot defeat
  // the suffix strip. Git accepts all of these shapes.
  let cleaned: string;
  if (schemeForm) {
    const parts = /^([a-z+]+:\/\/)([^/]*)([\s\S]*)$/i.exec(trimmed);
    const authority = parts?.[2] ?? '';
    const at = authority.lastIndexOf('@');
    cleaned =
      (parts?.[1] ?? '') +
      (at === -1 ? authority : authority.slice(at + 1)) +
      (parts?.[3] ?? '');
  } else {
    cleaned = trimmed;
  }
  cleaned = cleaned
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
      // The FULL path — the owner/repo collapse is non-injective on
      // nested-group platforms; the identity gates compare this when both
      // sides carry one.
      groupPath: parts.join('/').toLowerCase(),
    };
  };
  // URL form: scheme://[user@]host[:port]/group[/subgroup]/project. The
  // port is matched explicitly and discarded — without `(?::\d+)?` the
  // host capture stops at the port colon and the port number folds into
  // the path segments (`https://h:8443/solo` would parse as owner `8443`).
  // The path MUST start with `/`: a scheme input never falls through to
  // the scp grammar — `https://user:pa/ss` (no `@`, no port) is malformed
  // and fails closed instead of parsing host `user` from the userinfo
  // position.
  if (schemeForm) {
    const m = /^[a-z+]+:\/\/(?:[^@/]+@)?([^:/]+)(?::\d+)?\/(.+)$/i.exec(
      cleaned,
    );
    return m ? take(m[1], m[2]) : null;
  }
  // scp-like, GIT'S grammar: `[user@]host:path` — hostinfo ends at the
  // FIRST `:`, userinfo is `user@` with no `:` or `/` in the user part.
  // Token-bearing shapes (`oauth2:SECRET@host:…`, `ci-user:/tok@host:…`)
  // parse host = the span before that first colon, exactly as git connects
  // (GIT_TRACE-probed); their `@` residue lands in the path and fails
  // closed in `take` instead of fabricating coordinates.
  const m = /^(?:([^:@/]+)@)?([^:/]+):(?!\/\/)(.+)$/.exec(cleaned);
  return m ? take(m[2], m[3]) : null;
}

/** Redact a URL before putting it in a message — the raw secret must not
 *  reach stderr/logs/the transcript. Fail closed BY CONSTRUCTION: the split
 *  at the last `@` redacts everything before it — but ONLY when that `@`
 *  sits in the authority region. An `@` inside a query or fragment VALUE is
 *  the credential's own character (`?private_token=prefix@SECRET` is the
 *  shape this code's own cleaning comment calls "a real CI pattern"); there
 *  is no safe tail to keep after it, so the display fails closed with a
 *  constant instead of slicing around it. Six rounds of shape-by-shape
 *  slicing each missed the next shape — the class is closed, not patched.
 *  A userinfo-less origin carrying `@` only in the path is likewise a
 *  constant. */
function redactUrl(url: string): string {
  const at = url.lastIndexOf('@');
  if (at === -1) return url.replace(/[?#][\s\S]*$/, '');
  const marker = url.search(/[?#]/);
  if (marker !== -1 && marker < at) return '<redacted remote>';
  const tail = url.slice(at + 1).replace(/[?#][\s\S]*$/, '');
  return `<redacted>@${tail}`;
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

/** The MR's live head SHA: under AGit-Flow `sourceBranch` IS the head.
 *  Stated ONCE for the provider — every read site (getMrAuthorAndHead,
 *  getPrMeta, getFetchMeta, getReviewContext, submit's pre-write drift
 *  gate, the head-moved-during-post re-read) routes through here.
 *  Hand-derived copies had already diverged on normalization (two of the
 *  five read untrimmed), and a padded server value then drifted against
 *  the trimmed reads — a phantom "PR head advanced during review" for an
 *  MR that never moved (#9629 review). */
function aoneHeadSha(view: NonNullable<AoneMrView['mergeRequest']>): string {
  return (view.sourceBranch ?? '').trim();
}

/**
 * Allowlist shape for a server-controlled branch name reaching git's argv:
 * a plain branch name and nothing else — no option spellings, no refspec
 * shapes (`+`, `:`), no rev-parse metasyntax (`^`, `~`, `@{`), no ranges
 * (`..`), never the reserved word `HEAD` (fetch serves it silently and
 * merge-base resolves it through the stale clone-time symref), and never
 * the pseudo-ref set — `FETCH_HEAD` resolves to the just-fetched MR head
 * (an EMPTY diff beside full-range metadata), `ORIG_HEAD` to an arbitrary
 * ancestor. Both shape-legal, both silently wrong. The match is
 * CASE-INSENSITIVE: on case-insensitive filesystems (macOS/Windows
 * defaults) `.git/fetch_head` folds onto `.git/FETCH_HEAD` the
 * immediately-preceding fetch wrote, so lowercase spellings reach the same
 * pseudo-refs. Fail closed: an unusual-but-legal name is refused with a
 * clear metadata-stage error rather than guessed at inside a git
 * invocation. `refs/`-prefixed names ride the same rejection: they are
 * legal branch names (`git check-ref-format --branch` accepts
 * `refs/heads/x`), but as a fetch/merge-base argument they resolve
 * QUALIFIED refs the server controls (`refs/remotes/origin/HEAD` is the
 * clone's default-branch symref) — a wrong base disclosed only by a
 * misdescribing warning. fetch-pr's baseRefName guard carries the twin of
 * this check.
 */
const GIT_PSEUDO_REFS =
  /^(FETCH|ORIG|MERGE|CHERRY_PICK|REVERT|REBASE|BISECT)_HEAD$/i;

function isPlainBranchName(name: string): boolean {
  return (
    name.toUpperCase() !== 'HEAD' &&
    !GIT_PSEUDO_REFS.test(name) &&
    !name.includes('..') &&
    !/^refs\//i.test(name) &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)
  );
}

/** The full repository path named by the MR's own detail URL
 *  (`…/<group>[/subgroup…]/<project>/codereview/<id>`) — authoritative for
 *  which repo the MR lives in. Lowercased to compare against the parsed
 *  origin's groupPath. Undefined when absent or not the CR shape. */
function mrRepoPath(detailUrl: string | undefined): string | undefined {
  if (!detailUrl) return undefined;
  const m = /^[a-z+]+:\/\/[^/]+\/(.+)\/codereview\/\d+(?:$|[/?#])/i.exec(
    detailUrl.trim(),
  );
  return m?.[1]?.toLowerCase();
}

/**
 * ONE `a1 repo mr comment list` query, shape-checked. a1 can answer this
 * exact command with a well-formed `a1.error/v1` error OBJECT at exit 0 (a
 * backend auth failure or a client timeout — measured by cleanup's
 * a1CommentList, same payload, same guard). `?? []` does not coalesce an
 * object, and `.filter`/`.find` on it would throw an UNTAGGED TypeError,
 * losing the envelope's actionable message — the difference between
 * "re-authenticate" and "schema drift" — at exactly the moment the read
 * fails for a recoverable reason. Surface the cause tagged instead.
 */
function aoneCommentListing(
  prNumber: number,
  ownerRepo: string,
  ...extra: string[]
): AoneComment[] {
  const out = a1Json<unknown>(
    'repo',
    'mr',
    'comment',
    'list',
    '--mr',
    String(prNumber),
    '--repo',
    ownerRepo,
    '--sort',
    'asc',
    ...extra,
  );
  if (!Array.isArray(out)) {
    const cause = (out as { message?: unknown } | null)?.message;
    throw new Error(
      'a1 mr comment list returned an unexpected shape' +
        (typeof cause === 'string' && cause.trim() !== ''
          ? `: ${cause.trim()}`
          : ''),
    );
  }
  return out as AoneComment[];
}

/**
 * The MR's FULL comment surface: the default listing UNIONED with the
 * `--resolved` listing, deduped by id. The default listing EXCLUDES
 * resolved comments (measured by cleanup's auditAoneMrWrites: the MR's
 * `comments` minus `closedComments` is exactly what it returns), while
 * GitHub's REST fetches INCLUDE resolved-thread comments — so any consumer
 * that must see the same surface GitHub sees (the context bundle AND the
 * comment-body refetch a truncation note names) reads through this union.
 * A refetch that queried only the default list would throw "not found" for
 * a resolved id the context file had just rendered.
 *
 * DISCLOSED RESIDUAL: resolved REPLIES stay invisible — the `--resolved`
 * listing returns resolved ROOT inline comments only, and a1 exposes no
 * listing that includes their replies (same residual cleanup's audit
 * discloses, design doc #9617).
 */
function aoneAllComments(prNumber: number, ownerRepo: string): AoneComment[] {
  const byId = new Map<number, AoneComment>();
  for (const c of [
    ...aoneCommentListing(prNumber, ownerRepo),
    ...aoneCommentListing(prNumber, ownerRepo, '--resolved'),
  ]) {
    if (typeof c.id === 'number' && !byId.has(c.id)) byId.set(c.id, c);
  }
  return [...byId.values()];
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
      const cause = execErrorCause(err);
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
    // Detection can be steered onto this reader by an explicit `--host`
    // while the cwd clone sits on a DIFFERENT platform (the common
    // dual-remote Aone-migration setup: origin is a GitHub mirror). The
    // fetchDiff origin guard applies this same predicate for the same
    // reason; without it here the discovery branch emits a
    // self-contradictory identity ({platform:'aone', host:'github.com'})
    // and queries a1 with the mirror's coordinates.
    if (!isAoneHostFamily(identity.host)) {
      throw new Error(
        `cannot resolve an Aone repository: this clone's origin is on ` +
          `${JSON.stringify(identity.host)}, not the Aone host family — ` +
          `run from inside an Aone clone`,
      );
    }
    return identity;
  },

  getPrMeta(prNumber: number, ownerRepo: string): PrMeta {
    checkOwnerRepo(ownerRepo);
    const view = mrView(prNumber, ownerRepo);
    return {
      number: prNumber,
      headSha: aoneHeadSha(view),
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
    // The MR view is consulted BEFORE the guard: its detailUrl names the
    // repo the MR actually lives in — authoritative identity, where the
    // seam's `ownerRepo` is only the collapsed last-two form. The collapse
    // is non-injective on nested-group platforms, so a different group's
    // same-tail clone would pass an owner/repo comparison and serve the
    // ref-fetch; comparing FULL paths (origin's parsed groupPath against
    // the detailUrl's path) closes it. Without a detailUrl the guard falls
    // back to the collapsed comparison (plus the host check).
    const view = mrView(prNumber, ownerRepo);
    const mrPath = mrRepoPath(view.detailUrl);
    // The comparison carries the origin's HOST too — owner/repo equality
    // alone lets a same-named repo on a DIFFERENT platform pass the guard
    // and serve the ref-fetch. The host arm keys on the CANONICAL Aone
    // family predicate (port/trailing-dot/case normalized) — detection
    // accepts a dotted-FQDN origin as Aone, so the diff gate must too; a
    // harder comparison here refused a genuine clone with a misdirecting
    // remedy.
    const sameRepo =
      originIdentity !== null &&
      isAoneHostFamily(originIdentity.host) &&
      (mrPath !== undefined
        ? originIdentity.groupPath === mrPath
        : `${originIdentity.owner}/${originIdentity.repo}` === ownerRepo);
    if (!sameRepo) {
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
    // Screen BEFORE the fetches, the way fetch-pr screens its head and base
    // fetches: these are network spawns against the user's clone and EXECUTE
    // the command-valued repo-local config keys the screen names (a key an
    // earlier review's probe planted in the never-wiped common dir runs
    // during them). The spawns carry INERT_GIT_ARGS and an explicit
    // `--no-recurse-submodules` for the absorbed-submodule plant the
    // screen's candidate set cannot read — the same shape fetch-pr's
    // fetches close.
    const fetchRefusal = localFilterRefusal(
      process.cwd(),
      'the Aone MR diff fetches',
    );
    if (fetchRefusal) throw new Error(fetchRefusal);
    try {
      // Force-fetch (`+`): a stale throwaway ref left by an interrupted
      // earlier run would otherwise make this fetch fail whenever the MR head
      // was rewritten — the normal AGit-Flow iteration shape.
      git(
        ...INERT_GIT_ARGS,
        'fetch',
        '--no-recurse-submodules',
        'origin',
        `+${mrHeadRefSpec(prNumber)}:${ref}`,
      );
      // Fetch the target branch so the merge-base is current. If the fetch
      // fails (transient network, expired credential), DISCLOSE it: merge-base
      // then resolves against a possibly-stale local ref, and the diff may
      // carry every commit merged into the target since the clone. Mirrors
      // fetch-pr's `baseFetchFailed` → WARNING. The fetch is an EXPLICIT
      // BRANCH REFSPEC: a bare `git fetch origin -- <target>` dwims onto a
      // same-named TAG (exit 0, FETCH_HEAD-only, tracking ref untouched —
      // the stale-base state above with no WARNING, since the "fetch
      // succeeded").
      try {
        git(
          ...INERT_GIT_ARGS,
          'fetch',
          '--no-recurse-submodules',
          'origin',
          `+refs/heads/${target}:refs/remotes/origin/${target}`,
        );
      } catch {
        process.stderr.write(
          `WARNING: could not fetch origin/${target} — the merge-base is ` +
            `resolved from a possibly stale local ref, so the diff may not be ` +
            `the one under review.\n`,
        );
      }
      let base: string;
      try {
        // QUALIFIED tracking ref: git resolves an unqualified
        // `origin/<target>` in refs/tags and refs/heads BEFORE refs/remotes,
        // so a tag or branch literally named `origin/<targetBranch>` — a
        // PUSHABLE refname any user with push access (e.g. the MR author)
        // can create, and a fresh clone auto-carries — would shadow the
        // just-fetched tracking ref and silently move the merge base.
        base = git(
          'merge-base',
          `refs/remotes/origin/${target}`,
          // QUALIFIED head side: an unqualified throwaway-ref name resolves
          // in refs/tags before refs/heads — same shadow class as the base
          // arm, on the head.
          `refs/heads/${ref}`,
        );
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
        base = `refs/heads/${ref}~1`;
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
        // Head side qualified — same shadow class as the merge-base reads.
        `${base}..refs/heads/${ref}`,
      ).toString('latin1');
    } finally {
      try {
        // INERT_GIT_ARGS: `branch -D` fires the reference-transaction hook
        // from the never-wiped common hooks dir — the same hazard the
        // fetch-pr rollbacks neutralize — and this delete runs on every
        // fetchDiff exit, the certified success path included.
        git(...INERT_GIT_ARGS, 'branch', '-D', ref);
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
    // Serve the SAME surface getReviewContext renders — the full union that
    // INCLUDES resolved comments — because the refetch note that lands here
    // is emitted for a comment the context file carried, which may be a
    // resolved one; a default-only query would throw "not found" for it.
    // The union helper also shape-checks the a1.error/v1 envelope.
    const comments = aoneAllComments(prNumber, ownerRepo);
    const found = comments.find((c) => c.id === id);
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
      headRefOid: aoneHeadSha(view),
      baseRefName: view.targetBranch ?? 'master',
      // The reviewer clones the repo the CR lives in — never cross-repo.
      isCrossRepository: false,
      body: view.description,
      // Aone does not report diff stats; fetch-pr computes them locally.
    };
  },

  getReviewContext(prNumber: number, ownerRepo: string): ReviewContext {
    checkOwnerRepo(ownerRepo);
    const view = mrView(prNumber, ownerRepo);
    // One flat collection serves the three GitHub channels; `--sort asc`
    // gives chronological order (the GitHub endpoints' natural order).
    // The full resolved-INCLUSIVE surface (default + `--resolved`, deduped
    // by id, envelope-guarded) comes from the shared helper — the SAME one
    // getCommentBody reads, so a refetch note emitted for any rendered
    // comment (resolved included) always finds its body.
    const allComments = aoneAllComments(prNumber, ownerRepo);
    // DISCLOSED RESIDUAL: resolved REPLIES stay invisible — the `--resolved`
    // listing returns resolved ROOT inline comments only, and a1 exposes no
    // listing that includes their replies (same residual cleanup's audit
    // discloses, design doc #9617). A resolved thread therefore renders its
    // root without its reply chain; the re-check walk is unaffected (a
    // reply alone never retires a blocker — the code decides).
    const comments: ReviewContextComment[] = allComments
      .filter((c) => !c.isDraft)
      .map((c) => ({
        id: c.id,
        author: aoneCommentAuthor(c.author),
        body: c.note ?? c.body ?? '',
        createdAt: c.createdAt ?? c.created_at ?? '',
        ...(c.path !== undefined ? { path: c.path } : {}),
        ...(c.line !== undefined ? { line: c.line } : {}),
        ...(c.parentNoteId !== undefined && c.parentNoteId !== null
          ? { parentId: c.parentNoteId }
          : {}),
      }));
    // Aone has no review object: no verdicts. The ledger markers ride the
    // posted summaries, which are thread-level (path-less) comments — those
    // are the carriers, shaped as verdicts for the shared recovery walk.
    const carriers: ReviewContextVerdict[] = comments
      .filter((c) => c.path === undefined)
      .map((c) => ({
        id: c.id,
        author: c.author,
        body: c.body,
        state: 'COMMENTED',
        submittedAt: c.createdAt,
      }));
    return {
      title: view.title ?? '',
      body: view.description ?? '',
      authorLogin: aoneCommentAuthor(view.author),
      state: view.state ?? '',
      baseRefName: view.targetBranch ?? 'master',
      // Under AGit-Flow the head is a bare SHA and sourceBranch carries it;
      // rendering `target ← <sha>` is truthful and informative. A
      // non-AGit-Flow MR's real branch name renders the same way. Both
      // fields route through the provider's ONE head normalization — a
      // padded server value must not diverge from the trimmed reads every
      // other subcommand reports (aoneHeadSha's docstring names the read
      // sites; this one joins them).
      headRefName: aoneHeadSha(view),
      headRefOid: aoneHeadSha(view),
      // Aone reports no diff stats; the context header degrades.
      comments,
      verdicts: [],
      ledgerCarriers: carriers,
    };
  },

  getCurrentUser(): string {
    // The seam contract: '' on the empty-output shapes, never an untagged
    // throw or a non-string leak. A literal `null` payload PARSES (the
    // cleanup audit's aoneWhoamiAccount guards the same shape); an exit-0
    // empty stdout throws inside a1Json before any guard runs, so the call
    // is wrapped; a non-string account reaching recoverLedger's
    // `.toLowerCase()` would throw into the conservative recovery strip
    // and silently lose the ledger anchor.
    try {
      const who = a1Json<{ account?: unknown } | null>('auth', 'whoami');
      return typeof who?.account === 'string' ? who.account : '';
    } catch {
      return '';
    }
  },

  composeUrl(prNumber: number, ownerRepo: string): string {
    checkOwnerRepo(ownerRepo);
    // Reader-backed by construction: an Aone MR link can NEVER be assembled
    // from owner/repo — the collapse to the last two segments names a
    // different (possibly nonexistent) repo for a nested-group project —
    // so the only source is the platform's own detailUrl. A fetch failure
    // degrades to '' — a missing link must not fail a consumer that owns
    // the post's fate — but NOT silently: every other fail-open in this
    // provider discloses on stderr, and a failing re-query (auth expiry,
    // a network blip past the retry budget) must stay distinguishable
    // from the designed coordinates-relay case.
    try {
      return mrView(prNumber, ownerRepo).detailUrl ?? '';
    } catch (err) {
      const cause = execErrorCause(err);
      process.stderr.write(
        `WARNING: the Aone MR-link lookup failed` +
          (cause ? ` (${JSON.stringify(cause.slice(0, 80))})` : '') +
          `; the Posted line degrades to the target's coordinates.\n`,
      );
      return '';
    }
  },
};

// ---------------------------------------------------------------------------
// Comment / status reads — the Aone backing for `comment-status` and
// `presubmit` (Phase 3's dedup/self-PR slice of
// docs/design/2026-08-13-review-platform-provider-abstraction.md). Aone's
// comment collection is flat (inline comments, replies, and global summary
// comments all in `mr comment list`), but the DEFAULT query excludes
// RESOLVED comments while a `--resolved` query returns the resolved root
// inline ones (measured — cleanup's bypass audit pins the same shape on
// this exact command), so listMrComments unions the two. Threading rides
// `parentNoteId`, thread state rides `closed`/`outdated`. Comments carry NO
// commit anchor — the commit_id half of GitHub's classification has no
// input here, and the consumers map around it (presubmit keys staleness on
// `outdated` instead).
// ---------------------------------------------------------------------------

/** One entry of `a1 repo mr comment list --mr <id> -f json` (the fields the
 *  consumers read; the text is in `note`, `body` stays empty on known a1
 *  versions but is tolerated). */
export interface AoneMrComment {
  id: number;
  note?: string;
  body?: string;
  path?: string;
  line?: number | null;
  /** 'right' (new side) or 'left' (old side). */
  side?: string;
  /** The discussion was resolved — a1 stamps the numeric 1 (measured;
   *  cleanup's RawAoneComment pins the same payload); a boolean stays
   *  tolerated for shape drift. */
  closed?: number | boolean;
  /** The anchor no longer maps to the live head's diff (a past amend moved
   *  the code). */
  outdated?: boolean;
  /** Set on replies; points at the thread root. */
  parentNoteId?: number | null;
  isAiComment?: boolean;
  isDraft?: boolean;
  createdAt?: string;
  created_at?: string;
  author?: unknown;
}

/** The account name an a1 payload carries, tolerant across the shapes a1
 *  emits ({username} / {account} / {login} / {name} / a bare string). ''
 *  when none is readable — the consumers' identity gates decide what an
 *  unknown account means (never a silent self-match). */
export function aoneAccountName(author: unknown): string {
  if (typeof author === 'string') return author.trim();
  if (author !== null && typeof author === 'object') {
    const o = author as Record<string, unknown>;
    for (const key of ['username', 'account', 'login', 'name']) {
      const v = o[key];
      if (typeof v === 'string' && v.trim() !== '') return v.trim();
    }
  }
  return '';
}

/** The MR's author account and live head SHA (`sourceBranch` IS the head
 *  under AGit-Flow), from ONE `mr view` fetch. One call answers both
 *  halves presubmit and comment-status need (self-PR detection /
 *  authorReplied + drift). A missing author (deleted account) reports '',
 *  which fails the self-PR comparison soft, like the GitHub path's
 *  `author: null` (#9629 consolidated here). */
export function getMrAuthorAndHead(
  prNumber: number,
  ownerRepo: string,
): { author: string; headSha: string } {
  checkOwnerRepo(ownerRepo);
  const view = mrView(prNumber, ownerRepo);
  return {
    author: aoneAccountName(view.author),
    headSha: aoneHeadSha(view),
  };
}

/** One `a1 repo mr comment list` query, shape-checked: a1 can also answer
 *  a well-formed error OBJECT with exit 0 (cleanup's a1CommentList
 *  measures the same command) — a bare `null` stays the tolerated
 *  "no comments" shape, any other non-array must surface a1's `message` as
 *  a named error, not crash `.filter` with an untagged TypeError. */
function mrCommentListQuery(...flags: string[]): AoneMrComment[] {
  const out = a1Json<AoneMrComment[] | null>(
    'repo',
    'mr',
    'comment',
    'list',
    ...flags,
  );
  if (out === null) return [];
  if (!Array.isArray(out)) {
    const cause = (out as { message?: unknown } | null)?.message;
    throw new Error(
      'a1 mr comment list returned an unexpected shape' +
        (typeof cause === 'string' && cause.trim() !== ''
          ? `: ${cause.trim()}`
          : ''),
    );
  }
  return out;
}

/** The MR's comment list (inline + replies + global): the DEFAULT query
 *  unioned with the `--resolved` query, deduped by id — the default
 *  excludes RESOLVED comments while `--resolved` returns the resolved ROOT
 *  INLINE ones (the shape cleanup's bypass audit measures and pins on this
 *  exact command); resolved replies stay invisible, a1 exposes no listing
 *  that includes them. Draft (unpublished) entries are dropped at the read
 *  site so BOTH consumers — the comment-status index and presubmit's dedup
 *  — never classify a comment nobody can see: a leftover draft in the
 *  finding shape would otherwise overlap-drop a genuinely new finding,
 *  silently withholding it. Only an explicit `true` reads as unpublished —
 *  an unreadable draft state stays in (fail toward the visible-comment
 *  reading). */
export function listMrComments(
  prNumber: number,
  ownerRepo: string,
): AoneMrComment[] {
  checkOwnerRepo(ownerRepo);
  const listed = mrCommentListQuery(
    '--mr',
    String(prNumber),
    '--repo',
    ownerRepo,
  );
  const resolved = mrCommentListQuery(
    '--mr',
    String(prNumber),
    '--repo',
    ownerRepo,
    '--resolved',
  );
  const byId = new Map<number, AoneMrComment>();
  for (const c of [...listed, ...resolved]) {
    if (typeof c.id === 'number' && !byId.has(c.id)) byId.set(c.id, c);
  }
  return [...byId.values()].filter((c) => c.isDraft !== true);
}

/** The reviewing account, as `a1 auth whoami -f json` reports it. */
export function aoneWhoami(): string {
  const out = a1Json<unknown>('auth', 'whoami');
  return aoneAccountName(out);
}

/** Locate a `checks` array in an `a1 repo mr status` answer: the top level
 *  first, then one nesting level down (a1 wraps payloads differently across
 *  subcommands). Entries that are not objects are dropped — a classifier
 *  reading a string entry as a record would report every gate as pending on
 *  a key typo, and the drop keeps the shape contract honest. `null` means
 *  NO checks array was readable — none recognizable, or a found array whose
 *  entries ALL died on that filter — distinct from a found-but-empty array,
 *  which is a real "no gates exist" statement. */
function extractStatusChecks(
  out: unknown,
): Array<Record<string, unknown>> | null {
  const containers: unknown[] = [out];
  if (out !== null && typeof out === 'object' && !Array.isArray(out)) {
    for (const v of Object.values(out as Record<string, unknown>)) {
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        containers.push(v);
      }
    }
  }
  for (const container of containers) {
    // The seed IS the payload — a bare `null` answer (the shape
    // listMrComments tolerates) must read as "no recognizable checks
    // array", not crash the loop on a property read.
    if (container === null || typeof container !== 'object') {
      continue;
    }
    const checks = (container as Record<string, unknown>)['checks'];
    if (Array.isArray(checks)) {
      const objects = checks.filter(
        (e): e is Record<string, unknown> =>
          e !== null && typeof e === 'object' && !Array.isArray(e),
      );
      // A found array the filter empties entirely is the SAME unreadable
      // gate state as no array at all — returning [] here would hand the
      // caller the all-clear shape over a shape drift.
      if (objects.length === 0 && checks.length > 0) return null;
      return objects;
    }
  }
  return null;
}

/** The MR's merge-gate / CI checks (`a1 repo mr status <id> -f json`).
 *  A found-but-empty array stays `[]` — the GitHub contract's "no CI at
 *  all" shape, which the classifier reads as `no_checks` with zero totals
 *  and does NOT downgrade. `undefined` means a1 answered but no
 *  readable `checks` array was present — none recognizable, or one every
 *  entry of which was garbage — the caller maps that unreadable gate
 *  state to pending, never to the all-clear. */
export function getMrStatusChecks(
  prNumber: number,
  ownerRepo: string,
): Array<Record<string, unknown>> | undefined {
  checkOwnerRepo(ownerRepo);
  const out = a1Json<unknown>(
    'repo',
    'mr',
    'status',
    String(prNumber),
    '--repo',
    ownerRepo,
  );
  const checks = extractStatusChecks(out);
  return checks ?? undefined;
}

// ---------------------------------------------------------------------------
// Write path — the Aone half of `qwen review submit` (Phase 3 of
// docs/design/2026-08-13-review-platform-provider-abstraction.md).
//
// Aone has no Create-Review batch API: a review is N+1 calls — one
// `a1 repo mr comment create` per inline finding, one for the summary,
// plus `a1 repo mr approve` on an APPROVE. The order is the design's Q5
// policy: inline first, summary LAST (the summary never references
// something not yet posted), so a mid-batch failure leaves a state the
// terminal report can describe exactly.
// ---------------------------------------------------------------------------

/** One inline finding as it lands on the MR. */
export interface AoneInlineComment {
  path: string;
  /**
   * The new-side line — a multi-line range posts on its END line. The
   * old side CANNOT be anchored (a1 expresses `--line` as a new-side
   * position only — probed 2026-08-21, see
   * docs/design/2026-08-21-review-aone-removed-line-anchoring.md), and
   * the platform validates NOTHING (any integer posts; a wrong number
   * lands on the same-numbered new-side line silently). submit therefore
   * validates every anchor against the captured diff and relocates the
   * unanchorable BEFORE this batch is built — nothing reaching here is
   * unvouched.
   */
  line: number;
  body: string;
}

export interface AoneSubmitRequest {
  prNumber: number;
  ownerRepo: string;
  /** The head SHA the review was composed against (GitHub's commit_id). */
  commitId: string;
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  /** The composed summary body. */
  body: string;
  comments: AoneInlineComment[];
}

export interface AoneSubmitResult {
  /** Ids of the inline comments created (only the ones a1 reported). */
  inlineCommentIds: number[];
  /** How many inline comments were created — ids are best-effort. */
  postedInline: number;
  summaryCommentId?: number;
  summaryPosted: boolean;
  /** False only when the event was APPROVE and the approve call failed. */
  approved: boolean;
  approveError?: string;
  /** True when the head moved DURING the posting batch — the pre-write
   *  drift gate is check-then-post, so an amend pushed mid-batch orphans
   *  every inline comment; the post stands but the pins may not. */
  headMovedDuringPost?: boolean;
  webUrl: string;
}

/**
 * A write that FAILED MID-BATCH. The MR already carries part of the
 * review; the structured counts keep submit's report exact, and its
 * do-not-re-run advice keeps a retry from double-posting what landed.
 *
 * `ambiguous` says the FAILED write itself may have reached the server:
 * an exec error cannot tell "refused" from "accepted, then the transport
 * died" — a1 killed by the deadline AFTER the POST committed, a
 * connection reset mid-response, an HTTP 5xx after the server wrote. The
 * comment is then live on the MR while the count says it never landed,
 * and a retry posts it twice. So an ambiguous failure is counted as
 * LANDED for the do-not-re-run advisory — overcounting by one is a
 * cosmetic lie; undercounting is a duplicate post.
 *
 * `headMovedDuringPost` carries the mid-batch drift disclosure the
 * success path re-reads for: a batch runs minutes of sequential execs,
 * and an AGit-Flow amend pushed mid-batch orphans the landed pins at
 * code the author already replaced. Undefined when the re-read itself
 * failed — "could not verify" is not "verified stable", but it also
 * must not mask the post failure.
 */
export class AonePartialPostError extends Error {
  constructor(
    message: string,
    readonly postedInline: number,
    readonly inlineCommentIds: number[],
    readonly summaryPosted: boolean,
    readonly ambiguous: boolean = false,
    readonly headMovedDuringPost?: boolean,
  ) {
    super(message);
    this.name = 'AonePartialPostError';
  }
}

/** The created comment's id, read back best-effort — shapes tolerated:
 *  `{id}`, or one level nested (`{comment|note|result|data: {id}}`). The
 *  id feeds the failure report and tomorrow's audit; a miss degrades to
 *  "posted, id unknown", never to a failed submit. */
function createdCommentId(out: unknown): number | undefined {
  if (out === null || typeof out !== 'object') return undefined;
  const o = out as Record<string, unknown>;
  if (typeof o['id'] === 'number') return o['id'];
  for (const key of ['comment', 'note', 'result', 'data']) {
    const nested = o[key];
    if (nested !== null && typeof nested === 'object') {
      const id = (nested as Record<string, unknown>)['id'];
      if (typeof id === 'number') return id;
    }
  }
  return undefined;
}

function createMrComment(
  prNumber: number,
  ownerRepo: string,
  message: string,
  inline?: { path: string; line: number },
): number | undefined {
  // No AI-comment marking here, BY PLATFORM CONSTRAINT: probed 2026-08-21
  // on a scratch CR (issue #9614) — `comment create` does NOT auto-set
  // `isAiComment` for the posting identity (both a general and an inline
  // probe read back false, re-checked minutes later against an async
  // classifier), and a1 v0.1.90 exposes no flag to request it. Created
  // comments therefore sit in the generic discussion gate, never the
  // dedicated ai_comment merge gate; submit's REQUEST_CHANGES note
  // discloses that. When a1 ships a marking flag, THIS call is where it
  // gets passed.
  // a1JsonOnce is the tolerant read-back: an exec FAILURE propagates (a real
  // post failure — the partial-post path counts what landed before it), but a
  // SUCCEEDED exec whose answer does not parse is "accepted, id unknown", not
  // a failure. Throwing on the parse miss would undercount the partial-post
  // report by exactly this comment and, if it was the first, suppress the
  // do-not-re-run advisory altogether (see aone-client.ts).
  const out = a1JsonOnce<unknown>(
    'repo',
    'mr',
    'comment',
    'create',
    '--mr',
    String(prNumber),
    '--repo',
    ownerRepo,
    ...(inline ? ['--file', inline.path, '--line', String(inline.line)] : []),
    '--message',
    message,
  );
  return createdCommentId(out);
}

/** The cause of an a1 failure for a terminal report — the one line the
 *  user reads, capped so a kilobyte stack trace never lands there. */
function a1Cause(err: unknown): string {
  const e = err as Error & {
    stderr?: Buffer | string;
    status?: number;
    signal?: string;
  };
  const firstLine = (text: string): string | undefined =>
    text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .find(Boolean);
  // The message an execFileSync failure raises is NEVER a text source
  // here: its first line is the "Command failed: a1 …" preamble, and Node
  // embeds the FULL argv in that preamble — for a comment create, the
  // ENTIRE multi-line comment body. a1's real error rides the captured
  // `stderr` property. An empty-stderr failure (the 120 s deadline kill
  // — aone-client's own note: "usually no stderr" — SIGKILL/OOM, an a1
  // crash before writing) has no trustworthy text source at all, so the
  // fallback reports the EXIT FACTS, never the message: parsing it would
  // quote a line of the operator's own review text as the "cause".
  const stderr = e.stderr === undefined ? undefined : String(e.stderr);
  const cause =
    (stderr === undefined ? undefined : firstLine(stderr)) ??
    `a1 failed without stderr` +
      (typeof e.status === 'number' ? ` (exit ${e.status})` : '') +
      (e.signal ? ` (signal ${e.signal})` : '');
  return cause.length > 300 ? `${cause.slice(0, 300)}…` : cause;
}

/** The post-batch head re-read, stated ONCE for both disclosure paths:
 *  did the MR head move away from the composed `commitId`? Undefined when
 *  the re-read itself failed OR came back without a head to compare —
 *  "could not verify" is not "verified stable", and either shape
 *  degrades to unknown; it never masks the outcome it reports on (the
 *  post failure on the partial path, the post itself on the success
 *  path). */
function headMovedSinceCompose(
  prNumber: number,
  ownerRepo: string,
  commitId: string,
): boolean | undefined {
  try {
    const afterHead = aoneHeadSha(mrView(prNumber, ownerRepo));
    if (afterHead === '') return undefined;
    return afterHead !== commitId;
  } catch {
    return undefined;
  }
}

/**
 * Post a composed review to an Aone MR. The verdict mapping is the
 * design's D6: APPROVE runs the native `mr approve` AFTER the summary
 * lands; COMMENT is the summary alone; REQUEST_CHANGES has NO native
 * equivalent — the summary carries an explicit blocking header, and the
 * unresolved inline Criticals carry the blocking semantics through the
 * discussion merge gate (NEVER the ai_comment gate: a1 cannot mark a
 * comment as AI — see createMrComment).
 *
 * Throws BEFORE writing when the head drifted (the commit_id check
 * GitHub's API performs server-side). Throws AonePartialPostError when
 * a write fails mid-batch; an approve failure alone does NOT throw —
 * the review is fully posted, only the native approval is missing, and
 * the result says so.
 */
export function submitAoneReview(req: AoneSubmitRequest): AoneSubmitResult {
  checkOwnerRepo(req.ownerRepo);
  ensureAoneAuthenticated();

  const view = mrView(req.prNumber, req.ownerRepo);
  // a1 comments carry no commit anchor — the drift gate GitHub's Create
  // Review API enforces server-side (422 on a moved commit_id) lives
  // here. Under AGit-Flow an update AMENDS the single commit: posting a
  // review composed against the orphaned head would pin every inline
  // comment at code the author already replaced. An empty sourceBranch
  // cannot gate — nothing to compare against — and posts unanchored.
  const liveHead = aoneHeadSha(view);
  if (liveHead !== '' && liveHead !== req.commitId) {
    throw new Error(
      `refusing to post: the MR head moved — the review was composed ` +
        `against ${req.commitId}, but the live head is ${liveHead}. ` +
        `Re-review the new head before posting.`,
    );
  }

  // a1 takes the whole comment body as ONE argv element, and Linux caps a
  // single element at MAX_ARG_STRLEN = 131072 BYTES (not characters).
  // compose-review's BODY_MAX_CHARS is 65536 *characters* — a limit written
  // for GitHub and counted in chars — a CJK character is 3 bytes in UTF-8,
  // and a bilingual body folds the full Chinese copy in again. A long
  // Chinese review therefore sits comfortably inside the composer's cap and
  // outside the OS argv limit: the summary create — deliberately LAST —
  // would die with E2BIG only after every inline comment already landed,
  // stranding the MR with blockers and no verdict. Guard every message up
  // front so the batch refuses WHOLE, before anything posts. (The GitHub
  // branch streams over stdin precisely to dodge this; a1 has no stdin or
  // file input for `--message`, so a size gate is the honest substitute.)
  const A1_ARG_MAX_BYTES = 131072;
  const summaryMessage =
    req.event === 'REQUEST_CHANGES'
      ? `**Request changes**\n\n${req.body}`
      : req.body;
  const oversized = [
    ...req.comments.map((c, i) => ({
      what: `inline comment ${i + 1} (${c.path}:${c.line})`,
      text: c.body,
    })),
    { what: 'the summary comment', text: summaryMessage },
  ].find((m) => Buffer.byteLength(m.text, 'utf8') >= A1_ARG_MAX_BYTES);
  if (oversized) {
    throw new Error(
      `refusing to post: ${oversized.what} is ` +
        `${Buffer.byteLength(oversized.text, 'utf8')} bytes — over the ` +
        `${A1_ARG_MAX_BYTES}-byte single-argument limit a1 must pass it ` +
        `as. Nothing was written; the findings are in the terminal ` +
        `output and the saved report, and the USER can post them by ` +
        `hand — hand-posting is never an agent action.`,
    );
  }

  const postedIds: Array<number | undefined> = [];
  let summaryPosted = false;
  let summaryCommentId: number | undefined;
  try {
    for (const c of req.comments) {
      postedIds.push(
        createMrComment(req.prNumber, req.ownerRepo, c.body, {
          path: c.path,
          line: c.line,
        }),
      );
    }
    // An empty summary posts nothing: `-m ''` is refused by a1, and an
    // empty summary comment would be noise. Guard on the MESSAGE actually
    // posted (`summaryMessage`), not the raw body — on REQUEST_CHANGES the
    // blocking header is prepended, so a header-only summary still posts
    // even when the composed body is empty (which compose-review produces
    // today: C≥1 with inline-only Criticals → RC with body ''). The same
    // `summaryMessage` is what the size gate above measures — one view of
    // the decision, not two. (For COMMENT/APPROVE, summaryMessage ===
    // req.body, so an empty body still skips.)
    if (summaryMessage.trim() !== '') {
      summaryCommentId = createMrComment(
        req.prNumber,
        req.ownerRepo,
        summaryMessage,
      );
      summaryPosted = true;
    }
  } catch (err) {
    // Every error that reaches here is a write's EXEC failure — parse
    // misses are tolerated one layer down and never throw. An exec
    // failure cannot distinguish "refused" from "accepted, then the
    // transport died", so the failing write may ALREADY be live on the
    // MR even though the count never saw it: mark the failure ambiguous
    // so submit's do-not-re-run advisory fires regardless of the count.
    const ids = postedIds.filter((n): n is number => typeof n === 'number');
    // State the summary's fate explicitly when it was the write that died:
    // "N of N inline comment(s) landed" alone reads as a complete review,
    // but the verdict carrier (the blocking header on a Request changes)
    // is then absent from the MR — the one fact remainder-completion needs.
    const summaryFate =
      !summaryPosted && postedIds.length === req.comments.length
        ? `; the summary did NOT land`
        : '';
    // The same mid-batch drift disclosure the success path carries: an
    // amend pushed during the batch orphans the landed pins, and a write
    // failure must not silently drop the warning.
    throw new AonePartialPostError(
      `posting to MR ${req.prNumber} of ${req.ownerRepo} failed after ` +
        `${postedIds.length} of ${req.comments.length} inline comment(s)` +
        `${summaryPosted ? ' and the summary' : ''} landed` +
        `${summaryFate}: ` +
        a1Cause(err),
      postedIds.length,
      ids,
      summaryPosted,
      true,
      headMovedSinceCompose(req.prNumber, req.ownerRepo, req.commitId),
    );
  }

  let approved = false;
  let approveError: string | undefined;
  if (req.event === 'APPROVE') {
    try {
      a1Once(
        'repo',
        'mr',
        'approve',
        String(req.prNumber),
        '--repo',
        req.ownerRepo,
      );
      approved = true;
    } catch (err) {
      // Not a failed review — inline + summary are posted; only the
      // native approval is missing. Report it and let the user re-run
      // the one missing command.
      approveError = a1Cause(err);
    }
  }

  return {
    inlineCommentIds: postedIds.filter(
      (n): n is number => typeof n === 'number',
    ),
    postedInline: postedIds.length,
    summaryCommentId,
    summaryPosted,
    approved,
    approveError,
    // The drift gate above is check-then-post; the batch is N+1 sequential
    // execs (minutes for a long review), so a head that moves DURING it
    // slips the gate — re-read once and disclose; the success report must
    // not claim the pins held, and a read failure must not fail the post.
    headMovedDuringPost: headMovedSinceCompose(
      req.prNumber,
      req.ownerRepo,
      req.commitId,
    ),
    webUrl: view.detailUrl ?? '',
  };
}
