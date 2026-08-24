/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Matching a PR's owner/repo against `git remote -v`, extracted from the
// /review skill's Step 1 prose and given tests, because the prose shipped
// two bugs: a substring comparison that matched `shao/qwen-code` against a
// `wenshao/qwen-code` remote (review one repository, post to another), and
// hand-guessed remote names that stopped a review before it read any code.
// The rule is exact segment equality, case-insensitive, on the URL's host,
// owner and repo — nothing else is a match.

export interface RemoteIdentity {
  host: string;
  owner: string;
  repo: string;
  /**
   * The FULL normalized path (`group/subgroup/project`) when the remote URL
   * carries three or more segments — the collapse to owner/repo is
   * non-injective, and matchRemotes compares every segment when both sides
   * carry a path. Two-segment remotes repeat `owner/repo` here.
   */
  groupPath: string;
}

/** Lowercase and strip one trailing `.git`, the normal form comparison runs in. */
export function normalizeSegment(value: string): string {
  const v = value.toLowerCase();
  return v.endsWith('.git') ? v.slice(0, -4) : v;
}

// Aone's CR URLs use the WEB host while a clone's remote uses the GIT host —
// the same platform under two names. Treat them as one equivalence class so a
// `…/codereview/<id>` target (web host) matches its clone's remote (git host).
const AONE_HOSTS = new Set(['code.alibaba-inc.com', 'gitlab.alibaba-inc.com']);

/** The ONE host spelling normalization: a port, one trailing dot (FQDN
 *  form), and case all spell the same DNS name. Both host predicates route
 *  through it so the authorisation gate and the write router can never
 *  normalize differently — the CR-URL grammar keeps `(?::\d+)?` inside the
 *  host capture, so a predicate that skipped this refused
 *  `code.alibaba-inc.com:443` against the skill-mandated
 *  `gitlab.alibaba-inc.com` after the whole review ran. */
function normalizeHostSpelling(host: string): string {
  return host.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
}

/** Hosts compare equal when identical, or both are an Aone web/git alias. */
export function hostsEquivalent(a: string, b: string): boolean {
  const na = normalizeHostSpelling(a);
  const nb = normalizeHostSpelling(b);
  if (na === nb) return true;
  return AONE_HOSTS.has(na) && AONE_HOSTS.has(nb);
}

/** The CANONICAL Aone hosts, normalized through the shared spelling helper
 *  — but strict: no `.alibaba-inc.com` wildcard. Write routing keys on
 *  THIS, not the family: a bare `*.alibaba-inc.com` suffix also names
 *  GitHub Enterprise instances (an org's `ghe.alibaba-inc.com`), and an
 *  irreversible public write must not select the a1 path on a family
 *  resemblance. */
export function isAoneCanonicalHost(host: string | undefined): boolean {
  if (!host) return false;
  return AONE_HOSTS.has(normalizeHostSpelling(host));
}

/** Hosts that count as the Aone platform family — one canonical predicate,
 *  shared by every guard that asks "is this origin on Aone" (registry
 *  detection and aone.fetchDiff's origin guard both key on it). Normalizes
 *  the way a remote URL can spell the same DNS name: a port, one trailing
 *  dot (FQDN form), and case — so a dotted-spelling clone cannot pass
 *  detection and then be refused by a gate that normalized differently. */
export function isAoneHostFamily(host: string | undefined): boolean {
  if (!host) return false;
  const h = host.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  return (
    h === 'gitlab.alibaba-inc.com' ||
    h === 'code.alibaba-inc.com' ||
    h.endsWith('.alibaba-inc.com')
  );
}

/**
 * Parse one remote URL into its host / owner / repo, or null when it is
 * neither of the two shapes `git remote -v` prints for a GitHub-style host —
 * `git@<host>:<owner>/<repo>(.git)` and `https://<host>/<owner>/<repo>(.git)`
 * — nor the `ssh://` spelling of the first. Two-or-more path segments collapse
 * to the LAST two (nested-group repos, e.g. Aone `group/subgroup/project`);
 * a local path, a scheme-less name without a `host:path` shape, or a bundle
 * file is not a candidate and never matches. Host comparison at the call site
 * runs through `hostsEquivalent` (Aone web/git alias), not raw equality.
 */
export function parseRemoteUrl(raw: string): RemoteIdentity | null {
  const url = raw.trim();
  if (url === '') return null;

  let host: string;
  let pathPart: string;

  const schemeIdx = url.indexOf('://');
  if (schemeIdx !== -1) {
    // https://<host>/<owner>/<repo>(.git), ssh://git@<host>/<owner>/<repo>.git
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.hostname === '') return null;
    host = parsed.hostname;
    pathPart = parsed.pathname;
  } else {
    // The scp-like shape `[user@]<host>:<owner>/<repo>` — the colon must
    // come before the first slash, which is also what rejects local paths
    // (`/srv/git/x.git`, `C:\repo`) and bare names.
    const colonIdx = url.indexOf(':');
    const slashIdx = url.indexOf('/');
    if (colonIdx === -1 || slashIdx === -1 || colonIdx > slashIdx) {
      return null;
    }
    host = url.slice(0, colonIdx);
    const atIdx = host.lastIndexOf('@');
    if (atIdx !== -1) host = host.slice(atIdx + 1);
    pathPart = url.slice(colonIdx + 1);
  }

  const segments = pathPart
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (segments.length < 2) return null;
  if (host === '') return null;

  // Nested-group repos (e.g. Aone `group/subgroup/project`) collapse to the
  // last two segments for the owner/repo fields — otherwise every
  // nested-group clone fails to match and the worktree flow is unreachable.
  // GitHub remotes are always exactly two segments, so this is a no-op
  // there. The FULL path rides `groupPath`: the collapse is non-injective
  // (two different nested groups can share their last two segments), and
  // matchRemotes compares every segment when both sides carry a path.
  return {
    host: host.toLowerCase(),
    owner: normalizeSegment(segments[segments.length - 2]),
    repo: normalizeSegment(segments[segments.length - 1]),
    groupPath: segments.map(normalizeSegment).join('/'),
  };
}

export interface RemoteMatchInput {
  owner: string;
  repo: string;
  /** Defaults to `github.com` — a PR URL's host, or github.com for bare numbers. */
  host?: string;
  /**
   * The target's FULL group path when its URL grammar carries one (Aone
   * nested groups). When BOTH sides have three or more segments the match
   * compares every segment — the owner/repo collapse alone is non-injective
   * and would match a different group's same-named repo.
   */
  groupPath?: string;
}

export interface RemoteMatchOutcome {
  /** Remote names whose FETCH url is an exact-segment match, in `git remote -v` order. */
  matched: string[];
}

/**
 * Match an owner/repo/host against the raw output of `git remote -v`.
 *
 * Only `(fetch)` lines count: `fetch-pr` fetches `pull/<n>/head` through the
 * remote's fetch URL, and a remote whose push URL alone pointed at the repo
 * could not serve it. A remote appears twice (fetch and push); matching the
 * fetch lines alone also dedupes.
 */
export function matchRemotes(
  remoteVOutput: string,
  { owner, repo, host = 'github.com', groupPath }: RemoteMatchInput,
): RemoteMatchOutcome {
  const wantOwner = normalizeSegment(owner);
  const wantRepo = normalizeSegment(repo);
  // The full-path comparison's want side: only a three-or-more-segment
  // target path carries identity the collapse loses — a two-segment want
  // (GitHub URLs, bare numbers) keeps the last-two-segment rule.
  const wantPath = groupPath
    ? groupPath.split('/').filter(Boolean).map(normalizeSegment)
    : undefined;
  // A PR URL's host can carry an explicit port (parse-args' PR_URL_RE keeps
  // it, lib/gh.ts' HOSTNAME_RE accepts it), but a parsed remote host never
  // does — compare the hostname part only, or a port-bearing GHE review
  // could never match its own remote.
  const wantHost = normalizeSegment(host.replace(/:\d+$/, ''));

  const matched: string[] = [];

  for (const line of remoteVOutput.split('\n')) {
    const trimmed = line.trim();
    // A partial clone's fetch entry carries git's filter annotation AFTER
    // the marker — `<name>\t<url> (fetch) [blob:none]` — so the gate
    // cannot anchor on `(fetch)` alone or that remote is silently lost.
    if (trimmed === '' || !/\(fetch\)(\s+\[[^\]]*\])?$/.test(trimmed)) {
      continue;
    }
    // `<name>\t<url> (fetch)` plus that optional trailing annotation — the
    // name never contains whitespace, so the first run of non-space
    // characters is the name and the URL sits between it and the marker.
    const nameMatch = trimmed.match(
      /^(\S+)\s+(.*)\s+\(fetch\)(\s+\[[^\]]*\])?$/,
    );
    if (!nameMatch) continue;
    const identity = parseRemoteUrl(nameMatch[2]);
    if (identity === null) continue;
    if (!hostsEquivalent(identity.host, wantHost)) continue;
    // Repository identity: when the target carries its FULL group path,
    // compare EVERY segment EXACTLY — in both directions. The last-two
    // collapse is non-injective, and neither direction is safe: a
    // three-or-more-segment target matched against a two-segment remote
    // (or the reverse) is a DIFFERENT project that happens to share its
    // tail — exactly the review-one-repo-post-to-another hazard this
    // module exists to prevent. Only a target WITHOUT a path (GitHub
    // URLs, bare numbers) keeps the last-two rule.
    const remotePath = identity.groupPath.split('/');
    const sameRepo =
      wantPath !== undefined
        ? wantPath.length === remotePath.length &&
          wantPath.every((seg, i) => seg === remotePath[i])
        : identity.owner === wantOwner && identity.repo === wantRepo;
    if (sameRepo) {
      matched.push(nameMatch[1]);
    }
  }

  return { matched };
}
