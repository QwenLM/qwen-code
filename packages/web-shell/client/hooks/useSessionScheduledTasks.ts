import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { DaemonSessionScheduledTaskStatus } from '@qwen-code/sdk/daemon';
import {
  useActions,
  useDaemonSessionOwnerGuard,
  useWorkspace,
  useWorkspaceActions,
  type DaemonScheduledTask,
} from '@qwen-code/web-shell/daemon-react-sdk';
import {
  useDaemonAvailability,
  useDaemonAvailabilityController,
} from '../daemon/availability-context.js';
import { isDaemonUnavailableError } from '../daemon/availability.js';
import { useI18n } from '../i18n';
import { scheduledTaskRuntimeKey } from '../components/dialogs/scheduledTasksSchedule';
import {
  runScheduledTaskManually,
  type ScheduledTaskRunPrompt,
} from '../utils/scheduledTaskManualRun';

export type ScheduledTaskActionErrorHandler = (
  err: unknown,
  fallback: string,
) => void;

export interface SessionDurableScheduledTask {
  scope: 'durable';
  id: string;
  title: string;
  prompt: string;
  cronExpr: string;
  recurring: boolean;
  enabled: boolean;
  createdAt: number;
  lastFiredAt: number | null;
  nextRunAt: number | null;
  gate: string | null;
  workspaceId?: string;
  task: DaemonScheduledTask;
}

export interface SessionScopedScheduledTask {
  scope: 'session';
  source: 'cron' | 'wakeup';
  id: string;
  title: string;
  prompt: string;
  cronExpr: string;
  recurring: boolean;
  enabled: boolean;
  createdAt: number;
  lastFiredAt: number | null;
  nextRunAt: number | null;
  expiresAt: number | null;
  gate?: string;
  task: DaemonSessionScheduledTaskStatus;
}

export type SessionScheduledTask =
  | SessionDurableScheduledTask
  | SessionScopedScheduledTask;

export { scheduledTaskRuntimeKey };

export type SessionScheduledTaskLiveState = 'active' | 'paused';

export interface SessionScheduledTasksResult {
  tasks: readonly SessionScheduledTask[];
  activeCount: number;
  activeSessionCount: number;
  nextRunAt: number | null;
  taskStatusById: ReadonlyMap<string, SessionScheduledTaskLiveState>;
  liveSessionTaskById: ReadonlyMap<string, DaemonSessionScheduledTaskStatus>;
  confirmedDeletedDurableTaskKeys: ReadonlySet<string>;
  isDurableTaskDeletionConfirmed: (task: {
    id: string;
    workspaceId?: string;
    sessionId?: string | null;
  }) => boolean;
  confirmedCancelledSessionTaskIds: ReadonlySet<string>;
  confirmSessionCancellation: (
    taskId: string,
    expectedSessionId?: string,
    source?: 'cron' | 'wakeup',
  ) => void;
  confirmDurableDeletion: (task: {
    id: string;
    workspaceId?: string;
    sessionId?: string | null;
  }) => void;
  hasLiveDurableSnapshot: boolean;
  hasLiveSessionSnapshot: boolean;
  busyIds: ReadonlySet<string>;
  manualRunActive: boolean;
  syncSessionTasks: (
    tasks: readonly DaemonSessionScheduledTaskStatus[],
  ) => void;
  refresh: () => void;
  toggleDurableTask: (task: SessionDurableScheduledTask) => Promise<void>;
  runDurableTask: (task: SessionDurableScheduledTask) => Promise<void>;
  deleteDurableTask: (task: SessionDurableScheduledTask) => Promise<boolean>;
  cancelSessionTask: (task: SessionScopedScheduledTask) => Promise<boolean>;
  cancelSessionTaskById: (
    taskId: string,
    source?: 'cron' | 'wakeup',
  ) => Promise<boolean>;
}

function summarizePrompt(prompt: string): string {
  const firstLine = prompt
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  const text = firstLine ?? prompt.trim();
  const codepoints = Array.from(text);
  return codepoints.length > 80 ? `${codepoints.slice(0, 77).join('')}…` : text;
}

function toDurableEntry(
  task: DaemonScheduledTask,
  workspaceId?: string,
): SessionDurableScheduledTask {
  return {
    scope: 'durable',
    id: task.id,
    title: task.name?.trim() || summarizePrompt(task.prompt) || task.id,
    prompt: task.prompt,
    cronExpr: task.cron,
    recurring: task.recurring,
    enabled: task.enabled,
    createdAt: task.createdAt,
    lastFiredAt: task.lastFiredAt,
    nextRunAt: task.nextRunAt,
    gate: task.gate ?? null,
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    task,
  };
}

function toSessionEntry(
  task: DaemonSessionScheduledTaskStatus,
): SessionScopedScheduledTask {
  return {
    scope: 'session',
    source: task.source,
    id: task.id,
    title: summarizePrompt(task.prompt) || task.id,
    prompt: task.prompt,
    cronExpr: task.cronExpr,
    recurring: task.recurring,
    enabled: task.enabled !== false,
    createdAt: task.createdAt,
    lastFiredAt: task.lastFiredAt,
    nextRunAt: task.nextRunAt,
    expiresAt: task.expiresAt,
    ...(task.gate ? { gate: task.gate } : {}),
    task,
  };
}

export function useSessionScheduledTasks(options: {
  sessionId: string | undefined;
  workspaceId: string | undefined;
  workspaceCwd?: string;
  connected: boolean;
  durableEnabled: boolean;
  /**
   * Actual evidence of scheduling in this conversation. Empty means silent:
   * no always-on durable HTTP probe on ordinary conversation opens.
   */
  activityKey: string;
  /** Session is a dedicated persistent scheduled-task conversation. */
  durableSeeded?: boolean;
  /** Actual bound-session prompt admission, not the record-only /run route. */
  onRunPrompt: ScheduledTaskRunPrompt;
  shouldRefuseManualRun?: (task: DaemonScheduledTask) => boolean;
  onOverloadRefused?: () => void;
  onError: ScheduledTaskActionErrorHandler;
  /**
   * App calls this hook above the `<I18nProvider>` it renders, where `useI18n()`
   * falls back to key passthrough. Passing App's translator localizes errors
   * constructed inside the hook and manual-run helper too.
   */
  translate?: (key: string) => string;
  refreshTrigger?: number;
}): SessionScheduledTasksResult {
  const {
    sessionId,
    workspaceId,
    workspaceCwd,
    connected,
    durableEnabled,
    activityKey,
    durableSeeded = false,
    onRunPrompt,
    shouldRefuseManualRun,
    onOverloadRefused,
    onError,
    translate,
    refreshTrigger = 0,
  } = options;
  const available = useDaemonAvailability() === 'available';
  const availability = useDaemonAvailabilityController();
  const { t: contextTranslate } = useI18n();
  const t = translate ?? contextTranslate;
  const sessionActions = useActions();
  const workspaceActions = useWorkspaceActions();
  const workspace = useWorkspace();
  const workspaceClientRef = useRef(workspace.client);
  workspaceClientRef.current = workspace.client;
  const scopeRef = useRef({ sessionId, workspaceId });
  scopeRef.current = { sessionId, workspaceId };
  const ownerGuard = useDaemonSessionOwnerGuard();
  const ownerRef = useRef(ownerGuard.capture());
  if (!ownerRef.current?.isCurrent()) ownerRef.current = ownerGuard.capture();
  const owner = ownerRef.current;

  const [durableTasks, setDurableTasks] = useState<DaemonScheduledTask[]>([]);
  const [sessionScopedTasks, setSessionScopedTasks] = useState<
    DaemonSessionScheduledTaskStatus[]
  >([]);
  const [confirmedDeletedDurableTaskKeys, setConfirmedDeletedDurableTaskKeys] =
    useState<ReadonlySet<string>>(() => new Set<string>());
  const [hasLiveDurableSnapshot, setHasLiveDurableSnapshot] = useState(false);
  const [hasLiveSessionSnapshot, setHasLiveSessionSnapshot] = useState(false);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [manualRefreshTick, setManualRefreshTick] = useState(0);
  const [manualRunActive, setManualRunActive] = useState(false);
  const manualRunActiveRef = useRef(false);

  const durableReqRef = useRef(0);
  const durableRevisionRef = useRef(0);
  const scopeGenerationRef = useRef(0);
  const confirmedCancelledIdsRef = useRef(new Set<string>());
  const [
    confirmedCancelledSessionTaskIds,
    setConfirmedCancelledSessionTaskIds,
  ] = useState<ReadonlySet<string>>(() => new Set<string>());
  const confirmedDeletedDurableTaskKeysRef = useRef(new Set<string>());
  const manualRefreshSessionRef = useRef<string | undefined>(undefined);
  const observedRefreshTriggerRef = useRef(refreshTrigger);

  useLayoutEffect(() => {
    scopeGenerationRef.current += 1;
    confirmedCancelledIdsRef.current.clear();
    setConfirmedCancelledSessionTaskIds(new Set<string>());
    confirmedDeletedDurableTaskKeysRef.current.clear();
    setConfirmedDeletedDurableTaskKeys(new Set());
    manualRefreshSessionRef.current = undefined;
    observedRefreshTriggerRef.current = refreshTrigger;
    durableReqRef.current += 1;
    setDurableTasks([]);
    setSessionScopedTasks([]);
    setHasLiveDurableSnapshot(false);
    setHasLiveSessionSnapshot(false);
    manualRunActiveRef.current = false;
    setManualRunActive(false);
    setBusyIds(new Set());
    // The counter is a baseline only at session/workspace transitions. Later
    // increments are handled as explicit intent by the request effect below.
    // refreshTrigger is only a baseline here, not a scope change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, workspaceId]);

  useLayoutEffect(() => {
    if (durableEnabled) return;
    durableRevisionRef.current += 1;
    durableReqRef.current += 1;
    setDurableTasks([]);
    setHasLiveDurableSnapshot(false);
    confirmedDeletedDurableTaskKeysRef.current.clear();
    setConfirmedDeletedDurableTaskKeys(new Set());
    manualRunActiveRef.current = false;
    setManualRunActive(false);
    setBusyIds(new Set());
  }, [durableEnabled]);

  const fetchDurableTasks = useCallback(async () => {
    if (!available || !connected || !sessionId || !durableEnabled) return;
    if (!workspaceActions?.listScheduledTasks) return;
    if (availability && availability.getSnapshot() !== 'available') return;
    const reqId = ++durableReqRef.current;
    const durableRevision = durableRevisionRef.current;
    await workspaceActions
      .listScheduledTasks(workspaceId)
      .then((list) => {
        if (
          reqId !== durableReqRef.current ||
          durableRevision !== durableRevisionRef.current ||
          !owner.isCurrent()
        ) {
          return;
        }
        setDurableTasks(
          list.filter(
            (task) =>
              task.sessionId === sessionId &&
              !confirmedDeletedDurableTaskKeysRef.current.has(
                JSON.stringify([
                  task.workspaceId ?? workspaceId ?? null,
                  task.id,
                ]),
              ),
          ),
        );
        setHasLiveDurableSnapshot(true);
      })
      .catch((error: unknown) => {
        if (
          reqId !== durableReqRef.current ||
          durableRevision !== durableRevisionRef.current ||
          !owner.isCurrent() ||
          isDaemonUnavailableError(error)
        ) {
          return;
        }
        console.warn(
          '[web-shell] failed to refresh session scheduled tasks:',
          error,
        );
      });
  }, [
    availability,
    available,
    connected,
    durableEnabled,
    owner,
    sessionId,
    workspaceActions,
    workspaceId,
  ]);

  // Only real evidence (cron/loop activity or a dedicated scheduled-task
  // session) or an explicit user-managed panel action opens this request path.
  // Session-scoped snapshots arrive through useBackgroundTasks' shared,
  // activity-gated request channel via syncSessionTasks.
  const hasExplicitRefresh =
    manualRefreshTick > 0 && manualRefreshSessionRef.current === sessionId;
  useEffect(() => {
    if (observedRefreshTriggerRef.current !== refreshTrigger) {
      observedRefreshTriggerRef.current = refreshTrigger;
    } else if (!activityKey && !durableSeeded && !hasExplicitRefresh) {
      return;
    }
    fetchDurableTasks();
  }, [
    fetchDurableTasks,
    activityKey,
    durableSeeded,
    refreshTrigger,
    manualRefreshTick,
    hasExplicitRefresh,
  ]);

  const syncSessionTasks = useCallback(
    (incoming: readonly DaemonSessionScheduledTaskStatus[]) => {
      if (!owner.isCurrent()) return;
      // An acknowledged cancellation is newer than any task poll already in
      // flight. Do not resurrect it if that older response arrives later.
      setSessionScopedTasks(
        incoming.filter(
          (task) =>
            !confirmedCancelledIdsRef.current.has(
              scheduledTaskRuntimeKey({ ...task, scope: 'session' }),
            ),
        ),
      );
      setHasLiveSessionSnapshot(true);
    },
    [owner],
  );

  const refreshClient = workspace.client;
  const refresh = useCallback(() => {
    if (
      scopeRef.current.sessionId !== sessionId ||
      scopeRef.current.workspaceId !== workspaceId ||
      workspaceClientRef.current !== refreshClient
    ) {
      return;
    }
    // Revoke older reads before React starts the replacement request.
    durableReqRef.current += 1;
    manualRefreshSessionRef.current = sessionId;
    setManualRefreshTick((n) => n + 1);
  }, [refreshClient, sessionId, workspaceId]);

  const markBusy = useCallback(
    (task: Parameters<typeof scheduledTaskRuntimeKey>[0], busy: boolean) => {
      const key = scheduledTaskRuntimeKey(task);
      setBusyIds((prev) => {
        const next = new Set(prev);
        if (busy) next.add(key);
        else next.delete(key);
        return next;
      });
    },
    [],
  );

  const toggleDurableTask = useCallback(
    async (entry: SessionDurableScheduledTask) => {
      if (!workspaceActions?.updateScheduledTask) return;
      const generation = scopeGenerationRef.current;
      const durableRevision = durableRevisionRef.current;
      const sameScope = () =>
        durableRevisionRef.current === durableRevision &&
        scopeGenerationRef.current === generation;
      const isCurrent = () => sameScope() && owner.isCurrent();
      durableReqRef.current += 1;
      markBusy(entry, true);
      try {
        const updated = await workspaceActions.updateScheduledTask(
          entry.id,
          { enabled: !entry.enabled },
          entry.workspaceId ?? workspaceId,
          entry.task.sessionId ?? null,
        );
        if (!isCurrent()) return;
        if (
          updated.id !== entry.id ||
          (updated.sessionId ?? null) !== (entry.task.sessionId ?? null)
        ) {
          throw new Error(t('scheduledTasks.error.workspaceUnavailable'));
        }
        durableReqRef.current += 1;
        setDurableTasks((prev) =>
          prev.map((item) => (item.id === updated.id ? updated : item)),
        );
      } catch (error) {
        if (sameScope()) onError(error, t('scheduledTasks.error.toggleFailed'));
      } finally {
        if (sameScope()) markBusy(entry, false);
      }
    },
    [markBusy, onError, owner, t, workspaceActions, workspaceId],
  );

  const runDurableTask = useCallback(
    async (entry: SessionDurableScheduledTask) => {
      if (
        !workspaceActions?.runScheduledTask ||
        manualRunActiveRef.current ||
        !owner.isCurrent()
      ) {
        return;
      }
      const generation = scopeGenerationRef.current;
      const durableRevision = durableRevisionRef.current;
      const originalOwner = owner;
      const originalClient = workspaceClientRef.current;
      const sameScope = () =>
        durableRevisionRef.current === durableRevision &&
        scopeGenerationRef.current === generation;
      const isCurrent = () =>
        sameScope() && workspaceClientRef.current === originalClient;
      const deletedTaskKey = JSON.stringify([
        entry.workspaceId ?? workspaceId ?? null,
        entry.id,
      ]);
      // Same-session boundary admits one pending bound run. The ref closes
      // the rapid second-click window before React state renders.
      manualRunActiveRef.current = true;
      setManualRunActive(true);
      markBusy(entry, true);
      try {
        const resolvedWorkspaceCwd = entry.task.workspaceCwd ?? workspaceCwd;
        await runScheduledTaskManually(
          {
            ...entry.task,
            workspaceId: entry.workspaceId ?? workspaceId,
            ...(resolvedWorkspaceCwd !== undefined
              ? { workspaceCwd: resolvedWorkspaceCwd }
              : {}),
          },
          workspaceActions,
          onRunPrompt,
          t,
          {
            reload: refresh,
            onError: (error, fallback) => {
              if (
                !confirmedDeletedDurableTaskKeysRef.current.has(deletedTaskKey)
              ) {
                onError(error, fallback);
              }
            },
            isCurrent,
            isOwnerCurrent: () => originalOwner.isCurrent(),
            onOneShotError: onError,
            isStale: () =>
              confirmedDeletedDurableTaskKeysRef.current.has(deletedTaskKey),
            shouldRefuseManualRun,
            onOverloadRefused,
          },
        );
      } finally {
        if (sameScope()) {
          manualRunActiveRef.current = false;
          setManualRunActive(false);
          markBusy(entry, false);
        }
      }
    },
    [
      markBusy,
      onError,
      onOverloadRefused,
      onRunPrompt,
      owner,
      refresh,
      shouldRefuseManualRun,
      t,
      workspaceActions,
      workspaceCwd,
      workspaceId,
    ],
  );

  const confirmDurableDeletion = useCallback(
    (task: { id: string; workspaceId?: string; sessionId?: string | null }) => {
      if (
        !owner.isCurrent() ||
        !durableEnabled ||
        task.sessionId !== sessionId ||
        (task.workspaceId ?? null) !== (workspaceId ?? null)
      )
        return;
      durableReqRef.current += 1;
      const key = JSON.stringify([task.workspaceId ?? null, task.id]);
      confirmedDeletedDurableTaskKeysRef.current.add(key);
      setConfirmedDeletedDurableTaskKeys(
        new Set(confirmedDeletedDurableTaskKeysRef.current),
      );
      setDurableTasks((previous) =>
        previous.filter((item) => item.id !== task.id),
      );
    },
    [durableEnabled, owner, sessionId, workspaceId],
  );

  const deleteDurableTask = useCallback(
    async (entry: SessionDurableScheduledTask) => {
      if (!workspaceActions?.deleteScheduledTask) return false;
      const generation = scopeGenerationRef.current;
      const durableRevision = durableRevisionRef.current;
      const sameScope = () =>
        durableRevisionRef.current === durableRevision &&
        scopeGenerationRef.current === generation;
      const isCurrent = () => sameScope() && owner.isCurrent();
      durableReqRef.current += 1;
      markBusy(entry, true);
      try {
        await workspaceActions.deleteScheduledTask(
          entry.id,
          entry.workspaceId ?? workspaceId,
          entry.task.sessionId ?? null,
        );
        if (!isCurrent()) return false;
        confirmDurableDeletion({
          ...entry.task,
          workspaceId: entry.workspaceId ?? workspaceId,
        });
        return true;
      } catch (error) {
        if (sameScope()) onError(error, t('scheduledTasks.error.deleteFailed'));
        return false;
      } finally {
        if (sameScope()) markBusy(entry, false);
      }
    },
    [
      confirmDurableDeletion,
      markBusy,
      onError,
      owner,
      t,
      workspaceActions,
      workspaceId,
    ],
  );

  const confirmSessionCancellation = useCallback(
    (
      taskId: string,
      expectedSessionId = sessionId,
      source: 'cron' | 'wakeup' = 'cron',
    ) => {
      if (!owner.isCurrent() || expectedSessionId !== sessionId) return;
      const key = scheduledTaskRuntimeKey({
        id: taskId,
        source,
        scope: 'session',
      });
      confirmedCancelledIdsRef.current.add(key);
      setConfirmedCancelledSessionTaskIds(
        new Set(confirmedCancelledIdsRef.current),
      );
      setSessionScopedTasks((prev) =>
        prev.filter(
          (item) =>
            scheduledTaskRuntimeKey({ ...item, scope: 'session' }) !== key,
        ),
      );
    },
    [owner, sessionId],
  );

  const cancelSessionTaskById = useCallback(
    async (
      taskId: string,
      source: 'cron' | 'wakeup' = 'cron',
    ): Promise<boolean> => {
      const generation = scopeGenerationRef.current;
      const isCurrent = () =>
        scopeGenerationRef.current === generation && owner.isCurrent();
      const sameScope = () => scopeGenerationRef.current === generation;
      markBusy({ id: taskId, scope: 'session', source }, true);
      try {
        const result = await sessionActions.cancelTask(taskId, 'cron', source);
        if (result.cancelled && isCurrent()) {
          confirmSessionCancellation(taskId, undefined, source);
        }
        if (!result.cancelled && isCurrent()) {
          onError(
            new Error(t('scheduledTasks.error.cancelFailed')),
            t('scheduledTasks.error.cancelFailed'),
          );
        }
        return result.cancelled;
      } catch (error) {
        if (sameScope()) onError(error, t('scheduledTasks.error.cancelFailed'));
        return false;
      } finally {
        if (sameScope()) {
          markBusy({ id: taskId, scope: 'session', source }, false);
        }
      }
    },
    [confirmSessionCancellation, markBusy, onError, owner, sessionActions, t],
  );

  const cancelSessionTask = useCallback(
    async (entry: SessionScopedScheduledTask): Promise<boolean> =>
      cancelSessionTaskById(entry.id, entry.source),
    [cancelSessionTaskById],
  );

  const tasks = useMemo<readonly SessionScheduledTask[]>(() => {
    const combined: SessionScheduledTask[] = [
      ...sessionScopedTasks.map(toSessionEntry),
      ...durableTasks.map((task) => toDurableEntry(task, workspaceId)),
    ];
    combined.sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      const aNext = a.nextRunAt ?? Number.POSITIVE_INFINITY;
      const bNext = b.nextRunAt ?? Number.POSITIVE_INFINITY;
      if (aNext !== bNext) return aNext - bNext;
      return a.createdAt - b.createdAt;
    });
    return combined;
  }, [durableTasks, sessionScopedTasks, workspaceId]);

  const activeCount = useMemo(
    () => tasks.filter((task) => task.enabled).length,
    [tasks],
  );

  const activeSessionCount = sessionScopedTasks.filter(
    (task) => task.enabled !== false,
  ).length;

  const nextRunAt = useMemo(() => {
    let earliest: number | null = null;
    for (const task of tasks) {
      if (!task.enabled || task.nextRunAt === null) continue;
      if (earliest === null || task.nextRunAt < earliest) {
        earliest = task.nextRunAt;
      }
    }
    return earliest;
  }, [tasks]);

  useEffect(() => {
    if (nextRunAt === null) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (disposed) return;
      // Settle each read before scheduling the next one, including errors
      // and unchanged past-due responses.
      const delay = Math.min(
        Math.max(nextRunAt - Date.now(), 30_000),
        2_147_483_647,
      );
      timer = setTimeout(() => {
        void fetchDurableTasks().then(schedule);
      }, delay);
    };
    schedule();
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [fetchDurableTasks, nextRunAt]);

  const taskStatusById = useMemo(() => {
    const map = new Map<string, SessionScheduledTaskLiveState>();
    for (const task of tasks) {
      map.set(
        task.scope === 'session' ? scheduledTaskRuntimeKey(task) : task.id,
        task.enabled ? 'active' : 'paused',
      );
    }
    return map;
  }, [tasks]);

  const liveSessionTaskById = useMemo(() => {
    const map = new Map<string, DaemonSessionScheduledTaskStatus>();
    for (const task of sessionScopedTasks) {
      map.set(scheduledTaskRuntimeKey({ ...task, scope: 'session' }), task);
    }
    return map;
  }, [sessionScopedTasks]);

  return {
    tasks,
    activeCount,
    activeSessionCount,
    nextRunAt,
    taskStatusById,
    liveSessionTaskById,
    confirmedDeletedDurableTaskKeys,
    isDurableTaskDeletionConfirmed: (task: {
      id: string;
      workspaceId?: string;
      sessionId?: string | null;
    }) =>
      task.sessionId === sessionId &&
      (task.workspaceId ?? null) === (workspaceId ?? null) &&
      confirmedDeletedDurableTaskKeysRef.current.has(
        JSON.stringify([task.workspaceId ?? null, task.id]),
      ),
    confirmedCancelledSessionTaskIds,
    confirmSessionCancellation,
    confirmDurableDeletion,
    hasLiveDurableSnapshot,
    hasLiveSessionSnapshot,
    busyIds,
    manualRunActive,
    syncSessionTasks,
    refresh,
    toggleDurableTask,
    runDurableTask,
    deleteDurableTask,
    cancelSessionTask,
    cancelSessionTaskById,
  };
}
