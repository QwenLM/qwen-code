import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { EllipsisVerticalIcon, Trash2Icon, WrenchIcon } from 'lucide-react';
import {
  warnClipboardWriteFailure,
  writeClipboardText,
} from '../utils/clipboard';
import { useTranscriptRenderMode } from '../transcriptRenderMode';
import { useCopiedFlash } from '../hooks/useCopiedFlash';
import { useI18n } from '../i18n';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import styles from './MessageTimestamp.module.css';

interface MessageTimestampProps {
  /** Wall-clock epoch ms of the message; omitted for synthetic messages. */
  timestamp?: number;
  hideTimestamp?: boolean;
  children: ReactNode;
  /** When true, show the timestamp permanently at bottom-right instead of hover tooltip. */
  chatMode?: boolean;
  /** Use the larger vertical rhythm for tool summaries in thinking-hidden mode. */
  toolGroupSpacing?: boolean;
  copyText?: string;
  copyTitle?: string;
  /** When set, include an edit action in the overflow menu. */
  onEdit?: () => void;
  editTitle?: string;
  onDelete?: () => void;
  deleteDisabled?: boolean;
  deleteTitle?: string;
  /** When set, render an action that opens this turn's tool-call list. */
  onOpenTurnCalls?: () => void;
  turnCallsTitle?: string;
}

/**
 * Wraps a rendered history message and reveals its wall-clock time as a
 * CSS-only tooltip on hover.
 */
export function MessageTimestamp({
  timestamp,
  hideTimestamp = false,
  children,
  chatMode = false,
  toolGroupSpacing = false,
  copyText,
  copyTitle = 'Copy',
  onEdit,
  editTitle = 'Edit',
  onDelete,
  deleteDisabled = false,
  deleteTitle = 'Delete messages',
  onOpenTurnCalls,
  turnCallsTitle = 'View tool calls',
}: MessageTimestampProps) {
  const { t } = useI18n();
  const documentMode = useTranscriptRenderMode() === 'document';
  const [copied, flashCopied] = useCopiedFlash();
  const [menuOpen, setMenuOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const openedByHover = useRef(false);
  const hoverFocus = useRef<HTMLElement | null>(null);
  const restoreHoverFocus = useRef(false);
  const cancelClose = () => clearTimeout(closeTimer.current);
  const handleDirectInteraction = () => {
    cancelClose();
    openedByHover.current = false;
  };
  const scheduleClose = () => {
    cancelClose();
    if (openedByHover.current) {
      closeTimer.current = setTimeout(() => setMenuOpen(false), 120);
    }
  };
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  const handleCopy = useCallback(() => {
    if (!copyText) return;
    void writeClipboardText(copyText)
      .then(() => {
        flashCopied();
      })
      .catch(warnClipboardWriteFailure);
  }, [copyText, flashCopied]);
  if (documentMode) return <>{children}</>;
  if (
    timestamp === undefined &&
    !copyText &&
    !toolGroupSpacing &&
    !onEdit &&
    !onDelete &&
    !onOpenTurnCalls
  ) {
    return <>{children}</>;
  }
  const copyButton = copyText ? (
    <button
      type="button"
      className={styles.copyButton}
      title={copyTitle}
      aria-label={copyTitle}
      onClick={handleCopy}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  ) : null;
  const moreActions =
    onEdit || onDelete || onOpenTurnCalls ? (
      <DropdownMenu
        open={menuOpen}
        onOpenChange={(open) => {
          cancelClose();
          setMenuOpen(open);
        }}
        modal={false}
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={styles.copyButton}
            aria-label={t('message.moreActions')}
            onPointerEnter={(event) => {
              if (event.pointerType !== 'mouse') return;
              cancelClose();
              if (!menuOpen) {
                hoverFocus.current =
                  document.activeElement instanceof HTMLElement
                    ? document.activeElement
                    : null;
                openedByHover.current = true;
                restoreHoverFocus.current = true;
                setMenuOpen(true);
              }
            }}
            onPointerLeave={scheduleClose}
            onPointerDown={(event) => {
              if (
                event.pointerType === 'mouse' &&
                event.button === 0 &&
                !event.ctrlKey &&
                menuOpen
              )
                event.preventDefault();
              handleDirectInteraction();
            }}
            onKeyDown={handleDirectInteraction}
          >
            <EllipsisVerticalIcon strokeWidth={1.6} aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-max max-w-72"
          onPointerEnter={cancelClose}
          onPointerLeave={scheduleClose}
          onKeyDown={handleDirectInteraction}
          onPointerDown={handleDirectInteraction}
          onFocusCapture={(event) => {
            if (
              openedByHover.current &&
              restoreHoverFocus.current &&
              event.target === event.currentTarget
            ) {
              restoreHoverFocus.current = false;
              hoverFocus.current?.focus({ preventScroll: true });
            }
          }}
          onFocusOutside={(event) => {
            if (openedByHover.current) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            if (openedByHover.current) event.preventDefault();
          }}
        >
          {onOpenTurnCalls && (
            <DropdownMenuItem onSelect={onOpenTurnCalls}>
              <WrenchIcon strokeWidth={1.6} aria-hidden="true" />
              {turnCallsTitle}
            </DropdownMenuItem>
          )}
          {onEdit && (
            <DropdownMenuItem onSelect={onEdit}>
              <PencilIcon />
              {editTitle}
            </DropdownMenuItem>
          )}
          {onDelete && (
            <DropdownMenuItem
              variant="destructive"
              disabled={deleteDisabled}
              onSelect={onDelete}
            >
              <Trash2Icon strokeWidth={1.6} aria-hidden="true" />
              {deleteTitle}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    ) : null;
  const rowClassName = chatMode
    ? styles.chatRow
    : toolGroupSpacing
      ? `${styles.row} ${styles.toolGroupSpacing}`
      : styles.row;
  if (timestamp === undefined || hideTimestamp) {
    return (
      <div className={rowClassName}>
        {children}
        {copyButton}
        {moreActions}
      </div>
    );
  }
  return (
    <div className={rowClassName}>
      {children}
      {chatMode ? (
        <span
          className={styles.chatActions}
          data-menu-open={menuOpen || undefined}
        >
          <span className={styles.chatTip} aria-hidden="true">
            {formatTimestamp(timestamp)}
          </span>
          {copyButton}
          {moreActions}
        </span>
      ) : (
        <span className={styles.tip} aria-hidden="true">
          {formatTimestamp(timestamp)}
        </span>
      )}
      {!chatMode && moreActions}
    </div>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M5.2 4.4V3.2c0-.7.5-1.2 1.2-1.2h5.4c.7 0 1.2.5 1.2 1.2v5.4c0 .7-.5 1.2-1.2 1.2h-1.2"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.3"
      />
      <rect
        x="3"
        y="5.2"
        width="7.8"
        height="7.8"
        rx="1.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="m3.5 8.3 3 3L12.8 5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M11.1 2.6a1.4 1.4 0 0 1 2 2l-7.2 7.2-2.7.7.7-2.7 7.2-7.2Z"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.3"
      />
    </svg>
  );
}

/**
 * Local-time clock, dropping the date only for same-day timestamps:
 * - same day → `HH:mm:ss`
 * - earlier  → `yyyy-MM-dd HH:mm:ss`
 *
 * Fixed order and zero-padded (unlike toLocaleString) so stacked timestamps
 * align. `now` is injectable so the branch logic is unit-testable without
 * depending on the wall clock.
 */
export function formatTimestamp(ts: number, now: Date = new Date()): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return hms;
  }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hms}`;
}
