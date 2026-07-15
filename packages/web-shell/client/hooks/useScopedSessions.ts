import { useCallback, useEffect, useRef, useState } from 'react';
import { useSessions, useWorkspace } from '@qwen-code/webui/daemon-react-sdk';
import type {
  DaemonSessionArchiveState,
  DaemonSessionSummary,
} from '@qwen-code/sdk/daemon';

interface ScopedSessionsOptions {
  autoLoad?: boolean;
  enabled?: boolean;
  pageSize?: number;
  archiveState?: DaemonSessionArchiveState;
  view?: 'organized';
  group?: string;
}

interface ScopedState {
  cwd?: string;
  sessions: DaemonSessionSummary[];
  loading: boolean;
  error?: Error;
}

export function useScopedSessions(
  workspaceCwd: string | undefined,
  options: ScopedSessionsOptions = {},
) {
  const {
    autoLoad = false,
    enabled = true,
    pageSize,
    archiveState,
    view,
    group,
  } = options;
  const primary = useSessions({
    autoLoad,
    enabled: enabled && !workspaceCwd,
    pageSize,
    archiveState,
    view,
    group,
  });
  const {
    reload: reloadPrimary,
    deleteSession: deletePrimarySession,
    deleteSessions: deletePrimarySessions,
  } = primary;
  const workspace = useWorkspace();
  const requestSequence = useRef(0);
  const [scoped, setScoped] = useState<ScopedState>({
    sessions: [],
    loading: false,
  });

  const reloadScoped = useCallback(async () => {
    if (!workspaceCwd || !enabled) return [];
    const sequence = ++requestSequence.current;
    setScoped((current) => ({
      cwd: workspaceCwd,
      sessions: current.cwd === workspaceCwd ? current.sessions : [],
      loading: true,
    }));
    try {
      const sessions = await workspace.client
        .workspaceByCwd(workspaceCwd)
        .listWorkspaceSessions({ pageSize, archiveState, view, group });
      const scopedSessions = sessions.map((session) => ({
        ...session,
        workspaceCwd,
      }));
      if (requestSequence.current === sequence) {
        setScoped({
          cwd: workspaceCwd,
          sessions: scopedSessions,
          loading: false,
        });
      }
      return scopedSessions;
    } catch (error) {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      if (requestSequence.current === sequence) {
        setScoped({
          cwd: workspaceCwd,
          sessions: [],
          loading: false,
          error: normalized,
        });
      }
      throw normalized;
    }
  }, [
    archiveState,
    enabled,
    group,
    pageSize,
    view,
    workspace.client,
    workspaceCwd,
  ]);

  useEffect(() => {
    if (!workspaceCwd) return;
    requestSequence.current += 1;
    setScoped({
      cwd: workspaceCwd,
      sessions: [],
      loading: autoLoad && enabled,
    });
    if (autoLoad && enabled) void reloadScoped().catch(() => undefined);
    return () => {
      requestSequence.current += 1;
    };
  }, [autoLoad, enabled, reloadScoped, workspaceCwd]);

  const reload = useCallback(
    () => (workspaceCwd ? reloadScoped() : reloadPrimary()),
    [reloadPrimary, reloadScoped, workspaceCwd],
  );
  const deleteSessions = useCallback(
    async (sessionIds: string[]) => {
      if (!workspaceCwd) return deletePrimarySessions(sessionIds);
      const result = await workspace.client
        .workspaceByCwd(workspaceCwd)
        .deleteSessionsData(sessionIds);
      await reloadScoped();
      return result;
    },
    [deletePrimarySessions, reloadScoped, workspace.client, workspaceCwd],
  );
  const deleteSession = useCallback(
    async (sessionId: string) => {
      if (!workspaceCwd) return deletePrimarySession(sessionId);
      const result = await deleteSessions([sessionId]);
      if (result.errors.length > 0) {
        throw new Error(result.errors[0]!.error);
      }
      return result.removed.length > 0 || result.notFound.length > 0;
    },
    [deletePrimarySession, deleteSessions, workspaceCwd],
  );

  if (!workspaceCwd) return primary;
  const current = scoped.cwd === workspaceCwd ? scoped : undefined;
  return {
    sessions: current?.sessions ?? [],
    loading: current?.loading ?? (autoLoad && enabled),
    error: current?.error,
    reload,
    deleteSession,
    deleteSessions,
    releaseSession: primary.releaseSession,
  };
}
