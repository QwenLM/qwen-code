import { memo } from 'react';
import {
  CircleCheckIcon,
  CircleMinusIcon,
  CircleXIcon,
  InfoIcon,
} from 'lucide-react';
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
  const isTaskNotification =
    variant === 'info' && source === 'background_notification';
  const notificationData =
    isTaskNotification && typeof data === 'object' && data !== null
      ? (data as Record<string, unknown>)
      : undefined;
  const stringField = (key: string): string | undefined => {
    const value = notificationData?.[key];
    return typeof value === 'string' ? value : undefined;
  };
  const numberField = (key: string): number | undefined => {
    const value = notificationData?.[key];
    return typeof value === 'number' ? value : undefined;
  };
  const taskStatus = stringField('status');
  const taskNotificationLabel =
    taskStatus === 'completed'
      ? t('system.taskCompleted')
      : taskStatus === 'failed'
        ? t('system.taskFailed')
        : taskStatus === 'cancelled'
          ? t('system.taskCancelled')
          : t('system.taskNotification');
  const taskNotificationTone =
    taskStatus === 'completed'
      ? 'success'
      : taskStatus === 'failed'
        ? 'error'
        : 'neutral';
  const TaskNotificationIcon =
    taskStatus === 'completed'
      ? CircleCheckIcon
      : taskStatus === 'failed'
        ? CircleXIcon
        : taskStatus === 'cancelled'
          ? CircleMinusIcon
          : InfoIcon;

  const taskKind = stringField('kind');
  const taskCommandLabel = stringField('commandLabel');
  const taskDescription = stringField('description');
  const taskEventCount = numberField('eventCount');
  const taskDroppedLines = numberField('droppedLines');
  const taskI18nText = (() => {
    if (!taskKind || !taskStatus) return undefined;
    if (
      taskStatus !== 'completed' &&
      taskStatus !== 'failed' &&
      taskStatus !== 'cancelled'
    ) {
      return undefined;
    }
    const key = `notification.${taskKind}.${taskStatus}` as const;
    if (taskKind === 'shell') {
      return taskCommandLabel
        ? t(key, { command: taskCommandLabel })
        : undefined;
    }
    if (taskKind === 'monitor' || taskKind === 'agent') {
      return taskDescription
        ? t(key, {
            description: taskDescription,
            events: taskEventCount ?? 0,
            droppedLines: taskDroppedLines ?? 0,
          })
        : undefined;
    }
    return undefined;
  })();

  const renderedContent = preserveWhitespace ? (
    <pre>{content}</pre>
  ) : variant === 'info' ? (
    <Markdown content={content} />
  ) : (
    <pre>{content}</pre>
  );

  if (isTaskNotification) {
    return (
      <div className={styles.notificationBubbleRow}>
        <div className={styles.notificationBubbleColumn}>
          <div className={styles.notificationBubble}>
            <span
              className={styles.notificationIcon}
              data-tone={taskNotificationTone}
              role="img"
              aria-label={taskNotificationLabel}
              title={taskNotificationLabel}
            >
              <TaskNotificationIcon aria-hidden="true" />
            </span>
            <div className={styles.notificationText}>
              {taskI18nText ?? <Markdown content={content} />}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`${styles.message} ${styles[variant]} ${
        preserveWhitespace ? styles.modelSwitch : ''
      } ${isRecap ? styles.recap : ''}`}
    >
      <div className={styles.content}>
        {renderedContent}
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
