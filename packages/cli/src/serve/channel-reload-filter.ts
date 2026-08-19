/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import type { ChannelRuntimeState } from '../commands/channel/channel-state-store.js';
import type { ChannelWorkspaceGroup } from './channel-workspace-grouping.js';
import type { ServeChannelSelection } from './types.js';

/**
 * Runtime deps injected by the caller instead of statically imported: the
 * channel command graph (`../commands/channel/*`) reaches the settings,
 * extension and channel-registry closures, which the serve fast-path bundle
 * boundary forbids in the pre-listen static closure
 * (scripts/check-serve-fast-path-bundle.js). run-qwen-serve wires these from
 * the lazily loaded channel worker runtime (`ensureChannelRuntime`), so the
 * derivation stays the production one — the SAME canonicalization and the
 * SAME daemon state file recordChannelsStopped / clearStoppedRecord use —
 * without a static edge (fast-path.test.ts pins the absence of the edge).
 */
export type DaemonReloadSelectionFilterDeps = {
  canonicalizeWorkspace: (workspaceCwd: string) => string;
  readRuntimeStates: (
    canonicalWorkspaceCwd: string,
  ) => Record<string, ChannelRuntimeState>;
};

/**
 * The reload-side mirror of the daemon stop-record contract
 * (`recordChannelsStopped` in routes/workspace-channel-control,
 * `clearStoppedRecord` in channel-management-service): a names-mode
 * recovery reconcile from the committed selection force-starts
 * regardless of persisted state, so without this filter it would
 * resurrect an explicitly STOPPED sibling — the mode-`all` worker's
 * restore filter protects only mode-`all` selections (#8975). The
 * returned filter drops names carrying a persisted `stopped` record in
 * the OWNING workspace's daemon state file before every reload-op
 * resolve; explicit by-name start/restart clear the target's own record
 * before the recovery reload, so the requested name survives.
 * Never-fails: unreadable state degrades to KEEPING the name (the
 * pre-R14 behavior) — a degraded fs must not break recovery.
 *
 * The per-workspace read cache lives INSIDE the returned filter, not in
 * this factory closure: run-qwen-serve creates exactly one filter
 * instance for the daemon's lifetime (memoized ensureChannelWorkerManager),
 * so a factory-scoped cache would read each workspace's state file at
 * most once and make `stopped` records written after that first read
 * invisible to every later reload-op — resurrecting explicitly stopped
 * channels through reconcile force-start (R15-1). Per-invocation caching
 * still coalesces reads of the same workspace within one resolve.
 *
 * Lives in its own module (imported by run-qwen-serve) instead of the
 * routes file next to recordChannelsStopped: the serve fast-path import
 * boundary forbids the ACP runtime modules the routes graph pulls in
 * (fast-path.test pins it), and this filter needs none of them (R14-5).
 */
export function createDaemonReloadSelectionFilter(
  deps: DaemonReloadSelectionFilterDeps,
): (
  selection: ServeChannelSelection,
  groups: readonly ChannelWorkspaceGroup[],
) => ServeChannelSelection {
  return (selection, groups) => {
    if (selection.mode !== 'names') return selection;
    // Per-invocation cache: one filter instance serves the whole daemon
    // lifetime, so caching here (not in the factory) re-reads each
    // workspace's state file on every reload-op resolve while still
    // coalescing same-workspace reads within this single resolve (R15-1).
    const stateByWorkspace = new Map<
      string,
      Record<string, ChannelRuntimeState>
    >();
    const stoppedIn = (workspaceCwd: string, name: string): boolean => {
      let states = stateByWorkspace.get(workspaceCwd);
      if (!states) {
        // Throw-safe canonical form: the state path is derived from the
        // canonical workspace (matching clearStoppedRecord /
        // recordChannelsStopped — a split derivation would read a
        // different file than the one stop writes); canonicalizeWorkspace
        // rethrows non-ENOENT fs errors, so degrade to the resolved form.
        let canonical: string;
        try {
          canonical = deps.canonicalizeWorkspace(workspaceCwd);
        } catch {
          canonical = path.resolve(workspaceCwd);
        }
        states = deps.readRuntimeStates(canonical);
        stateByWorkspace.set(workspaceCwd, states);
      }
      return states[name] === 'stopped';
    };
    const kept = selection.names.filter((name) => {
      const owner = groups.find(
        (group) =>
          group.selection.mode === 'names' &&
          group.selection.names.includes(name),
      );
      // Keep-fallback for an ownerless name: it has no owning workspace
      // whose record could stop it, and dropping it would turn a
      // transient grouping gap into a silent channel loss.
      return owner ? !stoppedIn(owner.workspaceCwd, name) : true;
    });
    return kept.length === selection.names.length
      ? selection
      : { mode: 'names', names: kept };
  };
}
