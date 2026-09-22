// Force strict mode and setup for ESM
"use strict";
import {
  settleChatRecording,
  subscribeToHeadlessChatRecordingFailures
} from "./chunk-RA6PKQVM.js";
import {
  JsonOutputAdapter
} from "./chunk-EIDNNJX2.js";
import {
  StreamJsonOutputAdapter
} from "./chunk-LPRZ7GBH.js";
import {
  normalizePartList
} from "./chunk-5IENVM7Z.js";
import {
  handleAtCommand
} from "./chunk-CMK5J3CJ.js";
import {
  buildInitialSystemReminders,
  buildSystemMessage,
  computeUsageFromMetrics,
  createAgentToolProgressHandler,
  createToolProgressHandler,
  extractPartsFromUserMessage,
  handleSlashCommand,
  insertAfterFunctionResponses,
  isSlashCommand
} from "./chunk-BQDVNRRN.js";
import {
  RunBudgetEnforcer,
  cleanupReviewWorktreeLeases
} from "./chunk-PL2V2PQ2.js";
import {
  formatDuration
} from "./chunk-WEUQIY3Q.js";
import {
  AlreadyReportedError,
  handleBudgetExceededError,
  handleCancellationError,
  handleError,
  handleMaxTurnsExceededError,
  handleToolError
} from "./chunk-6OHXRCXH.js";
import {
  sanitizeTerminalText
} from "./chunk-47ECGEJC.js";
import {
  isInlineModelOverrideAllowed
} from "./chunk-Y3Q5OK4D.js";
import {
  buildGoalContinuationParts,
  buildSessionRecoveryPlanFromApiHistory,
  detectAutonomousSentinel,
  detectLoopSentinel
} from "./chunk-47GVX3K4.js";
import {
  restoreWorktreeContext
} from "./chunk-M5YIHMXP.js";
import {
  executeToolCall
} from "./chunk-HQI463JG.js";
import {
  GoalPersistenceUnavailableError,
  PLAN_MODE_ENTRY_SIBLING_SKIP_MESSAGE,
  createDuplicateProviderToolCallResponse,
  finalizeToolResponses,
  findPlanModeEntryBatchBoundaryIndex,
  findRepeatedDuplicateProviderToolCall,
  getCachedToolCallFingerprint,
  goalToolResultProvenance,
  isReplayOfHandledToolCall,
  isToolCallConcurrencySafe,
  markDuplicateProviderToolCallResponseSent,
  parseAndFormatApiError,
  partitionByConcurrencySafety,
  recordHandledToolCall
} from "./chunk-MRTRBONQ.js";
import {
  promptIdContext
} from "./chunk-O6GEWCJA.js";
import {
  parsePositiveIntegerEnv
} from "./chunk-6PVPNMXU.js";
import {
  GOAL_PAUSE_REASON_HEADLESS_RUN_ENDED,
  GOAL_PAUSE_REASON_USER_INTERRUPT,
  addAgentOutputMessageAttributes,
  goalPauseReasonForHeadlessFailure,
  goalPauseReasonForRunBudget
} from "./chunk-IMV5DBIP.js";
import {
  clampInlineMediaPart
} from "./chunk-WFNEY5G7.js";
import {
  isSystemReminderContent
} from "./chunk-2A6RZKP2.js";
import {
  formatFullTurnVisionNotice,
  formatVisionBridgeNotice,
  getFullTurnVisionModelSelector,
  hasImageParts,
  runVisionBridge,
  shouldRunVisionBridge,
  splitImageParts,
  uiTelemetryService
} from "./chunk-KKGSJZWK.js";
import {
  endInteractionSpan,
  getActiveInteractionSpan,
  isTelemetrySdkInitialized,
  shutdownTelemetry
} from "./chunk-B3XJFEEH.js";
import {
  ToolNames,
  canonicalToolName
} from "./chunk-ERIBG3BX.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  FatalInputError,
  getErrorType
} from "./chunk-S34QJ6IR.js";
import {
  registerCleanup
} from "./chunk-FR7RJHJR.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/nonInteractiveCli.ts
init_esbuild_shims();
var debugLogger = createDebugLogger("NON_INTERACTIVE_CLI");
var TurnInterruptedError = class extends Error {
  static {
    __name(this, "TurnInterruptedError");
  }
  constructor() {
    super("Operation cancelled.");
    this.name = "TurnInterruptedError";
  }
};
var restoredBackgroundAgentSessions = /* @__PURE__ */ new WeakMap();
var STRUCTURED_SHUTDOWN_HOLDBACK_MS = 500;
function isHeadlessLoopSentinel(prompt) {
  return detectLoopSentinel(prompt) !== null || detectAutonomousSentinel(prompt) !== null;
}
__name(isHeadlessLoopSentinel, "isHeadlessLoopSentinel");
var SUPPRESSED_OUTPUT_SUCCESS = "Skipped: this turn's structured_output contract took precedence as the terminal output.";
var SUPPRESSED_OUTPUT_RETRY = `${SUPPRESSED_OUTPUT_SUCCESS} Re-issue this call in a separate turn if needed.`;
function suppressedOutputBody(structuredCaptured) {
  return structuredCaptured ? SUPPRESSED_OUTPUT_SUCCESS : SUPPRESSED_OUTPUT_RETRY;
}
__name(suppressedOutputBody, "suppressedOutputBody");
var LOOP_TYPE_LABELS = {
  ["consecutive_identical_tool_calls" /* CONSECUTIVE_IDENTICAL_TOOL_CALLS */]: "the model repeated the same tool call with identical arguments",
  // Reasoning-stream chants fire this type too (checkReasoningContentLoop),
  // and getResponseText filters reasoning out of visible output — the label
  // must name both channels so a headless halt on an empty stdout is not
  // mistaken for a detector misfire.
  ["chanting_identical_sentences" /* CHANTING_IDENTICAL_SENTENCES */]: "the model repeated the same sentence in its output or reasoning",
  ["repetitive_thoughts" /* REPETITIVE_THOUGHTS */]: "the model repeated the same reasoning thought",
  ["read_file_loop" /* READ_FILE_LOOP */]: "the model spent too many consecutive calls reading files without making progress",
  ["action_stagnation" /* ACTION_STAGNATION */]: "the model kept calling the same tool without making progress",
  ["shell_command_stagnation" /* SHELL_COMMAND_STAGNATION */]: "the model repeated similar shell inspection commands without making progress",
  ["global_tool_call_duplicate" /* GLOBAL_TOOL_CALL_DUPLICATE */]: "the model repeated the same tool call across the turn, even when not back-to-back",
  ["alternating_tool_call_pattern" /* ALTERNATING_TOOL_CALL_PATTERN */]: "the model alternated between the same two tool calls in a repeating pattern",
  ["turn_tool_call_cap" /* TURN_TOOL_CALL_CAP */]: "the turn reached the per-turn tool-call limit",
  ["invalid_tool_params_stagnation" /* INVALID_TOOL_PARAMS_STAGNATION */]: "the model repeatedly sent invalid tool parameters without correcting them",
  ["repeated_tool_execution_failure" /* REPEATED_TOOL_EXECUTION_FAILURE */]: "the same tool execution failure continued after a corrective reminder"
};
function formatLoopDetectedMessage(loopType) {
  const reason = loopType ? LOOP_TYPE_LABELS[loopType] : void 0;
  const detail = reason ? ` (${loopType}: ${reason})` : "";
  const isAlwaysOn = loopType === "consecutive_identical_tool_calls" /* CONSECUTIVE_IDENTICAL_TOOL_CALLS */ || loopType === "shell_command_stagnation" /* SHELL_COMMAND_STAGNATION */ || loopType === "global_tool_call_duplicate" /* GLOBAL_TOOL_CALL_DUPLICATE */ || loopType === "invalid_tool_params_stagnation" /* INVALID_TOOL_PARAMS_STAGNATION */ || loopType === "repeated_tool_execution_failure" /* REPEATED_TOOL_EXECUTION_FAILURE */;
  const hint = loopType === "turn_tool_call_cap" /* TURN_TOOL_CALL_CAP */ ? " A per-turn tool-call cap was reached. The default is adaptive (allows up to 1000 diverse calls, halting only on repeated calls); an explicitly set `model.maxToolCallsPerTurn` is a hard cap. If the model was repeating the same call, investigate the repetition; otherwise unset the value to use the adaptive default, or raise it (set 0 to disable)." : isAlwaysOn ? " This is an always-on guard and cannot be disabled via `model.skipLoopDetection`." : " Set the `model.skipLoopDetection` setting to true to disable.";
  return `Loop detection halted the run${detail}.${hint}`;
}
__name(formatLoopDetectedMessage, "formatLoopDetectedMessage");
function sameGoalPermit(left, right) {
  return left?.goalId === right.goalId && left.revision === right.revision && left.turnId === right.turnId;
}
__name(sameGoalPermit, "sameGoalPermit");
function projectLegacyActiveGoal(snapshot) {
  const goal = snapshot.goal;
  if (goal?.status !== "active") return null;
  return {
    condition: goal.objective,
    iterations: goal.turnCount,
    setAt: goal.createdAt,
    tokensAtStart: 0,
    hookId: `goal-v2:${goal.goalId}:${goal.revision}`,
    ...goal.lastReason === void 0 ? {} : { lastReason: goal.lastReason }
  };
}
__name(projectLegacyActiveGoal, "projectLegacyActiveGoal");
function formatGoalState(snapshot, operation) {
  const goal = snapshot.goal;
  if (!goal) {
    return operation === "clear" ? "Goal cleared." : "No Goal is set.";
  }
  const status = goal.status === "usage_limited" ? "usage limited" : goal.status;
  const summary = `Goal ${status}: ${goal.objective}`;
  const usage = [];
  if (goal.turnCount > 0) {
    const turns = goal.turnBudget ?? goal.turnCount;
    usage.push(
      `${goal.turnCount}${goal.turnBudget === void 0 ? "" : ` of ${goal.turnBudget}`} ${turns === 1 ? "turn" : "turns"}`
    );
  }
  if (goal.activeTimeMs > 0 && goal.activeTimeBudgetMs !== void 0) {
    usage.push(
      `${formatDuration(goal.activeTimeMs, { hideTrailingZeros: true })} of ${formatDuration(goal.activeTimeBudgetMs, { hideTrailingZeros: true })} active`
    );
  }
  if (goal.tokensUsed > 0) {
    const used = goal.tokensUsed.toLocaleString("en-US");
    usage.push(
      goal.tokenBudget === void 0 ? `${used} tokens` : `${used} of ${goal.tokenBudget.toLocaleString("en-US")} tokens`
    );
  }
  const lines = [summary];
  if (usage.length > 0) lines.push(`Usage: ${usage.join(" \xB7 ")}`);
  if (goal.status !== "active" && goal.lastReason) {
    lines.push(`Reason: ${sanitizeTerminalText(goal.lastReason)}`);
  }
  return lines.join("\n");
}
__name(formatGoalState, "formatGoalState");
async function claimUserGoalTurn(runtime, turnKey, signal) {
  const immediate = runtime.permitForTurn(turnKey) ?? runtime.beginTurn(turnKey);
  if (immediate || runtime.getSnapshot().goal?.status !== "active") {
    return immediate;
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe = /* @__PURE__ */ __name(() => {
    }, "unsubscribe");
    const finish = /* @__PURE__ */ __name((permit, error) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      signal.removeEventListener("abort", onAbort);
      if (error !== void 0) reject(error);
      else resolve(permit);
    }, "finish");
    const inspect = /* @__PURE__ */ __name(() => {
      try {
        const permit = runtime.permitForTurn(turnKey);
        if (permit || runtime.getSnapshot().goal?.status !== "active") {
          finish(permit);
        }
      } catch (error) {
        finish(void 0, error);
      }
    }, "inspect");
    const onAbort = /* @__PURE__ */ __name(() => finish(void 0), "onAbort");
    unsubscribe = runtime.subscribe(inspect);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    else inspect();
  });
}
__name(claimUserGoalTurn, "claimUserGoalTurn");
function skipHeadlessLoopSentinel(scheduler, job) {
  if (!isHeadlessLoopSentinel(job.prompt)) {
    return false;
  }
  if (job.recurring && !job.durable) {
    debugLogger.debug(
      "skipHeadlessLoopSentinel: cleaning up recurring session loop.md cron in headless mode",
      { jobId: job.id }
    );
    void scheduler.delete(job.id).catch(() => {
    });
  }
  return true;
}
__name(skipHeadlessLoopSentinel, "skipHeadlessLoopSentinel");
function emitLoopDetectedMessage(config, loopType) {
  const message = formatLoopDetectedMessage(loopType);
  if (config.getOutputFormat() !== "text" /* TEXT */) {
    return message;
  }
  process.stderr.write(`${message}
`);
  return message;
}
__name(emitLoopDetectedMessage, "emitLoopDetectedMessage");
async function emitNonInteractiveFinalMessage(params) {
  const { message, isError, adapter, config } = params;
  adapter.startAssistantMessage();
  adapter.processEvent({
    type: "content" /* Content */,
    value: message
  });
  adapter.finalizeAssistantMessage();
  const metrics = uiTelemetryService.getMetrics();
  const usage = computeUsageFromMetrics(metrics);
  const outputFormat = config.getOutputFormat();
  const stats = outputFormat === "json" /* JSON */ ? uiTelemetryService.getMetrics() : void 0;
  await params.beforeEmit();
  adapter.emitResult({
    isError,
    durationMs: Date.now() - params.startTimeMs,
    apiDurationMs: 0,
    numTurns: 0,
    errorMessage: isError ? message : void 0,
    usage,
    stats,
    summary: message
  });
}
__name(emitNonInteractiveFinalMessage, "emitNonInteractiveFinalMessage");
function partitionHeadlessToolCalls(requests, config) {
  const registry = config.getToolRegistry();
  return partitionByConcurrencySafety(
    requests,
    (request) => isToolCallConcurrencySafe(
      request.name,
      registry.getTool(canonicalToolName(request.name))?.kind,
      request.args
    )
  );
}
__name(partitionHeadlessToolCalls, "partitionHeadlessToolCalls");
async function runNonInteractive(config, settings, input, prompt_id, options = {}) {
  return promptIdContext.run(prompt_id, async () => {
    let adapter;
    const outputFormat = config.getOutputFormat();
    if (options.adapter) {
      adapter = options.adapter;
    } else if (outputFormat === "stream-json" /* STREAM_JSON */) {
      adapter = new StreamJsonOutputAdapter(
        config,
        config.getIncludePartialMessages()
      );
    } else {
      adapter = new JsonOutputAdapter(config);
    }
    const ownsAdapter = options.adapter === void 0;
    const unsubscribeRecordingFailure = ownsAdapter ? subscribeToHeadlessChatRecordingFailures(config, adapter) : void 0;
    let chatRecordingSettlement;
    const settleBeforeTerminalOutput = /* @__PURE__ */ __name(() => {
      chatRecordingSettlement ??= settleChatRecording(config, {
        finalize: ownsAdapter
      }).then(() => void 0);
      return chatRecordingSettlement;
    }, "settleBeforeTerminalOutput");
    const emitResult = /* @__PURE__ */ __name(async (result) => {
      await settleBeforeTerminalOutput();
      adapter.emitResult(result);
      options.onResultEmitted?.();
    }, "emitResult");
    const sessionId = config.getSessionId();
    const permissionMode = config.getApprovalMode();
    const cleanupReviewWorktrees = /* @__PURE__ */ __name((gitTimeout) => cleanupReviewWorktreeLeases({
      sessionId,
      promptId: prompt_id,
      repositoryRoot: config.getProjectRoot(),
      gitTimeout
    }), "cleanupReviewWorktrees");
    const unregisterReviewWorktreeCleanup = registerCleanup(
      () => cleanupReviewWorktrees(1e3)
    );
    let turnCount = 0;
    let limitedTurnCount = 0;
    let totalApiDurationMs = 0;
    const startTime = Date.now();
    let activeInteractionPromptId = prompt_id;
    let activeInteractionOwner;
    const selectActiveInteraction = /* @__PURE__ */ __name((promptId, startsInteraction = false) => {
      if (startsInteraction || activeInteractionPromptId !== promptId) {
        activeInteractionOwner = void 0;
      }
      activeInteractionPromptId = promptId;
    }, "selectActiveInteraction");
    const captureActiveInteractionOwner = /* @__PURE__ */ __name(() => {
      activeInteractionOwner ??= getActiveInteractionSpan(
        activeInteractionPromptId
      );
      return activeInteractionOwner;
    }, "captureActiveInteractionOwner");
    const endActiveInteraction = /* @__PURE__ */ __name((status, metadata = {}) => {
      const owner = captureActiveInteractionOwner();
      if (!owner || getActiveInteractionSpan(activeInteractionPromptId) !== owner) {
        return;
      }
      endInteractionSpan(status, {
        promptId: activeInteractionPromptId,
        ...metadata
      });
    }, "endActiveInteraction");
    const llmClient = config.getLlmClient();
    const abortController = options.abortController ?? new AbortController();
    const queuedGoalTurns = [];
    let activeGoalTurn;
    let goalRuntimeUnsubscribe;
    const emitGoalSnapshot = /* @__PURE__ */ __name((snapshot) => {
      adapter.processEvent({
        type: "goal_state" /* GoalState */,
        value: snapshot
      });
      adapter.processEvent({
        type: "active_goal" /* ActiveGoal */,
        value: projectLegacyActiveGoal(snapshot)
      });
    }, "emitGoalSnapshot");
    const observeGoalRuntime = /* @__PURE__ */ __name((runtime) => {
      goalRuntimeUnsubscribe ??= runtime.subscribe(emitGoalSnapshot);
    }, "observeGoalRuntime");
    const enforceSessionTurnLimit = /* @__PURE__ */ __name(async (isRuntimeGoalTurn) => {
      if (isRuntimeGoalTurn) return;
      limitedTurnCount++;
      const maxSessionTurns = config.getMaxSessionTurns();
      if (maxSessionTurns >= 0 && limitedTurnCount > maxSessionTurns) {
        await failClosedActiveGoalTurn(
          "Headless Goal stopped after the session turn limit"
        );
        await settleBeforeTerminalOutput();
        await handleMaxTurnsExceededError(config);
      }
    }, "enforceSessionTurnLimit");
    let goalHostUnbind;
    const goalHost = {
      startGoalTurn: /* @__PURE__ */ __name(async (input2) => {
        if (queuedGoalTurns.some(
          ({ permit: permit2 }) => permit2.turnId === input2.permit.turnId
        )) {
          return;
        }
        const { permit, ...continuation } = input2;
        queuedGoalTurns.push({
          permit: { ...permit },
          turnKey: `goal-runtime:${permit.turnId}`,
          controller: new AbortController(),
          origin: "runtime",
          ...continuation
        });
      }, "startGoalTurn"),
      preemptGoalTurn: /* @__PURE__ */ __name((reason) => {
        for (const turn of queuedGoalTurns.splice(0)) {
          turn.controller.abort(reason);
        }
        activeGoalTurn?.controller.abort(reason);
      }, "preemptGoalTurn")
    };
    const bindGoalHost = /* @__PURE__ */ __name(() => {
      goalHostUnbind ??= config.bindGoalTurnHost(goalHost);
    }, "bindGoalHost");
    const markGoalTurnDelivered = /* @__PURE__ */ __name((turn) => {
      try {
        config.getGoalRuntime().markTurnDelivered(turn.turnKey);
      } catch {
      }
    }, "markGoalTurnDelivered");
    let settlingGoalTurn;
    let goalTurnSettlement;
    const failClosedActiveGoalTurn = /* @__PURE__ */ __name((reason, pauseReason) => {
      const turn = activeGoalTurn;
      if (!turn) return Promise.resolve();
      if (settlingGoalTurn === turn && goalTurnSettlement) {
        return goalTurnSettlement;
      }
      settlingGoalTurn = turn;
      goalTurnSettlement = (async () => {
        if (!turn.controller.signal.aborted) {
          turn.controller.abort(reason);
        }
        try {
          const runtime = await config.getGoalRuntimeReady();
          if (!sameGoalPermit(runtime.permitForTurn(turn.turnKey), turn.permit)) {
            return;
          }
          if (runtime.getSnapshot().goal?.status === "active") {
            try {
              await runtime.dispatch({
                action: "pause",
                expectedGoalId: turn.permit.goalId,
                expectedRevision: turn.permit.revision,
                reason: pauseReason ?? goalPauseReasonForHeadlessFailure(reason)
              });
            } catch (error) {
              debugLogger.warn("Failed to pause terminal headless Goal", error);
            }
          }
          try {
            await config.getChatRecordingService?.()?.flush();
          } catch (error) {
            debugLogger.warn("Failed to flush terminal headless Goal", error);
          }
          if (sameGoalPermit(runtime.permitForTurn(turn.turnKey), turn.permit)) {
            await runtime.finishTurn(turn.permit);
          }
        } catch (error) {
          debugLogger.warn("Failed to close terminal headless Goal", error);
        } finally {
          if (activeGoalTurn === turn) {
            activeGoalTurn = void 0;
          }
          if (settlingGoalTurn === turn) {
            settlingGoalTurn = void 0;
            goalTurnSettlement = void 0;
          }
        }
      })();
      return goalTurnSettlement;
    }, "failClosedActiveGoalTurn");
    const finishGoalTurn = /* @__PURE__ */ __name(async (turn) => {
      const runtime = await config.getGoalRuntimeReady();
      if (!sameGoalPermit(runtime.permitForTurn(turn.turnKey), turn.permit)) {
        return;
      }
      let abortSettlement;
      const pauseOnAbort = /* @__PURE__ */ __name(() => {
        const exceeded = budgetEnforcer.getExceeded();
        abortSettlement ??= runtime.dispatch({
          action: "pause",
          expectedGoalId: turn.permit.goalId,
          expectedRevision: turn.permit.revision,
          // The only thing that aborts this controller without tripping a
          // budget is a signal or the embedder cancelling the run, which
          // `routeAbort` names a user interrupt. Naming it anything else
          // here would make the recorded reason depend on which side of
          // `finishTurn`'s persistence window the same Ctrl+C landed on.
          reason: exceeded ? goalPauseReasonForRunBudget(exceeded.kind) : GOAL_PAUSE_REASON_USER_INTERRUPT
        }).then(() => void 0).catch((error) => {
          debugLogger.warn("Failed to pause aborted headless Goal", error);
        });
      }, "pauseOnAbort");
      abortController.signal.addEventListener("abort", pauseOnAbort, {
        once: true
      });
      if (abortController.signal.aborted) pauseOnAbort();
      try {
        if (!abortController.signal.aborted) {
          await runtime.finishTurn(turn.permit);
        }
      } finally {
        abortController.signal.removeEventListener("abort", pauseOnAbort);
        await abortSettlement;
      }
    }, "finishGoalTurn");
    const budgetEnforcer = new RunBudgetEnforcer(
      {
        maxWallTimeSeconds: config.getMaxWallTimeSeconds(),
        maxToolCalls: config.getMaxToolCalls()
      },
      abortController
    );
    const stampBudgetAbort = /* @__PURE__ */ __name(() => {
      const exceeded = budgetEnforcer.getExceeded();
      if (!exceeded) return;
      endActiveInteraction("error", {
        errorMessage: exceeded.message,
        errorType: "run_budget_exceeded"
      });
    }, "stampBudgetAbort");
    abortController.signal.addEventListener("abort", stampBudgetAbort, {
      once: true
    });
    budgetEnforcer.start();
    const routeAbort = /* @__PURE__ */ __name(async () => {
      const exceeded = budgetEnforcer.getExceeded();
      endActiveInteraction(exceeded ? "error" : "cancelled", {
        ...exceeded ? {
          errorMessage: exceeded.message,
          errorType: "run_budget_exceeded"
        } : {}
      });
      await failClosedActiveGoalTurn(
        exceeded?.message ?? "Headless Goal execution was cancelled",
        exceeded ? goalPauseReasonForRunBudget(exceeded.kind) : GOAL_PAUSE_REASON_USER_INTERRUPT
      );
      await settleBeforeTerminalOutput();
      if (exceeded) {
        await handleBudgetExceededError(config, exceeded);
        throw new Error(exceeded.message);
      }
      if (options.recoverableCancellation === true && abortController.signal.reason instanceof TurnInterruptedError) {
        throw abortController.signal.reason;
      }
      await handleCancellationError(config);
      throw new Error("Operation cancelled.");
    }, "routeAbort");
    const localQueue = [];
    const sdkOnlyMonitorQueue = [];
    const isCancelledMonitorEvent = /* @__PURE__ */ __name((item) => Boolean(
      item.monitorId && item.sdkNotification?.status === "running" && config.getMonitorRegistry().get(item.monitorId)?.status === "cancelled"
    ), "isCancelledMonitorEvent");
    const emitNotificationToSdk = /* @__PURE__ */ __name((item) => {
      if (item.sendMessageType !== "notification" /* Notification */) return;
      adapter.emitUserMessage([{ text: item.displayText }]);
      if (item.sdkNotification) {
        adapter.emitSystemMessage("task_notification", item.sdkNotification);
      }
    }, "emitNotificationToSdk");
    const flushQueuedNotificationsToSdk = /* @__PURE__ */ __name((queue) => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (!isCancelledMonitorEvent(item)) {
          emitNotificationToSdk(item);
        }
      }
    }, "flushQueuedNotificationsToSdk");
    let captureMonitorTurnsInLocalQueue = true;
    let oneShotMonitorsFinalized = false;
    const finalizeOneShotMonitors = /* @__PURE__ */ __name(() => {
      if (options.captureMonitorNotifications === false || oneShotMonitorsFinalized)
        return;
      oneShotMonitorsFinalized = true;
      captureMonitorTurnsInLocalQueue = false;
      config.getMonitorRegistry().abortAll();
      flushQueuedNotificationsToSdk(sdkOnlyMonitorQueue);
    }, "finalizeOneShotMonitors");
    let pipeBroken = false;
    let workflowApprovalChannelRegistered = false;
    const stdoutErrorHandler = /* @__PURE__ */ __name((err) => {
      if (err.code === "EPIPE" && !pipeBroken) {
        pipeBroken = true;
        process.stdout.destroy();
      }
    }, "stdoutErrorHandler");
    const shutdownHandler = /* @__PURE__ */ __name(() => {
      debugLogger.debug("[runNonInteractive] Shutdown signal received");
      abortController.abort();
    }, "shutdownHandler");
    const pendingTeammateMessages = [];
    let boundManager = null;
    let approvalListener = null;
    const detachFromManager = /* @__PURE__ */ __name((m) => {
      m.setLeaderMessageCallback(null);
      if (approvalListener) {
        m.getEventEmitter().off(
          "teammate_approval_request" /* TEAMMATE_APPROVAL_REQUEST */,
          approvalListener
        );
        approvalListener = null;
      }
    }, "detachFromManager");
    const onTeamManagerChangeHandler = /* @__PURE__ */ __name((manager) => {
      if (boundManager && boundManager !== manager) {
        detachFromManager(boundManager);
      }
      boundManager = manager;
      if (manager) {
        manager.setLeaderMessageCallback((formatted) => {
          pendingTeammateMessages.push(formatted);
        });
        if (options.controlService) {
          approvalListener = /* @__PURE__ */ __name((event) => {
            options.controlService.permission.handleTeammateApproval(event).catch((err) => {
              debugLogger.warn("Teammate approval handling failed:", err);
            });
          }, "approvalListener");
        } else {
          approvalListener = /* @__PURE__ */ __name((event) => {
            const mode = config.getApprovalMode();
            const confirmationDetails = event.confirmationDetails;
            const requiresExplicitHostApproval = confirmationDetails?.type !== "plan" && confirmationDetails !== void 0 && "hideAlwaysAllow" in confirmationDetails && confirmationDetails.hideAlwaysAllow === true;
            if (mode === "yolo" /* YOLO */ && !requiresExplicitHostApproval) {
              event.respond("proceed_once" /* ProceedOnce */).catch((err) => {
                debugLogger.warn(
                  "Teammate approval ProceedOnce failed:",
                  err
                );
              });
              return;
            }
            const reason = requiresExplicitHostApproval ? mode === "yolo" /* YOLO */ ? `Auto-cancelling tool ${event.toolName} requested by teammate "${event.teammateName}": this request requires an explicit interactive approval surface and cannot be bypassed by YOLO mode.` : `Auto-cancelling tool ${event.toolName} requested by teammate "${event.teammateName}": this request requires an explicit interactive approval surface, which is unavailable in non-stream-json mode with the current approval mode (${mode}). Use --input-format stream-json --output-format stream-json to review it.` : `Auto-cancelling tool ${event.toolName} requested by teammate "${event.teammateName}": current approval mode (${mode}) cannot prompt in non-stream-json mode. Use --yolo or stream-json to allow teammate tool calls.`;
            process.stderr.write(`[team] ${reason}
`);
            pendingTeammateMessages.push(
              `<team_notice>
${reason}
</team_notice>`
            );
            event.respond("cancel" /* Cancel */, {
              cancelMessage: reason
            }).catch((err) => {
              debugLogger.warn("Teammate approval Cancel failed:", err);
            });
          }, "approvalListener");
        }
        manager.getEventEmitter().on("teammate_approval_request" /* TEAMMATE_APPROVAL_REQUEST */, approvalListener);
      }
    }, "onTeamManagerChangeHandler");
    let continueSendType = null;
    try {
      process.stdout.on("error", stdoutErrorHandler);
      process.on("SIGINT", shutdownHandler);
      process.on("SIGTERM", shutdownHandler);
      if (options.controlService) {
        config.getWorkflowRunRegistry().setApprovalRequestCallback(
          (entry, approval, rawArgs, signal) => options.controlService.permission.handleWorkflowApproval(
            entry.runId,
            approval,
            rawArgs,
            signal
          )
        );
        workflowApprovalChannelRegistered = true;
      }
      config.onTeamManagerChange(onTeamManagerChangeHandler);
      const existingManager = config.getTeamManager();
      if (existingManager) {
        onTeamManagerChangeHandler(existingManager);
      }
      const systemMessage = await buildSystemMessage(
        config,
        sessionId,
        permissionMode,
        settings
      );
      adapter.emitMessage(systemMessage);
      const resumedSessionData = config.getResumedSessionData();
      if (resumedSessionData) {
        const restoredSessions = restoredBackgroundAgentSessions.get(config) ?? /* @__PURE__ */ new Set();
        if (!restoredSessions.has(sessionId)) {
          await config.loadPausedBackgroundAgents(sessionId);
          restoredSessions.add(sessionId);
          restoredBackgroundAgentSessions.set(config, restoredSessions);
        }
      }
      let initialPartList = extractPartsFromUserMessage(
        options.userMessage
      );
      const userMessageContent = options.userMessage?.message.content;
      const submittedPrompt = typeof userMessageContent === "string" ? userMessageContent : Array.isArray(userMessageContent) ? userMessageContent.filter((block) => block.type === "text").map((block) => block.type === "text" ? block.text : "").join(" ") : input;
      let inlineModelOverride;
      if (options.continueInterrupted) {
        const recoveryPlan = buildSessionRecoveryPlanFromApiHistory({
          sessionId,
          apiHistory: llmClient.getChat().getHistory(),
          completedToolCallIds: llmClient.getChat().getCompletedToolCallIds?.()
        });
        debugLogger.info("[runNonInteractive] continueInterrupted recovery", {
          kind: recoveryPlan.kind,
          repairs: recoveryPlan.repairs,
          hasContinuation: recoveryPlan.continuation !== void 0
        });
        if (!recoveryPlan.continuation) {
          await emitNonInteractiveFinalMessage({
            message: "No interrupted turn to continue.",
            isError: false,
            adapter,
            config,
            startTimeMs: startTime,
            beforeEmit: settleBeforeTerminalOutput
          });
          return 0;
        }
        initialPartList = recoveryPlan.continuation.parts;
        if (recoveryPlan.continuation.mode === "retry_user_parts") {
          continueSendType = "retry" /* Retry */;
        } else {
          continueSendType = "toolResult" /* ToolResult */;
        }
        const reminderParts = buildInitialSystemReminders(config);
        if (reminderParts.length > 0 && initialPartList) {
          const continuationParts = normalizePartList(initialPartList);
          const hasSystemReminderPart = continuationParts.some(
            (part) => isSystemReminderContent({ role: "user", parts: [part] })
          );
          if (!hasSystemReminderPart) {
            initialPartList = insertAfterFunctionResponses(
              continuationParts,
              reminderParts
            );
          }
        }
      }
      if (!initialPartList) {
        let slashHandled = false;
        if (isSlashCommand(input)) {
          const slashCommandResult = await handleSlashCommand(
            input,
            abortController,
            config,
            settings
          );
          switch (slashCommandResult.type) {
            case "submit_prompt":
              initialPartList = slashCommandResult.content;
              if (slashCommandResult.modelOverride !== void 0 && isInlineModelOverrideAllowed(
                config,
                slashCommandResult.modelOverride
              )) {
                inlineModelOverride = slashCommandResult.modelOverride;
                debugLogger.debug(
                  `[runNonInteractive] inline model override captured: ${inlineModelOverride}`
                );
              } else if (slashCommandResult.modelOverride !== void 0) {
                debugLogger.warn(
                  `[runNonInteractive] ignoring model override '${slashCommandResult.modelOverride}': not a model on the active provider`
                );
              }
              slashHandled = true;
              break;
            case "goal_control": {
              const { snapshot } = slashCommandResult.response;
              const shouldRunGoalWorker = snapshot.goal?.status === "active" && (slashCommandResult.operation.kind === "set" || slashCommandResult.operation.kind === "edit" || slashCommandResult.operation.kind === "resume");
              try {
                observeGoalRuntime(await config.getGoalRuntimeReady());
              } catch (error) {
                if (shouldRunGoalWorker || !(error instanceof GoalPersistenceUnavailableError)) {
                  throw error;
                }
                debugLogger.debug(
                  "[runNonInteractive] canonical Goal runtime unavailable; answering goal_control from the degraded snapshot"
                );
              }
              emitGoalSnapshot(snapshot);
              const message = formatGoalState(
                snapshot,
                slashCommandResult.operation.kind
              );
              if (!shouldRunGoalWorker) {
                await emitNonInteractiveFinalMessage({
                  message,
                  isError: false,
                  adapter,
                  config,
                  startTimeMs: startTime,
                  beforeEmit: settleBeforeTerminalOutput
                });
                return 0;
              }
              if (outputFormat === "text" /* TEXT */) {
                process.stdout.write(`${message}
`);
              }
              bindGoalHost();
              activeGoalTurn = queuedGoalTurns.shift();
              if (!activeGoalTurn) {
                throw new FatalInputError(
                  "The Goal runtime did not schedule a continuation."
                );
              }
              markGoalTurnDelivered(activeGoalTurn);
              initialPartList = buildGoalContinuationParts(activeGoalTurn);
              slashHandled = true;
              break;
            }
            case "message": {
              await emitNonInteractiveFinalMessage({
                message: slashCommandResult.content,
                isError: slashCommandResult.messageType === "error",
                adapter,
                config,
                startTimeMs: startTime,
                beforeEmit: settleBeforeTerminalOutput
              });
              return slashCommandResult.messageType === "error" ? 1 : 0;
            }
            case "stream_messages":
              throw new FatalInputError(
                "Stream messages mode is not supported in non-interactive CLI"
              );
            case "unsupported": {
              await emitNonInteractiveFinalMessage({
                message: slashCommandResult.reason,
                isError: true,
                adapter,
                config,
                startTimeMs: startTime,
                beforeEmit: settleBeforeTerminalOutput
              });
              return 1;
            }
            case "no_command":
              break;
            default: {
              const _exhaustive = slashCommandResult;
              throw new FatalInputError(
                `Unhandled slash command result type: ${_exhaustive.type}`
              );
            }
          }
        }
        if (!slashHandled) {
          const { processedQuery, shouldProceed } = await handleAtCommand({
            query: input,
            config,
            onDebugMessage: /* @__PURE__ */ __name(() => {
            }, "onDebugMessage"),
            messageId: Date.now(),
            signal: abortController.signal
          });
          if (!shouldProceed || !processedQuery) {
            throw new FatalInputError(
              "Exiting due to an error processing the @ command."
            );
          }
          initialPartList = processedQuery;
        }
      }
      if (!initialPartList) {
        initialPartList = [{ text: input }];
      }
      const withReminder = /* @__PURE__ */ __name((existing, text) => {
        const reminderPart = {
          text: `<system-reminder>
${text}
</system-reminder>

`
        };
        return Array.isArray(existing) ? [reminderPart, ...existing] : [reminderPart, existing];
      }, "withReminder");
      const startupNotice = options.continueInterrupted ? null : config.consumePendingStartupWorktreeNotice();
      if (startupNotice) {
        initialPartList = withReminder(initialPartList, startupNotice);
        adapter.emitSystemMessage("worktree_started", {
          notice: startupNotice
        });
      } else if (!options.continueInterrupted && resumedSessionData) {
        try {
          const sessionPath = config.getSessionService().getWorktreeSessionPath(sessionId);
          const restored = await restoreWorktreeContext(sessionPath);
          if (restored.contextMessage) {
            initialPartList = withReminder(
              initialPartList,
              restored.contextMessage
            );
            adapter.emitSystemMessage("worktree_restored", {
              slug: restored.session?.slug,
              path: restored.session?.worktreePath,
              branch: restored.session?.worktreeBranch
            });
          }
        } catch (error) {
          debugLogger.warn(`worktree restore failed (non-fatal):`, error);
        }
      }
      const recoveredAgentsNotice = resumedSessionData && !options.continueInterrupted && !isSlashCommand(input) ? config.consumePendingRecoveredAgentsNotice() : null;
      if (recoveredAgentsNotice) {
        initialPartList = withReminder(initialPartList, recoveredAgentsNotice);
      }
      let initialParts = normalizePartList(initialPartList);
      let fullTurnModelOverride;
      let fullTurnRuntimeView;
      const emitVisionNotice = /* @__PURE__ */ __name((subtype, notice) => {
        if (outputFormat === "text" /* TEXT */) {
          process.stderr.write(`${notice}
`);
        } else {
          adapter.emitSystemMessage(subtype, { notice });
        }
      }, "emitVisionNotice");
      if (inlineModelOverride === void 0 && shouldRunVisionBridge(config) && hasImageParts(initialParts)) {
        const fullTurnModel = config.getDefaultVisionBridgeModel();
        if (fullTurnModel?.agentCapable) {
          const fullTurnParts = initialParts.map(
            (part) => clampInlineMediaPart(part)
          );
          initialParts = fullTurnParts;
          if (hasImageParts(fullTurnParts)) {
            fullTurnModelOverride = getFullTurnVisionModelSelector(fullTurnModel);
            fullTurnRuntimeView = await config.getBaseLlmClient().resolveForModel(fullTurnModelOverride.slice(0, -1), {
              failClosed: true
            });
            emitVisionNotice(
              "vision_routing",
              formatFullTurnVisionNotice(fullTurnModel)
            );
          }
        } else {
          try {
            const bridgeResult = await runVisionBridge({
              config,
              parts: initialParts,
              signal: abortController.signal
            });
            if (bridgeResult.status !== "skipped" || bridgeResult.egressOccurred) {
              emitVisionNotice(
                "vision_bridge",
                formatVisionBridgeNotice(bridgeResult)
              );
            }
            initialParts = bridgeResult.applied && bridgeResult.parts != null ? normalizePartList(bridgeResult.parts) : splitImageParts(initialParts).nonImageParts;
          } catch (error) {
            debugLogger.debug(
              `vision bridge: failed before replacement; falling back to text-only parts error=${error instanceof Error ? error.message : String(error)}`
            );
            emitVisionNotice(
              "vision_bridge_failed",
              "Vision bridge failed; proceeding without the image(s)."
            );
            initialParts = splitImageParts(initialParts).nonImageParts;
          }
        }
      }
      const initialSendType = continueSendType ?? options.sendMessageType ?? "userQuery" /* UserQuery */;
      if (!activeGoalTurn && initialSendType === "userQuery" /* UserQuery */) {
        try {
          const runtime = await config.getGoalRuntimeReady();
          observeGoalRuntime(runtime);
          if (runtime.getSnapshot().goal?.status === "active") {
            const permit = await claimUserGoalTurn(
              runtime,
              prompt_id,
              abortController.signal
            );
            if (abortController.signal.aborted) {
              await routeAbort();
            }
            if (permit) {
              const goal = runtime.getSnapshot().goal;
              if (!goal) {
                throw new Error("Goal turn admission lost its active Goal");
              }
              const verifierFeedback = runtime.getVerifierFeedback(permit);
              activeGoalTurn = {
                permit,
                turnKey: prompt_id,
                controller: new AbortController(),
                origin: "user",
                continuationContext: goal.objective,
                ...verifierFeedback ? { verifierFeedback } : {}
              };
              bindGoalHost();
            }
          }
        } catch (error) {
          if (!(error instanceof GoalPersistenceUnavailableError)) {
            throw error;
          }
        }
      }
      let currentMessages = [{ role: "user", parts: initialParts }];
      const registry = config.getBackgroundTaskRegistry();
      registry.setNotificationCallback((displayText, modelText, meta) => {
        localQueue.push({
          displayText,
          modelText,
          sendMessageType: "notification" /* Notification */,
          todoWorkChainId: meta.todoWorkChainId,
          sdkNotification: {
            task_id: meta.agentId,
            tool_use_id: meta.toolUseId,
            status: meta.status,
            usage: meta.stats ? {
              total_tokens: meta.stats.totalTokens,
              tool_uses: meta.stats.toolUses,
              duration_ms: meta.stats.durationMs
            } : void 0
          }
        });
      });
      registry.setRegisterCallback((entry) => {
        adapter.emitSystemMessage("task_started", {
          task_id: entry.agentId,
          tool_use_id: entry.toolUseId,
          description: entry.description,
          subagent_type: entry.subagentType
        });
      });
      const monitorRegistry = config.getMonitorRegistry();
      if (options.captureMonitorNotifications !== false) {
        monitorRegistry.setNotificationCallback(
          (displayText, modelText, meta) => {
            if (meta.status === "running" && typeof monitorRegistry.get === "function") {
              const entry = monitorRegistry.get(meta.monitorId);
              if (!entry || entry.status !== "running") return;
            }
            const queueItem = {
              displayText,
              modelText,
              sendMessageType: "notification" /* Notification */,
              todoWorkChainId: meta.todoWorkChainId,
              monitorId: meta.monitorId,
              sdkNotification: {
                task_id: meta.monitorId,
                tool_use_id: meta.toolUseId,
                status: meta.status
              }
            };
            if (captureMonitorTurnsInLocalQueue) {
              localQueue.push(queueItem);
            } else {
              sdkOnlyMonitorQueue.push(queueItem);
              flushQueuedNotificationsToSdk(sdkOnlyMonitorQueue);
            }
          }
        );
      }
      if (options.captureMonitorRegistrations !== false) {
        monitorRegistry.setRegisterCallback((entry) => {
          adapter.emitSystemMessage("task_started", {
            task_id: entry.monitorId,
            tool_use_id: entry.toolUseId,
            description: entry.description
          });
        });
      }
      let isFirstTurn = true;
      let isFirstGoalSegment = activeGoalTurn !== void 0;
      let hasUnsentToolResponse = false;
      let modelOverride = inlineModelOverride ?? fullTurnModelOverride;
      const inlineModelOverrideActive = inlineModelOverride !== void 0;
      const fullTurnModelOverrideActive = fullTurnModelOverride !== void 0;
      if (inlineModelOverrideActive) {
        debugLogger.debug(
          `[runNonInteractive] inline model override active for turn: ${inlineModelOverride}`
        );
      }
      let structuredSubmission = void 0;
      let plainTextPreview = "";
      const PLAIN_TEXT_PREVIEW_LIMIT = 200;
      let loopDetected = false;
      let loopDetectedMessage = formatLoopDetectedMessage(void 0);
      const emitStructuredSuccess = /* @__PURE__ */ __name(async () => {
        const owner = captureActiveInteractionOwner();
        if (owner && getActiveInteractionSpan(activeInteractionPromptId) === owner) {
          let responseText;
          try {
            responseText = JSON.stringify(structuredSubmission);
          } catch {
            responseText = void 0;
          }
          if (responseText !== void 0) {
            addAgentOutputMessageAttributes(
              config,
              owner,
              responseText,
              "tool_call"
            );
          }
          endActiveInteraction("ok");
        }
        await failClosedActiveGoalTurn(
          "Headless Goal ended with structured output",
          GOAL_PAUSE_REASON_HEADLESS_RUN_ENDED
        );
        registry.abortAll();
        const holdbackDeadline = Date.now() + STRUCTURED_SHUTDOWN_HOLDBACK_MS;
        while (Date.now() < holdbackDeadline && registry.hasUnfinalizedTasks()) {
          await new Promise((r) => setTimeout(r, 50));
        }
        flushQueuedNotificationsToSdk(localQueue);
        finalizeOneShotMonitors();
        const metrics = uiTelemetryService.getMetrics();
        const usage = computeUsageFromMetrics(metrics);
        const stats = outputFormat === "json" /* JSON */ ? uiTelemetryService.getMetrics() : void 0;
        await emitResult({
          isError: false,
          durationMs: Date.now() - startTime,
          apiDurationMs: totalApiDurationMs,
          numTurns: turnCount,
          usage,
          stats,
          structuredResult: structuredSubmission
        });
        return 0;
      }, "emitStructuredSuccess");
      const emitLoopDetectedResult = /* @__PURE__ */ __name(async () => {
        endActiveInteraction("error", {
          errorMessage: "loop detected",
          errorType: "loop_detected"
        });
        await failClosedActiveGoalTurn(
          "Headless Goal stopped after loop detection"
        );
        registry.abortAll();
        flushQueuedNotificationsToSdk(localQueue);
        finalizeOneShotMonitors();
        if (outputFormat === "text" /* TEXT */) {
          await settleBeforeTerminalOutput();
          return 1;
        }
        const metrics = uiTelemetryService.getMetrics();
        const usage = computeUsageFromMetrics(metrics);
        const stats = outputFormat === "json" /* JSON */ ? uiTelemetryService.getMetrics() : void 0;
        await emitResult({
          isError: true,
          durationMs: Date.now() - startTime,
          apiDurationMs: totalApiDurationMs,
          numTurns: turnCount,
          errorMessage: loopDetectedMessage,
          usage,
          stats
        });
        return 1;
      }, "emitLoopDetectedResult");
      const emitRetryProgress = /* @__PURE__ */ __name((event, discardedToolCallCount, preserveText) => {
        if (event.type === "model_fallback" /* ModelFallback */) {
          process.stderr.write(
            `Falling back from ${event.fromModel} to ${event.toModel} (${discardedToolCallCount} buffered tool call(s) discarded).
`
          );
          return;
        }
        if (event.type !== "retry" /* Retry */) return;
        if (!event.retryInfo) {
          process.stderr.write(
            `Retrying provider attempt (${discardedToolCallCount} buffered tool call(s) discarded${preserveText ? "; preserving delivered text" : ""}).
`
          );
          return;
        }
        const { attempt, maxRetries, delayMs, message } = event.retryInfo;
        const delaySeconds = Math.ceil(delayMs / 1e3);
        process.stderr.write(
          `Retrying in ${delaySeconds}s (attempt ${attempt}/${maxRetries})${message ? `: ${message}` : ""}
`
        );
      }, "emitRetryProgress");
      const discardAbandonedAttempt = /* @__PURE__ */ __name((event, pendingRequests, onDiscardText) => {
        if (event.type !== "retry" /* Retry */ && event.type !== "model_fallback" /* ModelFallback */) {
          return;
        }
        const discardedToolCalls = pendingRequests.splice(0);
        const preserveText = event.type === "retry" /* Retry */ && event.isContinuation === true;
        adapter.restartAttempt(preserveText, discardedToolCalls);
        if (!preserveText) {
          onDiscardText?.();
        }
        const retryInfo = event.type === "retry" /* Retry */ ? event.retryInfo : void 0;
        adapter.emitSystemMessage("retry", {
          reason: event.type === "retry" /* Retry */ ? "retry" : "model_fallback",
          ...retryInfo ? {
            attempt: retryInfo.attempt,
            maxRetries: retryInfo.maxRetries,
            delayMs: retryInfo.delayMs
          } : {},
          discardedToolCalls: discardedToolCalls.length,
          preserveText
        });
        emitRetryProgress(event, discardedToolCalls.length, preserveText);
      }, "discardAbandonedAttempt");
      const handledToolCallFingerprints = new Map(
        llmClient.getHistoryToolCallFingerprints()
      );
      const duplicateProviderToolCallResponseIds = /* @__PURE__ */ new Set();
      const processToolCallBatch = /* @__PURE__ */ __name(async (batchRequests, setModelOverride, runtimeView) => {
        let terminateTurn = false;
        const responseByRequest = /* @__PURE__ */ new Map();
        const statusByResponse = /* @__PURE__ */ new Map();
        const structuredOutputActive = config.getJsonSchema() && batchRequests.some((r) => r.name === ToolNames.STRUCTURED_OUTPUT);
        const getProviderResponseId = /* @__PURE__ */ __name((request) => request.providerCallId ?? (structuredOutputActive ? void 0 : request.callId || void 0), "getProviderResponseId");
        const seenBatchCallIds = /* @__PURE__ */ new Set();
        const duplicateBatchRequests = [];
        const uniqueBatchRequests = batchRequests.filter((request) => {
          if (request.callId) {
            if (seenBatchCallIds.has(request.callId)) {
              if (structuredOutputActive && request.name === ToolNames.STRUCTURED_OUTPUT) {
                return true;
              }
              debugLogger.debug(
                `Dropping duplicate non-interactive tool callId=${request.callId} name=${request.name}`
              );
              duplicateBatchRequests.push(request);
              return false;
            }
            seenBatchCallIds.add(request.callId);
          }
          return true;
        });
        const isReplayOfHandledRequest = /* @__PURE__ */ __name((request) => {
          const providerCallId = getProviderResponseId(request);
          return providerCallId ? isReplayOfHandledToolCall(
            handledToolCallFingerprints,
            providerCallId,
            getCachedToolCallFingerprint(
              request,
              request.name,
              request.args
            )
          ) : false;
        }, "isReplayOfHandledRequest");
        const repeatedDuplicateRequest = findRepeatedDuplicateProviderToolCall(
          [...uniqueBatchRequests, ...duplicateBatchRequests],
          getProviderResponseId,
          isReplayOfHandledRequest,
          duplicateProviderToolCallResponseIds
        );
        if (repeatedDuplicateRequest) {
          const providerCallId = repeatedDuplicateRequest.providerCallId ?? repeatedDuplicateRequest.callId;
          debugLogger.debug(
            `[runNonInteractive] Dropping batch after repeated duplicate provider tool-call id: ${providerCallId} (tool: ${repeatedDuplicateRequest.name})`
          );
          return {
            responseParts: [],
            repeatedDuplicateProviderToolCall: true,
            terminateTurn: false
          };
        }
        const respondedRequests = /* @__PURE__ */ new Set();
        const executableBatchRequests = [];
        for (const requestInfo of uniqueBatchRequests) {
          const providerCallId = getProviderResponseId(requestInfo);
          if (!providerCallId) {
            executableBatchRequests.push(requestInfo);
            continue;
          }
          if (!isReplayOfHandledRequest(requestInfo)) {
            recordHandledToolCall(
              handledToolCallFingerprints,
              providerCallId,
              getCachedToolCallFingerprint(
                requestInfo,
                requestInfo.name,
                requestInfo.args
              )
            );
            executableBatchRequests.push(requestInfo);
            continue;
          }
          markDuplicateProviderToolCallResponseSent(
            providerCallId,
            duplicateProviderToolCallResponseIds
          );
          const toolResponse = createDuplicateProviderToolCallResponse(requestInfo);
          debugLogger.debug(
            `[runNonInteractive] Suppressing duplicate provider tool-call id: ${providerCallId} (tool: ${requestInfo.name})`
          );
          respondedRequests.add(requestInfo);
          adapter.emitToolResult(requestInfo, toolResponse);
          responseByRequest.set(requestInfo, toolResponse);
        }
        let requestsToExecute = executableBatchRequests;
        if (structuredOutputActive) {
          requestsToExecute = executableBatchRequests.filter(
            (r) => r.name === ToolNames.STRUCTURED_OUTPUT
          );
        }
        const planModeEntryBoundaryIndex = findPlanModeEntryBatchBoundaryIndex(
          requestsToExecute.map((request) => request.name)
        );
        const planModeEntryBoundary = planModeEntryBoundaryIndex === void 0 ? void 0 : requestsToExecute[planModeEntryBoundaryIndex];
        const executedRequests = new Set(
          respondedRequests
        );
        const toolBatches = partitionHeadlessToolCalls(
          requestsToExecute,
          config
        );
        const isBudgetExempt = /* @__PURE__ */ __name((requestInfo) => requestInfo.name === ToolNames.STRUCTURED_OUTPUT && config.getJsonSchema?.() !== void 0, "isBudgetExempt");
        const launchToolCall = /* @__PURE__ */ __name(async (requestInfo) => {
          debugLogger.debug(
            `[runNonInteractive] launching tool call ${requestInfo.callId} (${requestInfo.name})`
          );
          const inputFormat = typeof config.getInputFormat === "function" ? config.getInputFormat() : "text" /* TEXT */;
          const toolCallUpdateCallback = inputFormat === "stream-json" /* STREAM_JSON */ && options.controlService ? options.controlService.permission.getToolCallUpdateCallback() : void 0;
          const isAgentTool = requestInfo.name === "agent";
          const { handler: outputUpdateHandler } = isAgentTool ? createAgentToolProgressHandler(
            config,
            requestInfo.callId,
            adapter
          ) : createToolProgressHandler(requestInfo, adapter);
          const response = await executeToolCall(
            config,
            requestInfo,
            activeGoalTurn ? AbortSignal.any([
              abortController.signal,
              activeGoalTurn.controller.signal
            ]) : abortController.signal,
            {
              recordToolResult: false,
              onToolResultFullTurnModel: /* @__PURE__ */ __name((model) => {
                if (inlineModelOverrideActive) return false;
                return setModelOverride(model);
              }, "onToolResultFullTurnModel"),
              outputUpdateHandler,
              onAllToolCallsComplete: /* @__PURE__ */ __name(async (completedCalls) => {
                for (const call of completedCalls) {
                  statusByResponse.set(call.response, call.status);
                }
              }, "onAllToolCallsComplete"),
              runtimeView,
              ...toolCallUpdateCallback && {
                onToolCallsUpdate: toolCallUpdateCallback
              }
            }
          );
          debugLogger.debug(
            `[runNonInteractive] tool call ${requestInfo.callId} (${requestInfo.name}) settled${response.error ? " with error" : ""}`
          );
          return response;
        }, "launchToolCall");
        const finalizeToolCall = /* @__PURE__ */ __name((requestInfo, toolResponse) => {
          if (toolResponse.error) {
            handleToolError(
              requestInfo.name,
              toolResponse.error,
              config,
              toolResponse.errorType || "TOOL_EXECUTION_ERROR",
              typeof toolResponse.resultDisplay === "string" ? toolResponse.resultDisplay : void 0,
              { approvalRequired: toolResponse.approvalRequired === true }
            );
          }
          adapter.emitToolResult(requestInfo, toolResponse);
          responseByRequest.set(requestInfo, toolResponse);
          terminateTurn ||= toolResponse.terminateTurn === true;
          config.getLlmClient().recordCompletedToolCall(
            requestInfo.name,
            requestInfo.args
          );
          if ("modelOverride" in toolResponse) {
            setModelOverride(toolResponse.modelOverride);
          }
          if (requestInfo.name === ToolNames.STRUCTURED_OUTPUT && !toolResponse.error) {
            structuredSubmission = requestInfo.args;
            return true;
          }
          return false;
        }, "finalizeToolCall");
        const finalizePlanModeEntrySiblingSkip = /* @__PURE__ */ __name((requestInfo) => {
          const error = new Error(PLAN_MODE_ENTRY_SIBLING_SKIP_MESSAGE);
          const responseParts = [
            {
              functionResponse: {
                id: requestInfo.callId,
                name: requestInfo.name,
                response: { error: error.message }
              }
            }
          ];
          adapter.emitToolResult(requestInfo, {
            callId: requestInfo.callId,
            responseParts,
            resultDisplay: error.message,
            error,
            errorType: "execution_denied" /* EXECUTION_DENIED */,
            executionStatus: "not_started"
          });
          responseByRequest.set(requestInfo, {
            callId: requestInfo.callId,
            responseParts,
            resultDisplay: error.message,
            error,
            errorType: "execution_denied" /* EXECUTION_DENIED */,
            executionStatus: "not_started"
          });
          executedRequests.add(requestInfo);
        }, "finalizePlanModeEntrySiblingSkip");
        const maxToolConcurrency = parsePositiveIntegerEnv(
          process.env["QWEN_CODE_MAX_TOOL_CONCURRENCY"],
          10
        );
        let sessionEnded = false;
        for (const batch of toolBatches) {
          if (sessionEnded) break;
          if (batch.concurrent && batch.calls.length > 1) {
            const launched = [];
            const inFlight = /* @__PURE__ */ new Set();
            for (const requestInfo of batch.calls) {
              if (planModeEntryBoundary && requestInfo !== planModeEntryBoundary) {
                finalizePlanModeEntrySiblingSkip(requestInfo);
                continue;
              }
              if (!isBudgetExempt(requestInfo)) {
                budgetEnforcer.tickToolCall();
              }
              if (abortController.signal.aborted) break;
              executedRequests.add(requestInfo);
              const promise = launchToolCall(requestInfo);
              launched.push({ requestInfo, promise });
              const marker = promise.then(
                () => {
                },
                () => {
                }
              ).finally(() => {
                inFlight.delete(marker);
              });
              inFlight.add(marker);
              if (inFlight.size >= maxToolConcurrency) {
                await Promise.race(inFlight);
              }
            }
            const settled = await Promise.allSettled(
              launched.map((l) => l.promise)
            );
            for (let i = 0; i < launched.length; i++) {
              const outcome = settled[i];
              if (outcome.status === "rejected") {
                throw outcome.reason;
              }
              if (finalizeToolCall(launched[i].requestInfo, outcome.value)) {
                sessionEnded = true;
                break;
              }
            }
            if (!sessionEnded && abortController.signal.aborted) {
              await routeAbort();
            }
          } else {
            for (const requestInfo of batch.calls) {
              if (planModeEntryBoundary && requestInfo !== planModeEntryBoundary) {
                finalizePlanModeEntrySiblingSkip(requestInfo);
                continue;
              }
              if (!isBudgetExempt(requestInfo)) {
                budgetEnforcer.tickToolCall();
              }
              if (abortController.signal.aborted) await routeAbort();
              executedRequests.add(requestInfo);
              const toolResponse = await launchToolCall(requestInfo);
              if (finalizeToolCall(requestInfo, toolResponse)) {
                sessionEnded = true;
                break;
              }
            }
          }
        }
        const unexecutedCalls = executableBatchRequests.filter(
          (r) => !executedRequests.has(r)
        );
        if (unexecutedCalls.length > 0) {
          const skippedOutput = suppressedOutputBody(
            structuredSubmission !== void 0
          );
          for (const call of unexecutedCalls) {
            const responseParts = [
              {
                functionResponse: {
                  id: call.callId,
                  name: call.name,
                  response: { output: skippedOutput }
                }
              }
            ];
            const toolResponse = {
              callId: call.callId,
              responseParts,
              resultDisplay: skippedOutput,
              error: void 0,
              errorType: void 0,
              executionStatus: "not_started"
            };
            adapter.emitToolResult(call, toolResponse);
            responseByRequest.set(call, toolResponse);
          }
        }
        for (const requestInfo of duplicateBatchRequests) {
          const providerCallId = getProviderResponseId(requestInfo);
          if (!providerCallId) continue;
          markDuplicateProviderToolCallResponseSent(
            providerCallId,
            duplicateProviderToolCallResponseIds
          );
          const toolResponse = createDuplicateProviderToolCallResponse(requestInfo);
          adapter.emitToolResult(requestInfo, toolResponse);
          responseByRequest.set(requestInfo, toolResponse);
        }
        const orderedResponses = batchRequests.flatMap((request) => {
          const response = responseByRequest.get(request);
          return response ? [{ request, response }] : [];
        });
        const finalized = await finalizeToolResponses(
          config,
          orderedResponses.map(({ request, response }) => ({
            callId: request.callId,
            toolName: request.name,
            responseParts: response.responseParts,
            persistedOutputFiles: response.persistedOutputFiles,
            artifacts: response.artifacts
          })),
          new Map(
            orderedResponses.map(({ request }) => [
              request.callId,
              request.prompt_id
            ])
          )
        );
        const chatRecordingService = config.getChatRecordingService?.();
        const toolResponseParts = [];
        for (let index = 0; index < orderedResponses.length; index++) {
          const { request, response } = orderedResponses[index];
          const finalizedParts = finalized[index].responseParts;
          toolResponseParts.push(...finalizedParts);
          const goalProvenance = goalToolResultProvenance(request);
          chatRecordingService?.recordToolResult?.(
            finalizedParts,
            {
              callId: request.callId,
              status: statusByResponse.get(response) ?? (response.error ? "error" : "success"),
              resultDisplay: response.resultDisplay,
              persistedOutputFiles: finalized[index].persistedOutputFiles,
              artifacts: finalized[index].artifacts,
              error: response.error,
              errorType: response.errorType,
              executionStatus: response.executionStatus
            },
            ...goalProvenance ? [goalProvenance] : []
          );
        }
        return {
          responseParts: toolResponseParts,
          repeatedDuplicateProviderToolCall: false,
          terminateTurn
        };
      }, "processToolCallBatch");
      let currentPromptId = prompt_id;
      while (true) {
        let isTeammateTurn = false;
        if (!isFirstTurn && pendingTeammateMessages.length > 0) {
          const batch = pendingTeammateMessages.splice(0);
          const teammatePart = { text: batch.join("\n\n") };
          if ((hasUnsentToolResponse || activeGoalTurn) && currentMessages[0]) {
            currentMessages[0].parts = [
              ...currentMessages[0].parts || [],
              teammatePart
            ];
          } else {
            currentMessages = [{ role: "user", parts: [teammatePart] }];
          }
          isTeammateTurn = true;
        }
        hasUnsentToolResponse = false;
        turnCount++;
        const goalTurn = activeGoalTurn;
        await enforceSessionTurnLimit(goalTurn?.origin === "runtime");
        let sendType;
        if (goalTurn && isFirstGoalSegment) {
          sendType = goalTurn.origin === "runtime" ? "goal" /* Goal */ : "userQuery" /* UserQuery */;
        } else if (isTeammateTurn) {
          sendType = "teammate" /* Teammate */;
        } else if (goalTurn) {
          sendType = "toolResult" /* ToolResult */;
        } else if (isFirstTurn) {
          sendType = continueSendType ?? options.sendMessageType ?? "userQuery" /* UserQuery */;
        } else {
          sendType = "toolResult" /* ToolResult */;
        }
        if (isTeammateTurn) {
          selectActiveInteraction(currentPromptId);
          endActiveInteraction("ok");
          currentPromptId = `${prompt_id}/teammate/${turnCount}`;
        }
        selectActiveInteraction(
          currentPromptId,
          sendType !== "toolResult" /* ToolResult */
        );
        const toolCallRequests = [];
        const attemptPreviewLength = plainTextPreview.length;
        const apiStartTime = Date.now();
        const responseStream = llmClient.sendMessageStream(
          currentMessages[0]?.parts || [],
          abortController.signal,
          currentPromptId,
          {
            type: sendType,
            modelOverride,
            ...isFirstTurn && sendType === "userQuery" /* UserQuery */ && !options.continueInterrupted && submittedPrompt.trim().length > 0 && { submittedPrompt },
            ...isFirstTurn && options.notificationDisplayText && {
              notificationDisplayText: options.notificationDisplayText
            },
            ...goalTurn ? {
              goalPermit: goalTurn.permit,
              goalTurnKey: goalTurn.turnKey,
              goalSignal: goalTurn.controller.signal,
              goalOrigin: goalTurn.origin,
              getInterruptedGoalPauseReason: /* @__PURE__ */ __name((interruption) => {
                const exceeded = budgetEnforcer.getExceeded();
                if (exceeded) {
                  return goalPauseReasonForRunBudget(exceeded.kind);
                }
                if (abortController.signal.aborted) {
                  return GOAL_PAUSE_REASON_USER_INTERRUPT;
                }
                if (interruption?.cause === "stop-hook-cap") {
                  return goalPauseReasonForHeadlessFailure(
                    "a Stop hook blocked this session too many times in a row"
                  );
                }
                return interruption?.failure ? goalPauseReasonForHeadlessFailure(interruption.failure) : GOAL_PAUSE_REASON_HEADLESS_RUN_ENDED;
              }, "getInterruptedGoalPauseReason")
            } : {}
          }
        );
        isFirstTurn = false;
        isFirstGoalSegment = false;
        adapter.startAssistantMessage();
        for await (const event of responseStream) {
          captureActiveInteractionOwner();
          if (abortController.signal.aborted) {
            adapter.finalizeAssistantMessage();
            await routeAbort();
          }
          discardAbandonedAttempt(event, toolCallRequests, () => {
            plainTextPreview = plainTextPreview.slice(0, attemptPreviewLength);
          });
          adapter.processEvent(event);
          if (event.type === "hook_system_message" /* HookSystemMessage */ && outputFormat === "text" /* TEXT */) {
            process.stderr.write(`${sanitizeTerminalText(event.value)}
`);
          }
          if (event.type === "tool_call_request" /* ToolCallRequest */) {
            toolCallRequests.push(event.value);
          }
          if (event.type === "content" /* Content */ && plainTextPreview.length < PLAIN_TEXT_PREVIEW_LIMIT) {
            const remaining = PLAIN_TEXT_PREVIEW_LIMIT - plainTextPreview.length;
            plainTextPreview += String(event.value).slice(0, remaining);
          }
          if (event.type === "loop_detected" /* LoopDetected */) {
            if (!loopDetected) {
              loopDetectedMessage = emitLoopDetectedMessage(
                config,
                event.value?.loopType
              );
            }
            loopDetected = true;
          }
          if (event.type === "error" /* Error */) {
            const errorText = parseAndFormatApiError(
              event.value.error,
              config.getContentGeneratorConfig()?.authType
            );
            if (outputFormat === "text" /* TEXT */) {
              process.stderr.write(`${errorText}
`);
            }
            throw new AlreadyReportedError(errorText);
          }
        }
        captureActiveInteractionOwner();
        adapter.finalizeAssistantMessage();
        totalApiDurationMs += Date.now() - apiStartTime;
        if (loopDetected) {
          return emitLoopDetectedResult();
        }
        let shouldFinalizeTurn = toolCallRequests.length === 0;
        if (toolCallRequests.length > 0) {
          const {
            responseParts: toolResponseParts,
            repeatedDuplicateProviderToolCall,
            terminateTurn
          } = await processToolCallBatch(
            toolCallRequests,
            (override) => {
              if (inlineModelOverrideActive) return false;
              if (fullTurnModelOverrideActive && modelOverride !== override) {
                return false;
              }
              if (modelOverride?.endsWith("\0") && modelOverride !== override) {
                return false;
              }
              modelOverride = override;
              return true;
            },
            fullTurnRuntimeView
          );
          if (structuredSubmission !== void 0) {
            return emitStructuredSuccess();
          }
          if (repeatedDuplicateProviderToolCall && toolResponseParts.length === 0) {
            loopDetectedMessage = emitLoopDetectedMessage(
              config,
              "global_tool_call_duplicate" /* GLOBAL_TOOL_CALL_DUPLICATE */
            );
            return emitLoopDetectedResult();
          }
          if (terminateTurn && activeGoalTurn) {
            llmClient.addHistory({
              role: "user",
              parts: toolResponseParts
            });
            await config.getChatRecordingService?.()?.flush();
            await finishGoalTurn(activeGoalTurn);
            activeGoalTurn = void 0;
            selectActiveInteraction(currentPromptId);
            endActiveInteraction("ok");
            const nextGoalTurn = queuedGoalTurns.shift();
            if (nextGoalTurn) {
              activeGoalTurn = nextGoalTurn;
              markGoalTurnDelivered(nextGoalTurn);
              isFirstGoalSegment = true;
              currentMessages = [
                {
                  role: "user",
                  parts: buildGoalContinuationParts(nextGoalTurn)
                }
              ];
              hasUnsentToolResponse = false;
              continue;
            }
            shouldFinalizeTurn = true;
          }
          if (!shouldFinalizeTurn) {
            currentMessages = [{ role: "user", parts: toolResponseParts }];
            hasUnsentToolResponse = true;
          }
        }
        if (shouldFinalizeTurn) {
          if (activeGoalTurn) {
            const completedGoalTurn = activeGoalTurn;
            await config.getChatRecordingService?.()?.flush();
            await finishGoalTurn(completedGoalTurn);
            if (activeGoalTurn === completedGoalTurn) {
              activeGoalTurn = void 0;
            }
            selectActiveInteraction(currentPromptId);
            endActiveInteraction("ok");
            const nextGoalTurn = queuedGoalTurns.shift();
            if (nextGoalTurn) {
              activeGoalTurn = nextGoalTurn;
              markGoalTurnDelivered(nextGoalTurn);
              isFirstGoalSegment = true;
              currentMessages = [
                {
                  role: "user",
                  parts: buildGoalContinuationParts(nextGoalTurn)
                }
              ];
              hasUnsentToolResponse = false;
              continue;
            }
          }
          const teamManager = config.getTeamManager();
          if (teamManager?.hasActiveTeammates()) {
            if (teamManager.allRemainingStalled()) {
              teamManager.abortStalledTeammates();
              const status = teamManager.buildTeamStatusSummary();
              pendingTeammateMessages.push(status);
              continue;
            }
            while (teamManager.hasActiveTeammates() && !abortController.signal.aborted) {
              if (pendingTeammateMessages.length > 0) {
                break;
              }
              if (teamManager.allRemainingStalled()) {
                teamManager.abortStalledTeammates();
                const status = teamManager.buildTeamStatusSummary();
                pendingTeammateMessages.push(status);
                break;
              }
              const waitResult = await teamManager.waitForTeammateActivity(
                void 0,
                abortController.signal
              );
              if (waitResult === "timeout") {
                debugLogger.warn(
                  "[runNonInteractive] waitForTeammateActivity timed out (120s); will continue waiting until stall threshold or messages arrive."
                );
              }
            }
            if (pendingTeammateMessages.length > 0) {
              continue;
            }
          }
          if (abortController.signal.aborted) {
            await routeAbort();
          }
          if (teamManager) {
            await teamManager.drainLeaderInbox();
          }
          if (pendingTeammateMessages.length > 0) {
            continue;
          }
          const drainBatch = /* @__PURE__ */ __name(async () => {
            if (localQueue.length === 0) return;
            const targetType = localQueue[0].sendMessageType;
            let splitIdx = targetType === "cron" /* Cron */ ? 1 : 0;
            if (splitIdx === 0) {
              while (splitIdx < localQueue.length && localQueue[splitIdx].sendMessageType === targetType && localQueue[splitIdx].todoWorkChainId === localQueue[0].todoWorkChainId) {
                splitIdx++;
              }
            }
            const batch = localQueue.splice(0, splitIdx).filter((item2) => !isCancelledMonitorEvent(item2));
            if (batch.length === 0) return;
            for (const queueItem of batch) {
              emitNotificationToSdk(queueItem);
            }
            const item = {
              displayText: batch.map((i) => i.displayText).join("; "),
              modelText: batch.map((i) => i.modelText).join("\n\n"),
              sendMessageType: targetType,
              todoWorkChainId: batch[0]?.todoWorkChainId
            };
            turnCount++;
            await enforceSessionTurnLimit(false);
            let itemMessages = [
              { role: "user", parts: [{ text: item.modelText }] }
            ];
            let itemIsFirstTurn = true;
            let itemModelOverride;
            const itemPromptId = `${prompt_id}/automatic/${turnCount}`;
            while (true) {
              const itemToolCallRequests = [];
              const itemApiStartTime = Date.now();
              selectActiveInteraction(itemPromptId, itemIsFirstTurn);
              const itemStream = llmClient.sendMessageStream(
                itemMessages[0]?.parts || [],
                abortController.signal,
                itemPromptId,
                {
                  type: itemIsFirstTurn ? item.sendMessageType : "toolResult" /* ToolResult */,
                  modelOverride: itemModelOverride,
                  ...itemIsFirstTurn && {
                    notificationDisplayText: item.displayText,
                    todoWorkChainId: item.todoWorkChainId
                  }
                }
              );
              itemIsFirstTurn = false;
              adapter.startAssistantMessage();
              for await (const event of itemStream) {
                captureActiveInteractionOwner();
                if (abortController.signal.aborted) {
                  adapter.finalizeAssistantMessage();
                  flushQueuedNotificationsToSdk(localQueue);
                  finalizeOneShotMonitors();
                  await routeAbort();
                }
                discardAbandonedAttempt(event, itemToolCallRequests);
                adapter.processEvent(event);
                if (event.type === "hook_system_message" /* HookSystemMessage */ && outputFormat === "text" /* TEXT */) {
                  process.stderr.write(
                    `${sanitizeTerminalText(event.value)}
`
                  );
                }
                if (event.type === "tool_call_request" /* ToolCallRequest */) {
                  itemToolCallRequests.push(event.value);
                }
                if (event.type === "loop_detected" /* LoopDetected */) {
                  if (!loopDetected) {
                    loopDetectedMessage = emitLoopDetectedMessage(
                      config,
                      event.value?.loopType
                    );
                  }
                  loopDetected = true;
                }
                if (event.type === "error" /* Error */) {
                  const errorText = parseAndFormatApiError(
                    event.value.error,
                    config.getContentGeneratorConfig()?.authType
                  );
                  if (outputFormat === "text" /* TEXT */) {
                    process.stderr.write(`${errorText}
`);
                  }
                  throw new AlreadyReportedError(errorText);
                }
              }
              captureActiveInteractionOwner();
              adapter.finalizeAssistantMessage();
              totalApiDurationMs += Date.now() - itemApiStartTime;
              if (loopDetected) {
                return;
              }
              if (itemToolCallRequests.length > 0) {
                const {
                  responseParts: itemToolResponseParts,
                  repeatedDuplicateProviderToolCall
                } = await processToolCallBatch(
                  itemToolCallRequests,
                  (override) => {
                    if (itemModelOverride?.endsWith("\0") && itemModelOverride !== override) {
                      return false;
                    }
                    itemModelOverride = override;
                    return true;
                  }
                );
                if (structuredSubmission !== void 0) {
                  return;
                }
                if (repeatedDuplicateProviderToolCall && itemToolResponseParts.length === 0) {
                  loopDetectedMessage = emitLoopDetectedMessage(
                    config,
                    "global_tool_call_duplicate" /* GLOBAL_TOOL_CALL_DUPLICATE */
                  );
                  loopDetected = true;
                  return;
                }
                itemMessages = [{ role: "user", parts: itemToolResponseParts }];
              } else {
                break;
              }
            }
          }, "drainBatch");
          let drainPromise = null;
          const drainLocalQueue = /* @__PURE__ */ __name(() => {
            if (drainPromise) return drainPromise;
            const p = (async () => {
              while (localQueue.length > 0) {
                if (loopDetected) return;
                if (structuredSubmission !== void 0) return;
                await drainBatch();
              }
            })();
            drainPromise = p;
            void p.finally(() => {
              if (drainPromise === p) drainPromise = null;
            });
            return p;
          }, "drainLocalQueue");
          const scheduler = !config.isCronEnabled() ? null : config.getCronScheduler();
          if (scheduler) {
            scheduler.setSkipDurableFire(
              (job) => isHeadlessLoopSentinel(job.prompt)
            );
            await scheduler.enableDurable(config.getSessionId()).catch((err) => {
              debugLogger.warn(
                `Durable cron init failed \u2014 persistent tasks will not fire in this run: ${err}`
              );
            });
            await new Promise((resolve, reject) => {
              const onAbort = /* @__PURE__ */ __name(() => {
                scheduler.stop();
                resolve();
              }, "onAbort");
              if (abortController.signal.aborted) {
                onAbort();
                return;
              }
              abortController.signal.addEventListener("abort", onAbort, {
                once: true
              });
              const checkCronDone = /* @__PURE__ */ __name(() => {
                if (loopDetected) {
                  abortController.signal.removeEventListener("abort", onAbort);
                  scheduler.stop();
                  resolve();
                  return;
                }
                if (structuredSubmission !== void 0) {
                  abortController.signal.removeEventListener("abort", onAbort);
                  scheduler.stop();
                  resolve();
                  return;
                }
                if (scheduler.sessionSize === 0 && !drainPromise) {
                  abortController.signal.removeEventListener("abort", onAbort);
                  scheduler.stop();
                  resolve();
                }
              }, "checkCronDone");
              const onDrainError = /* @__PURE__ */ __name((err) => {
                abortController.signal.removeEventListener("abort", onAbort);
                scheduler.stop();
                reject(err);
              }, "onDrainError");
              scheduler.start((job) => {
                if (skipHeadlessLoopSentinel(scheduler, job)) {
                  checkCronDone();
                  return;
                }
                const label = job.prompt.slice(0, 40);
                localQueue.push({
                  displayText: `${job.cronExpr === "@wakeup" ? "Loop" : "Cron"}: ${label}`,
                  modelText: job.prompt,
                  sendMessageType: "cron" /* Cron */,
                  todoWorkChainId: job.todoWorkChainId
                });
                drainLocalQueue().then(checkCronDone, onDrainError);
              });
              checkCronDone();
            });
          }
          while (true) {
            if (abortController.signal.aborted) {
              registry.abortAll();
              flushQueuedNotificationsToSdk(localQueue);
              finalizeOneShotMonitors();
              await routeAbort();
            }
            captureMonitorTurnsInLocalQueue = false;
            await drainLocalQueue();
            if (loopDetected) return emitLoopDetectedResult();
            if (structuredSubmission !== void 0) break;
            if (!registry.hasUnfinalizedTasks() && localQueue.length === 0)
              break;
            await new Promise((r) => setTimeout(r, 100));
          }
          const memoryTaskPromises = config.getLlmClient().consumePendingMemoryTaskPromises();
          if (memoryTaskPromises.length > 0) {
            await Promise.allSettled(memoryTaskPromises);
          }
          finalizeOneShotMonitors();
          const metrics = uiTelemetryService.getMetrics();
          const usage = computeUsageFromMetrics(metrics);
          const stats = outputFormat === "json" /* JSON */ ? uiTelemetryService.getMetrics() : void 0;
          if (structuredSubmission !== void 0) {
            return emitStructuredSuccess();
          }
          if (config.getJsonSchema()) {
            const previewSnippet = plainTextPreview.trim();
            const previewSuffix = previewSnippet ? ` Output preview (${plainTextPreview.length}${plainTextPreview.length >= PLAIN_TEXT_PREVIEW_LIMIT ? "+" : ""} chars): ${JSON.stringify(previewSnippet)}.` : "";
            const errorMessage = `Model produced plain text instead of calling the structured_output tool as required by --json-schema after ${turnCount} turn(s).` + previewSuffix;
            endActiveInteraction("error", {
              errorMessage: "model did not produce structured output",
              errorType: "structured_output_missing"
            });
            await emitResult({
              isError: true,
              durationMs: Date.now() - startTime,
              apiDurationMs: totalApiDurationMs,
              numTurns: turnCount,
              errorMessage,
              usage,
              stats
            });
            return 1;
          }
          await emitResult({
            isError: false,
            durationMs: Date.now() - startTime,
            apiDurationMs: totalApiDurationMs,
            numTurns: turnCount,
            usage,
            stats
          });
          return 0;
        }
      }
    } catch (error) {
      const budgetExceeded = budgetEnforcer.getExceeded();
      const failureMessage = error instanceof Error ? error.message : String(error);
      endActiveInteraction(
        budgetExceeded || !abortController.signal.aborted ? "error" : "cancelled",
        {
          ...budgetExceeded ? {
            errorMessage: budgetExceeded.message,
            errorType: "run_budget_exceeded"
          } : abortController.signal.aborted ? {} : {
            errorMessage: "headless invocation failed",
            errorType: getErrorType(error)
          }
        }
      );
      await failClosedActiveGoalTurn(
        error instanceof Error ? error.message : "Headless Goal execution failed",
        budgetExceeded ? goalPauseReasonForRunBudget(budgetExceeded.kind) : void 0
      );
      try {
        adapter.finalizeAssistantMessage();
      } catch {
      }
      flushQueuedNotificationsToSdk(localQueue);
      finalizeOneShotMonitors();
      const recoverableCancellation = !budgetExceeded && options.recoverableCancellation === true && abortController.signal.reason instanceof TurnInterruptedError;
      const message = budgetExceeded ? budgetExceeded.message : recoverableCancellation ? abortController.signal.reason.message : failureMessage;
      const metrics = uiTelemetryService.getMetrics();
      const usage = computeUsageFromMetrics(metrics);
      const stats = outputFormat === "json" /* JSON */ ? uiTelemetryService.getMetrics() : void 0;
      const isAlreadyReportedError = error instanceof AlreadyReportedError;
      const skipAdapterEmit = outputFormat === "text" /* TEXT */ && isAlreadyReportedError;
      await settleBeforeTerminalOutput();
      if (!skipAdapterEmit) {
        try {
          await emitResult({
            isError: true,
            durationMs: Date.now() - startTime,
            apiDurationMs: totalApiDurationMs,
            numTurns: turnCount,
            errorMessage: message,
            usage,
            stats
          });
        } catch (emitErr) {
          debugLogger.error(
            `Failed to emit terminal result envelope: ${emitErr instanceof Error ? emitErr.message : String(emitErr)}`
          );
        }
      }
      if (budgetExceeded) {
        await handleBudgetExceededError(config, budgetExceeded);
      }
      if (recoverableCancellation) {
        return 130;
      }
      await handleError(error, config);
    } finally {
      await failClosedActiveGoalTurn(
        "Headless Goal host stopped before its permit was released"
      );
      goalRuntimeUnsubscribe?.();
      goalRuntimeUnsubscribe = void 0;
      goalHostUnbind?.();
      goalHostUnbind = void 0;
      if (workflowApprovalChannelRegistered) {
        config.getWorkflowRunRegistry().setApprovalRequestCallback(void 0);
      }
      cleanupReviewWorktrees();
      unregisterReviewWorktreeCleanup();
      config.onTeamManagerChange(null, onTeamManagerChangeHandler);
      if (boundManager) {
        detachFromManager(boundManager);
        boundManager = null;
      }
      budgetEnforcer.stop();
      abortController.signal.removeEventListener("abort", stampBudgetAbort);
      const reg = config.getBackgroundTaskRegistry();
      reg.setNotificationCallback(void 0);
      reg.setRegisterCallback(void 0);
      const monReg = config.getMonitorRegistry();
      if (options.captureMonitorNotifications !== false) {
        if (!oneShotMonitorsFinalized) {
          monReg.abortAll({ notify: false });
        }
        monReg.setNotificationCallback(void 0);
      }
      if (options.captureMonitorRegistrations !== false) {
        monReg.setRegisterCallback(void 0);
      }
      unsubscribeRecordingFailure?.();
      process.stdout.removeListener("error", stdoutErrorHandler);
      process.removeListener("SIGINT", shutdownHandler);
      process.removeListener("SIGTERM", shutdownHandler);
      if (isTelemetrySdkInitialized()) {
        await shutdownTelemetry();
      }
    }
    return 1;
  });
}
__name(runNonInteractive, "runNonInteractive");

export {
  TurnInterruptedError,
  formatGoalState,
  skipHeadlessLoopSentinel,
  runNonInteractive
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
