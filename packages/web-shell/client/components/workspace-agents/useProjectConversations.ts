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
    const refresh = async () => {
      if (busy) return;
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
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      disposed = true;
      clearInterval(timer);
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
