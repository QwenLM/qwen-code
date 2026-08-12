/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Qualify a local branch name from the daemon's branch listing into the exact
 * ref to diff or check out. The listing uses `%(refname:short)`, which git
 * LENGTHENS when the short name is ambiguous (branch `release` + tag
 * `release` → `heads/release`), so blindly re-prefixing would synthesize a
 * non-existent double-prefixed ref like `refs/heads/heads/release`.
 */
export function qualifyLocalBranchRef(name: string): string {
  if (name.startsWith('refs/heads/')) return name;
  if (name.startsWith('heads/')) return `refs/${name}`;
  return `refs/heads/${name}`;
}

/** Same disambiguation for remote-tracking names (`remotes/…` lengthening). */
export function qualifyRemoteBranchRef(name: string): string {
  if (name.startsWith('refs/remotes/')) return name;
  if (name.startsWith('remotes/')) return `refs/${name}`;
  return `refs/remotes/${name}`;
}

/** Strip the namespace/disambiguation prefix for display. */
export function displayBranchName(name: string): string {
  for (const prefix of ['refs/heads/', 'refs/remotes/', 'heads/', 'remotes/']) {
    if (name.startsWith(prefix)) return name.slice(prefix.length);
  }
  return name;
}
