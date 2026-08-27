/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { useWorkspace } from '@qwen-code/webui/daemon-react-sdk';
import type { DaemonWorkspaceGitDiffFile } from '@qwen-code/sdk/daemon';
import {
  ChevronDownIcon,
  EyeIcon,
  Loader2Icon,
  PencilIcon,
  SearchIcon,
} from 'lucide-react';
import { useI18n } from '../../i18n';
import { useExternalLinkOpener } from '../../hooks/useExternalLinkOpener';
import { Markdown } from '../messages/Markdown';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { DialogShell } from './DialogShell';
import { GitDiffContent } from './GitDiffDialog';
import { GitLogContent } from './GitLogDialog';
import { GitHubPrsContent } from './GitHubPrsDialog';
import styles from './GitDialog.module.css';

export type GitDialogView = 'diff' | 'log' | 'prs' | 'commit';

const GITHUB_PRS_FEATURE = 'workspace_github_prs';

const TITLE_KEYS: Record<GitDialogView, string> = {
  diff: 'gitDiff.title',
  log: 'gitLog.title',
  prs: 'githubPrs.title',
  commit: 'gitCommit.title',
};

/** Tabs visible in the tab bar — commit is a mode, not a regular tab. */
const TAB_VIEWS: Exclude<GitDialogView, 'commit'>[] = ['diff', 'log', 'prs'];
const MAX_SUMMARY_CHARS = 3500;

export function GitDialog({
  workspaceCwd,
  gitCwd,
  initialView,
  sessionId,
  resolveSessionForWorkspace,
  onClose,
}: {
  workspaceCwd: string;
  gitCwd?: string;
  initialView: GitDialogView;
  sessionId?: string;
  resolveSessionForWorkspace?: (
    cwd: string,
    forceCreate?: boolean,
  ) => Promise<string | undefined>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const openExternalLink = useExternalLinkOpener();
  const { client, capabilities } = useWorkspace();
  const gitSessionId = gitCwd ? sessionId : undefined;
  const prsSupported =
    capabilities?.features?.includes(GITHUB_PRS_FEATURE) === true;
  const tabViews = prsSupported
    ? TAB_VIEWS
    : TAB_VIEWS.filter((v) => v !== 'prs');
  const [view, setView] = useState(initialView);
  const [subtitle, setSubtitle] = useState<string>();
  const [commitMsg, setCommitMsg] = useState('');
  const [commitBusy, setCommitBusy] = useState<'commit' | 'push' | null>(null);
  const [generating, setGenerating] = useState(false);
  const [genFailed, setGenFailed] = useState(false);
  const [prFormOpen, setPrFormOpen] = useState(false);
  const [prTitle, setPrTitle] = useState('');
  const [prBody, setPrBody] = useState('');
  const [prBase, setPrBase] = useState('');
  const [prBusy, setPrBusy] = useState(false);
  const [prGenerating, setPrGenerating] = useState(false);
  const [prPreview, setPrPreview] = useState(false);
  const [prBranches, setPrBranches] = useState<{
    local: string[];
    remotes: [string, string[]][];
  } | null>(null);
  const [prBranchesError, setPrBranchesError] = useState(false);
  const prHeadInfoRef = useRef<{ hasUpstream: boolean } | null>(null);
  const [prStatus, setPrStatus] = useState<{
    msg: string;
    type: 'error' | 'success';
    url?: string;
  } | null>(null);
  const [commitStatus, setCommitStatus] = useState<{
    msg: string;
    type: 'error' | 'success';
  } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const resolveSessionRef = useRef(resolveSessionForWorkspace);
  resolveSessionRef.current = resolveSessionForWorkspace;
  const sessionIdRef = useRef(sessionId);
  // Reset only when the prop actually changes — an unconditional render-body
  // sync would clobber the fresh id the dialog resolves for its own side
  // queries (commit-message generation) before the PR binding reads it.
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  // btwSession with automatic retry: if the resolved session is stale
  // (daemon restarted, session evicted), force-create a new one and retry.
  const btwWithRetry = useCallback(
    async (sid: string, prompt: string, signal: AbortSignal) => {
      try {
        return await client.btwSession(sid, prompt, { signal });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/no session/i.test(msg) && resolveSessionRef.current) {
          // Session is stale — force-create via the workspace resolver.
          // The resolver's listWorkspaceSessions path returned a dead id;
          // calling createSession directly guarantees a live session.
          const fresh = await resolveSessionRef.current(
            gitCwd ?? workspaceCwd,
            true,
          );
          if (fresh && fresh !== sid && !signal.aborted) {
            sessionIdRef.current = fresh;
            return client.btwSession(fresh, prompt, { signal });
          }
        }
        throw err;
      }
    },
    [client, workspaceCwd, gitCwd],
  );
  const btwWithRetryRef = useRef(btwWithRetry);
  btwWithRetryRef.current = btwWithRetry;

  const startedInCommit = useRef(initialView === 'commit').current;
  const isCommit = view === 'commit';
  const effectiveTab = isCommit ? 'diff' : view;

  // Auto-generate commit message via session side-query when commit view opens.
  useEffect(() => {
    if (!isCommit) return;
    const abort = new AbortController();
    setGenerating(true);
    setGenFailed(false);
    setCommitMsg('');

    const resolveSession = resolveSessionRef.current
      ? resolveSessionRef.current(gitCwd ?? workspaceCwd)
      : sessionIdRef.current
        ? Promise.resolve(sessionIdRef.current)
        : Promise.resolve(undefined);

    resolveSession
      .then((sid) => {
        if (abort.signal.aborted) return;
        if (!sid) {
          setGenFailed(true);
          setGenerating(false);
          return;
        }
        const ws = client.workspaceByCwd(workspaceCwd);
        return ws.workspaceGitDiff(gitCwd, gitSessionId).then((diff) => {
          if (abort.signal.aborted) return;
          if (diff.files.length === 0) {
            setGenerating(false);
            return;
          }
          const fileLines = diff.files.map((f: DaemonWorkspaceGitDiffFile) => {
            const status = f.isUntracked
              ? 'new'
              : f.isDeleted
                ? 'deleted'
                : 'modified';
            const counts = f.isBinary
              ? ' (binary)'
              : ` (+${f.added ?? 0} -${f.removed ?? 0})`;
            const rename = f.oldPath ? ` (renamed from ${f.oldPath})` : '';
            return `${status}: ${f.path}${counts}${rename}`;
          });
          let fileSummary = fileLines.join('\n');
          if (fileSummary.length > MAX_SUMMARY_CHARS) {
            let truncated = '';
            let included = 0;
            for (const line of fileLines) {
              if (truncated.length + line.length + 1 > MAX_SUMMARY_CHARS) break;
              truncated += (truncated ? '\n' : '') + line;
              included++;
            }
            fileSummary =
              truncated + `\n(…and ${fileLines.length - included} more files)`;
          }
          const prompt =
            `Generate a concise git commit message for these changes. ` +
            `Reply with ONLY the commit message text, no quotes, no explanation.\n\n${fileSummary}`;
          return btwWithRetryRef
            .current(sid, prompt, abort.signal)
            .then((result) => {
              if (abort.signal.aborted) return;
              if (result.answer) setCommitMsg(result.answer.trim());
            });
        });
      })
      .catch(() => {
        if (!abort.signal.aborted) setGenFailed(true);
      })
      .finally(() => {
        if (!abort.signal.aborted) setGenerating(false);
      });

    return () => {
      abort.abort();
    };
  }, [isCommit, client, workspaceCwd, gitCwd, gitSessionId]);

  // Clamp if the PR tab vanishes mid-session.
  const clampedTab = tabViews.includes(
    effectiveTab as (typeof tabViews)[number],
  )
    ? effectiveTab
    : 'diff';

  const selectView = useCallback((next: GitDialogView) => {
    setSubtitle(undefined);
    setView(next);
  }, []);

  const selectAndFocus = (next: GitDialogView) => {
    selectView(next);
    document.getElementById(`git-dialog-tab-${next}`)?.focus();
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (isCommit) {
      // Commit is the rightmost tab. Arrow keys and Home move into the regular
      // tabs so keyboard users aren't trapped on the commit tab; End stays put
      // because commit is already the last tab.
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        selectAndFocus(tabViews[tabViews.length - 1]);
      } else if (event.key === 'ArrowRight' || event.key === 'Home') {
        event.preventDefault();
        selectAndFocus(tabViews[0]);
      } else if (event.key === 'End') {
        event.preventDefault();
      }
      return;
    }
    const index = tabViews.indexOf(clampedTab as (typeof tabViews)[number]);
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const delta = event.key === 'ArrowRight' ? 1 : -1;
      selectAndFocus(
        tabViews[(index + delta + tabViews.length) % tabViews.length],
      );
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      selectAndFocus(tabViews[0]);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      selectAndFocus(tabViews[tabViews.length - 1]);
    }
  };

  const doCommit = useCallback(
    async (andPush: boolean) => {
      if (commitBusy || prBusy || !commitMsg.trim()) return;
      setCommitBusy(andPush ? 'push' : 'commit');
      setCommitStatus(null);
      try {
        const ws = client.workspaceByCwd(workspaceCwd);
        const result = await ws.workspaceGitCommit(
          commitMsg.trim(),
          { all: true },
          gitCwd,
          gitSessionId,
        );
        if (andPush) {
          try {
            await ws.workspaceGitPush(
              { setUpstream: true },
              gitCwd,
              gitSessionId,
            );
            setCommitMsg('');
            setCommitStatus({
              msg: t('gitCommit.commitPushSuccess', { sha: result.sha }),
              type: 'success',
            });
          } catch (pushErr) {
            setCommitStatus({
              msg: t('gitCommit.commitSuccessPushFailed', {
                sha: result.sha,
                error:
                  pushErr instanceof Error ? pushErr.message : String(pushErr),
              }),
              type: 'error',
            });
          }
        } else {
          setCommitMsg('');
          setCommitStatus({
            msg: t('gitCommit.commitSuccess', { sha: result.sha }),
            type: 'success',
          });
        }
      } catch (err) {
        setCommitStatus({
          msg: err instanceof Error ? err.message : String(err),
          type: 'error',
        });
      } finally {
        setCommitBusy(null);
      }
    },
    [
      client,
      workspaceCwd,
      gitCwd,
      gitSessionId,
      commitMsg,
      commitBusy,
      prBusy,
      t,
    ],
  );

  const loadPrBranches = useCallback(() => {
    const ws = client.workspaceByCwd(workspaceCwd);
    setPrBranchesError(false);
    ws.workspaceGitBranches(gitCwd, gitSessionId)
      .then((branches) => {
        const local = branches.local.map((b) => b.name);
        const remoteMap = new Map<string, string[]>();
        for (const b of branches.remote) {
          const slash = b.name.indexOf('/');
          const remote = slash > 0 ? b.name.slice(0, slash) : 'other';
          let list = remoteMap.get(remote);
          if (!list) {
            list = [];
            remoteMap.set(remote, list);
          }
          list.push(b.name);
        }
        setPrBranches({ local, remotes: Array.from(remoteMap.entries()) });
        const head = branches.local.find((b) => b.isHead);
        prHeadInfoRef.current = head
          ? { hasUpstream: Boolean(head.upstream) }
          : null;
      })
      .catch(() => {
        setPrBranches(null);
        setPrBranchesError(true);
        prHeadInfoRef.current = null;
      });
  }, [client, workspaceCwd, gitCwd, gitSessionId]);

  // Auto-fill PR form when it opens.
  useEffect(() => {
    if (!prFormOpen || !isCommit) return;
    const ws = client.workspaceByCwd(workspaceCwd);

    // Fetch branch list for the target-branch dropdown (independent).
    loadPrBranches();

    setPrStatus(null);
    setPrGenerating(true);
    const abort = new AbortController();

    // Resolve base branch, session, then generate — all chained.
    const baseBranchPromise = ws
      .workspaceGitHubDefaultBranch()
      .then((r) => r.branch)
      .catch(() => 'origin/main');

    const resolveSession = resolveSessionRef.current
      ? resolveSessionRef.current(gitCwd ?? workspaceCwd)
      : sessionIdRef.current
        ? Promise.resolve(sessionIdRef.current)
        : Promise.resolve(undefined);

    Promise.all([baseBranchPromise, resolveSession])
      .then(([base, sid]) => {
        if (abort.signal.aborted) return;
        setPrBase(base);
        if (!sid) {
          ws.workspaceGit({ cwd: gitCwd, sessionId: gitSessionId })
            .then((git) => {
              if (!abort.signal.aborted && git.branch && !git.detached)
                setPrTitle(git.branch);
            })
            .catch(() => {})
            .finally(() => {
              if (!abort.signal.aborted) setPrGenerating(false);
            });
          return;
        }
        return Promise.all([
          ws.workspaceGitLog(50, 0, gitCwd, `${base}..HEAD`, gitSessionId),
          ws.workspaceGitDiff(gitCwd, gitSessionId),
        ]).then(([log, diff]) => {
          if (abort.signal.aborted) return;
          if (!log.available) {
            // The base ref didn't resolve locally (e.g. a stale or missing
            // default branch) — surface it instead of generating from an
            // empty range and emitting a misleading "(no commits)".
            setPrStatus({
              msg: t('gitCommit.prLogUnavailable'),
              type: 'error',
            });
            return;
          }
          // Build context from branch commits + uncommitted changes.
          const commitSummary =
            log.entries.length > 0
              ? log.entries
                  .map((e) => `- ${e.shortSha} ${e.subject}`)
                  .join('\n')
              : '(no commits ahead of base)';
          const uncommittedLines = diff.files.map(
            (f: DaemonWorkspaceGitDiffFile) => {
              const status = f.isUntracked
                ? 'new'
                : f.isDeleted
                  ? 'deleted'
                  : 'modified';
              return `${status}: ${f.path}`;
            },
          );
          let uncommitted = uncommittedLines.join('\n');
          if (uncommitted.length > MAX_SUMMARY_CHARS) {
            let truncated = '';
            let included = 0;
            for (const line of uncommittedLines) {
              if (truncated.length + line.length + 1 > MAX_SUMMARY_CHARS) break;
              truncated += (truncated ? '\n' : '') + line;
              included++;
            }
            uncommitted =
              truncated +
              `\n(…and ${uncommittedLines.length - included} more files)`;
          }
          const prompt =
            `Generate a GitHub pull request title and body for the changes on this branch compared to ${base}. ` +
            `Use the commit history and conversation context to understand what was done and why.\n\n` +
            `Commits on this branch (not in ${base}):\n${commitSummary}\n\n` +
            `${uncommitted ? `Uncommitted changes:\n${uncommitted}\n\n` : ''}` +
            `Follow these rules strictly:\n` +
            `1. Title: conventional commit format, e.g. "feat(web-shell): add branch picker". Under 70 chars.\n` +
            `2. Body must follow this exact template structure (fill in each section):\n\n` +
            `## What this PR does\n` +
            `<Describe the change in prose. Do NOT reference file names or function names.>\n\n` +
            `## Why it is needed\n` +
            `<Motivation, problem being solved, or user-facing benefit.>\n\n` +
            `## Reviewer Test Plan\n` +
            `### How to verify\n` +
            `<Steps a reviewer should follow to confirm the change works.>\n` +
            `### Evidence (Before & After)\n` +
            `N/A\n` +
            `### Tested on\n` +
            `|     OS     | Status |\n` +
            `| :--------: | :----: |\n` +
            `|  macOS  | ⚠️ |\n` +
            `| Windows | ⚠️ |\n` +
            `|  Linux  | ⚠️ |\n\n` +
            `## Risk & Scope\n` +
            `- Main risk or tradeoff: <fill in>\n` +
            `- Not validated / out of scope: <fill in>\n` +
            `- Breaking changes / migration notes: none\n\n` +
            `<details>\n<summary>中文说明</summary>\n\n` +
            `<Full Chinese translation of the English body above, section by section.>\n\n` +
            `</details>\n\n` +
            `3. Do NOT hard-wrap paragraphs — write each paragraph as one long line.\n` +
            `4. Reply with the title on the first line, then a blank line, then the body. No extra explanation.`;
          return btwWithRetryRef
            .current(sid, prompt, abort.signal)
            .then((result) => {
              if (abort.signal.aborted) return;
              if (result.answer) {
                const lines = result.answer.trim().split('\n');
                setPrTitle(lines[0] ?? '');
                setPrBody(lines.slice(1).join('\n').trim());
              } else {
                console.warn('[GitDialog] btwSession returned null answer');
              }
            });
        });
      })
      .catch((err) => {
        if (!abort.signal.aborted) {
          console.error('[GitDialog] PR generation failed:', err);
          setPrStatus({
            msg: err instanceof Error ? err.message : String(err),
            type: 'error',
          });
          ws.workspaceGit({ cwd: gitCwd, sessionId: gitSessionId })
            .then((git) => {
              if (!abort.signal.aborted && git.branch && !git.detached)
                setPrTitle(git.branch);
            })
            .catch(() => {});
        }
      })
      .finally(() => {
        if (!abort.signal.aborted) setPrGenerating(false);
      });

    return () => abort.abort();
  }, [
    prFormOpen,
    isCommit,
    client,
    workspaceCwd,
    gitCwd,
    gitSessionId,
    t,
    loadPrBranches,
  ]);

  const doCreatePr = useCallback(async () => {
    if (!prTitle.trim() || prGenerating || prBusy) return;
    setPrBusy(true);
    setPrStatus(null);
    if (prHeadInfoRef.current && !prHeadInfoRef.current.hasUpstream) {
      setPrStatus({ msg: t('gitCommit.prPushFirst'), type: 'error' });
      setPrBusy(false);
      return;
    }
    try {
      const ws = client.workspaceByCwd(workspaceCwd);
      // Strip a known remote prefix for `gh pr create --base`
      // (origin/main → main), but leave local branch names — which may
      // themselves contain "/" — untouched.
      const trimmedBase = prBase.trim();
      const remotePrefix = (prBranches?.remotes ?? [])
        .map(([name]) => name)
        .sort((a, b) => b.length - a.length)
        .find((name) => trimmedBase.startsWith(`${name}/`));
      const baseBranch = remotePrefix
        ? trimmedBase.slice(remotePrefix.length + 1)
        : trimmedBase;
      const result = await ws.workspaceGitHubCreatePullRequest(
        {
          title: prTitle.trim(),
          body: prBody.trim() || undefined,
          base: baseBranch || undefined,
        },
        gitCwd,
        gitSessionId,
      );
      setPrStatus({
        msg: t('gitCommit.prCreated', { number: result.number ?? '' }),
        type: 'success',
        url: result.url,
      });
      setPrFormOpen(false);
      // Bind the PR to the current session so the sidebar can badge and
      // search sessions by PR number. Best-effort: a binding failure must
      // not shadow the successful PR creation. Binding never creates a
      // session — when the dialog has no session context (workspace-level
      // open), the PR simply stays unbound. A session from another
      // workspace is rejected by the daemon route's workspace-conflict
      // check and surfaces here as a warning only.
      if (typeof result.number === 'number' && result.url) {
        // Newly created → the snapshot starts open; the daemon's refresh
        // timer advances it to merged/closed.
        const pr = {
          number: result.number,
          url: result.url,
          state: 'open' as const,
        };
        const sid = sessionIdRef.current;
        if (sid) {
          ws.updateSessionMetadata(sid, { pr }).catch((err: unknown) => {
            console.warn(
              'Failed to bind PR to session:',
              err instanceof Error ? err.message : String(err),
            );
          });
        }
      }
    } catch (err) {
      setPrStatus({
        msg: err instanceof Error ? err.message : String(err),
        type: 'error',
      });
    } finally {
      setPrBusy(false);
    }
  }, [
    client,
    workspaceCwd,
    gitCwd,
    gitSessionId,
    prTitle,
    prBody,
    prBase,
    prBranches,
    prGenerating,
    prBusy,
    t,
  ]);

  return (
    <DialogShell
      title={t(TITLE_KEYS[isCommit ? 'commit' : clampedTab])}
      subtitle={subtitle}
      size="xl"
      allowFullscreen
      onClose={onClose}
    >
      <div className={styles.content}>
        <div className={styles.tabBar} role="tablist">
          {tabViews.map((name) => (
            <button
              key={name}
              id={`git-dialog-tab-${name}`}
              type="button"
              role="tab"
              aria-selected={clampedTab === name && !isCommit}
              aria-controls="git-dialog-panel"
              tabIndex={clampedTab === name && !isCommit ? 0 : -1}
              className={`${styles.tab}${clampedTab === name && !isCommit ? ` ${styles.tabActive}` : ''}`}
              onClick={() => selectView(name)}
              onKeyDown={onTabKeyDown}
            >
              {t(TITLE_KEYS[name])}
            </button>
          ))}
          {startedInCommit && (
            <button
              id="git-dialog-tab-commit"
              type="button"
              role="tab"
              aria-selected={isCommit}
              aria-controls="git-dialog-panel"
              tabIndex={isCommit ? 0 : -1}
              className={`${styles.tab}${isCommit ? ` ${styles.tabActive}` : ''}`}
              onKeyDown={onTabKeyDown}
              onClick={() => selectView('commit')}
            >
              {t('gitCommit.title')}
            </button>
          )}
        </div>
        <div
          id="git-dialog-panel"
          className={styles.tabPanel}
          role="tabpanel"
          aria-labelledby={`git-dialog-tab-${isCommit ? 'commit' : clampedTab}`}
        >
          {clampedTab === 'diff' || isCommit ? (
            <GitDiffContent
              workspaceCwd={workspaceCwd}
              gitCwd={gitCwd}
              gitSessionId={gitSessionId}
              onSubtitleChange={setSubtitle}
            />
          ) : clampedTab === 'log' ? (
            <GitLogContent
              workspaceCwd={workspaceCwd}
              gitCwd={gitCwd}
              gitSessionId={gitSessionId}
              onSubtitleChange={setSubtitle}
            />
          ) : (
            <GitHubPrsContent
              workspaceCwd={workspaceCwd}
              onSubtitleChange={setSubtitle}
            />
          )}
        </div>
        {isCommit && (
          <div className={styles.commitPanel}>
            <textarea
              ref={textareaRef}
              className={styles.commitMessage}
              placeholder={
                generating
                  ? t('gitCommit.generating')
                  : genFailed
                    ? t('gitCommit.genFailed')
                    : t('gitCommit.messagePlaceholder')
              }
              value={commitMsg}
              disabled={generating}
              onChange={(e) => setCommitMsg(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void doCommit(false);
                }
              }}
            />
            {commitStatus && (
              <div
                className={`${styles.commitStatus} ${
                  commitStatus.type === 'error'
                    ? styles.commitStatusError
                    : styles.commitStatusSuccess
                }`}
              >
                {commitStatus.msg}
              </div>
            )}
            <div className={styles.commitActions}>
              <button
                type="button"
                className={`${styles.commitBtn} ${styles.commitBtnPrimary}`}
                disabled={!commitMsg.trim() || !!commitBusy || prBusy}
                onClick={() => void doCommit(false)}
              >
                {commitBusy === 'commit' && (
                  <Loader2Icon size={14} className={styles.spin} />
                )}
                {t('gitCommit.commit')}
              </button>
              <button
                type="button"
                className={`${styles.commitBtn} ${styles.commitBtnSecondary}`}
                disabled={!commitMsg.trim() || !!commitBusy || prBusy}
                onClick={() => void doCommit(true)}
              >
                {commitBusy === 'push' && (
                  <Loader2Icon size={14} className={styles.spin} />
                )}
                {t('gitCommit.commitAndPush')}
              </button>
              {prsSupported && (
                <button
                  type="button"
                  className={`${styles.commitBtn} ${styles.commitBtnSecondary}`}
                  disabled={!!commitBusy || prBusy}
                  onClick={() => setPrFormOpen(!prFormOpen)}
                >
                  {t('gitCommit.createPr')}
                </button>
              )}
            </div>
            {prFormOpen && (
              <div className={styles.prForm}>
                <input
                  className={styles.prInput}
                  placeholder={
                    prGenerating
                      ? t('gitCommit.generating')
                      : t('gitCommit.prTitlePlaceholder')
                  }
                  value={prTitle}
                  disabled={prGenerating}
                  onChange={(e) => setPrTitle(e.target.value)}
                />
                <div className={styles.prBodyWrap}>
                  <div className={styles.prBodyToolbar}>
                    <button
                      type="button"
                      className={`${styles.prBodyTab} ${!prPreview ? styles.prBodyTabActive : ''}`}
                      onClick={() => setPrPreview(false)}
                    >
                      <PencilIcon size={12} />
                      {t('gitCommit.prEdit')}
                    </button>
                    <button
                      type="button"
                      className={`${styles.prBodyTab} ${prPreview ? styles.prBodyTabActive : ''}`}
                      onClick={() => setPrPreview(true)}
                    >
                      <EyeIcon size={12} />
                      {t('gitCommit.prPreview')}
                    </button>
                  </div>
                  {prPreview ? (
                    <div className={styles.prBodyPreview}>
                      {prBody ? (
                        <Markdown content={prBody} />
                      ) : (
                        <span className={styles.prBodyEmpty}>
                          {t('gitCommit.prBodyPlaceholder')}
                        </span>
                      )}
                    </div>
                  ) : (
                    <textarea
                      className={styles.prBody}
                      placeholder={
                        prGenerating
                          ? t('gitCommit.generating')
                          : t('gitCommit.prBodyPlaceholder')
                      }
                      value={prBody}
                      disabled={prGenerating}
                      onChange={(e) => setPrBody(e.target.value)}
                    />
                  )}
                </div>
                <div className={styles.prFormRow}>
                  <BranchSelect
                    value={prBase}
                    onChange={setPrBase}
                    branches={prBranches}
                    error={prBranchesError}
                    onRetry={loadPrBranches}
                  />
                  <button
                    type="button"
                    className={`${styles.commitBtn} ${styles.commitBtnPrimary}`}
                    disabled={
                      !prTitle.trim() || prBusy || prGenerating || !!commitBusy
                    }
                    onClick={() => void doCreatePr()}
                  >
                    {prBusy && (
                      <Loader2Icon size={14} className={styles.spin} />
                    )}
                    {t('gitCommit.prSubmit')}
                  </button>
                </div>
              </div>
            )}
            {prStatus && (
              <div
                className={`${styles.commitStatus} ${
                  prStatus.type === 'error'
                    ? styles.commitStatusError
                    : styles.commitStatusSuccess
                }`}
              >
                {prStatus.url ? (
                  <a
                    href={prStatus.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(event) => openExternalLink(event, prStatus.url)}
                  >
                    {prStatus.msg}
                  </a>
                ) : (
                  prStatus.msg
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </DialogShell>
  );
}

type BranchList = {
  local: string[];
  remotes: [string, string[]][];
} | null;

function BranchSelect({
  value,
  onChange,
  branches,
  error = false,
  onRetry,
}: {
  value: string;
  onChange: (v: string) => void;
  branches: BranchList;
  error?: boolean;
  onRetry?: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const q = search.toLowerCase().trim();

  const filteredRemotes = branches
    ? branches.remotes
        .map(
          ([remote, names]) =>
            [
              remote,
              names.filter((n) => !q || n.toLowerCase().includes(q)),
            ] as [string, string[]],
        )
        .filter(
          ([remote, names]) =>
            names.length > 0 || remote.toLowerCase().includes(q),
        )
    : [];

  const filteredLocal = branches
    ? branches.local.filter((n) => !q || n.toLowerCase().includes(q))
    : [];

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) setTimeout(() => inputRef.current?.focus(), 50);
        else setSearch('');
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={styles.branchSelectTrigger}
          aria-label={t('branchSelect.baseBranch')}
        >
          <span className={styles.branchSelectValue}>
            {value
              ? value.includes('/')
                ? value.slice(value.indexOf('/') + 1)
                : value
              : 'main'}
          </span>
          <ChevronDownIcon size={12} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className={styles.branchSelectPopover}
        side="bottom"
        align="start"
        sideOffset={4}
      >
        <div className={styles.branchSelectSearch}>
          <SearchIcon size={13} />
          <input
            ref={inputRef}
            className={styles.branchSelectInput}
            placeholder={t('branchSelect.search')}
            aria-label={t('branchSelect.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className={styles.branchSelectList}>
          {filteredRemotes.map(([remote, names]) => (
            <div key={remote}>
              <div className={styles.branchSelectGroup}>{remote}</div>
              {names.map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`${styles.branchSelectItem} ${
                    n === value ? styles.branchSelectItemActive : ''
                  }`}
                  onClick={() => {
                    onChange(n);
                    setOpen(false);
                  }}
                >
                  {n.includes('/') ? n.slice(n.indexOf('/') + 1) : n}
                </button>
              ))}
            </div>
          ))}
          {filteredLocal.length > 0 && (
            <div>
              <div className={styles.branchSelectGroup}>
                {t('branchSelect.local')}
              </div>
              {filteredLocal.map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`${styles.branchSelectItem} ${
                    n === value ? styles.branchSelectItemActive : ''
                  }`}
                  onClick={() => {
                    onChange(n);
                    setOpen(false);
                  }}
                >
                  {n}
                </button>
              ))}
            </div>
          )}
          {!branches &&
            (error ? (
              <div className={styles.branchSelectEmpty}>
                {t('branchSelect.error')}
                {onRetry && (
                  <button
                    type="button"
                    className={styles.branchSelectRetry}
                    onClick={onRetry}
                  >
                    {t('branchSelect.retry')}
                  </button>
                )}
              </div>
            ) : (
              <div className={styles.branchSelectEmpty}>
                {t('branchSelect.loading')}
              </div>
            ))}
          {branches &&
            filteredRemotes.length === 0 &&
            filteredLocal.length === 0 && (
              <div className={styles.branchSelectEmpty}>
                {t('branchSelect.noMatches')}
              </div>
            )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
