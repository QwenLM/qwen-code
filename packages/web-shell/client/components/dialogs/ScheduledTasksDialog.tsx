/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useWorkspaceActions,
  type DaemonScheduledTask,
  type DaemonScheduledTaskRun,
} from '@qwen-code/webui/daemon-react-sdk';
import { useI18n } from '../../i18n';
import { DialogShell } from './DialogShell';
import {
  buildCron,
  describeCron,
  describeLastRun,
  formatCountdown,
  parseCronToBuilder,
  DEFAULT_BUILDER,
  type BuilderState,
  type Frequency,
  type TranslateFn,
} from './scheduledTasksSchedule';
import styles from './ScheduledTasksDialog.module.css';

/** Localized absolute timestamp, resilient to a bad epoch value. */
function safeLocaleString(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

/** Formats one run-history entry: localized timestamp + a kind tag. */
function describeRun(run: DaemonScheduledTaskRun, t: TranslateFn): string {
  const kind =
    run.kind === 'catch-up'
      ? ` · ${t('scheduledTasks.runKind.catchUp')}`
      : run.kind === 'manual'
        ? ` · ${t('scheduledTasks.runKind.manual')}`
        : '';
  return `${safeLocaleString(run.at)}${kind}`;
}

interface ScheduledTasksDialogProps {
  /** Manual "run now": execute the task's prompt in its bound session (so it
   * lands in the same transcript as its scheduled runs), or in the current
   * session for an unbound task. The App wiring switches to that session. */
  onRunPrompt: (
    prompt: string,
    sessionId: string | null,
  ) => void | Promise<void>;
  /** Switch to the chat view with the composer primed to describe a task, so
   * the agent can create it conversationally via its cron_create tool. */
  onCreateViaChat: () => void;
  /** Open a task's bound session — its transcript IS the task's run history.
   * When absent, tasks fall back to the inline fire-timestamp list. */
  onOpenSession?: (sessionId: string) => void;
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

// Divisors of 60 only: a non-divisor `*/N` is anchored to the hour and fires
// more often than "every N minutes" implies, so the picker offers only values
// that actually mean "every N minutes".
const MINUTE_INTERVALS = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30];
// The largest delay window.setTimeout handles without 32-bit overflow (~24.8
// days); larger values fire immediately.
const MAX_SET_TIMEOUT_MS = 2_147_483_647;
// A task past its nextRunAt reports the same past value on every fetch. Reload
// promptly this many times (to catch a just-fired task advancing), then fall
// back to the slow lane so a permanently-stuck task can't spin a 1 Hz GET loop.
const PAST_DUE_FAST_RELOADS = 3;
const OVERDUE_RELOAD_INTERVAL_MS = 30_000;

export function ScheduledTasksDialog({
  onRunPrompt,
  onCreateViaChat,
  onOpenSession,
  onError,
}: ScheduledTasksDialogProps) {
  const { t } = useI18n();
  const actions = useWorkspaceActions();

  const [tasks, setTasks] = useState<DaemonScheduledTask[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // The task whose manual "run now" is mid-flight (switching to its session +
  // enqueuing). Serialized to one at a time so overlapping runs can't drop a
  // prompt on the App's single bound-run latch.
  const [runningTaskId, setRunningTaskId] = useState<string | null>(null);

  // Create / edit form. `editingId` null = create, otherwise the id of the
  // task being edited (the form is dual-mode — same fields, different verb).
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [builder, setBuilder] = useState<BuilderState>(DEFAULT_BUILDER);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Which task's run history is expanded inline (only one at a time).
  const [expandedRunsId, setExpandedRunsId] = useState<string | null>(null);

  // Wall-clock, ticked every second, that the per-task next-run countdowns are
  // measured against. Only runs while at least one task has a next run.
  const [now, setNow] = useState(() => Date.now());

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

  // Tick the countdown clock once a second, but only while something is
  // actually counting down — an all-disabled (or empty) list needs no timer.
  const hasCountdown = !!tasks?.some((task) => task.nextRunAt != null);
  useEffect(() => {
    if (!hasCountdown) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [hasCountdown]);

  // Refresh the list shortly after the soonest task is due, so its countdown
  // rolls to the next occurrence and lastFiredAt / run history refresh too.
  const pastDueReloadsRef = useRef(0);
  useEffect(() => {
    if (!tasks) return;
    let soonest = Infinity;
    for (const task of tasks) {
      if (task.nextRunAt != null && task.nextRunAt < soonest) {
        soonest = task.nextRunAt;
      }
    }
    if (!Number.isFinite(soonest)) return;
    const remaining = soonest - Date.now();
    let delay: number;
    if (remaining > 0) {
      pastDueReloadsRef.current = 0;
      // Reload just after the fire (+2s). Clamp to the 32-bit setTimeout ceiling
      // (~24.8 days) so a months-away schedule can't overflow to fire-immediately
      // and re-arm in a tight loop.
      delay = Math.min(remaining + 2000, MAX_SET_TIMEOUT_MS);
    } else {
      // Already past due. A task that just fired advances its nextRunAt within a
      // couple of prompt reloads; one that stays past due (unbound with no lock
      // owner, or a bound session that won't revive) never advances — back off
      // to a slow lane so the page doesn't spin a 1 Hz GET /scheduled-tasks loop.
      const n = pastDueReloadsRef.current++;
      delay = n < PAST_DUE_FAST_RELOADS ? 1000 : OVERDUE_RELOAD_INTERVAL_MS;
    }
    const id = window.setTimeout(() => void reload(), delay);
    return () => window.clearTimeout(id);
  }, [tasks, reload]);

  const previewCron = buildCron(builder);
  const previewLabel = previewCron ? describeCron(previewCron, t) : null;

  const resetForm = useCallback(() => {
    setName('');
    setPrompt('');
    setBuilder(DEFAULT_BUILDER);
    setFormError(null);
    setShowForm(false);
    setEditingId(null);
  }, []);

  const openCreate = useCallback(() => {
    setEditingId(null);
    setName('');
    setPrompt('');
    setBuilder(DEFAULT_BUILDER);
    setFormError(null);
    setShowForm(true);
  }, []);

  const openEdit = useCallback((task: DaemonScheduledTask) => {
    setEditingId(task.id);
    setName(task.name ?? '');
    setPrompt(task.prompt);
    // Reverse the cron back onto the pickers; an expression the pickers can't
    // represent lands in the `custom` field, never silently rewritten.
    setBuilder(parseCronToBuilder(task.cron));
    setFormError(null);
    setShowForm(true);
  }, []);

  const handleSubmit = useCallback(async () => {
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
      if (editingId) {
        // Update only the editable fields; `recurring`/`enabled` are omitted so
        // the PATCH leaves them unchanged (recurring isn't in this form, and
        // enabled is driven by the card toggle). Empty name clears it.
        await actions.updateScheduledTask(editingId, {
          cron,
          prompt: prompt.trim(),
          name: name.trim() || null,
        });
      } else {
        await actions.createScheduledTask({
          cron,
          prompt: prompt.trim(),
          name: name.trim() || null,
          recurring: true,
          enabled: true,
        });
      }
      if (!mountedRef.current) return;
      resetForm();
      await reload();
    } catch (err) {
      if (!mountedRef.current) return;
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }, [actions, builder, editingId, name, prompt, reload, resetForm, t]);

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

  const handleRunNow = useCallback(
    async (task: DaemonScheduledTask) => {
      // Cheap early exit on the (possibly stale) snapshot, and serialize: only
      // one manual run in flight, since the App holds a single pending bound-run
      // latch and overlapping runs could drop a prompt.
      if (!task.enabled || runningTaskId !== null) return;
      setRunningTaskId(task.id);
      try {
        // Server-authoritative re-check right before running: the dialog's
        // snapshot can be stale — another tab/API may have disabled or deleted
        // the task since it loaded. Running then would EXECUTE the prompt in the
        // session while /run only refuses the RECORD afterward, i.e. a real
        // unrecorded run. Refresh, bail if gone/disabled, and use the FRESH
        // prompt/session so we never run an outdated one.
        const fresh = (await actions.listScheduledTasks()).find(
          (tk) => tk.id === task.id,
        );
        if (!fresh || !fresh.enabled) {
          await reload().catch(() => {});
          onError(
            new Error('This task is no longer runnable.'),
            t('scheduledTasks.error.runFailed'),
          );
          return;
        }
        if (fresh.recurring) {
          // Recurring: enqueue FIRST (onRunPrompt resolves at admission, rejects
          // if the session can't be opened), record AFTER — so a failed enqueue
          // leaves no false "ran" entry. A record failure is surfaced but the
          // history still catches up on the next refresh.
          await onRunPrompt(fresh.prompt, fresh.sessionId);
          try {
            await actions.runScheduledTask(fresh.id);
            await reload();
          } catch (err) {
            onError(err, t('scheduledTasks.error.runFailed'));
          }
        } else {
          // One-shot: /run IS its single fire — it deletes the task. Consume it
          // BEFORE enqueuing so it can't ALSO fire at its own scheduled slot (a
          // silent double execution). The trade-off is that a failed delivery
          // leaves the task gone AND un-run — and reload() has already dropped it
          // from the list — so surface THAT explicitly rather than the generic
          // "run failed", which would hide the deletion.
          await actions.runScheduledTask(fresh.id);
          await reload();
          try {
            await onRunPrompt(fresh.prompt, fresh.sessionId);
          } catch (err) {
            onError(err, t('scheduledTasks.error.oneShotConsumedButFailed'));
            return;
          }
        }
      } catch (err) {
        onError(err, t('scheduledTasks.error.runFailed'));
      } finally {
        setRunningTaskId(null);
      }
    },
    [actions, onError, onRunPrompt, reload, runningTaskId, t],
  );

  const handleDelete = useCallback(
    async (task: DaemonScheduledTask) => {
      // Truncate: an unnamed task falls back to its prompt, which can be up to
      // MAX_PROMPT_LENGTH — too long for a confirm() dialog.
      const raw = task.name || task.prompt;
      const label = raw.length > 60 ? `${raw.slice(0, 57)}…` : raw;
      if (!window.confirm(t('scheduledTasks.deleteConfirm', { name: label }))) {
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
            onClick={openCreate}
          >
            {t('scheduledTasks.new')}
          </button>
        </div>
      </div>

      {showForm && (
        <DialogShell
          title={t(
            editingId ? 'scheduledTasks.editTitle' : 'scheduledTasks.new',
          )}
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
                maxLength={100_000}
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
                onClick={() => void handleSubmit()}
                disabled={submitting}
              >
                {submitting
                  ? t(
                      editingId
                        ? 'scheduledTasks.saving'
                        : 'scheduledTasks.creating',
                    )
                  : t(
                      editingId
                        ? 'scheduledTasks.save'
                        : 'scheduledTasks.create',
                    )}
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
                    onClick={() => void handleRunNow(task)}
                    disabled={!task.enabled || runningTaskId !== null}
                    title={t('scheduledTasks.runNow')}
                    aria-label={t('scheduledTasks.runNow')}
                  >
                    ▶
                  </button>
                  <button
                    type="button"
                    className={styles.iconAction}
                    onClick={() => openEdit(task)}
                    disabled={busy}
                    title={t('scheduledTasks.edit')}
                    aria-label={t('scheduledTasks.edit')}
                  >
                    ✎
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
                {task.nextRunAt != null && (
                  <span
                    className={styles.countdown}
                    data-testid="scheduled-task-next-run"
                    title={t('scheduledTasks.nextRunTooltip', {
                      when: safeLocaleString(task.nextRunAt),
                    })}
                  >
                    <span className={styles.hourglassIcon} aria-hidden="true">
                      ⏳
                    </span>
                    {formatCountdown(task.nextRunAt - now, t)}
                  </span>
                )}
                <span className={styles.lastFired}>
                  {describeLastRun(task, t)}
                </span>
                {task.sessionId && onOpenSession ? (
                  // The task's bound session IS its run history — open its
                  // transcript. Always shown (empty state included) so the
                  // history is discoverable even before the first run.
                  <button
                    type="button"
                    className={styles.runsToggle}
                    onClick={() => onOpenSession(task.sessionId!)}
                    title={t('scheduledTasks.viewHistoryHint')}
                  >
                    {task.runs.length > 0
                      ? t('scheduledTasks.viewHistory', {
                          count: task.runs.length,
                        })
                      : t('scheduledTasks.viewHistoryEmpty')}
                  </button>
                ) : (
                  // Unbound (tool-created / legacy) task: no session to open, so
                  // fall back to the inline fire-timestamp list.
                  task.runs.length > 0 && (
                    <button
                      type="button"
                      className={styles.runsToggle}
                      aria-expanded={expandedRunsId === task.id}
                      onClick={() =>
                        setExpandedRunsId((cur) =>
                          cur === task.id ? null : task.id,
                        )
                      }
                    >
                      {t('scheduledTasks.runHistory', {
                        count: task.runs.length,
                      })}
                    </button>
                  )
                )}
              </div>

              {expandedRunsId === task.id && task.runs.length > 0 && (
                <ul className={styles.runsList}>
                  {/* Newest first — the ring is stored oldest-first. */}
                  {[...task.runs].reverse().map((run, idx) => (
                    <li key={`${run.at}-${idx}`} className={styles.runsItem}>
                      {describeRun(run, t)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
