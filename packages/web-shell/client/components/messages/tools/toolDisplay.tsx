import styles from './ToolChrome.module.css';
import { useI18n } from '../../../i18n';
export {
  formatToolDisplayName,
  localizeToolDisplayName,
  truncateText,
} from '../toolFormatting';

export function StatusIcon({ status }: { status: string }) {
  const { t } = useI18n();
  switch (status) {
    case 'completed':
    case 'success':
      return null;
    case 'failed':
    case 'error':
    case 'cancelled':
    case 'canceled':
      return (
        <span
          className={`${styles.icon} ${styles.iconError}`}
          role="img"
          aria-label={t('tool.status.failed')}
          title={t('tool.status.failed')}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            aria-hidden="true"
          >
            <circle
              cx="7"
              cy="7"
              r="5.5"
              stroke="currentColor"
              strokeWidth="1.25"
            />
            <path
              d="M4.8 4.8l4.4 4.4M9.2 4.8l-4.4 4.4"
              stroke="currentColor"
              strokeWidth="1.25"
              strokeLinecap="round"
            />
          </svg>
        </span>
      );
    case 'in_progress':
    case 'running':
      return null;
    default:
      return null;
  }
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

export function formatLiveElapsed(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0
    ? `${minutes}m ${remainingSeconds}s`
    : `${minutes}m`;
}
