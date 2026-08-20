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
 * or cancel an active workflow.
 *
 * State machine: running → pausing → paused → running, with every active
 * state able to settle as completed, failed, or cancelled.
 *
 * Foreground runs return through the normal tool-result channel. Background
 * runs additionally emit one terminal `<task-notification>` through a
 * dedicated model-completion callback. That slot is separate from the
 * terminal-bell callback so the CLI can subscribe to both without either
 * consumer replacing the other.
 */

import type { TaskBase, TaskRegistration } from './tasks/types.js';
import type { WorkflowMeta } from './runtime/workflow-sandbox.js';
import type { WorkflowRunHandle } from './runtime/workflow-runner.js';
import {
  AgentEventType,
  type AgentApprovalRequestEvent,
  type AgentEventEmitter,
  type AgentToolResultEvent,
} from './runtime/agent-events.js';
import {
  ToolConfirmationOutcome,
  type ToolConfirmationPayload,
} from '../tools/tools.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { todoWorkChainContext } from '../utils/promptIdContext.js';
import { stripAnsiAndControl } from '../utils/textUtils.js';
import { escapeXml } from '../utils/xml.js';
import { runOutsideAgentContext } from './runtime/agent-context.js';
import type { WorkflowDispatchState } from './runtime/workflow-dispatch-scheduler.js';

const debugLogger = createDebugLogger('WORKFLOW_REGISTRY');

/**
 * Cap on terminal entries retained for dialog history. Picked smaller
 * than `MAX_RETAINED_TERMINAL_AGENTS` (32) because workflow rows carry
 * the heavier label (workflow name + phase tree) and because users
 * typically run far fewer workflows than agents per session.
 */
export const MAX_RETAINED_TERMINAL_WORKFLOWS = 10;

export type WorkflowStatus =
  | WorkflowDispatchState
  | 'completed'
  | 'failed'
  | 'cancelled';
export type WorkflowTerminalStatus = Extract<
  WorkflowStatus,
  'completed' | 'failed' | 'cancelled'
>;

export function isActiveWorkflowStatus(
  status: WorkflowStatus,
): status is WorkflowDispatchState {
  return status === 'running' || status === 'pausing' || status === 'paused';
}

export function isTerminalWorkflowStatus(
  status: WorkflowStatus,
): status is WorkflowTerminalStatus {
  // Explicit positive match rather than `!isActiveWorkflowStatus(status)`:
  // a status later added to WorkflowStatus must not silently classify as
  // terminal and flow into WorkflowSnapshot.status (typed to this union).
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled'
  );
}

export const MAX_PENDING_WORKFLOW_APPROVALS = 32;
export const MAX_WORKFLOW_APPROVAL_DISPLAY_CHARS = 64 * 1024;

export interface WorkflowApproval {
  approvalId: string;
  subagentId: string;
  callId: string;
  name: string;
  description: string;
  confirmationDetails: AgentApprovalRequestEvent['confirmationDetails'];
  at: number;
}

/**
 * Workflow kind of `TaskState`. Tracks one orchestrator run — the
 * top-level `Workflow` tool call, not its internal subagent dispatches
 * (those are routed through the regular subagent path and recorded by
 * `BackgroundTaskRegistry` when backgrounded). The `phases` array is
 * the sandbox's `getPhases()` snapshot; `currentPhase` is the head of
 * the most recent `phase()` call.
 */
export interface WorkflowTask extends TaskBase<WorkflowStatus> {
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
  /** Whether the tool returned before this run reached a terminal state. */
  isBackgrounded?: boolean;
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
  /** Process-local approval requests; omitted from persisted snapshots. */
  pendingApprovals: readonly WorkflowApproval[];
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
  | 'pendingApprovals'
  | 'isBackgrounded'
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
  /** Defaults to false for legacy and foreground callers. */
  isBackgrounded?: boolean;
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
export interface WorkflowRunCompletionMeta {
  runId: string;
  status: Extract<WorkflowStatus, 'completed' | 'failed'>;
  todoWorkChainId?: string;
}
export type WorkflowRunCompletionCallback = (
  displayText: string,
  modelText: string,
  meta: WorkflowRunCompletionMeta,
) => void;
export type WorkflowApprovalChangeCallback = (entry: WorkflowTask) => void;
export type WorkflowApprovalRequestCallback = (
  entry: WorkflowTask,
  approval: WorkflowApproval,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => void | Promise<void>;

interface WorkflowApprovalRuntime {
  respond: AgentApprovalRequestEvent['respond'];
  requestController?: AbortController;
}

export class WorkflowRunRegistry {
  private readonly entries = new Map<string, WorkflowTask>();
  private readonly handles = new Map<string, WorkflowRunHandle>();

  private registerCallback: WorkflowRunRegisterCallback | undefined;
  private statusChangeCallback: WorkflowRunStatusChangeCallback | undefined;
  private notificationCallback: WorkflowRunNotificationCallback | undefined;
  private completionCallback: WorkflowRunCompletionCallback | undefined;
  private approvalChangeCallback: WorkflowApprovalChangeCallback | undefined;
  private approvalRequestCallback: WorkflowApprovalRequestCallback | undefined;
  private readonly approvalRuntimes = new Map<
    string,
    WorkflowApprovalRuntime
  >();
  private nextApprovalId = 1;
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

  setCompletionCallback(cb: WorkflowRunCompletionCallback | undefined): void {
    this.completionCallback = cb;
  }

  hasCompletionCallback(): boolean {
    return this.completionCallback !== undefined;
  }

  setApprovalChangeCallback(
    cb: WorkflowApprovalChangeCallback | undefined,
  ): void {
    this.approvalChangeCallback = cb;
  }

  setApprovalRequestCallback(
    cb: WorkflowApprovalRequestCallback | undefined,
  ): void {
    this.approvalRequestCallback = cb;
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

  private emitCompletion(entry: WorkflowTask): void {
    if (!entry.isBackgrounded || !this.completionCallback) return;
    if (entry.status !== 'completed' && entry.status !== 'failed') return;

    const statusText = entry.status === 'completed' ? 'completed' : 'failed';
    const label = stripAnsiAndControl(entry.description) || entry.runId;
    const displayText = `Background workflow "${label}" ${statusText}.`;
    const modelParts = [
      '<task-notification>',
      '<kind>workflow</kind>',
      `<task-id>${escapeXml(entry.runId)}</task-id>`,
      `<status>${entry.status}</status>`,
      `<summary>Background workflow "${escapeXml(label)}" ${statusText}.</summary>`,
    ];
    if (entry.status === 'completed' && entry.result !== undefined) {
      modelParts.push(
        `<result>${escapeXml(stringifyCompletionResult(entry.result))}</result>`,
      );
    }
    if (entry.status === 'failed') {
      modelParts.push(
        `<result>Error: ${escapeXml(entry.error ?? '')}</result>`,
      );
    }
    modelParts.push('</task-notification>');

    const meta: WorkflowRunCompletionMeta = {
      runId: entry.runId,
      status: entry.status,
      todoWorkChainId: entry.todoWorkChainId,
    };
    try {
      runOutsideAgentContext(() =>
        this.completionCallback!(displayText, modelParts.join('\n'), meta),
      );
    } catch (error) {
      debugLogger.error('Failed to emit workflow completion:', error);
    }
  }

  /**
   * Register a new run. Mutates the registration in place to graduate
   * it to a `WorkflowTask` (sets `id`, `kind`, derived counters), so
   * callers can keep using their local reference post-register and
   * observers see updates without an extra `get()`.
   */
  register(registration: WorkflowTaskRegistration): WorkflowTask {
    const existing = this.entries.get(registration.runId);
    if (
      (existing && isActiveWorkflowStatus(existing.status)) ||
      this.handles.has(registration.runId)
    ) {
      throw new Error(`Workflow run ${registration.runId} is already active.`);
    }
    const entry = registration as WorkflowTask;
    entry.id = registration.runId;
    entry.kind = 'workflow';
    entry.outputOffset = 0;
    entry.notified = false;
    entry.isBackgrounded = registration.isBackgrounded ?? false;
    entry.todoWorkChainId ??= todoWorkChainContext.getStore();
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
    entry.pendingApprovals = [];
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

  attachHandle(handle: WorkflowRunHandle): void {
    const status = this.entries.get(handle.runId)?.status;
    if (status && isActiveWorkflowStatus(status)) {
      this.handles.set(handle.runId, handle);
    }
  }

  pause(runId: string): boolean {
    const entry = this.entries.get(runId);
    const handle = this.handles.get(runId);
    if (!entry?.isBackgrounded || entry.status !== 'running' || !handle) {
      return false;
    }
    return handle.pause();
  }

  resume(runId: string): boolean {
    const entry = this.entries.get(runId);
    const handle = this.handles.get(runId);
    if (!entry || entry.status !== 'paused' || !handle) return false;
    return handle.resume();
  }

  onDispatchStateChange(runId: string, state: WorkflowDispatchState): void {
    const entry = this.entries.get(runId);
    if (!entry || isTerminalWorkflowStatus(entry.status)) return;
    if (state === 'pausing' && entry.status !== 'running') return;
    if (state === 'paused' && entry.status !== 'pausing') return;
    if (state === 'running' && entry.status !== 'paused') return;
    entry.status = state;
    this.emitStatusChange(entry);
  }

  getHandle(runId: string): WorkflowRunHandle | undefined {
    return this.handles.get(runId);
  }

  releaseHandle(runId: string, handle: WorkflowRunHandle): void {
    if (this.handles.get(runId) === handle) this.handles.delete(runId);
  }

  bridgeApprovalEvents(runId: string, emitter: AgentEventEmitter): () => void {
    const ownedApprovalIds = new Set<string>();
    const seenSources = new Set<string>();
    const onWaiting = (event: AgentApprovalRequestEvent) => {
      const sourceKey = JSON.stringify([event.subagentId, event.callId]);
      // Re-emission of an already-settled call: respond is idempotent via
      // the runtime's responded set, so silently dropping it is safe.
      if (seenSources.has(sourceKey)) return;
      seenSources.add(sourceKey);
      const parked = this.parkPendingApproval(runId, event);
      if (parked === 'duplicate') return;
      if (parked === 'rejected') {
        this.rejectResponder(event.respond);
        return;
      }
      ownedApprovalIds.add(parked);
    };
    const onResult = (event: AgentToolResultEvent) => {
      this.clearPendingApproval(runId, event.subagentId, event.callId);
    };
    emitter.on(AgentEventType.TOOL_WAITING_APPROVAL, onWaiting);
    emitter.on(AgentEventType.TOOL_RESULT, onResult);
    return () => {
      emitter.off(AgentEventType.TOOL_WAITING_APPROVAL, onWaiting);
      emitter.off(AgentEventType.TOOL_RESULT, onResult);
      this.rejectPendingApprovals(runId, (approval) =>
        ownedApprovalIds.has(approval.approvalId),
      );
    };
  }

  async resolvePendingApproval(
    runId: string,
    approvalId: string,
    outcome: ToolConfirmationOutcome,
    payload?: ToolConfirmationPayload,
  ): Promise<boolean> {
    const entry = this.entries.get(runId);
    if (!entry) return false;
    const approval = entry.pendingApprovals.find(
      (candidate) => candidate.approvalId === approvalId,
    );
    if (!approval) return false;
    const runtime = this.approvalRuntimes.get(approvalId);
    entry.pendingApprovals = entry.pendingApprovals.filter(
      (candidate) => candidate !== approval,
    );
    this.approvalRuntimes.delete(approvalId);
    runtime?.requestController?.abort();
    this.emitApprovalChange(entry);
    if (!runtime) return false;
    const normalized = normalizeWorkflowApprovalOutcome(outcome);
    try {
      await runtime.respond(
        normalized,
        normalized === outcome ? payload : undefined,
      );
    } catch (error) {
      debugLogger.error(
        `Failed to resolve workflow approval ${runId}/${approvalId}:`,
        error,
      );
      this.fail(
        runId,
        `Failed to resolve workflow approval: ${approvalId}`,
        Date.now(),
      );
      try {
        (this.handles.get(runId) ?? entry.abortController).abort();
      } catch (abortError) {
        debugLogger.error(
          'Failed to abort workflow after approval error:',
          abortError,
        );
      }
      return false;
    }
    return true;
  }

  clearPendingApproval(
    runId: string,
    subagentId: string,
    callId: string,
  ): boolean {
    const entry = this.entries.get(runId);
    const approval = entry?.pendingApprovals.find(
      (candidate) =>
        candidate.subagentId === subagentId && candidate.callId === callId,
    );
    if (!entry || !approval) return false;
    entry.pendingApprovals = entry.pendingApprovals.filter(
      (candidate) => candidate !== approval,
    );
    const runtime = this.approvalRuntimes.get(approval.approvalId);
    this.approvalRuntimes.delete(approval.approvalId);
    runtime?.requestController?.abort();
    this.emitApprovalChange(entry);
    return true;
  }

  private parkPendingApproval(
    runId: string,
    event: AgentApprovalRequestEvent,
  ): string | 'duplicate' | 'rejected' {
    const entry = this.entries.get(runId);
    if (
      !entry ||
      !isActiveWorkflowStatus(entry.status) ||
      (!this.approvalChangeCallback && !this.approvalRequestCallback)
    ) {
      debugLogger.warn(
        `Workflow approval rejected for ${runId}/${event.callId}: entry missing, not active, or no host channel`,
      );
      return 'rejected';
    }
    if (
      entry.pendingApprovals.some(
        (approval) =>
          approval.subagentId === event.subagentId &&
          approval.callId === event.callId,
      )
    ) {
      return 'duplicate';
    }
    if (entry.pendingApprovals.length >= MAX_PENDING_WORKFLOW_APPROVALS) {
      debugLogger.warn(
        `Workflow approval rejected for ${runId}/${event.callId}: pending limit (${MAX_PENDING_WORKFLOW_APPROVALS}) reached`,
      );
      return 'rejected';
    }
    const confirmationDetails = restrictWorkflowConfirmationDetails(
      event.confirmationDetails,
    );
    if (
      !confirmationDetails ||
      event.name.length +
        event.description.length +
        JSON.stringify(confirmationDetails).length >
        MAX_WORKFLOW_APPROVAL_DISPLAY_CHARS
    ) {
      debugLogger.warn(
        `Workflow approval rejected for ${runId}/${event.callId}: unsupported type (${event.confirmationDetails.type}) or payload exceeds ${MAX_WORKFLOW_APPROVAL_DISPLAY_CHARS} chars`,
      );
      return 'rejected';
    }
    const approvalId = `wfap_${this.nextApprovalId++}`;
    const approval: WorkflowApproval = {
      approvalId,
      subagentId: event.subagentId,
      callId: event.callId,
      name: event.name,
      description: event.description,
      confirmationDetails,
      at: event.timestamp,
    };
    const approvalRequestCallback = this.approvalRequestCallback;
    const requestController = approvalRequestCallback
      ? new AbortController()
      : undefined;
    this.approvalRuntimes.set(approvalId, {
      respond: event.respond,
      requestController,
    });
    entry.pendingApprovals = [...entry.pendingApprovals, approval];
    this.emitApprovalChange(entry);
    if (
      approvalRequestCallback &&
      requestController &&
      !requestController.signal.aborted
    ) {
      try {
        const request = approvalRequestCallback(
          entry,
          approval,
          event.args,
          requestController.signal,
        );
        void Promise.resolve(request).catch((error) => {
          debugLogger.error('Workflow approval channel failed:', error);
          return this.resolvePendingApproval(
            runId,
            approvalId,
            ToolConfirmationOutcome.Cancel,
          );
        });
      } catch (error) {
        debugLogger.error('Workflow approval channel failed:', error);
        entry.pendingApprovals = entry.pendingApprovals.filter(
          (candidate) => candidate.approvalId !== approvalId,
        );
        this.approvalRuntimes.delete(approvalId);
        requestController.abort();
        this.emitApprovalChange(entry);
        return 'rejected';
      }
    }
    return approvalId;
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
    if (!entry || !isActiveWorkflowStatus(entry.status)) return;
    entry.currentPhase = title;
    const last = entry.phases[entry.phases.length - 1];
    if (last !== title) entry.phases.push(title);
    this.emitStatusChange(entry);
  }

  /** Cumulative dispatch counter — incremented before each `agent()` call resolves. */
  onAgentDispatched(runId: string): void {
    const entry = this.entries.get(runId);
    if (!entry || !isActiveWorkflowStatus(entry.status)) return;
    entry.agentsDispatched++;
    this.emitStatusChange(entry);
  }

  /** Cumulative completion counter — incremented after each `agent()` call settles. */
  onAgentCompleted(runId: string): void {
    const entry = this.entries.get(runId);
    // No status gate: the runner's `finally` aborts the controller after
    // EVERY settlement (completed / failed / cancelled alike), so
    // dispatches in flight at settlement always drain after the terminal
    // status is set — regardless of which terminal it is. Gating the
    // drain to `cancelled` alone froze completed / failed counters
    // mid-drain (e.g. a run that fire-and-forget'd 2 of 5 dispatches
    // permanently showing 3/5 agents). The cap is the only guard needed.
    if (!entry || entry.agentsCompleted >= entry.agentsDispatched) return;
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
    // Symmetric with `onAgentCompleted`: dispatches in flight at
    // settlement still drain afterwards for EVERY terminal status (the
    // runner's `finally` aborts the controller after every settlement,
    // and the production dispatch reports tokens in a `finally`), and
    // their burn keeps mirroring into `tokensSpent` so the live entry's
    // completed-agent count and token total stay consistent. The
    // persisted snapshot and telemetry event are a best-effort
    // projection frozen at settlement — the runner captures both
    // before its first await, ahead of the in-flight drain — so they
    // may read lower than this entry.
    if (!entry) return;
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
    if (!isActiveWorkflowStatus(entry.status) && entry.status !== 'cancelled')
      return;
    const tail = logs.length > 100 ? logs.slice(-100) : Array.from(logs);
    entry.recentLogs = tail;
    this.emitStatusChange(entry);
  }

  complete(runId: string, result: unknown, endTime: number): void {
    const entry = this.entries.get(runId);
    if (!entry || !isActiveWorkflowStatus(entry.status)) return;
    this.rejectPendingApprovals(runId);
    entry.status = 'completed';
    entry.endTime = endTime;
    entry.result = result;
    entry.notified = true;
    this.emitStatusChange(entry);
    this.emitNotification(entry);
    this.emitCompletion(entry);
    this.evictTerminal();
  }

  fail(runId: string, message: string, endTime: number): void {
    const entry = this.entries.get(runId);
    if (!entry || !isActiveWorkflowStatus(entry.status)) return;
    this.rejectPendingApprovals(runId);
    entry.status = 'failed';
    entry.endTime = endTime;
    entry.error = message;
    entry.notified = true;
    this.emitStatusChange(entry);
    this.emitNotification(entry);
    this.emitCompletion(entry);
    this.evictTerminal();
  }

  /**
   * Mark an active entry as cancelled and abort its controller. No-op
   * if the entry has already settled — protects against an explicit
   * dialog cancel racing with the natural complete/fail path.
   */
  cancel(runId: string, endTime: number): void {
    const entry = this.entries.get(runId);
    if (!entry || !isActiveWorkflowStatus(entry.status)) return;
    this.rejectPendingApprovals(runId);
    entry.status = 'cancelled';
    entry.endTime = endTime;
    entry.notified = true;
    try {
      (this.handles.get(runId) ?? entry.abortController).abort();
    } catch (error) {
      debugLogger.error('Failed to abort workflow controller:', error);
    }
    this.emitStatusChange(entry);
    this.evictTerminal();
  }

  get(runId: string): WorkflowTask | undefined {
    return this.entries.get(runId);
  }

  /** All entries (active + terminal, no filter). Iteration order = registration order. */
  list(): WorkflowTask[] {
    return Array.from(this.entries.values());
  }

  /**
   * R7 (wenshao): true if any entry is still actively executing.
   * Mirrors the three sibling registries' `hasUnfinalizedTasks()` /
   * `hasRunningEntries()` / `getRunning().length > 0` so the unified
   * `hasBlockingBackgroundWork()` helper (the gate `/clear` and session-
   * resume both use to refuse a switch with live work) can count
   * workflow runs the same way.
   *
   * R12 (doudouOUC): `paused` deliberately does NOT count. A paused run
   * has drained its dispatches and executes nothing, and its wall-clock
   * watchdog is suspended — if it blocked the switch, a paused-and-
   * forgotten run would block `/clear` and session switching forever
   * with no backstop to release it. Mirrors the sibling
   * `BackgroundTaskRegistry.hasRunningTasks()`, which also counts only
   * `running` (a paused background agent does not block a switch).
   * Session-switch teardown cancels paused runs via `abortAll()` before
   * `reset()` so they settle terminal instead of leaking.
   */
  hasRunningEntries(): boolean {
    for (const entry of this.entries.values()) {
      if (entry.status === 'running' || entry.status === 'pausing') {
        return true;
      }
    }
    return false;
  }

  /**
   * R7 (wenshao): drop every in-memory entry without touching
   * controllers. Mirrors `BackgroundShellRegistry.reset()` and the
   * other siblings' contract — callers (`/clear`, session-resume)
   * MUST verify via `hasRunningEntries()` first that no active
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
    for (const entry of this.entries.values()) {
      this.rejectPendingApprovals(entry.runId);
    }
    for (const runtime of this.approvalRuntimes.values()) {
      runtime.requestController?.abort();
      this.rejectResponder(runtime.respond);
    }
    this.approvalRuntimes.clear();
    this.entries.clear();
    this.handles.clear();
    if (sample) this.emitStatusChange(sample);
  }

  /**
   * R7 (wenshao): cancel every active entry. Called on session/
   * Config shutdown so workflow runs don't outlive the CLI process and
   * leak orphaned dispatches. Symmetric with `BackgroundShellRegistry.
   * abortAll()` and `BackgroundTaskRegistry.abortAll()`.
   *
   * Settles each entry inline (status → 'cancelled', abort the
   * controller) and fires the status-change callback exactly once
   * after the loop — the per-entry `cancel()` path would have fired
   * the callback for every active entry, wasteful on shutdown.
   */
  abortAll(): void {
    const endTime = Date.now();
    let lastCancelled: WorkflowTask | undefined;
    for (const entry of Array.from(this.entries.values())) {
      if (!isActiveWorkflowStatus(entry.status)) continue;
      this.rejectPendingApprovals(entry.runId);
      entry.status = 'cancelled';
      entry.endTime = endTime;
      entry.notified = true;
      try {
        (this.handles.get(entry.runId) ?? entry.abortController).abort();
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
   * Active entries are always retained. Oldest terminal entries
   * (by `endTime`) are evicted first.
   */
  private evictTerminal(): void {
    const terminal = this.list().filter((e) =>
      isTerminalWorkflowStatus(e.status),
    );
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

  private rejectPendingApprovals(
    runId: string,
    predicate: (approval: WorkflowApproval) => boolean = () => true,
  ): void {
    const entry = this.entries.get(runId);
    if (!entry) return;
    const rejected = entry.pendingApprovals.filter(predicate);
    if (rejected.length === 0) return;
    const rejectedIds = new Set(
      rejected.map((approval) => approval.approvalId),
    );
    entry.pendingApprovals = entry.pendingApprovals.filter(
      (approval) => !rejectedIds.has(approval.approvalId),
    );
    const runtimes: WorkflowApprovalRuntime[] = [];
    for (const approvalId of rejectedIds) {
      const runtime = this.approvalRuntimes.get(approvalId);
      this.approvalRuntimes.delete(approvalId);
      if (!runtime) continue;
      runtime.requestController?.abort();
      runtimes.push(runtime);
    }
    this.emitApprovalChange(entry);
    for (const runtime of runtimes) this.rejectResponder(runtime.respond);
  }

  private rejectResponder(respond: AgentApprovalRequestEvent['respond']): void {
    void respond(ToolConfirmationOutcome.Cancel).catch((error) => {
      debugLogger.error('Failed to reject workflow approval:', error);
    });
  }

  private emitApprovalChange(entry: WorkflowTask): void {
    if (!this.approvalChangeCallback) return;
    try {
      this.approvalChangeCallback(entry);
    } catch (error) {
      debugLogger.error('Failed to emit workflow approval change:', error);
    }
  }
}

function stringifyCompletionResult(result: unknown): string {
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result) ?? String(result);
  } catch {
    return `(workflow returned a non-JSON-serializable value of type ${typeof result})`;
  }
}

function normalizeWorkflowApprovalOutcome(
  outcome: ToolConfirmationOutcome,
): ToolConfirmationOutcome {
  return outcome === ToolConfirmationOutcome.ProceedOnce ||
    outcome === ToolConfirmationOutcome.Cancel
    ? outcome
    : ToolConfirmationOutcome.Cancel;
}

function restrictWorkflowConfirmationDetails(
  details: AgentApprovalRequestEvent['confirmationDetails'],
): AgentApprovalRequestEvent['confirmationDetails'] | undefined {
  switch (details.type) {
    case 'edit':
      return {
        type: 'edit',
        title: details.title,
        fileName: details.fileName,
        filePath: details.filePath,
        fileDiff: details.fileDiff,
        originalContent: null,
        newContent: '',
        hideAlwaysAllow: true,
        hideModify: true,
        skipIdeDiff: true,
        warnings: details.warnings ? [...details.warnings] : undefined,
      };
    case 'exec':
      return {
        type: 'exec',
        title: details.title,
        command: details.command,
        rootCommand: details.rootCommand,
        hideAlwaysAllow: true,
        warnings: details.warnings ? [...details.warnings] : undefined,
      };
    case 'mcp':
      return {
        type: 'mcp',
        title: details.title,
        serverName: details.serverName,
        toolName: details.toolName,
        toolDisplayName: details.toolDisplayName,
        hideAlwaysAllow: true,
      };
    case 'info':
      return {
        type: 'info',
        title: details.title,
        prompt: details.prompt,
        renderPromptAsPlainText: details.renderPromptAsPlainText,
        urls: details.urls ? [...details.urls] : undefined,
        hideAlwaysAllow: true,
      };
    case 'plan':
    case 'ask_user_question':
      return undefined;
    default: {
      const _exhaustive: never = details;
      return _exhaustive;
    }
  }
}
