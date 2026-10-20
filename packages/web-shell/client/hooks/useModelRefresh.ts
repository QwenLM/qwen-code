import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  useActions,
  useConnection,
  useDaemonSessionOwnerGuard,
} from '@qwen-code/web-shell/daemon-react-sdk';
import type { DaemonSessionActions } from '@qwen-code/web-shell/daemon-react-sdk';
import { sessionContextKey } from '../daemon/session/session-context.js';

export function useModelRefresh(
  beforeRefresh?: Parameters<DaemonSessionActions['refreshModels']>[0],
) {
  const actions = useActions();
  const connection = useConnection();
  const ownerGuard = useDaemonSessionOwnerGuard();
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const pending = useRef(false);
  const generation = useRef(0);
  const contextKey = sessionContextKey(connection.sessionContext);
  useLayoutEffect(() => {
    generation.current += 1;
    pending.current = false;
    setRefreshing(false);
    setError(undefined);
    return () => {
      generation.current += 1;
    };
  }, [connection.sessionId, connection.workspaceCwd, contextKey]);
  const refresh = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    const request = ++generation.current;
    const owner = ownerGuard.capture();
    setRefreshing(true);
    setError(undefined);
    try {
      await actions.refreshModels(beforeRefresh);
    } catch (err) {
      if (request === generation.current && owner.isCurrent()) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (request === generation.current) {
        pending.current = false;
        setRefreshing(false);
      }
    }
  }, [actions, beforeRefresh, ownerGuard]);
  const available =
    connection.status === 'connected' &&
    (!connection.sessionContext ||
      connection.sessionContext.kind === 'workspace') &&
    connection.capabilities?.features.includes('workspace_model_reload');
  return useMemo(
    () => ({ refresh: available ? refresh : undefined, refreshing, error }),
    [available, refresh, refreshing, error],
  );
}
