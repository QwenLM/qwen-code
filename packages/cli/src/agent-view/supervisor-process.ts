/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs/promises';
import type { Socket } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AGENT_WORKTREE_SLUG_PATTERN,
  generateAgentWorktreeSlug,
  GitWorktreeService,
  readWorktreeSessionMarker,
  worktreeBranchForSlug,
  writeWorktreeSessionMarker,
} from '@qwen-code/qwen-code-core';
import {
  AgentViewAttachLeaseManager,
  DEFAULT_AGENT_VIEW_ATTACH_LEASE_TTL_MS,
} from './attach-lease.js';
import type { AgentViewAttachLease } from './attach-lease.js';
import {
  AGENT_VIEW_MAX_COORDINATION_WORKERS,
  AGENT_VIEW_MAX_RESULT_BYTES,
  AGENT_VIEW_MAX_TASK_BYTES,
  AGENT_VIEW_PROTOCOL_VERSION,
} from './protocol.js';
import type {
  AgentViewAnswerRequest,
  AgentViewActivityFile,
  AgentViewCoordinationDispatchAck,
  AgentViewCoordinationDispatchRequest,
  AgentViewCoordinationManifest,
  AgentViewCoordinationLineage,
  AgentViewCoordinationReassignRequest,
  AgentViewCoordinationResult,
  AgentViewCoordinationSessionSnapshot,
  AgentViewCoordinationSnapshot,
  AgentViewCoordinationTaskRequest,
  AgentViewLaunchFile,
  AgentViewPtyHostReceipt,
  AgentViewSessionSnapshot,
  AgentViewSessionStateFile,
  AgentViewWorkerFile,
  AgentViewWorkerControlsFile,
  AgentViewWorkerControlEvent,
  AgentViewWorkerEvent,
  AgentViewWorktreeState,
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
  getAgentViewSessionPaths,
  listAgentViewCoordinationRecords,
  listAgentViewSessionSnapshots,
  listAgentViewSessionStates,
  readAgentViewLaunch,
  readAgentViewCoordinationManifest,
  readAgentViewPtyHostReceipt,
  readAgentViewActivity,
  readAgentViewSessionState,
  readAgentViewWorker,
  readAgentViewWorkerControls,
  readAgentViewCoordinationResult,
  removeAgentViewSessionFiles,
  removeAgentViewRosterEntry,
  upsertAgentViewRosterEntry,
  updateAgentViewRosterEntry,
  withAgentViewSessionMutation,
  writeAgentViewActivity,
  writeAgentViewCoordinationManifest,
  writeAgentViewCoordinationResult,
  writeAgentViewCoordinationTask,
  writeAgentViewLaunch,
  writeAgentViewSessionState,
  writeAgentViewWorker,
  writeAgentViewWorkerControls,
} from './supervisor-store.js';
import type { AgentViewSupervisorHandler } from './supervisor-server.js';
import {
  createAgentViewWorkerSidebandEnv,
  QWEN_AGENT_VIEW_ATTEMPT_ID,
  QWEN_AGENT_VIEW_COORDINATION_MODE,
  QWEN_AGENT_VIEW_INPUT_SNAPSHOT,
  QWEN_AGENT_VIEW_GENERATION,
  QWEN_AGENT_VIEW_PROJECT_CWD,
  QWEN_AGENT_VIEW_PROMPT_ID,
  QWEN_AGENT_VIEW_TASK_PATH,
} from './worker-sideband.js';
import {
  captureAgentViewInputSnapshot,
  isAgentViewSnapshottedPath,
} from './input-snapshot.js';
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
const COORDINATION_BUDGETS = {
  maxSessionTurns: 12,
  maxWallTime: '10m',
  maxToolCalls: 60,
} as const;
const MAX_COORDINATION_ARTIFACTS = 128;
const MAX_COORDINATION_ARTIFACT_PATH_BYTES = 4 * 1024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface CoordinationAttemptSpec {
  lineage: AgentViewCoordinationLineage;
  sessionId: string;
  promptId: string;
  content: Buffer;
  writeMode: AgentViewCoordinationTaskRequest['writeMode'];
}

type WithoutSequence<T> = T extends { sequence: number }
  ? Omit<T, 'sequence'>
  : never;
type AgentViewWorkerControlInput = WithoutSequence<AgentViewWorkerControlEvent>;

interface ProvisionedCoordinationWorktree {
  service: GitWorktreeService;
  sessionId: string;
  state: AgentViewWorktreeState & {
    mode: 'worktree';
    path: string;
    slug: string;
    branch: string;
    baseCommit: string;
    owner: 'agent-view';
  };
}

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
type AgentViewSessionMutation = <T>(
  sessionId: string,
  action: () => Promise<T>,
) => Promise<T>;

export interface AgentViewSupervisorMaintenance {
  hibernateIdleSessions(): Promise<AgentViewSupervisorHibernationResult>;
  tickIdleHibernation(): Promise<AgentViewSupervisorMaintenanceResult>;
}

interface AgentViewWorkerReadyWaiter {
  expectedCwd: string;
  host?: AgentViewPtyHostHandle;
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
    workerEnvironment?: Readonly<Record<string, string>>,
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
  private readonly workerControls = new Map<
    string,
    AgentViewWorkerControlsFile
  >();
  private readonly admittedWorkerEventSequences = new Map<
    string,
    { generation: number; sequence: number }
  >();
  private readonly expectedWorkerPromptIds = new Map<string, string>();
  private readonly workers: WorkerRegistry;
  private coordinationAdmissionQueue: Promise<void> = Promise.resolve();
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
      (sessionId, action) => this.withSessionMutation(sessionId, action),
    );
  }

  private get store(): AgentViewStoreOptions {
    return storeOptions(this.options);
  }

  private notifyChanged(): void {
    this.snapshotCache.markDirty();
    notifyAgentViewSubscribers(this.subscribers);
  }

  private withSessionMutation<T>(
    sessionId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    return withAgentViewSessionMutation(sessionId, this.store, action);
  }

  private async loadWorkerControls(
    sessionId: string,
  ): Promise<AgentViewWorkerControlsFile> {
    const cached = this.workerControls.get(sessionId);
    if (cached) return cached;
    const controls = await readAgentViewWorkerControls(sessionId, this.store);
    this.workerControls.set(sessionId, controls);
    return controls;
  }

  private async saveWorkerControls(
    sessionId: string,
    controls: AgentViewWorkerControlsFile,
  ): Promise<void> {
    await writeAgentViewWorkerControls(sessionId, controls, this.store);
    this.workerControls.set(sessionId, controls);
  }

  private async appendWorkerControl(
    sessionId: string,
    event: AgentViewWorkerControlInput,
  ): Promise<AgentViewWorkerControlEvent> {
    const controls = await this.loadWorkerControls(sessionId);
    const queued = {
      ...event,
      sequence: controls.nextSequence + 1,
    } as AgentViewWorkerControlEvent;
    await this.saveWorkerControls(sessionId, {
      schemaVersion: 1,
      nextSequence: queued.sequence,
      events: [...controls.events, queued],
    });
    return queued;
  }

  private async withCoordinationAdmission<T>(
    action: () => Promise<T>,
  ): Promise<T> {
    const previous = this.coordinationAdmissionQueue;
    let release!: () => void;
    this.coordinationAdmissionQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => {});
    try {
      return await action();
    } finally {
      release();
    }
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
      await this.snapshotCache.list(store, Date.now())
    ).filter((snapshot) => snapshot.state.ownership !== 'unmanaged')) {
      const current = await this.withSessionMutation(
        snapshot.sessionId,
        async () => {
          const latestState = await readAgentViewSessionState(
            snapshot.sessionId,
            store,
          );
          if (!latestState) return undefined;
          const state =
            await this.workers.refreshMissingWorkerState(latestState);
          const storedActivity = await readAgentViewActivity(
            snapshot.sessionId,
            store,
          );
          const activity = await clearStalePendingPromptIfNeeded(
            state,
            storedActivity,
            store,
          );
          if (state !== latestState || activity !== storedActivity) {
            changed = true;
          }
          return { state, activity };
        },
      );
      if (!current) continue;
      snapshots.push({
        ...snapshot,
        state: current.state,
        activity: current.activity,
      });
    }
    if (changed) {
      this.notifyChanged();
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
      publishRoster: false,
      promptInArgv: !shouldWaitForWorkerReady(this.options),
    });
    try {
      const { launch, ready } = await this.withSessionMutation(
        result.sessionId,
        async () => {
          const storedLaunch = await readAgentViewLaunch(
            result.sessionId,
            store,
          );
          if (!storedLaunch) {
            throw new Error(
              'Agent View dispatch launch record was not written.',
            );
          }
          const generation = await nextWorkerGeneration(
            result.sessionId,
            store,
          );
          const launch = await writeWorkerGenerationLaunch(
            storedLaunch,
            generation,
            store,
          );
          await writeAgentViewWorker(
            result.sessionId,
            {
              schemaVersion: 1,
              generation,
              lastEventSequence: 0,
              protocolVersion: AGENT_VIEW_PROTOCOL_VERSION,
              platform: process.platform,
              recentOutputBytes: 0,
            },
            store,
          );
          const ready = this.workers.waitForWorkerReadyIfNeeded(
            result.sessionId,
            launch.activeCwd,
          );
          void ready.catch(() => {});
          const host = await this.workers.launchPtyHostForSupervisor(
            launch,
            store,
          );
          await ensureSessionStillLaunchable(result.sessionId, store, host);
          this.workers.set(result.sessionId, host);
          await writeAgentViewWorker(
            result.sessionId,
            {
              schemaVersion: 1,
              generation,
              lastEventSequence: 0,
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
          return { launch, ready };
        },
      );
      await ready;
      return await this.withSessionMutation(result.sessionId, async () => {
        await ensureSessionStillLaunchable(result.sessionId, store);
        if (shouldWaitForWorkerReady(this.options)) {
          await this.queuePromptForSessionLocked(result.sessionId, prompt);
        }
        const state = await readAgentViewSessionState(result.sessionId, store);
        const publishedAt = new Date().toISOString();
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
        this.notifyChanged();
        return result;
      });
    } catch (error) {
      await this.withSessionMutation(result.sessionId, async () => {
        this.workers.rejectPendingWorkerReady(result.sessionId, error);
        this.workers.terminateSession(result.sessionId, 'SIGTERM');
        await markFailedSession(result.sessionId, error, store);
        this.notifyChanged();
      });
      throw error;
    }
  }

  async dispatchCoordination(params: AgentViewCoordinationDispatchRequest) {
    const request = parseCoordinationDispatchParams(
      params as unknown as Record<string, unknown>,
    );
    const tasks = await Promise.all(
      request.tasks.map((task) => readCoordinationTaskInput(task)),
    );
    const coordinationId = request.coordinationId;
    const attempts = tasks.map((task) => ({
      lineage: {
        coordinationId,
        taskId: randomUUID(),
        attemptId: randomUUID(),
      },
      sessionId: randomUUID(),
      promptId: randomUUID(),
      content: task.content,
      writeMode: task.writeMode,
    }));
    return this.withCoordinationAdmission(async () => {
      const [manifest, records] = await Promise.all([
        readAgentViewCoordinationManifest(coordinationId, this.store),
        listAgentViewCoordinationRecords(coordinationId, this.store),
      ]);
      if (manifest || records.length > 0) {
        throw new Error(
          `Coordination ${coordinationId} already exists; collect it instead of dispatching again.`,
        );
      }
      await this.assertCoordinationCapacity(attempts);
      return this.launchCoordinationAttempts(
        request.cwd,
        attempts,
        request.environment,
      );
    });
  }

  async reassignCoordination(params: AgentViewCoordinationReassignRequest) {
    const request = parseCoordinationReassignParams(
      params as unknown as Record<string, unknown>,
    );
    const task = await readCoordinationTaskInput(request);
    return this.withCoordinationAdmission(async () => {
      const [records, manifest] = await Promise.all([
        listAgentViewCoordinationRecords(request.coordinationId, this.store),
        readAgentViewCoordinationManifest(request.coordinationId, this.store),
      ]);
      const taskRecords = records.filter(
        (record) =>
          record.snapshot.state.coordination?.taskId === request.taskId,
      );
      const manifestAttempts = manifest?.attempts.filter(
        (attempt) => attempt.lineage.taskId === request.taskId,
      );
      if (taskRecords.length === 0 && !manifestAttempts?.length) {
        throw new Error(
          `No coordination task ${request.taskId} exists in ${request.coordinationId}.`,
        );
      }
      const manifestLatest = manifestAttempts?.at(-1);
      const storedLatest = manifestLatest
        ? taskRecords.find(
            (record) => record.snapshot.sessionId === manifestLatest.sessionId,
          )
        : taskRecords.at(-1);
      const missingLatestAttempt = Boolean(manifestLatest && !storedLatest);
      const latest = await this.withSessionMutation(
        storedLatest?.snapshot.sessionId ?? manifestLatest?.sessionId ?? '',
        async () => {
          if (!storedLatest) return undefined;
          const storedState = await readAgentViewSessionState(
            storedLatest.snapshot.sessionId,
            this.store,
          );
          const state = storedState
            ? await this.workers.refreshMissingWorkerState(storedState)
            : undefined;
          return {
            ...storedLatest,
            snapshot: {
              ...storedLatest.snapshot,
              ...(state ? { state } : {}),
            },
            result: await readAgentViewCoordinationResult(
              storedLatest.snapshot.sessionId,
              this.store,
            ),
          };
        },
      );
      if (
        missingLatestAttempt &&
        manifestLatest?.writeMode === 'isolated-writer' &&
        manifestLatest.worktree?.mode === 'worktree'
      ) {
        throw new Error(
          `Coordination task ${request.taskId} has a retained writer worktree at ${manifestLatest.worktree.path ?? 'an unknown path'}; collect and recover it before reassignment.`,
        );
      }
      if (
        !missingLatestAttempt &&
        (!latest || !canReassignCoordinationRecord(latest))
      ) {
        throw new Error(
          `Coordination task ${request.taskId} cannot be reassigned from its current state.`,
        );
      }
      const writeMode =
        request.writeMode ??
        manifestLatest?.writeMode ??
        latest?.snapshot.launch?.writeMode;
      if (!writeMode) {
        throw new Error(
          `Coordination task ${request.taskId} has no write mode to inherit.`,
        );
      }
      const attempt: CoordinationAttemptSpec = {
        lineage: {
          coordinationId: request.coordinationId,
          taskId: request.taskId,
          attemptId: randomUUID(),
        },
        sessionId: randomUUID(),
        promptId: randomUUID(),
        content: task.content,
        writeMode,
      };
      await this.assertCoordinationCapacity([attempt]);
      const acknowledgements = await this.launchCoordinationAttempts(
        latest?.snapshot.state.projectCwd ?? manifest?.projectCwd ?? '',
        [attempt],
        request.environment,
      );
      const acknowledgement = acknowledgements[0];
      if (!acknowledgement) {
        throw new Error('Coordination reassignment produced no attempt.');
      }
      return acknowledgement;
    });
  }

  async collect(params: { coordinationId: string }) {
    const coordinationId = requireFullUuid(
      params?.['coordinationId'],
      'coordination ID',
    );
    return this.withCoordinationAdmission(() =>
      this.collectCoordinationLocked(coordinationId),
    );
  }

  private async assertCoordinationCapacity(
    attempts: CoordinationAttemptSpec[],
  ): Promise<void> {
    const states = await listAgentViewSessionStates(this.store);
    const live: AgentViewSessionStateFile[] = [];
    for (const candidate of states.filter(isLiveCoordinationState)) {
      const refreshed = await this.withSessionMutation(
        candidate.sessionId,
        async () => {
          const latest = await readAgentViewSessionState(
            candidate.sessionId,
            this.store,
          );
          if (!latest) return undefined;
          const state = await this.workers.refreshMissingWorkerState(latest);
          return { state, changed: state !== latest };
        },
      );
      if (!refreshed) continue;
      if (refreshed.changed) this.notifyChanged();
      if (isLiveCoordinationState(refreshed.state)) live.push(refreshed.state);
    }
    if (live.length + attempts.length > AGENT_VIEW_MAX_COORDINATION_WORKERS) {
      throw new Error(
        `Agent View supports at most ${AGENT_VIEW_MAX_COORDINATION_WORKERS} live coordination workers.`,
      );
    }
    const requestedWriters = attempts.filter(
      (attempt) => attempt.writeMode === 'isolated-writer',
    ).length;
    if (requestedWriters > 1) {
      throw new Error(
        'A coordination dispatch can contain at most one writer.',
      );
    }
    if (requestedWriters === 0) return;
    for (const state of live) {
      if (state.worktree.mode === 'worktree') {
        throw new Error('A live isolated coordination writer already exists.');
      }
      const launch = await readAgentViewLaunch(state.sessionId, this.store);
      if (launch?.writeMode === 'isolated-writer') {
        throw new Error('A live isolated coordination writer already exists.');
      }
    }
  }

  private async launchCoordinationAttempts(
    requestedCwd: string,
    attempts: CoordinationAttemptSpec[],
    workerEnvironment: Readonly<Record<string, string>>,
  ): Promise<AgentViewCoordinationDispatchAck[]> {
    const parentCwd = await requireCoordinationDirectory(requestedCwd);
    let writer: ProvisionedCoordinationWorktree | undefined;
    const writerAttempt = attempts.find(
      (attempt) => attempt.writeMode === 'isolated-writer',
    );
    const createdSessionIds: string[] = [];
    let manifest: AgentViewCoordinationManifest | undefined;
    try {
      const inputSnapshot = await captureAgentViewInputSnapshot(parentCwd);
      const now = new Date().toISOString();
      const coordinationId = attempts[0]?.lineage.coordinationId;
      if (!coordinationId) {
        throw new Error('Coordination launch requires at least one attempt.');
      }
      const existingManifest = await readAgentViewCoordinationManifest(
        coordinationId,
        this.store,
      );
      manifest = {
        schemaVersion: 1,
        coordinationId,
        projectCwd: parentCwd,
        createdAt: existingManifest?.createdAt ?? now,
        updatedAt: now,
        attempts: [
          ...(existingManifest?.attempts ?? []),
          ...attempts.map((attempt) => ({
            lineage: attempt.lineage,
            sessionId: attempt.sessionId,
            promptId: attempt.promptId,
            writeMode: attempt.writeMode,
            inputSnapshot,
          })),
        ],
      };
      await writeAgentViewCoordinationManifest(manifest, this.store);
      if (writerAttempt) {
        writer = await planCoordinationWorktree(
          parentCwd,
          path.join(
            getAgentViewStorePaths(this.store).globalDir,
            'agent-view-worktrees',
          ),
          writerAttempt.sessionId,
        );
        manifest = {
          ...manifest,
          updatedAt: new Date().toISOString(),
          attempts: manifest.attempts.map((attempt) =>
            attempt.sessionId === writerAttempt.sessionId
              ? {
                  ...attempt,
                  worktree: writer?.state,
                  worktreePhase: 'planned' as const,
                }
              : attempt,
          ),
        };
        await writeAgentViewCoordinationManifest(manifest, this.store);
        writer = await provisionCoordinationWorktree(writer);
        if (
          (await captureAgentViewInputSnapshot(parentCwd)) !== inputSnapshot
        ) {
          throw new Error(
            'The parent checkout changed while the coordination writer was being provisioned.',
          );
        }
        manifest = {
          ...manifest,
          updatedAt: new Date().toISOString(),
          attempts: manifest.attempts.map((attempt) =>
            attempt.sessionId === writerAttempt.sessionId
              ? {
                  ...attempt,
                  worktree: writer?.state,
                  worktreePhase: 'provisioned' as const,
                }
              : attempt,
          ),
        };
        await writeAgentViewCoordinationManifest(manifest, this.store);
      }
      const acknowledgements = new Map<
        string,
        AgentViewCoordinationDispatchAck
      >();
      const launchOrder = writerAttempt
        ? [
            ...attempts.filter((attempt) => attempt !== writerAttempt),
            writerAttempt,
          ]
        : attempts;
      for (const attempt of launchOrder) {
        const acknowledgement = await this.withSessionMutation(
          attempt.sessionId,
          async () => {
            createdSessionIds.push(attempt.sessionId);
            return this.launchCoordinationAttempt(
              parentCwd,
              attempt,
              inputSnapshot,
              workerEnvironment,
              attempt === writerAttempt ? writer : undefined,
            );
          },
        );
        acknowledgements.set(attempt.sessionId, acknowledgement);
      }
      this.notifyChanged();
      return attempts.map((attempt) => {
        const acknowledgement = acknowledgements.get(attempt.sessionId);
        if (!acknowledgement) {
          throw new Error(
            `Coordination attempt ${attempt.sessionId} was not acknowledged.`,
          );
        }
        return acknowledgement;
      });
    } catch (error) {
      const stopped = new Map<string, boolean>();
      for (const sessionId of createdSessionIds) {
        stopped.set(
          sessionId,
          await this.workers.terminateSessionAndWait(sessionId, 'SIGTERM'),
        );
      }
      const writerSessionCreated = Boolean(
        writerAttempt && createdSessionIds.includes(writerAttempt.sessionId),
      );
      let writerCleaned = true;
      if (writer) {
        writerCleaned =
          (!writerSessionCreated ||
            stopped.get(writerAttempt?.sessionId ?? '') === true) &&
          (await cleanupPristineCoordinationWorktree(writer));
        if (writerCleaned && manifest) {
          manifest = {
            ...manifest,
            updatedAt: new Date().toISOString(),
            attempts: manifest.attempts.map((attempt) =>
              attempt.sessionId === writerAttempt?.sessionId
                ? {
                    ...attempt,
                    worktree: { mode: 'none' },
                    worktreePhase: undefined,
                  }
                : attempt,
            ),
          };
          await writeAgentViewCoordinationManifest(manifest, this.store);
        }
      }
      const preserved: string[] = [];
      for (const sessionId of createdSessionIds) {
        const preserve =
          stopped.get(sessionId) !== true ||
          (sessionId === writerAttempt?.sessionId && !writerCleaned);
        await this.withSessionMutation(sessionId, async () => {
          if (preserve) {
            const state = await readAgentViewSessionState(
              sessionId,
              this.store,
            );
            if (state) {
              const now = new Date().toISOString();
              await writeAgentViewSessionState(
                {
                  ...state,
                  sessionState: 'failed',
                  updatedAt: now,
                  lastError: {
                    code: 'coordination_batch_rollback_incomplete',
                    message:
                      error instanceof Error ? error.message : String(error),
                    at: now,
                  },
                },
                this.store,
              );
              preserved.push(sessionId);
            }
            return;
          }
          await this.clearPendingSessionControls(sessionId);
          await removeAgentViewRosterEntry(sessionId, this.store);
          await removeAgentViewSessionFiles(sessionId, this.store);
          this.admittedWorkerEventSequences.delete(sessionId);
        });
      }
      this.notifyChanged();
      if (preserved.length > 0) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} Preserved coordination sessions for recovery: ${preserved.join(', ')}.`,
        );
      }
      throw error;
    }
  }

  private async launchCoordinationAttempt(
    parentCwd: string,
    attempt: CoordinationAttemptSpec,
    inputSnapshot: AgentViewCoordinationDispatchAck['inputSnapshot'],
    workerEnvironment: Readonly<Record<string, string>>,
    writer?: ProvisionedCoordinationWorktree,
  ): Promise<AgentViewCoordinationDispatchAck> {
    const store = this.store;
    const now = new Date().toISOString();
    const token = randomUUID();
    const generation = 1;
    const parentRoot = writer
      ? await writer.service.getRepoTopLevel()
      : undefined;
    const activeCwd = writer
      ? path.join(
          writer.state.path,
          parentRoot ? path.relative(parentRoot, parentCwd) : '',
        )
      : parentCwd;
    const worktree: AgentViewWorktreeState = writer?.state ?? { mode: 'none' };
    const paths = getAgentViewSessionPaths(attempt.sessionId, store);
    const taskPath = await writeAgentViewCoordinationTask(
      attempt.sessionId,
      attempt.content,
      store,
    );
    const state: AgentViewSessionStateFile = {
      schemaVersion: 1,
      sessionId: attempt.sessionId,
      ownership: 'managed',
      sessionState: 'starting',
      processState: 'starting',
      attachState: 'detached',
      projectCwd: parentCwd,
      originalCwd: parentCwd,
      activeCwd,
      createdAt: now,
      updatedAt: now,
      coordination: attempt.lineage,
      worktree,
    };
    const env = {
      ...createAgentViewWorkerSidebandEnv({
        sessionId: attempt.sessionId,
        sidebandEndpoint: this.socketPath,
        token,
        activeCwd,
        generation,
      }),
      [QWEN_AGENT_VIEW_COORDINATION_MODE]: attempt.writeMode,
      [QWEN_AGENT_VIEW_PROJECT_CWD]: parentCwd,
      [QWEN_AGENT_VIEW_TASK_PATH]: taskPath,
      [QWEN_AGENT_VIEW_PROMPT_ID]: attempt.promptId,
      [QWEN_AGENT_VIEW_ATTEMPT_ID]: attempt.lineage.attemptId,
      [QWEN_AGENT_VIEW_INPUT_SNAPSHOT]: inputSnapshot,
    };
    const launch: AgentViewLaunchFile = {
      schemaVersion: 1,
      sessionId: attempt.sessionId,
      argv: buildCurrentQwenCliArgv(['--session-id', attempt.sessionId]),
      env,
      entrypoint: getCurrentQwenCliEntrypoint(),
      projectCwd: parentCwd,
      activeCwd,
      includeDirectories: [],
      coordination: attempt.lineage,
      promptId: attempt.promptId,
      taskPath,
      resultPath: paths.resultPath,
      inputSnapshot,
      writeMode: attempt.writeMode,
      budgets: COORDINATION_BUDGETS,
      terminal: {
        columns: process.stdout.columns ?? 80,
        rows: process.stdout.rows ?? 24,
      },
    };
    await writeAgentViewSessionState(state, store);
    await writeAgentViewLaunch(launch, store);
    await writeAgentViewActivity(
      attempt.sessionId,
      {
        schemaVersion: 1,
        summary: 'Coordination worker starting',
        activePromptId: attempt.promptId,
        lastActivityAt: now,
        capabilities: [],
      },
      store,
    );
    await writeAgentViewWorker(
      attempt.sessionId,
      {
        schemaVersion: 1,
        endpoint: this.socketPath,
        tokenDigest: digestToken(token),
        generation,
        lastEventSequence: 0,
        protocolVersion: AGENT_VIEW_PROTOCOL_VERSION,
        platform: process.platform,
        recentOutputBytes: 0,
      },
      store,
    );
    await upsertAgentViewRosterEntry(
      {
        sessionId: attempt.sessionId,
        projectCwd: parentCwd,
        activeCwd,
        createdAt: now,
        updatedAt: now,
      },
      store,
    );
    if (writer) {
      await markCoordinationManifestWorktreePhase(
        attempt.lineage.coordinationId,
        attempt.sessionId,
        'launching',
        store,
      );
    }
    const host = await this.workers.launchPtyHostForSupervisor(
      launch,
      store,
      workerEnvironment,
    );
    await ensureSessionStillLaunchable(attempt.sessionId, store, host);
    this.workers.set(attempt.sessionId, host);
    await writeAgentViewWorker(
      attempt.sessionId,
      {
        schemaVersion: 1,
        hostPid: host.pid,
        workerPid: host.workerPid,
        ...(host.endpoint ? { hostEndpoint: host.endpoint } : {}),
        ...(host.authToken ? { hostAuthToken: host.authToken } : {}),
        generation,
        lastEventSequence: 0,
        protocolVersion: AGENT_VIEW_PROTOCOL_VERSION,
        platform: process.platform,
        recentOutputBytes: 0,
      },
      store,
    );
    if (writer) {
      await markCoordinationManifestWorktreePhase(
        attempt.lineage.coordinationId,
        attempt.sessionId,
        'launched',
        store,
      );
    }
    return {
      type: 'dispatch_ack',
      ...attempt.lineage,
      sessionId: attempt.sessionId,
      promptId: attempt.promptId,
      inputSnapshot,
      writeMode: attempt.writeMode,
      state: 'starting',
      ...(writer ? { worktree: writer.state } : {}),
    };
  }

  private async collectCoordinationLocked(
    coordinationId: string,
  ): Promise<AgentViewCoordinationSnapshot> {
    const [records, manifest] = await Promise.all([
      listAgentViewCoordinationRecords(coordinationId, this.store),
      readAgentViewCoordinationManifest(coordinationId, this.store),
    ]);
    if (records.length === 0 && !manifest) {
      throw new Error(`No coordination found for ${coordinationId}.`);
    }
    const parentCwd =
      manifest?.projectCwd ?? records[0]?.snapshot.state.projectCwd;
    if (!parentCwd) {
      throw new Error(`Coordination ${coordinationId} has no parent checkout.`);
    }
    let currentSnapshot = await captureAgentViewInputSnapshot(parentCwd);
    let sessions = await this.collectCoordinationAttempts(
      records,
      currentSnapshot,
      false,
      manifest,
    );
    let afterCollection = await captureAgentViewInputSnapshot(parentCwd);
    if (afterCollection !== currentSnapshot) {
      currentSnapshot = afterCollection;
      sessions = await this.collectCoordinationAttempts(
        records,
        currentSnapshot,
        false,
        manifest,
      );
      afterCollection = await captureAgentViewInputSnapshot(parentCwd);
      if (afterCollection !== currentSnapshot) {
        sessions = await this.collectCoordinationAttempts(
          records,
          afterCollection,
          true,
          manifest,
        );
      }
    }
    this.notifyChanged();
    return {
      type: 'coordination_snapshot',
      coordinationId,
      state: aggregateCoordinationState(sessions),
      sessions,
    };
  }

  private async collectCoordinationAttempts(
    records: Awaited<ReturnType<typeof listAgentViewCoordinationRecords>>,
    currentSnapshot: AgentViewCoordinationDispatchAck['inputSnapshot'],
    forceTerminalStale = false,
    manifest?: AgentViewCoordinationManifest,
  ): Promise<AgentViewCoordinationSessionSnapshot[]> {
    const sessions: AgentViewCoordinationSessionSnapshot[] = [];
    const recordsBySessionId = new Map(
      records.map((record) => [record.snapshot.sessionId, record]),
    );
    for (const attempt of manifest?.attempts ?? []) {
      const record = recordsBySessionId.get(attempt.sessionId);
      if (
        !record ||
        !record.snapshot.state.coordination ||
        !record.snapshot.launch?.promptId ||
        !record.snapshot.launch.inputSnapshot ||
        !record.snapshot.launch.writeMode
      ) {
        let worktree =
          record?.snapshot.state.worktree.mode === 'worktree'
            ? record.snapshot.state.worktree
            : attempt.worktree;
        if (
          !record &&
          manifest &&
          (attempt.worktreePhase === 'planned' ||
            attempt.worktreePhase === 'provisioned') &&
          worktree?.mode === 'worktree' &&
          (await cleanupPersistedCoordinationWorktree(
            manifest.projectCwd,
            attempt.sessionId,
            worktree,
            this.store,
          ))
        ) {
          worktree = { mode: 'none' };
          await markCoordinationManifestWorktreeCleaned(
            manifest.coordinationId,
            attempt.sessionId,
            this.store,
          );
        }
        sessions.push({
          lineage: attempt.lineage,
          sessionId: attempt.sessionId,
          promptId: attempt.promptId,
          writeMode: attempt.writeMode,
          inputSnapshot: attempt.inputSnapshot,
          state: 'failed',
          ...(worktree?.mode === 'worktree' ? { worktree } : {}),
        });
        recordsBySessionId.delete(attempt.sessionId);
        continue;
      }
      sessions.push(
        await this.collectCoordinationAttempt(
          record,
          currentSnapshot,
          forceTerminalStale,
        ),
      );
      recordsBySessionId.delete(attempt.sessionId);
    }
    for (const record of recordsBySessionId.values()) {
      sessions.push(
        await this.collectCoordinationAttempt(
          record,
          currentSnapshot,
          forceTerminalStale,
        ),
      );
    }
    return sessions;
  }

  private async collectCoordinationAttempt(
    record: Awaited<
      ReturnType<typeof listAgentViewCoordinationRecords>
    >[number],
    currentSnapshot: AgentViewCoordinationDispatchAck['inputSnapshot'],
    forceTerminalStale = false,
  ): Promise<AgentViewCoordinationSessionSnapshot> {
    return this.withSessionMutation(record.snapshot.sessionId, async () => {
      const sessionId = record.snapshot.sessionId;
      const [storedState, launch, storedActivity, storedResult] =
        await Promise.all([
          readAgentViewSessionState(sessionId, this.store),
          readAgentViewLaunch(sessionId, this.store),
          readAgentViewActivity(sessionId, this.store),
          readAgentViewCoordinationResult(sessionId, this.store),
        ]);
      if (
        !storedState?.coordination ||
        !launch?.promptId ||
        !launch.inputSnapshot ||
        !launch.writeMode
      ) {
        throw new Error(`Coordination session ${sessionId} is incomplete.`);
      }
      let state = await this.workers.refreshMissingWorkerState(storedState);
      const lineage = state.coordination;
      if (!lineage) {
        throw new Error(`Coordination session ${sessionId} lost its lineage.`);
      }
      const exitConfirmed =
        !isAliveProcessState(state.processState) &&
        (await this.workers.isSessionExitConfirmed(sessionId));
      let result = storedResult;
      if (!result && exitConfirmed) {
        const completedAt = new Date().toISOString();
        result = {
          schemaVersion: 1,
          lineage,
          sessionId,
          promptId: launch.promptId,
          generation: currentWorkerGeneration(
            await readAgentViewWorker(sessionId, this.store),
          ),
          outcome: 'failed',
          summary:
            'Coordination worker exited before its terminal result was persisted.',
          artifacts: [],
          completedAt,
        };
        state = {
          ...state,
          sessionState: 'failed',
          updatedAt: completedAt,
        };
        await Promise.all([
          writeAgentViewCoordinationResult(result, this.store),
          writeAgentViewSessionState(state, this.store),
        ]);
      }
      const terminal = isTerminalCoordinationState(state, result);
      const stale =
        storedActivity?.staleReason === 'checkout_changed' ||
        (terminal && forceTerminalStale) ||
        (terminal && launch.inputSnapshot !== currentSnapshot);
      let activity = storedActivity;
      if (stale && activity?.staleReason !== 'checkout_changed') {
        activity = {
          ...(activity ?? {
            schemaVersion: 1,
            lastActivityAt: state.updatedAt,
            capabilities: [],
          }),
          staleReason: 'checkout_changed',
        };
        await writeAgentViewActivity(sessionId, activity, this.store);
      }
      let worktree = state.worktree;
      if (
        terminal &&
        !isAliveProcessState(state.processState) &&
        exitConfirmed &&
        worktree.mode === 'worktree' &&
        (result?.artifacts.length ?? 0) === 0
      ) {
        const cleaned = await cleanupStoredCoordinationWorktree(
          state,
          this.store,
        );
        if (cleaned) {
          worktree = { mode: 'none' };
          await writeAgentViewSessionState(
            { ...state, worktree, updatedAt: new Date().toISOString() },
            this.store,
          );
          await markCoordinationManifestWorktreeCleaned(
            lineage.coordinationId,
            sessionId,
            this.store,
          );
        }
      }
      return {
        lineage,
        sessionId,
        promptId: launch.promptId,
        writeMode: launch.writeMode,
        inputSnapshot: launch.inputSnapshot,
        state: state.sessionState,
        ...(stale ? { staleReason: 'checkout_changed' as const } : {}),
        ...(!stale && result ? { result } : {}),
        ...(worktree.mode === 'worktree' ? { worktree } : {}),
      };
    });
  }

  async adopt(params?: Record<string, unknown>) {
    const adoption = parseAdoptParams(params);
    const store = this.store;
    let existingState: AgentViewSessionStateFile | undefined;
    let adoptingState: AgentViewSessionStateFile | undefined;
    try {
      const setup = await this.withSessionMutation(
        adoption.sessionId,
        async () => {
          existingState = await readAgentViewSessionState(
            adoption.sessionId,
            store,
          );
          if (
            existingState?.ownership === 'managed' ||
            existingState?.ownership === 'adopting'
          ) {
            return { alreadyManaged: true as const };
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
          const generation = await nextWorkerGeneration(
            adoption.sessionId,
            store,
          );
          adoptingState = {
            schemaVersion: 1,
            sessionId: adoption.sessionId,
            ownership: 'adopting',
            sessionState: 'idle',
            processState: 'starting',
            attachState: 'detached',
            projectCwd,
            originalCwd: activeCwd,
            activeCwd,
            createdAt,
            updatedAt: now,
            worktree: { mode: 'none' },
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
                generation,
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
              hostPid: undefined,
              workerPid: undefined,
              hostEndpoint: undefined,
              hostAuthToken: undefined,
              generation,
              lastEventSequence: 0,
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
          const launch = await readAgentViewLaunch(adoption.sessionId, store);
          if (!launch) {
            throw new Error(
              'Agent View adoption launch record was not written.',
            );
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
              generation,
              lastEventSequence: 0,
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
          return { alreadyManaged: false as const, ready };
        },
      );
      if (setup.alreadyManaged) {
        return {
          sessionId: adoption.sessionId,
          adopted: false,
          alreadyManaged: true,
        };
      }
      await setup.ready;
      return await this.withSessionMutation(adoption.sessionId, async () => {
        await ensureSessionStillLaunchable(adoption.sessionId, store);
        this.notifyChanged();
        return { sessionId: adoption.sessionId, adopted: true };
      });
    } catch (error) {
      await this.withSessionMutation(adoption.sessionId, async () => {
        this.workers.rejectPendingWorkerReady(adoption.sessionId, error);
        this.workers.terminateSession(adoption.sessionId, 'SIGTERM');
        if (adoptingState) {
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
        }
        this.notifyChanged();
      });
      throw error;
    }
  }
  async workerEvent(params?: Record<string, unknown>) {
    const event = parseWorkerEvent(params);
    await requireValidWorkerToken(event.sessionId, params, this.store);
    await this.admitWorkerEvent(event);
    if (event.type === 'ready') {
      this.workers.validatePendingWorkerReady(event);
      this.workers.resolvePendingWorkerReady(event.sessionId);
    }
    return this.withSessionMutation(event.sessionId, async () => {
      await requireCurrentWorkerEvent(event, this.store);
      if (event.type === 'state') {
        await this.validateWorkerPromptCorrelation(event);
      }
      if (event.type === 'result') {
        await this.applyCoordinationResult(event);
        await recordWorkerEventSequence(event, this.store);
        this.expectedWorkerPromptIds.delete(event.sessionId);
        this.notifyChanged();
        return { sessionId: event.sessionId, accepted: true };
      }
      if (
        event.type === 'state' &&
        (await readAgentViewCoordinationResult(event.sessionId, this.store))
      ) {
        throw new Error(
          `Coordination attempt ${event.sessionId} is already terminal.`,
        );
      }
      if (event.type === 'detach') {
        await requireKnownSession(event.sessionId, this.store);
        this.attachSockets.get(event.sessionId)?.destroy();
        await writeAttachState(event.sessionId, 'detached', this.store);
        await recordWorkerEventSequence(event, this.store);
        this.notifyChanged();
        return { sessionId: event.sessionId, accepted: true };
      }
      if (event.type === 'heartbeat') {
        await applyWorkerHeartbeatEvent(event, this.store);
        await recordWorkerEventSequence(event, this.store);
        return { sessionId: event.sessionId, accepted: true };
      }
      await applyWorkerEvent(
        event,
        this.store,
        await this.hasPendingWorkerInputControl(event.sessionId),
        await this.hasPendingWorkerAnswerControl(event.sessionId),
      );
      await recordWorkerEventSequence(event, this.store);
      if (
        event.type === 'state' &&
        (event.sessionState === 'idle' || event.sessionState === 'completed')
      ) {
        this.expectedWorkerPromptIds.delete(event.sessionId);
      }
      this.notifyChanged();
      return { sessionId: event.sessionId, accepted: true };
    });
  }

  private async admitWorkerEvent(event: AgentViewWorkerEvent): Promise<void> {
    const worker = await readAgentViewWorker(event.sessionId, this.store);
    const expectedGeneration = currentWorkerGeneration(worker);
    if (event.generation !== expectedGeneration) {
      throw new Error(
        `Agent View worker generation ${event.generation} is not current for ${event.sessionId}.`,
      );
    }
    const admitted = this.admittedWorkerEventSequences.get(event.sessionId);
    const lastSequence = Math.max(
      worker?.lastEventSequence ?? 0,
      admitted?.generation === event.generation ? admitted.sequence : 0,
    );
    if (event.sequence <= lastSequence) {
      throw new Error(
        `Agent View worker event sequence ${event.sequence} is not newer than ${lastSequence} for ${event.sessionId}.`,
      );
    }
    this.admittedWorkerEventSequences.set(event.sessionId, {
      generation: event.generation,
      sequence: event.sequence,
    });
  }

  private async validateWorkerPromptCorrelation(
    event: Extract<AgentViewWorkerEvent, { type: 'state' }>,
  ): Promise<void> {
    if (
      event.sessionState === 'needs_input' &&
      (!event.promptId ||
        !event.callId ||
        !event.inputType ||
        !event.inputSummary)
    ) {
      throw new Error(
        `Agent View needs_input identity is incomplete for ${event.sessionId}.`,
      );
    }
    if (!event.promptId) return;
    const queuedPrompt = (
      await this.loadWorkerControls(event.sessionId)
    ).events.findLast((control) => control.type === 'prompt');
    const activity = await readAgentViewActivity(event.sessionId, this.store);
    const expectedPromptId =
      queuedPrompt?.promptId ??
      this.expectedWorkerPromptIds.get(event.sessionId) ??
      activity?.activePromptId;
    if (expectedPromptId && event.promptId !== expectedPromptId) {
      throw new Error(
        `Agent View worker prompt ${event.promptId} is not current for ${event.sessionId}.`,
      );
    }
  }

  private async applyCoordinationResult(
    event: Extract<AgentViewWorkerEvent, { type: 'result' }>,
  ): Promise<void> {
    const [state, launch, existingResult] = await Promise.all([
      readAgentViewSessionState(event.sessionId, this.store),
      readAgentViewLaunch(event.sessionId, this.store),
      readAgentViewCoordinationResult(event.sessionId, this.store),
    ]);
    if (!state?.coordination || !launch?.coordination || !launch.promptId) {
      throw new Error(
        `Agent View session ${event.sessionId} is not a coordination attempt.`,
      );
    }
    if (state.sessionState === 'stopped') {
      throw new Error(
        `Coordination attempt ${event.attemptId} is stopping or stopped.`,
      );
    }
    if (
      event.attemptId !== state.coordination.attemptId ||
      event.attemptId !== launch.coordination.attemptId
    ) {
      throw new Error(
        `Coordination attempt ${event.attemptId} is not current for ${event.sessionId}.`,
      );
    }
    if (event.promptId !== launch.promptId) {
      throw new Error(
        `Coordination prompt ${event.promptId} is not current for ${event.sessionId}.`,
      );
    }
    if (existingResult) {
      throw new Error(
        `Coordination attempt ${event.attemptId} already has a result.`,
      );
    }
    if (
      Buffer.byteLength(event.summary, 'utf8') > AGENT_VIEW_MAX_RESULT_BYTES
    ) {
      throw new Error(
        `Coordination result summary exceeds ${AGENT_VIEW_MAX_RESULT_BYTES} bytes.`,
      );
    }
    const artifacts = await validateCoordinationArtifacts(
      event.artifacts ?? [],
      state.activeCwd,
    );
    const completedAt = event.at ?? new Date().toISOString();
    const result: AgentViewCoordinationResult = {
      schemaVersion: 1,
      lineage: state.coordination,
      sessionId: event.sessionId,
      promptId: event.promptId,
      generation: event.generation,
      outcome: event.outcome,
      summary: event.summary,
      artifacts,
      completedAt,
    };
    if (
      Buffer.byteLength(JSON.stringify(result), 'utf8') >
      AGENT_VIEW_MAX_RESULT_BYTES
    ) {
      throw new Error(
        `Coordination result exceeds ${AGENT_VIEW_MAX_RESULT_BYTES} bytes.`,
      );
    }
    await writeAgentViewCoordinationResult(result, this.store);
    const sessionState =
      event.outcome === 'completed'
        ? 'completed'
        : event.outcome === 'failed'
          ? 'failed'
          : 'stopped';
    await writeAgentViewSessionState(
      {
        ...state,
        sessionState,
        updatedAt: completedAt,
      },
      this.store,
    );
    const activity = await readAgentViewActivity(event.sessionId, this.store);
    await writeAgentViewActivity(
      event.sessionId,
      {
        ...(activity ?? {
          schemaVersion: 1,
          capabilities: [],
        }),
        summary: event.summary,
        lastResult: event.summary,
        activePromptId: undefined,
        lastCompletedPromptId: event.promptId,
        waitingFor: undefined,
        inputKind: undefined,
        lastActivityAt: completedAt,
      },
      this.store,
    );
  }

  async workerControl(params?: Record<string, unknown>) {
    const sessionId = requireSessionId(params);
    return this.withSessionMutation(sessionId, async () => {
      await requireKnownSession(sessionId, this.store);
      await requireValidWorkerToken(sessionId, params, this.store);
      await requireMatchingWorkerGeneration(sessionId, params, this.store);
      const ackSequence = optionalNonNegativeIntegerParam(
        params,
        'ackSequence',
      );
      const controls = await this.loadWorkerControls(sessionId);
      if (ackSequence !== undefined && ackSequence > controls.nextSequence) {
        throw new Error(
          `Agent View worker control acknowledgement ${ackSequence} exceeds ${controls.nextSequence} for ${sessionId}.`,
        );
      }
      const events =
        ackSequence === undefined
          ? [...controls.events]
          : controls.events.filter((event) => event.sequence > ackSequence);
      if (ackSequence !== undefined) {
        await this.saveWorkerControls(sessionId, { ...controls, events });
      }
      const generation = currentWorkerGeneration(
        await readAgentViewWorker(sessionId, this.store),
      );
      return { sessionId, generation, events };
    });
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
    const attachment = await this.withSessionMutation(sessionId, async () => {
      const state = await readAgentViewSessionState(sessionId, this.store);
      if (state?.coordination) {
        writeAttachError(
          socket,
          requestId,
          'unsupported_for_coordination',
          'Managed coordination workers are one-shot; inspect logs or reassign the task instead.',
        );
        return undefined;
      }
      if (!(await this.prepareSessionForAttach(sessionId, socket, requestId))) {
        return undefined;
      }
      return this.reserveSessionAttachment(sessionId, socket, requestId);
    });
    if (!attachment) return;
    await this.attachSessionStream(sessionId, socket, requestId, attachment);
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

  async resize(params?: Record<string, unknown>) {
    const sessionId = await resolveManagedSessionId(
      requireSessionId(params),
      this.store,
    );
    return this.withSessionMutation(sessionId, async () => {
      const host = await this.workers.getOrReconnectSessionHost(sessionId);
      if (!host) {
        throw new Error(`Agent View session ${sessionId} is not running.`);
      }
      host.resize({
        columns: positiveIntegerParam(params, 'columns'),
        rows: positiveIntegerParam(params, 'rows'),
      });
      return { sessionId, resized: true };
    });
  }
  async peek(params?: Record<string, unknown>) {
    const store = this.store;
    const sessionId = await resolveManagedSessionId(
      requireSessionId(params),
      store,
    );
    return this.withSessionMutation(sessionId, async () => {
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
      );
      if (activity !== storedActivity) {
        this.notifyChanged();
      }
      const result = state.coordination
        ? await readAgentViewCoordinationResult(sessionId, store)
        : undefined;
      return {
        sessionId,
        state,
        activity,
        worker: await readAgentViewWorker(sessionId, store),
        live: this.workers.has(sessionId),
        ...(result ? { result } : {}),
        ...(activity?.staleReason === 'checkout_changed'
          ? { staleReason: 'checkout_changed' as const }
          : {}),
      };
    });
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
  async answer(params: AgentViewAnswerRequest) {
    const request: AgentViewAnswerRequest = {
      sessionId: await resolveManagedSessionId(params.sessionId, this.store),
      generation: params.generation,
      promptId: params.promptId,
      callId: params.callId,
      text: params.text,
    };
    await this.queueAnswerForSession(request);
    this.notifyChanged();
    return { sessionId: request.sessionId, answered: true };
  }
  async logs(params?: Record<string, unknown>) {
    const sessionId = await resolveManagedSessionId(
      requireSessionId(params),
      this.store,
    );
    return this.withSessionMutation(sessionId, async () => {
      const host = await this.workers.getOrReconnectSessionHost(sessionId);
      return {
        sessionId,
        output: host
          ? ((await host.getOutput?.()) ?? host.output.toString())
          : '',
        live: Boolean(host),
      };
    });
  }
  async stop(params?: Record<string, unknown>) {
    const sessionId = await resolveManagedSessionId(
      requireSessionId(params),
      this.store,
    );
    const coordination = await this.withSessionMutation(sessionId, async () => {
      const state = await readAgentViewSessionState(sessionId, this.store);
      if (state?.coordination) {
        await markStoppedSession(sessionId, this.store, state.processState);
        await this.clearPendingSessionControls(sessionId);
        this.notifyChanged();
        return true;
      }
      await this.workers.stopSession(sessionId, () =>
        this.queueWorkerStop(sessionId),
      );
      this.notifyChanged();
      return false;
    });
    if (coordination) {
      if (!(await this.workers.terminateSessionAndWait(sessionId, 'SIGTERM'))) {
        throw new Error(
          `Coordination worker ${sessionId} did not exit; its session and worktree were preserved.`,
        );
      }
      await this.withSessionMutation(sessionId, async () => {
        await markStoppedSession(sessionId, this.store, 'exited');
      });
      this.notifyChanged();
    }
    return { sessionId, stopped: true };
  }
  async kill(params?: Record<string, unknown>) {
    const sessionId = await resolveManagedSessionId(
      requireSessionId(params),
      this.store,
    );
    const coordination = await this.withSessionMutation(sessionId, async () => {
      const state = await readAgentViewSessionState(sessionId, this.store);
      if (state?.coordination) {
        await markStoppedSession(sessionId, this.store, state.processState);
        await this.clearPendingSessionControls(sessionId);
        this.notifyChanged();
        return true;
      } else {
        await this.workers.killSession(sessionId, 'SIGKILL');
      }
      await this.clearPendingSessionControls(sessionId);
      this.notifyChanged();
      return false;
    });
    if (coordination) {
      if (!(await this.workers.terminateSessionAndWait(sessionId, 'SIGKILL'))) {
        throw new Error(
          `Coordination worker ${sessionId} did not exit; its session and worktree were preserved.`,
        );
      }
      await this.withSessionMutation(sessionId, async () => {
        await markStoppedSession(sessionId, this.store, 'exited');
      });
      this.notifyChanged();
    }
    return { sessionId, killed: true };
  }
  async respawn(params?: Record<string, unknown>) {
    const all = params?.['all'] === true;
    if (all) {
      const states = await listAgentViewSessionStates(this.store);
      const results = [];
      for (const state of states) {
        if (state.ownership !== 'managed') continue;
        results.push(
          await this.withSessionMutation(state.sessionId, async () => {
            try {
              const latestState = await readAgentViewSessionState(
                state.sessionId,
                this.store,
              );
              if (!latestState) {
                return {
                  sessionId: state.sessionId,
                  skipped: true,
                  reason: 'removed',
                };
              }
              if (latestState.coordination) {
                return {
                  sessionId: state.sessionId,
                  skipped: true,
                  reason:
                    'managed coordination tasks must be continued with reassign',
                };
              }
              const attachRefreshedState =
                await this.detachIfAttachIsStale(latestState);
              const refreshedState =
                await this.workers.refreshMissingWorkerState(
                  attachRefreshedState,
                );
              const blockReason = getRespawnBlockReason(
                refreshedState,
                await readAgentViewActivity(state.sessionId, this.store),
              );
              if (blockReason) {
                return {
                  sessionId: state.sessionId,
                  skipped: true,
                  reason: blockReason,
                };
              }
              return await this.workers.respawnSession(state.sessionId);
            } catch (error) {
              return {
                sessionId: state.sessionId,
                skipped: true,
                reason: error instanceof Error ? error.message : String(error),
              };
            }
          }),
        );
      }
      this.notifyChanged();
      return { all: true, results };
    }
    const sessionId = await resolveManagedSessionId(
      requireSessionId(params),
      this.store,
    );
    return this.withSessionMutation(sessionId, async () => {
      const state = await readAgentViewSessionState(sessionId, this.store);
      if (state?.coordination) {
        throw new Error(
          'Managed coordination workers cannot be respawned; use coordination reassign.',
        );
      }
      if (state) {
        await this.detachIfAttachIsStale(state);
      }
      const result = await this.workers.respawnSession(sessionId);
      this.notifyChanged();
      return result;
    });
  }
  async remove(params?: Record<string, unknown>) {
    return this.withCoordinationAdmission(() => this.removeLocked(params));
  }

  private async removeLocked(params?: Record<string, unknown>) {
    const store = this.store;
    const sessionId = await resolveManagedSessionId(
      requireSessionId(params),
      store,
    );
    const coordinationState = await this.withSessionMutation(
      sessionId,
      async () => {
        const state = await readAgentViewSessionState(sessionId, store);
        if (state?.coordination) {
          await markStoppedSession(sessionId, store, state.processState);
          await this.clearPendingSessionControls(sessionId);
          this.notifyChanged();
          return state;
        }
        await this.workers.killSession(sessionId, 'SIGTERM');
        await this.removeSessionFilesLocked(sessionId, state);
        return undefined;
      },
    );
    if (!coordinationState) {
      return { sessionId, removed: true };
    }
    if (!(await this.workers.terminateSessionAndWait(sessionId, 'SIGTERM'))) {
      throw new Error(
        `Coordination worker ${sessionId} did not exit; its session and worktree were preserved.`,
      );
    }
    return this.withSessionMutation(sessionId, async () => {
      const state = await readAgentViewSessionState(sessionId, store);
      if (!state) return { sessionId, removed: true };
      await markStoppedSession(sessionId, store, 'exited');
      const result = await readAgentViewCoordinationResult(sessionId, store);
      if (
        state.worktree.mode === 'worktree' &&
        (result?.artifacts.length ?? 0) > 0
      ) {
        throw new Error(
          `Coordination worktree ${state.worktree.path} is referenced by collected artifacts and was preserved.`,
        );
      }
      if (
        state.worktree.mode === 'worktree' &&
        !(await cleanupStoredCoordinationWorktree(state, store))
      ) {
        throw new Error(
          `Coordination worktree ${state.worktree.path} contains retained work; collect it before removing the session.`,
        );
      }
      if (state.coordination) {
        await markCoordinationManifestWorktreeCleaned(
          state.coordination.coordinationId,
          sessionId,
          store,
        );
      }
      await this.removeSessionFilesLocked(sessionId, state);
      return { sessionId, removed: true };
    });
  }

  private async removeSessionFilesLocked(
    sessionId: string,
    state: AgentViewSessionStateFile | undefined,
  ): Promise<void> {
    if (state) {
      await writeAgentViewSessionState(
        {
          ...state,
          ownership: 'unmanaged',
          processState: 'exited',
          updatedAt: new Date().toISOString(),
        },
        this.store,
      );
    }
    await this.clearPendingSessionControls(sessionId);
    await removeAgentViewRosterEntry(sessionId, this.store);
    await removeAgentViewSessionFiles(sessionId, this.store);
    this.workerControls.delete(sessionId);
    this.admittedWorkerEventSequences.delete(sessionId);
    this.notifyChanged();
  }
  async pin(params?: Record<string, unknown>) {
    const store = this.store;
    const sessionId = await resolveManagedSessionId(
      requireSessionId(params),
      store,
    );
    return this.withSessionMutation(sessionId, async () => {
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
    });
  }
  async rename(params?: Record<string, unknown>) {
    const store = this.store;
    const sessionId = await resolveManagedSessionId(
      requireSessionId(params),
      store,
    );
    return this.withSessionMutation(sessionId, async () => {
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
    });
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
      const didHibernate = await this.withSessionMutation(
        snapshot.sessionId,
        async () => {
          const state = await readAgentViewSessionState(
            snapshot.sessionId,
            this.store,
          );
          const activity = await readAgentViewActivity(
            snapshot.sessionId,
            this.store,
          );
          const host = this.workers.get(snapshot.sessionId);
          if (
            !state ||
            !host ||
            !canHibernateSession(
              { ...snapshot, state, activity },
              nowMs,
              policy.idleMs,
            )
          ) {
            return false;
          }

          await markSessionHibernating(state, this.store);
          if (!(await this.workers.shutdownHost(snapshot.sessionId, host))) {
            await writeAgentViewSessionState(
              { ...state, updatedAt: new Date().toISOString() },
              this.store,
            );
            return false;
          }
          await markSessionHibernated(state, this.store);
          return true;
        },
      );
      if (didHibernate) hibernated.push(snapshot.sessionId);
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
    return managed.every((state) => !isAliveProcessState(state.processState));
  }

  private async attachSessionStream(
    sessionId: string,
    socket: Socket,
    requestId: string,
    attachment: {
      host: AgentViewPtyHostHandle;
      lease: AgentViewAttachLease;
    },
  ): Promise<void> {
    const controller = new AbortController();
    socket.once('close', () => controller.abort());
    void attachment.host.exited
      .catch(() => {})
      .finally(() => {
        controller.abort();
      });
    const heartbeat = setInterval(() => {
      this.attachLeases.heartbeat(sessionId, attachment.lease.leaseId);
    }, DEFAULT_ATTACH_LEASE_HEARTBEAT_MS);
    heartbeat.unref?.();
    socket.write(
      `${JSON.stringify({
        id: requestId,
        ok: true,
        result: {
          sessionId,
          lease: attachment.lease,
        },
      })}\n`,
    );
    try {
      await bridgeAgentViewTerminal({
        stdin: socket,
        stdout: socket,
        pty: attachment.host,
        detachSignal: controller.signal,
      });
    } finally {
      clearInterval(heartbeat);
      await this.withSessionMutation(sessionId, async () => {
        if (this.attachSockets.get(sessionId) === socket) {
          this.attachSockets.delete(sessionId);
        }
        this.attachLeases.release(sessionId, attachment.lease.leaseId);
        await writeAttachState(sessionId, 'detached', this.store);
      });
      socket.end();
    }
  }

  private async reserveSessionAttachment(
    sessionId: string,
    socket: Socket,
    requestId: string,
  ): Promise<
    { host: AgentViewPtyHostHandle; lease: AgentViewAttachLease } | undefined
  > {
    await requireKnownSession(sessionId, this.store);
    const host = this.workers.get(sessionId);
    if (!host) {
      writeAttachError(
        socket,
        requestId,
        'not_running',
        `Agent View session ${sessionId} is not running.`,
      );
      return undefined;
    }

    const leaseResult = this.attachLeases.acquire(sessionId);
    if (!leaseResult.ok) {
      writeAttachError(
        socket,
        requestId,
        'already_attached',
        `Agent View session ${sessionId} is already attached.`,
      );
      return undefined;
    }
    await writeAttachState(sessionId, 'attached', this.store);
    this.attachSockets.set(sessionId, socket);
    await this.queueWorkerRedraw(sessionId);
    return { host, lease: leaseResult.lease };
  }

  private async queueWorkerRedraw(sessionId: string): Promise<void> {
    await this.appendWorkerControl(sessionId, {
      type: 'redraw',
      at: new Date().toISOString(),
    });
  }

  private async queueWorkerStop(sessionId: string): Promise<void> {
    await this.appendWorkerControl(sessionId, {
      type: 'stop',
      at: new Date().toISOString(),
    });
  }

  private async queuePromptForSession(
    sessionId: string,
    text: string,
  ): Promise<void> {
    return this.withSessionMutation(sessionId, async () => {
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
    if (state.coordination) {
      throw new Error(
        'Managed coordination workers cannot accept follow-up prompts; use coordination reassign.',
      );
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

    const activity = await clearStalePendingPromptIfNeeded(
      state,
      await readAgentViewActivity(sessionId, this.store),
      this.store,
    );
    if (
      hasPendingPrompt(activity) ||
      (await this.hasPendingWorkerInputControl(sessionId))
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

    const now = new Date().toISOString();
    const promptId = randomUUID();
    await this.appendWorkerControl(sessionId, {
      type: 'prompt',
      promptId,
      text,
      at: now,
    });
    this.expectedWorkerPromptIds.set(sessionId, promptId);
    await writeAgentViewActivity(
      sessionId,
      {
        schemaVersion: 1,
        ...getQueuedPromptActivityPatch(text, now),
        lastActivityAt: now,
        capabilities: activity?.capabilities ?? [],
      },
      this.store,
    );
  }

  private async queueAnswerForSession(
    request: AgentViewAnswerRequest,
  ): Promise<void> {
    return this.withSessionMutation(request.sessionId, async () => {
      await this.queueAnswerForSessionLocked(request);
    });
  }

  private async queueAnswerForSessionLocked(
    request: AgentViewAnswerRequest,
  ): Promise<void> {
    const { sessionId } = request;
    let state = await readAgentViewSessionState(sessionId, this.store);
    if (!state) {
      throw new Error(`No Agent View session found for ${sessionId}.`);
    }
    if (state.coordination) {
      throw new Error(
        'Managed coordination workers cannot accept answers; use coordination reassign.',
      );
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
    const [activity, worker] = await Promise.all([
      readAgentViewActivity(sessionId, this.store),
      readAgentViewWorker(sessionId, this.store),
    ]);
    const pendingInput = activity?.pendingInput;
    if (
      !pendingInput ||
      currentWorkerGeneration(worker) !== request.generation ||
      pendingInput.generation !== request.generation ||
      pendingInput.promptId !== request.promptId ||
      pendingInput.callId !== request.callId
    ) {
      throw new Error(
        `Agent View answer target is stale or does not match ${sessionId}.`,
      );
    }
    if (!this.workers.has(sessionId)) {
      await this.workers.reconnectSessionHost(sessionId);
    }
    if (!this.workers.has(sessionId)) {
      throw new Error(`Agent View session ${sessionId} is not running.`);
    }
    if (
      (activity?.waitingFor === 'response' && hasPendingPrompt(activity)) ||
      (await this.hasPendingWorkerInputControl(sessionId))
    ) {
      throw new Error(
        `Agent View session ${sessionId} is waiting for the previous response.`,
      );
    }
    await this.appendWorkerControl(sessionId, {
      type: 'answer',
      promptId: request.promptId,
      callId: request.callId,
      text: request.text,
      at: now,
    });
    await writeAgentViewActivity(
      sessionId,
      {
        ...activity,
        schemaVersion: 1,
        pendingInput: undefined,
        lastActivityAt: now,
        capabilities: activity?.capabilities ?? [],
      },
      this.store,
    );
  }

  private async hasPendingWorkerInputControl(
    sessionId: string,
  ): Promise<boolean> {
    return (await this.loadWorkerControls(sessionId)).events.some(
      (event) => event.type === 'prompt' || event.type === 'answer',
    );
  }

  private async hasPendingWorkerAnswerControl(
    sessionId: string,
  ): Promise<boolean> {
    return (await this.loadWorkerControls(sessionId)).events.some(
      (event) => event.type === 'answer',
    );
  }

  private async clearPendingSessionControls(sessionId: string): Promise<void> {
    const controls = await this.loadWorkerControls(sessionId);
    await this.saveWorkerControls(sessionId, { ...controls, events: [] });
    this.expectedWorkerPromptIds.delete(sessionId);
    if (await clearPersistedPromptQueue(sessionId, this.store)) {
      this.notifyChanged();
    }
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
    const next = {
      ...state,
      attachState: 'detached' as const,
      updatedAt: new Date().toISOString(),
    };
    await writeAgentViewSessionState(next, this.store);
    this.notifyChanged();
    return next;
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
    private readonly mutateSession: AgentViewSessionMutation,
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
      this.rejectPendingWorkerReadyForHost(
        sessionId,
        previous,
        new Error(`Agent View worker ${sessionId} was replaced before ready.`),
      );
      previous.kill('SIGTERM');
    }
    this.ptyHosts.set(sessionId, host);
    const waiter = this.pendingWorkerReady.get(sessionId);
    if (waiter && !waiter.host) waiter.host = host;
    this.trackHostExit(sessionId, host);
  }

  delete(sessionId: string): void {
    const host = this.ptyHosts.get(sessionId);
    if (!host) return;
    this.rejectPendingWorkerReadyForHost(
      sessionId,
      host,
      new Error(`Agent View worker ${sessionId} was removed before ready.`),
    );
    this.ptyHosts.delete(sessionId);
  }

  async stopSession(
    sessionId: string,
    queueStop: () => Promise<void>,
  ): Promise<void> {
    const host = await this.getOrReconnectSessionHost(sessionId);
    if (host) {
      await queueStop();
      await markStoppedSession(sessionId, this.store, 'alive');
      this.scheduleStopFallback(sessionId, host);
      return;
    }
    await this.assertNoUnverifiedStoredWorker(sessionId);
    this.rejectPendingWorkerReady(
      sessionId,
      new Error(`Agent View worker ${sessionId} was stopped before ready.`),
    );
    await markStoppedSession(sessionId, this.store, 'exited');
  }

  async killSession(
    sessionId: string,
    signal: NodeJS.Signals = 'SIGTERM',
  ): Promise<void> {
    const host = await this.getOrReconnectSessionHost(sessionId);
    if (host) {
      this.rejectPendingWorkerReadyForHost(
        sessionId,
        host,
        new Error(`Agent View worker ${sessionId} was killed before ready.`),
      );
      host.kill(signal);
    } else {
      await this.assertNoUnverifiedStoredWorker(sessionId);
      this.rejectPendingWorkerReady(
        sessionId,
        new Error(`Agent View worker ${sessionId} was killed before ready.`),
      );
    }
    if (host && this.ptyHosts.get(sessionId) === host) {
      this.ptyHosts.delete(sessionId);
    }
    await markStoppedSession(sessionId, this.store, 'exited');
  }

  terminateSession(sessionId: string, signal: NodeJS.Signals): void {
    const host = this.ptyHosts.get(sessionId);
    if (host) {
      this.rejectPendingWorkerReadyForHost(
        sessionId,
        host,
        new Error(
          `Agent View worker ${sessionId} was terminated before ready.`,
        ),
      );
    } else {
      this.rejectPendingWorkerReady(
        sessionId,
        new Error(
          `Agent View worker ${sessionId} was terminated before ready.`,
        ),
      );
    }
    host?.kill(signal);
    if (host) {
      this.ptyHosts.delete(sessionId);
    }
  }

  async terminateSessionAndWait(
    sessionId: string,
    signal: NodeJS.Signals,
  ): Promise<boolean> {
    const host = await this.getOrReconnectSessionHost(sessionId);
    if (!host) {
      const [state, worker, receipt] = await Promise.all([
        readAgentViewSessionState(sessionId, this.store),
        readAgentViewWorker(sessionId, this.store),
        readAgentViewPtyHostReceipt(sessionId, this.store),
      ]);
      const identity = resolvePersistedPtyHostIdentity(worker, receipt);
      if (identity) {
        return (
          !isPidRunning(identity.hostPid) && !isPidRunning(identity.workerPid)
        );
      }
      if (state?.coordination) return false;
      if (!state || !isAliveProcessState(state.processState)) return true;
      return !(
        isPidRunning(worker?.hostPid) || isPidRunning(worker?.workerPid)
      );
    }
    this.terminateSession(sessionId, signal);
    if (await waitForHostExit(host, DEFAULT_GRACEFUL_STOP_TIMEOUT_MS)) {
      return true;
    }
    host.kill('SIGKILL');
    return waitForHostExit(host, 1_000);
  }

  async shutdownHost(
    sessionId: string,
    host: AgentViewPtyHostHandle,
  ): Promise<boolean> {
    if (this.ptyHosts.get(sessionId) === host) {
      this.rejectPendingWorkerReadyForHost(
        sessionId,
        host,
        new Error(`Agent View worker ${sessionId} exited before ready.`),
      );
    }
    try {
      await shutdownPtyHost(host);
    } catch {
      return false;
    }
    let exited = await waitForHostExit(host, DEFAULT_GRACEFUL_STOP_TIMEOUT_MS);
    if (!exited) {
      host.kill('SIGKILL');
      exited = await waitForHostExit(host, 1_000);
    }
    if (exited && this.ptyHosts.get(sessionId) === host) {
      this.ptyHosts.delete(sessionId);
    }
    return exited;
  }

  async isSessionExitConfirmed(sessionId: string): Promise<boolean> {
    if (this.ptyHosts.has(sessionId)) return false;
    const [state, worker, receipt] = await Promise.all([
      readAgentViewSessionState(sessionId, this.store),
      readAgentViewWorker(sessionId, this.store),
      readAgentViewPtyHostReceipt(sessionId, this.store),
    ]);
    const identity = resolvePersistedPtyHostIdentity(worker, receipt);
    if (identity) {
      return (
        !isPidRunning(identity.hostPid) && !isPidRunning(identity.workerPid)
      );
    }
    if (state?.coordination) return false;
    return !(isPidRunning(worker?.hostPid) || isPidRunning(worker?.workerPid));
  }

  async shutdownAll(): Promise<number> {
    const entries = Array.from(this.ptyHosts.entries());
    const failed: string[] = [];
    await Promise.all(
      entries.map(([sessionId, host]) =>
        this.mutateSession(sessionId, async () => {
          if (!(await this.shutdownHost(sessionId, host))) {
            failed.push(sessionId);
            return;
          }
          await markStoppedSession(sessionId, this.store, 'exited');
        }),
      ),
    );
    if (failed.length > 0) {
      throw new Error(
        `Agent View workers did not exit and were preserved: ${failed.join(', ')}`,
      );
    }
    return entries.length;
  }

  async launchPtyHostForSupervisor(
    launchRecord: AgentViewLaunchFile,
    store: AgentViewStoreOptions,
    workerEnvironment?: Readonly<Record<string, string>>,
  ): Promise<AgentViewPtyHostHandle> {
    const launch = await refreshStoredResumeWorkerLaunchIfNeeded(
      launchRecord,
      store,
    );
    if (this.options.launchPtyHost) {
      return this.options.launchPtyHost(launch, workerEnvironment);
    }
    return launchAgentViewPtyHostProcess(launch, {
      ...store,
      ...(workerEnvironment ? { workerEnvironment } : {}),
    });
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

  private rejectPendingWorkerReadyForHost(
    sessionId: string,
    host: AgentViewPtyHostHandle,
    error: Error,
  ): void {
    const waiter = this.pendingWorkerReady.get(sessionId);
    if (!waiter || waiter.host !== host) return;
    this.rejectPendingWorkerReady(sessionId, error);
  }

  async reconnectSessionHost(sessionId: string): Promise<boolean> {
    return this.reconnectSessionHostLocked(sessionId);
  }

  private async reconnectSessionHostLocked(
    sessionId: string,
  ): Promise<boolean> {
    if (this.ptyHosts.has(sessionId)) {
      return true;
    }
    const [launch, worker, receipt] = await Promise.all([
      readAgentViewLaunch(sessionId, this.store),
      readAgentViewWorker(sessionId, this.store),
      readAgentViewPtyHostReceipt(sessionId, this.store),
    ]);
    const identity = resolvePersistedPtyHostIdentity(worker, receipt);
    if (!launch || !worker || !identity) {
      return false;
    }

    let host: AgentViewPtyHostHandle | undefined;
    try {
      host = await connectAgentViewPtyHostProcess(
        launch,
        identity.hostEndpoint,
        identity.hostAuthToken,
      );
      await writeAgentViewWorker(
        sessionId,
        {
          schemaVersion: 1,
          generation: currentWorkerGeneration(worker),
          hostPid: host.pid,
          workerPid: host.workerPid,
          hostEndpoint: identity.hostEndpoint,
          hostAuthToken: identity.hostAuthToken,
          protocolVersion: AGENT_VIEW_PROTOCOL_VERSION,
          platform: process.platform,
          recentOutputBytes: worker.recentOutputBytes,
        },
        this.store,
      );
      this.set(sessionId, host);
      return true;
    } catch {
      host?.dispose();
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
    return this.respawnSessionLocked(sessionId);
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
    if (!this.ptyHosts.has(sessionId)) {
      await this.assertNoUnverifiedStoredWorker(sessionId);
    }
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
    const generation = await nextWorkerGeneration(sessionId, this.store);
    await writeAgentViewWorker(
      sessionId,
      {
        schemaVersion: 1,
        hostPid: undefined,
        workerPid: undefined,
        endpoint: undefined,
        hostEndpoint: undefined,
        hostAuthToken: undefined,
        generation,
        lastEventSequence: 0,
        protocolVersion: AGENT_VIEW_PROTOCOL_VERSION,
        platform: process.platform,
        recentOutputBytes: 0,
      },
      this.store,
    );
    const resumeLaunch = await writeResumeWorkerLaunch(
      launch,
      generation,
      this.store,
    );
    this.ptyHosts.get(sessionId)?.kill('SIGTERM');
    let host: AgentViewPtyHostHandle | undefined;
    try {
      const ready = this.waitForWorkerReadyIfNeeded(
        sessionId,
        resumeLaunch.activeCwd,
      );
      void ready.catch(() => {});
      host = await this.launchPtyHostForSupervisor(resumeLaunch, this.store);
      await ensureSessionStillLaunchable(sessionId, this.store, host, {
        allowStopped: state.sessionState === 'stopped',
      });
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
          generation,
          lastEventSequence: 0,
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
      this.ptyHosts.delete(sessionId);
      await markFailedSession(sessionId, error, this.store);
      throw error;
    }
    return { sessionId, respawned: true };
  }

  private async assertNoUnverifiedStoredWorker(
    sessionId: string,
  ): Promise<void> {
    const worker = await readAgentViewWorker(sessionId, this.store);
    if (isPidRunning(worker?.hostPid) || isPidRunning(worker?.workerPid)) {
      throw new Error(
        `Agent View session ${sessionId} has a running persisted process, but its PTY host identity cannot be verified.`,
      );
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
    await this.assertNoUnverifiedStoredWorker(sessionId);
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

    const host = await this.getOrReconnectSessionHost(sessionId);
    if (host) {
      this.rejectPendingWorkerReadyForHost(
        sessionId,
        host,
        new Error(`Agent View worker ${sessionId} was replaced before ready.`),
      );
      host.kill('SIGTERM');
      if (this.ptyHosts.get(sessionId) === host) {
        this.ptyHosts.delete(sessionId);
      }
    } else {
      await this.assertNoUnverifiedStoredWorker(sessionId);
    }
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
      .then((exit) => {
        if (this.ptyHosts.get(sessionId) !== host) {
          return;
        }
        this.rejectPendingWorkerReadyForHost(
          sessionId,
          host,
          new Error(`Agent View worker ${sessionId} exited before ready.`),
        );
        return this.mutateSession(sessionId, async () => {
          if (this.ptyHosts.get(sessionId) !== host) return;
          try {
            await updateExitedSession(sessionId, exit.exitCode, this.store);
          } finally {
            if (this.ptyHosts.get(sessionId) === host) {
              this.ptyHosts.delete(sessionId);
            }
            this.onChanged();
          }
        });
      })
      .catch(() => {});
  }

  private scheduleStopFallback(
    sessionId: string,
    host: AgentViewPtyHostHandle,
  ): void {
    const timeout = setTimeout(() => {
      void this.mutateSession(sessionId, async () => {
        if (this.ptyHosts.get(sessionId) !== host) return;
        // Ctrl+X asks the worker to stop first; this is the timeout backstop.
        this.rejectPendingWorkerReadyForHost(
          sessionId,
          host,
          new Error(`Agent View worker ${sessionId} stopped before ready.`),
        );
        host.kill('SIGTERM');
        this.ptyHosts.delete(sessionId);
        await markStoppedSession(sessionId, this.store, 'exited');
        this.onChanged();
      }).catch(() => {});
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
      if (await reconnect()) {
        return state;
      }
      const worker = await readAgentViewWorker(state.sessionId, this.store);
      if (isPidRunning(worker?.hostPid) || isPidRunning(worker?.workerPid)) {
        return state;
      }
      const nextState = {
        ...state,
        processState: 'hibernated' as const,
        attachState: 'detached' as const,
        updatedAt: new Date().toISOString(),
      };
      await writeAgentViewSessionState(nextState, this.store);
      return nextState;
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

    const [worker, receipt] = await Promise.all([
      readAgentViewWorker(state.sessionId, this.store),
      readAgentViewPtyHostReceipt(state.sessionId, this.store),
    ]);
    const identity = resolvePersistedPtyHostIdentity(worker, receipt);
    if (
      (state.coordination && !identity) ||
      isPidRunning(identity?.hostPid ?? worker?.hostPid) ||
      isPidRunning(identity?.workerPid ?? worker?.workerPid)
    ) {
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
  private version = 0;

  markDirty(): void {
    this.dirty = true;
    this.version++;
  }

  async list(
    store: AgentViewStoreOptions,
    nowMs: number,
  ): Promise<AgentViewSessionSnapshot[]> {
    if (!this.dirty && this.snapshots && nowMs < this.expiresAt) {
      return this.snapshots;
    }
    const version = this.version;
    this.snapshots = await listAgentViewSessionSnapshots(store);
    this.expiresAt = nowMs + 1000;
    if (version === this.version) {
      this.dirty = false;
    }
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

async function waitForHostExit(
  host: AgentViewPtyHostHandle,
  timeoutMs: number,
): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      host.exited.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function ensureSessionStillLaunchable(
  sessionId: string,
  store: AgentViewStoreOptions,
  host?: AgentViewPtyHostHandle,
  options: { allowStopped?: boolean } = {},
): Promise<void> {
  const state = await readAgentViewSessionState(sessionId, store);
  if (
    !state ||
    (state.ownership !== 'managed' && state.ownership !== 'adopting') ||
    (state.sessionState === 'stopped' && !options.allowStopped)
  ) {
    host?.kill('SIGTERM');
    throw new Error(`Agent View session ${sessionId} was stopped.`);
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
  if (hasPendingPrompt(snapshot.activity)) return false;
  if (!canAgentViewHibernate(snapshot)) {
    return false;
  }
  if (
    snapshot.state.processState === 'hibernated' ||
    snapshot.state.processState === 'exited'
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
): Promise<void> {
  const latest = await readAgentViewSessionState(state.sessionId, options);
  if (!latest || latest.ownership !== 'managed') return;
  await writeAgentViewSessionState(
    {
      ...latest,
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
  const latest = await readAgentViewSessionState(state.sessionId, options);
  if (!latest || latest.ownership !== 'managed') return;
  if (latest.sessionState === 'stopped') return;
  await writeAgentViewSessionState(
    {
      ...latest,
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

interface PersistedPtyHostIdentity {
  hostPid: number;
  workerPid: number;
  hostEndpoint: string;
  hostAuthToken: string;
  generation: number;
}

function resolvePersistedPtyHostIdentity(
  worker: AgentViewWorkerFile | undefined,
  receipt: AgentViewPtyHostReceipt | undefined,
): PersistedPtyHostIdentity | undefined {
  const generation = currentWorkerGeneration(worker);
  const workerIdentity =
    isSafeExternalPid(worker?.hostPid) &&
    isSafeExternalPid(worker?.workerPid) &&
    worker?.hostEndpoint &&
    worker.hostAuthToken
      ? {
          hostPid: worker.hostPid,
          workerPid: worker.workerPid,
          hostEndpoint: worker.hostEndpoint,
          hostAuthToken: worker.hostAuthToken,
          generation,
        }
      : undefined;
  const receiptIdentity =
    receipt &&
    receipt.generation === generation &&
    isSafeExternalPid(receipt.hostPid) &&
    isSafeExternalPid(receipt.workerPid)
      ? receipt
      : undefined;
  if (workerIdentity && receiptIdentity) {
    if (
      workerIdentity.hostPid !== receiptIdentity.hostPid ||
      workerIdentity.workerPid !== receiptIdentity.workerPid ||
      workerIdentity.hostEndpoint !== receiptIdentity.hostEndpoint ||
      workerIdentity.hostAuthToken !== receiptIdentity.hostAuthToken
    ) {
      return undefined;
    }
  }
  return receiptIdentity ?? workerIdentity;
}

function isSafeExternalPid(pid: number | undefined): pid is number {
  return Number.isSafeInteger(pid) && Number(pid) > 0 && pid !== process.pid;
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
    state.processState === 'hibernated' ||
    state.processState === 'hibernating'
  ) {
    return;
  }
  await writeAgentViewSessionState(
    {
      ...state,
      sessionState:
        state.sessionState === 'stopped' ||
        state.sessionState === 'failed' ||
        state.sessionState === 'completed'
          ? state.sessionState
          : exitCode === 0
            ? 'completed'
            : 'failed',
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
  if (state.ownership !== 'managed') return;
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
  hasPendingControl: boolean,
  hasPendingAnswerControl: boolean,
): Promise<void> {
  const state = await readAgentViewSessionState(event.sessionId, options);
  if (!state) {
    throw new Error(`No Agent View session found for ${event.sessionId}.`);
  }
  if (state.ownership !== 'managed' && state.ownership !== 'adopting') {
    throw new Error(`Agent View session ${event.sessionId} is not managed.`);
  }
  if (state.sessionState === 'stopped') {
    return;
  }

  const now = event.at ?? new Date().toISOString();
  const activeCwd =
    event.type === 'ready' || event.type === 'state'
      ? path.resolve(event.cwd ?? state.activeCwd)
      : state.activeCwd;
  const sessionState =
    event.type === 'ready'
      ? 'idle'
      : event.type === 'result'
        ? event.outcome === 'failed'
          ? 'failed'
          : 'completed'
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
      ...(event.type === 'ready' ? { lastError: undefined } : {}),
    },
    options,
  );

  const existingActivity = await readAgentViewActivity(
    event.sessionId,
    options,
  );
  const completedPromptId =
    event.type === 'state' &&
    (event.sessionState === 'idle' || event.sessionState === 'completed')
      ? (event.promptId ?? existingActivity?.activePromptId)
      : event.type === 'result'
        ? event.promptId
        : undefined;
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
          ...(event.type === 'state' &&
          event.sessionState === 'needs_input' &&
          event.promptId &&
          event.callId &&
          event.inputType &&
          event.inputSummary &&
          !hasPendingAnswerControl
            ? {
                pendingInput: {
                  generation: event.generation,
                  promptId: event.promptId,
                  callId: event.callId,
                  type: event.inputType,
                  summary: event.inputSummary,
                },
              }
            : { pendingInput: undefined }),
          ...(event.type === 'state' && event.lastResult
            ? { lastResult: event.lastResult }
            : { lastResult: undefined }),
          ...(event.type === 'state' &&
          (event.sessionState === 'working' ||
            event.sessionState === 'needs_input') &&
          event.promptId
            ? { activePromptId: event.promptId }
            : {}),
          ...(event.type === 'state' &&
          (event.sessionState === 'idle' || event.sessionState === 'completed')
            ? {
                activePromptId: undefined,
                ...(completedPromptId
                  ? { lastCompletedPromptId: completedPromptId }
                  : {}),
              }
            : {}),
          ...(shouldClearPendingPrompt(event) && !hasPendingControl
            ? getDequeuedPromptActivityPatch(existingActivity)
            : {}),
          capabilities:
            event.type === 'ready'
              ? (event.capabilities ?? [])
              : (existingActivity?.capabilities ?? []),
        }
      : event.type === 'result'
        ? {
            summary: event.summary,
            lastResult: event.summary,
            waitingFor: undefined,
            inputKind: undefined,
            pendingInput: undefined,
            activePromptId: undefined,
            lastCompletedPromptId: event.promptId,
            capabilities: existingActivity?.capabilities ?? [],
          }
        : { capabilities: existingActivity?.capabilities ?? [] };
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
    event.type === 'ready' ||
    event.type === 'result' ||
    (event.type === 'state' &&
      (event.sessionState === 'idle' ||
        event.sessionState === 'completed' ||
        (event.sessionState === 'needs_input' &&
          event.waitingFor === 'response')))
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
  if (event.type === 'result') {
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

async function clearPersistedPromptQueue(
  sessionId: string,
  store: { globalDir?: string },
): Promise<boolean> {
  const activity = await readAgentViewActivity(sessionId, store);
  if (!activity || !hasPendingPrompt(activity)) {
    return false;
  }
  await writeAgentViewActivity(
    sessionId,
    {
      ...activity,
      ...getDequeuedPromptActivityPatch(activity),
    },
    store,
  );
  return true;
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
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`Agent View ${key} must be a positive integer.`);
  }
  return Number(value);
}

function optionalNonNegativeIntegerParam(
  params: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = params?.[key];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(`Agent View ${key} must be a non-negative integer.`);
  }
  return Number(value);
}

function parseCoordinationDispatchParams(
  params: Record<string, unknown> | undefined,
): AgentViewCoordinationDispatchRequest {
  const coordinationId = requireFullUuid(
    params?.['coordinationId'],
    'coordination ID',
  );
  const cwd = params?.['cwd'];
  const rawTasks = params?.['tasks'];
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
    throw new Error('Coordination dispatch requires an absolute cwd.');
  }
  if (
    !Array.isArray(rawTasks) ||
    rawTasks.length < 1 ||
    rawTasks.length > AGENT_VIEW_MAX_COORDINATION_WORKERS
  ) {
    throw new Error(
      `Coordination dispatch requires 1-${AGENT_VIEW_MAX_COORDINATION_WORKERS} tasks.`,
    );
  }
  const tasks = rawTasks.map(parseCoordinationTaskRequest);
  if (tasks.filter((task) => task.writeMode === 'isolated-writer').length > 1) {
    throw new Error('A coordination dispatch can contain at most one writer.');
  }
  return {
    coordinationId,
    cwd: path.resolve(cwd),
    tasks,
    environment: parseCoordinationEnvironment(params?.['environment']),
  };
}

function parseCoordinationReassignParams(
  params: Record<string, unknown> | undefined,
): AgentViewCoordinationReassignRequest {
  const coordinationId = requireFullUuid(
    params?.['coordinationId'],
    'coordination ID',
  );
  const taskId = requireFullUuid(params?.['taskId'], 'task ID');
  const taskFile = params?.['taskFile'];
  const writeMode = params?.['writeMode'];
  if (typeof taskFile !== 'string' || !path.isAbsolute(taskFile)) {
    throw new Error('Coordination task file must be absolute.');
  }
  if (
    writeMode !== undefined &&
    writeMode !== 'read-only' &&
    writeMode !== 'isolated-writer'
  ) {
    throw new Error('Coordination task write mode is invalid.');
  }
  return {
    coordinationId,
    taskId,
    taskFile: path.resolve(taskFile),
    ...(writeMode ? { writeMode } : {}),
    environment: parseCoordinationEnvironment(params?.['environment']),
  };
}

function parseCoordinationEnvironment(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    throw new Error('Coordination launch environment is required.');
  }
  const entries = Object.entries(value);
  if (entries.some(([, entry]) => typeof entry !== 'string')) {
    throw new Error('Coordination launch environment must contain strings.');
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function parseCoordinationTaskRequest(
  value: unknown,
): AgentViewCoordinationTaskRequest {
  if (!isRecord(value)) {
    throw new Error('Coordination task is invalid.');
  }
  const taskFile = value['taskFile'];
  const writeMode = value['writeMode'];
  if (typeof taskFile !== 'string' || !path.isAbsolute(taskFile)) {
    throw new Error('Coordination task file must be absolute.');
  }
  if (writeMode !== 'read-only' && writeMode !== 'isolated-writer') {
    throw new Error('Coordination task write mode is invalid.');
  }
  return { taskFile: path.resolve(taskFile), writeMode };
}

async function readCoordinationTaskInput<T extends { taskFile: string }>(
  task: T,
): Promise<T & { content: Buffer }> {
  let stat;
  try {
    stat = await fs.lstat(task.taskFile);
  } catch {
    throw new Error(`Coordination task file does not exist: ${task.taskFile}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(
      `Coordination task must be a regular file: ${task.taskFile}`,
    );
  }
  if (stat.size > AGENT_VIEW_MAX_TASK_BYTES) {
    throw new Error(
      `Coordination task exceeds ${AGENT_VIEW_MAX_TASK_BYTES} bytes: ${task.taskFile}`,
    );
  }
  const content = await fs.readFile(task.taskFile);
  if (content.byteLength > AGENT_VIEW_MAX_TASK_BYTES) {
    throw new Error(
      `Coordination task exceeds ${AGENT_VIEW_MAX_TASK_BYTES} bytes: ${task.taskFile}`,
    );
  }
  return { ...task, content };
}

async function requireCoordinationDirectory(cwd: string): Promise<string> {
  if (!path.isAbsolute(cwd)) {
    throw new Error('Coordination cwd must be absolute.');
  }
  const resolved = path.resolve(cwd);
  const stat = await fs.stat(resolved).catch(() => undefined);
  if (!stat?.isDirectory()) {
    throw new Error(`Coordination cwd is not a directory: ${cwd}`);
  }
  return fs.realpath(resolved);
}

async function planCoordinationWorktree(
  parentCwd: string,
  worktreesDir: string,
  sessionId: string,
): Promise<ProvisionedCoordinationWorktree> {
  const initialService = new GitWorktreeService(parentCwd);
  const repoRoot = await initialService.getRepoTopLevel();
  if (!repoRoot) {
    throw new Error('An isolated coordination writer requires a Git checkout.');
  }
  const service = new GitWorktreeService(repoRoot, undefined, worktreesDir);
  if (await service.hasWorktreeChanges(repoRoot)) {
    throw new Error(
      'An isolated coordination writer requires a clean parent checkout.',
    );
  }
  const baseCommit = await service.getCurrentCommitHash();
  const slug = generateAgentWorktreeSlug();
  return {
    service,
    sessionId,
    state: {
      mode: 'worktree',
      path: service.getUserWorktreePath(slug),
      slug,
      branch: worktreeBranchForSlug(slug),
      baseCommit,
      owner: 'agent-view',
      dirtySnapshot: 'not-needed',
    },
  };
}

async function provisionCoordinationWorktree(
  planned: ProvisionedCoordinationWorktree,
): Promise<ProvisionedCoordinationWorktree> {
  const { service, state } = planned;
  const created = await service.createUserWorktree(
    state.slug,
    state.baseCommit,
    {
      suppressCheckoutHooks: true,
    },
  );
  if (!created.success || !created.worktree) {
    throw new Error(created.error ?? 'Failed to create coordination worktree.');
  }
  if (
    path.resolve(created.worktree.path) !== path.resolve(state.path) ||
    created.worktree.branch !== state.branch
  ) {
    throw new Error('The coordination writer worktree did not match its plan.');
  }
  await writeWorktreeSessionMarker(state.path, planned.sessionId);
  const [head, dirty] = await Promise.all([
    new GitWorktreeService(state.path).getCurrentCommitHash(),
    service.hasWorktreeChanges(state.path),
  ]);
  if (head !== state.baseCommit || dirty) {
    throw new Error(
      'The coordination writer worktree changed before its worker started.',
    );
  }
  return planned;
}

async function cleanupPristineCoordinationWorktree(
  worktree: ProvisionedCoordinationWorktree,
): Promise<boolean> {
  if (
    worktree.state.owner !== 'agent-view' ||
    !AGENT_WORKTREE_SLUG_PATTERN.test(worktree.state.slug) ||
    worktree.state.branch !== worktreeBranchForSlug(worktree.state.slug) ||
    path.resolve(worktree.state.path) !==
      path.resolve(worktree.service.getUserWorktreePath(worktree.state.slug))
  ) {
    return false;
  }
  if (await worktree.service.isUserWorktreeRemoved(worktree.state.slug)) {
    return true;
  }
  if (
    await worktree.service.removeUnchangedUserWorktreeBranch(
      worktree.state.slug,
      worktree.state.baseCommit,
    )
  ) {
    return true;
  }
  let marker: string | null;
  let registered: { branch: string; headCommit: string } | null;
  try {
    [marker, registered] = await Promise.all([
      readWorktreeSessionMarker(worktree.state.path),
      worktree.service.getRegisteredWorktreeBranch(worktree.state.path),
    ]);
  } catch {
    return false;
  }
  if (
    marker !== worktree.sessionId ||
    !registered ||
    registered.branch !== worktree.state.branch ||
    registered.headCommit !== worktree.state.baseCommit
  ) {
    return false;
  }
  if (await worktree.service.hasWorktreeChanges(worktree.state.path)) {
    return false;
  }
  const removed = await worktree.service.removeUserWorktree(
    worktree.state.slug,
    {
      deleteBranch: false,
      preserveChanges: true,
    },
  );
  if (!removed.success) return false;
  return worktree.service.removeUnchangedUserWorktreeBranch(
    worktree.state.slug,
    worktree.state.baseCommit,
  );
}

async function cleanupStoredCoordinationWorktree(
  state: AgentViewSessionStateFile,
  store: AgentViewStoreOptions,
): Promise<boolean> {
  return cleanupPersistedCoordinationWorktree(
    state.projectCwd,
    state.sessionId,
    state.worktree,
    store,
  );
}

async function cleanupPersistedCoordinationWorktree(
  projectCwd: string,
  sessionId: string,
  worktree: AgentViewWorktreeState,
  store: AgentViewStoreOptions,
): Promise<boolean> {
  if (
    worktree.mode !== 'worktree' ||
    worktree.owner !== 'agent-view' ||
    !worktree.path ||
    !worktree.slug ||
    !worktree.branch ||
    !worktree.baseCommit
  ) {
    return false;
  }
  const worktreesDir = path.resolve(
    getAgentViewStorePaths(store).globalDir,
    'agent-view-worktrees',
  );
  if (path.dirname(path.resolve(worktree.path)) !== worktreesDir) return false;
  const initialService = new GitWorktreeService(projectCwd);
  const repoRoot = await initialService.getRepoTopLevel();
  if (!repoRoot) return false;
  return cleanupPristineCoordinationWorktree({
    service: new GitWorktreeService(repoRoot, undefined, worktreesDir),
    sessionId,
    state: {
      mode: 'worktree',
      path: worktree.path,
      slug: worktree.slug,
      branch: worktree.branch,
      baseCommit: worktree.baseCommit,
      owner: 'agent-view',
      dirtySnapshot: worktree.dirtySnapshot ?? 'not-needed',
    },
  });
}

async function markCoordinationManifestWorktreeCleaned(
  coordinationId: string,
  sessionId: string,
  store: AgentViewStoreOptions,
): Promise<void> {
  const manifest = await readAgentViewCoordinationManifest(
    coordinationId,
    store,
  );
  if (!manifest) return;
  const attempts = manifest.attempts.map((attempt) =>
    attempt.sessionId === sessionId && attempt.worktree?.mode === 'worktree'
      ? {
          ...attempt,
          worktree: { mode: 'none' as const },
          worktreePhase: undefined,
        }
      : attempt,
  );
  if (
    attempts.every((attempt, index) => attempt === manifest.attempts[index])
  ) {
    return;
  }
  await writeAgentViewCoordinationManifest(
    {
      ...manifest,
      updatedAt: new Date().toISOString(),
      attempts,
    },
    store,
  );
}

async function markCoordinationManifestWorktreePhase(
  coordinationId: string,
  sessionId: string,
  worktreePhase: 'launching' | 'launched',
  store: AgentViewStoreOptions,
): Promise<void> {
  const manifest = await readAgentViewCoordinationManifest(
    coordinationId,
    store,
  );
  if (!manifest) {
    throw new Error(
      `Coordination ${coordinationId} lost its ownership manifest before writer launch.`,
    );
  }
  let matched = false;
  const attempts = manifest.attempts.map((attempt) => {
    if (
      attempt.sessionId !== sessionId ||
      attempt.worktree?.mode !== 'worktree'
    ) {
      return attempt;
    }
    matched = true;
    return { ...attempt, worktreePhase };
  });
  if (!matched) {
    throw new Error(
      `Coordination writer ${sessionId} lost its ownership receipt before launch.`,
    );
  }
  await writeAgentViewCoordinationManifest(
    {
      ...manifest,
      updatedAt: new Date().toISOString(),
      attempts,
    },
    store,
  );
}

async function validateCoordinationArtifacts(
  artifacts: string[],
  activeCwd: string,
): Promise<string[]> {
  if (artifacts.length > MAX_COORDINATION_ARTIFACTS) {
    throw new Error(
      `Coordination result contains more than ${MAX_COORDINATION_ARTIFACTS} artifacts.`,
    );
  }
  const root = await fs.realpath(activeCwd);
  const canonicalArtifacts: string[] = [];
  for (const artifact of artifacts) {
    if (
      artifact.length === 0 ||
      !path.isAbsolute(artifact) ||
      Buffer.byteLength(artifact, 'utf8') > MAX_COORDINATION_ARTIFACT_PATH_BYTES
    ) {
      throw new Error('Coordination artifact path is invalid.');
    }
    const candidate = path.resolve(root, artifact);
    let realArtifact: string;
    try {
      realArtifact = await fs.realpath(candidate);
    } catch {
      throw new Error(`Coordination artifact does not exist: ${artifact}`);
    }
    if (!isPathWithin(root, realArtifact)) {
      throw new Error(
        `Coordination artifact resolves outside the worker cwd: ${artifact}`,
      );
    }
    if (!(await isAgentViewSnapshottedPath(root, realArtifact))) {
      throw new Error(
        `Coordination artifact is ignored or Git metadata: ${artifact}`,
      );
    }
    if (!(await fs.stat(realArtifact)).isFile()) {
      throw new Error(`Coordination artifact is not a file: ${artifact}`);
    }
    canonicalArtifacts.push(realArtifact);
  }
  return canonicalArtifacts;
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function requireFullUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error(`${label} must be a full UUID.`);
  }
  return value;
}

function isLiveCoordinationState(state: AgentViewSessionStateFile): boolean {
  return (
    state.ownership === 'managed' &&
    Boolean(state.coordination) &&
    isAliveProcessState(state.processState)
  );
}

function isTerminalCoordinationState(
  state: AgentViewSessionStateFile,
  result: AgentViewCoordinationResult | undefined,
): boolean {
  return (
    Boolean(result) ||
    state.sessionState === 'completed' ||
    state.sessionState === 'failed' ||
    state.sessionState === 'stopped'
  );
}

function canReassignCoordinationRecord(
  record: Awaited<ReturnType<typeof listAgentViewCoordinationRecords>>[number],
): boolean {
  if (isAliveProcessState(record.snapshot.state.processState)) return false;
  if (record.snapshot.activity?.staleReason === 'checkout_changed') return true;
  if (
    record.result?.outcome === 'failed' ||
    record.result?.outcome === 'handback'
  ) {
    return true;
  }
  return (
    !record.result &&
    (record.snapshot.state.sessionState === 'failed' ||
      record.snapshot.state.sessionState === 'stopped')
  );
}

function aggregateCoordinationState(
  sessions: AgentViewCoordinationSessionSnapshot[],
): AgentViewCoordinationSnapshot['state'] {
  const latestByTask = new Map<string, AgentViewCoordinationSessionSnapshot>();
  for (const session of sessions) {
    latestByTask.set(session.lineage.taskId, session);
  }
  const latest = [...latestByTask.values()];
  if (latest.some((session) => session.staleReason === 'checkout_changed')) {
    return 'stale';
  }
  if (
    latest.some(
      (session) =>
        !session.result &&
        (session.state === 'starting' ||
          session.state === 'working' ||
          session.state === 'needs_input' ||
          session.state === 'idle'),
    )
  ) {
    return 'running';
  }
  const completed = latest.filter(
    (session) => session.result?.outcome === 'completed',
  ).length;
  if (completed === latest.length) return 'completed';
  if (completed > 0) return 'partial';
  return 'failed';
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
  const eventIdentity = {
    generation: positiveIntegerParam(params, 'generation'),
    sequence: positiveIntegerParam(params, 'sequence'),
  };
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
      ...eventIdentity,
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
      ...eventIdentity,
      ...(at !== undefined ? { at } : {}),
    };
  }
  if (type === 'detach') {
    const at = stringParam(params, 'at');
    return {
      type,
      sessionId,
      ...eventIdentity,
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
    const callId = stringParam(params, 'callId');
    const inputType = inputTypeParam(params);
    const inputSummary = stringParam(params, 'inputSummary');
    const lastResult = stringParam(params, 'lastResult');
    const promptId = stringParam(params, 'promptId');
    if (
      sessionState === 'needs_input' &&
      (!promptId || !callId || !inputType || !inputSummary)
    ) {
      throw new Error(
        'Agent View needs_input requires promptId, callId, inputType, and inputSummary.',
      );
    }
    const at = stringParam(params, 'at');
    return {
      type,
      sessionId,
      ...eventIdentity,
      sessionState,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(waitingFor !== undefined ? { waitingFor } : {}),
      ...(inputKind !== undefined ? { inputKind } : {}),
      ...(callId !== undefined ? { callId } : {}),
      ...(inputType !== undefined ? { inputType } : {}),
      ...(inputSummary !== undefined ? { inputSummary } : {}),
      ...(lastResult !== undefined ? { lastResult } : {}),
      ...(promptId !== undefined ? { promptId } : {}),
      ...(at !== undefined ? { at } : {}),
    };
  }
  if (type === 'result') {
    const promptId = stringParam(params, 'promptId', { required: true });
    const attemptId = stringParam(params, 'attemptId', { required: true });
    const summary = stringParam(params, 'summary', { required: true });
    const outcome = params['outcome'];
    const rawArtifacts = params['artifacts'];
    if (
      !promptId ||
      !attemptId ||
      !summary ||
      (outcome !== 'completed' &&
        outcome !== 'failed' &&
        outcome !== 'handback') ||
      (rawArtifacts !== undefined &&
        (!Array.isArray(rawArtifacts) ||
          rawArtifacts.some((artifact) => typeof artifact !== 'string')))
    ) {
      throw new Error('Agent View worker result is invalid.');
    }
    const at = stringParam(params, 'at');
    return {
      type,
      sessionId,
      ...eventIdentity,
      promptId,
      attemptId,
      outcome,
      summary,
      artifacts: stringArrayParam(params, 'artifacts'),
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

function inputTypeParam(
  params: Record<string, unknown>,
): 'tool_confirmation' | 'ask_user_question' | undefined {
  const value = params['inputType'];
  return value === 'tool_confirmation' || value === 'ask_user_question'
    ? value
    : undefined;
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
  generation: number,
  store: { globalDir?: string },
): Promise<AgentViewLaunchFile> {
  const resumeLaunch = refreshResumeWorkerLaunch(launch);
  return writeWorkerGenerationLaunch(resumeLaunch, generation, store);
}

async function writeWorkerGenerationLaunch(
  launch: AgentViewLaunchFile,
  generation: number,
  store: { globalDir?: string },
): Promise<AgentViewLaunchFile> {
  const generationLaunch = {
    ...launch,
    env: {
      ...launch.env,
      [QWEN_AGENT_VIEW_GENERATION]: String(generation),
    },
  };
  await writeAgentViewLaunch(generationLaunch, store);
  return generationLaunch;
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

function currentWorkerGeneration(
  worker: AgentViewWorkerFile | undefined,
): number {
  const generation = worker?.['generation'];
  return Number.isInteger(generation) && Number(generation) >= 0
    ? Number(generation)
    : 0;
}

async function nextWorkerGeneration(
  sessionId: string,
  options: { globalDir?: string },
): Promise<number> {
  return (
    currentWorkerGeneration(await readAgentViewWorker(sessionId, options)) + 1
  );
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

export async function authorizeAgentViewWorkerSideband(
  params: Record<string, unknown> | undefined,
  options: { globalDir?: string } = {},
): Promise<boolean> {
  const sessionId = params?.['sessionId'];
  const token = params?.['token'];
  if (
    typeof sessionId !== 'string' ||
    !sessionId ||
    typeof token !== 'string' ||
    !token
  ) {
    return false;
  }
  try {
    const worker = await readAgentViewWorker(sessionId, options);
    return Boolean(
      worker?.tokenDigest && tokenDigestMatches(token, worker.tokenDigest),
    );
  } catch {
    return false;
  }
}

async function requireMatchingWorkerGeneration(
  sessionId: string,
  params: Record<string, unknown> | undefined,
  options: { globalDir?: string },
): Promise<void> {
  const generation = params?.['generation'];
  const expected = currentWorkerGeneration(
    await readAgentViewWorker(sessionId, options),
  );
  if (
    !Number.isSafeInteger(generation) ||
    Number(generation) < 1 ||
    Number(generation) !== expected
  ) {
    throw new Error(
      `Agent View worker generation ${String(generation)} is not current for ${sessionId}.`,
    );
  }
}

async function requireCurrentWorkerEvent(
  event: AgentViewWorkerEvent,
  options: { globalDir?: string },
): Promise<void> {
  const worker = await readAgentViewWorker(event.sessionId, options);
  const expectedGeneration = currentWorkerGeneration(worker);
  if (event.generation !== expectedGeneration) {
    throw new Error(
      `Agent View worker generation ${event.generation} is not current for ${event.sessionId}.`,
    );
  }
  const lastSequence = worker?.lastEventSequence ?? 0;
  if (event.sequence <= lastSequence) {
    throw new Error(
      `Agent View worker event sequence ${event.sequence} is not newer than ${lastSequence} for ${event.sessionId}.`,
    );
  }
}

async function recordWorkerEventSequence(
  event: AgentViewWorkerEvent,
  options: { globalDir?: string },
): Promise<void> {
  await writeAgentViewWorker(
    event.sessionId,
    {
      schemaVersion: 1,
      generation: event.generation,
      lastEventSequence: event.sequence,
      protocolVersion: AGENT_VIEW_PROTOCOL_VERSION,
      platform: process.platform,
      recentOutputBytes: 0,
    },
    options,
  );
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
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}
