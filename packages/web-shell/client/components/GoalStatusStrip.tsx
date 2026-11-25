import { useEffect, useState } from 'react';
import type { GoalSnapshotV2, GoalStatus } from '@qwen-code/sdk/daemon';
import { Pause, Pencil, Play, Target, Trash2 } from 'lucide-react';
import { useI18n } from '../i18n';
import { formatRuntime } from '../utils/formatRuntime';
import { formatContextTokens } from '../utils/formatTokenCount';
import { canResumeGoal } from '../utils/goalGate';
import styles from './GoalStatusStrip.module.css';

const TICK_INTERVAL_MS = 1000;

/**
 * Lifecycle tone shared by the strip's status text and the Goals page's
 * status pill / budget fills. Maps onto the shared execution-status palette
 * (App.module.css) the cockpit and workflow inspector already use, so a
 * goal's state reads the same colour everywhere: active = in flight,
 * paused/blocked/usage_limited = needs attention, complete = done. Matches
 * GoalStatusMessage's warning/success language.
 */
export function goalStatusTone(
  status: GoalStatus,
): 'running' | 'attention' | 'done' {
  if (status === 'active') return 'running';
  if (status === 'complete') return 'done';
  return 'attention';
}

/**
 * Whether a Goal is still a navigation aid: an absent or completed goal is
 * hidden, matching the Goals listings' `complete` filter. The strip, the
 * sidebar's reservation/marker decision and the marker's own guard all read
 * this one predicate so the three surfaces cannot drift apart.
 */
export function hasVisibleGoal<T extends { status: GoalStatus }>(
  goal: T | null | undefined,
): goal is T {
  return goal != null && goal.status !== 'complete';
}

export interface GoalStatusStripProps {
  snapshot: GoalSnapshotV2;
  busy?: boolean;
  onEdit: () => void;
  onPause: () => void;
  onResume: () => void;
  onClear: () => void;
  /** Open the Goals page listing every goal. Absent on surfaces where that
   * page is unavailable — the affordance then does not render. */
  onOpenGoals?: () => void;
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

export function getGoalTokenLabel(
  goal: NonNullable<GoalSnapshotV2['goal']>,
  t: ReturnType<typeof useI18n>['t'],
): string | undefined {
  if (goal.tokensUsed === undefined || goal.tokensUsed <= 0) return undefined;
  const used = formatContextTokens(goal.tokensUsed);
  return goal.tokenBudget === undefined
    ? t('goal.tokens', { used })
    : t('goal.tokensOfBudget', {
        used,
        budget: formatContextTokens(goal.tokenBudget),
      });
}

/**
 * Active time, against its ceiling when `model.goalMaxActiveMinutes` armed
 * one for this Goal.
 */
export function getGoalActiveTimeLabel(
  goal: NonNullable<GoalSnapshotV2['goal']>,
  activeTimeMs: number,
  t: ReturnType<typeof useI18n>['t'],
): string {
  return goal.activeTimeBudgetMs === undefined
    ? formatRuntime(activeTimeMs)
    : t('goal.activeOfBudget', {
        used: formatRuntime(activeTimeMs),
        budget: formatRuntime(goal.activeTimeBudgetMs),
      });
}

/**
 * Finished turns against the ceiling `model.goalMaxTurns` armed. A Goal with
 * no turn ceiling shows no turn figure here: the strip is one line, and the
 * count alone says nothing about how much room is left. Zero stays hidden,
 * as it does for tokens.
 */
export function getGoalTurnBudgetLabel(
  goal: NonNullable<GoalSnapshotV2['goal']>,
  t: ReturnType<typeof useI18n>['t'],
): string | undefined {
  if (goal.turnBudget === undefined || goal.turnCount <= 0) return undefined;
  return t('goal.turnsOfBudget', {
    count: goal.turnCount,
    budget: goal.turnBudget,
  });
}

export function GoalStatusStrip({
  snapshot,
  busy = false,
  onEdit,
  onPause,
  onResume,
  onClear,
  onOpenGoals,
}: GoalStatusStripProps) {
  const { t } = useI18n();
  const goal = snapshot.goal;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (goal?.status !== 'active') return;
    const id = window.setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [goal?.status]);

  if (!hasVisibleGoal(goal)) return null;

  const canPause = goal.status === 'active';
  const canResume = canResumeGoal(goal);
  const tokenLabel = getGoalTokenLabel(goal, t);
  const turnLabel = getGoalTurnBudgetLabel(goal, t);

  return (
    <div
      className={styles.root}
      data-testid="goal-status-strip"
      data-web-shell-goal-status=""
    >
      <Target className={styles.target} size={17} aria-hidden="true" />
      <div className={styles.summary}>
        <span
          className={styles.status}
          data-status={goalStatusTone(goal.status)}
        >
          {t(`goal.status.${goal.status}`)}
        </span>
        <span className={styles.activity}>
          {t(`goal.activity.${snapshot.activity}`)}
        </span>
        <span className={styles.objective} title={goal.objective}>
          {goal.objective}
        </span>
        <span className={styles.separator} aria-hidden="true">
          ·
        </span>
        <span className={styles.elapsed} data-testid="goal-active-elapsed">
          {getGoalActiveTimeLabel(goal, getGoalActiveTimeMs(snapshot, now), t)}
        </span>
        {turnLabel ? (
          <>
            <span className={styles.separator} aria-hidden="true">
              ·
            </span>
            <span className={styles.elapsed} data-testid="goal-active-turns">
              {turnLabel}
            </span>
          </>
        ) : null}
        {tokenLabel ? (
          <>
            <span className={styles.separator} aria-hidden="true">
              ·
            </span>
            <span className={styles.elapsed} data-testid="goal-active-tokens">
              {tokenLabel}
            </span>
          </>
        ) : null}
      </div>
      <div className={styles.actions}>
        {onOpenGoals && (
          <button
            type="button"
            className={`${styles.action} ${styles.goalsAction}`}
            onClick={onOpenGoals}
            title={t('goals.viewAll')}
            aria-label={t('goals.viewAll')}
            data-testid="goal-open-goals"
          >
            <Target size={16} aria-hidden="true" />
          </button>
        )}
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
