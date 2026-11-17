import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useActions,
  useConnection,
  useDaemonSessionOwnerGuard,
  useWorkspaceEventSignals,
} from '@qwen-code/web-shell/daemon-react-sdk';
import type {
  SessionSourceInput,
  SessionSourcesResult,
} from '@qwen-code/sdk/daemon';

export function useSessionSources() {
  const actions = useActions();
  const connection = useConnection();
  const guard = useDaemonSessionOwnerGuard();
  const ownerRef = useRef(guard.capture());
  if (!ownerRef.current.isCurrent()) ownerRef.current = guard.capture();
  const owner = ownerRef.current;
  const signals = useWorkspaceEventSignals();
  const supported =
    connection.capabilities?.features.includes('session_sources') === true;
  const enabled =
    supported &&
    connection.status === 'connected' &&
    Boolean(connection.sessionId) &&
    !connection.catchingUp;
  const [state, setState] = useState<
    SessionSourcesResult & {
      owner: typeof owner;
      loading: boolean;
      error: string | null;
      hydrated: boolean;
    }
  >({
    owner,
    revision: -1,
    sources: [],
    loading: enabled,
    error: null,
    hydrated: false,
  });
  const request = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const id = ++request.current;
    setState((previous) => ({
      ...(previous.owner === owner
        ? previous
        : { owner, revision: -1, sources: [], hydrated: false }),
      loading: true,
      error: null,
    }));
    try {
      const result = await actions.listSources();
      if (request.current !== id || !owner.isCurrent()) return;
      setState((previous) => ({
        ...(previous.owner === owner && previous.revision > result.revision
          ? previous
          : { ...result, owner }),
        loading: false,
        error: null,
        hydrated: true,
      }));
    } catch (error) {
      if (request.current !== id || !owner.isCurrent()) return;
      setState((previous) => ({
        ...previous,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [actions, enabled, owner]);

  useEffect(() => {
    void refresh();
    return () => {
      request.current += 1;
    };
  }, [refresh, signals?.sourcesVersion]);

  const upsert = useCallback(
    async (input: SessionSourceInput) => {
      if (!owner.isCurrent())
        throw new Error('Session source owner is no longer available');
      const result = await actions.upsertSource(input);
      if (!owner.isCurrent()) return;
      setState((previous) =>
        previous.owner !== owner || previous.revision > result.revision
          ? previous
          : {
              ...previous,
              revision: result.revision,
              sources: [
                result.source,
                ...previous.sources.filter(
                  (source) => source.id !== result.source.id,
                ),
              ].sort(
                (a, b) =>
                  b.createdAt.localeCompare(a.createdAt) ||
                  a.id.localeCompare(b.id),
              ),
              hydrated: true,
            },
      );
      await refresh();
      return result;
    },
    [actions, owner, refresh],
  );
  const remove = useCallback(
    async (id: string) => {
      if (!owner.isCurrent())
        throw new Error('Session source owner is no longer available');
      const result = await actions.removeSource(id);
      if (!owner.isCurrent()) return;
      setState((previous) =>
        previous.owner !== owner || previous.revision > result.revision
          ? previous
          : {
              ...previous,
              revision: result.revision,
              sources: previous.sources.filter((source) => source.id !== id),
            },
      );
      await refresh();
    },
    [actions, owner, refresh],
  );
  const current =
    state.owner === owner && owner.isCurrent() ? state : undefined;
  return {
    supported,
    sources: current?.sources ?? [],
    revision: current?.revision ?? -1,
    hydrated: current?.hydrated ?? false,
    loading: enabled && (current?.loading ?? true),
    error: current?.error ?? null,
    refresh,
    upsert,
    remove,
    owner,
  };
}
