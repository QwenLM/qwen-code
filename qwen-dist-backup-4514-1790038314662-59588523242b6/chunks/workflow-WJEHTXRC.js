// Force strict mode and setup for ESM
"use strict";
import {
  DEFAULT_MAX_AGENTS_PER_RUN,
  DEFAULT_WORKFLOW_SUBAGENT_MAX_TIME_MINUTES,
  DEFAULT_WORKFLOW_SUBAGENT_MAX_TURNS,
  MAX_TOKENS_PER_WORKFLOW_ENV,
  MAX_WORKFLOW_AGENTS_ENV,
  MAX_WORKFLOW_CONCURRENCY_ENV,
  WORKFLOW_AUTHORING_SKILL_NAME,
  WORKFLOW_SUBAGENT_MAX_MINUTES_ENV,
  WORKFLOW_SUBAGENT_MAX_TURNS_ENV,
  WorkflowBudgetImpl,
  WorkflowDispatchScheduler,
  WorkflowExecutionError,
  WorkflowJournal,
  WorkflowOrchestrator,
  createProductionDispatch,
  describeWorkflowDeterminismViolations,
  readWorkflowAuthoringReference,
  resolveConcurrencyLimit,
  resolveReviewWorkflowLimits,
  resolveWorkflowAuthoringSurface,
  scanWorkflowScriptShape,
  toolSearchRevealSentence,
  writeWorkflowSnapshot
} from "./chunk-CAAUC2LP.js";
import {
  RESUME_ARGS_TOO_LARGE_NOTE,
  buildFailureLines,
  buildResumeCall,
  buildWorkflowSizeGuidelineParagraph,
  compileWorkflowScript,
  computeWorkflowScriptDigest,
  deleteInlineWorkflowScript,
  describeWorkflowCompileError,
  evaluateWorkflowSize,
  extractAndStripMeta,
  findActiveExtensionWorkflowByPath,
  findActiveExtensionWorkflowByPathCanonical,
  getActiveExtensionWorkflows,
  getRuleDisplayName,
  getWorkflowTaskMutationKey,
  hasUninlinableResumeArgs,
  isSymlinkedRoot,
  isTerminalWorkflowStatus,
  markWorkflowRunPersistenceActive,
  parseExtensionWorkflowName,
  persistInlineWorkflowScript,
  readWorkflowSourceRef,
  resolveSavedWorkflowScript,
  resolveToolName,
  resolveWorkflowSizeCaps,
  resolveWorkflowSizeGuidelineSetting,
  tryWithWorkflowTaskMutation
} from "./chunk-MRTRBONQ.js";
import "./chunk-GOFAQQZA.js";
import "./chunk-65I7S4Z3.js";
import "./chunk-HEOH7JZY.js";
import "./chunk-TWPJO254.js";
import "./chunk-CQ35AJ4Z.js";
import "./chunk-4YS7RMCB.js";
import "./chunk-PQQV3OBW.js";
import "./chunk-ANKISCKU.js";
import "./chunk-4SZ2636R.js";
import "./chunk-5EZRLTLQ.js";
import "./chunk-QHWCP53L.js";
import "./chunk-C4FISGDN.js";
import "./chunk-O6GEWCJA.js";
import "./chunk-KS6F6LZQ.js";
import "./chunk-6PVPNMXU.js";
import "./chunk-OB57Y2WH.js";
import "./chunk-IMV5DBIP.js";
import "./chunk-IWMYX5LB.js";
import "./chunk-QJNDUTOL.js";
import "./chunk-QPTE6BKL.js";
import "./chunk-U6H3XTFA.js";
import "./chunk-ACHCT36C.js";
import "./chunk-CHEIIBT3.js";
import "./chunk-GHG4PQY2.js";
import "./chunk-YVYK3JYU.js";
import "./chunk-Q5N5NEVT.js";
import "./chunk-ADN5KESB.js";
import "./chunk-SK3RZOPS.js";
import "./chunk-EVZT24AF.js";
import "./chunk-ELRMZTPF.js";
import "./chunk-B5WYAQ4I.js";
import "./chunk-JX6XHPTX.js";
import "./chunk-6C3D7BKK.js";
import "./chunk-ZAQM5T2X.js";
import "./chunk-MNU36NGH.js";
import "./chunk-B3HGO6BB.js";
import "./chunk-AUFTA63J.js";
import "./chunk-SATGWSS6.js";
import "./chunk-MLXTMF7H.js";
import "./chunk-BQMSZSG6.js";
import "./chunk-WFNEY5G7.js";
import "./chunk-5FHOPPLZ.js";
import "./chunk-S6LOFUVP.js";
import "./chunk-BKVPLSEI.js";
import "./chunk-WNM6BA7E.js";
import "./chunk-S7UQ3V2H.js";
import "./chunk-QE36VXWP.js";
import "./chunk-2A6RZKP2.js";
import "./chunk-WDVSRQIQ.js";
import "./chunk-GXNXX7A2.js";
import "./chunk-IITTKFWM.js";
import "./chunk-Z72PLR74.js";
import "./chunk-NUQ4GK5I.js";
import "./chunk-KP2FHIFR.js";
import "./chunk-TLS6QN2S.js";
import "./chunk-NAVJD2PQ.js";
import "./chunk-KKPIFWTZ.js";
import "./chunk-NFC4WTY2.js";
import "./chunk-YSD6IY6F.js";
import {
  createAbortController,
  createChildAbortController
} from "./chunk-DJ2GSRLV.js";
import "./chunk-MS4SXNJ6.js";
import "./chunk-GVTAFLWB.js";
import {
  WorkflowRunEvent,
  WorkflowSizeWarningEvent,
  logWorkflowRun,
  logWorkflowSizeWarning
} from "./chunk-KKGSJZWK.js";
import "./chunk-5ETULJLP.js";
import "./chunk-VGC4I5JJ.js";
import "./chunk-RVT5L74D.js";
import "./chunk-HD7O6WLV.js";
import {
  isWithinRoot
} from "./chunk-25FMWESU.js";
import "./chunk-CFMZLE3L.js";
import "./chunk-43QUA4MC.js";
import "./chunk-WZAD4ZNJ.js";
import "./chunk-EKBQJ627.js";
import "./chunk-KUON6Z6R.js";
import "./chunk-XZA32HII.js";
import "./chunk-CA63HYHU.js";
import "./chunk-SBP43AO6.js";
import "./chunk-HHJLM3WQ.js";
import {
  stripAnsiAndControl
} from "./chunk-B3XJFEEH.js";
import "./chunk-74TONY4F.js";
import "./chunk-ZRQGTRHA.js";
import {
  BaseDeclarativeTool,
  BaseToolInvocation
} from "./chunk-VPGRGNNH.js";
import {
  ToolDisplayNames,
  ToolNames
} from "./chunk-ERIBG3BX.js";
import "./chunk-ZYDMQCQP.js";
import "./chunk-S34QJ6IR.js";
import "./chunk-TBWQLLFO.js";
import "./chunk-UKMWZ5NS.js";
import "./chunk-75DOP5OR.js";
import "./chunk-DMTGGOSA.js";
import "./chunk-YQ3U5MUC.js";
import "./chunk-MATEIJZF.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/tools/workflow/workflow.ts
init_esbuild_shims();

// packages/core/src/agents/runtime/workflow-runner.ts
init_esbuild_shims();
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
async function resolveResumeName(config, workflowName, scriptPath) {
  if (!workflowName || !scriptPath) return void 0;
  const canonical = /* @__PURE__ */ __name((file) => fs.realpath(file).catch(() => path.resolve(file)), "canonical");
  try {
    const resolved = await resolveSavedWorkflowScript(workflowName, config);
    const [byName, ran] = await Promise.all([
      canonical(resolved.scriptPath),
      canonical(scriptPath)
    ]);
    return byName === ran ? workflowName : void 0;
  } catch {
    return void 0;
  }
}
__name(resolveResumeName, "resolveResumeName");
var WorkflowRunHandle = class {
  constructor(runId, budget, registry, controller, scheduler, start, locations = {}) {
    this.runId = runId;
    this.budget = budget;
    this.registry = registry;
    this.controller = controller;
    this.scheduler = scheduler;
    this.scriptPath = locations.scriptPath;
    this.journalPath = locations.journalPath;
    this.sourceRef = locations.sourceRef;
    this.completion = Promise.resolve().then(start);
  }
  static {
    __name(this, "WorkflowRunHandle");
  }
  completion;
  /**
   * Where this run's script lives on disk: the file a `{scriptPath}` launch
   * loaded, or the persisted copy of an inline `{script}`. `undefined` when
   * an inline script could not be persisted (no `storage`, symlinked root,
   * write failure) — callers report the run without it rather than naming a
   * path that does not exist.
   */
  scriptPath;
  /** This run's resume journal, when the config has a `storage` to hold one. */
  journalPath;
  sourceRef;
  abort() {
    this.controller.abort();
  }
  pause() {
    return this.scheduler.pause();
  }
  resume() {
    return this.scheduler.resume();
  }
};
var WORKFLOW_SCRIPT_SYNTAX_HINT = "Workflow scripts must be plain JavaScript \u2014 the usual causes are TypeScript syntax (type annotations, interfaces, generics) and broken string quoting or escaping. Metadata must use literal values.";
var WorkflowScriptNotLaunchedError = class extends Error {
  /**
   * @param detail What is wrong with the script.
   * @param hint The usual causes, appended after `detail`. Defaults to the
   *   syntax causes of a compile failure; a refusal with a cause of its own
   *   passes an empty hint, so the reader is not sent looking for TypeScript
   *   syntax that is not there.
   */
  constructor(detail, hint = WORKFLOW_SCRIPT_SYNTAX_HINT) {
    super(
      `Workflow script is invalid and was not launched:
${detail}` + (hint ? `

${hint}` : "")
    );
    this.detail = detail;
    this.name = "WorkflowScriptNotLaunchedError";
  }
  static {
    __name(this, "WorkflowScriptNotLaunchedError");
  }
};
var WorkflowStartCancelledError = class extends Error {
  static {
    __name(this, "WorkflowStartCancelledError");
  }
  constructor() {
    super("Workflow start was cancelled.");
    this.name = "WorkflowStartCancelledError";
  }
};
var WorkflowRunner = class {
  static {
    __name(this, "WorkflowRunner");
  }
  static async start(options) {
    if (options.resumeFromRunId) {
      const attempt = await tryWithWorkflowTaskMutation(
        getWorkflowTaskMutationKey(options.config, options.resumeFromRunId),
        () => this.startClaimed(options)
      );
      if (!attempt.acquired) {
        throw new Error(
          `Workflow run ${options.resumeFromRunId} is already being modified.`
        );
      }
      return attempt.value;
    }
    return this.startClaimed(options);
  }
  static async startClaimed(options) {
    const config = options.config;
    const runInBackground = options.runInBackground === true;
    const budget = WorkflowBudgetImpl.fromConfig(config);
    const sizeCaps = resolveWorkflowSizeCaps(
      config.getWorkflowSizeGuideline?.() ?? resolveWorkflowSizeGuidelineSetting(void 0)
    );
    const runId = options.resumeFromRunId ?? `wf_${randomBytes(8).toString("hex")}`;
    const registry = config.getWorkflowRunRegistry?.();
    let entry;
    const isCurrentEntry = /* @__PURE__ */ __name(() => registry === void 0 || entry !== void 0 && registry.get(runId) === entry, "isCurrentEntry");
    const createController = /* @__PURE__ */ __name(() => runInBackground ? createAbortController() : createChildAbortController(options.signal), "createController");
    const controller = registry ? registry.reserveStart(runId, createController) : createController();
    const releasePersistenceActivity = markWorkflowRunPersistenceActive(
      config,
      runId
    );
    const assertStartNotCancelled = /* @__PURE__ */ __name(() => {
      if (controller.signal.aborted && !options.signal.aborted) {
        throw new WorkflowStartCancelledError();
      }
      if (runInBackground && options.signal.aborted) {
        throw new WorkflowStartCancelledError();
      }
    }, "assertStartNotCancelled");
    const storage = config.storage;
    const previousEntry = registry?.get(runId);
    let journalPath = storage ? storage.getWorkflowRunJournalPath(runId) : void 0;
    const journal = journalPath ? new WorkflowJournal(journalPath, storage.getWorkflowRunsDir()) : void 0;
    let script;
    let scriptPath;
    let resumeReplay;
    let sourceRef;
    let persistedInlineScript = false;
    let callerWasAbortedBeforeStart;
    let orchestrator;
    let reviewLimits;
    try {
      const loaded = options.loadScript ? await options.loadScript() : options.scriptPath && options.script === void 0 ? await resolveSavedWorkflowScript(
        { scriptPath: options.scriptPath },
        config
      ) : void 0;
      script = loaded?.script ?? options.script ?? "";
      scriptPath = loaded?.scriptPath ?? options.scriptPath;
      if (loaded && scriptPath && storage) {
        reviewLimits = await resolveReviewWorkflowLimits(
          scriptPath,
          storage.getGeneratedWorkflowsDir(),
          script
        );
      }
      const workflowName = options.workflowName ?? loaded?.savedWorkflowName ?? registry?.get(runId)?.workflowName;
      try {
        compileWorkflowScript(script);
      } catch (error) {
        throw new WorkflowScriptNotLaunchedError(
          describeWorkflowCompileError(
            error,
            script.split(/\r\n|[\n\r\u2028\u2029]/).length
          )
        );
      }
      const determinismViolations = scanWorkflowScriptShape(script).determinismViolations;
      if (determinismViolations.length > 0) {
        throw new WorkflowScriptNotLaunchedError(
          describeWorkflowDeterminismViolations(determinismViolations),
          ""
        );
      }
      resumeReplay = options.resumeFromRunId ? await journal?.load() : void 0;
      sourceRef = readWorkflowSourceRef(options.sourceRef);
      if (resumeReplay?.sourceError) throw new Error(resumeReplay.sourceError);
      if (options.resumeFromRunId) {
        const original = resumeReplay?.sourceRef;
        if (sourceRef && (!original || sourceRef.id !== original.id || sourceRef.revision !== original.revision)) {
          throw new Error(
            "Workflow sourceRef must match the original journal. Start a new run to use a different source."
          );
        }
        if (previousEntry?.sourceRef && !original) {
          throw new Error(
            "Workflow source metadata is missing from its journal."
          );
        }
        sourceRef = original;
      }
      assertStartNotCancelled();
      callerWasAbortedBeforeStart = options.signal.aborted;
      if (journal && !await journal.ensureExists()) {
        journalPath = void 0;
      }
      if (sourceRef) {
        if (!journal || !journalPath) {
          throw new Error(
            "Workflow sourceRef requires a writable resume journal."
          );
        }
        if (!options.resumeFromRunId) {
          await journal.append({ type: "source", version: 1, sourceRef });
        }
      }
      if (options.script !== void 0 && scriptPath === void 0) {
        const persisted = await persistInlineWorkflowScript(
          config,
          runId,
          script
        );
        scriptPath = persisted ?? void 0;
        persistedInlineScript = persisted !== null;
      }
      const resumeName = config.isWorkflowNameOnly?.() === true ? await resolveResumeName(config, workflowName, scriptPath) : void 0;
      assertStartNotCancelled();
      const dispatch = options.dispatch ?? createProductionDispatch(
        config,
        controller.signal,
        (outputTokens) => budget.recordSpent(outputTokens),
        registry ? (emitter2, dispatchId) => isCurrentEntry() ? registry.bridgeApprovalEvents(
          runId,
          emitter2,
          dispatchId,
          entry
        ) : () => void 0 : void 0,
        reviewLimits?.subagent
      );
      orchestrator = new WorkflowOrchestrator(dispatch);
      entry = registry?.register(
        {
          runId,
          toolUseId: options.toolUseId,
          ...workflowName ? { workflowName } : {},
          ...sourceRef ? { sourceRef } : {},
          meta: null,
          status: "running",
          startTime: Date.now(),
          outputFile: "",
          abortController: controller,
          // The registry and `/workflows` show one run: a turn target is not
          // this run's cap, and its spend is not this run's alone.
          tokenBudgetTotal: budget.runCap(),
          script,
          scriptPath,
          ...journalPath ? { journalPath } : {},
          // A saved workflow is the user's file, and the recovery advice says to
          // copy it first. The name is resolved here — from the resumed run
          // too, which a caller re-running a saved workflow's inline source
          // does not pass — so the hint follows the same decision.
          ...options.authoringHint && !workflowName ? { authoringHint: options.authoringHint } : {},
          ...resumeName ? { resumeName } : {},
          args: options.args,
          ...options.resumeFromRunId ? {
            sourceRunId: options.resumeFromRunId,
            startMode: "retry"
          } : {},
          isBackgrounded: runInBackground,
          resumeInBackground: runInBackground && config.isInteractive?.() === true && config.getExperimentalZedIntegration?.() !== true
        },
        controller
      );
    } catch (error) {
      registry?.releaseStart(runId, controller);
      controller.abort();
      if (persistedInlineScript && options.resumeFromRunId === void 0) {
        await deleteInlineWorkflowScript(config, runId);
      }
      if (persistedInlineScript && options.resumeFromRunId && previousEntry) {
        await persistInlineWorkflowScript(config, runId, previousEntry.script);
      }
      if (options.resumeFromRunId === void 0) {
        await journal?.remove();
      }
      releasePersistenceActivity();
      throw error;
    }
    const emitUpdate = /* @__PURE__ */ __name(() => {
      if (!entry || !options.onUpdate || !isCurrentEntry()) return;
      try {
        options.onUpdate(entry);
      } catch {
      }
    }, "emitUpdate");
    const maybeWarnSize = /* @__PURE__ */ __name(() => {
      const current = registry?.get(runId);
      if (!registry || !current || current.sizeWarning !== void 0) return;
      let scheduledAgents = 0;
      let settledAgents = 0;
      for (const dispatch of current.dispatches) {
        if (dispatch.status === "cached") continue;
        scheduledAgents++;
        if (dispatch.status === "completed" || dispatch.status === "failed" || dispatch.status === "cancelled") {
          settledAgents++;
        }
      }
      const warning = evaluateWorkflowSize(
        { scheduledAgents, settledAgents, tokensSpent: current.tokensSpent },
        sizeCaps
      );
      if (!warning || !registry.onSizeWarning(runId, warning)) return;
      try {
        logWorkflowSizeWarning(config, new WorkflowSizeWarningEvent(warning));
      } catch {
      }
    }, "maybeWarnSize");
    const emitter = {
      workflowCallUpdated: /* @__PURE__ */ __name((call) => {
        if (!isCurrentEntry()) return;
        registry?.onWorkflowCallUpdated(runId, call);
        emitUpdate();
      }, "workflowCallUpdated"),
      workflowCallsTruncated: /* @__PURE__ */ __name(() => {
        if (!isCurrentEntry()) return;
        registry?.onWorkflowCallsTruncated(runId);
        emitUpdate();
      }, "workflowCallsTruncated"),
      phaseStarted: /* @__PURE__ */ __name((title) => {
        if (!isCurrentEntry()) return;
        registry?.onPhaseStarted(runId, title);
        emitUpdate();
      }, "phaseStarted"),
      agentDispatched: /* @__PURE__ */ __name(() => {
        if (!isCurrentEntry()) return;
        registry?.onAgentDispatched(runId);
        emitUpdate();
      }, "agentDispatched"),
      agentCompleted: /* @__PURE__ */ __name(() => {
        if (!isCurrentEntry()) return;
        registry?.onAgentCompleted(runId);
      }, "agentCompleted"),
      dispatchQueued: /* @__PURE__ */ __name((event) => {
        if (!isCurrentEntry()) return;
        registry?.onDispatchQueued(runId, event);
        maybeWarnSize();
        emitUpdate();
      }, "dispatchQueued"),
      dispatchStarted: /* @__PURE__ */ __name((dispatchId, startedAt) => {
        if (!isCurrentEntry()) return;
        registry?.onDispatchStarted(runId, dispatchId, startedAt);
        emitUpdate();
      }, "dispatchStarted"),
      dispatchSettled: /* @__PURE__ */ __name((dispatchId, error, endedAt) => {
        if (!isCurrentEntry()) return;
        registry?.onDispatchSettled(
          runId,
          dispatchId,
          error,
          endedAt,
          !runInBackground && options.signal.aborted
        );
        emitUpdate();
      }, "dispatchSettled"),
      // The registry records this without firing a status update, avoiding a
      // TUI redraw per line while retaining the real replay timestamp.
      logAppended: /* @__PURE__ */ __name((line) => {
        if (!isCurrentEntry()) return;
        registry?.onLogAppended(runId, line);
      }, "logAppended"),
      budgetUpdated: /* @__PURE__ */ __name((spent, total) => {
        if (!isCurrentEntry()) return;
        registry?.onBudgetUpdated(runId, spent, total);
        maybeWarnSize();
        emitUpdate();
      }, "budgetUpdated"),
      resumeRespawn: /* @__PURE__ */ __name((line) => {
        if (!isCurrentEntry()) return;
        registry?.onResumeRespawn(runId, line);
        emitUpdate();
      }, "resumeRespawn")
    };
    const scheduler = new WorkflowDispatchScheduler(
      reviewLimits?.concurrency ?? resolveConcurrencyLimit(),
      controller.signal,
      ({ state }) => {
        if (!isCurrentEntry()) return;
        registry?.onDispatchStateChange(runId, state);
      }
    );
    const handle = new WorkflowRunHandle(
      runId,
      budget,
      registry,
      controller,
      scheduler,
      async () => {
        try {
          const outcome = await orchestrator.run({
            script,
            args: options.args,
            maxWallClockMs: reviewLimits?.maxWallClockMs,
            abortOnTimeout: controller,
            runId,
            emitter,
            budget,
            resolveSavedWorkflow: /* @__PURE__ */ __name(async (ref) => {
              if (options.restrictNestedScriptPaths === true && typeof ref === "object" && ref !== null && "scriptPath" in ref) {
                throw new Error(
                  "workflow({scriptPath}): this session restricts workflows to named workflows (tools.workflowNameOnly) \u2014 nest with workflow('<name>') instead."
                );
              }
              return resolveSavedWorkflowScript(ref, config);
            }, "resolveSavedWorkflow"),
            journal,
            resumeReplay,
            scheduler
          });
          if (entry) {
            entry.meta = outcome.meta;
            if (outcome.meta?.name && entry.description === runId) {
              entry.description = outcome.meta.name;
            }
          }
          registry?.setRecentLogs(runId, outcome.logs);
          if (entry && isTerminalWorkflowStatus(entry.status)) {
            return {
              ok: false,
              message: entry.status === "cancelled" ? "Workflow run cancelled." : entry.error ?? "Workflow run failed."
            };
          }
          registry?.complete(runId, outcome.result, Date.now());
          return { ok: true, outcome };
        } catch (error) {
          const details = error instanceof WorkflowExecutionError ? error : void 0;
          const message = extractErrorMessage(error);
          if (entry && details?.meta && !entry.meta) entry.meta = details.meta;
          if (details?.logs) registry?.setRecentLogs(runId, details.logs);
          if (entry && isTerminalWorkflowStatus(entry.status)) {
            return {
              ok: false,
              message: entry.status === "cancelled" ? "Workflow run cancelled." : entry.error ?? message,
              details
            };
          }
          if (callerWasAbortedBeforeStart || !runInBackground && options.signal.aborted) {
            registry?.cancel(runId, Date.now());
          } else {
            registry?.fail(runId, message, Date.now());
          }
          return { ok: false, message, details };
        } finally {
          controller.abort();
          if (entry && isTerminalWorkflowStatus(entry.status)) {
            const telemetryEvent = new WorkflowRunEvent({
              status: entry.status,
              agents_dispatched: entry.agentsDispatched,
              agents_completed: entry.agentsCompleted,
              // Read off the dispatch traces rather than the counters: a
              // dispatch that failed or replayed from cache still counts as
              // completed, so without these three a run that lost half its
              // fan-out and one that lost none report identically.
              agents_failed: entry.dispatches.reduce(
                (n, dispatch) => dispatch.status === "failed" ? n + 1 : n,
                0
              ),
              agents_cached: entry.dispatches.reduce(
                (n, dispatch) => dispatch.status === "cached" ? n + 1 : n,
                0
              ),
              agents_respawned: entry.agentsRespawned ?? 0,
              phase_count: entry.phases.length,
              tokens_spent: entry.tokensSpent,
              duration_ms: (entry.endTime ?? entry.startTime) - entry.startTime
            });
            const snapshotPersisted = await writeWorkflowSnapshot(
              config,
              entry
            );
            if (snapshotPersisted) {
              registry?.notifySnapshotPersisted(entry.runId);
            }
            await journal?.drain();
            try {
              logWorkflowRun(config, telemetryEvent);
            } catch {
            }
          }
          releasePersistenceActivity();
          registry?.releaseHandle(runId, handle);
        }
      },
      {
        ...scriptPath ? { scriptPath } : {},
        ...journalPath ? { journalPath } : {},
        ...sourceRef ? { sourceRef } : {}
      }
    );
    registry?.attachHandle(handle);
    return handle;
  }
};
function extractErrorMessage(error) {
  if (error && typeof error === "object" && "message" in error) {
    const message = error.message;
    if (typeof message === "string") return message;
    return String(message);
  }
  return String(error);
}
__name(extractErrorMessage, "extractErrorMessage");

// packages/core/src/tools/workflow/workflow.ts
import { promises as fs2 } from "node:fs";
import * as path2 from "node:path";
var WORKFLOW_PARAM_SCHEMA = {
  type: "object",
  properties: {
    sourceRef: {
      type: "object",
      description: "Optional caller-supplied definition id and revision for run correlation. Requires a writable journal; omit for ordinary workflows.",
      properties: {
        id: { type: "string", minLength: 1, maxLength: 256 },
        revision: { type: "string", minLength: 1, maxLength: 256 }
      },
      required: ["id", "revision"],
      additionalProperties: false
    },
    script: {
      type: "string",
      description: "JavaScript source of the workflow, wrapped as an async IIFE: top-level `await` and `return` are both legal, and a trailing expression is NOT a return value. Uses the injected globals `phase()`, `log()`, `agent()`, `parallel()`, `pipeline()`, `workflow()`, `args` and `budget`, and cannot import anything. May start with a literal `export const meta = {...}` (stripped before execution). `Math.random()` and all of `Date` (`new Date()`, `Date.now()` included) throw \u2014 a script must be deterministic for resume, so pass timestamps in via `args` or stamp the result after the run returns. Pass THUNKS to parallel(), not eager calls: `parallel([() => agent(...)])`, not `parallel([agent(...)])`."
    },
    scriptPath: {
      type: "string",
      description: "Optional. Absolute path to a workflow `.js` file to load and run instead of inline `script`. Primarily set by the `/<name>` saved-workflow slash command; a tool that generated a script for this run hands you its path the same way. The file must resolve inside a saved-workflow directory (`.qwen/workflows`, `~/.qwen/workflows`), be a workflow file an active extension ships, or sit under the generated-scripts root (`$QWEN_CODE_PROJECT_DIR/workflows/generated` \u2014 the per-project runtime dir, not the project tree) \u2014 any other path is refused. Provide exactly ONE of `script`, `scriptPath` or `name`. The file is read once per call, before approval, so edits to a saved workflow take effect on the next call. An inline `script` is persisted to `<generated root>/inline/<runId>.js` and that path comes back in the result, so a resume passes the path instead of the source."
    },
    name: {
      type: "string",
      description: "Optional. Name of a saved workflow to run instead of inline `script`: `<name>` for one in `.qwen/workflows` or `~/.qwen/workflows`, or `<extension>:<name>` for one an active extension ships. Provide exactly ONE of `script`, `scriptPath` or `name`."
    },
    args: {
      description: "Optional structured value bound to the `args` global. Pass actual JSON, not a stringified value."
    },
    resumeFromRunId: {
      type: "string",
      description: "Optional. Resume a prior workflow run by id (e.g. wf_abc123\u2026). Re-runs the supplied script or returned script path; agent() calls whose rolling prefix-hash (prompt + opts, chained in call order) matches a journaled result are served from cache for the longest unchanged prefix, and the first changed/missing call onward runs live. Pass the `scriptPath` the original run returned and the same `args`. Editing a saved workflow changes future runs too, so copy it for run-specific edits. Replay requires a journal; without one, every agent() call runs live. The journal keys hash each agent() call's prompt and opts, not the script text, so post-processing can change without losing the cache."
    },
    run_in_background: {
      type: "boolean",
      default: false,
      description: "Optional. When true, start the workflow under the interactive session and return a run handle immediately. The Background Tasks view can observe, cooperatively pause/resume, or stop it, and completion is delivered to the conversation when the run settles. Interactive TUI only. Defaults to false."
    }
  }
  // Exactly one of `script`, `scriptPath` and `name`; that can't be expressed
  // as a plain `required` list, so it's enforced in `validateToolParamValues`.
  // Inline authoring (the LLM path) passes `script`; the `scriptPath` and
  // `name` property descriptions state the rule.
};
var WorkflowToolInvocation = class extends BaseToolInvocation {
  constructor(config, toolOptions, params, authoringHint, workflowName, sessionOwned = false) {
    super(params);
    this.config = config;
    this.toolOptions = toolOptions;
    this.authoringHint = authoringHint;
    this.workflowName = workflowName;
    this.sessionOwned = sessionOwned;
  }
  static {
    __name(this, "WorkflowToolInvocation");
  }
  callId;
  /**
   * The failure hint, when the failing script is one this call authored.
   *
   * A saved workflow is the user's file, and the resume advice already tells
   * the model to copy it before making a run-specific change — "fix the script,
   * and retry" would contradict that in the same message.
   */
  authoredScriptHint() {
    if (!this.authoringHint) return null;
    return isScriptAuthoredByThisCall(
      this.config,
      this.workflowName ?? this.params.name,
      this.params.scriptPath
    ) ? this.authoringHint : null;
  }
  setCallId(callId) {
    this.callId = callId;
  }
  /**
   * Cache so the transcript header and the approval dialog cannot disagree,
   * and so an oversized script is scanned once per invocation rather than
   * once per surface that asks.
   */
  metaCache;
  resolveMeta() {
    if (this.metaCache === void 0) {
      this.metaCache = this.params.script ? readMetaForConfirmation(this.params.script) : null;
    }
    return this.metaCache;
  }
  /**
   * The file a `scriptPath` or `name` call runs, read once. The permission
   * check, the approval dialog and the run all use this one read, so the
   * script the user approved is the script that runs, even when the file
   * changes while the dialog is open.
   */
  scriptLoad;
  /** {@link scriptLoad} once settled, for the synchronous rule-match hook. */
  settledScriptLoad;
  loadReferencedScript() {
    if (this.params.script !== void 0) return void 0;
    const { name, scriptPath } = this.params;
    if (!name && !scriptPath) return void 0;
    this.scriptLoad ??= (async () => {
      try {
        const loaded = await resolveSavedWorkflowScript(
          name ? name : { scriptPath },
          this.config
        );
        return {
          ok: true,
          loaded,
          digest: computeWorkflowScriptDigest(loaded.script)
        };
      } catch (error) {
        return { ok: false, error };
      }
    })().then((load) => {
      this.settledScriptLoad = load;
      return load;
    });
    return this.scriptLoad;
  }
  getDescription() {
    const meta = this.resolveMeta();
    if (meta) {
      return `Run workflow: ${sanitizeLine(meta.name)}`;
    }
    if (this.params.name && this.params.script === void 0) {
      const kind = parseExtensionWorkflowName(this.params.name) ? "extension" : "saved";
      return `Run ${kind} workflow (${sanitizeLine(this.params.name)})`;
    }
    if (this.params.scriptPath && this.params.script === void 0) {
      if (isGeneratedWorkflowScriptPath(this.config, this.params.scriptPath)) {
        return `Run generated workflow script (${path2.basename(this.params.scriptPath)})`;
      }
      const extensionWorkflow = findActiveExtensionWorkflowByPath(
        this.config,
        this.params.scriptPath
      );
      if (extensionWorkflow) {
        return `Run extension workflow (${sanitizeLine(extensionWorkflow.name)})`;
      }
      return `Run saved workflow (${path2.basename(this.params.scriptPath)})`;
    }
    return `Run a workflow script (${this.params.script?.length ?? 0} chars)`;
  }
  toolLocations() {
    return [];
  }
  async getDefaultPermission() {
    const load = await this.loadReferencedScript();
    return load && !load.ok ? "allow" : "ask";
  }
  /**
   * An "always allow" for a saved or extension workflow is pinned to the
   * script it approved: `Workflow(name:gcp:audit,sha256:…)`. The digest is
   * computed from the file this call loaded. A `sha256` the model passed is
   * overwritten, and a call that loaded nothing matches no digest.
   */
  getPermissionMatchParams() {
    const load = this.settledScriptLoad;
    return {
      ...this.params,
      [WORKFLOW_RULE_DIGEST_KEY]: load?.ok ? load.digest : void 0
    };
  }
  /**
   * Show what is about to run, and scope the grant that approves it.
   *
   * Without this override the base class renders `Confirm WorkflowTool` over
   * `Run a workflow script (4127 chars)` — a character count standing in for
   * arbitrary model-authored JavaScript that may fan out to
   * `DEFAULT_MAX_AGENTS_PER_RUN` subagents, provision git worktrees and spend
   * an uncapped token budget. The asymmetry is visible within one run: the
   * subagent approvals this workflow bubbles up each get a full dialog.
   *
   * Two properties of the grant matter as much as the disclosure:
   *
   *   - An inline `script` can never be pre-approved. It is fresh
   *     model-authored source every time, so a blanket "always allow" would
   *     transfer consent from the script the user read to every script the
   *     model writes afterwards. `hideAlwaysAllow` removes the option and the
   *     empty `permissionRules` stops `injectPermissionRulesIfMissing` from
   *     supplying the bare-tool-name rule, which `buildPermissionRules`
   *     documents as matching *all* invocations.
   *   - A `scriptPath` or `name` names a file on disk that the user chose,
   *     so it can be pre-approved — scoped to that path or name, and pinned
   *     to the digest of the content shown here, so a changed script asks
   *     again. The rule is built with the same helpers the matcher uses so a
   *     tool rename moves both sides.
   */
  async getConfirmationDetails(_abortSignal) {
    const load = await this.loadReferencedScript();
    const loaded = load?.ok ? load : void 0;
    const meta = loaded ? readMetaForConfirmation(loaded.loaded.script) : this.resolveMeta();
    const isGeneratedScriptPath = this.params.scriptPath !== void 0 && await isGeneratedWorkflowScriptPathCanonical(
      this.config,
      this.params.scriptPath
    );
    const isGeneratedInlineScriptPath = this.params.scriptPath !== void 0 && await isWorkflowScriptPathWithinCanonicalRoot(
      this.params.scriptPath,
      path2.dirname(this.config.storage.getInlineWorkflowScriptPath("wf_0"))
    );
    const extensionWorkflow = isGeneratedScriptPath ? void 0 : this.params.name ? getActiveExtensionWorkflows(this.config).find(
      (workflow) => workflow.name === this.params.name
    ) : this.params.scriptPath !== void 0 ? await findActiveExtensionWorkflowByPathCanonical(
      this.config,
      this.params.scriptPath
    ) : void 0;
    const body = buildConfirmationPrompt(
      this.params,
      meta,
      isGeneratedScriptPath ? { kind: "generated" } : extensionWorkflow ? { kind: "extension", workflow: extensionWorkflow } : { kind: "saved" },
      loaded ? {
        scriptPath: loaded.loaded.scriptPath,
        script: loaded.loaded.script,
        digest: loaded.digest
      } : load ? { error: describeLoadError(load) } : void 0
    );
    const banner = resolveUsageBanner(
      this.config,
      this.config.getWorkflowRunRegistry?.(),
      WorkflowBudgetImpl.fromConfig(this.config)
    );
    const isInlineScript = this.params.script !== void 0 || isGeneratedInlineScriptPath;
    const grantRule = isInlineScript || !loaded ? void 0 : buildWorkflowGrantRule(this.params, loaded.digest);
    const details = {
      type: "info",
      title: "Run a dynamic workflow?",
      prompt: banner ? `${banner}${body}` : body,
      // The body is a script excerpt and a phase list: rendering it as
      // Markdown would swallow the very characters the reader needs to see.
      renderPromptAsPlainText: true,
      hideAlwaysAllow: grantRule === void 0,
      permissionRules: grantRule ? [grantRule] : [],
      onConfirm: /* @__PURE__ */ __name(async (_outcome, _payload) => {
      }, "onConfirm")
    };
    return details;
  }
  async execute(signal, updateOutput, _shellExecutionConfig) {
    const runInBackground = this.params.run_in_background === true;
    if (runInBackground && signal.aborted) {
      return startCancelledResult();
    }
    const load = this.loadReferencedScript();
    let handle;
    try {
      handle = await WorkflowRunner.start({
        config: this.config,
        signal,
        toolUseId: this.callId,
        ...this.workflowName ? { workflowName: this.workflowName } : {},
        ...authoringHintOption(this.authoredScriptHint()),
        script: this.params.script,
        scriptPath: this.params.scriptPath,
        ...load ? { loadScript: /* @__PURE__ */ __name(() => unwrapScriptLoad(load), "loadScript") } : {},
        args: this.params.args,
        sourceRef: this.params.sourceRef,
        resumeFromRunId: this.params.resumeFromRunId,
        dispatch: this.toolOptions.dispatch,
        runInBackground,
        ...!this.sessionOwned && this.config.isWorkflowNameOnly?.() === true ? { restrictNestedScriptPaths: true } : {},
        onUpdate: !runInBackground && updateOutput ? (entry) => safeEmitUpdate(updateOutput, entry) : void 0
      });
    } catch (error) {
      if (error instanceof WorkflowStartCancelledError || runInBackground && signal.aborted) {
        return startCancelledResult();
      }
      if (error instanceof WorkflowScriptNotLaunchedError) {
        const hint = this.authoredScriptHint();
        const text = hint ? `${error.message}
${hint}` : error.message;
        return {
          llmContent: [{ text }],
          returnDisplay: error.message,
          error: {
            message: text,
            type: "invalid_tool_params" /* INVALID_TOOL_PARAMS */
          }
        };
      }
      throw error;
    }
    if (runInBackground) {
      const status = handle.registry?.get(handle.runId)?.status ?? "running";
      const usageBanner = resolveUsageBanner(
        this.config,
        handle.registry,
        handle.budget
      );
      return {
        workflowRunId: handle.runId,
        ...handle.scriptPath ? { scriptPath: handle.scriptPath } : {},
        ...handle.journalPath ? { journalPath: handle.journalPath } : {},
        ...handle.sourceRef ? { sourceRef: handle.sourceRef } : {},
        llmContent: [
          {
            text: buildBackgroundStartText(handle, status)
          }
        ],
        returnDisplay: usageBanner + `Workflow ${handle.runId} started in the background (status: ${status}). Use Background Tasks to observe, cooperatively pause/resume, or stop it.`
      };
    }
    const settlement = await handle.completion;
    if (settlement.ok) {
      const { outcome } = settlement;
      const usageBanner = resolveUsageBanner(
        this.config,
        handle.registry,
        handle.budget
      );
      const llmText = safeStringifyResult(outcome.result);
      const displayJson = safeStringifyDisplayPayload({
        runId: outcome.runId,
        ...handle.sourceRef ? { sourceRef: handle.sourceRef } : {},
        ...outcome.meta ? { meta: outcome.meta } : {},
        phases: outcome.phases,
        logs: outcome.logs,
        result: outcome.result,
        // P5: surface the per-run token total in the terminal display so
        // the user sees actual usage even without opening the dialog.
        // P5 R1 (#11): align with `buildLivePhaseTreeDisplay` — include
        // tokens whenever ANY usage is reported OR a cap is set, not
        // only when spend > 0. A capped-but-zero-spend run still wants
        // the cap visible so the user sees the gate engaged.
        // Per run, like `/workflows`; a turn target adds the turn's figures
        // beside them rather than in place of them.
        ...handle.budget.runSpent() > 0 || handle.budget.total !== null ? {
          tokens: {
            spent: handle.budget.runSpent(),
            total: handle.budget.runCap(),
            ...handle.budget.source === "directive" ? {
              turnSpent: handle.budget.spent(),
              turnTotal: handle.budget.total
            } : {}
          }
        } : {}
      });
      return {
        ...handle.scriptPath ? { scriptPath: handle.scriptPath } : {},
        ...handle.journalPath ? { journalPath: handle.journalPath } : {},
        ...handle.sourceRef ? { sourceRef: handle.sourceRef } : {},
        // Two parts: the script's return value is left exactly as it was,
        // and the run handle follows as a separate part. Note what this does
        // NOT mean — `convertToFunctionResponse` joins the text parts with a
        // newline, so the model reads `<return value>\n--- workflow run ---…`
        // as one string. Keeping them apart is still what makes the return
        // value untouched at the tool boundary, keeps `returnDisplay` clean,
        // and gives the per-tool head/tail truncator a distinct trailer part.
        // The scheduler-wide persistence gate may still fold both parts into
        // one head-only preview when their combined text crosses its limit.
        llmContent: [
          { text: llmText },
          { text: buildRunTrailer(this.config, handle, this.params.args) }
        ],
        returnDisplay: usageBanner + "```json\n" + displayJson + "\n```"
      };
    } else {
      const { message, details } = settlement;
      const { phases, logs, meta } = details ?? {};
      const cancelled = handle.registry?.get(handle.runId)?.status === "cancelled";
      const failureText = cancelled ? "Workflow cancelled." : `Workflow failed: ${clampForDisplay(
        sanitizeBlock(message),
        TRAILER_ERROR_CHARS
      )}`;
      const trailer = buildRunTrailer(
        this.config,
        handle,
        this.params.args,
        logs,
        !cancelled,
        cancelled ? null : this.authoredScriptHint()
      );
      const display = `${cancelled ? "Workflow cancelled." : `Workflow failed: ${message}`}

${safeStringifyDisplayPayload(
        {
          runId: handle.runId,
          ...meta ? { meta } : {},
          phases: phases ?? [],
          logs: logs ?? []
        }
      )}`;
      return {
        ...handle.scriptPath ? { scriptPath: handle.scriptPath } : {},
        ...handle.journalPath ? { journalPath: handle.journalPath } : {},
        ...handle.sourceRef ? { sourceRef: handle.sourceRef } : {},
        // The failure message alone names what threw but not where to look:
        // the logs the runtime already mirrored (`dispatch failed (result not
        // consumed)` and friends) only reached `returnDisplay`, which the
        // scheduler overwrites with `error.message` — so the model never saw
        // them. Mirror the two content parts into the error message because
        // that is the only text the non-timeout scheduler branch delivers.
        llmContent: [{ text: failureText }, { text: trailer }],
        returnDisplay: display,
        // FIX-10 (REUSE-I1): use the standard ToolErrorType.EXECUTION_FAILED
        // code so error routing / dashboards can classify workflow failures
        // the same way as other execution-time tool errors.
        error: {
          message: `${failureText}
${trailer}`,
          type: "execution_failed" /* EXECUTION_FAILED */
        }
      };
    }
  }
};
var TRAILER_LOG_LINES = 20;
var TRAILER_LOG_LINE_CHARS = 400;
var TRAILER_ERROR_CHARS = 4e3;
function buildRunTrailer(config, handle, args, logs, includeResume = true, authoringHint = null) {
  const lines = [
    "--- workflow run ---",
    `runId: ${sanitizeLine(handle.runId)}`
  ];
  if (handle.scriptPath) {
    lines.push(`script: ${sanitizeLine(handle.scriptPath)}`);
  }
  if (handle.journalPath) {
    lines.push(`journal: ${sanitizeLine(handle.journalPath)}`);
  }
  const entry = handle.registry?.get(handle.runId);
  let failedCount = 0;
  if (entry) {
    const countByStatus = /* @__PURE__ */ __name((status) => entry.dispatches.reduce(
      (n, dispatch) => dispatch.status === status ? n + 1 : n,
      0
    ), "countByStatus");
    const respawned = entry.agentsRespawned ?? 0;
    failedCount = countByStatus("failed");
    lines.push(
      `agents: ${entry.dispatches.length} dispatched` + (respawned > 0 ? ` (${respawned} re-ran from a prior run)` : "") + ` \xB7 ${countByStatus("completed")} completed \xB7 ${countByStatus("cached")} cached \xB7 ${failedCount} failed \xB7 ${countByStatus("cancelled")} cancelled`
    );
  }
  const budget = handle.budget;
  const runSpent = budget.runSpent();
  lines.push(
    budget.source === "directive" && budget.total !== null ? `tokens: ${runSpent} spent by this run \xB7 ${budget.spent()} / ${budget.total} this turn` + (budget.directiveText ? ` (${sanitizeLine(budget.directiveText)} directive)` : "") : budget.total === null ? `tokens: ${runSpent} spent (no cap)` : `tokens: ${runSpent} / ${budget.total} spent`
  );
  const failures = entry ? buildFailureLines(entry) : [];
  if (failures.length > 0 && entry) {
    lines.push(
      `failures (${failedCount}):`,
      ...failures.map(
        (line) => clampForDisplay(sanitizeLine(line), TRAILER_LOG_LINE_CHARS)
      )
    );
  }
  const resume = buildResumeCall({
    runId: handle.runId,
    scriptPath: handle.scriptPath,
    args,
    ...config.isWorkflowNameOnly?.() === true ? { nameOnly: true, resumeName: entry?.resumeName } : {}
  });
  if (resume && includeResume) {
    const scriptPath = handle.scriptPath;
    const isExtensionWorkflow = entry?.workflowName !== void 0 && parseExtensionWorkflowName(entry.workflowName) !== null || scriptPath !== void 0 && findActiveExtensionWorkflowByPath(config, scriptPath) !== void 0;
    const pathAdvice = isExtensionWorkflow ? "this reads an extension's workflow file; copy it into .qwen/workflows before making a run-specific change" : entry?.workflowName || scriptPath !== void 0 && !isGeneratedWorkflowScriptPath(config, scriptPath) ? "this reads the saved workflow; copy it before making a run-specific change" : "edit that generated copy first if the script needs to change";
    const journalAdvice = handle.journalPath ? "the journal replays the longest unchanged prefix of agent() calls, and the first changed call onward runs live" : "no journal was written for this run, so every agent() call runs live";
    lines.push(`resume: ${resume} \u2014 ${pathAdvice}; ${journalAdvice}.`);
    if (hasUninlinableResumeArgs({ runId: handle.runId, args })) {
      lines.push(RESUME_ARGS_TOO_LARGE_NOTE);
    }
  }
  if (authoringHint && !entry?.workflowName) lines.push(authoringHint);
  const tail = (logs ?? []).slice(-TRAILER_LOG_LINES);
  if (tail.length > 0) {
    lines.push(
      `logs (last ${tail.length}):`,
      ...tail.map(
        (line) => clampForDisplay(sanitizeLine(line), TRAILER_LOG_LINE_CHARS)
      )
    );
  }
  return lines.join("\n");
}
__name(buildRunTrailer, "buildRunTrailer");
function buildBackgroundStartText(handle, status) {
  const lines = [
    "Workflow started in background.",
    `Run ID: ${sanitizeLine(handle.runId)}`,
    `Status: ${sanitizeLine(status)}`
  ];
  if (handle.scriptPath) {
    lines.push(`Script file: ${sanitizeLine(handle.scriptPath)}`);
  }
  if (handle.journalPath) {
    lines.push(`Journal: ${sanitizeLine(handle.journalPath)}`);
  }
  lines.push(
    `You will be notified when it settles. Use /workflows ${sanitizeLine(handle.runId)} for the live phase tree.`
  );
  return lines.join("\n");
}
__name(buildBackgroundStartText, "buildBackgroundStartText");
function startCancelledResult() {
  return {
    llmContent: "Workflow was cancelled before it could start.",
    returnDisplay: "Workflow cancelled."
  };
}
__name(startCancelledResult, "startCancelledResult");
function buildLivePhaseTreeDisplay(entry) {
  const payload = {
    runId: entry.runId,
    ...entry.meta ? { meta: entry.meta } : {},
    status: entry.status,
    currentPhase: entry.currentPhase,
    phases: entry.phases,
    agentsDispatched: entry.agentsDispatched,
    agentsCompleted: entry.agentsCompleted
  };
  if (entry.tokensSpent > 0 || entry.tokenBudgetTotal !== null) {
    payload["tokens"] = {
      spent: entry.tokensSpent,
      total: entry.tokenBudgetTotal
    };
  }
  try {
    return "```json\n" + JSON.stringify(payload, null, 2) + "\n```";
  } catch {
    return `Workflow ${entry.runId} \u2014 ${entry.status} \u2014 ${entry.phases.length} phase(s)`;
  }
}
__name(buildLivePhaseTreeDisplay, "buildLivePhaseTreeDisplay");
function resolveUsageBanner(config, registry, budget) {
  if (!registry) return "";
  if (config.getSkipWorkflowUsageWarning?.()) return "";
  if (!registry.shouldShowUsageWarning()) return "";
  return buildUsageBanner(budget);
}
__name(resolveUsageBanner, "resolveUsageBanner");
var CONFIRM_SCRIPT_EXCERPT_CHARS = 1200;
var CONFIRM_ARGS_CHARS = 300;
var CONFIRM_MAX_PHASES = 12;
var CONFIRM_MAX_STRUCTURE_ROWS = 12;
var CONFIRM_STRUCTURE_HEADING = "Structure (where the script calls agent(); a loop or a fan-out runs each call many times):";
function sanitizeLine(text) {
  return stripAnsiAndControl(text);
}
__name(sanitizeLine, "sanitizeLine");
function sanitizeBlock(text) {
  return text.replace(/\t/g, "  ").split("\n").map((line) => stripAnsiAndControl(line)).join("\n");
}
__name(sanitizeBlock, "sanitizeBlock");
function clampForDisplay(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}
\u2026 (${text.length - max} more characters)`;
}
__name(clampForDisplay, "clampForDisplay");
function readMetaForConfirmation(script) {
  try {
    return extractAndStripMeta(script).meta;
  } catch {
    return null;
  }
}
__name(readMetaForConfirmation, "readMetaForConfirmation");
function isGeneratedWorkflowScriptPath(config, scriptPath) {
  return isWithinRoot(scriptPath, config.storage.getGeneratedWorkflowsDir());
}
__name(isGeneratedWorkflowScriptPath, "isGeneratedWorkflowScriptPath");
async function isGeneratedWorkflowScriptPathCanonical(config, scriptPath) {
  return isWorkflowScriptPathWithinCanonicalRoot(
    scriptPath,
    config.storage.getGeneratedWorkflowsDir()
  );
}
__name(isGeneratedWorkflowScriptPathCanonical, "isGeneratedWorkflowScriptPathCanonical");
async function isWorkflowScriptPathWithinCanonicalRoot(scriptPath, root) {
  if (await isSymlinkedRoot(root)) return false;
  let realScriptPath;
  try {
    realScriptPath = await fs2.realpath(scriptPath);
  } catch {
    return isWithinRoot(scriptPath, root);
  }
  let realRoot;
  try {
    realRoot = await fs2.realpath(root);
  } catch {
    realRoot = path2.resolve(root);
  }
  return isWithinRoot(realScriptPath, realRoot);
}
__name(isWorkflowScriptPathWithinCanonicalRoot, "isWorkflowScriptPathWithinCanonicalRoot");
function buildConfirmationPrompt(params, meta, provenance, referenced) {
  const lines = [];
  const loaded = referenced && "script" in referenced ? referenced : void 0;
  const loadError = referenced && "error" in referenced ? referenced.error : void 0;
  const isReference = params.script === void 0 && Boolean(params.name || params.scriptPath);
  if (!isReference) {
    if (meta) {
      lines.push(`Workflow: ${sanitizeLine(meta.name)}`);
      lines.push(sanitizeLine(meta.description));
    } else {
      lines.push("Workflow: (the script declares no meta block)");
    }
  } else if (provenance.kind === "extension") {
    lines.push(`Extension workflow: ${sanitizeLine(provenance.workflow.name)}`);
    lines.push(sanitizeLine(provenance.workflow.description));
    lines.push(
      "",
      `Loaded from: ${sanitizeLine(params.scriptPath ?? loaded?.scriptPath ?? provenance.workflow.scriptPath)}`
    );
  } else {
    const label = provenance.kind === "generated" ? "Generated workflow script" : "Saved workflow";
    lines.push(
      `${label}: ${sanitizeLine(params.name || params.scriptPath || "")}`
    );
    if (meta) {
      lines.push(`Workflow: ${sanitizeLine(meta.name)}`);
      lines.push(sanitizeLine(meta.description));
    }
    if (params.name && loaded) {
      lines.push("", `Loaded from: ${sanitizeLine(loaded.scriptPath)}`);
    }
  }
  if (loadError !== void 0) {
    lines.push("", `Cannot load the script: ${sanitizeLine(loadError)}`);
  }
  if (meta?.phases?.length) {
    const shown = meta.phases.slice(0, CONFIRM_MAX_PHASES);
    lines.push("", `Phases (${meta.phases.length}):`);
    shown.forEach((phase, i) => {
      const detail = phase.detail ? ` \u2014 ${sanitizeLine(phase.detail)}` : "";
      lines.push(`  ${i + 1}. ${sanitizeLine(phase.title)}${detail}`);
    });
    if (meta.phases.length > shown.length) {
      lines.push(`  \u2026 and ${meta.phases.length - shown.length} more`);
    }
  }
  const structureSource = params.script || loaded?.script;
  if (structureSource) {
    const structure = buildConfirmationStructure(structureSource);
    if (structure.length > 0) {
      lines.push("", CONFIRM_STRUCTURE_HEADING, ...structure);
    }
  }
  if (params.resumeFromRunId) {
    lines.push("", `Resuming run: ${sanitizeLine(params.resumeFromRunId)}`);
  }
  if (params.args !== void 0) {
    let rendered;
    try {
      rendered = JSON.stringify(params.args) ?? String(params.args);
    } catch {
      rendered = "(args are not JSON-serializable)";
    }
    lines.push(
      "",
      `Args: ${clampForDisplay(sanitizeLine(rendered), CONFIRM_ARGS_CHARS)}`
    );
  }
  const scriptText = params.script || loaded?.script;
  if (scriptText) {
    lines.push(
      "",
      loaded ? `Script (${WORKFLOW_RULE_DIGEST_KEY} ${loaded.digest}):` : "Script:",
      clampForDisplay(sanitizeBlock(scriptText), CONFIRM_SCRIPT_EXCERPT_CHARS)
    );
  }
  return lines.join("\n");
}
__name(buildConfirmationPrompt, "buildConfirmationPrompt");
function buildConfirmationStructure(script) {
  const shape = scanWorkflowScriptShape(script);
  const shown = shape.rows.slice(0, CONFIRM_MAX_STRUCTURE_ROWS);
  const lines = shown.map((row) => {
    const label = row.kind === "loop" ? `loop ${sanitizeLine(row.condition ?? "")}` : row.kind;
    if (row.count === 0) {
      return `  ${label} \u2014 runs functions built elsewhere in the script`;
    }
    const sites = row.count > 1 ? `, ${row.count} agent() call sites` : "";
    const prompts = row.prompts.map((prompt) => `"${sanitizeLine(prompt)}"`).join(", ");
    return prompts ? `  ${label}${sites} \u2014 ${prompts}` : `  ${label}${sites}`;
  });
  if (shape.rows.length > shown.length) {
    lines.push(`  \u2026 and ${shape.rows.length - shown.length} more`);
  }
  return lines;
}
__name(buildConfirmationStructure, "buildConfirmationStructure");
var WORKFLOW_RULE_DIGEST_KEY = "sha256";
function describeLoadError(load) {
  if (load.ok) return "";
  return load.error instanceof Error ? load.error.message : String(load.error);
}
__name(describeLoadError, "describeLoadError");
async function unwrapScriptLoad(load) {
  const settled = await load;
  if (settled.ok) return settled.loaded;
  throw settled.error;
}
__name(unwrapScriptLoad, "unwrapScriptLoad");
function buildWorkflowGrantRule(params, digest) {
  const [key, value] = params.name ? ["name", params.name] : ["scriptPath", params.scriptPath];
  if (!value || /[,*]/.test(value) || value.trim() !== value) {
    return void 0;
  }
  return `${getRuleDisplayName(resolveToolName(ToolNames.WORKFLOW))}(${key}:${value},${WORKFLOW_RULE_DIGEST_KEY}:${digest})`;
}
__name(buildWorkflowGrantRule, "buildWorkflowGrantRule");
function buildUsageBanner(budget) {
  if (budget.total === null) {
    return `> Workflows have no per-run token cap. Put a \`+500k\`-style target in your message to cap a turn, or set \`${MAX_TOKENS_PER_WORKFLOW_ENV}=<n>\` (env) for a per-run soft cap. Suppress this notice with \`skipWorkflowUsageWarning: true\` in settings.

`;
  }
  if (budget.source === "directive") {
    return `> This turn's output-token target is ${budget.total}` + (budget.directiveText ? ` (set by \`${budget.directiveText}\` in your message)` : "") + `; workflow agent() calls stop once the turn's spend reaches it. Suppress this notice with \`skipWorkflowUsageWarning: true\` in settings.

`;
  }
  return `> Workflow token cap is ${budget.total} (per \`${MAX_TOKENS_PER_WORKFLOW_ENV}\`). Suppress this notice with \`skipWorkflowUsageWarning: true\` in settings.

`;
}
__name(buildUsageBanner, "buildUsageBanner");
function safeEmitUpdate(updateOutput, entry) {
  if (!updateOutput || !entry) return;
  try {
    updateOutput(buildLivePhaseTreeDisplay(entry));
  } catch {
  }
}
__name(safeEmitUpdate, "safeEmitUpdate");
function safeStringifyResult(result) {
  if (result === void 0) return "(workflow returned no value)";
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return `(workflow returned a non-JSON-serializable value of type ${typeof result})`;
  }
}
__name(safeStringifyResult, "safeStringifyResult");
function safeStringifyDisplayPayload(payload) {
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    if (payload && typeof payload === "object") {
      const sanitized = {};
      for (const [key, value] of Object.entries(payload)) {
        try {
          JSON.stringify(value);
          sanitized[key] = value;
        } catch {
          sanitized[key] = `(non-JSON-serializable value of type ${typeof value})`;
        }
      }
      try {
        return JSON.stringify(sanitized, null, 2);
      } catch {
      }
    }
    return "(display payload not JSON-serializable)";
  }
}
__name(safeStringifyDisplayPayload, "safeStringifyDisplayPayload");
var WORKFLOW_TOOL_DECISION = `Execute a workflow script that orchestrates subagents deterministically.

**Only on an explicit request**

Do not call this tool unless the user has asked for multi-agent orchestration. A run can dispatch up to ${DEFAULT_MAX_AGENTS_PER_RUN} subagents and spend tokens accordingly, so that scale has to be requested rather than inferred. It counts as requested when any of these holds:

- The user's message contains the word \`workflow\`; a system reminder confirms it when it does.
- The user asked for orchestration in their own words \u2014 run a workflow, fan out agents, orchestrate this with subagents.
- A skill or slash command that ran \u2014 invoked by the user, or by you through the Skill tool \u2014 instructs you to use this tool.
- The user named a saved workflow to run, reached through \`name\`, \`workflow('<name>')\` or \`scriptPath\`.
- The user asked to resume or continue an earlier run, which is \`resumeFromRunId\`.

Otherwise do not call it, however well the task would parallelize. Do the work in the main loop, or spawn a single subagent for one self-contained piece. When a workflow would genuinely be the better tool, say in one sentence what it would fan out over and roughly how many agents that is, then let the user decide \u2014 and mention that including the word \`workflow\` next time skips the ask.

**What a workflow is for**

Reach for one to be comprehensive (cover every part of the work in parallel), to be confident (independent perspectives and adversarial checks before an answer is committed to), or to take on scale a single context cannot hold. Parallelism on its own is not a reason; work that is already one short sequence of edits belongs in the main loop.`;
var WORKFLOW_TOOL_RUNTIME = `**Runtime**

\`phase(title)\`, \`log(msg)\`, \`agent(prompt, opts?)\`, \`parallel(thunks)\`, \`pipeline(items, ...stages)\`, \`workflow(nameOrRef, args?)\`, plus the \`args\` and \`budget\` globals. Saved workflows are \`<name>.js\` files under \`<projectRoot>/.qwen/workflows\` (project scope, also surfaced as \`/<name>\` slash commands) or \`~/.qwen/workflows\` (user scope), plus active extensions' \`<extension>:<name>\`; \`scriptPath\` additionally accepts an active extension's workflow file or a path inside the generated-scripts root (\`$QWEN_CODE_PROJECT_DIR/workflows/generated\` \u2014 the per-project runtime dir, not the project tree); any other path is refused. Default \`max(2, min(16, availableParallelism()-2))\` agents in flight per run, which follows CPU affinity and container CPU limits (\`${MAX_WORKFLOW_CONCURRENCY_ENV}\`), up to ${DEFAULT_MAX_AGENTS_PER_RUN} agents total (\`${MAX_WORKFLOW_AGENTS_ENV}\`), under a 30-minute wall-clock cap per run (\`QWEN_CODE_MAX_WORKFLOW_SECONDS\`) \u2014 a fan-out near the agent cap will not fit inside the default cap. Each subagent attempt is separately capped at ${DEFAULT_WORKFLOW_SUBAGENT_MAX_TURNS} turns (\`${WORKFLOW_SUBAGENT_MAX_TURNS_ENV}\`) and ${DEFAULT_WORKFLOW_SUBAGENT_MAX_TIME_MINUTES} minutes (\`${WORKFLOW_SUBAGENT_MAX_MINUTES_ENV}\`). \`agent()\` resolves to \`null\` when that admitted agent fails on its own \u2014 turn/time caps, model or setup errors, missing structured output, exhausted stall retries \u2014 for a bare \`await agent()\` exactly as inside \`parallel()\`/\`pipeline()\`, so check for \`null\` wherever you read a result; run-level rejections no later call could survive (the token budget, the ${DEFAULT_MAX_AGENTS_PER_RUN}-agent cap, cancellation) throw instead. \`budget.total\` is the turn's output-token target when the user's message sets one with a \`+500k\`-style directive, and \`budget.spent()\` then counts every output token this turn, the main loop included. Every run hands back its runId, the script's path on disk (an inline script is persisted, so a resume edits that file rather than re-sending the source) and its journal path; read it before diagnosing an empty or surprising result. Runs appear in the background-tasks view and the \`/workflows\` dialog (live phase tree, token usage, cooperative pause/resume, cancel); \`run_in_background: true\` returns a run handle immediately in the interactive TUI and delivers completion through the conversation. Scripts run in a node:vm sandbox with no filesystem or shell access \u2014 all I/O happens through the spawned agents.`;
var WORKFLOW_AUTHORING_POINTER = `**Writing the script**

Before writing a script, load the \`${WORKFLOW_AUTHORING_SKILL_NAME}\` skill \u2014 the authoring reference: the sandbox contract, agent() options, \`pipeline()\` vs \`parallel()\`, verification and convergence patterns, resume, and a worked example.`;
var WORKFLOW_NAME_ONLY_SECTION = `**Named workflows only**

This session restricts this tool to named workflows. Call it as \`{ name, args }\` with the name of a saved or extension workflow; \`script\` and \`scriptPath\` are refused, and a running script cannot nest \`workflow({ scriptPath })\`. Do not write a workflow script in this session. To resume a failed run, pass the same \`name\` and \`args\` with \`resumeFromRunId\`.`;
function withReplacements(text, replacements) {
  return replacements.reduce(
    (current, [from, to]) => current.split(from).join(to),
    text
  );
}
__name(withReplacements, "withReplacements");
var WORKFLOW_TOOL_DECISION_NAME_ONLY = withReplacements(
  WORKFLOW_TOOL_DECISION,
  [
    [
      "reached through `name`, `workflow('<name>')` or `scriptPath`.",
      "reached through `name` or `workflow('<name>')`."
    ]
  ]
);
var WORKFLOW_TOOL_RUNTIME_NAME_ONLY = withReplacements(
  WORKFLOW_TOOL_RUNTIME,
  [
    [
      "; `scriptPath` additionally accepts an active extension's workflow file or a path inside the generated-scripts root (`$QWEN_CODE_PROJECT_DIR/workflows/generated` \u2014 the per-project runtime dir, not the project tree); any other path is refused.",
      "."
    ],
    [
      " (an inline script is persisted, so a resume edits that file rather than re-sending the source)",
      ""
    ]
  ]
);
var WORKFLOW_AUTHORING_TOOL_SEARCH_NOTE = ` ${toolSearchRevealSentence(ToolDisplayNames.SKILL)}`;
var WORKFLOW_AUTHORING_INLINE_NOTE = "Skills cannot be loaded in this session, even one named in a skill listing, so the authoring reference follows in full. Where it points at another skill, that skill is not available here either.";
function buildWorkflowToolDescription(surface, reference = readWorkflowAuthoringReference(), sizeGuideline = null, options = {}) {
  const size = sizeGuideline ? buildWorkflowSizeGuidelineParagraph(sizeGuideline) : null;
  const runtime = size ? `${WORKFLOW_TOOL_RUNTIME}

${size}` : WORKFLOW_TOOL_RUNTIME;
  if (options.nameOnly) {
    const lockedRuntime = size ? `${WORKFLOW_TOOL_RUNTIME_NAME_ONLY}

${size}` : WORKFLOW_TOOL_RUNTIME_NAME_ONLY;
    return `${WORKFLOW_TOOL_DECISION_NAME_ONLY}

${WORKFLOW_NAME_ONLY_SECTION}

${lockedRuntime}`;
  }
  const pointer = `${WORKFLOW_TOOL_DECISION}

${runtime}

${WORKFLOW_AUTHORING_POINTER}`;
  switch (surface) {
    case "pointer":
      return pointer;
    case "pointer-via-tool-search":
      return `${pointer}${WORKFLOW_AUTHORING_TOOL_SEARCH_NOTE}`;
    case "withheld":
      return `${WORKFLOW_TOOL_DECISION}

${runtime}`;
    case "inline":
      return reference ? `${WORKFLOW_TOOL_DECISION}

${size ? `${size}

` : ""}${WORKFLOW_AUTHORING_INLINE_NOTE}

---

${reference.body.trim()}` : pointer;
    default: {
      const unhandled = surface;
      return unhandled;
    }
  }
}
__name(buildWorkflowToolDescription, "buildWorkflowToolDescription");
function buildWorkflowParamSchema(surface, nameOnly = false) {
  if (nameOnly) {
    const {
      script: _script,
      scriptPath: _scriptPath,
      ...properties
    } = WORKFLOW_PARAM_SCHEMA.properties;
    return {
      ...WORKFLOW_PARAM_SCHEMA,
      properties: {
        ...properties,
        name: {
          type: "string",
          description: "Name of the workflow to run: `<name>` for one in `.qwen/workflows` or `~/.qwen/workflows`, or `<extension>:<name>` for one an active extension ships. This session runs named workflows only, so every call passes `name`."
        },
        resumeFromRunId: {
          type: "string",
          description: "Optional. Resume a prior run by id (e.g. wf_abc123\u2026): pass the same `name` and `args` the original run used. agent() calls whose rolling prefix-hash matches a journaled result are served from cache for the longest unchanged prefix, and the first changed or missing call onward runs live."
        }
      }
    };
  }
  const base = WORKFLOW_PARAM_SCHEMA.properties.script.description;
  const where = surface === "pointer" || surface === "pointer-via-tool-search" ? ` agent() options and orchestration patterns are in the \`${WORKFLOW_AUTHORING_SKILL_NAME}\` skill.` : surface === "inline" ? " agent() options and orchestration patterns are in the authoring reference in this tool's description." : "";
  return {
    ...WORKFLOW_PARAM_SCHEMA,
    properties: {
      ...WORKFLOW_PARAM_SCHEMA.properties,
      script: { type: "string", description: `${base}${where}` }
    }
  };
}
__name(buildWorkflowParamSchema, "buildWorkflowParamSchema");
function buildWorkflowAuthoringHint(surface) {
  const loadSkill = `hint: Load the \`${WORKFLOW_AUTHORING_SKILL_NAME}\` skill for the script reference if you have not, fix the script, and retry.`;
  switch (surface) {
    case "pointer":
      return loadSkill;
    case "pointer-via-tool-search":
      return `${loadSkill} ${toolSearchRevealSentence(ToolDisplayNames.SKILL)}`;
    case "inline":
      return "hint: See the authoring reference in this tool's description, fix the script, and retry.";
    case "withheld":
      return null;
    default: {
      const unhandled = surface;
      return unhandled;
    }
  }
}
__name(buildWorkflowAuthoringHint, "buildWorkflowAuthoringHint");
function isScriptAuthoredByThisCall(config, workflowName, scriptPath) {
  if (workflowName) return false;
  if (!scriptPath) return true;
  try {
    return isGeneratedWorkflowScriptPath(config, scriptPath);
  } catch {
    return false;
  }
}
__name(isScriptAuthoredByThisCall, "isScriptAuthoredByThisCall");
function hasInlineScript(params) {
  return typeof params.script === "string" && params.script.length > 0;
}
__name(hasInlineScript, "hasInlineScript");
function hasScriptPath(params) {
  return typeof params.scriptPath === "string" && params.scriptPath.length > 0;
}
__name(hasScriptPath, "hasScriptPath");
function describeUnnamedWorkflowSources(params) {
  const refused = [];
  if (hasInlineScript(params)) refused.push("script");
  if (hasScriptPath(params)) refused.push("scriptPath");
  return refused;
}
__name(describeUnnamedWorkflowSources, "describeUnnamedWorkflowSources");
function authoringHintOption(hint) {
  return hint ? { authoringHint: hint } : {};
}
__name(authoringHintOption, "authoringHintOption");
var WorkflowTool = class extends BaseDeclarativeTool {
  constructor(config, toolOptions = {}) {
    const nameOnly = config.isWorkflowNameOnly?.() === true;
    const surface = nameOnly ? "withheld" : resolveWorkflowAuthoringSurface(config);
    super(
      ToolNames.WORKFLOW,
      ToolDisplayNames.WORKFLOW,
      buildWorkflowToolDescription(
        surface,
        void 0,
        config.getWorkflowSizeGuideline?.() ?? resolveWorkflowSizeGuidelineSetting(void 0),
        { nameOnly }
      ),
      "other" /* Other */,
      buildWorkflowParamSchema(surface, nameOnly),
      /* isOutputMarkdown */
      true,
      /* canUpdateOutput */
      true
    );
    this.config = config;
    this.toolOptions = toolOptions;
    this.authoringSurface = surface;
  }
  static {
    __name(this, "WorkflowTool");
  }
  /**
   * What this tool's description says about the authoring reference, decided
   * once here. The failure hint and the keyword reminder read it instead of
   * asking again, so a mid-session `/skills` toggle cannot make them disagree
   * with the description the model is holding.
   */
  authoringSurface;
  /**
   * Every call the model or a client schedules comes through here; the host's
   * own runs come through {@link buildSessionOwnedBackground} and are not the
   * model's to restrict. In a name-only session a call that carries a script
   * or a script path is refused before anything is read, approved or run.
   */
  build(params) {
    if (this.config.isWorkflowNameOnly?.() === true) {
      const refused = describeUnnamedWorkflowSources(params);
      if (refused.length > 0) {
        throw new Error(
          `WorkflowTool: this session restricts the Workflow tool to named workflows (tools.workflowNameOnly). Not allowed here: ${refused.join(", ")}. Invoke as {name, args} only.`
        );
      }
    }
    return super.build(params);
  }
  buildSessionOwnedBackground(params, workflowName) {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      throw new Error(validationError);
    }
    if (!this.config.getWorkflowRunRegistry().hasCompletionCallback()) {
      throw new Error(
        "WorkflowTool: session-owned background runs require an active workflow completion channel."
      );
    }
    return new WorkflowToolInvocation(
      this.config,
      this.toolOptions,
      { ...params, run_in_background: true },
      buildWorkflowAuthoringHint(this.authoringSurface),
      workflowName,
      /* sessionOwned */
      true
    );
  }
  validateToolParamValues(params) {
    try {
      readWorkflowSourceRef(params.sourceRef);
    } catch (error) {
      return error instanceof Error ? error.message : "Invalid workflow sourceRef.";
    }
    const hasScript = hasInlineScript(params);
    const hasPath = hasScriptPath(params);
    const hasName = typeof params.name === "string" && params.name.length > 0;
    const sources = [hasScript, hasPath, hasName].filter(Boolean).length;
    if (sources === 0) {
      return "WorkflowTool: provide `script` (inline source), `scriptPath` (a workflow script file) or `name` (a saved workflow).";
    }
    if (sources > 1) {
      return "WorkflowTool: provide exactly one of `script`, `scriptPath` or `name`.";
    }
    if (params.resumeFromRunId !== void 0 && !/^wf_[0-9a-f]+$/.test(params.resumeFromRunId)) {
      return "WorkflowTool: `resumeFromRunId` must match the generated id format `wf_<hex>`.";
    }
    if (params.run_in_background === true) {
      if (!this.config.isInteractive() || this.config.getExperimentalZedIntegration?.() === true) {
        return "WorkflowTool: `run_in_background` is available only in the interactive TUI.";
      }
      if (!this.config.getWorkflowRunRegistry().hasCompletionCallback()) {
        return "WorkflowTool: `run_in_background` requires an active workflow completion channel.";
      }
    }
    return null;
  }
  createInvocation(params) {
    return new WorkflowToolInvocation(
      this.config,
      this.toolOptions,
      params,
      buildWorkflowAuthoringHint(this.authoringSurface)
    );
  }
};
export {
  WORKFLOW_NAME_ONLY_SECTION,
  WorkflowTool,
  buildWorkflowToolDescription
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
