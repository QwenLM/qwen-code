/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { buildGoalControlRequest } from '../../utils/goalControlRequest';
import { canResumeGoal } from '../../utils/goalGate';
import {
  useWorkspaceActions,
  type DaemonGoal,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { Pause, Pencil, Play, Trash2 } from 'lucide-react';
import { useI18n } from '../../i18n';
import { DialogShell } from './DialogShell';
import { formatRuntime } from '../../utils/formatRuntime';
import { getGoalActiveTimeMs } from '../GoalStatusStrip';
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
  /** Create a canonical Goal in a brand-new session and switch to it.
   * Return `false` when session setup failed and the error was already shown;
   * throw to render the control failure inline. */
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
  const [busySessionIds, setBusySessionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const busySessionIdsRef = useRef<Set<string>>(new Set());

  const [showForm, setShowForm] = useState(false);
  const [editingGoal, setEditingGoal] = useState<DaemonGoal | null>(null);
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
  const hasGoals = goals?.some(
    ({ snapshot }) => snapshot.goal?.status === 'active',
  );
  useEffect(() => {
    if (!hasGoals) return;
    const id = window.setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [hasGoals]);

  const resetForm = useCallback(() => {
    setCondition('');
    setEditingGoal(null);
    setFormError(null);
    setShowForm(false);
  }, []);

  const setSessionBusy = useCallback((sessionId: string, busy: boolean) => {
    const next = new Set(busySessionIdsRef.current);
    if (busy) next.add(sessionId);
    else next.delete(sessionId);
    busySessionIdsRef.current = next;
    if (mountedRef.current) setBusySessionIds(next);
  }, []);

  const openEdit = useCallback((goal: DaemonGoal) => {
    setCondition(goal.snapshot.goal?.objective ?? '');
    setEditingGoal(goal);
    setFormError(null);
    setShowForm(true);
  }, []);

  const handleSubmit = useCallback(async () => {
    const trimmed = condition.trim();
    if (trimmed.length === 0) {
      setFormError(t('goals.error.emptyCondition'));
      return;
    }
    const editingSessionId = editingGoal?.sessionId;
    if (editingSessionId && busySessionIdsRef.current.has(editingSessionId)) {
      return;
    }
    if (editingSessionId) setSessionBusy(editingSessionId, true);
    setSubmitting(true);
    setFormError(null);
    try {
      if (editingGoal) {
        // No fallback to the stale snapshot: a session that has dropped out of
        // the list entirely is exactly the "no longer available" case this
        // branch reports, and resurrecting it would compare the stale goal
        // against itself and send a stale expectedRevision the daemon rejects
        // with a raw conflict error.
        const currentEditingGoal = goals?.find(
          (item) => item.sessionId === editingGoal.sessionId,
        );
        const goal = currentEditingGoal?.snapshot.goal;
        if (
          !currentEditingGoal ||
          !goal ||
          goal.goalId !== editingGoal.snapshot.goal?.goalId
        ) {
          throw new Error(t('goals.error.goalUnavailable'));
        }
        await actions.controlGoal(
          currentEditingGoal.sessionId,
          buildGoalControlRequest('edit', goal, trimmed, {
            emptyObjective: t('goals.error.emptyCondition'),
            goalUnavailable: t('goals.error.goalUnavailable'),
          }),
        );
      } else {
        const created = await onCreateGoal(trimmed);
        if (!mountedRef.current) return;
        if (created === false) return;
      }
      await reload();
      resetForm();
    } catch (err) {
      if (!mountedRef.current) {
        // The page closed while the prompt was in flight, so the inline form
        // error has nowhere to render. Toast rather than swallow it.
        onError(err, t('goals.error.saveFailed'));
        return;
      }
      if (editingGoal) await reload();
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      if (editingSessionId) setSessionBusy(editingSessionId, false);
      if (mountedRef.current) setSubmitting(false);
    }
  }, [
    actions,
    condition,
    editingGoal,
    goals,
    onCreateGoal,
    onError,
    reload,
    resetForm,
    setSessionBusy,
    t,
  ]);

  const control = useCallback(
    async (item: DaemonGoal, action: 'pause' | 'resume' | 'clear') => {
      const goal = item.snapshot.goal;
      if (!goal || busySessionIdsRef.current.has(item.sessionId)) return;
      setSessionBusy(item.sessionId, true);
      try {
        await actions.controlGoal(
          item.sessionId,
          buildGoalControlRequest(action, goal, undefined, {
            emptyObjective: t('goals.error.emptyCondition'),
            goalUnavailable: t('goals.error.goalUnavailable'),
          }),
        );
        await reload();
      } catch (err) {
        await reload();
        onError(err, t(`goals.error.${action}Failed`));
      } finally {
        setSessionBusy(item.sessionId, false);
      }
    },
    [actions, onError, reload, setSessionBusy, t],
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
              setEditingGoal(null);
              setFormError(null);
              setShowForm(true);
            }}
          >
            {t('goals.new')}
          </button>
        </div>
      </div>

      {showForm && (
        <DialogShell
          title={t(editingGoal ? 'goals.edit' : 'goals.new')}
          size="md"
          // A submit that outlives its form applies `resetForm()`/`setFormError`
          // to whatever form is open when it settles, so closing mid-flight
          // would dismiss (or misattribute an error to) the next goal's form.
          dismissible={!submitting}
          onClose={resetForm}
        >
          <div className={styles.formFields}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>
                {t('goals.objective')}
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
                {submitting
                  ? t('goals.saving')
                  : t(editingGoal ? 'goals.save' : 'goals.create')}
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

      {/* Explicit list semantics: these are divs, and even a real <ul> loses its
          implicit role under `display: flex` in Safari. Without them a screen
          reader cannot announce "list, N items" or navigate goal by goal. */}
      <div className={styles.list} role="list">
        {(goals ?? []).map((item) => {
          const goal = item.snapshot.goal;
          if (!goal) return null;
          const busy = busySessionIds.has(item.sessionId);
          // The reducer rejects `edit` on a completed Goal, and completion does
          // not bump the revision, so the version check passes and the edit
          // dead-ends in an error toast. Gate the affordance the way
          // pause/resume are gated.
          const canEdit = goal.status !== 'complete';
          const canPause = goal.status === 'active';
          // Shared with `GoalStatusStrip` so the two gates cannot drift apart.
          const canResume = canResumeGoal(goal);
          return (
            <div key={item.sessionId} className={styles.card} role="listitem">
              <div className={styles.cardHeader}>
                <span
                  className={`${styles.statusDot} ${item.snapshot.activity !== 'idle' ? styles.statusDotRunning : ''}`}
                  aria-hidden="true"
                />
                <div className={styles.cardTitle} title={goal.objective}>
                  {goal.objective}
                </div>
                <div className={styles.cardMenu}>
                  {canEdit && (
                    <button
                      type="button"
                      className={styles.iconAction}
                      onClick={() => openEdit(item)}
                      disabled={busy}
                      title={t('goal.edit')}
                      aria-label={t('goal.edit')}
                    >
                      <Pencil size={15} aria-hidden="true" />
                    </button>
                  )}
                  {canPause && (
                    <button
                      type="button"
                      className={styles.iconAction}
                      onClick={() => void control(item, 'pause')}
                      disabled={busy}
                      title={t('goal.pause')}
                      aria-label={t('goal.pause')}
                    >
                      <Pause size={15} aria-hidden="true" />
                    </button>
                  )}
                  {canResume && (
                    <button
                      type="button"
                      className={styles.iconAction}
                      onClick={() => void control(item, 'resume')}
                      disabled={busy}
                      title={t('goal.resume')}
                      aria-label={t('goal.resume')}
                    >
                      <Play size={15} aria-hidden="true" />
                    </button>
                  )}
                  <button
                    type="button"
                    className={styles.iconAction}
                    onClick={() => void control(item, 'clear')}
                    disabled={busy}
                    title={t('goals.clear')}
                    aria-label={t('goals.clear')}
                  >
                    <Trash2 size={15} aria-hidden="true" />
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
                  {t(`goal.status.${goal.status}`)}
                </span>
                <span className={styles.meta} data-testid="goal-activity">
                  {t(`goal.activity.${item.snapshot.activity}`)}
                </span>
                <span className={styles.meta}>
                  {goal.turnCount > 0
                    ? t(goal.turnCount === 1 ? 'goal.turn' : 'goal.turns', {
                        count: goal.turnCount,
                      })
                    : t('goals.notYetEvaluated')}
                </span>
                <span className={styles.meta} data-testid="goal-elapsed">
                  {formatRuntime(getGoalActiveTimeMs(item.snapshot, now))}
                </span>
                <button
                  type="button"
                  className={styles.sessionLink}
                  onClick={() => onOpenSession(item.sessionId)}
                  title={t('goals.openSessionHint')}
                  // The visible text is just the session's name, which says
                  // nothing about what activating it does. Name the action AND
                  // the target — the target stays in the accessible name so it
                  // still contains the visible label (WCAG 2.5.3).
                  aria-label={`${t('goals.openSessionHint')}: ${item.displayName || item.sessionId}`}
                >
                  {item.displayName || item.sessionId}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
