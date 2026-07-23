/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useState, type KeyboardEvent } from 'react';
import { useI18n } from '../../i18n';
import { DialogShell } from './DialogShell';
import { GitDiffContent } from './GitDiffDialog';
import { GitLogContent } from './GitLogDialog';
import styles from './GitDialog.module.css';

export type GitDialogView = 'diff' | 'log';

export function GitDialog({
  workspaceCwd,
  initialView,
  onClose,
}: {
  workspaceCwd: string;
  initialView: GitDialogView;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [view, setView] = useState(initialView);
  const [subtitle, setSubtitle] = useState<string>();

  const selectView = useCallback((next: GitDialogView) => {
    setSubtitle(undefined);
    setView(next);
  }, []);

  const selectAndFocus = (next: GitDialogView) => {
    selectView(next);
    document.getElementById(`git-dialog-tab-${next}`)?.focus();
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      selectAndFocus(view === 'diff' ? 'log' : 'diff');
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      selectAndFocus('diff');
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      selectAndFocus('log');
    }
  };

  const title = view === 'diff' ? t('gitDiff.title') : t('gitLog.title');

  return (
    <DialogShell
      title={title}
      subtitle={subtitle}
      size="xl"
      allowFullscreen
      onClose={onClose}
    >
      <div className={styles.content}>
        <div className={styles.tabBar} role="tablist">
          <button
            id="git-dialog-tab-diff"
            type="button"
            role="tab"
            aria-selected={view === 'diff'}
            aria-controls="git-dialog-panel"
            tabIndex={view === 'diff' ? 0 : -1}
            className={`${styles.tab}${view === 'diff' ? ` ${styles.tabActive}` : ''}`}
            onClick={() => selectView('diff')}
            onKeyDown={onTabKeyDown}
          >
            {t('gitDiff.title')}
          </button>
          <button
            id="git-dialog-tab-log"
            type="button"
            role="tab"
            aria-selected={view === 'log'}
            aria-controls="git-dialog-panel"
            tabIndex={view === 'log' ? 0 : -1}
            className={`${styles.tab}${view === 'log' ? ` ${styles.tabActive}` : ''}`}
            onClick={() => selectView('log')}
            onKeyDown={onTabKeyDown}
          >
            {t('gitLog.title')}
          </button>
        </div>
        <div
          id="git-dialog-panel"
          className={styles.tabPanel}
          role="tabpanel"
          aria-labelledby={`git-dialog-tab-${view}`}
        >
          {view === 'diff' ? (
            <GitDiffContent
              workspaceCwd={workspaceCwd}
              onSubtitleChange={setSubtitle}
            />
          ) : (
            <GitLogContent
              workspaceCwd={workspaceCwd}
              onSubtitleChange={setSubtitle}
            />
          )}
        </div>
      </div>
    </DialogShell>
  );
}
