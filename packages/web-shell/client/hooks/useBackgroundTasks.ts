import { useEffect, useRef, useState } from 'react';
import type { DaemonSessionTaskStatus } from '@qwen-code/sdk/daemon';
import { useActions } from '@qwen-code/webui/daemon-react-sdk';
import { TASKS_STATUS_ACTIVE_EVENT } from '../components/messages/TasksStatusMessage';
import { isSessionDisconnectedError } from '../utils/sessionErrors';

const TASKS_POLL_INTERVAL_MS = 3000;
const MAX_EMPTY_TASK_POLLS = 2;

function hasActiveTask(tasks: readonly DaemonSessionTaskStatus[]): boolean {
  return tasks.some(
    (task) => task.status === 'running' || task.status === 'paused',
  );
}

export function useBackgroundTasks(
  sessionId: string | undefined,
  taskActivityKey: string,
  connected: boolean,
  refreshTrigger = 0,
): DaemonSessionTaskStatus[] {
  const actions = useActions();
  const [tasks, setTasks] = useState<DaemonSessionTaskStatus[]>([]);
  const [pollingActive, setPollingActive] = useState(false);
  const [tasksPanelActive, setTasksPanelActive] = useState(false);
  const emptyPollsRef = useRef(0);
  const tasksRefreshInFlightRef = useRef<{
    sessionId: string;
    request: object;
  } | null>(null);

  useEffect(() => {
    setTasks([]);
    setPollingActive(false);
    emptyPollsRef.current = 0;
  }, [connected, sessionId]);

  useEffect(() => {
    if (!connected || !sessionId || !taskActivityKey) return;
    emptyPollsRef.current = 0;
    setPollingActive(true);
  }, [connected, sessionId, taskActivityKey]);

  useEffect(() => {
    if (!connected || !sessionId || refreshTrigger === 0) return;
    emptyPollsRef.current = 0;
    setPollingActive(true);
  }, [connected, refreshTrigger, sessionId]);

  useEffect(() => {
    if (tasksPanelActive) return;
    if (!connected || !sessionId || !pollingActive) return;

    let disposed = false;
    const refresh = () => {
      if (tasksRefreshInFlightRef.current?.sessionId === sessionId) return;
      const request = {};
      tasksRefreshInFlightRef.current = { sessionId, request };
      actions
        .getTasks({ silent: true })
        .then((snapshot) => {
          if (disposed || snapshot.sessionId !== sessionId) return;
          setTasks(snapshot.tasks);
          if (snapshot.tasks.length === 0) {
            emptyPollsRef.current += 1;
            if (emptyPollsRef.current >= MAX_EMPTY_TASK_POLLS) {
              setPollingActive(false);
            }
            return;
          }
          emptyPollsRef.current = 0;
          if (!hasActiveTask(snapshot.tasks)) {
            setPollingActive(false);
          }
        })
        .catch((error: unknown) => {
          if (disposed) return;
          if (isSessionDisconnectedError(error)) {
            setPollingActive(false);
            return;
          }
          console.warn('[web-shell] failed to refresh tasks:', error);
        })
        .finally(() => {
          if (tasksRefreshInFlightRef.current?.request === request) {
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
  }, [actions, connected, pollingActive, sessionId, tasksPanelActive]);

  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;

  useEffect(() => {
    const onTasksPanelActive = (event: Event) => {
      const detail = (event as CustomEvent<{ active?: boolean }>).detail;
      const active = detail?.active === true;
      setTasksPanelActive(active);
      if (!active && hasActiveTask(tasksRef.current)) {
        setPollingActive(true);
      }
    };
    window.addEventListener(TASKS_STATUS_ACTIVE_EVENT, onTasksPanelActive);
    return () =>
      window.removeEventListener(TASKS_STATUS_ACTIVE_EVENT, onTasksPanelActive);
  }, []);

  return tasks;
}
