/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Socket } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  AgentViewAttachLeaseManager,
  DEFAULT_AGENT_VIEW_ATTACH_LEASE_TTL_MS,
} from './attach-lease.js';
import { AGENT_VIEW_PROTOCOL_VERSION } from './protocol.js';
import type {
  AgentViewActivityFile,
  AgentViewLaunchFile,
  AgentViewRosterEntry,
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
  digestAgentViewWorkerToken,
  getAgentViewSessionPaths,
  getAgentViewStorePaths,
  inputKindValue,
  isAgentViewSessionState,
  listAgentViewSessionSnapshots,
  listAgentViewSessionStates,
  patchAgentViewActivityIf,
  patchAgentViewSessionState,
  patchAgentViewSessionStateIf,
  readAgentViewLaunch,
  readAgentViewActivity,
  readAgentViewRosterForWrite,
  readAgentViewSessionState,
  readAgentViewWorker,
  redactAgentViewWorker,
  removeAgentViewRosterEntry,
  sanitizeSessionId,
  upsertAgentViewRosterEntry,
  updateAgentViewRosterEntry,
  writeAgentViewActivity,
  writeAgentViewLaunch,
  writeAgentViewSessionState,
  writeAgentViewWorker,
} from './supervisor-store.js';
import type { AgentViewSupervisorHandler } from './supervisor-server.js';
import {
  createAgentViewWorkerSidebandEnv,
  QWEN_AGENT_VIEW_TOKEN,
} from './worker-sideband.js';
import {
  buildCurrentQwenCliArgv,
  getCurrentQwenCliEntrypoint,
} from './current-cli-argv.js';
import {
  canAgentViewHibernate,
  canAgentViewQueueFollowUp,
  getAgentViewActivityInputState,
} from './presentation.js';

function resolveSessionCwd(cwd: string): string {
  try {
    return fs.realpathSync(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

const UNIX_SOCKET_PATH_LIMIT = 100;
const DEFAULT_IDLE_HIBERNATION_MS = 30 * 60 * 1000;
const DEFAULT_SUPERVISOR_AUTO_EXIT_GRACE_MS = 10 * 60 * 1000;
const DEFAULT_WORKER_READY_TIMEOUT_MS = 15_000;
const DEFAULT_GRACEFUL_STOP_TIMEOUT_MS = 10_000;
const DEFAULT_ATTACH_LEASE_HEARTBEAT_MS =
  DEFAULT_AGENT_VIEW_ATTACH_LEASE_TTL_MS / 3;

export interface AgentViewSupervisorHibernationPolicy {
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
  generation: number;
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

  // Fall back to a per-uid directory under the runtime dir. prepareSocketPath
  // creates it 0700 when missing and the socket file is 0600, but the directory
  // name is predictable: on a shared multi-user tmpdir a pre-existing directory
  // is reused with its current owner and mode. Callers that need a hardened
  // path should pass a private 0700 runtimeDir (e.g. XDG_RUNTIME_DIR).
  const uid = process.getuid?.();
  const fallbackDir =
    uid === undefined ? `qwen-agent-view-${digest}` : `qwen-agent-view-${uid}`;
  const fallbackPath = path.join(
    options.runtimeDir ?? os.tmpdir(),
    fallbackDir,
    `supervisor-${digest}.sock`,
  );
  if (Buffer.byteLength(fallbackPath) < UNIX_SOCKET_PATH_LIMIT) {
    return fallbackPath;
  }

  const compactPath = path.join(
    options.runtimeDir ?? os.tmpdir(),
    uid === undefined ? `qav-${digest.slice(0, 8)}` : `qav-${uid}`,
    `${digest}.sock`,
  );
  if (Buffer.byteLength(compactPath) < UNIX_SOCKET_PATH_LIMIT) {
    return compactPath;
  }
  throw new Error(
    `Agent View supervisor socket path is too long: ${compactPath}`,
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
      (sessionId) => {
        this.pendingWorkerControls.delete(sessionId);
        void clearPersistedPromptQueue(sessionId, this.store)
          .then((changed) => {
            if (changed) this.notifyChanged();
          })
          .catch(() => {});
      },
      (sessionId) => {
        // prompt/answer controls hold accepted user input and survive a
        // worker replacement; superseded stop/redraw controls must not
        // reach the replacement worker.
        const kept = (this.pendingWorkerControls.get(sessionId) ?? []).filter(
          (event) => event.type === 'prompt' || event.type === 'answer',
        );
        if (kept.length > 0) {
          this.pendingWorkerControls.set(sessionId, kept);
        } else {
          this.pendingWorkerControls.delete(sessionId);
        }
      },
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
    let changed = false;
    for (const snapshot of (
      await this.snapshotCache.list(
        store,
        (this.options.now?.() ?? new Date()).getTime(),
      )
    ).filter((snapshot) => snapshot.state.ownership !== 'unmanaged')) {
      let state = snapshot.state;
      let activity = snapshot.activity;
      try {
        state = await this.workers.refreshMissingWorkerState(snapshot.state);
        activity = await clearStalePendingPromptIfNeeded(
          state,
          snapshot.activity,
          store,
          this.hasPendingWorkerInputControl(snapshot.sessionId),
          this.workers.has(snapshot.sessionId),
          this.startedAt,
        );
      } catch {
        // Per-session healing is best-effort: one unreadable session
        // directory must not reject the whole listing — fall back to the
        // cached snapshot and continue.
        state = snapshot.state;
        activity = snapshot.activity;
      }
      if (state !== snapshot.state || activity !== snapshot.activity) {
        changed = true;
      }
      snapshots.push({
        ...snapshot,
        state,
        activity,
      });
    }
    if (changed) {
      this.notifyChanged();
    }
    const cwd = typeof params?.['cwd'] === 'string' ? params['cwd'] : undefined;
    if (!cwd) return snapshots;
    const resolvedCwd = path.resolve(cwd);
    const descendantPrefix = resolvedCwd.endsWith(path.sep)
      ? resolvedCwd
      : `${resolvedCwd}${path.sep}`;
    return snapshots.filter(
      (snapshot) =>
        snapshot.state.projectCwd === resolvedCwd ||
        snapshot.state.activeCwd === resolvedCwd ||
        snapshot.state.activeCwd.startsWith(descendantPrefix),
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
      publishRoster: false,
      promptInArgv: !shouldWaitForWorkerReady(this.options),
    });
    const launch = await readAgentViewLaunch(result.sessionId, store);
    if (!launch) {
      throw new Error('Agent View dispatch launch record was not written.');
    }

    let readyCompleted = false;
    try {
      const ready = this.workers.waitForWorkerReadyIfNeeded(
        result.sessionId,
        launch.activeCwd,
      );
      void ready.catch(() => {});
      const host = await this.workers.launchPtyHostForSupervisor(launch, store);
      await ensureSessionStillLaunchable(result.sessionId, store, host);
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
      readyCompleted = true;
      await ensureSessionStillLaunchable(result.sessionId, store);
      if (shouldWaitForWorkerReady(this.options)) {
        await this.queuePromptForSession(result.sessionId, prompt);
      }
      const state = await readAgentViewSessionState(result.sessionId, store);
      const publishedAt = new Date().toISOString();
      try {
        await upsertAgentViewRosterEntry(
          {
            sessionId: result.sessionId,
            projectCwd: launch.projectCwd,
            activeCwd: launch.activeCwd,
            createdAt: state?.createdAt ?? publishedAt,
            updatedAt: publishedAt,
          },
          store,
        );
      } catch {
        // The worker is already running and ready; a roster publication
        // failure must not fail the dispatch or orphan the live worker.
      }
      this.notifyChanged();
      return result;
    } catch (error) {
      if (!readyCompleted) {
        if (isStoppedError(error)) {
          // A deliberate stop during the ready wait must not be mislabeled
          // as a launch failure. If the racing stop found no host and no
          // stored pid to signal, it queued no stop control, so nothing
          // graceful will ever reach the just-launched host —
          // terminate it. A pending stop control means a graceful stop is
          // already in flight and must not be hard-killed.
          if (!this.hasPendingWorkerStopControl(result.sessionId)) {
            this.workers.terminateSession(result.sessionId, 'SIGTERM');
          }
          await markStoppedSession(result.sessionId, store, 'exited');
        } else {
          this.workers.rejectPendingWorkerReady(result.sessionId, error);
          this.workers.terminateSession(result.sessionId, 'SIGTERM');
          await markFailedSession(result.sessionId, error, store);
        }
        this.notifyChanged();
      }
      throw error;
    }
  }
  async adopt(params?: Record<string, unknown>) {
    const adoption = parseAdoptParams(params);
    const store = this.store;
    return this.workers.withHostSetupLock(adoption.sessionId, async () => {
      const existingState = await readAgentViewSessionState(
        adoption.sessionId,
        store,
      );
      if (existingState?.ownership === 'managed') {
        return {
          sessionId: adoption.sessionId,
          adopted: false,
          alreadyManaged: true,
        };
      }
      if (existingState?.ownership === 'adopting') {
        const worker = await readAgentViewWorker(adoption.sessionId, store);
        if (
          this.workers.has(adoption.sessionId) ||
          isPidRunning(worker?.hostPid) ||
          isPidRunning(worker?.workerPid)
        ) {
          return {
            sessionId: adoption.sessionId,
            adopted: false,
            alreadyManaged: true,
          };
        }
        // Stale 'adopting' left by a supervisor crash mid-adopt: no live host
        // or worker process remains, so allow the session to be re-adopted.
      }
      if (this.workers.has(adoption.sessionId)) {
        throw new Error(
          `Agent View session ${adoption.sessionId} is already running.`,
        );
      }

      const token = randomUUID();
      const now = new Date().toISOString();
      const activeCwd = path.resolve(adoption.activeCwd);
      const projectCwd = path.resolve(adoption.projectCwd);
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

      try {
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
            tokenDigest: digestAgentViewWorkerToken(token),
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
        const launch = await readAgentViewLaunch(adoption.sessionId, store);
        if (!launch) {
          throw new Error('Agent View adoption launch record was not written.');
        }
        const ready = this.workers.waitForWorkerReadyIfNeeded(
          adoption.sessionId,
          activeCwd,
        );
        void ready.catch(() => {});
        const host = await this.workers.launchPtyHostForSupervisor(
          launch,
          store,
        );
        await ensureSessionStillLaunchable(adoption.sessionId, store, host);
        this.workers.set(adoption.sessionId, host);
        const latestState =
          (await readAgentViewSessionState(adoption.sessionId, store)) ??
          adoptingState;
        await patchAgentViewSessionState(
          adoption.sessionId,
          {
            ownership: 'managed',
            sessionState:
              latestState.processState === 'alive'
                ? latestState.sessionState
                : 'starting',
            processState:
              latestState.processState === 'alive' ? 'alive' : 'starting',
            attachState: 'detached',
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
        await ensureSessionStillLaunchable(adoption.sessionId, store);
        this.notifyChanged();
        return { sessionId: adoption.sessionId, adopted: true };
      } catch (error) {
        if (isStoppedError(error)) {
          // A deliberate stop during the adopt ready wait must not be
          // mislabeled as an adoption failure — matching dispatch()'s
          // catch, including terminating the host a racing stop could not
          // reach (no stop control was queued for it).
          if (!this.hasPendingWorkerStopControl(adoption.sessionId)) {
            this.workers.terminateSession(adoption.sessionId, 'SIGTERM');
          }
          await markStoppedSession(adoption.sessionId, store, 'exited');
        } else {
          this.workers.rejectPendingWorkerReady(adoption.sessionId, error);
          this.workers.terminateSession(adoption.sessionId, 'SIGTERM');
          const failedAt = new Date().toISOString();
          // Never restore a stale 'adopting' record: re-persisting it would
          // lock the session out of every managed operation. Fall through to
          // the terminal adoption_failed state so a later adopt can retry.
          const restorableState =
            existingState && existingState.ownership !== 'adopting'
              ? existingState
              : undefined;
          await writeAgentViewSessionState(
            restorableState ?? {
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
        }
        await removeAgentViewRosterEntry(adoption.sessionId, store);
        this.notifyChanged();
        throw error;
      }
    });
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
    let applied = true;
    try {
      applied = await applyWorkerEvent(
        event,
        this.store,
        this.hasPendingWorkerInputControl(event.sessionId),
      );
    } catch (error) {
      if (event.type === 'ready') {
        this.workers.rejectPendingWorkerReady(event.sessionId, error);
      }
      throw error;
    }
    if (event.type === 'ready') {
      if (applied) {
        this.workers.resolvePendingWorkerReady(event.sessionId);
      } else {
        // The ready was dropped (dead-worker guard or in-queue re-validation):
        // fail the waiter fast instead of hanging until the ready timeout.
        this.workers.rejectPendingWorkerReady(
          event.sessionId,
          new AgentViewSessionStoppedError(event.sessionId, 'worker'),
        );
      }
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
      const state = await readAgentViewSessionState(sessionId, this.store);
      if (state) {
        await this.detachIfAttachIsStale(state);
      }
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
    const storedActivity = await readAgentViewActivity(sessionId, store);
    const activity = await clearStalePendingPromptIfNeeded(
      state,
      storedActivity,
      store,
      this.hasPendingWorkerInputControl(sessionId),
      this.workers.has(sessionId),
      this.startedAt,
    );
    if (activity !== storedActivity) {
      this.notifyChanged();
    }
    return {
      sessionId,
      state,
      activity,
      worker: redactAgentViewWorker(
        await readAgentViewWorker(sessionId, store),
      ),
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
        const attachRefreshedState = await this.detachIfAttachIsStale(state);
        const refreshedState =
          await this.workers.refreshMissingWorkerState(attachRefreshedState);
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
        try {
          results.push(await this.workers.respawnSession(state.sessionId));
        } catch (error) {
          results.push({
            sessionId: state.sessionId,
            skipped: true,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      this.notifyChanged();
      return { all: true, results };
    }
    const sessionId = await resolveManagedSessionId(
      requireSessionId(params),
      this.store,
    );
    const state = await readAgentViewSessionState(sessionId, this.store);
    if (state) {
      await this.detachIfAttachIsStale(state);
    }
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
    await this.workers.killSession(sessionId, 'SIGTERM');
    const state = await readAgentViewSessionState(sessionId, store);
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
    const update = (current: AgentViewRosterEntry): AgentViewRosterEntry => ({
      ...current,
      pinned: pinned ?? !current.pinned,
      updatedAt: now,
    });
    let entry = await updateAgentViewRosterEntry(sessionId, update, store);
    if (!entry) {
      // The dispatch-time roster publication is best-effort (it must not
      // fail a live dispatch); heal the missing entry lazily so pin/rename
      // do not wedge forever after a transient roster write failure.
      await this.republishMissingRosterEntry(sessionId);
      entry = await updateAgentViewRosterEntry(sessionId, update, store);
    }
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
    const update = (current: AgentViewRosterEntry): AgentViewRosterEntry => {
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
    };
    let entry = await updateAgentViewRosterEntry(sessionId, update, store);
    if (!entry) {
      await this.republishMissingRosterEntry(sessionId);
      entry = await updateAgentViewRosterEntry(sessionId, update, store);
    }
    if (!entry) {
      throw new Error(`No Agent View roster entry found for ${sessionId}.`);
    }
    this.notifyChanged();
    return { sessionId, displayName: entry.displayName ?? '' };
  }
  private async republishMissingRosterEntry(sessionId: string): Promise<void> {
    const state = await readAgentViewSessionState(sessionId, this.store);
    if (!state) {
      return;
    }
    await upsertAgentViewRosterEntry(
      {
        sessionId,
        projectCwd: state.projectCwd,
        activeCwd: state.activeCwd,
        createdAt: state.createdAt,
        updatedAt: new Date().toISOString(),
      },
      this.store,
    );
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
    const snapshots = await listAgentViewSessionSnapshots(this.store);
    const nowMs = (this.options.now?.() ?? new Date()).getTime();
    const hibernated: string[] = [];
    for (const snapshot of snapshots) {
      const host = this.workers.get(snapshot.sessionId);
      if (!host) {
        await this.workers.refreshMissingWorkerState(snapshot.state);
        continue;
      }
      if (
        this.hasLiveAttach(snapshot.sessionId) ||
        this.hasPendingWorkerInputControl(snapshot.sessionId) ||
        this.hasPendingWorkerStopControl(snapshot.sessionId) ||
        !canHibernateSession(snapshot, nowMs, policy.idleMs)
      ) {
        continue;
      }

      const didHibernate = await this.workers.withHostSetupLock(
        snapshot.sessionId,
        async () => {
          // Re-check inside the lock: a concurrent dispatch or respawn
          // may have changed the session between the snapshot and now.
          if (
            this.hasLiveAttach(snapshot.sessionId) ||
            this.hasPendingWorkerInputControl(snapshot.sessionId) ||
            this.hasPendingWorkerStopControl(snapshot.sessionId)
          ) {
            return false;
          }
          // Re-verify the pin inside the lock: the snapshot's rosterEntry
          // comes from a soft-fail join, so a transient roster read error
          // must not silently void the user's keep-alive opt-out. An
          // unreadable roster fails closed (skip this candidate).
          let roster;
          try {
            roster = await readAgentViewRosterForWrite(this.store);
          } catch {
            return false;
          }
          if (
            roster.sessions.some(
              (entry) =>
                entry.pinned &&
                sanitizeSessionId(entry.sessionId) === snapshot.sessionId,
            )
          ) {
            return false;
          }
          if (!(await markSessionHibernating(snapshot.state, this.store))) {
            return false;
          }
          const latestState = await readAgentViewSessionState(
            snapshot.sessionId,
            this.store,
          );
          const latestActivity = await readAgentViewActivity(
            snapshot.sessionId,
            this.store,
          );
          if (
            !latestState ||
            latestState.sessionState === 'stopped' ||
            latestState.sessionState === 'working' ||
            latestState.processState !== 'hibernating' ||
            this.hasLiveAttach(snapshot.sessionId) ||
            this.hasPendingWorkerInputControl(snapshot.sessionId) ||
            this.hasPendingWorkerStopControl(snapshot.sessionId) ||
            hasPendingPrompt(latestActivity) ||
            // Re-run the idle-window freshness check against the re-read
            // record: activity a worker reported since the pre-lock
            // snapshot makes hibernating now cost the user a respawn.
            (latestActivity?.lastActivityAt !== undefined &&
              nowMs - Date.parse(latestActivity.lastActivityAt) < policy.idleMs)
          ) {
            if (latestState?.processState === 'hibernating') {
              // Flip back inside the queued mutation: a concurrent stop
              // verdict enqueued between the re-read above and this
              // rollback must not be re-asserted away by a stale snapshot.
              await patchAgentViewSessionStateIf(
                snapshot.sessionId,
                (existing) =>
                  existing.processState === 'hibernating'
                    ? {
                        processState: 'alive',
                        updatedAt: new Date().toISOString(),
                      }
                    : undefined,
                this.store,
              );
            }
            return false;
          }
          await this.workers.shutdownHost(snapshot.sessionId, host);
          return markSessionHibernated(snapshot.state, this.store);
        },
      );
      if (didHibernate) {
        hibernated.push(snapshot.sessionId);
      }
    }

    return { hibernated };
  }

  private async shouldAutoExitAfterHibernation(
    policy: ReturnType<typeof getHibernationPolicy>,
  ): Promise<boolean> {
    if (!policy.autoExit) {
      return false;
    }
    pruneClosedSockets(this.subscribers);
    pruneClosedSocketMap(this.attachSockets);
    if (this.subscribers.size > 0 || this.attachSockets.size > 0) {
      return false;
    }

    const states = await listAgentViewSessionStates(this.store);
    // Reconcile ghost 'adopting' records left by a supervisor that died
    // mid-adoption: nothing will ever finish them, so they must not block
    // auto-exit forever. A live adoption holds a fresh starting record and
    // its own ready timeout bounds how long it can stay that way.
    const adoptingInFlight: AgentViewSessionStateFile[] = [];
    for (const state of states) {
      if (state.ownership !== 'adopting') {
        continue;
      }
      if (
        isStaleStartingState(state, this.options) ||
        !isAliveProcessState(state.processState)
      ) {
        const failedAt = new Date().toISOString();
        await writeAgentViewSessionState(
          {
            ...state,
            ownership: 'unmanaged',
            processState: 'exited',
            updatedAt: failedAt,
            lastError: {
              code: 'adoption_failed',
              message: 'Agent View adoption did not complete.',
              at: failedAt,
            },
          },
          this.store,
        );
        await removeAgentViewRosterEntry(state.sessionId, this.store);
        continue;
      }
      adoptingInFlight.push(state);
    }
    // An adoption in flight launches a detached host and waits for ready; do
    // not auto-exit underneath it.
    if (adoptingInFlight.length > 0) {
      return false;
    }
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

    try {
      await requireKnownSession(sessionId, this.store);
    } catch (error) {
      this.attachLeases.release(sessionId, leaseResult.lease.leaseId);
      throw error;
    }
    const host = this.workers.get(sessionId);
    if (!host) {
      this.attachLeases.release(sessionId, leaseResult.lease.leaseId);
      writeAttachError(
        socket,
        requestId,
        'not_running',
        `Agent View session ${sessionId} is not running.`,
      );
      return;
    }

    const controller = new AbortController();
    socket.once('close', () => controller.abort());
    void host.exited
      .catch(() => {})
      .finally(() => {
        controller.abort();
      });
    const heartbeat = setInterval(() => {
      this.attachLeases.heartbeat(sessionId, leaseResult.lease.leaseId);
    }, DEFAULT_ATTACH_LEASE_HEARTBEAT_MS);
    heartbeat.unref?.();
    let bridged = false;
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
      bridged = true;
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
      if (bridged) {
        try {
          await writeAttachState(sessionId, 'detached', this.store);
        } catch {
          // Best-effort: a store error during detach must not mask
          // the original error from the try block.
        }
        socket.end();
      }
      // Pre-bridge failure: leave the socket open so the RPC layer can
      // deliver the structured error envelope instead of a bare EOF.
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
    let state = await readAgentViewSessionState(sessionId, this.store);
    if (!state) {
      throw new Error(`No Agent View session found for ${sessionId}.`);
    }
    if (state.attachState === 'attached') {
      state = await this.detachIfAttachIsStale(state);
    }
    if (state.attachState === 'attached') {
      throw new Error(
        `Agent View session ${sessionId} is currently attached elsewhere.`,
      );
    }

    const respawnedStoppedOrFailed =
      await this.workers.respawnStoppedOrFailedSessionIfNeeded(sessionId);
    if (respawnedStoppedOrFailed) {
      state = await readAgentViewSessionState(sessionId, this.store);
      if (!state) {
        throw new Error(`No Agent View session found for ${sessionId}.`);
      }
    }
    // Heal a dead-but-non-terminal session (e.g. persisted 'working' after a
    // daemon restart) so its orphaned pending-prompt marker can be cleared.
    state = await this.workers.refreshMissingWorkerState(state);

    const activity = await clearStalePendingPromptIfNeeded(
      state,
      await readAgentViewActivity(sessionId, this.store),
      this.store,
      this.hasPendingWorkerInputControl(sessionId),
      this.workers.has(sessionId),
      this.startedAt,
    );
    if (
      hasPendingPrompt(activity) ||
      this.hasPendingWorkerInputControl(sessionId)
    ) {
      throw new Error(
        `Agent View session ${sessionId} is waiting for the previous response.`,
      );
    }
    if (
      !respawnedStoppedOrFailed &&
      !canAgentViewQueueFollowUp(state, activity)
    ) {
      throw new Error(
        `Agent View session ${sessionId} is not ready for follow-up.`,
      );
    }

    if (!this.workers.has(sessionId)) {
      await this.workers.reconnectSessionHost(sessionId);
    }
    if (!this.workers.has(sessionId)) {
      await this.workers.respawnSession(sessionId);
    }

    state = await readAgentViewSessionState(sessionId, this.store);
    if (!state) {
      throw new Error(`No Agent View session found for ${sessionId}.`);
    }
    if (state.attachState === 'attached') {
      state = await this.detachIfAttachIsStale(state);
    }
    if (state.attachState === 'attached' || this.hasLiveAttach(sessionId)) {
      throw new Error(
        `Agent View session ${sessionId} is currently attached elsewhere.`,
      );
    }

    const now = new Date().toISOString();
    // Re-read so capabilities a just-respawned worker reported in its ready
    // event win over the pre-respawn snapshot used for the checks above.
    const latestActivity = await readAgentViewActivity(sessionId, this.store);
    // Persist the queue marker before pushing the in-memory control: if
    // this write fails the RPC rejects with no side effects, and a retry
    // still passes the pending-prompt checks.
    await writeAgentViewActivity(
      sessionId,
      {
        schemaVersion: 1,
        ...getQueuedPromptActivityPatch(text, now),
        lastActivityAt: now,
        capabilities:
          latestActivity?.capabilities ?? activity?.capabilities ?? [],
      },
      this.store,
    );
    const events = this.pendingWorkerControls.get(sessionId) ?? [];
    events.push({
      type: 'prompt',
      sequence: this.nextSequence(),
      text,
      at: now,
    });
    this.pendingWorkerControls.set(sessionId, events);
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
    let state = await readAgentViewSessionState(sessionId, this.store);
    if (!state) {
      throw new Error(`No Agent View session found for ${sessionId}.`);
    }
    if (state.attachState === 'attached') {
      state = await this.detachIfAttachIsStale(state);
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
      await this.workers.reconnectSessionHost(sessionId);
    }
    if (!this.workers.has(sessionId)) {
      throw new Error(`Agent View session ${sessionId} is not running.`);
    }
    state = await readAgentViewSessionState(sessionId, this.store);
    if (!state) {
      throw new Error(`No Agent View session found for ${sessionId}.`);
    }
    if (state.attachState === 'attached') {
      state = await this.detachIfAttachIsStale(state);
    }
    if (state.attachState === 'attached' || this.hasLiveAttach(sessionId)) {
      throw new Error(
        `Agent View session ${sessionId} is currently attached elsewhere.`,
      );
    }
    if (this.hasPendingWorkerInputControl(sessionId)) {
      throw new Error(
        `Agent View session ${sessionId} is waiting for the previous response.`,
      );
    }
    // Touch the activity record before pushing the in-memory control: if
    // this write fails the RPC rejects with no side effects, and a retry
    // still passes the pending-answer checks. Queued answers are
    // intentionally ephemeral — the in-memory control is their only record.
    await writeAgentViewActivity(
      sessionId,
      {
        schemaVersion: 1,
        lastActivityAt: now,
        capabilities: activity?.capabilities ?? [],
      },
      this.store,
    );
    const events = this.pendingWorkerControls.get(sessionId) ?? [];
    events.push({
      type: 'answer',
      sequence: this.nextSequence(),
      text,
      at: now,
    });
    this.pendingWorkerControls.set(sessionId, events);
  }

  private hasPendingWorkerInputControl(sessionId: string): boolean {
    return (this.pendingWorkerControls.get(sessionId) ?? []).some(
      (event) => event.type === 'prompt' || event.type === 'answer',
    );
  }

  private hasPendingWorkerStopControl(sessionId: string): boolean {
    return (this.pendingWorkerControls.get(sessionId) ?? []).some(
      (event) => event.type === 'stop',
    );
  }

  private hasLiveAttach(sessionId: string): boolean {
    return (
      this.attachSockets.has(sessionId) ||
      this.attachLeases.get(sessionId) !== undefined
    );
  }

  private async detachIfAttachIsStale(
    state: AgentViewSessionStateFile,
  ): Promise<AgentViewSessionStateFile> {
    if (
      state.attachState !== 'attached' ||
      this.attachSockets.has(state.sessionId) ||
      this.attachLeases.get(state.sessionId)
    ) {
      return state;
    }
    // Patch only the owned field through the queued mutation: re-asserting
    // a whole stale snapshot here would erase a concurrent exit verdict.
    // Keep the original updatedAt: clearing a stale attach flag is a
    // reconciliation, not a lifecycle change — bumping it would reset the
    // clock isStaleStartingState uses to recover a stuck starting session.
    await patchAgentViewSessionState(
      state.sessionId,
      { attachState: 'detached' },
      this.store,
    );
    this.notifyChanged();
    return { ...state, attachState: 'detached' };
  }
}

class WorkerRegistry {
  private readonly ptyHosts = new Map<string, AgentViewPtyHostHandle>();
  private readonly hostSetupQueues = new Map<string, Promise<void>>();
  private readonly pendingWorkerReady = new Map<
    string,
    AgentViewWorkerReadyWaiter
  >();
  private readonly bootGeneration = new Map<string, number>();

  constructor(
    private readonly options: AgentViewSupervisorProcessOptions,
    private readonly onChanged: () => void,
    private readonly onHostReleased: (sessionId: string) => void,
    private readonly preserveQueuedInputControls: (sessionId: string) => void,
  ) {}

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
    const previous = this.ptyHosts.get(sessionId);
    if (previous && previous !== host) {
      previous.kill('SIGTERM');
    }
    this.ptyHosts.set(sessionId, host);
    this.trackHostExit(sessionId, host);
  }

  async stopSession(sessionId: string, queueStop: () => void): Promise<void> {
    const host = await this.getOrReconnectSessionHost(sessionId);
    const generation = this.bootGeneration.get(sessionId);
    this.rejectPendingWorkerReady(
      sessionId,
      new AgentViewSessionStoppedError(sessionId, 'worker'),
      generation,
    );
    if (host) {
      queueStop();
      this.scheduleStopFallback(sessionId, host);
      await markStoppedSession(sessionId, this.store, 'alive');
      return;
    }
    const storedWorker = await readAgentViewWorker(sessionId, this.store);
    const storedPids = [storedWorker?.hostPid, storedWorker?.workerPid].filter(
      (pid): pid is number => typeof pid === 'number',
    );
    if (storedPids.some((pid) => isPidRunning(pid))) {
      queueStop();
      this.scheduleStoredStopFallback(sessionId, storedPids);
    }
    await markStoppedSession(sessionId, this.store, 'exited');
  }

  async killSession(
    sessionId: string,
    signal: NodeJS.Signals = 'SIGTERM',
  ): Promise<void> {
    const host = await this.getOrReconnectSessionHost(sessionId);
    const generation = this.bootGeneration.get(sessionId);
    host?.kill(signal);
    this.rejectPendingWorkerReady(
      sessionId,
      new AgentViewSessionStoppedError(sessionId, 'worker'),
      generation,
    );
    this.bootGeneration.delete(sessionId);
    if (host && this.ptyHosts.get(sessionId) === host) {
      this.ptyHosts.delete(sessionId);
      this.onHostReleased(sessionId);
    } else if (!host) {
      await this.killStoredWorkerPids(sessionId, signal);
      this.onHostReleased(sessionId);
    }
    await markStoppedSession(sessionId, this.store, 'exited');
  }

  terminateSession(sessionId: string, signal: NodeJS.Signals): void {
    const host = this.ptyHosts.get(sessionId);
    const generation = this.bootGeneration.get(sessionId);
    host?.kill(signal);
    if (host) {
      this.rejectPendingWorkerReady(
        sessionId,
        new AgentViewSessionStoppedError(sessionId, 'worker'),
        generation,
      );
      this.bootGeneration.delete(sessionId);
      this.ptyHosts.delete(sessionId);
      this.onHostReleased(sessionId);
    }
  }

  async shutdownHost(
    sessionId: string,
    host: AgentViewPtyHostHandle,
  ): Promise<void> {
    if (this.ptyHosts.get(sessionId) === host) {
      this.ptyHosts.delete(sessionId);
      this.onHostReleased(sessionId);
    }
    await shutdownPtyHost(host);
  }

  async shutdownAll(): Promise<number> {
    const entries = Array.from(this.ptyHosts.entries());
    await Promise.allSettled(
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

    const generation = (this.bootGeneration.get(sessionId) ?? 0) + 1;
    this.bootGeneration.set(sessionId, generation);

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
        expectedCwd: resolveSessionCwd(expectedCwd),
        timeout,
        generation,
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

    const actualCwd = resolveSessionCwd(event.cwd);
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

  rejectPendingWorkerReady(
    sessionId: string,
    error: unknown,
    expectedGeneration?: number,
  ): void {
    const waiter = this.pendingWorkerReady.get(sessionId);
    if (!waiter) return;
    if (
      expectedGeneration !== undefined &&
      waiter.generation !== expectedGeneration
    ) {
      return;
    }
    this.pendingWorkerReady.delete(sessionId);
    waiter.reject(error instanceof Error ? error : new Error(String(error)));
  }

  async reconnectSessionHost(sessionId: string): Promise<boolean> {
    return this.withHostSetupLock(sessionId, () =>
      this.reconnectSessionHostLocked(sessionId),
    );
  }

  private async reconnectSessionHostLocked(
    sessionId: string,
  ): Promise<boolean> {
    if (this.ptyHosts.has(sessionId)) {
      return true;
    }
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
      try {
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
      } catch {
        // The reconnected worker is already alive; do not kill it just because
        // pid bookkeeping could not be refreshed.
      }
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
  ): Promise<{ sessionId: string; respawned: true }> {
    return this.withHostSetupLock(sessionId, () =>
      this.respawnSessionLocked(sessionId),
    );
  }

  private async respawnSessionLocked(
    sessionId: string,
  ): Promise<{ sessionId: string; respawned: true }> {
    const state = await readAgentViewSessionState(sessionId, this.store);
    if (!state) {
      throw new Error(`No Agent View session found for ${sessionId}.`);
    }
    if (state.ownership !== 'managed') {
      throw new Error(`Agent View session ${sessionId} is not managed.`);
    }
    const refreshedState = await this.refreshMissingWorkerState(state, () =>
      this.reconnectSessionHostLocked(sessionId),
    );
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
    // Rotate the worker sideband token on respawn so the replaced worker's
    // predecessor token can no longer authenticate worker-side calls.
    const token = randomUUID();
    const resumeLaunch = await writeResumeWorkerLaunch(
      launch,
      token,
      this.store,
    );
    // The replacement worker must not inherit stop/redraw controls queued
    // for its predecessor; prompt/answer controls are preserved.
    this.preserveQueuedInputControls(sessionId);
    const existingHost = this.ptyHosts.get(sessionId);
    existingHost?.kill('SIGTERM');
    if (!existingHost) {
      // No in-memory host: a persisted worker process may still be running
      // (e.g. a graceful-stop straggler after a supervisor restart), so
      // signal it before launching its replacement.
      await this.killStoredWorkerPids(sessionId, 'SIGTERM');
    }
    let host: AgentViewPtyHostHandle | undefined;
    try {
      // Persist the respawn bookkeeping before launch so any event the
      // replacement worker emits right away authenticates against the
      // rotated tokenDigest and passes the dead-worker guard (processState
      // 'starting'); writing them after launch lets a fast ready die at
      // the ready timeout.
      const latestState =
        (await readAgentViewSessionState(sessionId, this.store)) ?? state;
      let preLaunchPatchApplied = false;
      await patchAgentViewSessionStateIf(
        sessionId,
        (existing) => {
          // Re-validate inside the queue: a concurrent stop verdict enqueued
          // after the pre-launch read must not be overwritten by 'starting'.
          if (
            existing.sessionState === 'stopped' &&
            (latestState.sessionState !== 'stopped' ||
              existing.updatedAt !== latestState.updatedAt)
          ) {
            return undefined;
          }
          preLaunchPatchApplied = true;
          return {
            sessionState:
              existing.processState === 'alive'
                ? existing.sessionState
                : 'starting',
            processState:
              existing.processState === 'alive' ? 'alive' : 'starting',
            attachState: 'detached',
            updatedAt: new Date().toISOString(),
          };
        },
        this.store,
      );
      if (!preLaunchPatchApplied) {
        throw new AgentViewSessionStoppedError(sessionId, 'session');
      }
      await writeAgentViewWorker(
        sessionId,
        {
          schemaVersion: 1,
          protocolVersion: AGENT_VIEW_PROTOCOL_VERSION,
          platform: process.platform,
          tokenDigest: digestAgentViewWorkerToken(token),
          recentOutputBytes: 0,
        },
        this.store,
      );
      const ready = this.waitForWorkerReadyIfNeeded(
        sessionId,
        resumeLaunch.activeCwd,
      );
      void ready.catch(() => {});
      host = await this.launchPtyHostForSupervisor(resumeLaunch, this.store);
      await ensureSessionStillLaunchable(sessionId, this.store, host, {
        allowStopped: refreshedState.sessionState === 'stopped',
        stoppedUpdatedAt: refreshedState.updatedAt,
      });
      this.set(sessionId, host);
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
      await ready;
      await ensureSessionStillLaunchable(sessionId, this.store);
    } catch (error) {
      this.rejectPendingWorkerReady(sessionId, error);
      host?.kill('SIGTERM');
      if (host && this.ptyHosts.get(sessionId) === host) {
        // Only drop the registry entry — preserveQueuedInputControls already
        // saved the pending prompt/answer controls for the next respawn.
        this.ptyHosts.delete(sessionId);
      }
      if (isStoppedError(error)) {
        await markStoppedSession(sessionId, this.store, 'exited');
      } else {
        await markFailedSession(sessionId, error, this.store);
      }
      throw error;
    }
    return { sessionId, respawned: true };
  }

  async withHostSetupLock<T>(
    sessionId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const previous = this.hostSetupQueues.get(sessionId) ?? Promise.resolve();
    const current = previous.then(action, action);
    const queued = current
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (this.hostSetupQueues.get(sessionId) === queued) {
          this.hostSetupQueues.delete(sessionId);
        }
      });
    this.hostSetupQueues.set(sessionId, queued);
    return current;
  }

  private async killStoredWorkerPids(
    sessionId: string,
    signal: NodeJS.Signals,
  ): Promise<void> {
    const state = await readAgentViewSessionState(sessionId, this.store);
    if (
      state?.processState === 'exited' ||
      state?.processState === 'hibernated'
    ) {
      // The worker is long dead and exit verdicts never clear worker.json
      // pids; the pids may have been reused by unrelated processes, so
      // never signal them.
      return;
    }
    const worker = await readAgentViewWorker(sessionId, this.store);
    for (const pid of [worker?.hostPid, worker?.workerPid]) {
      if (!pid) continue;
      // A concurrent respawn may have registered a new host with fresh
      // pids since we decided there was none; its pids are authoritative.
      if (this.ptyHosts.has(sessionId)) break;
      try {
        process.kill(pid, signal);
      } catch {
        // The persisted pid may already be gone or belong to an inaccessible process.
      }
    }
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
      (state.processState === 'starting' ||
        state.processState === 'restarting') &&
      !isStaleStartingState(state, this.options)
    ) {
      throw new Error(
        `Agent View session ${sessionId} is still ${state.processState}.`,
      );
    }
    const staleStarting = isStaleStartingState(state, this.options);
    if (state.attachState === 'attached') {
      state = {
        ...state,
        attachState: 'detached',
        updatedAt: new Date().toISOString(),
      };
      await patchAgentViewSessionState(
        sessionId,
        { attachState: 'detached', updatedAt: state.updatedAt },
        this.store,
      );
    }
    if (staleStarting) {
      state = {
        ...state,
        sessionState: 'failed',
        processState: 'exited',
        attachState: 'detached',
        updatedAt: new Date().toISOString(),
      };
      await patchAgentViewSessionState(
        sessionId,
        {
          sessionState: 'failed',
          processState: 'exited',
          attachState: 'detached',
          updatedAt: state.updatedAt,
        },
        this.store,
      );
    }
    if (state.sessionState === 'stopped') {
      state = {
        ...state,
        processState: 'exited',
        attachState: 'detached',
        updatedAt: new Date().toISOString(),
      };
      await patchAgentViewSessionState(
        sessionId,
        {
          processState: 'exited',
          attachState: 'detached',
          updatedAt: state.updatedAt,
        },
        this.store,
      );
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
    return false;
  }

  async respawnStoppedOrFailedSessionIfNeeded(
    sessionId: string,
  ): Promise<boolean> {
    return this.withHostSetupLock(sessionId, async () => {
      const state = await readAgentViewSessionState(sessionId, this.store);
      if (
        !state ||
        (state.sessionState !== 'stopped' && state.sessionState !== 'failed')
      ) {
        return false;
      }

      let host = this.ptyHosts.get(sessionId);
      const refreshedState = host
        ? state
        : await this.refreshMissingWorkerState(state, () =>
            this.reconnectSessionHostLocked(sessionId),
          );
      host ??= this.ptyHosts.get(sessionId);
      // A live attach must block the respawn even when a host is still
      // registered (e.g. draining inside the graceful-stop window); the
      // surviving process itself is handled below, so only the attach check
      // applies to the stopped/failed states this method revives.
      if (refreshedState.attachState !== 'detached') {
        throw new Error(
          `Agent View session ${sessionId} cannot be respawned: it is currently attached.`,
        );
      }
      host?.kill('SIGTERM');
      if (host && this.ptyHosts.get(sessionId) === host) {
        // Reviving releases only the registry entry: queued prompt/answer
        // controls and the persisted marker belong to accepted user input
        // the replacement worker must still deliver. respawnSessionLocked
        // filters out superseded stop/redraw controls before launching.
        this.ptyHosts.delete(sessionId);
      } else if (!host) {
        await this.killStoredWorkerPids(sessionId, 'SIGTERM');
      }
      await patchAgentViewSessionState(
        sessionId,
        {
          processState: 'exited',
          attachState: 'detached',
          updatedAt: new Date().toISOString(),
        },
        this.store,
      );
      await this.respawnSessionLocked(sessionId);
      return true;
    });
  }

  private trackHostExit(sessionId: string, host: AgentViewPtyHostHandle): void {
    void host.exited
      .then((exit) =>
        // Serialize the exit verdict with respawn: a superseded host killed
        // during respawnSessionLocked must not clobber the replacement's
        // freshly written state once the registry has swapped.
        this.withHostSetupLock(sessionId, async () => {
          if (this.ptyHosts.get(sessionId) !== host) {
            return;
          }
          try {
            this.rejectPendingWorkerReady(
              sessionId,
              new Error(`Agent View worker ${sessionId} exited before ready.`),
            );
            await updateExitedSession(sessionId, exit.exitCode, this.store);
          } finally {
            // Reaching here means the host exited on its own: planned releases
            // remove the registry entry first. Keep the queued prompt/answer
            // controls and the persisted queue marker so a later respawn can
            // still deliver accepted user input.
            this.ptyHosts.delete(sessionId);
            this.onChanged();
          }
        }),
      )
      .catch(() => {});
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
      // Preserve undelivered prompt/answer controls (and the persisted marker)
      // for the replacement worker — matching scheduleStoredStopFallback.
      this.preserveQueuedInputControls(sessionId);
      void markStoppedSession(sessionId, this.store, 'exited')
        .catch(() => {})
        .finally(() => {
          this.onChanged();
        });
    }, DEFAULT_GRACEFUL_STOP_TIMEOUT_MS);
    timeout.unref?.();
  }

  private scheduleStoredStopFallback(
    sessionId: string,
    storedPids: number[],
  ): void {
    const timeout = setTimeout(() => {
      // Run inside the host-setup lock so the decision serializes with a
      // concurrent respawn: mid-launch the worker record still carries the
      // replaced worker's stale pids, which would misidentify the respawn
      // as the dead worker this stop was scheduled for.
      void this.withHostSetupLock(sessionId, async () => {
        // Verify the record still points at the worker this fallback was
        // scheduled for BEFORE signaling: the grace window may have hosted
        // a respawn whose fresh pids must never be touched, and a stale
        // stored pid may have been reused by an unrelated process.
        const worker = await readAgentViewWorker(sessionId, this.store);
        const recordIsCurrent =
          worker !== undefined &&
          [worker.hostPid, worker.workerPid].some(
            (pid) => pid !== undefined && storedPids.includes(pid),
          );
        if (!recordIsCurrent) {
          return;
        }
        for (const pid of storedPids) {
          try {
            process.kill(pid, 'SIGTERM');
          } catch {
            // The persisted pid may already be gone or belong to an inaccessible process.
          }
        }
        // The worker this stop was meant for is gone; drop its queued
        // stop control so a future replacement never receives it.
        this.preserveQueuedInputControls(sessionId);
        await markStoppedSession(sessionId, this.store, 'exited');
      })
        .catch(() => {})
        .finally(() => {
          this.onChanged();
        });
    }, DEFAULT_GRACEFUL_STOP_TIMEOUT_MS);
    timeout.unref?.();
  }

  async refreshMissingWorkerState(
    state: AgentViewSessionStateFile,
    reconnect: () => Promise<boolean> = () =>
      this.reconnectSessionHost(state.sessionId),
  ): Promise<AgentViewSessionStateFile> {
    if (state.processState === 'hibernating') {
      if (this.ptyHosts.has(state.sessionId)) {
        return state;
      }
      const worker = await readAgentViewWorker(state.sessionId, this.store);
      if (isPidRunning(worker?.hostPid) || isPidRunning(worker?.workerPid)) {
        await reconnect();
        return state;
      }
      const patch = {
        processState: 'hibernated' as const,
        attachState: 'detached' as const,
        updatedAt: new Date().toISOString(),
      };
      // Decide inside the queued mutation so a concurrent stop verdict
      // that lands mid-heal is not overwritten.
      let applied = false;
      await patchAgentViewSessionStateIf(
        state.sessionId,
        (existing) => {
          if (
            existing.processState !== 'hibernating' ||
            existing.sessionState === 'stopped'
          ) {
            return undefined;
          }
          applied = true;
          return patch;
        },
        this.store,
      );
      return applied ? { ...state, ...patch } : state;
    }
    if (
      state.processState !== 'alive' &&
      state.processState !== 'starting' &&
      state.processState !== 'restarting'
    ) {
      return state;
    }
    if (this.ptyHosts.has(state.sessionId)) {
      return state;
    }
    if (
      (state.processState === 'starting' ||
        state.processState === 'restarting') &&
      !isStaleStartingState(state, this.options)
    ) {
      return state;
    }
    if (await reconnect()) {
      return state;
    }

    const worker = await readAgentViewWorker(state.sessionId, this.store);
    if (isPidRunning(worker?.hostPid) || isPidRunning(worker?.workerPid)) {
      return state;
    }

    const now = new Date().toISOString();
    // Decide the heal inside the queued mutation so a concurrent terminal
    // verdict (stop/complete) that lands mid-heal is not overwritten.
    let appliedPatch: Partial<AgentViewSessionStateFile> | undefined;
    await patchAgentViewSessionStateIf(
      state.sessionId,
      (existing) => {
        const nextSessionState =
          existing.sessionState === 'starting' ||
          existing.sessionState === 'working' ||
          existing.sessionState === 'needs_input'
            ? 'failed'
            : existing.sessionState;
        appliedPatch = {
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
        return appliedPatch;
      },
      this.store,
    );
    return appliedPatch ? { ...state, ...appliedPatch } : state;
  }
}

class SessionSnapshotCache {
  private snapshots: AgentViewSessionSnapshot[] | undefined;
  private expiresAt = 0;

  markDirty(): void {
    this.snapshots = undefined;
  }

  async list(
    store: AgentViewStoreOptions,
    nowMs: number,
  ): Promise<AgentViewSessionSnapshot[]> {
    if (this.snapshots && nowMs < this.expiresAt) {
      return this.snapshots;
    }
    this.snapshots = await listAgentViewSessionSnapshots(store);
    this.expiresAt = nowMs + 1000;
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

async function ensureSessionStillLaunchable(
  sessionId: string,
  store: AgentViewStoreOptions,
  host?: AgentViewPtyHostHandle,
  options: { allowStopped?: boolean; stoppedUpdatedAt?: string } = {},
): Promise<void> {
  const state = await readAgentViewSessionState(sessionId, store);
  const stoppedAfterLaunch =
    state?.sessionState === 'stopped' &&
    options.allowStopped &&
    options.stoppedUpdatedAt !== undefined &&
    state.updatedAt !== options.stoppedUpdatedAt;
  if (!state) {
    // Distinguish a transient state-read failure (EMFILE/EIO/EACCES —
    // readAgentViewSessionState fail-softs and returns undefined) from a
    // genuine deletion: if the state file still exists, the read failure is
    // transient and the just-launched host must not be killed.
    const paths = getAgentViewSessionPaths(sessionId, store);
    try {
      await fs.promises.access(paths.statePath);
      return;
    } catch {
      host?.kill('SIGTERM');
      throw new AgentViewSessionStoppedError(sessionId, 'session');
    }
  }
  if (
    (state.ownership !== 'managed' && state.ownership !== 'adopting') ||
    (state.sessionState === 'stopped' && !options.allowStopped) ||
    stoppedAfterLaunch
  ) {
    host?.kill('SIGTERM');
    throw new AgentViewSessionStoppedError(sessionId, 'session');
  }
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
    snapshot.state.processState === 'exited' ||
    hasPendingPrompt(snapshot.activity)
  ) {
    return false;
  }

  const activityAt = Date.parse(
    snapshot.activity?.lastActivityAt ?? snapshot.state.updatedAt,
  );
  if (!Number.isFinite(activityAt)) {
    return false;
  }
  return nowMs - activityAt >= idleMs;
}

async function markSessionHibernating(
  state: AgentViewSessionStateFile,
  options: { globalDir?: string },
): Promise<boolean> {
  const latest = await readAgentViewSessionState(state.sessionId, options);
  if (!latest || latest.ownership !== 'managed') return false;
  if (latest.sessionState === 'stopped' || latest.processState !== 'alive') {
    return false;
  }
  await patchAgentViewSessionState(
    state.sessionId,
    { processState: 'hibernating', updatedAt: new Date().toISOString() },
    options,
  );
  return true;
}

async function markSessionHibernated(
  state: AgentViewSessionStateFile,
  options: { globalDir?: string },
): Promise<boolean> {
  const latest = await readAgentViewSessionState(state.sessionId, options);
  if (!latest || latest.ownership !== 'managed') return false;
  if (
    latest.sessionState === 'stopped' ||
    latest.processState !== 'hibernating'
  ) {
    return false;
  }
  await patchAgentViewSessionState(
    state.sessionId,
    { processState: 'hibernated', updatedAt: new Date().toISOString() },
    options,
  );
  return true;
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
  // Patch only the owned fields: re-asserting a whole stale snapshot here
  // would erase a concurrent exit verdict from updateExitedSession.
  await patchAgentViewSessionState(
    sessionId,
    { attachState, updatedAt: new Date().toISOString() },
    options,
  );
}

const MAX_QUEUED_PROMPT_PREVIEW_CHARS = 500;

function getQueuedPromptActivityPatch(
  text: string,
  at: string,
): Partial<AgentViewActivityFile> {
  return {
    queuedPromptCount: 1,
    // Preview only: the full text lives in the worker control queue and
    // the launch record; activity.json is re-read on every list() poll.
    queuedPromptPreview: text.slice(0, MAX_QUEUED_PROMPT_PREVIEW_CHARS),
    lastQueuedPromptAt: at,
  };
}

function getDequeuedPromptActivityPatch(): Partial<AgentViewActivityFile> {
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
  return (options.now?.() ?? new Date()).getTime() - updatedAt > timeoutMs;
}

class AgentViewSessionStoppedError extends Error {
  constructor(sessionId: string, kind: 'worker' | 'session') {
    super(`Agent View ${kind} ${sessionId} was stopped.`);
    this.name = 'AgentViewSessionStoppedError';
  }
}

function isStoppedError(error: unknown): boolean {
  return error instanceof AgentViewSessionStoppedError;
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
  // Always write, even when the values are unchanged: the bumped updatedAt
  // is what lets a concurrent respawn observe a repeated stop through
  // ensureSessionStillLaunchable's stoppedAfterLaunch check.
  await patchAgentViewSessionState(
    sessionId,
    {
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
  if (state.ownership !== 'managed' || state.processState === 'hibernated') {
    return;
  }
  await patchAgentViewSessionStateIf(
    sessionId,
    (existing) => {
      // Re-validate inside the queue: a concurrent stop verdict enqueued
      // after the read above must keep its terminal sessionState.
      if (
        existing.ownership !== 'managed' ||
        existing.processState === 'hibernated'
      ) {
        return undefined;
      }
      return {
        sessionState:
          existing.sessionState === 'stopped' ||
          existing.sessionState === 'failed' ||
          existing.sessionState === 'completed'
            ? existing.sessionState
            : exitCode === 0 && existing.sessionState !== 'starting'
              ? 'completed'
              : 'failed',
        processState: 'exited',
        updatedAt: new Date().toISOString(),
      };
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
  if (state.ownership !== 'managed') return;
  if (state.sessionState === 'stopped' || state.sessionState === 'completed') {
    if (state.processState !== 'exited') {
      await markStoppedSession(sessionId, options, 'exited');
    }
    return;
  }
  const now = new Date().toISOString();
  const message = error instanceof Error ? error.message : String(error);
  await patchAgentViewSessionStateIf(
    sessionId,
    (existing) => {
      // Re-validate inside the queued mutation: a concurrent stop verdict
      // enqueued after the read above must keep its terminal sessionState.
      if (
        existing.sessionState === 'stopped' ||
        existing.sessionState === 'completed'
      ) {
        return undefined;
      }
      return {
        sessionState: 'failed',
        processState: 'exited',
        updatedAt: now,
        lastError: { code, message, at: now },
      };
    },
    options,
  );
}

async function applyWorkerEvent(
  event: AgentViewWorkerEvent,
  options: { globalDir?: string },
  hasPendingInputControl = false,
): Promise<boolean> {
  const state = await readAgentViewSessionState(event.sessionId, options);
  if (!state) {
    throw new Error(`No Agent View session found for ${event.sessionId}.`);
  }
  if (state.ownership !== 'managed' && state.ownership !== 'adopting') {
    throw new Error(`Agent View session ${event.sessionId} is not managed.`);
  }
  if (
    (state.sessionState === 'stopped' ||
      state.processState === 'exited' ||
      state.processState === 'hibernated') &&
    (event.type === 'ready' || event.type === 'state')
  ) {
    // A buffered/in-flight event from a dead worker must not clobber the
    // exit verdict. A legitimate replacement worker's ready arrives only
    // after respawn writes processState 'starting'.
    return false;
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

  let statePatchApplied = false;
  await patchAgentViewSessionStateIf(
    event.sessionId,
    (existing) => {
      // Re-validate inside the queued mutation: an exit verdict enqueued
      // after the guard read above must not be clobbered by this patch.
      if (
        (existing.sessionState === 'stopped' ||
          existing.processState === 'exited' ||
          existing.processState === 'hibernated') &&
        (event.type === 'ready' || event.type === 'state')
      ) {
        return undefined;
      }
      statePatchApplied = true;
      return {
        sessionState,
        processState: 'alive',
        activeCwd,
        updatedAt: now,
        ...(event.type === 'ready' ? { lastError: undefined } : {}),
      };
    },
    options,
  );
  if (!statePatchApplied) {
    return false;
  }

  const existingActivity = await readAgentViewActivity(
    event.sessionId,
    options,
  );
  const dequeuePendingPrompt = shouldClearPendingPrompt(
    event,
    state,
    existingActivity,
    hasPendingInputControl,
  );
  const activityPatch =
    event.type === 'state' || event.type === 'ready'
      ? {
          ...(event.summary ? { summary: event.summary } : {}),
          ...(event.type === 'state'
            ? { waitingFor: event.waitingFor || undefined }
            : { waitingFor: undefined }),
          ...(event.type === 'state'
            ? {
                inputKind:
                  event.inputKind ??
                  inferInputKind(event.sessionState, event.waitingFor),
              }
            : { inputKind: undefined }),
          ...(event.type === 'state' && event.lastResult
            ? { lastResult: event.lastResult }
            : { lastResult: undefined }),
          capabilities:
            event.type === 'ready'
              ? (event.capabilities ?? [])
              : (existingActivity?.capabilities ?? []),
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
  if (dequeuePendingPrompt) {
    // Route the dequeue through the queued mutation, re-validating the
    // marker inside it: a concurrent kill/send may have replaced the
    // marker after the activity read above, and erasing a fresh marker
    // would drop the double-submit guard for the newly queued prompt.
    const baselineMarker = existingActivity?.lastQueuedPromptAt;
    await patchAgentViewActivityIf(
      event.sessionId,
      (latest) =>
        hasPendingPrompt(latest) && latest.lastQueuedPromptAt === baselineMarker
          ? getDequeuedPromptActivityPatch()
          : undefined,
      options,
    );
  }
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
  return true;
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

function shouldClearPendingPrompt(
  event: AgentViewWorkerEvent,
  previousState: AgentViewSessionStateFile,
  activity: AgentViewActivityFile | undefined,
  hasPendingInputControl = false,
): boolean {
  if (!hasPendingPrompt(activity)) {
    return false;
  }
  // A prompt/answer control still queued for the worker means the persisted
  // marker is the only durable record of an accepted prompt; a replacement
  // worker's ready must not erase it until the control is consumed.
  if (hasPendingInputControl) {
    return false;
  }
  // A queued-prompt marker newer than this event belongs to a prompt the
  // worker has not seen yet; a stale buffered event must not erase it.
  const queuedAt = activity?.lastQueuedPromptAt;
  if (queuedAt && event.at && event.at < queuedAt) {
    return false;
  }
  return (
    event.type === 'ready' ||
    (event.type === 'state' &&
      (event.sessionState === 'idle' ||
        event.sessionState === 'completed' ||
        (event.sessionState === 'needs_input' &&
          event.waitingFor === 'response' &&
          previousState.sessionState !== 'needs_input')))
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
    shouldClearPendingPrompt(event, previousState, existingActivity) &&
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
  hasLiveInputControl: boolean,
  hasLiveHost = false,
  supervisorStartedAt?: string,
): Promise<AgentViewActivityFile | undefined> {
  if (!hasPendingPrompt(activity)) {
    return activity;
  }
  if (hasLiveInputControl) {
    // This daemon still holds the undelivered input control, so the
    // persisted marker is provably not stale.
    return activity;
  }
  // A marker with no live input control on a session that is not in
  // flight is orphaned (e.g. the daemon restarted and lost its in-memory
  // queue); leaving it would reject every subsequent send forever. With a
  // live host registered and an uninterrupted daemon, 'marker present,
  // control absent' instead means the worker already drained the control
  // — clearing here would let a retry deliver the same prompt twice.
  // A marker queued before this daemon started cannot have a live in-memory
  // control (the queue is process-local), so it is orphaned even on a
  // needs_input session whose worker survived the restart.
  const markerPredatesDaemon =
    supervisorStartedAt !== undefined &&
    activity?.lastQueuedPromptAt !== undefined &&
    Date.parse(activity.lastQueuedPromptAt) < Date.parse(supervisorStartedAt);
  const orphaned =
    markerPredatesDaemon ||
    (!hasLiveHost &&
      (state.sessionState === 'idle' ||
        state.sessionState === 'completed' ||
        state.sessionState === 'failed' ||
        state.sessionState === 'stopped'));
  if (!orphaned && !shouldClearStalePendingPrompt(state, activity)) {
    return activity;
  }
  // Re-read immediately before writing so the dequeue does not re-assert
  // stale lastActivityAt/capabilities over a concurrent worker update.
  const baseline =
    (await readAgentViewActivity(state.sessionId, store)) ?? activity;
  if (!baseline) {
    return activity;
  }
  // A concurrent send may have queued a new prompt (different
  // lastQueuedPromptAt) or dequeued the stale one between the snapshot
  // and the re-read; re-validate before writing to avoid erasing fresh
  // input.
  if (baseline.lastQueuedPromptAt !== activity?.lastQueuedPromptAt) {
    return baseline;
  }
  if (!orphaned && !shouldClearStalePendingPrompt(state, baseline)) {
    return baseline;
  }
  const patch = getDequeuedPromptActivityPatch();
  await writeAgentViewActivity(
    state.sessionId,
    {
      schemaVersion: 1,
      lastActivityAt: baseline.lastActivityAt,
      capabilities: baseline.capabilities,
      ...patch,
    },
    store,
  );
  return { ...baseline, ...patch };
}

async function clearPersistedPromptQueue(
  sessionId: string,
  store: { globalDir?: string },
): Promise<boolean> {
  const activity = await readAgentViewActivity(sessionId, store);
  if (!activity || !hasPendingPrompt(activity)) {
    return false;
  }
  // Re-validate inside the queued mutation: a concurrent send may have
  // replaced the marker after the read above, and erasing a fresh marker
  // would drop the double-submit guard for the newly queued prompt.
  const baselineMarker = activity.lastQueuedPromptAt;
  return patchAgentViewActivityIf(
    sessionId,
    (latest) => {
      if (
        !hasPendingPrompt(latest) ||
        latest.lastQueuedPromptAt !== baselineMarker
      ) {
        return undefined;
      }
      return getDequeuedPromptActivityPatch();
    },
    store,
  );
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
  if (!params) {
    throw new Error('Agent View adoption params are required.');
  }
  // Canonicalize at the RPC boundary: registry keys, control-queue keys,
  // worker env values, and store-resolved ids must be one string; the
  // store lowercases directory names, so a raw mixed-case id here would
  // fork every lookup keyed on it.
  const sessionId = sanitizeSessionId(requireSessionId(params));
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
    if (!isAgentViewSessionState(sessionState)) {
      throw new Error('Agent View worker event state is invalid.');
    }
    const cwd = stringParam(params, 'cwd');
    const summary = stringParam(params, 'summary');
    const waitingFor = stringParam(params, 'waitingFor');
    const inputKind = inputKindValue(params['inputKind']);
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

function stringParam(
  params: Record<string, unknown>,
  key: string,
  options: { required?: boolean } = {},
): string | undefined {
  const value = params[key];
  if (typeof value === 'string' && value.length > 0) return value;
  if (options.required) {
    throw new Error(`Agent View ${key} is required.`);
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
  token?: string,
): AgentViewLaunchFile {
  return {
    ...launch,
    entrypoint: getCurrentQwenCliEntrypoint(),
    argv: buildResumeWorkerArgv(launch.sessionId),
    ...(token === undefined
      ? {}
      : { env: { ...launch.env, [QWEN_AGENT_VIEW_TOKEN]: token } }),
  };
}

async function writeResumeWorkerLaunch(
  launch: AgentViewLaunchFile,
  token: string,
  store: { globalDir?: string },
): Promise<AgentViewLaunchFile> {
  const resumeLaunch = refreshResumeWorkerLaunch(launch, token);
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

export async function requireValidWorkerToken(
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
  const actual = Buffer.from(digestAgentViewWorkerToken(token), 'hex');
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
    return exact.sessionId;
  }

  const requestedPrefix = requestedSessionId.toLowerCase();
  const matches = (await listAgentViewSessionStates(options)).filter(
    (state) =>
      state.ownership === 'managed' &&
      state.sessionId.toLowerCase().startsWith(requestedPrefix),
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
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}
