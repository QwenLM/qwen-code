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
import styles from './GoalsDialog.module.css';

/** Keep in sync with MAX_GOAL_LENGTH in packages/cli/src/ui/commands/goalCommand.ts */
const MAX_GOAL_LENGTH = 4000;

/**
 * How often the list is refetched. Unlike scheduled tasks there is no
 * `nextRunAt` to schedule against: a goal advances whenever its session
 * finishes a turn, which the page can't predict, so it polls on a slow lane.
 */
const RELOAD_INTERVAL_MS = 10_000;
/** The elapsed-time column ticks independently of the refetch. */
const TICK_INTERVAL_MS = 1000;

interface GoalsDialogProps {
  /** Send `/goal <condition>` into a brand-new session and switch to it. Setting
   * a goal is not a pure write — the daemon registers the Stop hook AND kicks
   * off the first turn — so it has to travel the prompt path, not a REST POST. */
  onCreateGoal: (condition: string) => void | Promise<void>;
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
      setGoals(list);
      setLoadError(null);
    } catch (err) {
      if (!mountedRef.current || seq !== reloadSeqRef.current) return;
      setLoadError(err instanceof Error ? err.message : String(err));
      setGoals((prev) => prev ?? []);
    }
  }, [actions]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const id = window.setInterval(() => void reload(), RELOAD_INTERVAL_MS);
    return () => window.clearInterval(id);
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
    if (trimmed.length > MAX_GOAL_LENGTH) {
      setFormError(t('goals.error.tooLong', { max: MAX_GOAL_LENGTH }));
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      await onCreateGoal(trimmed);
      if (!mountedRef.current) return;
      resetForm();
    } catch (err) {
      if (!mountedRef.current) return;
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }, [condition, onCreateGoal, resetForm, t]);

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
                maxLength={MAX_GOAL_LENGTH}
                rows={4}
                placeholder={t('goals.conditionPlaceholder')}
                onChange={(e) => setCondition(e.target.value)}
              />
            </label>
            <div className={styles.formHint}>{t('goals.newHint')}</div>

            {formError && <div className={styles.formError}>{formError}</div>}

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

      {loadError && <div className={styles.loadError}>{loadError}</div>}

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
                  className={`${styles.statusDot} ${goal.running ? styles.statusDotRunning : ''}`}
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
                  {t(goal.running ? 'goals.running' : 'goals.idle')}
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
