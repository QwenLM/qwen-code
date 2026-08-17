import { useEffect, useMemo, useState } from 'react';
import type {
  DaemonClient,
  DaemonSessionCatalogVersion,
  DaemonSessionGroupCatalog,
  DaemonWorkspaceSessionLiveState,
} from '@qwen-code/sdk/daemon';
import {
  getSessionCatalogStore,
  type StagedWorkspaceSessionCatalog,
} from './session-catalog-store';

export const SESSION_LIVE_STATE_POLL_MS = 2_000;
export const SESSION_LIVE_STATE_ERROR_RETRY_MS = 30_000;
export const SESSION_LIVE_STATE_RECONCILE_COOLDOWN_MS = 10_000;

interface WorkspacePollState {
  workspaceCwd: string;
  acceptedVersion?: DaemonSessionCatalogVersion;
  inFlight: boolean;
  liveRetryAt: number;
  reconcileRetryAt: number;
  lastReconcileAt: number;
  fallbackAttempted: boolean;
  reconcileRequested: boolean;
}

interface WorkspaceSessionLiveStateOptions {
  enabled: boolean;
  workspaceCwds: readonly string[];
  groupWorkspaceCwds: readonly string[];
}

function versionsEqual(
  left: DaemonSessionCatalogVersion | undefined,
  right: DaemonSessionCatalogVersion,
): boolean {
  return (
    left?.generation === right.generation && left.revision === right.revision
  );
}

export function useWorkspaceSessionLiveState(
  client: DaemonClient,
  {
    enabled,
    workspaceCwds,
    groupWorkspaceCwds,
  }: WorkspaceSessionLiveStateOptions,
): ReadonlyMap<string, DaemonSessionGroupCatalog> {
  const catalogStore = useMemo(() => getSessionCatalogStore(client), [client]);
  const targetsKey = JSON.stringify([...new Set(workspaceCwds)].sort());
  const targets = useMemo(
    () => JSON.parse(targetsKey) as string[],
    [targetsKey],
  );
  const groupTargetsKey = JSON.stringify(
    [...new Set(groupWorkspaceCwds)].sort(),
  );
  const groupTargets = useMemo(
    () => new Set(JSON.parse(groupTargetsKey) as string[]),
    [groupTargetsKey],
  );
  const [groupCatalogs, setGroupCatalogs] = useState<
    ReadonlyMap<string, DaemonSessionGroupCatalog>
  >(() => new Map());

  useEffect(() => {
    const activeTargets = new Set(targets);
    setGroupCatalogs((current) => {
      if (!enabled) {
        return current.size === 0 ? current : new Map();
      }
      if (
        [...current.keys()].every(
          (cwd) => activeTargets.has(cwd) && groupTargets.has(cwd),
        )
      ) {
        return current;
      }
      const next = new Map<string, DaemonSessionGroupCatalog>();
      for (const [cwd, catalog] of current) {
        if (activeTargets.has(cwd) && groupTargets.has(cwd)) {
          next.set(cwd, catalog);
        }
      }
      return next;
    });
  }, [enabled, groupTargets, targets]);

  useEffect(() => {
    if (!enabled || targets.length === 0) return;
    let disposed = false;
    const releaseLiveState = targets.map((workspaceCwd) =>
      catalogStore.retainWorkspaceLiveState(workspaceCwd),
    );
    const states = targets.map<WorkspacePollState>((workspaceCwd) => ({
      workspaceCwd,
      inFlight: false,
      liveRetryAt: 0,
      reconcileRetryAt: 0,
      lastReconcileAt: Number.NEGATIVE_INFINITY,
      fallbackAttempted: false,
      reconcileRequested: false,
    }));

    const publishGroups = (
      workspaceCwd: string,
      catalog: DaemonSessionGroupCatalog | undefined,
    ) => {
      if (!catalog || disposed) return;
      setGroupCatalogs((current) => {
        if (current.get(workspaceCwd) === catalog) return current;
        const next = new Map(current);
        next.set(workspaceCwd, catalog);
        return next;
      });
    };

    const readLiveState = async (
      workspaceCwd: string,
    ): Promise<DaemonWorkspaceSessionLiveState> => {
      return await client.getWorkspaceSessionLiveState(workspaceCwd);
    };

    const stageCatalogBundle = async (
      state: WorkspacePollState,
    ): Promise<
      [StagedWorkspaceSessionCatalog, DaemonSessionGroupCatalog | undefined]
    > => {
      const groupRequest = groupTargets.has(state.workspaceCwd)
        ? client.workspaceByCwd(state.workspaceCwd).listSessionGroups()
        : Promise.resolve(undefined);
      return await Promise.all([
        catalogStore.stageWorkspaceRefresh(state.workspaceCwd),
        groupRequest,
      ]);
    };

    const loadFallbackBundle = async (
      state: WorkspacePollState,
    ): Promise<void> => {
      const [stagedCatalog, groups] = await stageCatalogBundle(state);
      if (disposed || !catalogStore.commitWorkspaceRefresh(stagedCatalog)) {
        return;
      }
      publishGroups(state.workspaceCwd, groups);
    };

    const reconcile = async (
      state: WorkspacePollState,
      liveA: DaemonWorkspaceSessionLiveState,
      allowTrailing: boolean,
    ): Promise<void> => {
      state.reconcileRequested =
        state.reconcileRequested ||
        catalogStore.consumeWorkspaceLiveStateRefreshRequest(
          state.workspaceCwd,
        );
      state.lastReconcileAt = Date.now();
      const [stagedCatalog, groups] = await stageCatalogBundle(state);
      if (disposed) return;
      const liveB = await readLiveState(state.workspaceCwd);
      if (disposed) return;
      catalogStore.applyLiveState(state.workspaceCwd, liveB.sessions);
      if (versionsEqual(liveA.catalogVersion, liveB.catalogVersion)) {
        if (!catalogStore.commitWorkspaceRefresh(stagedCatalog)) {
          if (allowTrailing) await reconcile(state, liveB, false);
          return;
        }
        catalogStore.applyLiveState(state.workspaceCwd, liveB.sessions);
        state.acceptedVersion = liveB.catalogVersion;
        state.reconcileRequested = false;
        publishGroups(state.workspaceCwd, groups);
        return;
      }
      if (allowTrailing) await reconcile(state, liveB, false);
      else state.reconcileRequested = false;
    };

    const poll = async (state: WorkspacePollState): Promise<void> => {
      if (
        disposed ||
        state.inFlight ||
        Date.now() < state.liveRetryAt ||
        (typeof document !== 'undefined' && document.hidden)
      ) {
        return;
      }
      state.inFlight = true;
      let live: DaemonWorkspaceSessionLiveState;
      try {
        live = await readLiveState(state.workspaceCwd);
      } catch (error) {
        if (disposed) return;
        state.liveRetryAt = Date.now() + SESSION_LIVE_STATE_ERROR_RETRY_MS;
        console.warn('[session-live-state] request failed:', error);
        if (!state.acceptedVersion && !state.fallbackAttempted) {
          state.fallbackAttempted = true;
          try {
            await loadFallbackBundle(state);
          } catch (fallbackError) {
            if (!disposed) {
              console.warn(
                '[session-live-state] initial catalog fallback failed:',
                fallbackError,
              );
            }
          }
        }
        state.inFlight = false;
        return;
      }
      if (disposed) {
        state.inFlight = false;
        return;
      }
      catalogStore.applyLiveState(state.workspaceCwd, live.sessions);
      state.liveRetryAt = 0;
      state.reconcileRequested =
        state.reconcileRequested ||
        catalogStore.consumeWorkspaceLiveStateRefreshRequest(
          state.workspaceCwd,
        );
      if (
        !state.reconcileRequested &&
        versionsEqual(state.acceptedVersion, live.catalogVersion)
      ) {
        state.inFlight = false;
        return;
      }
      if (
        Date.now() < state.reconcileRetryAt ||
        (!state.reconcileRequested &&
          Date.now() - state.lastReconcileAt <
            SESSION_LIVE_STATE_RECONCILE_COOLDOWN_MS)
      ) {
        state.inFlight = false;
        return;
      }
      try {
        await reconcile(state, live, true);
        state.reconcileRetryAt = 0;
      } catch (error) {
        if (!disposed) {
          state.reconcileRetryAt =
            Date.now() + SESSION_LIVE_STATE_ERROR_RETRY_MS;
          console.warn('[session-live-state] reconciliation failed:', error);
        }
      } finally {
        state.inFlight = false;
      }
    };

    for (const state of states) void poll(state);
    const interval = window.setInterval(() => {
      for (const state of states) void poll(state);
    }, SESSION_LIVE_STATE_POLL_MS);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      for (const release of releaseLiveState) release();
    };
  }, [catalogStore, client, enabled, groupTargets, targets]);

  return groupCatalogs;
}
