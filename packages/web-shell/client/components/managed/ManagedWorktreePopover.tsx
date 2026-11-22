import { useRef } from 'react';
import { CircleDotIcon, GitBranchIcon, GitForkIcon } from 'lucide-react';
import { useI18n } from '../../i18n';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import styles from '../GitModePopover.module.css';
import { useManagedWorktreeText } from './managed-worktree-messages';

export function ManagedWorktreePopover({
  worktree,
  currentBranch,
  open,
  onOpenChange,
  disabled,
  onWorktreeChange,
  onManage,
}: {
  worktree: boolean;
  currentBranch?: string | null;
  open: boolean;
  onOpenChange: (value: boolean) => void;
  disabled: boolean;
  onWorktreeChange: (value: boolean) => void;
  onManage: () => void;
}) {
  const { t } = useI18n();
  const text = useManagedWorktreeText();
  const contentRef = useRef<HTMLDivElement>(null);
  const label = worktree
    ? t('gitMode.worktree')
    : currentBranch || text('mode');

  return (
    <span className={styles.wrap}>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            className={`${styles.chip} ${worktree ? styles.chipWorktree : ''}`}
            aria-label={`${text(!worktree && currentBranch ? 'branch' : 'mode')}: ${label}`}
            data-web-shell-git-branch
            data-testid="managed-worktree-chip"
          >
            <span className={styles.chipIcon}>
              {worktree ? (
                <GitForkIcon size={14} />
              ) : currentBranch ? (
                <GitBranchIcon size={15} />
              ) : (
                <CircleDotIcon size={15} />
              )}
            </span>
            <span className={styles.chipText}>{label}</span>
            <span className={styles.chevron} aria-hidden="true">
              ▾
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          ref={contentRef}
          side="top"
          align="end"
          sideOffset={8}
          className={styles.popover}
          onClick={(event) => event.stopPropagation()}
          onInteractOutside={(event) => {
            if (contentRef.current?.contains(event.target as Node))
              event.preventDefault();
          }}
        >
          <div className={styles.header}>{t('gitMode.title')}</div>
          {([false, true] as const).map((isolated) => (
            <button
              key={String(isolated)}
              type="button"
              role="radio"
              aria-checked={worktree === isolated}
              disabled={disabled}
              className={`${styles.option} ${worktree === isolated ? styles.optionSelected : ''}`}
              onClick={() => {
                onWorktreeChange(isolated);
                onOpenChange(false);
              }}
            >
              <span
                className={`${styles.optionIcon} ${isolated ? styles.iconWorktree : styles.iconCurrent}`}
              >
                {isolated ? (
                  <GitForkIcon size={15} />
                ) : (
                  <CircleDotIcon size={15} />
                )}
              </span>
              <span className={styles.optionText}>
                <span className={styles.optionName}>
                  {isolated
                    ? t('gitMode.worktree')
                    : currentBranch
                      ? t('gitMode.current')
                      : text('current')}
                </span>
                {isolated && (
                  <span className={styles.optionDesc}>
                    {t('gitMode.worktreeDesc')}
                  </span>
                )}
                {!isolated && currentBranch && (
                  <span className={styles.optionDesc}>
                    {t('gitMode.currentDesc', { branch: currentBranch })}
                  </span>
                )}
              </span>
              {worktree === isolated && (
                <span
                  className={
                    isolated ? styles.checkWorktree : styles.checkCurrent
                  }
                  aria-hidden="true"
                >
                  ✓
                </span>
              )}
            </button>
          ))}
          <div className={styles.footer}>
            <button
              type="button"
              disabled={disabled}
              className={styles.option}
              onClick={() => {
                onOpenChange(false);
                onManage();
              }}
            >
              {text('manage')}
            </button>
          </div>
        </PopoverContent>
      </Popover>
      {worktree && (
        <button
          type="button"
          disabled={disabled}
          className={styles.clearBtn}
          onClick={(event) => {
            event.stopPropagation();
            onWorktreeChange(false);
            onOpenChange(false);
          }}
          aria-label={t('gitMode.resetToCurrent')}
          title={t('gitMode.resetToCurrent')}
          data-testid="managed-worktree-clear"
        >
          ✕
        </button>
      )}
    </span>
  );
}
