import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  DaemonGitCommitDetail,
  DaemonGitLogEntry,
  DaemonSessionPrInfo,
} from '@qwen-code/sdk/daemon';
import { useWorkspace } from '@qwen-code/web-shell/daemon-react-sdk';
import {
  buildCommitFallbackUnits,
  commitFallbackRange,
  type ChangeOverviewUnit,
} from './change-overview';

const COMMIT_FALLBACK_LIMIT = 20;

export interface ChangeOverviewState {
  /** False when the workspace is not a git repository (hide the overview). */
  gitAvailable: boolean;
  loading: boolean;
  units: ChangeOverviewUnit[];
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
  const prsSupported =
    capabilities?.features?.includes('workspace_github_prs') === true;
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);
  const [state, setState] = useState<ChangeOverviewState>({
    gitAvailable: true,
    loading: true,
    units: [],
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
        const summary = await client
          .sessionStatus(sessionId)
          .catch(() => undefined);
        if (!active) return;
        boundPrs = summary?.prs ?? [];
        baseBranch = summary?.branch?.baseBranch;
        gitCwd = summary?.worktree?.path ?? workspaceCwd;
      }

      const diff = await ws
        .workspaceGitDiff(gitCwd, sessionId)
        .catch(() => undefined);
      if (!active) return;
      if (!diff || diff.available === false) {
        setState({ gitAvailable: false, loading: false, units: [] });
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
      if (prsSupported && boundPrs.length > 0) {
        const prResults = await Promise.all(
          boundPrs.map(async (pr) => {
            const base = {
              kind: 'pr' as const,
              id: `pr:${pr.number}`,
              number: pr.number,
              title: `#${pr.number}`,
              url: pr.url,
            };
            const result = await ws
              .workspaceGitHubPullRequestFiles(pr.number, gitCwd, sessionId)
              .catch(() => undefined);
            if (!result || result.available === false) {
              return {
                headSha: undefined as string | undefined,
                unit: {
                  ...base,
                  state: 'unavailable',
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
        // Bound PRs are ordered last = latest; scope the commit fallback to the
        // newest head we could resolve, not whichever fetch happened to finish
        // last.
        for (let i = prResults.length - 1; i >= 0; i -= 1) {
          if (prResults[i]!.headSha) {
            latestPrHeadSha = prResults[i]!.headSha;
            break;
          }
        }
      }

      // Commit fallback: the loose window after the latest bound PR head (or
      // since the base branch when there is no PR). Fetch each commit's detail.
      const range = commitFallbackRange(latestPrHeadSha, baseBranch);
      const log = await ws
        .workspaceGitLog(COMMIT_FALLBACK_LIMIT, 0, gitCwd, range, {
          sessionId,
        })
        .catch(() => undefined);
      if (!active) return;
      const entries: DaemonGitLogEntry[] = log?.entries ?? [];
      if (entries.length > 0) {
        const details = new Map<string, DaemonGitCommitDetail>();
        await Promise.all(
          entries.map(async (entry) => {
            const detail = await ws
              .workspaceGitCommitDetail(entry.sha, gitCwd, sessionId)
              .catch(() => undefined);
            if (detail) details.set(entry.sha, detail);
          }),
        );
        if (!active) return;
        units.push(...buildCommitFallbackUnits(entries, details));
      }

      setState({ gitAvailable: true, loading: false, units });
    })().catch(() => {
      if (active) setState({ gitAvailable: false, loading: false, units: [] });
    });

    return () => {
      active = false;
    };
  }, [client, workspaceCwd, sessionId, prsSupported, refreshKey]);

  return useMemo(() => ({ ...state, refresh }), [state, refresh]);
}
