import type { ReactNode } from 'react';
import styles from './MessageTimestamp.module.css';

interface MessageTimestampProps {
  /** Wall-clock epoch ms of the message; omitted for synthetic messages. */
  timestamp?: number;
  children: ReactNode;
}

/**
 * Wraps a rendered history message and reveals its wall-clock time as a
 * CSS-only tooltip on hover. When the message carries no timestamp the
 * children render unchanged, so no empty wrapper is introduced.
 */
export function MessageTimestamp({
  timestamp,
  children,
}: MessageTimestampProps) {
  if (timestamp === undefined) {
    return <>{children}</>;
  }
  return (
    <div className={styles.row}>
      {children}
      <span className={styles.tip} aria-hidden="true">
        {formatTimestamp(timestamp)}
      </span>
    </div>
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
