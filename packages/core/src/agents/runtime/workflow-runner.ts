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
  type WorkflowMeta,
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

export interface WorkflowRunSuccess {
  ok: true;
  outcome: WorkflowRunOutcome;
}

export interface WorkflowRunFailure {
  ok: false;
  message: string;
  phases?: string[];
  logs?: string[];
  meta?: WorkflowMeta;
}

export type WorkflowRunSettlement = WorkflowRunSuccess | WorkflowRunFailure;

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
    const controller = createChildAbortController(options.signal);
    const budget = WorkflowBudgetImpl.fromEnv();
    const dispatch =
      options.dispatch ??
      createProductionDispatch(
        options.config,
        controller.signal,
        (outputTokens) => budget.recordSpent(outputTokens),
      );
    const orchestrator = new WorkflowOrchestrator(dispatch);

    let resolvedScript = options.script ?? '';
    let resolvedScriptPath = options.scriptPath;
    try {
      if (options.scriptPath && options.script === undefined) {
        const loaded = await resolveSavedWorkflowScript(
          { scriptPath: options.scriptPath },
          options.config,
        );
        resolvedScript = loaded.script;
        resolvedScriptPath = loaded.scriptPath;
      }
    } catch (error) {
      controller.abort();
      throw error;
    }

    const runId =
      options.resumeFromRunId ?? `wf_${randomBytes(8).toString('hex')}`;
    let journal: WorkflowJournal | undefined;
    let resumeReplay: JournalReplay | undefined;
    const storage = options.config.storage;
    if (storage) {
      journal = new WorkflowJournal(storage.getWorkflowRunJournalPath(runId));
      if (options.resumeFromRunId) {
        resumeReplay = await journal.load();
      }
    }

    const registry = options.config.getWorkflowRunRegistry?.();
    const entry = registry?.register({
      runId,
      meta: null,
      status: 'running',
      startTime: Date.now(),
      outputFile: '',
      abortController: controller,
      tokenBudgetTotal: budget.total,
      script: resolvedScript,
      scriptPath: resolvedScriptPath,
    });
    const emitter = createEmitter(runId, registry, entry, options.onUpdate);

    const handle: WorkflowRunHandle = new WorkflowRunHandle(
      runId,
      budget,
      registry,
      controller,
      (): Promise<WorkflowRunSettlement> =>
        settleRun({
          options,
          handle,
          orchestrator,
          controller,
          registry,
          entry,
          emitter,
          budget,
          runId,
          resolvedScript,
          journal,
          resumeReplay,
        }),
    );
    registry?.attachHandle(handle);
    return handle;
  }
}

interface SettleRunOptions {
  options: WorkflowRunnerOptions;
  handle: WorkflowRunHandle;
  orchestrator: WorkflowOrchestrator;
  controller: AbortController;
  registry: WorkflowRunRegistry | undefined;
  entry: WorkflowTask | undefined;
  emitter: WorkflowOrchestratorEmitter;
  budget: WorkflowBudgetImpl;
  runId: string;
  resolvedScript: string;
  journal: WorkflowJournal | undefined;
  resumeReplay: JournalReplay | undefined;
}

async function settleRun(
  context: SettleRunOptions,
): Promise<WorkflowRunSettlement> {
  const {
    options,
    handle,
    orchestrator,
    controller,
    registry,
    entry,
    emitter,
    budget,
    runId,
    resolvedScript,
    journal,
    resumeReplay,
  } = context;

  try {
    const outcome = await orchestrator.run({
      script: resolvedScript,
      args: options.args,
      abortOnTimeout: controller,
      runId,
      emitter,
      budget,
      resolveSavedWorkflow: (ref) =>
        resolveSavedWorkflowScript(ref, options.config),
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
    const message = extractErrorMessage(error);
    const phases =
      error instanceof WorkflowExecutionError ? error.phases : undefined;
    const logs =
      error instanceof WorkflowExecutionError ? error.logs : undefined;
    const meta =
      error instanceof WorkflowExecutionError
        ? (error.meta ?? undefined)
        : undefined;
    if (entry && meta && !entry.meta) entry.meta = meta;
    if (logs) registry?.setRecentLogs(runId, logs);
    if (options.signal.aborted) {
      registry?.cancel(runId, Date.now());
    } else {
      registry?.fail(runId, message, Date.now());
    }
    return { ok: false, message, phases, logs, meta };
  } finally {
    controller.abort();
    if (entry && entry.status !== 'running') {
      await writeWorkflowSnapshot(options.config, entry);
      emitTelemetry(options.config, entry);
    }
    registry?.releaseHandle(runId, handle);
  }
}

function createEmitter(
  runId: string,
  registry: WorkflowRunRegistry | undefined,
  entry: WorkflowTask | undefined,
  onUpdate: ((entry: WorkflowTask) => void) | undefined,
): WorkflowOrchestratorEmitter {
  const emitUpdate = (): void => {
    if (!entry || !onUpdate) return;
    try {
      onUpdate(entry);
    } catch {
      // UI refresh failures must not affect workflow execution.
    }
  };
  return {
    phaseStarted: (title) => {
      registry?.onPhaseStarted(runId, title);
      emitUpdate();
    },
    agentDispatched: () => {
      registry?.onAgentDispatched(runId);
      emitUpdate();
    },
    agentCompleted: () => {
      registry?.onAgentCompleted(runId);
    },
    logAppended: () => {},
    budgetUpdated: (spent, total) => {
      registry?.onBudgetUpdated(runId, spent, total);
      emitUpdate();
    },
  };
}

function emitTelemetry(config: Config, entry: WorkflowTask): void {
  try {
    logWorkflowRun(
      config,
      new WorkflowRunEvent({
        status: entry.status,
        agents_dispatched: entry.agentsDispatched,
        agents_completed: entry.agentsCompleted,
        phase_count: entry.phases.length,
        tokens_spent: entry.tokensSpent,
        duration_ms: (entry.endTime ?? entry.startTime) - entry.startTime,
      }),
    );
  } catch {
    // Telemetry must not affect workflow execution.
  }
}

function extractErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === 'string') return message;
    return String(message);
  }
  return String(error);
}
