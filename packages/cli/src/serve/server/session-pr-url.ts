/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Identity of a PR url as `host/owner/repo` plus number, tolerant of the
 * spellings the bind path accepts (`www.`, `http:`, a `/files` suffix,
 * case). Wider than `canonicalSessionPrUrl` on purpose: same-PR identity
 * everywhere else (re-binds, the sidecar's write gate, the session-list
 * merge) keeps the canonical rule. Shared by the PR refresh sweep and the
 * PR-state watch observation so both normalise a binding URL identically.
 */
export function pullRequestKey(
  url: string,
): { repo: string; number: number } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  // GitHub also serves `/pull/N.diff` and `/pull/N.patch`.
  const match =
    /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|\.diff$|\.patch$|$)/.exec(
      parsed.pathname,
    );
  if (!match) return undefined;
  const host = parsed.hostname.replace(/^www\./, '');
  return {
    repo: `${host}/${match[1]}/${match[2]}`.toLowerCase(),
    number: Number(match[3]),
  };
}

export function samePullRequest(left: string, right: string): boolean {
  const a = pullRequestKey(left);
  const b = pullRequestKey(right);
  return (
    a !== undefined &&
    b !== undefined &&
    a.repo === b.repo &&
    a.number === b.number
  );
}
