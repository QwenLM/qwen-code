import { useCallback, useEffect, useRef, useState } from 'react';
import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';
import { CheckIcon, CopyIcon, InfoIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '../../i18n';
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '../ui/dropdown-menu';
import styles from './WebShellSidebar.module.css';

interface SessionDetailsSubmenuProps {
  session: DaemonSessionSummary;
  label: string;
  completedUnread: boolean;
  onError: (error: unknown, fallback: string) => void;
  getCollisionBoundary: () => HTMLElement | null;
}

const COLLISION_PADDING = 8;

export function SessionDetailsSubmenu({
  session,
  label,
  completedUnread,
  onError,
  getCollisionBoundary,
}: SessionDetailsSubmenuProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyAttemptRef = useRef(0);
  const currentSessionIdRef = useRef(session.sessionId);
  currentSessionIdRef.current = session.sessionId;
  const collisionBoundary = open ? getCollisionBoundary() : null;

  useEffect(() => {
    setCopied(false);
  }, [session.sessionId]);

  useEffect(
    () => () => {
      copyAttemptRef.current += 1;
    },
    [],
  );

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (!nextOpen) {
      copyAttemptRef.current += 1;
    }
    setCopied(false);
    setOpen(nextOpen);
  }, []);

  const copySessionId = useCallback(async () => {
    const sessionId = session.sessionId;
    const copyAttempt = ++copyAttemptRef.current;
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
        throw new Error('Clipboard API is unavailable');
      }
      await navigator.clipboard.writeText(sessionId);
      if (
        copyAttemptRef.current !== copyAttempt ||
        currentSessionIdRef.current !== sessionId
      ) {
        return;
      }
      setCopied(true);
    } catch (error: unknown) {
      if (
        copyAttemptRef.current !== copyAttempt ||
        currentSessionIdRef.current !== sessionId
      ) {
        return;
      }
      setCopied(false);
      onError(error, t('sidebar.copySessionIdFailed'));
    }
  }, [onError, session.sessionId, t]);

  return (
    <DropdownMenuSub open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuSubTrigger>
        <InfoIcon />
        {t('sidebar.details')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        avoidCollisions
        collisionBoundary={collisionBoundary ?? undefined}
        collisionPadding={COLLISION_PADDING}
        // Radix's optimized strategy does not observe the non-portal WebShell root.
        updatePositionStrategy="always"
        className={cn(styles.sessionDetailsContent, 'min-w-0 p-3')}
      >
        <div className={styles.tooltipContent}>
          <div className={styles.tooltipTitle} title={label}>
            {label}
          </div>
          <div className={styles.tooltipTags}>
            {session.hasActivePrompt && (
              <span
                className={`${styles.tooltipTag} ${styles.tooltipTagRunning}`}
              >
                {t('sidebar.running')}
              </span>
            )}
            {completedUnread && (
              <span className={`${styles.tooltipTag} ${styles.tooltipTagNew}`}>
                {t('sidebar.completedUnread')}
              </span>
            )}
            <span className={styles.tooltipTag}>
              {t('sidebar.clients', { count: session.clientCount ?? 0 })}
            </span>
          </div>
          <div className={styles.sessionDetailsIdRow}>
            <span className={styles.sessionDetailsId} title={session.sessionId}>
              {session.sessionId}
            </span>
            <DropdownMenuItem
              className={cn(styles.sessionDetailsCopyButton, 'cursor-pointer')}
              aria-label={t('sidebar.copySessionId')}
              title={t('sidebar.copySessionId')}
              onSelect={(event) => {
                event.preventDefault();
                void copySessionId();
              }}
            >
              {copied ? (
                <CheckIcon aria-hidden="true" />
              ) : (
                <CopyIcon aria-hidden="true" />
              )}
            </DropdownMenuItem>
          </div>
          <span
            className={styles.sessionDetailsCopied}
            role="status"
            aria-live="polite"
          >
            {copied ? t('sidebar.sessionIdCopied') : ''}
          </span>
        </div>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
