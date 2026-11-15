/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildGoalControlRequest } from '../../utils/goalControlRequest';
import { canResumeGoal } from '../../utils/goalGate';
import {
  useWorkspaceActions,
  type DaemonGoal,
} from '@qwen-code/web-shell/daemon-react-sdk';
import type { DaemonWorkspaceCapability } from '@qwen-code/sdk/daemon';
import {
  ArrowUpRight,
  MessageSquareText,
  Pause,
  Pencil,
  Play,
  Trash2,
} from 'lucide-react';
import { useI18n } from '../../i18n';
import { formatContextTokens } from '../../utils/formatTokenCount';
import {
  disambiguateWorkspaceLabels,
  workspaceLabel,
} from '../../utils/workspace';
import { DialogShell } from './DialogShell';
import {
  getGoalActiveTimeLabel,
  getGoalActiveTimeMs,
  getGoalTokenLabel,
  goalStatusTone,
} from '../GoalStatusStrip';
import { WorkspacePill } from '../WorkspacePill';
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

interface GoalBudgetBar {
  key: 'turns' | 'tokens' | 'time';
  label: string;
  valueText: string;
  /** Raw used/budget; the rendered bar clamps to [0, 1] so a spent budget
   * reads as full, not overflow. */
  ratio: number;
}

interface GoalsDialogProps {
  /** Create a canonical Goal in a brand-new session and switch to it.
   * `workspaceCwd` targets that workspace when the multi-workspace picker
   * chose one; absent keeps the App's default target. Return `false` when
   * session setup failed and the error was already shown; throw to render the
   * control failure inline. */
  onCreateGoal: (
    condition: string,
    workspaceCwd?: string,
  ) => boolean | void | Promise<boolean | void>;
  /** Open the session driving a goal — its transcript IS the goal's history.
   * `workspaceCwd` is the goal's own workspace when the aggregated view
   * tagged it, so the App loads the session in that workspace's context. */
  onOpenSession: (sessionId: string, workspaceCwd?: string) => void;
  /** Registered workspaces on a multi-workspace daemon (from capabilities).
   * When more than one is present the page aggregates every operable
   * workspace's goals (each card tagged with its workspace) and the New form
   * offers a workspace picker. Absent or a single entry → the plain
   * primary-only view. */
  workspaces?: DaemonWorkspaceCapability[];
  /** Forces all goal listing through this workspace's route. */
  lockedWorkspace?: DaemonWorkspaceCapability;
  /** The workspace the create form defaults to (the App's currently selected
   * workspace). Falls back to a creatable primary, else the first creatable
   * entry, when absent or not creatable. */
  defaultWorkspaceCwd?: string;
  onError: (error: unknown, fallback: string) => void;
}

export function GoalsDialog({
  onCreateGoal,
  onOpenSession,
  workspaces,
  lockedWorkspace,
  defaultWorkspaceCwd,
  onError,
}: GoalsDialogProps) {
  const { t } = useI18n();
  const actions = useWorkspaceActions();

  // Multi-workspace aggregation, mirroring ScheduledTasksDialog. Memoized so
  // the derived arrays are stable identities — `reload` depends on them, and a
  // fresh array each render would re-fire its mount effect in a loop.
  const workspaceList = useMemo(() => workspaces ?? [], [workspaces]);
  const isMultiWorkspace = !lockedWorkspace && workspaceList.length > 1;
  // The workspaces the page can actually read: every trusted local one, PLUS
  // the primary even when untrusted — both primary read surfaces are trust-gated,
  // so an untrusted primary surfaces as a partial-load error rather than
  // silently disappearing. SSH workspaces are excluded: the SSH boundary
  // rejects the qualified goals route with 501, so their listing can never
  // load; they fall into skippedWorkspaces so the notice accounts for them.
  const operableWorkspaces = useMemo(
    () => workspaceList.filter((ws) => ws.primary || (ws.trusted && !ws.ssh)),
    [workspaceList],
  );
  const skippedWorkspaces = useMemo(
    () => workspaceList.filter((ws) => !ws.primary && (!ws.trusted || ws.ssh)),
    [workspaceList],
  );
  // The set the create path actually accepts: the App re-validates the
  // picker's cwd against trusted workspaces, so an untrusted primary — kept
  // in operableWorkspaces to make its listing failure loud — must not be a
  // picker target, or the form opens on a dead default every retry refuses.
  const creatableWorkspaces = useMemo(
    () => operableWorkspaces.filter((ws) => ws.trusted !== false),
    [operableWorkspaces],
  );
  // The notice only renders in the aggregated view; the empty-state
  // suppression must use the same predicate so a locked view never hides its
  // empty state without showing the notice.
  const showSkippedNotice = isMultiWorkspace && skippedWorkspaces.length > 0;
  // Two checkouts can share a basename; a native <select> cannot carry a
  // tooltip, so the picker (and the badges) disambiguate like the composer's
  // workspace menu does.
  const labeledWorkspaces = useMemo(
    () =>
      disambiguateWorkspaceLabels(
        operableWorkspaces.map((ws) => ({ ...ws, label: workspaceLabel(ws) })),
      ),
    [operableWorkspaces],
  );
  const workspaceDisplayLabel = useCallback(
    (cwd: string) =>
      labeledWorkspaces.find((ws) => ws.cwd === cwd)?.label ??
      workspaceLabel({ cwd }),
    [labeledWorkspaces],
  );
  // The workspace id to pass to listGoals: primary uses its unqualified route
  // (undefined), secondaries their qualified one.
  const workspaceActionId = useCallback(
    (ws: DaemonWorkspaceCapability): string | undefined =>
      ws.primary ? undefined : ws.id,
    [],
  );
  const lockedWorkspaceId = lockedWorkspace
    ? workspaceActionId(lockedWorkspace)
    : undefined;

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
  // The workspace the create form targets. Only meaningful in the
  // multi-workspace view; the edit form has no picker (a goal's session
  // already owns its workspace).
  const [formWorkspaceCwd, setFormWorkspaceCwd] = useState<string | undefined>(
    undefined,
  );
  const defaultCreateWorkspaceCwd = useMemo(() => {
    if (
      defaultWorkspaceCwd &&
      creatableWorkspaces.some((ws) => ws.cwd === defaultWorkspaceCwd)
    ) {
      return defaultWorkspaceCwd;
    }
    return (
      creatableWorkspaces.find((ws) => ws.primary)?.cwd ??
      creatableWorkspaces[0]?.cwd
    );
  }, [defaultWorkspaceCwd, creatableWorkspaces]);
  // A capabilities refresh can drop the selected workspace (removal or trust
  // revocation) while the form stays open. Reconcile the selection with the
  // creatable set for BOTH the control and the submit: otherwise the control
  // falls back to its first option while the submit still sends the vanished
  // cwd.
  const effectiveFormWorkspaceCwd = creatableWorkspaces.some(
    (ws) => ws.cwd === formWorkspaceCwd,
  )
    ? formWorkspaceCwd
    : defaultCreateWorkspaceCwd;

  // Retire the no-creatable refusal once a creatable target reappears (a
  // capabilities refresh grants trust or registers a workspace); unrelated
  // form errors are left alone.
  const workspaceUnavailableMessage = t('goals.error.workspaceUnavailable');
  useEffect(() => {
    if (effectiveFormWorkspaceCwd) {
      setFormError((prev) =>
        prev === workspaceUnavailableMessage ? null : prev,
      );
    }
  }, [effectiveFormWorkspaceCwd, workspaceUnavailableMessage]);

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
      let list: DaemonGoal[];
      let dropped = 0;
      const failures: string[] = [];
      if (lockedWorkspace) {
        const result = await actions.listGoals(lockedWorkspaceId);
        // Tag even without a badge so opening a goal's session restores it
        // in the locked workspace's context, as the scheduled-tasks page does.
        list = result.goals.map((goal) => ({
          ...goal,
          workspaceCwd: lockedWorkspace.cwd,
        }));
        dropped = result.droppedCount;
      } else if (isMultiWorkspace) {
        // Fan out over every operable workspace and tag each goal with its
        // workspace so cards can badge it. One workspace failing must not
        // blank the whole list — keep the others and name every failing
        // workspace so no project drops out silently.
        const results = await Promise.all(
          operableWorkspaces.map(async (ws) => {
            const actionId = workspaceActionId(ws);
            try {
              const result = await actions.listGoals(actionId);
              return {
                goals: result.goals.map((goal) => ({
                  ...goal,
                  workspaceCwd: ws.cwd,
                })),
                droppedCount: result.droppedCount,
              };
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              failures.push(`${workspaceDisplayLabel(ws.cwd)}: ${message}`);
              return { goals: [] as DaemonGoal[], droppedCount: 0 };
            }
          }),
        );
        if (failures.length === operableWorkspaces.length) {
          // A total outage (daemon restart, wedged bridges) must not erase the
          // page for multi-workspace users only — keep the previous list, the
          // same retention the single/locked views get from the outer catch.
          if (!mountedRef.current || seq !== reloadSeqRef.current) return;
          setLoadError(failures.join('; '));
          setGoals((prev) => prev ?? []);
          setDroppedCount(0);
          return;
        }
        list = results.flatMap((result) => result.goals);
        dropped = results.reduce((sum, result) => sum + result.droppedCount, 0);
      } else {
        // The one workspace of a single-project daemon: its goals' sessions
        // are restored there, not in a standalone or Live context. Daemons
        // that advertise no workspace list keep the untagged legacy shape.
        const sole = workspaceList.find((ws) => ws.primary);
        const result = await actions.listGoals();
        list =
          sole && workspaceList.length === 1
            ? result.goals.map((goal) => ({ ...goal, workspaceCwd: sole.cwd }))
            : result.goals;
        dropped = result.droppedCount;
      }
      if (!mountedRef.current || seq !== reloadSeqRef.current) return;
      // Each workspace's listing is newest-first; the merged list re-sorts so
      // the aggregate keeps that order across workspaces.
      list.sort((a, b) => b.setAt - a.setAt);
      setGoals(list);
      setDroppedCount(dropped);
      setLoadError(failures.length > 0 ? failures.join('; ') : null);
    } catch (err) {
      if (!mountedRef.current || seq !== reloadSeqRef.current) return;
      setLoadError(err instanceof Error ? err.message : String(err));
      setGoals((prev) => prev ?? []);
      // The count described the previous, partially-probed list. This load
      // reached nothing at all, so keeping it would pin a degraded banner
      // reporting a partial probe that no longer happened.
      setDroppedCount(0);
    }
  }, [
    actions,
    isMultiWorkspace,
    lockedWorkspace,
    lockedWorkspaceId,
    operableWorkspaces,
    workspaceActionId,
    workspaceDisplayLabel,
    workspaceList,
  ]);

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
        // No workspace the create path would accept — every registered one
        // is untrusted or remote, including the single-workspace deployment
        // whose trust was revoked. Surface the refusal instead of submitting
        // undefined into a silent no-op. A daemon that advertises NO
        // workspace list keeps the legacy shape: submit undefined and create
        // in the primary.
        if (workspaceList.length > 0 && !effectiveFormWorkspaceCwd) {
          setFormError(t('goals.error.workspaceUnavailable'));
          return;
        }
        const created = await onCreateGoal(
          trimmed,
          isMultiWorkspace ? effectiveFormWorkspaceCwd : undefined,
        );
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
    effectiveFormWorkspaceCwd,
    goals,
    isMultiWorkspace,
    onCreateGoal,
    onError,
    reload,
    resetForm,
    setSessionBusy,
    t,
    workspaceList,
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
              setFormWorkspaceCwd(defaultCreateWorkspaceCwd);
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
            {isMultiWorkspace && !editingGoal && (
              <label className={styles.field}>
                <span className={styles.fieldLabel}>
                  {t('goals.workspace')}
                </span>
                <select
                  className={styles.select}
                  value={effectiveFormWorkspaceCwd ?? ''}
                  disabled={submitting || creatableWorkspaces.length <= 1}
                  onChange={(e) =>
                    setFormWorkspaceCwd(e.target.value || undefined)
                  }
                >
                  {labeledWorkspaces
                    .filter((ws) =>
                      creatableWorkspaces.some((c) => c.id === ws.id),
                    )
                    .map((ws) => (
                      <option key={ws.id} value={ws.cwd}>
                        {ws.label}
                      </option>
                    ))}
                </select>
                {creatableWorkspaces.length === 0 && (
                  <span
                    className={styles.formError}
                    data-testid="goals-no-creatable"
                  >
                    {workspaceUnavailableMessage}
                  </span>
                )}
              </label>
            )}
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

      {showSkippedNotice && (
        <div className={styles.degraded} data-testid="goals-skipped">
          {t('goals.workspacesSkipped', { count: skippedWorkspaces.length })}
        </div>
      )}

      {goals !== null &&
        goals.length === 0 &&
        !loadError &&
        !showSkippedNotice && (
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
          const tokenLabel = getGoalTokenLabel(goal, t);
          const activeTimeMs = getGoalActiveTimeMs(item.snapshot, now);
          const tone = goalStatusTone(goal.status);
          // Only armed budgets get a bar: an unbounded goal has no ceiling to
          // show progress against. A token budget without a usage figure
          // (older daemon) is skipped too — a bar with no fill would claim
          // zero spend the snapshot cannot actually attest. The row is the
          // single home for an armed budget's figures: the matching footer
          // cell is suppressed below, and the text reuses the same localised
          // templates the footer used so a catalogue change moves both.
          const budgets: GoalBudgetBar[] = [];
          if (goal.turnBudget !== undefined) {
            budgets.push({
              key: 'turns',
              label: t('goals.budget.turns'),
              valueText: t('goal.turnsOfBudget', {
                count: goal.turnCount,
                budget: goal.turnBudget,
              }),
              ratio: goal.turnBudget > 0 ? goal.turnCount / goal.turnBudget : 1,
            });
          }
          if (goal.tokenBudget !== undefined && goal.tokensUsed !== undefined) {
            budgets.push({
              key: 'tokens',
              label: t('goals.budget.tokens'),
              valueText: t('goal.tokensOfBudget', {
                used: formatContextTokens(goal.tokensUsed),
                budget: formatContextTokens(goal.tokenBudget),
              }),
              ratio:
                goal.tokenBudget > 0 ? goal.tokensUsed / goal.tokenBudget : 1,
            });
          }
          if (goal.activeTimeBudgetMs !== undefined) {
            budgets.push({
              key: 'time',
              label: t('goals.budget.time'),
              // Same helper the strip and the unbudgeted footer cell use, so
              // a change to the active-time wording moves every surface.
              valueText: getGoalActiveTimeLabel(goal, activeTimeMs, t),
              ratio:
                goal.activeTimeBudgetMs > 0
                  ? activeTimeMs / goal.activeTimeBudgetMs
                  : 1,
            });
          }
          const hasBudgetBar = (key: GoalBudgetBar['key']) =>
            budgets.some((budget) => budget.key === key);
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
                  {/* The transcript IS the goal's history, so opening the
                      session is the primary way to inspect a goal — give it
                      a constant header affordance, not only the footer link.
                      Navigation, not a control: never gated on `busy`. */}
                  <button
                    type="button"
                    className={`${styles.iconAction} ${styles.sessionAction}`}
                    onClick={() =>
                      onOpenSession(item.sessionId, item.workspaceCwd)
                    }
                    title={t('goals.openSessionHint')}
                    aria-label={`${t('goals.openSessionHint')}: ${item.displayName || item.sessionId}`}
                    data-testid="goal-open-session"
                  >
                    <MessageSquareText size={15} aria-hidden="true" />
                  </button>
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

              {budgets.length > 0 && (
                <div className={styles.budgets}>
                  {budgets.map((budget) => {
                    const percent = Math.round(
                      Math.min(1, Math.max(0, budget.ratio)) * 100,
                    );
                    // The progressbar's name is the visible label + figure
                    // themselves (aria-labelledby), not a second copy of them
                    // in aria-label. Ids are per-session so cards never collide.
                    const labelId = `${item.sessionId}-budget-${budget.key}-label`;
                    const valueId = `${item.sessionId}-budget-${budget.key}-value`;
                    return (
                      <div key={budget.key} className={styles.budgetRow}>
                        <span className={styles.budgetLabel} id={labelId}>
                          {budget.label}
                        </span>
                        <div
                          className={styles.budgetTrack}
                          role="progressbar"
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={percent}
                          aria-labelledby={`${labelId} ${valueId}`}
                          data-testid={`goal-budget-${budget.key}`}
                        >
                          <div
                            className={styles.budgetFill}
                            data-status={tone}
                            style={{ width: `${percent}%` }}
                          />
                        </div>
                        <span className={styles.budgetValue} id={valueId}>
                          {budget.valueText}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className={styles.cardFooter}>
                {isMultiWorkspace && item.workspaceCwd && (
                  <span data-testid="goal-workspace">
                    <WorkspacePill
                      cwd={item.workspaceCwd}
                      label={workspaceDisplayLabel(item.workspaceCwd)}
                    />
                  </span>
                )}
                <span
                  className={styles.statusPill}
                  data-status={tone}
                  data-testid="goal-status"
                >
                  {t(`goal.status.${goal.status}`)}
                </span>
                <span className={styles.meta} data-testid="goal-activity">
                  {t(`goal.activity.${item.snapshot.activity}`)}
                </span>
                {/* An armed budget's figures live in its progress row above;
                    repeating them here would state the same fact twice. */}
                {!hasBudgetBar('turns') && (
                  <span className={styles.meta} data-testid="goal-turns">
                    {goal.turnCount > 0
                      ? t(goal.turnCount === 1 ? 'goal.turn' : 'goal.turns', {
                          count: goal.turnCount,
                        })
                      : t('goals.notYetEvaluated')}
                  </span>
                )}
                {tokenLabel && !hasBudgetBar('tokens') ? (
                  <span className={styles.meta} data-testid="goal-tokens">
                    {tokenLabel}
                  </span>
                ) : null}
                {activeTimeMs > 0 && !hasBudgetBar('time') && (
                  <span className={styles.meta} data-testid="goal-elapsed">
                    {getGoalActiveTimeLabel(goal, activeTimeMs, t)}
                  </span>
                )}
                <button
                  type="button"
                  className={styles.sessionLink}
                  onClick={() =>
                    onOpenSession(item.sessionId, item.workspaceCwd)
                  }
                  title={t('goals.openSessionHint')}
                  // The visible text is just the session's name, which says
                  // nothing about what activating it does. Name the action AND
                  // the target — the target stays in the accessible name so it
                  // still contains the visible label (WCAG 2.5.3).
                  aria-label={`${t('goals.openSessionHint')}: ${item.displayName || item.sessionId}`}
                  data-testid="goal-session-link"
                >
                  <MessageSquareText size={13} aria-hidden="true" />
                  <span className={styles.sessionLinkText}>
                    {item.displayName || item.sessionId}
                  </span>
                  <ArrowUpRight size={12} aria-hidden="true" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
