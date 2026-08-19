/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import type { ChannelWebhookTask } from '@qwen-code/channel-base';
import { canonicalizeWorkspace } from '@qwen-code/acp-bridge/workspacePaths';
import { ChannelWebhookEnqueueError } from './channel-webhook-ipc.js';
import {
  ChannelDeliveryError,
  type ChannelDeliveryRequest,
} from '../runtime/channel-delivery-ipc.js';
import type {
  ChannelWorkerGroup,
  ChannelWorkerGroupSnapshot,
} from './channel-worker-group.js';
import { ChannelWorkerReconcileError } from './channel-worker-group.js';
import {
  ChannelWorkerStartupError,
  ChannelWorkerStopError,
} from './channel-worker-supervisor.js';
import type {
  ChannelStartupAttemptFailure,
  ChannelWorkerSnapshot,
} from './channel-worker-supervisor.js';
import { isAllChannelSelectionName } from './channel-selection.js';
import type { ChannelWorkspaceGroup } from './channel-workspace-grouping.js';
import type { ServeChannelSelection } from './types.js';

export type ChannelWorkerControlTransition =
  | 'idle'
  | 'starting'
  | 'reconciling'
  | 'stopping'
  | 'rolling_back';

export interface ChannelWorkerControlState {
  enabled: boolean;
  selection: ServeChannelSelection | null;
  pendingSelection?: ServeChannelSelection;
  transition: ChannelWorkerControlTransition;
  workers: ChannelWorkerGroupSnapshot[];
}

export interface ChannelWorkerSetResult {
  changed: boolean;
  replaced: boolean;
  partial: boolean;
  state: ChannelWorkerControlState;
  /** Internal HTTP status hint; omitted from the response body. */
  created?: boolean;
  /**
   * Only present on failure: the commit succeeded, but clearing a
   * committed name's persisted `stopped` record did not persist — a
   * later automatic reload-op resolve filters the name out and
   * permanently trims the committed selection (R15-19). The client gets
   * the loss signal and a retry handle instead of a silent undo (#8975).
   */
  statePersisted?: boolean;
  /**
   * Set alongside `statePersisted = false`: the canonical workspace
   * paths whose record clear failed, so a retry can be targeted (R14).
   */
  statePersistFailedWorkspaces?: string[];
}

export interface ChannelWorkerStopResult {
  changed: boolean;
  state: ChannelWorkerControlState;
  /**
   * Channel names the stop actually tore down, grouped by workspace,
   * captured inside the manager lane at stop time (a pre-stop snapshot
   * taken by the caller can race an in-flight start). Callers persisting
   * `stopped` state (#8975) must record from here.
   */
  stoppedChannels?: Array<{ workspaceCwd: string; names: string[] }>;
}

export class ChannelWorkerControlError extends Error {
  readonly code:
    | 'channel_worker_start_failed'
    | 'channel_worker_stop_failed'
    | 'channel_worker_not_enabled'
    | 'channel_runtime_owner_mismatch'
    | 'daemon_draining';
  readonly rolledBack?: boolean;
  readonly rollbackError?: string;
  readonly startupFailures?: ChannelStartupAttemptFailure[];
  readonly startupFailuresTruncated?: boolean;
  /**
   * Channels a failed stop already tore down, captured before the failure.
   * A failed stop can lose the group (release failure) or the success
   * return path, so the captured set rides on the error: callers
   * persisting `stopped` state (#8975) must record it even when the stop
   * reports failure, or those channels resurrect on `--channel all`.
   */
  readonly stoppedChannels?: Array<{
    workspaceCwd: string;
    names: string[];
  }>;
  /**
   * Set by callers that persist `stoppedChannels` best-effort after
   * catching this error: `false` when at least one group's state write
   * also failed, so the HTTP layer can carry the loss on the error body —
   * the client has no retry handle once the group is cleared (#8975).
   * Assigned post-construction on purpose: the manager throws before any
   * persistence is attempted.
   */
  statePersisted?: boolean;
  /**
   * Set alongside `statePersisted = false`: the workspaces whose state
   * write failed, so the error body carries attribution for a targeted
   * retry (R14).
   */
  statePersistFailedWorkspaces?: string[];
  /**
   * Workspaces whose old worker entry the failed reconcile's rollback
   * restored: their channels are relaunching even though the aggregate
   * `rolledBack` is `false` (another workspace's restore failed). A
   * caller persisting `stopped` for one workspace must skip the ones
   * listed here, or it records a stop for a channel that is coming back
   * (R9-4).
   */
  readonly restoredWorkspaces?: string[];

  constructor(
    code: ChannelWorkerControlError['code'],
    message: string,
    details: {
      rolledBack?: boolean;
      rollbackError?: string;
      startupFailures?: readonly ChannelStartupAttemptFailure[];
      startupFailuresTruncated?: boolean;
      stoppedChannels?: ReadonlyArray<{
        workspaceCwd: string;
        names: readonly string[];
      }>;
      restoredWorkspaces?: readonly string[];
    } = {},
  ) {
    super(message);
    this.name = 'ChannelWorkerControlError';
    this.code = code;
    this.rolledBack = details.rolledBack;
    this.rollbackError = details.rollbackError;
    this.startupFailures = details.startupFailures?.map((failure) => ({
      ...failure,
    }));
    this.startupFailuresTruncated = details.startupFailuresTruncated;
    this.stoppedChannels = details.stoppedChannels?.map((entry) => ({
      workspaceCwd: entry.workspaceCwd,
      names: [...entry.names],
    }));
    this.restoredWorkspaces = details.restoredWorkspaces
      ? [...details.restoredWorkspaces]
      : undefined;
  }
}

export interface CreateChannelWorkerManagerOptions {
  resolveGroups: (
    selection: ServeChannelSelection,
    operation: 'initial' | 'set' | 'reload',
  ) => Promise<readonly ChannelWorkspaceGroup[]>;
  /**
   * Optional filter applied to the committed selection before every
   * `reload`-operation resolve (reload / reloadWorkspace /
   * refreshWorkspaces). Drops names-mode entries that carry a persisted
   * `stopped` record, so a dead-worker recovery reconcile does not
   * force-start an explicitly stopped SIBLING channel: the mode-`all`
   * worker's restore filter protects only mode-`all` selections, and a
   * names-mode replacement worker reconciled from the full untrimmed
   * committedSelection resurrects the stopped sibling and the ready
   * `active` write erases its record (R14). `initial` and `set` resolves
   * are deliberately UNFILTERED: explicit selections force-start
   * regardless of persisted state (#8975), and explicit by-name
   * start/restart clear the target's own record before the recovery
   * reload, so the requested name survives the filter. Receives the
   * committed groups for per-workspace state attribution. Never-fails:
   * any error degrades to the unfiltered selection.
   */
  filterReloadSelection?: (
    selection: ServeChannelSelection,
    groups: readonly ChannelWorkspaceGroup[],
  ) => ServeChannelSelection;
  /**
   * Optional hook invoked after a SUCCESSFUL names-mode selection commit
   * (initial start / explicit `set` / per-channel enable or disable),
   * receiving the committed groups. Clears persisted `stopped` records
   * for the committed names: an explicit names-mode selection
   * force-starts regardless of persisted state (#8975), so a record
   * surviving the re-commit lets a later automatic reload-op resolve
   * (e.g. `refreshWorkspaces` on workspace attach/detach) filter a
   * still-starting name out BEFORE its ready `active` write lands —
   * leaving it committed-but-ownerless (`start` →
   * channel_runtime_owner_mismatch, `restart` →
   * channel_worker_not_enabled) with the record never cleared: dead
   * until stop+start or another PUT (R14). mode-`all` commits must NOT
   * clear: `--channel all` restore honors `stopped` records by design.
   * Never throws — a clear failure must not fail an already-committed
   * selection (persistence failures never flip a succeeded operation),
   * but it must not be SILENT either: post-R14 a surviving `stopped`
   * record means the reload filter DROPS the name and a later reload-op
   * permanently trims the committed selection — the "degrades to the
   * pre-fix window" framing predates the filter and is wrong (R15-19).
   * Returns the canonical workspace paths whose clear FAILED (a `trySet`
   * returning false on a record that WAS `stopped`, or a non-ENOENT
   * pre-read failure that leaves the record unknown); the manager
   * surfaces them as `statePersisted: false` +
   * `statePersistFailedWorkspaces` on the set result, mirroring the
   * DELETE route's loss plumbing (#8975).
   */
  clearStoppedRecords?: (
    groups: readonly ChannelWorkspaceGroup[],
  ) => readonly string[];
  createGroup: (groups: readonly ChannelWorkspaceGroup[]) => ChannelWorkerGroup;
  reserveLease: (selection: ServeChannelSelection) => void;
  releaseLease: () => void;
  initialLeaseReserved?: boolean;
  onCommittedSelection?: (
    selection: ServeChannelSelection | undefined,
    groups: readonly ChannelWorkspaceGroup[],
  ) => void;
  onStateChange?: (state: ChannelWorkerControlState) => void;
}

export interface ChannelWorkerManager {
  /**
   * Returns the initial commit's set result: the boot path must be able to
   * read the `clearStoppedRecords` loss signal (`statePersisted: false` +
   * `statePersistFailedWorkspaces`) and surface it — discarding it leaves
   * the committed names' surviving `stopped` records undiagnosed when a
   * later reload-op resolve filters and permanently trims them (R16-26).
   */
  startInitial(
    selection: ServeChannelSelection,
  ): Promise<ChannelWorkerSetResult>;
  setSelection(
    selection: ServeChannelSelection,
    requiredOwner?: ChannelWorkerRequiredOwner,
  ): Promise<ChannelWorkerSetResult>;
  setChannelEnabled(
    owner: ChannelWorkerRequiredOwner,
    enabled: boolean,
  ): Promise<ChannelWorkerSetResult | ChannelWorkerStopResult>;
  stopSelection(): Promise<ChannelWorkerStopResult>;
  reload(): Promise<ChannelWorkerSnapshot>;
  reloadWorkspace(
    workspaceCwd: string,
    name: string,
  ): Promise<ChannelWorkerSnapshot>;
  state(): ChannelWorkerControlState;
  primarySnapshot(): ChannelWorkerSnapshot;
  snapshots(): ChannelWorkerGroupSnapshot[];
  /**
   * Raw group snapshots WITHOUT the `publicWorkerSnapshot` strip: for
   * in-process ownership matching only (a terminal worker's carried
   * `lastRequestedChannels`/`lastConnectedChannels` are load-bearing
   * there). Never serialize this over HTTP — public surfaces use
   * `state()`/`snapshots()`, which strip the internal fields (#8975).
   */
  ownershipSnapshots(): ChannelWorkerGroupSnapshot[];
  committedChannelNames(): string[];
  enqueueWebhookTask(
    task: ChannelWebhookTask,
  ): ReturnType<ChannelWorkerGroup['enqueueWebhookTask']>;
  deliverChannelMessage(
    workspaceCwd: string,
    request: ChannelDeliveryRequest,
  ): ReturnType<ChannelWorkerGroup['deliverChannelMessage']>;
  beginWorkspaceDrain(workspaceCwd: string): void;
  cancelWorkspaceDrain(workspaceCwd: string): void;
  workspaceActivity(workspaceCwd: string): number;
  removeWorkspace(workspaceCwd: string): Promise<void>;
  restoreWorkspace(workspaceCwd: string): Promise<void>;
  refreshWorkspaces(): Promise<void>;
  workerChanged(): void;
  shutdown(): Promise<void>;
  killAllSync(): void;
}

export interface ChannelWorkerRequiredOwner {
  name: string;
  workspaceCwd: string;
}

const DISABLED_SNAPSHOT: ChannelWorkerSnapshot = {
  enabled: false,
  state: 'disabled',
  channels: [],
};

function cloneSelection(
  selection: ServeChannelSelection,
): ServeChannelSelection {
  return selection.mode === 'all'
    ? { mode: 'all' }
    : { mode: 'names', names: [...selection.names] };
}

function cloneGroups(
  groups: readonly ChannelWorkspaceGroup[],
): ChannelWorkspaceGroup[] {
  return groups.map((group) => ({
    workspaceCwd: group.workspaceCwd,
    selection: cloneSelection(group.selection),
  }));
}

function selectionsEqual(
  left: ServeChannelSelection | undefined,
  right: ServeChannelSelection,
): boolean {
  if (!left || left.mode !== right.mode) return false;
  if (left.mode === 'all') return true;
  if (right.mode === 'all' || left.names.length !== right.names.length) {
    return false;
  }
  return left.names.every((name, index) => name === right.names[index]);
}

function isPartial(workers: readonly ChannelWorkerGroupSnapshot[]): boolean {
  return workers.some((worker) => {
    if (!worker.requestedChannels) return false;
    const connected = new Set(worker.channels);
    return worker.requestedChannels.some((name) => !connected.has(name));
  });
}

function groupIncludesName(
  group: ChannelWorkspaceGroup,
  name: string,
): boolean {
  return group.selection.mode === 'all' || group.selection.names.includes(name);
}

function assertRequiredOwner(
  targetGroups: readonly ChannelWorkspaceGroup[],
  requiredOwner: ChannelWorkerRequiredOwner,
): void {
  const owners = targetGroups.filter((target) =>
    groupIncludesName(target, requiredOwner.name),
  );
  if (
    owners.length !== 1 ||
    owners[0]!.workspaceCwd !== requiredOwner.workspaceCwd
  ) {
    throw new ChannelWorkerControlError(
      'channel_runtime_owner_mismatch',
      `Channel "${requiredOwner.name}" does not resolve to workspace "${requiredOwner.workspaceCwd}".`,
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A terminal-failed worker: restart budget exhausted, no restart
 * scheduled — it will never connect anything again. ONE shared predicate
 * for every guard layer that must classify it identically (the manager's
 * committed-names exclusion and the management service's
 * `workspaceWorkerStarting` / `terminalFailedWorkerFor` guards): a future
 * change to terminal detection applied to one site but not all silently
 * desyncs the layers — dead channels excluded from `committedChannelNames`
 * while the service guard still classifies the worker as starting rejects
 * every per-channel stop with `channel_worker_starting` (or the inverse) —
 * the R8-18/R9-5 defect classes (R14).
 */
export function isTerminalFailedWorker(
  worker: ChannelWorkerGroupSnapshot,
): boolean {
  return worker.state === 'failed' && worker.nextRestartAt === undefined;
}

/**
 * Collect the channel names a stop tears down, grouped by workspace.
 * Only channels that actually connected are captured: the ready report
 * commits the attempted set in `requestedChannels` and the connected set in
 * `channels`, and intersecting the two keeps a partial start from recording
 * a never-connected channel as explicitly stopped (#8975). Inside the launch
 * window `channels` is the placeholder, so the intersection degrades: for a
 * crash-restarting mode-`all` worker it is the `['all']` placeholder (every
 * carried real name fails the intersection, so the stop records nothing and
 * the stopped channels resurrect), while for mode-names it equals the
 * attempted set (a channel whose connect failed before the crash gets
 * recorded as stopped though it never ran). Intersect with the connected
 * set carried from the last ready report instead (#8975). Before the first
 * ready report there is no carried set: a stop in the initial mode-`all`
 * window records nothing, as before. The carried set is authoritative in
 * EVERY state, not just `starting`: a budget-exhausted terminal snapshot
 * drops `requestedChannels`, and its `channels` is the last launch's
 * attempted set (or the mode-`all` placeholder), so intersecting with it
 * would record never-connected channels — or nothing — as explicitly
 * stopped. The supervisor keeps `lastConnectedChannels` on that terminal
 * snapshot exactly for this capture, and when `requestedChannels` is gone
 * the carried connected set also supplies the candidate names (#8975).
 * Manager-driven starts serialize in the lane, but supervisor-internal
 * crash-restarts bypass it: the caller unions the pre-stop snapshots with
 * the group's post-stop snapshots so a ready report that commits during
 * the tear-down window is still recorded as explicitly stopped (#8975).
 */
function stoppedChannelsByWorkspace(
  workers: readonly ChannelWorkerGroupSnapshot[],
): Array<{ workspaceCwd: string; names: string[] }> {
  const byWorkspace = new Map<string, Set<string>>();
  for (const worker of workers) {
    // Neither a requested set nor a carried connected set: nothing was
    // ever confirmed connected (the initial mode-`all` window, or a
    // budget-exhausted worker that never reported ready) — recording the
    // launch placeholder/attempted set would pin never-run channels as
    // explicitly stopped (#8975).
    if (!worker.requestedChannels && !worker.lastConnectedChannels) continue;
    // Fall back to `channels` ONLY once the worker is `running` (a ready
    // report has committed it): before the first ready — the mode-names
    // startup window, and crash-restarts that never came back ready —
    // `channels` is still the ATTEMPTED set, and capturing it would
    // persist never-connected channels as explicitly `stopped`, skipping
    // them on every later `--channel all` until manually started. That
    // contradicts this capture's contract ("only channels that actually
    // connected are captured"), so record nothing there instead (#8975).
    const connected = new Set(
      worker.lastConnectedChannels ??
        (worker.state === 'running' ? worker.channels : []),
    );
    const names = (
      worker.requestedChannels ??
      worker.lastConnectedChannels ??
      worker.channels
    ).filter((name) => !isAllChannelSelectionName(name) && connected.has(name));
    if (names.length === 0) continue;
    // Throw-safe canonical form: canonicalizeWorkspace rethrows non-ENOENT
    // fs errors by design, but a degraded worker path must degrade to the
    // resolved form instead of escaping the stop before any tear-down as an
    // opaque 500 with no structured code or stoppedChannels (#8975).
    let workspaceCwd: string;
    try {
      workspaceCwd = canonicalizeWorkspace(worker.workspaceCwd);
    } catch {
      workspaceCwd = path.resolve(worker.workspaceCwd);
    }
    let collected = byWorkspace.get(workspaceCwd);
    if (!collected) {
      collected = new Set<string>();
      byWorkspace.set(workspaceCwd, collected);
    }
    for (const name of names) collected.add(name);
  }
  return [...byWorkspace.entries()].map(([workspaceCwd, names]) => ({
    workspaceCwd,
    names: [...names],
  }));
}

/**
 * The control state rides HTTP responses verbatim (GET/PUT/DELETE
 * /workspace/channel, GET /daemon/status, POST /workspace/channel/reload):
 * strip `lastConnectedChannels`, an internal input of the stop capture
 * that the SDK's `DaemonChannelWorkerSnapshot` does not declare, and
 * `lastRequestedChannels`, the internal input of the mode-names
 * dead-name computation on terminal snapshots (R9-6). The capture and
 * the computation read the group snapshots directly, so stripping in
 * these public accessors does not narrow what they see (#8975).
 */
function publicWorkerSnapshot<T extends ChannelWorkerSnapshot>(worker: T): T {
  if (!worker.lastConnectedChannels && !worker.lastRequestedChannels) {
    return worker;
  }
  const publicSnapshot = { ...worker };
  delete publicSnapshot.lastConnectedChannels;
  delete publicSnapshot.lastRequestedChannels;
  return publicSnapshot;
}

function startupFailureDetails(error: unknown): {
  startupFailures?: readonly ChannelStartupAttemptFailure[];
  startupFailuresTruncated?: boolean;
} {
  if (
    !(
      error instanceof ChannelWorkerStartupError ||
      error instanceof ChannelWorkerReconcileError
    ) ||
    !error.startupFailures
  ) {
    return {};
  }
  return {
    startupFailures: error.startupFailures,
    ...(error.startupFailuresTruncated
      ? { startupFailuresTruncated: true }
      : {}),
  };
}

export function createChannelWorkerManager(
  opts: CreateChannelWorkerManagerOptions,
): ChannelWorkerManager {
  let committedSelection: ServeChannelSelection | undefined;
  let committedGroups: ChannelWorkspaceGroup[] = [];
  let pendingSelection: ServeChannelSelection | undefined;
  let transition: ChannelWorkerControlTransition = 'idle';
  let group: ChannelWorkerGroup | undefined;
  let leaseReserved = opts.initialLeaseReserved === true;
  let draining = false;
  let hardKilled = false;
  let lane: Promise<void> = Promise.resolve();
  const workspaceDrains = new Set<string>();

  const snapshot = (): ChannelWorkerControlState => ({
    enabled:
      committedSelection !== undefined || group !== undefined || leaseReserved,
    selection: committedSelection ? cloneSelection(committedSelection) : null,
    ...(pendingSelection
      ? { pendingSelection: cloneSelection(pendingSelection) }
      : {}),
    transition,
    workers: (group?.snapshots() ?? []).map(publicWorkerSnapshot),
  });

  const notify = () => {
    opts.onStateChange?.(snapshot());
  };

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = lane.then(operation, operation);
    lane = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const drainingError = () =>
    new ChannelWorkerControlError(
      'daemon_draining',
      'Daemon is shutting down.',
    );

  const reserve = (selection: ServeChannelSelection) => {
    if (leaseReserved) return;
    opts.reserveLease(selection);
    leaseReserved = true;
  };

  const release = () => {
    if (!leaseReserved) return;
    opts.releaseLease();
    leaseReserved = false;
  };

  const setTransition = (
    next: ChannelWorkerControlTransition,
    pending?: ServeChannelSelection,
  ) => {
    transition = next;
    pendingSelection = pending ? cloneSelection(pending) : undefined;
    notify();
  };

  const commit = (
    selection: ServeChannelSelection | undefined,
    groups: readonly ChannelWorkspaceGroup[],
  ) => {
    committedSelection = selection ? cloneSelection(selection) : undefined;
    committedGroups = cloneGroups(groups);
    transition = 'idle';
    pendingSelection = undefined;
    opts.onCommittedSelection?.(committedSelection, groups);
    notify();
  };

  // Post-commit hook for explicit names-mode selections: clear persisted
  // `stopped` records for the committed names (see the
  // `clearStoppedRecords` option doc). Never throws — a clear failure
  // must not fail an already-committed selection — but it returns the
  // workspaces whose clear FAILED so the set result surfaces the loss
  // (a surviving record lets the reload filter drop the name and a later
  // reload-op permanently trims the committed selection, R15-19).
  const clearRecordsForCommit = (
    selection: ServeChannelSelection,
    groups: readonly ChannelWorkspaceGroup[],
  ): string[] => {
    if (!opts.clearStoppedRecords || selection.mode !== 'names') return [];
    try {
      return [...opts.clearStoppedRecords(groups)];
    } catch {
      // An UNEXPECTED hook error (not a reported per-workspace failure)
      // cannot be attributed: degrade to no loss signal rather than fail
      // the committed selection.
      return [];
    }
  };

  // Loss fields for the set result: only present on failure, mirroring
  // the DELETE route's shape (#8975, R15-19).
  const clearLossFields = (
    persistFailedWorkspaces: readonly string[],
  ): Pick<
    ChannelWorkerSetResult,
    'statePersisted' | 'statePersistFailedWorkspaces'
  > =>
    persistFailedWorkspaces.length === 0
      ? {}
      : {
          statePersisted: false,
          statePersistFailedWorkspaces: [...persistFailedWorkspaces],
        };

  const classifyFailure = (
    error: unknown,
    fallbackCode: 'channel_worker_start_failed' | 'channel_worker_stop_failed',
    extraDetails: {
      stoppedChannels?: ReadonlyArray<{
        workspaceCwd: string;
        names: readonly string[];
      }>;
    } = {},
  ): ChannelWorkerControlError => {
    if (error instanceof ChannelWorkerReconcileError) {
      return new ChannelWorkerControlError(
        error.stopFailed ? 'channel_worker_stop_failed' : fallbackCode,
        error.message,
        {
          rolledBack: error.rolledBack,
          ...(error.rollbackError
            ? { rollbackError: error.rollbackError }
            : {}),
          ...(error.restoredWorkspaces
            ? { restoredWorkspaces: error.restoredWorkspaces }
            : {}),
          ...startupFailureDetails(error),
          ...extraDetails,
        },
      );
    }
    return new ChannelWorkerControlError(
      error instanceof ChannelWorkerStopError
        ? 'channel_worker_stop_failed'
        : fallbackCode,
      errorMessage(error),
      { ...startupFailureDetails(error), ...extraDetails },
    );
  };

  // Committed-group bookkeeping for a preserve-scoped reconcile (R20-3):
  // preserved workspaces' live entries stay untouched, so their committed
  // groups must carry over as-is — committing the freshly resolved target
  // group for them would desync committedGroups from the live entries
  // (the same coherence contract reloadWorkspace's scoped commit keeps,
  // R14/R17-3).
  const committedGroupsForApply = (
    targetGroups: readonly ChannelWorkspaceGroup[],
    preserveWorkspaceCwds: ReadonlySet<string> | undefined,
  ): ChannelWorkspaceGroup[] => {
    if (!preserveWorkspaceCwds || preserveWorkspaceCwds.size === 0) {
      return [...targetGroups];
    }
    const preserved = new Map(
      committedGroups
        .filter((committedGroup) =>
          preserveWorkspaceCwds.has(committedGroup.workspaceCwd),
        )
        .map(
          (committedGroup) =>
            [committedGroup.workspaceCwd, committedGroup] as const,
        ),
    );
    const seen = new Set<string>();
    const merged = targetGroups.map((targetGroup) => {
      seen.add(targetGroup.workspaceCwd);
      return preserved.get(targetGroup.workspaceCwd) ?? targetGroup;
    });
    for (const [workspaceCwd, committedGroup] of preserved) {
      if (!seen.has(workspaceCwd)) merged.push(committedGroup);
    }
    return merged;
  };

  const applySelection = async (
    selection: ServeChannelSelection,
    initial: boolean,
    resolvedGroups?: readonly ChannelWorkspaceGroup[],
    preserveWorkspaceCwds?: ReadonlySet<string>,
  ): Promise<ChannelWorkerSetResult> => {
    if (hardKilled) throw drainingError();
    const enabling = !snapshot().enabled;
    const replacing = committedSelection !== undefined;
    const sameSelection = selectionsEqual(committedSelection, selection);
    if (sameSelection && group?.isHealthy()) {
      // A same-selection retry must re-run the stopped-record clear
      // (R20-5): the original commit's clearStoppedRecords hook can fail
      // to flip a pre-existing `stopped` record (transient lock/ENOSPC),
      // the set result's warning then directs the user to re-run the
      // identical command, and without this re-clear that retry returned
      // before clearRecordsForCommit ran — the surviving record let the
      // next reload-op filter drop the name and permanently trim the
      // committed selection while reporting success. Idempotent: no
      // reconcile, only the clear and its loss report (no-op for mode-`all`
      // and when the hook is not wired).
      const persistFailedWorkspaces = clearRecordsForCommit(
        selection,
        committedGroups,
      );
      return {
        changed: false,
        replaced: false,
        partial: isPartial(group.snapshots()),
        state: snapshot(),
        created: false,
        ...clearLossFields(persistFailedWorkspaces),
      };
    }

    setTransition(replacing ? 'reconciling' : 'starting', selection);
    let targetGroups: readonly ChannelWorkspaceGroup[];
    try {
      targetGroups =
        resolvedGroups ??
        (await opts.resolveGroups(selection, initial ? 'initial' : 'set'));
      if (hardKilled) throw drainingError();
      reserve(selection);
    } catch (error) {
      setTransition('idle');
      throw error;
    }

    if (!group) {
      let candidate: ChannelWorkerGroup;
      try {
        candidate = opts.createGroup(targetGroups);
      } catch (error) {
        let cleanupError: unknown;
        if (!initial) {
          try {
            release();
          } catch (releaseError) {
            cleanupError = releaseError;
          }
        }
        setTransition('idle');
        throw new ChannelWorkerControlError(
          'channel_worker_start_failed',
          errorMessage(error),
          cleanupError
            ? { rolledBack: false, rollbackError: errorMessage(cleanupError) }
            : { rolledBack: !initial },
        );
      }
      group = candidate;
      for (const workspaceCwd of workspaceDrains) {
        candidate.beginWorkspaceDrain(workspaceCwd);
      }
      notify();
      try {
        await candidate.start();
      } catch (error) {
        const startupDetails = startupFailureDetails(error);
        let cleanupError: unknown;
        try {
          await candidate.stop();
        } catch (stopError) {
          cleanupError = stopError;
        }
        if (!cleanupError) {
          if (!initial) {
            try {
              release();
            } catch (releaseError) {
              cleanupError = releaseError;
            }
          }
          if (!cleanupError) group = undefined;
        }
        setTransition('idle');
        throw new ChannelWorkerControlError(
          'channel_worker_start_failed',
          errorMessage(error),
          cleanupError
            ? {
                rolledBack: false,
                rollbackError: errorMessage(cleanupError),
                ...startupDetails,
              }
            : { rolledBack: true, ...startupDetails },
        );
      }
      commit(selection, targetGroups);
      const persistFailedWorkspaces = clearRecordsForCommit(
        selection,
        targetGroups,
      );
      return {
        changed: true,
        replaced: false,
        partial: isPartial(candidate.snapshots()),
        state: snapshot(),
        created: enabling,
        ...clearLossFields(persistFailedWorkspaces),
      };
    }

    try {
      const result = await group.reconcile(targetGroups, {
        onRollingBack: () => setTransition('rolling_back', selection),
        ...(preserveWorkspaceCwds && preserveWorkspaceCwds.size > 0
          ? { preserveWorkspaceCwds }
          : {}),
      });
      commit(
        selection,
        committedGroupsForApply(targetGroups, preserveWorkspaceCwds),
      );
      const persistFailedWorkspaces = clearRecordsForCommit(
        selection,
        targetGroups,
      );
      return {
        changed: result.changed || !sameSelection,
        replaced: !sameSelection,
        partial: isPartial(result.workers),
        state: snapshot(),
        created: enabling,
        ...clearLossFields(persistFailedWorkspaces),
      };
    } catch (error) {
      setTransition('idle');
      throw classifyFailure(error, 'channel_worker_start_failed');
    }
  };

  // The committed selection for a `reload`-operation resolve, with the
  // optional stopped-record filter applied (see the `filterReloadSelection`
  // option doc): a dead-worker recovery reconcile must not force-start
  // explicitly stopped names-mode siblings. Never-fails — a filter error
  // degrades to the unfiltered selection (R14).
  const reloadSelection = (
    selection: ServeChannelSelection,
  ): ServeChannelSelection => {
    if (!opts.filterReloadSelection) return selection;
    try {
      return opts.filterReloadSelection(selection, committedGroups);
    } catch {
      return selection;
    }
  };

  // reloadWorkspace's reconcile is scoped to ONE workspace
  // (forceWorkspaceCwd): entries owned by other workspaces are preserved
  // as-is, so names the GLOBAL reload filter dropped but a PRESERVED
  // workspace owns must stay committed — committing the globally
  // filtered selection trims them while their workers keep running,
  // desyncing committedGroups from committedSelection: a later
  // per-channel stop then hits the disable early-return with nothing to
  // tear down, and the channel runs unmanaged until the next GLOBAL
  // reconcile (reload/refreshWorkspaces) re-filters with a full
  // reconcile and stops it coherently. Names owned by the reconciled
  // workspace itself stay filtered — re-adding the requested workspace's
  // own dropped name would resurrect an explicitly stopped channel
  // (R15-38). Never changes a mode-`all` selection (R17-3).
  const scopeCommitSelection = (
    selection: ServeChannelSelection,
    workspaceCwd: string,
  ): ServeChannelSelection => {
    if (selection.mode !== 'names') return selection;
    const kept = new Set(selection.names);
    let changed = false;
    for (const committedGroup of committedGroups) {
      if (committedGroup.workspaceCwd === workspaceCwd) continue;
      if (committedGroup.selection.mode !== 'names') continue;
      for (const name of committedGroup.selection.names) {
        if (!kept.has(name)) {
          kept.add(name);
          changed = true;
        }
      }
    }
    return changed ? { mode: 'names', names: [...kept] } : selection;
  };

  // Reporting a terminal-failed worker's names as committed makes a
  // per-channel start early-return `{changed: false}` on the dead worker
  // instead of relaunching it — silently swallowing the natural recovery
  // command (#8975). Predicate shared with the service guards via the
  // exported `isTerminalFailedWorker` (R14).
  const committedChannelNames = (): string[] => {
    if (!committedSelection) return [];
    if (committedSelection.mode === 'names') {
      const deadNames = new Set<string>();
      for (const worker of group?.snapshots() ?? []) {
        if (!isTerminalFailedWorker(worker)) continue;
        // The terminal snapshot drops `requestedChannels`; its full
        // attempted set rides in `lastRequestedChannels` (R9-6). Falling
        // back to `channels` alone degrades to the last ready's CONNECTED
        // subset, leaving a never-connected channel "committed" on the
        // dead worker — its own start/stop/remove then throws
        // channel_runtime_owner_mismatch instead of relaunching it.
        for (const name of worker.requestedChannels ??
          worker.lastRequestedChannels ??
          worker.channels) {
          deadNames.add(name);
        }
      }
      return committedSelection.names.filter((name) => !deadNames.has(name));
    }
    const names = new Set<string>();
    for (const worker of group?.snapshots() ?? []) {
      if (isTerminalFailedWorker(worker)) continue;
      for (const name of worker.requestedChannels ?? worker.channels) {
        // The mode-`all` launch placeholder is not a real channel; leaking it
        // here breaks enabled checks, stop recording and status (#8975).
        if (isAllChannelSelectionName(name)) continue;
        names.add(name);
      }
    }
    return [...names];
  };

  // The mode-`all` enable/disable rebuild source: a mode-`all` commitment
  // carries no name list, so the rebuild must source names from the
  // workers — but NOT through the filtered committedChannelNames() view:
  // that view skips terminal-failed workers wholesale (the R8-18
  // start/recovery contract), and rebuilding from it silently drops their
  // carried names from the committed selection on every sibling
  // enable/disable — ghosts that every later reload-op resolve
  // (reload/reloadWorkspace/refreshWorkspaces) omits until a daemon
  // restart, breaking the mode-`all` restore contract. The merge base's
  // mode-all loop had no terminal skip, and the names-mode rebuild
  // already sources from the unfiltered selection (R15-17); union the
  // carried names back in for the mode-all sibling (R19-1).
  const modeAllRebuildNames = (committedNames: string[]): string[] => {
    if (committedSelection?.mode !== 'all') return committedNames;
    const names = new Set(committedNames);
    for (const worker of group?.snapshots() ?? []) {
      if (!isTerminalFailedWorker(worker)) continue;
      // The terminal snapshot drops `requestedChannels`; the carried sets
      // ride `lastRequestedChannels` / `lastConnectedChannels` (R9-6).
      for (const name of worker.lastRequestedChannels ??
        worker.lastConnectedChannels ??
        []) {
        // The mode-`all` launch placeholder is not a real channel (same
        // filter as the mode-all branch above).
        if (isAllChannelSelectionName(name)) continue;
        names.add(name);
      }
    }
    return [...names];
  };

  const assertCommittedOwner = (
    requiredOwner: ChannelWorkerRequiredOwner,
  ): void => {
    const owners = (group?.snapshots() ?? []).filter(
      (worker) =>
        worker.adapters?.some(
          (adapter) => adapter.name === requiredOwner.name,
        ) ||
        worker.requestedChannels?.includes(requiredOwner.name) ||
        worker.channels.includes(requiredOwner.name),
    );
    if (
      owners.length !== 1 ||
      owners[0]!.workspaceCwd !== requiredOwner.workspaceCwd
    ) {
      throw new ChannelWorkerControlError(
        'channel_runtime_owner_mismatch',
        `Channel "${requiredOwner.name}" does not have one confirmed runtime owner in workspace "${requiredOwner.workspaceCwd}".`,
      );
    }
  };

  const stopSelectionNow = async (): Promise<ChannelWorkerStopResult> => {
    const hadState = group !== undefined || leaseReserved;
    if (!hadState) {
      return { changed: false, state: snapshot() };
    }
    // Capture what this stop tears down before the workers go away, so
    // callers can persist `stopped` from the result instead of a racy
    // pre-stop snapshot. The pre-stop capture alone is not sufficient:
    // supervisor-internal crash-restarts bypass the manager lane, so a
    // relaunch whose ready report commits during the tear-down window
    // connects channels the pre-stop capture never recorded (the worker
    // already wrote them `active`). Re-read the snapshots once
    // `group.stop()` settles and union both captures so those channels are
    // persisted `stopped` too (#8975).
    const stoppingGroup = group;
    const capturedSnapshots: ChannelWorkerGroupSnapshot[] = [
      ...(stoppingGroup?.snapshots() ?? []),
    ];
    setTransition('stopping');
    try {
      if (stoppingGroup) {
        try {
          await stoppingGroup.stop();
        } finally {
          // The supervisors' final snapshots reflect any ready that
          // committed during the tear-down; union them with the pre-stop
          // capture. After a rejected stop() they additionally cover the
          // partial tear-down a retry would otherwise re-capture.
          capturedSnapshots.push(...stoppingGroup.snapshots());
        }
        group = undefined;
      }
      release();
    } catch (error) {
      setTransition('idle');
      const stoppedChannels = stoppedChannelsByWorkspace(capturedSnapshots);
      // Carry the captured tear-down set on the error: a partial multi-
      // workspace stop already killed some workers, and a release() failure
      // clears the group before any retry could re-capture the names. The
      // route persists this set even on the failure path, so the stopped
      // channels do not resurrect on the next `--channel all` (#8975).
      //
      // Treat a stop-REJECTED group as LOST: drop the handle and the
      // committed selection here, or the group stays latched mid-tear-down
      // forever — its stopping state only resets in group.start(), so every
      // reconcile-based recovery rejects on the latch, and a per-channel
      // start for an already torn-down channel early-returns 200
      // `{changed: false}` (nothing relaunched) while the persisted
      // `stopped` record removes even the daemon-restart self-heal: the
      // channel is dead while start reports success. Clearing the group
      // lets the next operation create a fresh one; the surviving workers
      // of the rejected stop are orphaned by design — an unrecoverable
      // half-stopped group is worse than a leaked child the standalone
      // pidfile path can still signal (R14).
      group = undefined;
      try {
        release();
      } catch {
        // The release failure may be exactly what rejected; the lost-group
        // cleanup proceeds regardless (a stuck lease is recovered by the
        // next reserve no-op, the latch is not).
      }
      commit(undefined, []);
      throw classifyFailure(error, 'channel_worker_stop_failed', {
        ...(stoppedChannels.length > 0 ? { stoppedChannels } : {}),
      });
    }
    const stoppedChannels = stoppedChannelsByWorkspace(capturedSnapshots);
    commit(undefined, []);
    return {
      changed: hadState,
      state: snapshot(),
      ...(stoppedChannels.length > 0 ? { stoppedChannels } : {}),
    };
  };

  const manager: ChannelWorkerManager = {
    startInitial(selection) {
      if (draining) {
        return Promise.reject(drainingError());
      }
      // Return the initial commit's set result so the boot path can
      // surface the clearStoppedRecords loss signal (R16-26).
      return enqueue(() => applySelection(selection, true));
    },
    setSelection(selection, requiredOwner) {
      if (draining) {
        return Promise.reject(drainingError());
      }
      return enqueue(async () => {
        if (!requiredOwner) return applySelection(selection, false);
        const targetGroups = await opts.resolveGroups(selection, 'set');
        assertRequiredOwner(targetGroups, requiredOwner);
        if (hardKilled) throw drainingError();
        return applySelection(selection, false, targetGroups);
      });
    },
    setChannelEnabled(owner, enabled) {
      if (draining) {
        return Promise.reject(drainingError());
      }
      return enqueue(async () => {
        const committedNames = committedChannelNames();
        const currentlyEnabled = committedNames.includes(owner.name);
        if (currentlyEnabled) assertCommittedOwner(owner);
        // The dead-name exclusion in committedChannelNames() is the
        // recovery contract for per-channel start (R8-18); the committed
        // SELECTION is the source of truth for enable/disable rebuilds.
        // Rebuilding from the filtered view silently dropped a
        // terminal-failed worker's names on every enable/disable commit —
        // ghosts that break every later reload-op resolve, and a collapse
        // to names=[] when the last live sibling is disabled, whose
        // whole-stop capture launders the crash into a clean `stopped`
        // record (R15-17). Mode-`all` commitments carry no name list;
        // their rebuild unions the live-worker names with terminal
        // workers' carried names, so a sibling enable/disable cannot drop
        // the dead worker's channels from the committed selection (R19-1).
        const selectionNames =
          committedSelection?.mode === 'names'
            ? committedSelection.names
            : modeAllRebuildNames(committedNames);
        // Terminal-failed workers must survive the rebuild untouched
        // (R20-3): the rebuilt selection still carries their names (the
        // R19-1 union / R15-17 ghost contract), and resolving it yields a
        // target group for the dead workspace — reconciling that target
        // replaces the terminal entry with a fresh one on a FRESH restart
        // budget, resurrecting the crash-looping channel the budget exists
        // to stop and violating the R8-18 contract (an explicit start is
        // the only path back up). Exception: when the toggled name itself
        // rides a terminal-failed worker, that workspace reconciles
        // normally — disabling its ghost name is exactly the re-commit
        // that removes it (R15-17), and its entry must go with it.
        const carriesName = (worker: ChannelWorkerGroupSnapshot): boolean =>
          (worker.adapters?.some((adapter) => adapter.name === owner.name) ??
            false) ||
          (worker.requestedChannels?.includes(owner.name) ?? false) ||
          (worker.lastRequestedChannels?.includes(owner.name) ?? false) ||
          worker.channels.includes(owner.name);
        const preserveWorkspaceCwds = new Set(
          (group?.snapshots() ?? [])
            .filter(
              (worker) =>
                isTerminalFailedWorker(worker) && !carriesName(worker),
            )
            .map((worker) => worker.workspaceCwd),
        );
        if (enabled) {
          if (currentlyEnabled) {
            return {
              changed: false,
              replaced: false,
              partial: isPartial(group?.snapshots() ?? []),
              state: snapshot(),
              created: false,
            };
          }
          // Starting a name the terminal-failed owner worker never
          // carried must fail fast instead of commit-and-no-op: the
          // owner workspace rides preserveWorkspaceCwds (correct —
          // relaunching it would resurrect the carried crash-looper on
          // a fresh budget), reconcile drops the new name's target
          // wholesale, and committing it anyway latches a phantom —
          // `currentlyEnabled` early-returns success on every retry
          // while nothing runs, and only a worker restart (which also
          // resurrects the carried channels) or a daemon restart
          // recovers it. Starting a CARRIED name is unaffected: that
          // workspace is not preserved, and the relaunch is the R8-18
          // recovery contract (R21-12).
          if (preserveWorkspaceCwds.has(owner.workspaceCwd)) {
            throw new ChannelWorkerControlError(
              'channel_worker_start_failed',
              `Cannot start channel "${owner.name}": workspace "${owner.workspaceCwd}" has a terminally failed channel worker (restart budget exhausted) that never carried it. Restart that workspace's channel worker to recover it, then start the channel again.`,
            );
          }
          const selection: ServeChannelSelection = {
            mode: 'names',
            names: selectionNames.includes(owner.name)
              ? [...selectionNames]
              : [...selectionNames, owner.name],
          };
          const targetGroups = await opts.resolveGroups(selection, 'set');
          assertRequiredOwner(targetGroups, owner);
          if (hardKilled) throw drainingError();
          return applySelection(
            selection,
            false,
            targetGroups,
            preserveWorkspaceCwds,
          );
        }
        // A dead-committed name (terminal-failed worker, excluded from
        // committedChannelNames) is still trimmed and re-committed: that
        // re-commit is what removes the ghost from the selection when
        // service.remove deletes its channel (R15-17).
        if (!currentlyEnabled && !selectionNames.includes(owner.name)) {
          return { changed: false, state: snapshot() };
        }
        const names = selectionNames.filter((name) => name !== owner.name);
        return names.length === 0
          ? stopSelectionNow()
          : applySelection(
              { mode: 'names', names },
              false,
              undefined,
              preserveWorkspaceCwds,
            );
      });
    },
    stopSelection() {
      if (draining) {
        return Promise.reject(drainingError());
      }
      return enqueue(stopSelectionNow);
    },
    reload() {
      if (draining) {
        return Promise.reject(drainingError());
      }
      return enqueue(async () => {
        if (!group || !committedSelection) {
          throw new ChannelWorkerControlError(
            'channel_worker_not_enabled',
            'This daemon has no channel worker to reload.',
          );
        }
        setTransition('reconciling', committedSelection);
        // Resolve AND commit the filtered selection: committing the
        // unfiltered selection with the trimmed groups desyncs the
        // bookkeeping — the next reload's owner lookup misses the
        // filtered name, the keep-fallback retains it, and the reconcile
        // force-starts the explicitly stopped channel (the resurrection
        // the filter exists to prevent). Committed state must stay
        // coherent with what was reconciled (R14).
        const filteredSelection = reloadSelection(committedSelection);
        let targetGroups: readonly ChannelWorkspaceGroup[];
        try {
          targetGroups = await opts.resolveGroups(filteredSelection, 'reload');
        } catch (error) {
          setTransition('idle');
          throw error;
        }
        if (hardKilled) throw drainingError();
        // A reload-op reconciles every committed name — including the
        // ghost names a terminal-failed worker still carries
        // (reloadSelection only filters persisted `stopped` records,
        // which budget exhaustion never writes). Without the preserve
        // guard the dead workspace's entry — which force:true skips the
        // unchanged gate for — is replaced by a fresh entry on a FRESH
        // restart budget: the same resurrection setChannelEnabled guards
        // against (R20-3), reached through the reload path. No
        // `carriesName` exception here: reload-ops toggle no name
        // (R21-11).
        const preserveWorkspaceCwds = new Set(
          group
            .snapshots()
            .filter(isTerminalFailedWorker)
            .map((worker) => worker.workspaceCwd),
        );
        try {
          await group.reconcile(targetGroups, {
            force: true,
            onRollingBack: () =>
              setTransition('rolling_back', committedSelection),
            ...(preserveWorkspaceCwds.size > 0
              ? { preserveWorkspaceCwds }
              : {}),
          });
        } catch (error) {
          setTransition('idle');
          throw classifyFailure(error, 'channel_worker_start_failed');
        }
        commit(
          filteredSelection,
          committedGroupsForApply(targetGroups, preserveWorkspaceCwds),
        );
        const snapshots = group.snapshots();
        return publicWorkerSnapshot(
          snapshots.find((worker) => worker.primary) ??
            snapshots[0] ?? { ...DISABLED_SNAPSHOT },
        );
      });
    },
    reloadWorkspace(workspaceCwd, name) {
      if (draining) {
        return Promise.reject(drainingError());
      }
      return enqueue(async () => {
        if (!group || !committedSelection) {
          throw new ChannelWorkerControlError(
            'channel_worker_not_enabled',
            'This daemon has no channel worker to reload.',
          );
        }
        setTransition('reconciling', committedSelection);
        // Resolve the filtered selection and commit its workspace-scoped
        // form (see reload(): the committed state must stay coherent with
        // what was reconciled, or the next reload resurrects the filtered
        // name) (R14). The scoping keeps names owned by PRESERVED other
        // workspaces committed — this reconcile cannot touch them
        // (forceWorkspaceCwd below), so trimming them here desyncs the
        // bookkeeping while their workers keep running (R17-3).
        const filteredSelection = reloadSelection(committedSelection);
        const scopedSelection = scopeCommitSelection(
          filteredSelection,
          workspaceCwd,
        );
        let targetGroups: readonly ChannelWorkspaceGroup[];
        try {
          targetGroups = await opts.resolveGroups(filteredSelection, 'reload');
          assertRequiredOwner(targetGroups, { name, workspaceCwd });
          if (
            targetGroups.filter(
              (target) => target.workspaceCwd === workspaceCwd,
            ).length !== 1 ||
            committedGroups.filter(
              (target) => target.workspaceCwd === workspaceCwd,
            ).length !== 1
          ) {
            throw new ChannelWorkerControlError(
              'channel_runtime_owner_mismatch',
              `Workspace "${workspaceCwd}" does not own a committed channel worker.`,
            );
          }
        } catch (error) {
          setTransition('idle');
          throw error;
        }
        if (hardKilled) throw drainingError();
        try {
          await group.reconcile(targetGroups, {
            forceWorkspaceCwd: workspaceCwd,
            onRollingBack: () =>
              setTransition('rolling_back', committedSelection),
          });
        } catch (error) {
          setTransition('idle');
          throw classifyFailure(error, 'channel_worker_start_failed');
        }
        const targetGroup = targetGroups.find(
          (target) => target.workspaceCwd === workspaceCwd,
        )!;
        const nextCommittedGroups = committedGroups.map((committedGroup) =>
          committedGroup.workspaceCwd === workspaceCwd
            ? targetGroup
            : committedGroup,
        );
        commit(scopedSelection, nextCommittedGroups);
        const worker = group
          .snapshots()
          .find((snapshot) => snapshot.workspaceCwd === workspaceCwd);
        if (!worker) {
          throw new ChannelWorkerControlError(
            'channel_runtime_owner_mismatch',
            `Workspace "${workspaceCwd}" has no channel worker after reload.`,
          );
        }
        return publicWorkerSnapshot(worker);
      });
    },
    state: snapshot,
    primarySnapshot: () =>
      publicWorkerSnapshot(
        group?.primarySnapshot() ?? { ...DISABLED_SNAPSHOT },
      ),
    snapshots: () => (group?.snapshots() ?? []).map(publicWorkerSnapshot),
    // Unstripped on purpose: see the interface doc. Ownership matching
    // must see the terminal carried sets that `publicWorkerSnapshot`
    // removes from the HTTP-facing accessors (R9-5/R9-6, R10-1).
    ownershipSnapshots: () => group?.snapshots() ?? [],
    committedChannelNames,
    enqueueWebhookTask(task) {
      if (!group || draining) {
        return Promise.reject(
          new ChannelWebhookEnqueueError(
            'channel_worker_unavailable',
            draining
              ? 'Daemon is shutting down.'
              : 'Channel worker is not running.',
          ),
        ) as ReturnType<ChannelWorkerGroup['enqueueWebhookTask']>;
      }
      return group.enqueueWebhookTask(task);
    },
    deliverChannelMessage(workspaceCwd, request) {
      if (!group || draining) {
        return Promise.reject(
          new ChannelDeliveryError(
            'channel_worker_unavailable',
            draining
              ? 'Daemon is shutting down.'
              : 'Channel worker is not running.',
          ),
        ) as ReturnType<ChannelWorkerGroup['deliverChannelMessage']>;
      }
      return group.deliverChannelMessage(request, workspaceCwd);
    },
    beginWorkspaceDrain(workspaceCwd) {
      workspaceDrains.add(workspaceCwd);
      group?.beginWorkspaceDrain(workspaceCwd);
    },
    cancelWorkspaceDrain(workspaceCwd) {
      workspaceDrains.delete(workspaceCwd);
      group?.cancelWorkspaceDrain(workspaceCwd);
    },
    workspaceActivity(workspaceCwd) {
      return group?.workspaceActivity(workspaceCwd) ?? 0;
    },
    removeWorkspace(workspaceCwd) {
      return enqueue(async () => {
        try {
          await group?.removeWorkspace(workspaceCwd);
          notify();
        } finally {
          workspaceDrains.delete(workspaceCwd);
        }
      });
    },
    restoreWorkspace(workspaceCwd) {
      return enqueue(async () => {
        await group?.restoreWorkspace(workspaceCwd);
        notify();
      });
    },
    refreshWorkspaces() {
      return enqueue(async () => {
        if (!group || !committedSelection) return;
        setTransition('reconciling', committedSelection);
        // Resolve AND commit the filtered selection (see reload(): the
        // committed state must stay coherent with what was reconciled,
        // or the next reload resurrects the filtered name). This is the
        // automatic attach/detach trigger (R14).
        const filteredSelection = reloadSelection(committedSelection);
        let targetGroups: readonly ChannelWorkspaceGroup[];
        try {
          targetGroups = await opts.resolveGroups(filteredSelection, 'reload');
        } catch (error) {
          setTransition('idle');
          throw error;
        }
        if (hardKilled) throw drainingError();
        // Same preserve guard as reload(): this routine attach/detach
        // trigger reconciles the committed selection ghost names
        // included, and without it the terminal workspace's entry is
        // replaced on a fresh restart budget (R21-11).
        const preserveWorkspaceCwds = new Set(
          group
            .snapshots()
            .filter(isTerminalFailedWorker)
            .map((worker) => worker.workspaceCwd),
        );
        try {
          if (preserveWorkspaceCwds.size > 0) {
            await group.reconcile(targetGroups, { preserveWorkspaceCwds });
          } else {
            await group.reconcile(targetGroups);
          }
        } catch (error) {
          setTransition('idle');
          throw classifyFailure(error, 'channel_worker_start_failed');
        }
        commit(
          filteredSelection,
          committedGroupsForApply(targetGroups, preserveWorkspaceCwds),
        );
      });
    },
    workerChanged: notify,
    shutdown() {
      draining = true;
      return enqueue(async () => {
        if (group || leaseReserved) setTransition('stopping');
        try {
          if (group) {
            await group.stop();
            group = undefined;
          }
          release();
        } catch (error) {
          setTransition('idle');
          throw classifyFailure(error, 'channel_worker_stop_failed');
        }
        commit(undefined, []);
      });
    },
    killAllSync() {
      draining = true;
      hardKilled = true;
      group?.killAllSync();
      pendingSelection = undefined;
      transition = 'idle';
      notify();
    },
  };
  return manager;
}
