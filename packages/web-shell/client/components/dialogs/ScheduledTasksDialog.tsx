/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useWorkspaceActions,
  type DaemonScheduledTask,
} from '@qwen-code/webui/daemon-react-sdk';
import { useI18n } from '../../i18n';
import { DialogShell } from './DialogShell';
import {
  buildCron,
  describeCron,
  describeLastRun,
  type BuilderState,
  type Frequency,
} from './scheduledTasksSchedule';
import styles from './ScheduledTasksDialog.module.css';

interface ScheduledTasksDialogProps {
  /** Manual "run now": inject the task's prompt into the current session and
   * (in the App wiring) close this dialog so the run is visible in the chat. */
  onRunPrompt: (prompt: string) => void;
  /** Switch to the chat view with the composer primed to describe a task, so
   * the agent can create it conversationally via its cron_create tool. */
  onCreateViaChat: () => void;
  onError: (error: unknown, fallback: string) => void;
}

const FREQUENCIES: Frequency[] = [
  'daily',
  'weekdays',
  'weekly',
  'hourly',
  'minutes',
  'custom',
];

const DEFAULT_BUILDER: BuilderState = {
  frequency: 'daily',
  time: '09:00',
  weekday: 1,
  minuteInterval: 30,
  customCron: '0 9 * * *',
};

// Divisors of 60 only: a non-divisor `*/N` is anchored to the hour and fires
// more often than "every N minutes" implies, so the picker offers only values
// that actually mean "every N minutes".
const MINUTE_INTERVALS = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30];

export function ScheduledTasksDialog({
  onRunPrompt,
  onCreateViaChat,
  onError,
}: ScheduledTasksDialogProps) {
  const { t } = useI18n();
  const actions = useWorkspaceActions();

  const [tasks, setTasks] = useState<DaemonScheduledTask[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Create form
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [builder, setBuilder] = useState<BuilderState>(DEFAULT_BUILDER);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Guard against setState after unmount (loads are async).
  const mountedRef = useRef(true);
  // Monotonic reload id: a slow mount/Refresh load that resolves after a
  // create/toggle/delete's reload must not overwrite the newer list with
  // stale data. Only the latest reload is allowed to apply its result.
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
      const list = await actions.listScheduledTasks();
      if (!mountedRef.current || seq !== reloadSeqRef.current) return;
      // Newest first — matches the reference "sort by created, descending".
      const sorted = [...list].sort((a, b) => b.createdAt - a.createdAt);
      setTasks(sorted);
      setLoadError(null);
    } catch (err) {
      if (!mountedRef.current || seq !== reloadSeqRef.current) return;
      setLoadError(err instanceof Error ? err.message : String(err));
      setTasks((prev) => prev ?? []);
    }
  }, [actions]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const previewCron = buildCron(builder);
  const previewLabel = previewCron ? describeCron(previewCron, t) : null;

  const resetForm = useCallback(() => {
    setName('');
    setPrompt('');
    setBuilder(DEFAULT_BUILDER);
    setFormError(null);
    setShowForm(false);
  }, []);

  const handleCreate = useCallback(async () => {
    const cron = buildCron(builder);
    if (!cron) {
      setFormError(t('scheduledTasks.error.invalidSchedule'));
      return;
    }
    if (prompt.trim().length === 0) {
      setFormError(t('scheduledTasks.error.emptyPrompt'));
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      await actions.createScheduledTask({
        cron,
        prompt: prompt.trim(),
        name: name.trim() || null,
        recurring: true,
        enabled: true,
      });
      if (!mountedRef.current) return;
      resetForm();
      await reload();
    } catch (err) {
      if (!mountedRef.current) return;
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }, [actions, builder, name, prompt, reload, resetForm, t]);

  const handleToggle = useCallback(
    async (task: DaemonScheduledTask) => {
      setBusyId(task.id);
      try {
        await actions.updateScheduledTask(task.id, { enabled: !task.enabled });
        await reload();
      } catch (err) {
        onError(err, t('scheduledTasks.error.toggleFailed'));
      } finally {
        if (mountedRef.current) setBusyId(null);
      }
    },
    [actions, onError, reload, t],
  );

  const handleDelete = useCallback(
    async (task: DaemonScheduledTask) => {
      const label = task.name || task.prompt;
      if (
        typeof window !== 'undefined' &&
        !window.confirm(t('scheduledTasks.deleteConfirm', { name: label }))
      ) {
        return;
      }
      setBusyId(task.id);
      try {
        await actions.deleteScheduledTask(task.id);
        await reload();
      } catch (err) {
        onError(err, t('scheduledTasks.error.deleteFailed'));
      } finally {
        if (mountedRef.current) setBusyId(null);
      }
    },
    [actions, onError, reload, t],
  );

  return (
    <div className={styles.root}>
      <div className={styles.intro}>{t('scheduledTasks.subtitle')}</div>

      <div className={styles.toolbar}>
        <div className={styles.count}>
          {tasks === null
            ? t('scheduledTasks.loading')
            : t('scheduledTasks.count', { count: tasks.length })}
        </div>
        <div className={styles.toolbarActions}>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => void reload()}
          >
            {t('scheduledTasks.refresh')}
          </button>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={onCreateViaChat}
          >
            {t('scheduledTasks.createViaChat')}
          </button>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={() => setShowForm(true)}
          >
            {t('scheduledTasks.new')}
          </button>
        </div>
      </div>

      {showForm && (
        <DialogShell
          title={t('scheduledTasks.new')}
          size="md"
          onClose={resetForm}
        >
          <div className={styles.formFields}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>
                {t('scheduledTasks.name')}
              </span>
              <input
                className={styles.input}
                type="text"
                value={name}
                maxLength={200}
                placeholder={t('scheduledTasks.namePlaceholder')}
                onChange={(e) => setName(e.target.value)}
              />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>
                {t('scheduledTasks.prompt')}
                <span className={styles.required}>*</span>
              </span>
              <textarea
                className={styles.textarea}
                value={prompt}
                rows={4}
                placeholder={t('scheduledTasks.promptPlaceholder')}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </label>

            <div className={styles.scheduleRow}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>
                  {t('scheduledTasks.frequency')}
                </span>
                <select
                  className={styles.select}
                  value={builder.frequency}
                  onChange={(e) => {
                    const frequency = e.target.value as Frequency;
                    setBuilder((b) => ({
                      ...b,
                      frequency,
                      // The time picker is hidden for hourly, so reset the
                      // minute to :00 instead of silently carrying over the
                      // minute picked for a daily/weekly schedule.
                      ...(frequency === 'hourly' ? { time: '00:00' } : {}),
                    }));
                  }}
                >
                  {FREQUENCIES.map((f) => (
                    <option key={f} value={f}>
                      {t(`scheduledTasks.freq.${f}`)}
                    </option>
                  ))}
                </select>
              </label>

              {(builder.frequency === 'daily' ||
                builder.frequency === 'weekdays' ||
                builder.frequency === 'weekly') && (
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>
                    {t('scheduledTasks.time')}
                  </span>
                  <input
                    className={styles.input}
                    type="time"
                    value={builder.time}
                    onChange={(e) =>
                      setBuilder((b) => ({ ...b, time: e.target.value }))
                    }
                  />
                </label>
              )}

              {builder.frequency === 'weekly' && (
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>
                    {t('scheduledTasks.weekday')}
                  </span>
                  <select
                    className={styles.select}
                    value={builder.weekday}
                    onChange={(e) =>
                      setBuilder((b) => ({
                        ...b,
                        weekday: Number(e.target.value),
                      }))
                    }
                  >
                    {t('scheduledTasks.weekdayNames')
                      .split(',')
                      .map((label, idx) => (
                        <option key={idx} value={idx}>
                          {label}
                        </option>
                      ))}
                  </select>
                </label>
              )}

              {builder.frequency === 'minutes' && (
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>
                    {t('scheduledTasks.interval')}
                  </span>
                  <select
                    className={styles.select}
                    value={builder.minuteInterval}
                    onChange={(e) =>
                      setBuilder((b) => ({
                        ...b,
                        minuteInterval: Number(e.target.value),
                      }))
                    }
                  >
                    {MINUTE_INTERVALS.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {builder.frequency === 'custom' && (
                <label className={`${styles.field} ${styles.fieldGrow}`}>
                  <span className={styles.fieldLabel}>
                    {t('scheduledTasks.cron')}
                  </span>
                  <input
                    className={styles.input}
                    type="text"
                    value={builder.customCron}
                    spellCheck={false}
                    placeholder="0 9 * * 1-5"
                    onChange={(e) =>
                      setBuilder((b) => ({ ...b, customCron: e.target.value }))
                    }
                  />
                </label>
              )}
            </div>

            <div className={styles.preview}>
              {previewLabel ? (
                <>
                  <span className={styles.previewLabel}>{previewLabel}</span>
                  <code className={styles.previewCron}>{previewCron}</code>
                </>
              ) : (
                <span className={styles.previewInvalid}>
                  {t('scheduledTasks.error.invalidSchedule')}
                </span>
              )}
            </div>

            {formError && <div className={styles.formError}>{formError}</div>}

            <div className={styles.formActions}>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={resetForm}
                disabled={submitting}
              >
                {t('scheduledTasks.cancel')}
              </button>
              <button
                type="button"
                className={styles.primaryButton}
                onClick={() => void handleCreate()}
                disabled={submitting}
              >
                {submitting
                  ? t('scheduledTasks.creating')
                  : t('scheduledTasks.create')}
              </button>
            </div>
          </div>
        </DialogShell>
      )}

      {loadError && <div className={styles.loadError}>{loadError}</div>}

      {tasks !== null && tasks.length === 0 && !loadError && (
        <div className={styles.empty}>{t('scheduledTasks.empty')}</div>
      )}

      <div className={styles.list}>
        {(tasks ?? []).map((task) => {
          const title = task.name || task.prompt;
          const busy = busyId === task.id;
          return (
            <div
              key={task.id}
              className={`${styles.card} ${task.enabled ? '' : styles.cardDisabled}`}
            >
              <div className={styles.cardHeader}>
                <button
                  type="button"
                  role="switch"
                  aria-checked={task.enabled}
                  aria-label={
                    task.enabled
                      ? t('scheduledTasks.disable')
                      : t('scheduledTasks.enable')
                  }
                  className={`${styles.toggle} ${task.enabled ? styles.toggleOn : ''}`}
                  onClick={() => void handleToggle(task)}
                  disabled={busy}
                >
                  <span className={styles.toggleKnob} />
                </button>
                <div className={styles.cardTitle} title={title}>
                  {title}
                </div>
                <div className={styles.cardMenu}>
                  <button
                    type="button"
                    className={styles.iconAction}
                    onClick={() => onRunPrompt(task.prompt)}
                    title={t('scheduledTasks.runNow')}
                    aria-label={t('scheduledTasks.runNow')}
                  >
                    ▶
                  </button>
                  <button
                    type="button"
                    className={styles.iconAction}
                    onClick={() => void handleDelete(task)}
                    disabled={busy}
                    title={t('scheduledTasks.delete')}
                    aria-label={t('scheduledTasks.delete')}
                  >
                    ✕
                  </button>
                </div>
              </div>

              {task.name && (
                <div className={styles.cardPrompt} title={task.prompt}>
                  {task.prompt}
                </div>
              )}

              <div className={styles.cardFooter}>
                <span className={styles.schedulePill}>
                  <span className={styles.clockIcon} aria-hidden="true">
                    ◷
                  </span>
                  {describeCron(task.cron, t)}
                </span>
                <span className={styles.recurringTag}>
                  {t(
                    task.recurring
                      ? 'scheduledTasks.repeats'
                      : 'scheduledTasks.runsOnce',
                  )}
                </span>
                <span className={styles.lastFired}>
                  {describeLastRun(task, t)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
