/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Provider registry + detection. The platform is chosen from (in order) a
// `--host` on the CANONICAL Aone pair, an explicit NON-Aone `--host` (a
// host flag outranks the remote-URL hint in BOTH directions), a remote URL
// on the canonical pair, an explicit NON-Aone remote (beats the cwd
// probe), the current clone's origin remote (the FAMILY predicate — the
// one place a non-canonical `*.alibaba-inc.com` host still reads as
// Aone), and finally GitHub. An explicit family-but-not-canonical host is
// a GHE instance and stays GitHub. Detection is read-only and never throws
// — an unreadable origin simply falls through to GitHub. (There is no
// `--platform` flag; an explicit `--host` is the practical override.)

import { gitOpt } from '../git.js';
import { isAoneCanonicalHost, isAoneHostFamily } from '../remote-match.js';
import { aoneReader, parseRemoteUrl } from './aone.js';
import { githubReader } from './github.js';
import type { PlatformKind, ReviewPlatformReader } from './types.js';

/** A hint the caller already has about which platform the target lives on. */
export interface PlatformHint {
  /** A `--host` flag or a host discovered elsewhere. */
  host?: string;
  /** A git remote URL (e.g. the `--remote` under review). */
  remoteUrl?: string;
}

/** Hosts that identify Aone Code on the FAMILY predicate — the canonical
 *  web/git pair PLUS any `*.alibaba-inc.com` host. This is the NO-EXPLICIT-
 *  SIGNAL fallback predicate (the cwd origin probe) only: an EXPLICIT host
 *  or remote on a family host that is NOT the canonical pair is a GitHub
 *  Enterprise instance (`ghe.alibaba-inc.com` is the live example the write
 *  gate already refuses the family for), and routing its reads at a1 would
 *  authenticate against the wrong platform and fetch an unrelated
 *  same-numbered MR. Delegates to the remote-match predicates so every
 *  Aone gate normalizes identically (port, trailing-dot FQDN spelling,
 *  case) — a dotted-spelling clone that passes detection cannot be refused
 *  by a downstream gate that normalized differently. */
export function isAoneHost(host: string | undefined): boolean {
  return isAoneHostFamily(host);
}

/** scheme://[user@]host/… or [user@]host:path → host. DELEGATES to the
 *  canonical aone.parseRemoteUrl — detection and the identity parser must
 *  read the SAME grammar, or a shape one accepts the other refuses
 *  misroutes silently (a `?`-bearing userinfo once detected 'github' while
 *  the canonical parser said Aone). One parser, one source of truth. */
function hostOfRemoteUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  return parseRemoteUrl(url)?.host;
}

/** The cwd clone's origin URL, or undefined when unreadable / not a repo.
 *  Delegates to lib/git's `gitOpt` — the subsystem's shared git policy
 *  (`GIT_TERMINAL_PROMPT=0`, the shared timeout, fresh per call) — instead
 *  of forking its own probe options. */
function cwdOriginUrl(): string | undefined {
  return gitOpt('remote', 'get-url', 'origin') ?? undefined;
}

export function detectPlatformKind(hint?: PlatformHint): PlatformKind {
  // Trim the hint host: the predicates lowercase and strip a port but do not
  // trim, and padded hosts are a known-good input class (setGhHost trims).
  // EXPLICIT signals (a --host flag, a --remote URL) select Aone only on
  // the CANONICAL pair: the caller named the host, and a non-canonical
  // `*.alibaba-inc.com` name is a GHE instance, not Aone — the family
  // wildcard here would authenticate the review against the wrong platform
  // and read an unrelated same-numbered MR (the review skill always passes
  // --host, so this arm is the one the GHE PRs ride).
  const hintHost = hint?.host?.trim();
  if (isAoneCanonicalHost(hintHost)) return 'aone';
  // An EXPLICIT host flag outranks the remote-URL hint — in both
  // directions. fetch-pr threads both hints (the review remote's URL and
  // the caller's --host), and a remoteUrl-first order let an Aone origin
  // hijack an explicitly-GitHub invocation: because MR ids are global, the
  // hijack can SUCCEED — building the worktree/diff from an unrelated MR
  // head under the caller's label. The explicit host failing loudly with a
  // refspec the other remote cannot serve is strictly safer than silent
  // wrong evidence. (The flag's describe text makes the same promise: it
  // "selects the platform".)
  if (hintHost) return 'github';
  // Same canonical-only rule for an explicit remote: a family-only remote
  // is a GHE clone, and its refs are GitHub-shaped.
  if (isAoneCanonicalHost(hostOfRemoteUrl(hint?.remoteUrl))) return 'aone';
  // An explicit NON-Aone remote is a positive GitHub signal — it must win
  // over the cwd probe, or an explicitly-GitHub-targeted subcommand run
  // from an Aone clone would be hijacked to Aone. Before this seam existed
  // these flows were cwd-independent (always GitHub).
  if (hint?.remoteUrl) return 'github';
  // No explicit signal: fall back to the cwd clone's origin, where the
  // FAMILY predicate stands — an origin the user did not name explicitly is
  // the one place a non-canonical Aone-family host still reads as Aone.
  if (isAoneHost(hostOfRemoteUrl(cwdOriginUrl()))) return 'aone';
  return 'github';
}

export function getPlatformReader(hint?: PlatformHint): ReviewPlatformReader {
  return detectPlatformKind(hint) === 'aone' ? aoneReader : githubReader;
}
