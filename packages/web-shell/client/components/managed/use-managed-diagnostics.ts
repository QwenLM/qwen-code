import { useEffect, useMemo, useState } from 'react';
import type {
  ManagedDiagnosticAgentTrace,
  ManagedDiagnosticContextUsage,
  ManagedDiagnosticResources,
  ManagedDiagnosticStats,
  ManagedDiagnosticsProvider,
} from './managed-agent-provider';

export type ManagedDiagnosticsTab =
  | 'context'
  | 'statistics'
  | 'resources'
  | 'agents';
export type ManagedDiagnosticsSnapshot =
  | { kind: 'context'; value: ManagedDiagnosticContextUsage }
  | { kind: 'statistics'; value: ManagedDiagnosticStats }
  | { kind: 'resources'; value: ManagedDiagnosticResources }
  | { kind: 'agents'; value: ManagedDiagnosticAgentTrace };

export function useManagedDiagnostics({
  provider,
  sessionId,
  clientId,
  tab,
  running,
  revision,
  enabled = true,
}: {
  provider: ManagedDiagnosticsProvider;
  sessionId: string;
  clientId: string;
  tab: ManagedDiagnosticsTab;
  running: boolean;
  revision?: string;
  enabled?: boolean;
}) {
  const owner = useMemo(
    () => ({ provider, sessionId, clientId, tab }),
    [provider, sessionId, clientId, tab],
  );
  const [frame, setFrame] = useState<{
    owner: object;
    snapshot?: ManagedDiagnosticsSnapshot;
    loading: boolean;
    error: boolean;
  }>();
  const [paging, setPaging] = useState<{
    owner: object;
    cursors: Array<string | undefined>;
  }>();
  const [refreshRevision, setRefreshRevision] = useState(0);
  const cursors = paging?.owner === owner ? paging.cursors : [undefined];
  const cursor = cursors.at(-1);
  const current = frame?.owner === owner ? frame : undefined;

  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    let inFlight = false;
    const read = async (): Promise<ManagedDiagnosticsSnapshot> => {
      const options = { clientId, signal: abort.signal };
      switch (tab) {
        case 'context':
          return {
            kind: tab,
            value: await provider.getContextUsage(sessionId, options),
          };
        case 'statistics':
          return {
            kind: tab,
            value: await provider.getStatistics(sessionId, options),
          };
        case 'resources':
          return {
            kind: tab,
            value: await provider.getResources(sessionId, options),
          };
        case 'agents':
          return {
            kind: tab,
            value: await provider.listAgentTrace(sessionId, {
              ...options,
              cursor,
              limit: 20,
            }),
          };
      }
    };
    const refresh = async () => {
      if (abort.signal.aborted || inFlight) return;
      inFlight = true;
      setFrame((previous) => ({
        owner,
        snapshot: previous?.owner === owner ? previous.snapshot : undefined,
        loading: true,
        error: false,
      }));
      try {
        const snapshot = await read();
        if (abort.signal.aborted) return;
        if (
          snapshot.value.sessionId !== sessionId ||
          snapshot.value.schemaVersion !== 1
        ) {
          throw new Error('Managed diagnostics identity mismatch');
        }
        setFrame({ owner, snapshot, loading: false, error: false });
      } catch {
        if (!abort.signal.aborted) {
          setFrame({ owner, loading: false, error: true });
        }
      } finally {
        inFlight = false;
      }
    };
    const visibleRefresh = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    void refresh();
    const polling = running && (tab === 'statistics' || tab === 'agents');
    const timer = polling
      ? window.setInterval(visibleRefresh, 5_000)
      : undefined;
    document.addEventListener('visibilitychange', visibleRefresh);
    return () => {
      abort.abort();
      if (timer !== undefined) window.clearInterval(timer);
      document.removeEventListener('visibilitychange', visibleRefresh);
    };
  }, [
    provider,
    sessionId,
    clientId,
    tab,
    owner,
    cursor,
    running,
    revision,
    refreshRevision,
    enabled,
  ]);

  return {
    snapshot: current?.snapshot,
    loading: enabled && (current?.loading ?? true),
    error: enabled && (current?.error ?? false),
    refresh: () => setRefreshRevision((value) => value + 1),
    hasPrevious: cursors.length > 1,
    previous: () => setPaging({ owner, cursors: cursors.slice(0, -1) }),
    next: () => {
      const snapshot = current?.snapshot;
      if (snapshot?.kind === 'agents' && snapshot.value.nextCursor) {
        setPaging({ owner, cursors: [...cursors, snapshot.value.nextCursor] });
      }
    },
  };
}
