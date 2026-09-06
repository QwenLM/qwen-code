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

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Config } from '../config/config.js';
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
import {
  buildResumeCall,
  hasUninlinableResumeArgs,
  RESUME_ARGS_TOO_LARGE_NOTE,
} from './workflow-resume-call.js';
import { escapeXml, escapeXmlElementText } from '../utils/xml.js';
import { runOutsideAgentContext } from './runtime/agent-context.js';
import type { WorkflowDispatchState } from './runtime/workflow-dispatch-scheduler.js';

const debugLogger = createDebugLogger('WORKFLOW_REGISTRY');

const mutatingWorkflowTasks = new Map<string, symbol>();
const activeWorkflowRunKeys = new Map<string, number>();
const workflowTaskMutationContext = new AsyncLocalStorage<
  ReadonlyMap<string, symbol>
>();
const inMemoryMutationScopeIds = new WeakMap<object, number>();
let nextInMemoryMutationScopeId = 1;

export function getWorkflowTaskMutationKey(
  config: Config,
  taskId: string,
  namespace = 'run',
): string {
  const storage = config.storage as
    | { getWorkflowRunsDir?: () => string }
    | undefined;
  const workflowRunsDir = storage?.getWorkflowRunsDir?.();
  if (workflowRunsDir) {
    return `${workflowRunsDir}\0${namespace}\0${taskId}`;
  }

  const owner = storage ?? config.getWorkflowRunRegistry?.() ?? config;
  let scopeId = inMemoryMutationScopeIds.get(owner);
  if (scopeId === undefined) {
    scopeId = nextInMemoryMutationScopeId++;
    inMemoryMutationScopeIds.set(owner, scopeId);
  }
  return `memory:${scopeId}\0${namespace}\0${taskId}`;
}

export type WorkflowTaskMutationAttempt<T> =
  | { acquired: true; value: T }
  | { acquired: false };

export async function tryWithWorkflowTaskMutation<T>(
  mutationKey: string,
  operation: () => Promise<T>,
): Promise<WorkflowTaskMutationAttempt<T>> {
  const inherited = workflowTaskMutationContext.getStore();
  const inheritedOwner = inherited?.get(mutationKey);
  if (
    inheritedOwner !== undefined &&
    mutatingWorkflowTasks.get(mutationKey) === inheritedOwner
  ) {
    return { acquired: true, value: await operation() };
  }
  if (mutatingWorkflowTasks.has(mutationKey)) return { acquired: false };

  const owner = Symbol(mutationKey);
  mutatingWorkflowTasks.set(mutationKey, owner);
  const context = new Map(inherited);
  context.set(mutationKey, owner);
  try {
    return {
      acquired: true,
      value: await workflowTaskMutationContext.run(context, operation),
    };
  } finally {
    if (mutatingWorkflowTasks.get(mutationKey) === owner) {
      mutatingWorkflowTasks.delete(mutationKey);
    }
  }
}

export function markWorkflowRunPersistenceActive(
  config: Config,
  runId: string,
): () => void {
  const key = getWorkflowTaskMutationKey(config, runId);
  activeWorkflowRunKeys.set(key, (activeWorkflowRunKeys.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = activeWorkflowRunKeys.get(key) ?? 0;
    if (count <= 1) activeWorkflowRunKeys.delete(key);
    else activeWorkflowRunKeys.set(key, count - 1);
  };
}

export function isWorkflowRunPersistenceActive(
  config: Config,
  runId: string,
): boolean {
  const key = getWorkflowTaskMutationKey(config, runId);
  return activeWorkflowRunKeys.has(key) || mutatingWorkflowTasks.has(key);
}

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
export type WorkflowRunStartMode = 'retry' | 'rerun';

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

export type WorkflowDispatchTraceStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'cached';

export interface WorkflowPhaseVisit {
  id: string;
  index: number;
  title: string;
  startedAt: number;
  endedAt?: number;
}

export interface WorkflowDispatchTrace {
  id: string;
  phaseVisitId: string | null;
  label: string;
  prompt: string;
  subagentId?: string;
  status: WorkflowDispatchTraceStatus;
  dependsOn: string[];
  queuedAt: number;
  startedAt?: number;
  endedAt?: number;
  error?: string;
}

export interface WorkflowDispatchQueued {
  id: string;
  label?: string;
  prompt: string;
  dependsOn: string[];
  queuedAt: number;
  cached?: boolean;
}

interface WorkflowEventBase {
  at: number;
}

type WorkflowEventPayload =
  | (WorkflowEventBase & {
      type: 'phase-started';
      phaseVisitId: string;
      title: string;
    })
  | (WorkflowEventBase & {
      type: 'phase-completed';
      phaseVisitId: string;
    })
  | (WorkflowEventBase & {
      type:
        | 'dispatch-queued'
        | 'dispatch-started'
        | 'dispatch-completed'
        | 'dispatch-cancelled'
        | 'dispatch-cached';
      dispatchId: string;
    })
  | (WorkflowEventBase & {
      type: 'dispatch-failed';
      dispatchId: string;
      error: string;
    })
  | (WorkflowEventBase & {
      type: 'log';
      message: string;
    })
  | (WorkflowEventBase & {
      type: 'approval-requested' | 'approval-settled';
      name: string;
      dispatchId?: string;
    })
  | (WorkflowEventBase & {
      type: 'workflow-completed' | 'workflow-cancelled';
    })
  | (WorkflowEventBase & {
      type: 'workflow-failed';
      error: string;
    });

/** Ordered, JSON-safe facts captured while a workflow runs. */
export type WorkflowEvent = WorkflowEventPayload & { id: string };

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
  /** Tool call in the parent session that launched this workflow. */
  toolUseId?: string;
  /** Saved workflow definition name, when this run came from one. */
  workflowName?: string;
  /** Run whose result or journal led to this attempt. */
  sourceRunId?: string;
  /** Whether this attempt reused the journal or started from scratch. */
  startMode?: WorkflowRunStartMode;
  /**
   * Parsed `export const meta = {...}` from the workflow script, or
   * `null` if the script had no meta declaration. The pill / dialog
   * row label falls back to `runId` when meta is null.
   */
  meta: WorkflowMeta | null;
  status: WorkflowStatus;
  /** Whether the tool returned before this run reached a terminal state. */
  isBackgrounded?: boolean;
  /** Whether a model-visible resume may preserve background execution. */
  resumeInBackground?: boolean;
  /** Title of the most recent `phase(...)` call, or `null` before the first phase. */
  currentPhase: string | null;
  /**
   * All phase titles seen so far (deduplicated against the previous
   * entry — matches the sandbox's `safePhase` collapse). Capped at
   * `MAX_PHASE_ENTRIES` (10_000) by the sandbox.
   */
  phases: string[];
  /** Chronological phase entries; unlike `phases`, each revisit has a stable id. */
  phaseVisits: WorkflowPhaseVisit[];
  /** Current phase visit used to associate newly-issued dispatches. */
  currentPhaseVisitId: string | null;
  /** Dispatch-level execution graph for live UI consumers. */
  dispatches: WorkflowDispatchTrace[];
  /** Cumulative `agent()` dispatches issued by this run. */
  agentsDispatched: number;
  /** Cumulative `agent()` dispatches that have resolved (success or thrown). */
  agentsCompleted: number;
  /** Most recent log lines from the sandbox's `getLogs()`. Capped at 100 for the UI. */
  recentLogs: string[];
  /** Ordered runtime facts used to replay this run after it settles. */
  events: WorkflowEvent[];
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
  /** Original structured arguments, retained so a failed run can resume the same journal prefix. */
  args?: unknown;
  /**
   * The loaded saved-workflow path or the persisted copy of an inline script.
   * `undefined` only when an inline script could not be persisted.
   */
  scriptPath?: string;
  /**
   * This run's resume journal (`<projectDir>/workflows/<runId>/journal.jsonl`),
   * when the config had a `storage` to hold one. Recorded so the terminal
   * notification can point the model at the per-agent results without
   * reconstructing the path from a storage handle it does not have.
   */
  journalPath?: string;
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
  | 'phaseVisits'
  | 'currentPhaseVisitId'
  | 'dispatches'
  | 'agentsDispatched'
  | 'agentsCompleted'
  | 'recentLogs'
  | 'events'
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

/**
 * Fires when the runner has safely persisted a terminal run's snapshot to
 * the shared store. The owning session uses this to retire its
 * unpersisted history cache: once the run exists on disk, absence from
 * the store means a deletion happened, not "not written yet".
 */
export type WorkflowSnapshotPersistedCallback = (runId: string) => void;

interface WorkflowApprovalRuntime {
  respond: AgentApprovalRequestEvent['respond'];
  requestController?: AbortController;
  releaseSource: () => void;
}

export class WorkflowRunRegistry {
  private readonly entries = new Map<string, WorkflowTask>();
  private readonly handles = new Map<string, WorkflowRunHandle>();
  private readonly starting = new Map<string, AbortController>();

  private registerCallback: WorkflowRunRegisterCallback | undefined;
  private statusChangeCallback: WorkflowRunStatusChangeCallback | undefined;
  private notificationCallback: WorkflowRunNotificationCallback | undefined;
  private completionCallback: WorkflowRunCompletionCallback | undefined;
  private approvalChangeCallback: WorkflowApprovalChangeCallback | undefined;
  private approvalRequestCallback: WorkflowApprovalRequestCallback | undefined;
  private snapshotPersistedCallback:
    | WorkflowSnapshotPersistedCallback
    | undefined;
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

  clearStatusChangeCallback(cb: WorkflowRunStatusChangeCallback): void {
    if (this.statusChangeCallback === cb) this.statusChangeCallback = undefined;
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

  setSnapshotPersistedCallback(
    cb: WorkflowSnapshotPersistedCallback | undefined,
  ): void {
    this.snapshotPersistedCallback = cb;
  }

  /** Called by the runner once a terminal run's snapshot is persisted. */
  notifySnapshotPersisted(runId: string): void {
    if (!this.snapshotPersistedCallback) return;
    try {
      this.snapshotPersistedCallback(runId);
    } catch (error) {
      debugLogger.error('Failed to notify snapshot persistence:', error);
    }
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
    // What the run cost, so the model can size the next fan-out against a
    // number instead of a guess. `agents_cached` is the resume-relevant half:
    // a resumed run whose agents all replayed spent nothing and proves it here.
    modelParts.push(`<usage>${escapeXml(buildUsageLine(entry))}</usage>`);
    // The two recovery routes a backgrounded run needs and cannot reconstruct:
    // a failure needs the resume call (the script is on disk, editable before
    // the retry); a success needs the journal, because an empty-looking result
    // is far more often a script that dropped its values than a fan-out that
    // produced none.
    const recovery =
      entry.status === 'failed'
        ? buildRecoveryLines(entry)
        : buildDiagnosticsLines(entry);
    if (recovery.length > 0) {
      const tag = entry.status === 'failed' ? 'recovery' : 'diagnostics';
      modelParts.push(
        `<${tag}>${escapeXmlElementText(recovery.join('\n'))}</${tag}>`,
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
   * Hold a run id for a workflow whose start is still in flight — the
   * runner reserves before it loads the script and replays the journal,
   * and only `register`s once both succeeded. The reservation is what
   * makes the id visible to liveness and cancel checks during that
   * window; the returned controller is the run's own.
   */
  reserveStart(
    runId: string,
    createController: () => AbortController,
  ): AbortController {
    const existing = this.entries.get(runId);
    if (
      (existing && isActiveWorkflowStatus(existing.status)) ||
      this.handles.has(runId) ||
      this.starting.has(runId)
    ) {
      throw new Error(`Workflow run ${runId} is already active.`);
    }
    const controller = createController();
    this.starting.set(runId, controller);
    return controller;
  }

  releaseStart(runId: string, controller: AbortController): void {
    if (this.starting.get(runId) === controller) this.starting.delete(runId);
  }

  isStarting(runId: string): boolean {
    return this.starting.has(runId);
  }

  /**
   * Run ids reserved by `reserveStart` and not yet registered. A session
   * reports these as active-work holds: `list()` has no entry for the
   * starting window, and a daemon that judged the session idle from
   * `list()` alone would close it and abort the start under the client
   * that just asked for it.
   */
  listStartingRunIds(): string[] {
    return [...this.starting.keys()];
  }

  /**
   * Cancel a run that has been reserved but not yet registered. Aborts
   * the reserved controller only — the reservation itself is the
   * runner's to release, in its start-failure path, exactly as after
   * `abortAll`. Returns `false` when nothing is starting under `runId`,
   * so a caller can fall through to the registered-entry route.
   */
  cancelStarting(runId: string): boolean {
    const controller = this.starting.get(runId);
    if (!controller) return false;
    try {
      controller.abort();
    } catch (error) {
      debugLogger.error('Failed to abort a starting workflow:', error);
    }
    return true;
  }

  /**
   * Register a new run. Mutates the registration in place to graduate
   * it to a `WorkflowTask` (sets `id`, `kind`, derived counters), so
   * callers can keep using their local reference post-register and
   * observers see updates without an extra `get()`.
   */
  register(
    registration: WorkflowTaskRegistration,
    startController?: AbortController,
  ): WorkflowTask {
    const existing = this.entries.get(registration.runId);
    const reservedController = this.starting.get(registration.runId);
    if (
      (existing && isActiveWorkflowStatus(existing.status)) ||
      this.handles.has(registration.runId) ||
      (reservedController !== undefined &&
        reservedController !== startController)
    ) {
      throw new Error(`Workflow run ${registration.runId} is already active.`);
    }
    if (reservedController === startController) {
      this.starting.delete(registration.runId);
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
    entry.phaseVisits = [];
    entry.currentPhaseVisitId = null;
    entry.dispatches = [];
    entry.agentsDispatched = 0;
    entry.agentsCompleted = 0;
    entry.recentLogs = [];
    entry.events = [];
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
    if (this.handles.get(runId) !== handle) return;
    this.handles.delete(runId);
    this.evictTerminal();
  }

  bridgeApprovalEvents(
    runId: string,
    emitter: AgentEventEmitter,
    dispatchId?: string,
    expectedEntry?: WorkflowTask,
  ): () => void {
    const ownedApprovalIds = new Set<string>();
    const seenSources = new Set<string>();
    const isCurrentEntry = () =>
      expectedEntry === undefined || this.entries.get(runId) === expectedEntry;
    const onWaiting = (event: AgentApprovalRequestEvent) => {
      if (!isCurrentEntry()) return;
      if (dispatchId) {
        const dispatch = this.entries
          .get(runId)
          ?.dispatches.find(({ id }) => id === dispatchId);
        if (dispatch) dispatch.subagentId = event.subagentId;
      }
      const sourceKey = JSON.stringify([event.subagentId, event.callId]);
      if (seenSources.has(sourceKey)) {
        debugLogger.warn(
          `Workflow approval re-emission dropped (source still latched): ${runId}/${sourceKey}`,
        );
        return;
      }
      seenSources.add(sourceKey);
      const parked = this.parkPendingApproval(runId, event, dispatchId, () =>
        seenSources.delete(sourceKey),
      );
      if (parked === 'duplicate') {
        seenSources.delete(sourceKey);
        return;
      }
      if (parked === 'rejected') {
        seenSources.delete(sourceKey);
        this.rejectResponder(event.respond);
        return;
      }
      ownedApprovalIds.add(parked);
    };
    const onResult = (event: AgentToolResultEvent) => {
      if (!isCurrentEntry()) return;
      this.clearPendingApproval(
        runId,
        event.subagentId,
        event.callId,
        event.timestamp,
      );
    };
    emitter.on(AgentEventType.TOOL_WAITING_APPROVAL, onWaiting);
    emitter.on(AgentEventType.TOOL_RESULT, onResult);
    return () => {
      emitter.off(AgentEventType.TOOL_WAITING_APPROVAL, onWaiting);
      emitter.off(AgentEventType.TOOL_RESULT, onResult);
      if (!isCurrentEntry()) return;
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
    this.appendApprovalEvent(entry, approval, 'approval-settled', Date.now());
    entry.pendingApprovals = entry.pendingApprovals.filter(
      (candidate) => candidate !== approval,
    );
    const runtime = this.releaseApprovalRuntime(approvalId);
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
    at = Date.now(),
  ): boolean {
    const entry = this.entries.get(runId);
    const approval = entry?.pendingApprovals.find(
      (candidate) =>
        candidate.subagentId === subagentId && candidate.callId === callId,
    );
    if (!entry || !approval) return false;
    this.appendApprovalEvent(entry, approval, 'approval-settled', at);
    entry.pendingApprovals = entry.pendingApprovals.filter(
      (candidate) => candidate !== approval,
    );
    this.releaseApprovalRuntime(approval.approvalId);
    this.emitApprovalChange(entry);
    return true;
  }

  private parkPendingApproval(
    runId: string,
    event: AgentApprovalRequestEvent,
    dispatchId: string | undefined,
    releaseSource: () => void,
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
      releaseSource,
    });
    entry.pendingApprovals = [...entry.pendingApprovals, approval];
    this.appendEvent(entry, {
      type: 'approval-requested',
      at: approval.at,
      name: approval.name,
      ...(dispatchId ? { dispatchId } : {}),
    });
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
        this.appendApprovalEvent(
          entry,
          approval,
          'approval-settled',
          Date.now(),
        );
        entry.pendingApprovals = entry.pendingApprovals.filter(
          (candidate) => candidate.approvalId !== approvalId,
        );
        this.releaseApprovalRuntime(approvalId);
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
   * @param runId    the run to update
   * @param rawTitle the phase title from the sandbox `phase()` call
   */
  onPhaseStarted(runId: string, rawTitle: string, at = Date.now()): void {
    const entry = this.entries.get(runId);
    if (!entry || !isActiveWorkflowStatus(entry.status)) return;
    // Script-derived titles reach persisted snapshots and TUI rendering:
    // normalize at this registry boundary like every sibling string.
    const title = stripAnsiAndControl(rawTitle).slice(0, 200) || 'phase';
    entry.currentPhase = title;
    const last = entry.phases[entry.phases.length - 1];
    if (last !== title) {
      entry.phases.push(title);
      const priorVisit = entry.phaseVisits[entry.phaseVisits.length - 1];
      if (priorVisit && priorVisit.endedAt === undefined) {
        this.closeCurrentPhase(entry, at);
      }
      const index = entry.phaseVisits.length;
      const visit: WorkflowPhaseVisit = {
        id: `phase-${index + 1}`,
        index,
        title,
        startedAt: at,
      };
      entry.phaseVisits.push(visit);
      entry.currentPhaseVisitId = visit.id;
      this.appendEvent(entry, {
        type: 'phase-started',
        at,
        phaseVisitId: visit.id,
        title,
      });
    }
    this.emitStatusChange(entry);
  }

  onDispatchQueued(runId: string, event: WorkflowDispatchQueued): void {
    const entry = this.entries.get(runId);
    if (!entry || !isActiveWorkflowStatus(entry.status)) return;
    if (entry.dispatches.some((dispatch) => dispatch.id === event.id)) return;
    const fallbackLabel = `Agent ${entry.dispatches.length + 1}`;
    entry.dispatches.push({
      id: event.id,
      phaseVisitId: entry.currentPhaseVisitId,
      label:
        stripAnsiAndControl(event.label ?? '').slice(0, 200) || fallbackLabel,
      prompt: stripAnsiAndControl(event.prompt).slice(0, 4_096),
      status: event.cached ? 'cached' : 'queued',
      dependsOn: Array.from(new Set(event.dependsOn)).filter((id) =>
        entry.dispatches.some((dispatch) => dispatch.id === id),
      ),
      queuedAt: event.queuedAt,
      ...(event.cached ? { endedAt: event.queuedAt } : {}),
    });
    this.appendEvent(entry, {
      type: 'dispatch-queued',
      at: event.queuedAt,
      dispatchId: event.id,
    });
    if (event.cached) {
      this.appendEvent(entry, {
        type: 'dispatch-cached',
        at: event.queuedAt,
        dispatchId: event.id,
      });
    }
    this.emitStatusChange(entry);
  }

  onDispatchStarted(runId: string, dispatchId: string, at = Date.now()): void {
    const entry = this.entries.get(runId);
    const dispatch = entry?.dispatches.find(({ id }) => id === dispatchId);
    if (!entry || !dispatch || dispatch.status !== 'queued') return;
    dispatch.status = 'running';
    dispatch.startedAt = at;
    this.appendEvent(entry, {
      type: 'dispatch-started',
      at,
      dispatchId,
    });
    this.emitStatusChange(entry);
  }

  onDispatchSettled(
    runId: string,
    dispatchId: string,
    error?: string,
    at = Date.now(),
    cancelRequested = false,
  ): void {
    const entry = this.entries.get(runId);
    const dispatch = entry?.dispatches.find(({ id }) => id === dispatchId);
    if (!entry || !dispatch || dispatch.endedAt !== undefined) return;
    const shouldRecordEvent = isActiveWorkflowStatus(entry.status);
    dispatch.status =
      entry.status === 'cancelled' || cancelRequested
        ? 'cancelled'
        : error !== undefined
          ? 'failed'
          : dispatch.status === 'cached'
            ? 'cached'
            : 'completed';
    dispatch.endedAt = at;
    if (error !== undefined && dispatch.status !== 'cancelled')
      dispatch.error = stripAnsiAndControl(error).slice(0, 4_096);
    if (!shouldRecordEvent) {
      this.emitStatusChange(entry);
      return;
    }
    if (dispatch.status === 'failed') {
      this.appendEvent(entry, {
        type: 'dispatch-failed',
        at,
        dispatchId,
        error: dispatch.error || 'Dispatch failed.',
      });
    } else {
      this.appendEvent(entry, {
        type:
          dispatch.status === 'cached'
            ? 'dispatch-cached'
            : dispatch.status === 'cancelled'
              ? 'dispatch-cancelled'
              : 'dispatch-completed',
        at,
        dispatchId,
      });
    }
    this.emitStatusChange(entry);
  }

  /** Record one sandbox log line without forcing a TUI redraw per line. */
  onLogAppended(runId: string, line: string, at = Date.now()): void {
    const entry = this.entries.get(runId);
    // Mirrors setRecentLogs's 'cancelled' allowance: a dialog cancel flips
    // the status before the sandbox's run-end flush fires its last mirror
    // lines, and the two persisted log projections must keep agreeing.
    if (
      !entry ||
      (!isActiveWorkflowStatus(entry.status) && entry.status !== 'cancelled')
    )
      return;
    const message = stripAnsiAndControl(line).slice(0, 4_096);
    if (entry.recentLogs.length === 100) {
      entry.recentLogs.shift();
      const firstLog = entry.events.findIndex((event) => event.type === 'log');
      if (firstLog >= 0) entry.events.splice(firstLog, 1);
    }
    entry.recentLogs.push(message);
    this.appendEvent(entry, { type: 'log', at, message });
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
    entry.recentLogs = tail.map((line) =>
      stripAnsiAndControl(line).slice(0, 4_096),
    );
    // The sandbox buffer tail is the run's final log account: nested merges
    // reach it via appendLog without re-emitting, and the overflow sentinel
    // can be pushed without emission, so the live-mirrored 'log' window can
    // disagree with it in membership AND order. Rebuild the window from the
    // same tail so the two persisted log projections keep agreeing.
    entry.events = entry.events.filter((event) => event.type !== 'log');
    for (const message of entry.recentLogs) {
      this.appendEvent(entry, { type: 'log', at: Date.now(), message });
    }
    this.emitStatusChange(entry);
  }

  complete(runId: string, result: unknown, endTime: number): void {
    const entry = this.entries.get(runId);
    if (!entry || !isActiveWorkflowStatus(entry.status)) return;
    this.rejectPendingApprovals(runId, undefined, endTime);
    entry.status = 'completed';
    entry.endTime = endTime;
    this.closeCurrentPhase(entry, endTime);
    this.cancelLiveDispatches(entry, endTime);
    entry.result = result;
    this.appendEvent(entry, { type: 'workflow-completed', at: endTime });
    entry.notified = true;
    this.emitStatusChange(entry);
    this.emitNotification(entry);
    this.emitCompletion(entry);
    this.evictTerminal();
  }

  fail(runId: string, message: string, endTime: number): void {
    const entry = this.entries.get(runId);
    if (!entry || !isActiveWorkflowStatus(entry.status)) return;
    this.rejectPendingApprovals(runId, undefined, endTime);
    entry.status = 'failed';
    entry.endTime = endTime;
    this.closeCurrentPhase(entry, endTime);
    this.cancelLiveDispatches(entry, endTime);
    // Script-derived failure text rides into the snapshot, the /workflows
    // render, and the completion-notification XML: normalize it once at
    // this boundary and persist the same string in both projections.
    entry.error = stripAnsiAndControl(message).slice(0, 4_096);
    this.appendEvent(entry, {
      type: 'workflow-failed',
      at: endTime,
      error: entry.error,
    });
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
    this.rejectPendingApprovals(runId, undefined, endTime);
    entry.status = 'cancelled';
    entry.endTime = endTime;
    this.closeCurrentPhase(entry, endTime);
    this.cancelLiveDispatches(entry, endTime);
    this.appendEvent(entry, { type: 'workflow-cancelled', at: endTime });
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

  removeTerminal(runId: string): boolean {
    const entry = this.entries.get(runId);
    if (
      !entry ||
      !isTerminalWorkflowStatus(entry.status) ||
      this.handles.has(runId)
    ) {
      return false;
    }
    this.rejectPendingApprovals(runId);
    this.entries.delete(runId);
    this.emitStatusChange();
    return true;
  }

  setLineage(
    runId: string,
    sourceRunId: string,
    startMode: WorkflowRunStartMode,
  ): boolean {
    const entry = this.entries.get(runId);
    if (!entry) return false;
    entry.sourceRunId = sourceRunId;
    entry.startMode = startMode;
    this.emitStatusChange(entry);
    return true;
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
    if (this.starting.size > 0) return true;
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
    for (const approvalId of Array.from(this.approvalRuntimes.keys())) {
      const runtime = this.releaseApprovalRuntime(approvalId);
      if (runtime) this.rejectResponder(runtime.respond);
    }
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
    for (const controller of this.starting.values()) {
      controller.abort();
    }
    for (const entry of Array.from(this.entries.values())) {
      if (!isActiveWorkflowStatus(entry.status)) continue;
      this.rejectPendingApprovals(entry.runId, undefined, endTime);
      entry.status = 'cancelled';
      entry.endTime = endTime;
      this.closeCurrentPhase(entry, endTime);
      this.cancelLiveDispatches(entry, endTime);
      this.appendEvent(entry, { type: 'workflow-cancelled', at: endTime });
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

  private closeCurrentPhase(entry: WorkflowTask, endTime: number): void {
    const current = entry.phaseVisits[entry.phaseVisits.length - 1];
    if (current && current.endedAt === undefined) {
      current.endedAt = endTime;
      this.appendEvent(entry, {
        type: 'phase-completed',
        at: endTime,
        phaseVisitId: current.id,
      });
    }
  }

  private cancelLiveDispatches(entry: WorkflowTask, endTime: number): void {
    for (const dispatch of entry.dispatches) {
      if (dispatch.status !== 'queued' && dispatch.status !== 'running') {
        continue;
      }
      dispatch.status = 'cancelled';
      dispatch.endedAt = endTime;
      this.appendEvent(entry, {
        type: 'dispatch-cancelled',
        at: endTime,
        dispatchId: dispatch.id,
      });
    }
  }

  private appendEvent(
    entry: WorkflowTask,
    payload: WorkflowEventPayload,
  ): void {
    const lastId = entry.events.at(-1)?.id;
    const nextId = lastId ? Number(lastId.slice('event-'.length)) + 1 : 1;
    entry.events.push({
      id: `event-${nextId}`,
      ...payload,
    });
  }

  private appendApprovalEvent(
    entry: WorkflowTask,
    approval: WorkflowApproval,
    type: 'approval-requested' | 'approval-settled',
    at: number,
  ): void {
    const dispatchId = entry.dispatches.find(
      (dispatch) => dispatch.subagentId === approval.subagentId,
    )?.id;
    this.appendEvent(entry, {
      type,
      at,
      name: approval.name,
      ...(dispatchId ? { dispatchId } : {}),
    });
  }

  /**
   * Sweep terminal entries when they exceed `MAX_RETAINED_TERMINAL_WORKFLOWS`.
   * Active entries are always retained. Oldest terminal entries
   * (by `endTime`) are evicted first.
   */
  private evictTerminal(): void {
    const terminal = this.list().filter(
      (entry) =>
        isTerminalWorkflowStatus(entry.status) &&
        !this.handles.has(entry.runId),
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
    // Eviction is a row-removing mutation like every other one, and the
    // consumers that render these rows (tasks dialog, `/workflows`
    // roster) re-read the registry only when a status change is
    // emitted. Two paths reach here without a usable emission:
    // `releaseHandle` emits nothing of its own, and complete / fail /
    // cancel / abortAll emit BEFORE sweeping, so a synchronous consumer
    // reads the pre-eviction list. Either way the roster kept showing
    // an evicted row until some unrelated status change fired. Emit
    // once here, after the sweep, so every eviction converges on its
    // own — and so a future eviction site inherits the guarantee
    // instead of having to remember it.
    this.emitStatusChange();
  }

  private emitStatusChange(entry?: WorkflowTask): void {
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
    at = Date.now(),
  ): void {
    const entry = this.entries.get(runId);
    if (!entry) return;
    const rejected = entry.pendingApprovals.filter(predicate);
    if (rejected.length === 0) return;
    const rejectedIds = new Set(
      rejected.map((approval) => approval.approvalId),
    );
    for (const approval of rejected) {
      this.appendApprovalEvent(entry, approval, 'approval-settled', at);
    }
    entry.pendingApprovals = entry.pendingApprovals.filter(
      (approval) => !rejectedIds.has(approval.approvalId),
    );
    const runtimes: WorkflowApprovalRuntime[] = [];
    for (const approvalId of rejectedIds) {
      const runtime = this.releaseApprovalRuntime(approvalId);
      if (!runtime) continue;
      runtimes.push(runtime);
    }
    this.emitApprovalChange(entry);
    for (const runtime of runtimes) this.rejectResponder(runtime.respond);
  }

  private releaseApprovalRuntime(
    approvalId: string,
  ): WorkflowApprovalRuntime | undefined {
    const runtime = this.approvalRuntimes.get(approvalId);
    if (!runtime) return undefined;
    this.approvalRuntimes.delete(approvalId);
    runtime.releaseSource();
    runtime.requestController?.abort();
    return runtime;
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

/** Flat `key=value` usage line for the terminal notification. */
function buildUsageLine(entry: WorkflowTask): string {
  const countByStatus = (status: WorkflowDispatchTraceStatus): number =>
    entry.dispatches.reduce((n, d) => (d.status === status ? n + 1 : n), 0);
  // A run that never settled its end time reads as zero elapsed rather than
  // as a negative duration computed against `Date.now()`.
  const durationMs = Math.max(
    0,
    (entry.endTime ?? entry.startTime) - entry.startTime,
  );
  return [
    `agents_dispatched=${entry.dispatches.length}`,
    `agents_succeeded=${countByStatus('completed')}`,
    `agents_cached=${countByStatus('cached')}`,
    `agents_failed=${countByStatus('failed')}`,
    `agents_cancelled=${countByStatus('cancelled')}`,
    `tokens_spent=${entry.tokensSpent}`,
    `duration_ms=${durationMs}`,
  ].join(' ');
}

/** `<recovery>` body for a failed run. */
function buildRecoveryLines(entry: WorkflowTask): string[] {
  const lines: string[] = [];
  const resume = buildResumeCall(entry);
  if (resume) {
    const pathAdvice = entry.workflowName
      ? `This reads the saved /${entry.workflowName} workflow; copy it before making a run-specific change.`
      : 'Edit the generated script copy first if the script needs to change.';
    const journalAdvice = entry.journalPath
      ? 'The journal replays the longest unchanged prefix of agent() calls; the first changed call onward runs live.'
      : 'No journal was written for this run, so every agent() call runs live.';
    lines.push(`Resume: ${resume} — ${pathAdvice} ${journalAdvice}`);
    if (hasUninlinableResumeArgs(entry)) {
      lines.push(RESUME_ARGS_TOO_LARGE_NOTE);
    }
  }
  if (entry.journalPath) {
    lines.push(`Journal: ${stripAnsiAndControl(entry.journalPath)}`);
  }
  return lines;
}

/** `<diagnostics>` body for a completed run. */
function buildDiagnosticsLines(entry: WorkflowTask): string[] {
  const lines: string[] = [];
  if (entry.journalPath) {
    lines.push(
      `Per-agent results: ${stripAnsiAndControl(entry.journalPath)} — one {"type":"result",...} line per completed agent with its full return value. If the result above is empty or unexpected, read this file BEFORE diagnosing.`,
    );
  }
  const resume = buildResumeCall(entry);
  if (resume) {
    lines.push(
      entry.workflowName
        ? `Re-run the saved /${entry.workflowName} workflow: ${resume}`
        : `Re-run after editing the generated script: ${resume}`,
    );
    if (hasUninlinableResumeArgs(entry)) {
      lines.push(RESUME_ARGS_TOO_LARGE_NOTE);
    }
  }
  return lines;
}
