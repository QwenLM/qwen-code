/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useMemo, useState } from 'react';
import { CircleDotIcon, GitForkIcon } from 'lucide-react';
import { useI18n } from '../i18n';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import styles from './GitModePopover.module.css';

export type SessionGitIntent =
  | { mode: 'current' }
  | { mode: 'branch'; name: string }
  | { mode: 'worktree'; slug?: string };

function GitBranchIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      width={15}
      height={15}
    >
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

function validateBranchName(name: string): boolean {
  if (!name) return false;
  return !(
    /[^a-zA-Z0-9._/-]/.test(name) ||
    name.includes('..') ||
    name.startsWith('.') ||
    name.startsWith('-') ||
    name.startsWith('/') ||
    name.endsWith('/') ||
    name.endsWith('.')
  );
}

interface GitModePopoverProps {
  branch: string;
  compact?: boolean;
  intent: SessionGitIntent;
  onIntentChange: (intent: SessionGitIntent) => void;
}

export function GitModePopover({
  branch,
  compact = false,
  intent,
  onIntentChange,
}: GitModePopoverProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [selectedMode, setSelectedMode] = useState<
    'current' | 'branch' | 'worktree'
  >(intent.mode);
  const [branchName, setBranchName] = useState(
    intent.mode === 'branch' ? intent.name : '',
  );

  const branchValid = useMemo(
    () => validateBranchName(branchName),
    [branchName],
  );

  const handleOpenChange = useCallback(
    (v: boolean) => {
      setOpen(v);
      if (v) {
        setSelectedMode(intent.mode);
        setBranchName(intent.mode === 'branch' ? intent.name : '');
      }
    },
    [intent],
  );

  const handleSelectCurrent = useCallback(() => {
    onIntentChange({ mode: 'current' });
    setOpen(false);
  }, [onIntentChange]);

  const handleConfirmBranch = useCallback(() => {
    if (!branchName || !branchValid) return;
    onIntentChange({ mode: 'branch', name: branchName });
    setOpen(false);
  }, [branchName, branchValid, onIntentChange]);

  const handleConfirmWorktree = useCallback(() => {
    onIntentChange({ mode: 'worktree' });
    setOpen(false);
  }, [onIntentChange]);

  const handleClear = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onIntentChange({ mode: 'current' });
    },
    [onIntentChange],
  );

  const isBranch = intent.mode === 'branch';
  const isWorktree = intent.mode === 'worktree';
  const chipLabel = isBranch
    ? `→ ${intent.name}`
    : isWorktree
      ? t('gitMode.worktree')
      : branch;

  return (
    <span className={styles.wrap}>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={`${styles.chip} ${isBranch ? styles.chipBranch : ''} ${isWorktree ? styles.chipWorktree : ''} ${compact ? styles.chipCompact : ''}`}
            data-web-shell-git-branch
            data-testid="git-mode-chip"
            aria-label={t('gitMode.title')}
          >
            <span className={styles.chipIcon}>
              {isWorktree ? (
                <GitForkIcon size={14} strokeWidth={1.5} />
              ) : (
                <GitBranchIcon />
              )}
            </span>
            {!compact && <span className={styles.chipText}>{chipLabel}</span>}
            <svg
              className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`}
              viewBox="0 0 16 16"
              fill="currentColor"
              width={9}
              height={9}
              aria-hidden="true"
            >
              <path d="M4.427 7.427l3.396 3.396a.25.25 0 0 0 .354 0l3.396-3.396A.25.25 0 0 0 11.396 7H4.604a.25.25 0 0 0-.177.427Z" />
            </svg>
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          sideOffset={8}
          className={styles.popover}
        >
          <div className={styles.header}>{t('gitMode.title')}</div>

          <button
            type="button"
            className={`${styles.option} ${selectedMode === 'current' ? styles.optionSelected : ''}`}
            onClick={handleSelectCurrent}
          >
            <span className={`${styles.optionIcon} ${styles.iconCurrent}`}>
              <CircleDotIcon size={15} strokeWidth={1.5} />
            </span>
            <span className={styles.optionText}>
              <span className={styles.optionName}>{t('gitMode.current')}</span>
              <span className={styles.optionDesc}>
                {t('gitMode.currentDesc', { branch })}
              </span>
            </span>
            {selectedMode === 'current' && (
              <span className={styles.checkCurrent}>✓</span>
            )}
          </button>

          <button
            type="button"
            className={`${styles.option} ${selectedMode === 'branch' ? styles.optionSelected : ''}`}
            onClick={() => setSelectedMode('branch')}
          >
            <span className={`${styles.optionIcon} ${styles.iconBranch}`}>
              <GitBranchIcon />
            </span>
            <span className={styles.optionText}>
              <span className={styles.optionName}>{t('gitMode.branch')}</span>
              <span className={styles.optionDesc}>
                {t('gitMode.branchDesc', { branch })}
              </span>
            </span>
            {selectedMode === 'branch' && (
              <span className={styles.checkBranch}>✓</span>
            )}
          </button>

          {selectedMode === 'branch' && (
            <div className={styles.branchBox}>
              <div className={styles.branchRow}>
                <label className={styles.branchLabel}>
                  {t('gitMode.branchLabel')}
                </label>
                <span className={styles.branchInputWrap}>
                  <input
                    className={`${styles.branchInput} ${branchName && !branchValid ? styles.branchInputInvalid : ''} ${branchName && branchValid ? styles.branchInputValid : ''}`}
                    value={branchName}
                    onChange={(e) => setBranchName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && branchName && branchValid)
                        handleConfirmBranch();
                    }}
                    placeholder={t('gitMode.branchPlaceholder')}
                    autoFocus
                    spellCheck={false}
                    autoComplete="off"
                    data-testid="git-mode-branch-input"
                  />
                  {branchName && (
                    <span
                      className={styles.branchStatus}
                      style={{
                        color: branchValid
                          ? 'var(--web-shell-git-mode-valid, #3ddc97)'
                          : 'var(--web-shell-git-mode-invalid, #ff6b6b)',
                      }}
                    >
                      {branchValid ? '✓' : '✗'}
                    </span>
                  )}
                </span>
              </div>
              <div
                className={`${styles.branchHint} ${branchName && !branchValid ? styles.branchHintError : ''}`}
              >
                {branchName && !branchValid
                  ? t('gitMode.branchInvalidName')
                  : t('gitMode.branchConflictWarning')}
              </div>
            </div>
          )}

          <button
            type="button"
            className={`${styles.option} ${selectedMode === 'worktree' ? styles.optionSelected : ''}`}
            onClick={() => setSelectedMode('worktree')}
          >
            <span className={`${styles.optionIcon} ${styles.iconWorktree}`}>
              <GitForkIcon size={15} strokeWidth={1.5} />
            </span>
            <span className={styles.optionText}>
              <span className={styles.optionName}>{t('gitMode.worktree')}</span>
              <span className={styles.optionDesc}>
                {t('gitMode.worktreeDesc')}
              </span>
            </span>
            {selectedMode === 'worktree' && (
              <span className={styles.checkWorktree}>✓</span>
            )}
          </button>

          <div className={styles.footer}>
            <span className={styles.cmd}>
              {selectedMode === 'branch'
                ? `$ git checkout -b ${branchName || '…'} ← ${branch}`
                : selectedMode === 'worktree'
                  ? '$ git worktree add .qwen/worktrees/<slug>'
                  : `$ git checkout ${branch}`}
            </span>
            {selectedMode === 'branch' && (
              <button
                type="button"
                className={styles.confirmBranch}
                disabled={!branchName || !branchValid}
                onClick={handleConfirmBranch}
                data-testid="git-mode-confirm-branch"
              >
                {t('gitMode.confirmBranch')}
              </button>
            )}
            {selectedMode === 'worktree' && (
              <button
                type="button"
                className={styles.confirmWorktree}
                onClick={handleConfirmWorktree}
                data-testid="git-mode-confirm-worktree"
              >
                {t('gitMode.confirmWorktree')}
              </button>
            )}
          </div>
        </PopoverContent>
      </Popover>
      {(isBranch || isWorktree) && (
        <button
          type="button"
          className={styles.clearBtn}
          onClick={handleClear}
          title={t('gitMode.resetToCurrent')}
          data-testid="git-mode-clear"
        >
          ✕
        </button>
      )}
    </span>
  );
}
