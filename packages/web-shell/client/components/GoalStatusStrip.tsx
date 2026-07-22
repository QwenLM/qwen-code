import { useEffect, useState } from 'react';
import type { GoalSnapshotV2 } from '@qwen-code/sdk/daemon';
import { Pause, Pencil, Play, Target, Trash2 } from 'lucide-react';
import { useI18n } from '../i18n';
import { formatRuntime } from '../utils/formatRuntime';
import styles from './GoalStatusStrip.module.css';

const TICK_INTERVAL_MS = 1000;

export interface GoalStatusStripProps {
  snapshot: GoalSnapshotV2;
  busy?: boolean;
  onEdit: () => void;
  onPause: () => void;
  onResume: () => void;
  onClear: () => void;
}

export function getGoalActiveTimeMs(
  snapshot: GoalSnapshotV2,
  now: number,
): number {
  const goal = snapshot.goal;
  if (!goal) return 0;
  return (
    goal.activeTimeMs +
    (goal.status === 'active' ? Math.max(0, now - goal.updatedAt) : 0)
  );
}

export function GoalStatusStrip({
  snapshot,
  busy = false,
  onEdit,
  onPause,
  onResume,
  onClear,
}: GoalStatusStripProps) {
  const { t } = useI18n();
  const goal = snapshot.goal;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (goal?.status !== 'active') return;
    const id = window.setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [goal?.status]);

  if (!goal || goal.status === 'complete') return null;

  const canPause = goal.status === 'active';
  const canResume =
    goal.status === 'paused' ||
    goal.status === 'blocked' ||
    goal.status === 'usage_limited';
  const statusLabel = t(`goal.status.${goal.status}`);
  const activityLabel = t(`goal.activity.${snapshot.activity}`);
  const elapsed = formatRuntime(getGoalActiveTimeMs(snapshot, now));

  return (
    <div
      className={styles.root}
      data-testid="goal-status-strip"
      data-web-shell-goal-status=""
    >
      <Target className={styles.target} size={17} aria-hidden="true" />
      <div className={styles.summary}>
        <span className={styles.status}>{statusLabel}</span>
        <span className={styles.activity}>{activityLabel}</span>
        <span className={styles.objective} title={goal.objective}>
          {goal.objective}
        </span>
        <span className={styles.separator} aria-hidden="true">
          ·
        </span>
        <span className={styles.elapsed} data-testid="goal-active-elapsed">
          {elapsed}
        </span>
      </div>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.action}
          onClick={onEdit}
          disabled={busy}
          title={t('goal.edit')}
          aria-label={t('goal.edit')}
        >
          <Pencil size={16} aria-hidden="true" />
        </button>
        {canPause && (
          <button
            type="button"
            className={styles.action}
            onClick={onPause}
            disabled={busy}
            title={t('goal.pause')}
            aria-label={t('goal.pause')}
          >
            <Pause size={16} aria-hidden="true" />
          </button>
        )}
        {canResume && (
          <button
            type="button"
            className={styles.action}
            onClick={onResume}
            disabled={busy}
            title={t('goal.resume')}
            aria-label={t('goal.resume')}
          >
            <Play size={16} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          className={styles.action}
          onClick={onClear}
          disabled={busy}
          title={t('goals.clear')}
          aria-label={t('goals.clear')}
        >
          <Trash2 size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
