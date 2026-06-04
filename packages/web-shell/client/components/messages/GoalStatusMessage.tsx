import { useEffect } from 'react';
import { createSentinelSerializer } from '../../utils/sentinelMessage';
import styles from './GoalStatusMessage.module.css';

export type GoalStatusKind =
  | 'set'
  | 'achieved'
  | 'cleared'
  | 'failed'
  | 'aborted'
  | 'checking';

export interface SerializedGoalStatusMessage {
  kind: GoalStatusKind;
  condition: string;
  iterations?: number;
  durationMs?: number;
  setAt?: number;
  lastReason?: string;
}

export const GOAL_STATUS_ACTIVE_EVENT = 'web-shell-goal-status-active';

const {
  serialize: serializeGoalStatusMessage,
  parse: parseRawGoalStatusMessage,
} = createSentinelSerializer<SerializedGoalStatusMessage>(
  'web-shell:goal-status:v1:',
);

function parseGoalStatusMessage(
  content: string,
): SerializedGoalStatusMessage | null {
  const parsed = parseRawGoalStatusMessage(content);
  if (!parsed || !parsed.kind || !parsed.condition) return null;
  return parsed;
}

export { serializeGoalStatusMessage, parseGoalStatusMessage };

function formatRuntime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${totalSeconds % 60}s`;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}h ${totalMinutes % 60}m`;
}

function pluralTurns(n: number): string {
  return `${n} ${n === 1 ? 'turn' : 'turns'}`;
}

function getTitle(status: SerializedGoalStatusMessage): {
  prefix: string;
  title: string;
  colorClass: string;
} {
  switch (status.kind) {
    case 'checking':
      return {
        prefix: '○',
        title: `Goal check${
          status.iterations && status.iterations > 0
            ? ` · turn ${status.iterations}`
            : ''
        } · not yet met`,
        colorClass: styles.muted,
      };
    case 'set':
      return {
        prefix: '◎',
        title: 'Goal set',
        colorClass: styles.accent,
      };
    case 'achieved':
      return {
        prefix: '✓',
        title: 'Goal achieved',
        colorClass: styles.success,
      };
    case 'cleared':
      return {
        prefix: '○',
        title: 'Goal cleared',
        colorClass: styles.muted,
      };
    case 'failed':
      return {
        prefix: '✖',
        title: 'Goal could not be achieved',
        colorClass: styles.error,
      };
    case 'aborted':
      return {
        prefix: '!',
        title: 'Goal aborted',
        colorClass: styles.warning,
      };
  }
}

export function GoalStatusMessage({
  status,
  activateFooter = false,
}: {
  status: SerializedGoalStatusMessage;
  activateFooter?: boolean;
}) {
  useEffect(() => {
    if (!activateFooter) return;
    const active = status.kind === 'set' || status.kind === 'checking';
    window.dispatchEvent(
      new CustomEvent(GOAL_STATUS_ACTIVE_EVENT, {
        detail: {
          active,
          condition: status.condition,
          setAt: status.setAt,
        },
      }),
    );
  }, [activateFooter, status.condition, status.kind, status.setAt]);

  const title = getTitle(status);
  const stats: string[] = [];
  if (status.kind !== 'checking') {
    if (status.iterations && status.iterations > 0) {
      stats.push(pluralTurns(status.iterations));
    }
    if (typeof status.durationMs === 'number') {
      stats.push(formatRuntime(status.durationMs));
    }
  }
  const subtitle = stats.length > 0 ? ` · ${stats.join(' · ')}` : '';
  const showReason =
    (status.kind === 'checking' ||
      status.kind === 'achieved' ||
      status.kind === 'failed' ||
      status.kind === 'aborted') &&
    status.lastReason?.trim();

  return (
    <div className={styles.message}>
      <span className={`${styles.prefix} ${title.colorClass}`}>
        {title.prefix}
      </span>
      <div className={styles.body}>
        <div className={`${styles.title} ${title.colorClass}`}>
          {title.title}
          {subtitle && <span className={styles.muted}>{subtitle}</span>}
        </div>
        <div className={styles.row}>
          <span className={styles.label}>Goal:</span>
          <span className={styles.value}>{status.condition}</span>
        </div>
        {showReason && (
          <div className={styles.muted}>
            {status.kind === 'checking' ? 'Judge' : 'Last check'}: {showReason}
          </div>
        )}
      </div>
    </div>
  );
}
