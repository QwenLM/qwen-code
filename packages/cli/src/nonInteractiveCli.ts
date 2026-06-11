/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  BackgroundTaskStatus,
  Config,
  ToolCallRequestInfo,
} from '@qwen-code/qwen-code-core';
import { isSlashCommand } from './ui/utils/commandUtils.js';
import type { LoadedSettings } from './config/settings.js';
import {
  executeToolCall,
  shutdownTelemetry,
  isTelemetrySdkInitialized,
  GeminiEventType,
  FatalInputError,
  promptIdContext,
  OutputFormat,
  InputFormat,
  LoopType,
  ToolNames,
  uiTelemetryService,
  parseAndFormatApiError,
  createDebugLogger,
  SendMessageType,
  restoreWorktreeContext,
  TeamEventType,
  ApprovalMode,
  ToolConfirmationOutcome,
} from '@qwen-code/qwen-code-core';
import type { Content, Part, PartListUnion } from '@google/genai';
import type { CLIUserMessage, PermissionMode } from './nonInteractive/types.js';
import type { JsonOutputAdapterInterface } from './nonInteractive/io/BaseJsonOutputAdapter.js';
import { JsonOutputAdapter } from './nonInteractive/io/JsonOutputAdapter.js';
import { StreamJsonOutputAdapter } from './nonInteractive/io/StreamJsonOutputAdapter.js';
import type { ControlService } from './nonInteractive/control/ControlService.js';

import { handleSlashCommand } from './nonInteractiveCliCommands.js';
import { handleAtCommand } from './ui/hooks/atCommandProcessor.js';
import {
  AlreadyReportedError,
  handleError,
  handleToolError,
  handleCancellationError,
  handleMaxTurnsExceededError,
  handleBudgetExceededError,
} from './utils/errors.js';
import { RunBudgetEnforcer } from './utils/runBudget.js';

const debugLogger = createDebugLogger('NON_INTERACTIVE_CLI');

/**
 * Maximum wait, in milliseconds, for in-flight background tasks to emit
 * their terminal `task_notification` after `abortAll()` on the
 * structured-output success path. Tasks are marked cancelled
 * synchronously by `abortAll`, but the natural task handler emits the
 * notification on a later microtask — without a brief holdback the
 * structured-output run would silently drop those events. Capped so a
 * slow agent can't block exit indefinitely.
 */
const STRUCTURED_SHUTDOWN_HOLDBACK_MS = 500;

/**
 * Body of the synthesised `tool_result` for a `tool_use` block that was
 * suppressed because a sibling `structured_output` call took precedence
 * as the terminal output for the same turn.
 *
 * Two variants — the success-path body drops the trailing "Re-issue this
 * call in a separate turn if needed." sentence because the session
 * terminates immediately after synthesis (no model or SDK consumer can
 * act on the advice). The retry-path body keeps it: when the structured
 * call failed validation, the model is about to receive these parts in
 * the next turn and may legitimately re-issue the suppressed call.
 *
 * Shared between the main-turn and drain-turn synthesis sites so a
 * future wording change can't desync them.
 */
const SUPPRESSED_OUTPUT_SUCCESS =
  "Skipped: this turn's structured_output contract took precedence as the terminal output.";
const SUPPRESSED_OUTPUT_RETRY = `${SUPPRESSED_OUTPUT_SUCCESS} Re-issue this call in a separate turn if needed.`;
function suppressedOutputBody(structuredCaptured: boolean): string {
  return structuredCaptured
    ? SUPPRESSED_OUTPUT_SUCCESS
    : SUPPRESSED_OUTPUT_RETRY;
}
import {
  normalizePartList,
  extractPartsFromUserMessage,
  buildSystemMessage,
  createToolProgressHandler,
  createAgentToolProgressHandler,
  computeUsageFromMetrics,
} from './utils/nonInteractiveHelpers.js';

// Human-readable labels for the detectors that can fire mid-stream.
// Surfaced to stderr in TEXT mode so a headless run that halts on a loop
// doesn't exit with empty stdout and no explanation — see PR #3236 review.
const LOOP_TYPE_LABELS: Record<LoopType, string> = {
  [LoopType.CONSECUTIVE_IDENTICAL_TOOL_CALLS]:
    'the model repeated the same tool call with identical arguments',
  [LoopType.CHANTING_IDENTICAL_SENTENCES]:
    'the model repeated the same sentence in its output',
  [LoopType.REPETITIVE_THOUGHTS]:
    'the model repeated the same reasoning thought',
  [LoopType.READ_FILE_LOOP]:
    'the model spent too many consecutive calls reading files without making progress',
  [LoopType.ACTION_STAGNATION]:
    'the model kept calling the same tool without making progress',
};

function emitLoopDetectedMessage(
  config: Config,
  loopType: LoopType | undefined,
): void {
  // In TEXT mode the adapter swallows LoopDetected, so we print here. In
  // JSON modes the adapter emits a structured result, which is enough.
  if (config.getOutputFormat() !== OutputFormat.TEXT) {
    return;
  }
  const reason = loopType ? LOOP_TYPE_LABELS[loopType] : undefined;
  const detail = reason ? ` (${loopType}: ${reason})` : '';
  process.stderr.write(
    `Loop detection halted the run${detail}. Set the \`model.skipLoopDetection\` setting to true to disable.\n`,
  );
}

/**
 * Emits a final message for slash command results.
 * Note: systemMessage should already be emitted before calling this function.
 */
async function emitNonInteractiveFinalMessage(params: {
  message: string;
  isError: boolean;
  adapter: JsonOutputAdapterInterface;
  config: Config;
  startTimeMs: number;
}): Promise<void> {
  const { message, isError, adapter, config } = params;

  // JSON output mode: emit assistant message and result
  // (systemMessage should already be emitted by caller)
  adapter.startAssistantMessage();
  adapter.processEvent({
    type: GeminiEventType.Content,
    value: message,
  } as unknown as Parameters<JsonOutputAdapterInterface['processEvent']>[0]);
  adapter.finalizeAssistantMessage();

  const metrics = uiTelemetryService.getMetrics();
  const usage = computeUsageFromMetrics(metrics);
  const outputFormat = config.getOutputFormat();
  const stats =
    outputFormat === OutputFormat.JSON
      ? uiTelemetryService.getMetrics()
      : undefined;

  adapter.emitResult({
    isError,
    durationMs: Date.now() - params.startTimeMs,
    apiDurationMs: 0,
    numTurns: 0,
    errorMessage: isError ? message : undefined,
    usage,
    stats,
    summary: message,
  });
}

/**
 * Provides optional overrides for `runNonInteractive` execution.
 *
 * @param abortController - Optional abort controller for cancellation.
 * @param adapter - Optional JSON output adapter for structured output formats.
 * @param userMessage - Optional CLI user message payload for preformatted input.
 * @param controlService - Optional control service for future permission handling.
 */
export interface RunNonInteractiveOptions {
  abortController?: AbortController;
  adapter?: JsonOutputAdapterInterface;
  userMessage?: CLIUserMessage;
  controlService?: ControlService;
  sendMessageType?: SendMessageType;
  notificationDisplayText?: string;
  captureMonitorNotifications?: boolean;
  captureMonitorRegistrations?: boolean;
}

/**
 * Executes the non-interactive CLI flow for a single request.
 */
export async function runNonInteractive(
  config: Config,
  settings: LoadedSettings,
  input: string,
  prompt_id: string,
  options: RunNonInteractiveOptions = {},
): Promise<number> {
  return promptIdContext.run(prompt_id, async (): Promise<number> => {
    // Create output adapter based on format
    let adapter: JsonOutputAdapterInterface;
    const outputFormat = config.getOutputFormat();

    if (options.adapter) {
      adapter = options.adapter;
    } else if (outputFormat === OutputFormat.STREAM_JSON) {
      adapter = new StreamJsonOutputAdapter(
        config,
        config.getIncludePartialMessages(),
      );
    } else {
      adapter = new JsonOutputAdapter(config);
    }

    // Get readonly values once at the start
    const sessionId = config.getSessionId();
    const permissionMode = config.getApprovalMode() as PermissionMode;

    let turnCount = 0;
    let totalApiDurationMs = 0;
    const startTime = Date.now();

    const geminiClient = config.getGeminiClient();
    const abortController = options.abortController ?? new AbortController();

    // Run-level budget enforcement for headless / unattended runs
    // (issue #4103). Tied to the same abortController as user-initiated
    // SIGINT so the existing cancellation plumbing carries the abort;
    // `routeAbort` below interprets the reason so the user sees
    // "budget exceeded" instead of a generic "cancelled" envelope.
    const budgetEnforcer = new RunBudgetEnforcer(
      {
        maxWallTimeSeconds: config.getMaxWallTimeSeconds(),
        maxToolCalls: config.getMaxToolCalls(),
      },
      abortController,
    );
    budgetEnforcer.start();

    /**
     * Called at every abort-detection site in place of
     * `handleCancellationError` directly. If a budget tripped, surface the
     * structured budget error (exit 55); otherwise fall through to the
     * SIGINT / user-cancel path (exit 130) so existing behavior is
     * preserved. Both branches call into `process.exit(...)` so the
     * `unreachable` throw is only present to keep the type-checker honest.
     */
    const routeAbort = async (): Promise<never> => {
      const exceeded = budgetEnforcer.getExceeded();
      if (exceeded) {
        await handleBudgetExceededError(config, exceeded);
        // Explicit unreachable — `handleBudgetExceededError` is `never`
        // in production (it calls `process.exit`). If a test stubs
        // `process.exit` or a future refactor makes the handler
        // resumable, this throw carries the original budget message
        // so the outer catch's `errorMessage` field stays actionable
        // (vs. a useless literal "unreachable").
        throw new Error(exceeded.message);
      }
      await handleCancellationError(config);
      throw new Error('Operation cancelled.');
    };

    interface LocalQueueItem {
      displayText: string;
      modelText: string;
      sendMessageType: SendMessageType;
      sdkNotification?: {
        task_id: string;
        tool_use_id?: string;
        status: BackgroundTaskStatus;
        usage?: {
          total_tokens: number;
          tool_uses: number;
          duration_ms: number;
        };
      };
    }
    const localQueue: LocalQueueItem[] = [];
    const sdkOnlyMonitorQueue: LocalQueueItem[] = [];
    const emitNotificationToSdk = (item: LocalQueueItem) => {
      if (item.sendMessageType !== SendMessageType.Notification) return;
      adapter.emitUserMessage([{ text: item.displayText }]);
      if (item.sdkNotification) {
        adapter.emitSystemMessage('task_notification', item.sdkNotification);
      }
    };
    const flushQueuedNotificationsToSdk = (queue: LocalQueueItem[]) => {
      while (queue.length > 0) {
        emitNotificationToSdk(queue.shift()!);
      }
    };
    let captureMonitorTurnsInLocalQueue = true;
    let oneShotMonitorsFinalized = false;
    const finalizeOneShotMonitors = () => {
      if (
        options.captureMonitorNotifications === false ||
        oneShotMonitorsFinalized
      )
        return;
      oneShotMonitorsFinalized = true;
      captureMonitorTurnsInLocalQueue = false;
      config.getMonitorRegistry().abortAll();
      flushQueuedNotificationsToSdk(sdkOnlyMonitorQueue);
    };

    // EPIPE: don't process.exit here — that bypasses the caller's
    // runExitCleanup → flush() and drops queued JSONL writes. Destroy
    // stdout instead and let the natural return drive cleanup. (Aborting
    // is also wrong: the abort path runs handleCancellationError → exit
    // 130 and re-introduces the same bypass.)
    let pipeBroken = false;
    const stdoutErrorHandler = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE' && !pipeBroken) {
        pipeBroken = true;
        process.stdout.destroy();
      }
    };

    // Setup signal handlers for graceful shutdown
    const shutdownHandler = () => {
      debugLogger.debug('[runNonInteractive] Shutdown signal received');
      abortController.abort();
    };

    // ─── Teammate message queue ─────────────────────────
    // When teammates send messages to the leader, they
    // accumulate here and are drained into the LLM
    // conversation between turns.
    const pendingTeammateMessages: string[] = [];
    // Track the manager we're currently bound to so we can
    // detach the leader callback and approval listener before
    // a new manager is installed (or in `finally`). Without
    // this, a reused stream-json session could leave callbacks
    // attached to a stale TeamManager.
    let boundManager: import('@qwen-code/qwen-code-core').TeamManager | null =
      null;
    let approvalListener:
      | ((
          event: import('@qwen-code/qwen-code-core').TeammateApprovalRequestEvent,
        ) => void)
      | null = null;
    const detachFromManager = (
      m: import('@qwen-code/qwen-code-core').TeamManager,
    ) => {
      m.setLeaderMessageCallback(null);
      if (approvalListener) {
        m.getEventEmitter().off(
          TeamEventType.TEAMMATE_APPROVAL_REQUEST,
          approvalListener,
        );
        approvalListener = null;
      }
    };
    const onTeamManagerChangeHandler = (
      manager: import('@qwen-code/qwen-code-core').TeamManager | null,
    ) => {
      // Detach from the previous manager before rebinding.
      if (boundManager && boundManager !== manager) {
        detachFromManager(boundManager);
      }
      boundManager = manager;
      if (manager) {
        manager.setLeaderMessageCallback((formatted) => {
          pendingTeammateMessages.push(formatted);
        });

        // Route teammate tool approvals through the session's
        // permission channel.
        if (options.controlService) {
          // Stream-json mode: SDK handles approvals. Catch instead of
          // void: the handler's own error path re-issues a respond()
          // that can reject (teammate terminated mid-request), and a
          // voided rejection here is an unhandledRejection in an SDK
          // session — mirror the headless listeners below.
          approvalListener = (event) => {
            options
              .controlService!.permission.handleTeammateApproval(event)
              .catch((err) => {
                debugLogger.warn('Teammate approval handling failed:', err);
              });
          };
        } else {
          // Headless / non-stream-json mode: there is no UI to
          // surface a prompt, so the only safe options are
          // YOLO (auto-approve) or Cancel. Without this fallback
          // listener, the event has no subscriber and the teammate
          // hangs until its 600s stall timeout fires.
          approvalListener = (event) => {
            const mode = config.getApprovalMode();
            if (mode === ApprovalMode.YOLO) {
              // `respond` may reject if the teammate terminates between the
              // approval request and our response — catch it so it doesn't
              // become an unhandledRejection that can crash the process.
              event
                .respond(ToolConfirmationOutcome.ProceedOnce)
                .catch((err) => {
                  debugLogger.warn(
                    'Teammate approval ProceedOnce failed:',
                    err,
                  );
                });
              return;
            }
            // Surface a clear reason on stderr — otherwise the
            // failure looks like the teammate gave up for no reason.
            const reason =
              `Auto-cancelling tool ${event.toolName} requested by ` +
              `teammate "${event.teammateName}": current approval mode ` +
              `(${mode}) cannot prompt in non-stream-json mode. ` +
              `Use --yolo or stream-json to allow teammate tool calls.`;
            process.stderr.write(`[team] ${reason}\n`);
            // Also surface to the leader's LLM, otherwise it just
            // sees the teammate fail without any signal that an
            // approval was needed and the host couldn't prompt.
            pendingTeammateMessages.push(
              `<team_notice>\n${reason}\n</team_notice>`,
            );
            event.respond(ToolConfirmationOutcome.Cancel).catch((err) => {
              debugLogger.warn('Teammate approval Cancel failed:', err);
            });
          };
        }
        manager
          .getEventEmitter()
          .on(TeamEventType.TEAMMATE_APPROVAL_REQUEST, approvalListener);
      }
    };

    try {
      process.stdout.on('error', stdoutErrorHandler);

      process.on('SIGINT', shutdownHandler);
      process.on('SIGTERM', shutdownHandler);

      config.onTeamManagerChange(onTeamManagerChangeHandler);

      // Handle the case where a manager already exists (e.g.,
      // a follow-up turn in a stream-json session that created
      // a team on a previous turn).
      const existingManager = config.getTeamManager();
      if (existingManager) {
        onTeamManagerChangeHandler(existingManager);
      }

      // Emit systemMessage first (always the first message in JSON mode)
      const systemMessage = await buildSystemMessage(
        config,
        sessionId,
        permissionMode,
      );
      adapter.emitMessage(systemMessage);

      let initialPartList: PartListUnion | null = extractPartsFromUserMessage(
        options.userMessage,
      );

      if (!initialPartList) {
        let slashHandled = false;
        if (isSlashCommand(input)) {
          const slashCommandResult = await handleSlashCommand(
            input,
            abortController,
            config,
            settings,
          );
          switch (slashCommandResult.type) {
            case 'submit_prompt':
              // A slash command can replace the prompt entirely; fall back to @-command processing otherwise.
              initialPartList = slashCommandResult.content;
              slashHandled = true;
              break;
            case 'message': {
              // systemMessage already emitted above
              await emitNonInteractiveFinalMessage({
                message: slashCommandResult.content,
                isError: slashCommandResult.messageType === 'error',
                adapter,
                config,
                startTimeMs: startTime,
              });
              return slashCommandResult.messageType === 'error' ? 1 : 0;
            }
            case 'stream_messages':
              throw new FatalInputError(
                'Stream messages mode is not supported in non-interactive CLI',
              );
            case 'unsupported': {
              await emitNonInteractiveFinalMessage({
                message: slashCommandResult.reason,
                isError: true,
                adapter,
                config,
                startTimeMs: startTime,
              });
              return 1;
            }
            case 'no_command':
              break;
            default: {
              const _exhaustive: never = slashCommandResult;
              throw new FatalInputError(
                `Unhandled slash command result type: ${(_exhaustive as { type: string }).type}`,
              );
            }
          }
        }

        if (!slashHandled) {
          const { processedQuery, shouldProceed } = await handleAtCommand({
            query: input,
            config,
            onDebugMessage: () => {},
            messageId: Date.now(),
            signal: abortController.signal,
          });

          if (!shouldProceed || !processedQuery) {
            // An error occurred during @include processing (e.g., file not found).
            // The error message is already logged by handleAtCommand.
            throw new FatalInputError(
              'Exiting due to an error processing the @ command.',
            );
          }
          initialPartList = processedQuery as PartListUnion;
        }
      }

      if (!initialPartList) {
        initialPartList = [{ text: input }];
      }

      // Inject a worktree context notice into the model's first prompt.
      // Two sources: the `--worktree` startup flag (set by gemini.tsx
      // before loadCliConfig) takes precedence over the Phase C resume
      // restore. TUI does this via historyManager.addItem(INFO); here in
      // headless we prepend a `<system-reminder>` block since there is
      // no UI history to write into.
      const withReminder = (
        existing: PartListUnion,
        text: string,
      ): PartListUnion => {
        const reminderPart: Part = {
          text: `<system-reminder>\n${text}\n</system-reminder>\n\n`,
        };
        return Array.isArray(existing)
          ? [reminderPart, ...existing]
          : [reminderPart, existing];
      };

      const startupNotice = config.consumePendingStartupWorktreeNotice();
      if (startupNotice) {
        initialPartList = withReminder(initialPartList, startupNotice);
        adapter.emitSystemMessage('worktree_started', {
          notice: startupNotice,
        });
      } else if (config.getResumedSessionData()) {
        try {
          const sessionPath = config
            .getSessionService()
            .getWorktreeSessionPath(sessionId);
          const restored = await restoreWorktreeContext(sessionPath);
          if (restored.contextMessage) {
            initialPartList = withReminder(
              initialPartList,
              restored.contextMessage,
            );
            // Surface the notice in the JSON stream so SDK consumers
            // can react to it (logging, UI hints, etc.).
            adapter.emitSystemMessage('worktree_restored', {
              slug: restored.session?.slug,
              path: restored.session?.worktreePath,
              branch: restored.session?.worktreeBranch,
            });
          }
        } catch (error) {
          debugLogger.warn(`worktree restore failed (non-fatal):`, error);
        }
      }

      const initialParts = normalizePartList(initialPartList);
      let currentMessages: Content[] = [{ role: 'user', parts: initialParts }];

      // Register the callback early so background agents launched during the main
      // tool-call chain can push completions onto the queue.
      const registry = config.getBackgroundTaskRegistry();
      registry.setNotificationCallback((displayText, modelText, meta) => {
        localQueue.push({
          displayText,
          modelText,
          sendMessageType: SendMessageType.Notification,
          sdkNotification: {
            task_id: meta.agentId,
            tool_use_id: meta.toolUseId,
            status: meta.status,
            usage: meta.stats
              ? {
                  total_tokens: meta.stats.totalTokens,
                  tool_uses: meta.stats.toolUses,
                  duration_ms: meta.stats.durationMs,
                }
              : undefined,
          },
        });
      });

      registry.setRegisterCallback((entry) => {
        adapter.emitSystemMessage('task_started', {
          task_id: entry.agentId,
          tool_use_id: entry.toolUseId,
          description: entry.description,
          subagent_type: entry.subagentType,
        });
      });

      const monitorRegistry = config.getMonitorRegistry();
      if (options.captureMonitorNotifications !== false) {
        // One-shot headless runs capture monitor notifications locally so any
        // events already emitted before exit can be surfaced to the SDK/model.
        // Persistent stream-json sessions own this callback at the Session
        // layer instead, so future monitor events can continue after the
        // originating turn has already completed.
        monitorRegistry.setNotificationCallback(
          (displayText, modelText, meta) => {
            const queueItem = {
              displayText,
              modelText,
              sendMessageType: SendMessageType.Notification,
              sdkNotification: {
                task_id: meta.monitorId,
                tool_use_id: meta.toolUseId,
                status: meta.status,
              },
            };

            if (captureMonitorTurnsInLocalQueue) {
              localQueue.push(queueItem);
            } else {
              sdkOnlyMonitorQueue.push(queueItem);
              flushQueuedNotificationsToSdk(sdkOnlyMonitorQueue);
            }
          },
        );
      }

      if (options.captureMonitorRegistrations !== false) {
        monitorRegistry.setRegisterCallback((entry) => {
          adapter.emitSystemMessage('task_started', {
            task_id: entry.monitorId,
            tool_use_id: entry.toolUseId,
            description: entry.description,
          });
        });
      }

      let isFirstTurn = true;
      let hasUnsentToolResponse = false;
      let modelOverride: string | undefined;
      // Session-scoped because the synthetic `structured_output` tool can
      // be invoked from EITHER the main assistant-turn loop or from a
      // drain-turn (queued notification / cron prompt); whichever fires
      // first wins, and both paths need to surface the same structured
      // result envelope.
      let structuredSubmission: unknown = undefined;
      // Captures the first ~200 chars of model-emitted plain text across
      // turns. Used only to enrich the --json-schema "produced plain
      // text" error: the user/operator gets a hint of what the model
      // actually said instead of a static, context-free message.
      let plainTextPreview = '';
      const PLAIN_TEXT_PREVIEW_LIMIT = 200;

      // Shared terminal block for the structured-output success
      // contract. Both the main-turn loop and the drain-turn post-loop
      // previously reproduced this block verbatim
      // (`registry.abortAll()` → bounded holdback for in-flight
      // background-task `task_notification` events → flush localQueue →
      // finalize one-shot monitors → `adapter.emitResult` → return 0).
      // `finalizeOneShotMonitors` is idempotent (the
      // `oneShotMonitorsFinalized` guard makes the second call a
      // no-op), so unconditional invocation is safe even when the drain
      // path already finalized monitors before reaching here.
      const emitStructuredSuccess = async (): Promise<0> => {
        registry.abortAll();
        // `abortAll()` marks each task `cancelled` synchronously, but
        // the matching `task_notification` is emitted later by the
        // task's natural handler. Hold back briefly (capped at
        // STRUCTURED_SHUTDOWN_HOLDBACK_MS) so consumers see every
        // `task_started` paired with its terminal notification, without
        // blocking exit on a slow agent that the user has already
        // declared done.
        const holdbackDeadline = Date.now() + STRUCTURED_SHUTDOWN_HOLDBACK_MS;
        while (
          Date.now() < holdbackDeadline &&
          registry.hasUnfinalizedTasks()
        ) {
          await new Promise((r) => setTimeout(r, 50));
        }
        flushQueuedNotificationsToSdk(localQueue);
        finalizeOneShotMonitors();
        const metrics = uiTelemetryService.getMetrics();
        const usage = computeUsageFromMetrics(metrics);
        const stats =
          outputFormat === OutputFormat.JSON
            ? uiTelemetryService.getMetrics()
            : undefined;
        adapter.emitResult({
          isError: false,
          durationMs: Date.now() - startTime,
          apiDurationMs: totalApiDurationMs,
          numTurns: turnCount,
          usage,
          stats,
          structuredResult: structuredSubmission,
        });
        return 0;
      };

      /**
       * Shared per-turn tool-call dispatch for the main-turn loop and
       * `drainOneItem`. Both call sites used to reproduce ~120 lines of
       * near-identical logic that filtered `structured_output` to its
       * own pre-scan when `--json-schema` is active, executed each
       * request through `executeToolCall`, captured the `structured_output`
       * args into the session-scoped `structuredSubmission`, and
       * synthesised `tool_result` events for every suppressed sibling
       * `tool_use`. The two blocks differed only by variable name
       * prefixes (`requestsToExecute` vs `itemRequestsToExecute`, etc.)
       * and which scope's `modelOverride` to update — passed in as
       * `setModelOverride` so the caller controls binding.
       *
       * The helper mutates the closure-captured `structuredSubmission`
       * directly (it's session-scoped on purpose: whichever turn
       * captures it terminates the run). The caller is responsible for
       * acting on a non-undefined `structuredSubmission` after the
       * helper returns (main-turn → emitStructuredSuccess(); drain-turn
       * → return so the post-drain code emits success).
       */
      const processToolCallBatch = async (
        batchRequests: ToolCallRequestInfo[],
        setModelOverride: (override: string | undefined) => void,
      ): Promise<Part[]> => {
        const toolResponseParts: Part[] = [];

        // Pre-scan: when --json-schema is active and the model emitted
        // a `structured_output` call alongside other tools in the same
        // turn, the structured call is the terminal contract. Execute
        // every structured_output in original order until one succeeds,
        // suppress every non-structured sibling. See the multi-shape
        // examples in the main loop's prior comment for the
        // [bad/good/side-effect] permutations.
        let requestsToExecute = batchRequests;
        if (
          config.getJsonSchema() &&
          batchRequests.some((r) => r.name === ToolNames.STRUCTURED_OUTPUT)
        ) {
          requestsToExecute = batchRequests.filter(
            (r) => r.name === ToolNames.STRUCTURED_OUTPUT,
          );
        }
        const executedCallIds = new Set<string>();

        for (const requestInfo of requestsToExecute) {
          executedCallIds.add(requestInfo.callId);

          const inputFormat =
            typeof config.getInputFormat === 'function'
              ? config.getInputFormat()
              : InputFormat.TEXT;
          const toolCallUpdateCallback =
            inputFormat === InputFormat.STREAM_JSON && options.controlService
              ? options.controlService.permission.getToolCallUpdateCallback()
              : undefined;

          // Build outputUpdateHandler for this tool call. Agent tool
          // has its own complex handler (subagent messages). All other
          // tools with canUpdateOutput=true (e.g., MCP tools) get a
          // generic handler that emits progress via the adapter.
          const isAgentTool = requestInfo.name === 'agent';
          const { handler: outputUpdateHandler } = isAgentTool
            ? createAgentToolProgressHandler(
                config,
                requestInfo.callId,
                adapter,
              )
            : createToolProgressHandler(requestInfo, adapter);

          // Tick BEFORE the call so that --max-tool-calls=N caps the run
          // at exactly N executions: the (N+1)th tick aborts before the
          // tool runs. Ticking after would let the (N+1)th tool execute
          // and only then abort. See issue #4103.
          //
          // Exempt `structured_output` ONLY when `--json-schema` is
          // active: under --json-schema this is the terminal "I'm done"
          // contract tool, not real work, and counting it would abort
          // an otherwise-valid completion at the budget edge (budget=3,
          // model used 3 tools then emits structured_output as call #4
          // → exit 55 instead of success). Guarding on
          // `getJsonSchema()` keeps the exemption tied to the feature
          // that owns the tool name — an MCP server that registers an
          // unrelated tool literally named `structured_output` would
          // otherwise inherit a free pass.
          //
          // Caveat: failed structured_output calls (Ajv validation
          // failure) also skip the tick, so a model stuck in a
          // validation-retry loop is not bounded by --max-tool-calls.
          // Documented in docs/users/features/headless.md → "Scope".
          // Combine with --max-session-turns or --max-wall-time.
          const isStructuredOutputExempt =
            requestInfo.name === ToolNames.STRUCTURED_OUTPUT &&
            config.getJsonSchema?.() !== undefined;
          if (!isStructuredOutputExempt) {
            budgetEnforcer.tickToolCall();
          }
          if (abortController.signal.aborted) await routeAbort();
          const toolResponse = await executeToolCall(
            config,
            requestInfo,
            abortController.signal,
            {
              outputUpdateHandler,
              ...(toolCallUpdateCallback && {
                onToolCallsUpdate: toolCallUpdateCallback,
              }),
            },
          );

          if (toolResponse.error) {
            // In JSON/STREAM_JSON mode, tool errors are tolerated and
            // formatted as tool_result blocks. handleToolError detects
            // mode from config and allows the session to continue so
            // the LLM can decide what to do next. In text mode, we
            // still log the error.
            handleToolError(
              requestInfo.name,
              toolResponse.error,
              config,
              toolResponse.errorType || 'TOOL_EXECUTION_ERROR',
              typeof toolResponse.resultDisplay === 'string'
                ? toolResponse.resultDisplay
                : undefined,
            );
          }

          adapter.emitToolResult(requestInfo, toolResponse);
          config
            .getGeminiClient()
            .recordCompletedToolCall(
              requestInfo.name,
              requestInfo.args as Record<string, unknown>,
            );

          if (toolResponse.responseParts) {
            toolResponseParts.push(...toolResponse.responseParts);
          }

          // Capture model override from skill tool results.
          // Use `in` so that undefined (from inherit/no-model skills)
          // clears a prior override, while non-skill tools (field
          // absent) leave the current override intact.
          if ('modelOverride' in toolResponse) {
            setModelOverride(toolResponse.modelOverride);
          }

          if (
            requestInfo.name === ToolNames.STRUCTURED_OUTPUT &&
            !toolResponse.error
          ) {
            // Honour the "first valid call ends the session" contract.
            // The break is after the responseParts/modelOverride capture
            // above so future changes to SyntheticOutputTool can't
            // silently drop those signals. structuredSubmission is the
            // session-scoped binding from the enclosing scope.
            structuredSubmission = requestInfo.args;
            break;
          }
        }

        // Synthesise tool_result events + retry parts for every
        // tool_use block from the prior assistant message that we did
        // NOT actually execute — non-structured siblings that were
        // suppressed up front, plus any structured_output calls left
        // unexecuted after an earlier one in the batch already
        // succeeded. Runs for both the success and retry paths so the
        // emitted event log pairs every tool_use with a tool_result
        // AND the retry-turn payload (when reached) doesn't leave
        // Anthropic / OpenAI staring at unpaired tool_use blocks.
        const unexecutedCalls = batchRequests.filter(
          (r) => !executedCallIds.has(r.callId),
        );
        if (unexecutedCalls.length > 0) {
          const skippedOutput = suppressedOutputBody(
            structuredSubmission !== undefined,
          );
          for (const call of unexecutedCalls) {
            const responseParts: Part[] = [
              {
                functionResponse: {
                  id: call.callId,
                  name: call.name,
                  response: { output: skippedOutput },
                },
              },
            ];
            adapter.emitToolResult(call, {
              callId: call.callId,
              responseParts,
              resultDisplay: skippedOutput,
              error: undefined,
              errorType: undefined,
            });
            toolResponseParts.push(...responseParts);
          }
        }

        return toolResponseParts;
      };

      while (true) {
        // Drain pending teammate messages into the conversation.
        // sendMessageStream only reads currentMessages[0].parts,
        // so teammate text must be merged into that same parts
        // array to avoid being silently dropped.
        // Skip on the first turn to avoid replacing the user's
        // initial query — early teammate messages will be picked
        // up on the next iteration.
        let isTeammateTurn = false;
        if (!isFirstTurn && pendingTeammateMessages.length > 0) {
          const batch = pendingTeammateMessages.splice(0);
          const teammatePart = { text: batch.join('\n\n') };
          if (hasUnsentToolResponse && currentMessages[0]) {
            currentMessages[0].parts = [
              ...(currentMessages[0].parts || []),
              teammatePart,
            ];
          } else {
            currentMessages = [{ role: 'user', parts: [teammatePart] }];
          }
          // Treat BOTH the standalone and the merged-into-tool-response
          // cases as a teammate turn. Teammate text is fresh external
          // input, so the loop detector must reset — otherwise a leader
          // that polls task_list while teammate messages keep merging
          // into its tool-response turns climbs the identical-tool-call
          // counter and trips a false LoopDetected. The Teammate send
          // path prepends nothing to the request, so a merged turn's
          // leading functionResponse parts stay paired with their
          // functionCall.
          isTeammateTurn = true;
        }
        hasUnsentToolResponse = false;

        turnCount++;
        if (
          config.getMaxSessionTurns() >= 0 &&
          turnCount > config.getMaxSessionTurns()
        ) {
          await handleMaxTurnsExceededError(config);
        }

        let sendType: SendMessageType;
        if (isFirstTurn) {
          sendType = options.sendMessageType ?? SendMessageType.UserQuery;
        } else if (isTeammateTurn) {
          sendType = SendMessageType.Teammate;
        } else {
          sendType = SendMessageType.ToolResult;
        }

        const toolCallRequests: ToolCallRequestInfo[] = [];
        const apiStartTime = Date.now();
        const responseStream = geminiClient.sendMessageStream(
          currentMessages[0]?.parts || [],
          abortController.signal,
          prompt_id,
          {
            type: sendType,
            modelOverride,
            ...(isFirstTurn &&
              options.notificationDisplayText && {
                notificationDisplayText: options.notificationDisplayText,
              }),
          },
        );
        isFirstTurn = false;

        // Start assistant message for this turn
        adapter.startAssistantMessage();

        for await (const event of responseStream) {
          if (abortController.signal.aborted) {
            // Pair the startAssistantMessage() above so stream-json mode
            // doesn't leave an unterminated message_start when a budget /
            // SIGINT abort lands mid-stream. Symmetric with the drain-item
            // loop fix below.
            adapter.finalizeAssistantMessage();
            await routeAbort();
          }
          // Use adapter for all event processing
          adapter.processEvent(event);
          if (event.type === GeminiEventType.ToolCallRequest) {
            toolCallRequests.push(event.value);
          }
          if (
            event.type === GeminiEventType.Content &&
            plainTextPreview.length < PLAIN_TEXT_PREVIEW_LIMIT
          ) {
            const remaining =
              PLAIN_TEXT_PREVIEW_LIMIT - plainTextPreview.length;
            plainTextPreview += String(event.value).slice(0, remaining);
          }
          if (event.type === GeminiEventType.LoopDetected) {
            emitLoopDetectedMessage(config, event.value?.loopType);
          }
          if (
            outputFormat === OutputFormat.TEXT &&
            event.type === GeminiEventType.Error
          ) {
            const errorText = parseAndFormatApiError(
              event.value.error,
              config.getContentGeneratorConfig()?.authType,
            );
            process.stderr.write(`${errorText}\n`);
            // We have already formatted and written the message; mark the
            // throw so the top-level handleError doesn't reformat (which
            // would yield "[API Error: [API Error: ...]]") or print it a
            // second time. Exit code stays 1 — same as before.
            throw new AlreadyReportedError(errorText);
          }
        }

        // Finalize assistant message
        adapter.finalizeAssistantMessage();
        totalApiDurationMs += Date.now() - apiStartTime;

        if (toolCallRequests.length > 0) {
          // Dispatch the per-turn tool-call batch through the shared
          // helper (see processToolCallBatch above). The helper handles
          // the `--json-schema` pre-scan, executes each request, writes
          // the first valid `structured_output` call's args into the
          // session-scoped `structuredSubmission`, and synthesises
          // tool_result events for every suppressed sibling. The
          // `modelOverride` setter is the only call-site-specific
          // binding — the main turn updates the session-scoped
          // `modelOverride` so the next turn's sendMessageStream sees
          // it; the drain turn updates a per-item `itemModelOverride`
          // scoped to that drain item.
          const toolResponseParts = await processToolCallBatch(
            toolCallRequests,
            (override) => {
              modelOverride = override;
            },
          );

          if (structuredSubmission !== undefined) {
            // Single-shot terminal contract; aborts in-flight background
            // agents, holds back briefly for their terminal
            // task_notification events to land, then emits the
            // structured success envelope. Same helper as the drain-turn
            // post-loop branch — see emitStructuredSuccess above.
            return emitStructuredSuccess();
          }
          currentMessages = [{ role: 'user', parts: toolResponseParts }];
          hasUnsentToolResponse = true;
        } else {
          // No more tool calls — check if teammates are active.
          const teamManager = config.getTeamManager();
          if (teamManager?.hasActiveTeammates()) {
            // If all remaining teammates are stalled, abort them,
            // inject a final status, and let the leader wrap up.
            if (teamManager.allRemainingStalled()) {
              teamManager.abortStalledTeammates();
              const status = teamManager.buildTeamStatusSummary();
              pendingTeammateMessages.push(status);
              continue;
            }

            // Wait for messages or termination. On timeout,
            // wait again — don't inject status summaries that
            // cause the leader to poll task_list in a loop.
            // Only break out when a real message arrives or
            // all teammates finish.
            while (
              teamManager.hasActiveTeammates() &&
              !abortController.signal.aborted
            ) {
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
                undefined,
                abortController.signal,
              );
              // Without this log a per-call 120s timeout silently
              // retries until the 600s stall threshold trips —
              // making "teammate stuck" debugging painful in
              // production. `terminated`/`aborted` exit on their
              // own through the loop conditions, so logging
              // `timeout` is enough.
              if (waitResult === 'timeout') {
                debugLogger.warn(
                  '[runNonInteractive] waitForTeammateActivity timed ' +
                    'out (120s); will continue waiting until stall ' +
                    'threshold or messages arrive.',
                );
              }
            }

            // Drain messages and loop back.
            if (pendingTeammateMessages.length > 0) {
              continue;
            }
            // All terminated with no messages — fall through.
          }

          // If the session was aborted (e.g. Ctrl+C), stop
          // immediately instead of falling through to the
          // success path.
          if (abortController.signal.aborted) {
            await handleCancellationError(config);
          }

          // Force one final inbox drain before deciding to exit.
          // A teammate may have written its final send_message
          // and gone IDLE between the last 500ms poll and now —
          // without this, that message is lost.
          if (teamManager) {
            await teamManager.drainLeaderInbox();
          }

          // Also drain any final teammate messages.
          if (pendingTeammateMessages.length > 0) {
            continue;
          }

          // Drain-turns count toward getMaxSessionTurns() for symmetry with the main
          // loop — otherwise a looping cron or a model that keeps replying to
          // notifications could exceed the cap silently in headless runs.
          const drainOneItem = async () => {
            if (localQueue.length === 0) return;
            const item = localQueue.shift()!;

            emitNotificationToSdk(item);

            turnCount++;
            if (
              config.getMaxSessionTurns() >= 0 &&
              turnCount > config.getMaxSessionTurns()
            ) {
              await handleMaxTurnsExceededError(config);
            }

            let itemMessages: Content[] = [
              { role: 'user', parts: [{ text: item.modelText }] },
            ];
            let itemIsFirstTurn = true;
            let itemModelOverride: string | undefined;

            while (true) {
              const itemToolCallRequests: ToolCallRequestInfo[] = [];
              const itemApiStartTime = Date.now();
              const itemStream = geminiClient.sendMessageStream(
                itemMessages[0]?.parts || [],
                abortController.signal,
                prompt_id,
                {
                  type: itemIsFirstTurn
                    ? item.sendMessageType
                    : SendMessageType.ToolResult,
                  modelOverride: itemModelOverride,
                  ...(itemIsFirstTurn && {
                    notificationDisplayText: item.displayText,
                  }),
                },
              );
              itemIsFirstTurn = false;

              adapter.startAssistantMessage();

              for await (const event of itemStream) {
                if (abortController.signal.aborted) {
                  // Pair the startAssistantMessage() above so stream-json
                  // mode doesn't leave an unterminated message_start, then
                  // route through `routeAbort` so a budget overrun in the
                  // final drain item surfaces as exit code 55 instead of
                  // being silently swallowed by the outer success path
                  // (drain-loop fall-through; see issue #4103 review).
                  //
                  // Also flush queued task notifications and finalize
                  // one-shot monitors here. Previously this site used a
                  // bare `return` and let control fall through to the
                  // outer holdback loop, which did the flushing before
                  // exiting; routing through `routeAbort` skips that
                  // path, so we re-do it inline to preserve the
                  // task_started↔task_notification pairing invariant.
                  adapter.finalizeAssistantMessage();
                  flushQueuedNotificationsToSdk(localQueue);
                  finalizeOneShotMonitors();
                  await routeAbort();
                }
                adapter.processEvent(event);
                if (event.type === GeminiEventType.ToolCallRequest) {
                  itemToolCallRequests.push(event.value);
                }
                if (event.type === GeminiEventType.LoopDetected) {
                  emitLoopDetectedMessage(config, event.value?.loopType);
                }
                if (
                  outputFormat === OutputFormat.TEXT &&
                  event.type === GeminiEventType.Error
                ) {
                  const errorText = parseAndFormatApiError(
                    event.value.error,
                    config.getContentGeneratorConfig()?.authType,
                  );
                  process.stderr.write(`${errorText}\n`);
                  // See the matching note in the first stream loop above —
                  // we mark the throw so handleError doesn't reformat or
                  // reprint downstream.
                  throw new AlreadyReportedError(errorText);
                }
              }

              adapter.finalizeAssistantMessage();
              totalApiDurationMs += Date.now() - itemApiStartTime;

              if (itemToolCallRequests.length > 0) {
                // Same shared dispatch as the main-turn loop. The only
                // call-site difference is `itemModelOverride` is local to
                // the drain item (so the next iteration's
                // sendMessageStream picks up the per-item override),
                // while the main loop binds to the session-scoped
                // `modelOverride`.
                const itemToolResponseParts = await processToolCallBatch(
                  itemToolCallRequests,
                  (override) => {
                    itemModelOverride = override;
                  },
                );

                if (structuredSubmission !== undefined) {
                  // Stop processing further turns for this drain item;
                  // the post-drain code will emit the terminal result.
                  return;
                }
                itemMessages = [{ role: 'user', parts: itemToolResponseParts }];
              } else {
                break;
              }
            }
          };

          // Single-flight drain: concurrent callers wait for the running drain so
          // cron jobs firing mid-stream don't produce overlapping turns.
          //
          // Clear via outer `.finally()` rather than inside the async body: when the
          // queue is empty the body runs synchronously, so an inner finally would
          // null the slot BEFORE the outer `drainPromise = p` assignment and leave
          // it stuck forever.
          let drainPromise: Promise<void> | null = null;
          const drainLocalQueue = (): Promise<void> => {
            if (drainPromise) return drainPromise;
            const p = (async () => {
              while (localQueue.length > 0) {
                // Stop draining once a queued item's structured_output
                // call captured the terminal contract — no point running
                // more queued prompts that can't influence the result.
                if (structuredSubmission !== undefined) return;
                await drainOneItem();
              }
            })();
            drainPromise = p;
            void p.finally(() => {
              if (drainPromise === p) drainPromise = null;
            });
            return p;
          };

          // Start cron scheduler — fires enqueue onto the shared queue.
          const scheduler = !config.isCronEnabled()
            ? null
            : config.getCronScheduler();

          if (scheduler && scheduler.size > 0) {
            await new Promise<void>((resolve, reject) => {
              // Resolve on SIGINT/SIGTERM too — recurring cron jobs never
              // drop scheduler.size to 0 on their own, so without this the
              // hold-back loop below is unreachable after an abort.
              const onAbort = () => {
                scheduler.stop();
                resolve();
              };
              if (abortController.signal.aborted) {
                onAbort();
                return;
              }
              abortController.signal.addEventListener('abort', onAbort, {
                once: true,
              });

              const checkCronDone = () => {
                // A drain-turn structured_output makes the rest of the
                // cron schedule moot: we already have a terminal result
                // and the post-drain emit is about to fire. Stop the
                // scheduler so no further jobs enqueue.
                if (structuredSubmission !== undefined) {
                  abortController.signal.removeEventListener('abort', onAbort);
                  scheduler.stop();
                  resolve();
                  return;
                }
                if (scheduler.size === 0 && !drainPromise) {
                  abortController.signal.removeEventListener('abort', onAbort);
                  scheduler.stop();
                  resolve();
                }
              };

              // Propagate drain failures. Without this, a rejected
              // drainLocalQueue() (e.g. a text-mode API error surfacing
              // out of drainOneItem) would be swallowed by `void` and
              // checkCronDone would never fire — hanging the run.
              const onDrainError = (err: unknown) => {
                abortController.signal.removeEventListener('abort', onAbort);
                scheduler.stop();
                reject(err);
              };

              scheduler.start((job: { prompt: string }) => {
                const label = job.prompt.slice(0, 40);
                localQueue.push({
                  displayText: `Cron: ${label}`,
                  modelText: job.prompt,
                  sendMessageType: SendMessageType.Cron,
                });
                drainLocalQueue().then(checkCronDone, onDrainError);
              });

              // Check immediately in case jobs were already deleted
              checkCronDone();
            });
          }

          // Wait for running background agents to complete before emitting the final
          // result. On SIGINT/SIGTERM, abort them and route through
          // handleCancellationError — otherwise the success emitResult below would
          // silently convert a cancellation into a completion.
          while (true) {
            if (abortController.signal.aborted) {
              registry.abortAll();
              // Flush queued terminal notifications before routeAbort
              // exits so stream-json consumers always see a task_notification
              // paired with every task_started.
              flushQueuedNotificationsToSdk(localQueue);
              finalizeOneShotMonitors();
              await routeAbort();
            }
            // Once we enter the final holdback loop, monitor events should no
            // longer extend one-shot runtime. Already-queued events still drain
            // through the model, but later monitor output is SDK-only.
            captureMonitorTurnsInLocalQueue = false;
            await drainLocalQueue();
            // A drain-turn structured_output captured the terminal
            // contract — bail out of the holdback loop early and let the
            // post-loop code emit the success result.
            if (structuredSubmission !== undefined) break;
            // Wait for every background task's terminal notification, not
            // just the running ones: cancel() marks status 'cancelled'
            // synchronously but the notification is emitted later by the
            // natural handler, and SDK consumers need every task_started
            // paired with one. Monitors are different: they intentionally
            // continue in the background, so final result emission is not
            // gated on monitor lifetime.
            if (!registry.hasUnfinalizedTasks() && localQueue.length === 0)
              break;
            await new Promise((r) => setTimeout(r, 100));
          }

          const memoryTaskPromises = config
            .getGeminiClient()
            .consumePendingMemoryTaskPromises();
          if (memoryTaskPromises.length > 0) {
            await Promise.allSettled(memoryTaskPromises);
          }
          finalizeOneShotMonitors();

          const metrics = uiTelemetryService.getMetrics();
          const usage = computeUsageFromMetrics(metrics);
          // Get stats for JSON format output
          const stats =
            outputFormat === OutputFormat.JSON
              ? uiTelemetryService.getMetrics()
              : undefined;

          // A drain-turn structured_output captured the terminal contract
          // — emit the structured success envelope rather than falling
          // through to the "Model produced plain text..." failure path.
          // Same helper as the main-turn path; recomputes its own
          // metrics snapshot after the holdback so any task notifications
          // that landed during shutdown contribute to the totals.
          if (structuredSubmission !== undefined) {
            return emitStructuredSuccess();
          }

          // --json-schema contract: the model MUST terminate via the
          // structured_output tool. Reaching this branch means it emitted
          // plain text instead — surface as an error rather than silently
          // returning whatever free-form summary the adapter collected.
          // Returning a non-zero exit code (rather than throwing) avoids
          // the outer catch re-emitting the result a second time.
          if (config.getJsonSchema()) {
            // Enrich the static contract message with diagnostic context:
            // turn count (how many tries the model got) + a preview of
            // what it actually said (truncated). Operators debugging a
            // headless run shouldn't have to scrape `--output-format
            // json` to understand why the contract failed.
            const previewSnippet = plainTextPreview.trim();
            const previewSuffix = previewSnippet
              ? ` Output preview (${plainTextPreview.length}${
                  plainTextPreview.length >= PLAIN_TEXT_PREVIEW_LIMIT ? '+' : ''
                } chars): ${JSON.stringify(previewSnippet)}.`
              : '';
            const errorMessage =
              `Model produced plain text instead of calling the structured_output tool as required by --json-schema after ${turnCount} turn(s).` +
              previewSuffix;
            adapter.emitResult({
              isError: true,
              durationMs: Date.now() - startTime,
              apiDurationMs: totalApiDurationMs,
              numTurns: turnCount,
              errorMessage,
              usage,
              stats,
            });
            return 1;
          }

          adapter.emitResult({
            isError: false,
            durationMs: Date.now() - startTime,
            apiDurationMs: totalApiDurationMs,
            numTurns: turnCount,
            usage,
            stats,
          });
          return 0;
        }
      }
    } catch (error) {
      // Ensure message_start / message_stop (and content_block events) are
      // properly paired even when an error aborts the turn mid-stream.
      // The call is safe when no message was started (throws → caught) or
      // when already finalized (idempotent guard inside the adapter).
      try {
        adapter.finalizeAssistantMessage();
      } catch {
        // Expected when no message was started or already finalized
      }

      flushQueuedNotificationsToSdk(localQueue);
      finalizeOneShotMonitors();

      // If a run-level budget tripped during an awaited stream / tool
      // call, the underlying fetch's AbortError lands here before our
      // explicit `routeAbort` sites can fire. Capture the reason so we
      // can (a) include the friendly "Run aborted: …" message in the
      // adapter's terminal result envelope (STREAM_JSON consumers
      // depend on that envelope to close the stream cleanly) and (b)
      // exit with the budget handler's exit code 55 instead of the
      // generic `handleError` exit code 1 from a raw "AbortError".
      const budgetExceeded = budgetEnforcer.getExceeded();

      // For JSON and STREAM_JSON modes, compute usage from metrics
      const message = budgetExceeded
        ? budgetExceeded.message
        : error instanceof Error
          ? error.message
          : String(error);
      const metrics = uiTelemetryService.getMetrics();
      const usage = computeUsageFromMetrics(metrics);
      // Get stats for JSON format output
      const stats =
        outputFormat === OutputFormat.JSON
          ? uiTelemetryService.getMetrics()
          : undefined;

      // In TEXT mode the adapter's emitResult writes errorMessage straight
      // to stderr, which would duplicate the line the stream-error handler
      // has already printed. AlreadyReportedError marks the case where the
      // user-facing line is already on the wire — skip the adapter call
      // entirely in that case so we don't emit a phantom blank line.
      // JSON / STREAM_JSON modes still emit normally; the adapter is the
      // primary output channel there, not a duplicate of stderr.
      const isAlreadyReportedError = error instanceof AlreadyReportedError;
      const skipAdapterEmit =
        outputFormat === OutputFormat.TEXT && isAlreadyReportedError;

      if (!skipAdapterEmit) {
        // Wrap in try/catch: emitResult eventually hits stdout.write, which
        // can throw on EPIPE / ERR_STREAM_WRITE_AFTER_END when a piped
        // consumer closes early (`qwen -p ... | head -n 1` is the common
        // case). Letting that throw bubble out skips `handleBudgetExceededError`
        // / `handleError` below, dropping the documented exit code 55
        // contract — precisely when stdout is in trouble. Best-effort emit
        // and continue to the exit handler.
        try {
          adapter.emitResult({
            isError: true,
            durationMs: Date.now() - startTime,
            apiDurationMs: totalApiDurationMs,
            numTurns: turnCount,
            errorMessage: message,
            usage,
            stats,
          });
        } catch (emitErr) {
          debugLogger.error(
            `Failed to emit terminal result envelope: ${
              emitErr instanceof Error ? emitErr.message : String(emitErr)
            }`,
          );
        }
      }
      if (budgetExceeded) {
        // Always exit AFTER emitResult so STREAM_JSON / JSON consumers
        // see a terminal result envelope before the process dies.
        await handleBudgetExceededError(config, budgetExceeded);
      }
      await handleError(error, config);
    } finally {
      // Unsubscribe the leader message callback and approval
      // listener, but do NOT tear down the team itself — in
      // stream-json sessions the same Config is reused across
      // turns, so the team must survive. Full team cleanup
      // happens via Config.shutdown() / cleanupTeamRuntime()
      // when the session ends.
      config.onTeamManagerChange(null, onTeamManagerChangeHandler);
      if (boundManager) {
        detachFromManager(boundManager);
        boundManager = null;
      }

      // Cancel the wall-clock timer so it doesn't fire after a successful
      // run completes — important for callers (e.g. the `qwen serve`
      // daemon, SDK) that reuse a single process across many runs.
      budgetEnforcer.stop();

      const reg = config.getBackgroundTaskRegistry();
      reg.setNotificationCallback(undefined);
      reg.setRegisterCallback(undefined);
      const monReg = config.getMonitorRegistry();
      // In one-shot (non-Session) runs, abort all running monitors so their
      // piped stdio refs don't keep the Node event loop alive after the result
      // is emitted. Session runs manage monitor lifecycle independently.
      if (options.captureMonitorNotifications !== false) {
        if (!oneShotMonitorsFinalized) {
          monReg.abortAll({ notify: false });
        }
        monReg.setNotificationCallback(undefined);
      }
      if (options.captureMonitorRegistrations !== false) {
        monReg.setRegisterCallback(undefined);
      }

      process.stdout.removeListener('error', stdoutErrorHandler);
      // Cleanup signal handlers
      process.removeListener('SIGINT', shutdownHandler);
      process.removeListener('SIGTERM', shutdownHandler);
      if (isTelemetrySdkInitialized()) {
        await shutdownTelemetry();
      }
    }
    // Unreachable in practice: the catch block awaits handleError() which
    // returns Promise<never> (it always exits the process or rethrows).
    // This return exists only so TS sees the function as total.
    return 1;
  });
}
