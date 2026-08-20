/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';

// Sidebar search matches git context beyond the label: PR number (with or
// without '#'), branch name, and worktree slug. `query` must already be
// lowercased.
export function sessionMatchesGitQuery(
  session: DaemonSessionSummary,
  query: string,
): boolean {
  const prs = session.prs ?? [];
  for (const pr of prs) {
    const prText = String(pr.number);
    if (query === prText || query === `#${prText}`) return true;
  }
  const candidates = [
    session.branch?.name,
    session.worktree?.branch,
    session.worktree?.slug,
  ];
  return candidates.some(
    (candidate) =>
      candidate !== undefined && candidate.toLowerCase().includes(query),
  );
}
