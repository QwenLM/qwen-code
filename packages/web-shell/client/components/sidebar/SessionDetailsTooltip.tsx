import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';
import {
  CheckIcon,
  CopyIcon,
  FolderClosedIcon,
  GitBranchIcon,
  RadioTowerIcon,
} from 'lucide-react';
import { useI18n } from '../../i18n';
import { workspaceBasename } from '../../utils/workspace';
import { Popover, PopoverAnchor, PopoverContent } from '../ui/popover';
import styles from './WebShellSidebar.module.css';
import { resolveSessionDetailsCollisionBoundary } from './sessionDetailsCollisionBoundary';

interface SessionDetailsTooltipProps {
  session: DaemonSessionSummary;
  label: string;
  time: string;
  completedUnread: boolean;
  children: ReactElement;
}

export function SessionDetailsTooltip({
  session,
  label,
  time,
  completedUnread,
  children,
}: SessionDetailsTooltipProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>(
    'idle',
  );
  const copyAttemptRef = useRef(0);
  const copyResetTimerRef = useRef<number | undefined>(undefined);
  const openTimerRef = useRef<number | undefined>(undefined);
  const closeTimerRef = useRef<number | undefined>(undefined);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const collisionBoundary = open
    ? resolveSessionDetailsCollisionBoundary(
        anchorRef.current?.closest<HTMLElement>('aside') ?? null,
      )
    : null;
  const folderPath = session.workspaceCwd;
  const folderName = workspaceBasename(folderPath);
  const branch = session.worktree?.branch ?? session.branch?.name;
  const status = session.hasActivePrompt
    ? t('sidebar.running')
    : completedUnread
      ? t('sidebar.completedUnread')
      : t('sidebar.clients', { count: session.clientCount ?? 0 });

  useEffect(() => {
    return () => {
      window.clearTimeout(openTimerRef.current);
      window.clearTimeout(closeTimerRef.current);
      window.clearTimeout(copyResetTimerRef.current);
      copyAttemptRef.current += 1;
    };
  }, []);

  useEffect(() => {
    copyAttemptRef.current += 1;
    window.clearTimeout(copyResetTimerRef.current);
    setCopyStatus('idle');
  }, [session.sessionId]);

  const cancelClose = () => window.clearTimeout(closeTimerRef.current);
  const openAfterDelay = () => {
    cancelClose();
    if (open) return;
    window.clearTimeout(openTimerRef.current);
    openTimerRef.current = window.setTimeout(() => setOpen(true), 300);
  };
  const close = () => {
    window.clearTimeout(openTimerRef.current);
    cancelClose();
    setOpen(false);
    copyAttemptRef.current += 1;
    window.clearTimeout(copyResetTimerRef.current);
    setCopyStatus('idle');
  };
  const closeAfterDelay = () => {
    window.clearTimeout(openTimerRef.current);
    cancelClose();
    closeTimerRef.current = window.setTimeout(close, 100);
  };
  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) setOpen(true);
    else close();
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverAnchor
        ref={anchorRef}
        asChild
        onPointerEnter={(event) => {
          if (event.currentTarget.contains(event.target as Node)) {
            openAfterDelay();
          }
        }}
        onPointerLeave={closeAfterDelay}
        onPointerDownCapture={close}
        onClick={() => handleOpenChange(false)}
      >
        {children}
      </PopoverAnchor>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={0}
        collisionBoundary={collisionBoundary ?? undefined}
        collisionPadding={8}
        updatePositionStrategy="always"
        showArrow
        role="dialog"
        aria-label={label}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onPointerEnter={cancelClose}
        onPointerLeave={closeAfterDelay}
        className={styles.sessionDetailsTooltip}
      >
        <div className={styles.sessionDetailsHeader}>
          <span className={styles.sessionDetailsTitle} title={label}>
            {label}
          </span>
          {time && <span className={styles.sessionDetailsTime}>{time}</span>}
        </div>
        <div className={styles.sessionDetailsRow}>
          <FolderClosedIcon aria-hidden="true" />
          <span title={folderPath}>{folderName}</span>
        </div>
        {branch && (
          <div className={styles.sessionDetailsRow}>
            <GitBranchIcon aria-hidden="true" />
            <span title={branch}>{branch}</span>
          </div>
        )}
        <div className={styles.sessionDetailsRow}>
          <RadioTowerIcon aria-hidden="true" />
          <span>{status}</span>
        </div>
        <div className={styles.sessionDetailsIdRow}>
          <span title={session.sessionId}>{session.sessionId}</span>
          <button
            type="button"
            tabIndex={-1}
            className={styles.sessionDetailsCopyButton}
            aria-label={t('sidebar.copySessionId')}
            title={t('sidebar.copySessionId')}
            onClick={() => {
              const copyAttempt = ++copyAttemptRef.current;
              if (
                typeof navigator === 'undefined' ||
                !navigator.clipboard?.writeText
              ) {
                setCopyStatus('failed');
                return;
              }
              void navigator.clipboard
                .writeText(session.sessionId)
                .then(() => {
                  if (copyAttemptRef.current === copyAttempt) {
                    setCopyStatus('copied');
                    window.clearTimeout(copyResetTimerRef.current);
                    copyResetTimerRef.current = window.setTimeout(() => {
                      if (copyAttemptRef.current === copyAttempt) {
                        setCopyStatus('idle');
                      }
                    }, 2000);
                  }
                })
                .catch(() => {
                  if (copyAttemptRef.current === copyAttempt) {
                    setCopyStatus('failed');
                  }
                });
            }}
          >
            {copyStatus === 'copied' ? (
              <CheckIcon aria-hidden="true" />
            ) : (
              <CopyIcon aria-hidden="true" />
            )}
          </button>
          <span
            className={
              copyStatus === 'copied' ? 'sr-only' : styles.sessionDetailsCopied
            }
            aria-live="polite"
          >
            {copyStatus === 'copied'
              ? t('sidebar.sessionIdCopied')
              : copyStatus === 'failed'
                ? t('sidebar.copySessionIdFailed')
                : ''}
          </span>
        </div>
      </PopoverContent>
    </Popover>
  );
}
