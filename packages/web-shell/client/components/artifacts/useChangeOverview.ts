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
  isSafeSingleRef,
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
  const excludeRefsSupported =
    capabilities?.features?.includes('workspace_git_log_exclude_refs') === true;
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
      let startCommit: string | undefined;
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
        baseBranch =
          summary?.branch?.baseBranch ?? summary?.worktree?.baseBranch;
        // The immutable commit the session started from. The session's own
        // creation-time start (top-level baseCommit) wins over a derived
        // branch/worktree base tip: a plain session that hands off into a
        // worktree must keep its pre-handoff commits (the worktree's creation
        // tip T is later than the session start S, and T..HEAD would hide
        // S..T). Sessions created as a branch/worktree have no top-level start,
        // so they fall through to that meta's base. Absent on legacy sessions,
        // which fall back to the base branch or suppress.
        startCommit =
          summary?.baseCommit ??
          summary?.branch?.baseCommit ??
          summary?.worktree?.baseCommit;
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
      let prResults: Array<{
        headSha: string | undefined;
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
      }

      // Commit fallback: the session's loose window — commits since the
      // session start commit (else its base branch), minus every commit
      // reachable from any bound PR head. Run only when every produced PR unit
      // resolved a head (a unit that failed to resolve its head cannot be
      // excluded, so its commits must not be re-listed as loose work) AND the
      // heads can actually be excluded: with bound PR units but no exclude
      // capability (a new client against an older daemon) an unfiltered window
      // would re-list those PRs' own commits as loose, so suppress instead.
      const showFallback =
        prResults.every((result) => result.headSha !== undefined) &&
        (boundPrs.length === 0 || !prFilesSupported || excludeRefsSupported);
      // Reachability exclusion handles merged, parallel, and incomparable PR
      // heads uniformly — no single-head boundary heuristic. Only passed when
      // the daemon advertises the exclude capability; showFallback above
      // suppresses the window entirely when bound PR heads cannot be excluded.
      // The base branch's remote-tracking refs join the exclusion set so
      // integrating upstream (pull, rebase, merge of the base) does not re-list
      // pre-session commits as loose work. The recorded baseBranch is the LOCAL
      // name (e.g. main), which integration never advances — only the
      // remote-tracking ref does — so excluding the local name alone subtracts
      // nothing. Exclude the remote-tracking ref under BOTH documented remotes:
      // `origin/<baseBranch>` (a standard clone) and `upstream/<baseBranch>` (a
      // fork, where origin is the personal fork and integration comes from
      // upstream — CONTRIBUTING's layout). The session's own commits (children
      // of the base) survive; the recorded start commit still bounds the window.
      // A remote-tracking ref that does not exist locally (the other remote, or
      // a clone with no remote) is dropped by the log route's existence probe
      // rather than failing the whole walk, so the present exclusions — bound PR
      // heads above all — still apply. A remote named other than origin/upstream
      // is a known residual: its integrated commits may re-list as loose work.
      // Only the remote-tracking refs are excluded, never the local base name:
      // the local branch is what absorbs the session's own work (a local merge
      // of the session branch into it), so `--not <local>` would empty the
      // window and report no committed work. The remote-tracking ref reaches
      // the integrated upstream commits without covering the session's own
      // (still unpushed) commits; the recorded start commit bounds the window.
      const baseBranchExclusions =
        baseBranch && baseBranch !== 'HEAD' && isSafeSingleRef(baseBranch)
          ? [
              ...new Set(
                baseBranch.startsWith('origin/') ||
                baseBranch.startsWith('upstream/')
                  ? [baseBranch]
                  : [`origin/${baseBranch}`, `upstream/${baseBranch}`],
              ),
            ].filter(isSafeSingleRef)
          : [];
      const excludeRefs = excludeRefsSupported
        ? [
            ...prResults
              .map((result) => result.headSha)
              .filter((sha): sha is string => sha !== undefined),
            ...baseBranchExclusions,
          ]
        : [];
      let commitsTruncated = false;
      if (showFallback) {
        const range = commitFallbackRange(startCommit, baseBranch);
        // A real window is required: `null` (unsafe ref) and `undefined` (no
        // start commit and no base branch) both suppress the fallback. The
        // overview never issues a range-less walk, which would re-list the
        // repository's pre-session history as this session's loose work.
        if (range) {
          let log = await ws
            .workspaceGitLog(COMMIT_FALLBACK_LIMIT, 0, gitCwd, range, {
              sessionId,
              ...(excludeRefs.length > 0 ? { excludeRefs } : {}),
            })
            .catch(() => undefined);
          // A bound PR head can be missing from the local object database — a
          // headRefOid refreshed after a remote update, a force-pushed/gc'd
          // head, a legacy cross-repo binding. `git log --not <missing>` then
          // fails permanently (bad object), so the excluded log is unavailable
          // on every retry. Degrade to the same boundary window WITHOUT
          // exclusion rather than blanking every unit: re-listing that PR's
          // commits in this degraded case is the accepted residual.
          if (log && log.available === false && excludeRefs.length > 0) {
            log = await ws
              .workspaceGitLog(COMMIT_FALLBACK_LIMIT, 0, gitCwd, range, {
                sessionId,
              })
              .catch(() => undefined);
          }
          if (!active) return;
          // A thrown fetch (timeout, 5xx, dropped connection) or a log still
          // unavailable after the no-exclusion retry (e.g. an unsafe excluded
          // ref, or the start commit itself not in the object database) is a
          // retryable failure, not "no loose commits"; surface it instead of an
          // empty session.
          if (!log || log.available === false) {
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
  }, [
    client,
    workspaceCwd,
    sessionId,
    prFilesSupported,
    excludeRefsSupported,
    refreshKey,
  ]);

  return useMemo(() => ({ ...state, refresh }), [state, refresh]);
}
