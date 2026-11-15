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
    };

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
    units.push({
      kind: 'commit',
      id: `commit:${entry.sha}`,
      sha: entry.sha,
      shortSha: entry.shortSha,
      subject: entry.subject,
      files,
      additions: detail.linesAdded ?? 0,
      deletions: detail.linesRemoved ?? 0,
      filesCount: detail.filesCount ?? files.length,
    });
  }
  return units;
}
