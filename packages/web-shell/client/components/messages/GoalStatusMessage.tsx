import { useEffect } from 'react';
import { DAEMON_GOAL_STATUS_SENTINEL_PREFIX } from '@qwen-code/sdk/daemon';
import { useI18n } from '../../i18n';
import { formatRuntime } from '../../utils/formatRuntime';
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
  DAEMON_GOAL_STATUS_SENTINEL_PREFIX,
);

const VALID_GOAL_KINDS = new Set<string>([
  'set',
  'achieved',
  'cleared',
  'failed',
  'aborted',
  'checking',
]);

function parseGoalStatusMessage(
  content: unknown,
): SerializedGoalStatusMessage | null {
  const parsed =
    typeof content === 'string' ? parseRawGoalStatusMessage(content) : content;
  return normalizeGoalStatus(parsed);
}

export { serializeGoalStatusMessage, parseGoalStatusMessage };

function normalizeGoalStatus(
  value: unknown,
): SerializedGoalStatusMessage | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  const condition = record.condition;
  if (typeof kind !== 'string' || !VALID_GOAL_KINDS.has(kind)) return null;
  if (typeof condition !== 'string') return null;
  const iterations = getNumber(record.iterations);
  const durationMs = getNumber(record.durationMs);
  const setAt = getNumber(record.setAt);
  const lastReason =
    typeof record.lastReason === 'string' ? record.lastReason : undefined;
  return {
    kind: kind as GoalStatusKind,
    condition,
    ...(iterations !== undefined ? { iterations } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(setAt !== undefined ? { setAt } : {}),
    ...(lastReason !== undefined ? { lastReason } : {}),
  };
}

function getNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function pluralTurns(n: number, t: ReturnType<typeof useI18n>['t']): string {
  return t(n === 1 ? 'goal.turn' : 'goal.turns', { count: n });
}

function getTitle(
  status: SerializedGoalStatusMessage,
  t: ReturnType<typeof useI18n>['t'],
): {
  prefix: string;
  title: string;
  colorClass: string;
} {
  switch (status.kind) {
    case 'checking':
      return {
        prefix: '○',
        title: `${t('goal.check')}${
          status.iterations && status.iterations > 0
            ? ` · ${t('goal.turnLabel', { count: status.iterations })}`
            : ''
        } · ${t('goal.notYetMet')}`,
        colorClass: styles.muted,
      };
    case 'set':
      return {
        prefix: '◎',
        title: t('goal.set'),
        colorClass: styles.accent,
      };
    case 'achieved':
      return {
        prefix: '✓',
        title: t('goal.achieved'),
        colorClass: styles.success,
      };
    case 'cleared':
      return {
        prefix: '○',
        title: t('goal.cleared'),
        colorClass: styles.muted,
      };
    case 'failed':
      return {
        prefix: '✖',
        title: t('goal.failed'),
        colorClass: styles.error,
      };
    case 'aborted':
      return {
        prefix: '!',
        title: t('goal.aborted'),
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
  const { t } = useI18n();

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

  const title = getTitle(status, t);
  const stats: string[] = [];
  if (status.kind !== 'checking') {
    if (status.iterations && status.iterations > 0) {
      stats.push(pluralTurns(status.iterations, t));
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
  const reasonLabel =
    status.kind === 'checking' ? t('goal.judge') : t('goal.lastCheck');

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
          <span className={styles.label}>{t('goal.label')}:</span>
          <span className={styles.value}>{status.condition}</span>
        </div>
        {showReason && (
          <div className={styles.muted}>
            {reasonLabel}: {showReason}
          </div>
        )}
      </div>
    </div>
  );
}
