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
  /**
   * P5: cumulative output tokens spent by this run's `agent()` dispatches.
   * Mirrored from `budget.spent()` after each successful completion via
   * the `budgetUpdated` emitter event. Stays at `0` for runs without a
   * budget (legacy callers) and for the period between register and the
   * first dispatch settling.
   */
  tokensSpent: number;
  /**
   * P5: per-run token cap from `QWEN_CODE_MAX_TOKENS_PER_WORKFLOW`. `null`
   * when no cap is set — the dialog renders `tokensSpent` alone in that
   * case rather than the `M / N` form. Set at register time from
   * `budget.total` and re-affirmed by every `budgetUpdated` fire (the
   * budget's `total` is immutable so the value never changes mid-run).
   */
  tokenBudgetTotal: number | null;
  /**
   * P5: per-phase token attribution. Delta tokens are attributed to the
   * entry's `currentPhase` at the moment `budgetUpdated` fires. A
   * workflow that dispatches an agent before its first `phase()` call
   * accumulates that agent's tokens under a sentinel `null` phase, which
   * the UI surfaces as `(no phase)` so the share is observable rather
   * than hidden.
   */
  perPhaseTokens: Map<string | null, number>;
  /**
   * P7b: the workflow script source (verbatim, as the tool received it).
   * Used by the run-snapshot writer (so a persisted run carries its
   * script) and the save-to-disk dialog (so a completed run can be saved
   * to `.qwen/workflows/<name>.js`). Empty string for legacy callers that
   * don't supply it.
   */
  script: string;
  /**
   * P7b: the path the script was loaded from, when the run was launched
   * from a saved workflow (`Workflow({scriptPath})` or a `/workflow-name`
   * slash command). `undefined` for inline scripts. Recorded as run
   * provenance (e.g. for the snapshot).
   */
  scriptPath?: string;
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
  | 'tokensSpent'
  | 'tokenBudgetTotal'
  | 'perPhaseTokens'
  | 'script'
  | 'description'
> & {
  // Allow the caller to omit `description` — we synthesize it from
  // `meta?.name ?? runId` for symmetry with shell registry's `command`
  // synthesis.
  description?: string;
  /**
   * P5: optional per-run token cap at register time. Defaults to `null`
   * (no cap). Persists for the life of the entry — `onBudgetUpdated`
   * does NOT re-write it because the budget's `total` is immutable.
   */
  tokenBudgetTotal?: number | null;
  /**
   * P7b: the workflow script source. Defaults to `''` when omitted (legacy
   * callers / tests). Needed for run snapshots + the save-to-disk dialog.
   */
  script?: string;
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

/**
 * P-notif: fires once when a run reaches a terminal state worth surfacing to
 * the user — `completed` / `failed`, but NOT a user-initiated `cancel` (the
 * user already knows). The CLI wires this to the terminal-bell notification
 * service. A separate slot from `statusChangeCallback` (which the dialog's
 * `useBackgroundTaskView` owns), so the two never clobber each other.
 */
export type WorkflowRunNotificationCallback = (entry: WorkflowTask) => void;

export class WorkflowRunRegistry {
  private readonly entries = new Map<string, WorkflowTask>();

  private registerCallback: WorkflowRunRegisterCallback | undefined;
  private statusChangeCallback: WorkflowRunStatusChangeCallback | undefined;
  private notificationCallback: WorkflowRunNotificationCallback | undefined;
  /**
   * P5 T7: one-time usage-warning latch. The first `Workflow` tool
   * invocation per session checks `shouldShowUsageWarning()`; if true,
   * the tool prepends a one-line banner to the result describing the
   * token-budget knob (`QWEN_CODE_MAX_TOKENS_PER_WORKFLOW`) and how to
   * suppress (`skipWorkflowUsageWarning` setting). The latch flips on
   * the same call so subsequent runs are quiet. Survives `reset()` —
   * the warning is per-session, not per-clear.
   */
  private usageWarningShown = false;

  /**
   * P5 T7: gate the one-time usage warning. Returns `true` exactly once
   * per session, flipping the latch as a side effect. Settings-level
   * suppression (`skipWorkflowUsageWarning`) is enforced upstream by
   * the caller (`WorkflowTool`) before invoking — the registry only
   * tracks session-scoped freshness.
   */
  shouldShowUsageWarning(): boolean {
    if (this.usageWarningShown) return false;
    this.usageWarningShown = true;
    return true;
  }

  setRegisterCallback(cb: WorkflowRunRegisterCallback | undefined): void {
    this.registerCallback = cb;
  }

  setStatusChangeCallback(
    cb: WorkflowRunStatusChangeCallback | undefined,
  ): void {
    this.statusChangeCallback = cb;
  }

  setNotificationCallback(
    cb: WorkflowRunNotificationCallback | undefined,
  ): void {
    this.notificationCallback = cb;
  }

  /** Fire the terminal-completion notification (best-effort). */
  private emitNotification(entry: WorkflowTask): void {
    if (!this.notificationCallback) return;
    try {
      this.notificationCallback(entry);
    } catch (error) {
      debugLogger.error('Failed to emit workflow notification:', error);
    }
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
    entry.tokensSpent = 0;
    // Preserve a caller-supplied cap; default to "no cap" otherwise.
    // Note: the registration's optional `tokenBudgetTotal` shape is the
    // sole way to seed this — `onBudgetUpdated` only mirrors mid-run
    // updates, never the initial value.
    if (entry.tokenBudgetTotal === undefined) {
      entry.tokenBudgetTotal = null;
    }
    entry.perPhaseTokens = new Map();
    // P7b: default the script source so the snapshot writer + save dialog
    // always have a (possibly empty) string to work with.
    if (entry.script === undefined) entry.script = '';
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
   * P5: mirror a `budgetUpdated` emitter event into the entry. Attributes
   * the cumulative delta (`spent - entry.tokensSpent`) to the entry's
   * `currentPhase`. Per-phase attribution is best-effort: agents in
   * flight when the script issues a new `phase()` will attribute their
   * tokens to whichever phase was current when `budgetUpdated` fires —
   * the orchestrator fires immediately after `agentCompleted`, so the
   * race window is bounded but not zero. Tasks before the first
   * `phase()` call attribute to the sentinel `null` key.
   */
  onBudgetUpdated(runId: string, spent: number, total: number | null): void {
    const entry = this.entries.get(runId);
    if (!entry || entry.status !== 'running') return;
    const delta = spent - entry.tokensSpent;
    const totalChanged = entry.tokenBudgetTotal !== total;
    // P5 R1 (#8): skip the statusChange emit when nothing observable
    // changed. The orchestrator fires `budgetUpdated` after EVERY
    // successful dispatch — including dispatches whose subagent
    // reported `outputTokens === 0` (early failures, fast no-op
    // responses). Those produce a no-delta call here; firing the
    // UI re-render anyway burns frames for no visible effect.
    if (delta <= 0 && !totalChanged) return;
    if (delta > 0) {
      const key = entry.currentPhase;
      const prior = entry.perPhaseTokens.get(key) ?? 0;
      entry.perPhaseTokens.set(key, prior + delta);
    }
    entry.tokensSpent = spent;
    // `total` is immutable on the budget, but mirror it defensively so
    // a stale register-time value can't drift if the caller wires a
    // budget without seeding `tokenBudgetTotal`.
    entry.tokenBudgetTotal = total;
    this.emitStatusChange(entry);
  }

  /**
   * Replace the recent-log tail. The sandbox owns the source-of-truth
   * `getLogs()` array; we mirror it here for the UI so the dialog
   * doesn't have to thread a sandbox reference. Capped at 100 entries
   * (the tail) so a chatty workflow doesn't bloat the registry.
   *
   * R7 (wenshao): allowed after a `'cancelled'` transition too. The
   * dialog-initiated cancel path calls `registry.cancel()` first
   * (status flips to `'cancelled'` synchronously), then the abort
   * propagates to the tool's catch arm which calls `setRecentLogs`.
   * Without this, dialog-cancelled runs always showed an empty Logs
   * section. `'completed'` / `'failed'` are still rejected — those
   * terminal states ARE final (no late-arriving logs to absorb).
   */
  setRecentLogs(runId: string, logs: readonly string[]): void {
    const entry = this.entries.get(runId);
    if (!entry) return;
    if (entry.status !== 'running' && entry.status !== 'cancelled') return;
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
    this.emitNotification(entry);
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
    this.emitNotification(entry);
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
   * R7 (wenshao): true if any entry is still `'running'`. Mirrors the
   * three sibling registries' `hasUnfinalizedTasks()` /
   * `hasRunningEntries()` / `getRunning().length > 0` so the unified
   * `hasBlockingBackgroundWork()` helper (the gate `/clear` and session-
   * resume both use to refuse a switch with live work) can count
   * workflow runs the same way.
   */
  hasRunningEntries(): boolean {
    for (const entry of this.entries.values()) {
      if (entry.status === 'running') return true;
    }
    return false;
  }

  /**
   * R7 (wenshao): drop every in-memory entry without touching
   * controllers. Mirrors `BackgroundShellRegistry.reset()` and the
   * other siblings' contract — callers (`/clear`, session-resume)
   * MUST verify via `hasRunningEntries()` first that no still-running
   * work exists before invoking. The companion path that aborts
   * controllers is `abortAll()`.
   */
  reset(): void {
    if (this.entries.size === 0) return;
    // Snapshot a sample entry for the statusChange callback so a single
    // subscriber notify is enough — the only consumer
    // (`useBackgroundTaskView`) ignores the entry arg and re-pulls
    // `list()` on every fire.
    const sample = this.entries.values().next().value as
      | WorkflowTask
      | undefined;
    this.entries.clear();
    if (sample) this.emitStatusChange(sample);
  }

  /**
   * R7 (wenshao): cancel every still-running entry. Called on session/
   * Config shutdown so workflow runs don't outlive the CLI process and
   * leak orphaned dispatches. Symmetric with `BackgroundShellRegistry.
   * abortAll()` and `BackgroundTaskRegistry.abortAll()`.
   *
   * Settles each entry inline (status → 'cancelled', abort the
   * controller) and fires the status-change callback exactly once
   * after the loop — the per-entry `cancel()` path would have fired
   * the callback for every running entry, wasteful on shutdown.
   */
  abortAll(): void {
    const endTime = Date.now();
    let lastCancelled: WorkflowTask | undefined;
    for (const entry of Array.from(this.entries.values())) {
      if (entry.status !== 'running') continue;
      entry.status = 'cancelled';
      entry.endTime = endTime;
      entry.notified = true;
      try {
        entry.abortController.abort();
      } catch (error) {
        debugLogger.error(
          'abortAll: failed to abort workflow controller:',
          error,
        );
      }
      lastCancelled = entry;
    }
    if (lastCancelled) this.emitStatusChange(lastCancelled);
    this.evictTerminal();
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
