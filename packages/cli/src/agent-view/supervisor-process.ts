/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Socket } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AgentViewAttachLeaseManager,
  DEFAULT_AGENT_VIEW_ATTACH_LEASE_TTL_MS,
} from './attach-lease.js';
import { AGENT_VIEW_PROTOCOL_VERSION } from './protocol.js';
import type {
  AgentViewActivityFile,
  AgentViewLaunchFile,
  AgentViewSessionSnapshot,
  AgentViewSessionStateFile,
  AgentViewWorkerControlEvent,
  AgentViewWorkerEvent,
} from './protocol.js';
import type { AgentViewPtyHostHandle } from './pty-host.js';
import {
  connectAgentViewPtyHostProcess,
  launchAgentViewPtyHostProcess,
} from './pty-host-process.js';
import { bridgeAgentViewTerminal } from './terminal-bridge.js';
import { dispatchAgentViewSession } from './supervisor-dispatch.js';
import {
  getAgentViewStorePaths,
  listAgentViewSessionSnapshots,
  listAgentViewSessionStates,
  readAgentViewLaunch,
  readAgentViewActivity,
  readAgentViewSessionState,
  readAgentViewWorker,
  removeAgentViewRosterEntry,
  upsertAgentViewRosterEntry,
  updateAgentViewRosterEntry,
  writeAgentViewActivity,
  writeAgentViewLaunch,
  writeAgentViewSessionState,
  writeAgentViewWorker,
} from './supervisor-store.js';
import type { AgentViewSupervisorHandler } from './supervisor-server.js';
import { createAgentViewWorkerSidebandEnv } from './worker-sideband.js';
import {
  buildCurrentQwenCliArgv,
  getCurrentQwenCliEntrypoint,
} from './current-cli-argv.js';
import {
  canAgentViewHibernate,
  canAgentViewQueueFollowUp,
  getAgentViewActivityInputState,
} from './presentation.js';

const UNIX_SOCKET_PATH_LIMIT = 100;
const DEFAULT_IDLE_HIBERNATION_MS = 30 * 60 * 1000;
const DEFAULT_SUPERVISOR_AUTO_EXIT_GRACE_MS = 10 * 60 * 1000;
const DEFAULT_WORKER_READY_TIMEOUT_MS = 15_000;
const DEFAULT_GRACEFUL_STOP_TIMEOUT_MS = 10_000;
const DEFAULT_ATTACH_LEASE_HEARTBEAT_MS =
  DEFAULT_AGENT_VIEW_ATTACH_LEASE_TTL_MS / 3;

export interface AgentViewSupervisorHibernationPolicy {
  enabled?: boolean;
  idleMs?: number;
  autoExit?: boolean;
  autoExitGraceMs?: number;
}

export interface AgentViewSupervisorHibernationResult {
  hibernated: string[];
}

export interface AgentViewSupervisorMaintenanceResult
  extends AgentViewSupervisorHibernationResult {
  shutdownRequested: boolean;
}

type AgentViewStoreOptions = { globalDir?: string };

export interface AgentViewSupervisorMaintenance {
  hibernateIdleSessions(): Promise<AgentViewSupervisorHibernationResult>;
  tickIdleHibernation(): Promise<AgentViewSupervisorMaintenanceResult>;
}

interface AgentViewWorkerReadyWaiter {
  expectedCwd: string;
  timeout: NodeJS.Timeout;
  resolve(): void;
  reject(error: Error): void;
}

export interface AgentViewSupervisorPathOptions {
  globalDir?: string;
  platform?: NodeJS.Platform;
  runtimeDir?: string;
}

export interface AgentViewSupervisorProcessOptions
  extends AgentViewSupervisorPathOptions {
  launchPtyHost?: (
    launch: AgentViewLaunchFile,
  ) => Promise<AgentViewPtyHostHandle>;
  hibernationPolicy?: AgentViewSupervisorHibernationPolicy;
  waitForWorkerReady?: boolean;
  workerReadyTimeoutMs?: number;
  now?: () => Date;
  onShutdown?: () => void | Promise<void>;
}

export function getAgentViewSupervisorSocketPath(
  options: AgentViewSupervisorPathOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const globalDir = getAgentViewStorePaths({
    ...(options.globalDir ? { globalDir: options.globalDir } : {}),
  }).globalDir;
  const digest = shortHash(globalDir);

  if (platform === 'win32') {
    return `\\\\.\\pipe\\qwen-agent-view-${digest}`;
  }

  const primaryPath = path.join(
    getAgentViewStorePaths({ globalDir }).daemonDir,
    'supervisor.sock',
  );
  if (Buffer.byteLength(primaryPath) < UNIX_SOCKET_PATH_LIMIT) {
    return primaryPath;
  }

  return path.join(
    options.runtimeDir ?? os.tmpdir(),
    `qwen-agent-view-${digest}.sock`,
  );
}

export function getAgentViewSupervisorStaleSocketPath(
  socketPath: string,
  marker = `${process.pid}`,
): string {
  const safeMarker = marker.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (socketPath.startsWith('\\\\.\\pipe\\')) {
    return `\\\\.\\pipe\\qwen-agent-view-stale-${shortHash(
      `${socketPath}:${safeMarker}`,
    )}`;
  }

  const candidate = `${socketPath}.stale-${safeMarker}`;
  if (Buffer.byteLength(candidate) < UNIX_SOCKET_PATH_LIMIT) {
    return candidate;
  }

  return path.join(
    path.dirname(socketPath),
    `qwen-agent-view-stale-${shortHash(`${socketPath}:${safeMarker}`)}.sock`,
  );
}

export function createAgentViewSupervisorHandler(
  options: AgentViewSupervisorProcessOptions = {},
): AgentViewSupervisorHandler & AgentViewSupervisorMaintenance {
  return new AgentViewSupervisorProcessHandler(options);
}

class AgentViewSupervisorProcessHandler
  implements AgentViewSupervisorHandler, AgentViewSupervisorMaintenance
{
  private readonly socketPath: string;
  private readonly startedAt: string;
  private readonly attachSockets = new Map<string, Socket>();
  private readonly attachLeases = new AgentViewAttachLeaseManager();
  private readonly subscribers = new Set<Socket>();
  private readonly snapshotCache = new SessionSnapshotCache();
  private readonly pendingWorkerControls = new Map<
    string,
    AgentViewWorkerControlEvent[]
  >();
  private readonly promptQueues = new Map<string, Promise<void>>();
  private readonly attachSetupQueues = new Map<string, Promise<void>>();
  private readonly workers: WorkerRegistry;
  private workerControlSequence = 0;
  private autoExitRequested = false;
  private autoExitEligibleSinceMs: number | undefined;

  constructor(
    private readonly options: AgentViewSupervisorProcessOptions = {},
  ) {
    this.socketPath = getAgentViewSupervisorSocketPath(options);
    this.startedAt = new Date().toISOString();
    this.workers = new WorkerRegistry(
      options,
      () => this.notifyChanged(),
      (sessionId) => this.pendingWorkerControls.delete(sessionId),
    );
  }

  private get store(): AgentViewStoreOptions {
    return storeOptions(this.options);
  }

  private nextSequence(): number {
    return ++this.workerControlSequence;
  }

  private notifyChanged(): void {
    this.snapshotCache.markDirty();
    notifyAgentViewSubscribers(this.subscribers);
  }

  status() {
    return {
      protocolVersion: AGENT_VIEW_PROTOCOL_VERSION,
      pid: process.pid,
      socketPath: this.socketPath,
      startedAt: this.startedAt,
    };
  }
  async list(params?: Record<string, unknown>) {
    const store = this.store;
    const snapshots = [];
    for (const snapshot of (
      await this.snapshotCache.list(store, Date.now())
    ).filter((snapshot) => snapshot.state.ownership !== 'unmanaged')) {
      const state = await this.workers.refreshMissingWorkerState(
        snapshot.state,
      );
      if (state !== snapshot.state) {
        this.snapshotCache.markDirty();
      }
      const activity = await clearStalePendingPromptIfNeeded(
        state,
        snapshot.activity,
        store,
      );
      if (activity !== snapshot.activity) {
        this.snapshotCache.markDirty();
      }
      snapshots.push({
        ...snapshot,
        state,
        activity,
      });
    }
    const cwd = typeof params?.['cwd'] === 'string' ? params['cwd'] : undefined;
    if (!cwd) return snapshots;
    const resolvedCwd = path.resolve(cwd);
    return snapshots.filter(
      (snapshot) =>
        snapshot.state.projectCwd === resolvedCwd ||
        snapshot.state.activeCwd === resolvedCwd ||
        snapshot.state.activeCwd.startsWith(`${resolvedCwd}${path.sep}`),
    );
  }
  subscribe(
    _params: Record<string, unknown> | undefined,
    socket: Socket,
    requestId: string,
  ) {
    socket.write(
      `${JSON.stringify({
        id: requestId,
        ok: true,
        result: { subscribed: true },
      })}\n`,
    );
    this.subscribers.add(socket);
    socket.once('close', () => {
      this.subscribers.delete(socket);
    });
    socket.once('error', () => {
      this.subscribers.delete(socket);
    });
  }
  async dispatch(params?: Record<string, unknown>) {
    const prompt =
      typeof params?.['prompt'] === 'string' ? params['prompt'] : '';
    const cwd =
      typeof params?.['cwd'] === 'string' ? params['cwd'] : process.cwd();
    if (!prompt.trim()) {
      throw new Error('Agent View dispatch prompt cannot be empty.');
    }
    const store = {
      ...(this.options.globalDir ? { globalDir: this.options.globalDir } : {}),
    };
    const result = await dispatchAgentViewSession(prompt, cwd, {
      ...store,
      sidebandEndpoint: this.socketPath,
    });
    const launch = await readAgentViewLaunch(result.sessionId, store);
    if (!launch) {
      throw new Error('Agent View dispatch launch record was not written.');
    }

    try {
      const ready = this.workers.waitForWorkerReadyIfNeeded(
        result.sessionId,
        launch.activeCwd,
      );
      void ready.catch(() => {});
      const host = await this.workers.launchPtyHostForSupervisor(launch, store);
      this.workers.set(result.sessionId, host);
      await writeAgentViewWorker(
        result.sessionId,
        {
          schemaVersion: 1,
          hostPid: host.pid,
          workerPid: host.workerPid,
          ...(host.endpoint ? { hostEndpoint: host.endpoint } : {}),
          ...(host.authToken ? { hostAuthToken: host.authToken } : {}),
          protocolVersion: AGENT_VIEW_PROTOCOL_VERSION,
          platform: process.platform,
          recentOutputBytes: 0,
        },
        store,
      );
      await ready;
      this.notifyChanged();
      return result;
    } catch (error) {
      this.workers.rejectPendingWorkerReady(result.sessionId, error);
      this.workers.terminateSession(result.sessionId, 'SIGTERM');
      await markFailedSession(result.sessionId, error, store);
      this.notifyChanged();
      throw error;
    }
  }
  async adopt(params?: Record<string, unknown>) {
    const adoption = parseAdoptParams(params);
    const store = this.store;
    const existingState = await readAgentViewSessionState(
      adoption.sessionId,
      store,
    );
    if (
      existingState?.ownership === 'managed' ||
      existingState?.ownership === 'adopting'
    ) {
      return {
        sessionId: adoption.sessionId,
        adopted: false,
        alreadyManaged: true,
      };
    }
    if (this.workers.has(adoption.sessionId)) {
      throw new Error(
        `Agent View session ${adoption.sessionId} is already running.`,
      );
    }

    const token = randomUUID();
    const now = new Date().toISOString();
    const activeCwd = path.resolve(adoption.activeCwd);
    const projectCwd = activeCwd;
    const createdAt = existingState?.createdAt ?? now;
    const adoptingState = {
      schemaVersion: 1 as const,
      sessionId: adoption.sessionId,
      ownership: 'adopting' as const,
      sessionState: 'idle' as const,
      processState: 'starting' as const,
      attachState: 'detached' as const,
      projectCwd,
      originalCwd: activeCwd,
      activeCwd,
      createdAt,
      updatedAt: now,
      worktree: { mode: 'none' as const },
    };

    await writeAgentViewSessionState(adoptingState, store);
    await writeAgentViewLaunch(
      {
        schemaVersion: 1,
        sessionId: adoption.sessionId,
        argv: buildResumeWorkerArgv(adoption.sessionId),
        env: createAgentViewWorkerSidebandEnv({
          sessionId: adoption.sessionId,
          sidebandEndpoint: this.socketPath,
          token,
          activeCwd,
        }),
        entrypoint: getCurrentQwenCliEntrypoint(),
        projectCwd,
        activeCwd,
        ...(adoption.approvalMode
          ? { approvalMode: adoption.approvalMode }
          : {}),
        ...(adoption.sandbox ? { sandbox: adoption.sandbox } : {}),
        includeDirectories: [],
        terminal: adoption.terminal,
      },
      store,
    );
    await writeAgentViewActivity(
      adoption.sessionId,
      {
        schemaVersion: 1,
        summary: 'Backgrounded from native session',
        lastActivityAt: now,
        capabilities: [],
      },
      store,
    );
    await writeAgentViewWorker(
      adoption.sessionId,
      {
        schemaVersion: 1,
        endpoint: this.socketPath,
        tokenDigest: digestToken(token),
        protocolVersion: AGENT_VIEW_PROTOCOL_VERSION,
        platform: process.platform,
        recentOutputBytes: 0,
      },
      store,
    );
    await upsertAgentViewRosterEntry(
      {
        sessionId: adoption.sessionId,
        projectCwd,
        activeCwd,
        createdAt,
        updatedAt: now,
      },
      store,
    );

    try {
      const launch = await readAgentViewLaunch(adoption.sessionId, store);
      if (!launch) {
        throw new Error('Agent View adoption launch record was not written.');
      }
      const ready = this.workers.waitForWorkerReadyIfNeeded(
        adoption.sessionId,
        activeCwd,
      );
      void ready.catch(() => {});
      const host = await this.workers.launchPtyHostForSupervisor(launch, store);
      this.workers.set(adoption.sessionId, host);
      await writeAgentViewSessionState(
        {
          ...adoptingState,
          ownership: 'managed',
          sessionState: 'starting',
          processState: 'starting',
          updatedAt: new Date().toISOString(),
        },
        store,
      );
      await writeAgentViewWorker(
        adoption.sessionId,
        {
          schemaVersion: 1,
          hostPid: host.pid,
          workerPid: host.workerPid,
          ...(host.endpoint ? { hostEndpoint: host.endpoint } : {}),
          ...(host.authToken ? { hostAuthToken: host.authToken } : {}),
          protocolVersion: AGENT_VIEW_PROTOCOL_VERSION,
          platform: process.platform,
          recentOutputBytes: 0,
        },
        store,
      );
      await ready;
      this.notifyChanged();
      return { sessionId: adoption.sessionId, adopted: true };
    } catch (error) {
      this.workers.rejectPendingWorkerReady(adoption.sessionId, error);
      this.workers.terminateSession(adoption.sessionId, 'SIGTERM');
      const failedAt = new Date().toISOString();
      await writeAgentViewSessionState(
        existingState ?? {
          ...adoptingState,
          ownership: 'unmanaged',
          processState: 'exited',
          updatedAt: failedAt,
          lastError: {
            code: 'adoption_failed',
            message:
              error instanceof Error
                ? error.message
                : 'Agent View adoption failed.',
            at: failedAt,
          },
        },
        store,
      );
      await removeAgentViewRosterEntry(adoption.sessionId, store);
      this.notifyChanged();
      throw error;
    }
  }
  async workerEvent(params?: Record<string, unknown>) {
    const event = parseWorkerEvent(params);
    await requireValidWorkerToken(event.sessionId, params, this.store);
    if (event.type === 'ready') {
      this.workers.validatePendingWorkerReady(event);
    }
    if (event.type === 'detach') {
      await requireKnownSession(event.sessionId, this.store);
      this.attachSockets.get(event.sessionId)?.destroy();
      await writeAttachState(event.sessionId, 'detached', this.store);
      this.notifyChanged();
      return { sessionId: event.sessionId, accepted: true };
    }
    if (event.type === 'heartbeat') {
      await applyWorkerHeartbeatEvent(event, this.store);
      return { sessionId: event.sessionId, accepted: true };
    }
    try {
      await applyWorkerEvent(event, this.store);
    } catch (error) {
      if (event.type === 'ready') {
        this.workers.rejectPendingWorkerReady(event.sessionId, error);
      }
      throw error;
    }
    if (event.type === 'ready') {
      this.workers.resolvePendingWorkerReady(event.sessionId);
    }
    this.notifyChanged();
    return { sessionId: event.sessionId, accepted: true };
  }
  async workerControl(params?: Record<string, unknown>) {
    const sessionId = requireSessionId(params);
    await requireKnownSession(sessionId, this.store);
    await requireValidWorkerToken(sessionId, params, this.store);
    const events = this.pendingWorkerControls.get(sessionId) ?? [];
    this.pendingWorkerControls.delete(sessionId);
    return { sessionId, events };
  }
  async attachStream(
    params: Record<string, unknown> | undefined,
    socket: Socket,
    requestId: string,
  ) {
    const sessionId = await resolveManagedSessionId(
      requireSessionId(params),
      this.store,
    );
    const readyToAttach = await this.withAttachSetupLock(sessionId, async () =>
      this.prepareSessionForAttach(sessionId, socket, requestId),
    );
    if (!readyToAttach) return;
    await this.attachSessionStream(sessionId, socket, requestId);
  }

  private async prepareSessionForAttach(
    sessionId: string,
    socket: Socket,
    requestId: string,
  ): Promise<boolean> {
    try {
      if (await this.workers.respawnStoppedOrFailedSessionIfNeeded(sessionId)) {
        this.notifyChanged();
      }
    } catch (error) {
      writeAttachError(
        socket,
        requestId,
        'pty_launch_failed',
        error instanceof Error ? error.message : String(error),
      );
      this.notifyChanged();
      return false;
    }
    if (!this.workers.has(sessionId)) {
      if (!(await this.workers.reconnectSessionHost(sessionId))) {
        try {
          if (
            !(await this.workers.respawnSessionForAttachIfInactive(sessionId))
          ) {
            writeAttachError(
              socket,
              requestId,
              'stale_host',
              `Agent View session ${sessionId} has no live PTY host.`,
            );
            this.notifyChanged();
            return false;
          }
        } catch (error) {
          writeAttachError(
            socket,
            requestId,
            'pty_launch_failed',
            error instanceof Error ? error.message : String(error),
          );
          this.notifyChanged();
          return false;
        }
      }
      this.notifyChanged();
    }
    return true;
  }

  private async withAttachSetupLock<T>(
    sessionId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const previous = this.attachSetupQueues.get(sessionId) ?? Promise.resolve();
    const current = previous.then(action, action);
    const queued = current
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (this.attachSetupQueues.get(sessionId) === queued) {
          this.attachSetupQueues.delete(sessionId);
        }
      });
    this.attachSetupQueues.set(sessionId, queued);
    return current;
  }

  async resize(params?: Record<string, unknown>) {
    const sessionId = await resolveManagedSessionId(
      requireSessionId(params),
      this.store,
    );
    const host = await this.workers.getOrReconnectSessionHost(sessionId);
    if (!host) {
      throw new Error(`Agent View session ${sessionId} is not running.`);
    }
    host.resize({
      columns: positiveIntegerParam(params, 'columns'),
      rows: positiveIntegerParam(params, 'rows'),
    });
    return { sessionId, resized: true };
  }
  async peek(params?: Record<string, unknown>) {
    const store = this.store;
    const sessionId = await resolveManagedSessionId(
      requireSessionId(params),
      store,
    );
    const storedState = await readAgentViewSessionState(sessionId, store);
    const state = storedState
      ? await this.workers.refreshMissingWorkerState(storedState)
      : undefined;
    if (state && state !== storedState) {
      this.notifyChanged();
    }
    if (!state) {
      throw new Error(`No Agent View session found for ${sessionId}.`);
    }
    const activity = await clearStalePendingPromptIfNeeded(
      state,
      await readAgentViewActivity(sessionId, store),
      store,
    );
    return {
      sessionId,
      state,
      activity,
      worker: await readAgentViewWorker(sessionId, store),
      live: this.workers.has(sessionId),
    };
  }
  async send(params?: Record<string, unknown>) {
    const sessionId = await resolveManagedSessionId(
      requireSessionId(params),
      this.store,
    );
    const text = requireText(params);
    await this.queuePromptForSession(sessionId, text);
    this.notifyChanged();
    return { sessionId, sent: true };
  }
  async answer(params?: Record<string, unknown>) {
    const sessionId = await resolveManagedSessionId(
      requireSessionId(params),
      this.store,
    );
    const text = requireText(params);
    await this.queueAnswerForSession(sessionId, text);
    this.notifyChanged();
    return { sessionId, answered: true };
  }
  async logs(params?: Record<string, unknown>) {
    const sessionId = await resolveManagedSessionId(
      requireSessionId(params),
      this.store,
    );
    const host = await this.workers.getOrReconnectSessionHost(sessionId);
    return {
      sessionId,
      output: host
        ? ((await host.getOutput?.()) ?? host.output.toString())
        : '',
      live: Boolean(host),
    };
  }
  async stop(params?: Record<string, unknown>) {
    const sessionId = await resolveManagedSessionId(
      requireSessionId(params),
      this.store,
    );
    await this.workers.stopSession(sessionId, () =>
      this.queueWorkerStop(sessionId),
    );
    this.notifyChanged();
    return { sessionId, stopped: true };
  }
  async kill(params?: Record<string, unknown>) {
    const sessionId = await resolveManagedSessionId(
      requireSessionId(params),
      this.store,
    );
    await this.workers.killSession(sessionId, 'SIGKILL');
    this.notifyChanged();
    return { sessionId, killed: true };
  }
  async respawn(params?: Record<string, unknown>) {
    const all = params?.['all'] === true;
    if (all) {
      const states = await listAgentViewSessionStates(this.store);
      const results = [];
      for (const state of states) {
        if (state.ownership !== 'managed') continue;
        const refreshedState =
          await this.workers.refreshMissingWorkerState(state);
        const blockReason = getRespawnBlockReason(
          refreshedState,
          await readAgentViewActivity(state.sessionId, this.store),
        );
        if (blockReason) {
          results.push({
            sessionId: state.sessionId,
            skipped: true,
            reason: blockReason,
          });
          continue;
        }
        results.push(await this.workers.respawnSession(state.sessionId));
      }
      this.notifyChanged();
      return { all: true, results };
    }
    const sessionId = await resolveManagedSessionId(
      requireSessionId(params),
      this.store,
    );
    const result = await this.workers.respawnSession(sessionId);
    this.notifyChanged();
    return result;
  }
  async remove(params?: Record<string, unknown>) {
    const store = this.store;
    const sessionId = await resolveManagedSessionId(
      requireSessionId(params),
      store,
    );
    const state = await readAgentViewSessionState(sessionId, store);
    this.workers.terminateSession(sessionId, 'SIGTERM');
    if (state) {
      await writeAgentViewSessionState(
        {
          ...state,
          ownership: 'unmanaged',
          processState: 'exited',
          updatedAt: new Date().toISOString(),
        },
        store,
      );
    }
    await removeAgentViewRosterEntry(sessionId, store);
    this.notifyChanged();
    return { sessionId, removed: true };
  }
  async pin(params?: Record<string, unknown>) {
    const store = this.store;
    const sessionId = await resolveManagedSessionId(
      requireSessionId(params),
      store,
    );
    const pinned =
      typeof params?.['pinned'] === 'boolean' ? params['pinned'] : undefined;
    const now = new Date().toISOString();
    const entry = await updateAgentViewRosterEntry(
      sessionId,
      (current) => ({
        ...current,
        pinned: pinned ?? !current.pinned,
        updatedAt: now,
      }),
      store,
    );
    if (!entry) {
      throw new Error(`No Agent View roster entry found for ${sessionId}.`);
    }
    this.notifyChanged();
    return { sessionId, pinned: Boolean(entry.pinned) };
  }
  async rename(params?: Record<string, unknown>) {
    const store = this.store;
    const sessionId = await resolveManagedSessionId(
      requireSessionId(params),
      store,
    );
    const displayName =
      typeof params?.['displayName'] === 'string'
        ? params['displayName'].trim()
        : '';
    const now = new Date().toISOString();
    const entry = await updateAgentViewRosterEntry(
      sessionId,
      (current) => {
        const next = {
          ...current,
          updatedAt: now,
        };
        if (displayName) {
          return {
            ...next,
            displayName,
          };
        }
        delete next.displayName;
        return next;
      },
      store,
    );
    if (!entry) {
      throw new Error(`No Agent View roster entry found for ${sessionId}.`);
    }
    this.notifyChanged();
    return { sessionId, displayName: entry.displayName ?? '' };
  }
  async shutdown(params?: Record<string, unknown>) {
    if (params?.['keepWorkers'] === true) {
      await this.options.onShutdown?.();
      return { shuttingDown: true, keepWorkers: true };
    }
    for (const socket of this.attachSockets.values()) {
      socket.destroy();
    }
    this.attachSockets.clear();
    const workerCount = await this.workers.shutdownAll();
    await this.options.onShutdown?.();
    return { shuttingDown: true, workersStopped: workerCount };
  }
  async hibernateIdleSessions() {
    const result = await this.hibernateIdleSessionsWithPolicy(
      getHibernationPolicy(this.options),
    );
    if (result.hibernated.length > 0) {
      this.notifyChanged();
    }
    return result;
  }
  async tickIdleHibernation() {
    const policy = getHibernationPolicy(this.options);
    const hibernation = await this.hibernateIdleSessionsWithPolicy(policy);
    if (hibernation.hibernated.length > 0) {
      this.notifyChanged();
    }
    const autoExitEligible =
      !this.autoExitRequested &&
      (await this.shouldAutoExitAfterHibernation(policy));
    const nowMs = (this.options.now?.() ?? new Date()).getTime();
    if (!autoExitEligible) {
      this.autoExitEligibleSinceMs = undefined;
    } else if (this.autoExitEligibleSinceMs === undefined) {
      this.autoExitEligibleSinceMs = nowMs;
    }
    const shutdownRequested =
      autoExitEligible &&
      this.autoExitEligibleSinceMs !== undefined &&
      nowMs - this.autoExitEligibleSinceMs >= policy.autoExitGraceMs;
    if (shutdownRequested) {
      this.autoExitRequested = true;
      await this.options.onShutdown?.();
    }
    return {
      ...hibernation,
      shutdownRequested: shutdownRequested || this.autoExitRequested,
    };
  }

  private async hibernateIdleSessionsWithPolicy(
    policy: ReturnType<typeof getHibernationPolicy>,
  ): Promise<AgentViewSupervisorHibernationResult> {
    if (!policy.enabled) {
      return { hibernated: [] };
    }

    const snapshots = await listAgentViewSessionSnapshots(this.store);
    const nowMs = (this.options.now?.() ?? new Date()).getTime();
    const hibernated: string[] = [];
    for (const snapshot of snapshots) {
      const host = this.workers.get(snapshot.sessionId);
      if (!host || !canHibernateSession(snapshot, nowMs, policy.idleMs)) {
        continue;
      }

      await markSessionHibernating(snapshot.state, this.store);
      await this.workers.shutdownHost(snapshot.sessionId, host);
      await markSessionHibernated(snapshot.state, this.store);
      hibernated.push(snapshot.sessionId);
    }

    return { hibernated };
  }

  private async shouldAutoExitAfterHibernation(
    policy: ReturnType<typeof getHibernationPolicy>,
  ): Promise<boolean> {
    if (!policy.enabled || !policy.autoExit) {
      return false;
    }
    pruneClosedSockets(this.subscribers);
    pruneClosedSocketMap(this.attachSockets);
    if (this.subscribers.size > 0 || this.attachSockets.size > 0) {
      return false;
    }

    const states = await listAgentViewSessionStates(this.store);
    const managed = states.filter((state) => state.ownership === 'managed');
    return (
      states.length > 0 &&
      managed.every((state) => !isAliveProcessState(state.processState))
    );
  }

  private async attachSessionStream(
    sessionId: string,
    socket: Socket,
    requestId: string,
  ): Promise<void> {
    await requireKnownSession(sessionId, this.store);
    const host = this.workers.get(sessionId);
    if (!host) {
      writeAttachError(
        socket,
        requestId,
        'not_running',
        `Agent View session ${sessionId} is not running.`,
      );
      return;
    }

    const leaseResult = this.attachLeases.acquire(sessionId);
    if (!leaseResult.ok) {
      writeAttachError(
        socket,
        requestId,
        'already_attached',
        `Agent View session ${sessionId} is already attached.`,
      );
      return;
    }

    const controller = new AbortController();
    socket.once('close', () => controller.abort());
    const heartbeat = setInterval(() => {
      this.attachLeases.heartbeat(sessionId, leaseResult.lease.leaseId);
    }, DEFAULT_ATTACH_LEASE_HEARTBEAT_MS);
    heartbeat.unref?.();
    try {
      await writeAttachState(sessionId, 'attached', this.store);
      this.attachSockets.set(sessionId, socket);
      socket.write(
        `${JSON.stringify({
          id: requestId,
          ok: true,
          result: { sessionId, lease: leaseResult.lease },
        })}\n`,
      );
      this.queueWorkerRedraw(sessionId);
      await bridgeAgentViewTerminal({
        stdin: socket,
        stdout: socket,
        pty: host,
        detachSignal: controller.signal,
      });
    } finally {
      clearInterval(heartbeat);
      if (this.attachSockets.get(sessionId) === socket) {
        this.attachSockets.delete(sessionId);
      }
      this.attachLeases.release(sessionId, leaseResult.lease.leaseId);
      await writeAttachState(sessionId, 'detached', this.store);
      socket.end();
    }
  }

  private queueWorkerRedraw(sessionId: string): void {
    const events = this.pendingWorkerControls.get(sessionId) ?? [];
    events.push({
      type: 'redraw',
      sequence: this.nextSequence(),
      at: new Date().toISOString(),
    });
    this.pendingWorkerControls.set(sessionId, events);
  }

  private queueWorkerStop(sessionId: string): void {
    const events = this.pendingWorkerControls.get(sessionId) ?? [];
    events.push({
      type: 'stop',
      sequence: this.nextSequence(),
      at: new Date().toISOString(),
    });
    this.pendingWorkerControls.set(sessionId, events);
  }

  private async queuePromptForSession(
    sessionId: string,
    text: string,
  ): Promise<void> {
    return this.withPromptQueueLock(sessionId, async () => {
      await this.queuePromptForSessionLocked(sessionId, text);
    });
  }

  private async queuePromptForSessionLocked(
    sessionId: string,
    text: string,
  ): Promise<void> {
    const state = await readAgentViewSessionState(sessionId, this.store);
    if (!state) {
      throw new Error(`No Agent View session found for ${sessionId}.`);
    }
    if (state.attachState === 'attached') {
      throw new Error(
        `Agent View session ${sessionId} is currently attached elsewhere.`,
      );
    }
    const activity = await readAgentViewActivity(sessionId, this.store);
    if (
      hasPendingPrompt(activity) ||
      this.hasPendingWorkerInputControl(sessionId)
    ) {
      throw new Error(
        `Agent View session ${sessionId} is waiting for the previous response.`,
      );
    }
    if (!canAgentViewQueueFollowUp(state, activity)) {
      throw new Error(
        `Agent View session ${sessionId} is not ready for follow-up.`,
      );
    }

    await this.workers.respawnStoppedOrFailedSessionIfNeeded(sessionId);
    if (!this.workers.has(sessionId)) {
      await this.workers.respawnSession(sessionId);
    }

    const now = new Date().toISOString();
    const events = this.pendingWorkerControls.get(sessionId) ?? [];
    events.push({
      type: 'prompt',
      sequence: this.nextSequence(),
      text,
      at: now,
    });
    this.pendingWorkerControls.set(sessionId, events);
    await writeAgentViewActivity(
      sessionId,
      {
        schemaVersion: 1,
        ...getQueuedPromptActivityPatch(text, now),
        lastActivityAt: now,
        capabilities: [],
      },
      this.store,
    );
  }

  private async withPromptQueueLock(
    sessionId: string,
    action: () => Promise<void>,
  ): Promise<void> {
    const previous = this.promptQueues.get(sessionId) ?? Promise.resolve();
    const current = previous.then(action, action);
    const cleanup = current.finally(() => {
      if (this.promptQueues.get(sessionId) === cleanup) {
        this.promptQueues.delete(sessionId);
      }
    });
    void cleanup.catch(() => {});
    this.promptQueues.set(sessionId, cleanup);
    return current;
  }

  private async queueAnswerForSession(
    sessionId: string,
    text: string,
  ): Promise<void> {
    return this.withPromptQueueLock(sessionId, async () => {
      await this.queueAnswerForSessionLocked(sessionId, text);
    });
  }

  private async queueAnswerForSessionLocked(
    sessionId: string,
    text: string,
  ): Promise<void> {
    const state = await readAgentViewSessionState(sessionId, this.store);
    if (!state) {
      throw new Error(`No Agent View session found for ${sessionId}.`);
    }
    if (state.attachState === 'attached') {
      throw new Error(
        `Agent View session ${sessionId} is currently attached elsewhere.`,
      );
    }
    if (state.sessionState !== 'needs_input') {
      throw new Error(
        `Agent View session ${sessionId} is not waiting for input.`,
      );
    }

    const now = new Date().toISOString();
    const activity = await readAgentViewActivity(sessionId, this.store);
    if (getAgentViewActivityInputState(activity) === 'soft_question') {
      await this.queuePromptForSessionLocked(sessionId, text);
      return;
    }
    if (!this.workers.has(sessionId)) {
      throw new Error(`Agent View session ${sessionId} is not running.`);
    }
    if (
      (activity?.waitingFor === 'response' && hasPendingPrompt(activity)) ||
      this.hasPendingWorkerInputControl(sessionId)
    ) {
      throw new Error(
        `Agent View session ${sessionId} is waiting for the previous response.`,
      );
    }
    const events = this.pendingWorkerControls.get(sessionId) ?? [];
    events.push({
      type: 'answer',
      sequence: this.nextSequence(),
      text,
      at: now,
    });
    this.pendingWorkerControls.set(sessionId, events);
    await writeAgentViewActivity(
      sessionId,
      {
        schemaVersion: 1,
        ...(activity?.waitingFor === 'response'
          ? getQueuedPromptActivityPatch(text, now)
          : {}),
        lastActivityAt: now,
        capabilities: [],
      },
      this.store,
    );
  }

  private hasPendingWorkerInputControl(sessionId: string): boolean {
    return (this.pendingWorkerControls.get(sessionId) ?? []).some(
      (event) => event.type === 'prompt' || event.type === 'answer',
    );
  }
}

class WorkerRegistry {
  private readonly ptyHosts = new Map<string, AgentViewPtyHostHandle>();
  private readonly pendingWorkerReady = new Map<
    string,
    AgentViewWorkerReadyWaiter
  >();

  constructor(
    private readonly options: AgentViewSupervisorProcessOptions,
    private readonly onChanged: () => void,
    private readonly onHostReleased: (sessionId: string) => void,
  ) {}

  get size(): number {
    return this.ptyHosts.size;
  }

  private get store(): AgentViewStoreOptions {
    return storeOptions(this.options);
  }

  has(sessionId: string): boolean {
    return this.ptyHosts.has(sessionId);
  }

  get(sessionId: string): AgentViewPtyHostHandle | undefined {
    return this.ptyHosts.get(sessionId);
  }

  set(sessionId: string, host: AgentViewPtyHostHandle): void {
    this.ptyHosts.set(sessionId, host);
    this.trackHostExit(sessionId, host);
  }

  delete(sessionId: string): void {
    if (this.ptyHosts.delete(sessionId)) {
      this.onHostReleased(sessionId);
    }
  }

  async stopSession(sessionId: string, queueStop: () => void): Promise<void> {
    const host = await this.getOrReconnectSessionHost(sessionId);
    if (host) {
      queueStop();
      await markStoppedSession(sessionId, this.store, 'alive');
      this.scheduleStopFallback(sessionId, host);
      return;
    }
    await markStoppedSession(sessionId, this.store, 'exited');
  }

  async killSession(
    sessionId: string,
    signal: NodeJS.Signals = 'SIGTERM',
  ): Promise<void> {
    const host = await this.getOrReconnectSessionHost(sessionId);
    host?.kill(signal);
    if (host && this.ptyHosts.get(sessionId) === host) {
      this.ptyHosts.delete(sessionId);
      this.onHostReleased(sessionId);
    }
    await markStoppedSession(sessionId, this.store, 'exited');
  }

  terminateSession(sessionId: string, signal: NodeJS.Signals): void {
    const host = this.ptyHosts.get(sessionId);
    host?.kill(signal);
    if (host) {
      this.ptyHosts.delete(sessionId);
      this.onHostReleased(sessionId);
    }
  }

  async shutdownHost(
    sessionId: string,
    host: AgentViewPtyHostHandle,
  ): Promise<void> {
    await shutdownPtyHost(host);
    if (this.ptyHosts.get(sessionId) === host) {
      this.ptyHosts.delete(sessionId);
      this.onHostReleased(sessionId);
    }
  }

  async shutdownAll(): Promise<number> {
    const entries = Array.from(this.ptyHosts.entries());
    await Promise.all(
      entries.map(async ([sessionId, host]) => {
        await this.shutdownHost(sessionId, host);
        await markStoppedSession(sessionId, this.store, 'exited');
      }),
    );
    return entries.length;
  }

  async launchPtyHostForSupervisor(
    launchRecord: AgentViewLaunchFile,
    store: AgentViewStoreOptions,
  ): Promise<AgentViewPtyHostHandle> {
    const launch = await refreshStoredResumeWorkerLaunchIfNeeded(
      launchRecord,
      store,
    );
    if (this.options.launchPtyHost) {
      return this.options.launchPtyHost(launch);
    }
    return launchAgentViewPtyHostProcess(launch, store);
  }

  waitForWorkerReadyIfNeeded(
    sessionId: string,
    expectedCwd: string,
  ): Promise<void> {
    if (!shouldWaitForWorkerReady(this.options)) {
      return Promise.resolve();
    }

    this.rejectPendingWorkerReady(
      sessionId,
      new Error(`Agent View worker ${sessionId} was superseded before ready.`),
    );

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingWorkerReady.delete(sessionId);
        reject(
          new Error(
            `Agent View worker ${sessionId} did not report ready before timeout.`,
          ),
        );
      }, this.options.workerReadyTimeoutMs ?? DEFAULT_WORKER_READY_TIMEOUT_MS);
      timeout.unref?.();
      this.pendingWorkerReady.set(sessionId, {
        expectedCwd: path.resolve(expectedCwd),
        timeout,
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });
  }

  validatePendingWorkerReady(
    event: Extract<AgentViewWorkerEvent, { type: 'ready' }>,
  ): void {
    const waiter = this.pendingWorkerReady.get(event.sessionId);
    if (!waiter) return;

    const actualCwd = path.resolve(event.cwd);
    if (actualCwd !== waiter.expectedCwd) {
      const error = new Error(
        `Agent View worker ${event.sessionId} reported cwd ${actualCwd}, expected ${waiter.expectedCwd}.`,
      );
      this.pendingWorkerReady.delete(event.sessionId);
      waiter.reject(error);
      throw error;
    }
  }

  resolvePendingWorkerReady(sessionId: string): void {
    const waiter = this.pendingWorkerReady.get(sessionId);
    if (!waiter) return;
    this.pendingWorkerReady.delete(sessionId);
    waiter.resolve();
  }

  rejectPendingWorkerReady(sessionId: string, error: unknown): void {
    const waiter = this.pendingWorkerReady.get(sessionId);
    if (!waiter) return;
    this.pendingWorkerReady.delete(sessionId);
    waiter.reject(error instanceof Error ? error : new Error(String(error)));
  }

  async reconnectSessionHost(sessionId: string): Promise<boolean> {
    const [launch, worker] = await Promise.all([
      readAgentViewLaunch(sessionId, this.store),
      readAgentViewWorker(sessionId, this.store),
    ]);
    if (!launch || !worker?.hostEndpoint) {
      return false;
    }

    try {
      const host = await connectAgentViewPtyHostProcess(
        launch,
        worker.hostEndpoint,
        worker.hostAuthToken,
      );
      this.set(sessionId, host);
      await writeAgentViewWorker(
        sessionId,
        {
          schemaVersion: 1,
          hostPid: host.pid,
          workerPid: host.workerPid,
          hostEndpoint: worker.hostEndpoint,
          ...(worker.hostAuthToken
            ? { hostAuthToken: worker.hostAuthToken }
            : {}),
          protocolVersion: AGENT_VIEW_PROTOCOL_VERSION,
          platform: process.platform,
          recentOutputBytes: worker.recentOutputBytes,
        },
        this.store,
      );
      return true;
    } catch {
      return false;
    }
  }

  async getOrReconnectSessionHost(
    sessionId: string,
  ): Promise<AgentViewPtyHostHandle | undefined> {
    const existing = this.ptyHosts.get(sessionId);
    if (existing) {
      return existing;
    }
    if (await this.reconnectSessionHost(sessionId)) {
      return this.ptyHosts.get(sessionId);
    }
    return undefined;
  }

  async respawnSession(
    sessionId: string,
    respawnOptions: { waitForReady?: boolean } = {},
  ): Promise<{ sessionId: string; respawned: true }> {
    const state = await readAgentViewSessionState(sessionId, this.store);
    if (!state) {
      throw new Error(`No Agent View session found for ${sessionId}.`);
    }
    if (state.ownership !== 'managed') {
      throw new Error(`Agent View session ${sessionId} is not managed.`);
    }
    const refreshedState = await this.refreshMissingWorkerState(state);
    const activity = await readAgentViewActivity(sessionId, this.store);
    const blockReason = getRespawnBlockReason(refreshedState, activity);
    if (blockReason) {
      throw new Error(
        `Agent View session ${sessionId} cannot be respawned: ${blockReason}.`,
      );
    }
    const launch = await readAgentViewLaunch(sessionId, this.store);
    if (!launch) {
      throw new Error(`No Agent View launch record found for ${sessionId}.`);
    }
    const resumeLaunch = await writeResumeWorkerLaunch(launch, this.store);
    this.ptyHosts.get(sessionId)?.kill('SIGTERM');
    let host: AgentViewPtyHostHandle | undefined;
    try {
      const ready = this.waitForWorkerReadyIfNeeded(
        sessionId,
        resumeLaunch.activeCwd,
      );
      void ready.catch(() => {});
      host = await this.launchPtyHostForSupervisor(resumeLaunch, this.store);
      this.set(sessionId, host);
      await writeAgentViewSessionState(
        {
          ...state,
          sessionState: 'starting',
          processState: 'starting',
          attachState: 'detached',
          updatedAt: new Date().toISOString(),
        },
        this.store,
      );
      await writeAgentViewWorker(
        sessionId,
        {
          schemaVersion: 1,
          hostPid: host.pid,
          workerPid: host.workerPid,
          ...(host.endpoint ? { hostEndpoint: host.endpoint } : {}),
          ...(host.authToken ? { hostAuthToken: host.authToken } : {}),
          protocolVersion: AGENT_VIEW_PROTOCOL_VERSION,
          platform: process.platform,
          recentOutputBytes: 0,
        },
        this.store,
      );
      if (respawnOptions.waitForReady ?? true) {
        await ready;
      }
    } catch (error) {
      this.rejectPendingWorkerReady(sessionId, error);
      host?.kill('SIGTERM');
      if (this.ptyHosts.delete(sessionId)) {
        this.onHostReleased(sessionId);
      }
      await markFailedSession(sessionId, error, this.store);
      throw error;
    }
    return { sessionId, respawned: true };
  }

  async respawnSessionForAttachIfInactive(sessionId: string): Promise<boolean> {
    let state = await readAgentViewSessionState(sessionId, this.store);
    if (!state) {
      throw new Error(`No Agent View session found for ${sessionId}.`);
    }
    if (state.ownership !== 'managed') {
      throw new Error(`Agent View session ${sessionId} is not managed.`);
    }
    if (
      state.attachState === 'attached' ||
      isStaleStartingState(state, this.options)
    ) {
      state = {
        ...state,
        sessionState: 'failed',
        processState: 'exited',
        attachState: 'detached',
        updatedAt: new Date().toISOString(),
      };
      await writeAgentViewSessionState(state, this.store);
    }
    if (state.sessionState === 'stopped') {
      state = {
        ...state,
        processState: 'exited',
        attachState: 'detached',
        updatedAt: new Date().toISOString(),
      };
      await writeAgentViewSessionState(state, this.store);
    }
    state = await this.refreshMissingWorkerState(state);
    const blockReason = getRespawnBlockReason(
      state,
      await readAgentViewActivity(sessionId, this.store),
    );
    if (!blockReason) {
      await this.respawnSession(sessionId);
      return true;
    }
    await markFailedSession(
      sessionId,
      new Error(`stale PTY host while ${blockReason}`),
      this.store,
      'stale_host',
    );
    return false;
  }

  async respawnStoppedOrFailedSessionIfNeeded(
    sessionId: string,
  ): Promise<boolean> {
    const state = await readAgentViewSessionState(sessionId, this.store);
    if (
      !state ||
      (state.sessionState !== 'stopped' && state.sessionState !== 'failed')
    ) {
      return false;
    }

    this.ptyHosts.get(sessionId)?.kill('SIGTERM');
    this.ptyHosts.delete(sessionId);
    this.onHostReleased(sessionId);
    await writeAgentViewSessionState(
      {
        ...state,
        processState: 'exited',
        attachState: 'detached',
        updatedAt: new Date().toISOString(),
      },
      this.store,
    );
    await this.respawnSession(sessionId);
    return true;
  }

  private trackHostExit(sessionId: string, host: AgentViewPtyHostHandle): void {
    void host.exited
      .then(async (exit) => {
        if (this.ptyHosts.get(sessionId) !== host) {
          return;
        }
        await updateExitedSession(sessionId, exit.exitCode, this.store);
      })
      .catch(() => {})
      .finally(() => {
        if (this.ptyHosts.get(sessionId) !== host) {
          return;
        }
        this.ptyHosts.delete(sessionId);
        this.onHostReleased(sessionId);
        this.onChanged();
      });
  }

  private scheduleStopFallback(
    sessionId: string,
    host: AgentViewPtyHostHandle,
  ): void {
    const timeout = setTimeout(() => {
      if (this.ptyHosts.get(sessionId) !== host) {
        return;
      }
      // Ctrl+X asks the worker to stop first; this is the timeout backstop.
      host.kill('SIGTERM');
      this.ptyHosts.delete(sessionId);
      this.onHostReleased(sessionId);
      void markStoppedSession(sessionId, this.store, 'exited')
        .catch(() => {})
        .finally(() => {
          this.onChanged();
        });
    }, DEFAULT_GRACEFUL_STOP_TIMEOUT_MS);
    timeout.unref?.();
  }

  async refreshMissingWorkerState(
    state: AgentViewSessionStateFile,
  ): Promise<AgentViewSessionStateFile> {
    if (
      state.processState !== 'alive' &&
      state.processState !== 'starting' &&
      state.processState !== 'restarting' &&
      state.processState !== 'hibernating'
    ) {
      return state;
    }
    if (this.ptyHosts.has(state.sessionId)) {
      return state;
    }
    if (await this.reconnectSessionHost(state.sessionId)) {
      return state;
    }

    const worker = await readAgentViewWorker(state.sessionId, this.store);
    if (isPidRunning(worker?.hostPid) || isPidRunning(worker?.workerPid)) {
      return state;
    }

    const nextSessionState =
      state.sessionState === 'starting' ||
      state.sessionState === 'working' ||
      state.sessionState === 'needs_input'
        ? 'failed'
        : state.sessionState;
    const now = new Date().toISOString();
    const nextState = {
      ...state,
      sessionState: nextSessionState,
      processState: 'exited' as const,
      attachState: 'detached' as const,
      updatedAt: now,
      ...(nextSessionState === 'failed'
        ? {
            lastError: {
              code: 'stale_worker',
              message: 'Agent View worker process is no longer running.',
              at: now,
            },
          }
        : {}),
    };
    await writeAgentViewSessionState(nextState, this.store);
    return nextState;
  }
}

class SessionSnapshotCache {
  private snapshots: AgentViewSessionSnapshot[] | undefined;
  private expiresAt = 0;
  private dirty = true;

  markDirty(): void {
    this.dirty = true;
  }

  async list(
    store: AgentViewStoreOptions,
    nowMs: number,
  ): Promise<AgentViewSessionSnapshot[]> {
    if (!this.dirty && this.snapshots && nowMs < this.expiresAt) {
      return this.snapshots;
    }
    this.snapshots = await listAgentViewSessionSnapshots(store);
    this.expiresAt = nowMs + 1000;
    this.dirty = false;
    return this.snapshots;
  }
}

async function shutdownPtyHost(host: AgentViewPtyHostHandle): Promise<void> {
  if (host.shutdown) {
    await host.shutdown();
    return;
  }
  host.kill('SIGTERM');
}

function isAliveProcessState(
  processState: AgentViewSessionStateFile['processState'],
): boolean {
  return (
    processState === 'starting' ||
    processState === 'alive' ||
    processState === 'hibernating' ||
    processState === 'restarting'
  );
}

function canHibernateSession(
  snapshot: AgentViewSessionSnapshot,
  nowMs: number,
  idleMs: number,
): boolean {
  if (snapshot.state.ownership !== 'managed') return false;
  if (!canAgentViewHibernate(snapshot)) {
    return false;
  }
  if (
    snapshot.state.processState === 'hibernated' ||
    snapshot.state.processState === 'exited'
  ) {
    return false;
  }

  const activityAt =
    Date.parse(snapshot.activity?.lastActivityAt ?? snapshot.state.updatedAt) ||
    0;
  return nowMs - activityAt >= idleMs;
}

async function markSessionHibernating(
  state: AgentViewSessionStateFile,
  options: { globalDir?: string },
): Promise<void> {
  await writeAgentViewSessionState(
    {
      ...state,
      processState: 'hibernating',
      updatedAt: new Date().toISOString(),
    },
    options,
  );
}

async function markSessionHibernated(
  state: AgentViewSessionStateFile,
  options: { globalDir?: string },
): Promise<void> {
  await writeAgentViewSessionState(
    {
      ...state,
      processState: 'hibernated',
      updatedAt: new Date().toISOString(),
    },
    options,
  );
}

function pruneClosedSockets(sockets: Set<Socket>): void {
  for (const socket of sockets) {
    if (socket.destroyed) {
      sockets.delete(socket);
    }
  }
}

function pruneClosedSocketMap(sockets: Map<string, Socket>): void {
  for (const [sessionId, socket] of sockets) {
    if (socket.destroyed) {
      sockets.delete(sessionId);
    }
  }
}

function getHibernationPolicy(
  options: AgentViewSupervisorProcessOptions,
): Required<AgentViewSupervisorHibernationPolicy> {
  return {
    enabled: options.hibernationPolicy?.enabled ?? true,
    idleMs: options.hibernationPolicy?.idleMs ?? DEFAULT_IDLE_HIBERNATION_MS,
    autoExit: options.hibernationPolicy?.autoExit ?? true,
    autoExitGraceMs:
      options.hibernationPolicy?.autoExitGraceMs ??
      DEFAULT_SUPERVISOR_AUTO_EXIT_GRACE_MS,
  };
}

function notifyAgentViewSubscribers(subscribers: Set<Socket>): void {
  const payload = `${JSON.stringify({
    type: 'changed',
    at: new Date().toISOString(),
  })}\n`;
  for (const socket of subscribers) {
    if (socket.destroyed) {
      subscribers.delete(socket);
      continue;
    }
    socket.write(payload, (error) => {
      if (error) {
        subscribers.delete(socket);
        socket.destroy();
      }
    });
  }
}

function writeAttachError(
  socket: Socket,
  requestId: string,
  code: string,
  message: string,
): void {
  socket.end(
    `${JSON.stringify({
      id: requestId,
      ok: false,
      error: { code, message },
    })}\n`,
  );
}

async function writeAttachState(
  sessionId: string,
  attachState: 'attached' | 'detached',
  options: { globalDir?: string },
): Promise<void> {
  const state = await readAgentViewSessionState(sessionId, options);
  if (!state) return;
  await writeAgentViewSessionState(
    {
      ...state,
      attachState,
      updatedAt: new Date().toISOString(),
    },
    options,
  );
}

function getQueuedPromptActivityPatch(
  text: string,
  at: string,
): Partial<AgentViewActivityFile> {
  return {
    queuedPromptCount: 1,
    queuedPromptPreview: text,
    lastQueuedPromptAt: at,
  };
}

function getDequeuedPromptActivityPatch(
  _activity: AgentViewActivityFile | undefined,
): Partial<AgentViewActivityFile> {
  return {
    queuedPromptCount: undefined,
    queuedPromptPreview: undefined,
    lastQueuedPromptAt: undefined,
  };
}

function getQueuedPromptCount(
  activity: AgentViewActivityFile | undefined,
): number {
  return typeof activity?.queuedPromptCount === 'number' &&
    Number.isFinite(activity.queuedPromptCount)
    ? Math.max(0, Math.floor(activity.queuedPromptCount))
    : 0;
}

function hasPendingPrompt(
  activity: AgentViewActivityFile | undefined,
): boolean {
  return getQueuedPromptCount(activity) > 0;
}

async function refreshStoredResumeWorkerLaunchIfNeeded(
  launch: AgentViewLaunchFile,
  store: { globalDir?: string },
): Promise<AgentViewLaunchFile> {
  if (!isResumeWorkerLaunch(launch)) {
    return launch;
  }
  const refreshed = refreshResumeWorkerLaunch(launch);
  if (
    refreshed.entrypoint === launch.entrypoint &&
    stringArraysEqual(refreshed.argv, launch.argv)
  ) {
    return launch;
  }
  await writeAgentViewLaunch(refreshed, store);
  return refreshed;
}

function shouldWaitForWorkerReady(
  options: AgentViewSupervisorProcessOptions,
): boolean {
  return options.waitForWorkerReady ?? !options.launchPtyHost;
}

function getRespawnBlockReason(
  state: AgentViewSessionStateFile,
  activity?: AgentViewActivityFile,
): string | undefined {
  if (state.attachState !== 'detached') {
    return 'it is currently attached';
  }
  if (
    state.processState === 'alive' ||
    state.processState === 'starting' ||
    state.processState === 'restarting' ||
    state.processState === 'hibernating'
  ) {
    return `its process is ${state.processState}`;
  }
  if (
    state.sessionState === 'starting' ||
    state.sessionState === 'working' ||
    (state.sessionState === 'needs_input' &&
      getAgentViewActivityInputState(activity) !== 'soft_question')
  ) {
    return `it is ${state.sessionState}`;
  }
  return undefined;
}

function isPidRunning(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'EPERM'
    );
  }
}

function isStaleStartingState(
  state: AgentViewSessionStateFile,
  options: AgentViewSupervisorProcessOptions,
): boolean {
  if (
    state.processState !== 'starting' &&
    state.processState !== 'restarting'
  ) {
    return false;
  }
  const updatedAt = Date.parse(state.updatedAt);
  if (!Number.isFinite(updatedAt)) {
    return false;
  }
  const timeoutMs =
    options.workerReadyTimeoutMs ?? DEFAULT_WORKER_READY_TIMEOUT_MS;
  return Date.now() - updatedAt > timeoutMs;
}

async function markStoppedSession(
  sessionId: string,
  options: { globalDir?: string },
  processState: AgentViewSessionStateFile['processState'] = 'exited',
): Promise<void> {
  const state = await readAgentViewSessionState(sessionId, options);
  if (!state) return;
  if (state.ownership !== 'managed') {
    return;
  }
  if (state.sessionState === 'stopped' && state.processState === processState) {
    return;
  }
  await writeAgentViewSessionState(
    {
      ...state,
      sessionState: 'stopped',
      processState,
      updatedAt: new Date().toISOString(),
    },
    options,
  );
}

async function updateExitedSession(
  sessionId: string,
  exitCode: number,
  options: { globalDir?: string },
): Promise<void> {
  const state = await readAgentViewSessionState(sessionId, options);
  if (!state) return;
  if (
    state.ownership !== 'managed' ||
    state.sessionState === 'stopped' ||
    state.processState === 'hibernated'
  ) {
    return;
  }
  await writeAgentViewSessionState(
    {
      ...state,
      sessionState: exitCode === 0 ? 'completed' : 'failed',
      processState: 'exited',
      updatedAt: new Date().toISOString(),
    },
    options,
  );
}

async function markFailedSession(
  sessionId: string,
  error: unknown,
  options: { globalDir?: string },
  code = 'pty_launch_failed',
): Promise<void> {
  const state = await readAgentViewSessionState(sessionId, options);
  if (!state) return;
  const now = new Date().toISOString();
  await writeAgentViewSessionState(
    {
      ...state,
      sessionState: 'failed',
      processState: 'exited',
      updatedAt: now,
      lastError: {
        code,
        message: error instanceof Error ? error.message : String(error),
        at: now,
      },
    },
    options,
  );
}

async function applyWorkerEvent(
  event: AgentViewWorkerEvent,
  options: { globalDir?: string },
): Promise<void> {
  const state = await readAgentViewSessionState(event.sessionId, options);
  if (!state) {
    throw new Error(`No Agent View session found for ${event.sessionId}.`);
  }
  if (state.ownership !== 'managed' && state.ownership !== 'adopting') {
    throw new Error(`Agent View session ${event.sessionId} is not managed.`);
  }

  const now = event.at ?? new Date().toISOString();
  const activeCwd =
    event.type === 'ready' || event.type === 'state'
      ? path.resolve(event.cwd ?? state.activeCwd)
      : state.activeCwd;
  const sessionState =
    event.type === 'ready'
      ? 'idle'
      : event.type === 'state'
        ? event.sessionState
        : state.sessionState;

  await writeAgentViewSessionState(
    {
      ...state,
      sessionState,
      processState: 'alive',
      activeCwd,
      updatedAt: now,
    },
    options,
  );

  const existingActivity = await readAgentViewActivity(
    event.sessionId,
    options,
  );
  const activityPatch =
    event.type === 'state' || event.type === 'ready'
      ? {
          ...(event.summary ? { summary: event.summary } : {}),
          ...(event.type === 'state'
            ? { waitingFor: event.waitingFor || undefined }
            : {}),
          ...(event.type === 'state'
            ? {
                inputKind:
                  event.inputKind ??
                  inferInputKind(event.sessionState, event.waitingFor),
              }
            : {}),
          ...(event.type === 'state' && event.lastResult
            ? { lastResult: event.lastResult }
            : {}),
          ...(shouldClearPendingPrompt(event)
            ? getDequeuedPromptActivityPatch(existingActivity)
            : {}),
          capabilities:
            event.type === 'ready' ? (event.capabilities ?? []) : [],
        }
      : { capabilities: [] };
  const lastActivityAt = shouldAdvanceActivityTime({
    event,
    previousState: state,
    nextSessionState: sessionState,
    existingActivity,
    activityPatch,
  })
    ? now
    : (existingActivity?.lastActivityAt ?? now);
  await writeAgentViewActivity(
    event.sessionId,
    {
      schemaVersion: 1,
      ...activityPatch,
      lastActivityAt,
    },
    options,
  );
  await writeAgentViewWorker(
    event.sessionId,
    {
      schemaVersion: 1,
      protocolVersion: AGENT_VIEW_PROTOCOL_VERSION,
      platform: process.platform,
      lastHeartbeatAt: now,
      recentOutputBytes: 0,
    },
    options,
  );
}

async function applyWorkerHeartbeatEvent(
  event: Extract<AgentViewWorkerEvent, { type: 'heartbeat' }>,
  options: { globalDir?: string },
): Promise<void> {
  const state = await readAgentViewSessionState(event.sessionId, options);
  if (!state) {
    throw new Error(`No Agent View session found for ${event.sessionId}.`);
  }
  if (state.ownership !== 'managed' && state.ownership !== 'adopting') {
    throw new Error(`Agent View session ${event.sessionId} is not managed.`);
  }

  await writeAgentViewWorker(
    event.sessionId,
    {
      schemaVersion: 1,
      protocolVersion: AGENT_VIEW_PROTOCOL_VERSION,
      platform: process.platform,
      lastHeartbeatAt: event.at ?? new Date().toISOString(),
      recentOutputBytes: 0,
    },
    options,
  );
}

function shouldClearPendingPrompt(event: AgentViewWorkerEvent): boolean {
  return (
    event.type === 'state' &&
    (event.sessionState === 'idle' ||
      event.sessionState === 'completed' ||
      (event.sessionState === 'needs_input' && event.waitingFor === 'response'))
  );
}

function shouldAdvanceActivityTime({
  event,
  previousState,
  nextSessionState,
  existingActivity,
  activityPatch,
}: {
  event: AgentViewWorkerEvent;
  previousState: AgentViewSessionStateFile;
  nextSessionState: AgentViewSessionStateFile['sessionState'];
  existingActivity: AgentViewActivityFile | undefined;
  activityPatch: Partial<AgentViewActivityFile>;
}): boolean {
  if (!existingActivity) {
    return true;
  }
  if (event.type === 'ready') {
    return true;
  }
  if (event.type !== 'state') {
    return false;
  }
  if (event.sessionState === 'working') {
    return true;
  }
  if (previousState.sessionState !== nextSessionState) {
    return true;
  }
  if (
    activityPatch.summary !== undefined &&
    activityPatch.summary !== existingActivity.summary
  ) {
    return true;
  }
  if (
    activityPatch.waitingFor !== existingActivity.waitingFor ||
    activityPatch.inputKind !== existingActivity.inputKind
  ) {
    return true;
  }
  if (
    activityPatch.lastResult !== undefined &&
    activityPatch.lastResult !== existingActivity.lastResult
  ) {
    return true;
  }
  return (
    shouldClearPendingPrompt(event) &&
    getQueuedPromptCount(existingActivity) > 0
  );
}

function inferInputKind(
  sessionState: AgentViewSessionStateFile['sessionState'],
  waitingFor: string | undefined,
): 'blocking' | 'soft' | undefined {
  if (sessionState !== 'needs_input') {
    return undefined;
  }
  return waitingFor === 'response' ? 'soft' : 'blocking';
}

async function clearStalePendingPromptIfNeeded(
  state: AgentViewSessionStateFile,
  activity: AgentViewActivityFile | undefined,
  store: { globalDir?: string },
): Promise<AgentViewActivityFile | undefined> {
  if (!shouldClearStalePendingPrompt(state, activity)) {
    return activity;
  }
  const nextActivity = {
    ...activity,
    ...getDequeuedPromptActivityPatch(activity),
  };
  await writeAgentViewActivity(state.sessionId, nextActivity, store);
  return nextActivity;
}

function shouldClearStalePendingPrompt(
  state: AgentViewSessionStateFile,
  activity: AgentViewActivityFile | undefined,
): activity is AgentViewActivityFile {
  if (
    state.sessionState !== 'needs_input' ||
    activity?.waitingFor !== 'response' ||
    !hasPendingPrompt(activity) ||
    !activity.lastQueuedPromptAt
  ) {
    return false;
  }
  const lastActivityAt = Date.parse(activity.lastActivityAt);
  const lastQueuedPromptAt = Date.parse(activity.lastQueuedPromptAt);
  return (
    Number.isFinite(lastActivityAt) &&
    Number.isFinite(lastQueuedPromptAt) &&
    lastActivityAt > lastQueuedPromptAt
  );
}

function requireSessionId(params: Record<string, unknown> | undefined): string {
  const sessionId = params?.['sessionId'];
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('Agent View session id is required.');
  }
  return sessionId;
}

function requireText(params: Record<string, unknown> | undefined): string {
  const text = params?.['text'];
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('Agent View message text is required.');
  }
  return text;
}

function positiveIntegerParam(
  params: Record<string, unknown> | undefined,
  key: string,
): number {
  const value = params?.[key];
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Error(`Agent View ${key} must be a positive integer.`);
  }
  return Number(value);
}

function parseAdoptParams(params: Record<string, unknown> | undefined): {
  sessionId: string;
  projectCwd: string;
  activeCwd: string;
  approvalMode?: string;
  sandbox?: string;
  terminal: { columns: number; rows: number };
} {
  const sessionId = requireSessionId(params);
  if (!params) {
    throw new Error('Agent View adoption params are required.');
  }
  const projectCwd = stringParam(params, 'projectCwd', { required: true });
  const activeCwd = stringParam(params, 'activeCwd', { required: true });
  if (!projectCwd || !activeCwd) {
    throw new Error('Agent View adoption cwd is required.');
  }
  const terminal = params['terminal'];
  if (!isRecord(terminal)) {
    throw new Error('Agent View adoption terminal size is required.');
  }
  const approvalMode = stringParam(params, 'approvalMode');
  const sandbox = stringParam(params, 'sandbox');
  return {
    sessionId,
    projectCwd,
    activeCwd,
    ...(approvalMode !== undefined ? { approvalMode } : {}),
    ...(sandbox !== undefined ? { sandbox } : {}),
    terminal: {
      columns: positiveIntegerParam(terminal, 'columns'),
      rows: positiveIntegerParam(terminal, 'rows'),
    },
  };
}

function parseWorkerEvent(
  params: Record<string, unknown> | undefined,
): AgentViewWorkerEvent {
  if (!params) {
    throw new Error('Agent View worker event is required.');
  }
  const type = params['type'];
  const sessionId = params['sessionId'];
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('Agent View worker event session id is required.');
  }
  if (type === 'ready') {
    const cwd = stringParam(params, 'cwd', { required: true });
    if (!cwd) {
      throw new Error('Agent View worker event cwd is required.');
    }
    const summary = stringParam(params, 'summary');
    const at = stringParam(params, 'at');
    return {
      type,
      sessionId,
      cwd,
      ...(summary !== undefined ? { summary } : {}),
      ...(at !== undefined ? { at } : {}),
      capabilities: stringArrayParam(params, 'capabilities'),
    };
  }
  if (type === 'heartbeat') {
    const at = stringParam(params, 'at');
    return {
      type,
      sessionId,
      ...(at !== undefined ? { at } : {}),
    };
  }
  if (type === 'detach') {
    const at = stringParam(params, 'at');
    return {
      type,
      sessionId,
      ...(at !== undefined ? { at } : {}),
    };
  }
  if (type === 'state') {
    const sessionState = params['sessionState'];
    if (
      sessionState !== 'starting' &&
      sessionState !== 'working' &&
      sessionState !== 'needs_input' &&
      sessionState !== 'idle' &&
      sessionState !== 'completed' &&
      sessionState !== 'stopped' &&
      sessionState !== 'failed'
    ) {
      throw new Error('Agent View worker event state is invalid.');
    }
    const cwd = stringParam(params, 'cwd');
    const summary = stringParam(params, 'summary');
    const waitingFor = stringParam(params, 'waitingFor');
    const inputKind = inputKindParam(params);
    const lastResult = stringParam(params, 'lastResult');
    const at = stringParam(params, 'at');
    return {
      type,
      sessionId,
      sessionState,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(waitingFor !== undefined ? { waitingFor } : {}),
      ...(inputKind !== undefined ? { inputKind } : {}),
      ...(lastResult !== undefined ? { lastResult } : {}),
      ...(at !== undefined ? { at } : {}),
    };
  }
  throw new Error('Agent View worker event type is invalid.');
}

function inputKindParam(
  params: Record<string, unknown>,
): 'blocking' | 'soft' | undefined {
  const value = params['inputKind'];
  return value === 'blocking' || value === 'soft' ? value : undefined;
}

function stringParam(
  params: Record<string, unknown>,
  key: string,
  options: { required?: boolean } = {},
): string | undefined {
  const value = params[key];
  if (typeof value === 'string' && value.length > 0) return value;
  if (options.required) {
    throw new Error(`Agent View worker event ${key} is required.`);
  }
  return undefined;
}

function stringArrayParam(
  params: Record<string, unknown>,
  key: string,
): string[] {
  const value = params[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function buildResumeWorkerArgv(sessionId: string): string[] {
  return buildCurrentQwenCliArgv(['--resume', sessionId]);
}

function refreshResumeWorkerLaunch(
  launch: AgentViewLaunchFile,
): AgentViewLaunchFile {
  return {
    ...launch,
    entrypoint: getCurrentQwenCliEntrypoint(),
    argv: buildResumeWorkerArgv(launch.sessionId),
  };
}

async function writeResumeWorkerLaunch(
  launch: AgentViewLaunchFile,
  store: { globalDir?: string },
): Promise<AgentViewLaunchFile> {
  const resumeLaunch = refreshResumeWorkerLaunch(launch);
  await writeAgentViewLaunch(resumeLaunch, store);
  return resumeLaunch;
}

function isResumeWorkerLaunch(launch: AgentViewLaunchFile): boolean {
  const resumeIndex = launch.argv.indexOf('--resume');
  return resumeIndex >= 0 && launch.argv[resumeIndex + 1] === launch.sessionId;
}

function stringArraysEqual(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function digestToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function requireValidWorkerToken(
  sessionId: string,
  params: Record<string, unknown> | undefined,
  options: { globalDir?: string },
): Promise<void> {
  const token = params?.['token'];
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('Agent View worker token is required.');
  }
  const worker = await readAgentViewWorker(sessionId, options);
  if (!worker?.tokenDigest) {
    throw new Error(`No Agent View worker token found for ${sessionId}.`);
  }
  if (!tokenDigestMatches(token, worker.tokenDigest)) {
    throw new Error('Agent View worker token is invalid.');
  }
}

function tokenDigestMatches(token: string, expectedDigest: string): boolean {
  const actual = Buffer.from(digestToken(token), 'hex');
  const expected = Buffer.from(expectedDigest, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function requireKnownSession(
  sessionId: string,
  options: { globalDir?: string },
): Promise<void> {
  const state = await readAgentViewSessionState(sessionId, options);
  if (!state) {
    throw new Error(`No Agent View session found for ${sessionId}.`);
  }
  if (state.ownership !== 'managed') {
    throw new Error(`Agent View session ${sessionId} is not managed.`);
  }
}

async function resolveManagedSessionId(
  requestedSessionId: string,
  options: { globalDir?: string },
): Promise<string> {
  const exact = await readAgentViewSessionState(requestedSessionId, options);
  if (exact) {
    if (exact.ownership !== 'managed') {
      throw new Error(
        `Agent View session ${requestedSessionId} is not managed.`,
      );
    }
    return requestedSessionId;
  }

  const matches = (await listAgentViewSessionStates(options)).filter(
    (state) =>
      state.ownership === 'managed' &&
      state.sessionId.startsWith(requestedSessionId),
  );
  if (matches.length === 1) {
    return matches[0].sessionId;
  }
  if (matches.length > 1) {
    throw new Error(
      `Agent View session id ${requestedSessionId} is ambiguous. Use a longer id.`,
    );
  }
  throw new Error(`No Agent View session found for ${requestedSessionId}.`);
}

function storeOptions(options: AgentViewSupervisorProcessOptions): {
  globalDir?: string;
} {
  return {
    ...(options.globalDir ? { globalDir: options.globalDir } : {}),
  };
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}
