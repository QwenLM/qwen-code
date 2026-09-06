import { useEffect, useMemo, useRef, useState } from 'react';
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
/**
 * Consecutive live-state request failures before the retained snapshot is
 * dropped as no longer current. Failures are spaced by
 * `SESSION_LIVE_STATE_ERROR_RETRY_MS`, so this is a ~minute of a channel that
 * cannot answer — long enough to ride out a daemon restart, short enough that
 * a pane held loading by this authority is released while the turn is still
 * interesting (#9487).
 */
export const SESSION_LIVE_STATE_STALE_AFTER_FAILURES = 3;
export const SESSION_LIVE_STATE_RECONCILE_COOLDOWN_MS = 10_000;

interface WorkspacePollState {
  workspaceCwd: string;
  acceptedVersion?: DaemonSessionCatalogVersion;
  inFlight: boolean;
  liveRetryAt: number;
  reconcileRetryAt: number;
  lastReconcileAt: number;
  fallbackAttempted: boolean;
  interactiveRefreshRequested: boolean;
  reconcileRequested: boolean;
  invalidationRequested: boolean;
  invalidationReconcileAt: number;
}

interface WorkspaceSessionLiveStateOptions {
  enabled: boolean;
  workspaceCwds: readonly string[];
  groupWorkspaceCwds: readonly string[];
}

function versionsEqual(
  left: DaemonSessionCatalogVersion | undefined,
  right: DaemonSessionCatalogVersion | undefined,
): boolean {
  return (
    left?.generation === right?.generation && left?.revision === right?.revision
  );
}

function groupCatalogsEqual(
  left: DaemonSessionGroupCatalog,
  right: DaemonSessionGroupCatalog,
): boolean {
  if (left.groups.length !== right.groups.length) return false;
  if (left.colorOptions.length !== right.colorOptions.length) return false;
  const rightById = new Map(right.groups.map((group) => [group.id, group]));
  for (const group of left.groups) {
    const other = rightById.get(group.id);
    if (
      !other ||
      other.name !== group.name ||
      other.color !== group.color ||
      other.order !== group.order
    ) {
      return false;
    }
  }
  return left.colorOptions.every(
    (color, index) => color === right.colorOptions[index],
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
  const targetsKey = [...new Set(workspaceCwds)].sort().join('\n');
  const targets = useMemo(
    () => targetsKey.split('\n').filter(Boolean),
    [targetsKey],
  );
  const groupTargetsKey = [...new Set(groupWorkspaceCwds)].sort().join('\n');
  const groupTargets = useMemo(
    () => new Set(groupTargetsKey.split('\n').filter(Boolean)),
    [groupTargetsKey],
  );
  const groupTargetsRef = useRef(groupTargets);
  useEffect(() => {
    groupTargetsRef.current = groupTargets;
  }, [groupTargets]);
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
    // Group-membership growth (e.g. toggling the session source back to
    // Tasks) must fetch groups for newly covered workspaces; the polling
    // loop below intentionally does not restart on groupTargets changes.
    if (!enabled) return;
    for (const cwd of groupTargets) {
      if (activeTargets.has(cwd)) {
        catalogStore.requestWorkspaceLiveStateRefresh(cwd);
      }
    }
  }, [catalogStore, enabled, groupTargets, targets]);

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
      interactiveRefreshRequested: false,
      reconcileRequested: false,
      invalidationRequested: false,
      invalidationReconcileAt: Number.NEGATIVE_INFINITY,
    }));

    const publishGroups = (
      workspaceCwd: string,
      catalog: DaemonSessionGroupCatalog | undefined,
    ) => {
      if (!catalog || disposed) return;
      setGroupCatalogs((current) => {
        const previous = current.get(workspaceCwd);
        if (previous && groupCatalogsEqual(previous, catalog)) {
          return current;
        }
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
      // Groups and sessions are independent failure domains: a failing
      // groups endpoint must not discard a committable staged catalog.
      const groupRequest = groupTargetsRef.current.has(state.workspaceCwd)
        ? client
            .workspaceByCwd(state.workspaceCwd)
            .listSessionGroups()
            .catch(() => undefined)
        : Promise.resolve(undefined);
      return await Promise.all([
        catalogStore.stageWorkspaceRefresh(state.workspaceCwd),
        groupRequest,
      ]);
    };

    const loadFallbackBundle = async (
      state: WorkspacePollState,
    ): Promise<boolean> => {
      const [stagedCatalog, groups] = await stageCatalogBundle(state);
      if (disposed || !catalogStore.commitWorkspaceRefresh(stagedCatalog)) {
        return false;
      }
      publishGroups(state.workspaceCwd, groups);
      return true;
    };

    const consumeRefreshRequest = (state: WorkspacePollState): void => {
      const request = catalogStore.consumeWorkspaceLiveStateRefreshRequest(
        state.workspaceCwd,
      );
      const interactive = request === 'interactive';
      state.reconcileRequested = state.reconcileRequested || interactive;
      state.invalidationRequested =
        state.invalidationRequested || request === 'invalidated';
    };

    const reconcile = async (
      state: WorkspacePollState,
      liveA: DaemonWorkspaceSessionLiveState,
      allowTrailing: boolean,
    ): Promise<void> => {
      consumeRefreshRequest(state);
      state.lastReconcileAt = Date.now();
      const [stagedCatalog, groups] = await stageCatalogBundle(state);
      if (disposed) return;
      const liveB = await readLiveState(state.workspaceCwd);
      if (disposed) return;
      catalogStore.applyLiveState(state.workspaceCwd, liveB.sessions);
      if (versionsEqual(liveA.catalogVersion, liveB.catalogVersion)) {
        if (!catalogStore.commitWorkspaceRefresh(stagedCatalog)) {
          if (allowTrailing) {
            await reconcile(state, liveB, false);
            return;
          }
          // A persistently refused commit (e.g. revision bumped mid-staging
          // every time) must clear the request flags — otherwise they keep
          // bypassing the cooldown and the loop re-runs a full reconcile on
          // every 2s tick with no decay.
          state.reconcileRequested = false;
          state.invalidationRequested = false;
          return;
        }
        catalogStore.applyLiveState(state.workspaceCwd, liveB.sessions);
        state.acceptedVersion = liveB.catalogVersion;
        state.reconcileRequested = false;
        state.invalidationRequested = false;
        publishGroups(state.workspaceCwd, groups);
        return;
      }
      if (allowTrailing) await reconcile(state, liveB, false);
      else {
        state.reconcileRequested = false;
        state.invalidationRequested = false;
      }
    };

    const poll = async (state: WorkspacePollState): Promise<void> => {
      if (
        disposed ||
        state.inFlight ||
        (typeof document !== 'undefined' && document.hidden)
      ) {
        return;
      }
      const bypassRetry = state.interactiveRefreshRequested;
      if (!bypassRetry && Date.now() < state.liveRetryAt) return;
      state.interactiveRefreshRequested = false;
      state.inFlight = true;
      const finish = (): void => {
        state.inFlight = false;
        if (state.interactiveRefreshRequested) void poll(state);
      };
      // Contract: only a response from a request started after a completion
      // was recorded may settle it, so the pending set is snapshotted before
      // the request goes out. Completions recorded mid-flight keep their
      // newer sequence and settle on the next tick.
      const pendingActivity = catalogStore.snapshotSessionActivity(
        state.workspaceCwd,
      );
      let live: DaemonWorkspaceSessionLiveState;
      try {
        live = await readLiveState(state.workspaceCwd);
      } catch (error) {
        if (disposed) return;
        state.liveRetryAt = Date.now() + SESSION_LIVE_STATE_ERROR_RETRY_MS;
        // Only backoff-paced failures count. Interactive refreshes bypass
        // `liveRetryAt`, so a user deleting or archiving a few sessions during
        // a 10s daemon restart could otherwise push the streak to the
        // threshold seconds apart — dropping the snapshot inside the very blip
        // the threshold exists to ride out.
        if (
          !bypassRetry &&
          catalogStore.recordLiveStateFailure(state.workspaceCwd) ===
            SESSION_LIVE_STATE_STALE_AFTER_FAILURES
        ) {
          // The channel has stopped answering. Retaining the last snapshot
          // would let a reader keep vouching for a turn nobody can confirm.
          catalogStore.markWorkspaceLiveStateUnavailable(state.workspaceCwd);
        }
        console.warn('[session-live-state] request failed:', error);
        if (!state.acceptedVersion && !state.fallbackAttempted) {
          try {
            // Only a committed fallback latches; a failed or uncommitted
            // attempt stays retryable on the next live-state failure.
            state.fallbackAttempted = await loadFallbackBundle(state);
          } catch (fallbackError) {
            if (!disposed) {
              console.warn(
                '[session-live-state] initial catalog fallback failed:',
                fallbackError,
              );
            }
          }
        }
        finish();
        return;
      }
      if (disposed) {
        finish();
        return;
      }
      const absorbedActivity = catalogStore.applyLiveState(
        state.workspaceCwd,
        live.sessions,
      );
      state.liveRetryAt = 0;
      if (pendingActivity) {
        for (const [sessionId, sequence] of pendingActivity) {
          // applyLiveState reports which sessions absorbed a usable watermark
          // on a loaded active page; anything else (missing row, absent or
          // invalid stamp, row outside the loaded catalog) falls back to the
          // rate-limited full reconcile.
          if (!absorbedActivity.has(sessionId)) {
            state.invalidationRequested = true;
          }
          catalogStore.resolveSessionActivity(
            state.workspaceCwd,
            sessionId,
            sequence,
          );
        }
      }
      consumeRefreshRequest(state);
      const bypassReconcileRetry =
        bypassRetry || state.interactiveRefreshRequested;
      state.interactiveRefreshRequested = false;
      if (
        !state.reconcileRequested &&
        !state.invalidationRequested &&
        versionsEqual(state.acceptedVersion, live.catalogVersion)
      ) {
        finish();
        return;
      }
      // Interactive requests bypass the reconcile cooldown. Lifecycle
      // invalidations get one prompt reconcile per cooldown window — tracked
      // on a separate timestamp so a single local create stays immediate
      // while sustained event churn stays rate-limited.
      if (
        (!bypassReconcileRetry && Date.now() < state.reconcileRetryAt) ||
        (!state.reconcileRequested &&
          (state.invalidationRequested
            ? Date.now() - state.invalidationReconcileAt
            : Date.now() - state.lastReconcileAt) <
            SESSION_LIVE_STATE_RECONCILE_COOLDOWN_MS)
      ) {
        finish();
        return;
      }
      try {
        if (state.invalidationRequested && !state.reconcileRequested) {
          state.invalidationReconcileAt = Date.now();
        }
        await reconcile(state, live, true);
        state.reconcileRetryAt = 0;
      } catch (error) {
        if (!disposed) {
          state.reconcileRetryAt =
            Date.now() + SESSION_LIVE_STATE_ERROR_RETRY_MS;
          console.warn('[session-live-state] reconciliation failed:', error);
        }
      } finally {
        finish();
      }
    };

    // Interactive refresh requests (explicit refresh(), expiring
    // maxAgeMs subscriptions, group-membership growth) and recorded turn
    // completions wake the loop immediately instead of waiting for the
    // next 2s tick.
    const stopWake = catalogStore.onLiveStateWake(
      (workspaceCwd, bypassRetry) => {
        const state = states.find(
          (candidate) => candidate.workspaceCwd === workspaceCwd,
        );
        if (!state) return;
        if (bypassRetry) state.interactiveRefreshRequested = true;
        void poll(state);
      },
    );
    const onVisibilityWake = (): void => {
      if (typeof document !== 'undefined' && document.hidden) return;
      for (const state of states) void poll(state);
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityWake);
    }
    for (const state of states) void poll(state);
    const interval = window.setInterval(() => {
      for (const state of states) void poll(state);
    }, SESSION_LIVE_STATE_POLL_MS);
    return () => {
      disposed = true;
      stopWake();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityWake);
      }
      window.clearInterval(interval);
      for (const release of releaseLiveState) release();
    };
  }, [catalogStore, client, enabled, targets]);

  return groupCatalogs;
}
