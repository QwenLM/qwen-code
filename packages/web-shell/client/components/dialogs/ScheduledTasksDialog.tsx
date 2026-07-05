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

type Frequency =
  | 'daily'
  | 'weekdays'
  | 'weekly'
  | 'hourly'
  | 'minutes'
  | 'custom';

const FREQUENCIES: Frequency[] = [
  'daily',
  'weekdays',
  'weekly',
  'hourly',
  'minutes',
  'custom',
];

interface BuilderState {
  frequency: Frequency;
  time: string; // "HH:MM"
  weekday: number; // 0..6, Sun..Sat
  minuteInterval: number;
  customCron: string;
}

const DEFAULT_BUILDER: BuilderState = {
  frequency: 'daily',
  time: '09:00',
  weekday: 1,
  minuteInterval: 30,
  customCron: '0 9 * * *',
};

function parseHhmm(time: string): { hh: number; mm: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return { hh, mm };
}

/** Build a 5-field cron from the builder inputs. Returns null when the inputs
 * for the chosen frequency are invalid (the caller surfaces a form error). */
function buildCron(state: BuilderState): string | null {
  if (state.frequency === 'custom') {
    const cron = state.customCron.trim();
    return cron.length > 0 ? cron : null;
  }
  if (state.frequency === 'minutes') {
    const n = Math.floor(state.minuteInterval);
    if (!Number.isFinite(n) || n < 1 || n > 59) return null;
    return `*/${n} * * * *`;
  }
  const t = parseHhmm(state.time);
  if (!t) return null;
  switch (state.frequency) {
    case 'daily':
      return `${t.mm} ${t.hh} * * *`;
    case 'weekdays':
      return `${t.mm} ${t.hh} * * 1-5`;
    case 'weekly':
      return `${t.mm} ${t.hh} * * ${state.weekday}`;
    case 'hourly':
      return `${t.mm} * * * *`;
    default:
      return null;
  }
}

/** Human-readable schedule label, localized. Covers the shapes the builder
 * emits (the common cases in the reference design); anything else — including
 * ranges/lists a power user hand-writes — falls back to the raw expression so
 * the label is never wrong, only sometimes terse. */
function describeCron(
  cron: string,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [min, hour, dom, mon, dow] = parts;
  const isNum = (s: string) => /^\d+$/.test(s);
  const pad = (n: string) => n.padStart(2, '0');

  // */N * * * *
  if (
    /^\*\/\d+$/.test(min!) &&
    hour === '*' &&
    dom === '*' &&
    mon === '*' &&
    dow === '*'
  ) {
    return t('scheduledTasks.human.everyMinutes', { n: min!.slice(2) });
  }
  // M * * * *  → hourly at minute M
  if (
    isNum(min!) &&
    hour === '*' &&
    dom === '*' &&
    mon === '*' &&
    dow === '*'
  ) {
    return t('scheduledTasks.human.hourly', { min: pad(min!) });
  }
  // M H * * *  → daily
  if (
    isNum(min!) &&
    isNum(hour!) &&
    dom === '*' &&
    mon === '*' &&
    dow === '*'
  ) {
    return t('scheduledTasks.human.daily', {
      time: `${pad(hour!)}:${pad(min!)}`,
    });
  }
  // M H * * 1-5 → weekdays
  if (
    isNum(min!) &&
    isNum(hour!) &&
    dom === '*' &&
    mon === '*' &&
    dow === '1-5'
  ) {
    return t('scheduledTasks.human.weekdays', {
      time: `${pad(hour!)}:${pad(min!)}`,
    });
  }
  // M H * * D → weekly on a single weekday
  if (
    isNum(min!) &&
    isNum(hour!) &&
    dom === '*' &&
    mon === '*' &&
    isNum(dow!) &&
    Number(dow) >= 0 &&
    Number(dow) <= 6
  ) {
    const names = t('scheduledTasks.weekdayNames').split(',');
    const name = names[Number(dow)] ?? dow!;
    return t('scheduledTasks.human.weekly', {
      day: name,
      time: `${pad(hour!)}:${pad(min!)}`,
    });
  }
  return cron;
}

function describeLastRun(
  task: DaemonScheduledTask,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  // A fresh task is stamped with `lastFiredAt = floor(createdAt)` so the
  // scheduler can't fire it during its creation minute — that stamp is NOT a
  // real run. Only a genuine fire advances lastFiredAt past the creation
  // minute, so anything at or before it reads as "never run".
  const createdMinute = task.createdAt - (task.createdAt % 60_000);
  if (task.lastFiredAt === null || task.lastFiredAt <= createdMinute) {
    return t('scheduledTasks.never');
  }
  let when: string;
  try {
    when = new Date(task.lastFiredAt).toLocaleString();
  } catch {
    return t('scheduledTasks.never');
  }
  return t('scheduledTasks.lastFired', { when });
}

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
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    try {
      const list = await actions.listScheduledTasks();
      if (!mountedRef.current) return;
      // Newest first — matches the reference "sort by created, descending".
      const sorted = [...list].sort((a, b) => b.createdAt - a.createdAt);
      setTasks(sorted);
      setLoadError(null);
    } catch (err) {
      if (!mountedRef.current) return;
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
                  onChange={(e) =>
                    setBuilder((b) => ({
                      ...b,
                      frequency: e.target.value as Frequency,
                    }))
                  }
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
                  <input
                    className={styles.input}
                    type="number"
                    min={1}
                    max={59}
                    value={builder.minuteInterval}
                    onChange={(e) =>
                      setBuilder((b) => ({
                        ...b,
                        minuteInterval: Number(e.target.value),
                      }))
                    }
                  />
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
