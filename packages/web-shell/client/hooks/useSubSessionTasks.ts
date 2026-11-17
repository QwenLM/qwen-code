import { useEffect, useRef, useState } from 'react';
import type { DaemonSessionSubSessionTaskStatus } from '@qwen-code/sdk/daemon';
import {
  useActions,
  useDaemonSessionOwnerGuard,
  useWorkspaceEventSignals,
} from '@qwen-code/web-shell/daemon-react-sdk';

// The daemon pushes a change event; this only backs it up if one is missed.
const RUNNING_POLL_INTERVAL_MS = 10_000;

/**
 * The sends this session made that the daemon reports back to it (a
 * person's `/send`, or the model's `create_sub_session` in `sent` mode).
 * Re-read when the daemon says one started or settled, when `refreshKey`
 * changes, and slowly while one is still running.
 */
export function useSubSessionTasks(
  sessionId: string | undefined,
  enabled: boolean,
  refreshKey = 0,
): DaemonSessionSubSessionTaskStatus[] {
  const actions = useActions();
  const ownerGuard = useDaemonSessionOwnerGuard();
  const ownerRef = useRef(ownerGuard.capture());
  if (!ownerRef.current?.isCurrent()) ownerRef.current = ownerGuard.capture();
  const owner = ownerRef.current;
  const signals = useWorkspaceEventSignals();
  const version = sessionId
    ? (signals?.subSessionTaskVersions?.[sessionId] ?? 0)
    : 0;
  const [tasks, setTasks] = useState<DaemonSessionSubSessionTaskStatus[]>([]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setTasks([]);
  }, [owner, sessionId]);

  useEffect(() => {
    if (!enabled || !sessionId) return;
    let disposed = false;
    actions
      .getTasks({ silent: true, includeSubSessions: true })
      .then((snapshot) => {
        if (disposed || !owner.isCurrent() || snapshot.sessionId !== sessionId)
          return;
        setTasks(snapshot.subSessions ?? []);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [actions, enabled, owner, refreshKey, sessionId, tick, version]);

  const running = tasks.some((task) => task.status === 'running');
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(
      () => setTick((value) => value + 1),
      RUNNING_POLL_INTERVAL_MS,
    );
    return () => clearInterval(timer);
  }, [running]);

  return tasks;
}
