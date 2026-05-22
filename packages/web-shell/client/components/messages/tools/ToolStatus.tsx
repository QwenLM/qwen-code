import type { ToolCallStatus } from '../../../adapters/types';
import styles from './ToolStatus.module.css';

interface ToolStatusProps {
  status: ToolCallStatus;
  toolName: string;
  elapsed?: number;
}

const STATUS_ICONS: Record<ToolCallStatus, string> = {
  pending: '○',
  in_progress: '◐',
  completed: '●',
  failed: '✗',
};

const STATUS_CLASSES: Record<ToolCallStatus, string> = {
  pending: styles.pending,
  in_progress: styles.running,
  completed: styles.done,
  failed: styles.error,
};

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function ToolStatus({ status, toolName, elapsed }: ToolStatusProps) {
  return (
    <div className={`${styles.status} ${STATUS_CLASSES[status]}`}>
      <span className={styles.icon}>{STATUS_ICONS[status]}</span>
      <span className={styles.name}>{toolName}</span>
      {elapsed !== undefined && status === 'completed' && (
        <span className={styles.elapsed}>{formatElapsed(elapsed)}</span>
      )}
      {status === 'in_progress' && <span className={styles.spinner} />}
    </div>
  );
}
