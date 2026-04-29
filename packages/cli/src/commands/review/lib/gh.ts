/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Thin wrapper around the GitHub CLI (`gh`) for the `qwen review`
// subcommands. All callers go through `execFileSync` (no shell) so quoting
// and escaping is consistent across macOS, Linux, and Windows.

import { execFileSync } from 'node:child_process';

/** Run `gh` with args. Returns stdout, trimmed and CRLF-normalised. */
export function gh(...args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8' })
    .replace(/\r\n/g, '\n')
    .trim();
}

/**
 * Run `gh api <path>` (optionally with `--jq <expr>`) and JSON-parse the
 * result. Returns null when the response is empty (e.g. 204 / no content).
 */
export function ghApi(path: string, jq?: string): unknown {
  const args = ['api', path];
  if (jq) args.push('--jq', jq);
  const out = gh(...args);
  return out ? JSON.parse(out) : null;
}

/** Login of the currently authenticated GitHub user. */
export function currentUser(): string {
  return gh('api', 'user', '--jq', '.login');
}

/**
 * Verify `gh` is installed and authenticated. Throws a clear error if not —
 * subcommands call this first so missing-auth failures don't show up as
 * cryptic 401s mid-run.
 */
export function ensureAuthenticated(): void {
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'pipe' });
  } catch {
    throw new Error(
      'gh CLI is not authenticated. Run `gh auth login` and retry.',
    );
  }
}
