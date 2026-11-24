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
  useWorkspaceActions,
  type DaemonScheduledTask,
} from '@qwen-code/web-shell/daemon-react-sdk';
import {
  useDaemonAvailability,
  useDaemonAvailabilityController,
} from '../daemon/availability-context.js';
import { isDaemonUnavailableError } from '../daemon/availability.js';
import { useI18n } from '../i18n';
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
  cancelSessionTaskById: (taskId: string) => Promise<boolean>;
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
  onError: ScheduledTaskActionErrorHandler;
  refreshTrigger?: number;
}): SessionScheduledTasksResult {
  const {
    sessionId,
    workspaceId,
    connected,
    durableEnabled,
    activityKey,
    durableSeeded = false,
    onRunPrompt,
    onError,
    refreshTrigger = 0,
  } = options;
  const available = useDaemonAvailability() === 'available';
  const availability = useDaemonAvailabilityController();
  const { t } = useI18n();
  const sessionActions = useActions();
  const workspaceActions = useWorkspaceActions();
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
    // The counter is a baseline only at owner/session transitions. Later
    // increments are handled as explicit intent by the request effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, sessionId, workspaceId]);

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
          (task) => !confirmedCancelledIdsRef.current.has(task.id),
        ),
      );
      setHasLiveSessionSnapshot(true);
    },
    [owner],
  );

  const refresh = useCallback(() => {
    // Revoke older reads before React starts the replacement request.
    durableReqRef.current += 1;
    manualRefreshSessionRef.current = sessionId;
    setManualRefreshTick((n) => n + 1);
  }, [sessionId]);

  const markBusy = useCallback((id: string, busy: boolean) => {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const toggleDurableTask = useCallback(
    async (entry: SessionDurableScheduledTask) => {
      if (!workspaceActions?.updateScheduledTask) return;
      const generation = scopeGenerationRef.current;
      const durableRevision = durableRevisionRef.current;
      const isCurrent = () =>
        durableRevisionRef.current === durableRevision &&
        scopeGenerationRef.current === generation &&
        owner.isCurrent();
      durableReqRef.current += 1;
      markBusy(entry.id, true);
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
        if (isCurrent()) onError(error, t('scheduledTasks.error.toggleFailed'));
      } finally {
        if (isCurrent()) markBusy(entry.id, false);
      }
    },
    [markBusy, onError, owner, t, workspaceActions, workspaceId],
  );

  const runDurableTask = useCallback(
    async (entry: SessionDurableScheduledTask) => {
      if (!workspaceActions?.runScheduledTask || manualRunActiveRef.current) {
        return;
      }
      const generation = scopeGenerationRef.current;
      const durableRevision = durableRevisionRef.current;
      const isCurrent = () =>
        durableRevisionRef.current === durableRevision &&
        scopeGenerationRef.current === generation &&
        owner.isCurrent();
      const deletedTaskKey = JSON.stringify([
        entry.workspaceId ?? workspaceId ?? null,
        entry.id,
      ]);
      // Same-session boundary admits one pending bound run. The ref closes
      // the rapid second-click window before React state renders.
      manualRunActiveRef.current = true;
      setManualRunActive(true);
      markBusy(entry.id, true);
      try {
        await runScheduledTaskManually(
          { ...entry.task, workspaceId: entry.workspaceId ?? workspaceId },
          workspaceActions,
          onRunPrompt,
          t,
          {
            reload: refresh,
            onError,
            isCurrent,
            isStale: () =>
              confirmedDeletedDurableTaskKeysRef.current.has(deletedTaskKey),
          },
        );
      } finally {
        if (isCurrent()) {
          manualRunActiveRef.current = false;
          setManualRunActive(false);
          markBusy(entry.id, false);
        }
      }
    },
    [
      markBusy,
      onError,
      onRunPrompt,
      owner,
      refresh,
      t,
      workspaceActions,
      workspaceId,
    ],
  );

  const confirmDurableDeletion = useCallback(
    (task: { id: string; workspaceId?: string; sessionId?: string | null }) => {
      if (!owner.isCurrent() || !durableEnabled || task.sessionId !== sessionId)
        return;
      durableReqRef.current += 1;
      const key = JSON.stringify([
        task.workspaceId ?? workspaceId ?? null,
        task.id,
      ]);
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
      const isCurrent = () =>
        durableRevisionRef.current === durableRevision &&
        scopeGenerationRef.current === generation &&
        owner.isCurrent();
      durableReqRef.current += 1;
      markBusy(entry.id, true);
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
        if (isCurrent()) onError(error, t('scheduledTasks.error.deleteFailed'));
        return false;
      } finally {
        if (isCurrent()) markBusy(entry.id, false);
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
    (taskId: string, expectedSessionId = sessionId) => {
      if (!owner.isCurrent() || expectedSessionId !== sessionId) return;
      confirmedCancelledIdsRef.current.add(taskId);
      setConfirmedCancelledSessionTaskIds(
        new Set(confirmedCancelledIdsRef.current),
      );
      setSessionScopedTasks((prev) =>
        prev.filter((item) => item.id !== taskId),
      );
    },
    [owner, sessionId],
  );

  const cancelSessionTaskById = useCallback(
    async (taskId: string): Promise<boolean> => {
      const generation = scopeGenerationRef.current;
      const isCurrent = () =>
        scopeGenerationRef.current === generation && owner.isCurrent();
      markBusy(taskId, true);
      try {
        const result = await sessionActions.cancelTask(taskId, 'cron');
        if (result.cancelled && isCurrent()) {
          confirmSessionCancellation(taskId);
        }
        if (!result.cancelled && isCurrent()) {
          onError(
            new Error(t('scheduledTasks.error.cancelFailed')),
            t('scheduledTasks.error.cancelFailed'),
          );
        }
        return result.cancelled;
      } catch (error) {
        if (isCurrent()) onError(error, t('scheduledTasks.error.cancelFailed'));
        return false;
      } finally {
        if (isCurrent()) markBusy(taskId, false);
      }
    },
    [confirmSessionCancellation, markBusy, onError, owner, sessionActions, t],
  );

  const cancelSessionTask = useCallback(
    async (entry: SessionScopedScheduledTask): Promise<boolean> =>
      cancelSessionTaskById(entry.id),
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
      map.set(task.id, task.enabled ? 'active' : 'paused');
    }
    return map;
  }, [tasks]);

  const liveSessionTaskById = useMemo(() => {
    const map = new Map<string, DaemonSessionScheduledTaskStatus>();
    for (const task of sessionScopedTasks) {
      map.set(task.id, task);
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
      confirmedDeletedDurableTaskKeysRef.current.has(
        JSON.stringify([task.workspaceId ?? workspaceId ?? null, task.id]),
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
