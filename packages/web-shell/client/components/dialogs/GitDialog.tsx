/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useState, type KeyboardEvent } from 'react';
import { useWorkspace } from '@qwen-code/webui/daemon-react-sdk';
import { useI18n } from '../../i18n';
import { DialogShell } from './DialogShell';
import { GitDiffContent } from './GitDiffDialog';
import { GitLogContent } from './GitLogDialog';
import { GitHubPrsContent } from './GitHubPrsDialog';
import styles from './GitDialog.module.css';

export type GitDialogView = 'diff' | 'log' | 'prs';

const GITHUB_PRS_FEATURE = 'workspace_github_prs';

const TITLE_KEYS: Record<GitDialogView, string> = {
  diff: 'gitDiff.title',
  log: 'gitLog.title',
  prs: 'githubPrs.title',
};

export function GitDialog({
  workspaceCwd,
  gitCwd,
  initialView,
  onClose,
}: {
  workspaceCwd: string;
  gitCwd?: string;
  initialView: GitDialogView;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { capabilities } = useWorkspace();
  const prsSupported =
    capabilities?.features?.includes(GITHUB_PRS_FEATURE) === true;
  const views: GitDialogView[] = prsSupported
    ? ['diff', 'log', 'prs']
    : ['diff', 'log'];
  const [view, setView] = useState(initialView);
  const [subtitle, setSubtitle] = useState<string>();

  // The PR tab can vanish after mount if the capability is withdrawn
  // mid-session (a daemon reconnect resets capabilities to undefined);
  // clamp the rendered view so the tablist, ARIA wiring, and content never
  // reference a tab that is no longer rendered.
  const effectiveView = views.includes(view) ? view : 'diff';

  const selectView = useCallback((next: GitDialogView) => {
    setSubtitle(undefined);
    setView(next);
  }, []);

  const selectAndFocus = (next: GitDialogView) => {
    selectView(next);
    document.getElementById(`git-dialog-tab-${next}`)?.focus();
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = views.indexOf(effectiveView);
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const delta = event.key === 'ArrowRight' ? 1 : -1;
      selectAndFocus(views[(index + delta + views.length) % views.length]);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      selectAndFocus(views[0]);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      selectAndFocus(views[views.length - 1]);
    }
  };

  return (
    <DialogShell
      title={t(TITLE_KEYS[effectiveView])}
      subtitle={subtitle}
      size="xl"
      allowFullscreen
      onClose={onClose}
    >
      <div className={styles.content}>
        <div className={styles.tabBar} role="tablist">
          {views.map((name) => (
            <button
              key={name}
              id={`git-dialog-tab-${name}`}
              type="button"
              role="tab"
              aria-selected={effectiveView === name}
              aria-controls="git-dialog-panel"
              tabIndex={effectiveView === name ? 0 : -1}
              className={`${styles.tab}${effectiveView === name ? ` ${styles.tabActive}` : ''}`}
              onClick={() => selectView(name)}
              onKeyDown={onTabKeyDown}
            >
              {t(TITLE_KEYS[name])}
            </button>
          ))}
        </div>
        <div
          id="git-dialog-panel"
          className={styles.tabPanel}
          role="tabpanel"
          aria-labelledby={`git-dialog-tab-${effectiveView}`}
        >
          {effectiveView === 'diff' ? (
            <GitDiffContent
              workspaceCwd={workspaceCwd}
              gitCwd={gitCwd}
              onSubtitleChange={setSubtitle}
            />
          ) : effectiveView === 'log' ? (
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
      </div>
    </DialogShell>
  );
}
