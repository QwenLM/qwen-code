import { useEffect, useRef, useState } from 'react';
import type { DaemonSessionTaskWithWorkflowStatus } from '@qwen-code/sdk/daemon';
import {
  useActions,
  useDaemonSessionOwnerGuard,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { TASKS_STATUS_ACTIVE_EVENT } from '../components/messages/TasksStatusMessage';
import { isSessionDisconnectedError } from '../utils/sessionErrors';

const TASKS_POLL_INTERVAL_MS = 3000;
const MAX_EMPTY_TASK_POLLS = 2;

function hasActiveTask(
  tasks: readonly DaemonSessionTaskWithWorkflowStatus[],
): boolean {
  return tasks.some(
    (task) =>
      task.status === 'running' ||
      task.status === 'pausing' ||
      task.status === 'paused',
  );
}

export function useBackgroundTasks(
  sessionId: string | undefined,
  taskActivityKey: string,
  /**
   * Whether any background task tool call is still running. Passed in as a
   * fact rather than re-parsed out of `taskActivityKey`, whose rendering is
   * not injective (callId is unconstrained text).
   */
  taskActivityActive: boolean,
  connected: boolean,
  refreshTrigger = 0,
  workflowsEnabled = false,
): DaemonSessionTaskWithWorkflowStatus[] {
  const actions = useActions();
  const ownerGuard = useDaemonSessionOwnerGuard();
  const ownerRef = useRef(ownerGuard.capture());
  if (!ownerRef.current?.isCurrent()) ownerRef.current = ownerGuard.capture();
  const owner = ownerRef.current;
  const [tasks, setTasks] = useState<DaemonSessionTaskWithWorkflowStatus[]>([]);
  const tasksOwnerRef = useRef(owner);
  const [pollingActive, setPollingActive] = useState(false);
  const [tasksPanelActive, setTasksPanelActive] = useState(false);
  const emptyPollsRef = useRef(0);
  const tasksRefreshInFlightRef = useRef<typeof owner | null>(null);

  useEffect(() => {
    tasksOwnerRef.current = owner;
    setTasks([]);
    setPollingActive(false);
    emptyPollsRef.current = 0;
    // The pause latch belongs to the session it was raised for. Split view
    // keeps the previous session's pane mounted, so switching primary never
    // fires the panel's `active: false` — and when that pane's panel does
    // close, its event carries the OLD sessionId and is filtered out here.
    // Without this reset the new session's polling would stay blocked for
    // good: the guard below outranks every refreshTrigger bump.
    setTasksPanelActive(false);
  }, [connected, owner, sessionId]);

  useEffect(() => {
    if (!connected || !sessionId || (!taskActivityKey && refreshTrigger === 0))
      return;
    emptyPollsRef.current = 0;
    setPollingActive(true);
  }, [connected, owner, refreshTrigger, sessionId, taskActivityKey]);

  useEffect(() => {
    if (tasksPanelActive) return;
    if (!connected || !sessionId || !pollingActive) return;

    let disposed = false;
    const refresh = () => {
      if (tasksRefreshInFlightRef.current === owner) return;
      tasksRefreshInFlightRef.current = owner;
      const request = workflowsEnabled
        ? actions.getWorkflowTasks({ silent: true })
        : actions.getTasks({ silent: true });
      request
        .then((snapshot) => {
          if (
            disposed ||
            !owner.isCurrent() ||
            snapshot.sessionId !== sessionId
          )
            return;
          setTasks(snapshot.tasks);
          if (snapshot.tasks.length === 0) {
            if (taskActivityActive) return;
            emptyPollsRef.current += 1;
            if (emptyPollsRef.current >= MAX_EMPTY_TASK_POLLS) {
              setPollingActive(false);
            }
            return;
          }
          emptyPollsRef.current = 0;
          if (!hasActiveTask(snapshot.tasks) && !taskActivityActive) {
            setPollingActive(false);
          }
        })
        .catch((error: unknown) => {
          if (disposed || !owner.isCurrent()) return;
          if (isSessionDisconnectedError(error)) {
            setPollingActive(false);
            return;
          }
          console.warn('[web-shell] failed to refresh tasks:', error);
        })
        .finally(() => {
          if (tasksRefreshInFlightRef.current === owner) {
            tasksRefreshInFlightRef.current = null;
          }
        });
    };

    refresh();
    const id = setInterval(refresh, TASKS_POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      clearInterval(id);
    };
  }, [
    actions,
    connected,
    owner,
    pollingActive,
    sessionId,
    taskActivityActive,
    taskActivityKey,
    tasksPanelActive,
    workflowsEnabled,
  ]);

  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;

  useEffect(() => {
    const onTasksPanelActive = (event: Event) => {
      const detail = (
        event as CustomEvent<{ active?: boolean; sessionId?: string }>
      ).detail;
      if (detail?.sessionId !== sessionId) return;
      const active = detail?.active === true;
      setTasksPanelActive(active);
      if (!active && hasActiveTask(tasksRef.current)) {
        setPollingActive(true);
      }
    };
    window.addEventListener(TASKS_STATUS_ACTIVE_EVENT, onTasksPanelActive);
    return () =>
      window.removeEventListener(TASKS_STATUS_ACTIVE_EVENT, onTasksPanelActive);
  }, [sessionId]);

  return tasksOwnerRef.current === owner ? tasks : [];
}
