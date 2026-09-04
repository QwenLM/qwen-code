import { useCallback, type ReactNode } from 'react';
import {
  warnClipboardWriteFailure,
  writeClipboardText,
} from '../utils/clipboard';
import { useTranscriptRenderMode } from '../transcriptRenderMode';
import { useCopiedFlash } from '../hooks/useCopiedFlash';
import styles from './MessageTimestamp.module.css';

interface MessageTimestampProps {
  /** Wall-clock epoch ms of the message; omitted for synthetic messages. */
  timestamp?: number;
  children: ReactNode;
  /** When true, show the timestamp permanently at bottom-right instead of hover tooltip. */
  chatMode?: boolean;
  /** Use the larger vertical rhythm for tool summaries in thinking-hidden mode. */
  toolGroupSpacing?: boolean;
  copyText?: string;
  copyTitle?: string;
}

/**
 * Wraps a rendered history message and reveals its wall-clock time as a
 * CSS-only tooltip on hover.
 */
export function MessageTimestamp({
  timestamp,
  children,
  chatMode = false,
  toolGroupSpacing = false,
  copyText,
  copyTitle = 'Copy',
}: MessageTimestampProps) {
  const documentMode = useTranscriptRenderMode() === 'document';
  const [copied, flashCopied] = useCopiedFlash();
  const handleCopy = useCallback(() => {
    if (!copyText) return;
    void writeClipboardText(copyText)
      .then(() => {
        flashCopied();
      })
      .catch(warnClipboardWriteFailure);
  }, [copyText, flashCopied]);
  if (documentMode) return <>{children}</>;
  if (timestamp === undefined && !copyText && !toolGroupSpacing) {
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
  const rowClassName = chatMode
    ? styles.chatRow
    : toolGroupSpacing
      ? `${styles.row} ${styles.toolGroupSpacing}`
      : styles.row;
  if (timestamp === undefined) {
    return (
      <div className={rowClassName}>
        {children}
        {copyButton}
      </div>
    );
  }
  return (
    <div className={rowClassName}>
      {children}
      {chatMode ? (
        <span className={styles.chatActions}>
          <span className={styles.chatTip} aria-hidden="true">
            {formatTimestamp(timestamp)}
          </span>
          {copyButton}
        </span>
      ) : (
        <span className={styles.tip} aria-hidden="true">
          {formatTimestamp(timestamp)}
        </span>
      )}
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
