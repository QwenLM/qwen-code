/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import type { Config } from '../../config/config.js';
import { logWorkflowRun } from '../../telemetry/loggers.js';
import { WorkflowRunEvent } from '../../telemetry/types.js';
import { createChildAbortController } from '../../utils/abortController.js';
import {
  type WorkflowRunRegistry,
  type WorkflowTask,
} from '../workflow-run-registry.js';
import { writeWorkflowSnapshot } from '../workflow-snapshot.js';
import {
  createProductionDispatch,
  WorkflowExecutionError,
  WorkflowOrchestrator,
  type WorkflowAgentDispatch,
  type WorkflowOrchestratorEmitter,
  type WorkflowRunOutcome,
} from './workflow-orchestrator.js';
import { WorkflowBudgetImpl } from './workflow-budget.js';
import { WorkflowJournal, type JournalReplay } from './workflow-journal.js';
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
    start: () => Promise<WorkflowRunSettlement>,
  ) {
    this.completion = Promise.resolve().then(start);
  }

  abort(): void {
    this.controller.abort();
  }
}

export class WorkflowRunner {
  static async start(
    options: WorkflowRunnerOptions,
  ): Promise<WorkflowRunHandle> {
    const config = options.config;
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
    const storage = config.storage;
    const journal = storage
      ? new WorkflowJournal(storage.getWorkflowRunJournalPath(runId))
      : undefined;
    const resumeReplay: JournalReplay | undefined = options.resumeFromRunId
      ? await journal?.load()
      : undefined;
    const controller = createChildAbortController(options.signal);
    const dispatch =
      options.dispatch ??
      createProductionDispatch(config, controller.signal, (outputTokens) =>
        budget.recordSpent(outputTokens),
      );
    const orchestrator = new WorkflowOrchestrator(dispatch);
    const registry = config.getWorkflowRunRegistry?.();
    const entry = registry?.register({
      runId,
      meta: null,
      status: 'running',
      startTime: Date.now(),
      outputFile: '',
      abortController: controller,
      tokenBudgetTotal: budget.total,
      script,
      scriptPath,
    });
    const emitUpdate = (): void => {
      if (!entry || !options.onUpdate) return;
      try {
        options.onUpdate(entry);
      } catch {
        // UI refresh failures must not affect workflow execution.
      }
    };
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

    const handle: WorkflowRunHandle = new WorkflowRunHandle(
      runId,
      budget,
      registry,
      controller,
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
          });
          if (entry) {
            entry.meta = outcome.meta;
            if (outcome.meta?.name && entry.description === runId) {
              entry.description = outcome.meta.name;
            }
          }
          registry?.setRecentLogs(runId, outcome.logs);
          registry?.complete(runId, outcome.result, Date.now());
          return { ok: true, outcome };
        } catch (error) {
          const details =
            error instanceof WorkflowExecutionError ? error : undefined;
          const message = extractErrorMessage(error);
          if (entry && details?.meta && !entry.meta) entry.meta = details.meta;
          if (details?.logs) registry?.setRecentLogs(runId, details.logs);
          if (options.signal.aborted) {
            registry?.cancel(runId, Date.now());
          } else {
            registry?.fail(runId, message, Date.now());
          }
          return { ok: false, message, details };
        } finally {
          controller.abort();
          if (entry && entry.status !== 'running') {
            await writeWorkflowSnapshot(config, entry);
            try {
              logWorkflowRun(
                config,
                new WorkflowRunEvent({
                  status: entry.status,
                  agents_dispatched: entry.agentsDispatched,
                  agents_completed: entry.agentsCompleted,
                  phase_count: entry.phases.length,
                  tokens_spent: entry.tokensSpent,
                  duration_ms:
                    (entry.endTime ?? entry.startTime) - entry.startTime,
                }),
              );
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
