/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createDebugLogger } from '@qwen-code/qwen-code-core';

import type { WorkspaceRuntime } from '../workspace-registry.js';

export const MAX_CONCURRENT_VOICE_SESSIONS = 8;
const DISPOSE_WAIT_MS = 5_000;
const debugLogger = createDebugLogger('WORKSPACE_VOICE_COORDINATOR');

export interface VoiceAdmissionLease {
  readonly signal: AbortSignal;
  release(): void;
}

export type VoiceAdmissionResult =
  | { readonly kind: 'admitted'; readonly lease: VoiceAdmissionLease }
  | { readonly kind: 'rejected'; readonly reason: 'draining' | 'capacity' };

interface RuntimeVoiceState {
  draining: boolean;
  completed: boolean;
  leases: Set<Lease>;
  idleWaiters: Set<() => void>;
}

class Lease implements VoiceAdmissionLease {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private released = false;

  constructor(private readonly onRelease: (lease: Lease) => void) {}

  release(): void {
    if (this.released) return;
    this.released = true;
    this.onRelease(this);
  }

  abort(reason: Error): void {
    if (!this.signal.aborted) this.controller.abort(reason);
  }
}

export class WorkspaceVoiceCoordinator {
  private readonly states = new Map<WorkspaceRuntime, RuntimeVoiceState>();
  private readonly disposed = new WeakSet<WorkspaceRuntime>();
  private active = 0;

  acquire(runtime: WorkspaceRuntime): VoiceAdmissionResult {
    if (this.disposed.has(runtime)) {
      return { kind: 'rejected', reason: 'draining' };
    }
    const state = this.stateFor(runtime);
    if (state.draining) return { kind: 'rejected', reason: 'draining' };
    if (this.active >= MAX_CONCURRENT_VOICE_SESSIONS) {
      return { kind: 'rejected', reason: 'capacity' };
    }

    const lease = new Lease((current) => this.release(runtime, current));
    state.leases.add(lease);
    this.active++;
    return { kind: 'admitted', lease };
  }

  beginWorkspaceDrain(runtime: WorkspaceRuntime): void {
    this.stateFor(runtime).draining = true;
  }

  cancelWorkspaceDrain(runtime: WorkspaceRuntime): void {
    const state = this.states.get(runtime);
    if (state && !state.completed) state.draining = false;
  }

  completeWorkspaceDrain(runtime: WorkspaceRuntime): void {
    this.disposed.add(runtime);
    const state = this.states.get(runtime);
    if (!state) return;
    state.draining = true;
    state.completed = true;
    const abortReason = new Error('Workspace drain completed');
    for (const lease of state.leases) lease.abort(abortReason);
    this.deleteIfIdle(runtime, state);
  }

  getWorkspaceActivity(runtime: WorkspaceRuntime): number {
    return this.states.get(runtime)?.leases.size ?? 0;
  }

  async disposeRuntime(
    runtime: WorkspaceRuntime,
    reason: 'daemon_shutdown' | 'workspace_removed',
  ): Promise<void> {
    this.disposed.add(runtime);
    const state = this.states.get(runtime);
    if (!state) return;
    state.draining = true;
    state.completed = true;
    const abortReason = new Error(
      reason === 'workspace_removed'
        ? 'Workspace runtime was removed'
        : 'Daemon is shutting down',
    );
    for (const lease of state.leases) lease.abort(abortReason);
    if (state.leases.size === 0) {
      this.deleteIfIdle(runtime, state);
      return;
    }
    let resolveIdle: (() => void) | undefined;
    const idle = new Promise<void>((resolve) => {
      resolveIdle = resolve;
      state.idleWaiters.add(resolve);
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      await Promise.race([
        idle,
        new Promise<void>((resolve) => {
          timeout = setTimeout(() => {
            timedOut = true;
            resolve();
          }, DISPOSE_WAIT_MS);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (resolveIdle) state.idleWaiters.delete(resolveIdle);
    }
    if (timedOut && state.leases.size > 0) {
      debugLogger.warn(
        `Voice runtime disposal timed out with ${state.leases.size} active lease(s).`,
      );
    }
  }

  private stateFor(runtime: WorkspaceRuntime): RuntimeVoiceState {
    let state = this.states.get(runtime);
    if (!state) {
      state = {
        draining: false,
        completed: false,
        leases: new Set(),
        idleWaiters: new Set(),
      };
      this.states.set(runtime, state);
    }
    return state;
  }

  private release(runtime: WorkspaceRuntime, lease: Lease): void {
    const state = this.states.get(runtime);
    if (!state || !state.leases.delete(lease)) return;
    this.active--;
    if (state.leases.size === 0) {
      for (const resolve of state.idleWaiters) resolve();
      state.idleWaiters.clear();
    }
    this.deleteIfIdle(runtime, state);
  }

  private deleteIfIdle(
    runtime: WorkspaceRuntime,
    state: RuntimeVoiceState,
  ): void {
    if (state.completed && state.leases.size === 0) this.states.delete(runtime);
  }
}
