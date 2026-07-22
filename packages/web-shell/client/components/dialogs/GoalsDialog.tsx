/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GoalControlRequest, GoalRecord } from '@qwen-code/sdk/daemon';
import {
  useWorkspaceActions,
  type DaemonGoal,
} from '@qwen-code/webui/daemon-react-sdk';
import { Pause, Pencil, Play, Trash2 } from 'lucide-react';
import { useI18n } from '../../i18n';
import { DialogShell } from './DialogShell';
import { formatRuntime } from '../../utils/formatRuntime';
import { getGoalActiveTimeMs } from '../GoalStatusStrip';
import styles from './GoalsDialog.module.css';

const RELOAD_INTERVAL_MS = 10_000;
const TICK_INTERVAL_MS = 1000;

interface GoalsDialogProps {
  /** Create a Goal in the currently bound session through Goal control v2. */
  onCreateGoal: (objective: string) => boolean | void | Promise<boolean | void>;
  onOpenSession: (sessionId: string) => void;
  onError: (error: unknown, fallback: string) => void;
}

function versionedRequest(
  goal: GoalRecord,
  action: 'edit' | 'pause' | 'resume' | 'clear',
  objective?: string,
): GoalControlRequest {
  return {
    action,
    ...(action === 'edit' ? { objective: objective ?? goal.objective } : {}),
    expectedGoalId: goal.goalId,
    expectedRevision: goal.revision,
  } as GoalControlRequest;
}

export function GoalsDialog({
  onCreateGoal,
  onOpenSession,
  onError,
}: GoalsDialogProps) {
  const { t } = useI18n();
  const actions = useWorkspaceActions();
  const [goals, setGoals] = useState<DaemonGoal[] | null>(null);
  const [droppedCount, setDroppedCount] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busySessionId, setBusySessionId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingGoal, setEditingGoal] = useState<DaemonGoal | null>(null);
  const [objective, setObjective] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const mountedRef = useRef(true);
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
    } catch (error) {
      if (!mountedRef.current || seq !== reloadSeqRef.current) return;
      setLoadError(error instanceof Error ? error.message : String(error));
      setGoals((current) => current ?? []);
      setDroppedCount(0);
    }
  }, [actions]);

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

  const hasActiveGoal = goals?.some(
    ({ snapshot }) => snapshot.goal?.status === 'active',
  );
  useEffect(() => {
    if (!hasActiveGoal) return;
    const id = window.setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [hasActiveGoal]);

  const closeForm = useCallback(() => {
    setObjective('');
    setEditingGoal(null);
    setFormError(null);
    setShowForm(false);
  }, []);
  const requestCloseForm = useCallback(() => {
    if (!submitting) closeForm();
  }, [closeForm, submitting]);

  const openCreate = useCallback(() => {
    setObjective('');
    setEditingGoal(null);
    setFormError(null);
    setShowForm(true);
  }, []);

  const openEdit = useCallback((goal: DaemonGoal) => {
    setObjective(goal.snapshot.goal?.objective ?? '');
    setEditingGoal(goal);
    setFormError(null);
    setShowForm(true);
  }, []);

  const handleSubmit = useCallback(async () => {
    const trimmed = objective.trim();
    if (!trimmed) {
      setFormError(t('goals.error.emptyCondition'));
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      if (editingGoal) {
        const goal = editingGoal.snapshot.goal;
        if (!goal) throw new Error(t('goals.error.goalUnavailable'));
        await actions.controlGoal(
          editingGoal.sessionId,
          versionedRequest(goal, 'edit', trimmed),
        );
      } else {
        const created = await onCreateGoal(trimmed);
        if (!mountedRef.current) return;
        if (created === false) return;
      }
      await reload();
      if (mountedRef.current) closeForm();
    } catch (error) {
      await reload();
      if (!mountedRef.current) {
        onError(error, t('goals.error.saveFailed'));
        return;
      }
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }, [
    actions,
    closeForm,
    editingGoal,
    objective,
    onCreateGoal,
    onError,
    reload,
    t,
  ]);

  const control = useCallback(
    async (item: DaemonGoal, action: 'pause' | 'resume' | 'clear') => {
      const goal = item.snapshot.goal;
      if (!goal) return;
      setBusySessionId(item.sessionId);
      try {
        await actions.controlGoal(
          item.sessionId,
          versionedRequest(goal, action),
        );
        await reload();
      } catch (error) {
        await reload();
        onError(error, t(`goals.error.${action}Failed`));
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
            onClick={openCreate}
          >
            {t('goals.new')}
          </button>
        </div>
      </div>

      {showForm && (
        <DialogShell
          title={t(editingGoal ? 'goals.edit' : 'goals.new')}
          size="md"
          onClose={requestCloseForm}
        >
          <div className={styles.formFields}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>
                {t('goals.objective')}
                <span className={styles.required}>*</span>
              </span>
              <textarea
                className={styles.textarea}
                value={objective}
                rows={4}
                disabled={submitting}
                placeholder={t('goals.conditionPlaceholder')}
                onChange={(event) => setObjective(event.target.value)}
              />
            </label>
            <div className={styles.formHint}>{t('goals.newHint')}</div>
            {formError && (
              <div className={styles.formError} role="alert">
                {formError}
              </div>
            )}
            <div className={styles.formActions}>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={requestCloseForm}
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

      <div className={styles.list} role="list">
        {(goals ?? []).map((item) => {
          const goal = item.snapshot.goal;
          if (!goal) return null;
          const busy = busySessionId === item.sessionId;
          const canPause = goal.status === 'active';
          const canResume =
            goal.status === 'paused' ||
            goal.status === 'blocked' ||
            goal.status === 'usage_limited';
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
                  {goal.status !== 'complete' && (
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
                <span className={styles.meta} data-testid="goal-elapsed">
                  {formatRuntime(getGoalActiveTimeMs(item.snapshot, now))}
                </span>
                <button
                  type="button"
                  className={styles.sessionLink}
                  onClick={() => onOpenSession(item.sessionId)}
                  title={t('goals.openSessionHint')}
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
