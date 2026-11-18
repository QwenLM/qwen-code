import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  DaemonGitCommitDetail,
  DaemonGitLogEntry,
  DaemonSessionPrInfo,
  DaemonSessionSummary,
} from '@qwen-code/sdk/daemon';
import { useWorkspace } from '@qwen-code/web-shell/daemon-react-sdk';
import {
  buildCommitFallbackUnits,
  commitFallbackRange,
  prRepoFromUrl,
  prUnavailableCauseFromError,
  type ChangeOverviewUnit,
  type PrUnavailableCause,
} from './change-overview';

const COMMIT_FALLBACK_LIMIT = 20;

export interface ChangeOverviewState {
  /** False when the workspace is not a git repository. */
  gitAvailable: boolean;
  /** True when a fetch failed transiently; retryable, not a workspace property. */
  loadFailed: boolean;
  loading: boolean;
  units: ChangeOverviewUnit[];
  /** True when the commit-fallback window is capped and older commits exist. */
  commitsTruncated: boolean;
}

/**
 * Assemble the session's delivery-unit change overview from git: the
 * uncommitted batch, one unit per bound PR (with its changed-file list and
 * scale), and a commit fallback for commits no bound PR covers. Read-only;
 * every fetch degrades gracefully so a missing `gh` or an old daemon never
 * blanks the panel.
 */
export function useChangeOverview(
  workspaceCwd: string,
  sessionId?: string,
): ChangeOverviewState & { refresh: () => void } {
  const { client, capabilities } = useWorkspace();
  const prFilesSupported =
    capabilities?.features?.includes('workspace_github_pr_files') === true;
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);
  const [state, setState] = useState<ChangeOverviewState>({
    gitAvailable: true,
    loadFailed: false,
    loading: true,
    units: [],
    commitsTruncated: false,
  });

  useEffect(() => {
    if (!workspaceCwd) return;
    let active = true;
    setState((current) => ({ ...current, loading: true }));

    void (async () => {
      const ws = client.workspaceByCwd(workspaceCwd);

      // Bound PRs + branch/worktree come from the session summary. Without a
      // session (or on failure) the overview still shows workspace git state.
      let boundPrs: DaemonSessionPrInfo[] = [];
      let baseBranch: string | undefined;
      let gitCwd = workspaceCwd;
      if (sessionId) {
        let summary: DaemonSessionSummary | undefined;
        try {
          summary = await client.sessionStatus(sessionId);
        } catch {
          // A rejected summary must not silently repoint a worktree session at
          // the primary checkout and present that as the session's own work;
          // surface a retryable failure instead.
          if (active) {
            setState({
              gitAvailable: true,
              loadFailed: true,
              loading: false,
              units: [],
              commitsTruncated: false,
            });
          }
          return;
        }
        if (!active) return;
        // A `review`-provenance binding is a PR merely mentioned in a
        // review/verify command, not this session's delivery; exclude it so a
        // foreign PR's scale is not presented as the session's own work.
        // Legacy bindings without a source stay included.
        boundPrs = (summary?.prs ?? []).filter((pr) => pr.source !== 'review');
        baseBranch = summary?.branch?.baseBranch;
        gitCwd = summary?.worktree?.path ?? workspaceCwd;
      }

      const diff = await ws
        .workspaceGitDiff(gitCwd, sessionId)
        .catch(() => undefined);
      if (!active) return;
      if (!diff) {
        // A thrown fetch (timeout, 5xx, dropped connection) is retryable; do
        // not mislabel it as a permanent property of the workspace.
        setState({
          gitAvailable: true,
          loadFailed: true,
          loading: false,
          units: [],
          commitsTruncated: false,
        });
        return;
      }
      if (diff.available === false) {
        setState({
          gitAvailable: false,
          loadFailed: false,
          loading: false,
          units: [],
          commitsTruncated: false,
        });
        return;
      }

      const units: ChangeOverviewUnit[] = [
        {
          kind: 'uncommitted',
          id: 'uncommitted',
          files: diff.files.map((file) => ({
            path: file.path,
            additions: file.added ?? 0,
            deletions: file.removed ?? 0,
            isBinary: file.isBinary,
          })),
          additions: diff.linesAdded,
          deletions: diff.linesRemoved,
          filesCount: diff.filesCount,
          hiddenCount: diff.hiddenCount,
        },
      ];

      // PR units: fetch each bound PR's file list. A failure (gh missing, old
      // daemon without the route) leaves the unit visible but 'unavailable'.
      let latestPrHeadSha: string | undefined;
      let prResults: Array<{
        headSha: string | undefined;
        headIsAncestor: boolean;
        unit: ChangeOverviewUnit;
      }> = [];
      if (prFilesSupported && boundPrs.length > 0) {
        prResults = await Promise.all(
          boundPrs.map(async (pr) => {
            const base = {
              kind: 'pr' as const,
              id: `pr:${pr.number}`,
              number: pr.number,
              title: `#${pr.number}`,
              url: pr.url,
            };
            let cause: PrUnavailableCause = 'error';
            const result = await ws
              .workspaceGitHubPullRequestFiles(
                pr.number,
                gitCwd,
                sessionId,
                prRepoFromUrl(pr.url),
              )
              .catch((error: unknown) => {
                cause = prUnavailableCauseFromError(error);
                return undefined;
              });
            if (!result || result.available === false) {
              return {
                headSha: undefined as string | undefined,
                headIsAncestor: false,
                unit: {
                  ...base,
                  state: 'unavailable',
                  unavailableCause: result === undefined ? cause : 'error',
                  files: [],
                  additions: 0,
                  deletions: 0,
                  filesCount: 0,
                  hiddenCount: 0,
                } as ChangeOverviewUnit,
              };
            }
            return {
              headSha: result.headSha || undefined,
              headIsAncestor: result.headIsAncestor === true,
              unit: {
                ...base,
                state: 'ready',
                files: result.files.map((file) => ({
                  path: file.path,
                  additions: file.additions,
                  deletions: file.deletions,
                })),
                additions: result.additions,
                deletions: result.deletions,
                filesCount: result.files.length + result.hiddenCount,
                hiddenCount: result.hiddenCount,
              } as ChangeOverviewUnit,
            };
          }),
        );
        if (!active) return;
        units.push(...prResults.map((result) => result.unit));
        // Bound PRs are ordered last = latest. The latest head is a trustworthy
        // fallback boundary only when EVERY bound PR head is an ancestor of
        // HEAD: a merged or rewritten PR anywhere in the set means the base
        // history absorbed its work, and even an older ancestor head's window
        // (<older>..HEAD) would straddle that history — re-listing main-only
        // commits and the merged PR's squash commit as loose work. In that
        // case fall back to the base-branch window (or suppress below when no
        // baseline is known) instead of skipping to an older ancestor head.
        if (prResults.every((result) => result.headIsAncestor)) {
          latestPrHeadSha = prResults[prResults.length - 1]?.headSha;
        }
      }

      // Commit fallback: the loose window after the latest bound PR head (or
      // since the base branch when there is no PR). Run only when every PR unit
      // actually produced resolved a head: with the files capability absent no
      // PR unit is produced, so the fallback still runs; but if any produced PR
      // unit failed to resolve its head, that PR's commits could sit inside the
      // window and be re-listed as loose work, so suppress the fallback.
      const showFallback = prResults.every(
        (result) => result.headSha !== undefined,
      );
      let commitsTruncated = false;
      if (showFallback) {
        const range = commitFallbackRange(latestPrHeadSha, baseBranch);
        // null = the base branch cannot survive the daemon's range whitelist.
        // undefined with bound PRs = no trustworthy boundary (no head passed
        // the ancestry probe and no base branch is known). Both skip the fetch
        // rather than fall through to an unscoped walk that would re-list
        // pre-session or PR-covered history. With no bound PRs, undefined
        // keeps the designed "HEAD's recent history" walk. Key on boundPrs,
        // not prResults: without the files capability no PR unit is produced
        // even though the session has bindings, and those bindings' commits
        // must not be re-listed as loose work either.
        if (range !== null && !(range === undefined && boundPrs.length > 0)) {
          let log = await ws
            .workspaceGitLog(COMMIT_FALLBACK_LIMIT, 0, gitCwd, range, {
              sessionId,
            })
            .catch(() => undefined);
          if (!active) return;
          // A thrown fetch (timeout, 5xx, dropped connection) is a retryable
          // failure, not "no loose commits"; keep it distinct from a response.
          let logFailed = log === undefined;
          // A head that was an ancestor at probe time can still fail the log
          // (e.g. a shallow clone); retry once with the base-branch window so
          // the session's loose commits still surface instead of silently
          // disappearing.
          if (log && log.available === false && latestPrHeadSha !== undefined) {
            const baseRange = commitFallbackRange(undefined, baseBranch);
            // `undefined` is the "no baseline" sentinel, not a retry target:
            // an omitted range would walk HEAD unscoped. `null` is refused
            // outright. Only a real window is retried.
            if (baseRange) {
              const retry = await ws
                .workspaceGitLog(COMMIT_FALLBACK_LIMIT, 0, gitCwd, baseRange, {
                  sessionId,
                })
                .catch(() => undefined);
              if (!active) return;
              // A rejected retry must not erase the first response's
              // unavailable verdict; keep the first response and fail below.
              if (retry) log = retry;
              else logFailed = true;
            }
          }
          // A log the daemon reports unavailable (e.g. the range's head is not
          // in the object database) or a thrown fetch is a retryable failure,
          // not "no loose commits"; surface it instead of an empty session.
          if (logFailed || !log || log.available === false) {
            setState({
              gitAvailable: true,
              loadFailed: true,
              loading: false,
              units: [],
              commitsTruncated: false,
            });
            return;
          }
          // The log window is capped; surface that older commits exist rather
          // than silently truncating the delivery scale.
          commitsTruncated = log.hasMore === true;
          // Drop merge commits before the detail fan-out so they neither spend
          // detail round-trips nor displace real loose commits in the window.
          const entries: DaemonGitLogEntry[] = log.entries.filter(
            (entry) => entry.parents.length <= 1,
          );
          if (entries.length > 0) {
            const details = new Map<string, DaemonGitCommitDetail>();
            let detailFailed = false;
            await Promise.all(
              entries.map(async (entry) => {
                const detail = await ws
                  .workspaceGitCommitDetail(entry.sha, gitCwd, sessionId)
                  .catch(() => undefined);
                if (detail && detail.available !== false) {
                  details.set(entry.sha, detail);
                } else {
                  detailFailed = true;
                }
              }),
            );
            if (!active) return;
            // A partial detail fan-out must not render as a complete list;
            // surface the retryable failure instead.
            if (detailFailed) {
              setState({
                gitAvailable: true,
                loadFailed: true,
                loading: false,
                units: [],
                commitsTruncated: false,
              });
              return;
            }
            units.push(...buildCommitFallbackUnits(entries, details));
          }
        }
      }

      setState({
        gitAvailable: true,
        loadFailed: false,
        loading: false,
        units,
        commitsTruncated,
      });
    })().catch(() => {
      if (active) {
        setState({
          gitAvailable: true,
          loadFailed: true,
          loading: false,
          units: [],
          commitsTruncated: false,
        });
      }
    });

    return () => {
      active = false;
    };
  }, [client, workspaceCwd, sessionId, prFilesSupported, refreshKey]);

  return useMemo(() => ({ ...state, refresh }), [state, refresh]);
}
