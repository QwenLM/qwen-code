/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonWorkspaceGitStatus } from '@qwen-code/sdk/daemon';
import { CircleDotIcon, LayersIcon, TriangleAlertIcon } from 'lucide-react';
import { useI18n } from '../i18n';
import styles from './ChatEditor.module.css';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './ui/tooltip';

function GitBranchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="6" cy="5" r="2.5" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="18" cy="6" r="2.5" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="6" cy="19" r="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M6 7.5v9M8.5 12h3.25A6.25 6.25 0 0 0 18 5.75"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Tone of the compact badge dot, by descending severity. */
type BadgeTone = 'error' | 'warning' | 'accent';

interface DerivedStatus {
  detached: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  ahead: number;
  behind: number;
  stashCount: number;
  operation?: DaemonWorkspaceGitStatus['operation'];
  dirty: boolean;
}

function deriveStatus(status?: DaemonWorkspaceGitStatus): DerivedStatus {
  const staged = status?.staged ?? 0;
  const unstaged = status?.unstaged ?? 0;
  const untracked = status?.untracked ?? 0;
  return {
    detached: status?.detached ?? false,
    staged,
    unstaged,
    untracked,
    conflicted: status?.conflicted ?? 0,
    ahead: status?.ahead ?? 0,
    behind: status?.behind ?? 0,
    stashCount: status?.stashCount ?? 0,
    operation: status?.operation,
    dirty: staged + unstaged + untracked > 0,
  };
}

/** Compact badge tone for the icon-only (compact) chip; null when clean. */
function badgeTone(s: DerivedStatus): BadgeTone | null {
  if (s.conflicted > 0) return 'error';
  if (s.operation) return 'warning';
  if (s.detached) return 'warning';
  if (s.dirty) return 'accent';
  return null;
}

export function GitBranchIndicator({
  branch,
  status,
  compact = false,
  onOpenDiff,
}: {
  branch: string;
  status?: DaemonWorkspaceGitStatus;
  compact?: boolean;
  onOpenDiff?: () => void;
}) {
  const { t } = useI18n();
  const s = deriveStatus(status);

  // Localized state phrases drive both the accessible label and the tooltip,
  // so the two never drift apart.
  const phrases: string[] = [];
  if (s.operation) phrases.push(t(`git.operation.${s.operation}`));
  if (s.detached) phrases.push(t('git.detached'));
  if (s.conflicted > 0)
    phrases.push(t('git.conflicted', { count: s.conflicted }));
  if (s.staged > 0) phrases.push(t('git.staged', { count: s.staged }));
  if (s.unstaged > 0) phrases.push(t('git.unstaged', { count: s.unstaged }));
  if (s.untracked > 0) phrases.push(t('git.untracked', { count: s.untracked }));
  if (s.ahead > 0) phrases.push(t('git.ahead', { count: s.ahead }));
  if (s.behind > 0) phrases.push(t('git.behind', { count: s.behind }));
  if (s.stashCount > 0) phrases.push(t('git.stash', { count: s.stashCount }));

  const ariaLabel =
    phrases.length > 0
      ? `${t('git.currentBranch', { branch })} — ${phrases.join(', ')}`
      : t('git.currentBranch', { branch });

  const tone = badgeTone(s);

  const chipClassName = `${styles.gitBranchChip} ${
    compact ? styles.gitBranchChipCompact : ''
  } ${onOpenDiff ? styles.gitBranchChipButton : ''}`;

  const chipDataAttrs = {
    'data-web-shell-git-branch': true,
    'data-detached': s.detached ? 'true' : undefined,
    'data-dirty': s.dirty ? 'true' : undefined,
    'data-operation': s.operation ?? undefined,
    'data-clickable': onOpenDiff ? 'true' : undefined,
  } as const;

  const chipInner = (
    <>
      <span className={styles.gitBranchIconWrap}>
        <span className={styles.gitBranchIcon}>
          {s.detached ? <CircleDotIcon /> : <GitBranchIcon />}
        </span>
        {compact && tone && (
          <span
            className={styles.gitBranchBadgeDot}
            data-tone={tone}
            aria-hidden="true"
          />
        )}
      </span>
      <span className={styles.gitBranchText}>{branch}</span>
      {!compact && (
        <span className={styles.gitBranchIndicators} aria-hidden="true">
          {s.operation && (
            <span className={styles.gitBranchOperation}>
              {t(`git.operation.${s.operation}`)}
            </span>
          )}
          {s.conflicted > 0 && (
            <span className={styles.gitBranchConflicted}>
              <TriangleAlertIcon />
              {s.conflicted}
            </span>
          )}
          {s.dirty && <span className={styles.gitBranchDirtyDot} />}
          {s.ahead > 0 && (
            <span className={styles.gitBranchAheadBehind}>↑{s.ahead}</span>
          )}
          {s.behind > 0 && (
            <span className={styles.gitBranchAheadBehind}>↓{s.behind}</span>
          )}
          {s.stashCount > 0 && (
            <span className={styles.gitBranchStash}>
              <LayersIcon />
              {s.stashCount}
            </span>
          )}
        </span>
      )}
    </>
  );

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          {onOpenDiff ? (
            <button
              type="button"
              className={chipClassName}
              aria-label={ariaLabel}
              onClick={onOpenDiff}
              {...chipDataAttrs}
            >
              {chipInner}
            </button>
          ) : (
            <output
              className={chipClassName}
              aria-label={ariaLabel}
              {...chipDataAttrs}
            >
              {chipInner}
            </output>
          )}
        </TooltipTrigger>
        <TooltipContent side="top">
          <div className={styles.gitBranchTooltip}>
            <div className={styles.gitBranchTooltipTitle}>
              {s.detached ? t('git.detached') : branch}
            </div>
            {phrases.length > 0 ? (
              phrases.map((phrase) => (
                <div key={phrase} className={styles.gitBranchTooltipRow}>
                  {phrase}
                </div>
              ))
            ) : status?.computedAt !== undefined ? (
              <div className={styles.gitBranchTooltipRow}>{t('git.clean')}</div>
            ) : null}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
