/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Provider registry + detection. The platform is chosen from (in order) a
// `--host` whose host is an Aone host, an explicit NON-Aone `--host` (a
// host flag outranks the remote-URL hint in BOTH directions), a remote URL
// whose host is an Aone host, an explicit NON-Aone remote (beats the cwd
// probe), the current clone's origin remote, and finally GitHub. Detection
// is read-only and never throws — an unreadable origin simply falls through
// to GitHub. (There is no `--platform` flag; an explicit `--host` is the
// practical override.)

import { gitOpt } from '../git.js';
import { isAoneHostFamily } from '../remote-match.js';
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

/** Hosts that identify Aone Code (web host + git host). Delegates to the
 *  canonical remote-match predicate so every Aone-family gate normalizes
 *  identically (port, trailing-dot FQDN spelling, case) — a dotted-spelling
 *  clone that passes detection cannot be refused by a downstream gate that
 *  normalized differently. */
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
  // Trim the hint host: isAoneHost lowercases and strips a port but does not
  // trim, and padded hosts are a known-good input class (setGhHost trims).
  const hintHost = hint?.host?.trim();
  if (isAoneHost(hintHost)) return 'aone';
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
  if (isAoneHost(hostOfRemoteUrl(hint?.remoteUrl))) return 'aone';
  // An explicit NON-Aone remote is a positive GitHub signal — it must win
  // over the cwd probe, or an explicitly-GitHub-targeted subcommand run
  // from an Aone clone would be hijacked to Aone. Before this seam existed
  // these flows were cwd-independent (always GitHub).
  if (hint?.remoteUrl) return 'github';
  // No explicit signal: fall back to the cwd clone's origin.
  if (isAoneHost(hostOfRemoteUrl(cwdOriginUrl()))) return 'aone';
  return 'github';
}

export function getPlatformReader(hint?: PlatformHint): ReviewPlatformReader {
  return detectPlatformKind(hint) === 'aone' ? aoneReader : githubReader;
}
