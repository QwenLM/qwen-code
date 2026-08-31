/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { redactLogCredentials } from '@qwen-code/acp-bridge/logRedaction';
import { canonicalizeWorkspace } from '@qwen-code/acp-bridge/workspacePaths';
import {
  PairingStore,
  sanitizeLogText,
  type PairingRequest,
} from '@qwen-code/channel-base';
import { ChannelStateStore } from '../commands/channel/channel-state-store.js';
import { resolveChannelCwd } from '../commands/channel/channel-cwd.js';
import { getPlugin } from '../commands/channel/channel-registry.js';
import { daemonChannelRuntimeStatePath } from '../commands/channel/runtime.js';
import type {
  ChannelSecretUpdate,
  ChannelSettingsMutationOptions,
  ChannelSettingsSnapshot,
  ChannelSettingsUpsertOptions,
  WorkspaceChannelSettingsStore,
} from './channel-settings-store.js';
import { isAllChannelSelectionName } from './channel-selection.js';
import { normalizeWorkerDiagnostic } from './channel-worker-diagnostics.js';
import type { ChannelWorkerGroupSnapshot } from './channel-worker-group.js';
import {
  ChannelWorkerControlError,
  isTerminalFailedWorker,
} from './channel-worker-manager.js';
import type {
  ChannelWorkerControlState,
  ChannelWorkerManager,
  ChannelWorkerRequiredOwner,
} from './channel-worker-manager.js';
import type { ChannelWorkerSnapshot } from './channel-worker-supervisor.js';
import { recordChannelsStopped } from './routes/workspace-channel-control.js';

export interface ChannelRuntimeState {
  state: 'stopped' | 'starting' | 'connected' | 'partial' | 'error';
  lastError?: string;
}

export interface ChannelSecretState {
  present: boolean;
  source?: 'literal' | 'environment';
}

export interface ChannelInstanceSnapshot {
  name: string;
  config: Record<string, unknown>;
  secrets: Record<string, ChannelSecretState>;
  startsWithServe: boolean;
  runtime: ChannelRuntimeState;
}

export interface DaemonChannelsSnapshot {
  revision: string;
  instances: Record<string, ChannelInstanceSnapshot>;
}

export interface ChannelUpsertRequest {
  expectedRevision: string;
  config: Record<string, unknown> & { type: string };
  secrets?: Record<string, ChannelSecretUpdate>;
}

export type RevisionRequest = ChannelSettingsMutationOptions;

export interface ChannelStartupRequest extends RevisionRequest {
  enabled: boolean;
}

export interface ChannelMutationResult {
  snapshot: DaemonChannelsSnapshot;
  instance: ChannelInstanceSnapshot;
}

export interface ChannelStopResult extends ChannelMutationResult {
  /**
   * Present (and `false`) only when the stop succeeded but its `stopped`
   * record failed to persist: a later `--channel all` restart may bring
   * the channel back, so callers claiming a durable stop must surface the
   * failure. Absent on the happy path (#8975).
   */
  statePersisted?: boolean;
  /**
   * Present alongside `statePersisted: false`: the workspaces whose
   * state write failed. A bare boolean gives the client no retry handle
   * — a re-issued stop takes the `{changed: false}` path and can never
   * re-record another workspace's torn-down set, so the loss must be
   * attributable for a targeted retry (R14).
   */
  statePersistFailedWorkspaces?: string[];
}

export interface ChannelStartResult extends ChannelMutationResult {
  /**
   * Present (and `false`) only when the start succeeded but the commit
   * failed to clear the channel's persisted `stopped` record: the
   * surviving record lets the next reload-op resolve filter the channel
   * out and permanently trim the committed selection, so callers claiming
   * a durable start must surface the failure. Absent on the happy path
   * (#8975, R16-2).
   */
  statePersisted?: boolean;
  /**
   * Present alongside `statePersisted: false`: the workspaces whose
   * record clear failed, so a retry can be targeted (R14/R16-2).
   */
  statePersistFailedWorkspaces?: string[];
}

export interface ChannelRemoveResult extends ChannelMutationResult {
  /**
   * Present (and `false`) only when the removal's stop succeeded but its
   * `stopped` record failed to persist: a later `--channel all` restart
   * may bring the removed channels back, and a re-issued remove finds the
   * group already cleared so it can never re-record — callers must
   * surface the failure. Absent on the happy path (#8975, R17-2).
   */
  statePersisted?: boolean;
  /**
   * Present alongside `statePersisted: false`: the workspaces whose
   * state write failed, so a retry can be targeted (R14/R17-2).
   */
  statePersistFailedWorkspaces?: string[];
}

export interface ChannelPairingRequestsSnapshot {
  requests: PairingRequest[];
}

export interface ChannelPairingApprovalResult
  extends ChannelPairingRequestsSnapshot {
  approved: PairingRequest;
}

export interface ChannelPairingApprovalsSnapshot {
  senderIds: string[];
  groupIds: string[];
}

export interface ChannelPairingApprovalSubject {
  type: 'user' | 'group';
  id: string;
}

export interface ChannelPairingRevocationResult
  extends ChannelPairingApprovalsSnapshot {
  revoked: string;
}

export interface ChannelManagementService {
  list(): Promise<DaemonChannelsSnapshot>;
  upsert(
    name: string,
    request: ChannelUpsertRequest,
  ): Promise<ChannelMutationResult>;
  remove(name: string, request: RevisionRequest): Promise<ChannelRemoveResult>;
  setStartup(
    name: string,
    request: ChannelStartupRequest,
  ): Promise<ChannelMutationResult>;
  start(name: string): Promise<ChannelStartResult>;
  stop(name: string): Promise<ChannelStopResult>;
  restart(name: string): Promise<ChannelMutationResult>;
  pairingRequests(name: string): Promise<ChannelPairingRequestsSnapshot>;
  approvePairing(
    name: string,
    code: string,
  ): Promise<ChannelPairingApprovalResult>;
  pairingApprovals(name: string): Promise<ChannelPairingApprovalsSnapshot>;
  revokePairingApproval(
    name: string,
    subject: ChannelPairingApprovalSubject,
  ): Promise<ChannelPairingRevocationResult>;
}

interface ChannelManagementSettingsStore {
  snapshot(): ChannelSettingsSnapshot;
  upsert(
    name: string,
    options: ChannelSettingsUpsertOptions,
  ): Promise<ChannelSettingsSnapshot>;
  remove(
    name: string,
    options: ChannelSettingsMutationOptions,
  ): Promise<ChannelSettingsSnapshot>;
  setStartupNames(
    names: readonly string[],
    options: ChannelSettingsMutationOptions,
  ): Promise<ChannelSettingsSnapshot>;
}

export interface ChannelManagementWorkerManager {
  committedChannelNames(): string[];
  state(): ChannelWorkerControlState;
  /**
   * Unstripped worker snapshots for ownership matching: `state()` strips
   * the terminal carried sets (`lastRequestedChannels` et al.) before
   * they ride HTTP, but a crash-dead worker's channels live ONLY there —
   * matching against `state().workers` makes those predicates dead and
   * the R9-5 recovery route unreachable (R10-1).
   */
  ownershipSnapshots(): ChannelWorkerGroupSnapshot[];
  setChannelEnabled(
    owner: ChannelWorkerRequiredOwner,
    enabled: boolean,
  ): Promise<{
    changed: boolean;
    /**
     * Present when the disable routed through the whole-selection stop
     * (disabling the LAST committed channel): the per-workspace tear-down
     * set captured at stop time. Callers persisting `stopped` state
     * (#8975) must record from here instead of the single name.
     */
    stoppedChannels?: Array<{ workspaceCwd: string; names: string[] }>;
    /**
     * Present (and `false`) only when the commit failed to clear a
     * committed name's persisted `stopped` record (`clearRecordsForCommit`
     * → `clearLossFields`): the surviving record lets the next reload-op
     * resolve filter the name out and permanently trim the committed
     * selection. Callers must surface the loss — dropping it reports a
     * durable success that does not hold (R16-2).
     */
    statePersisted?: boolean;
    /**
     * Present alongside `statePersisted: false`: the canonical workspaces
     * whose record clear failed, so a retry can be targeted (R14/R16-2).
     */
    statePersistFailedWorkspaces?: string[];
  }>;
  reloadWorkspace(
    workspaceCwd: string,
    name: string,
  ): Promise<ChannelWorkerSnapshot>;
}

export interface CreateChannelManagementServiceOptions {
  workspaceCwd: string;
  store: ChannelManagementSettingsStore | WorkspaceChannelSettingsStore;
  manager: ChannelManagementWorkerManager | ChannelWorkerManager;
}

export class ChannelManagementError extends Error {
  /**
   * Set when a remove()'s settings write fails after its stop already
   * computed a stop-record loss: the rethrown error must carry the loss,
   * or the client gets a bare settings error with no retry handle and a
   * retried remove can never re-record (R20-4). Same surface as
   * ChannelWorkerControlError's loss fields (#8975).
   */
  statePersisted?: boolean;
  /**
   * Present alongside `statePersisted: false`: the workspaces whose
   * stop-record write failed before the settings write threw (R20-4).
   */
  statePersistFailedWorkspaces?: string[];
  constructor(
    readonly code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ChannelManagementError';
  }
}

function diagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeLogText(
    redactLogCredentials(normalizeWorkerDiagnostic(message)),
    512,
  );
}

function usesEnvironment(value: unknown): boolean {
  return typeof value === 'string' && /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

export function createChannelManagementService(
  opts: CreateChannelManagementServiceOptions,
): ChannelManagementService {
  const diagnostics = new Map<string, string>();
  let mutationTail = Promise.resolve();

  const inMutationLane = <T>(mutation: () => Promise<T>): Promise<T> => {
    const result = mutationTail.then(mutation, mutation);
    mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const assertExpectedRevision = (
    snapshot: ChannelSettingsSnapshot,
    expectedRevision: string,
  ): void => {
    if (snapshot.revision !== expectedRevision) {
      throw new ChannelManagementError(
        'channel_settings_conflict',
        'Channel settings changed; reload before trying again.',
      );
    }
  };

  // Match on the UNSTRIPPED snapshots: `state()` strips the terminal
  // carried sets before they ride HTTP, and a budget-exhausted worker's
  // channels can live only in `lastRequestedChannels` — reading them
  // through `state().workers` silently drops the predicate (R10-1).
  const workerFor = (name: string) => {
    const matches = opts.manager
      .ownershipSnapshots()
      .filter(
        (worker) =>
          worker.adapters?.some((adapter) => adapter.name === name) ||
          worker.requestedChannels?.includes(name) ||
          worker.lastRequestedChannels?.includes(name) ||
          worker.channels.includes(name),
      );
    return matches;
  };

  const workspaceCommittedNames = (): string[] =>
    opts.manager
      .committedChannelNames()
      .filter((name) =>
        workerFor(name).some((w) => w.workspaceCwd === opts.workspaceCwd),
      );

  // Throw-safe canonical form for guard comparisons: canonicalizeWorkspace
  // rethrows non-ENOENT fs errors by design, but on this stop path a
  // degraded path must degrade the guard to "no matching worker" instead of
  // escaping stop() as an opaque 500 with no `stopped` record (#8975).
  const canonicalForGuard = (workspaceCwd: string): string => {
    try {
      return canonicalizeWorkspace(workspaceCwd);
    } catch {
      return path.resolve(workspaceCwd);
    }
  };

  // A worker without a committed ready report (no `requestedChannels`) is
  // still starting; a mode-`all` worker in that window may connect any
  // configured channel, so per-channel stops cannot be confirmed (#8975).
  // The ready report is not the only window opener: a crash-restarting
  // mode-`all` worker carries its last committed names across the relaunch
  // (`requestedChannels` defined) while `channels` is still the `['all']`
  // launch placeholder — the same hazard, so the guard keys on the
  // placeholder too. A permanently failed worker (restart budget exhausted,
  // no restart scheduled) will never connect anything again, so it is not
  // "starting" and stops may be recorded against it.
  const workspaceWorkerStarting = (): boolean => {
    const target = canonicalForGuard(opts.workspaceCwd);
    return opts.manager.state().workers.some(
      (worker) =>
        canonicalForGuard(worker.workspaceCwd) === target &&
        // Shared predicate with the manager's committed-names exclusion
        // and `terminalFailedWorkerFor` below — one definition, three
        // sites (R14).
        !isTerminalFailedWorker(worker) &&
        (worker.requestedChannels === undefined ||
          (worker.state === 'starting' &&
            worker.channels.some(isAllChannelSelectionName))),
    );
  };

  // A crash-dead worker in this workspace (restart budget exhausted, no
  // restart scheduled) is excluded from committedChannelNames() so a
  // per-channel start relaunches it (#8975 R8-18) — but its channels must
  // not REPORT as a clean user stop: the async crash never populates
  // diagnostics, and the budget error on the worker is the only trace of
  // what happened (R9-5). Match on the terminal carried sets too: a
  // never-connected channel is absent from `channels` on the terminal
  // snapshot, and `requestedChannels` is dropped there (R9-6).
  const terminalFailedWorkerFor = (name: string) => {
    const target = canonicalForGuard(opts.workspaceCwd);
    const named = workerFor(name).find(
      (worker) =>
        canonicalForGuard(worker.workspaceCwd) === target &&
        isTerminalFailedWorker(worker),
    );
    if (named) return named;
    // A mode-`all` worker that went terminal carrying NO channel names —
    // ready with zero channels (the zero-channel degrade) then
    // crash-exhausted its budget: `{state:'failed', channels:[],
    // lastRequestedChannels:[], requestedChannels/adapters dropped}` —
    // matches no name in workerFor's four clauses, but it is still the
    // owner of every configured name in its workspace. Without this
    // fallback the crash launders to a bare `stopped` runtime state
    // (R9-5), start() falls into setChannelEnabled and collapses the
    // mode-`all` commitment to a names-mode single-channel selection,
    // and restart() rejects channel_worker_not_enabled, killing the
    // recovery route (R15-16). A names-mode worker cannot reach this
    // shape: it launches with at least one requested name, and the
    // terminal snapshot carries the attempted set in
    // `lastRequestedChannels` (R9-6) — so an empty carry set plus an
    // empty/`['all']`-placeholder channel list identifies the dead
    // mode-`all` worker.
    return opts.manager
      .ownershipSnapshots()
      .find(
        (worker) =>
          canonicalForGuard(worker.workspaceCwd) === target &&
          isTerminalFailedWorker(worker) &&
          !worker.requestedChannels &&
          !worker.adapters &&
          (worker.lastRequestedChannels?.length ?? 0) === 0 &&
          (worker.channels.length === 0 ||
            worker.channels.some(isAllChannelSelectionName)),
      );
  };

  const assertOwnedRuntime = (name: string): void => {
    if (!workspaceCommittedNames().includes(name)) return;
    const workers = workerFor(name).filter(
      (worker) => worker.workspaceCwd === opts.workspaceCwd,
    );
    if (workers.length !== 1) {
      throw new ChannelManagementError(
        'channel_runtime_owner_mismatch',
        `Channel "${name}" does not have one confirmed runtime owner in this workspace.`,
      );
    }
  };

  // An explicit by-name start/restart must clear any persisted `stopped`
  // record first: the recovery reconcile can relaunch a mode-`all`
  // worker, whose restore filter skips exactly the channels carrying a
  // `stopped` record — without the clear, the reconcile resolves success
  // while the channel stays down. Read first so the failure is precise:
  // when the record is not `stopped` there is nothing to clear and a
  // failing write must not block a recovery that does not depend on it;
  // when it IS `stopped` and the clear fails, fail loudly instead of
  // reporting a start the relaunched worker will not honor (#8975).
  const clearStoppedRecord = (name: string): void => {
    const store = new ChannelStateStore(
      daemonChannelRuntimeStatePath(canonicalForGuard(opts.workspaceCwd)),
    );
    // Fail-closed pre-read: `readAll()` swallows every non-ENOENT read
    // failure as an empty map, so an unknown-content read would degrade
    // to "record is not stopped" and start/restart would proceed without
    // clearing — defeating this function's fail-loud invariant exactly
    // when the disk is degraded. `prune([])` reads through the same
    // fail-closed path the writers use (throws on non-ENOENT read
    // failures, treats missing/corrupt files as empty) without writing
    // (R15-2).
    let states: Record<string, 'active' | 'stopped'>;
    try {
      states = store.prune([]);
    } catch {
      throw new ChannelManagementError(
        'channel_state_persist_failed',
        `Channel "${name}" cannot be started: its persisted state could not be read, so a stopped record could not be ruled out and a whole-selection worker may skip it on relaunch.`,
      );
    }
    if (states[name] !== 'stopped') return;
    if (!store.trySet(name, 'active')) {
      throw new ChannelManagementError(
        'channel_state_persist_failed',
        `Channel "${name}" cannot be started: its persisted stopped record could not be cleared, so a whole-selection worker would skip it on relaunch.`,
      );
    }
  };

  // Persist the torn-down set AND the requested name's own record. The
  // carried tear-down set only includes channels that CONNECTED at least
  // once (stoppedChannelsByWorkspace filters on the connected set), so a
  // requested channel that never connected is absent from it even when
  // the set is defined — and the single-name fallback was structurally
  // unreachable whenever the carried set existed. Without the
  // supplementary write the requested channel gets no `stopped` record
  // and the next `--channel all` restarts it — the exact stop this call
  // performed is silently undone (#8975, R14). Returns the workspaces
  // whose write FAILED (empty = every record persisted).
  const recordStopForName = (
    name: string,
    carried:
      | ReadonlyArray<{
          readonly workspaceCwd: string;
          readonly names: readonly string[];
        }>
      | undefined,
  ): string[] => {
    const failed = carried ? recordChannelsStopped(carried) : [];
    const target = canonicalForGuard(opts.workspaceCwd);
    const carriedHere = (carried ?? []).some(
      (entry) =>
        canonicalForGuard(entry.workspaceCwd) === target &&
        entry.names.includes(name),
    );
    if (carriedHere) return failed;
    if (
      !new ChannelStateStore(daemonChannelRuntimeStatePath(target)).trySet(
        name,
        'stopped',
      ) &&
      !failed.includes(target)
    ) {
      failed.push(target);
    }
    return failed;
  };

  const runtimeFor = (name: string): ChannelRuntimeState => {
    const retainedError = diagnostics.get(name);
    if (retainedError) return { state: 'error', lastError: retainedError };
    if (!workspaceCommittedNames().includes(name)) {
      // A crash-dead (budget-exhausted) worker's channel is not committed,
      // but reporting it as a bare `stopped` hides the crash: surface the
      // worker's budget/failure diagnostic instead (R9-5).
      const deadWorker = terminalFailedWorkerFor(name);
      if (deadWorker) {
        return {
          state: 'error',
          ...(deadWorker.error
            ? { lastError: diagnostic(deadWorker.error) }
            : {}),
        };
      }
      return { state: 'stopped' };
    }
    const state = opts.manager.state();
    const workers = workerFor(name).filter(
      (worker) => worker.workspaceCwd === opts.workspaceCwd,
    );
    if (workers.length !== 1) {
      return {
        state: 'error',
        lastError: 'Channel runtime owner is unknown or ambiguous.',
      };
    }
    const worker = workers[0]!;
    const adapter = worker.adapters?.find((item) => item.name === name);
    if (adapter?.state === 'connected') return { state: 'connected' };
    if (adapter?.state === 'error') {
      return {
        state: 'error',
        ...(adapter.error ? { lastError: diagnostic(adapter.error) } : {}),
      };
    }
    if (
      adapter?.state === 'starting' ||
      state.transition === 'starting' ||
      state.transition === 'reconciling'
    ) {
      return { state: 'starting' };
    }
    if (worker.state === 'running') return { state: 'partial' };
    return {
      state: 'error',
      ...(worker.error ? { lastError: diagnostic(worker.error) } : {}),
    };
  };

  const instanceFrom = async (
    name: string,
    rawConfig: Record<string, unknown>,
    startupNames: readonly string[],
  ): Promise<ChannelInstanceSnapshot> => {
    const type = typeof rawConfig['type'] === 'string' ? rawConfig['type'] : '';
    const plugin = type ? await getPlugin(type) : undefined;
    if (!plugin?.management) {
      return {
        name,
        config: type ? { type } : {},
        secrets: {},
        startsWithServe:
          startupNames.some(isAllChannelSelectionName) ||
          startupNames.includes(name),
        runtime: runtimeFor(name),
      };
    }
    const secretKeys = new Set(
      plugin.management.fields
        .filter((field) => field.kind === 'secret')
        .map((field) => field.key),
    );
    const config: Record<string, unknown> = {};
    const secrets: Record<string, ChannelSecretState> = {};
    for (const [key, value] of Object.entries(rawConfig)) {
      if (!secretKeys.has(key)) {
        config[key] = value;
        continue;
      }
      secrets[key] = {
        present: value !== undefined,
        ...(value !== undefined
          ? { source: usesEnvironment(value) ? 'environment' : 'literal' }
          : {}),
      };
    }
    for (const key of secretKeys) {
      secrets[key] ??= { present: false };
    }
    return {
      name,
      config,
      secrets,
      startsWithServe:
        startupNames.some(isAllChannelSelectionName) ||
        startupNames.includes(name),
      runtime: runtimeFor(name),
    };
  };

  const listFrom = async (
    persisted: ChannelSettingsSnapshot,
  ): Promise<DaemonChannelsSnapshot> => {
    const entries = await Promise.all(
      Object.entries(persisted.channels).map(
        async ([name, config]) =>
          [
            name,
            await instanceFrom(name, config, persisted.startupNames),
          ] as const,
      ),
    );
    return {
      revision: persisted.revision,
      instances: Object.fromEntries(entries),
    };
  };

  const resultFor = async (
    name: string,
    persisted = opts.store.snapshot(),
  ): Promise<ChannelMutationResult> => {
    const snapshot = await listFrom(persisted);
    const instance = Object.hasOwn(snapshot.instances, name)
      ? snapshot.instances[name]!
      : ({
          name,
          config: {},
          secrets: {},
          startsWithServe: false,
          runtime: runtimeFor(name),
        } satisfies ChannelInstanceSnapshot);
    return { snapshot, instance };
  };

  const stopChannel = (
    name: string,
  ): ReturnType<ChannelManagementWorkerManager['setChannelEnabled']> =>
    opts.manager.setChannelEnabled(
      { name, workspaceCwd: opts.workspaceCwd },
      false,
    );

  const assertManageableInstanceName = (name: string): void => {
    if (isAllChannelSelectionName(name)) {
      throw new ChannelManagementError(
        'invalid_channel_instance_name',
        'Channel instance name "all" is reserved for startup selection.',
      );
    }
  };

  const assertWorkspaceConfig = (config: Record<string, unknown>): void => {
    const rawCwd = config['cwd'];
    if (typeof rawCwd !== 'string') return;
    const workspaceCwd = canonicalizeWorkspace(opts.workspaceCwd);
    const channelCwd = canonicalizeWorkspace(
      resolveChannelCwd(rawCwd, workspaceCwd),
    );
    if (channelCwd !== workspaceCwd) {
      throw new ChannelManagementError(
        'channel_workspace_mismatch',
        'Channel workspace must match the selected workspace.',
      );
    }
  };

  const pairingStoreFor = (name: string): PairingStore => {
    assertManageableInstanceName(name);
    const channels = opts.store.snapshot().channels;
    if (!Object.hasOwn(channels, name)) {
      throw new ChannelManagementError(
        'channel_instance_not_found',
        `Channel "${name}" is not configured in this workspace.`,
      );
    }
    const config = channels[name]!;
    assertWorkspaceConfig(config);
    if (
      config['senderPolicy'] !== 'pairing' &&
      config['groupPolicy'] !== 'pairing'
    ) {
      throw new ChannelManagementError(
        'channel_pairing_not_enabled',
        `Channel "${name}" does not use pairing mode.`,
      );
    }
    return new PairingStore(name, opts.workspaceCwd);
  };

  const service: ChannelManagementService = {
    async list() {
      return listFrom(opts.store.snapshot());
    },
    async upsert(name, request) {
      assertManageableInstanceName(name);
      assertWorkspaceConfig(request.config);
      const active = workspaceCommittedNames().includes(name);
      if (active) assertOwnedRuntime(name);
      const persisted = await opts.store.upsert(name, request);
      diagnostics.delete(name);
      if (active) {
        // Mirror the start/restart entry points: the reload resolves
        // through the stopped-record filter, which drops names carrying a
        // persisted `stopped` record — with a surviving record (the
        // statePersisted:false loss mode this PR models) the filtered
        // resolve throws channel_runtime_owner_mismatch and the fallback
        // below STOPS the live channel a config update should only
        // reconfigure. Clear the record first so the reload sees the
        // channel as startable (#8975, R17-5).
        clearStoppedRecord(name);
        try {
          await opts.manager.reloadWorkspace(opts.workspaceCwd, name);
        } catch (error) {
          diagnostics.set(name, diagnostic(error));
          try {
            await stopChannel(name);
          } catch {
            // Keep the reload diagnostic when best-effort cleanup also fails.
          }
        }
      }
      return resultFor(name, persisted);
    },
    async remove(name, request) {
      assertManageableInstanceName(name);
      const current = opts.store.snapshot();
      if (!Object.hasOwn(current.channels, name)) {
        throw new ChannelManagementError(
          'channel_instance_not_found',
          `Channel "${name}" is not configured in this workspace.`,
        );
      }
      assertWorkspaceConfig(current.channels[name]!);
      assertExpectedRevision(current, request.expectedRevision);
      // Mirror stop()'s starting-window guard (R20-2): during a mode-`all`
      // worker's pre-ready or crash-restart window the stop gate below
      // finds nothing — committedChannelNames() skips the `['all']`
      // placeholder and every workerFor clause misses a pre-ready snapshot
      // — so the gate would skip stopChannel and the deletion would commit
      // while the in-flight worker connects the removed channel: a live
      // channel with no config, unmanageable (stop/remove throw
      // channel_instance_not_found) until a global reconcile. stop() in the
      // identical state rejects with 409 channel_worker_starting ("Report a
      // failure rather than reporting a success that does not hold"); a
      // name that IS committed still routes through the confirmable stop
      // below, so only uncommitted names are rejected.
      if (
        workspaceWorkerStarting() &&
        !workspaceCommittedNames().includes(name)
      ) {
        throw new ChannelManagementError(
          'channel_worker_starting',
          `Channel "${name}" cannot be removed while its workspace worker is still starting; retry once the worker reports ready.`,
        );
      }
      // Gate on the committed selection's source of truth, not only the
      // filtered view: a terminal-failed worker's names are excluded from
      // workspaceCommittedNames() (the start/recovery contract), but the
      // worker still owns them — skipping the stop left the removed name
      // a ghost in the committed selection, failing every later reload-op
      // resolve until daemon restart (R15-17). The disable re-commits the
      // trimmed selection, which is what removes the ghost.
      let stopPersistFailedWorkspaces: string[] = [];
      if (
        workspaceCommittedNames().includes(name) ||
        workerFor(name).some((w) => w.workspaceCwd === opts.workspaceCwd)
      ) {
        assertOwnedRuntime(name);
        try {
          const stopped = await stopChannel(name);
          // Removing the LAST committed channel empties the selection and
          // routes through the whole-selection stop, whose result carries
          // the per-workspace tear-down set. Persist it like stop()'s
          // success path, both stop() catch branches and the DELETE route
          // do, or the removed channels resurrect on the next `--channel
          // all` start (#8975, R16-16). The persistence result is
          // surfaced on the response like stop()'s success path does:
          // dropping it returns a clean 200 with no loss signal and no
          // retry handle — a re-issued remove finds the group already
          // cleared and can never re-record, so the next `--channel all`
          // resurrects exactly the channels #8975 must keep stopped
          // (R17-2). Union BOTH loss sources exactly like stop()'s
          // success path (R17-4): this name's own record write AND the
          // manager's disable result — a disable routed through the
          // names-mode commit clears committed names' persisted `stopped`
          // records, and a clear failure rides `statePersisted` /
          // `statePersistFailedWorkspaces` on the disable result. Reading
          // only recordStopForName's own write failures drops that
          // signal, so a sibling workspace's surviving record trims the
          // committed selection on the next reload-op with no loss
          // signal ever emitted (R18-2).
          stopPersistFailedWorkspaces = [
            ...new Set([
              ...(stopped.statePersisted === false
                ? (stopped.statePersistFailedWorkspaces ?? [])
                : []),
              ...recordStopForName(name, stopped.stoppedChannels),
            ]),
          ];
        } catch (error) {
          // A failed stop can still have torn down channels (lease release
          // can fail after a successful tear-down): the manager carries the
          // torn-down set on the error — persist it before rethrowing,
          // mirroring stop()'s catch branch (#8975, R16-16).
          if (
            error instanceof ChannelWorkerControlError &&
            error.stoppedChannels
          ) {
            const failedWorkspaces = recordStopForName(
              name,
              error.stoppedChannels,
            );
            if (failedWorkspaces.length > 0) {
              error.statePersisted = false;
              error.statePersistFailedWorkspaces = failedWorkspaces;
            }
          } else if (
            error instanceof ChannelWorkerControlError &&
            error.code === 'channel_worker_start_failed' &&
            error.rolledBack === false
          ) {
            // Mirror stop()'s SECOND catch branch: the per-channel
            // disable via applySelection stopped this channel's worker
            // entry, the replacement selection failed to start, and the
            // rollback restart also failed — the channel is confirmed
            // dead, but this error shape carries no stoppedChannels set.
            // Record the stop anyway (same restoredWorkspaces guard as
            // stop(): an entry restored in THIS workspace is relaunching,
            // so a `stopped` record would skip a live channel), or the
            // failed DELETE leaves the channel configured and the next
            // `--channel all` restarts it — silently undoing the
            // tear-down the DELETE performed (#8975, R17-6).
            const restoredHere = (error.restoredWorkspaces ?? []).some(
              (workspaceCwd) =>
                canonicalForGuard(workspaceCwd) ===
                canonicalForGuard(opts.workspaceCwd),
            );
            if (!restoredHere) {
              const failedWorkspaces = recordStopForName(name, undefined);
              if (failedWorkspaces.length > 0) {
                error.statePersisted = false;
                error.statePersistFailedWorkspaces = failedWorkspaces;
              }
            }
          }
          throw error;
        }
      }
      // The settings write sits OUTSIDE the stop try/catch above, but the
      // stop has already cleared the group and committed the trimmed
      // selection: when this write throws, the computed loss must ride the
      // rethrown error — a bare settings error leaves the client no retry
      // handle, and a retried remove skips the whole stop block (nothing
      // left to stop) and returns clean success, so the loss is never
      // re-recordable and the next `--channel all` resurrects the sibling
      // workspace's explicitly stopped channels (the #8975 regression).
      // Mirror stopChannel's catch branches; wrapping with the persist
      // failure code keeps the loss visible in the HTTP error body (R20-4).
      let persisted: ChannelSettingsSnapshot;
      try {
        persisted = await opts.store.remove(name, request);
      } catch (error) {
        if (stopPersistFailedWorkspaces.length > 0) {
          const wrapped = new ChannelManagementError(
            'channel_state_persist_failed',
            `Channel "${name}" removal stopped its workers but failed to persist the settings deletion: ${diagnostic(error)}`,
            { cause: error },
          );
          wrapped.statePersisted = false;
          wrapped.statePersistFailedWorkspaces = stopPersistFailedWorkspaces;
          throw wrapped;
        }
        throw error;
      }
      diagnostics.delete(name);
      return {
        ...(await resultFor(name, persisted)),
        // Only on failure: the happy-path response shape stays unchanged,
        // mirroring stop()'s success path (R17-2).
        ...(stopPersistFailedWorkspaces.length === 0
          ? {}
          : {
              statePersisted: false,
              statePersistFailedWorkspaces: stopPersistFailedWorkspaces,
            }),
      };
    },
    async setStartup(name, request) {
      assertManageableInstanceName(name);
      const current = opts.store.snapshot();
      if (!Object.hasOwn(current.channels, name)) {
        throw new ChannelManagementError(
          'channel_instance_not_found',
          `Channel "${name}" is not configured in this workspace.`,
        );
      }
      assertWorkspaceConfig(current.channels[name]!);
      const startsAll = current.startupNames.some(isAllChannelSelectionName);
      if (startsAll && request.enabled) {
        assertExpectedRevision(current, request.expectedRevision);
        return resultFor(name, current);
      }
      const startupNames = startsAll
        ? Object.keys(current.channels).filter(
            (item) => !isAllChannelSelectionName(item) && item !== name,
          )
        : request.enabled
          ? current.startupNames.includes(name)
            ? current.startupNames
            : [...current.startupNames, name]
          : current.startupNames.filter((item) => item !== name);
      const persisted = await opts.store.setStartupNames(startupNames, {
        expectedRevision: request.expectedRevision,
      });
      return resultFor(name, persisted);
    },
    async start(name) {
      assertManageableInstanceName(name);
      const persisted = opts.store.snapshot();
      if (!Object.hasOwn(persisted.channels, name)) {
        throw new ChannelManagementError(
          'channel_instance_not_found',
          `Channel "${name}" is not configured in this workspace.`,
        );
      }
      assertWorkspaceConfig(persisted.channels[name]!);
      // A crash-dead (budget-exhausted) worker's channel is not
      // committed, so the enable path would rebuild the GLOBAL selection
      // from the filtered committed names: with a mode-`all` commitment
      // that collapses it to names-mode — healthy workspaces' selections
      // are rewritten and their live workers stopped+relaunched, the dead
      // worker's OTHER channels are excluded until daemon restart, and
      // the replacement entry launders the crash diagnostic into a clean
      // `stopped`. Route through the workspace-scoped reload restart()
      // uses instead: it replaces only the dead entry, resets the budget,
      // and keeps the committed selection intact (#8975).
      if (
        !workspaceCommittedNames().includes(name) &&
        terminalFailedWorkerFor(name)
      ) {
        clearStoppedRecord(name);
        try {
          await opts.manager.reloadWorkspace(opts.workspaceCwd, name);
          diagnostics.delete(name);
        } catch (error) {
          diagnostics.set(name, diagnostic(error));
          throw error;
        }
        return resultFor(name, persisted);
      }
      const enabled: Awaited<
        ReturnType<ChannelManagementWorkerManager['setChannelEnabled']>
      > = await opts.manager.setChannelEnabled(
        { name, workspaceCwd: opts.workspaceCwd },
        true,
      );
      diagnostics.delete(name);
      return {
        ...(await resultFor(name, persisted)),
        // Only on failure: the happy-path response shape stays unchanged,
        // but when the commit failed to clear the channel's persisted
        // `stopped` record the loss must reach the client — the surviving
        // record lets the next reload-op resolve filter the explicitly
        // started channel out and permanently trim the committed
        // selection, and the `{changed: false}` early-return on a retried
        // start can never re-clear it. Mirrors stop()'s ChannelStopResult
        // shape (#8975, R16-2).
        ...(enabled.statePersisted === false
          ? {
              statePersisted: false,
              statePersistFailedWorkspaces:
                enabled.statePersistFailedWorkspaces ?? [],
            }
          : {}),
      };
    },
    async stop(name) {
      assertManageableInstanceName(name);
      const persisted = opts.store.snapshot();
      if (!Object.hasOwn(persisted.channels, name)) {
        throw new ChannelManagementError(
          'channel_instance_not_found',
          `Channel "${name}" is not configured in this workspace.`,
        );
      }
      assertWorkspaceConfig(persisted.channels[name]!);
      let result: Awaited<
        ReturnType<ChannelManagementWorkerManager['setChannelEnabled']>
      >;
      try {
        result = await opts.manager.setChannelEnabled(
          { name, workspaceCwd: opts.workspaceCwd },
          false,
        );
      } catch (error) {
        // A failed stop can still have torn down channels: disabling the
        // last committed channel routes through the whole-selection stop,
        // whose lease release can fail after a successful tear-down. The
        // manager carries the torn-down set on the error; persist it like
        // the whole-selection route does, or those channels resurrect on
        // the next `--channel all` start (#8975).
        if (
          error instanceof ChannelWorkerControlError &&
          error.stoppedChannels
        ) {
          // Aggregate the persistence result via the DELETE route's
          // recordChannelsStopped and surface the loss on the rethrown
          // error: under the same disk condition that failed the lease
          // release, the state write can also fail, and the client gets a
          // 500 with no retry handle (the group is already cleared) — the
          // management route's error body must carry the loss, or the
          // torn-down channels silently resurrect on `--channel all`
          // (#8975). Carry the failed workspaces too, so a retry can be
          // targeted at the affected channels (R14). recordStopForName
          // also writes the requested name's own record when the carried
          // set exists but excludes it (a never-connected channel) (R14).
          const failedWorkspaces = recordStopForName(
            name,
            error.stoppedChannels,
          );
          if (failedWorkspaces.length > 0) {
            error.statePersisted = false;
            error.statePersistFailedWorkspaces = failedWorkspaces;
          }
        } else if (
          error instanceof ChannelWorkerControlError &&
          error.code === 'channel_worker_start_failed' &&
          error.rolledBack === false
        ) {
          // Per-channel disable via applySelection: the reconcile stopped
          // this channel's worker entry, the replacement selection failed
          // to start, and the rollback restart also failed — the channel
          // is confirmed dead, but this error shape carries no
          // stoppedChannels set. Record the stop anyway, or the channel
          // resurrects on the next `--channel all` start (#8975). Key on
          // code + rolledBack together, not rolledBack alone: the
          // stop-phase failure shape (code channel_worker_stop_failed)
          // can leave an old worker alive, where recording `stopped`
          // would be wrong. Aggregate the persistence boolean like the
          // sibling stoppedChannels branch: the same disk condition that
          // broke startup can also fail this write, and the 502 body must
          // carry the loss or the client has no retry handle (#8975).
          //
          // `rolledBack` is aggregate across workspaces: with a
          // multi-workspace reconcile it is false when ANY workspace's
          // restore fails — even when THIS workspace's entry was restored
          // and its channel is relaunching. Persisting `stopped` then
          // records a stop for a live channel, which the next `--channel
          // all` skips. Re-check via the per-workspace restore report:
          // record the stop only when this workspace's entry was NOT
          // restored (R9-4). A reconcile that failed before any rollback
          // ran (replacement stop failure, daemon shutting down) carries
          // no restored set — there the stopped entry stays dead and the
          // record is correct.
          const restoredHere = (error.restoredWorkspaces ?? []).some(
            (workspaceCwd) =>
              canonicalForGuard(workspaceCwd) ===
              canonicalForGuard(opts.workspaceCwd),
          );
          if (!restoredHere) {
            // Route through the shared single-name persistence helper
            // (behaviorally identical to the inline write it replaces,
            // including the failed-workspace attribution): the sibling
            // catch branch and the success path both use it, and a second
            // definition of the stop-record write diverges silently when
            // the helper changes — against this file's "one definition,
            // three sites" convention (R14, R16-5).
            const failedWorkspaces = recordStopForName(name, undefined);
            if (failedWorkspaces.length > 0) {
              error.statePersisted = false;
              error.statePersistFailedWorkspaces = failedWorkspaces;
            }
          }
        }
        throw error;
      }
      if (!result.changed && workspaceWorkerStarting()) {
        // A mode-`all` worker mid crash-restart has not committed real
        // channel names yet, so the disable could not be confirmed: the
        // relaunching worker may connect this channel and overwrite the
        // `stopped` record. Reject loudly instead of reporting a success
        // that does not hold (#8975).
        throw new ChannelManagementError(
          'channel_worker_starting',
          `Channel "${name}" cannot be stopped while its workspace worker is still starting; retry once the worker reports ready.`,
        );
      }
      // An explicit stop must persist, so a later `--channel all` restart
      // does not bring this channel back (#8975). The stop already succeeded
      // at this point, so a degraded workspace path must not escape as a raw
      // fs error and skip the persistence — use the throw-safe form. When
      // the disable routed through the whole-selection stop (disabling the
      // LAST committed channel), the result carries the per-workspace
      // tear-down set: persist it group-by-group via recordChannelsStopped
      // like the catch branch and the DELETE route do — persisting only
      // this one name would leave the other torn-down workspaces
      // unrecorded, and they would resurrect on the next `--channel all`
      // start (#8975). recordStopForName ALSO writes this name's own
      // record when the carried set exists but excludes it — the carried
      // set only holds connected channels, so a never-connected requested
      // channel would otherwise get no `stopped` record and resurrect
      // (R14).
      // Union BOTH loss sources: this name's own record write AND the
      // manager's disable result — the names-mode commit inside
      // applySelection clears committed names' persisted `stopped`
      // records, and a clear failure rides `statePersisted` /
      // `statePersistFailedWorkspaces` on the disable result. start()
      // surfaces that identical signal (R16-2); stop() used to build the
      // response only from recordStopForName's own write failures, so a
      // sibling workspace's surviving record trimmed the committed
      // selection on the next reload-op with no loss signal ever emitted
      // (R17-4).
      const persistFailedWorkspaces = [
        ...new Set([
          ...(result.statePersisted === false
            ? (result.statePersistFailedWorkspaces ?? [])
            : []),
          ...recordStopForName(name, result.stoppedChannels),
        ]),
      ];
      diagnostics.delete(name);
      return {
        ...(await resultFor(name, persisted)),
        // Only on failure: the happy-path response shape stays unchanged,
        // but the route's client must be able to tell that the stop record
        // did not persist and the stop is not durable — a persistence
        // failure must never fail an already-succeeded stop (#8975) — and
        // which workspaces lost their records, so a retry can be targeted
        // (R14).
        ...(persistFailedWorkspaces.length === 0
          ? {}
          : {
              statePersisted: false,
              statePersistFailedWorkspaces: persistFailedWorkspaces,
            }),
      };
    },
    async restart(name) {
      assertManageableInstanceName(name);
      const persisted = opts.store.snapshot();
      if (!Object.hasOwn(persisted.channels, name)) {
        throw new ChannelManagementError(
          'channel_instance_not_found',
          `Channel "${name}" is not configured in this workspace.`,
        );
      }
      assertWorkspaceConfig(persisted.channels[name]!);
      // A crash-dead (budget-exhausted) worker's channel is not committed,
      // but restart is its natural recovery route: reloadWorkspace
      // reconciles the workspace, replacing the dead entry and resetting
      // the budget. Rejecting with channel_worker_not_enabled here would
      // leave start() as the only way back while the status claims a
      // clean stop (R9-5).
      if (
        !workspaceCommittedNames().includes(name) &&
        !terminalFailedWorkerFor(name)
      ) {
        throw new ChannelManagementError(
          'channel_worker_not_enabled',
          `Channel "${name}" is not running.`,
        );
      }
      assertOwnedRuntime(name);
      // A crash-dead channel recovered in mode-`all` reconciles with the
      // still-committed whole selection: the relaunched worker's restore
      // filter skips exactly the channel whose `stopped` record an
      // explicit stop persisted — restart() would resolve success while
      // the channel stays down. Clear the record before the reconcile so
      // the recovery it reports is real (#8975).
      clearStoppedRecord(name);
      try {
        await opts.manager.reloadWorkspace(opts.workspaceCwd, name);
        diagnostics.delete(name);
      } catch (error) {
        diagnostics.set(name, diagnostic(error));
        throw error;
      }
      return resultFor(name, persisted);
    },
    async pairingRequests(name) {
      return { requests: pairingStoreFor(name).listPending() };
    },
    async approvePairing(name, code) {
      const store = pairingStoreFor(name);
      const approved = store.approve(code);
      if (!approved) {
        throw new ChannelManagementError(
          'channel_pairing_request_not_found',
          'Pairing request was not found or has expired.',
        );
      }
      return { approved, requests: store.listPending() };
    },
    async pairingApprovals(name) {
      const store = pairingStoreFor(name);
      return {
        senderIds: store.getAllowlist(),
        groupIds: store.getGroupAllowlist(),
      };
    },
    async revokePairingApproval(name, subject) {
      const store = pairingStoreFor(name);
      const revoked =
        subject.type === 'group'
          ? store.revokeGroup(subject.id)
          : store.revoke(subject.id);
      if (!revoked) {
        throw new ChannelManagementError(
          'channel_pairing_approval_not_found',
          'Pairing approval was not found.',
        );
      }
      return {
        revoked: subject.id,
        senderIds: store.getAllowlist(),
        groupIds: store.getGroupAllowlist(),
      };
    },
  };
  return {
    list: () => service.list(),
    upsert: (name, request) =>
      inMutationLane(() => service.upsert(name, request)),
    remove: (name, request) =>
      inMutationLane(() => service.remove(name, request)),
    setStartup: (name, request) =>
      inMutationLane(() => service.setStartup(name, request)),
    start: (name) => inMutationLane(() => service.start(name)),
    stop: (name) => inMutationLane(() => service.stop(name)),
    restart: (name) => inMutationLane(() => service.restart(name)),
    pairingRequests: (name) => service.pairingRequests(name),
    approvePairing: (name, code) =>
      inMutationLane(() => service.approvePairing(name, code)),
    pairingApprovals: (name) => service.pairingApprovals(name),
    revokePairingApproval: (name, subject) =>
      inMutationLane(() => service.revokePairingApproval(name, subject)),
  };
}
