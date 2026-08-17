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
import { aoneReader } from './aone.js';
import { githubReader } from './github.js';
import type { PlatformKind, ReviewPlatformReader } from './types.js';

/** A hint the caller already has about which platform the target lives on. */
export interface PlatformHint {
  /** A `--host` flag or a host discovered elsewhere. */
  host?: string;
  /** A git remote URL (e.g. the `--remote` under review). */
  remoteUrl?: string;
}

/** Hosts that identify Aone Code (web host + git host). */
export function isAoneHost(host: string | undefined): boolean {
  if (!host) return false;
  // Strip a port and one trailing dot: the trailing-dot FQDN spelling
  // (`code.alibaba-inc.com.`) is DNS-identical to the plain host, and the
  // URL grammar admits it — without this it slips past every guard that
  // keys on isAoneHost while its CR-form twin is refused fail-closed.
  const h = host.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  return (
    h === 'gitlab.alibaba-inc.com' ||
    h === 'code.alibaba-inc.com' ||
    h.endsWith('.alibaba-inc.com')
  );
}

/** scheme://[user@]host/… or [user@]host:path → host. */
function hostOfRemoteUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  // Query/fragment first: they can carry credentials AND `@`, and neither
  // belongs to the authority the host is read from.
  const s = url.trim().replace(/[?#][\s\S]*$/, '');
  if (/^[a-z+]+:\/\//i.test(s)) {
    // URL form. The userinfo consumption is GREEDY — up to the last `@`
    // that still leaves a host shape — because token-bearing CI origins
    // put `:` AND `/` inside the secret (`https://oauth2:abc/def@host/…`),
    // and a bounded `(?:[^@/]+@)?` capture would parse the credential
    // prefix as the host, silently misrouting detection. Mirrors
    // aone.parseRemoteUrl's cleaning.
    const stripped = s.replace(/^([a-z+]+:\/\/)[\s\S]*@(?=[^:@/]+[:/])/i, '$1');
    const u = /^[a-z+]+:\/\/([^:/?#]+)/i.exec(stripped);
    return u ? u[1].toLowerCase() : undefined;
  }
  // scp-like: [user@]host:path — userinfo may contain `:` and `/`; consume
  // up to the last `@` that leaves a `host:` shape. A plain local path has
  // no host:path shape. Mirrors aone.parseRemoteUrl / remote-match.
  const stripped = s.replace(/^(?:[\s\S]*@)(?=[^:@/]+:)/, '');
  const scp = /^([^:/]+):(?!\/\/)/.exec(stripped);
  return scp ? scp[1].toLowerCase() : undefined;
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
