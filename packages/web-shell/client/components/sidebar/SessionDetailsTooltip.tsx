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
import { useExternalLinkOpener } from '../../hooks/useExternalLinkOpener';
import { writeClipboardText } from '../../utils/clipboard';
import { isExternalOpenUrl } from '../../utils/externalOpen';
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from '../ui/popover';
import {
  SessionIssueStateIcon,
  SessionPrStateIcon,
  sessionIssueStateLabel,
  sessionPrStateLabel,
} from '../SessionPrStateIcon';
import styles from './WebShellSidebar.module.css';
import { resolveSessionDetailsCollisionBoundary } from './sessionDetailsCollisionBoundary';

interface SessionDetailsTooltipProps {
  session: DaemonSessionSummary;
  label: string;
  time: string;
  completedUnread: boolean;
  workspaceLabel?: string;
  openOnClick?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactElement;
}

export function SessionDetailsTooltip({
  session,
  label,
  time,
  completedUnread,
  workspaceLabel,
  openOnClick = false,
  open: controlledOpen,
  onOpenChange,
  children,
}: SessionDetailsTooltipProps) {
  const { t } = useI18n();
  const openExternalLink = useExternalLinkOpener();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = onOpenChange ?? setUncontrolledOpen;
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>(
    'idle',
  );
  const copyAttemptRef = useRef(0);
  const copyResetTimerRef = useRef<number | undefined>(undefined);
  const openTimerRef = useRef<number | undefined>(undefined);
  const closeTimerRef = useRef<number | undefined>(undefined);
  const anchorRef = useRef<HTMLElement | null>(null);
  const copyButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);
  const collisionBoundary = open
    ? resolveSessionDetailsCollisionBoundary(anchorRef.current)
    : null;
  const folderPath = session.workspaceCwd;
  const branch = session.worktree?.branch ?? session.branch?.name;
  const prs = [...(session.prs ?? [])]
    .reverse()
    .filter((pr) => isExternalOpenUrl(pr.url));
  // Stacked PRs can close the same issue; list it once, under its newest PR.
  const seenIssueUrls = new Set<string>();
  const issues = prs
    .flatMap((pr) => pr.issues ?? [])
    .filter(
      (issue) =>
        isExternalOpenUrl(issue.url) &&
        !seenIssueUrls.has(issue.url) &&
        seenIssueUrls.add(issue.url),
    );
  const status = session.isWaitingForPermission
    ? t('sessionsOverview.status.needsApproval')
    : session.isWaitingForUserQuestion
      ? t('sessionsOverview.status.askUserQuestion')
      : session.hasActivePrompt
        ? t('sidebar.running')
        : completedUnread
          ? t('sidebar.completedUnread')
          : `${t('sessionsOverview.status.idle')} · ${t('sidebar.clients', { count: session.clientCount ?? 0 })}`;

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
    if (!open) {
      window.clearTimeout(openTimerRef.current);
      window.clearTimeout(closeTimerRef.current);
    }
  }, [session.sessionId, open]);

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
    restoreFocusRef.current = true;
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
    if (nextOpen) {
      restoreFocusRef.current = false;
      setOpen(true);
    } else close();
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      {openOnClick ? (
        <PopoverTrigger
          ref={(node) => {
            anchorRef.current = node;
          }}
          asChild
        >
          {children}
        </PopoverTrigger>
      ) : (
        <PopoverAnchor
          ref={(node) => {
            anchorRef.current = node;
          }}
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
      )}
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
        onOpenAutoFocus={(event) => {
          if (!openOnClick) {
            event.preventDefault();
            return;
          }
          requestAnimationFrame(() => {
            copyButtonRef.current?.scrollIntoView({ block: 'nearest' });
          });
        }}
        onPointerEnter={openOnClick ? undefined : cancelClose}
        onCloseAutoFocus={(event) => {
          if (!restoreFocusRef.current) event.preventDefault();
        }}
        onPointerLeave={openOnClick ? undefined : closeAfterDelay}
        onClick={(event) => event.stopPropagation()}
        className={`${styles.sessionDetailsTooltip} max-h-(--radix-popover-content-available-height)`}
      >
        <div className="flex min-h-0 flex-col gap-2.5 overflow-y-auto overscroll-contain">
          <div className={styles.sessionDetailsHeader}>
            <span
              className={`${styles.sessionDetailsTitle} !whitespace-normal break-words`}
            >
              {label}
            </span>
            {time && <span className={styles.sessionDetailsTime}>{time}</span>}
          </div>
          <div className={styles.sessionDetailsRow}>
            <FolderClosedIcon aria-hidden="true" />
            <span
              className="!whitespace-normal break-all"
              title={workspaceLabel ?? folderPath}
            >
              {workspaceLabel ?? folderPath}
            </span>
          </div>
          {branch && (
            <div className={styles.sessionDetailsRow}>
              <GitBranchIcon aria-hidden="true" />
              <span className="!whitespace-normal break-all" title={branch}>
                {branch}
              </span>
            </div>
          )}
          {prs.map((pr, index) => {
            const stateLabel = sessionPrStateLabel(t, pr.state);
            return (
              // Index composite: a hand-edited sidecar can carry duplicate
              // numbers (the reader validates shape, not uniqueness), and a
              // duplicate key would reconcile rows against each other. The
              // list is a stable per-snapshot order, so index keys are safe.
              <div
                className={styles.sessionDetailsRow}
                key={`${index}-${pr.number}`}
              >
                <SessionPrStateIcon state={pr.state} />
                <a
                  href={pr.url}
                  target="_blank"
                  rel="noreferrer"
                  title={pr.url}
                  onClick={(event) => {
                    event.stopPropagation();
                    openExternalLink(event, pr.url);
                  }}
                >
                  {t('sidebar.sessionPr', { number: pr.number })}
                  {stateLabel ? (
                    <span className="sr-only">{` · ${stateLabel}`}</span>
                  ) : null}
                </a>
              </div>
            );
          })}
          {issues.map((issue, index) => {
            const stateLabel = sessionIssueStateLabel(t, issue.state);
            return (
              <div
                className={styles.sessionDetailsRow}
                key={`issue-${index}-${issue.number}`}
              >
                <SessionIssueStateIcon state={issue.state} />
                <a
                  href={issue.url}
                  target="_blank"
                  rel="noreferrer"
                  title={issue.url}
                  onClick={(event) => {
                    event.stopPropagation();
                    openExternalLink(event, issue.url);
                  }}
                >
                  {t('sidebar.sessionIssue', { number: issue.number })}
                  {stateLabel ? (
                    <span className="sr-only">{` · ${stateLabel}`}</span>
                  ) : null}
                </a>
              </div>
            );
          })}
          <div className={styles.sessionDetailsRow}>
            <RadioTowerIcon aria-hidden="true" />
            <span>{status}</span>
          </div>
          <div className={styles.sessionDetailsIdRow}>
            <span
              className="!whitespace-normal break-all"
              data-web-shell-session-id
              title={session.sessionId}
            >
              {session.sessionId}
            </span>
            <button
              type="button"
              ref={copyButtonRef}
              tabIndex={openOnClick ? undefined : -1}
              className={styles.sessionDetailsCopyButton}
              data-web-shell-session-id-copy
              aria-label={t('sidebar.copySessionId')}
              title={t('sidebar.copySessionId')}
              onClick={() => {
                const copyAttempt = ++copyAttemptRef.current;
                void writeClipboardText(session.sessionId)
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
                copyStatus === 'copied'
                  ? 'sr-only'
                  : styles.sessionDetailsCopied
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
        </div>
      </PopoverContent>
    </Popover>
  );
}
