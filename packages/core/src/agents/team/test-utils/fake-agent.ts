/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview FakeAgent — test double for AgentInteractive.
 *
 * Implements the subset of AgentInteractive's public surface that
 * TeamManager uses, backed by a deterministic script instead of an
 * LLM reasoning loop. Status transitions emit real STATUS_CHANGE
 * events through a real AgentEventEmitter.
 */

import {
  AgentEventEmitter,
  AgentEventType,
} from '../../runtime/agent-events.js';
import { AgentStatus, isTerminalStatus } from '../../runtime/agent-types.js';
import type { AgentStatsSummary } from '../../runtime/agent-statistics.js';

/**
 * Script that controls how a FakeAgent responds to lifecycle events.
 */
export interface FakeAgentScript {
  /**
   * Called when the agent receives a message (via enqueueMessage).
   * Return value controls what happens next:
   * - undefined: agent goes IDLE immediately (default)
   * - 'stay_running': agent stays RUNNING (test must manually idle)
   * - Promise: agent stays RUNNING until promise resolves, then IDLE
   */
  onMessage?: (
    message: string,
    agent: FakeAgent,
  ) => void | 'stay_running' | Promise<void>;

  /**
   * Called when the agent starts (via start()).
   */
  onStart?: (agent: FakeAgent) => void | Promise<void>;
}

/**
 * FakeAgent — deterministic test double for AgentInteractive.
 *
 * Matches the public surface that TeamManager uses: getStatus(),
 * getEventEmitter(), getError(), getLastRoundError(), getStats(),
 * enqueueMessage(), waitForCompletion(), abort(), shutdown(),
 * cancelCurrentRound().
 */
export class FakeAgent {
  readonly agentId: string;
  readonly agentName: string;

  private status: AgentStatus = AgentStatus.INITIALIZING;
  private readonly emitter = new AgentEventEmitter();
  private readonly receivedMessages: string[] = [];
  private readonly pendingQueue: string[] = [];
  private processing = false;
  private drained = false;
  private script: FakeAgentScript;
  private error: string | undefined;
  private lastRoundError: string | undefined;

  /** Resolvers waiting for a specific message count. */
  private messageWaiters: Array<{
    count: number;
    resolve: () => void;
  }> = [];

  /** Resolvers waiting for a specific status. */
  private statusWaiters: Array<{
    target: AgentStatus;
    resolve: () => void;
  }> = [];

  /** Resolves when status reaches a terminal state. */
  private completionResolve: (() => void) | undefined;
  private completionPromise: Promise<void>;

  constructor(
    agentId: string,
    agentName: string,
    script: FakeAgentScript = {},
  ) {
    this.agentId = agentId;
    this.agentName = agentName;
    this.script = script;

    this.completionPromise = new Promise<void>((resolve) => {
      this.completionResolve = resolve;
    });
  }

  // ─── Lifecycle ──────────────────────────────────────────────

  /**
   * Start the agent. Transitions INITIALIZING → IDLE (or runs
   * onStart script first).
   */
  async start(): Promise<void> {
    if (this.script.onStart) {
      const result = this.script.onStart(this);
      if (result instanceof Promise) {
        await result;
      }
    }
    if (this.status === AgentStatus.INITIALIZING) {
      this.setStatus(AgentStatus.IDLE);
    }
  }

  // ─── AgentInteractive-compatible surface ────────────────────

  getStatus(): AgentStatus {
    return this.status;
  }

  getEventEmitter(): AgentEventEmitter {
    return this.emitter;
  }

  getError(): string | undefined {
    return this.error;
  }

  getLastRoundError(): string | undefined {
    return this.lastRoundError;
  }

  getStats(): AgentStatsSummary {
    return {
      rounds: 0,
      totalDurationMs: 0,
      totalToolCalls: 0,
      successfulToolCalls: 0,
      failedToolCalls: 0,
      successRate: 0,
      inputTokens: 0,
      outputTokens: 0,
      thoughtTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      toolUsage: [],
    };
  }

  /**
   * Mirrors AgentInteractive's queue semantics: a message that arrives
   * while a round is in flight is queued and processed when the round
   * settles — it must NOT spin up a concurrent inline round. Messages
   * after abort()/shutdown() are silently dropped (drained queue), and
   * a terminal agent is never resurrected via setStatus(RUNNING).
   */
  enqueueMessage(message: string): void {
    if (this.drained || isTerminalStatus(this.status)) return;
    this.pendingQueue.push(message);
    if (!this.processing) {
      this.processNext();
    }
  }

  private processNext(): void {
    const message = this.pendingQueue.shift();
    if (message === undefined) return;
    this.processing = true;
    this.receivedMessages.push(message);
    this.flushMessageWaiters();

    this.setStatus(AgentStatus.RUNNING);

    if (this.script.onMessage) {
      const result = this.script.onMessage(message, this);
      if (result === 'stay_running') {
        // Test controls when to go idle via goIdle(); `processing`
        // stays armed so queued messages wait for it, like the real
        // run loop mid-round.
        return;
      }
      if (result instanceof Promise) {
        void result.then(() => this.settleAfterRound());
        return;
      }
    }

    this.settleAfterRound();
  }

  /**
   * Mirrors the real run loop's drain-then-settle order: queued
   * messages are processed before the agent settles to IDLE. A
   * terminal status (abort, or a script that moved to COMPLETED)
   * stops the drain — the real loop never resurrects.
   */
  private settleAfterRound(): void {
    this.processing = false;
    if (this.drained || isTerminalStatus(this.status)) return;
    if (this.pendingQueue.length > 0) {
      this.processNext();
      return;
    }
    if (this.status === AgentStatus.RUNNING) {
      this.setStatus(AgentStatus.IDLE);
    }
  }

  async waitForCompletion(): Promise<void> {
    if (isTerminalStatus(this.status)) return;
    return this.completionPromise;
  }

  abort(): void {
    this.drained = true;
    this.pendingQueue.length = 0;
    if (!isTerminalStatus(this.status)) {
      this.setStatus(AgentStatus.CANCELLED);
    }
  }

  async shutdown(): Promise<void> {
    this.drained = true;
    if (!isTerminalStatus(this.status)) {
      this.setStatus(AgentStatus.COMPLETED);
    }
  }

  cancelCurrentRound(): void {
    if (this.status === AgentStatus.RUNNING) {
      this.setStatus(AgentStatus.IDLE);
    }
  }

  // ─── Test control ───────────────────────────────────────────

  /** Manually transition to a status (emits STATUS_CHANGE). */
  setStatus(newStatus: AgentStatus): void {
    const previousStatus = this.status;
    if (previousStatus === newStatus) return;

    this.status = newStatus;

    this.emitter.emit(AgentEventType.STATUS_CHANGE, {
      agentId: this.agentId,
      previousStatus,
      newStatus,
      timestamp: Date.now(),
    });

    this.flushStatusWaiters();

    if (isTerminalStatus(newStatus)) {
      this.completionResolve?.();
    }
  }

  /**
   * Manually end the current round (RUNNING → IDLE). Messages queued
   * while the round was held open are processed first, mirroring the
   * real run loop.
   */
  goIdle(): void {
    if (this.status === AgentStatus.RUNNING) {
      this.settleAfterRound();
    }
  }

  /** All messages received via enqueueMessage(). */
  getReceivedMessages(): readonly string[] {
    return this.receivedMessages;
  }

  /** Wait until the agent has received N messages total. */
  waitForMessageCount(n: number): Promise<void> {
    if (this.receivedMessages.length >= n) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.messageWaiters.push({ count: n, resolve });
    });
  }

  /** Wait until status reaches the given value. */
  waitForStatus(target: AgentStatus): Promise<void> {
    if (this.status === target) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.statusWaiters.push({ target, resolve });
    });
  }

  /** Set the error string (test control). */
  setError(error: string | undefined): void {
    this.error = error;
  }

  /** Set the lastRoundError string (test control). */
  setLastRoundError(error: string | undefined): void {
    this.lastRoundError = error;
  }

  // ─── Private ────────────────────────────────────────────────

  private flushMessageWaiters(): void {
    const pending = this.messageWaiters;
    this.messageWaiters = [];
    for (const w of pending) {
      if (this.receivedMessages.length >= w.count) {
        w.resolve();
      } else {
        this.messageWaiters.push(w);
      }
    }
  }

  private flushStatusWaiters(): void {
    const pending = this.statusWaiters;
    this.statusWaiters = [];
    for (const w of pending) {
      if (this.status === w.target) {
        w.resolve();
      } else {
        this.statusWaiters.push(w);
      }
    }
  }
}
