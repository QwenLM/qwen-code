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
import { isSessionDisconnectedError } from '../utils/sessionErrors';

const SESSION_SCHEDULED_POLL_INTERVAL_MS = 5000;

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
  activityKey: string;
  refreshTrigger?: number;
}): SessionScheduledTasksResult {
  const {
    sessionId,
    workspaceId,
    connected,
    durableEnabled,
    activityKey,
    refreshTrigger = 0,
  } = options;
  const available = useDaemonAvailability() === 'available';
  const availability = useDaemonAvailabilityController();
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

  const durableReqRef = useRef(0);
  const sessionReqRef = useRef(0);
  const sessionFetchInFlightRef = useRef(false);

  useEffect(() => {
    durableReqRef.current += 1;
    sessionReqRef.current += 1;
    sessionFetchInFlightRef.current = false;
    setDurableTasks([]);
    setSessionScopedTasks([]);
    setHasLiveDurableSnapshot(false);
    setHasLiveSessionSnapshot(false);
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

  const fetchSessionScopedTasks = useCallback(() => {
    if (!available || !connected || !sessionId) return;
    if (availability && availability.getSnapshot() !== 'available') return;
    if (sessionFetchInFlightRef.current) return;
    const reqId = ++sessionReqRef.current;
    sessionFetchInFlightRef.current = true;
    void sessionActions
      .getTasks({ silent: true })
      .then((snapshot) => {
        if (
          reqId !== sessionReqRef.current ||
          !owner.isCurrent() ||
          snapshot.sessionId !== sessionId
        ) {
          return;
        }
        setSessionScopedTasks(snapshot.scheduledTasks ?? []);
        setHasLiveSessionSnapshot(true);
      })
      .catch((error: unknown) => {
        if (
          reqId !== sessionReqRef.current ||
          !owner.isCurrent() ||
          isDaemonUnavailableError(error) ||
          isSessionDisconnectedError(error)
        ) {
          return;
        }
        console.warn(
          '[web-shell] failed to refresh session cron tasks:',
          error,
        );
      })
      .finally(() => {
        if (reqId === sessionReqRef.current) {
          sessionFetchInFlightRef.current = false;
        }
      });
  }, [availability, available, connected, owner, sessionActions, sessionId]);

  useEffect(() => {
    fetchDurableTasks();
  }, [fetchDurableTasks, activityKey, refreshTrigger, manualRefreshTick]);

  useEffect(() => {
    fetchSessionScopedTasks();
  }, [fetchSessionScopedTasks, activityKey, refreshTrigger, manualRefreshTick]);

  // Keep polling lightly only while the session has active in-memory cron
  // jobs or pending loop wakeups so fires/expirations reflect promptly.
  const hasActiveSessionScoped = sessionScopedTasks.length > 0;
  useEffect(() => {
    if (!available || !connected || !sessionId || !hasActiveSessionScoped) {
      return;
    }
    const timer = setInterval(() => {
      fetchSessionScopedTasks();
    }, SESSION_SCHEDULED_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [
    available,
    connected,
    fetchSessionScopedTasks,
    hasActiveSessionScoped,
    sessionId,
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
      } finally {
        markBusy(entry.id, false);
      }
    },
    [markBusy, owner, workspaceActions, workspaceId],
  );

  const runDurableTask = useCallback(
    async (entry: SessionDurableScheduledTask) => {
      if (!workspaceActions?.runScheduledTask) return;
      markBusy(entry.id, true);
      try {
        await workspaceActions.runScheduledTask(
          entry.id,
          entry.workspaceId ?? workspaceId,
        );
        fetchDurableTasks();
      } finally {
        markBusy(entry.id, false);
      }
    },
    [fetchDurableTasks, markBusy, workspaceActions, workspaceId],
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
      } finally {
        markBusy(entry.id, false);
      }
    },
    [markBusy, owner, workspaceActions, workspaceId],
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
        return result.cancelled;
      } finally {
        markBusy(taskId, false);
      }
    },
    [markBusy, owner, sessionActions],
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
    syncSessionTasks,
    refresh,
    toggleDurableTask,
    runDurableTask,
    deleteDurableTask,
    cancelSessionTask,
    cancelSessionTaskById,
  };
}
