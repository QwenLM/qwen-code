/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import type { Config } from '../../config/config.js';
import { logWorkflowRun } from '../../telemetry/loggers.js';
import { WorkflowRunEvent } from '../../telemetry/types.js';
import {
  createAbortController,
  createChildAbortController,
} from '../../utils/abortController.js';
import {
  getWorkflowTaskMutationKey,
  isTerminalWorkflowStatus,
  tryWithWorkflowTaskMutation,
  type WorkflowRunRegistry,
  type WorkflowTask,
} from '../workflow-run-registry.js';
import { writeWorkflowSnapshot } from '../workflow-snapshot.js';
import {
  createProductionDispatch,
  resolveConcurrencyLimit,
  WorkflowExecutionError,
  WorkflowOrchestrator,
  type WorkflowAgentDispatch,
  type WorkflowOrchestratorEmitter,
  type WorkflowRunOutcome,
} from './workflow-orchestrator.js';
import { WorkflowBudgetImpl } from './workflow-budget.js';
import { WorkflowDispatchScheduler } from './workflow-dispatch-scheduler.js';
import { WorkflowJournal, type JournalReplay } from './workflow-journal.js';
import { resolveSavedWorkflowScript } from './workflow-saved.js';
import {
  compileWorkflowScript,
  describeWorkflowCompileError,
} from './workflow-sandbox.js';

export interface WorkflowRunnerOptions {
  config: Config;
  signal: AbortSignal;
  toolUseId?: string;
  workflowName?: string;
  script?: string;
  scriptPath?: string;
  args: unknown;
  resumeFromRunId?: string;
  dispatch?: WorkflowAgentDispatch;
  onUpdate?: (entry: WorkflowTask) => void;
  runInBackground?: boolean;
}

export type WorkflowRunSettlement =
  | { ok: true; outcome: WorkflowRunOutcome }
  | { ok: false; message: string; details?: WorkflowExecutionError };

export class WorkflowRunHandle {
  readonly completion: Promise<WorkflowRunSettlement>;

  constructor(
    readonly runId: string,
    readonly budget: WorkflowBudgetImpl,
    readonly registry: WorkflowRunRegistry | undefined,
    private readonly controller: AbortController,
    private readonly scheduler: WorkflowDispatchScheduler,
    start: () => Promise<WorkflowRunSettlement>,
  ) {
    this.completion = Promise.resolve().then(start);
  }

  abort(): void {
    this.controller.abort();
  }

  pause(): boolean {
    return this.scheduler.pause();
  }

  resume(): boolean {
    return this.scheduler.resume();
  }
}

/**
 * The script never compiled, so no run was created.
 *
 * Distinct from `WorkflowExecutionError` on purpose: that one describes a run
 * that existed and failed, and callers report it as such. This one means there
 * is nothing to report on — no runId, no journal, no registry entry, no
 * snapshot — and the caller should say the workflow was not launched rather
 * than that it failed.
 */
export class WorkflowScriptNotLaunchedError extends Error {
  constructor(readonly detail: string) {
    super(
      `Workflow script is invalid and was not launched:\n${detail}\n\n` +
        `Workflow scripts must be plain JavaScript — the usual causes are ` +
        `TypeScript syntax (type annotations, interfaces, generics) and ` +
        `broken string quoting or escaping. Metadata must use literal values.`,
    );
    this.name = 'WorkflowScriptNotLaunchedError';
  }
}

/**
 * A start that was cancelled before it registered — a background start by
 * the caller's signal, or a start in either mode by
 * `WorkflowRunRegistry.cancelStarting` / `abortAll` aborting the run's own
 * controller while the caller's signal stayed live. The second source is
 * why this is a class and not a bare `Error`: the tool cannot tell it from
 * a genuine start failure by looking at the caller's signal, and would
 * otherwise surface "cancelled" as an unexplained error.
 */
export class WorkflowStartCancelledError extends Error {
  constructor() {
    super('Workflow start was cancelled.');
    this.name = 'WorkflowStartCancelledError';
  }
}

export class WorkflowRunner {
  static async start(
    options: WorkflowRunnerOptions,
  ): Promise<WorkflowRunHandle> {
    if (options.resumeFromRunId) {
      const attempt = await tryWithWorkflowTaskMutation(
        getWorkflowTaskMutationKey(options.config, options.resumeFromRunId),
        () => this.startClaimed(options),
      );
      if (!attempt.acquired) {
        throw new Error(
          `Workflow run ${options.resumeFromRunId} is already being modified.`,
        );
      }
      return attempt.value;
    }
    return this.startClaimed(options);
  }

  private static async startClaimed(
    options: WorkflowRunnerOptions,
  ): Promise<WorkflowRunHandle> {
    const config = options.config;
    const runInBackground = options.runInBackground === true;
    const budget = WorkflowBudgetImpl.fromEnv();
    const runId =
      options.resumeFromRunId ?? `wf_${randomBytes(8).toString('hex')}`;
    const registry = config.getWorkflowRunRegistry?.();
    let entry: WorkflowTask | undefined;
    const isCurrentEntry = (): boolean =>
      registry === undefined ||
      (entry !== undefined && registry.get(runId) === entry);
    const createController = () =>
      runInBackground
        ? createAbortController()
        : createChildAbortController(options.signal);
    const controller = registry
      ? registry.reserveStart(runId, createController)
      : createController();
    const storage = config.storage;
    const journal = storage
      ? new WorkflowJournal(storage.getWorkflowRunJournalPath(runId))
      : undefined;
    let script: string;
    let scriptPath: string | undefined;
    let resumeReplay: JournalReplay | undefined;
    let callerWasAbortedBeforeStart: boolean;
    let orchestrator: WorkflowOrchestrator;
    try {
      const loaded =
        options.scriptPath && options.script === undefined
          ? await resolveSavedWorkflowScript(
              { scriptPath: options.scriptPath },
              config,
            )
          : undefined;
      script = loaded?.script ?? options.script ?? '';
      scriptPath = loaded?.scriptPath ?? options.scriptPath;
      const workflowName = options.workflowName ?? loaded?.savedWorkflowName;

      try {
        compileWorkflowScript(script);
      } catch (error) {
        throw new WorkflowScriptNotLaunchedError(
          describeWorkflowCompileError(
            error,
            script.split(/\r\n|[\n\r\u2028\u2029]/).length,
          ),
        );
      }

      resumeReplay = options.resumeFromRunId
        ? await journal?.load()
        : undefined;
      // A registry-side cancel (`cancelStarting`, `abortAll`) aborts the
      // reserved controller while the caller's signal stays live. It is a
      // cancel in either mode: registering anyway would let the settlement
      // classifier — which only knows the caller's signal and the entry's
      // status — record the run as failed, or completed for a dispatch-free
      // script, under a client that was just told `{cancelled: true}`.
      if (controller.signal.aborted && !options.signal.aborted) {
        throw new WorkflowStartCancelledError();
      }
      // The caller's own abort is reported the same way for a background
      // start; a foreground start registers and settles `cancelled` so the
      // caller's tool result carries the run it asked for.
      if (runInBackground && options.signal.aborted) {
        throw new WorkflowStartCancelledError();
      }
      callerWasAbortedBeforeStart = options.signal.aborted;
      const dispatch =
        options.dispatch ??
        createProductionDispatch(
          config,
          controller.signal,
          (outputTokens) => budget.recordSpent(outputTokens),
          registry
            ? (emitter, dispatchId) =>
                isCurrentEntry()
                  ? registry.bridgeApprovalEvents(
                      runId,
                      emitter,
                      dispatchId,
                      entry,
                    )
                  : () => undefined
            : undefined,
        );
      orchestrator = new WorkflowOrchestrator(dispatch);
      entry = registry?.register(
        {
          runId,
          toolUseId: options.toolUseId,
          ...(workflowName ? { workflowName } : {}),
          meta: null,
          status: 'running',
          startTime: Date.now(),
          outputFile: '',
          abortController: controller,
          tokenBudgetTotal: budget.total,
          script,
          scriptPath,
          args: options.args,
          ...(options.resumeFromRunId
            ? {
                sourceRunId: options.resumeFromRunId,
                startMode: 'retry' as const,
              }
            : {}),
          isBackgrounded: runInBackground,
        },
        controller,
      );
    } catch (error) {
      registry?.releaseStart(runId, controller);
      controller.abort();
      throw error;
    }
    const emitUpdate = (): void => {
      if (!entry || !options.onUpdate || !isCurrentEntry()) return;
      try {
        options.onUpdate(entry);
      } catch {
        // UI refresh failures must not affect workflow execution.
      }
    };
    const emitter: WorkflowOrchestratorEmitter = {
      phaseStarted: (title) => {
        if (!isCurrentEntry()) return;
        registry?.onPhaseStarted(runId, title);
        emitUpdate();
      },
      agentDispatched: () => {
        if (!isCurrentEntry()) return;
        registry?.onAgentDispatched(runId);
        emitUpdate();
      },
      agentCompleted: () => {
        if (!isCurrentEntry()) return;
        // No emitUpdate: budgetUpdated fires right after and renders both
        // updates together (avoids 2x TUI redraws per agent).
        registry?.onAgentCompleted(runId);
      },
      dispatchQueued: (event) => {
        if (!isCurrentEntry()) return;
        registry?.onDispatchQueued(runId, event);
        emitUpdate();
      },
      dispatchStarted: (dispatchId, startedAt) => {
        if (!isCurrentEntry()) return;
        registry?.onDispatchStarted(runId, dispatchId, startedAt);
        emitUpdate();
      },
      dispatchSettled: (dispatchId, error, endedAt) => {
        if (!isCurrentEntry()) return;
        registry?.onDispatchSettled(
          runId,
          dispatchId,
          error,
          endedAt,
          !runInBackground && options.signal.aborted,
        );
        emitUpdate();
      },
      // The registry records this without firing a status update, avoiding a
      // TUI redraw per line while retaining the real replay timestamp.
      logAppended: (line) => {
        if (!isCurrentEntry()) return;
        registry?.onLogAppended(runId, line);
      },
      budgetUpdated: (spent, total) => {
        if (!isCurrentEntry()) return;
        registry?.onBudgetUpdated(runId, spent, total);
        emitUpdate();
      },
    };

    const scheduler = new WorkflowDispatchScheduler(
      resolveConcurrencyLimit(),
      controller.signal,
      ({ state }) => {
        if (!isCurrentEntry()) return;
        registry?.onDispatchStateChange(runId, state);
      },
    );

    const handle: WorkflowRunHandle = new WorkflowRunHandle(
      runId,
      budget,
      registry,
      controller,
      scheduler,
      async (): Promise<WorkflowRunSettlement> => {
        try {
          const outcome = await orchestrator.run({
            script,
            args: options.args,
            abortOnTimeout: controller,
            runId,
            emitter,
            budget,
            resolveSavedWorkflow: (ref) =>
              resolveSavedWorkflowScript(ref, config),
            journal,
            resumeReplay,
            scheduler,
          });
          if (entry) {
            entry.meta = outcome.meta;
            if (outcome.meta?.name && entry.description === runId) {
              entry.description = outcome.meta.name;
            }
          }
          registry?.setRecentLogs(runId, outcome.logs);
          // A held successful dispatch resolves its gate on abort, so a
          // run whose entry settled terminal mid-script — cancelled via
          // the dialog, or failed via resolvePendingApproval's
          // contingency — can still finish normally. Settle with the
          // entry's terminal state instead of reporting a success that
          // contradicts the registry entry, telemetry, and snapshot.
          if (entry && isTerminalWorkflowStatus(entry.status)) {
            return {
              ok: false,
              message:
                entry.status === 'cancelled'
                  ? 'Workflow run cancelled.'
                  : (entry.error ?? 'Workflow run failed.'),
            };
          }
          registry?.complete(runId, outcome.result, Date.now());
          return { ok: true, outcome };
        } catch (error) {
          const details =
            error instanceof WorkflowExecutionError ? error : undefined;
          const message = extractErrorMessage(error);
          if (entry && details?.meta && !entry.meta) entry.meta = details.meta;
          if (details?.logs) registry?.setRecentLogs(runId, details.logs);
          // Mirror of the guard on the success path. When the entry was
          // settled terminal from outside — the dialog's cancel, or the
          // approval contingency's fail — the abort that follows is what
          // makes the sandbox reject, so the rejection arriving here is a
          // consequence of that settlement, not a new fact about the run.
          // Report the entry's state and its own message, not the
          // rejection's.
          if (entry && isTerminalWorkflowStatus(entry.status)) {
            return {
              ok: false,
              message:
                entry.status === 'cancelled'
                  ? 'Workflow run cancelled.'
                  : (entry.error ?? message),
              details,
            };
          }
          if (
            callerWasAbortedBeforeStart ||
            (!runInBackground && options.signal.aborted)
          ) {
            registry?.cancel(runId, Date.now());
          } else {
            registry?.fail(runId, message, Date.now());
          }
          return { ok: false, message, details };
        } finally {
          controller.abort();
          if (entry && isTerminalWorkflowStatus(entry.status)) {
            // Capture the telemetry projection before the first await:
            // the finally path from complete()/fail() up to here has no
            // yield, so this IS the settlement-time state. In-flight
            // dispatches keep draining (mutating the live entry) across
            // the snapshot write's awaits, and a post-await read made
            // the snapshot and telemetry disagree with each other.
            const telemetryEvent = new WorkflowRunEvent({
              status: entry.status,
              agents_dispatched: entry.agentsDispatched,
              agents_completed: entry.agentsCompleted,
              phase_count: entry.phases.length,
              tokens_spent: entry.tokensSpent,
              duration_ms: (entry.endTime ?? entry.startTime) - entry.startTime,
            });
            const snapshotPersisted = await writeWorkflowSnapshot(
              config,
              entry,
            );
            if (snapshotPersisted) {
              // Lets the owning session retire its unpersisted history
              // cache entry: once the run is safely on disk, a sibling's
              // deletion must win over the stale in-memory copy.
              registry?.notifySnapshotPersisted(entry.runId);
            }
            await journal?.drain();
            try {
              logWorkflowRun(config, telemetryEvent);
            } catch {
              // Telemetry must not affect workflow execution.
            }
          }
          registry?.releaseHandle(runId, handle);
        }
      },
    );
    registry?.attachHandle(handle);
    return handle;
  }
}

/**
 * Duck-typed extraction so vm-realm Errors (raised inside the sandbox)
 * don't coerce to "Error: <msg>" via toString(). See workflow-orchestrator.ts
 * for the matching helper on the orchestrator side.
 */
function extractErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === 'string') return message;
    return String(message);
  }
  return String(error);
}
