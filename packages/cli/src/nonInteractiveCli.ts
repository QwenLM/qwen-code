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
  uiTelemetryService,
  parseAndFormatApiError,
  createDebugLogger,
  SendMessageType,
  TeamEventType,
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
  handleError,
  handleToolError,
  handleCancellationError,
  handleMaxTurnsExceededError,
} from './utils/errors.js';

const debugLogger = createDebugLogger('NON_INTERACTIVE_CLI');
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
): Promise<void> {
  return promptIdContext.run(prompt_id, async () => {
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
        // permission channel (stream-json SDK or local mode).
        if (options.controlService) {
          approvalListener = (event) => {
            void options.controlService!.permission.handleTeammateApproval(
              event,
            );
          };
          manager
            .getEventEmitter()
            .on(TeamEventType.TEAMMATE_APPROVAL_REQUEST, approvalListener);
        }
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
              return;
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
              return;
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

      const initialParts = normalizePartList(initialPartList);
      let currentMessages: Content[] = [{ role: 'user', parts: initialParts }];

      // Register the callback early so background agents launched during the main
      // tool-call chain can push completions onto the queue.
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

      let isFirstTurn = true;
      let hasUnsentToolResponse = false;
      let modelOverride: string | undefined;
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
            isTeammateTurn = true;
          }
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
          sendType = SendMessageType.UserQuery;
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
          { type: sendType, modelOverride },
        );
        isFirstTurn = false;

        // Start assistant message for this turn
        adapter.startAssistantMessage();

        for await (const event of responseStream) {
          if (abortController.signal.aborted) {
            await handleCancellationError(config);
          }
          // Use adapter for all event processing
          adapter.processEvent(event);
          if (event.type === GeminiEventType.ToolCallRequest) {
            toolCallRequests.push(event.value);
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
            // Throw error to exit with non-zero code
            throw new Error(errorText);
          }
        }

        // Finalize assistant message
        adapter.finalizeAssistantMessage();
        totalApiDurationMs += Date.now() - apiStartTime;

        if (toolCallRequests.length > 0) {
          const toolResponseParts: Part[] = [];

          for (const requestInfo of toolCallRequests) {
            const finalRequestInfo = requestInfo;

            const inputFormat =
              typeof config.getInputFormat === 'function'
                ? config.getInputFormat()
                : InputFormat.TEXT;
            const toolCallUpdateCallback =
              inputFormat === InputFormat.STREAM_JSON && options.controlService
                ? options.controlService.permission.getToolCallUpdateCallback()
                : undefined;

            // Build outputUpdateHandler for this tool call.
            // Agent tool has its own complex handler (subagent messages).
            // All other tools with canUpdateOutput=true (e.g., MCP tools)
            // get a generic handler that emits progress via the adapter.
            const isAgentTool = finalRequestInfo.name === 'agent';
            const { handler: outputUpdateHandler } = isAgentTool
              ? createAgentToolProgressHandler(
                  config,
                  finalRequestInfo.callId,
                  adapter,
                )
              : createToolProgressHandler(finalRequestInfo, adapter);

            const toolResponse = await executeToolCall(
              config,
              finalRequestInfo,
              abortController.signal,
              {
                outputUpdateHandler,
                ...(toolCallUpdateCallback && {
                  onToolCallsUpdate: toolCallUpdateCallback,
                }),
              },
            );

            if (toolResponse.error) {
              // In JSON/STREAM_JSON mode, tool errors are tolerated and formatted
              // as tool_result blocks. handleToolError will detect JSON/STREAM_JSON mode
              // from config and allow the session to continue so the LLM can decide what to do next.
              // In text mode, we still log the error.
              handleToolError(
                finalRequestInfo.name,
                toolResponse.error,
                config,
                toolResponse.errorType || 'TOOL_EXECUTION_ERROR',
                typeof toolResponse.resultDisplay === 'string'
                  ? toolResponse.resultDisplay
                  : undefined,
              );
            }

            adapter.emitToolResult(finalRequestInfo, toolResponse);

            if (toolResponse.responseParts) {
              toolResponseParts.push(...toolResponse.responseParts);
            }

            // Capture model override from skill tool results.
            // Use `in` so that undefined (from inherit/no-model skills) clears a prior override,
            // while non-skill tools (field absent) leave the current override intact.
            if ('modelOverride' in toolResponse) {
              modelOverride = toolResponse.modelOverride;
            }
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
              await teamManager.waitForTeammateActivity(
                undefined,
                abortController.signal,
              );
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

          // Shared between the normal drain and the cancellation flush so stream-json
          // consumers always see a terminal task_notification paired with task_started.
          const emitNotificationToSdk = (item: LocalQueueItem) => {
            if (item.sendMessageType !== SendMessageType.Notification) return;
            adapter.emitUserMessage([{ text: item.displayText }]);
            if (item.sdkNotification) {
              adapter.emitSystemMessage(
                'task_notification',
                item.sdkNotification,
              );
            }
          };

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

            const inputFormat =
              typeof config.getInputFormat === 'function'
                ? config.getInputFormat()
                : InputFormat.TEXT;
            const toolCallUpdateCallback =
              inputFormat === InputFormat.STREAM_JSON && options.controlService
                ? options.controlService.permission.getToolCallUpdateCallback()
                : undefined;

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
                  // Pair the startAssistantMessage() above so stream-json mode doesn't
                  // leave an unterminated message_start.
                  adapter.finalizeAssistantMessage();
                  return;
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
                  throw new Error(errorText);
                }
              }

              adapter.finalizeAssistantMessage();
              totalApiDurationMs += Date.now() - itemApiStartTime;

              if (itemToolCallRequests.length > 0) {
                const itemToolResponseParts: Part[] = [];

                for (const requestInfo of itemToolCallRequests) {
                  const isAgentTool = requestInfo.name === 'agent';
                  const { handler: outputUpdateHandler } = isAgentTool
                    ? createAgentToolProgressHandler(
                        config,
                        requestInfo.callId,
                        adapter,
                      )
                    : createToolProgressHandler(requestInfo, adapter);

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

                  if (toolResponse.responseParts) {
                    itemToolResponseParts.push(...toolResponse.responseParts);
                  }

                  if ('modelOverride' in toolResponse) {
                    itemModelOverride = toolResponse.modelOverride;
                  }
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
              // Flush queued terminal notifications before handleCancellationError
              // exits so stream-json consumers always see a task_notification paired
              // with every task_started.
              while (localQueue.length > 0) {
                emitNotificationToSdk(localQueue.shift()!);
              }
              await handleCancellationError(config);
            }
            await drainLocalQueue();
            // Wait for every task's terminal notification, not just the
            // running ones: cancel() marks status 'cancelled' synchronously
            // but the notification is emitted later by the natural handler,
            // and SDK consumers need every task_started paired with one.
            if (!registry.hasUnfinalizedTasks() && localQueue.length === 0)
              break;
            await new Promise((r) => setTimeout(r, 100));
          }

          const metrics = uiTelemetryService.getMetrics();
          const usage = computeUsageFromMetrics(metrics);
          // Get stats for JSON format output
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
          });
          return;
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

      // For JSON and STREAM_JSON modes, compute usage from metrics
      const message = error instanceof Error ? error.message : String(error);
      const metrics = uiTelemetryService.getMetrics();
      const usage = computeUsageFromMetrics(metrics);
      // Get stats for JSON format output
      const stats =
        outputFormat === OutputFormat.JSON
          ? uiTelemetryService.getMetrics()
          : undefined;
      adapter.emitResult({
        isError: true,
        durationMs: Date.now() - startTime,
        apiDurationMs: totalApiDurationMs,
        numTurns: turnCount,
        errorMessage: message,
        usage,
        stats,
      });
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

      const reg = config.getBackgroundTaskRegistry();
      reg.setNotificationCallback(undefined);
      reg.setRegisterCallback(undefined);

      process.stdout.removeListener('error', stdoutErrorHandler);
      // Cleanup signal handlers
      process.removeListener('SIGINT', shutdownHandler);
      process.removeListener('SIGTERM', shutdownHandler);
      if (isTelemetrySdkInitialized()) {
        await shutdownTelemetry();
      }
    }
  });
}
