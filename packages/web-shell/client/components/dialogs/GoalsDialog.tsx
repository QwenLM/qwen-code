/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useWorkspaceActions,
  type DaemonGoal,
} from '@qwen-code/webui/daemon-react-sdk';
import { useI18n } from '../../i18n';
import { DialogShell } from './DialogShell';
import { formatRuntime } from '../../utils/formatRuntime';
import { isGoalClearKeyword } from '../../utils/goalCondition';
import styles from './GoalsDialog.module.css';

/**
 * Gap between the end of one refetch and the start of the next. Unlike
 * scheduled tasks there is no `nextRunAt` to schedule against: a goal advances
 * whenever its session finishes a turn, which the page can't predict, so it
 * polls on a slow lane.
 */
const RELOAD_INTERVAL_MS = 10_000;
/** The elapsed-time column ticks independently of the refetch. */
const TICK_INTERVAL_MS = 1000;

interface GoalsDialogProps {
  /** Send `/goal <condition>` into a brand-new session and switch to it. Setting
   * a goal is not a pure write — the daemon registers the Stop hook AND kicks
   * off the first turn — so it has to travel the prompt path, not a REST POST.
   *
   * Return `false` to report a failure this form must not treat as a creation —
   * the condition stays in the box. Reserved for failures already surfaced
   * elsewhere; throw to have the message rendered inline instead. */
  onCreateGoal: (condition: string) => boolean | void | Promise<boolean | void>;
  /** Open the session driving a goal — its transcript IS the goal's history. */
  onOpenSession: (sessionId: string) => void;
  onError: (error: unknown, fallback: string) => void;
}

export function GoalsDialog({
  onCreateGoal,
  onOpenSession,
  onError,
}: GoalsDialogProps) {
  const { t } = useI18n();
  const actions = useWorkspaceActions();

  const [goals, setGoals] = useState<DaemonGoal[] | null>(null);
  /** Sessions the daemon could not probe; their goals are missing from `goals`. */
  const [droppedCount, setDroppedCount] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busySessionId, setBusySessionId] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [condition, setCondition] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [now, setNow] = useState(() => Date.now());

  const mountedRef = useRef(true);
  // Monotonic reload id: a slow poll that resolves after a clear's reload must
  // not resurrect the cleared goal. Only the latest reload may apply.
  const reloadSeqRef = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    const seq = ++reloadSeqRef.current;
    try {
      const list = await actions.listGoals();
      if (!mountedRef.current || seq !== reloadSeqRef.current) return;
      setGoals(list.goals);
      setDroppedCount(list.droppedCount);
      setLoadError(null);
    } catch (err) {
      if (!mountedRef.current || seq !== reloadSeqRef.current) return;
      setLoadError(err instanceof Error ? err.message : String(err));
      setGoals((prev) => prev ?? []);
      // The count described the previous, partially-probed list. This load
      // reached nothing at all, so keeping it would pin a degraded banner
      // reporting a partial probe that no longer happened.
      setDroppedCount(0);
    }
  }, [actions]);

  // One self-chaining loop owns both the initial load and the polling: each
  // fetch is scheduled only once the previous one has settled. `GET /goals`
  // probes every live session, and a wedged child holds it for the bridge's
  // ext-method timeout — the same order as this interval — so a fixed
  // setInterval would stack overlapping fan-outs. `withActionTimeout` rejects
  // the wait but does not abort the request, so those would keep running.
  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const run = async () => {
      await reload();
      if (cancelled) return;
      timer = window.setTimeout(() => void run(), RELOAD_INTERVAL_MS);
    };
    void run();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [reload]);

  // Only tick the elapsed column while something is actually elapsing.
  const hasGoals = !!goals?.length;
  useEffect(() => {
    if (!hasGoals) return;
    const id = window.setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [hasGoals]);

  const resetForm = useCallback(() => {
    setCondition('');
    setFormError(null);
    setShowForm(false);
  }, []);

  const handleSubmit = useCallback(async () => {
    const trimmed = condition.trim();
    if (trimmed.length === 0) {
      setFormError(t('goals.error.emptyCondition'));
      return;
    }
    // No length cap: `/goal` accepts a condition of any length, and refusing
    // one here that the daemon would accept only splits the two surfaces.
    //
    // The condition travels to the daemon as `/goal <condition>`, so a bare
    // clear keyword arrives as a clear command: the fresh session would drop
    // the goal the instant it was set, with nothing to show for it.
    if (isGoalClearKeyword(trimmed)) {
      setFormError(t('goals.error.clearKeyword', { word: trimmed }));
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const created = await onCreateGoal(trimmed);
      if (!mountedRef.current) return;
      // No goal was started, and the caller already said why. Resetting here
      // would close the form and drop the condition the user typed.
      if (created === false) return;
      resetForm();
    } catch (err) {
      if (!mountedRef.current) {
        // The page closed while the prompt was in flight, so the inline form
        // error has nowhere to render. Toast rather than swallow it.
        onError(err, t('goals.error.createFailed'));
        return;
      }
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }, [condition, onCreateGoal, onError, resetForm, t]);

  const handleClear = useCallback(
    async (goal: DaemonGoal) => {
      const label =
        goal.condition.length > 60
          ? `${goal.condition.slice(0, 57)}…`
          : goal.condition;
      if (!window.confirm(t('goals.clearConfirm', { condition: label }))) {
        return;
      }
      setBusySessionId(goal.sessionId);
      try {
        await actions.clearGoal(goal.sessionId);
        await reload();
      } catch (err) {
        onError(err, t('goals.error.clearFailed'));
      } finally {
        if (mountedRef.current) setBusySessionId(null);
      }
    },
    [actions, onError, reload, t],
  );

  return (
    <div className={styles.root}>
      <div className={styles.intro}>{t('goals.subtitle')}</div>

      <div className={styles.toolbar}>
        <div className={styles.count}>
          {goals === null
            ? t('goals.loading')
            : t('goals.count', { count: goals.length })}
        </div>
        <div className={styles.toolbarActions}>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => void reload()}
          >
            {t('goals.refresh')}
          </button>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={() => {
              setCondition('');
              setFormError(null);
              setShowForm(true);
            }}
          >
            {t('goals.new')}
          </button>
        </div>
      </div>

      {showForm && (
        <DialogShell title={t('goals.new')} size="md" onClose={resetForm}>
          <div className={styles.formFields}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>
                {t('goals.condition')}
                <span className={styles.required}>*</span>
              </span>
              <textarea
                className={styles.textarea}
                value={condition}
                rows={4}
                placeholder={t('goals.conditionPlaceholder')}
                onChange={(e) => setCondition(e.target.value)}
              />
            </label>
            <div className={styles.formHint}>{t('goals.newHint')}</div>

            {/* `role="alert"` so the rejection is announced when it appears —
                a sighted user sees it land under the field they just submitted,
                but without this a screen-reader user gets no signal at all and
                is left believing the goal was created. */}
            {formError && (
              <div className={styles.formError} role="alert">
                {formError}
              </div>
            )}

            <div className={styles.formActions}>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={resetForm}
                disabled={submitting}
              >
                {t('goals.cancel')}
              </button>
              <button
                type="button"
                className={styles.primaryButton}
                onClick={() => void handleSubmit()}
                disabled={submitting}
              >
                {submitting ? t('goals.creating') : t('goals.create')}
              </button>
            </div>
          </div>
        </DialogShell>
      )}

      {/* Likewise: this appears on a poll that failed after the page was already
          up, so nothing else on screen changes to hint that the list went
          stale. */}
      {loadError && (
        <div className={styles.loadError} role="alert">
          {loadError}
        </div>
      )}

      {droppedCount > 0 && (
        <div className={styles.degraded} data-testid="goals-dropped">
          {t('goals.dropped', { count: droppedCount })}
        </div>
      )}

      {goals !== null && goals.length === 0 && !loadError && (
        <div className={styles.empty}>{t('goals.empty')}</div>
      )}

      <div className={styles.list}>
        {(goals ?? []).map((goal) => {
          const busy = busySessionId === goal.sessionId;
          return (
            <div key={goal.sessionId} className={styles.card}>
              <div className={styles.cardHeader}>
                <span
                  className={`${styles.statusDot} ${goal.hasActivePrompt ? styles.statusDotRunning : ''}`}
                  aria-hidden="true"
                />
                <div className={styles.cardTitle} title={goal.condition}>
                  {goal.condition}
                </div>
                <div className={styles.cardMenu}>
                  <button
                    type="button"
                    className={styles.iconAction}
                    onClick={() => void handleClear(goal)}
                    disabled={busy}
                    title={t('goals.clear')}
                    aria-label={t('goals.clear')}
                  >
                    ✕
                  </button>
                </div>
              </div>

              {goal.lastReason && (
                <div className={styles.cardReason}>
                  <span className={styles.reasonLabel}>
                    {t('goal.lastCheck')}:
                  </span>{' '}
                  {goal.lastReason}
                </div>
              )}

              <div className={styles.cardFooter}>
                <span className={styles.statusPill}>
                  {t(goal.hasActivePrompt ? 'goals.running' : 'goals.idle')}
                </span>
                <span className={styles.meta}>
                  {goal.iterations > 0
                    ? t(goal.iterations === 1 ? 'goal.turn' : 'goal.turns', {
                        count: goal.iterations,
                      })
                    : t('goals.notYetEvaluated')}
                </span>
                <span className={styles.meta} data-testid="goal-elapsed">
                  {formatRuntime(Math.max(0, now - goal.setAt))}
                </span>
                <button
                  type="button"
                  className={styles.sessionLink}
                  onClick={() => onOpenSession(goal.sessionId)}
                  title={t('goals.openSessionHint')}
                >
                  {goal.displayName || goal.sessionId}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
