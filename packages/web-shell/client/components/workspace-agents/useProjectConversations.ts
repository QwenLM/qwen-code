import { useEffect, useMemo, useRef, useState } from 'react';
import { useWorkspace } from '@qwen-code/web-shell/daemon-react-sdk';
import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';
import { isAgentCollaborationEnabledForWorkspace } from '../../utils/workspace';
import { createThreadsHttpApi } from './threads-api';

export const COLLABORATION_SOURCE = 'workspace_collaboration';
/** Live streams the sidebar may hold; the chat needs connections too. */
const MAX_STREAMS = 2;
export function useProjectConversations(cwds: readonly string[]) {
  const workspace = useWorkspace();
  const key = JSON.stringify(
    [...new Set(cwds)]
      .filter((cwd) =>
        isAgentCollaborationEnabledForWorkspace(workspace.capabilities, cwd),
      )
      .sort(),
  );
  const enabled = key !== '[]';
  const [snapshot, setSnapshot] = useState<{
    scope: string;
    sessions: DaemonSessionSummary[];
    error?: string;
  }>();
  const cache = useRef<
    | {
        baseUrl: string;
        token: string | undefined;
        generation: number;
        sessionsByCwd: Map<string, DaemonSessionSummary[]>;
      }
    | undefined
  >(undefined);
  if (
    !cache.current ||
    cache.current.baseUrl !== workspace.baseUrl ||
    cache.current.token !== workspace.token
  ) {
    cache.current = {
      baseUrl: workspace.baseUrl,
      token: workspace.token,
      generation: (cache.current?.generation ?? 0) + 1,
      sessionsByCwd: new Map(),
    };
  }
  const scope = `${cache.current.generation}:${workspace.baseUrl}:${key}`;
  useEffect(() => {
    if (!enabled) return;
    const sessionsByCwd = cache.current!.sessionsByCwd;
    const disabled = new Set<string>();
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
          if (disabled.has(cwd)) return { sessions: [] };
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
            if (!disposed) sessionsByCwd.set(cwd, sessions);
            return { sessions };
          } catch (error) {
            if (
              error instanceof Error &&
              error.message === 'agent_collaboration_disabled'
            ) {
              disabled.add(cwd);
              return { sessions: [] };
            }
            return {
              sessions: sessionsByCwd.get(cwd) ?? [],
              // The project's name; the sidebar words the failure.
              error: cwd.split(/[\\/]/).at(-1),
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
    // Refetch when a workspace's store changes; poll only while a stream is down.
    // Each stream holds one of the browser's six HTTP/1.1 connections to the
    // daemon, so workspaces past the first few are polled instead. Streams
    // open after the first read, so none is held open against a workspace
    // that has collaboration off.
    let poll: ReturnType<typeof setInterval> | undefined;
    const stops: Array<() => void> = [];
    void refresh().then(() => {
      if (disposed) return;
      const cwds = (JSON.parse(key) as string[]).filter(
        (cwd) => !disabled.has(cwd),
      );
      const down = new Set(cwds.slice(MAX_STREAMS));
      if (down.size > 0) poll = setInterval(() => void refresh(), 5000);
      for (const cwd of cwds.slice(0, MAX_STREAMS)) {
        const api = createThreadsHttpApi(
          workspace.baseUrl,
          workspace.token,
          cwd,
        );
        const stop = api.subscribe!(
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
        );
        stops.push(stop);
      }
    });
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
