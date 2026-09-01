/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';

// Sidebar search matches git context beyond the label: PR number and the
// numbers of the issues a bound PR closes (with or without '#'), branch name,
// and worktree slug. `query` must already be lowercased.
export function sessionMatchesGitQuery(
  session: DaemonSessionSummary,
  query: string,
): boolean {
  const matchesNumber = (number: number): boolean =>
    query === String(number) || query === `#${number}`;
  for (const pr of session.prs ?? []) {
    if (matchesNumber(pr.number)) return true;
    if ((pr.issues ?? []).some((issue) => matchesNumber(issue.number))) {
      return true;
    }
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
