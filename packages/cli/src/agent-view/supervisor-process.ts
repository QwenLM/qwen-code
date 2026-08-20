/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { Socket } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  AgentViewSessionSnapshot,
  AgentViewSessionStateFile,
} from './protocol.js';
import type { AgentViewSupervisorHandler } from './supervisor-server.js';
import {
  getAgentViewStorePaths,
  listAgentViewSessionSnapshots,
  listAgentViewSessionStates,
} from './supervisor-store.js';

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
): AgentViewSupervisorHandler & AgentViewSupervisorMaintenance {
  return new AgentViewSupervisorProcessHandler(options);
}

class AgentViewSupervisorProcessHandler
  implements AgentViewSupervisorHandler, AgentViewSupervisorMaintenance
{
  private readonly socketPath: string;
  private readonly startedAt = new Date().toISOString();
  private readonly subscribers = new Set<Socket>();
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

  async list(): Promise<AgentViewSessionSnapshot[]> {
    return listAgentViewSessionSnapshots(this.store);
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

  shutdown(): { shuttingDown: true; workersStopped: 0 } {
    void Promise.resolve(this.options.onShutdown?.()).catch(() => {});
    return { shuttingDown: true, workersStopped: 0 };
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
}

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}
