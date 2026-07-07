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
        <span className={`${styles.icon} ${styles.iconError}`}>
          {t('tool.status.failed')}
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
