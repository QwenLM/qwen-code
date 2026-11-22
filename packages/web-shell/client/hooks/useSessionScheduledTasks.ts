import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  enabled: true;
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
  deleteDurableTask: (task: SessionDurableScheduledTask) => Promise<void>;
  cancelSessionTask: (task: SessionScopedScheduledTask) => Promise<boolean>;
  cancelSessionTaskById: (taskId: string) => Promise<boolean>;
}

function summarizePrompt(prompt: string): string {
  const firstLine = prompt
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  const text = firstLine ?? prompt.trim();
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
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
    enabled: true,
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
  const [hasLiveDurableSnapshot, setHasLiveDurableSnapshot] = useState(false);
  const [hasLiveSessionSnapshot, setHasLiveSessionSnapshot] = useState(false);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [manualRefreshTick, setManualRefreshTick] = useState(0);
  const [manualRunActive, setManualRunActive] = useState(false);
  const manualRunActiveRef = useRef(false);

  const durableReqRef = useRef(0);

  useEffect(() => {
    durableReqRef.current += 1;
    setDurableTasks([]);
    setSessionScopedTasks([]);
    setHasLiveDurableSnapshot(false);
    setHasLiveSessionSnapshot(false);
    manualRunActiveRef.current = false;
    setManualRunActive(false);
    setBusyIds(new Set());
  }, [owner, sessionId, workspaceId]);

  const fetchDurableTasks = useCallback(() => {
    if (!available || !connected || !sessionId || !durableEnabled) return;
    if (!workspaceActions?.listScheduledTasks) return;
    if (availability && availability.getSnapshot() !== 'available') return;
    const reqId = ++durableReqRef.current;
    void workspaceActions
      .listScheduledTasks(workspaceId)
      .then((list) => {
        if (reqId !== durableReqRef.current || !owner.isCurrent()) return;
        setDurableTasks(list.filter((task) => task.sessionId === sessionId));
        setHasLiveDurableSnapshot(true);
      })
      .catch((error: unknown) => {
        if (
          reqId !== durableReqRef.current ||
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
  useEffect(() => {
    if (!activityKey && !durableSeeded && manualRefreshTick === 0) return;
    fetchDurableTasks();
  }, [
    fetchDurableTasks,
    activityKey,
    durableSeeded,
    refreshTrigger,
    manualRefreshTick,
  ]);

  const syncSessionTasks = useCallback(
    (incoming: readonly DaemonSessionScheduledTaskStatus[]) => {
      if (!owner.isCurrent()) return;
      setSessionScopedTasks([...incoming]);
      setHasLiveSessionSnapshot(true);
    },
    [owner],
  );

  const refresh = useCallback(() => {
    setManualRefreshTick((n) => n + 1);
  }, []);

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
      markBusy(entry.id, true);
      try {
        const updated = await workspaceActions.updateScheduledTask(
          entry.id,
          { enabled: !entry.enabled },
          entry.workspaceId ?? workspaceId,
        );
        if (!owner.isCurrent()) return;
        setDurableTasks((prev) =>
          prev.map((item) => (item.id === updated.id ? updated : item)),
        );
      } catch (error) {
        onError(error, t('scheduledTasks.error.toggleFailed'));
      } finally {
        markBusy(entry.id, false);
      }
    },
    [markBusy, onError, owner, t, workspaceActions, workspaceId],
  );

  const runDurableTask = useCallback(
    async (entry: SessionDurableScheduledTask) => {
      if (!workspaceActions?.runScheduledTask || manualRunActiveRef.current) {
        return;
      }
      // Same-session boundary admits one pending bound run. The ref closes
      // the rapid second-click window before React state renders.
      manualRunActiveRef.current = true;
      setManualRunActive(true);
      markBusy(entry.id, true);
      try {
        await runScheduledTaskManually(
          entry.task,
          workspaceActions,
          onRunPrompt,
          t,
          { reload: refresh, onError },
        );
      } finally {
        manualRunActiveRef.current = false;
        setManualRunActive(false);
        markBusy(entry.id, false);
      }
    },
    [markBusy, onError, onRunPrompt, refresh, t, workspaceActions],
  );

  const deleteDurableTask = useCallback(
    async (entry: SessionDurableScheduledTask) => {
      if (!workspaceActions?.deleteScheduledTask) return;
      markBusy(entry.id, true);
      try {
        await workspaceActions.deleteScheduledTask(
          entry.id,
          entry.workspaceId ?? workspaceId,
        );
        if (!owner.isCurrent()) return;
        setDurableTasks((prev) => prev.filter((item) => item.id !== entry.id));
      } catch (error) {
        onError(error, t('scheduledTasks.error.deleteFailed'));
      } finally {
        markBusy(entry.id, false);
      }
    },
    [markBusy, onError, owner, t, workspaceActions, workspaceId],
  );

  const cancelSessionTaskById = useCallback(
    async (taskId: string): Promise<boolean> => {
      markBusy(taskId, true);
      try {
        const result = await sessionActions.cancelTask(taskId, 'cron');
        if (result.cancelled && owner.isCurrent()) {
          setSessionScopedTasks((prev) =>
            prev.filter((item) => item.id !== taskId),
          );
        }
        if (!result.cancelled && owner.isCurrent()) {
          onError(
            new Error('The scheduled task was not cancelled'),
            t('scheduledTasks.error.toggleFailed'),
          );
        }
        return result.cancelled;
      } catch (error) {
        onError(error, t('scheduledTasks.error.toggleFailed'));
        return false;
      } finally {
        markBusy(taskId, false);
      }
    },
    [markBusy, onError, owner, sessionActions, t],
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

  const activeSessionCount = sessionScopedTasks.length;

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
