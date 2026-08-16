/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Provider registry + detection. The platform is chosen from (in order) a
// `--host` whose host is an Aone host, a remote URL whose host is an Aone
// host, an explicit NON-Aone host/remote (beats the cwd probe), the current
// clone's origin remote, and finally GitHub. Detection is read-only and never
// throws — an unreadable origin simply falls through to GitHub. (There is no
// `--platform` flag; an explicit `--host` is the practical override.)

import { execFileSync } from 'node:child_process';
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
  const h = host.toLowerCase().replace(/:\d+$/, '');
  return (
    h === 'gitlab.alibaba-inc.com' ||
    h === 'code.alibaba-inc.com' ||
    h.endsWith('.alibaba-inc.com')
  );
}

/** scheme://[user@]host/… or [user@]host:path → host. */
function hostOfRemoteUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  // URL form first: scheme://[user@]host/…
  const u = /^[a-z+]+:\/\/(?:[^@/]+@)?([^:/]+)[:/]/i.exec(url);
  if (u) return u[1].toLowerCase();
  // scp-like: [user@]host:path — user@ optional and may itself carry a colon
  // (token-bearing `oauth2:SECRET@host:…` from ssh-config / `url.insteadOf`).
  // `(?!\/\/)` keeps a scheme URL out of this branch; a plain local path has
  // no host:path shape. Mirrors aone.parseRemoteUrl / remote-match.
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/.exec(url);
  if (scp) return scp[1].toLowerCase();
  return undefined;
}

/** The cwd clone's origin URL, or undefined when unreadable / not a repo. */
function cwdOriginUrl(): string | undefined {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

export function detectPlatformKind(hint?: PlatformHint): PlatformKind {
  // Trim the hint host: isAoneHost lowercases and strips a port but does not
  // trim, and padded hosts are a known-good input class (setGhHost trims).
  const hintHost = hint?.host?.trim();
  if (isAoneHost(hintHost)) return 'aone';
  if (isAoneHost(hostOfRemoteUrl(hint?.remoteUrl))) return 'aone';
  // An explicit NON-Aone host/remote is a positive GitHub signal — it must
  // win over the cwd probe, or an explicitly-GitHub-targeted subcommand run
  // from an Aone clone would be hijacked to Aone. Before this seam existed
  // these flows were cwd-independent (always GitHub).
  if (hintHost || hint?.remoteUrl) return 'github';
  // No explicit signal: fall back to the cwd clone's origin.
  if (isAoneHost(hostOfRemoteUrl(cwdOriginUrl()))) return 'aone';
  return 'github';
}

export function getPlatformReader(hint?: PlatformHint): ReviewPlatformReader {
  return detectPlatformKind(hint) === 'aone' ? aoneReader : githubReader;
}
