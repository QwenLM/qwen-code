import type { DaemonGitCommitDetail } from '@qwen-code/sdk/daemon';

/** One delivery unit in the change overview: a batch of changed files. */
export interface ChangeOverviewFile {
  path: string;
  additions: number;
  deletions: number;
}

export type ChangeOverviewUnit =
  | {
      kind: 'uncommitted';
      id: 'uncommitted';
      files: ChangeOverviewFile[];
      additions: number;
      deletions: number;
      filesCount: number;
      hiddenCount: number;
    }
  | {
      kind: 'pr';
      id: string;
      number: number;
      title: string;
      url: string;
      /** 'unavailable' when the file list could not be fetched. */
      state: 'ready' | 'unavailable';
      files: ChangeOverviewFile[];
      additions: number;
      deletions: number;
      filesCount: number;
      hiddenCount: number;
    }
  | {
      kind: 'commit';
      id: string;
      sha: string;
      shortSha: string;
      subject: string;
      files: ChangeOverviewFile[];
      additions: number;
      deletions: number;
      filesCount: number;
      hiddenCount: number;
    };

/**
 * The `owner/repo` a bound PR's URL points at, so its file list is resolved in
 * that repository rather than by number in the session's checkout (a same
 * number in another repo is a different PR). Returns undefined for anything
 * that is not a plain GitHub PR URL with a valid slug.
 */
export function prRepoFromUrl(url: string): string | undefined {
  const match = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(url);
  if (!match) return undefined;
  const repo = `${match[1]}/${match[2]}`;
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ? repo : undefined;
}

/**
 * The git log range that yields the commit-fallback window: commits a bound PR
 * does not cover. With a known PR head, only commits after it are loose (the
 * PR units already show the rest); without one, the session's base branch (or
 * HEAD's recent history) bounds the window.
 */
export function commitFallbackRange(
  latestPrHeadSha: string | undefined,
  baseBranch: string | undefined,
): string | undefined {
  if (latestPrHeadSha) return `${latestPrHeadSha}..HEAD`;
  if (baseBranch) return `${baseBranch}..HEAD`;
  return undefined;
}

/**
 * Map commit-fallback log entries to units. The caller already fetched the
 * loose window via {@link commitFallbackRange}, so covered commits are absent.
 * Merge commits are skipped — their diff-tree detail is the merge's own
 * introduction, not session work — as are commits whose detail is unavailable.
 */
export function buildCommitFallbackUnits(
  entries: readonly {
    sha: string;
    shortSha: string;
    subject: string;
    parents: string[];
  }[],
  details: ReadonlyMap<string, DaemonGitCommitDetail>,
): ChangeOverviewUnit[] {
  const units: ChangeOverviewUnit[] = [];
  for (const entry of entries) {
    if (entry.parents.length > 1) continue;
    const detail = details.get(entry.sha);
    if (!detail || detail.available === false) continue;
    const files = (detail.files ?? []).map((file) => ({
      path: file.path,
      additions: file.added,
      deletions: file.removed,
    }));
    const filesCount = detail.filesCount ?? files.length;
    units.push({
      kind: 'commit',
      id: `commit:${entry.sha}`,
      sha: entry.sha,
      shortSha: entry.shortSha,
      subject: entry.subject,
      files,
      additions: detail.linesAdded ?? 0,
      deletions: detail.linesRemoved ?? 0,
      filesCount,
      // The commit-detail route caps its per-file rows, so a large commit lists
      // only part of its files; surface the remainder like the other units.
      hiddenCount: Math.max(0, filesCount - files.length),
    });
  }
  return units;
}
