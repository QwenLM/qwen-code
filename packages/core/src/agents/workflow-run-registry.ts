/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tracks in-flight and recently-finished workflow runs spawned via the
 * `Workflow` tool. Sibling of `BackgroundTaskRegistry` (agents),
 * `BackgroundShellRegistry` (shells), and `MonitorRegistry` (monitors).
 * Each entry holds the metadata that the footer pill, the `/workflows`
 * slash command, and the Background tasks dialog use to query, observe,
 * or cancel a running workflow.
 *
 * State machine: register → running → { completed | failed | cancelled }.
 * Transitions out of running are one-shot — complete / fail / cancel
 * become no-ops once the entry has settled.
 *
 * Unlike `BackgroundTaskRegistry`, the workflow registry does NOT emit
 * any `<task-notification>` XML or model-facing prose — `WorkflowTool`
 * already returns its own llmContent + returnDisplay payload to the
 * model when the run terminates, so a second envelope would duplicate
 * the signal. The registry is UI-only: its callbacks drive the pill
 * counts, the dialog roster, and the per-phase detail body.
 */

import type { TaskBase, TaskRegistration } from './tasks/types.js';
import type { WorkflowMeta } from './runtime/workflow-sandbox.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('WORKFLOW_REGISTRY');

/**
 * Cap on terminal entries retained for dialog history. Picked smaller
 * than `MAX_RETAINED_TERMINAL_AGENTS` (32) because workflow rows carry
 * the heavier label (workflow name + phase tree) and because users
 * typically run far fewer workflows than agents per session.
 */
export const MAX_RETAINED_TERMINAL_WORKFLOWS = 10;

export type WorkflowStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Workflow kind of `TaskState`. Tracks one orchestrator run — the
 * top-level `Workflow` tool call, not its internal subagent dispatches
 * (those are routed through the regular subagent path and recorded by
 * `BackgroundTaskRegistry` when backgrounded). The `phases` array is
 * the sandbox's `getPhases()` snapshot; `currentPhase` is the head of
 * the most recent `phase()` call.
 */
export interface WorkflowTask extends TaskBase {
  kind: 'workflow';
  /** Run identifier (e.g. `wf_<8hex>`); aliased to `TaskBase.id`. */
  runId: string;
  /**
   * Parsed `export const meta = {...}` from the workflow script, or
   * `null` if the script had no meta declaration. The pill / dialog
   * row label falls back to `runId` when meta is null.
   */
  meta: WorkflowMeta | null;
  status: WorkflowStatus;
  /** Title of the most recent `phase(...)` call, or `null` before the first phase. */
  currentPhase: string | null;
  /**
   * All phase titles seen so far (deduplicated against the previous
   * entry — matches the sandbox's `safePhase` collapse). Capped at
   * `MAX_PHASE_ENTRIES` (10_000) by the sandbox.
   */
  phases: string[];
  /** Cumulative `agent()` dispatches issued by this run. */
  agentsDispatched: number;
  /** Cumulative `agent()` dispatches that have resolved (success or thrown). */
  agentsCompleted: number;
  /** Most recent log lines from the sandbox's `getLogs()`. Capped at 100 for the UI. */
  recentLogs: string[];
  /** Final script return value once the run completes (success path). */
  result?: unknown;
  /** Error message on `failed` (terminal). */
  error?: string;
}

/**
 * Shape callers pass to `register()`. The four `TaskBase` fields the
 * registry derives — `id`, `kind`, `outputOffset`, `notified` — are
 * omitted; everything else (including `outputFile`) is supplied by the
 * caller. `currentPhase` / `phases` / `agentsDispatched` /
 * `agentsCompleted` / `recentLogs` all default to their empty
 * counterparts at register time and become observable via subsequent
 * `onPhaseStarted` / `onAgentDispatched` / etc.
 */
export type WorkflowTaskRegistration = Omit<
  TaskRegistration<WorkflowTask>,
  | 'currentPhase'
  | 'phases'
  | 'agentsDispatched'
  | 'agentsCompleted'
  | 'recentLogs'
  | 'description'
> & {
  // Allow the caller to omit `description` — we synthesize it from
  // `meta?.name ?? runId` for symmetry with shell registry's `command`
  // synthesis.
  description?: string;
};

/** Fires when a new entry is registered. */
export type WorkflowRunRegisterCallback = (entry: WorkflowTask) => void;

/**
 * Fires whenever the entry's `status`, `currentPhase`, or dispatch
 * counts change. Symmetric with the other registries' `statusChange`
 * callback so the unified `useBackgroundTaskView` hook can subscribe
 * to all four with the same shape.
 */
export type WorkflowRunStatusChangeCallback = (entry?: WorkflowTask) => void;

export class WorkflowRunRegistry {
  private readonly entries = new Map<string, WorkflowTask>();

  private registerCallback: WorkflowRunRegisterCallback | undefined;
  private statusChangeCallback: WorkflowRunStatusChangeCallback | undefined;

  setRegisterCallback(cb: WorkflowRunRegisterCallback | undefined): void {
    this.registerCallback = cb;
  }

  setStatusChangeCallback(
    cb: WorkflowRunStatusChangeCallback | undefined,
  ): void {
    this.statusChangeCallback = cb;
  }

  /**
   * Register a new run. Mutates the registration in place to graduate
   * it to a `WorkflowTask` (sets `id`, `kind`, derived counters), so
   * callers can keep using their local reference post-register and
   * observers see updates without an extra `get()`.
   */
  register(registration: WorkflowTaskRegistration): WorkflowTask {
    const entry = registration as WorkflowTask;
    entry.id = registration.runId;
    entry.kind = 'workflow';
    entry.outputOffset = 0;
    entry.notified = false;
    entry.currentPhase = null;
    entry.phases = [];
    entry.agentsDispatched = 0;
    entry.agentsCompleted = 0;
    entry.recentLogs = [];
    if (!entry.description) {
      entry.description = entry.meta?.name ?? entry.runId;
    }
    this.entries.set(entry.runId, entry);
    debugLogger.info(`Registered workflow run: ${entry.runId}`);

    if (this.registerCallback) {
      try {
        this.registerCallback(entry);
      } catch (error) {
        debugLogger.error('Failed to emit register callback:', error);
      }
    }
    this.emitStatusChange(entry);
    return entry;
  }

  /**
   * Append a phase title. Mirrors the sandbox's `safePhase` collapse:
   * a phase identical to the most recent entry is treated as the same
   * phase and not re-appended. `currentPhase` is set unconditionally.
   *
   * @param runId  the run to update
   * @param title  the phase title from the sandbox `phase()` call
   */
  onPhaseStarted(runId: string, title: string): void {
    const entry = this.entries.get(runId);
    if (!entry || entry.status !== 'running') return;
    entry.currentPhase = title;
    const last = entry.phases[entry.phases.length - 1];
    if (last !== title) entry.phases.push(title);
    this.emitStatusChange(entry);
  }

  /** Cumulative dispatch counter — incremented before each `agent()` call resolves. */
  onAgentDispatched(runId: string): void {
    const entry = this.entries.get(runId);
    if (!entry || entry.status !== 'running') return;
    entry.agentsDispatched++;
    this.emitStatusChange(entry);
  }

  /** Cumulative completion counter — incremented after each `agent()` call settles. */
  onAgentCompleted(runId: string): void {
    const entry = this.entries.get(runId);
    if (!entry || entry.status !== 'running') return;
    entry.agentsCompleted++;
    this.emitStatusChange(entry);
  }

  /**
   * Replace the recent-log tail. The sandbox owns the source-of-truth
   * `getLogs()` array; we mirror it here for the UI so the dialog
   * doesn't have to thread a sandbox reference. Capped at 100 entries
   * (the tail) so a chatty workflow doesn't bloat the registry.
   */
  setRecentLogs(runId: string, logs: readonly string[]): void {
    const entry = this.entries.get(runId);
    if (!entry || entry.status !== 'running') return;
    const tail = logs.length > 100 ? logs.slice(-100) : Array.from(logs);
    entry.recentLogs = tail;
    this.emitStatusChange(entry);
  }

  complete(runId: string, result: unknown, endTime: number): void {
    const entry = this.entries.get(runId);
    if (!entry || entry.status !== 'running') return;
    entry.status = 'completed';
    entry.endTime = endTime;
    entry.result = result;
    entry.notified = true;
    this.emitStatusChange(entry);
    this.evictTerminal();
  }

  fail(runId: string, message: string, endTime: number): void {
    const entry = this.entries.get(runId);
    if (!entry || entry.status !== 'running') return;
    entry.status = 'failed';
    entry.endTime = endTime;
    entry.error = message;
    entry.notified = true;
    this.emitStatusChange(entry);
    this.evictTerminal();
  }

  /**
   * Mark a running entry as cancelled and abort its controller. No-op
   * if the entry has already settled — protects against an explicit
   * dialog cancel racing with the natural complete/fail path.
   */
  cancel(runId: string, endTime: number): void {
    const entry = this.entries.get(runId);
    if (!entry || entry.status !== 'running') return;
    entry.status = 'cancelled';
    entry.endTime = endTime;
    entry.notified = true;
    try {
      entry.abortController.abort();
    } catch (error) {
      debugLogger.error('Failed to abort workflow controller:', error);
    }
    this.emitStatusChange(entry);
    this.evictTerminal();
  }

  get(runId: string): WorkflowTask | undefined {
    return this.entries.get(runId);
  }

  /** All entries (running + terminal, no filter). Iteration order = registration order. */
  list(): WorkflowTask[] {
    return Array.from(this.entries.values());
  }

  /**
   * Sweep terminal entries when they exceed `MAX_RETAINED_TERMINAL_WORKFLOWS`.
   * Running entries are always retained. Oldest terminal entries
   * (by `endTime`) are evicted first.
   */
  private evictTerminal(): void {
    const terminal = this.list().filter((e) => e.status !== 'running');
    if (terminal.length <= MAX_RETAINED_TERMINAL_WORKFLOWS) return;
    terminal.sort((a, b) => (a.endTime ?? 0) - (b.endTime ?? 0));
    const toEvict = terminal.slice(
      0,
      terminal.length - MAX_RETAINED_TERMINAL_WORKFLOWS,
    );
    for (const e of toEvict) {
      this.entries.delete(e.runId);
    }
  }

  private emitStatusChange(entry: WorkflowTask): void {
    if (!this.statusChangeCallback) return;
    try {
      this.statusChangeCallback(entry);
    } catch (error) {
      debugLogger.error('Failed to emit workflow status change:', error);
    }
  }
}
