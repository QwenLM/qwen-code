import { useEffect, useMemo, useRef, useState } from 'react';
import { useWorkspace } from '@qwen-code/web-shell/daemon-react-sdk';
import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';
import { createThreadsHttpApi } from './ThreadsRoute';

export const COLLABORATION_SOURCE = 'workspace_collaboration';
export function useProjectConversations(cwds: readonly string[]) {
  const workspace = useWorkspace();
  const key = JSON.stringify([...new Set(cwds)].sort());
  const enabled = workspace.capabilities?.features?.includes(
    'agent_collaboration_v1',
  );
  const [snapshot, setSnapshot] = useState<{
    scope: string;
    sessions: DaemonSessionSummary[];
    error?: string;
  }>();
  const sessionsByCwd = useRef(new Map<string, DaemonSessionSummary[]>());
  const scope = `${workspace.baseUrl}:${key}`;
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let busy = false;
    let again = false;
    const refresh = async (): Promise<void> => {
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      const results = await Promise.all(
        (JSON.parse(key) as string[]).map(async (cwd) => {
          try {
            const { threads } = await createThreadsHttpApi(
              workspace.baseUrl,
              workspace.token,
              cwd,
            ).listThreads();
            const sessions = threads
              .filter((t) => !t.parentThreadId)
              .map((t) => ({
                sessionId: `collaboration:${t.id}`,
                sourceId: t.id,
                sourceType: COLLABORATION_SOURCE,
                workspaceCwd: cwd,
                displayName: t.title,
                createdAt: new Date(t.updatedAt).toISOString(),
                updatedAt: new Date(t.updatedAt).toISOString(),
                hasActivePrompt: t.liveRunCount > 0,
              }));
            sessionsByCwd.current.set(cwd, sessions);
            return { sessions };
          } catch {
            return {
              sessions: sessionsByCwd.current.get(cwd) ?? [],
              error: `无法加载项目对话：${cwd.split(/[\\/]/).at(-1)}`,
            };
          }
        }),
      );
      if (!disposed)
        setSnapshot({
          scope,
          sessions: results.flatMap((r) => r.sessions),
          error: results.find((r) => r.error)?.error,
        });
      busy = false;
      if (again && !disposed) {
        again = false;
        void refresh();
      }
    };
    void refresh();
    // Refetch when a workspace's store changes; poll only while a stream is down.
    const down = new Set<string>();
    let poll: ReturnType<typeof setInterval> | undefined;
    const stops = (JSON.parse(key) as string[]).map((cwd) =>
      createThreadsHttpApi(workspace.baseUrl, workspace.token, cwd).subscribe!(
        (event) => {
          if (event.type === 'changed') void refresh();
        },
        (state) => {
          if (state === 'closed') down.add(cwd);
          else down.delete(cwd);
          if (down.size > 0) {
            poll ??= setInterval(() => void refresh(), 5000);
          } else {
            clearInterval(poll);
            poll = undefined;
          }
        },
      ),
    );
    return () => {
      disposed = true;
      for (const stop of stops) stop();
      clearInterval(poll);
    };
  }, [enabled, key, scope, workspace.baseUrl, workspace.token]);
  return useMemo(
    () =>
      enabled && snapshot?.scope === scope
        ? snapshot
        : { sessions: [], error: undefined },
    [enabled, snapshot, scope],
  );
}
