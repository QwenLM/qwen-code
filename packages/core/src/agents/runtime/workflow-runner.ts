/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import type { Config } from '../../config/config.js';
import { logWorkflowRun } from '../../telemetry/loggers.js';
import { WorkflowRunEvent } from '../../telemetry/types.js';
import { createDebugLogger } from '../../utils/debugLogger.js';
import {
  createAbortController,
  createChildAbortController,
} from '../../utils/abortController.js';
import {
  isActiveWorkflowStatus,
  isTerminalWorkflowStatus,
  type WorkflowRunRegistry,
  type WorkflowTask,
} from '../workflow-run-registry.js';
import {
  readWorkflowManifest,
  writeWorkflowManifest,
  writeWorkflowSnapshot,
} from '../workflow-snapshot.js';
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
import {
  WorkflowJournal,
  type JournalCheckpoint,
  type JournalReplay,
} from './workflow-journal.js';
import { resolveSavedWorkflowScript } from './workflow-saved.js';

export interface WorkflowRunnerOptions {
  config: Config;
  signal: AbortSignal;
  script?: string;
  scriptPath?: string;
  args: unknown;
  resumeFromRunId?: string;
  dispatch?: WorkflowAgentDispatch;
  onUpdate?: (entry: WorkflowTask) => void;
  runInBackground?: boolean;
}

const debugLogger = createDebugLogger('WORKFLOW_RUNNER');

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
    const runId =
      options.resumeFromRunId ?? `wf_${randomBytes(8).toString('hex')}`;
    const registry = config.getWorkflowRunRegistry?.();
    const storage = config.storage;
    const journal = storage
      ? new WorkflowJournal(storage.getWorkflowRunJournalPath(runId))
      : undefined;
    let resumeReplay: JournalReplay | undefined;
    if (options.resumeFromRunId && journal) {
      const manifest = await readWorkflowManifest(config, runId);
      if (!manifest.canResume) {
        throw new Error(
          manifest.resumeBlockedReason ??
            `Workflow run ${runId} is not recoverable.`,
        );
      }
      if (!isActiveWorkflowStatus(manifest.status)) {
        throw new Error(
          `Workflow run ${runId} is ${manifest.status}; terminal runs must be rerun instead of resumed.`,
        );
      }
      if (manifest.script !== script) {
        throw new Error(
          `Workflow run ${runId} script does not match its durable manifest.`,
        );
      }
      if (serializedArgs(options.args) !== JSON.stringify(manifest.args)) {
        throw new Error(
          `Workflow run ${runId} args do not match its durable manifest.`,
        );
      }
      resumeReplay = await journal.load(manifest.journal);
    } else if (options.resumeFromRunId && !registry?.get(runId)) {
      throw new Error('Workflow storage is required to resume a run.');
    }
    if (runInBackground && options.signal.aborted) {
      throw new Error('Background workflow start was cancelled.');
    }
    const callerWasAbortedBeforeStart = options.signal.aborted;
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
          ? (emitter) => registry.bridgeApprovalEvents(runId, emitter)
          : undefined,
      );
    const orchestrator = new WorkflowOrchestrator(dispatch);
    let entry: WorkflowTask | undefined;
    try {
      entry = registry?.register({
        runId,
        meta: null,
        status: 'running',
        startTime: Date.now(),
        outputFile: '',
        abortController: controller,
        tokenBudgetTotal: budget.total,
        script,
        scriptPath,
        isBackgrounded: runInBackground,
      });
    } catch (error) {
      controller.abort();
      throw error;
    }
    const emitUpdate = (): void => {
      if (!entry || !options.onUpdate) return;
      try {
        options.onUpdate(entry);
      } catch {
        // UI refresh failures must not affect workflow execution.
      }
    };

    const persistManifest = async (
      status: WorkflowTask['status'],
      checkpoint: JournalCheckpoint,
      source: WorkflowTask | undefined = entry,
    ): Promise<void> => {
      if (!source) return;
      await writeWorkflowManifest(config, source, {
        args: options.args,
        journal: checkpoint,
        status,
      });
    };

    const persistManifestBestEffort = async (
      status: WorkflowTask['status'],
      checkpoint: JournalCheckpoint,
      source: WorkflowTask | undefined = entry,
    ): Promise<void> => {
      try {
        await persistManifest(status, checkpoint, source);
      } catch (error) {
        debugLogger.warn(
          `Failed to persist workflow manifest for ${runId}: ${extractErrorMessage(error)}`,
        );
      }
    };

    if (entry && journal) {
      let initialCheckpoint: JournalCheckpoint;
      try {
        initialCheckpoint = await journal.flush();
        assertCompleteCheckpoint(initialCheckpoint, 'initial');
        await persistManifest('running', initialCheckpoint);
      } catch (error) {
        const message = `Failed to persist initial workflow checkpoint: ${extractErrorMessage(error)}`;
        registry?.fail(runId, message, Date.now());
        controller.abort();
        throw new Error(message);
      }
      // A background run's controller is deliberately not linked to the
      // caller's signal, so nothing re-reads that signal after the
      // pre-start check. The persist above is the only await between the
      // two, and an fsync is long enough to swallow an Esc: without this
      // the run registers, dispatches agents, and reports "started in
      // background" for something the user just cancelled. The manifest
      // that persist just wrote says 'running' + resumable, so it has to
      // be settled here too or the run reads as recoverable forever.
      if (runInBackground && options.signal.aborted) {
        const endTime = Date.now();
        registry?.cancel(runId, endTime);
        controller.abort();
        await persistManifestBestEffort(
          'cancelled',
          initialCheckpoint,
          freezeWorkflowTask({ ...entry, status: 'cancelled', endTime }),
        );
        throw new Error('Background workflow start was cancelled.');
      }
    }
    const emitter: WorkflowOrchestratorEmitter = {
      phaseStarted: (title) => {
        registry?.onPhaseStarted(runId, title);
        emitUpdate();
      },
      agentDispatched: () => {
        registry?.onAgentDispatched(runId);
        emitUpdate();
      },
      agentCompleted: () => {
        // No emitUpdate: budgetUpdated fires right after and renders both
        // updates together (avoids 2x TUI redraws per agent).
        registry?.onAgentCompleted(runId);
      },
      // Deliberate no-op: logs are snapshotted at terminal via
      // setRecentLogs; per-line emit would cause up to 10k TUI redraws.
      logAppended: () => {},
      budgetUpdated: (spent, total) => {
        registry?.onBudgetUpdated(runId, spent, total);
        emitUpdate();
      },
    };

    let fatalPersistenceError: string | undefined;
    const scheduler = new WorkflowDispatchScheduler(
      resolveConcurrencyLimit(),
      controller.signal,
      ({ state }) => registry?.onDispatchStateChange(runId, state),
      journal
        ? async () => {
            try {
              const checkpoint = await journal.flush();
              assertCompleteCheckpoint(checkpoint, 'pause');
              await persistManifest('paused', checkpoint);
            } catch (error) {
              fatalPersistenceError = `Failed to persist workflow pause checkpoint: ${extractErrorMessage(error)}`;
              registry?.fail(runId, fatalPersistenceError, Date.now());
              controller.abort();
              throw error;
            }
          }
        : undefined,
    );

    // The pause barrier above runs detached (it is entered from a dispatch's
    // `.finally`), and it durably writes 'paused' + canResume. A run that
    // completes or is cancelled while that write is in flight would publish
    // its terminal manifest first and have the barrier overwrite it — a
    // finished run advertised as resumable forever. Joining the barrier
    // before each terminal write orders the two.
    const joinPauseBarrier = (): Promise<void> =>
      scheduler.whenPauseBarrierSettled();

    let terminalCheckpoint: JournalCheckpoint | undefined;

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
          await joinPauseBarrier();
          terminalCheckpoint = await journal?.flush();
          if (entry && isTerminalWorkflowStatus(entry.status)) {
            return {
              ok: false,
              message:
                entry.status === 'cancelled'
                  ? 'Workflow run cancelled.'
                  : (entry.error ?? 'Workflow run failed.'),
            };
          }
          const endTime = Date.now();
          if (entry && terminalCheckpoint) {
            const completedEntry = freezeWorkflowTask({
              ...entry,
              status: 'completed',
              endTime,
              result: outcome.result,
            });
            try {
              await persistManifest(
                'completed',
                terminalCheckpoint,
                completedEntry,
              );
            } catch (error) {
              fatalPersistenceError = `Failed to persist workflow terminal checkpoint: ${extractErrorMessage(error)}`;
              throw new Error(fatalPersistenceError);
            }
          }
          if (entry && isTerminalWorkflowStatus(entry.status)) {
            return {
              ok: false,
              message:
                entry.status === 'cancelled'
                  ? 'Workflow run cancelled.'
                  : (entry.error ?? 'Workflow run failed.'),
            };
          }
          registry?.complete(runId, outcome.result, endTime);
          return { ok: true, outcome };
        } catch (error) {
          const details =
            error instanceof WorkflowExecutionError ? error : undefined;
          const message = fatalPersistenceError ?? extractErrorMessage(error);
          if (entry && details?.meta && !entry.meta) entry.meta = details.meta;
          if (details?.logs) registry?.setRecentLogs(runId, details.logs);
          try {
            await joinPauseBarrier();
            terminalCheckpoint = await journal?.flush();
          } catch (flushError) {
            debugLogger.warn(
              `Failed to flush workflow terminal journal for ${runId}: ${extractErrorMessage(flushError)}`,
            );
          }
          const cancelled =
            callerWasAbortedBeforeStart ||
            (!runInBackground && options.signal.aborted) ||
            entry?.status === 'cancelled';
          const endTime = Date.now();
          if (entry && terminalCheckpoint) {
            const failedEntry = freezeWorkflowTask({
              ...entry,
              status: cancelled ? 'cancelled' : 'failed',
              endTime,
              ...(cancelled ? {} : { error: message }),
            });
            await persistManifestBestEffort(
              failedEntry.status,
              terminalCheckpoint,
              failedEntry,
            );
          }
          if (cancelled) {
            registry?.cancel(runId, endTime);
          } else {
            registry?.fail(runId, message, endTime);
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
            const settledEntry = freezeWorkflowTask(entry);
            const telemetryEvent = new WorkflowRunEvent({
              status: settledEntry.status,
              agents_dispatched: settledEntry.agentsDispatched,
              agents_completed: settledEntry.agentsCompleted,
              phase_count: settledEntry.phases.length,
              tokens_spent: settledEntry.tokensSpent,
              duration_ms:
                (settledEntry.endTime ?? settledEntry.startTime) -
                settledEntry.startTime,
            });
            const snapshotWrite = writeWorkflowSnapshot(config, settledEntry);
            // Reached without a terminal flush on the early-return paths
            // (the entry settled mid-script), so this write needs the same
            // ordering guarantee the try/catch paths already took.
            await joinPauseBarrier();
            let checkpoint = terminalCheckpoint;
            if (!checkpoint && journal) {
              try {
                checkpoint = await journal.flush();
              } catch (flushError) {
                debugLogger.warn(
                  `Failed to flush terminal workflow journal for ${runId}: ${extractErrorMessage(flushError)}`,
                );
              }
            }
            if (checkpoint) {
              await persistManifestBestEffort(
                settledEntry.status,
                checkpoint,
                settledEntry,
              );
            }
            await snapshotWrite;
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

function serializedArgs(args: unknown): string | undefined {
  try {
    return JSON.stringify(args ?? null);
  } catch {
    return undefined;
  }
}

function assertCompleteCheckpoint(
  checkpoint: JournalCheckpoint,
  transition: 'initial' | 'pause',
): void {
  if (checkpoint.integrity === 'complete') return;
  throw new Error(
    `${transition} workflow journal checkpoint failed${checkpoint.error ? `: ${checkpoint.error}` : ''}`,
  );
}

function freezeWorkflowTask(task: WorkflowTask): WorkflowTask {
  return {
    ...task,
    phases: [...task.phases],
    recentLogs: [...task.recentLogs],
    perPhaseTokens: new Map(task.perPhaseTokens),
    pendingApprovals: [],
  };
}
