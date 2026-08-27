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
  isTerminalWorkflowStatus,
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

export class WorkflowRunner {
  static async start(
    options: WorkflowRunnerOptions,
  ): Promise<WorkflowRunHandle> {
    const config = options.config;
    const runInBackground = options.runInBackground === true;
    const budget = WorkflowBudgetImpl.fromEnv();
    const loaded =
      options.scriptPath && options.script === undefined
        ? await resolveSavedWorkflowScript(
            { scriptPath: options.scriptPath },
            config,
          )
        : undefined;
    const script = loaded?.script ?? options.script ?? '';
    const scriptPath = loaded?.scriptPath ?? options.scriptPath;

    // Refuse a script that cannot compile before anything exists to clean up.
    // Everything below this line has a cost that outlives a failure: a runId is
    // minted, a journal file is opened, the run is registered and shows up in
    // `/workflows`, and the failure path writes a snapshot and a log entry. A
    // single TypeScript annotation used to produce all of that — a phantom
    // failed run for a workflow that never started. Compiling first turns it
    // into a plain refusal with nothing to explain afterwards.
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

    const runId =
      options.resumeFromRunId ?? `wf_${randomBytes(8).toString('hex')}`;
    const storage = config.storage;
    const journal = storage
      ? new WorkflowJournal(storage.getWorkflowRunJournalPath(runId))
      : undefined;
    const resumeReplay: JournalReplay | undefined = options.resumeFromRunId
      ? await journal?.load()
      : undefined;
    if (runInBackground && options.signal.aborted) {
      throw new Error('Background workflow start was cancelled.');
    }
    const callerWasAbortedBeforeStart = options.signal.aborted;
    const registry = config.getWorkflowRunRegistry?.();
    let entry: WorkflowTask | undefined;
    const isCurrentEntry = (): boolean =>
      registry === undefined ||
      (entry !== undefined && registry.get(runId) === entry);
    const controller = runInBackground
      ? createAbortController()
      : createChildAbortController(options.signal);
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
    const orchestrator = new WorkflowOrchestrator(dispatch);
    try {
      entry = registry?.register({
        runId,
        toolUseId: options.toolUseId,
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
      });
    } catch (error) {
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
          registry?.setRecentLogs(runId, outcome.logs, handle);
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
          if (details?.logs)
            registry?.setRecentLogs(runId, details.logs, handle);
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
            await writeWorkflowSnapshot(config, entry);
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
