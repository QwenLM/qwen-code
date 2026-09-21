/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Config } from '../../config/config.js';
import {
  logWorkflowRun,
  logWorkflowSizeWarning,
} from '../../telemetry/loggers.js';
import {
  WorkflowRunEvent,
  WorkflowSizeWarningEvent,
} from '../../telemetry/types.js';
import {
  createAbortController,
  createChildAbortController,
} from '../../utils/abortController.js';
import {
  getWorkflowTaskMutationKey,
  isTerminalWorkflowStatus,
  markWorkflowRunPersistenceActive,
  tryWithWorkflowTaskMutation,
  type WorkflowRunRegistry,
  type WorkflowTask,
  type WorkflowTaskRegistration,
} from '../workflow-run-registry.js';
import {
  readWorkflowSnapshot,
  writeWorkflowSnapshot,
  type WorkflowSnapshot,
} from '../workflow-snapshot.js';
import {
  checkpointFromTask,
  removeWorkflowCheckpoint,
  writeWorkflowCheckpoint,
  type WorkflowCheckpointWrite,
} from '../workflow-checkpoint.js';
import {
  readWorkflowSourceRef,
  type WorkflowSourceRef,
} from '../workflow-correlation.js';
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
import {
  describeWorkflowDeterminismViolations,
  scanWorkflowScriptShape,
} from './workflow-script-shape.js';
import {
  evaluateWorkflowSize,
  resolveWorkflowSizeCaps,
  resolveWorkflowSizeGuidelineSetting,
} from './workflow-size.js';
import { WorkflowDispatchScheduler } from './workflow-dispatch-scheduler.js';
import { WorkflowJournal, type JournalReplay } from './workflow-journal.js';
import {
  deleteInlineWorkflowScript,
  persistInlineWorkflowScript,
  resolveSavedWorkflowScript,
  type ResolvedSavedWorkflow,
} from './workflow-saved.js';
import {
  compileWorkflowScript,
  describeWorkflowCompileError,
  type WorkflowMeta,
} from './workflow-sandbox.js';
import {
  resolveReviewWorkflowLimits,
  type ReviewWorkflowLimits,
} from './review-workflow.js';

export interface WorkflowRunnerOptions {
  config: Config;
  signal: AbortSignal;
  toolUseId?: string;
  workflowName?: string;
  sourceRef?: WorkflowSourceRef;
  script?: string;
  scriptPath?: string;
  /**
   * Loads the script a `scriptPath` or saved-workflow `name` call runs, in
   * place of reading `scriptPath` here. The Workflow tool passes the load it
   * showed for approval, so the content that runs is the content approved.
   */
  loadScript?: () => Promise<ResolvedSavedWorkflow>;
  args: unknown;
  resumeFromRunId?: string;
  dispatch?: WorkflowAgentDispatch;
  onUpdate?: (entry: WorkflowTask) => void;
  runInBackground?: boolean;
  /** Client-started tools have no model tool-result continuation. */
  notifyOnCompletion?: boolean;
  /**
   * Where this session's authoring reference is, sent with a failed background
   * run's completion notification. Omitted for a script the model did not
   * author (a saved workflow), where "fix the script" would be wrong advice.
   */
  authoringHint?: string;
  /**
   * Refuse `workflow({ scriptPath })` inside the script. Set for a call the
   * model made in a name-only session (`tools.workflowNameOnly`); a run the
   * host starts itself is not the model's and is left unrestricted.
   */
  restrictNestedScriptPaths?: boolean;
}

/**
 * The name a name-only session may resume this run by: the run's workflow
 * name, but only when that name resolves now to the script this run executes.
 * A name recorded from a path in a subdirectory, one a same-named project
 * workflow shadows, or one a retry carried over to an inline copy would send a
 * resume to a different script, or to none.
 */
async function resolveResumeName(
  config: Config,
  workflowName: string | undefined,
  scriptPath: string | undefined,
): Promise<string | undefined> {
  if (!workflowName || !scriptPath) return undefined;
  const canonical = (file: string): Promise<string> =>
    fs.realpath(file).catch(() => path.resolve(file));
  try {
    const resolved = await resolveSavedWorkflowScript(workflowName, config);
    const [byName, ran] = await Promise.all([
      canonical(resolved.scriptPath),
      canonical(scriptPath),
    ]);
    return byName === ran ? workflowName : undefined;
  } catch {
    return undefined;
  }
}

export type WorkflowRunSettlement =
  | { ok: true; outcome: WorkflowRunOutcome }
  | { ok: false; message: string; details?: WorkflowExecutionError };

export class WorkflowRunHandle {
  readonly completion: Promise<WorkflowRunSettlement>;
  /**
   * Where this run's script lives on disk: the file a `{scriptPath}` launch
   * loaded, or the persisted copy of an inline `{script}`. `undefined` when
   * an inline script could not be persisted (no `storage`, symlinked root,
   * write failure) — callers report the run without it rather than naming a
   * path that does not exist.
   */
  readonly scriptPath: string | undefined;
  /** This run's resume journal, when the config has a `storage` to hold one. */
  readonly journalPath: string | undefined;
  readonly sourceRef: WorkflowSourceRef | undefined;

  constructor(
    readonly runId: string,
    readonly budget: WorkflowBudgetImpl,
    readonly registry: WorkflowRunRegistry | undefined,
    private readonly controller: AbortController,
    private readonly scheduler: WorkflowDispatchScheduler,
    start: () => Promise<WorkflowRunSettlement>,
    locations: {
      scriptPath?: string;
      journalPath?: string;
      sourceRef?: WorkflowSourceRef;
    } = {},
  ) {
    this.scriptPath = locations.scriptPath;
    this.journalPath = locations.journalPath;
    this.sourceRef = locations.sourceRef;
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

const WORKFLOW_SCRIPT_SYNTAX_HINT =
  'Workflow scripts must be plain JavaScript — the usual causes are ' +
  'TypeScript syntax (type annotations, interfaces, generics) and ' +
  'broken string quoting or escaping. Metadata must use literal values.';

/**
 * The script was refused before a run was created: it did not compile, or it
 * calls something a resumable workflow cannot replay.
 *
 * Distinct from `WorkflowExecutionError` on purpose: that one describes a run
 * that existed and failed, and callers report it as such. This one means there
 * is nothing to report on — no runId, no journal, no registry entry, no
 * snapshot — and the caller should say the workflow was not launched rather
 * than that it failed.
 */
export class WorkflowScriptNotLaunchedError extends Error {
  /**
   * @param detail What is wrong with the script.
   * @param hint The usual causes, appended after `detail`. Defaults to the
   *   syntax causes of a compile failure; a refusal with a cause of its own
   *   passes an empty hint, so the reader is not sent looking for TypeScript
   *   syntax that is not there.
   */
  constructor(
    readonly detail: string,
    hint: string = WORKFLOW_SCRIPT_SYNTAX_HINT,
  ) {
    super(
      `Workflow script is invalid and was not launched:\n${detail}` +
        (hint ? `\n\n${hint}` : ''),
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

/**
 * A resume refused because the run's journal is not there to replay: missing
 * from disk, or present but unreadable. A class so a host starting the resume
 * on a caller's behalf can tell this refusal — which a rerun answers — from a
 * fault in the host itself.
 */
export class WorkflowJournalUnavailableError extends Error {
  constructor(
    readonly runId: string,
    readonly reason: 'missing' | 'unreadable',
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowJournalUnavailableError';
  }
}

/**
 * A resume could not record that its run is running again.
 *
 * Retrying a run from history refuses one whose checkpoint is on disk, so a
 * resume that starts without writing one leaves another process free to be
 * the second runner on its journal. Nothing was started when this is thrown.
 */
export class WorkflowCheckpointUnwritableError extends Error {
  constructor(readonly runId: string) {
    super(
      `Could not record that workflow run ${runId} is running again, so another process could start it a second time. Nothing was started; try again.`,
    );
    this.name = 'WorkflowCheckpointUnwritableError';
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
    const budget = WorkflowBudgetImpl.fromConfig(config);
    // Read once per run: a guideline the user changes mid-run applies from the
    // next run, the same way the tool description does.
    const sizeCaps = resolveWorkflowSizeCaps(
      config.getWorkflowSizeGuideline?.() ??
        resolveWorkflowSizeGuidelineSetting(undefined),
    );
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
    const releasePersistenceActivity = markWorkflowRunPersistenceActive(
      config,
      runId,
    );
    const assertStartNotCancelled = (): void => {
      if (controller.signal.aborted && !options.signal.aborted) {
        throw new WorkflowStartCancelledError();
      }
      if (runInBackground && options.signal.aborted) {
        throw new WorkflowStartCancelledError();
      }
    };
    const storage = config.storage;
    const previousEntry = registry?.get(runId);
    // The run as it was before this start: the registry entry while the
    // process still has one, else its snapshot (the registry does not outlive
    // the process). Read once, for the sourceRef guard below and for putting
    // back the inline script copy a resume that fails to start overwrote.
    let previousRun:
      | Pick<WorkflowSnapshot, 'sourceRef' | 'script'>
      | undefined = previousEntry;
    let journalPath = storage
      ? storage.getWorkflowRunJournalPath(runId)
      : undefined;
    const journal = journalPath
      ? new WorkflowJournal(journalPath, storage.getWorkflowRunsDir())
      : undefined;
    let script: string;
    let scriptPath: string | undefined;
    let resumeReplay: JournalReplay | undefined;
    let sourceRef: WorkflowSourceRef | undefined;
    let persistedInlineScript = false;
    // Set once the run's checkpoint has been written (or found to have
    // nowhere to live), by whichever of the two paths below wrote it; the
    // settlement waits on it before removing the file.
    let checkpointWrite: Promise<WorkflowCheckpointWrite> | undefined;
    const checkpointContext = () => ({
      sessionId: config.getSessionId?.() ?? '',
      meta: scriptMeta,
    });
    let callerWasAbortedBeforeStart: boolean;
    let orchestrator: WorkflowOrchestrator;
    let reviewLimits: ReviewWorkflowLimits | undefined;
    let scriptMeta: WorkflowMeta | null = null;
    try {
      const loaded = options.loadScript
        ? await options.loadScript()
        : options.scriptPath && options.script === undefined
          ? await resolveSavedWorkflowScript(
              { scriptPath: options.scriptPath },
              config,
            )
          : undefined;
      script = loaded?.script ?? options.script ?? '';
      scriptPath = loaded?.scriptPath ?? options.scriptPath;
      if (loaded && scriptPath && storage) {
        reviewLimits = await resolveReviewWorkflowLimits(
          scriptPath,
          storage.getGeneratedWorkflowsDir(),
          script,
        );
      }
      const workflowName =
        options.workflowName ??
        loaded?.savedWorkflowName ??
        registry?.get(runId)?.workflowName;

      try {
        scriptMeta = compileWorkflowScript(script).meta;
      } catch (error) {
        throw new WorkflowScriptNotLaunchedError(
          describeWorkflowCompileError(
            error,
            script.split(/\r\n|[\n\r\u2028\u2029]/).length,
          ),
        );
      }
      // A script that reads a clock or a random source cannot be replayed on
      // resume. Refused here, before any agent spends a token, rather than on
      // whichever call reaches the sandbox guard first.
      const determinismViolations =
        scanWorkflowScriptShape(script).determinismViolations;
      if (determinismViolations.length > 0) {
        throw new WorkflowScriptNotLaunchedError(
          describeWorkflowDeterminismViolations(determinismViolations),
          '',
        );
      }

      if (options.resumeFromRunId) {
        // A resume replays a journal. With none to replay it would dispatch
        // every agent again under the old run id while reading as a
        // continuation, so it is refused before anything is spent or written.
        // Without storage there is no journal to have lost, and a resume
        // there has always been a live run under the old id.
        const loaded = await journal?.load();
        if (loaded?.kind === 'missing') {
          throw new WorkflowJournalUnavailableError(
            options.resumeFromRunId,
            'missing',
            `No journal found for workflow run ${options.resumeFromRunId}, so there is nothing to resume. To run the workflow from the start, call Workflow again without resumeFromRunId.`,
          );
        }
        if (loaded?.kind === 'unreadable') {
          throw new WorkflowJournalUnavailableError(
            options.resumeFromRunId,
            'unreadable',
            `Could not read the journal for workflow run ${options.resumeFromRunId}: ${loaded.reason}`,
          );
        }
        resumeReplay = loaded?.replay;
      }
      sourceRef = readWorkflowSourceRef(options.sourceRef);
      if (resumeReplay?.sourceError) throw new Error(resumeReplay.sourceError);
      if (options.resumeFromRunId) {
        const original = resumeReplay?.sourceRef;
        if (
          sourceRef &&
          (!original ||
            sourceRef.id !== original.id ||
            sourceRef.revision !== original.revision)
        ) {
          throw new Error(
            'Workflow sourceRef must match the original journal. Start a new run to use a different source.',
          );
        }
        // After a restart the run's snapshot is what still says it carried a
        // reference. Without it this guard could not fire, and the resumed
        // run would settle without the reference and overwrite the snapshot
        // that held it.
        if (!previousRun) {
          previousRun = await readWorkflowSnapshot(config, runId);
        }
        if (previousRun?.sourceRef && !original) {
          throw new Error(
            'Workflow source metadata is missing from its journal.',
          );
        }
        sourceRef = original;
      }
      // A registry-side cancel (`cancelStarting`, `abortAll`) aborts the
      // reserved controller while the caller's signal stays live. It is a
      // cancel in either mode: registering anyway would let the settlement
      // classifier — which only knows the caller's signal and the entry's
      // status — record the run as failed, or completed for a dispatch-free
      // script, under a client that was just told `{cancelled: true}`.
      assertStartNotCancelled();
      // The caller's own abort is reported the same way for a background
      // start; a foreground start registers and settles `cancelled` so the
      // caller's tool result carries the run it asked for.
      callerWasAbortedBeforeStart = options.signal.aborted;
      if (journal && !(await journal.ensureExists())) {
        journalPath = undefined;
      }
      // Queued before anything else so the journal of a run that launched is
      // never empty: a later resume can then tell a run interrupted before its
      // first result from one whose journal is gone. Not awaited, so a slow
      // disk does not hold the launch: appends are serialized, so it still
      // lands before the `source` record below and every dispatch's lines, and
      // a start that fails from here on reaches `journal.remove()`, which waits
      // for it before deleting.
      if (journal && journalPath && !options.resumeFromRunId) {
        void journal.markLaunched();
      }
      if (sourceRef) {
        if (!journal || !journalPath) {
          throw new Error(
            'Workflow sourceRef requires a writable resume journal.',
          );
        }
        if (!options.resumeFromRunId) {
          await journal.append({ type: 'source', version: 1, sourceRef });
        }
      }
      // Persisted only once the run is certain to start: a script that never
      // compiled, and a start the registry cancelled out from under us, leave
      // no file behind. A resume of an inline script overwrites the copy from
      // the original run, which is the file the model was told to edit; a
      // resume that then fails to start puts the original back (see the
      // catch below).
      if (options.script !== undefined && scriptPath === undefined) {
        const persisted = await persistInlineWorkflowScript(
          config,
          runId,
          script,
        );
        scriptPath = persisted ?? undefined;
        persistedInlineScript = persisted !== null;
      }
      const resumeName =
        config.isWorkflowNameOnly?.() === true
          ? await resolveResumeName(config, workflowName, scriptPath)
          : undefined;
      assertStartNotCancelled();
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
          reviewLimits?.subagent,
        );
      orchestrator = new WorkflowOrchestrator(dispatch);
      const registration: WorkflowTaskRegistration = {
        runId,
        toolUseId: options.toolUseId,
        ...(workflowName ? { workflowName } : {}),
        ...(sourceRef ? { sourceRef } : {}),
        meta: null,
        status: 'running',
        startTime: Date.now(),
        outputFile: '',
        abortController: controller,
        // The registry and `/workflows` show one run: a turn target is not
        // this run's cap, and its spend is not this run's alone.
        tokenBudgetTotal: budget.runCap(),
        script,
        scriptPath,
        ...(journalPath ? { journalPath } : {}),
        // A saved workflow is the user's file, and the recovery advice says to
        // copy it first. The name is resolved here — from the resumed run
        // too, which a caller re-running a saved workflow's inline source
        // does not pass — so the hint follows the same decision.
        ...(options.authoringHint && !workflowName
          ? { authoringHint: options.authoringHint }
          : {}),
        ...(resumeName ? { resumeName } : {}),
        args: options.args,
        ...(options.resumeFromRunId
          ? {
              sourceRunId: options.resumeFromRunId,
              startMode: 'retry' as const,
            }
          : {}),
        isBackgrounded: runInBackground,
        notifyOnCompletion: options.notifyOnCompletion,
        resumeInBackground:
          runInBackground &&
          config.isInteractive?.() === true &&
          config.getExperimentalZedIntegration?.() !== true,
      };
      // A resume's checkpoint is not best-effort. `retry` from history
      // refuses a run whose checkpoint is still on disk, reading it as a
      // process that has not been seen to exit; a resume that registers
      // without one leaves another process free to start a second runner on
      // this journal. So it is written first and awaited -- before
      // `register`, which replaces the run's terminal entry and so would
      // have to be undone, while here there is still nothing to undo.
      //
      // Only when this resume has a journal. That is exactly the case the
      // refusal protects: with no journal there is nothing for a second
      // runner to interleave, and a history retry of such a run is refused
      // for want of one anyway.
      if (options.resumeFromRunId && journalPath) {
        checkpointWrite = Promise.resolve(
          await writeWorkflowCheckpoint(
            config,
            checkpointFromTask(registration, checkpointContext()),
          ),
        );
        if ((await checkpointWrite) === 'failed') {
          throw new WorkflowCheckpointUnwritableError(runId);
        }
        // That write is the only await between the check above and
        // `register`, which does not read the controller. A cancel landing
        // during it would otherwise register anyway and settle the run
        // `failed` under a caller that was just told it was cancelled --
        // exactly what the earlier check exists to prevent. The catch below
        // takes the checkpoint back.
        assertStartNotCancelled();
      }
      entry = registry?.register(registration, controller);
    } catch (error) {
      registry?.releaseStart(runId, controller);
      controller.abort();
      if (persistedInlineScript && options.resumeFromRunId === undefined) {
        await deleteInlineWorkflowScript(config, runId);
      }
      if (persistedInlineScript && options.resumeFromRunId && previousRun) {
        await persistInlineWorkflowScript(config, runId, previousRun.script);
      }
      if (options.resumeFromRunId === undefined) {
        await journal?.remove();
      }
      // Written above for a resume that then failed to start: left behind it
      // would read as a live run in another process, and refuse every later
      // retry until the pid that wrote it is gone.
      if ((await checkpointWrite) === 'written') {
        await removeWorkflowCheckpoint(config, runId);
      }
      releasePersistenceActivity();
      throw error;
    }
    // Lets a later process find this run if this one exits before it
    // settles. Not awaited: a fresh run has no history entry for anyone to
    // retry, so nothing about starting depends on it, and the settlement
    // below waits for it before removing it. A resume wrote its own above.
    if (!checkpointWrite && entry) {
      checkpointWrite = writeWorkflowCheckpoint(
        config,
        checkpointFromTask(entry, checkpointContext()),
      );
    }
    const emitUpdate = (): void => {
      if (!entry || !options.onUpdate || !isCurrentEntry()) return;
      try {
        options.onUpdate(entry);
      } catch {
        // UI refresh failures must not affect workflow execution.
      }
    };
    // The large-run flag. Checked whenever the run schedules an agent or
    // records spend; the registry keeps only the first warning.
    const maybeWarnSize = (): void => {
      const current = registry?.get(runId);
      if (!registry || !current || current.sizeWarning !== undefined) return;
      let scheduledAgents = 0;
      let settledAgents = 0;
      for (const dispatch of current.dispatches) {
        // A journal replay spends nothing and schedules no agent.
        if (dispatch.status === 'cached') continue;
        scheduledAgents++;
        if (
          dispatch.status === 'completed' ||
          dispatch.status === 'failed' ||
          dispatch.status === 'cancelled'
        ) {
          settledAgents++;
        }
      }
      const warning = evaluateWorkflowSize(
        { scheduledAgents, settledAgents, tokensSpent: current.tokensSpent },
        sizeCaps,
      );
      if (!warning || !registry.onSizeWarning(runId, warning)) return;
      try {
        logWorkflowSizeWarning(config, new WorkflowSizeWarningEvent(warning));
      } catch {
        // Telemetry must never disturb the run it describes.
      }
    };
    const emitter: WorkflowOrchestratorEmitter = {
      workflowCallUpdated: (call) => {
        if (!isCurrentEntry()) return;
        registry?.onWorkflowCallUpdated(runId, call);
        emitUpdate();
      },
      workflowCallsTruncated: () => {
        if (!isCurrentEntry()) return;
        registry?.onWorkflowCallsTruncated(runId);
        emitUpdate();
      },
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
        maybeWarnSize();
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
        maybeWarnSize();
        emitUpdate();
      },
      resumeRespawn: (line) => {
        if (!isCurrentEntry()) return;
        registry?.onResumeRespawn(runId, line);
        emitUpdate();
      },
    };

    const scheduler = new WorkflowDispatchScheduler(
      reviewLimits?.concurrency ?? resolveConcurrencyLimit(),
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
            maxWallClockMs: reviewLimits?.maxWallClockMs,
            abortOnTimeout: controller,
            runId,
            emitter,
            budget,
            resolveSavedWorkflow: async (ref) => {
              // A model call in a name-only session runs no script it cannot
              // name, nested or not. Any other malformed ref falls through to
              // the resolver's own type error.
              if (
                options.restrictNestedScriptPaths === true &&
                typeof ref === 'object' &&
                ref !== null &&
                'scriptPath' in ref
              ) {
                throw new Error(
                  "workflow({scriptPath}): this session restricts workflows to named workflows (tools.workflowNameOnly) — nest with workflow('<name>') instead.",
                );
              }
              return resolveSavedWorkflowScript(ref, config);
            },
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
              // Read off the dispatch traces rather than the counters: a
              // dispatch that failed or replayed from cache still counts as
              // completed, so without these three a run that lost half its
              // fan-out and one that lost none report identically.
              agents_failed: entry.dispatches.reduce(
                (n, dispatch) => (dispatch.status === 'failed' ? n + 1 : n),
                0,
              ),
              agents_cached: entry.dispatches.reduce(
                (n, dispatch) => (dispatch.status === 'cached' ? n + 1 : n),
                0,
              ),
              agents_respawned: entry.agentsRespawned ?? 0,
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
          // The run settled, so nothing is left for a later process to
          // claim — even when the snapshot write failed, since a claim would
          // then call a run interrupted that was not.
          if (checkpointWrite) {
            await checkpointWrite;
            await removeWorkflowCheckpoint(config, runId);
          }
          releasePersistenceActivity();
          registry?.releaseHandle(runId, handle);
        }
      },
      {
        ...(scriptPath ? { scriptPath } : {}),
        ...(journalPath ? { journalPath } : {}),
        ...(sourceRef ? { sourceRef } : {}),
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
