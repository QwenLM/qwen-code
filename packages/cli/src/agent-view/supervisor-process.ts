/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createHash,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type { Socket } from 'node:net';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  AgentViewDispatchParams,
  AgentViewDispatchResult,
  AgentViewSessionSnapshot,
  AgentViewSessionStateFile,
  AgentViewWorkerControlEvent,
  AgentViewWorkerControlRequest,
  AgentViewWorkerControlResult,
  AgentViewWorkerEvent,
  AgentViewWorkerViewSnapshot,
} from './protocol.js';
import { AGENT_VIEW_PROTOCOL_VERSION } from './protocol.js';
import type {
  AgentViewSidebandAuthorizer,
  AgentViewSupervisorHandler,
} from './supervisor-server.js';
import {
  getAgentViewStorePaths,
  getAgentViewSessionPaths,
  listAgentViewSessionSnapshots,
  listAgentViewSessionStates,
  readAgentViewActivity,
  readAgentViewSessionState,
  readAgentViewWorker,
  removeAgentViewRosterEntry,
  upsertAgentViewRosterEntry,
  writeAgentViewActivity,
  writeAgentViewSessionState,
  writeAgentViewWorker,
} from './supervisor-store.js';
import type { AgentViewSupervisorRequestMap } from './supervisor-client.js';

const UNIX_SOCKET_PATH_LIMIT = 100;
const DEFAULT_SUPERVISOR_AUTO_EXIT_GRACE_MS = 10 * 60 * 1000;

export interface AgentViewSupervisorHibernationPolicy {
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

export interface AgentViewSupervisorMaintenance {
  hibernateIdleSessions(): Promise<AgentViewSupervisorHibernationResult>;
  tickIdleHibernation(): Promise<AgentViewSupervisorMaintenanceResult>;
}

export interface AgentViewSupervisorPathOptions {
  globalDir?: string;
  platform?: NodeJS.Platform;
  runtimeDir?: string;
}

export interface AgentViewSupervisorProcessOptions
  extends AgentViewSupervisorPathOptions {
  hibernationPolicy?: AgentViewSupervisorHibernationPolicy;
  now?: () => Date;
  onShutdown?: () => void | Promise<void>;
  spawnWorker?: AgentViewWorkerSpawner;
}

export interface AgentViewWorkerLaunch {
  params: AgentViewDispatchParams;
  workerToken: string;
}

export interface AgentViewWorkerHandle {
  pid?: number;
  stop?(): Promise<void> | void;
  kill?(): Promise<void> | void;
  onExit?(listener: (code: number | null) => void): (() => void) | void;
}

export type AgentViewWorkerSpawner = (
  launch: AgentViewWorkerLaunch,
) => Promise<AgentViewWorkerHandle>;

export interface AgentViewSupervisorProcess
  extends AgentViewSupervisorHandler,
    AgentViewSupervisorMaintenance {
  authorizeSideband: AgentViewSidebandAuthorizer;
  disposeWorkers(): Promise<number>;
}

type AgentViewStoreOptions = { globalDir?: string };

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
  return path.join(
    options.runtimeDir ?? os.tmpdir(),
    fallbackDir,
    `supervisor-${digest}.sock`,
  );
}

export function createAgentViewSupervisorHandler(
  options: AgentViewSupervisorProcessOptions = {},
): AgentViewSupervisorProcess {
  return new AgentViewSupervisorProcessHandler(options);
}

class AgentViewSupervisorProcessHandler
  implements AgentViewSupervisorProcess
{
  private readonly socketPath: string;
  private readonly startedAt = new Date().toISOString();
  private readonly subscribers = new Set<Socket>();
  private readonly workers = new Map<string, AgentViewWorkerHandle>();
  private readonly workerExitCleanups = new Map<string, () => void>();
  private readonly controls = new Map<
    string,
    { nextSequence: number; events: AgentViewWorkerControlEvent[] }
  >();
  private readonly viewSnapshots = new Map<
    string,
    AgentViewWorkerViewSnapshot
  >();
  private autoExitEligibleSinceMs?: number;

  constructor(private readonly options: AgentViewSupervisorProcessOptions) {
    this.socketPath = getAgentViewSupervisorSocketPath(options);
  }

  async status(): Promise<{
    state: 'ready';
    socketPath: string;
    startedAt: string;
    sessions: number;
  }> {
    const sessions = await listAgentViewSessionStates(this.store);
    return {
      state: 'ready',
      socketPath: this.socketPath,
      startedAt: this.startedAt,
      sessions: sessions.length,
    };
  }

  async list(params?: { cwd?: string }): Promise<AgentViewSessionSnapshot[]> {
    const snapshots = await listAgentViewSessionSnapshots(this.store);
    const withViews = snapshots.map((snapshot) => {
      const viewSnapshot = this.viewSnapshots.get(snapshot.sessionId);
      return {
        ...snapshot,
        ...(viewSnapshot ? { viewSnapshot } : {}),
      };
    });
    if (!params?.cwd) return withViews;
    const cwd = path.resolve(params.cwd);
    return withViews.filter(
      ({ state }) =>
        state.projectCwd === cwd || state.activeCwd === cwd,
    );
  }

  subscribe(_params: undefined, socket: Socket, requestId: string): void {
    this.subscribers.add(socket);
    socket.once('close', () => this.subscribers.delete(socket));
    socket.write(
      `${JSON.stringify({
        id: requestId,
        ok: true,
        result: { subscribed: true },
      })}\n`,
    );
  }

  async dispatch(
    raw: AgentViewDispatchParams,
  ): Promise<AgentViewDispatchResult> {
    if (!this.options.spawnWorker) {
      throw new Error('Agent View worker spawning is not configured.');
    }
    const params = normalizeDispatchParams(raw);
    const existing = await readAgentViewSessionState(
      params.sessionId,
      this.store,
    );
    if (existing && existing.processState !== 'exited') {
      throw new Error(`Agent View session "${params.sessionId}" is active.`);
    }

    const now = this.now();
    const workerToken = randomUUID();
    await writeAgentViewSessionState(
      {
        schemaVersion: 1,
        sessionId: params.sessionId,
        ownership: 'managed',
        sessionState: 'starting',
        processState: 'starting',
        attachState: 'detached',
        projectCwd: params.projectCwd,
        originalCwd: params.projectCwd,
        activeCwd: params.activeCwd,
        createdAt: now,
        updatedAt: now,
        worktree: { mode: 'none' },
      },
      this.store,
    );
    await writeAgentViewActivity(
      params.sessionId,
      {
        schemaVersion: 1,
        lastActivityAt: now,
        capabilities: [],
      },
      this.store,
    );
    await writeAgentViewWorker(
      params.sessionId,
      {
        schemaVersion: 1,
        hostPid: process.pid,
        tokenDigest: digestToken(workerToken),
        protocolVersion: AGENT_VIEW_PROTOCOL_VERSION,
        platform: process.platform,
        recentOutputBytes: 0,
      },
      this.store,
    );
    await upsertAgentViewRosterEntry(
      {
        sessionId: params.sessionId,
        projectCwd: params.projectCwd,
        activeCwd: params.activeCwd,
        displayName: params.displayName,
        createdAt: now,
        updatedAt: now,
      },
      this.store,
    );

    try {
      const handle = await this.options.spawnWorker({ params, workerToken });
      this.workers.set(params.sessionId, handle);
      let dispatchComplete = false;
      let earlyExit = false;
      let earlyExitCode: number | null = null;
      const cleanup = handle.onExit?.((code) => {
        if (!dispatchComplete) {
          earlyExit = true;
          earlyExitCode = code;
          return;
        }
        void this.recordWorkerExit(params.sessionId, code).catch(() => {});
      });
      if (cleanup) this.workerExitCleanups.set(params.sessionId, cleanup);
      if (handle.pid !== undefined) {
        const worker = await readAgentViewWorker(params.sessionId, this.store);
        if (worker) {
          await writeAgentViewWorker(
            params.sessionId,
            { ...worker, workerPid: handle.pid },
            this.store,
          );
        }
      }
      dispatchComplete = true;
      if (earlyExit) {
        await this.recordWorkerExit(params.sessionId, earlyExitCode);
      }
    } catch (error) {
      await this.failSession(params.sessionId, error);
      await removeAgentViewRosterEntry(params.sessionId, this.store);
      await this.forgetWorker(params.sessionId);
      throw error;
    }

    this.notifyChanged(params.sessionId);
    return { sessionId: params.sessionId };
  }

  async workerEvent(
    raw: AgentViewSupervisorRequestMap['workerEvent'],
  ): Promise<{ accepted: true }> {
    const { token: _token, ...payload } = raw;
    const event = normalizeWorkerEvent(payload as AgentViewWorkerEvent);
    const state = await this.requireSession(event.sessionId);
    const at = event.at ?? this.now();
    const activity = await readAgentViewActivity(event.sessionId, this.store);
    const worker = await readAgentViewWorker(event.sessionId, this.store);

    if (event.type === 'ready') {
      await writeAgentViewSessionState(
        {
          ...state,
          sessionState:
            state.sessionState === 'starting' ? 'idle' : state.sessionState,
          processState: 'alive',
          activeCwd: path.resolve(event.cwd),
          updatedAt: at,
        },
        this.store,
      );
      await writeAgentViewActivity(
        event.sessionId,
        {
          ...activity,
          schemaVersion: 1,
          summary: event.summary,
          lastActivityAt: at,
          capabilities: event.capabilities ?? activity?.capabilities ?? [],
        },
        this.store,
      );
    } else if (event.type === 'state') {
      await writeAgentViewSessionState(
        {
          ...state,
          sessionState: event.sessionState,
          processState: isTerminalSessionState(event.sessionState)
            ? 'exited'
            : 'alive',
          activeCwd: event.cwd ? path.resolve(event.cwd) : state.activeCwd,
          updatedAt: at,
        },
        this.store,
      );
      await writeAgentViewActivity(
        event.sessionId,
        {
          ...activity,
          schemaVersion: 1,
          summary: event.summary,
          waitingFor: event.waitingFor,
          lastResult: event.lastResult,
          lastActivityAt: at,
          capabilities: activity?.capabilities ?? [],
        },
        this.store,
      );
    } else if (event.type === 'detach') {
      await writeAgentViewSessionState(
        { ...state, attachState: 'detached', updatedAt: at },
        this.store,
      );
    } else if (event.type === 'viewSnapshot') {
      this.viewSnapshots.set(event.sessionId, event.snapshot);
      await writeAgentViewActivity(
        event.sessionId,
        {
          ...activity,
          schemaVersion: 1,
          lastActivityAt: at,
          capabilities: activity?.capabilities ?? [],
        },
        this.store,
      );
    } else if (event.type === 'sessionEvent') {
      if (event.event === 'status') {
        const sessionState = sessionStateFromAgentStatus(event.payload.next);
        await writeAgentViewSessionState(
          {
            ...state,
            sessionState,
            processState: isTerminalSessionState(sessionState)
              ? 'exited'
              : 'alive',
            updatedAt: at,
          },
          this.store,
        );
      }
      await writeAgentViewActivity(
        event.sessionId,
        {
          ...activity,
          schemaVersion: 1,
          lastActivityAt: at,
          capabilities: activity?.capabilities ?? [],
        },
        this.store,
      );
    }

    if (worker) {
      await writeAgentViewWorker(
        event.sessionId,
        { ...worker, lastHeartbeatAt: at },
        this.store,
      );
    }
    this.notifyChanged(event.sessionId, event);
    return { accepted: true };
  }

  workerControl(
    raw: AgentViewWorkerControlRequest,
  ): AgentViewWorkerControlResult {
    const sessionId = normalizeSessionId(raw.sessionId);
    const queue = this.getControlQueue(sessionId);
    const acknowledged = nonNegativeInteger(raw.acknowledgeThrough, 0);
    if (acknowledged > 0) {
      queue.events = queue.events.filter(
        (event) => event.sequence > acknowledged,
      );
    }
    const afterSequence = nonNegativeInteger(raw.afterSequence, 0);
    return {
      sessionId,
      events: queue.events.filter(
        (event) => event.sequence > afterSequence,
      ),
      nextSequence: queue.nextSequence - 1,
    };
  }

  async send(
    params: AgentViewSupervisorRequestMap['send'],
  ): Promise<{ queued: true; sequence: number }> {
    await this.requireSession(params.sessionId);
    if (typeof params.text !== 'string' || params.text.trim().length === 0) {
      throw new Error('Agent View prompt must not be empty.');
    }
    if (typeof params.turnId !== 'string' || params.turnId.length === 0) {
      throw new Error('Agent View prompt turnId is required.');
    }
    return {
      queued: true,
      sequence: this.enqueueControl(params.sessionId, {
        type: 'prompt',
        turnId: params.turnId,
        text: params.text,
      }),
    };
  }

  async cancel(
    params: AgentViewSupervisorRequestMap['cancel'],
  ): Promise<{ queued: true; sequence: number }> {
    await this.requireSession(params.sessionId);
    return {
      queued: true,
      sequence: this.enqueueControl(params.sessionId, { type: 'cancel' }),
    };
  }

  async answer(
    params: AgentViewSupervisorRequestMap['answer'],
  ): Promise<{ queued: true; sequence: number }> {
    await this.requireSession(params.sessionId);
    if (!params.callId) throw new Error('Agent View answer callId is required.');
    if (!isAnswerOutcome(params.outcome)) {
      throw new Error('Invalid Agent View answer outcome.');
    }
    return {
      queued: true,
      sequence: this.enqueueControl(params.sessionId, {
        type: 'answer',
        callId: params.callId,
        outcome: params.outcome,
        payload: params.payload,
      }),
    };
  }

  async stop(
    params: AgentViewSupervisorRequestMap['stop'],
  ): Promise<{ queued: true; sequence: number }> {
    const state = await this.requireSession(params.sessionId);
    const sequence = this.enqueueControl(params.sessionId, { type: 'stop' });
    await writeAgentViewSessionState(
      { ...state, sessionState: 'stopped', updatedAt: this.now() },
      this.store,
    );
    this.notifyChanged(params.sessionId);
    return { queued: true, sequence };
  }

  async kill(
    params: AgentViewSupervisorRequestMap['kill'],
  ): Promise<{ killed: true }> {
    await this.requireSession(params.sessionId);
    await this.workers.get(params.sessionId)?.kill?.();
    await this.markSessionExited(params.sessionId, 'stopped');
    await this.forgetWorker(params.sessionId);
    return { killed: true };
  }

  async remove(
    params: AgentViewSupervisorRequestMap['remove'],
  ): Promise<{ removed: true }> {
    const state = await this.requireSession(params.sessionId);
    if (state.processState !== 'exited') {
      throw new Error('Only exited Agent View sessions can be removed.');
    }
    await this.forgetWorker(params.sessionId);
    await removeAgentViewRosterEntry(params.sessionId, this.store);
    await fs.rm(
      getAgentViewSessionPaths(params.sessionId, this.store).sessionDir,
      { recursive: true, force: true },
    );
    this.notifyChanged(params.sessionId);
    return { removed: true };
  }

  authorizeSideband: AgentViewSidebandAuthorizer = async (_op, params) => {
    if (!params) return false;
    const sessionId = stringValue(params['sessionId']);
    const token = stringValue(params['token']);
    if (!sessionId || !token) return false;
    const worker = await readAgentViewWorker(sessionId, this.store);
    return Boolean(
      worker?.tokenDigest && tokenMatchesDigest(token, worker.tokenDigest),
    );
  };

  async shutdown(
    params?: AgentViewSupervisorRequestMap['shutdown'],
  ): Promise<{ shuttingDown: true; workersStopped: number }> {
    const workersStopped = params?.keepWorkers
      ? 0
      : await this.disposeWorkers();
    void Promise.resolve(this.options.onShutdown?.()).catch(() => {});
    return { shuttingDown: true, workersStopped };
  }

  async disposeWorkers(): Promise<number> {
    const workers = [...this.workers.entries()];
    await Promise.allSettled(
      workers.map(async ([sessionId, handle]) => {
        await handle.stop?.();
        await this.markSessionExited(sessionId, 'stopped');
      }),
    );
    await Promise.all(
      workers.map(([sessionId]) => this.forgetWorker(sessionId)),
    );
    return workers.length;
  }

  async hibernateIdleSessions(): Promise<AgentViewSupervisorHibernationResult> {
    return { hibernated: [] };
  }

  async tickIdleHibernation(): Promise<AgentViewSupervisorMaintenanceResult> {
    const states = await listAgentViewSessionStates(this.store);
    if (this.shouldAutoExit(states)) {
      void Promise.resolve(this.options.onShutdown?.()).catch(() => {});
      return { hibernated: [], shutdownRequested: true };
    }

    return { hibernated: [], shutdownRequested: false };
  }

  private shouldAutoExit(states: AgentViewSessionStateFile[]): boolean {
    const policy = this.options.hibernationPolicy;
    if (policy?.autoExit === false || states.length === 0) {
      this.autoExitEligibleSinceMs = undefined;
      return false;
    }

    const onlyInactiveManagedSessions = states.every(
      (state) =>
        state.ownership === 'managed' &&
        (state.processState === 'hibernated' ||
          state.processState === 'exited'),
    );
    if (!onlyInactiveManagedSessions) {
      this.autoExitEligibleSinceMs = undefined;
      return false;
    }

    const nowMs = (this.options.now?.() ?? new Date()).getTime();
    this.autoExitEligibleSinceMs ??= nowMs;
    return (
      nowMs - this.autoExitEligibleSinceMs >=
      (policy?.autoExitGraceMs ?? DEFAULT_SUPERVISOR_AUTO_EXIT_GRACE_MS)
    );
  }

  private get store(): AgentViewStoreOptions {
    return {
      ...(this.options.globalDir ? { globalDir: this.options.globalDir } : {}),
    };
  }

  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private getControlQueue(sessionId: string): {
    nextSequence: number;
    events: AgentViewWorkerControlEvent[];
  } {
    const key = normalizeSessionId(sessionId);
    let queue = this.controls.get(key);
    if (!queue) {
      queue = { nextSequence: 1, events: [] };
      this.controls.set(key, queue);
    }
    return queue;
  }

  private enqueueControl(
    sessionId: string,
    event:
      | { type: 'prompt'; turnId: string; text: string }
      | { type: 'cancel' }
      | { type: 'stop' }
      | {
          type: 'answer';
          callId: string;
          outcome: AgentViewSupervisorRequestMap['answer']['outcome'];
          payload?: AgentViewSupervisorRequestMap['answer']['payload'];
        },
  ): number {
    const queue = this.getControlQueue(sessionId);
    const sequence = queue.nextSequence++;
    queue.events.push({ ...event, sequence, at: this.now() });
    this.notifyChanged(sessionId);
    return sequence;
  }

  private async requireSession(
    sessionId: string,
  ): Promise<AgentViewSessionStateFile> {
    const key = normalizeSessionId(sessionId);
    const state = await readAgentViewSessionState(key, this.store);
    if (!state) throw new Error(`Agent View session "${key}" was not found.`);
    return state;
  }

  private async recordWorkerExit(
    sessionId: string,
    code: number | null,
  ): Promise<void> {
    const state = await readAgentViewSessionState(sessionId, this.store);
    const sessionState =
      state?.sessionState === 'stopped'
        ? 'stopped'
        : code === 0
          ? 'completed'
          : 'failed';
    await this.markSessionExited(sessionId, sessionState);
    this.notifyChanged(sessionId, {
      type: 'state',
      sessionId,
      sessionState,
      ...(state?.activeCwd ? { cwd: state.activeCwd } : {}),
    });
    await this.forgetWorker(sessionId);
  }

  private async markSessionExited(
    sessionId: string,
    sessionState: 'completed' | 'stopped' | 'failed',
  ): Promise<void> {
    const state = await readAgentViewSessionState(sessionId, this.store);
    if (!state) return;
    await writeAgentViewSessionState(
      {
        ...state,
        sessionState,
        processState: 'exited',
        updatedAt: this.now(),
      },
      this.store,
    );
    this.notifyChanged(sessionId);
  }

  private async failSession(sessionId: string, error: unknown): Promise<void> {
    const state = await readAgentViewSessionState(sessionId, this.store);
    if (!state) return;
    const now = this.now();
    await writeAgentViewSessionState(
      {
        ...state,
        sessionState: 'failed',
        processState: 'exited',
        updatedAt: now,
        lastError: {
          code: 'worker_spawn_failed',
          message: error instanceof Error ? error.message : String(error),
          at: now,
        },
      },
      this.store,
    );
    this.notifyChanged(sessionId);
  }

  private async forgetWorker(sessionId: string): Promise<void> {
    this.workerExitCleanups.get(sessionId)?.();
    this.workerExitCleanups.delete(sessionId);
    this.workers.delete(sessionId);
    this.controls.delete(sessionId);
    this.viewSnapshots.delete(sessionId);
    const worker = await readAgentViewWorker(sessionId, this.store);
    if (worker?.tokenDigest) {
      await writeAgentViewWorker(
        sessionId,
        { ...worker, tokenDigest: '' },
        this.store,
      );
    }
  }

  private notifyChanged(
    sessionId?: string,
    workerEvent?: AgentViewWorkerEvent,
  ): void {
    const payload = `${JSON.stringify({
      type: 'changed',
      at: this.now(),
      ...(sessionId ? { sessionId } : {}),
      ...(workerEvent ? { workerEvent } : {}),
    })}\n`;
    for (const socket of this.subscribers) {
      try {
        socket.write(payload);
      } catch {
        this.subscribers.delete(socket);
        socket.destroy();
      }
    }
  }
}

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

function digestToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function tokenMatchesDigest(token: string, digest: string): boolean {
  const actual = Buffer.from(digestToken(token), 'hex');
  const expected = Buffer.from(digest, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function normalizeSessionId(value: string): string {
  if (
    typeof value !== 'string' ||
    !/^[a-z0-9][a-z0-9@._-]{0,127}$/.test(value)
  ) {
    throw new Error('Invalid Agent View sessionId.');
  }
  return value;
}

function normalizeDispatchParams(
  params: AgentViewDispatchParams,
): AgentViewDispatchParams {
  const sessionId = normalizeSessionId(params.sessionId);
  if (!path.isAbsolute(params.specPath)) {
    throw new Error('Agent View specPath must be absolute.');
  }
  if (!path.isAbsolute(params.projectCwd) || !path.isAbsolute(params.activeCwd)) {
    throw new Error('Agent View working directories must be absolute.');
  }
  return {
    sessionId,
    specPath: path.resolve(params.specPath),
    projectCwd: path.resolve(params.projectCwd),
    activeCwd: path.resolve(params.activeCwd),
    ...(params.displayName ? { displayName: params.displayName } : {}),
  };
}

function normalizeWorkerEvent(event: AgentViewWorkerEvent): AgentViewWorkerEvent {
  normalizeSessionId(event.sessionId);
  return event;
}

function isTerminalSessionState(
  state: AgentViewSessionStateFile['sessionState'],
): boolean {
  return state === 'completed' || state === 'stopped' || state === 'failed';
}

function sessionStateFromAgentStatus(
  status: string,
): AgentViewSessionStateFile['sessionState'] {
  switch (status) {
    case 'initializing':
      return 'starting';
    case 'running':
      return 'working';
    case 'idle':
      return 'idle';
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'stopped';
    default:
      return 'failed';
  }
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! >= 0 ? value! : fallback;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isAnswerOutcome(
  value: unknown,
): value is AgentViewSupervisorRequestMap['answer']['outcome'] {
  return (
    value === 'proceed_once' ||
    value === 'proceed_once_and_switch_to_default' ||
    value === 'proceed_always' ||
    value === 'proceed_always_server' ||
    value === 'proceed_always_tool' ||
    value === 'proceed_always_project' ||
    value === 'proceed_always_user' ||
    value === 'modify_with_editor' ||
    value === 'restore_previous' ||
    value === 'cancel'
  );
}
