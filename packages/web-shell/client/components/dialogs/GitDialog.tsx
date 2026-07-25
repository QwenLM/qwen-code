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
import { EyeIcon, Loader2Icon, PencilIcon } from 'lucide-react';
import { useI18n } from '../../i18n';
import { Markdown } from '../messages/Markdown';
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
  const { client, capabilities } = useWorkspace();
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
  const genAbortRef = useRef<AbortController | null>(null);
  const resolveSessionRef = useRef(resolveSessionForWorkspace);
  resolveSessionRef.current = resolveSessionForWorkspace;

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
          const fresh = await resolveSessionRef.current(workspaceCwd, true);
          if (fresh && fresh !== sid && !signal.aborted) {
            return client.btwSession(fresh, prompt, { signal });
          }
        }
        throw err;
      }
    },
    [client, workspaceCwd],
  );
  const btwWithRetryRef = useRef(btwWithRetry);
  btwWithRetryRef.current = btwWithRetry;

  const isCommit = view === 'commit';
  const effectiveTab = isCommit ? 'diff' : view;

  // Auto-generate commit message via session side-query when commit view opens.
  useEffect(() => {
    if (!isCommit) return;
    const abort = new AbortController();
    genAbortRef.current = abort;
    setGenerating(true);
    setCommitMsg('');

    const resolveSession = resolveSessionRef.current
      ? resolveSessionRef.current(workspaceCwd)
      : sessionId
        ? Promise.resolve(sessionId)
        : Promise.resolve(undefined);

    resolveSession
      .then((sid) => {
        if (abort.signal.aborted || !sid) {
          if (!abort.signal.aborted) setGenerating(false);
          return;
        }
        const ws = client.workspaceByCwd(workspaceCwd);
        return ws.workspaceGitDiff(gitCwd).then((diff) => {
          if (abort.signal.aborted) return;
          if (diff.files.length === 0) {
            setGenerating(false);
            return;
          }
          const fileSummary = diff.files
            .map((f: DaemonWorkspaceGitDiffFile) => {
              const status = f.isUntracked
                ? 'new'
                : f.isDeleted
                  ? 'deleted'
                  : 'modified';
              return `${status}: ${f.path}`;
            })
            .join('\n');
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
        // Diff fetch or btw failed — leave textarea empty.
      })
      .finally(() => {
        if (!abort.signal.aborted) setGenerating(false);
      });

    return () => {
      abort.abort();
    };
  }, [isCommit, sessionId, client, workspaceCwd, gitCwd]);

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
      if (!commitMsg.trim()) return;
      setCommitBusy(andPush ? 'push' : 'commit');
      setCommitStatus(null);
      try {
        const ws = client.workspaceByCwd(workspaceCwd);
        const result = await ws.workspaceGitCommit(commitMsg.trim(), {
          all: true,
        });
        if (andPush) {
          await ws.workspaceGitPush({ setUpstream: true });
          setCommitStatus({
            msg: t('gitCommit.commitPushSuccess', { sha: result.sha }),
            type: 'success',
          });
        } else {
          setCommitStatus({
            msg: t('gitCommit.commitSuccess', { sha: result.sha }),
            type: 'success',
          });
        }
        setCommitMsg('');
      } catch (err) {
        setCommitStatus({
          msg: err instanceof Error ? err.message : String(err),
          type: 'error',
        });
      } finally {
        setCommitBusy(null);
      }
    },
    [client, workspaceCwd, commitMsg, t],
  );

  // Auto-fill PR form when it opens.
  useEffect(() => {
    if (!prFormOpen || !isCommit) return;
    const ws = client.workspaceByCwd(workspaceCwd);

    // Fetch branch list for the target-branch dropdown (independent).
    ws.workspaceGitBranches()
      .then((branches) => {
        const local = branches.local.map((b) => b.name);
        const remoteMap = new Map<string, string[]>();
        for (const b of branches.remote) {
          const slash = b.name.indexOf('/');
          const remote = slash > 0 ? b.name.slice(0, slash) : 'other';
          const short = slash > 0 ? b.name.slice(slash + 1) : b.name;
          let list = remoteMap.get(remote);
          if (!list) {
            list = [];
            remoteMap.set(remote, list);
          }
          list.push(short);
        }
        setPrBranches({ local, remotes: Array.from(remoteMap.entries()) });
      })
      .catch(() => setPrBranches(null));

    setPrGenerating(true);
    setPrTitle('');
    setPrBody('');
    const abort = new AbortController();

    // Resolve base branch, session, then generate — all chained.
    const baseBranchPromise = ws
      .workspaceGitHubDefaultBranch()
      .then((r) => r.branch)
      .catch(() => 'main');

    const resolveSession = resolveSessionRef.current
      ? resolveSessionRef.current(workspaceCwd)
      : sessionId
        ? Promise.resolve(sessionId)
        : Promise.resolve(undefined);

    Promise.all([baseBranchPromise, resolveSession])
      .then(([base, sid]) => {
        if (abort.signal.aborted) return;
        setPrBase(base);
        if (!sid) {
          ws.workspaceGit()
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
          ws.workspaceGitLog(50, 0, gitCwd, `${base}..HEAD`),
          ws.workspaceGitDiff(gitCwd),
        ]).then(([log, diff]) => {
          if (abort.signal.aborted) return;
          // Build context from branch commits + uncommitted changes.
          const commitSummary =
            log.entries.length > 0
              ? log.entries
                  .map((e) => `- ${e.shortSha} ${e.subject}`)
                  .join('\n')
              : '(no commits ahead of base)';
          const uncommitted = diff.files
            .map((f: DaemonWorkspaceGitDiffFile) => {
              const status = f.isUntracked
                ? 'new'
                : f.isDeleted
                  ? 'deleted'
                  : 'modified';
              return `${status}: ${f.path}`;
            })
            .join('\n');
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
            `|  macOS  | ✅ |\n` +
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
          ws.workspaceGit()
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
  }, [prFormOpen, isCommit, sessionId, client, workspaceCwd, gitCwd]);

  const doCreatePr = useCallback(async () => {
    if (!prTitle.trim()) return;
    setPrBusy(true);
    setPrStatus(null);
    try {
      const ws = client.workspaceByCwd(workspaceCwd);
      const result = await ws.workspaceGitHubCreatePullRequest({
        title: prTitle.trim(),
        body: prBody.trim() || undefined,
        base: prBase.trim() || undefined,
      });
      setPrStatus({
        msg: t('gitCommit.prCreated', { number: result.number }),
        type: 'success',
        url: result.url,
      });
      setPrFormOpen(false);
    } catch (err) {
      setPrStatus({
        msg: err instanceof Error ? err.message : String(err),
        type: 'error',
      });
    } finally {
      setPrBusy(false);
    }
  }, [client, workspaceCwd, prTitle, prBody, prBase, t]);

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
          {isCommit && (
            <span className={`${styles.tab} ${styles.tabActive}`}>
              {t('gitCommit.title')}
            </span>
          )}
        </div>
        <div
          id="git-dialog-panel"
          className={styles.tabPanel}
          role="tabpanel"
          aria-labelledby={`git-dialog-tab-${clampedTab}`}
        >
          {clampedTab === 'diff' || isCommit ? (
            <GitDiffContent
              workspaceCwd={workspaceCwd}
              gitCwd={gitCwd}
              onSubtitleChange={setSubtitle}
            />
          ) : clampedTab === 'log' ? (
            <GitLogContent
              workspaceCwd={workspaceCwd}
              gitCwd={gitCwd}
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
                disabled={!commitMsg.trim() || !!commitBusy}
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
                disabled={!commitMsg.trim() || !!commitBusy}
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
                  <select
                    className={styles.prSelect}
                    value={prBase}
                    onChange={(e) => setPrBase(e.target.value)}
                  >
                    {prBranches ? (
                      <>
                        {prBranches.remotes.map(([remote, names]) => (
                          <optgroup key={remote} label={remote}>
                            {names.map((n) => (
                              <option key={`${remote}/${n}`} value={n}>
                                {n}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                        {prBranches.local.length > 0 && (
                          <optgroup label={t('branchPicker.section.local')}>
                            {prBranches.local.map((n) => (
                              <option key={n} value={n}>
                                {n}
                              </option>
                            ))}
                          </optgroup>
                        )}
                      </>
                    ) : (
                      <option value={prBase}>{prBase || 'main'}</option>
                    )}
                  </select>
                  <button
                    type="button"
                    className={`${styles.commitBtn} ${styles.commitBtnPrimary}`}
                    disabled={!prTitle.trim() || prBusy}
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
