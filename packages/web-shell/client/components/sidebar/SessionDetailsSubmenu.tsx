import { useCallback, useEffect, useRef, useState } from 'react';
import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';
import { CheckIcon, CopyIcon, InfoIcon } from 'lucide-react';
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
  const [collisionBoundary, setCollisionBoundary] =
    useState<HTMLElement | null>(null);
  const collisionRepositionFrameRef = useRef<number | null>(null);

  const cancelCollisionReposition = useCallback(() => {
    if (collisionRepositionFrameRef.current !== null) {
      cancelAnimationFrame(collisionRepositionFrameRef.current);
      collisionRepositionFrameRef.current = null;
    }
  }, []);

  useEffect(() => {
    setCopied(false);
  }, [session.sessionId]);

  useEffect(() => {
    if (!open) {
      setCollisionBoundary(null);
      return;
    }

    const boundary = getCollisionBoundary();
    setCollisionBoundary(boundary);
    if (!boundary || typeof ResizeObserver === 'undefined') {
      return;
    }

    let hasInitialMeasurement = false;
    let lastWidth = 0;
    let lastHeight = 0;
    const observer = new ResizeObserver((entries) => {
      const entry = entries.find((candidate) => candidate.target === boundary);
      const { width, height } =
        entry?.contentRect ?? boundary.getBoundingClientRect();

      if (!hasInitialMeasurement) {
        hasInitialMeasurement = true;
        lastWidth = width;
        lastHeight = height;
        return;
      }
      if (width === lastWidth && height === lastHeight) {
        return;
      }

      lastWidth = width;
      lastHeight = height;
      if (collisionRepositionFrameRef.current !== null) return;

      setCollisionBoundary(null);
      collisionRepositionFrameRef.current = requestAnimationFrame(() => {
        collisionRepositionFrameRef.current = null;
        setCollisionBoundary(boundary);
      });
    });
    observer.observe(boundary);
    return () => {
      observer.disconnect();
      cancelCollisionReposition();
    };
  }, [cancelCollisionReposition, getCollisionBoundary, open]);

  useEffect(() => cancelCollisionReposition, [cancelCollisionReposition]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      cancelCollisionReposition();
      if (!nextOpen) {
        setCollisionBoundary(null);
      }
      setCopied(false);
      setOpen(nextOpen);
    },
    [cancelCollisionReposition],
  );

  const copySessionId = useCallback(async () => {
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
        throw new Error('Clipboard API is unavailable');
      }
      await navigator.clipboard.writeText(session.sessionId);
      setCopied(true);
    } catch (error: unknown) {
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
        collisionPadding={8}
        className={styles.sessionDetailsContent}
        onClick={(event) => event.stopPropagation()}
      >
        <div className={styles.tooltipContent}>
          <div className={styles.tooltipTitle}>{label}</div>
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
              className={styles.sessionDetailsCopyButton}
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
          {copied && (
            <span
              className={styles.sessionDetailsCopied}
              role="status"
              aria-live="polite"
            >
              {t('sidebar.sessionIdCopied')}
            </span>
          )}
        </div>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
