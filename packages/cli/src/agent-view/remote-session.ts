/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  ApprovalMode,
  AgentStatus,
  type AgentMessage,
  type AgentSession,
  type AgentSessionEvents,
  type AgentSessionView,
  type ToolResultDisplay,
  type TurnId,
} from '@qwen-code/qwen-code-core';
import type {
  AgentViewSessionState,
  AgentViewWorkerEvent,
  AgentViewWorkerViewSnapshot,
} from './protocol.js';
import type { AgentViewSupervisorClientHandle } from './supervisor-runner.js';

export class RemoteSession implements AgentSession, AgentSessionView {
  readonly kind = 'supervised' as const;

  private readonly events = new EventEmitter();
  private readonly subscription;
  private status = AgentStatus.INITIALIZING;
  private error: string | undefined;
  private snapshot: AgentViewWorkerViewSnapshot;
  private ready = false;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private readonly readyPromise = new Promise<void>((resolve, reject) => {
    this.readyResolve = resolve;
    this.readyReject = reject;
  });

  constructor(
    readonly agentId: string,
    readonly teamId: string,
    private readonly supervisor: AgentViewSupervisorClientHandle,
    cwd: string,
    modelId: string,
    approvalMode?: ApprovalMode,
  ) {
    this.snapshot = emptySnapshot(cwd, modelId, approvalMode);
    void this.readyPromise.catch(() => {});
    this.subscription = supervisor.subscribe(
      (event) => {
        if (event.sessionId !== agentId || !event.workerEvent) return;
        this.accept(event.workerEvent);
      },
      (error) => {
        this.error = error.message;
        if (!this.ready) this.readyReject(error);
        this.events.emit('change');
      },
    );
  }

  async waitUntilReady(timeoutMs = 60_000): Promise<void> {
    let timeout: ReturnType<typeof setTimeout>;
    await Promise.race([
      this.readyPromise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(new Error(`Agent "${this.agentId}" did not become ready.`)),
          timeoutMs,
        );
      }),
    ]).finally(() => clearTimeout(timeout!));
  }

  async waitUntilSubscribed(): Promise<void> {
    await this.subscription.ready;
  }

  getStatus(): AgentStatus {
    return this.status;
  }

  /**
   * One-line failure summary for the status label.
   *
   * The supervisor's diagnostic is deliberately multi-line (it carries a log
   * tail); its first line already names the exit code and the log path, which
   * is what fits — and what an operator needs — in the composer.
   */
  getError(): string | undefined {
    const error = this.error ?? this.snapshot.lastRoundError;
    return error?.split('\n')[0];
  }

  /** Full multi-line diagnostic, including any captured subprocess output. */
  getErrorDetail(): string | undefined {
    return this.error ?? this.snapshot.lastRoundError;
  }

  async send(message: string): Promise<TurnId> {
    const turnId = randomUUID();
    try {
      await this.supervisor.send(this.agentId, turnId, message);
    } catch (error) {
      this.recordError(error);
      throw error;
    }
    return turnId;
  }

  cancelTurn(): void {
    void this.supervisor
      .cancel(this.agentId)
      .catch((error) => this.recordError(error));
  }

  abort(): void {
    void this.supervisor
      .stop(this.agentId)
      .catch((error) => this.recordError(error));
  }

  on<E extends keyof AgentSessionEvents>(
    event: E,
    handler: (payload: AgentSessionEvents[E]) => void,
  ): () => void {
    this.events.on(event, handler);
    return () => this.events.off(event, handler);
  }

  getMessages(): readonly AgentMessage[] {
    return this.snapshot.messages;
  }

  getPendingApprovals(): ReadonlyMap<
    string,
    AgentSessionEvents['approvalRequest']['details']
  > {
    return new Map(this.snapshot.pendingApprovals);
  }

  getLiveOutputs(): ReadonlyMap<string, ToolResultDisplay> {
    return new Map(this.snapshot.liveOutputs);
  }

  getShellPids(): ReadonlyMap<string, number> {
    return new Map();
  }

  getExecutionStartTimes(): ReadonlyMap<string, number> {
    return new Map(this.snapshot.executionStartTimes);
  }

  get workingDir(): string {
    return this.snapshot.workingDir;
  }

  get modelId(): string {
    return this.snapshot.modelId;
  }

  getLastPromptTokenCount(): number {
    return this.snapshot.lastPromptTokenCount ?? 0;
  }

  getLastRoundError(): string | undefined {
    return this.snapshot.lastRoundError ?? this.error;
  }

  getApprovalMode(): ApprovalMode {
    return this.snapshot.approvalMode ?? ApprovalMode.DEFAULT;
  }

  onChange(cb: () => void): () => void {
    this.events.on('change', cb);
    return () => this.events.off('change', cb);
  }

  dispose(): void {
    this.subscription.dispose();
    this.events.removeAllListeners();
  }

  private accept(event: AgentViewWorkerEvent): void {
    if (event.type === 'viewSnapshot') {
      this.snapshot = event.snapshot;
      this.events.emit('change');
      return;
    }
    if (event.type === 'ready') {
      this.markReady();
      return;
    }
    if (event.type === 'state') {
      // The supervisor attaches the exit code and captured output here; keep it
      // even when the session is already ready so a mid-run crash stays
      // explicable in the pane.
      if (event.lastError) this.error = event.lastError.message;
      this.setStatus(statusFromSupervisor(event.sessionState));
      if (!this.ready && isTerminalSupervisorState(event.sessionState)) {
        const reason =
          event.lastError?.message ??
          `no diagnostics were reported (state: ${event.sessionState})`;
        // Only fall back to the wrapper text when the supervisor sent no
        // diagnostic; otherwise the agent-name prefix would push the exit code
        // and log path off the end of a one-line status label.
        this.error ??= reason;
        this.readyReject(
          new Error(
            `Agent "${this.agentId}" exited before becoming ready. ${reason}`,
          ),
        );
      }
      return;
    }
    if (event.type !== 'sessionEvent') return;

    if (event.event === 'status') {
      this.status = event.payload.next;
    } else if (event.event === 'exited' && event.payload.code !== 0) {
      this.error = event.payload.reason;
    }
    this.events.emit(event.event, event.payload);
    this.events.emit('change');
  }

  private setStatus(next: AgentStatus): void {
    if (this.status === next) return;
    const previous = this.status;
    this.status = next;
    this.events.emit('status', { previous, next });
    this.events.emit('change');
  }

  private markReady(): void {
    if (this.ready) return;
    this.ready = true;
    this.readyResolve();
  }

  private recordError(error: unknown): void {
    this.error = error instanceof Error ? error.message : String(error);
    this.events.emit('change');
  }
}

function isTerminalSupervisorState(state: AgentViewSessionState): boolean {
  return state === 'completed' || state === 'stopped' || state === 'failed';
}

function emptySnapshot(
  cwd: string,
  modelId: string,
  approvalMode?: ApprovalMode,
): AgentViewWorkerViewSnapshot {
  return {
    messages: [],
    pendingApprovals: [],
    liveOutputs: [],
    shellPids: [],
    executionStartTimes: [],
    workingDir: cwd,
    modelId,
    ...(approvalMode ? { approvalMode } : {}),
  };
}

function statusFromSupervisor(state: AgentViewSessionState): AgentStatus {
  switch (state) {
    case 'starting':
      return AgentStatus.INITIALIZING;
    case 'working':
    case 'needs_input':
      return AgentStatus.RUNNING;
    case 'idle':
      return AgentStatus.IDLE;
    case 'completed':
      return AgentStatus.COMPLETED;
    case 'stopped':
      return AgentStatus.CANCELLED;
    case 'failed':
      return AgentStatus.FAILED;
    default: {
      // Exhaustive today; a new supervisor state must map explicitly rather
      // than silently reading as some other status in the UI.
      const unexpected: never = state;
      throw new Error(`Unhandled supervisor session state: ${unexpected}`);
    }
  }
}
