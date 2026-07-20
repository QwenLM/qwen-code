import { memo } from 'react';
import { useI18n } from '../../i18n';
import {
  ContextUsageMessage,
  parseContextUsageMessage,
} from './ContextUsageMessage';
import { StatsMessage, parseStatsMessage } from './StatsMessage';
import { StatusMessage, parseStatusMessage } from './StatusMessage';
import { McpStatusMessage, parseMcpStatusMessage } from './McpStatusMessage';
import {
  TasksStatusMessage,
  parseTasksStatusMessage,
} from './TasksStatusMessage';
import { GoalStatusMessage, parseGoalStatusMessage } from './GoalStatusMessage';
import { Markdown } from './Markdown';
import styles from './SystemMessage.module.css';

interface SystemMessageProps {
  content: string;
  variant: 'info' | 'error' | 'warning';
  source?: string;
  data?: unknown;
  /** Run /context detail, exactly like typing it (context-usage panels). */
  onShowContextDetail?: () => void;
  isLatest?: boolean;
  showRetryHint?: boolean;
  onRetryClick?: () => void;
}

export const SystemMessage = memo(function SystemMessage({
  content,
  variant,
  source,
  data,
  onShowContextDetail,
  isLatest = false,
  showRetryHint = false,
  onRetryClick,
}: SystemMessageProps) {
  const { t } = useI18n();
  // The user ESC-cancelled a live stream. Render it right-aligned and subtle —
  // a user-initiated stop reads as belonging to the user side of the transcript.
  if (source === 'prompt_cancelled') {
    return (
      <div className={styles.cancelled} role="status">
        <span>{t('turn.stopped')}</span>
      </div>
    );
  }
  const contextUsage =
    variant === 'info' ? parseContextUsageMessage(content) : null;
  if (contextUsage) {
    return (
      <div className={styles.flushMessage}>
        <ContextUsageMessage
          status={contextUsage}
          onShowDetail={onShowContextDetail}
        />
      </div>
    );
  }

  const statsData = variant === 'info' ? parseStatsMessage(content) : null;
  if (statsData) {
    return (
      <div className={styles.flushMessage}>
        <StatsMessage view={statsData.view} status={statsData.status} />
      </div>
    );
  }

  const statusInfo = variant === 'info' ? parseStatusMessage(content) : null;
  if (statusInfo) {
    return (
      <div className={styles.flushMessage}>
        <StatusMessage info={statusInfo} />
      </div>
    );
  }

  const mcpStatus = variant === 'info' ? parseMcpStatusMessage(content) : null;
  if (mcpStatus) {
    return (
      <div className={styles.flushMessage}>
        <McpStatusMessage message={mcpStatus} />
      </div>
    );
  }

  const tasksStatus =
    variant === 'info' ? parseTasksStatusMessage(content) : null;
  if (tasksStatus) {
    return (
      <div className={styles.flushMessage}>
        <TasksStatusMessage message={tasksStatus} />
      </div>
    );
  }

  const goalStatus =
    variant === 'info'
      ? source === 'goal'
        ? parseGoalStatusMessage(data)
        : parseGoalStatusMessage(content)
      : null;
  if (goalStatus) {
    return (
      <div className={styles.flushMessage}>
        <GoalStatusMessage status={goalStatus} activateFooter={isLatest} />
      </div>
    );
  }

  const preserveWhitespace =
    variant === 'info' && source === 'model_switch_summary';
  const isRecap = variant === 'info' && source === 'recap';

  return (
    <div
      className={`${styles.message} ${styles[variant]} ${
        preserveWhitespace ? styles.modelSwitch : ''
      } ${isRecap ? styles.recap : ''}`}
    >
      <div className={styles.content}>
        {preserveWhitespace ? (
          <pre>{content}</pre>
        ) : variant === 'info' ? (
          <Markdown content={content} />
        ) : (
          <pre>{content}</pre>
        )}
        {showRetryHint && onRetryClick && (
          <div className={styles.retryHint}>
            <button
              type="button"
              className={styles.retryButton}
              onClick={onRetryClick}
            >
              {t('retry.hint')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
});
