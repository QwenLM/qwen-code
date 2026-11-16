import type { DaemonGitCommitDetail } from '@qwen-code/sdk/daemon';

/** One delivery unit in the change overview: a batch of changed files. */
export interface ChangeOverviewFile {
  path: string;
  additions: number;
  deletions: number;
  /** Binary rows carry zero counts by design; render a marker, not "+0 -0". */
  isBinary?: boolean;
}

/** Why a PR's file list could not be fetched, so the panel can say so honestly. */
export type PrUnavailableCause = 'cli' | 'route' | 'error';

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
      /** Present when state is 'unavailable'; names the actual failure cause. */
      unavailableCause?: PrUnavailableCause;
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
 * The `[host/]owner/repo` a bound PR's URL points at, so its file list is
 * resolved in that repository rather than by number in the session's checkout
 * (a same number in another repo is a different PR). The host is carried
 * through to `gh --repo` in its documented [HOST/]OWNER/REPO form: dropping it
 * would resolve an Enterprise PR's slug on github.com and could render a
 * foreign same-numbered PR's files under this PR's heading. Returns undefined
 * for anything that is not a plain GitHub PR URL with a valid slug and a bare
 * hostname[:port] host.
 */
export function prRepoFromUrl(url: string): string | undefined {
  const match = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(url);
  if (!match) return undefined;
  const repo = `${match[2]}/${match[3]}`;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return undefined;
  const host = match[1]!;
  if (!/^[A-Za-z0-9.-]+(?::\d+)?$/.test(host)) return undefined;
  return `${host}/${repo}`;
}

/**
 * Classify a failed PR-files fetch from the daemon error's wire shape, so the
 * panel names the real cause instead of always blaming a missing `gh` or an
 * old daemon. `github_cli_unavailable` → gh missing; a 404 → the daemon
 * predates the route; anything else (expired token, rate limit, transient
 * daemon error) → a generic retryable failure.
 */
export function prUnavailableCauseFromError(
  error: unknown,
): PrUnavailableCause {
  if (typeof error !== 'object' || error === null) return 'error';
  const status = (error as { status?: unknown }).status;
  const body = (error as { body?: unknown }).body;
  const code =
    typeof body === 'object' && body !== null
      ? (body as { code?: unknown }).code
      : undefined;
  if (code === 'github_cli_unavailable') return 'cli';
  if (status === 404) return 'route';
  return 'error';
}

/**
 * Mirror of the daemon's `isSafeLogRange` predicate for a single ref. A base
 * branch git permits but the whitelist rejects (e.g. `feat@2026`) would make
 * the daemon silently drop the range and run an unscoped `git log`, re-listing
 * pre-session history; refuse to compose such a range instead.
 */
function isSafeRangeRef(ref: string): boolean {
  return (
    !ref.startsWith('-') &&
    !ref.startsWith('..') &&
    /^[A-Za-z0-9_./~^-]+$/.test(ref)
  );
}

/**
 * The git log range that yields the commit-fallback window: commits a bound PR
 * does not cover. With a known PR head, only commits after it are loose (the
 * PR units already show the rest); without one, the session's base branch (or
 * HEAD's recent history) bounds the window.
 *
 * Returns a range string, or one of two distinct sentinels: `undefined` means
 * "no baseline — walk HEAD's recent history" (an omitted range), while `null`
 * means "refuse the fallback". A base branch git permits but the daemon's
 * whitelist rejects (e.g. `feat@2026`) would be dropped server-side into an
 * unscoped walk that re-lists pre-session history, so it must skip the fetch
 * entirely (`null`), not fall through to the omitted-range path. The literal
 * `'HEAD'` is the daemon's detached-HEAD sentinel (session.ts treats it the
 * same way), not a baseline: composing `HEAD..HEAD` would be always-empty and
 * silently render a committing session as having no loose commits, so it maps
 * to the no-baseline walk instead.
 */
export function commitFallbackRange(
  latestPrHeadSha: string | undefined,
  baseBranch: string | undefined,
): string | null | undefined {
  if (latestPrHeadSha) return `${latestPrHeadSha}..HEAD`;
  if (baseBranch && baseBranch !== 'HEAD') {
    return isSafeRangeRef(baseBranch) ? `${baseBranch}..HEAD` : null;
  }
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
      isBinary: file.isBinary,
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
