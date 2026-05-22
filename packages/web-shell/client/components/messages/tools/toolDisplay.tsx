import styles from './ToolChrome.module.css';

export function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'completed':
    case 'success':
      return <span className={`${styles.icon} ${styles.iconDone}`}>✓</span>;
    case 'failed':
    case 'error':
      return <span className={`${styles.icon} ${styles.iconError}`}>✗</span>;
    case 'in_progress':
      return <span className={`${styles.icon} ${styles.iconSpin}`}>⟳</span>;
    default:
      return <span className={`${styles.icon} ${styles.iconPending}`}>○</span>;
  }
}

export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '...';
}

export function formatElapsed(start?: number, end?: number): string {
  if (!start) return '';
  const seconds = Math.round(((end || Date.now()) - start) / 1000);
  if (seconds < 3) return '';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

export function formatDurationMs(ms?: number): string {
  if (!ms) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}
